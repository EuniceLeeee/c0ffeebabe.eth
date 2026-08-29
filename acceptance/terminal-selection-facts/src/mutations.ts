import {
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createArtifactResolutionClaim,
  createRetentionLeaseReceipt,
  decodeArtifactBytes,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import { createReadOnlyArtifactRef } from "../../../specs/core-envelope/src/index.ts";
import type { TerminalSelectionRuntimeFactsV1 } from "./predicate.ts";
import type { TerminalSelectionReferenceInputV1 } from "./reference-model.ts";
import {
  createTerminalSelectionFactV1,
  createTerminalSelectionMissingFactV1,
} from "./schema.ts";
import { TERMINAL_SELECTION_CRITICAL_MUTATION_IDS } from "./spec.ts";

export type TerminalSelectionCriticalMutationId = (typeof TERMINAL_SELECTION_CRITICAL_MUTATION_IDS)[number];

export interface TerminalSelectionMutationFixtureV1 {
  readonly runtime: TerminalSelectionRuntimeFactsV1;
  readonly reference: TerminalSelectionReferenceInputV1;
}

export interface TerminalSelectionMutationDefinitionV1 {
  readonly mutationId: TerminalSelectionCriticalMutationId;
  readonly implementationDigest: Hash;
  readonly apply: (base: TerminalSelectionMutationFixtureV1) => TerminalSelectionMutationFixtureV1;
}

const MUTATION_HASH = hashDomain("aloha/terminal-selection/critical-mutation/v1", "mutated") as Hash;

type ArtifactEnvelopeV1 = TerminalSelectionRuntimeFactsV1 | TerminalSelectionReferenceInputV1;

function withRecomputedArtifactRoot(
  index: number,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (index === 0) {
    const { observationRoot: _old, ...core } = value;
    return { ...core, observationRoot: hashDomain("aloha/raw-terminal-selection-observation/v1", core as CanonicalJson) };
  }
  if (index === 1) {
    const { manifestRoot: _old, ...core } = value;
    return { ...core, manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", core as CanonicalJson) };
  }
  if (index === 2) {
    const { observationRoot: _old, ...core } = value;
    return { ...core, observationRoot: hashDomain("aloha/production-terminal-phase-full-family-projection/v1", core as CanonicalJson) };
  }
  if (index === 3) {
    const { evidenceRoot: _old, ...core } = value;
    return { ...core, evidenceRoot: hashDomain("aloha/searcher-production-six-step-process-evidence/v1", core as CanonicalJson) };
  }
  return value;
}

function replaceArtifact<T extends ArtifactEnvelopeV1>(
  input: T,
  index: number,
  bytes: Uint8Array,
): T {
  const oldRef = input.refs[index];
  const oldClaim = input.claims[index];
  const oldLease = input.leases[index];
  const oldMirror = oldClaim?.observedMirror;
  if (oldRef === undefined || oldClaim === undefined || oldLease === undefined || oldMirror === null || oldMirror === undefined) return input;
  const contentSha256 = sha256Hex(bytes);
  const lease = createRetentionLeaseReceipt({
    storeIdentityHash: oldMirror.storeIdentityHash,
    objectKey: contentSha256,
    contentSha256,
    validFromStoreEpoch: oldLease.validFromStoreEpoch,
    validThroughStoreEpoch: oldLease.validThroughStoreEpoch,
    issuerId: oldLease.issuerId,
    issuerQualificationId: oldLease.issuerQualificationId,
    qualificationRegistryRoot: oldLease.qualificationRegistryRoot,
  });
  const locator = Object.freeze({
    kind: "content-object" as const,
    storeIdentityHash: oldMirror.storeIdentityHash,
    objectKey: contentSha256,
  });
  const ref = createReadOnlyArtifactRef({
    locator,
    immutableMirrorLocator: locator,
    contentSha256,
    byteLength: String(bytes.byteLength),
    mediaType: oldRef.mediaType,
    schema: oldRef.schema,
    resolverPolicyHash: oldRef.resolverPolicyHash,
    retentionLeaseReceiptId: lease.receiptId,
  });
  const claim = createArtifactResolutionClaim({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: oldClaim.resolverPolicyHash,
    observedMirror: {
      storeIdentityHash: oldMirror.storeIdentityHash,
      objectKey: contentSha256,
      bytes: encodeArtifactBytes(bytes),
      contentSha256,
      byteLength: String(bytes.byteLength),
      mediaType: oldRef.mediaType,
      schema: oldRef.schema,
    },
    outcome: "content-observed",
  });
  const refs = input.refs.map((value, current) => current === index ? ref : value);
  const claims = input.claims.map((value, current) => current === index ? claim : value);
  const leases = input.leases.map((value, current) => current === index ? lease : value);
  const facts = refs.length >= 4
    ? [createTerminalSelectionFactV1({
        rawSelectionArtifactRefId: refs[0]!.artifactRefId,
        terminalManifestArtifactRefId: refs[1]!.artifactRefId,
        fullFamilyProjectionArtifactRefId: refs[2]!.artifactRefId,
        processEvidenceArtifactRefId: refs[3]!.artifactRefId,
        sixStepPredicateArtifactRefIds: refs.slice(4).map(value => value.artifactRefId),
      })]
    : [createTerminalSelectionMissingFactV1({
        rawSelectionArtifactRefId: refs[0]!.artifactRefId,
        terminalManifestArtifactRefId: refs[1]!.artifactRefId,
        fullFamilyProjectionArtifactRefId: refs[2]!.artifactRefId,
      })];
  const observations = input.observations.map(observation => Object.freeze({
    ...observation,
    rawArtifactRefs: observation.rawArtifactRefs.map(value => value.artifactRefId === oldRef.artifactRefId ? ref : value),
    observedClaimIds: observation.observedClaimIds.map(value => value === oldClaim.claimId ? claim.claimId : value),
  }));
  const currentInvocation = input.trustedObserverInvocation;
  const trustedObserverInvocation = currentInvocation === null || currentInvocation === undefined
    ? currentInvocation
    : Object.freeze({
        ...currentInvocation,
        authenticatedArtifactRefIds: currentInvocation.authenticatedArtifactRefIds
          .map(value => value === oldRef.artifactRefId ? ref.artifactRefId : value)
          .sort(),
      });
  return Object.freeze({ ...input, facts, refs, claims, leases, observations, trustedObserverInvocation }) as unknown as T;
}

function mutateArtifactJson<T extends ArtifactEnvelopeV1>(
  input: T,
  index: number,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>,
  recomputeArtifactRoot = true,
): T {
  const claim = input.claims[index];
  if (claim?.observedMirror === null || claim?.observedMirror === undefined) return input;
  const decoded = decodeCanonicalBytes(decodeArtifactBytes(claim.observedMirror.bytes));
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return input;
  const mutated = mutate(structuredClone(decoded) as Record<string, unknown>);
  const bytes = encodeCanonicalBytes(recomputeArtifactRoot ? withRecomputedArtifactRoot(index, mutated) : mutated);
  return replaceArtifact(input, index, bytes);
}

function mutateBoth(
  base: TerminalSelectionMutationFixtureV1,
  index: number,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>,
  recomputeArtifactRoot = true,
): TerminalSelectionMutationFixtureV1 {
  return Object.freeze({
    runtime: mutateArtifactJson(base.runtime, index, mutate, recomputeArtifactRoot),
    reference: mutateArtifactJson(base.reference, index, mutate, recomputeArtifactRoot),
  });
}

function nested(
  value: Record<string, unknown>,
  field: string,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const old = value[field];
  return { ...value, [field]: { ...(old !== null && typeof old === "object" ? old as object : {}), ...patch } };
}

function mutateFacts(
  base: TerminalSelectionMutationFixtureV1,
  mutate: (fact: unknown) => unknown,
): TerminalSelectionMutationFixtureV1 {
  return Object.freeze({
    runtime: Object.freeze({ ...base.runtime, facts: base.runtime.facts.map(mutate) }),
    reference: Object.freeze({ ...base.reference, facts: base.reference.facts.map(mutate) }),
  });
}

function missingObservation(base: TerminalSelectionMutationFixtureV1): TerminalSelectionMutationFixtureV1 {
  return Object.freeze({
    runtime: Object.freeze({ ...base.runtime, observations: Object.freeze([]) }),
    reference: Object.freeze({ ...base.reference, observations: Object.freeze([]) }),
  });
}

function splitObservation<T extends ArtifactEnvelopeV1>(input: T): T {
  const midpoint = Math.max(1, Math.floor(input.refs.length / 2));
  const observations = Object.freeze([
    Object.freeze({ observationId: "terminal-selection-mutation-left", rawArtifactRefs: input.refs.slice(0, midpoint), observedClaimIds: input.claims.slice(0, midpoint).map(value => value.claimId) }),
    Object.freeze({ observationId: "terminal-selection-mutation-right", rawArtifactRefs: input.refs.slice(midpoint), observedClaimIds: input.claims.slice(midpoint).map(value => value.claimId) }),
  ]);
  return Object.freeze({ ...input, observations }) as unknown as T;
}

const definitions: Record<TerminalSelectionCriticalMutationId, TerminalSelectionMutationDefinitionV1["apply"]> = {
  "raw-sqlite-before-after-splice": base => mutateBoth(base, 0, value => ({ ...value, databaseSha256After: MUTATION_HASH })),
  "raw-storage-set-splice": base => mutateBoth(base, 0, value => ({ ...value, storageSetRootAfter: MUTATION_HASH })),
  "raw-selection-root-splice": base => mutateBoth(base, 0, value => nested(value, "selection", { selectionRoot: MUTATION_HASH })),
  "selection-policy-splice": base => mutateBoth(base, 0, value => nested(value, "selection", { selectionPolicyDigest: MUTATION_HASH })),
  "eligible-success-root-splice": base => mutateBoth(base, 0, value => nested(value, "selection", { eligibleSuccessRoot: MUTATION_HASH })),
  "selected-terminal-splice": base => mutateBoth(base, 0, value => nested(value, "selection", { selectedProducerTerminalId: MUTATION_HASH })),
  "terminal-manifest-root-splice": base => mutateBoth(base, 1, value => ({ ...value, manifestRoot: MUTATION_HASH }), false),
  "full-family-projection-splice": base => mutateBoth(base, 2, value => ({ ...value, observationRoot: MUTATION_HASH }), false),
  "terminal-invocation-root-splice": base => mutateBoth(base, 1, value => ({ ...value, terminalPhaseInvocationRoot: MUTATION_HASH })),
  "six-step-predicate-closure-splice": base => mutateBoth(base, 1, value => nested(value, "sixStep", { predicateArtifactRoot: MUTATION_HASH })),
  "process-evidence-root-splice": base => mutateBoth(base, 3, value => ({ ...value, evidenceRoot: MUTATION_HASH }), false),
  "process-append-record-splice": base => mutateBoth(base, 3, value => ({ ...value, durableAppendRecordId: MUTATION_HASH })),
  "process-anchor-splice": base => mutateBoth(base, 3, value => nested(value, "runtimeAnchor", { pid: "999" })),
  "release-process-splice": base => mutateBoth(base, 3, value => ({ ...value, releaseProvenanceHash: MUTATION_HASH })),
  "serving-process-splice": base => mutateBoth(base, 3, value => nested(value, "serving", { generationId: "mutated-generation" })),
  "source-coverage-process-splice": base => mutateBoth(base, 3, value => nested(value, "serving", { sourceCoverageRoot: MUTATION_HASH })),
  "release-anchor-splice": base => mutateBoth(base, 1, value => ({ ...value, releaseAnchorRoot: MUTATION_HASH })),
  "artifact-ref-splice": base => mutateFacts(base, fact => ({ ...(fact as object), rawSelectionArtifactRefId: MUTATION_HASH })),
  "artifact-mirror-splice": base => Object.freeze({
    runtime: Object.freeze({ ...base.runtime, claims: base.runtime.claims.map((claim, index) => index === 0 && claim.observedMirror !== null ? { ...claim, observedMirror: { ...claim.observedMirror, bytes: encodeArtifactBytes(new Uint8Array([0])) } } : claim) }),
    reference: Object.freeze({ ...base.reference, claims: base.reference.claims.map((claim, index) => index === 0 && claim.observedMirror !== null ? { ...claim, observedMirror: { ...claim.observedMirror, bytes: encodeArtifactBytes(new Uint8Array([0])) } } : claim) }),
  }),
  "missing-independent-observation": missingObservation,
  "cross-observation-denominator-splice": base => Object.freeze({ runtime: splitObservation(base.runtime), reference: splitObservation(base.reference) }),
  "producer-verdict-injection": base => mutateFacts(base, fact => ({ ...(fact as object), producerVerdict: "pass" })),
};

export const TERMINAL_SELECTION_MUTATION_REGISTRY: readonly TerminalSelectionMutationDefinitionV1[] = Object.freeze(
  TERMINAL_SELECTION_CRITICAL_MUTATION_IDS.map(mutationId => Object.freeze({
    mutationId,
    implementationDigest: hashDomain("aloha/terminal-selection/mutation-implementation/v1", {
      mutationId,
      program: "coherent-content-addressed-reroot-v1",
    }),
    apply: definitions[mutationId],
  })),
);

export const TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST = hashDomain(
  "aloha/terminal-selection/mutation-registry/v1",
  TERMINAL_SELECTION_MUTATION_REGISTRY.map(({ mutationId, implementationDigest }) => ({ mutationId, implementationDigest })),
);
