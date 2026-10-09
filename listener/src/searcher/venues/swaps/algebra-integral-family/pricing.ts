import { compileAddressMutations } from "../../mutation-index.js";
import type { TokenEdge } from "../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import {
  directedPoolMid,
  q96DirectedReserves,
} from "../blockscan-state-shared.js";
import {
  ALGEBRA_BURN_TOPIC,
  ALGEBRA_COMMUNITY_FEE_TOPIC,
  ALGEBRA_FEE_TOPIC,
  ALGEBRA_INITIALIZE_TOPIC,
  ALGEBRA_INTEGRAL_ADAPTER_ID,
  ALGEBRA_MINT_TOPIC,
  ALGEBRA_PLUGIN_CONFIG_TOPIC,
  ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG,
  ALGEBRA_PLUGIN_TOPIC,
  ALGEBRA_SWAP_TOPIC,
  ALGEBRA_TICK_SPACING_TOPIC,
} from "./abi.js";
import { sameAddress } from "./codec.js";
import { staticBindingProjection } from "./instance.js";
import {
  algebraPriceStateRequests,
  readAlgebraPriceState,
} from "./state.js";
import type {
  AlgebraIntegralDescriptor,
  AlgebraIntegralPricingDescriptor,
  AlgebraIntegralPricingSnapshot,
  AlgebraIntegralRoute,
} from "./types.js";

const MUTATION_TOPICS = new Set([
  ALGEBRA_SWAP_TOPIC,
  ALGEBRA_INITIALIZE_TOPIC,
  ALGEBRA_MINT_TOPIC,
  ALGEBRA_BURN_TOPIC,
  // Pool administration that changes the modelled pricing surface: the fee the
  // pool will execute, the plugin config's dynamic-fee bit, the plugin address
  // itself, and the tick spacing that bounds the initialized-tick target.
  ALGEBRA_FEE_TOPIC,
  ALGEBRA_PLUGIN_CONFIG_TOPIC,
  ALGEBRA_PLUGIN_TOPIC,
  ALGEBRA_TICK_SPACING_TOPIC,
  ALGEBRA_COMMUNITY_FEE_TOPIC,
]);

