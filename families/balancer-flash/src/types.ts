import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { FundingRepaymentObligationV1 } from "../../../packages/funding/src/index.ts";
import { BALANCER_FLASH_FAMILY_ID } from "./manifest.ts";

export interface BalancerFlashCutoffV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}
export interface BalancerFlashObservationV1 {
  readonly kind: "log";
  readonly cutoff: BalancerFlashCutoffV1;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly target: string;
  readonly topic: Hash;
  readonly rawLocatorHash: Hash;
}
export interface BalancerFlashCandidateV1 {
  readonly target: string;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly cutoff: BalancerFlashCutoffV1;
}
export interface BalancerFlashIdentityReadFactsV1 {
  readonly cutoff: BalancerFlashCutoffV1;
  readonly target: string;
  readonly reverseTarget: string;
  readonly inputAsset: string;
  readonly outputAsset: string;
}
export interface BalancerFlashIdentityV1 {
  readonly cutoff: BalancerFlashCutoffV1;
  readonly candidateSnapshotHash: Hash;
  readonly instanceKey: string;
  readonly factsHash: Hash;
  readonly facts: Readonly<{ target: string; inputAsset: string; outputAsset: string }>;
}
export interface BalancerFlashStateReadFactsV1 {
  readonly cutoff: BalancerFlashCutoffV1;
  readonly instanceKey: string;
  readonly reserveIn: string;
  readonly reserveOut: string;
}
export interface BalancerFlashMaterializedStateV1 extends BalancerFlashStateReadFactsV1 {
  readonly identityFactsHash: Hash;
  readonly stateHash: Hash;
}
export interface BalancerFlashRouteV1 {
  readonly instanceKey: string;
  readonly inputAsset: string;
  readonly outputAsset: string;
  readonly routeBindingHash: Hash;
}
export interface BalancerFlashQuoteV1 {
  readonly cutoff: BalancerFlashCutoffV1;
  readonly routeBindingHash: Hash;
  readonly amountIn: string;
  readonly observedAmountOut: string;
  readonly quoteHash: Hash;
}
export interface BalancerFlashActionV1 {
  readonly cutoff: BalancerFlashCutoffV1;
  readonly target: string;
  readonly calldata: string;
  readonly exactQuoteHash: Hash;
  readonly actionIntentHash: Hash;
  readonly obligation: FundingRepaymentObligationV1;
  readonly actionHash: Hash;
}
export interface BalancerFlashExecutionIntentV1 {
  readonly kind: "balancer-flash-execution-intent";
  readonly cutoff: BalancerFlashCutoffV1;
  readonly target: string;
  readonly calldata: string;
  readonly actionHash: Hash;
  readonly exactQuoteHash: Hash;
  readonly obligationHash: Hash;
  readonly expectedEffects: readonly BalancerFlashEffectV1[];
}
export interface BalancerFlashEffectV1 {
  readonly asset: string;
  readonly account: "lender" | "receiver";
  readonly direction: "decrease" | "increase";
  readonly amount: string;
}

export function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("balancer-flash address must be 20 bytes");
  return `0x${value.slice(2).toLowerCase()}`;
}
export function assertCutoff(value: BalancerFlashCutoffV1): BalancerFlashCutoffV1 {
  if (!/^\d+$/.test(value.chainId)
    || !/^\d+$/.test(value.number)
    || !/^0x[0-9a-f]{64}$/.test(value.hash)
    || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) {
    throw new TypeError("balancer-flash cutoff is not canonical");
  }
  return Object.freeze({ ...value });
}
export function cutoffEqual(left: BalancerFlashCutoffV1, right: BalancerFlashCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number
    && left.hash === right.hash && left.stateRoot === right.stateRoot;
}
export function familyCandidateKey(instanceNominationKey: string): Hash {
  return hashDomain("aloha/family-candidate/v1", {
    family: BALANCER_FLASH_FAMILY_ID,
    instanceNominationKey,
  });
}
