import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
export const ERC4626_SILO_REDEEM_NOMINATION_MUTATION_CORPUS = Object.freeze({ schemaVersion: 1, corpusRoot: hashDomain("aloha/erc4626-silo-redeem/nomination-mutation-corpus/v1", ["wrong-owned-topic", "raw-log-mismatch", "duplicate-vault", "foreign-raw-locator"]) });
export const ERC4626_SILO_REDEEM_NOMINATION_INDEPENDENT_ORACLE = Object.freeze({ schemaVersion: 1, oracleRoot: hashDomain("aloha/erc4626-silo-redeem/nomination-independent-oracle/v1", ["owned-redeem-log", "vault-target", "recent-window-ownership"]) });
