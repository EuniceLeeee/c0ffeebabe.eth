import type { CanonicalValue } from "../../canonical-value.js";
import type {
  NormalizedSwapVictimImpact,
  VictimReplaySpec,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "./codec.js";
import type {
  AngstromV4Descriptor,
  AngstromV4Route,
} from "./types.js";

/**
 * Angstrom preserves the PoolManager's landed V4 post-state, but its hook can
 * change the final caller balance after the Swap event. Consequently there is
 * no sound local amount-out replay and no legacy family-owned overlay.
 */
export const angstromV4VictimReplay = {
  bind({ descriptor, routes, impact }) {
    if (!sameAddress(impact.pool, descriptor.immutableBinding.manager)) {
      return null;
    }
    return routes.find((route) =>
      sameAddress(route.tokenIn, impact.tokenIn) &&
      sameAddress(route.tokenOut, impact.tokenOut)
    ) ?? null;
  },
  applyLocal({ descriptor, route, impact }) {
    assertImpactBinding(descriptor, route, impact);
    return null;
  },
  exactPostState({ descriptor, route, impact, source }) {
    assertImpactBinding(descriptor, route, impact);
    if (impact.exactPostState === undefined) return null;
    const state = canonicalRecord(impact.exactPostState);
    if (
      state.poolId !== undefined &&
      (typeof state.poolId !== "string" ||
        state.poolId.toLowerCase() !== descriptor.poolId)
    ) {
      throw new Error("angstrom-v4 victim exact post-state poolId mismatch");
    }
    return Object.freeze({
      kind: "v4",
      poolManager: descriptor.immutableBinding.manager,
      poolId: descriptor.poolId,
      sqrtPriceX96: canonicalBigint(state.sqrtPriceX96, "sqrtPriceX96"),
      tick: canonicalInteger(state.tick, "tick"),
      liquidity: canonicalBigint(state.liquidity, "liquidity"),
      lpFee: canonicalInteger(state.lpFee, "lpFee"),
      blockNumber: source.number,
    });
  },
  buildOverlay({ descriptor, route, impact }) {
    assertImpactBinding(descriptor, route, impact);
    return null;
  },
} satisfies VictimReplaySpec<AngstromV4Descriptor, AngstromV4Route>;

function assertImpactBinding(
  descriptor: AngstromV4Descriptor,
  route: AngstromV4Route,
  impact: NormalizedSwapVictimImpact,
): void {
  if (
    route.instanceKey !== descriptor.instanceKey ||
    route.poolId !== descriptor.poolId ||
    !sameAddress(route.manager, descriptor.immutableBinding.manager) ||
    !sameAddress(impact.pool, descriptor.immutableBinding.manager) ||
    !sameAddress(impact.tokenIn, route.tokenIn) ||
    !sameAddress(impact.tokenOut, route.tokenOut)
  ) {
    throw new Error("angstrom-v4 victim impact does not match the bound route");
  }
}

function canonicalRecord(
  value: CanonicalValue,
): Readonly<Record<string, CanonicalValue>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("angstrom-v4 victim exact post-state must be a canonical record");
  }
  return value as Readonly<Record<string, CanonicalValue>>;
}

function canonicalBigint(
  value: CanonicalValue | undefined,
  label: string,
): bigint {
  if (typeof value !== "bigint") {
    throw new Error(`angstrom-v4 victim ${label} must be bigint`);
  }
  return value;
}

function canonicalInteger(
  value: CanonicalValue | undefined,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`angstrom-v4 victim ${label} must be a safe integer`);
  }
  return value;
}
