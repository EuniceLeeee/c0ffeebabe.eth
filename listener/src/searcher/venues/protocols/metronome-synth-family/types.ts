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
import type { ProtocolPricingSnapshot } from "../standard-family/common.js";

export interface MetronomeSynthCandidate extends FamilyCandidate {
  readonly candidateKind: "metronome-synth-pool";
  readonly pool: string;
  readonly hintedTokens: readonly string[];
}

export interface MetronomeSynthDirection {
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export type MetronomeSynthIdentityEvidence =
  | {
      readonly phase: "membership";
      readonly pool: string;
      readonly tokens: readonly string[];
    }
  | {
      readonly phase: "active";
      readonly pool: string;
      readonly tokens: readonly string[];
      readonly directions: readonly MetronomeSynthDirection[];
      readonly behaviorProofHash: string;
    };

export interface MetronomeSynthIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly pool: string;
  readonly tokens: readonly string[];
  readonly directions: readonly MetronomeSynthDirection[];
}

export interface MetronomeSynthDescriptor extends CompiledInstanceDescriptor {
  readonly pool: string;
  readonly tokens: readonly string[];
  readonly directions: readonly MetronomeSynthDirection[];
  readonly oracleBinding: string;
}

export interface MetronomeSynthRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly adapterId: "metronome-synth-swap";
}

export interface MetronomeSynthPricingDraft {
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly tokens: readonly string[];
  readonly routes: readonly MetronomeSynthRoute[];
}

export interface MetronomeSynthPricingStaticEvidence {
  readonly oneTokens: readonly {
    readonly token: string;
    readonly amount: bigint;
  }[];
}

export interface MetronomeSynthPricingDescriptor
  extends MetronomeSynthPricingDraft, MetronomeSynthPricingStaticEvidence {}

export type MetronomeSynthPricingSnapshot = ProtocolPricingSnapshot;

export interface MetronomeSynthExactEvidence {
  readonly kind: "metronome-synth-quote";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly fee: bigint;
  readonly oracleBinding: string;
  readonly bindingFingerprint: string;
}
