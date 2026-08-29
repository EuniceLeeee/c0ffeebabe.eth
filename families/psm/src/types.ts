import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { PSM_FAMILY_ID } from "./manifest.ts";
export interface PsmCutoffV1 { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash; }
export interface PsmObservationV1 { readonly kind: "log" | "call" | "address-surface"; readonly cutoff: PsmCutoffV1; readonly blockNumber: string; readonly blockHash: Hash; readonly txHash: Hash; readonly logIndex: string; readonly target: string; readonly rawLocatorHash: Hash; }
export interface PsmCandidateV1 { readonly target: string; readonly instanceNominationKey: string; readonly candidateSnapshotHash: Hash; readonly evidence: PsmObservationV1; }
export interface PsmIdentityReadFactsV1 { readonly cutoff: PsmCutoffV1; readonly target: string; readonly reverseTarget: string; readonly inputAsset: string; readonly outputAsset: string; }
export interface PsmIdentityV1 { readonly cutoff: PsmCutoffV1; readonly candidateSnapshotHash: Hash; readonly instanceKey: string; readonly factsHash: Hash; readonly facts: { readonly target: string; readonly inputAsset: string; readonly outputAsset: string; }; }
export interface PsmStateReadFactsV1 { readonly cutoff: PsmCutoffV1; readonly instanceKey: string; readonly feeWad: string; readonly assetScale: string; }
export interface PsmMaterializedStateV1 extends PsmStateReadFactsV1 { readonly identityFactsHash: Hash; readonly stateHash: Hash; }
export interface PsmRouteV1 { readonly instanceKey: string; readonly inputAsset: string; readonly outputAsset: string; readonly routeBindingHash: Hash; }
export interface PsmQuoteV1 { readonly cutoff: PsmCutoffV1; readonly routeBindingHash: Hash; readonly amountIn: string; readonly amountOut: string; readonly feeWad: string; readonly assetScale: string; readonly quoteHash: Hash; }
export interface PsmActionV1 { readonly cutoff: PsmCutoffV1; readonly target: string; readonly calldata: string; readonly exactQuoteHash: Hash; readonly actionHash: Hash; }
export interface PsmExecutionIntentV1 { readonly kind: "psm-execution-intent"; readonly cutoff: PsmCutoffV1; readonly target: string; readonly calldata: string; readonly actionHash: Hash; readonly exactQuoteHash: Hash; }
export function canonicalAddress(value: string): string { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("PSM address must be 20 bytes"); return `0x${value.slice(2).toLowerCase()}`; }
export function assertCutoff(value: PsmCutoffV1): PsmCutoffV1 { if (!/^\d+$/.test(value.chainId) || !/^\d+$/.test(value.number) || !/^0x[0-9a-f]{64}$/.test(value.hash) || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) throw new TypeError("PSM cutoff is not canonical"); return Object.freeze({ ...value }); }
export function cutoffEqual(a: PsmCutoffV1, b: PsmCutoffV1): boolean { return a.chainId === b.chainId && a.number === b.number && a.hash === b.hash && a.stateRoot === b.stateRoot; }
export function familyCandidateKey(instanceNominationKey: string): Hash { return hashDomain("aloha/family-candidate/v1", { family: PSM_FAMILY_ID, instanceNominationKey }); }
