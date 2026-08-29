import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const FLUID_CREDIT_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/fluid-credit/nomination-mutation-corpus/v1", ["wrong-credit-topic", "raw-log-mismatch", "duplicate-market", "foreign-raw-locator"]) });
export const FLUID_CREDIT_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/fluid-credit/nomination-independent-oracle/v1", ["credit-event-market", "exact-contract-pattern", "recent-window-ownership"]) });
