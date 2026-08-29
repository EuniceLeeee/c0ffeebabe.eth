import type { Hash } from "../../../canonical-codec/src/index.ts";
import {
  normalizeEconomicSafetyFinalizationInputV1,
  EconomicSafetyPolicyRejectionErrorV1,
  sealEconomicSafetyEvidenceV1,
  sealEconomicSafetyChainRejectionV1,
  type EconomicSafetyEvidenceCapabilityV1,
  type EconomicSafetyEvidenceV1,
  type EconomicSafetyChainRejectionV1,
  type EconomicSafetyFinalizationInputV1,
  type EconomicSafetyFinalizationServiceV1,
  type EconomicSafetyQualifiedEvaluatorV1,
} from "../index.ts";
import { registerEconomicSafetyFinalizationServiceV1 } from "./state.ts";

const capabilities = new WeakMap<object, {
  readonly service: EconomicSafetyFinalizationServiceV1;
  readonly evidence: EconomicSafetyEvidenceV1 | EconomicSafetyChainRejectionV1;
}>();

/** Owner-only constructor. Production callers must enter through runtime-release-authority. */
export function issueEconomicSafetyFinalizationServiceV1(input: {
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly evaluator: EconomicSafetyQualifiedEvaluatorV1;
}): EconomicSafetyFinalizationServiceV1 {
  if (input.evaluator === null || typeof input.evaluator !== "object" || typeof input.evaluator.evaluate !== "function") {
    throw new TypeError("qualified economic safety evaluator is required");
  }
  const service: EconomicSafetyFinalizationServiceV1 = Object.freeze({
    binding() {
      return Object.freeze({
        authorityRoot: input.authorityRoot,
        implementationHash: input.implementationHash,
        releaseProvenanceHash: input.releaseProvenanceHash,
      });
    },
    async finalize(raw: EconomicSafetyFinalizationInputV1) {
      const normalized = normalizeEconomicSafetyFinalizationInputV1(raw);
      let evidence: EconomicSafetyEvidenceV1 | EconomicSafetyChainRejectionV1;
      try {
        evidence = sealEconomicSafetyEvidenceV1({
          authorityRoot: input.authorityRoot,
          implementationHash: input.implementationHash,
          releaseProvenanceHash: input.releaseProvenanceHash,
          input: normalized,
          decision: await input.evaluator.evaluate(normalized),
        });
      } catch (error) {
        if (!(error instanceof EconomicSafetyPolicyRejectionErrorV1)) throw error;
        evidence = sealEconomicSafetyChainRejectionV1({
          authorityRoot: input.authorityRoot,
          implementationHash: input.implementationHash,
          releaseProvenanceHash: input.releaseProvenanceHash,
          input: normalized,
          code: error.code,
        });
      }
      const capability = Object.freeze({ kind: "opaque-qualified-stage-rejection-capability" as const }) as EconomicSafetyEvidenceCapabilityV1;
      capabilities.set(capability, { service, evidence });
      return capability;
    },
    read(capability: EconomicSafetyEvidenceCapabilityV1) {
      if (capability === null || typeof capability !== "object") throw new TypeError("economic safety evidence capability is invalid");
      const state = capabilities.get(capability);
      if (state === undefined || state.service !== service) throw new TypeError("economic safety evidence capability was not issued by this service");
      return state.evidence;
    },
  });
  registerEconomicSafetyFinalizationServiceV1(service);
  return service;
}
