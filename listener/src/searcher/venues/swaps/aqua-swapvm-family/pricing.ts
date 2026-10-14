import { bindRequestResultRound, collectRequestProgramResults, type PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { stateRequests, decodeState, quoteRequest, quoteOutput, profile } from "./codec.js";
import { binding } from "./instance.js";
import { assertRoute } from "./routes.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route, Snapshot, State } from "./types.js";
export function point(s: State, i: number): bigint {
  // A raw marginal sample only. Exact always quotes its own unchanged input.
  const unit = 10n ** s.decimals[i], byBalance = s.balances[i] / 10000n;
  const value = unit < byBalance ? unit : byBalance; return value > 0n ? value : 1n;
}
const dependencies = (d: Descriptor) => [d.router, d.aqua, d.order.maker, ...d.tokens];
export const pricing = {
  // Maker balance/approval and strategy docking can change without a swap.
  // Existing production scheduling owns these reads; no Family timer or RPC.
  refreshPolicy: "each-block",
  stateKey: r => r.instanceKey, staticBindingProjection: ({ descriptor: d }) => binding(d),
  snapshotCompatibilityProjection: ({ descriptor: d }) => binding(d),
  compileDraft({ descriptor: d, stateKey, routes }) {
    if (stateKey !== d.instanceKey || !routes.length || routes.length > 2) throw new Error("aqua pricing group");
    routes.forEach(r => assertRoute(d, r)); return d;
  }, finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["get-code", "eth-call"] }),
    buildRequests: ({ descriptor: d }) => stateRequests(d),
    buildDependentProgram({ current: i, completedRound, initialResults }) {
      if (completedRound !== 0) return null;
      const s = decodeState(i.descriptor, initialResults, i.source);
      const requests = s.active ? [0, 1].filter(j => s.capacities[1-j] > 0n)
        .map(j => ({ ...quoteRequest(i.descriptor, j, point(s, j), `point:${j}`), required: false, completion: "return-or-revert-data" as const })) : [];
      return bindRequestResultRound(requests.length ? { transports: ["eth-call"], caller: "executor" } : { transports: [] }, requests);
    },
    decodeSnapshot({ descriptor: d, initialResults, dependentEvidence }): Snapshot {
      if (dependentEvidence.length !== 1) throw new Error("aqua missing pricing round");
      const s = decodeState(d, initialResults), all = collectRequestProgramResults(initialResults, dependentEvidence);
      const points = [0, 1].map(i => {
        const amountIn = point(s, i); let reason: string | null = !s.active ? "aqua-strategy-inactive" : s.capacities[1-i] === 0n ? "aqua-maker-capacity-zero" : null;
        const r = all.find(r => r.id === `point:${i}`);
        if (!reason && (!r || !r.ok || r.completion !== "returned")) reason = "aqua-current-quote-unavailable";
        if (reason) return { amountIn, amountOut: 0n, reason };
        if (!r || !r.ok || r.source.number !== s.source.number || r.source.hash !== s.source.hash || r.source.generation !== s.source.generation)
          throw new Error("aqua pricing foreign source");
        return { amountIn, amountOut: quoteOutput(d, all, amountIn, s.capacities[1-i], `point:${i}`), reason: null };
      });
      return { ...s, points };
    },
    deriveMids({ descriptor: d, routes, snapshot: s }) {
      const mids = new Map<Route["routeKey"], ReturnType<typeof quotedPoolMid>>();
      for (const r of routes) {
        assertRoute(d, r); const p = s.points[r.i]; if (p.reason || s.balances[r.i] === 0n) continue;
        mids.set(r.routeKey, quotedPoolMid({ kind: "external-swap", amountIn: p.amountIn, amountOut: p.amountOut,
          depthIn: s.balances[r.i], depthOut: s.capacities[r.j], feeBps: profile(d.order)!.feeBps,
          edge: { adapterId: ACTION, instanceKey: d.instanceKey, target: d.router, tokenIn: r.tokenIn, tokenOut: r.tokenOut,
            slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false } }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor: d, snapshot: s, routes }) {
      const out = new Map<Route["routeKey"], string>();
      for (const r of routes) { assertRoute(d, r); const reason = s.points[r.i].reason;
        if (reason || s.balances[r.i] === 0n) out.set(r.routeKey, reason ?? "aqua-input-reserve-zero"); }
      return out;
    },
  }, dependencies: ({ descriptor: d }) => dependencies(d),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: dependencies(d), keys: [d.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor: d, observation: o }) {
      const a = o.kind === "log" ? o.address : o.kind === "call" ? o.target : null;
      return a && dependencies(d).includes(a.toLowerCase()) ? [d.instanceKey] : [];
    },
  }, liveStateProjection: { project: ({ snapshot: s }) => ({ ...s, source: { ...s.source }, balances: [...s.balances], capacities: [...s.capacities], decimals: [...s.decimals], points: s.points.map(p => ({ ...p })) }) },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, Snapshot>;
