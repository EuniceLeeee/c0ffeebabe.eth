import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export type CurvePlainMode = "received" | "received-no-receiver" | "exchange" | "received-uint";
export type CurveIndexAbi = "int128" | "uint256";
export interface CurvePlainCandidate extends FamilyCandidate {
  readonly candidateKind: "curve-plain-pool";
  readonly pool: string;
  readonly hintedI: number | null;
  readonly hintedJ: number | null;
}
export interface CurvePlainDirection {
  readonly i: number;
  readonly j: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executionMode: CurvePlainMode;
}
export interface CurvePlainBinding {
  readonly quoteAbi: CurveIndexAbi;
  readonly coinAbi: CurveIndexAbi;
  readonly balanceAbi: CurveIndexAbi;
  readonly registry: string;
  readonly handlers: readonly string[];
  readonly codeHash: string;
  readonly coins: readonly string[];
  readonly decimals: readonly number[];
}
export interface CurvePlainIdentity extends VerifiedIdentity {
  readonly facts: {
    readonly pool: string;
    readonly binding: CurvePlainBinding;
    readonly directions: readonly CurvePlainDirection[];
  };
}
export interface CurvePlainDescriptor extends CompiledInstanceDescriptor {
  readonly pool: string;
  readonly binding: CurvePlainBinding;
  readonly directions: readonly CurvePlainDirection[];
}
export interface CurvePlainRoute extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly i: number;
  readonly j: number;
  readonly executionMode: CurvePlainMode;
  readonly quoteAbi: CurveIndexAbi;
}
export interface CurvePlainPricingDescriptor {
  readonly instance: CurvePlainDescriptor;
  readonly route: CurvePlainRoute;
}
export interface CurvePlainPricingSnapshot {
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly balanceIn: bigint;
  readonly balanceOut: bigint;
  readonly amplification: bigint;
  readonly fee: bigint;
}
export interface CurvePlainExactEvidence {
  readonly kind: "curve-plain-get-dy";
  readonly quoteAbi: CurveIndexAbi;
  readonly source: CanonicalSource;
  readonly binding: string;
  readonly routeKey: CurvePlainRoute["routeKey"];
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}
