import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
export interface Erc4626CutoffV1 { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash; }
export interface Erc4626ObservationV1 { readonly kind: "log" | "call" | "address-surface"; readonly cutoff: Erc4626CutoffV1; readonly blockNumber: string; readonly blockHash: Hash; readonly txHash: Hash; readonly logIndex: string; readonly target: string; readonly rawLocatorHash: Hash; readonly topic?: Hash | null; }
export interface Erc4626CandidateV1 { readonly target: string; readonly instanceNominationKey: string; readonly candidateSnapshotHash: Hash; readonly evidence: Erc4626ObservationV1; }
export interface Erc4626IdentityReadFactsV1 { readonly cutoff: Erc4626CutoffV1; readonly target: string; readonly reverseTarget: string; readonly asset: string; }
export interface Erc4626IdentityV1 { readonly cutoff: Erc4626CutoffV1; readonly candidateSnapshotHash: Hash; readonly instanceKey: string; readonly factsHash: Hash; readonly facts: { readonly target: string; readonly asset: string; }; }
export interface Erc4626StateReadFactsV1 { readonly cutoff: Erc4626CutoffV1; readonly instanceKey: string; readonly factsHash: Hash; }
export interface Erc4626MaterializedStateV1 extends Erc4626StateReadFactsV1 { readonly identityFactsHash: Hash; readonly stateHash: Hash; }
export interface Erc4626RouteV1 { readonly instanceKey: string; readonly inputAsset: string; readonly outputAsset: string; readonly routeBindingHash: Hash; }
export interface Erc4626QuoteV1 { readonly cutoff: Erc4626CutoffV1; readonly routeBindingHash: Hash; readonly referenceAmount: string; readonly observedAmount: string; readonly tolerance: string; readonly quoteHash: Hash; }
export interface Erc4626ActionV1 { readonly cutoff: Erc4626CutoffV1; readonly target: string; readonly calldata: string; readonly exactQuoteHash: Hash; readonly actionHash: Hash; }
export interface Erc4626ExecutionIntentV1 { readonly kind: "erc4626-execution-intent"; readonly cutoff: Erc4626CutoffV1; readonly target: string; readonly calldata: string; readonly actionHash: Hash; readonly exactQuoteHash: Hash; }
export function canonicalAddress(value: string): string { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("erc4626 address must be 20 bytes"); return `0x${value.slice(2).toLowerCase()}`; }
export function assertCutoff(value: Erc4626CutoffV1): Erc4626CutoffV1 { if (!/^\d+$/.test(value.chainId) || !/^\d+$/.test(value.number) || !/^0x[0-9a-f]{64}$/.test(value.hash) || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) throw new TypeError("erc4626 cutoff is not canonical"); return Object.freeze({ ...value }); }
export function cutoffEqual(left: Erc4626CutoffV1, right: Erc4626CutoffV1): boolean { return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot; }
export function familyCandidateKey(instanceNominationKey: string): Hash { return hashDomain("aloha/family-candidate/v1", { family: "erc4626", instanceNominationKey }); }
