import { types as nodeTypes } from "node:util";
import { CANONICAL_LIMITS, hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { ObservedContentArtifactV1 } from "../content-addressed-sink.ts";
import {
  PREDICATE_MATERIAL_PROVIDER_CONTRACT_VERSION,
  type PredicateDomainMaterialCapabilityV1,
  type PredicateDomainMaterialV1,
  type PredicateMaterialProviderV1,
  type PredicateMaterialSourcePortV1,
  type PredicateMaterialUnavailableCodeV1,
} from "../../../gate-core/src/material-provider.ts";
import {
  issuePredicateDomainMaterialCapabilityV1,
} from "../../../gate-core/src/internal/predicate-domain-material-issuer.ts";
import {
  assertProductionPredicateMaterialSourcePortV1,
} from "../internal/predicate-material-source-owner.ts";

export function providerContractDigest(predicateId: string): Hash {
  return hashDomain("aloha/predicate-material-provider-contract/v1", {
    version: PREDICATE_MATERIAL_PROVIDER_CONTRACT_VERSION,
    predicateId,
    output: "opaque-domain-material-capability",
    unavailable: "typed-missing-or-invalid",
  });
}

export function unavailable(
  predicateId: string,
  status: "missing" | "invalid",
  code: PredicateMaterialUnavailableCodeV1,
  detail: unknown,
): PredicateDomainMaterialCapabilityV1 {
  return issuePredicateDomainMaterialCapabilityV1(Object.freeze({
    status,
    predicateId,
    code,
    evidenceRoot: hashDomain("aloha/predicate-material-unavailable/v1", { predicateId, status, code, detail }),
  }));
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  return Object.freeze([...new Map(values.map(value => [key(value), value] as const)).values()]);
}

export function available(
  predicateId: string,
  candidateReleaseCommit: string,
  artifacts: readonly ObservedContentArtifactV1[],
  resolverPolicies: PredicateDomainMaterialV1["resolverPolicies"],
  predicateFacts: PredicateDomainMaterialV1["predicateFacts"],
): PredicateDomainMaterialCapabilityV1 {
  if (!/^[0-9a-f]{40}$/.test(candidateReleaseCommit)) {
    return unavailable(predicateId, "invalid", "owner-material-invalid", "candidate-release-commit");
  }
  const refs = uniqueBy(artifacts.map(value => value.ref), value => value.artifactRefId);
  const claims = uniqueBy(artifacts.map(value => value.claim), value => value.claimId);
  const leases = uniqueBy(artifacts.map(value => value.lease), value => value.receiptId);
  const policies = uniqueBy(resolverPolicies, value => value.policyHash);
  if (refs.length !== artifacts.length || claims.length !== artifacts.length
    || refs.some(ref => !policies.some(policy => policy.policyHash === ref.resolverPolicyHash))) {
    return unavailable(predicateId, "invalid", "owner-material-invalid", "artifact-closure");
  }
  if (predicateFacts !== null && typeof predicateFacts === "object" && nodeTypes.isProxy(predicateFacts)) {
    return unavailable(predicateId, "invalid", "owner-material-invalid", "predicate-facts-proxy");
  }
  if (!Array.isArray(predicateFacts)) {
    return unavailable(predicateId, "invalid", "owner-material-invalid", "predicate-facts-array");
  }
  const facts: unknown[] = [];
  const length = Object.getOwnPropertyDescriptor(predicateFacts, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > CANONICAL_LIMITS.maxArrayItems) {
    return unavailable(predicateId, "invalid", "owner-material-invalid", "predicate-facts-length");
  }
  const keys = Reflect.ownKeys(predicateFacts);
  if (keys.length !== length + 1
    || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    return unavailable(predicateId, "invalid", "owner-material-invalid", "predicate-facts-dense-array");
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(predicateFacts, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return unavailable(predicateId, "invalid", "owner-material-invalid", `predicate-facts-data-property:${index}`);
    }
    facts.push(descriptor.value);
  }
  return issuePredicateDomainMaterialCapabilityV1(Object.freeze({
    status: "available",
    predicateId,
    candidateReleaseCommit,
    artifactRefs: refs,
    artifactClaims: claims,
    resolverPolicies: policies,
    retentionLeases: leases,
    predicateFacts: Object.freeze(facts),
  }));
}

export function defineProvider(
  predicateId: string,
  provide: (source: PredicateMaterialSourcePortV1) => Promise<PredicateDomainMaterialCapabilityV1>,
): PredicateMaterialProviderV1 {
  return Object.freeze({
    predicateId,
    providerContractVersion: PREDICATE_MATERIAL_PROVIDER_CONTRACT_VERSION,
    providerContractDigest: providerContractDigest(predicateId),
    async provide(source: PredicateMaterialSourcePortV1) {
      assertProductionPredicateMaterialSourcePortV1(source);
      return provide(source);
    },
  });
}
