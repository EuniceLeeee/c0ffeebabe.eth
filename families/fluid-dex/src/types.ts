import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { FLUID_DEX_FAMILY_ID } from "./manifest.ts";

export interface FluidDexCutoffV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}
export interface FluidDexObservationV1 {
  readonly kind: "log";
  readonly cutoff: FluidDexCutoffV1;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly target: string;
  readonly topic: Hash;
  readonly rawLocatorHash: Hash;
}
export interface FluidDexCandidateV1 {
  readonly target: string;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly evidence: FluidDexObservationV1;
}
export interface FluidDexIdentityReadFactsV1 {
  readonly cutoff: FluidDexCutoffV1;
  readonly target: string;
  readonly reverseTarget: string;
  readonly inputAsset: string;
  readonly outputAsset: string;
}
export interface FluidDexIdentityV1 {
  readonly cutoff: FluidDexCutoffV1;
  readonly candidateSnapshotHash: Hash;
  readonly instanceKey: string;
  readonly factsHash: Hash;
  readonly facts: Readonly<{ target: string; inputAsset: string; outputAsset: string }>;
}
export interface FluidDexStateReadFactsV1 {
  readonly cutoff: FluidDexCutoffV1;
  readonly instanceKey: string;
  readonly reserveIn: string;
  readonly reserveOut: string;
}
export interface FluidDexMaterializedStateV1 extends FluidDexStateReadFactsV1 {
  readonly identityFactsHash: Hash;
  readonly stateHash: Hash;
}
export interface FluidDexRouteV1 {
  readonly instanceKey: string;
  readonly inputAsset: string;
  readonly outputAsset: string;
  readonly routeBindingHash: Hash;
}
export interface FluidDexQuoteV1 {
  readonly cutoff: FluidDexCutoffV1;
  readonly routeBindingHash: Hash;
  readonly amountIn: string;
  readonly observedAmountOut: string;
  readonly quoteHash: Hash;
}
export interface FluidDexActionV1 {
  readonly cutoff: FluidDexCutoffV1;
  readonly target: string;
  readonly calldata: string;
  readonly exactQuoteHash: Hash;
  readonly actionHash: Hash;
}
export interface FluidDexExecutionIntentV1 {
  readonly kind: "fluid-dex-execution-intent";
  readonly cutoff: FluidDexCutoffV1;
  readonly target: string;
  readonly calldata: string;
  readonly actionHash: Hash;
  readonly exactQuoteHash: Hash;
}

export function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("fluid-dex address must be 20 bytes");
  return `0x${value.slice(2).toLowerCase()}`;
}
export function assertCutoff(value: FluidDexCutoffV1): FluidDexCutoffV1 {
  if (!/^\d+$/.test(value.chainId)
    || !/^\d+$/.test(value.number)
    || !/^0x[0-9a-f]{64}$/.test(value.hash)
    || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) {
    throw new TypeError("fluid-dex cutoff is not canonical");
  }
  return Object.freeze({ ...value });
}
export function cutoffEqual(left: FluidDexCutoffV1, right: FluidDexCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number
    && left.hash === right.hash && left.stateRoot === right.stateRoot;
}
export function familyCandidateKey(instanceNominationKey: string): Hash {
  return hashDomain("aloha/family-candidate/v1", {
    family: FLUID_DEX_FAMILY_ID,
    instanceNominationKey,
  });
}
