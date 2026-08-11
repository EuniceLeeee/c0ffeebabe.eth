import type { TokenEdge } from "../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import {
  bindRequestResultRound,
  collectRequestProgramResults,
  type PricingSemantics,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import {
  directedPoolMid,
  q96DirectedReserves,
  q96PrecisionProbeAmount,
} from "../blockscan-state-shared.js";
import {
  PANCAKE_V3_SWAP_TOPIC,
  UNIV3_BURN_TOPIC,
  UNIV3_INITIALIZE_TOPIC,
  UNIV3_MINT_TOPIC,
  UNIV3_POOL_INTERFACE,
  UNIV3_QUOTER_V2_INTERFACE,
  UNIV3_SWAP_TOPIC,
} from "../univ3-abi.js";
import {
  uniV3SnapshotCompatibilityProjection,
  uniV3StaticBindingProjection,
} from "./binding.js";
import {
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import type {
  UniV3Descriptor,
  UniV3PrecisionOutcome,
  UniV3PricingDescriptor,
  UniV3PricingSnapshot,
  UniV3Route,
} from "./types.js";

const SLOT0_REQUEST_ID = "current-slot0";
const LIQUIDITY_REQUEST_ID = "current-liquidity";
const PRECISION_REQUEST_PREFIX = "univ3-precision:";
const MAX_V3_EXACT_INPUT = (1n << 255n) - 1n;
const MUTATION_TOPICS = new Set([
  UNIV3_INITIALIZE_TOPIC,
  UNIV3_MINT_TOPIC,
  UNIV3_BURN_TOPIC,
  UNIV3_SWAP_TOPIC,
  PANCAKE_V3_SWAP_TOPIC,
]);

export const univ3Pricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    uniV3StaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: uniV3SnapshotCompatibilityProjection,
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey) {
      throw new Error(`univ3 pricing stateKey does not match ${descriptor.pool}`);
    }
    assertRoutesMatchDescriptor(descriptor, routes);
    return {
      instanceKey: descriptor.instanceKey,
      pool: descriptor.pool,
      token0: descriptor.token0,
      token1: descriptor.token1,
      fee: descriptor.fee,
      tickSpacing: descriptor.tickSpacing,
      factoryBinding: descriptor.factoryBinding,
      quoterBinding: descriptor.quoterBinding,
    };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    factoryBinding: Object.freeze({ ...draft.factoryBinding }),
    quoterBinding: Object.freeze({ ...draft.quoterBinding }),
  }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      Object.freeze({
        id: SLOT0_REQUEST_ID,
        kind: "eth-call" as const,
        to: descriptor.pool,
        data: UNIV3_POOL_INTERFACE.encodeFunctionData("slot0"),
        completion: "return-data" as const,
      }),
      Object.freeze({
        id: LIQUIDITY_REQUEST_ID,
        kind: "eth-call" as const,
        to: descriptor.pool,
        data: UNIV3_POOL_INTERFACE.encodeFunctionData("liquidity"),
        completion: "return-data" as const,
      }),
    ]),
    buildDependentProgram({
      current,
      completedRound,
      initialResults,
      priorEvidence,
    }) {
      if (completedRound > 0) return null;
      const priorResults = collectRequestProgramResults(
        initialResults,
        priorEvidence,
      );
      assertRoutesMatchPricingDescriptor(current.descriptor, current.routes);
      const snapshot = decodeCoreSnapshot(priorResults);
      if (snapshot.inactiveReason !== null) return null;
      const quoter = current.descriptor.quoterBinding.quoter;
      if (quoter === null) return null;
      const requests = [];
      for (const route of current.routes) {
        const amountIn = precisionAmount(current.descriptor, snapshot, route);
        if (amountIn === null) continue;
        const id = precisionRequestId(route, amountIn);
        if (priorResults.some((result) => result.id === id)) continue;
        const quoteCallData = UNIV3_QUOTER_V2_INTERFACE.encodeFunctionData(
          "quoteExactInputSingle",
          [{
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            amountIn,
            fee: current.descriptor.fee,
            sqrtPriceLimitX96: 0n,
          }],
        );
        requests.push(Object.freeze({
          id,
          kind: "eth-call" as const,
          to: quoter,
          data: quoteCallData,
          completion: "return-or-revert-data" as const,
        }));
      }
      return requests.length === 0
        ? null
        : bindRequestResultRound(
            { transports: ["eth-call"] },
            Object.freeze(requests),
          );
    },
    decodeSnapshot: ({ initialResults, dependentEvidence }) => decodeSnapshot(
      collectRequestProgramResults(initialResults, dependentEvidence),
    ),
    deriveMids({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      if (snapshot.inactiveReason !== null) return new Map();
      const mids = new Map<UniV3Route["routeKey"], RouteVenueMid>();
      for (const route of routes) {
        const amountIn = precisionAmount(descriptor, snapshot, route);
        const outcome = amountIn === null
          ? undefined
          : snapshot.precision[precisionRequestId(route, amountIn)];
        if (
          amountIn !== null &&
          descriptor.quoterBinding.quoter !== null &&
          outcome === undefined
        ) {
          throw new Error(`univ3 precision result missing for ${route.routeKey}`);
        }
        if (
          amountIn !== null &&
          (descriptor.quoterBinding.quoter === null ||
            outcome?.failure !== undefined ||
            outcome?.amountOut === undefined ||
            outcome.amountOut === 0n)
        ) {
          continue;
        }
        const directed = q96DirectedReserves({
          sqrtPriceX96: snapshot.sqrtPriceX96,
          liquidity: snapshot.liquidity,
          token0: descriptor.token0,
          token1: descriptor.token1,
          edge: routeEdge(descriptor, route),
          ...(amountIn === null
            ? {}
            : { precisionQuote: { amountIn, amountOut: outcome!.amountOut! } }),
        });
        if (directed === null) continue;
        mids.set(route.routeKey, directedPoolMid({
          kind: "v3",
          edge: routeEdge(descriptor, route),
          reserveIn: directed.reserveIn,
          reserveOut: directed.reserveOut,
          mid: directed.mid,
          sqrtPriceX96: directed.sqrtPriceInOutX96,
          liquidity: snapshot.liquidity,
          feeBps: Number(descriptor.fee) / 100,
        }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const unavailable = new Map<UniV3Route["routeKey"], string>();
      if (snapshot.inactiveReason !== null) {
        for (const route of routes) {
          unavailable.set(route.routeKey, snapshot.inactiveReason);
        }
        return unavailable;
      }
      for (const route of routes) {
        const amountIn = precisionAmount(descriptor, snapshot, route);
        if (amountIn === null) continue;
        if (descriptor.quoterBinding.quoter === null) {
          unavailable.set(
            route.routeKey,
            `univ3 direction ${route.tokenIn}->${route.tokenOut} requires a ` +
              "factory-bound current-source precision witness, but the " +
              `reverse-verified factory ${descriptor.factoryBinding.factory} ` +
              "has no verified quoter binding",
          );
          continue;
        }
        const outcome = snapshot.precision[
          precisionRequestId(route, amountIn)
        ];
        if (outcome === undefined) {
          throw new Error(`univ3 precision result missing for ${route.routeKey}`);
        }
        if (outcome.failure !== undefined) {
          unavailable.set(
            route.routeKey,
            `univ3 direction ${route.tokenIn}->${route.tokenOut} ` +
              `factory-bound current-source precision witness failed: ` +
              outcome.failure,
          );
        } else if (outcome.amountOut === 0n) {
          unavailable.set(
            route.routeKey,
            `univ3 direction ${route.tokenIn}->${route.tokenOut} returned zero ` +
              `at its current-source scanner ceiling ${amountIn}`,
          );
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
    ...(descriptor.quoterBinding.quoter === null
      ? []
      : [descriptor.quoterBinding.quoter]),
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      if (
        observation.kind !== "log" ||
        !sameAddress(observation.address, descriptor.pool) ||
        !MUTATION_TOPICS.has(observation.topics[0]?.toLowerCase() ?? "")
      ) {
        return [];
      }
      return [descriptor.instanceKey];
    },
  },
  liveStateProjection: {
    project: ({ descriptor, snapshot }) => ({
      kind: "v3-live",
      pool: descriptor.pool,
      token0: descriptor.token0,
      token1: descriptor.token1,
      fee: descriptor.fee,
      tickSpacing: descriptor.tickSpacing,
      sqrtPriceX96: snapshot.sqrtPriceX96,
      tick: snapshot.tick,
      liquidity: snapshot.liquidity,
      observationIndex: snapshot.observationIndex,
      observationCardinality: snapshot.observationCardinality,
      observationCardinalityNext: snapshot.observationCardinalityNext,
      feeProtocol: snapshot.feeProtocol,
      unlocked: snapshot.unlocked,
      blockNumber: snapshot.source.number,
    }),
  },
} satisfies PricingSemantics<
  UniV3Descriptor,
  UniV3Route,
  UniV3PricingDescriptor,
  UniV3PricingSnapshot
>;

function decodeSnapshot(
  results: readonly AdapterRequestResult[],
): UniV3PricingSnapshot {
  const core = decodeCoreSnapshot(results);
  const precision: Record<string, UniV3PrecisionOutcome> = {};
  for (const result of results) {
    if (!result.id.startsWith(PRECISION_REQUEST_PREFIX)) continue;
    const amountIn = precisionAmountFromRequestId(result.id);
    if (!result.ok) {
      throw new Error(
        `univ3 request result ${result.id} is unresolved: ${result.failure}`,
      );
    }
    if (result.completion === "reverted-as-declared") {
      precision[result.id] = Object.freeze({
        amountIn,
        failure: "quote call reverted",
      });
      continue;
    }
    const decoded = UNIV3_QUOTER_V2_INTERFACE.decodeFunctionResult(
      "quoteExactInputSingle",
      result.data,
    );
    precision[result.id] = Object.freeze({
      amountIn,
      amountOut: BigInt(decoded[0]),
    });
  }
  return Object.freeze({ ...core, precision });
}

function decodeCoreSnapshot(
  results: readonly AdapterRequestResult[],
): Omit<UniV3PricingSnapshot, "precision"> {
  const slot0Result = requireSuccessfulResult(results, SLOT0_REQUEST_ID);
  const liquidityResult = requireSuccessfulResult(results, LIQUIDITY_REQUEST_ID);
  assertSameSource(slot0Result.source, liquidityResult.source);
  const slot0 = UNIV3_POOL_INTERFACE.decodeFunctionResult(
    "slot0",
    slot0Result.data,
  );
  const liquidity = BigInt(UNIV3_POOL_INTERFACE.decodeFunctionResult(
    "liquidity",
    liquidityResult.data,
  )[0]);
  const sqrtPriceX96 = BigInt(slot0[0]);
  const inactive = [];
  if (sqrtPriceX96 === 0n) inactive.push("sqrtPriceX96");
  if (liquidity === 0n) inactive.push("liquidity");
  return Object.freeze({
    source: slot0Result.source,
    sqrtPriceX96,
    tick: Number(slot0[1]),
    liquidity,
    observationIndex: Number(slot0[2]),
    observationCardinality: Number(slot0[3]),
    observationCardinalityNext: Number(slot0[4]),
    feeProtocol: Number(slot0[5]),
    unlocked: Boolean(slot0[6]),
    inactiveReason: inactive.length === 0
      ? null
      : `univ3 pool has zero ${inactive.join(" and ")} at the current source`,
  });
}

function precisionAmount(
  descriptor: UniV3PricingDescriptor,
  snapshot: Pick<UniV3PricingSnapshot, "sqrtPriceX96" | "liquidity">,
  route: UniV3Route,
): bigint | null {
  return q96PrecisionProbeAmount({
    sqrtPriceX96: snapshot.sqrtPriceX96,
    liquidity: snapshot.liquidity,
    token0: descriptor.token0,
    token1: descriptor.token1,
    edge: routeEdge(descriptor, route),
    maxAmountIn: MAX_V3_EXACT_INPUT,
  });
}

function precisionRequestId(route: UniV3Route, amountIn: bigint): string {
  return `${PRECISION_REQUEST_PREFIX}${amountIn}:` + hashCanonical({
    routeKey: route.routeKey,
    amountIn,
  });
}

function precisionAmountFromRequestId(id: string): bigint {
  const suffix = id.slice(PRECISION_REQUEST_PREFIX.length);
  const separator = suffix.indexOf(":");
  if (separator <= 0) throw new Error(`malformed univ3 precision id ${id}`);
  return BigInt(suffix.slice(0, separator));
}

function assertSameSource(left: CanonicalSource, right: CanonicalSource): void {
  if (
    left.number !== right.number ||
    left.hash.toLowerCase() !== right.hash.toLowerCase() ||
    left.generation !== right.generation
  ) {
    throw new Error("univ3 current reads came from different canonical sources");
  }
}

function assertRoutesMatchDescriptor(
  descriptor: UniV3Descriptor,
  routes: readonly UniV3Route[],
): void {
  for (const route of routes) {
    if (
      route.instanceKey !== descriptor.instanceKey ||
      !sameAddress(route.pool, descriptor.pool) ||
      route.fee !== descriptor.fee ||
      route.tickSpacing !== descriptor.tickSpacing
    ) {
      throw new Error(`univ3 route does not belong to ${descriptor.pool}`);
    }
  }
}

function assertRoutesMatchPricingDescriptor(
  descriptor: UniV3PricingDescriptor,
  routes: readonly UniV3Route[],
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
      route.fee !== descriptor.fee ||
      route.tickSpacing !== descriptor.tickSpacing
    ) {
      throw new Error(`univ3 route binding does not match ${descriptor.pool}`);
    }
  }
}

function routeEdge(
  descriptor: UniV3PricingDescriptor,
  route: UniV3Route,
): TokenEdge {
  return Object.freeze({
    adapterId: "univ3-swap",
    instanceKey: route.instanceKey,
    target: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: "swap" as const,
    poolToken0: descriptor.token0,
    poolToken1: descriptor.token1,
    v3Fee: Number(descriptor.fee),
    v3TickSpacing: descriptor.tickSpacing,
    factory: descriptor.factoryBinding.factory,
    ...deriveEdgeTaxonomy("swap"),
  });
}
