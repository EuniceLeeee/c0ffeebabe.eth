import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

/**
 * Opaque release-owned ports.  Their issuers and readers live below
 * `internal/`; callers cannot mint a material source or a common-envelope
 * authority by constructing a DTO with the same shape.
 */
export type PredicateMaterialSourcePortV1 = object;
export type CommonEnvelopeAuthorityPortV1 = object;
export type PredicateDomainMaterialCapabilityV1 = object;
export type AssembledReleaseInvocationSetCapabilityV1 = object;

export const PREDICATE_MATERIAL_PROVIDER_CONTRACT_VERSION = "1.0.0" as const;

export type PredicateMaterialUnavailableCodeV1 =
  | "owner-port-missing"
  | "owner-material-missing"
  | "owner-material-invalid"
  | "predicate-artifact-closure-missing"
  | "common-envelope-authority-missing"
  | "common-envelope-material-missing"
  | "common-envelope-material-invalid";

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
}
export interface AssembledPredicateEvaluationV1 {
  readonly predicateId: string;
  readonly status: "evaluated" | "missing" | "invalid";
  readonly unavailableCode: PredicateMaterialUnavailableCodeV1 | null;
  readonly verdict: "pass" | "fail" | "invalid" | null;
  readonly certificateId: Hash | null;
}
