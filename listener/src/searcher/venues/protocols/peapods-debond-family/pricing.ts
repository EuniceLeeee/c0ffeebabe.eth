import type { PricingSemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid } from "../standard-family/common.js";
import { ABI, WAD } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { debond } from "./math.js";
import { assertRoute } from "./routes.js";
import { decodeState, requirements, stateRequests } from "./state.js";
import type { Descriptor, Route, State } from "./types.js";
export const dependencies = (d: Descriptor) => [d.pod, d.asset];
function affected(d: Descriptor, o: UnifiedObservation): readonly string[] {
  const target = o.kind === "log" ? o.address.toLowerCase() : o.kind === "call" ? o.target.toLowerCase() : null;
  if (!target || !dependencies(d).includes(target)) return [];
  if (target === d.asset && o.kind === "log" && o.topics[0]?.toLowerCase() === ABI.getEvent("Transfer")!.topicHash.toLowerCase()) {
    try { const v = ABI.decodeEventLog("Transfer", o.data, [...o.topics]);
      return [v.from, v.to].some(a => String(a).toLowerCase() === d.pod) ? [d.instanceKey] : []; } catch { /* malformed event remains conservative */ }
  }
  return [d.instanceKey];
}
function sample(s: State) {
  const amountIn = s.supply < WAD ? s.supply : WAD;
  if (!amountIn) return undefined;
  const amountOut = debond(s, amountIn).amountOut;
  return amountOut > 0n ? { amountIn, amountOut } : undefined;
}
export const pricing = {
  stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => binding(descriptor), snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor: d, stateKey, routes }) {
    if (stateKey !== d.instanceKey || routes.length !== 1) throw new Error("peapods pricing route group");
    routes.forEach(r => assertRoute(d, r)); return d;
  }, finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => requirements, buildRequests: ({ descriptor }) => stateRequests(descriptor),
    decodeSnapshot: ({ descriptor, initialResults }) => decodeState(descriptor, initialResults),
    deriveMids({ descriptor: d, snapshot: s, routes }) { const quote = sample(s);
      return new Map(routes.flatMap(r => { assertRoute(d, r); return quote ? [[r.routeKey, protocolMid({ route: r, adapterId: ACTION, target: d.pod, quote })] as const] : []; })); },
    classifyUnavailable: ({ snapshot, routes }) => new Map(sample(snapshot) ? [] : routes.map(r => [r.routeKey, "peapods-no-positive-backing"] as const)),
  },
  dependencies: ({ descriptor }) => dependencies(descriptor),
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
  mutation: {
    compile({ entries }) {
      const candidates = compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: dependencies(d), keys: [d.instanceKey] }), { kinds: ["log", "call"] });
      const descriptors = new Map<string, Descriptor>(entries.map(e => [e.descriptor.instanceKey, e.descriptor]));
      // The production session uses this compiled path, not the callback below.
      // Narrow only the indexed dependency subscribers, never scan every POD.
      return { dependencies: candidates.dependencies, affectedStateKeys({ observation }) {
        return candidates.affectedStateKeys({ observation }).filter(key => affected(descriptors.get(key)!, observation).length > 0);
      } };
    },
    affectedStateKeys: ({ descriptor, observation }) => affected(descriptor, observation),
  },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, State>;
