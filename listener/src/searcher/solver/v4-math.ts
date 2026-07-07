import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { type V4PoolKey, v4HooksAffectSwap, v4PoolId } from "../planner/token-graph.js";
import {
  computeSwapStep,
  getSqrtRatioAtTick,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  nextInitializedTickWithinOneWord,
  V3MissingBitmapWordError,
} from "./v3-math.js";

export interface V4MathStateBackend {
  call(req: { to: string; data: string }): Promise<string>;
}

export type V4PoolQuoteRef =
  | string
  | V4PoolKey
  | (V4PoolKey & { poolId?: string })
  | { poolId: string; poolKey: V4PoolKey };

interface ResolvedV4PoolRef {
  poolId: string;
  key: V4PoolKey;
}

interface V4Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: bigint;
  lpFee: bigint;
}

const UINT24_MAX = 0xffffff;
const MAX_SWAP_FEE = 1_000_000n;
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;
const TICKS_OFFSET = 4n;
const TICK_BITMAP_OFFSET = 5n;

const stateViewIface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getTickBitmap(bytes32 poolId,int16 tick) view returns (uint256 tickBitmap)",
  "function getTickInfo(bytes32 poolId,int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128)",
]);

const extsloadIface = new ethers.Interface([
  "function extsload(bytes32 slot) view returns (bytes32)",
]);

/**
 * Hookless, single-pool v4 exact-input quote against Pool.swap math.
 *
 * The swap loop is a direct port of v3SwapToState's exact-input tick walk. The
 * v4 boundary adapts Pool.swap's exact-input sign convention
 * (`amountSpecified < 0`) back to the positive amountRemaining expected by the
 * shared v3 SwapMath port.
 */
