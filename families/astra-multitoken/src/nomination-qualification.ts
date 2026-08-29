import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const ASTRA_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/astra-multitoken/nomination-mutation-corpus/v1", ["wrong-change-topic", "raw-log-mismatch", "duplicate-target", "foreign-raw-locator"]) });
export const ASTRA_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/astra-multitoken/nomination-independent-oracle/v1", ["change-log-target", "indexed-token-pair", "recent-window-ownership"]) });
