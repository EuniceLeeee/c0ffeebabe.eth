import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid } from "../standard-family/common.js";
import { binding } from "./instance.js";
import { address, WAD } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { capacity, decodeState, dependentRound, requirements, rootRequests, withdraw } from "./state.js";
import type { Descriptor, Route, State } from "./types.js";
export const dependencies = (d: Descriptor) => [...new Set([d.vault, d.vaultImplementation, d.strategy, d.strategyImplementation, d.asset, d.locker])];
function sample(s: State) {
  const cap = capacity(s), amountIn = cap < WAD ? cap : WAD;
  if (!amountIn) return undefined;
  const amountOut = withdraw(s, amountIn).amountOut;
  return amountOut > 0n ? { amountIn, amountOut } : undefined;
}
export const pricing = {
  // Re-resolve proxies/dependencies even without a touch to the old dependency
  // index. Current coordinator keeps bootstrap raw mids immutable; effective
  // and Exact refresh each block. A changed binding requires normal re-admission.
  refreshPolicy: "each-block", stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => binding(descriptor), snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor: d, stateKey, routes }) {
    if (stateKey !== d.instanceKey || routes.length !== 1) throw new Error("badger-sett pricing route group");
    routes.forEach(r => assertRoute(d, r)); return d;
  }, finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => requirements, buildRequests: ({ descriptor: d }) => rootRequests(d.vault),
    buildDependentProgram: ({ current: i, completedRound, initialResults, priorEvidence }) => dependentRound(i.descriptor, initialResults, priorEvidence, completedRound, i.source),
    decodeSnapshot: ({ descriptor: d, initialResults, dependentEvidence }) => decodeState(d, initialResults, dependentEvidence),
    deriveMids({ descriptor: d, snapshot: s, routes }) {
      const quote = sample(s);
      return new Map(routes.flatMap(r => { assertRoute(d, r); return quote ? [[r.routeKey, protocolMid({ route: r, adapterId: ACTION, target: d.vault, quote })] as const] : []; }));
    },
    classifyUnavailable: ({ snapshot, routes }) => new Map(sample(snapshot) ? [] : routes.map(r => [r.routeKey, "badger-sett-no-liquid-positive-capacity"] as const)),
  },
  dependencies: ({ descriptor }) => dependencies(descriptor),
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, binding: { ...snapshot.binding }, source: { ...snapshot.source } }) },
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: dependencies(d), keys: [d.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor: d, observation: o }) {
      const a = o.kind === "log" ? o.address : o.kind === "call" ? o.target : null;
      return a && dependencies(d).includes(address(a)) ? [d.instanceKey] : [];
    },
  },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, State>;
