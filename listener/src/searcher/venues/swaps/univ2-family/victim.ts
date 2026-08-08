import { ethers } from "ethers";
import { quoteV2ExactInput } from "../../../solver/v2-constant-product-math.js";
import type { V2PostImpactSeed } from "../../../solver/pool-state-cache.js";
import type { CanonicalValue } from "../../canonical-value.js";
import type {
  NormalizedSwapVictimImpact,
  VictimReplaySpec,
  VictimReplayOverlayIntent,
} from "../../adapter-family-plugin.js";
import { buildApprovedSwapVictimOverlay } from "../../victim-runtime-shared.js";
import { canonicalAddress, sameAddress } from "./codec.js";
import type { UniV2Descriptor, UniV2Route } from "./types.js";

export const UNIV2_ROUTER =
  "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

const UNIV2_ROUTER_INTERFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
]);

export interface UniV2VictimPreState {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly feeBps: bigint;
  readonly blockTimestampLast?: number;
}

export interface UniV2VictimImpact {
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut?: bigint;
}

export interface UniV2ExactPostState {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly feeBps: bigint;
  readonly blockTimestampLast?: number;
}

export const univ2VictimReplay = {
  bind({ descriptor, routes, impact }) {
    if (!samePool(descriptor.pool, impact.pool)) return null;
    return routes.find((route) =>
      samePool(route.pool, descriptor.pool) &&
      samePool(route.tokenIn, impact.tokenIn) &&
      samePool(route.tokenOut, impact.tokenOut)
    ) ?? null;
  },
  applyLocal({ descriptor, route, preState, impact, source }) {
    if (!routeMatches(descriptor, route, impact)) return null;
    const parsed = decodePreState(preState);
    if (
      parsed === null ||
      !samePool(parsed.pool, descriptor.pool) ||
      !samePool(parsed.token0, descriptor.token0) ||
      !samePool(parsed.token1, descriptor.token1) ||
      parsed.feeBps !== descriptor.feeRule.feeBps
    ) {
      return null;
    }
    const applied = applyUniV2VictimState({
      preState: parsed,
      impact,
      blockNumber: source.number,
    });
    if (applied === null) return null;
    return Object.freeze({
      postImpact: applied.postImpact as unknown as CanonicalValue,
      amountOut: applied.amountOut,
    });
  },
  exactPostState({ descriptor, route, impact, source }) {
    if (
      !routeMatches(descriptor, route, impact) ||
      impact.exactPostState === undefined
    ) {
      return null;
    }
    const exactPostState = decodeUniV2ExactPostState(impact.exactPostState);
    if (
      exactPostState === null ||
      exactPostState.feeBps !== descriptor.feeRule.feeBps
    ) {
      return null;
    }
    return uniV2ExactPostImpact({
      pool: descriptor.pool,
      token0: descriptor.token0,
      token1: descriptor.token1,
      exactPostState,
      blockNumber: source.number,
    }) as unknown as CanonicalValue;
  },
  buildOverlay({ descriptor, route, impact, validUntil }) {
    if (!routeMatches(descriptor, route, impact)) return null;
    return buildUniV2VictimOverlayIntent({ impact, validUntil });
  },
} satisfies VictimReplaySpec<UniV2Descriptor, UniV2Route>;

export function applyUniV2VictimState(input: {
  readonly preState: UniV2VictimPreState;
  readonly impact: UniV2VictimImpact;
  readonly blockNumber: number;
}): { readonly postImpact: V2PostImpactSeed; readonly amountOut: bigint } | null {
  const { preState: pre, impact } = input;
  if (!sameAddress(pre.pool, impact.pool) || impact.amountIn <= 0n) return null;
  const zeroForOne =
    sameAddress(impact.tokenIn, pre.token0) &&
    sameAddress(impact.tokenOut, pre.token1);
  const oneForZero =
    sameAddress(impact.tokenIn, pre.token1) &&
    sameAddress(impact.tokenOut, pre.token0);
  if (!zeroForOne && !oneForZero) return null;

  const [reserveIn, reserveOut] = zeroForOne
    ? [pre.reserve0, pre.reserve1]
    : [pre.reserve1, pre.reserve0];
  const amountOut = quoteV2ExactInput(
    reserveIn,
    reserveOut,
    impact.amountIn,
    pre.feeBps,
  );
  if (amountOut <= 0n || amountOut >= reserveOut) return null;

  const postImpact: V2PostImpactSeed = Object.freeze({
    kind: "v2" as const,
    pool: ethers.getAddress(pre.pool),
    token0: ethers.getAddress(pre.token0).toLowerCase(),
    token1: ethers.getAddress(pre.token1).toLowerCase(),
    reserve0: zeroForOne
      ? pre.reserve0 + impact.amountIn
      : pre.reserve0 - amountOut,
    reserve1: zeroForOne
      ? pre.reserve1 - amountOut
      : pre.reserve1 + impact.amountIn,
    feeBps: pre.feeBps,
    ...(pre.blockTimestampLast === undefined
      ? {}
      : { blockTimestampLast: pre.blockTimestampLast }),
    blockNumber: input.blockNumber,
  });
  return Object.freeze({ postImpact, amountOut });
}

