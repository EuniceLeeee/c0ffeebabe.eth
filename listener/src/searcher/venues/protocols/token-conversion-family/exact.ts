import { bindRequestResultRound, collectRequestProgramResults, localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { assertSameSource, assertSource, codeRequest, requireRuntimeCode, successfulResult } from "../standard-family/common.js";
import { assertInvocation } from "./binding.js";
import { MAX_UINT, nonzero } from "./variants.js";
import { bearStateRequests, decodeBearState } from "./bear-local.js";
import type { ConversionDescriptor, ConversionRoute, ConversionExactEvidence } from "./types.js";
import { supportsXwinPrefix, xwinPrefix } from "./sequential.js";
import { decodeXwinLocal, localSurface, xwinLocalPauseRequest, xwinLocalResources, xwinLocalRound } from "./xwin-local.js";
import { quoteBearTrial, quoteXwinTrial } from "./trial-state.js";
import { assertXwinBinding, checkXwinDependencies, decodeXwinReceipt, decodeXwinSurface, xwinDependencyRequests, xwinSimulation, xwinSimulationRequirements, xwinStateRequests } from "./xwin.js";
type Input = ExactQuoteInput<ConversionDescriptor, ConversionRoute>;
function check(input: Input) {
  assertInvocation(input.descriptor, input.route); nonzero(input.executor);
  if ([input.descriptor.target, input.descriptor.asset].some(a => a.toLowerCase() === input.executor.toLowerCase())) throw new Error("conversion executor aliases token");
  if (input.descriptor.variant === "xwin-allocations-v1" && input.executor.toLowerCase() === input.descriptor.proxyAdmin.toLowerCase()) throw new Error("xWin proxy admin cannot execute conversion");
  if (typeof input.amountIn !== "bigint" || input.amountIn < 0n || input.amountIn > MAX_UINT) throw new Error("conversion exact input outside uint256");
}
function evidence(i: Input, amountOut: bigint): ConversionExactEvidence {
  return { kind: "token-conversion-balance-quote", source: i.source, executor: i.executor,
    direction: i.route.direction, amountIn: i.amountIn, amountOut, bindingFingerprint: i.route.bindingRef.fingerprint };
}
export const exactProgram: ExactRequestProgram<ConversionDescriptor, ConversionRoute, ConversionExactEvidence> = {
  requirements(input) {
    check(input);
    return input.amountIn === 0n ? { transports: [] } : input.descriptor.variant === "xwin-allocations-v1" ?
      { transports: ["get-code", "get-storage", "eth-call"], caller: "executor" } : { transports: ["get-code", "eth-call"] };
  },
  buildRequests(i) {
    check(i);
    if (i.amountIn > 0n && i.descriptor.variant === "xwin-allocations-v1")
      return [...xwinStateRequests("exact-xwin", i.descriptor.target), codeRequest("exact-xwin-actor-code", i.executor)];
    return i.amountIn === 0n ? [] : bearStateRequests("exact", i.descriptor);
  },
  buildDependentProgram({ programInput: i, completedRound, initialResults, priorEvidence }) {
    check(i);
    if (i.amountIn === 0n || i.descriptor.variant !== "xwin-allocations-v1") return null;
    const s = decodeXwinSurface(initialResults, "exact-xwin", i.descriptor.target);
    assertXwinBinding(s, i.descriptor);
    requireRuntimeCode(initialResults, "exact-xwin-actor-code");
    if (completedRound === 0) return bindRequestResultRound({ transports: ["get-code", "eth-call"], caller: "executor" }, xwinDependencyRequests("exact-xwin", s));
    checkXwinDependencies(collectRequestProgramResults(initialResults, priorEvidence), "exact-xwin", s);
    return completedRound === 1 ? bindRequestResultRound(xwinSimulationRequirements, [xwinSimulation("exact-xwin-conversion", s, i.route.direction, i.amountIn, xwinPrefix(i))]) : null;
  },
  decode({ programInput: i, initialResults: initial, dependentEvidence }) {
    check(i);
    const results = collectRequestProgramResults(initial, dependentEvidence);
    if (i.amountIn === 0n) {
      if (results.length !== 0) throw new Error("unexpected zero conversion evidence");
      return { amountOut: 0n, evidence: evidence(i, 0n) };
    }
    assertSource(assertSameSource(results.map(r => successfulResult(results, r.id))), i.source);
    if (i.descriptor.variant === "xwin-allocations-v1") {
      const s = decodeXwinSurface(initial, "exact-xwin", i.descriptor.target);
      assertXwinBinding(s, i.descriptor);
      requireRuntimeCode(initial, "exact-xwin-actor-code");
      checkXwinDependencies(results, "exact-xwin", s);
      const { amountOut } = decodeXwinReceipt(results, "exact-xwin-conversion", s, i.route.direction, i.amountIn, i.executor, xwinPrefix(i));
      return { amountOut, evidence: evidence(i, amountOut) };
    }
    return quoteBearTrial(i, decodeBearState("exact", i.descriptor, results))!;
  },
};
export const xwinLocalProgram: ExactRequestProgram<ConversionDescriptor, ConversionRoute, ConversionExactEvidence> = {
  requirements: input => { check(input); return input.amountIn === 0n ? { transports: [] } : { transports: ["get-code", "get-storage", "eth-call"], caller: "executor" }; },
  buildRequests: i => { check(i); return i.amountIn === 0n ? [] : [...xwinStateRequests("exact-xwin", i.descriptor.target),
    codeRequest("exact-xwin-actor-code", i.executor), xwinLocalPauseRequest("exact-xwin", i.descriptor.target)]; },
  buildDependentProgram({ programInput: i, completedRound, initialResults, priorEvidence }) {
    check(i);
    if (i.amountIn === 0n) return null;
    const s = localSurface(initialResults, "exact-xwin", i.descriptor);
    requireRuntimeCode(initialResults, "exact-xwin-actor-code");
    return xwinLocalRound("exact-xwin", s, i.executor, completedRound, collectRequestProgramResults(initialResults, priorEvidence));
  },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i);
    if (i.amountIn === 0n) return { amountOut: 0n, evidence: evidence(i, 0n) };
    const s = localSurface(initialResults, "exact-xwin", i.descriptor);
    assertSource(s.source, i.source);
    requireRuntimeCode(initialResults, "exact-xwin-actor-code");
    const results = collectRequestProgramResults(initialResults, dependentEvidence);
    const state = decodeXwinLocal("exact-xwin", s, i.executor, results);
    return quoteXwinTrial(i, { state, resources: xwinLocalResources("exact-xwin", s, i.executor, results) })!;
  },
};
// Explicit receipt mode is retained for same-state validation. Production uses
// read-state/local; unsupported local semantics fail rather than silently simulate.
export function createConversionExact(xwinMode: "local" | "simulation" = "local") { return {
  methods: (input: Input) => [
    localZeroExactMethod<ConversionDescriptor, ConversionRoute, ConversionExactEvidence>("zero", i => { check(i); return { amountOut: 0n, evidence: evidence(i, 0n) }; }),
    // Bear's getStats call can use the existing same-source call memo; code
    // checks still use the provider. Do not declare stateOnlyReads: it accepts eth_call only,
    // whereas this program also retains both runtime-code checks.
    ...(input.descriptor.variant === "btb-bear-v1" || xwinMode === "local" || supportsXwinPrefix(input) ? [{ id: input.descriptor.variant === "btb-bear-v1" ? "bear-local-state" : xwinMode === "local" ? "xwin-local-state" : "conversion-execution-receipt", kind: "request-program" as const,
      ...(input.descriptor.variant === "xwin-allocations-v1" && xwinMode === "simulation"
        ? { sequentialPrefix: true as const, chainAmountQuote: true as const }
        : { trialState: { quote(i: Input) {
          check(i);
          const result = i.descriptor.variant === "btb-bear-v1" ? quoteBearTrial(i) : quoteXwinTrial(i);
          return result === undefined ? { status: "not-applicable" as const, reason: "conversion trial state not loaded" }
            : { status: "quoted" as const, result };
        } } }),
      program: input.descriptor.variant === "xwin-allocations-v1" && xwinMode === "local" ? xwinLocalProgram : exactProgram }] : []),
  ],
  cacheCompatibilityProjection: i => ({ variant: i.descriptor.variant, codeHash: i.descriptor.codeHash,
    executor: i.executor.toLowerCase(), bindingFingerprint: i.route.bindingRef.fingerprint, xwinMode }),
} satisfies ExactQuoteSemantics<ConversionDescriptor, ConversionRoute, ConversionExactEvidence>; }
export const exact = createConversionExact();
