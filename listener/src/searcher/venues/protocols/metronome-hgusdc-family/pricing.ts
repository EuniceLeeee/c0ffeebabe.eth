import {
  bindRequestResultRound,
  collectRequestProgramResults,
  type PricingSemantics,
} from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  assertSameSource,
  callRequest,
  decodeDecimals,
  decodeUint,
  lowerAddress,
  protocolMid,
  returnedResult,
  sameAddress,
} from "../standard-family/common.js";
import {
  METRONOME_HGUSDC_CURVE_INTERFACE,
  METRONOME_HGUSDC_ERC20_INTERFACE,
  METRONOME_HGUSDC_VAULT_INTERFACE,
  assertMetronomeHgUsdcInvocation,
  metronomeHgUsdcStaticProjection,
} from "./shared.js";
import type {
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcPricingDescriptor,
  MetronomeHgUsdcPricingDraft,
  MetronomeHgUsdcPricingSnapshot,
  MetronomeHgUsdcRoute,
} from "./types.js";

export interface MetronomeHgUsdcPricingStaticEvidence {
  readonly oneTokenIn: bigint;
}

export const metronomeHgUsdcPricing = {
  stateKey: (route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }) =>
    metronomeHgUsdcStaticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => ({
    curve: lowerAddress(descriptor.curve),
    vault: lowerAddress(descriptor.vault),
    tokenIn: lowerAddress(descriptor.tokenIn),
    tokenOut: lowerAddress(descriptor.tokenOut),
    curveDirection: [1, 0],
  }),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 1) {
      throw new Error("Metronome hgUSDC pricing requires one bound route");
    }
    const route = routes[0];
    assertMetronomeHgUsdcInvocation(descriptor, route);
    return Object.freeze({
      instanceKey: descriptor.instanceKey,
      router: descriptor.router,
      curve: descriptor.curve,
      vault: descriptor.vault,
      tokenIn: descriptor.tokenIn,
      curveIntermediate: descriptor.curveIntermediate,
      tokenOut: descriptor.tokenOut,
      route,
    });
  },
  staticEvidence: {
    reusePolicy: {
      kind: "dependency-proof" as const,
      dependencyKeys: (draft: MetronomeHgUsdcPricingDraft) =>
        Object.freeze([draft.tokenIn]),
    },
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: (draft: MetronomeHgUsdcPricingDraft) => Object.freeze([
      callRequest(
        "static-token-in-decimals",
        draft.tokenIn,
        METRONOME_HGUSDC_ERC20_INTERFACE.encodeFunctionData("decimals"),
      ),
    ]),
    decode({ results }: {
      readonly programInput: MetronomeHgUsdcPricingDraft;
      readonly results: readonly AdapterRequestResult[];
    }): MetronomeHgUsdcPricingStaticEvidence {
      return Object.freeze({
        oneTokenIn: decodeDecimals(
          METRONOME_HGUSDC_ERC20_INTERFACE,
          results,
          "static-token-in-decimals",
        ),
      });
    },
  },
  finalizePricingDescriptor({ draft, staticEvidence }) {
    if (staticEvidence === undefined) {
      throw new Error("Metronome hgUSDC pricing lacks decimals evidence");
    }
    return Object.freeze({ ...draft, ...staticEvidence });
  },
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }) => Object.freeze([callRequest(
      "current-curve-quote",
      descriptor.curve,
      METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionData(
        "get_dy",
        [1n, 0n, descriptor.oneTokenIn],
      ),
    )]),
    buildDependentProgram({
      current,
      completedRound,
      initialResults,
      priorEvidence,
    }) {
      if (completedRound !== 0) return null;
      const priorResults = collectRequestProgramResults(
        initialResults,
        priorEvidence,
      );
      const curveOut = decodeUint(
        METRONOME_HGUSDC_CURVE_INTERFACE,
        "get_dy",
        priorResults,
        "current-curve-quote",
      );
      return bindRequestResultRound(
        { transports: ["eth-call"] },
        Object.freeze([callRequest(
          "current-vault-preview",
          current.descriptor.vault,
          METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionData(
            "previewRedeem",
            [curveOut],
          ),
        )]),
      );
    },
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      const results = collectRequestProgramResults(
        initialResults,
        dependentEvidence,
      );
      const curve = returnedResult(results, "current-curve-quote");
      const vault = returnedResult(results, "current-vault-preview");
      const source = assertSameSource([curve, vault]);
      const curveOut = BigInt(
        METRONOME_HGUSDC_CURVE_INTERFACE.decodeFunctionResult(
          "get_dy",
          curve.data,
        )[0],
      );
      const amountOut = BigInt(
        METRONOME_HGUSDC_VAULT_INTERFACE.decodeFunctionResult(
          "previewRedeem",
          vault.data,
        )[0],
      );
      return Object.freeze({
        source,
        curveOut,
        quotes: Object.freeze({
          [descriptor.route.routeKey]: Object.freeze({
          amountIn: descriptor.oneTokenIn,
          amountOut,
          }),
        }),
      });
    },
    deriveMids({ descriptor, snapshot, routes }) {
      const mids = new Map<
        MetronomeHgUsdcRoute["routeKey"],
        ReturnType<typeof protocolMid>
      >();
      for (const route of routes) {
        const quote = snapshot.quotes[route.routeKey];
        if (
          snapshot.curveOut <= 0n ||
          quote === undefined ||
          quote.amountOut <= 0n
        ) continue;
        mids.set(route.routeKey, protocolMid({
          route,
          adapterId: route.adapterId,
          target: descriptor.router,
          quote,
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      const quote = Object.values(snapshot.quotes)[0];
      return snapshot.curveOut === 0n || quote?.amountOut === 0n
        ? new Map(routes.map((route) => [
            route.routeKey,
            "metronome_hgusdc_quote_chain_zero",
          ] as const))
        : new Map();
    },
  },
  dependencies: ({ descriptor }) => Object.freeze([
    descriptor.router,
    descriptor.curve,
    descriptor.vault,
    descriptor.tokenIn,
    descriptor.curveIntermediate,
    descriptor.tokenOut,
  ]),
  mutation: {
    affectedStateKeys({ descriptor, observation }) {
      return observation.kind === "log" && [
          descriptor.router,
          descriptor.curve,
          descriptor.vault,
          descriptor.tokenIn,
          descriptor.curveIntermediate,
          descriptor.tokenOut,
        ].some((address) => sameAddress(observation.address, address))
        ? [descriptor.instanceKey]
        : [];
    },
  },
} satisfies PricingSemantics<
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute,
  MetronomeHgUsdcPricingDescriptor,
  MetronomeHgUsdcPricingSnapshot,
  MetronomeHgUsdcPricingDraft,
  MetronomeHgUsdcPricingStaticEvidence
>;
