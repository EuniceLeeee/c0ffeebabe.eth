/**
 * Fixture extractor CLI — competitor closed-loop tx -> CoffeeFixture JSON.
 *
 * Turns a real on-chain arbitrage tx into the exact CoffeeFixture shape consumed by
 * blockscan-fork-solve.ts / blockscan-a0-replay.ts, so a new competitor loop can be
 * gated by "does our system close this loop on a fork with the expected profit".
 *
 * Read-only: fetches the receipt + logs (archive RPC), decodes each flashloan / swap /
 * protocol leg IN LOG ORDER by topic0, records the GROUND-TRUTH realized amounts from the
 * events, then reads each pool's pre-execution state at sourceBlock (executionBlock-1). The
 * ~intra-block-drift caveat of reading at the block boundary is noted in preStateNote.
 *
 * Usage:
 *   npm run searcher:extract-loop-fixture -- --tx <hash> [--rpc <archive-url>] [--out <path>]
 *
 * Mainnet fork/dry-run research only; no signing, no broadcast.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";

// ── Event topic0s (all cast-verified 2026-07-07) ──
const T = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  balancerV2Flash: "0x0d7d75e01ab95780d3cd1c8ec0dd6c2ce19e3a20427eec8bf53283b6fb8e95f0",
  aaveV3Flash: "0xefefaba5e921573100900a3ad9cf29f222d995fb3b6045797eaea7521bd8d6f0",
  univ2Swap: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  univ3Swap: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  pancakeV3Swap: "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83",
  univ4Swap: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  curveTokenExchangeI128: "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140",
  curveTokenExchangeU256: "0xb2e76ae99761dc136e598d4a629bb347eccb9532a5f8bbd72e18467c3c34cc98",
  balancerV1LogSwap: "0x908fb5ee8f16c6bc9bc3690973819f32a4d4b10188134543c88706e0e1d43378",
  balancerV1LogExit: "0xe74c91552b64c2e2e7bd255639e004e693bd3e1d01cc33e65610b86afcc1ffed",
  balancerV1LogJoin: "0x63982df10efd8dfaaaa0fcc7f50b2d93b7cba26ccc48adee2873220d485dc39a",
  erc4626Deposit: "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7",
  erc4626Withdraw: "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db",
} as const;

const abi = ethers.AbiCoder.defaultAbiCoder();

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
}

interface CliArgs {
  txHash: string;
  rpcUrl: string;
  outPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let txHash: string | undefined;
  let rpcUrl: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tx") txHash = argv[++i];
    else if (a === "--rpc") rpcUrl = argv[++i];
    else if (a === "--out") outPath = argv[++i];
  }
  if (!txHash) throw new Error("usage: --tx <hash> [--rpc <archive-url>] [--out <path>]");
  rpcUrl = rpcUrl || loadEnvRpc();
  if (!rpcUrl) throw new Error("no --rpc and no MAINNET_RPC_URL/SEARCHER_LIVE_RPC_URL in .env");
  return { txHash: txHash.toLowerCase(), rpcUrl, outPath };
}

function loadEnvRpc(): string | undefined {
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (key === "SEARCHER_LIVE_RPC_URL" || key === "MAINNET_RPC_URL") {
      return rest.join("=").replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? "<redacted>" : "";
    parsed.password = parsed.password ? "<redacted>" : "";
    const localHost =
      parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    if (!localHost && parsed.pathname && parsed.pathname !== "/") parsed.pathname = "/<redacted>";
    if (parsed.search) parsed.search = "?<redacted>";
    return parsed.toString();
  } catch {
    return url.startsWith("http") ? "<rpc-url>" : url;
  }
}

function addr(topicOrAddress: string): string {
  // 32-byte topic -> 20-byte address, or pass through a plain address.
  const hex = topicOrAddress.toLowerCase().replace(/^0x/, "");
  const last40 = hex.length >= 40 ? hex.slice(-40) : hex.padStart(40, "0");
  return ethers.getAddress("0x" + last40);
}

// ─── Leg decoders ───────────────────────────────────────────

interface DecodedLeg {
  seq: number;
  kind: "univ2" | "univ3" | "univ4" | "curve" | "balancer-v1" | "erc4626";
  poolId?: string;
  poolKey?: Record<string, unknown>;
  address?: string;
  pool?: string;
  token0?: string;
  token1?: string;
  tokenIn?: string;
  tokenOut?: string;
  zeroForOne?: boolean;
  soldId?: number;
  boughtId?: number;
  vault?: string;
  logIndex: number;
  realized: { amountIn: string; amountOut: string };
  role: string;
  _decodeNote?: string;
}

/** Decode a univ2 Swap. token0/token1 filled later from RPC; direction from which in/out is nonzero. */
function decodeUniv2(log: RawLog): Omit<DecodedLeg, "seq" | "role"> {
  const [a0In, a1In, a0Out, a1Out] = abi.decode(["uint256", "uint256", "uint256", "uint256"], log.data) as bigint[];
  // token1 in -> token0 out (oneForZero) OR token0 in -> token1 out (zeroForOne).
  const zeroForOne = a0In > 0n;
  const amountIn = zeroForOne ? a0In : a1In;
  const amountOut = zeroForOne ? a1Out : a0Out;
  return {
    kind: "univ2",
    address: ethers.getAddress(log.address),
    pool: ethers.getAddress(log.address),
    zeroForOne,
    logIndex: log.logIndex,
    realized: { amountIn: amountIn.toString(), amountOut: amountOut.toString() },
  };
}

