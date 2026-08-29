import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";

export const UNIV3_STANDARD_NOMINATION_MUTATION_CORPUS = Object.freeze({
  schemaVersion: 1,
  corpusRoot: hashDomain("aloha/univ3-standard/nomination-mutation-corpus/v1", [
    "omit-one-pool-created",
    "drop-one-swap-log",
    "same-evidence-two-pools",
    "malformed-pool-created-abi",
  ]),
});

export const UNIV3_STANDARD_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({
  schemaVersion: 1,
  oracleRoot: hashDomain("aloha/univ3-standard/nomination-independent-oracle/v1", [
    "pool-created-complete-history",
    "swap-log-pool-identity",
  ]),
});
