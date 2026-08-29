import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
export interface GoldxCutoffV1 { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash; }
export interface GoldxObservationV1 { readonly kind: "log" | "call" | "address-surface"; readonly cutoff: GoldxCutoffV1; readonly blockNumber: string; readonly blockHash: Hash; readonly txHash: Hash; readonly logIndex: string; readonly target: string; readonly rawLocatorHash: Hash; readonly topic?: Hash | null; }
export interface GoldxCandidateV1 { readonly target: string; readonly instanceNominationKey: string; readonly candidateSnapshotHash: Hash; readonly evidence: GoldxObservationV1; }
export interface GoldxIdentityReadFactsV1 { readonly cutoff: GoldxCutoffV1; readonly target: string; readonly reverseTarget: string; readonly inputAsset: string; readonly outputAsset: string; }
export interface GoldxIdentityV1 { readonly cutoff: GoldxCutoffV1; readonly candidateSnapshotHash: Hash; readonly instanceKey: string; readonly factsHash: Hash; readonly facts: { readonly target: string; readonly inputAsset: string; readonly outputAsset: string; }; }
export interface GoldxStateReadFactsV1 { readonly cutoff: GoldxCutoffV1; readonly instanceKey: string; readonly unitWad: string; }
export interface GoldxMaterializedStateV1 extends GoldxStateReadFactsV1 { readonly identityFactsHash: Hash; readonly stateHash: Hash; }
export interface GoldxRouteV1 { readonly instanceKey: string; readonly inputAsset: string; readonly outputAsset: string; readonly routeBindingHash: Hash; }
export interface GoldxQuoteV1 { readonly cutoff: GoldxCutoffV1; readonly routeBindingHash: Hash; readonly amountIn: string; readonly amountOut: string; readonly unitWad: string; readonly quoteHash: Hash; }
export interface GoldxActionV1 { readonly cutoff: GoldxCutoffV1; readonly target: string; readonly calldata: string; readonly exactQuoteHash: Hash; readonly actionHash: Hash; }
export interface GoldxExecutionIntentV1 { readonly kind: "goldx-execution-intent"; readonly cutoff: GoldxCutoffV1; readonly target: string; readonly calldata: string; readonly actionHash: Hash; readonly exactQuoteHash: Hash; }
export function canonicalAddress(value: string): string { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("goldx address must be 20 bytes"); return `0x${value.slice(2).toLowerCase()}`; }
export function assertCutoff(value: GoldxCutoffV1): GoldxCutoffV1 { if (!/^\d+$/.test(value.chainId) || !/^\d+$/.test(value.number) || !/^0x[0-9a-f]{64}$/.test(value.hash) || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) throw new TypeError("goldx cutoff is not canonical"); return Object.freeze({ ...value }); }
export function cutoffEqual(left: GoldxCutoffV1, right: GoldxCutoffV1): boolean { return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot; }
export function familyCandidateKey(instanceNominationKey: string): Hash { return hashDomain("aloha/family-candidate/v1", { family: "goldx", instanceNominationKey }); }
