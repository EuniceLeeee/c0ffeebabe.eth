import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { UNIV4_FAMILY_ID } from "./manifest.ts";
import type { Univ4PoolKey } from "./abi.ts";

export type { Univ4PoolKey } from "./abi.ts";

export interface Univ4CutoffV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}
export interface Univ4ObservationV1 {
  readonly kind: "log";
  readonly cutoff: Univ4CutoffV1;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly target: string;
  readonly topic: Hash;
  readonly rawLocatorHash: Hash;
}
export interface Univ4CandidateV1 {
  readonly target: string;
  /** PoolManager is the execution target; poolId is the instance identity. */
  readonly poolId: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly evidence: Univ4ObservationV1;
}
export interface Univ4IdentityReadFactsV1 {
  readonly cutoff: Univ4CutoffV1;
  readonly target: string;
  readonly reverseTarget: string;
  readonly inputAsset: string;
  readonly outputAsset: string;
  /** Reverse-verified PoolKey identity from an Initialize/manager witness. */
  readonly poolId: Hash;
  readonly poolKey: Univ4PoolKey;
  readonly managerBinding: Univ4ManagerBindingV1;
}
export interface Univ4ManagerBindingV1 {
  readonly manager: string;
  readonly stateView: string;
  readonly quoter: string;
}
export interface Univ4IdentityV1 {
  readonly cutoff: Univ4CutoffV1;
  readonly candidateSnapshotHash: Hash;
  readonly instanceKey: string;
  readonly factsHash: Hash;
  readonly facts: Readonly<{
    target: string;
    inputAsset: string;
    outputAsset: string;
    poolId: Hash;
    poolKey: Univ4PoolKey;
    managerBinding: Univ4ManagerBindingV1;
  }>;
}
export interface Univ4StateReadFactsV1 {
  readonly cutoff: Univ4CutoffV1;
  readonly instanceKey: string;
  readonly reserveIn: string;
  readonly reserveOut: string;
}
export interface Univ4MaterializedStateV1 extends Univ4StateReadFactsV1 {
  readonly identityFactsHash: Hash;
  readonly stateHash: Hash;
}
export interface Univ4RouteV1 {
  readonly instanceKey: string;
  readonly inputAsset: string;
  readonly outputAsset: string;
  readonly routeBindingHash: Hash;
}
export interface Univ4QuoteV1 {
  readonly cutoff: Univ4CutoffV1;
  readonly routeBindingHash: Hash;
  readonly amountIn: string;
  readonly observedAmountOut: string;
  readonly quoteHash: Hash;
}
export interface Univ4ActionV1 {
  readonly cutoff: Univ4CutoffV1;
  readonly target: string;
  readonly calldata: string;
  readonly exactQuoteHash: Hash;
  readonly actionHash: Hash;
}
export interface Univ4ExecutionIntentV1 {
  readonly kind: "univ4-execution-intent";
  readonly cutoff: Univ4CutoffV1;
  readonly target: string;
  readonly calldata: string;
  readonly actionHash: Hash;
  readonly exactQuoteHash: Hash;
}

export function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("univ4 address must be 20 bytes");
  return `0x${value.slice(2).toLowerCase()}`;
}
export function assertCutoff(value: Univ4CutoffV1): Univ4CutoffV1 {
  if (!/^\d+$/.test(value.chainId)
    || !/^\d+$/.test(value.number)
    || !/^0x[0-9a-f]{64}$/.test(value.hash)
    || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) {
    throw new TypeError("univ4 cutoff is not canonical");
  }
  return Object.freeze({ ...value });
}
export function cutoffEqual(left: Univ4CutoffV1, right: Univ4CutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number
    && left.hash === right.hash && left.stateRoot === right.stateRoot;
}
export function familyCandidateKey(instanceNominationKey: string): Hash {
  return hashDomain("aloha/family-candidate/v1", {
    family: UNIV4_FAMILY_ID,
    instanceNominationKey,
  });
}
