import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { PredicateCompositionBindingV1 } from "./predicate-composition.ts";
import {
  type AssembledPredicateEvaluationV1,
  type AssembledReleaseInvocationSetCapabilityV1,
  type CommonEnvelopeAuthorityPortV1,
  type PredicateDomainMaterialStateV1,
  type PredicateMaterialSourcePortV1,
} from "./material-provider.ts";
import {
  assertCommonEnvelopeAuthorityPortV1,
  invokeCommonEnvelopeAuthorityPortV1,
  type CommonEnvelopeAssemblyStateV1,
} from "./internal/material-provider-state.ts";
import {
  readPredicateDomainMaterialCapabilityV1,
} from "./internal/predicate-domain-material-state.ts";
import { evaluateGateCoreRuntime } from "./index.ts";
import { sealAssembledReleaseAcceptanceResultsV1 } from "./internal/assembled-acceptance-owner.ts";

interface AssembledEntryV1 {
  readonly predicateId: string;
  readonly state: CommonEnvelopeAssemblyStateV1;
  readonly binding: PredicateCompositionBindingV1;
}

const invocationSets = new WeakMap<object, readonly AssembledEntryV1[]>();

/**
 * Release-owned mechanical traversal.  Predicate semantics and source
 * selection remain in generated bindings/providers; this assembler has no
 * predicate-id switch and accepts no caller-authored GateCoreInput.
 */
export async function assembleReleasePredicateInvocationsV1(
  authority: CommonEnvelopeAuthorityPortV1,
  source: PredicateMaterialSourcePortV1,
  bindings: readonly PredicateCompositionBindingV1[],
): Promise<AssembledReleaseInvocationSetCapabilityV1> {
  assertCommonEnvelopeAuthorityPortV1(authority);
  if (source === null || typeof source !== "object") throw new TypeError("predicate material source port is required");
  const entries: AssembledEntryV1[] = [];
  for (const binding of bindings) {
    let state: CommonEnvelopeAssemblyStateV1;
    let material: PredicateDomainMaterialStateV1;
    try {
      if (binding.materialProvider.predicateId !== binding.predicateId
        || binding.materialProvider.providerContractDigest !== binding.materialProviderContractDigest
        || binding.materialProvider.providerContractVersion !== "1.0.0") {
        throw new TypeError("generated material provider contract mismatch");
      }
      const capability = await binding.materialProvider.provide(source);
      material = readPredicateDomainMaterialCapabilityV1(capability);
      if (material.predicateId !== binding.predicateId) throw new TypeError("predicate material provider identity mismatch");
    } catch (error) {
      state = Object.freeze({
        status: "invalid" as const,
        code: "owner-material-invalid" as const,
        evidenceRoot: hashDomain("aloha/predicate-material-provider-error/v1", {
          predicateId: binding.predicateId,
          message: error instanceof Error ? error.message : "provider-error",
        }),
      });
      entries.push(Object.freeze({ predicateId: binding.predicateId, state, binding }));
      continue;
    }
    if (material.status !== "available") {
      state = material;
    } else {
      try {
        state = await invokeCommonEnvelopeAuthorityPortV1(authority, binding, material);
      } catch (error) {
        state = Object.freeze({
          status: "invalid" as const,
          code: "common-envelope-material-invalid" as const,
          evidenceRoot: hashDomain("aloha/common-envelope-assembly-error/v1", {
            predicateId: binding.predicateId,
            message: error instanceof Error ? error.message : "common-envelope-error",
          }),
        });
      }
    }
    entries.push(Object.freeze({ predicateId: binding.predicateId, state, binding }));
  }
  const capability = Object.freeze(Object.create(null)) as object;
  invocationSets.set(capability, Object.freeze(entries));
  return capability;
}

/** Evaluate sealed invocations without revealing authority pins, signatures,
 * registry material, or the forgeable GateCoreInput transport object. */
export function evaluateAssembledReleaseInvocationsV1(
  capability: AssembledReleaseInvocationSetCapabilityV1,
): readonly AssembledPredicateEvaluationV1[] {
  if (capability === null || typeof capability !== "object") throw new TypeError("assembled release invocation capability is invalid");
  const entries = invocationSets.get(capability);
  if (entries === undefined) throw new TypeError("assembled release invocation capability was not release-assembler-issued");
  const gateResults: Array<ReturnType<typeof evaluateGateCoreRuntime>> = [];
  const summaries = entries.map(entry => {
    if (entry.state.status !== "available") return Object.freeze({
      predicateId: entry.predicateId,
      status: entry.state.status,
      unavailableCode: entry.state.code,
      verdict: null,
      certificateId: null,
    });
    const result = evaluateGateCoreRuntime(
      entry.state.authority,
      entry.state.input,
      Object.freeze({
        rootDigest: entry.state.authority.predicateCompositionRootDigest,
        resolve: (predicateId: string) => predicateId === entry.predicateId ? entry.binding : null,
      }),
      entry.state.nowUnixNs,
    );
    gateResults.push(result);
    return Object.freeze({
      predicateId: entry.predicateId,
      status: "evaluated" as const,
      unavailableCode: null,
      verdict: result.verdict,
      certificateId: result.certificate.certificateId as Hash,
    });
  });
  if (gateResults.length === entries.length) {
    sealAssembledReleaseAcceptanceResultsV1(capability, gateResults);
  }
  return Object.freeze(summaries);
}
