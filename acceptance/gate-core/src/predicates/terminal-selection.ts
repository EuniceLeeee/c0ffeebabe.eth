import {
  TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  TERMINAL_SELECTION_PREDICATE_SPEC,
  evaluateTerminalSelectionPredicate,
  type TerminalSelectionRuntimeFactsV1,
} from "../../../terminal-selection-facts/src/runtime.ts";
import type {
  PredicateEvaluatorV1,
  PredicateIssueSinkV1,
  PredicateRuntimeFactsV1,
} from "../predicate-composition.ts";
import type { GateReasonCode, GateVerdict } from "../predicate-contract.ts";
import { COMMON_ENVELOPE_ROLE_CONTRACT_VERSION } from "../../../../specs/qualification/src/index.ts";

const TERMINAL_SELECTION_ADAPTER_VERSION = "terminal-selection-gate-core-adapter-v1";

function mapReasonCode(code: string): GateReasonCode {
  switch (code) {
    case "artifact-ref-mismatch": return "artifact-ref-mismatch";
    case "artifact-claim-mismatch": return "artifact-claim-mismatch";
    case "observation-mismatch": return "observation-mismatch";
    case "process-anchor-mismatch": return "process-anchor-mismatch";
    case "predicate-observation-missing": return "predicate-observation-missing";
    case "predicate-failed": return "predicate-failed";
    default: return "predicate-observation-mismatch";
  }
}

function evaluateLive(runtime: PredicateRuntimeFactsV1, issues: PredicateIssueSinkV1): GateVerdict {
  const result = evaluateTerminalSelectionPredicate(runtime as TerminalSelectionRuntimeFactsV1);
  for (const reason of result.reasons) issues.add(mapReasonCode(reason.code), reason.path);
  return result.verdict;
}

export const TERMINAL_SELECTION_PREDICATE_ADAPTER_VERSION = TERMINAL_SELECTION_ADAPTER_VERSION;

export const TERMINAL_SELECTION_PREDICATE_EVALUATOR: PredicateEvaluatorV1 = Object.freeze({
  predicateId: TERMINAL_SELECTION_PREDICATE_SPEC.predicateId,
  commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  adapterVersion: TERMINAL_SELECTION_ADAPTER_VERSION,
  predicateSpec: TERMINAL_SELECTION_PREDICATE_SPEC,
  predicateProgramDescriptorDigest: TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluateLive,
});
