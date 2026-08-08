import type { TokenEdge } from "../../../planner/token-graph.js";
import type { PricingSemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import {
  assertAstraRouteBinding,
  astraBindingFingerprint,
  astraStaticBindingProjection,
} from "./binding.js";
import {
  ASTRA_ERC20_INTERFACE,
  ASTRA_MULTITOKEN_CHANGE_TOPIC,
  ASTRA_MULTITOKEN_INTERFACE,
  assertSameSource,
  canonicalAddress,
  decodeUint,
  returnedResult,
  sameAddress,
} from "./codec.js";
import type {
  AstraMultiTokenDescriptor,
  AstraMultiTokenPricingDescriptor,
  AstraMultiTokenPricingDraft,
  AstraMultiTokenPricingSnapshot,
  AstraMultiTokenPricingStaticEvidence,
  AstraMultiTokenRoute,
} from "./types.js";

const STATIC_DECIMALS_ID = "static-token-in-decimals";
const CURRENT_RETURN_ID = "current-get-return";

export const astraMultiTokenPricing = {
  stateKey: (route) => route.routeKey,
  staticBindingProjection: ({ descriptor, routes }) => ({
    instance: astraStaticBindingProjection(descriptor),
    route: singleRouteProjection(descriptor, routes),
  }),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
    target: descriptor.target,
    route: singleRouteProjection(descriptor, routes),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    const route = requireSingleRoute(descriptor, routes);
    if (stateKey !== route.routeKey) {
      throw new Error(
        `astra-multitoken pricing stateKey does not match ${route.routeKey}`,
      );
    }
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      registryFingerprint: astraBindingFingerprint(descriptor),
      route: Object.freeze({
        routeKey: route.routeKey,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        target: route.target,
      }),
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: AstraMultiTokenPricingDraft) =>
        Object.freeze([draft.route.tokenIn]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: AstraMultiTokenPricingDraft) => Object.freeze([
      Object.freeze({
        id: STATIC_DECIMALS_ID,
        kind: "eth-call" as const,
        to: draft.route.tokenIn,
        data: ASTRA_ERC20_INTERFACE.encodeFunctionData("decimals"),
        completion: "return-data" as const,
      }),
    ]),
    decode({ results }: {
      readonly programInput: AstraMultiTokenPricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): AstraMultiTokenPricingStaticEvidence {
      const result = returnedResult(results, STATIC_DECIMALS_ID);
      assertSameSource([result]);
      const decimals = Number(
        ASTRA_ERC20_INTERFACE.decodeFunctionResult("decimals", result.data)[0],
      );
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error(`astra-multitoken token decimals ${decimals} are invalid`);
      }
      return Object.freeze({ oneToken: 10n ** BigInt(decimals) });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined || staticEvidence.oneToken <= 0n) {
      throw new Error(
        `astra-multitoken pricing ${draft.route.routeKey} lacks decimals evidence`,
      );
    }
    return Object.freeze({
      ...draft,
      route: Object.freeze({ ...draft.route }),
      oneToken: staticEvidence.oneToken,
    });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests({ descriptor, routes }) {
      assertPricingRoutes(descriptor, routes);
      return Object.freeze([getReturnRequest(
        CURRENT_RETURN_ID,
        descriptor.target,
        descriptor.route.tokenIn,
        descriptor.route.tokenOut,
        descriptor.oneToken,
      )]);
    },
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      const result = returnedResult(results, CURRENT_RETURN_ID);
      assertSameSource([result]);
      const amountOut = decodeUint(results, CURRENT_RETURN_ID, "getReturn");
      if (amountOut <= 0n) {
        throw new Error(
          `astra-multitoken current quote ${descriptor.route.routeKey} returned ${amountOut}`,
        );
      }
      return Object.freeze({
        source: result.source,
        amountIn: descriptor.oneToken,
        amountOut,
      });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      assertPricingRoutes(descriptor, routes);
      if (snapshot.amountIn !== descriptor.oneToken || snapshot.amountOut <= 0n) {
        throw new Error("astra-multitoken pricing snapshot is incompatible");
      }
      const route = routes[0];
      return new Map([[route.routeKey, protocolMid(route, snapshot)]]);
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.target,
    descriptor.route.tokenIn,
    descriptor.route.tokenOut,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      return isTargetChange(observation, descriptor.target)
        ? [descriptor.route.routeKey]
        : [];
    },
  },
  liveStateProjection: {
    project: ({ descriptor, snapshot }) => ({
      kind: "astra-multitoken-get-return-live",
      target: descriptor.target,
      tokenIn: descriptor.route.tokenIn,
      tokenOut: descriptor.route.tokenOut,
      amountIn: snapshot.amountIn,
      amountOut: snapshot.amountOut,
      blockNumber: snapshot.source.number,
    }),
  },
} satisfies PricingSemantics<
  AstraMultiTokenDescriptor,
  AstraMultiTokenRoute,
  AstraMultiTokenPricingDescriptor,
  AstraMultiTokenPricingSnapshot,
  AstraMultiTokenPricingDraft,
  AstraMultiTokenPricingStaticEvidence
