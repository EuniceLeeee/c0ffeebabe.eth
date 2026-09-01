import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const ANGSTROM_V4_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/angstrom-v4/nomination-mutation-corpus/v1", ["wrong-hook", "duplicate-pool-id", "history-gap", "raw-log-mismatch"]) });
export const ANGSTROM_V4_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/angstrom-v4/nomination-independent-oracle/v1", ["pool-manager-initialize", "exact-hook-binding", "rolling-observation"]) });
