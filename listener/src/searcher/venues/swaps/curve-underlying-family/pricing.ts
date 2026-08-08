import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import type { TokenEdge } from "../../../planner/token-graph.js";
import {
  bindRequestResultRound,
  collectRequestProgramResults,
  PricingSemantics,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import {
  CURVE_METAREGISTRY,
  CURVE_UNDERLYING_ERC20_INTERFACE,
  CURVE_UNDERLYING_META_INTERFACE,
  CURVE_UNDERLYING_POOL_INTERFACE,
  decodeGetDy,
  decodeTokenDecimals,
  decodeUnderlyingBalances,
  decodeUnderlyingDecimals,
  requireSuccessfulResult,
  sameAddress,
} from "./codec.js";
import type {
  CurveUnderlyingDescriptor,
  CurveUnderlyingPricingDescriptor,
  CurveUnderlyingPricingSnapshot,
  CurveUnderlyingRoute,
} from "./types.js";

const REGISTRY_DECIMALS_ID = "current-registry-decimals";
const REGISTRY_BALANCES_ID = "current-registry-balances";
const TOKEN_DECIMALS_ID = "current-token-decimals";
const QUOTE_PREFIX = "current-get-dy:";

export const curveUnderlyingPricing = {
  stateKey: (route) => route.routeKey,
  staticBindingProjection: ({ descriptor, routes }) => ({
    pool: descriptor.pool,
    coins: descriptor.coins,
    registryBinding: {
      registry: descriptor.registryBinding.registry,
      handlers: descriptor.registryBinding.handlers,
      lookupSemantics: descriptor.registryBinding.lookupSemantics,
    },
    directions: routes.map((route) => ({
      i: route.i,
      j: route.j,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      semantics: route.semantics,
    })),
  }),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
    pool: descriptor.pool,
    registry: descriptor.registryBinding.registry,
    directions: routes.map((route) => ({
      i: route.i,
      j: route.j,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
    })),
  }),
  compileDraft({ descriptor, routes }) {
    if (routes.length !== 1) {
      throw new Error("curve-underlying pricing requires one directed route");
    }
    const route = routes[0];
    assertRoute(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      pool: descriptor.pool,
      registry: descriptor.registryBinding.registry,
      coins: Object.freeze([...descriptor.coins]),
      route,
    });
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    coins: Object.freeze([...draft.coins]),
  }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests({ descriptor }) {
      return Object.freeze([
        Object.freeze({
          id: REGISTRY_DECIMALS_ID,
          kind: "eth-call" as const,
          to: descriptor.registry,
          data: CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData(
            "get_underlying_decimals",
            [descriptor.pool],
          ),
          completion: "return-data" as const,
        }),
        Object.freeze({
          id: REGISTRY_BALANCES_ID,
          kind: "eth-call" as const,
          to: descriptor.registry,
          data: CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData(
            "get_underlying_balances",
            [descriptor.pool],
          ),
          completion: "return-data" as const,
        }),
        Object.freeze({
          id: TOKEN_DECIMALS_ID,
          kind: "eth-call" as const,
          to: descriptor.route.tokenIn,
          data: CURVE_UNDERLYING_ERC20_INTERFACE.encodeFunctionData("decimals"),
          completion: "return-data" as const,
        }),
      ]);
    },
    buildDependentProgram({
      current,
      completedRound,
      initialResults,
      priorEvidence,
    }) {
      const priorResults = collectRequestProgramResults(
        initialResults,
        priorEvidence,
      );
      const candidates = quoteCandidates(current.descriptor, priorResults);
      if (completedRound === 0) {
        return bindRequestResultRound(
          { transports: ["eth-call"] },
          Object.freeze([quoteRequest(current.descriptor, candidates[0], 0)]),
        );
      }
      if (firstPositiveQuote(priorResults, candidates) !== null) return null;
      if (completedRound !== 1 || candidates.length === 1) return null;
      return bindRequestResultRound(
        { transports: ["eth-call"] },
        Object.freeze(candidates.slice(1).map((amountIn, offset) =>
          quoteRequest(current.descriptor, amountIn, offset + 1)
        )),
      );
    },
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      const results = collectRequestProgramResults(
        initialResults,
        dependentEvidence,
      );
      const candidates = quoteCandidates(descriptor, results);
      const quote = firstPositiveQuote(results, candidates);
      if (quote === null) {
        const failed = results.find((result) =>
          result.id.startsWith(QUOTE_PREFIX) && !result.ok
        );
        if (failed !== undefined && !failed.ok) {
          throw new Error(`curve-underlying unresolved: ${failed.failure}`);
        }
        throw new Error(
          `curve-underlying ${descriptor.pool} ${descriptor.route.i}->` +
            `${descriptor.route.j} returned no positive current quote`,
        );
      }
      const quoteResult = requireSuccessfulResult(
        results,
        quoteRequestId(quote.index),
      );
      const scale = decodeInputScale(descriptor, results);
      return Object.freeze({
        source: quoteResult.source,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        inputUnit: scale.unit,
        inputBalance: scale.balance,
      });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (routes.length !== 1) {
        throw new Error("curve-underlying pricing snapshot requires one route");
      }
      const route = routes[0];
      assertPricingRoute(descriptor, route);
      return new Map([[route.routeKey, quotedPoolMid({
        kind: "curve-underlying",
        edge: routeEdge(descriptor, route),
        amountIn: snapshot.amountIn,
        amountOut: snapshot.amountOut,
        depthIn: snapshot.inputBalance ?? snapshot.amountIn * 10_000n,
        depthOut: snapshot.amountOut * 10_000n,
      })]]);
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.pool,
    descriptor.registry,
    ...descriptor.coins,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, routes, observation }) {
      if (
        observation.kind !== "log" ||
        !sameAddress(observation.address, descriptor.pool)
      ) {
        return [];
      }
      return Object.freeze(routes.map((route) => route.routeKey));
    },
  },
  liveStateProjection: {
    project: ({ descriptor, snapshot }) => ({
      kind: "curve-underlying-directed-quote",
      pool: descriptor.pool,
      i: descriptor.route.i,
      j: descriptor.route.j,
      tokenIn: descriptor.route.tokenIn,
      tokenOut: descriptor.route.tokenOut,
      amountIn: snapshot.amountIn,
      amountOut: snapshot.amountOut,
      blockNumber: snapshot.source.number,
    }),
  },
} satisfies PricingSemantics<
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute,
  CurveUnderlyingPricingDescriptor,
  CurveUnderlyingPricingSnapshot
