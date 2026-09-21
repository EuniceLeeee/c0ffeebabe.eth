import { compileAddressMutations } from "../../mutation-index.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { UNIT, same } from "./codec.js";
import { staticBinding } from "./instance.js";
import { actionId, assertRoute } from "./routes.js";
import { decodeState, quoteAmount, stateRequests } from "./state.js";
import type { EllaDescriptor, EllaPricingDescriptor, EllaRoute, EllaState } from "./types.js";

function dependencies(d: EllaDescriptor) { return [d.pool, d.token, d.factory, d.oracle, d.aggregator]; }
export const ellaPricing = {
  stateKey: route => route.instanceKey,
  staticBindingProjection: ({ descriptor }) => staticBinding(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => staticBinding(descriptor),
  compileDraft({ descriptor, routes }) {
    routes.forEach(r => assertRoute(descriptor, r)); return { instance: descriptor };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({ ...draft }),
  current: {
    requirements: () => ({ transports: ["eth-call", "get-storage"] }),
    buildRequests: ({ descriptor }) => stateRequests(descriptor.instance),
    decodeSnapshot: ({ descriptor, initialResults }) => decodeState(descriptor.instance, initialResults),
    deriveMids({ descriptor, routes, snapshot: s }) {
      const mids = new Map<EllaRoute["routeKey"], ReturnType<typeof quotedPoolMid>>();
      for (const r of routes) {
        assertRoute(descriptor.instance, r);
        const outBalance = r.direction === "buy-token" ? s.tokenBalance : s.nativeBalance;
        // Small capacity-aware sample is only for raw mid. Effective's amount
        // is never replaced by this sample and goes through Exact unchanged.
        const capacity = r.direction === "buy-token" ? outBalance * s.price / UNIT : outBalance * UNIT / s.price;
        const amountIn = capacity / 100n;
        if (amountIn <= 0n) continue;
        const q = quoteAmount(s, r.direction, amountIn);
        if (q.amountOut <= 0n) continue;
        mids.set(r.routeKey, quotedPoolMid({ kind: "external-swap", amountIn, amountOut: q.amountOut,
          depthIn: capacity, depthOut: outBalance,
          edge: { adapterId: actionId(r.direction), instanceKey: r.instanceKey, target: r.pool,
            tokenIn: r.tokenIn, tokenOut: r.tokenOut, slotKind: "swap", ...deriveEdgeTaxonomy("swap") } }));
      }
      return mids;
    },
  },
  dependencies: ({ descriptor }) => dependencies(descriptor.instance),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({
      addresses: dependencies(descriptor.instance), keys: [descriptor.instance.instanceKey],
    }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, observation }) {
    const target = observation.kind === "call" ? observation.target : observation.kind === "log" ? observation.address : null;
    return target && dependencies(descriptor.instance).some(d => same(d, target)) ? [descriptor.instance.instanceKey] : [];
  } },
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
} satisfies PricingSemantics<EllaDescriptor, EllaRoute, EllaPricingDescriptor, EllaState>;
