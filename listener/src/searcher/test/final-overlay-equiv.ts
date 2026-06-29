import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { DEFAULT_SEARCHER_OWNER } from "../../shared/executor/botvm-executor.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolImpact } from "../detector/pool-impact.js";
import { RevmLiveBackend } from "../live-backends/revm-live-backend.js";
import { RevmSimClient } from "../revm-sim-client.js";
import { resolveErc20BalanceSlot } from "../solver/balance-slots.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { PoolStateUpdater } from "../solver/pool-state-updater.js";
import { postImpactStateOverrides } from "../solver/post-impact-overrides.js";
import { applyVictimSwapLocally } from "../solver/victim-apply.js";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const BOTVM = "0x4aF9495C4aC24c5CD3b0C90611550a1996415BCe";
const BALANCE_OF = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

interface EquivCase {
  name: string;
  adapterId: "univ2-swap" | "univ3-swap";
  pool: string;
  victimIn: string;
  victimOut: string;
  victimAmountIn: bigint;
  quoteIn: string;
  quoteOut: string;
  quoteAmountIn: bigint;
  /** v2 only: assert balanceOf(token, pair) matches the cold replay (catches a
   *  missing/incomplete balanceOf override). */
  checkBalances?: [string, string];
}

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
  const block = (await provider.getBlockNumber()) - 1;
  console.log(`[finaloverlay-equiv] ${c.name} block=${block}`);

  const impact: PoolImpact = {
    pool: c.pool,
    tokenIn: c.victimIn,
    tokenOut: c.victimOut,
    amountIn: c.victimAmountIn,
    matchedAdapterId: c.adapterId,
  };
  const event = {
    txHash: "0x0",
    blockNumber: block + 1,
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
  const quoteReq = {
    adapterId: c.adapterId,
    target: c.pool,
    tokenIn: c.quoteIn,
    tokenOut: c.quoteOut,
    amountIn: c.quoteAmountIn,
  };

  const cache = new PoolStateCache(provider);
  const updater = new PoolStateUpdater(provider, cache, { maxPools: 1, awaitTickRefreshForTest: true });
  await updater.update(block, [{
    adapterId: impact.matchedAdapterId,
    target: impact.pool,
    tokenIn: impact.tokenIn,
    tokenOut: impact.tokenOut,
    amountIn: impact.amountIn,
  }], { awaitTicks: true, maxTickPools: 1 });
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
      throw new Error(`${c.name}: state_override quote differs from cold overlay`);
    }
    if (resultKey(cold) !== resultKey(override)) {
      throw new Error(`${c.name}: state_override final overlay changed simulate result`);
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

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  await runCase(provider, rpcUrl, {
    name: "v3 CRV/WETH",
    adapterId: "univ3-swap",
    pool: "0x919Fa96e88d67499339577Fa202345436bcDaf79",
    victimIn: WETH,
    victimOut: CRV,
    victimAmountIn: 101859718286728000n,
    quoteIn: CRV,
    quoteOut: WETH,
    quoteAmountIn: 100n * 10n ** 18n,
  });

  await runCase(provider, rpcUrl, {
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
  });

  console.log("final-overlay-equiv PASS (2/2)");
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