/** Decode a univ3 / pancake-v3 Swap. amount0/amount1 are signed; negative = pool paid out. */
function decodeUniv3(log: RawLog, pancake: boolean): Omit<DecodedLeg, "seq" | "role"> {
  // univ3: (int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  // pancake adds (uint128 protocolFeesToken0, uint128 protocolFeesToken1) — extra tail, first 5 identical.
  const [a0, a1] = abi.decode(
    pancake
      ? ["int256", "int256", "uint160", "uint128", "int24", "uint128", "uint128"]
      : ["int256", "int256", "uint160", "uint128", "int24"],
    log.data,
  ) as bigint[];
  const zeroForOne = a0 > 0n; // token0 in (positive), token1 out (negative)
  const amountIn = zeroForOne ? a0 : a1;
  const amountOut = zeroForOne ? -a1 : -a0;
  return {
    kind: "univ3",
    address: ethers.getAddress(log.address),
    pool: ethers.getAddress(log.address),
    zeroForOne,
    logIndex: log.logIndex,
    realized: { amountIn: amountIn.toString(), amountOut: amountOut.toString() },
  };
}

/** Decode a univ4 PoolManager Swap. poolId from topic1; amounts signed. poolKey recovery is out of scope (v1). */
function decodeUniv4(log: RawLog): Omit<DecodedLeg, "seq" | "role"> {
  // topics: [topic0, id (bytes32), sender (address)]
  // data: (int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
  const poolId = log.topics[1].toLowerCase();
  const [a0, a1, sqrtP, liq, tick] = abi.decode(
    ["int128", "int128", "uint160", "uint128", "int24", "uint24"],
    log.data,
  ) as bigint[];
  // v4 sign convention: amount0/amount1 in the PoolManager Swap event are the SWAPPER's balance deltas
  // (a BalanceDelta), NOT the manager's. A negative delta = the swapper PAID that token (token IN); a
  // positive delta = the swapper RECEIVED it (token OUT). So token0-in (zeroForOne) has amount0 < 0.
  // (Verified byte-exact against f2de7499: leg1 a0=-1807735808 a1=+1809208404 is USDC->USDT zeroForOne.)
  const zeroForOne = a0 < 0n; // token0 paid in (negative), token1 received (positive)
  const amountIn = zeroForOne ? -a0 : -a1;
  const amountOut = zeroForOne ? a1 : a0;
  return {
    kind: "univ4",
    poolId,
    poolKey: { recovered: false, _todo: "keccak brute-force of poolId over (tokens,fee,tickSpacing,hooks)" },
    address: ethers.getAddress(log.address), // PoolManager singleton
    zeroForOne,
    logIndex: log.logIndex,
    realized: { amountIn: amountIn.toString(), amountOut: amountOut.toString() },
    _decodeNote: `postStateFromEvent sqrtPriceX96=${sqrtP} liquidity=${liq} tick=${tick}`,
  };
}

