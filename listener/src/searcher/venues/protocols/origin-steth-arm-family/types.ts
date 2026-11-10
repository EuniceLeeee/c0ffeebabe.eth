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
import type { OriginStethArmDirection } from "./codec.js";

export interface OriginStethArmCandidate extends FamilyCandidate {
  readonly candidateKind: "origin-steth-arm";
  readonly target: string;
}

export interface OriginStethArmIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly weth: string;
  readonly steth: string;
  readonly implementation: string;
  readonly proxyCodeHash: string;
  readonly implementationCodeHash: string;
  readonly stethCodeHash: string;
  readonly wethCodeHash: string;
}

export interface OriginStethArmDescriptor extends CompiledInstanceDescriptor {
  /** ARM proxy address (call target; storage lives here). */
  readonly target: string;
  /** WETH — immutable token0 of the verified implementation. */
  readonly weth: string;
  /** stETH — immutable token1 of the verified implementation. */
  readonly steth: string;
  readonly implementation: string;
  readonly proxyCodeHash: string;
  readonly implementationCodeHash: string;
  readonly stethCodeHash: string;
  readonly wethCodeHash: string;
}

export interface OriginStethArmRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: OriginStethArmDirection;
  readonly adapterId: "origin-steth-arm-swap";
}

export interface OriginStethArmPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly weth: string;
  readonly steth: string;
  readonly routes: readonly OriginStethArmRoute[];
}

interface OriginStethArmIdentityBase {
  readonly source: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly implementation: string;
  readonly stethCodeHash: string;
  readonly wethCodeHash: string;
}

export type OriginStethArmIdentityEvidence =
  | ({ readonly phase: "proxy" } & OriginStethArmIdentityBase)
  | ({
      readonly phase: "binding";
      readonly implementationCodeHash: string;
      readonly traderate0: bigint;
      readonly traderate1: bigint;
    } & OriginStethArmIdentityBase)
  | ({
      readonly phase: "verified";
      readonly implementationCodeHash: string;
      readonly traderate0: bigint;
      readonly traderate1: bigint;
      readonly behaviorValid: boolean;
      readonly behaviorProofHash: string;
    } & OriginStethArmIdentityBase);

export interface OriginStethArmExactEvidence {
  readonly kind: "origin-steth-arm-linear-price";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly direction: OriginStethArmDirection;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly rate: bigint;
  readonly rateSlot: string;
  readonly bindingFingerprint: string;
}
