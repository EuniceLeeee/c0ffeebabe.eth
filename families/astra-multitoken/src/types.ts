import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { EffectTransportDeclarationV1 } from "../../../packages/execution-program/src/index.ts";

export type Address = `0x${string}`;

export interface SourceAnchorV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface AstraObservationV1 {
  readonly kind: "call" | "log" | "address-surface";
  readonly target: string;
  /** The outer observed caller; required for call candidates. */
  readonly sender?: Address;
  readonly source: SourceAnchorV1;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly dataHex?: string;
  readonly topics?: readonly string[];
}

export interface AstraCandidateV1 {
  readonly target: Address;
  readonly actor: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly observedAmountOut: bigint | null;
  readonly sourceKind: "observed-change-call" | "change-log";
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly source: SourceAnchorV1;
}

export interface AstraIdentityReadsV1 {
  readonly target: Address;
  readonly tokens: readonly Address[];
  readonly tokenCodeHashes: readonly Hash[];
  readonly weights: readonly bigint[];
  readonly changesEnabled: boolean;
  readonly totalPercents: bigint;
  readonly changeFee: bigint;
  readonly inLendingMode: bigint | null;
  readonly activeQuote: bigint;
  readonly source: SourceAnchorV1;
}

export interface AstraIdentityV1 {
  readonly actor: Address;
  readonly target: Address;
  readonly tokens: readonly Address[];
  readonly tokenCodeHashes: readonly Hash[];
  readonly weights: readonly bigint[];
  readonly changesEnabled: true;
  readonly totalPercents: bigint;
  readonly changeFee: bigint;
  readonly inLendingMode: bigint | null;
  readonly activeQuote: bigint;
  readonly source: SourceAnchorV1;
  readonly factsHash: Hash;
  readonly instanceKey: string;
}

export interface AstraInstanceV1 {
  readonly familyId: "astra-multitoken";
  readonly instanceKey: string;
  readonly target: Address;
  readonly identity: AstraIdentityV1;
  readonly runtimeRequirements: readonly string[];
}

export interface AstraRouteV1 {
  readonly routeKey: string;
  readonly instanceKey: string;
  readonly target: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly pairIndex: number;
  readonly bindingFingerprint: Hash;
}

export interface AstraQuoteV1 {
  readonly source: SourceAnchorV1;
  readonly routeKey: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly quoteHash: Hash;
}

export interface AstraExactV1 extends AstraQuoteV1 {
  readonly effectHash: Hash;
  readonly obligations: readonly string[];
}

export interface AstraActionV1 {
  readonly target: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly calldata: string;
  readonly actionHash: Hash;
  /** Generic transport projection; central code never imports Astra. */
  readonly effectTransport: EffectTransportDeclarationV1;
}
