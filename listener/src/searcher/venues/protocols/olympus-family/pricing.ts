import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import {
  assertSameSource,
  callRequest,
  lowerAddress,
  protocolMid,
  returnedResult,
  sameAddress,
} from "../standard-family/common.js";
import {
  assertOlympusInvocation,
  olympusStaticBindingProjection,
} from "./binding.js";
import {
  OLYMPUS_INTERFACE,
  OLYMPUS_SAMPLE,
  olympusQuote,
} from "./codec.js";
import type {
  OlympusDescriptor,
  OlympusPricingDescriptor,
  OlympusPricingSnapshot,
  OlympusRoute,
} from "./types.js";

export const olympusPricing = {
  stateKey: (route: OlympusRoute) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    olympusStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    staking: lowerAddress(descriptor.staking),
    gOHM: lowerAddress(descriptor.gOHM),
    OHM: lowerAddress(descriptor.OHM),
    semantics: "olympus-staking-index-unstake-v1",
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("Olympus pricing requires exactly one verified route");
    }
    assertOlympusInvocation(descriptor, routes[0]);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      staking: descriptor.staking,
      gOHM: descriptor.gOHM,
      OHM: descriptor.OHM,
      route: routes[0],
    });
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([
      callRequest(
        "current-index",
        descriptor.staking,
        OLYMPUS_INTERFACE.encodeFunctionData("index"),
      ),
    ]),
    decodeSnapshot({ descriptor, initialResults }): OlympusPricingSnapshot {
      const result = returnedResult(initialResults, "current-index");
      const source = assertSameSource([result]);
      const index = BigInt(
        OLYMPUS_INTERFACE.decodeFunctionResult("index", result.data)[0],
      );
      const amountOut = olympusQuote(OLYMPUS_SAMPLE, index);
      return Object.freeze({
        source,
        index,
        quotes: Object.freeze({
          [descriptor.route.routeKey]: Object.freeze({
            amountIn: OLYMPUS_SAMPLE,
            amountOut,
          }),
        }),
      });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (
        routes.length !== 1 ||
        routes[0].routeKey !== descriptor.route.routeKey
      ) {
        throw new Error(
          "Olympus current route differs from its pricing descriptor",
        );
      }
      const point = snapshot.quotes[descriptor.route.routeKey];
      if (point === undefined) throw new Error("Olympus current quote missing");
      return new Map([[descriptor.route.routeKey, protocolMid({
        route: descriptor.route,
        adapterId: "olympus-unstake",
        target: descriptor.staking,
        quote: point,
      })]]);
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([...new Set([
    descriptor.staking,
    descriptor.gOHM,
    descriptor.OHM,
  ])]),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({
      addresses: [descriptor.staking], keys: [descriptor.instanceKey],
    }), { kinds: ["call"] }),
    affectedStateKeys: ({ descriptor, observation }) =>
      observation.kind === "call" &&
        sameAddress(observation.target, descriptor.staking)
        ? [descriptor.instanceKey]
        : [],
  },
} satisfies PricingSemantics<
  OlympusDescriptor,
  OlympusRoute,
  OlympusPricingDescriptor,
  OlympusPricingSnapshot
>;
