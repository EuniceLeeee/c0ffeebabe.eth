import { collectRequestProgramResults, type PricingSemantics } from "../../adapter-family-plugin.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import { bigintRatio } from "../../swaps/blockscan-state-shared.js";
import { fluidCreditStaticBindingProjection } from "./instance.js";
import { assertFluidCreditRoute } from "./exact.js";
import { decodeFluidCurrentState, fluidConfigRequests, fluidRateProgram, type FluidCreditSnapshot } from "./state.js";
import type { FluidCreditDescriptor, FluidCreditRoute } from "./types.js";

export interface FluidCreditPricingDescriptor {
  readonly instance: FluidCreditDescriptor;
  readonly route: FluidCreditRoute;
}
export const fluidCreditPricing = {
  stateKey: route => route.instanceKey,
  staticBindingProjection: ({ descriptor }) => fluidCreditStaticBindingProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => fluidCreditStaticBindingProjection(descriptor),
  compileDraft({ descriptor, routes }) {
    if (routes.length !== 1) throw new Error("fluid-credit pricing requires one collateral/debt direction");
    assertFluidCreditRoute(descriptor, routes[0]);
    return { instance: descriptor, route: routes[0] };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze(draft),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => fluidConfigRequests(descriptor.instance.vault),
    buildDependentProgram({ current, completedRound, initialResults }) {
      return completedRound === 0 ? fluidRateProgram(current.descriptor.instance.vault, initialResults) : null;
    },
    decodeSnapshot: ({ initialResults, dependentEvidence }) =>
      decodeFluidCurrentState(collectRequestProgramResults(initialResults, dependentEvidence)),
    deriveMids({ descriptor, snapshot, routes }) {
      if (routes.length !== 1 || routes[0].routeKey !== descriptor.route.routeKey) throw new Error("fluid-credit pricing route mismatch");
      const route = routes[0];
      assertFluidCreditRoute(descriptor.instance, route);
      // Common price tables use raw token-unit ratios. Decimals are applied by
      // consumers for human display, not by this already raw-scaled oracle.
      const mid = bigintRatio(snapshot.oracleRate * snapshot.collateralFactorBps, 10n ** 27n * 10_000n);
      if (!Number.isFinite(mid) || mid <= 0) throw new Error("fluid-credit invalid mid");
      return new Map([[route.routeKey, { kind: "protocol" as const, pool: descriptor.instance.vault, mid,
        feeBps: Number(snapshot.borrowFeeBps), depthProxy: 0,
        edges: [{ adapterId: "fluid-vault", target: descriptor.instance.vault, instanceKey: route.instanceKey,
          tokenIn: route.tokenIn, tokenOut: route.tokenOut, slotKind: "lend" as const, ...deriveEdgeTaxonomy("lend") }] }]]);
    },
  },
  dependencies: ({ descriptor }) => [descriptor.instance.vault, descriptor.instance.supplyToken, descriptor.instance.borrowToken],
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
} satisfies PricingSemantics<FluidCreditDescriptor, FluidCreditRoute, FluidCreditPricingDescriptor, FluidCreditSnapshot>;
