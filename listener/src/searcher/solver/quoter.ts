import { ethers } from "ethers";
import { PROTOCOL_LEG_DESCRIPTORS } from "../../adapters/protocol-legs.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { V4PoolKey } from "../planner/token-graph.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";
export { quoteBalancerV3 } from "../venues/swaps/balancer-v3.js";
import { quoteCurvePlain } from "../venues/swaps/curve-shared.js";
import type { V4QuotePathStats } from "../venues/route-leg-adapter.js";
export type { V4QuotePathStats } from "../venues/route-leg-adapter.js";
export {
  encodeUniV4QuoteExactInputSingle,
  uniV4QuoterIface,
} from "../venues/swaps/univ4.js";
import type { PoolStateCache } from "./pool-state-cache.js";

/**
 * Quoter — per-protocol amountOut estimation on the current fork state.
 * Returns "what would amountIn give you if you swapped right now".
 *
 * Used by amount-propagation to chain swap amounts through a path,
 * which then feeds solver's binary-search over flashAmount.
 *
 * Curve / UniV3 have on-chain quoters. Protocols without an exact quote or
 * dry-run path fail-fast here instead of emitting placeholder amounts.
 */

const FLUID_DEX_RESOLVER_ENV = "FLUID_DEX_RESOLVER";
export const FLUID_DEX_ADDRESS_DEAD = "0x000000000000000000000000000000000000dEaD";

type CallBackend = Pick<StateBackend, "call">;

// ── GOLDx (fully collateralized PAXG conversion) ─────────────

const goldxIface = new ethers.Interface([
  "function unit() view returns (uint256)",
]);
const GOLDX_WAD = 10n ** 18n;

export async function quoteGoldxMint(
  state: CallBackend,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  if (
    tokenIn.toLowerCase() !== ADDR.PAXG.toLowerCase() ||
    tokenOut.toLowerCase() !== ADDR.GOLDX.toLowerCase()
  ) {
    throw new Error(`GOLDx mint only supports PAXG->GOLDx, got ${tokenIn} -> ${tokenOut}`);
  }
  const data = goldxIface.encodeFunctionData("unit");
  const result = await state.call({ to: target, data });
  const unit = BigInt(goldxIface.decodeFunctionResult("unit", result)[0]);
  if (unit <= 0n) throw new Error(`GOLDx unit() returned ${unit}`);
  return amountIn * unit / GOLDX_WAD;
}

// ── PSM (Sky/Maker stable swap, 1:1 with decimal scaling) ──────

const psmIface = new ethers.Interface([
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
]);
const WAD = 10n ** 18n;
const PSM_TO18 = 10n ** 12n;

async function readPSMFee(
  state: StateBackend,
  target: string,
  fee: "tin" | "tout",
): Promise<bigint> {
  try {
    const result = await state.call({
      to: target,
      data: psmIface.encodeFunctionData(fee),
    });
    const decoded = psmIface.decodeFunctionResult(fee, result);
    return BigInt(decoded[0]);
  } catch {
    return 0n;
  }
}

async function quotePSM(
  state: StateBackend,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const usdc = ADDR.USDC.toLowerCase();
  const dai = ADDR.DAI.toLowerCase();
  const tIn = tokenIn.toLowerCase();
  const tOut = tokenOut.toLowerCase();
  const sellsGem = tIn === usdc && tOut === dai;
  const buysGem = tIn === dai && tOut === usdc;
  if (!sellsGem && !buysGem) {
    throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
  }
  const [tin, tout] = await Promise.all([
    readPSMFee(state, target, "tin"),
    readPSMFee(state, target, "tout"),
  ]);
  if (sellsGem) {
    const gemAmt18 = amountIn * PSM_TO18;
    const fee = gemAmt18 * tin / WAD;
    return gemAmt18 - fee;
  }
  if (buysGem) {
    const gemAmt18 = amountIn * WAD / (WAD + tout);
    return gemAmt18 / PSM_TO18;
  }
  throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
}

// -- Descriptor-backed protocol legs ----------------------------

function protocolLegQuoteFunctionName(adapterId: string, signature: string): string {
  const paren = signature.indexOf("(");
  if (paren <= 0) {
    throw new Error(`invalid protocol leg quote signature for ${adapterId}: ${signature}`);
  }
  return signature.slice(0, paren);
}

