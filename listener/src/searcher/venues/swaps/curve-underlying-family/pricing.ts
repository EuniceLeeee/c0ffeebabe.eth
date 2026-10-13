import { lendingGuardRequests, assertLendingGuards, lendingSwapRequest, decodeLendingSwap,
  lendingSimulationRequirements, lendingProjection } from "./lending.js";
import { acceptLegacyPlainControlCall, legacyPlainQuoteRequests, decodeLegacyPlainState, quoteLegacyPlain } from "./legacy-plain.js";
import { curveUnderlyingAcceptBaseCall, curveUnderlyingAcceptLpMutation, curveUnderlyingAcceptMutation, curveUnderlyingQuoteModelProjection, curveUnderlyingRefreshAddresses } from "./quote-model.js";
import { CURVE_UNDERLYING_NATIVE_QUOTE } from "./native.js";
import { compileAddressMutations } from "../../mutation-index.js";
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
  // Crypto and the bound classic meta/base model can change price as A/gamma
  // ramps advance without pool activity. Reuse the central each-block lifecycle;
  // current A and every dependent amount quote stay bound to that same source.
  refreshPolicyForInstance: ({ descriptor }) => descriptor.nativeAlias || descriptor.quoteModel || descriptor.lending
    ? "each-block" : "on-touch",
  stateKey: (route) => route.routeKey,
  staticBindingProjection: ({ descriptor, routes }) => ({
    pool: descriptor.pool,
    quoteModel: curveUnderlyingQuoteModelProjection(descriptor.quoteModel),
    legacyPlain: descriptor.legacyPlain ? { ...descriptor.legacyPlain } : null,
    lending: lendingProjection(descriptor.lending),
    nativeAlias: descriptor.nativeAlias ? { ...descriptor.nativeAlias } : null,
    coins: descriptor.coins,
    registryBinding: {
      registry: descriptor.registryBinding.registry,
      handlers: descriptor.registryBinding.handlers,
      lookupSemantics: descriptor.registryBinding.lookupSemantics,
      ...(descriptor.registryBinding.lookupSemantics === "get_base_pool+get_underlying_coins"
        ? { basePool: descriptor.registryBinding.basePool } : {}),
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
    quoteModel: curveUnderlyingQuoteModelProjection(descriptor.quoteModel),
    legacyPlain: descriptor.legacyPlain ? { ...descriptor.legacyPlain } : null,
    lending: lendingProjection(descriptor.lending),
    nativeAlias: descriptor.nativeAlias ? { ...descriptor.nativeAlias } : null,
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
      ...(descriptor.quoteModel ? { quoteModel: descriptor.quoteModel } : {}),
      ...(descriptor.legacyPlain ? { legacyPlain: descriptor.legacyPlain } : {}),
      ...(descriptor.lending ? { lending: descriptor.lending } : {}),
      ...(descriptor.nativeAlias ? { nativeAlias: descriptor.nativeAlias } : {}),
      route,
    });
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({
    ...draft,
    coins: Object.freeze([...draft.coins]),
  }),
  current: {
    requirements: ({ descriptor }) => ({ transports: descriptor.legacyPlain || descriptor.lending ? ["eth-call", "get-code", "get-storage"] : ["eth-call"] }),
    buildRequests({ descriptor }) {
      if (descriptor.lending) return [...lendingGuardRequests(descriptor.pool, descriptor.lending), {
        id: TOKEN_DECIMALS_ID, kind: "eth-call" as const, to: descriptor.route.tokenIn,
        data: CURVE_UNDERLYING_ERC20_INTERFACE.encodeFunctionData("decimals"), completion: "return-data" as const,
      }];
      return Object.freeze([
        ...(descriptor.legacyPlain ? legacyPlainQuoteRequests(descriptor.pool) : []),
        Object.freeze({
          id: REGISTRY_DECIMALS_ID,
          kind: "eth-call" as const,
          to: descriptor.registry,
          data: CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData(
            "get_underlying_decimals",
            [descriptor.pool],
          ),
          required: false,
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
          required: false,
          completion: "return-data" as const,
        }),
        Object.freeze({
          id: TOKEN_DECIMALS_ID,
          kind: "eth-call" as const,
          to: descriptor.route.tokenIn,
          data: CURVE_UNDERLYING_ERC20_INTERFACE.encodeFunctionData("decimals"),
          required: false,
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
      if (current.descriptor.lending) {
        assertLendingGuards(current.descriptor.pool, current.descriptor.coins, current.descriptor.lending,
          current.source, initialResults);
        const results = collectRequestProgramResults(initialResults, priorEvidence);
        const candidates = quoteCandidates(current.descriptor, results);
        if (completedRound === 0) return bindRequestResultRound(lendingSimulationRequirements,
          [lendingCurrentRequest(current.descriptor, candidates[0], 0)]);
        if (lendingCurrentQuote(current.descriptor, results, candidates) !== null || completedRound !== 1) return null;
        return bindRequestResultRound(lendingSimulationRequirements, candidates.slice(1).map((amount, index) =>
          lendingCurrentRequest(current.descriptor, amount, index + 1)));
      }
      if (current.descriptor.legacyPlain) return null;
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
      if (descriptor.lending) {
        const source = requireSuccessfulResult(initialResults, "lending-pool-code").source;
        assertLendingGuards(descriptor.pool, descriptor.coins, descriptor.lending, source, initialResults);
        const quote = lendingCurrentQuote(descriptor, results, candidates);
        if (quote === null) throw new Error("lending has no executable current quote");
        const scale = decodeInputScale(descriptor, results);
        return { source, amountIn: quote.amountIn, amountOut: quote.amountOut, inputUnit: scale.unit, inputBalance: null };
      }
      if (descriptor.legacyPlain) {
        const source = requireSuccessfulResult(results, "legacy-plain-code").source;
        const state = decodeLegacyPlainState(descriptor.legacyPlain, source, results);
        const scale = decodeInputScale(descriptor, results);
        for (const amountIn of candidates) {
          const amountOut = quoteLegacyPlain(state, descriptor.route.i, descriptor.route.j, amountIn);
          if (amountOut > 0n) return Object.freeze({ source, amountIn, amountOut,
            inputUnit: scale.unit, inputBalance: scale.balance });
        }
        throw new Error("legacy plain has no positive current quote");
      }
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
  dependencies: ({ descriptor }) => Object.freeze([...new Set([
    ...refreshAddresses(descriptor),
    descriptor.registry,
    ...descriptor.coins,
  ].map(address => address.toLowerCase()))]),
  mutation: {
    compile: ({ entries }) => {
      const logs = compileAddressMutations(entries, ({ descriptor, routes }) => ({
        addresses: refreshAddresses(descriptor).filter(address => !descriptor.quoteModel ||
          !sameAddress(address, descriptor.quoteModel.baseLPToken)),
        keys: routes.map(route => route.routeKey),
      }), { kinds: ["log"], accept: curveUnderlyingAcceptMutation });
      const lp = compileAddressMutations(entries, ({ descriptor, routes }) => ({
        addresses: descriptor.quoteModel ? [descriptor.quoteModel.baseLPToken] : [],
        keys: routes.map(route => route.routeKey),
      }), { kinds: ["log"], accept: curveUnderlyingAcceptLpMutation });
      const calls = compileAddressMutations(entries, ({ descriptor, routes }) => ({
        addresses: descriptor.quoteModel ? [descriptor.quoteModel.basePool] : [],
        keys: routes.map(route => route.routeKey),
      }), { kinds: ["call"], accept: curveUnderlyingAcceptBaseCall });
      const controls = compileAddressMutations(entries, ({ descriptor, routes }) => ({
        addresses: descriptor.legacyPlain || descriptor.lending ? [descriptor.pool] : [],
        keys: routes.map(route => route.routeKey),
      }), { kinds: ["call"], accept: acceptLegacyPlainControlCall });
      return Object.freeze({
        dependencies: Object.freeze([...new Set([...logs.dependencies, ...lp.dependencies, ...calls.dependencies, ...controls.dependencies])]),
        affectedStateKeys: ({ observation }: Parameters<typeof logs.affectedStateKeys>[0]) => {
          if (observation.kind === "call") return Object.freeze([...new Set([
            ...calls.affectedStateKeys({ observation }), ...controls.affectedStateKeys({ observation }),
          ])]);
          const logKeys = logs.affectedStateKeys({ observation });
          const lpKeys = lp.affectedStateKeys({ observation });
          if (lpKeys.length === 0) return logKeys;
          if (logKeys.length === 0) return lpKeys;
          return Object.freeze([...new Set([...logKeys, ...lpKeys])]);
        },
      });
    },
    affectedStateKeys({ descriptor, routes, observation }) {
      if (observation.kind === "call") {
        if ((descriptor.legacyPlain || descriptor.lending) && sameAddress(observation.target, descriptor.pool) &&
            acceptLegacyPlainControlCall(observation)) return Object.freeze(routes.map(route => route.routeKey));
        return descriptor.quoteModel && curveUnderlyingAcceptBaseCall(observation) &&
          sameAddress(observation.target, descriptor.quoteModel.basePool)
          ? Object.freeze(routes.map(route => route.routeKey)) : [];
      }
      if (observation.kind === "log" && descriptor.quoteModel &&
          sameAddress(observation.address, descriptor.quoteModel.baseLPToken) &&
          !curveUnderlyingAcceptLpMutation(observation)) return [];
      if (
        observation.kind !== "log" || !curveUnderlyingAcceptMutation(observation) ||
        !refreshAddresses(descriptor).some(address => sameAddress(observation.address, address))
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
    data: (descriptor.nativeAlias ? CURVE_UNDERLYING_NATIVE_QUOTE : CURVE_UNDERLYING_POOL_INTERFACE).encodeFunctionData(
      descriptor.nativeAlias ? "get_dy" : "get_dy_underlying",
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

function refreshAddresses(descriptor: CurveUnderlyingPricingDescriptor): readonly string[] {
  return descriptor.lending ? [descriptor.pool, descriptor.lending.lpToken, ...descriptor.lending.wrappedCoins]
    : curveUnderlyingRefreshAddresses(descriptor);
}
function lendingCurrentRequest(descriptor: CurveUnderlyingPricingDescriptor, amountIn: bigint, index: number): AdapterRequest {
  return lendingSwapRequest({ id: quoteRequestId(index), ...descriptor.route, pool: descriptor.pool, amountIn });
}
function lendingCurrentQuote(descriptor: CurveUnderlyingPricingDescriptor, results: readonly AdapterRequestResult[],
  candidates: readonly bigint[]): { amountIn: bigint; amountOut: bigint } | null {
  const source = requireSuccessfulResult(results, "lending-pool-code").source;
  for (const [index, amountIn] of candidates.entries()) {
    const read = results.find(r => r.id === quoteRequestId(index));
    if (!read) continue;
    const amountOut = decodeLendingSwap({ pool: descriptor.pool, coins: descriptor.coins, binding: descriptor.lending!,
      i: descriptor.route.i, j: descriptor.route.j, amountIn, source }, read);
    if (amountOut !== null) return { amountIn, amountOut };
  }
  return null;
}
