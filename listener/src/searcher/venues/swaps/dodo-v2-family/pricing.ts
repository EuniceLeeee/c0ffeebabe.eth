import type { TokenEdge } from "../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import {
  bindRequestResultRound,
  collectRequestProgramResults,
  type PricingSemantics,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import {
  BLOCKSCAN_MULTICALL3,
  quotedPoolMid,
} from "../blockscan-state-shared.js";
import {
  quoteDodoPmmExactInput,
} from "../dodo-pmm-math.js";
import {
  assertSameSource,
  decodeAddressResult,
  decodeDecimalsResult,
  decodeDodoPmmState,
  decodeFeeRates,
  decodeInputSemanticsResult,
  inputSemanticsCall,
  requireSuccessfulResult,
  sameAddress,
  DODO_V2_ERC20_INTERFACE,
  DODO_V2_POOL_INTERFACE,
  DODO_V2_SWAP_TOPIC,
} from "./codec.js";
import { staticBindingProjection } from "./instance.js";
import { DODO_V2_QUOTE_ACTOR_EVIDENCE_ID } from "./identity.js";
import {
  applyDodoTransferToInput,
  buildBoundedProbeCall,
  decodeBoundedProbeResult,
  selectDodoProbeInput,
} from "./pricing-helpers.js";
import type {
  DodoBoundedProbePlan,
  DodoV2CurrentCore,
  DodoV2Descriptor,
  DodoV2PricingDescriptor,
  DodoV2PricingDraft,
  DodoV2PricingRouteBinding,
  DodoV2PricingSnapshot,
  DodoV2Route,
  DodoV2StaticEvidence,
} from "./types.js";

const STATIC_BASE_DECIMALS_ID = "static-base-decimals";
const STATIC_QUOTE_DECIMALS_ID = "static-quote-decimals";
const CURRENT_BASE_TOKEN_ID = "current-base-token";
const CURRENT_QUOTE_TOKEN_ID = "current-quote-token";
const CURRENT_PMM_ID = "current-pmm-state";
const CURRENT_FEE_ID = "current-actor-fee";
const CURRENT_INPUT_ID = "current-input-semantics";
const BOUNDED_PROBE_PREFIX = "current-bounded-probe:";

