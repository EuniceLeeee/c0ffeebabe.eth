import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { ArtifactResolutionClaimV1, ResolverPolicyV1, RetentionLeaseReceiptV1 } from "../../../../specs/artifact-resolution/src/index.ts";
import type { ReadOnlyArtifactRefV1 } from "../../../../specs/core-envelope/src/index.ts";
import type {
  PredicateDomainMaterialCapabilityV1,
  PredicateMaterialUnavailableCodeV1,
} from "../material-provider.ts";

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

export type PredicateDomainMaterialStateV1 =
  | PredicateDomainMaterialV1
  | PredicateDomainMaterialUnavailableV1;

const domainMaterial = new WeakMap<object, PredicateDomainMaterialStateV1>();

export function registerPredicateDomainMaterialCapabilityV1(
  state: PredicateDomainMaterialStateV1,
): PredicateDomainMaterialCapabilityV1 {
  const capability = Object.freeze(Object.create(null)) as object;
  domainMaterial.set(capability, state);
  return capability;
}

export function readPredicateDomainMaterialCapabilityV1(
  capability: PredicateDomainMaterialCapabilityV1,
): PredicateDomainMaterialStateV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("predicate domain material capability is invalid");
  }
  const state = domainMaterial.get(capability);
  if (state === undefined) throw new TypeError("predicate domain material capability was not provider-issued");
  return state;
}