>;

function getReturnRequest(
  id: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: target,
    data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData("getReturn", [
      tokenIn,
      tokenOut,
      amountIn,
    ]),
    completion: "return-data" as const,
  });
}

function requireSingleRoute(
  descriptor: AstraMultiTokenDescriptor,
  routes: readonly AstraMultiTokenRoute[],
): AstraMultiTokenRoute {
  if (routes.length !== 1) {
    throw new Error(
      `astra-multitoken pricing requires one route, received ${routes.length}`,
    );
  }
  const route = routes[0];
  assertAstraRouteBinding(descriptor, route);
  return route;
}

function singleRouteProjection(
  descriptor: AstraMultiTokenDescriptor,
  routes: readonly AstraMultiTokenRoute[],
) {
  const route = requireSingleRoute(descriptor, routes);
  return {
    routeKey: route.routeKey,
    target: route.target,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
  };
}

function assertPricingRoutes(
  descriptor: AstraMultiTokenPricingDescriptor,
  routes: readonly AstraMultiTokenRoute[],
): void {
  if (routes.length !== 1) {
    throw new Error("astra-multitoken pricing descriptor is per-route");
  }
  const route = routes[0];
  if (
    route.instanceKey !== descriptor.instanceKey ||
    route.routeKey !== descriptor.route.routeKey ||
    !sameAddress(route.target, descriptor.target) ||
    !sameAddress(route.tokenIn, descriptor.route.tokenIn) ||
    !sameAddress(route.tokenOut, descriptor.route.tokenOut)
  ) {
    throw new Error("astra-multitoken current route does not match descriptor");
  }
}

function protocolMid(
  route: AstraMultiTokenRoute,
  snapshot: AstraMultiTokenPricingSnapshot,
): RouteVenueMid {
  const mid = Number(snapshot.amountOut) / Number(snapshot.amountIn);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`astra-multitoken produced invalid mid ${mid}`);
  }
  const reserveA = snapshot.amountIn * 10_000n;
  const reserveB = snapshot.amountOut * 10_000n;
  const depthProxy = Number(reserveA < reserveB ? reserveA : reserveB);
  if (!Number.isFinite(depthProxy) || depthProxy <= 0) {
    throw new Error("astra-multitoken produced invalid depth proxy");
  }
  const edge: TokenEdge = Object.freeze({
    adapterId: "astra-multitoken-change",
    instanceKey: route.instanceKey,
    target: canonicalAddress(route.target),
    tokenIn: canonicalAddress(route.tokenIn),
    tokenOut: canonicalAddress(route.tokenOut),
    slotKind: "protocol" as const,
    protocolAction: "convert" as const,
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    kind: "protocol" as const,
    pool: route.target,
    edges: Object.freeze([edge]) as unknown as TokenEdge[],
    mid,
    feeBps: 0,
    reserveA,
    reserveB,
    depthProxy,
  });
}

function isTargetChange(
  observation: UnifiedObservation,
  target: string,
): boolean {
  return observation.kind === "log" &&
    sameAddress(observation.address, target) &&
    observation.topics[0]?.toLowerCase() === ASTRA_MULTITOKEN_CHANGE_TOPIC;
}
