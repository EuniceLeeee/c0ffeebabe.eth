import type { CanonicalValue } from "../../canonical-value.js";
import type {
  NormalizedSwapVictimImpact,
  VictimReplaySpec,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "../univ4-family/codec.js";
import type { FeeHookDescriptor, FeeHookRoute } from "./types.js";

export const univ4FeeHookVictimReplay = {
  bind({ descriptor, routes, impact }) {
    if (!sameAddress(impact.pool, descriptor.managerBinding.manager)) return null;
    return routes.find((route) =>
      sameAddress(route.tokenIn, impact.tokenIn) &&
      sameAddress(route.tokenOut, impact.tokenOut)
    ) ?? null;
  },
  applyLocal({ descriptor, route, impact, source }) {
    assertImpactBinding(descriptor, route, impact);
    if (
      impact.amountOut === undefined ||
      impact.amountOut <= 0n ||
      impact.exactPostState === undefined
    ) {
      return null;
    }
    return Object.freeze({
      amountOut: impact.amountOut,
      postImpact: exactPostState(descriptor, impact.exactPostState, source.number),
    });
  },
  exactPostState({ descriptor, route, impact, source }) {
    assertImpactBinding(descriptor, route, impact);
    return impact.exactPostState === undefined
      ? null
      : exactPostState(descriptor, impact.exactPostState, source.number);
  },
  buildOverlay({ descriptor, route, impact }) {
    assertImpactBinding(descriptor, route, impact);
    return null;
  },
} satisfies VictimReplaySpec<FeeHookDescriptor, FeeHookRoute>;

function assertImpactBinding(
  descriptor: FeeHookDescriptor,
  route: FeeHookRoute,
  impact: NormalizedSwapVictimImpact,
): void {
  if (
    route.instanceKey !== descriptor.instanceKey ||
    route.poolId !== descriptor.poolId ||
    !sameAddress(impact.pool, descriptor.managerBinding.manager) ||
    !sameAddress(impact.tokenIn, route.tokenIn) ||
    !sameAddress(impact.tokenOut, route.tokenOut)
  ) {
    throw new Error(
      "univ4 fee-hook victim impact does not match the bound route",
    );
  }
}

function exactPostState(
  descriptor: FeeHookDescriptor,
  value: CanonicalValue,
  blockNumber: number,
): CanonicalValue {
  const state = canonicalRecord(value);
  if (
    state.poolId !== undefined &&
    (typeof state.poolId !== "string" ||
      state.poolId.toLowerCase() !== descriptor.poolId)
  ) {
    throw new Error(
      "univ4 fee-hook victim exact post-state poolId mismatch",
    );
  }
  return Object.freeze({
    kind: "v4",
    poolManager: descriptor.managerBinding.manager,
    poolId: descriptor.poolId,
    sqrtPriceX96: canonicalBigint(state.sqrtPriceX96, "sqrtPriceX96"),
    tick: canonicalInteger(state.tick, "tick"),
    liquidity: canonicalBigint(state.liquidity, "liquidity"),
    lpFee: canonicalInteger(state.lpFee, "lpFee"),
    blockNumber,
  });
}

function canonicalRecord(
  value: CanonicalValue,
): Readonly<Record<string, CanonicalValue>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(
      "univ4 fee-hook victim exact post-state must be a canonical record",
    );
  }
  return value as Readonly<Record<string, CanonicalValue>>;
}

function canonicalBigint(
  value: CanonicalValue | undefined,
  label: string,
): bigint {
  if (typeof value !== "bigint") {
    throw new Error("univ4 fee-hook victim " + label + " must be a bigint");
  }
  return value;
}

function canonicalInteger(
  value: CanonicalValue | undefined,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(
      "univ4 fee-hook victim " + label + " must be a safe integer",
    );
  }
  return value;
}
