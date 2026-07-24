import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { DEFAULT_SEARCHER_OWNER } from "../../shared/executor/botvm-executor.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { detectPoolImpact, type PoolImpact } from "../detector/pool-impact.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";
import { type TokenEdge, type V4PoolKey, v4PoolId } from "../planner/token-graph.js";
import { RevmLiveBackend } from "../live-backends/revm-live-backend.js";
import { RevmSimClient } from "../revm-sim-client.js";
import { resolveErc20BalanceSlot } from "../solver/balance-slots.js";
import { PoolStateCache, type PostImpactSeed } from "../solver/pool-state-cache.js";
import { PoolStateUpdater } from "../solver/pool-state-updater.js";
import { postImpactStateOverrides } from "../solver/post-impact-overrides.js";
import {
  encodeUniV4QuoteExactInputSingle,
  uniV4QuoterIface,
} from "../venues/swaps/univ4.js";
import { applyVictimSwapLocally } from "../solver/victim-apply.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { QuoteRequest, QuoteResult } from "../live-state-backend.js";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const BOTVM = "0x4aF9495C4aC24c5CD3b0C90611550a1996415BCe";
const V4_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const V4_QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203";
const V4_SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const BALANCE_OF = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

interface BaseEquivCase {
  name: string;
  adapterId: "univ2-swap" | "univ3-swap" | "univ4-unlock";
  pool: string;
  quoteIn: string;
  quoteOut: string;
  quoteAmountIn: bigint;
}

interface SyntheticEquivCase extends BaseEquivCase {
  adapterId: "univ2-swap" | "univ3-swap";
  victimIn: string;
  victimOut: string;
  victimAmountIn: bigint;
  /** v2 only: assert balanceOf(token, pair) matches the cold replay (catches a
   *  missing/incomplete balanceOf override). */
  checkBalances?: [string, string];
}

interface V4EquivCase extends BaseEquivCase {
  adapterId: "univ4-unlock";
  block: number;
  txHash: string;
  poolId: string;
  v4PoolKey: V4PoolKey;
}

type EquivCase = SyntheticEquivCase | V4EquivCase;

