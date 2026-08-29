import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const EIGENPIE_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/eigenpie/nomination-mutation-corpus/v1", ["wrong-owned-topic", "raw-log-mismatch", "duplicate-protocol", "foreign-raw-locator"]) });
export const EIGENPIE_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/eigenpie/nomination-independent-oracle/v1", ["owned-protocol-log", "protocol-target", "recent-window-ownership"]) });