export async function quoteV4ExactInLocal(
  state: V4MathStateBackend,
  pool: V4PoolQuoteRef,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  if (amountIn <= 0n) throw new Error(`V4 local quote: exact input must be positive, got ${amountIn}`);
  const resolved = resolveV4PoolRef(pool);
  const key = resolved.key;
  assertHooklessPool(key);
  const zeroForOne = v4ZeroForOne(key, tokenIn, tokenOut);
  const reader = new V4PoolStateReader(state, resolved.poolId);
  const slot0 = await reader.getSlot0();
  const liquidityStart = await reader.getLiquidity();
  if (slot0.sqrtPriceX96 === 0n) throw new Error(`V4 local quote: pool ${resolved.poolId} is not initialized`);
  if (slot0.lpFee >= MAX_SWAP_FEE) {
    throw new Error(`V4 local quote: unsupported lpFee ${slot0.lpFee} for exact-input pool ${resolved.poolId}`);
  }

  const tickBitmap = new Map<number, bigint>();
  const ticks = new Map<number, bigint>();
  const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  // v4 exact input is negative at Pool.swap's boundary; the imported v3 helper
  // uses positive amountRemaining for the same exact-input branch.
  const amountSpecified = -amountIn;
  let amountRemaining = -amountSpecified;
  let amountCalculated = 0n;
  let sqrtPriceX96 = slot0.sqrtPriceX96;
  let tick = slot0.tick;
  let liquidity = liquidityStart;
  let iterations = 0;

  while (amountRemaining > 0n && sqrtPriceX96 !== sqrtPriceLimitX96) {
    iterations++;
    if (iterations > 10_000) {
      throw new Error(`V4 local quote: exceeded tick-walk iteration guard for pool ${resolved.poolId}`);
    }

    const [tickNextRaw, initialized] = await nextInitializedV4Tick(
      reader,
      tickBitmap,
      tick,
      key.tickSpacing,
      zeroForOne,
    );
    let tickNext = tickNextRaw;
    if (tickNext < MIN_TICK) tickNext = MIN_TICK;
    else if (tickNext > MAX_TICK) tickNext = MAX_TICK;

    const sqrtPriceNextX96 = getSqrtRatioAtTick(tickNext);
    const reachesLimit = zeroForOne
      ? sqrtPriceNextX96 < sqrtPriceLimitX96
      : sqrtPriceNextX96 > sqrtPriceLimitX96;
    const target = reachesLimit ? sqrtPriceLimitX96 : sqrtPriceNextX96;

    const stepResult = computeSwapStep(sqrtPriceX96, target, liquidity, amountRemaining, slot0.lpFee);
    sqrtPriceX96 = stepResult.sqrtRatioNextX96;
    amountRemaining -= stepResult.amountIn + stepResult.feeAmount;
    amountCalculated -= stepResult.amountOut;

    if (sqrtPriceX96 === sqrtPriceNextX96) {
      if (initialized) {
        let liquidityNet = ticks.get(tickNext);
        if (liquidityNet === undefined) {
          liquidityNet = await reader.getTickLiquidityNet(tickNext);
          ticks.set(tickNext, liquidityNet);
        }
        if (zeroForOne) liquidityNet = -liquidityNet;
        liquidity += liquidityNet;
        if (liquidity < 0n) {
          throw new Error(`V4 local quote: negative liquidity after crossing tick ${tickNext}`);
        }
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else {
      break;
    }
  }

  return -amountCalculated;
}

async function nextInitializedV4Tick(
  reader: V4PoolStateReader,
  tickBitmap: Map<number, bigint>,
  tick: number,
  tickSpacing: number,
  zeroForOne: boolean,
): Promise<[number, boolean]> {
  while (true) {
    try {
      return nextInitializedTickWithinOneWord(tickBitmap, tick, tickSpacing, zeroForOne);
    } catch (err) {
      if (!(err instanceof V3MissingBitmapWordError)) throw err;
      tickBitmap.set(err.word, await reader.getTickBitmap(err.word));
    }
  }
}

class V4PoolStateReader {
  private stateViewAvailable: boolean | null = null;
  private readonly poolStateSlot: bigint;

  constructor(
    private readonly state: V4MathStateBackend,
    private readonly poolId: string,
  ) {
    this.poolStateSlot = poolStateSlot(poolId);
  }

  async getSlot0(): Promise<V4Slot0> {
    const result = await this.tryStateView("getSlot0", [this.poolId]);
    if (result) {
      return {
        sqrtPriceX96: BigInt(result[0]),
        tick: Number(result[1]),
        protocolFee: BigInt(result[2]),
        lpFee: BigInt(result[3]),
      };
    }

    const word = await this.extsloadWord(wordHex(this.poolStateSlot));
    return {
      sqrtPriceX96: word & ((1n << 160n) - 1n),
      tick: Number(fromTwos((word >> 160n) & 0xffffffn, 24n)),
      protocolFee: (word >> 184n) & 0xffffffn,
      lpFee: (word >> 208n) & 0xffffffn,
    };
  }

  async getLiquidity(): Promise<bigint> {
    const result = await this.tryStateView("getLiquidity", [this.poolId]);
    if (result) return BigInt(result[0]);
    return this.extsloadWord(wordHex(this.poolStateSlot + LIQUIDITY_OFFSET));
  }

  async getTickBitmap(word: number): Promise<bigint> {
    const result = await this.tryStateView("getTickBitmap", [this.poolId, word]);
    if (result) return BigInt(result[0]);
    const tickBitmapMapping = wordHex(this.poolStateSlot + TICK_BITMAP_OFFSET);
    return this.extsloadWord(mappingSlotSigned(word, tickBitmapMapping));
  }

  async getTickLiquidityNet(tick: number): Promise<bigint> {
    const result = await this.tryStateView("getTickInfo", [this.poolId, tick]);
    if (result) return BigInt(result[1]);
    const ticksMapping = wordHex(this.poolStateSlot + TICKS_OFFSET);
    const word = await this.extsloadWord(mappingSlotSigned(tick, ticksMapping));
    return fromTwos(word >> 128n, 128n);
  }

  private async tryStateView(method: string, args: unknown[]): Promise<ethers.Result | null> {
    if (this.stateViewAvailable === false) return null;
    try {
      const data = stateViewIface.encodeFunctionData(method, args);
      const raw = await this.state.call({ to: ADDR.UNISWAP_V4_STATE_VIEW, data });
      if (!raw || raw === "0x") throw new Error("empty StateView response");
      this.stateViewAvailable = true;
      return stateViewIface.decodeFunctionResult(method, raw);
    } catch {
      this.stateViewAvailable = false;
      return null;
    }
  }

  private async extsloadWord(slot: string): Promise<bigint> {
    const raw = await this.state.call({
      to: ADDR.UNISWAP_V4_POOL_MANAGER,
      data: extsloadIface.encodeFunctionData("extsload", [slot]),
    });
    const decoded = extsloadIface.decodeFunctionResult("extsload", raw);
    return BigInt(decoded[0]);
  }
}

function resolveV4PoolRef(pool: V4PoolQuoteRef): ResolvedV4PoolRef {
  if (typeof pool === "string") {
    throw new Error(
      "V4 local quote: bare poolId is not enough to quote; pass PoolKey metadata for tickSpacing/hooks",
    );
  }
  const maybeWithPoolKey = pool as { poolId?: string; poolKey?: V4PoolKey };
  const key = normalizeV4PoolKey(maybeWithPoolKey.poolKey ?? (pool as V4PoolKey));
  const computedPoolId = v4PoolId(key);
  const providedPoolId = maybeWithPoolKey.poolId?.toLowerCase();
  if (providedPoolId && providedPoolId !== computedPoolId) {
    throw new Error(`V4 local quote: PoolKey hashes to ${computedPoolId}, not provided poolId ${providedPoolId}`);
  }
  return { poolId: providedPoolId ?? computedPoolId, key };
}

function assertHooklessPool(key: V4PoolKey): void {
  if (key.hooks.toLowerCase() !== ethers.ZeroAddress.toLowerCase() || v4HooksAffectSwap(key.hooks)) {
    throw new Error(`V4 local quote: hooks are not supported (${key.hooks})`);
  }
}

function v4ZeroForOne(key: V4PoolKey, tokenIn: string, tokenOut: string): boolean {
  const realIn = realV4Currency(tokenIn, key, "tokenIn");
  const realOut = realV4Currency(tokenOut, key, "tokenOut");
  const c0 = key.currency0.toLowerCase();
  const c1 = key.currency1.toLowerCase();
  const tIn = realIn.toLowerCase();
  const tOut = realOut.toLowerCase();
  if (tIn === c0 && tOut === c1) return true;
  if (tIn === c1 && tOut === c0) return false;
  throw new Error(`V4 local quote: tokens ${tokenIn} -> ${tokenOut} do not match PoolKey`);
}

function realV4Currency(token: string, key: V4PoolKey, field: string): string {
  const t = normalizeV4Currency(token, field);
  if (t.toLowerCase() === key.currency0.toLowerCase()) return key.currency0;
  if (t.toLowerCase() === key.currency1.toLowerCase()) return key.currency1;

  const c0Native = key.currency0.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const c1Native = key.currency1.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  if (c0Native !== c1Native && t.toLowerCase() === ADDR.WETH.toLowerCase()) {
    return c0Native ? key.currency0 : key.currency1;
  }

  throw new Error(`V4 local quote: ${field} ${token} does not match PoolKey ${key.currency0} / ${key.currency1}`);
}

function normalizeV4PoolKey(poolKey: V4PoolKey): V4PoolKey {
  return {
    currency0: normalizeV4Currency(poolKey.currency0, "currency0"),
    currency1: normalizeV4Currency(poolKey.currency1, "currency1"),
    fee: uint24(poolKey.fee, "fee"),
    tickSpacing: int24(poolKey.tickSpacing, "tickSpacing"),
    hooks: normalizeV4Currency(poolKey.hooks, "hooks"),
  };
}

function normalizeV4Currency(value: string, field: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`V4 local quote: ${field} must be an address or 0x0, got ${value}`);
  }
}

function uint24(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > UINT24_MAX) {
    throw new Error(`V4 local quote: PoolKey ${field} must be a uint24, got ${value}`);
  }
  return value;
}

function int24(value: number, field: string): number {
  if (!Number.isInteger(value) || value < -0x800000 || value > 0x7fffff) {
    throw new Error(`V4 local quote: PoolKey ${field} must be an int24, got ${value}`);
  }
  return value;
}

function poolStateSlot(poolId: string): bigint {
  return BigInt(
    ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32"],
      [poolId.toLowerCase(), wordHex(POOLS_SLOT)],
    ),
  );
}

function mappingSlotSigned(key: number, mappingSlot: string): string {
  return ethers.solidityPackedKeccak256(["int256", "bytes32"], [BigInt(key), mappingSlot]);
}

function wordHex(value: bigint): string {
  return ethers.toBeHex(BigInt.asUintN(256, value), 32);
}

function fromTwos(value: bigint, bits: bigint): bigint {
  const masked = value & ((1n << bits) - 1n);
  const signBit = 1n << (bits - 1n);
  return (masked & signBit) === 0n ? masked : masked - (1n << bits);
}