export const dodoV2Pricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    staticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
    pool: descriptor.pool,
    baseToken: descriptor.baseToken,
    quoteToken: descriptor.quoteToken,
    quoteActorBinding: {
      actor: descriptor.quoteActorBinding.actor,
      role: descriptor.quoteActorBinding.role,
      feeSemantics: descriptor.quoteActorBinding.feeSemantics,
      querySemantics: descriptor.quoteActorBinding.querySemantics,
      inputSemantics: descriptor.quoteActorBinding.inputSemantics,
    },
    directions: routes.map((route) => ({
      routeKey: route.routeKey,
      direction: route.direction,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
    })).sort((left, right) => left.routeKey.localeCompare(right.routeKey)),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey) {
      throw new Error(`dodo-v2 pricing stateKey does not match ${descriptor.pool}`);
    }
    assertRoutesMatchDescriptor(descriptor, routes);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      pool: descriptor.pool,
      baseToken: descriptor.baseToken,
      quoteToken: descriptor.quoteToken,
      registryBinding: descriptor.registryBinding,
      quoteActorBinding: descriptor.quoteActorBinding,
      routes: Object.freeze(routes.map(pricingRouteBinding)),
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: DodoV2PricingDraft) => Object.freeze([
        draft.baseToken,
        draft.quoteToken,
      ]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: DodoV2PricingDraft) => Object.freeze([
      decimalsRequest(STATIC_BASE_DECIMALS_ID, draft.baseToken),
      decimalsRequest(STATIC_QUOTE_DECIMALS_ID, draft.quoteToken),
    ]),
    decode({ results }: {
      readonly programInput: DodoV2PricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): DodoV2StaticEvidence {
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(`dodo-v2 static decimals unresolved: ${result.failure}`);
        }
        return result;
      });
      assertSameSource(successful);
      return Object.freeze({
        baseOneToken: decodeDecimalsResult(results, STATIC_BASE_DECIMALS_ID),
        quoteOneToken: decodeDecimalsResult(results, STATIC_QUOTE_DECIMALS_ID),
      });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error(`dodo-v2 pricing ${draft.pool} is missing decimals evidence`);
    }
    return Object.freeze({
      ...draft,
      registryBinding: Object.freeze({ ...draft.registryBinding }),
      quoteActorBinding: Object.freeze({ ...draft.quoteActorBinding }),
      routes: Object.freeze(draft.routes.map((route) => Object.freeze({ ...route }))),
      baseOneToken: staticEvidence.baseOneToken,
      quoteOneToken: staticEvidence.quoteOneToken,
    });
  },
  current: {
    requirements: () => ({
      transports: ["eth-call" as const],
      caller: "verified-actor" as const,
    }),
    buildRequests: ({ descriptor }) => currentRequests(descriptor),
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
      const core = decodeCurrentCore(current.descriptor, priorResults);
      const requests: AdapterRequest[] = [];
      for (const route of current.descriptor.routes) {
        const selection = currentSelection(current.descriptor, core, route);
        if (
          typeof selection === "bigint" ||
          selection.kind !== "bounded-onchain-probe"
        ) {
          continue;
        }
        requests.push(boundedProbeRequest(current.descriptor, route, selection));
      }
      return requests.length === 0
        ? null
        : bindRequestResultRound(
            {
              transports: ["eth-call"],
              caller: "verified-actor",
            },
            Object.freeze(requests),
          );
    },
    decodeSnapshot: ({ descriptor, initialResults, dependentEvidence }) =>
      decodeSnapshot(
        descriptor,
        collectRequestProgramResults(initialResults, dependentEvidence),
      ),
    deriveMids({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const mids = new Map<DodoV2Route["routeKey"], RouteVenueMid>();
      for (const route of routes) {
        if (Object.hasOwn(snapshot.unavailable, route.routeKey)) continue;
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined) {
          throw new Error(`missing dodo-v2 current quote for ${route.routeKey}`);
        }
        mids.set(route.routeKey, quotedPoolMid({
          kind: "external-swap",
          edge: routeEdge(descriptor, route),
          amountIn: quote.amountIn,
          amountOut: quote.amountOut,
          depthIn: quote.amountIn * 10_000n,
          depthOut: quote.amountOut * 10_000n,
        }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor, snapshot, routes }) {
      assertRoutesMatchPricingDescriptor(descriptor, routes);
      const unavailable = new Map<DodoV2Route["routeKey"], string>();
      for (const route of routes) {
        const reason = snapshot.unavailable[route.routeKey];
        if (reason !== undefined) unavailable.set(route.routeKey, reason);
      }
      return unavailable;
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.pool,
    descriptor.baseToken,
    descriptor.quoteToken,
    descriptor.registryBinding.registry,
    descriptor.quoteActorBinding.actor,
    BLOCKSCAN_MULTICALL3,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      if (
        observation.kind !== "log" ||
        !sameAddress(observation.address, descriptor.pool) ||
        observation.topics[0]?.toLowerCase() !== DODO_V2_SWAP_TOPIC
      ) {
        return [];
      }
      return [descriptor.instanceKey];
    },
  },
  liveStateProjection: {
    project: ({ descriptor, snapshot }) => ({
      kind: "dodo-v2-pmm-live",
      pool: descriptor.pool,
      baseToken: descriptor.baseToken,
      quoteToken: descriptor.quoteToken,
      quoteActor: descriptor.quoteActorBinding.actor,
      pmm: {
        i: snapshot.pmm.i,
        K: snapshot.pmm.K,
        B: snapshot.pmm.B,
        Q: snapshot.pmm.Q,
        B0: snapshot.pmm.B0,
        Q0: snapshot.pmm.Q0,
        R: snapshot.pmm.R,
      },
      lpFeeRate: snapshot.lpFeeRate,
      mtFeeRate: snapshot.mtFeeRate,
      baseInput: {
        surplus: snapshot.baseInput.surplus,
        deficit: snapshot.baseInput.deficit,
      },
      quoteInput: {
        surplus: snapshot.quoteInput.surplus,
        deficit: snapshot.quoteInput.deficit,
      },
      blockNumber: snapshot.source.number,
    }),
  },
} satisfies PricingSemantics<
  DodoV2Descriptor,
  DodoV2Route,
  DodoV2PricingDescriptor,
  DodoV2PricingSnapshot,
  DodoV2PricingDraft,
  DodoV2StaticEvidence
>;

function decimalsRequest(id: string, token: string): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: token,
    data: DODO_V2_ERC20_INTERFACE.encodeFunctionData("decimals"),
    completion: "return-data" as const,
  });
}

