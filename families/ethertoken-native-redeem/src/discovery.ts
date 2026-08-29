import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type EtherTokenNativeRedeemCandidateV1, type EtherTokenNativeRedeemObservationV1 } from "./types.ts";
import { ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC } from "./manifest.ts";
export type EtherTokenNativeRedeemDiscoveryPatternV1 = "ethertoken-native-surface" | "ethertoken-native-call";
export const ETHERTOKEN_NATIVE_REDEEM_OWNED_LOG_TOPIC = ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC;
export interface EtherTokenNativeRedeemCandidateSeedV1 { readonly target: string; readonly evidence: EtherTokenNativeRedeemObservationV1; }
export function decodeEtherTokenNativeRedeemCandidate(observation: EtherTokenNativeRedeemObservationV1, pattern: EtherTokenNativeRedeemDiscoveryPatternV1): EtherTokenNativeRedeemCandidateSeedV1 | null { if ((pattern === "ethertoken-native-surface" || pattern === "ethertoken-native-call") && (observation.kind === "address-surface" || observation.kind === "call" || (observation.kind === "log" && observation.topic === ETHERTOKEN_NATIVE_REDEEM_OWNED_LOG_TOPIC))) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation }); return null; }
export function instanceNominationKey(input: EtherTokenNativeRedeemCandidateSeedV1 | EtherTokenNativeRedeemCandidateV1): string { return canonicalAddress(input.target); }
export function candidateSnapshotHash(input: EtherTokenNativeRedeemObservationV1): Hash { return hashDomain("aloha/ethertoken-native-redeem/candidate-snapshot/v1", { familyDefinitionHash: ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, target: canonicalAddress(input.target), cutoff: input.cutoff, blockNumber: input.blockNumber, blockHash: input.blockHash, txHash: input.txHash, logIndex: input.logIndex, topic: input.topic ?? null, rawLocatorHash: input.rawLocatorHash }); }