function protocolLegQuoteAbi(signature: string): string {
  if (/\breturns\s*\(/.test(signature)) return `function ${signature}`;
  return `function ${signature} view returns (uint256)`;
}

export async function quoteProtocolLeg(
  state: StateBackend,
  target: string,
  adapterId: string,
  amountIn: bigint,
): Promise<bigint> {
  const desc = PROTOCOL_LEG_DESCRIPTORS.find((entry) => entry.id === adapterId);
  if (!desc) {
    throw new Error(`protocol leg quote descriptor not found for adapter ${adapterId}`);
  }
  if (desc.quoteSig === undefined) {
    throw new Error(`protocol leg ${adapterId} has no quoteSig`);
  }
  const iface = new ethers.Interface([protocolLegQuoteAbi(desc.quoteSig)]);
  const fnName = protocolLegQuoteFunctionName(adapterId, desc.quoteSig);
  const data = iface.encodeFunctionData(fnName, [amountIn]);
  const result = await state.call({ to: target, data });
  const decoded = iface.decodeFunctionResult(fnName, result);
  return BigInt(decoded[0]);
}

const siloRedeemIface = new ethers.Interface([
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
]);

/**
 * Non-standard ERC4626 silo redeem (e.g. srUSDe -> sUSDe). The vault's previewRedeem returns an
 * asset()-denominated VALUE (USDe), and the silo pays the out-token (sUSDe) at that token's
 * previewWithdraw of the value — byte-exact to the on-chain payout (verified via callTracer: the
 * silo staticcalls previewWithdraw itself, diff 0). Two SEQUENTIAL state.calls on two contracts;
 * quoteProtocolLeg's single-call/single-contract shape cannot express this.
 */
export async function quoteSiloRedeem(
  state: StateBackend,
  vault: string,
  outToken: string,
  shares: bigint,
): Promise<bigint> {
  const assetsData = siloRedeemIface.encodeFunctionData("previewRedeem", [shares]);
  const assetsRaw = await state.call({ to: vault, data: assetsData });
  const assets = BigInt(siloRedeemIface.decodeFunctionResult("previewRedeem", assetsRaw)[0]);
  const outData = siloRedeemIface.encodeFunctionData("previewWithdraw", [assets]);
  const outRaw = await state.call({ to: outToken, data: outData });
  return BigInt(siloRedeemIface.decodeFunctionResult("previewWithdraw", outRaw)[0]);
}

// ── Metronome Synth Pool --------------------------------------

export const metronomeSynthPoolIface = new ethers.Interface([
  "function quoteSwapOut(address syntheticTokenIn, address syntheticTokenOut, uint256 amountIn) view returns (uint256 amountOut, uint256 fee)",
]);

export async function quoteMetronomeSynthSwap(
  state: CallBackend,
  pool: string,
  synthIn: string,
  synthOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const data = metronomeSynthPoolIface.encodeFunctionData("quoteSwapOut", [
    synthIn,
    synthOut,
    amountIn,
  ]);
  const result = await state.call({ to: pool, data });
  const decoded = metronomeSynthPoolIface.decodeFunctionResult("quoteSwapOut", result);
  return BigInt(decoded[0]);
}

function quoteFluidVault(): bigint {
  throw new Error("unsupported exact quote: fluid-vault requires solver debt search");
}

// ── Fluid DEX T1 ------------------------------------------------

export const fluidDexSwapIface = new ethers.Interface([
  "function swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_) payable returns (uint256 amountOut_)",
]);

export const fluidDexResolverIface = new ethers.Interface([
  "function estimateSwapIn(address dex_, bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_) payable returns (uint256 amountOut_)",
]);

export function fluidDexSwap0To1(
  tokenIn: string,
  tokenOut: string,
  poolToken0: string | undefined,
  poolToken1: string | undefined,
): boolean {
  if (!poolToken0 || !poolToken1) {
    throw new Error(`fluid-dex quote missing pool token order for ${tokenIn} -> ${tokenOut}`);
  }
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const t0 = poolToken0.toLowerCase();
  const t1 = poolToken1.toLowerCase();
  if (inLower === t0 && outLower === t1) return true;
  if (inLower === t1 && outLower === t0) return false;
  throw new Error(
    `fluid-dex tokens ${tokenIn} -> ${tokenOut} do not match pool tokens ${poolToken0} / ${poolToken1}`,
  );
}

export async function quoteFluidDex(
  state: CallBackend,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolToken0: string | undefined,
  poolToken1: string | undefined,
): Promise<bigint> {
  const swap0to1 = fluidDexSwap0To1(tokenIn, tokenOut, poolToken0, poolToken1);
  const resolver = configuredFluidDexResolver();
  if (resolver) {
    try {
      const data = fluidDexResolverIface.encodeFunctionData("estimateSwapIn", [
        pool,
        swap0to1,
        amountIn,
        0n,
      ]);
      const result = await state.call({ to: resolver, data });
      const decoded = fluidDexResolverIface.decodeFunctionResult("estimateSwapIn", result);
      return BigInt(decoded[0]);
    } catch {
      // Resolver deployments vary by environment. Fall through to the pool's
      // documented ADDRESS_DEAD estimate path if the configured resolver is not usable.
    }
  }

  return quoteFluidDexViaPoolEstimate(state, pool, swap0to1, amountIn);
}

function configuredFluidDexResolver(): string | null {
  const raw = process.env[FLUID_DEX_RESOLVER_ENV];
  if (!raw) return null;
  try {
    const addr = ethers.getAddress(raw);
    return addr === ethers.ZeroAddress ? null : addr;
  } catch {
    return null;
  }
}

async function quoteFluidDexViaPoolEstimate(
  state: CallBackend,
  pool: string,
  swap0to1: boolean,
  amountIn: bigint,
): Promise<bigint> {
  const data = fluidDexSwapIface.encodeFunctionData("swapIn", [
    swap0to1,
    amountIn,
    0n,
    FLUID_DEX_ADDRESS_DEAD,
  ]);
  try {
    const result = await state.call({ to: pool, data });
    const decoded = fluidDexSwapIface.decodeFunctionResult("swapIn", result);
    return BigInt(decoded[0]);
  } catch (err) {
    const revertData = extractRevertData(err);
    const decoded = decodeFluidDexEstimateRevert(revertData);
    if (decoded !== null) return decoded;
    throw err;
  }
}

function extractRevertData(err: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value;
    if (typeof value !== "object") continue;
    const obj = value as Record<string, unknown>;
    for (const key of ["data", "error", "info", "body", "payload"]) {
      const next = obj[key];
      if (typeof next === "string" && /^0x[0-9a-fA-F]+$/.test(next)) return next;
      if (next && typeof next === "object") stack.push(next);
    }
  }
  return null;
}

