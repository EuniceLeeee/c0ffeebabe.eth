import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export interface EigenpieCutoffV1 { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash; }
export interface EigenpieObservationV1 { readonly kind: "log" | "call" | "address-surface"; readonly cutoff: EigenpieCutoffV1; readonly blockNumber: string; readonly blockHash: Hash; readonly txHash: Hash; readonly logIndex: string; readonly target: string; readonly rawLocatorHash: Hash; readonly topic?: Hash | null; }
export interface EigenpieCandidateV1 { readonly target: string; readonly instanceNominationKey: string; readonly candidateSnapshotHash: Hash; readonly evidence: EigenpieObservationV1; }
export interface EigenpieIdentityReadFactsV1 { readonly cutoff: EigenpieCutoffV1; readonly target: string; readonly reverseTarget: string; readonly inputAsset: string; readonly outputAsset: string; }
export interface EigenpieIdentityV1 { readonly cutoff: EigenpieCutoffV1; readonly candidateSnapshotHash: Hash; readonly instanceKey: string; readonly factsHash: Hash; readonly facts: { readonly target: string; readonly inputAsset: string; readonly outputAsset: string; }; }
export interface EigenpieStateReadFactsV1 { readonly cutoff: EigenpieCutoffV1; readonly instanceKey: string; readonly factsHash: Hash; }
export interface EigenpieMaterializedStateV1 extends EigenpieStateReadFactsV1 { readonly identityFactsHash: Hash; readonly stateHash: Hash; }
export interface EigenpieRouteV1 { readonly instanceKey: string; readonly inputAsset: string; readonly outputAsset: string; readonly routeBindingHash: Hash; }
export interface EigenpieQuoteV1 { readonly cutoff: EigenpieCutoffV1; readonly routeBindingHash: Hash; readonly amountOut: string; readonly tokenOut: string; readonly quoteHash: Hash; }
export interface EigenpieActionV1 { readonly cutoff: EigenpieCutoffV1; readonly target: string; readonly calldata: string; readonly exactQuoteHash: Hash; readonly actionHash: Hash; }
export interface EigenpieExecutionIntentV1 { readonly kind: "eigenpie-execution-intent"; readonly cutoff: EigenpieCutoffV1; readonly target: string; readonly calldata: string; readonly actionHash: Hash; readonly exactQuoteHash: Hash; }

export function canonicalAddress(value: string): string { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("eigenpie address must be 20 bytes"); return `0x${value.slice(2).toLowerCase()}`; }
export function assertCutoff(value: EigenpieCutoffV1): EigenpieCutoffV1 { if (!/^\d+$/.test(value.chainId) || !/^\d+$/.test(value.number) || !/^0x[0-9a-f]{64}$/.test(value.hash) || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) throw new TypeError("eigenpie cutoff is not canonical"); return Object.freeze({ ...value }); }
export function cutoffEqual(left: EigenpieCutoffV1, right: EigenpieCutoffV1): boolean { return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot; }
export function familyCandidateKey(instanceNominationKey: string): Hash { return hashDomain("aloha/family-candidate/v1", { family: "eigenpie", instanceNominationKey }); }