function currentRequests(
  descriptor: DodoV2PricingDescriptor,
): readonly AdapterRequest[] {
  const inputCall = inputSemanticsCall(descriptor);
  return Object.freeze([
    poolCall(CURRENT_BASE_TOKEN_ID, descriptor.pool, "_BASE_TOKEN_"),
    poolCall(CURRENT_QUOTE_TOKEN_ID, descriptor.pool, "_QUOTE_TOKEN_"),
    poolCall(CURRENT_PMM_ID, descriptor.pool, "getPMMStateForCall"),
    Object.freeze({
      id: CURRENT_FEE_ID,
      kind: "eth-call" as const,
      to: descriptor.pool,
      caller: Object.freeze({
        kind: "verified-actor" as const,
        evidenceId: DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
      }),
      data: DODO_V2_POOL_INTERFACE.encodeFunctionData("getUserFeeRate", [
        descriptor.quoteActorBinding.actor,
      ]),
      completion: "return-data" as const,
    }),
    Object.freeze({
      id: CURRENT_INPUT_ID,
      kind: "eth-call" as const,
      to: inputCall.to,
      data: inputCall.data,
      completion: "return-data" as const,
    }),
  ]);
}

function poolCall(
  id: string,
  pool: string,
  functionName: "_BASE_TOKEN_" | "_QUOTE_TOKEN_" | "getPMMStateForCall",
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: pool,
    data: DODO_V2_POOL_INTERFACE.encodeFunctionData(functionName),
    completion: "return-data" as const,
  });
}

function decodeCurrentCore(
  descriptor: DodoV2PricingDescriptor,
  results: readonly AdapterRequestResult[],
): DodoV2CurrentCore {
  const baseResult = requireSuccessfulResult(results, CURRENT_BASE_TOKEN_ID);
  const quoteResult = requireSuccessfulResult(results, CURRENT_QUOTE_TOKEN_ID);
  const pmmResult = requireSuccessfulResult(results, CURRENT_PMM_ID);
  const feeResult = requireSuccessfulResult(results, CURRENT_FEE_ID);
  const inputResult = requireSuccessfulResult(results, CURRENT_INPUT_ID);
  assertSameSource([baseResult, quoteResult, pmmResult, feeResult, inputResult]);
  const onchainBase = decodeAddressResult(
    results,
    CURRENT_BASE_TOKEN_ID,
    "_BASE_TOKEN_",
  );
  const onchainQuote = decodeAddressResult(
    results,
    CURRENT_QUOTE_TOKEN_ID,
    "_QUOTE_TOKEN_",
  );
  if (
    !sameAddress(onchainBase, descriptor.baseToken) ||
    !sameAddress(onchainQuote, descriptor.quoteToken)
  ) {
    throw new Error(`dodo-v2 pool ${descriptor.pool} token identity changed`);
  }
  const fees = decodeFeeRates(feeResult.data);
  const input = decodeInputSemanticsResult({
    result: inputResult,
    pool: descriptor.pool,
    baseToken: descriptor.baseToken,
    quoteToken: descriptor.quoteToken,
  });
  return Object.freeze({
    source: pmmResult.source,
    pmm: decodeDodoPmmState(pmmResult.data),
    ...fees,
    ...input,
  });
}

function decodeSnapshot(
  descriptor: DodoV2PricingDescriptor,
  results: readonly AdapterRequestResult[],
): DodoV2PricingSnapshot {
  const core = decodeCurrentCore(descriptor, results);
  const quotes: Record<string, {
    readonly amountIn: bigint;
    readonly amountOut: bigint;
  }> = {};
  const unavailable: Record<string, string> = {};
  for (const route of descriptor.routes) {
    const selection = currentSelection(descriptor, core, route);
    if (typeof selection !== "bigint") {
      if (selection.kind === "provably-unavailable") {
        unavailable[route.routeKey] = selection.reason;
        continue;
      }
      const result = requireSuccessfulResult(
        results,
        boundedProbeRequestId(route),
      );
      const quote = decodeBoundedProbeResult({
        data: result.data,
        pool: descriptor.pool,
        sellBase: route.direction === "sell-base",
        plan: selection,
        quoteActor: descriptor.quoteActorBinding.actor,
      });
      if (quote === null) {
        throw new Error(
          `dodo-v2 current bounded probe found no positive quote for ` +
            `${route.tokenIn}->${route.tokenOut}: ${selection.reason}`,
        );
      }
      quotes[route.routeKey] = Object.freeze({
        amountIn: quote.transferAmount,
        amountOut: quote.amountOut,
      });
      continue;
    }
    const sellBase = route.direction === "sell-base";
    const position = sellBase ? core.baseInput : core.quoteInput;
    const effectiveInput = applyDodoTransferToInput(
      position,
      selection,
      descriptor.pool,
    );
    const local = quoteDodoPmmExactInput({
      state: core.pmm,
      sellBase,
      payAmount: effectiveInput,
      lpFeeRate: core.lpFeeRate,
      mtFeeRate: core.mtFeeRate,
    });
    if (local.status !== "quote" || local.amountOut <= 0n) {
      throw new Error(
        `dodo-v2 local selection contract changed for ` +
          `${route.tokenIn}->${route.tokenOut}`,
      );
    }
    quotes[route.routeKey] = Object.freeze({
      amountIn: selection,
      amountOut: local.amountOut,
    });
  }
  return Object.freeze({
    ...core,
    quotes: Object.freeze(quotes),
    unavailable: Object.freeze(unavailable),
  });
}

