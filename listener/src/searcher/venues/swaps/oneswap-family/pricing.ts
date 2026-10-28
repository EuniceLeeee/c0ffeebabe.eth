import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { lower } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { quoteAmount } from "./math.js";
import { assertRoute } from "./routes.js";
import { decodeState, stateRequests } from "./state.js";
import type { Descriptor, Route, State } from "./types.js";
const dependencies = (d: Descriptor) => [...new Set([d.pool, d.stock, d.money, d.factory, d.implementation, d.ones])];
export const pricing = {
  stateKey: r => r.instanceKey, staticBindingProjection: ({ descriptor }) => binding(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || !routes.length) throw new Error("oneswap invalid pricing group");
    routes.forEach(r => assertRoute(descriptor, r)); return descriptor;
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call", "get-code"] }), buildRequests: ({ descriptor }) => stateRequests(descriptor),
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      if (dependentEvidence.length) throw new Error("oneswap unexpected state rounds");
      return decodeState(descriptor, initialResults);
    },
    deriveMids({ descriptor: d, snapshot: s, routes }) {
      const mids = new Map<Route["routeKey"], ReturnType<typeof quotedPoolMid>>();
      for (const r of routes) {
        assertRoute(d, r);
        const depthIn = r.buy ? s.money : s.stock, depthOut = r.buy ? s.stock : s.money;
        const amountIn = depthIn / 100_000n;
        if (!amountIn || !depthOut) continue;
        const { amountOut } = quoteAmount(d, s, r.buy, amountIn);
        if (!amountOut) continue;
        mids.set(r.routeKey, quotedPoolMid({ kind: "external-swap", amountIn, amountOut, depthIn, depthOut, feeBps: Number(s.feeBps),
          edge: { adapterId: ACTION, instanceKey: r.instanceKey, target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut,
            slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false } }));
      }
      return mids;
    },
  },
  dependencies: ({ descriptor }) => dependencies(descriptor),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({ addresses: dependencies(descriptor), keys: [descriptor.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, observation }) {
      const target = observation.kind === "log" ? observation.address : observation.kind === "call" ? observation.target : null;
      return target && dependencies(descriptor).some(a => lower(a) === lower(target)) ? [descriptor.instanceKey] : [];
    },
  },
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source },
    sells: snapshot.sells.map(o => ({ ...o })), buys: snapshot.buys.map(o => ({ ...o })) }) },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, State>;