/** Decode a curve TokenExchange (int128 or uint256 id variant). */
function decodeCurve(log: RawLog, i128: boolean): Omit<DecodedLeg, "seq" | "role"> {
  // TokenExchange(buyer, sold_id, tokens_sold, bought_id, tokens_bought)
  const types = i128
    ? ["int128", "uint256", "int128", "uint256"]
    : ["uint256", "uint256", "uint256", "uint256"];
  const [soldId, tokensSold, boughtId, tokensBought] = abi.decode(types, log.data) as bigint[];
  return {
    kind: "curve",
    pool: ethers.getAddress(log.address),
    address: ethers.getAddress(log.address),
    soldId: Number(soldId),
    boughtId: Number(boughtId),
    logIndex: log.logIndex,
    realized: { amountIn: tokensSold.toString(), amountOut: tokensBought.toString() },
  };
}

/**
 * Decode a Balancer V1 single-asset exit (LOG_EXIT). amountIn = BPT burned (the Transfer of the pool
 * token to 0x0 immediately following), amountOut = tokenOut amount from the LOG_EXIT data.
 * LOG_EXIT(caller indexed, tokenOut indexed, tokenAmountOut) — tokenOut in topic2, amount in data.
 */
function decodeBalancerV1Exit(log: RawLog, allLogs: RawLog[]): Omit<DecodedLeg, "seq" | "role"> {
  const tokenOut = addr(log.topics[2]);
  const [tokenAmountOut] = abi.decode(["uint256"], log.data) as bigint[];
  // BPT burned = the Transfer of the pool's own token (log.address) TO the zero address, closest after.
  const pool = log.address.toLowerCase();
  let bptBurned = 0n;
  for (const l of allLogs) {
    if (l.logIndex <= log.logIndex) continue;
    if (l.topics[0].toLowerCase() !== T.transfer) continue;
    if (l.address.toLowerCase() !== pool) continue;
    if (addr(l.topics[2]) !== ethers.ZeroAddress) continue;
    bptBurned = (abi.decode(["uint256"], l.data) as bigint[])[0];
    break;
  }
  return {
    kind: "balancer-v1",
    pool: ethers.getAddress(log.address),
    address: ethers.getAddress(log.address),
    tokenIn: ethers.getAddress(log.address), // BPT (the pool token) is burned
    tokenOut,
    logIndex: log.logIndex,
    realized: { amountIn: bptBurned.toString(), amountOut: tokenAmountOut.toString() },
    _decodeNote: "single-asset exit: amountIn = BPT burned (Transfer to 0x0), amountOut = LOG_EXIT tokenAmountOut",
  };
}

/** Decode a Balancer V1 LOG_SWAP: (caller, tokenIn indexed, tokenOut indexed, amountIn, amountOut). */
function decodeBalancerV1Swap(log: RawLog): Omit<DecodedLeg, "seq" | "role"> {
  const tokenIn = addr(log.topics[2]);
  const tokenOut = addr(log.topics[3]);
  const [amountIn, amountOut] = abi.decode(["uint256", "uint256"], log.data) as bigint[];
  return {
    kind: "balancer-v1",
    pool: ethers.getAddress(log.address),
    address: ethers.getAddress(log.address),
    tokenIn,
    tokenOut,
    logIndex: log.logIndex,
    realized: { amountIn: amountIn.toString(), amountOut: amountOut.toString() },
  };
}

/** Decode an erc4626 Withdraw (share->asset redeem) or Deposit (asset->share). */
function decodeErc4626(log: RawLog, isWithdraw: boolean): Omit<DecodedLeg, "seq" | "role"> {
  if (isWithdraw) {
    // Withdraw(sender, receiver, owner, assets, shares)
    const [assets, shares] = abi.decode(["uint256", "uint256"], log.data) as bigint[];
    return {
      kind: "erc4626",
      vault: ethers.getAddress(log.address),
      address: ethers.getAddress(log.address),
      logIndex: log.logIndex,
      realized: { amountIn: shares.toString(), amountOut: assets.toString() },
      _decodeNote: "erc4626 redeem: amountIn = shares burned, amountOut = assets() paid (see nonStandardRedeem caveat)",
    };
  }
  // Deposit(sender, owner, assets, shares)
  const [assets, shares] = abi.decode(["uint256", "uint256"], log.data) as bigint[];
  return {
    kind: "erc4626",
    vault: ethers.getAddress(log.address),
    address: ethers.getAddress(log.address),
    logIndex: log.logIndex,
    realized: { amountIn: assets.toString(), amountOut: shares.toString() },
    _decodeNote: "erc4626 deposit: amountIn = assets, amountOut = shares minted",
  };
}

