import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";

export const CURVE_UNDERLYING_NOMINATION_MUTATION_CORPUS = Object.freeze({
  schemaVersion: 1,
  corpusRoot: hashDomain("aloha/curve-underlying/nomination-mutation-corpus/v1", [
    "omit-one-registry-pool",
    "duplicate-evidence-index",
    "foreign-recent-log",
    "same-evidence-two-candidates",
  ]),
});

export const CURVE_UNDERLYING_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({
  schemaVersion: 1,
  oracleRoot: hashDomain("aloha/curve-underlying/nomination-independent-oracle/v1", [
    "metaregistry-complete-set",
    "event-log-identity",
  ]),
});