export const algebraIntegralPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) => staticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
    pool: descriptor.pool,
    tickSpacing: descriptor.tickSpacing,
    feeBinding: descriptor.executedFee.kind,
    pluginConfig: descriptor.executedFee.pluginConfig,
    plugin: descriptor.executedFee.plugin,
    directions: routes
      .map((route) => [route.tokenIn, route.tokenOut] as const)
      .sort(([leftIn, leftOut], [rightIn, rightOut]) =>
        `${leftIn}:${leftOut}`.localeCompare(`${rightIn}:${rightOut}`)
      ),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey) {
      throw new Error(
        `algebra-integral pricing stateKey does not match ${descriptor.pool}`,
      );
    }
    assertRoutesMatchDescriptor(descriptor, routes);
    return {
      instanceKey: descriptor.instanceKey,
      pool: descriptor.pool,
      token0: descriptor.token0,
      token1: descriptor.token1,
      tickSpacing: descriptor.tickSpacing,
      factoryBinding: descriptor.factoryBinding,
      executedFee: descriptor.executedFee,
    };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    factoryBinding: Object.freeze({ ...draft.factoryBinding }),
    executedFee: Object.freeze({ ...draft.executedFee }),
  }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) =>
      algebraPriceStateRequests(descriptor.pool),
    decodeSnapshot: ({ descriptor, initialResults }) =>
      decodeSnapshot(descriptor, initialResults),
    deriveMids({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const mids = new Map<AlgebraIntegralRoute["routeKey"], RouteVenueMid>();
      if (snapshot.inactiveReason !== null) return mids;
      for (const route of routes) {
        const edge = routeEdge(descriptor, route, snapshot.executedFee);
        const directed = q96DirectedReserves({
          sqrtPriceX96: snapshot.sqrtPriceX96,
          liquidity: snapshot.liquidity,
          token0: descriptor.token0,
          token1: descriptor.token1,
          edge,
        });
        if (directed === null) continue;
        mids.set(route.routeKey, directedPoolMid({
          kind: "v3",
          edge,
          reserveIn: directed.reserveIn,
          reserveOut: directed.reserveOut,
          mid: directed.mid,
          sqrtPriceX96: directed.sqrtPriceInOutX96,
          liquidity: snapshot.liquidity,
          // The executed fee unit is hundredths of a bip (1e-6), so one basis
          // point is 100 units: this is the same conversion UniV3 families use.
          feeBps: Number(snapshot.executedFee) / 100,
        }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const unavailable = new Map<AlgebraIntegralRoute["routeKey"], string>();
      if (snapshot.inactiveReason !== null) {
        for (const route of routes) {
          unavailable.set(route.routeKey, snapshot.inactiveReason);
        }
      }
      return unavailable;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.pool,
    descriptor.token0,
    descriptor.token1,
    descriptor.factoryBinding.factory,
    descriptor.executedFee.plugin,
  ]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(
      entries,
      ({ descriptor }) => ({
        addresses: [descriptor.pool],
        keys: [descriptor.instanceKey],
      }),
      {
        kinds: ["log"],
        accept: (observation) =>
          observation.kind === "log" &&
          MUTATION_TOPICS.has(observation.topics[0]?.toLowerCase() ?? ""),
      },
    ),
    affectedStateKeys({ descriptor, observation }) {
      if (
        observation.kind !== "log" ||
        !MUTATION_TOPICS.has(observation.topics[0]?.toLowerCase() ?? "") ||
        !sameAddress(observation.address, descriptor.pool)
      ) {
        return [];
      }
      return [descriptor.instanceKey];
    },
  },
} satisfies PricingSemantics<
  AlgebraIntegralDescriptor,
  AlgebraIntegralRoute,
  AlgebraIntegralPricingDescriptor,
  AlgebraIntegralPricingSnapshot
>;

/**
 * A snapshot is quotable only in the supported variant: the pool's own
 * `globalState.lastFee` must be the fee it will execute, which is exactly the
 * `DYNAMIC_FEE`-clear case. If the bit is set (or the two reads disagree) the
 * pool became plugin-fee controlled after admission; both routes are reported
 * unavailable rather than quoted with an unreadable fee.
 */
function decodeSnapshot(
  descriptor: AlgebraIntegralPricingDescriptor,
  results: Parameters<typeof readAlgebraPriceState>[0],
): AlgebraIntegralPricingSnapshot {
  const state = readAlgebraPriceState(results);
  const unsupported = [];
  if ((state.globalState.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG) !== 0) {
    unsupported.push("plugin-config dynamic-fee bit is set");
  }
  if (state.fee !== state.globalState.lastFee) {
    unsupported.push(
      `fee() ${state.fee} differs from globalState.lastFee ${state.globalState.lastFee}`,
    );
  }
  if (state.tickSpacing !== descriptor.tickSpacing) {
    unsupported.push(
      `tickSpacing ${state.tickSpacing} differs from the admitted ${descriptor.tickSpacing}`,
    );
  }
  const inactive = [...unsupported];
  if (state.globalState.sqrtPriceX96 === 0n) inactive.push("sqrtPriceX96");
  if (state.liquidity === 0n) inactive.push("liquidity");
  if (!state.globalState.unlocked) inactive.push("pool is mid-swap (locked)");
  return Object.freeze({
    source: state.source,
    sqrtPriceX96: state.globalState.sqrtPriceX96,
    tick: state.globalState.tick,
    lastFee: state.globalState.lastFee,
    executedFee: state.fee,
    pluginConfig: state.globalState.pluginConfig,
    communityFee: state.globalState.communityFee,
    unlocked: state.globalState.unlocked,
    liquidity: state.liquidity,
    tickSpacing: state.tickSpacing,
    nextTickGlobal: state.nextTickGlobal,
    prevTickGlobal: state.prevTickGlobal,
    inactiveReason: inactive.length === 0
      ? null
      : unsupported.length === 0
        ? `algebra-integral pool has zero ${inactive.join(" and ")} at the current source`
        : `algebra-integral pool is not the supported variant: ${unsupported.join("; ")}`,
  });
}

function assertRoutesMatchDescriptor(
  descriptor: AlgebraIntegralDescriptor,
  routes: readonly AlgebraIntegralRoute[],
): void {
  for (const route of routes) {
    if (
      route.instanceKey !== descriptor.instanceKey ||
      !sameAddress(route.pool, descriptor.pool) ||
      route.tickSpacing !== descriptor.tickSpacing
    ) {
      throw new Error(`algebra-integral route does not belong to ${descriptor.pool}`);
    }
  }
}

function assertRoutesMatchPricingDescriptor(
  descriptor: AlgebraIntegralPricingDescriptor,
  routes: readonly AlgebraIntegralRoute[],
): void {
  for (const route of routes) {
    const zeroForOne = route.direction === "zero-for-one";
    const expectedIn = zeroForOne ? descriptor.token0 : descriptor.token1;
    const expectedOut = zeroForOne ? descriptor.token1 : descriptor.token0;
    if (
      route.instanceKey !== descriptor.instanceKey ||
      !sameAddress(route.pool, descriptor.pool) ||
      !sameAddress(route.tokenIn, expectedIn) ||
      !sameAddress(route.tokenOut, expectedOut) ||
      route.tickSpacing !== descriptor.tickSpacing
    ) {
      throw new Error(
        `algebra-integral route binding does not match ${descriptor.pool}`,
      );
    }
  }
}

function routeEdge(
  descriptor: AlgebraIntegralPricingDescriptor,
  route: AlgebraIntegralRoute,
  executedFee: bigint,
): TokenEdge {
  return Object.freeze({
    adapterId: ALGEBRA_INTEGRAL_ADAPTER_ID,
    instanceKey: route.instanceKey,
    target: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: "swap" as const,
    poolToken0: descriptor.token0,
    poolToken1: descriptor.token1,
    v3Fee: Number(executedFee),
    v3TickSpacing: descriptor.tickSpacing,
    factory: descriptor.factoryBinding.factory,
    ...deriveEdgeTaxonomy("swap"),
  });
}

export function algebraIntegralSnapshotFingerprint(
  descriptor: AlgebraIntegralPricingDescriptor,
  snapshot: AlgebraIntegralPricingSnapshot,
): string {
  return hashCanonical({
    pool: descriptor.pool,
    sqrtPriceX96: snapshot.sqrtPriceX96,
    liquidity: snapshot.liquidity,
    executedFee: snapshot.executedFee,
  });
}