// ─── Flashloan detection ─────────────────────────────────────

interface FlashInfo {
  venue: "balancer-v2" | "aave-v3";
  token: string;
  amount: string;
  fee: string;
  /** The flash recipient contract — the account that receives the disbursement and repays the venue. */
  recipient: string;
}

function detectFlash(logs: RawLog[]): FlashInfo | null {
  for (const log of logs) {
    const t0 = log.topics[0].toLowerCase();
    if (t0 === T.balancerV2Flash) {
      // FlashLoan(recipient indexed, token indexed, amount, feeAmount)
      const recipient = addr(log.topics[1]);
      const token = addr(log.topics[2]);
      const [amount, fee] = abi.decode(["uint256", "uint256"], log.data) as bigint[];
      return { venue: "balancer-v2", token, amount: amount.toString(), fee: fee.toString(), recipient };
    }
    if (t0 === T.aaveV3Flash) {
      // FlashLoan(target indexed, initiator, asset indexed, amount, interestRateMode, premium, referralCode indexed)
      const recipient = addr(log.topics[1]);
      const token = addr(log.topics[2]);
      const [, amount, , premium] = abi.decode(
        ["address", "uint256", "uint8", "uint256"],
        log.data,
      ) as bigint[];
      return { venue: "aave-v3", token, amount: amount.toString(), fee: premium.toString(), recipient };
    }
  }
  return null;
}

// ─── preState readers (read at sourceBlock = executionBlock-1) ──

async function readPreState(
  leg: DecodedLeg,
  provider: ethers.JsonRpcProvider,
  sourceBlock: number,
): Promise<Record<string, unknown> | undefined> {
  const blockTag = ethers.toBeHex(sourceBlock);
  try {
    switch (leg.kind) {
      case "univ2": {
        const data = await provider.call({
          to: leg.pool!,
          data: "0x0902f1ac", // getReserves()
          blockTag,
        } as ethers.TransactionRequest);
        const [r0, r1] = abi.decode(["uint112", "uint112", "uint32"], data) as bigint[];
        return { reserves: { r0: r0.toString(), r1: r1.toString() } };
      }
      case "univ3": {
        const slot0 = await provider.call({ to: leg.pool!, data: "0x3850c7bd", blockTag } as ethers.TransactionRequest); // slot0()
        const liq = await provider.call({ to: leg.pool!, data: "0x1a686502", blockTag } as ethers.TransactionRequest); // liquidity()
        const sqrtPriceX96 = (abi.decode(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], slot0) as bigint[])[0];
        const liquidity = (abi.decode(["uint128"], liq) as bigint[])[0];
        return { sqrtPriceX96: sqrtPriceX96.toString(), liquidity: liquidity.toString() };
      }
      case "univ4":
        // v4 slot0/liquidity require poolId + StateView; deferred with poolKey recovery (v1 records event post-state only).
        return { _todo: "v4 preState needs StateView(poolId); see poolKey recovery TODO", recovered: false };
      case "curve": {
        // balances(i) per coin — read for the two involved coin ids.
        const bIn = await callUint(provider, leg.pool!, "0x4903b0d1", leg.soldId!, blockTag); // balances(uint256)
        const bOut = await callUint(provider, leg.pool!, "0x4903b0d1", leg.boughtId!, blockTag);
        return { variant: "unknown", balances: { [leg.soldId!]: bIn?.toString(), [leg.boughtId!]: bOut?.toString() }, _note: "A/fee/rates require pool-version-specific reads; recorded balances only for v1" };
      }
      case "balancer-v1": {
        // Balancer V1 BPool reads: getSwapFee() 0x1c1b8772 ; totalSupply() 0x18160ddd ;
        // getBalance(address) 0xf8b2cb4f ; getDenormalizedWeight(address) 0x948d8ce6.
        const state: Record<string, unknown> = {};
        state.getSwapFee = (await callRaw(provider, leg.pool!, "0x1c1b8772", blockTag))?.toString();
        state.totalSupply = (await callRaw(provider, leg.pool!, "0x18160ddd", blockTag))?.toString();
        if (leg.tokenOut) {
          state.balanceTokenOut = (await callAddrArg(provider, leg.pool!, "0xf8b2cb4f", leg.tokenOut, blockTag))?.toString();
          state.weightTokenOut = (await callAddrArg(provider, leg.pool!, "0x948d8ce6", leg.tokenOut, blockTag))?.toString();
        }
        return state;
      }
      case "erc4626": {
        const totalAssets = (await callRaw(provider, leg.vault!, "0x01e1d114", blockTag))?.toString(); // totalAssets()
        const totalSupply = (await callRaw(provider, leg.vault!, "0x18160ddd", blockTag))?.toString(); // totalSupply()
        return { totalAssets, totalSupply, _note: "erc4626 redeem edge output token may differ from asset() — see nonStandardRedeem" };
      }
    }
  } catch (err) {
    return { _preStateError: err instanceof Error ? err.message : String(err) };
  }
  return undefined;
}

