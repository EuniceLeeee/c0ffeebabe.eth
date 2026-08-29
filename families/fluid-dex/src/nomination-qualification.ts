import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const FLUID_DEX_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/fluid-dex/nomination-mutation-corpus/v1", ["wrong-dex-topic", "raw-log-mismatch", "duplicate-pool", "foreign-raw-locator"]) });
export const FLUID_DEX_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/fluid-dex/nomination-independent-oracle/v1", ["dex-event-pool", "exact-contract-pattern", "recent-window-ownership"]) });