>;

function quoteCandidates(
  descriptor: CurveUnderlyingPricingDescriptor,
  results: readonly AdapterRequestResult[],
): readonly bigint[] {
  const { unit, balance } = decodeInputScale(descriptor, results);
  const candidates: bigint[] = [];
  if (unit !== null) candidates.push(unit);
  if (balance !== null) {
    const cap = balance / 100n > 0n ? balance / 100n : balance;
    let probe = balance / 1_000_000n > 0n ? balance / 1_000_000n : 1n;
    candidates.push(probe);
    while (probe < cap) {
      const next = probe * 10n;
      probe = next > cap ? cap : next;
      candidates.push(probe);
    }
  } else if (unit !== null) {
    candidates.push(
      unit / 1_000_000n,
      unit / 1_000n,
      unit * 1_000n,
      unit * 1_000_000n,
    );
  }
  const unique: bigint[] = [];
  const seen = new Set<string>();
  for (const value of candidates) {
    if (value <= 0n) continue;
    const key = value.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  if (unique.length === 0 || unique.length > 32) {
    throw new Error(
      `curve-underlying requires 1..32 quote candidates, got ${unique.length}`,
    );
  }
  return Object.freeze(unique);
}

function decodeInputScale(
  descriptor: CurveUnderlyingPricingDescriptor,
  results: readonly AdapterRequestResult[],
): { readonly unit: bigint | null; readonly balance: bigint | null } {
  let unit: bigint | null = null;
  let balance: bigint | null = null;
  const registryDecimals = optionalSuccessfulResult(results, REGISTRY_DECIMALS_ID);
  if (registryDecimals !== null) {
    const decimals = decodeUnderlyingDecimals(registryDecimals.data)[descriptor.route.i];
    if (decimals !== undefined && decimals >= 0n && decimals <= 36n) {
      unit = 10n ** decimals;
    }
  }
  const registryBalances = optionalSuccessfulResult(results, REGISTRY_BALANCES_ID);
  if (registryBalances !== null) {
    const current = decodeUnderlyingBalances(registryBalances.data)[descriptor.route.i];
    if (current !== undefined && current > 0n) balance = current;
  }
  if (unit === null) {
    const tokenDecimals = optionalSuccessfulResult(results, TOKEN_DECIMALS_ID);
    if (tokenDecimals !== null) {
      unit = 10n ** BigInt(decodeTokenDecimals(tokenDecimals.data));
    }
  }
  if (unit === null && balance === null) {
    throw new Error(
      `curve-underlying ${descriptor.pool} has no behavior-proven input scale`,
    );
  }
  return Object.freeze({ unit, balance });
}

function optionalSuccessfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> | null {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined || !result.ok || result.completion !== "returned") {
    return null;
  }
  return result;
}