export function uniV2ExactPostImpact(input: {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly exactPostState: UniV2ExactPostState;
  readonly blockNumber: number;
}): V2PostImpactSeed | null {
  const state = input.exactPostState;
  if (
    state.reserve0 < 0n ||
    state.reserve1 < 0n ||
    state.feeBps < 0n ||
    state.feeBps >= 10_000n
  ) {
    return null;
  }
  if (
    state.blockTimestampLast !== undefined &&
    (!Number.isSafeInteger(state.blockTimestampLast) ||
      state.blockTimestampLast < 0)
  ) {
    return null;
  }
  return Object.freeze({
    kind: "v2" as const,
    pool: ethers.getAddress(input.pool),
    token0: ethers.getAddress(input.token0).toLowerCase(),
    token1: ethers.getAddress(input.token1).toLowerCase(),
    reserve0: state.reserve0,
    reserve1: state.reserve1,
    feeBps: state.feeBps,
    ...(state.blockTimestampLast === undefined
      ? {}
      : { blockTimestampLast: state.blockTimestampLast }),
    blockNumber: input.blockNumber,
  });
}

export function buildUniV2VictimOverlayIntent(input: {
  readonly impact: UniV2VictimImpact | NormalizedSwapVictimImpact;
  readonly validUntil: bigint;
}): VictimReplayOverlayIntent {
  if (input.validUntil <= 0n) {
    throw new Error("univ2 victim validUntil must be positive");
  }
  const tokenIn = ethers.getAddress(input.impact.tokenIn);
  const tokenOut = ethers.getAddress(input.impact.tokenOut);
  return buildApprovedSwapVictimOverlay({
    impact: {
      pool: ethers.getAddress(input.impact.pool),
      tokenIn,
      tokenOut,
      amountIn: input.impact.amountIn,
      ...(input.impact.amountOut === undefined
        ? {}
        : { amountOut: input.impact.amountOut }),
      matchedAdapterId: "univ2-swap",
    },
    approveTarget: UNIV2_ROUTER,
    swapTarget: UNIV2_ROUTER,
    swapCalldata: UNIV2_ROUTER_INTERFACE.encodeFunctionData(
      "swapExactTokensForTokens",
      [
        input.impact.amountIn,
        0,
        [tokenIn, tokenOut],
        "0x000000000000000000000000000000000000dEaD",
        input.validUntil,
      ],
    ),
    gasLimit: 0x1000000,
  });
}

export function decodeUniV2ExactPostState(
  value: unknown,
): UniV2ExactPostState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.reserve0 !== "bigint" ||
    typeof record.reserve1 !== "bigint" ||
    typeof record.feeBps !== "bigint"
  ) {
    return null;
  }
  if (
    record.blockTimestampLast !== undefined &&
    typeof record.blockTimestampLast !== "number"
  ) {
    return null;
  }
  return Object.freeze({
    reserve0: record.reserve0,
    reserve1: record.reserve1,
    feeBps: record.feeBps,
    ...(record.blockTimestampLast === undefined
      ? {}
      : { blockTimestampLast: record.blockTimestampLast }),
  });
}

function routeMatches(
  descriptor: UniV2Descriptor,
  route: UniV2Route,
  impact: {
    readonly pool: string;
    readonly tokenIn: string;
    readonly tokenOut: string;
  },
): boolean {
  return (
    route.instanceKey === descriptor.instanceKey &&
    samePool(route.pool, descriptor.pool) &&
    samePool(impact.pool, descriptor.pool) &&
    samePool(route.tokenIn, impact.tokenIn) &&
    samePool(route.tokenOut, impact.tokenOut)
  );
}

function samePool(left: string, right: string): boolean {
  try {
    return canonicalAddress(left) === canonicalAddress(right);
  } catch {
    return left.toLowerCase() === right.toLowerCase();
  }
}

function decodePreState(value: CanonicalValue): UniV2VictimPreState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Readonly<Record<string, CanonicalValue>>;
  if (
    typeof record.pool !== "string" ||
    typeof record.token0 !== "string" ||
    typeof record.token1 !== "string" ||
    typeof record.reserve0 !== "bigint" ||
    typeof record.reserve1 !== "bigint" ||
    typeof record.feeBps !== "bigint" ||
    (record.blockTimestampLast !== undefined &&
      typeof record.blockTimestampLast !== "number")
  ) {
    return null;
  }
  return Object.freeze({
    pool: record.pool,
    token0: record.token0,
    token1: record.token1,
    reserve0: record.reserve0,
    reserve1: record.reserve1,
    feeBps: record.feeBps,
    ...(record.blockTimestampLast === undefined
      ? {}
      : { blockTimestampLast: record.blockTimestampLast }),
  });
}