function loadEnv(): void {
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

async function runCase(provider: ethers.JsonRpcProvider, rpcUrl: string, c: EquivCase): Promise<void> {
  const block = c.adapterId === "univ4-unlock" ? c.block : (await provider.getBlockNumber()) - 1;
  console.log(`[finaloverlay-equiv] ${c.name} block=${block}`);

  const impact: PoolImpact = c.adapterId === "univ4-unlock"
    ? await detectV4Impact(provider, c)
    : {
        pool: c.pool,
        tokenIn: c.victimIn,
        tokenOut: c.victimOut,
        amountIn: c.victimAmountIn,
        matchedAdapterId: c.adapterId,
      };
  const event = {
    txHash: "0x0",
    blockNumber: c.adapterId === "univ4-unlock" ? block : block + 1,
    rawTx: "0x",
    from: ethers.ZeroAddress,
    nonce: 0,
    to: null,
    input: "0x",
    logs: [],
    minProfit: 1n,
  };
  const input = {
    event: event as never,
    impact,
    baseBlock: block,
    path: "hash-only" as const,
    routeHops: [] as Array<{ adapterId: string; target: string; tokenIn: string; tokenOut: string }>,
  };
  const quoteReq: QuoteRequest = {
    adapterId: c.adapterId,
    target: c.pool,
    tokenIn: c.quoteIn,
    tokenOut: c.quoteOut,
    amountIn: c.quoteAmountIn,
    ...(c.adapterId === "univ4-unlock" ? { v4PoolKey: c.v4PoolKey } : {}),
  };

  const cache = new PoolStateCache(provider);
  const updater = new PoolStateUpdater(provider, cache, { maxPools: 1, awaitTickRefreshForTest: true });
  if (c.adapterId !== "univ4-unlock") {
    await updater.update(block, [{
      adapterId: impact.matchedAdapterId,
      target: impact.pool,
      tokenIn: impact.tokenIn,
      tokenOut: impact.tokenOut,
      amountIn: impact.amountIn,
    }], { awaitTicks: true, maxTickPools: 1 });
  }
  const localReadState = {
    call: async (req: { to: string; data: string; from?: string }) =>
      provider.call({ to: req.to, data: req.data, from: req.from, blockTag: block }),
  } as unknown as StateBackend;
  const local = await applyVictimSwapLocally(cache, impact, block, localReadState);
  if (!local) throw new Error(`${c.name}: local victim-apply failed; cannot build state_override case`);
  console.log(`[finaloverlay-equiv] ${c.name} local victim out=${local.amountOut}`);

  // For v2, prove the probe resolves both tokens' balance slots and 3 overrides
  // build — otherwise the backend would silently fall back to the cold overlay and
  // the test would pass trivially without ever exercising the override path.
  if (c.adapterId === "univ2-swap") {
    const resolver = (token: string) =>
      resolveErc20BalanceSlot(token, c.pool, {
        balanceOf: async (t, h) =>
          BigInt(await provider.call({ to: t, data: BALANCE_OF.encodeFunctionData("balanceOf", [h]), blockTag: block })),
        getStorage: async (t, key) => BigInt(await provider.getStorage(t, key, block)),
      });
    const ov = await postImpactStateOverrides(local.postImpact, resolver);
    if (ov.length !== 3) throw new Error(`${c.name}: expected 3 v2 overrides from probe, got ${ov.length}`);
    console.log(`[finaloverlay-equiv] ${c.name} v2 overrides built=3 (probe ok)`);
  }
  if (c.adapterId === "univ4-unlock") {
    const ov = await postImpactStateOverrides(local.postImpact);
    if (ov.length !== 2) throw new Error(`${c.name}: expected 2 v4 overrides from probe, got ${ov.length}`);
    console.log(`[finaloverlay-equiv] ${c.name} v4 overrides built=2 (probe ok)`);
    await runV4OverrideCompare(rpcUrl, block, c, local.postImpact, quoteReq);
    return;
  }

  const coldClient = new RevmSimClient({ timeoutMs: 120_000 });
  const overrideClient = new RevmSimClient({ timeoutMs: 120_000 });
  const coldBackend = new RevmLiveBackend(coldClient, BOTVM, DEFAULT_SEARCHER_OWNER, provider, [], rpcUrl);
  const overrideBackend = new RevmLiveBackend(overrideClient, BOTVM, DEFAULT_SEARCHER_OWNER, provider, [], rpcUrl);

  try {
    await coldBackend.prepareVictimState(input);
    const coldQuote = await coldBackend.quote(quoteReq);
    const cold = await coldClient.simulatePrepared({
      owner: DEFAULT_SEARCHER_OWNER,
      executor: BOTVM,
      calldata: "0x",
      profitToken: WETH,
      gasLimit: 0x1000000,
    });

    const overrideInput = { ...input, postImpact: local.postImpact };
    await overrideBackend.warmPrepareState(overrideInput);
    await overrideBackend.prepareVictimState(overrideInput);
    const overrideQuote = await overrideBackend.quote(quoteReq);
    const override = await overrideClient.simulatePrepared({
      owner: DEFAULT_SEARCHER_OWNER,
      executor: BOTVM,
      calldata: "0x",
      profitToken: WETH,
      gasLimit: 0x1000000,
    });

    console.log(`[finaloverlay-equiv] ${c.name} coldQuote=${coldQuote.amountOut} overrideQuote=${overrideQuote.amountOut}`);
    if (coldQuote.amountOut !== overrideQuote.amountOut) {
      throw new Error(
        `${c.name}: state_override quote differs from cold overlay ` +
          `cold=${coldQuote.amountOut} override=${overrideQuote.amountOut}`,
      );
    }
    if (resultKey(cold) !== resultKey(override)) {
      throw new Error(
        `${c.name}: state_override final overlay changed simulate result ` +
          `cold=${resultKey(cold)} override=${resultKey(override)}`,
      );
    }

    if (c.checkBalances) {
      for (const token of c.checkBalances) {
        const data = BALANCE_OF.encodeFunctionData("balanceOf", [c.pool]);
        const coldBal = BigInt(await coldBackend.call({ to: token, data }));
        const ovBal = BigInt(await overrideBackend.call({ to: token, data }));
        if (coldBal !== ovBal) {
          throw new Error(`${c.name}: balanceOf(${token.slice(0, 8)},pair) cold=${coldBal} override=${ovBal}`);
        }
      }
      console.log(`[finaloverlay-equiv] ${c.name} balanceOf(pair) cold==override`);
    }
    console.log(`[finaloverlay-equiv] ${c.name} PASS`);
  } finally {
    coldClient.stop();
    overrideClient.stop();
  }
}

async function detectV4Impact(provider: ethers.JsonRpcProvider, c: V4EquivCase): Promise<PoolImpact> {
  const poolId = c.poolId.toLowerCase();
  const computedPoolId = v4PoolId(c.v4PoolKey);
  if (computedPoolId !== poolId) {
    throw new Error(`${c.name}: v4PoolId(PoolKey)=${computedPoolId} != case poolId=${poolId}`);
  }

  const receipt = await provider.getTransactionReceipt(c.txHash);
  if (!receipt) throw new Error(`${c.name}: receipt not found for ${c.txHash}`);
  if (receipt.blockNumber !== c.block) {
    throw new Error(`${c.name}: receipt block ${receipt.blockNumber} != expected ${c.block}`);
  }

  const swapLogs = receipt.logs
    .filter((log) =>
      log.address.toLowerCase() === c.pool.toLowerCase() &&
      log.topics[0]?.toLowerCase() === V4_SWAP_TOPIC &&
      log.topics[1]?.toLowerCase() === poolId)
    .map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
    }));
  if (swapLogs.length !== 1) {
    throw new Error(`${c.name}: expected 1 v4 Swap log for poolId ${poolId}, got ${swapLogs.length}`);
  }

  const event: OrderflowEvent = {
    txHash: c.txHash,
    blockNumber: c.block,
    rawTx: "0x",
    from: ethers.ZeroAddress,
    nonce: 0,
    to: null,
    input: "0x",
    logs: swapLogs,
    minProfit: 1n,
    victimState: "materialized",
  };
  const impacts = (await detectPoolImpact(event, v4Graph(c)))
    .filter((impact) =>
      impact.matchedAdapterId === "univ4-unlock" &&
      impact.poolId?.toLowerCase() === poolId);
  if (impacts.length !== 1) {
    throw new Error(`${c.name}: expected 1 decoded v4 PoolImpact, got ${impacts.length}`);
  }
  const impact = impacts[0];
  if (!impact.v4PostState || impact.amountOut === undefined || impact.amountOut <= 0n) {
    throw new Error(`${c.name}: decoded v4 impact missing post-state or amountOut`);
  }
  console.log(
    `[finaloverlay-equiv] ${c.name} decoded v4 impact ` +
      `${impact.tokenIn.slice(0, 10)}->${impact.tokenOut.slice(0, 10)} ` +
      `amountIn=${impact.amountIn} amountOut=${impact.amountOut}`,
  );
  return impact;
}

