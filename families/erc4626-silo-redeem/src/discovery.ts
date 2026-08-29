import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type Erc4626SiloRedeemCandidateV1, type Erc4626SiloRedeemObservationV1 } from "./types.ts";
import { ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { ERC4626_SILO_REDEEM_WITHDRAW_TOPIC } from "./manifest.ts";
export type Erc4626SiloRedeemDiscoveryPatternV1 = "erc4626-silo-redeem-surface" | "erc4626-silo-redeem-call";
export const ERC4626_SILO_REDEEM_OWNED_LOG_TOPIC = ERC4626_SILO_REDEEM_WITHDRAW_TOPIC;
export interface Erc4626SiloRedeemCandidateSeedV1 { readonly target: string; readonly evidence: Erc4626SiloRedeemObservationV1; }
export function decodeErc4626SiloRedeemCandidate(observation: Erc4626SiloRedeemObservationV1, pattern: Erc4626SiloRedeemDiscoveryPatternV1): Erc4626SiloRedeemCandidateSeedV1 | null { if ((pattern === "erc4626-silo-redeem-surface" || pattern === "erc4626-silo-redeem-call") && (observation.kind === "address-surface" || observation.kind === "call" || (observation.kind === "log" && observation.topic === ERC4626_SILO_REDEEM_OWNED_LOG_TOPIC))) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation }); return null; }
export function instanceNominationKey(input: Erc4626SiloRedeemCandidateSeedV1 | Erc4626SiloRedeemCandidateV1): string { return canonicalAddress(input.target); }
export function candidateSnapshotHash(input: Erc4626SiloRedeemObservationV1): Hash { return hashDomain("aloha/erc4626-silo-redeem/candidate-snapshot/v1", { familyDefinitionHash: ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH, target: canonicalAddress(input.target), cutoff: input.cutoff, blockNumber: input.blockNumber, blockHash: input.blockHash, txHash: input.txHash, logIndex: input.logIndex, topic: input.topic ?? null, rawLocatorHash: input.rawLocatorHash }); }
