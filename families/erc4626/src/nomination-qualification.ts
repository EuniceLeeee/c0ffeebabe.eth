import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const ERC4626_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/erc4626/nomination-mutation-corpus/v1", ["wrong-owned-topic", "raw-log-mismatch", "duplicate-vault", "foreign-raw-locator"]) });
export const ERC4626_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/erc4626/nomination-independent-oracle/v1", ["owned-vault-log", "vault-target", "recent-window-ownership"]) });