function v4Graph(c: V4EquivCase): TokenEdge[] {
  const key = c.v4PoolKey;
  const poolId = v4PoolId(key);
  return [
    v4Edge(c, key.currency0, key.currency1, poolId),
    v4Edge(c, key.currency1, key.currency0, poolId),
  ];
}

function v4Edge(c: V4EquivCase, tokenIn: string, tokenOut: string, poolId: string): TokenEdge {
  const key = c.v4PoolKey;
  return {
    adapterId: "univ4-unlock",
    target: c.pool,
    tokenIn: ethers.getAddress(tokenIn),
    tokenOut: ethers.getAddress(tokenOut),
    slotKind: "swap",
    v4PoolKey: key,
    poolId,
    nativeCurrency0: key.currency0 === ethers.ZeroAddress,
    nativeCurrency1: key.currency1 === ethers.ZeroAddress,
    ...deriveEdgeTaxonomy("swap"),
  };
}

async function runV4OverrideCompare(
  rpcUrl: string,
  block: number,
  c: V4EquivCase,
  postImpact: PostImpactSeed,
  quoteReq: QuoteRequest,
): Promise<void> {
  if (postImpact.kind !== "v4") throw new Error(`${c.name}: expected v4 postImpact, got ${postImpact.kind}`);
  const stateOverrides = await postImpactStateOverrides(postImpact);
  const coldClient = new RevmSimClient({ timeoutMs: 120_000 });
  const overrideClient = new RevmSimClient({ timeoutMs: 120_000 });

  try {
    await coldClient.prepare({
      blockNumber: block,
      rpcUrl,
      funded: [DEFAULT_SEARCHER_OWNER],
      prewarm: [DEFAULT_SEARCHER_OWNER, BOTVM, c.pool, V4_QUOTER],
    });
    const coldQuote = await quotePreparedV4(coldClient, quoteReq);
    const cold = await coldClient.simulatePrepared({
      owner: DEFAULT_SEARCHER_OWNER,
      executor: BOTVM,
      calldata: "0x",
      profitToken: WETH,
      gasLimit: 0x1000000,
    });

    await overrideClient.prepare({
      blockNumber: block,
      rpcUrl,
      funded: [DEFAULT_SEARCHER_OWNER],
      stateOverrides,
      prewarm: [DEFAULT_SEARCHER_OWNER, BOTVM, c.pool, V4_QUOTER],
    });
    const overrideQuote = await quotePreparedV4(overrideClient, quoteReq);
    const override = await overrideClient.simulatePrepared({
      owner: DEFAULT_SEARCHER_OWNER,
      executor: BOTVM,
      calldata: "0x",
      profitToken: WETH,
      gasLimit: 0x1000000,
    });

    console.log(`[finaloverlay-equiv] ${c.name} coldQuote=${coldQuote.amountOut} overrideQuote=${overrideQuote.amountOut}`);
    if (coldQuote.amountOut !== overrideQuote.amountOut) {
      throw new Error(
        `${c.name}: state_override quote differs from cold fork ` +
          `cold=${coldQuote.amountOut} override=${overrideQuote.amountOut}`,
      );
    }
    if (resultKey(cold) !== resultKey(override)) {
      throw new Error(
        `${c.name}: state_override final overlay changed simulate result ` +
          `cold=${resultKey(cold)} override=${resultKey(override)}`,
      );
    }
    console.log(`[finaloverlay-equiv] ${c.name} PASS`);
  } finally {
    coldClient.stop();
    overrideClient.stop();
  }
}

