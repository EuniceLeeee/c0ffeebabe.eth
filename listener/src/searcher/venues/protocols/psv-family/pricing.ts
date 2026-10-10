import type { PricingSemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid } from "../standard-family/common.js";
import { ABI, WAD } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { assertCapacity, decodeState, formula, requirements, stateRequests } from "./state.js";
import type { Descriptor, Route, State } from "./types.js";
export const dependencies = (d: Descriptor) => [d.target, d.implementation, d.gem, d.stable];
function affected(d: Descriptor, o: UnifiedObservation): readonly string[] {
  const target = o.kind === "log" ? o.address.toLowerCase() : o.kind === "call" ? o.target.toLowerCase() : null;
  if (!target || !dependencies(d).includes(target)) return [];
  if ([d.gem, d.stable].includes(target) && o.kind === "log" && o.topics[0]?.toLowerCase() === ABI.getEvent("Transfer")!.topicHash.toLowerCase()) {
    try { const e = ABI.decodeEventLog("Transfer", o.data, [...o.topics]);
      return [e.from, e.to].some(a => String(a).toLowerCase() === d.target) ? [d.instanceKey] : []; } catch { /* malformed remains conservative */ }
  }
  return [d.instanceKey];
}
function sample(d: Descriptor, s: State, r: Route) {
  if (s.paused) return undefined;
  const sell = r.direction === "sell-gem", inputScale = 10n ** BigInt(18 - (sell ? d.gemDecimals : d.stableDecimals));
  const reserveWad = (sell ? s.stableReserve : s.gemReserve) * 10n ** BigInt(18 - (sell ? d.stableDecimals : d.gemDecimals));
  const cap = [WAD, reserveWad, ...(s.maxPerTransaction ? [s.maxPerTransaction] : []), ...(s.maxPerBlock ? [s.remaining] : [])].reduce((a,b) => a < b ? a : b);
  const amountIn = cap / inputScale; if (!amountIn) return undefined;
  const q = formula(d, s, r.direction, amountIn); if (!q.amountOut) return undefined;
  assertCapacity(d, s, r.direction, amountIn, q.amountOut, q.fee); return { amountIn, amountOut: q.amountOut };
}
export const pricing = {
  // A block-limited vault regains capacity without a transaction. Each-head
  // refresh is deliberate until snapshot-dependent refresh is supported.
  refreshPolicy: "each-block", stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => binding(descriptor), snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor: d, stateKey, routes }) {
    if (stateKey !== d.instanceKey || !routes.length || routes.length > 2 || new Set(routes.map(r => r.direction)).size !== routes.length) throw new Error("PSV pricing route group");
    routes.forEach(r => assertRoute(d, r)); return d;
  }, finalizePricingDescriptor: ({ draft }) => draft,
  current: { requirements: () => requirements, buildRequests: ({ descriptor }) => stateRequests(descriptor),
    decodeSnapshot: ({ descriptor, initialResults }) => decodeState(descriptor, initialResults),
    deriveMids: ({ descriptor: d, snapshot: s, routes }) => new Map(routes.flatMap(r => { assertRoute(d, r); const q = sample(d, s, r);
      return q ? [[r.routeKey, protocolMid({ route: r, adapterId: ACTION, target: d.target, quote: q })] as const] : []; })),
    classifyUnavailable: ({ descriptor: d, snapshot: s, routes }) => new Map(routes.filter(r => !sample(d, s, r)).map(r => [r.routeKey, "psv-paused-or-no-positive-capacity"])),
  },
  dependencies: ({ descriptor }) => dependencies(descriptor),
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
  mutation: { compile({ entries }) {
    const index = compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: dependencies(d), keys: [d.instanceKey] }), { kinds: ["log", "call"] });
    const byKey = new Map(entries.map(e => [String(e.descriptor.instanceKey), e.descriptor]));
    return { dependencies: index.dependencies, affectedStateKeys: ({ observation }) => index.affectedStateKeys({ observation }).filter(k => affected(byKey.get(String(k))!, observation).length > 0) };
  }, affectedStateKeys: ({ descriptor, observation }) => affected(descriptor, observation) },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, State>;
