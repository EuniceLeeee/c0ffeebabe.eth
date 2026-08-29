import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { familyCandidateKey as centralFamilyCandidateKey, type SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import { UNIV3_STANDARD_FAMILY_AUTHORING_HASH } from "./family-definition.ts";

export interface UniV3CutoffV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface UniV3EvidenceV1 {
  readonly kind: "log" | "call" | "address-surface";
  readonly cutoff: UniV3CutoffV1;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly target: string;
  readonly topic0?: Hash;
  readonly rawLocatorHash: Hash;
  readonly selector?: string;
}

export interface UniV3CandidateV1 {
  readonly target: string;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly evidence: UniV3EvidenceV1 | UniV3SourceEvidenceV1;
}

export interface UniV3SourceEvidenceV1 {
  readonly kind: "source-plan";
  readonly cutoff: UniV3CutoffV1;
  readonly target: string;
  readonly source: SourcePlanEvidenceRefV1;
}

export interface UniV3IdentityReadFactsV1 {
  readonly cutoff: UniV3CutoffV1;
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: string;
  readonly tickSpacing: number;
  readonly reversePool: string;
}

export interface UniV3IdentityV1 {
  readonly cutoff: UniV3CutoffV1;
  readonly candidateSnapshotHash: Hash;
  readonly facts: {
    readonly pool: string;
    readonly factory: string;
    readonly token0: string;
    readonly token1: string;
    readonly fee: string;
    readonly tickSpacing: number;
    readonly reversePool: string;
  };
  readonly factsHash: Hash;
  readonly instanceKey: string;
}

export interface UniV3TickBitmapWordV1 {
  readonly word: number;
  readonly bits: string;
}

export interface UniV3TickLiquidityV1 {
  readonly tick: number;
  readonly liquidityNet: string;
}

export interface UniV3StateReadFactsV1 {
  readonly cutoff: UniV3CutoffV1;
  readonly pool: string;
  readonly sqrtPriceX96: string;
  readonly tick: number;
  readonly liquidity: string;
  readonly fee: string;
  readonly tickSpacing: number;
  readonly tickBitmap: readonly UniV3TickBitmapWordV1[];
  readonly ticks: readonly UniV3TickLiquidityV1[];
  /** Current-source quoter result for this route amount when the factory has a bound quoter. */
  readonly exactAmountOut?: string;
}

export interface UniV3MaterializedStateV1 extends UniV3StateReadFactsV1 {
  readonly identityFactsHash: Hash;
  readonly stateHash: Hash;
}

export interface UniV3RouteV1 {
  readonly instanceKey: string;
  readonly inputToken: string;
  readonly outputToken: string;
  readonly zeroForOne: boolean;
  readonly routeBindingHash: Hash;
}

export interface UniV3QuoteV1 {
  readonly cutoff: UniV3CutoffV1;
  readonly routeBindingHash: Hash;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly stateHash: Hash;
  readonly quoteHash: Hash;
}

export interface UniV3ActionV1 {
  readonly cutoff: UniV3CutoffV1;
  readonly routeBindingHash: Hash;
  readonly exactQuoteHash: Hash;
  readonly target: string;
  readonly selector: string;
  readonly calldata: string;
  readonly actionHash: Hash;
}

export interface UniV3ExecutionIntentV1 {
  readonly kind: "univ3-execution-intent";
  readonly cutoff: UniV3CutoffV1;
  readonly target: string;
  readonly calldata: string;
  readonly actionHash: Hash;
  readonly exactQuoteHash: Hash;
}

export interface UniV3ObservationV1 {
  readonly kind: "log" | "call" | "address-surface";
  readonly target: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly topic0?: Hash;
  readonly selector?: string;
  readonly rawLocatorHash: Hash;
  readonly cutoff: UniV3CutoffV1;
}

export function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("univ3 address must be 20 bytes");
  return `0x${value.slice(2).toLowerCase()}`;
}

export function sameAddress(left: string, right: string): boolean {
  return canonicalAddress(left) === canonicalAddress(right);
}

export function cutoffEqual(left: UniV3CutoffV1, right: UniV3CutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

export function assertCutoff(value: UniV3CutoffV1): UniV3CutoffV1 {
  if (!/^\d+$/.test(value.chainId) || !/^\d+$/.test(value.number)) throw new TypeError("univ3 cutoff numbers must be decimal strings");
  canonicalAddress("0x0000000000000000000000000000000000000000");
  if (!/^0x[0-9a-f]{64}$/.test(value.hash) || !/^0x[0-9a-f]{64}$/.test(value.stateRoot)) throw new TypeError("univ3 cutoff hashes must be canonical");
  return Object.freeze({ ...value });
}

export function assertDecimal(value: string, label: string): string {
  if (!/^\d+$/.test(value)) throw new TypeError(`${label} must be an unsigned decimal string`);
  return value;
}

export function familyCandidateKey(instanceNominationKey: string): Hash {
  return centralFamilyCandidateKey(UNIV3_STANDARD_FAMILY_AUTHORING_HASH, instanceNominationKey);
}
