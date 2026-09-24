import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import {
  callRequest,
  lowerAddress,
  protocolMid,
  assertSameSource,
  returnedResult,
  sameAddress,
  type ProtocolPricingSnapshot,
} from "../standard-family/common.js";
import {
  assertPsmInvocation,
  psmStaticBindingProjection,
} from "./binding.js";
import {
  PSM_CURRENT_SAMPLE,
  PSM_INTERFACE,
  psmSellQuote,
  psmBuyQuote,
  PSM_WAD,
} from "./codec.js";
import type {
  PsmDescriptor,
  PsmPricingDescriptor,
  PsmRoute,
} from "./types.js";
type Snapshot = ProtocolPricingSnapshot & { readonly unavailable: Readonly<Record<string, string>> };

export const psmPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    psmStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    target: lowerAddress(descriptor.target),
    pair: [lowerAddress(descriptor.gem), lowerAddress(descriptor.dai)],
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length < 1 || routes.length > 2 ||
      new Set(routes.map(route => route.direction)).size !== routes.length) {
      throw new Error("PSM pricing requires distinct verified directions");
    }
    for (const route of routes) assertPsmInvocation(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      target: descriptor.target,
      routes: Object.freeze([...routes]),
      decimalScale: descriptor.decimalScale,
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze(descriptor.routes.map(route =>
      callRequest(
        `current-${route.direction}`,
        descriptor.target,
        PSM_INTERFACE.encodeFunctionData(route.direction === "sell-gem" ? "tin" : "tout"),
      ),
    )),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      const source = assertSameSource(results.map(result => returnedResult(results, result.id)));
      const unavailable: Record<string, string> = {};
      const quotes: Record<string, { amountIn: bigint; amountOut: bigint }> = {};
      for (const route of descriptor.routes) {
        const sell = route.direction === "sell-gem";
        const amountIn = PSM_CURRENT_SAMPLE * (sell ? 1n : descriptor.decimalScale);
        const data = returnedResult(results, `current-${route.direction}`).data;
        const fee = BigInt(PSM_INTERFACE.decodeFunctionResult(sell ? "tin" : "tout", data)[0]);
        if (fee > PSM_WAD) { unavailable[route.routeKey] = "psm direction fee disabled or outside supported range"; continue; }
        const amountOut = (sell ? psmSellQuote : psmBuyQuote)(amountIn, fee, descriptor.decimalScale);
        if (amountOut === 0n) { unavailable[route.routeKey] = "psm zero output"; continue; }
        quotes[route.routeKey] = { amountIn, amountOut };
      }
      return { source, quotes, unavailable };
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== descriptor.routes.length ||
        routes.some((route, index) => route.routeKey !== descriptor.routes[index].routeKey)
      ) {
        throw new Error(
          "PSM current route differs from its pricing descriptor",
        );
      }
      return new Map(descriptor.routes.flatMap(route => {
      const quote = snapshot.quotes[route.routeKey];
      if (quote === undefined) {
        if (snapshot.unavailable[route.routeKey]) return [];
        throw new Error("PSM current quote missing");
      }
      return [[route.routeKey, protocolMid({
        route,
        adapterId: "psm",
        target: descriptor.target,
        quote,
      })] as const]; }));
    },
    classifyUnavailable: ({ snapshot, routes }) => new Map(routes.filter(route => snapshot.unavailable[route.routeKey] !== undefined)
      .map(route => [route.routeKey, snapshot.unavailable[route.routeKey]])),
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.target,
    ...new Set(descriptor.routes.flatMap(route => [route.tokenIn, route.tokenOut])),
  ]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor, routes }) => ({
      addresses: [descriptor.target], keys: [descriptor.instanceKey],
    }), { kinds: ["call"] }),
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "call" &&
        sameAddress(observation.target, descriptor.target)
        ? [descriptor.instanceKey]
        : [],
  },
} satisfies PricingSemantics<
  PsmDescriptor,
  PsmRoute,
  PsmPricingDescriptor,
  Snapshot
>;
