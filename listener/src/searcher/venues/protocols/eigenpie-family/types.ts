import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type {
  FamilyId,
  InstanceKey,
  LineageId,
} from "../../adapter-family-identifiers.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export interface EigenpieCandidate extends FamilyCandidate {
  readonly candidateKind: "eigenpie-deposit-pair";
  readonly target: string;
  readonly actor: string;
  readonly tokenIn: string;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly observedAmountOut: bigint | null;
  readonly transactionHash: string | null;
}

export interface EigenpieQuoteEvidence {
  readonly phase: "quote";
  readonly targetCodeHash: string;
  readonly tokenInCodeHash: string;
  readonly target: string;
  readonly actor: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export interface EigenpieActiveEvidence
  extends Omit<EigenpieQuoteEvidence, "phase"> {
  readonly phase: "active";
  readonly tokenOutCodeHash: string;
  readonly behaviorProofHash: string;
  readonly active: boolean;
}

export type EigenpieIdentityEvidence =
  | EigenpieQuoteEvidence
  | EigenpieActiveEvidence;

export interface EigenpieIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly sampleAmountIn: bigint;
}

export interface EigenpieDescriptor extends CompiledInstanceDescriptor {
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly sampleAmountIn: bigint;
}

export interface EigenpieRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "deposit-asset";
  readonly adapterId: "eigenpie-deposit-asset";
}

export interface EigenpiePricingDraft {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly route: EigenpieRoute;
}

export interface EigenpiePricingDescriptor extends EigenpiePricingDraft {
  readonly oneAsset: bigint;
}

export interface EigenpieExactEvidence {
  readonly kind: "eigenpie-pair-quote";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
}
