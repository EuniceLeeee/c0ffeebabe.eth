import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { same } from "./codec.js";
import { staticBinding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { decodeState, quoteAmount, stateRequests } from "./state.js";
import type { Descriptor, PricingDescriptor, Route, State } from "./types.js";
const dependencies = (d: Descriptor) => [d.pool, d.token];
export const pricing = {
  stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => staticBinding(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => staticBinding(descriptor),
  compileDraft({ descriptor, routes }) { routes.forEach(r => assertRoute(descriptor, r)); return { instance: descriptor }; },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({ ...draft }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => stateRequests(descriptor.instance),
    decodeSnapshot({ initialResults, dependentEvidence }) {
      if (dependentEvidence.length) throw new Error("univ1 unexpected state rounds");
      return decodeState(initialResults);
    },
    deriveMids({ descriptor, routes, snapshot }) {
      const mids = new Map<Route["routeKey"], ReturnType<typeof quotedPoolMid>>();
      for (const r of routes) {
        assertRoute(descriptor.instance, r);
        const depthIn = r.buy ? snapshot.nativeReserve : snapshot.tokenReserve;
        const depthOut = r.buy ? snapshot.tokenReserve : snapshot.nativeReserve;
        // Raw sampling only. Effective and Solver retain their requested input.
        const amountIn = depthIn / 100_000n;
        if (amountIn <= 1n || depthOut === 0n) continue;
        const amountOut = quoteAmount(snapshot, r.buy, amountIn);
        if (amountOut === 0n) continue;
        mids.set(r.routeKey, quotedPoolMid({ kind: "external-swap", amountIn, amountOut, depthIn, depthOut,
          edge: { adapterId: ACTION, instanceKey: r.instanceKey, target: r.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut,
            slotKind: "swap", ...deriveEdgeTaxonomy("swap") } }));
      }
      return mids;
    },
  },
  dependencies: ({ descriptor }) => dependencies(descriptor.instance),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({ addresses: dependencies(descriptor.instance),
      keys: [descriptor.instance.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, observation }) {
      const target = observation.kind === "call" ? observation.target : observation.kind === "log" ? observation.address : null;
      return target && dependencies(descriptor.instance).some(a => same(a, target)) ? [descriptor.instance.instanceKey] : [];
    },
  },
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
} satisfies PricingSemantics<Descriptor, Route, PricingDescriptor, State>;