function decodeFluidDexEstimateRevert(data: string | null): bigint | null {
  if (!data || data === "0x") return null;
  try {
    const decoded = fluidDexSwapIface.decodeFunctionResult("swapIn", data);
    return BigInt(decoded[0]);
  } catch {
    // ADDRESS_DEAD estimates are intentionally surfaced through revert data.
  }
  const raw = data.startsWith("0x") ? data.slice(2) : data;
  if (raw.length < 64) return null;
  try {
    const lastWord = `0x${raw.slice(raw.length - 64)}`;
    return BigInt(lastWord);
  } catch {
    return null;
  }
}

// ── Dispatch ───────────────────────────────────────────────────

export async function quote(
  adapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  state: StateBackend,
  cache?: PoolStateCache,
  v4PoolKey?: V4PoolKey,
  poolToken0?: string,
  poolToken1?: string,
  v4QuoteStats?: V4QuotePathStats,
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  const routeAdapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.findForEdge(adapterId);
  if (routeAdapter) {
    return routeAdapter.quoteExact({
      state,
      target,
      edgeAdapterId: adapterId,
      amountIn,
      tokenIn,
      tokenOut,
      cache,
      v4PoolKey,
      v4QuoteStats,
    });
  }
  switch (adapterId) {
    case "psm":
      return quotePSM(state, target, tokenIn, tokenOut, amountIn);
    case "fluid-dex-swap":
      return quoteFluidDex(state, target, tokenIn, tokenOut, amountIn, poolToken0, poolToken1);
    case "wsteth-wrap":
    case "wsteth-unwrap":
    case "erc4626-deposit":
    case "erc4626-redeem":
    case "rocksolid-sync-deposit":
      return quoteProtocolLeg(state, target, adapterId, amountIn);
    case "goldx-mint":
      return quoteGoldxMint(state, target, tokenIn, tokenOut, amountIn);
    case "erc4626-redeem-silo":
      return quoteSiloRedeem(state, target, tokenOut, amountIn);
    case "metronome-synth-swap":
      return quoteMetronomeSynthSwap(state, target, tokenIn, tokenOut, amountIn);
    case "metronome-hgusdc-exit": { // msUSD -> Curve frxUSD -> authorized hgUSDC redeem -> USDC
      let frxUsdOut: bigint;
      if (cache) {
        try {
          frxUsdOut = await cache.quoteCurve(
            state,
            ADDR.CURVE_MSUSD_FRXUSD,
            ADDR.MSUSD,
            ADDR.FRXUSD,
            amountIn,
          );
        } catch {
          frxUsdOut = await quoteCurvePlain(
            state,
            ADDR.CURVE_MSUSD_FRXUSD,
            ADDR.MSUSD,
            ADDR.FRXUSD,
            amountIn,
          );
        }
      } else {
        frxUsdOut = await quoteCurvePlain(
          state,
          ADDR.CURVE_MSUSD_FRXUSD,
          ADDR.MSUSD,
          ADDR.FRXUSD,
          amountIn,
        );
      }
      return quoteProtocolLeg(state, ADDR.HGUSDC, "erc4626-redeem", frxUsdOut);
    }
    case "fluid-vault":
      return quoteFluidVault();
    default:
      throw new Error(`no quoter for adapter ${adapterId}`);
  }
}