async function callRaw(
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
  blockTag: string,
): Promise<bigint | undefined> {
  try {
    const out = await provider.call({ to, data, blockTag } as ethers.TransactionRequest);
    if (!out || out === "0x") return undefined;
    return (abi.decode(["uint256"], out) as bigint[])[0];
  } catch {
    return undefined;
  }
}

async function callUint(
  provider: ethers.JsonRpcProvider,
  to: string,
  selector: string,
  arg: number,
  blockTag: string,
): Promise<bigint | undefined> {
  const data = selector + abi.encode(["uint256"], [BigInt(arg)]).slice(2);
  return callRaw(provider, to, data, blockTag);
}

async function callAddrArg(
  provider: ethers.JsonRpcProvider,
  to: string,
  selector: string,
  argAddr: string,
  blockTag: string,
): Promise<bigint | undefined> {
  const data = selector + abi.encode(["address"], [argAddr]).slice(2);
  return callRaw(provider, to, data, blockTag);
}

const UNISWAP_V4_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
// Initialize(id indexed, currency0 indexed, currency1 indexed, fee, tickSpacing, hooks, sqrtPriceX96, tick)
const V4_INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

/**
 * Recover a v4 PoolKey from the PoolManager's Initialize log for this poolId — a targeted archive read
 * (NOT keccak brute-force): currency0/1 are indexed; fee/tickSpacing/hooks are in the data. Returns a
 * poolKey object with recovered:true, or {recovered:false} if the Initialize log can't be found.
 */