function currentSelection(
  descriptor: DodoV2PricingDescriptor,
  core: DodoV2CurrentCore,
  route: DodoV2PricingRouteBinding,
) {
  const sellBase = route.direction === "sell-base";
  const input = sellBase ? core.baseInput : core.quoteInput;
  return selectDodoProbeInput({
    oneToken: sellBase ? descriptor.baseOneToken : descriptor.quoteOneToken,
    currentInput: input.surplus,
    inputDeficit: input.deficit,
    reserve: sellBase ? core.pmm.B : core.pmm.Q,
    pmm: core.pmm,
    sellBase,
    pool: descriptor.pool,
    lpFeeRate: core.lpFeeRate,
    mtFeeRate: core.mtFeeRate,
  });
}

function boundedProbeRequest(
  descriptor: DodoV2PricingDescriptor,
  route: DodoV2PricingRouteBinding,
  plan: DodoBoundedProbePlan,
): AdapterRequest {
  return Object.freeze({
    id: boundedProbeRequestId(route),
    kind: "eth-call" as const,
    to: BLOCKSCAN_MULTICALL3,
    caller: Object.freeze({
      kind: "verified-actor" as const,
      evidenceId: DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
    }),
    data: buildBoundedProbeCall({
      pool: descriptor.pool,
      sellBase: route.direction === "sell-base",
      plan,
      quoteActor: descriptor.quoteActorBinding.actor,
    }),
    completion: "return-data" as const,
  });
}

function boundedProbeRequestId(route: DodoV2PricingRouteBinding): string {
  return `${BOUNDED_PROBE_PREFIX}${hashCanonical({ routeKey: route.routeKey })}`;
}

function pricingRouteBinding(route: DodoV2Route): DodoV2PricingRouteBinding {
  return Object.freeze({
    routeKey: route.routeKey,
    direction: route.direction,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
  });
}

function assertRoutesMatchDescriptor(
  descriptor: DodoV2Descriptor,
  routes: readonly DodoV2Route[],
): void {
  for (const route of routes) {
    if (
      route.instanceKey !== descriptor.instanceKey ||
      !sameAddress(route.pool, descriptor.pool)
    ) {
      throw new Error(`dodo-v2 route does not belong to ${descriptor.pool}`);
    }
    assertDirection(route, descriptor.baseToken, descriptor.quoteToken);
  }
}

function assertRoutesMatchPricingDescriptor(
  descriptor: DodoV2PricingDescriptor,
  routes: readonly DodoV2Route[],
): void {
  for (const route of routes) {
    if (
      route.instanceKey !== descriptor.instanceKey ||
      !sameAddress(route.pool, descriptor.pool)
    ) {
      throw new Error(`dodo-v2 route binding does not match ${descriptor.pool}`);
    }
    assertDirection(route, descriptor.baseToken, descriptor.quoteToken);
  }
}

function assertDirection(
  route: Pick<DodoV2Route, "direction" | "tokenIn" | "tokenOut">,
  baseToken: string,
  quoteToken: string,
): void {
  const expectedIn = route.direction === "sell-base" ? baseToken : quoteToken;
  const expectedOut = route.direction === "sell-base" ? quoteToken : baseToken;
  if (
    !sameAddress(route.tokenIn, expectedIn) ||
    !sameAddress(route.tokenOut, expectedOut)
  ) {
    throw new Error("dodo-v2 route direction does not match base/quote binding");
  }
}

function routeEdge(
  descriptor: DodoV2PricingDescriptor,
  route: DodoV2Route,
): TokenEdge {
  return Object.freeze({
    adapterId: "dodo-v2-swap",
    instanceKey: route.instanceKey,
    target: descriptor.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: "swap" as const,
    poolToken0: descriptor.baseToken,
    poolToken1: descriptor.quoteToken,
    ...deriveEdgeTaxonomy("swap"),
  });
}
