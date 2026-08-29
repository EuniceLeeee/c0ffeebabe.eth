export {
  evaluateTerminalSelectionPredicate,
  type TerminalSelectionPredicateResultV1,
  type TerminalSelectionPredicateVerdict,
  type TerminalSelectionReasonCode,
  type TerminalSelectionReasonV1,
  type TerminalSelectionRuntimeFactsV1,
} from "./predicate.ts";
export * from "./schema.ts";
export {
  TERMINAL_SELECTION_CRITICAL_MUTATION_IDS,
  TERMINAL_SELECTION_INVOCATION_SEAL_ROLE,
  TERMINAL_SELECTION_OBSERVER_ROLE,
  TERMINAL_SELECTION_RAW_OBSERVER_ROLE,
  TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  TERMINAL_SELECTION_PREDICATE_SPEC,
  TERMINAL_SELECTION_PREDICATE_SPEC_DIGEST,
} from "./spec.ts";
