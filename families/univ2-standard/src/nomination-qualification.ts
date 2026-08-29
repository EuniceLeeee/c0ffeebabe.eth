import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";

export const UNIV2_STANDARD_NOMINATION_MUTATION_CORPUS = Object.freeze({
  schemaVersion: 1,
  corpusRoot: hashDomain("aloha/univ2-standard/nomination-mutation-corpus/v1", [
    "omit-one-pair-created",
    "drop-one-sync-log",
    "same-evidence-two-pairs",
    "foreign-topic",
  ]),
});

export const UNIV2_STANDARD_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({
  schemaVersion: 1,
  oracleRoot: hashDomain("aloha/univ2-standard/nomination-independent-oracle/v1", [
    "pair-created-complete-history",
    "sync-log-pair-identity",
  ]),
});
