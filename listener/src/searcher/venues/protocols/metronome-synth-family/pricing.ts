import { ADDR } from "../../../../shared/constants/addresses.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  assertSameSource,
  callRequest,
  decodeDecimals,
  protocolMid,
  returnedResult,
  sameAddress,
} from "../standard-family/common.js";
import {
  METRONOME_SYNTH_ERC20_INTERFACE,
  METRONOME_SYNTH_POOL_INTERFACE,
  assertMetronomeSynthInvocation,
  metronomeSynthCurrentRequestId,
  metronomeSynthStaticProjection,
  metronomeSynthUniqueAddresses,
} from "./shared.js";
import type {
  MetronomeSynthDescriptor,
  MetronomeSynthPricingDescriptor,
  MetronomeSynthPricingDraft,
  MetronomeSynthPricingSnapshot,
  MetronomeSynthPricingStaticEvidence,
  MetronomeSynthRoute,
} from "./types.js";

export const metronomeSynthPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    metronomeSynthStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
    pool: descriptor.pool,
    oracleBinding: descriptor.oracleBinding,
    directions: routes.map((route) => [route.tokenIn, route.tokenOut]).sort(),
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length === 0) {
      throw new Error("Metronome synth pricing requires active routes");
    }
    for (const route of routes) {
      assertMetronomeSynthInvocation(descriptor, route);
    }
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      pool: descriptor.pool,
      tokens: descriptor.tokens,
      routes: Object.freeze([...routes]),
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: MetronomeSynthPricingDraft) => Object.freeze([
        ...metronomeSynthUniqueAddresses([
          draft.pool,
          ...draft.routes.map((route) => route.tokenIn),
        ]),
      ]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: MetronomeSynthPricingDraft) => Object.freeze(
      metronomeSynthUniqueAddresses(
        draft.routes.map((route) => route.tokenIn),
      ).map((token) => callRequest(
        `static-decimals:${token.toLowerCase()}`,
        token,
        METRONOME_SYNTH_ERC20_INTERFACE.encodeFunctionData("decimals"),
      )),
    ),
    decode({ programInput, results }: {
      readonly programInput: MetronomeSynthPricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): MetronomeSynthPricingStaticEvidence {
      return Object.freeze({
        oneTokens: Object.freeze(
          metronomeSynthUniqueAddresses(
            programInput.routes.map((route) => route.tokenIn),
          ).map((token) => Object.freeze({
            token,
            amount: decodeDecimals(
              METRONOME_SYNTH_ERC20_INTERFACE,
              results,
              `static-decimals:${token.toLowerCase()}`,
            ),
          })),
        ),
      });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("Metronome synth pricing lacks decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze(
      descriptor.routes.map((route) => callRequest(
        metronomeSynthCurrentRequestId(route),
        descriptor.pool,
        METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionData("quoteSwapOut", [
          route.tokenIn,
          route.tokenOut,
          oneToken(descriptor, route.tokenIn),
        ]),
      )),
    ),
    decodeSnapshot({ descriptor, initialResults }) {
      const results = initialResults;
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(
            `Metronome synth current quote unresolved: ${result.failure}`,
          );
        }
        return result;
      });
      const source = assertSameSource(successful);
      const quotes: Record<
        string,
        { readonly amountIn: bigint; readonly amountOut: bigint }
      > = {};
      for (const route of descriptor.routes) {
        const result = returnedResult(
          results,
          metronomeSynthCurrentRequestId(route),
        );
        const decoded = METRONOME_SYNTH_POOL_INTERFACE.decodeFunctionResult(
          "quoteSwapOut",
          result.data,
        );
        quotes[route.routeKey] = Object.freeze({
          amountIn: oneToken(descriptor, route.tokenIn),
          amountOut: BigInt(decoded[0]),
        });
      }
      return Object.freeze({ source, quotes });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        MetronomeSynthRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (quote === undefined || quote.amountOut <= 0n) continue;
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.pool,
          quote,
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      return new Map(routes.flatMap((route) =>
        snapshot.quotes[route.routeKey]?.amountOut === 0n
          ? [[route.routeKey, "metronome_quote_zero"] as const]
          : []
      ));
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.pool,
    ...descriptor.tokens,
    ADDR.METRONOME_ORACLE_FORWARDER,
    ADDR.METRONOME_ORACLE,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      if (
        observation.kind === "log" &&
        sameAddress(observation.address, descriptor.pool)
      ) return [descriptor.instanceKey];
      if (
        observation.kind === "call" &&
        sameAddress(observation.target, ADDR.METRONOME_ORACLE_FORWARDER)
      ) return [descriptor.instanceKey];
      return [];
    },
  },
} satisfies PricingSemantics<
  MetronomeSynthDescriptor,
  MetronomeSynthRoute,
  MetronomeSynthPricingDescriptor,
  MetronomeSynthPricingSnapshot,
  MetronomeSynthPricingDraft,
  MetronomeSynthPricingStaticEvidence
>;

function oneToken(
  descriptor: MetronomeSynthPricingDescriptor,
  token: string,
): bigint {
  const item = descriptor.oneTokens.find((candidate) =>
    sameAddress(candidate.token, token)
  );
  if (item === undefined) {
    throw new Error(`Metronome synth pricing lacks decimals for ${token}`);
  }
  return item.amount;
}
