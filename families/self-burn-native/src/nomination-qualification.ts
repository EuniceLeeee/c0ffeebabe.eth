import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const SELF_BURN_NATIVE_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/self-burn-native/nomination-mutation-corpus/v1", ["wrong-owned-topic", "raw-log-mismatch", "duplicate-token", "foreign-raw-locator"]) });
export const SELF_BURN_NATIVE_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/self-burn-native/nomination-independent-oracle/v1", ["owned-burn-log", "token-target", "recent-window-ownership"]) });
