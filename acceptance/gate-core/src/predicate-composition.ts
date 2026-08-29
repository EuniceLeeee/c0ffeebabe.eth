import type {
  ArtifactResolutionClaimV1,
  ResolverPolicyV1,
  RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import type {
  ReadOnlyArtifactRefV1,
} from "../../../specs/core-envelope/src/index.ts";
import type {
  PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import type {
  GateReasonCode,
  GateVerdict,
} from "./predicate-contract.ts";
import type { PredicateMaterialProviderV1 } from "./material-provider.ts";

/**
 * A predicate adapter is the only place that knows a predicate's typed live
 * fact bundle. Qualification corpora and oracles run offline; the adapter is
 * selected by the trusted release binding, never by caller input or a
 * producer verdict.
 */
export interface PredicateIssueSinkV1 {
  add(code: GateReasonCode, path: string): void;
}

export interface PredicateRuntimeFactsV1 {
  readonly facts: readonly unknown[];
  readonly refs: readonly ReadOnlyArtifactRefV1[];
  readonly claims: readonly ArtifactResolutionClaimV1[];
  readonly policies: readonly ResolverPolicyV1[];
  readonly leases: readonly RetentionLeaseReceiptV1[];
  readonly observations: readonly {
    readonly observationId: string;
    readonly rawArtifactRefs: readonly ReadOnlyArtifactRefV1[];
    readonly observedClaimIds: readonly string[];
  }[];
  /** Narrow projection assembled only after GateCore verifies the signed
   * observer invocation, its registry key and the subject-artifact ref closure. */
  readonly trustedObserverInvocation?: Readonly<{
    readonly keyId: Hash;
    readonly observerQualificationId: Hash;
    readonly roleId: string;
    readonly authenticatedArtifactRefIds: readonly Hash[];
    readonly candidateReleaseCommit: string;
  }> | null;
  /** Selected-predicate authority artifacts are pinned by the externally
   * signed GateCore authority.  The generic core verifies only this neutral
   * content-addressed envelope; the selected predicate owns its role/schema
   * semantics. */
  readonly trustedPredicateAuthority?: SelectedPredicateAuthorityEntryV1;
  /** Neutral projection of the externally signed release requirement set.
   * GateCore exposes it only after the V3 approval signature and the selected
   * requirement have both verified. Predicate adapters may join related
   * qualification identities without accepting caller-reported digests. */
  readonly trustedReleaseQualificationBindings?: readonly Readonly<{
    readonly predicateId: string;
    readonly predicateSpecDigest: Hash;
    readonly verifierQualificationId: Hash;
  }>[];
}

export interface PredicateAuthorityArtifactBindingV1 {
  readonly roleId: string;
  readonly artifactRefId: Hash;
  readonly contentSha256: Hash;
  readonly schema: Readonly<{
    readonly id: string;
    readonly version: string;
    readonly schemaHash: Hash;
  }>;
}

/** One authority entry for the selected predicate only.  There is no global
 * predicate map here, so adding an unrelated predicate cannot change this
 * predicate's authority entry or qualification leaf. */
export interface SelectedPredicateAuthorityEntryV1 {
  readonly predicateId: string;
  readonly artifactBindings: readonly PredicateAuthorityArtifactBindingV1[];
  readonly bindingSetRoot: Hash;
}

export interface PredicateEvaluatorV1 {
  readonly predicateId: string;
  /** Shared GateCore input-envelope role contract implemented by the spec. */
  readonly commonEnvelopeRoleContractVersion: string;
  /** Versioned plugin-owned adapter contract identity. */
  readonly adapterVersion: string;
  readonly predicateSpec: PredicateSpecV1;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;

  /** Decode and evaluate only the typed live facts for this predicate. */
  readonly evaluateLive: (
    facts: PredicateRuntimeFactsV1,
    issues: PredicateIssueSinkV1,
  ) => GateVerdict;
}

/**
 * Generator-owned release identity around one concrete evaluator. The
 * evaluator owns semantics; it cannot self-report which named predicate or
 * oracle exports the reviewed release selected.
 */
export interface PredicateCompositionBindingV1 {
  readonly predicateId: string;
  readonly commonEnvelopeRoleContractVersion: string;
  readonly predicateSpecDigest: Hash;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  readonly adapterVersion: string;
  readonly oracleVersion: string;
  readonly compositionLeafDigest: Hash;
  readonly predicateImplementationExportDigest: Hash;
  readonly oracleImplementationExportDigest: Hash;
  readonly materialProviderContractDigest: Hash;
  readonly materialProviderImplementationExportDigest: Hash;
  readonly evaluator: PredicateEvaluatorV1;
  readonly materialProvider: PredicateMaterialProviderV1;
}

/** Trusted release binding supplied by the package wrapper, never by input. */
export interface PredicateCompositionPortV1 {
  readonly rootDigest: Hash;
  readonly resolve: (predicateId: string) => PredicateCompositionBindingV1 | null;
}
