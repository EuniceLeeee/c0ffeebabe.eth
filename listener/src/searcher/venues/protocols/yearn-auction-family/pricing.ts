import type { PricingSemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid } from "../standard-family/common.js";
import { ABI } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { cost, decodeState, quoteBudget, requirements, stateRequests } from "./state.js";
import type { Binding, Descriptor, Route, State } from "./types.js";
export const dependencies = (d: Binding) => [d.target, d.implementation, d.want, d.sold];
export function sampleBudget(d: Binding, s: State): bigint {
  const one = 10n ** BigInt(d.soldDecimals), output = s.available < one ? s.available : one;
  return cost(d, s.rawPrice, output);
}
function sample(d: Descriptor, s: State) {
  if (!s.available || !s.rawPrice) return undefined;
  const amountIn = sampleBudget(d, s); if (!amountIn) return undefined;
  const q = quoteBudget(d, s, amountIn); return { amountIn, amountOut: q.amountOut };
}
function affected(d: Descriptor, o: UnifiedObservation): readonly string[] {
  const target = o.kind === "log" ? o.address.toLowerCase() : o.kind === "call" ? o.target.toLowerCase() : null;
  if (!target || !dependencies(d).includes(target)) return [];
  if ([d.want, d.sold].includes(target) && o.kind === "log" && o.topics[0]?.toLowerCase() === ABI.getEvent("Transfer")!.topicHash.toLowerCase()) {
    try { const e = ABI.decodeEventLog("Transfer", o.data, [...o.topics]);
      return [e.from, e.to].some(a => String(a).toLowerCase() === d.target) ? [d.instanceKey] : []; } catch { /* unknown remains conservative */ }
  }
  return [d.instanceKey];
}
export const pricing = { refreshPolicy: "each-block", stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => binding(descriptor), snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor: d, stateKey, routes }) {
    if (stateKey !== d.instanceKey || routes.length !== 1) throw new Error("Yearn auction pricing route group");
    routes.forEach(r => assertRoute(d, r)); return d;
  }, finalizePricingDescriptor: ({ draft }) => draft,
  current: { requirements: () => requirements, buildRequests: ({ descriptor }) => stateRequests(descriptor),
    decodeSnapshot: ({ descriptor, initialResults }) => decodeState(descriptor, initialResults),
    deriveMids: ({ descriptor: d, snapshot: s, routes }) => new Map(routes.flatMap(r => { assertRoute(d, r); const q = sample(d, s);
      return q ? [[r.routeKey, protocolMid({ route: r, adapterId: ACTION, target: d.target, quote: q })] as const] : []; })),
    classifyUnavailable: ({ descriptor: d, snapshot: s, routes }) => new Map(routes.filter(() => !sample(d, s)).map(r => [r.routeKey, "yearn-auction-no-active-payable-capacity"])),
  }, dependencies: ({ descriptor }) => dependencies(descriptor),
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
  mutation: { compile({ entries }) {
    const index = compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: dependencies(d), keys: [d.instanceKey] }), { kinds: ["log", "call"] });
    const byKey = new Map(entries.map(e => [String(e.descriptor.instanceKey), e.descriptor]));
    return { dependencies: index.dependencies, affectedStateKeys: ({ observation }) => index.affectedStateKeys({ observation }).filter(k => affected(byKey.get(String(k))!, observation).length > 0) };
  }, affectedStateKeys: ({ descriptor, observation }) => affected(descriptor, observation) },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, State>;
