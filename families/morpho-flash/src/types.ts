import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { MORPHO_FLASH_FAMILY_ID } from "./manifest.ts";

export interface MorphoFlashCutoffV1 { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }
export interface MorphoFlashObservationV1 { readonly kind: "log"; readonly cutoff: MorphoFlashCutoffV1; readonly blockNumber: string; readonly blockHash: Hash; readonly txHash: Hash; readonly logIndex: string; readonly target: string; readonly topic: Hash; readonly rawLocatorHash: Hash }
export interface MorphoFlashCandidateV1 { readonly target: string; readonly instanceNominationKey: string; readonly candidateSnapshotHash: Hash; readonly cutoff: MorphoFlashCutoffV1 }
export interface MorphoFlashIdentityReadFactsV1 {
  readonly cutoff: MorphoFlashCutoffV1;
  readonly target: string;
  readonly reverseLender: string;
  readonly asset: string;
  readonly receiver: string;
  readonly assetHasCode: boolean;
  readonly receiverHasCode: boolean;
  readonly feeBps: string;
}
export interface MorphoFlashIdentityV1 {
  readonly cutoff: MorphoFlashCutoffV1;
  readonly candidateSnapshotHash: Hash;
  readonly instanceKey: string;
  readonly factsHash: Hash;
  readonly facts: Readonly<{ lender: string; asset: string; receiver: string; feeBps: string }>;
}
export interface MorphoFlashStateReadFactsV1 { readonly cutoff: MorphoFlashCutoffV1; readonly instanceKey: string; readonly availableLiquidity: string }
export interface MorphoFlashMaterializedStateV1 extends MorphoFlashStateReadFactsV1 { readonly identityFactsHash: Hash; readonly stateHash: Hash }
export interface MorphoFlashRouteV1 { readonly instanceKey: string; readonly lender: string; readonly asset: string; readonly receiver: string; readonly routeBindingHash: Hash }
export interface MorphoFlashQuoteV1 { readonly cutoff: MorphoFlashCutoffV1; readonly routeBindingHash: Hash; readonly amountIn: string; readonly repaymentAmount: string; readonly quoteHash: Hash }
export interface MorphoFlashActionV1 {
  readonly cutoff: MorphoFlashCutoffV1;
  readonly target: string;
  readonly calldata: string;
  readonly exactQuoteHash: Hash;
  readonly actionIntentHash: Hash;
  readonly obligation: import("../../../packages/funding/src/index.ts").FundingRepaymentObligationV1;
  readonly actionHash: Hash;
}
export interface MorphoFlashExecutionIntentV1 { readonly kind: "morpho-flash-execution-intent"; readonly cutoff: MorphoFlashCutoffV1; readonly target: string; readonly calldata: string; readonly actionHash: Hash; readonly exactQuoteHash: Hash; readonly obligationHash: Hash; readonly expectedEffects: readonly MorphoFlashEffectV1[] }
export interface MorphoFlashEffectV1 { readonly asset: string; readonly account: "lender" | "receiver"; readonly direction: "decrease" | "increase"; readonly amount: string }

export function canonicalAddress(value: string): string { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("morpho-flash address must be 20 bytes"); return `0x${value.slice(2).toLowerCase()}`; }
export function assertCutoff(value: MorphoFlashCutoffV1): MorphoFlashCutoffV1 { if (!/^\d+$/.test(value.chainId) || !/^\d+$/.test(value.number) || !/^0x[0-9a-f]{64}$/.test(value.hash) || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) throw new TypeError("morpho-flash cutoff is not canonical"); return Object.freeze({ ...value }); }
export function cutoffEqual(left: MorphoFlashCutoffV1, right: MorphoFlashCutoffV1): boolean { return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot; }
export function familyCandidateKey(instanceNominationKey: string): Hash { return hashDomain("aloha/family-candidate/v1", { family: MORPHO_FLASH_FAMILY_ID, instanceNominationKey }); }