async function quotePreparedV4(client: RevmSimClient, req: QuoteRequest): Promise<QuoteResult> {
  const data = encodeUniV4QuoteExactInputSingle(req.tokenIn, req.tokenOut, req.amountIn, req.v4PoolKey);
  const resp = await client.quote({
    to: V4_QUOTER,
    data,
    gasLimit: 3_000_000,
  });
  if (resp.missingStateKeys && resp.missingStateKeys.length > 0) {
    throw new Error(`v4 quote missingState: ${resp.missingStateKeys.slice(0, 6).join(",")}`);
  }
  if (!resp.success) {
    throw new Error(resp.revertReason ?? "v4 quote reverted");
  }
  if (!resp.output || resp.output === "0x") {
    throw new Error("v4 quote returned empty output");
  }
  const decoded = uniV4QuoterIface.decodeFunctionResult("quoteExactInputSingle", resp.output);
  return { amountOut: BigInt(decoded[0]), latencyMs: resp.latencyMs, cacheStats: resp.cacheStats };
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const cases: EquivCase[] = [
    {
      name: "v3 CRV/WETH",
      adapterId: "univ3-swap",
      pool: "0x919Fa96e88d67499339577Fa202345436bcDaf79",
      victimIn: WETH,
      victimOut: CRV,
      victimAmountIn: 101859718286728000n,
      quoteIn: CRV,
      quoteOut: WETH,
      quoteAmountIn: 100n * 10n ** 18n,
    },
    {
      name: "v2 USDC/WETH",
      adapterId: "univ2-swap",
      pool: "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc",
      victimIn: WETH,
      victimOut: USDC,
      victimAmountIn: 10n ** 17n,
      quoteIn: USDC,
      quoteOut: WETH,
      quoteAmountIn: 100n * 10n ** 6n,
      checkBalances: [USDC, WETH],
    },
    {
      // Fixture chosen so this poolId has EXACTLY ONE swap in the block, so a
      // post-block fork == the victim's immediate post-swap state (no later
      // same-pool swap to reverse it). That makes cold(fork@N) a valid ground
      // truth to compare the applyV4 override against. (Block 25523003 had 3
      // swaps on this pool — tx idx2 nearly reversed the victim — so its cold
      // baseline was end-of-block, not immediate-post-victim.)
      name: "v4 USDC/USDT",
      adapterId: "univ4-unlock",
      pool: V4_POOL_MANAGER,
      block: 25_523_157,
      txHash: "0xdc56bd839c88a273bed892712dae84b1bffba6a4593b60cb043edff814cb1cde",
      poolId: "0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5",
      v4PoolKey: {
        currency0: USDC,
        currency1: USDT,
        fee: 8,
        tickSpacing: 1,
        hooks: ethers.ZeroAddress,
      },
      quoteIn: USDT,
      quoteOut: USDC,
      quoteAmountIn: 100n * 10n ** 6n,
    },
  ];

  for (const c of cases) {
    await runCase(provider, rpcUrl, c);
  }

  console.log(`final-overlay-equiv PASS (${cases.length}/${cases.length})`);
}

function resultKey(result: {
  success?: boolean;
  profit?: string;
  revertReason?: string;
}): string {
  return JSON.stringify({
    success: result.success ?? false,
    profit: result.profit ?? "0",
    revertReason: result.revertReason ?? "",
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
