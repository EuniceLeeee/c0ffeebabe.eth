import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { BONE, same } from "./codec.js";
import { staticBinding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { decodeState, spotPrice, stateRequests } from "./state.js";
import type { Descriptor, PricingDescriptor, Route, State } from "./types.js";
// Finalized BPool quotes use recorded balances, not ERC20 balanceOf. A token
// donation changes quotes only when gulp() touches the pool. No oracle/time
// dependency exists in this source-proven immutable weighted model.
const dependencies = (d: Descriptor) => [d.pool];
export const pricing = {
  stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => staticBinding(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => staticBinding(descriptor),
  compileDraft({ descriptor, routes }) { routes.forEach(r => assertRoute(descriptor, r)); return { instance: descriptor }; },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({ ...draft }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests: ({ descriptor }) => stateRequests(descriptor.instance),
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      if (dependentEvidence.length) throw new Error("balancer-v1 unexpected pricing rounds");
      return decodeState(descriptor.instance, initialResults);
    },
    deriveMids({ descriptor: { instance: d }, routes, snapshot: s }) {
      const mids = new Map<Route["routeKey"], { kind: "external-swap"; pool: string; edges: { adapterId: string; instanceKey: string; target: string; tokenIn: string; tokenOut: string; slotKind: "swap"; edgeKind: "swap"; leavesStandingPosition: false }[]; mid: number; feeBps: number; reserveA: bigint; reserveB: bigint; depthProxy: number }>();
      for (const r of routes) {
        assertRoute(d, r);
        const a = s.balances[r.i], b = s.balances[r.j];
        if (a <= 0n || b <= 0n) continue;
        // Mid is a raw marginal price including the pool fee. It is never
        // linearly scaled into an Exact quote for a specified input amount.
        const price = spotPrice(a, d.weights[r.i], b, d.weights[r.j], d.swapFee);
        const mid = Number(BONE) / Number(price);
        if (!Number.isFinite(mid) || mid <= 0) throw new Error("balancer-v1 invalid mid");
        mids.set(r.routeKey, { kind: "external-swap", pool: d.pool, mid, feeBps: 0, reserveA: a, reserveB: b,
          depthProxy: Number(a < b ? a : b), edges: [{ adapterId: ACTION, instanceKey: d.instanceKey, target: d.pool,
            tokenIn: r.tokenIn, tokenOut: r.tokenOut, slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false }] });
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
      return target && same(target, descriptor.instance.pool) ? [descriptor.instance.instanceKey] : [];
    },
  },
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, balances: [...snapshot.balances], source: { ...snapshot.source } }) },
} satisfies PricingSemantics<Descriptor, Route, PricingDescriptor, State>;