async function recoverV4PoolKey(
  provider: ethers.JsonRpcProvider,
  poolId: string,
): Promise<Record<string, unknown>> {
  try {
    const logs = await provider.getLogs({
      address: UNISWAP_V4_POOL_MANAGER,
      topics: [V4_INITIALIZE_TOPIC, poolId],
      fromBlock: 0,
      toBlock: "latest",
    });
    if (logs.length === 0) return { recovered: false, _note: "no Initialize log found for poolId" };
    const log = logs[0];
    const currency0 = addr(log.topics[2]);
    const currency1 = addr(log.topics[3]);
    const decoded = abi.decode(["uint24", "int24", "address", "uint160", "int24"], log.data);
    const fee = decoded[0] as bigint;
    const tickSpacing = decoded[1] as bigint;
    const hooks = decoded[2] as string;
    return {
      recovered: true,
      currency0,
      currency1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      hooks: ethers.getAddress(hooks),
      _source: `PoolManager Initialize log (tx ${log.transactionHash})`,
    };
  } catch (err) {
    return { recovered: false, _error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read an ERC20 symbol() (best-effort; some tokens return bytes32 or nothing). */
async function readTokenSymbol(provider: ethers.JsonRpcProvider, token: string): Promise<string> {
  try {
    const out = await provider.call({ to: token, data: "0x95d89b41" } as ethers.TransactionRequest); // symbol()
    if (!out || out === "0x") return "?";
    try {
      return (abi.decode(["string"], out) as string[])[0] || "?";
    } catch {
      // bytes32 symbol fallback (e.g. MKR-style tokens).
      return ethers.toUtf8String(out).replace(/\0+$/, "") || "?";
    }
  } catch {
    return "?";
  }
}

/** Fill univ2/univ3/curve/erc4626 leg tokens + resolve tokenIn/tokenOut from the decoded direction. */
async function fillPoolTokens(leg: DecodedLeg, provider: ethers.JsonRpcProvider): Promise<void> {
  try {
    if (leg.kind === "univ2" || leg.kind === "univ3") {
      const t0raw = await provider.call({ to: leg.pool!, data: "0x0dfe1681" } as ethers.TransactionRequest); // token0()
      const t1raw = await provider.call({ to: leg.pool!, data: "0xd21220a7" } as ethers.TransactionRequest); // token1()
      const t0 = addr(t0raw);
      const t1 = addr(t1raw);
      leg.token0 = t0;
      leg.token1 = t1;
      leg.tokenIn = leg.zeroForOne ? t0 : t1;
      leg.tokenOut = leg.zeroForOne ? t1 : t0;
    } else if (leg.kind === "curve" && leg.soldId !== undefined && leg.boughtId !== undefined) {
      // coins(i): resolve the sold/bought coin addresses for tokenIn/tokenOut.
      leg.tokenIn = await curveCoin(provider, leg.pool!, leg.soldId);
      leg.tokenOut = await curveCoin(provider, leg.pool!, leg.boughtId);
    } else if (leg.kind === "erc4626" && leg.vault) {
      // Withdraw/redeem: shares (vault token) in -> asset() out. Deposit is the reverse.
      const asset = addr(await provider.call({ to: leg.vault, data: "0x38d52e0f" } as ethers.TransactionRequest)); // asset()
      const isWithdraw = leg._decodeNote?.includes("redeem") ?? true;
      leg.tokenIn = isWithdraw ? ethers.getAddress(leg.vault) : asset;
      leg.tokenOut = isWithdraw ? asset : ethers.getAddress(leg.vault);
    }
  } catch {
    /* leave undefined; direction still recorded via zeroForOne / soldId */
  }
}

async function curveCoin(provider: ethers.JsonRpcProvider, pool: string, i: number): Promise<string> {
  const data = "0xc6610657" + abi.encode(["uint256"], [BigInt(i)]).slice(2); // coins(uint256)
  return addr(await provider.call({ to: pool, data } as ethers.TransactionRequest));
}

// ─── Loop surplus ────────────────────────────────────────────

/**
 * Trim the decoded legs to the CLOSED LOOP and compute its realized surplus in loopToken units.
 *
 * The loop is a linear ring in the flash token: leg[0].tokenIn == flashToken, and we thread forward
 * (leg[i].tokenOut == leg[i+1].tokenIn) until a leg's tokenOut RETURNS to the flash token — that leg
 * closes the loop. Legs AFTER loop-closure (e.g. a bonus USDC->WETH profit-conversion sweep) are NOT
 * part of the closed loop and are dropped, so the emitted fixture is a single flashToken->…->flashToken
 * ring that the loop-fork-gate's fixed-path Assertion B (which measures grossProfit in the flash token)
 * can execute and close. Surplus = closing leg's realized amountOut − flashAmount − flashFee.
 *
 * Requires each leg to carry tokenIn/tokenOut (filled by fillPoolTokens / v4 poolKey recovery). If the
 * first leg doesn't start at the flash token or the ring never returns to it, we can't identify a linear
 * loop — return all legs untrimmed with a diagnostic surplus of 0 (the gate will then RED clearly).
 */
function computeLoopSurplus(
  legs: DecodedLeg[],
  flash: FlashInfo,
): { loopLegs: DecodedLeg[]; units: string; note: string } {
  const flashToken = flash.token.toLowerCase();
  const flashAmount = BigInt(flash.amount);
  const flashFee = BigInt(flash.fee);

  const threaded = legs.every((l) => l.tokenIn && l.tokenOut);
  if (!threaded || legs.length === 0 || legs[0].tokenIn!.toLowerCase() !== flashToken) {
    return {
      loopLegs: legs,
      units: "0",
      note:
        `could not identify a linear loop in the flash token ${flashToken} ` +
        `(first leg tokenIn=${legs[0]?.tokenIn ?? "?"}); emitted all ${legs.length} legs untrimmed`,
    };
  }

  // Thread forward until a leg returns to the flash token.
  let closeIdx = -1;
  for (let i = 0; i < legs.length; i++) {
    if (i > 0 && legs[i].tokenIn!.toLowerCase() !== legs[i - 1].tokenOut!.toLowerCase()) {
      // Chain broke before closing — not a single linear ring (branched/DAG loop).
      break;
    }
    if (legs[i].tokenOut!.toLowerCase() === flashToken) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx < 0) {
    return {
      loopLegs: legs,
      units: "0",
      note: `flash-token ring never closed (checked ${legs.length} legs); emitted all legs untrimmed`,
    };
  }

  const loopLegs = legs.slice(0, closeIdx + 1);
  const loopReturn = BigInt(loopLegs[closeIdx].realized.amountOut);
  const surplus = loopReturn - flashAmount - flashFee;
  return {
    loopLegs,
    units: surplus.toString(),
    note:
      `linear loop closes at leg ${closeIdx + 1} (${loopLegs.length} legs, ${legs.length - loopLegs.length} ` +
      `post-loop conversion leg(s) dropped); return=${loopReturn} flash=${flashAmount} fee=${flashFee}; ` +
      `surplus = return − flash − fee`,
  };
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = new ethers.JsonRpcProvider(args.rpcUrl);

  const receipt = await provider.getTransactionReceipt(args.txHash);
  if (!receipt) throw new Error(`no receipt for ${args.txHash} (archive RPC required)`);
  if (receipt.status !== 1) throw new Error(`tx ${args.txHash} did not succeed (status ${receipt.status})`);

  const executionBlock = receipt.blockNumber;
  const sourceBlock = executionBlock - 1;
  const txIndex = receipt.index;
  const executor = receipt.from;

  // ethers v6 receipt.logs are readonly Log objects; normalize to RawLog with numeric logIndex.
  const logs: RawLog[] = receipt.logs.map((l) => ({
    address: l.address,
    topics: [...l.topics],
    data: l.data,
    logIndex: l.index,
  }));

  const flash = detectFlash(logs);
  if (!flash) throw new Error("no Balancer V2 / Aave V3 flashloan event found in tx logs");

  // Decode each venue leg IN LOG ORDER.
  const legs: DecodedLeg[] = [];
  let seq = 0;
  for (const log of logs) {
    const t0 = log.topics[0].toLowerCase();
    let decoded: Omit<DecodedLeg, "seq" | "role"> | null = null;
    if (t0 === T.univ2Swap) decoded = decodeUniv2(log);
    else if (t0 === T.univ3Swap) decoded = decodeUniv3(log, false);
    else if (t0 === T.pancakeV3Swap) decoded = decodeUniv3(log, true);
    else if (t0 === T.univ4Swap) decoded = decodeUniv4(log);
    else if (t0 === T.curveTokenExchangeI128) decoded = decodeCurve(log, true);
    else if (t0 === T.curveTokenExchangeU256) decoded = decodeCurve(log, false);
    else if (t0 === T.balancerV1LogExit) decoded = decodeBalancerV1Exit(log, logs);
    else if (t0 === T.balancerV1LogSwap) decoded = decodeBalancerV1Swap(log);
    else if (t0 === T.erc4626Withdraw) decoded = decodeErc4626(log, true);
    else if (t0 === T.erc4626Deposit) decoded = decodeErc4626(log, false);
    if (!decoded) continue;
    seq += 1;
    legs.push({ ...decoded, seq, role: `leg ${seq} (${decoded.kind})` });
  }

  if (legs.length === 0) throw new Error("no decodable venue legs found");

  // Fill univ2/univ3 pool tokens (latest-state is fine: token0/token1 are immutable).
  for (const leg of legs) await fillPoolTokens(leg, provider);

  // Recover v4 poolKeys from the PoolManager Initialize log + resolve tokenIn/tokenOut by direction.
  for (const leg of legs) {
    if (leg.kind !== "univ4" || !leg.poolId) continue;
    const key = await recoverV4PoolKey(provider, leg.poolId);
    leg.poolKey = key;
    if (key.recovered) {
      const c0 = key.currency0 as string;
      const c1 = key.currency1 as string;
      // zeroForOne: token0 in, token1 out. graph aliases native ETH (0x0) to WETH is done downstream.
      leg.token0 = c0;
      leg.token1 = c1;
      leg.tokenIn = leg.zeroForOne ? c0 : c1;
      leg.tokenOut = leg.zeroForOne ? c1 : c0;
    }
  }

  // Trim the decoded legs to the closed flash-token ring (dropping any post-loop bonus conversion
  // legs), and compute the realized surplus from the ring's closing return. The gate's fixed-path
  // Assertion B measures grossProfit in the flash token, so the emitted loop must close in it.
  const loop = computeLoopSurplus(legs, flash);
  const loopLegs = loop.loopLegs;
  loopLegs.forEach((leg, i) => {
    leg.seq = i + 1;
    leg.role = `leg ${i + 1} (${leg.kind})`;
  });
  const loopSurplus = { units: loop.units, note: loop.note };

  // Read pre-execution state at sourceBlock for each (retained) leg.
  for (const leg of loopLegs) {
    const preState = await readPreState(leg, provider, sourceBlock);
    if (preState) (leg as DecodedLeg & { preState?: unknown }).preState = preState;
  }

  const flashTokenSymbol = await readTokenSymbol(provider, flash.token);

  const fixture = {
    _note:
      `Extracted competitor closed-loop fixture from ${args.txHash} (block ${executionBlock}, txIndex ${txIndex}). ` +
      `${loopLegs.length} loop legs: ${loopLegs.map((l) => l.kind).join(" -> ")}. loopToken flash = ${flash.venue}.`,
    _provenance:
      "Auto-extracted by extract-loop-fixture.ts: realized amounts decoded from event logs (GROUND TRUTH); " +
      "preState read read-only at sourceBlock (executionBlock-1) via eth_call at that block tag. " +
      "v4 poolKey recovery + v4 preState (StateView) are TODO in v1 (poolId + raw event amounts recorded). " +
      "curve pre-state records coin balances only (A/fee/rates are pool-version-specific reads).",
    preStateNote:
      "preState is read at the block-1 BOUNDARY, not the exact intra-block pre-tx point. If earlier txs in " +
      "executionBlock touched a leg's pool, the true pre-tx state drifts from this boundary read. Realized " +
      "amounts (from the events) are exact; only the pre-state carries this ~intra-block-drift caveat.",
    txHash: args.txHash,
    executionBlock,
    sourceBlock,
    txIndex,
    executor,
    strategyKind: "block-scan",
    edgeKinds: ["flash", "swap"],
    stateSource: "auto-extracted (event-realized amounts exact; preState boundary-read)",
    flash: {
      venue: flash.venue,
      token: flash.token,
      tokenSymbol: flashTokenSymbol,
      amount: flash.amount,
      fee: flash.fee,
      recipient: flash.recipient,
    },
    loopToken: flash.token,
    legs: loopLegs,
    loopSurplusRealized: loopSurplus,
    expectedGrossWeiRealized: loopSurplus.units,
    expectedGrossWei: loopSurplus.units,
    _gate:
      "Consume with loop-fork-gate (blockscan-fork-solve.ts --fixture): Assertion A asserts every leg's pool " +
      "yields an edge in buildTokenGraph (RED if a venue kind has no adapter); Assertion B forks + executes " +
      "the loop and asserts net output >= expectedGrossWeiRealized * tolerance.",
  };

  const out = JSON.stringify(fixture, null, 2);
  if (args.outPath) {
    writeFileSync(args.outPath, out + "\n");
    console.log(`[extract-loop-fixture] wrote ${args.outPath}`);
  } else {
    console.log(out);
  }
  console.error(
    `[extract-loop-fixture] tx=${args.txHash} rpc=${redactRpcUrl(args.rpcUrl)} block=${executionBlock} ` +
      `txIndex=${txIndex} decoded=${legs.length} loopLegs=${loopLegs.length} ` +
      `(${loopLegs.map((l) => l.kind).join(",")}) flash=${flash.venue}/${flash.amount} surplus=${loopSurplus.units}`,
  );
}

main().catch((err) => {
  console.error(`extract-loop-fixture FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
