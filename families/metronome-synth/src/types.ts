import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { METRONOME_SYNTH_FAMILY_ID } from "./manifest.ts";
import type { MetronomeSynthProjectionV1 } from "../kernel/projection.ts";
export interface MetronomeSynthCutoffV1 { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash; }
export interface MetronomeSynthObservationV1 { readonly kind: "log" | "call" | "address-surface"; readonly cutoff: MetronomeSynthCutoffV1; readonly blockNumber: string; readonly blockHash: Hash; readonly txHash: Hash; readonly logIndex: string; readonly target: string; readonly rawLocatorHash: Hash; }
export interface MetronomeSynthCandidateV1 { readonly target: string; readonly instanceNominationKey: string; readonly candidateSnapshotHash: Hash; readonly evidence: MetronomeSynthObservationV1; }
export interface MetronomeSynthIdentityReadFactsV1 { readonly cutoff: MetronomeSynthCutoffV1; readonly target: string; readonly reverseTarget: string; readonly pool: string; readonly tokens: readonly string[]; readonly activeDirections: readonly { readonly tokenIn: string; readonly tokenOut: string }[]; readonly oracleBinding: `0x${string}`; }
export interface MetronomeSynthIdentityV1 { readonly cutoff: MetronomeSynthCutoffV1; readonly candidateSnapshotHash: Hash; readonly instanceKey: string; readonly factsHash: Hash; readonly facts: MetronomeSynthProjectionV1; }
export interface MetronomeSynthStateReadFactsV1 { readonly cutoff: MetronomeSynthCutoffV1; readonly instanceKey: string; readonly projectionHash: Hash; }
export interface MetronomeSynthMaterializedStateV1 extends MetronomeSynthStateReadFactsV1 { readonly identityFactsHash: Hash; readonly stateHash: Hash; }
export interface MetronomeSynthRouteV1 { readonly instanceKey: string; readonly inputAsset: string; readonly outputAsset: string; readonly routeBindingHash: Hash; }
export interface MetronomeSynthActionV1 { readonly cutoff: MetronomeSynthCutoffV1; readonly target: string; readonly calldata: string; readonly bindingHash: Hash; readonly actionHash: Hash; }
export interface MetronomeSynthExecutionIntentV1 { readonly kind: "metronome-synth-execution-intent"; readonly cutoff: MetronomeSynthCutoffV1; readonly target: string; readonly calldata: string; readonly actionHash: Hash; readonly bindingHash: Hash; }
export function canonicalAddress(value: string): string { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("metronome synth address must be 20 bytes"); return `0x${value.slice(2).toLowerCase()}`; }
export function assertCutoff(value: MetronomeSynthCutoffV1): MetronomeSynthCutoffV1 { if (!/^\d+$/.test(value.chainId) || !/^\d+$/.test(value.number) || !/^0x[0-9a-f]{64}$/.test(value.hash) || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) throw new TypeError("metronome synth cutoff is not canonical"); return Object.freeze({ ...value }); }
export function cutoffEqual(left: MetronomeSynthCutoffV1, right: MetronomeSynthCutoffV1): boolean { return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot; }
export function familyCandidateKey(key: string): Hash { return hashDomain("aloha/family-candidate/v1", { family: METRONOME_SYNTH_FAMILY_ID, instanceNominationKey: key }); }
