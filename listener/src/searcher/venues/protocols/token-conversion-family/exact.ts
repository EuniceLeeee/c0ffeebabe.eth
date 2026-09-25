import { bindRequestResultRound, collectRequestProgramResults, localZeroExactMethod, type ExactQuoteInput, type ExactQuoteSemantics, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { assertSameSource, assertSource, codeRequest, requireRuntimeCode, successfulResult } from "../standard-family/common.js";
import { assertInvocation } from "./binding.js";
import { MAX_UINT, nonzero, proveBearRuntime } from "./variants.js";
import { proveConversionAssetRuntime } from "./asset-runtime.js";
import { conversionSimulation, decodeConversionReceipt, simulationRequirements } from "./simulation.js";
import type { ConversionDescriptor, ConversionRoute, ConversionExactEvidence } from "./types.js";
import { supportsXwinPrefix, xwinPrefix } from "./sequential.js";
import { assertXwinBinding, checkXwinDependencies, decodeXwinReceipt, decodeXwinSurface, xwinDependencyRequests, xwinSimulation, xwinSimulationRequirements, xwinStateRequests } from "./xwin.js";
type Input = ExactQuoteInput<ConversionDescriptor, ConversionRoute>;
function check(input: Input) {
  assertInvocation(input.descriptor, input.route); nonzero(input.executor);
  xwinPrefix(input);
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
      { transports: ["get-code", "get-storage", "eth-call"], caller: "executor" } : { ...simulationRequirements, transports: ["get-code", "effect-delta-simulation"] };
  },
  buildRequests(i) {
    check(i);
    if (i.amountIn > 0n && i.descriptor.variant === "xwin-allocations-v1")
      return [...xwinStateRequests("exact-xwin", i.descriptor.target), codeRequest("exact-xwin-actor-code", i.executor)];
    return i.amountIn === 0n ? [] : [codeRequest("exact-code", i.descriptor.target),
      codeRequest("exact-asset-code", i.descriptor.asset),
      conversionSimulation("exact-conversion", i.descriptor.target, i.descriptor.asset, i.route.direction, i.amountIn)];
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
    if (proveBearRuntime(requireRuntimeCode(results, "exact-code"), i.descriptor.target, i.descriptor.asset) !== i.descriptor.codeHash) throw new Error("conversion runtime changed");
    if (proveConversionAssetRuntime(requireRuntimeCode(results, "exact-asset-code"), i.descriptor.asset) !== i.descriptor.assetCodeHash) throw new Error("conversion asset runtime changed");
    const { amountOut } = decodeConversionReceipt(results, "exact-conversion", i.descriptor.target, i.descriptor.asset, i.route.direction, i.amountIn, i.executor);
    return { amountOut, evidence: evidence(i, amountOut) };
  },
};
export const exact = {
  methods: (input: Input) => [
    localZeroExactMethod<ConversionDescriptor, ConversionRoute, ConversionExactEvidence>("zero", i => { check(i); return { amountOut: 0n, evidence: evidence(i, 0n) }; }),
    // No stateOnlyReads/reusePolicy: underlying execution may depend on caller
    // or environment. Each amount executes at the requested canonical source.
    ...(supportsXwinPrefix(input) ? [{ id: "conversion-execution-receipt", kind: "request-program" as const,
      chainAmountQuote: true as const,
      ...(input.descriptor.variant === "xwin-allocations-v1" ? { sequentialPrefix: true as const } : {}),
      program: exactProgram }] : []),
  ],
  cacheCompatibilityProjection: i => ({ variant: i.descriptor.variant, codeHash: i.descriptor.codeHash,
    executor: i.executor.toLowerCase(), bindingFingerprint: i.route.bindingRef.fingerprint }),
} satisfies ExactQuoteSemantics<ConversionDescriptor, ConversionRoute, ConversionExactEvidence>;
