import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid } from "../standard-family/common.js";
import { address } from "./codec.js";
import { binding } from "./instance.js";
import { actionId, assertRoute } from "./routes.js";
import { decodeState, midSample, redemptionOutputs, stateRequests } from "./state.js";
import { CORE_LIBRARIES } from "./legacy.js";
import type { Descriptor, Route, State } from "./types.js";
export const dependencies = (d: Descriptor) => [...new Set([d.set, d.module, d.controller, ...d.components,
  ...(d.legacy ? [d.legacy.factory, d.legacy.vault, ...CORE_LIBRARIES.map(l => l.address)] : [])])];
export const pricing = {
  stateKey: r => r.instanceKey, staticBindingProjection: ({ descriptor }) => binding(descriptor), snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor: d, stateKey, routes }) {
    if (stateKey !== d.instanceKey || !routes.length || new Set(routes.map(r => r.component)).size !== routes.length) throw new Error("set-redemption invalid pricing group");
    routes.forEach(r => assertRoute(d, r)); return d;
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: { requirements: () => ({ transports: ["get-code", "eth-call"] }), buildRequests: ({ descriptor }) => stateRequests(descriptor),
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) { if (dependentEvidence.length) throw new Error("set-redemption unexpected state rounds"); return decodeState(descriptor, initialResults); },
    deriveMids({ descriptor: d, snapshot: s, routes }) {
      const sample = midSample(s), outputs = redemptionOutputs(s, sample);
      return new Map(routes.flatMap(r => { assertRoute(d, r); const amountOut = outputs[d.components.indexOf(r.component)];
        return sample > 0n && amountOut > 0n ? [[r.routeKey, protocolMid({ route: r, adapterId: actionId(d), target: d.module, quote: { amountIn: sample, amountOut } })] as const] : []; }));
    },
    classifyUnavailable({ descriptor, snapshot, routes }) {
      const output = redemptionOutputs(snapshot, midSample(snapshot));
      return new Map(routes.flatMap(r => !output[descriptor.components.indexOf(r.component)] ? [[r.routeKey, "set-redemption-zero-output-or-capacity"] as const] : []));
    },
  },
  dependencies: ({ descriptor }) => dependencies(descriptor),
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
  mutation: { compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: dependencies(d), keys: [d.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor: d, observation: o }) { const a = o.kind === "log" ? o.address : o.kind === "call" ? o.target : null;
      return a && dependencies(d).includes(address(a)) ? [d.instanceKey] : []; } },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, State>;
