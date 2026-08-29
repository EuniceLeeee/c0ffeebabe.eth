import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const UNIV4_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/univ4/nomination-mutation-corpus/v1", ["wrong-manager", "duplicate-pool-id", "history-gap", "raw-log-mismatch"]) });
export const UNIV4_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/univ4/nomination-independent-oracle/v1", ["pool-manager-initialize", "pool-key-domain", "contiguous-history"]) });
