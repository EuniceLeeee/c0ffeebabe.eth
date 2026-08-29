import type { Hash } from "../../../canonical-codec/src/index.ts";
import {
  normalizeEconomicSafetyFinalizationInputV1,
  sealEconomicSafetyEvidenceV1,
  type EconomicSafetyEvidenceCapabilityV1,
  type EconomicSafetyEvidenceV1,
  type EconomicSafetyFinalizationInputV1,
  type EconomicSafetyFinalizationServiceV1,
  type EconomicSafetyQualifiedEvaluatorV1,
} from "../index.ts";
import { registerEconomicSafetyFinalizationServiceV1 } from "./state.ts";

const capabilities = new WeakMap<object, {
  readonly service: EconomicSafetyFinalizationServiceV1;
  readonly evidence: EconomicSafetyEvidenceV1;
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
      const evidence = sealEconomicSafetyEvidenceV1({
        authorityRoot: input.authorityRoot,
        implementationHash: input.implementationHash,
        releaseProvenanceHash: input.releaseProvenanceHash,
        input: normalized,
        decision: await input.evaluator.evaluate(normalized),
      });
      const capability = Object.freeze(Object.create(null)) as EconomicSafetyEvidenceCapabilityV1;
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
