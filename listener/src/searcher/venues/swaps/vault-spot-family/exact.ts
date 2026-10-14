import { localZeroExactMethod, bindRequestResultRound, collectRequestProgramResults, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { rootRequests, decodeRoot, reverseRequests, assertReverse, sourceOf, amount } from "./codec.js";
import { assertRoute } from "./routes.js";
import { simulationRequest, simulationRequirements, decodeReceipt } from "./simulation.js";
import type { Descriptor, Route, Evidence } from "./types.js";
type Input = ExactQuoteInput<Descriptor, Route>;
function check(i: Input) { assertRoute(i.descriptor, i.route); amount(i.amountIn, true); runtimeExecutor(i.executor, i.descriptor.vault, ...i.descriptor.tokens); }
function result(i: Input, out: bigint) { return { amountOut: out, evidence: { kind: "vault-spot-execution" as const, source: i.source,
  executor: i.executor.toLowerCase(), binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, amountIn: i.amountIn, amountOut: out } }; }
export const exactProgram: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: () => ({ transports: ["get-code", "eth-call"] }),
  buildRequests(i) { check(i); return i.amountIn === 0n ? [] : rootRequests(i.descriptor); },
  buildDependentProgram({ programInput: i, completedRound, initialResults }) {
    check(i); if (i.amountIn === 0n || completedRound !== 0) return null;
    const s = decodeRoot(i.descriptor, initialResults, i.source);
    if (!s.active) throw new Error("vault-spot swaps disabled or pair unlisted");
    return bindRequestResultRound({ ...simulationRequirements, transports: ["get-code", "eth-call", "effect-delta-simulation"] },
      [...reverseRequests(i.descriptor, s), simulationRequest(i.descriptor, i.route, i.amountIn, i.executor)]);
  },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i);
    if (i.amountIn === 0n) { if (initialResults.length || dependentEvidence.length) throw new Error("vault-spot zero quote has reads"); return result(i, 0n); }
    if (dependentEvidence.length !== 1) throw new Error("vault-spot missing Exact round");
    const s = decodeRoot(i.descriptor, initialResults, i.source), all = collectRequestProgramResults(initialResults, dependentEvidence);
    if (!s.active) throw new Error("vault-spot inactive");
    sourceOf(all, i.source); assertReverse(i.descriptor, s, all);
    return result(i, decodeReceipt(all, i.descriptor, i.route, i.amountIn, i.executor));
  },
};
export const exact = {
  methods: () => [localZeroExactMethod<Descriptor, Route, Evidence>("zero", i => { check(i); return result(i, 0n); }),
    { id: "vault-spot-executed-amount", kind: "request-program", chainAmountQuote: true, program: exactProgram }],
  cacheCompatibilityProjection: i => ({ binding: i.route.bindingRef.fingerprint, routeKey: i.route.routeKey, executor: i.executor.toLowerCase() }),
} satisfies ExactQuoteSemantics<Descriptor, Route, Evidence>;
