import {
  evaluateSixStepPredicate,
  SIX_STEP_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  SIX_STEP_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  SIX_STEP_PREDICATE_SPEC,
  type SixStepRuntimeFactsV1,
} from "../../../six-step-facts/src/runtime.ts";
import type {
  PredicateEvaluatorV1,
  PredicateIssueSinkV1,
  PredicateRuntimeFactsV1,
} from "../predicate-composition.ts";
import type { GateReasonCode, GateVerdict } from "../predicate-contract.ts";
import { COMMON_ENVELOPE_ROLE_CONTRACT_VERSION } from "../../../../specs/qualification/src/index.ts";

const SIX_STEP_ADAPTER_VERSION = "six-step-gate-core-adapter-v1";

function mapReasonCode(code: string): GateReasonCode {
  switch (code) {
    case "predicate-failed": return "predicate-failed";
    case "artifact-ref-mismatch": return "artifact-ref-mismatch";
    case "artifact-claim-mismatch": return "artifact-claim-mismatch";
    case "observation-mismatch": return "observation-mismatch";
    case "production-receipt-mismatch": return "production-receipt-mismatch";
    case "process-anchor-mismatch": return "process-anchor-mismatch";
    case "predicate-observation-missing": return "predicate-observation-missing";
    default: return "predicate-observation-mismatch";
  }
}

function evaluateLive(
  runtime: PredicateRuntimeFactsV1,
  issues: PredicateIssueSinkV1,
): GateVerdict {
  const result = evaluateSixStepPredicate(runtime as SixStepRuntimeFactsV1);
  for (const reason of result.reasons) issues.add(mapReasonCode(reason.code), reason.path);
  return result.verdict;
}

export const SIX_STEP_PREDICATE_ADAPTER_VERSION = SIX_STEP_ADAPTER_VERSION;

export const SIX_STEP_PREDICATE_EVALUATOR: PredicateEvaluatorV1 = Object.freeze({
  predicateId: SIX_STEP_PREDICATE_SPEC.predicateId,
  commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  adapterVersion: SIX_STEP_ADAPTER_VERSION,
  predicateSpec: SIX_STEP_PREDICATE_SPEC,
  predicateProgramDescriptorDigest: SIX_STEP_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: SIX_STEP_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluateLive,
});
