import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { ArtifactResolutionClaimV1, ResolverPolicyV1, RetentionLeaseReceiptV1 } from "../../../specs/artifact-resolution/src/index.ts";
import type { ReadOnlyArtifactRefV1 } from "../../../specs/core-envelope/src/index.ts";

/**
 * Opaque release-owned ports.  Their issuers and readers live below
 * `internal/`; callers cannot mint a material source or a common-envelope
 * authority by constructing a DTO with the same shape.
 */
export type PredicateMaterialSourcePortV1 = object;
export type CommonEnvelopeAuthorityPortV1 = object;
export type PredicateDomainMaterialCapabilityV1 = object;
export type AssembledReleaseInvocationSetCapabilityV1 = object;

export const PREDICATE_MATERIAL_PROVIDER_CONTRACT_VERSION = "2.0.0" as const;

export type PredicateMaterialUnavailableCodeV1 =
  | "owner-port-missing"
  | "owner-material-missing"
  | "owner-material-invalid"
  | "predicate-artifact-closure-missing"
  | "common-envelope-authority-missing"
  | "common-envelope-material-missing"
  | "common-envelope-material-invalid";

/** Inert material DTOs. Capability ownership and storage remain internal. */
export interface PredicateDomainMaterialV1 {
  readonly status: "available";
  readonly predicateId: string;
  readonly candidateReleaseCommit: string;
  readonly artifactRefs: readonly ReadOnlyArtifactRefV1[];
  readonly artifactClaims: readonly ArtifactResolutionClaimV1[];
  readonly resolverPolicies: readonly ResolverPolicyV1[];
  readonly retentionLeases: readonly RetentionLeaseReceiptV1[];
  readonly predicateFacts: readonly unknown[];
}

export interface PredicateDomainMaterialUnavailableV1 {
  readonly status: "missing" | "invalid";
  readonly predicateId: string;
  readonly code: PredicateMaterialUnavailableCodeV1;
  readonly evidenceRoot: Hash;
}

export type PredicateDomainMaterialStateV1 = PredicateDomainMaterialV1 | PredicateDomainMaterialUnavailableV1;

/** One generated binding invokes one fixed provider.  The source and result
 * are both opaque capabilities; no GateCoreInput-shaped public surface is
 * accepted or returned. */
export interface PredicateMaterialProviderV1 {
  readonly predicateId: string;
  readonly providerContractVersion: typeof PREDICATE_MATERIAL_PROVIDER_CONTRACT_VERSION;
  readonly providerContractDigest: Hash;
  readonly provide: (
    source: PredicateMaterialSourcePortV1,
  ) => Promise<PredicateDomainMaterialCapabilityV1>;
  /** Provider-owned reader for the opaque capability returned by `provide`.
   * Generic GateCore never imports the provider's capability state owner. */
  readonly read: (
    capability: PredicateDomainMaterialCapabilityV1,
  ) => PredicateDomainMaterialStateV1;
}
export interface AssembledPredicateEvaluationV1 {
  readonly predicateId: string;
  readonly status: "evaluated" | "missing" | "invalid";
  readonly unavailableCode: PredicateMaterialUnavailableCodeV1 | null;
  readonly verdict: "pass" | "fail" | "invalid" | null;
  readonly certificateId: Hash | null;
}