function quoteRequest(
  descriptor: CurveUnderlyingPricingDescriptor,
  amountIn: bigint | undefined,
  index: number,
): AdapterRequest {
  if (amountIn === undefined || amountIn <= 0n) {
    throw new Error(`curve-underlying quote candidate ${index} is invalid`);
  }
  return Object.freeze({
    id: quoteRequestId(index),
    kind: "eth-call" as const,
    to: descriptor.pool,
    data: CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionData(
      "get_dy_underlying",
      [BigInt(descriptor.route.i), BigInt(descriptor.route.j), amountIn],
    ),
    completion: "return-data" as const,
  });
}

function firstPositiveQuote(
  results: readonly AdapterRequestResult[],
  candidates: readonly bigint[],
): { readonly index: number; readonly amountIn: bigint; readonly amountOut: bigint } | null {
  for (let index = 0; index < candidates.length; index++) {
    const result = results.find((candidate) => candidate.id === quoteRequestId(index));
    if (result === undefined || !result.ok || result.completion !== "returned") {
      continue;
    }
    let amountOut: bigint;
    try {
      amountOut = decodeGetDy(result.data);
    } catch {
      continue;
    }
    if (amountOut > 0n) {
      return Object.freeze({ index, amountIn: candidates[index], amountOut });
    }
  }
  return null;
}

function quoteRequestId(index: number): string {
  return `${QUOTE_PREFIX}${index}`;
}

function assertRoute(
  descriptor: CurveUnderlyingDescriptor,
  route: CurveUnderlyingRoute | undefined,
): asserts route is CurveUnderlyingRoute {
  if (route === undefined) throw new Error("curve-underlying route is missing");
  const direction = descriptor.verifiedDirections.find((candidate) =>
    candidate.i === route.i && candidate.j === route.j
  );
  if (
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    direction === undefined ||
    !sameAddress(route.tokenIn, direction.tokenIn) ||
    !sameAddress(route.tokenOut, direction.tokenOut)
  ) {
    throw new Error("curve-underlying route does not match descriptor binding");
  }
}

function assertPricingRoute(
  descriptor: CurveUnderlyingPricingDescriptor,
  route: CurveUnderlyingRoute | undefined,
): asserts route is CurveUnderlyingRoute {
  if (
    route === undefined ||
    route.routeKey !== descriptor.route.routeKey ||
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.pool, descriptor.pool) ||
    route.i !== descriptor.route.i ||
    route.j !== descriptor.route.j
  ) {
    throw new Error("curve-underlying pricing route does not match descriptor");
  }
}

function routeEdge(
  descriptor: CurveUnderlyingPricingDescriptor,
  route: CurveUnderlyingRoute,
): TokenEdge {
  return Object.freeze({
    adapterId: "curve-exchange-underlying",
    instanceKey: route.instanceKey,
    target: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: "swap" as const,
    curveI: route.i,
    curveJ: route.j,
    ...deriveEdgeTaxonomy("swap"),
  });
}
