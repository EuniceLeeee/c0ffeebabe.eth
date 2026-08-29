import {
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createReadOnlyArtifactRef,
  recomputeReadOnlyArtifactRefId,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  decodeArtifactHexBytes,
  encodeArtifactBytes,
  encodeArtifactHexBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import { evaluateArtifactLineageOracle } from "./reference-model.ts";
import { evaluateArtifactLineagePredicate } from "./predicate.ts";
import {
  ARTIFACT_LINEAGE_MUTATION_IDS,
  ARTIFACT_LINEAGE_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  ARTIFACT_LINEAGE_PREDICATE_SPEC,
} from "./spec.ts";
import {
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION,
  ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION,
  ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION,
} from "./role-qualification.ts";
import type { ArtifactLineageRoleId, RoleQualificationCaseResult, RoleQualificationCaseRoots } from "./role-qualification.ts";
import {
  ARTIFACT_LINEAGE_SCHEMA_MANIFESTS,
  createArtifactLineageClaim,
  createArtifactLineageObservation,
  createArtifactLineageObservationFromBytes,
  decodeArtifactLineageClaim,
  decodeArtifactLineageFactBundle,
  decodeArtifactLineageObservation,
  encodeArtifactLineageClaim,
  encodeArtifactLineageFactBundle,
  encodeArtifactLineageObservation,
  type ArtifactLineageClaimDraft,
  type ArtifactLineageClaimV1,
  type ArtifactLineageCodecInput,
  type ArtifactLineageFactBundleV1,
  type ArtifactLineageObservationDraft,
  type ArtifactLineageObservationFromBytesDraft,
  type ArtifactLineageObservationV1,
  type ArtifactLineagePredicateResult,
  type ArtifactLineageRawFactsInputV1,
  type ArtifactLineageReasonCode,
  type ArtifactLineageVerdict,
  type ReadOnlyArtifactRefV1,
  type SchemaRef,
} from "./schema.ts";

export {
  ARTIFACT_LINEAGE_SCHEMA_MANIFESTS,
  createArtifactLineageClaim,
  createArtifactLineageObservation,
  createArtifactLineageObservationFromBytes,
  decodeArtifactLineageClaim,
  decodeArtifactLineageFactBundle,
  decodeArtifactLineageObservation,
  encodeArtifactLineageClaim,
  encodeArtifactLineageFactBundle,
  encodeArtifactLineageObservation,
  evaluateArtifactLineageOracle,
};

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const CASE_DOMAIN = "aloha/artifact-lineage-independent-oracle-case/v2";
const CASE_ROOT_DOMAIN = "aloha/artifact-lineage-independent-oracle-root/v2";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;

export interface ArtifactLineageIndependentOracleCaseV1 {
  readonly caseId: string;
  readonly mutationId: string | null;
  readonly classification: "positive" | "negative" | "invalid";
  readonly claim: ArtifactLineageClaimV1;
  readonly observation: ArtifactLineageObservationV1;
  readonly rawFacts: ArtifactLineageRawFactsInputV1;
  /** Deliberately unconsumed producer witness. */
  readonly producerVerdict: string;
  /** Test-only hostile/derived materialization over immutable canonical bytes. */
  readonly rawBytesForm?: "proxy" | "derived";
}

export interface ArtifactLineageCaseResultV1 {
  readonly caseId: string;
  readonly mutationId: string | null;
  readonly classification: ArtifactLineageIndependentOracleCaseV1["classification"];
  readonly oracle: ArtifactLineagePredicateResult;
  readonly predicate: ArtifactLineagePredicateResult;
  readonly expectedVerdict: ArtifactLineageVerdict;
  readonly classificationMatchesOracle: boolean;
  readonly predicateMatchesOracle: boolean;
  readonly predicateSpecDigest: Hash;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  readonly oracleCaseDigest: Hash;
  readonly caseDigest: Hash;
}

export interface ArtifactLineageCaseRootsV1 {
  readonly caseSetRoot: Hash;
  readonly positiveCaseRoot: Hash;
  readonly negativeCaseRoot: Hash;
  readonly invalidCaseRoot: Hash;
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleCaseCount: string;
}

export interface ArtifactLineageQualificationMaterialV1 {
  readonly predicateSpec: PredicateSpecV1;
  readonly observerRole: ObserverRoleSpecV1;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  readonly criticalMutationIds: readonly string[];
  readonly cases: readonly ArtifactLineageIndependentOracleCaseV1[];
  readonly caseResults: readonly ArtifactLineageCaseResultV1[];
  readonly roots: ArtifactLineageCaseRootsV1;
  readonly implWitnessCaseCount: "0";
}

function materializeCaseRawFacts(caseMaterial: ArtifactLineageIndependentOracleCaseV1): ArtifactLineageRawFactsInputV1 | unknown {
  if (caseMaterial.rawBytesForm === undefined) return caseMaterial.rawFacts;
  const bytes = decodeArtifactHexBytes(caseMaterial.rawFacts.rawBytes ?? "0x");
  if (caseMaterial.rawBytesForm === "proxy") {
    return {
      ...caseMaterial.rawFacts,
      rawBytes: new Proxy(bytes, {
        get() { throw new Error("hostile binary trap"); },
        getOwnPropertyDescriptor() { throw new Error("hostile binary trap"); },
        getPrototypeOf() { throw new Error("hostile binary trap"); },
        ownKeys() { throw new Error("hostile binary trap"); },
      }),
    };
  }
  class DerivedBytes extends Uint8Array {}
  return { ...caseMaterial.rawFacts, rawBytes: new DerivedBytes(bytes) };
}

export function evaluateArtifactLineageCase(
  caseMaterial: ArtifactLineageIndependentOracleCaseV1,
): ArtifactLineagePredicateResult & {
  readonly oracle: ArtifactLineagePredicateResult;
  readonly predicate: ArtifactLineagePredicateResult;
  readonly expectedVerdict: ArtifactLineageVerdict;
  readonly classificationMatchesOracle: boolean;
  readonly predicateMatchesOracle: boolean;
} {
  const rawFacts = materializeCaseRawFacts(caseMaterial);
  const predicate = evaluateArtifactLineagePredicate(caseMaterial.claim, caseMaterial.observation, rawFacts);
  const oracle = evaluateArtifactLineageOracle(caseMaterial.claim, caseMaterial.observation, rawFacts);
  const expectedVerdict: ArtifactLineageVerdict = caseMaterial.classification === "positive"
    ? "pass"
    : caseMaterial.classification === "negative" ? "fail" : "invalid";
  return Object.freeze({
    ...predicate,
    oracle,
    predicate,
    expectedVerdict,
    classificationMatchesOracle: oracle.verdict === expectedVerdict,
    predicateMatchesOracle: predicate.verdict === oracle.verdict &&
      JSON.stringify(predicate.reasons) === JSON.stringify(oracle.reasons),
  });
}

function stableRawFingerprint(caseMaterial: ArtifactLineageIndependentOracleCaseV1): CanonicalJsonObject {
  return {
    rawBytes: caseMaterial.rawFacts.rawBytes,
    locator: caseMaterial.rawFacts.locator as CanonicalJsonObject,
    immutableMirrorLocator: caseMaterial.rawFacts.immutableMirrorLocator as CanonicalJsonObject,
    mediaType: caseMaterial.rawFacts.mediaType,
    schema: caseMaterial.rawFacts.schema as null | CanonicalJsonObject,
    observedStoreEpoch: caseMaterial.rawFacts.observedStoreEpoch,
    rawBytesForm: caseMaterial.rawBytesForm ?? null,
  };
}

function caseBytesSha256(value: unknown): Hash {
  return sha256Hex(encodeCanonicalBytes(value));
}

function caseDigest(
  caseMaterial: ArtifactLineageIndependentOracleCaseV1,
  evaluation: ReturnType<typeof evaluateArtifactLineageCase>,
): Hash {
  return hashDomain(CASE_DOMAIN, {
    predicateSpecDigest: ARTIFACT_LINEAGE_PREDICATE_SPEC.specDigest,
    predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    caseId: caseMaterial.caseId,
    mutationId: caseMaterial.mutationId,
    classification: caseMaterial.classification,
    claimBytesSha256: caseBytesSha256(caseMaterial.claim),
    observationBytesSha256: caseBytesSha256(caseMaterial.observation),
    rawFacts: stableRawFingerprint(caseMaterial),
    expectedVerdict: evaluation.expectedVerdict,
    classificationMatchesOracle: evaluation.classificationMatchesOracle,
    predicateMatchesOracle: evaluation.predicateMatchesOracle,
    oracle: { verdict: evaluation.oracle.verdict, reasons: evaluation.oracle.reasons },
    predicate: { verdict: evaluation.predicate.verdict, reasons: evaluation.predicate.reasons },
  });
}

function oracleCaseDigest(
  caseMaterial: ArtifactLineageIndependentOracleCaseV1,
  oracle: ArtifactLineagePredicateResult,
): Hash {
  return hashDomain(CASE_DOMAIN, {
    predicateSpecDigest: ARTIFACT_LINEAGE_PREDICATE_SPEC.specDigest,
    predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    caseId: caseMaterial.caseId,
    mutationId: caseMaterial.mutationId,
    claimBytesSha256: caseBytesSha256(caseMaterial.claim),
    observationBytesSha256: caseBytesSha256(caseMaterial.observation),
    rawFacts: stableRawFingerprint(caseMaterial),
    oracle: { verdict: oracle.verdict, reasons: oracle.reasons },
  });
}

function rootFor(
  results: readonly ArtifactLineageCaseResultV1[],
  digestField: "caseDigest" | "oracleCaseDigest",
): Hash {
  return hashDomain(CASE_ROOT_DOMAIN, {
    predicateSpecDigest: ARTIFACT_LINEAGE_PREDICATE_SPEC.specDigest,
    predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    digests: results.map((result) => result[digestField]).sort(),
  });
}

function validateCaseSet(cases: readonly ArtifactLineageIndependentOracleCaseV1[]): void {
  const seenCaseIds = new Set<string>();
  const seenMutationIds = new Set<string>();
  const allowed = new Set<string>(ARTIFACT_LINEAGE_MUTATION_IDS);
  for (const [index, entry] of cases.entries()) {
    if (typeof entry.caseId !== "string" || entry.caseId.length === 0 || seenCaseIds.has(entry.caseId)) {
      throw new TypeError(`duplicate or empty artifact-lineage caseId at ${index}`);
    }
    seenCaseIds.add(entry.caseId);
    if (entry.mutationId !== null) {
      if (!allowed.has(entry.mutationId) || seenMutationIds.has(entry.mutationId)) {
        throw new TypeError(`extra or duplicate artifact-lineage mutation at ${entry.caseId}`);
      }
      seenMutationIds.add(entry.mutationId);
    }
  }
  for (const mutationId of ARTIFACT_LINEAGE_MUTATION_IDS) {
    if (!seenMutationIds.has(mutationId)) throw new TypeError(`missing artifact-lineage mutation ${mutationId}`);
  }
}

export function computeArtifactLineageCaseRoots(
  cases: readonly ArtifactLineageIndependentOracleCaseV1[],
): { readonly roots: ArtifactLineageCaseRootsV1; readonly results: readonly ArtifactLineageCaseResultV1[] } {
  validateCaseSet(cases);
  const results = cases.map((caseMaterial) => {
    const evaluation = evaluateArtifactLineageCase(caseMaterial);
    return Object.freeze({
      caseId: caseMaterial.caseId,
      mutationId: caseMaterial.mutationId,
      classification: caseMaterial.classification,
      oracle: evaluation.oracle,
      predicate: evaluation.predicate,
      expectedVerdict: evaluation.expectedVerdict,
      classificationMatchesOracle: evaluation.classificationMatchesOracle,
      predicateMatchesOracle: evaluation.predicateMatchesOracle,
      predicateSpecDigest: ARTIFACT_LINEAGE_PREDICATE_SPEC.specDigest,
      predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
      oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
      oracleCaseDigest: oracleCaseDigest(caseMaterial, evaluation.oracle),
      caseDigest: caseDigest(caseMaterial, evaluation),
    });
  }).sort((left, right) => left.caseId.localeCompare(right.caseId));
  const positive = results.filter((result) => result.oracle.verdict === "pass");
  const negative = results.filter((result) => result.oracle.verdict === "fail");
  const invalid = results.filter((result) => result.oracle.verdict === "invalid");
  return Object.freeze({
    roots: Object.freeze({
      caseSetRoot: rootFor(results, "caseDigest"),
      positiveCaseRoot: rootFor(positive, "oracleCaseDigest"),
      negativeCaseRoot: rootFor(negative, "oracleCaseDigest"),
      invalidCaseRoot: rootFor(invalid, "oracleCaseDigest"),
      independentOracleCaseRoot: rootFor(results, "oracleCaseDigest"),
      independentOracleCaseCount: String(results.length),
    }),
    results: Object.freeze(results),
  });
}

export interface ArtifactLineageQualificationResultV1 {
  readonly factsConsistent: boolean;
  readonly authority: false;
  readonly issues: readonly string[];
  readonly material: ArtifactLineageQualificationMaterialV1;
}

const emptyRoots: ArtifactLineageCaseRootsV1 = Object.freeze({
  caseSetRoot: ZERO_HASH,
  positiveCaseRoot: ZERO_HASH,
  negativeCaseRoot: ZERO_HASH,
  invalidCaseRoot: ZERO_HASH,
  independentOracleCaseRoot: ZERO_HASH,
  independentOracleCaseCount: "0",
});

export function qualifyArtifactLineageFacts(
  cases: readonly ArtifactLineageIndependentOracleCaseV1[] = ARTIFACT_LINEAGE_CASE_MATERIAL,
): ArtifactLineageQualificationResultV1 {
  const issues: string[] = [];
  let computed: { readonly roots: ArtifactLineageCaseRootsV1; readonly results: readonly ArtifactLineageCaseResultV1[] } = {
    roots: emptyRoots,
    results: Object.freeze([]),
  };
  try {
    computed = computeArtifactLineageCaseRoots(cases);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "invalid-case-material");
  }
  if (computed.results.length > 0) {
    for (const result of computed.results) {
      if (!result.classificationMatchesOracle) issues.push(`case-classification-mismatch:${result.caseId}`);
      if (!result.predicateMatchesOracle) issues.push(`predicate-oracle-disagreement:${result.caseId}`);
    }
    if (!computed.results.some((result) => result.oracle.verdict === "pass")) issues.push("missing-positive-case");
    if (!computed.results.some((result) => result.oracle.verdict === "fail")) issues.push("missing-negative-case");
    if (!computed.results.some((result) => result.oracle.verdict === "invalid")) issues.push("missing-invalid-case");
  }
  const material: ArtifactLineageQualificationMaterialV1 = Object.freeze({
    predicateSpec: ARTIFACT_LINEAGE_PREDICATE_SPEC,
    observerRole: ARTIFACT_LINEAGE_OBSERVER_ROLE,
    predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    criticalMutationIds: ARTIFACT_LINEAGE_MUTATION_IDS,
    cases: deepFreeze([...cases]),
    caseResults: computed.results,
    roots: computed.roots,
    implWitnessCaseCount: "0",
  });
  return Object.freeze({ factsConsistent: issues.length === 0, authority: false, issues: Object.freeze(issues), material });
}

function baseFixture(): {
  readonly bytes: Uint8Array;
  readonly artifactRef: ReadOnlyArtifactRefV1;
  readonly claim: ArtifactLineageClaimV1;
  readonly observation: ArtifactLineageObservationV1;
  readonly rawFacts: ArtifactLineageRawFactsInputV1;
} {
  const bytes = new Uint8Array([0x00, 0xff, 0x41, 0x00]);
  const bytesHex = encodeArtifactHexBytes(bytes);
  const contentSha256 = sha256Hex(bytes);
  const policy = createResolverPolicy({
    schemaVersion: 1, kind: "aloha.artifact-resolver-policy", allowedLocatorKind: "content-object",
    digestAlgorithm: "sha256", maxByteLength: "1024", requireExactLengthMediaAndSchema: true,
    minimumRemainingStoreEpochs: "1", failureOutcome: "invalid",
  });
  const locator = {
    kind: "file-range" as const, systemId: "lineage-system", bootIdHash: h("5"),
    device: "7", inode: "9", startInclusive: "10", endExclusive: String(10 + bytes.byteLength),
  };
  const provisionalRef = createReadOnlyArtifactRef({
    locator,
    immutableMirrorLocator: { kind: "content-object", storeIdentityHash: h("6"), objectKey: contentSha256 },
    contentSha256, byteLength: String(bytes.byteLength), mediaType: "application/octet-stream", schema: null,
    resolverPolicyHash: policy.policyHash, retentionLeaseReceiptId: ZERO_HASH,
  });
  const lease = createRetentionLeaseReceipt({
    storeIdentityHash: provisionalRef.immutableMirrorLocator.storeIdentityHash,
    objectKey: provisionalRef.immutableMirrorLocator.objectKey,
    contentSha256: provisionalRef.contentSha256,
    validFromStoreEpoch: "10", validThroughStoreEpoch: "12", issuerId: "lineage-issuer",
    issuerQualificationId: h("7"), qualificationRegistryRoot: h("8"),
  });
  const artifactRefWithLease = { ...provisionalRef, retentionLeaseReceiptId: lease.receiptId } as ReadOnlyArtifactRefV1;
  const refWithIdentity = { ...artifactRefWithLease, artifactRefId: recomputeReadOnlyArtifactRefId(artifactRefWithLease) } as ReadOnlyArtifactRefV1;
  const observedMirror = createObservedImmutableMirror({
    storeIdentityHash: refWithIdentity.immutableMirrorLocator.storeIdentityHash,
    objectKey: refWithIdentity.immutableMirrorLocator.objectKey, bytes: encodeArtifactBytes(bytes),
    mediaType: refWithIdentity.mediaType, schema: refWithIdentity.schema,
  });
  const resolutionClaim = createArtifactResolutionClaim({
    artifactRefId: refWithIdentity.artifactRefId, resolverPolicyHash: policy.policyHash,
    observedMirror, outcome: "content-observed",
  });
  const claim = createArtifactLineageClaim({
    schemaVersion: 1, kind: "aloha.artifact-lineage-claim", artifactRef: refWithIdentity, resolverPolicy: policy,
    resolutionClaim, retentionLease: lease, observedStoreEpoch: "11",
  });
  const observation = createArtifactLineageObservationFromBytes({
    schemaVersion: 1, kind: "aloha.artifact-lineage-observation", artifactRefId: refWithIdentity.artifactRefId,
    locator: refWithIdentity.locator, immutableMirrorLocator: refWithIdentity.immutableMirrorLocator,
    rawBytes: bytesHex, mediaType: refWithIdentity.mediaType, schema: refWithIdentity.schema,
    observedStoreEpoch: "11",
  });
  const rawFacts = Object.freeze({
    rawBytes: bytesHex, locator: refWithIdentity.locator, immutableMirrorLocator: refWithIdentity.immutableMirrorLocator,
    mediaType: refWithIdentity.mediaType, schema: refWithIdentity.schema, observedStoreEpoch: "11",
  });
  return { bytes, artifactRef: refWithIdentity, claim, observation, rawFacts };
}

function rebuildClaim(base: ArtifactLineageClaimV1, patch: Partial<ArtifactLineageClaimDraft>): ArtifactLineageClaimV1 {
  const { claimId: _claimId, ...payload } = base;
  return createArtifactLineageClaim({ ...payload, ...patch });
}

function rebuildObservation(base: ArtifactLineageObservationV1, patch: Partial<ArtifactLineageObservationDraft>): ArtifactLineageObservationV1 {
  const { observationId: _observationId, payloadHash: _payloadHash, ...payload } = base;
  return createArtifactLineageObservation({ ...payload, ...patch });
}

function rawWith(base: ArtifactLineageRawFactsInputV1, patch: Partial<ArtifactLineageRawFactsInputV1>): ArtifactLineageRawFactsInputV1 {
  return Object.freeze({ ...base, ...patch });
}

function mutationCases(): readonly ArtifactLineageIndependentOracleCaseV1[] {
  const base = baseFixture();
  const mutatedBytes = new Uint8Array(base.bytes);
  mutatedBytes[1] = 0xfe;
  const mutatedBytesHex = encodeArtifactHexBytes(mutatedBytes);
  const mutatedMirror = createObservedImmutableMirror({
    storeIdentityHash: base.artifactRef.immutableMirrorLocator.storeIdentityHash,
    objectKey: base.artifactRef.immutableMirrorLocator.objectKey,
    bytes: encodeArtifactBytes(mutatedBytes),
    mediaType: base.artifactRef.mediaType,
    schema: base.artifactRef.schema,
  });
  const mutatedClaim = rebuildClaim(base.claim, {
    resolutionClaim: createArtifactResolutionClaim({
      artifactRefId: base.artifactRef.artifactRefId,
      resolverPolicyHash: base.claim.resolverPolicy.policyHash,
      observedMirror: mutatedMirror,
      outcome: "content-observed",
    }),
  });
  const mutatedObservation = createArtifactLineageObservationFromBytes({
    schemaVersion: 1, kind: "aloha.artifact-lineage-observation", artifactRefId: base.artifactRef.artifactRefId,
    locator: base.artifactRef.locator, immutableMirrorLocator: base.artifactRef.immutableMirrorLocator,
    rawBytes: mutatedBytesHex, mediaType: base.artifactRef.mediaType, schema: base.artifactRef.schema,
    observedStoreEpoch: "11",
  });
  const spliceLocator = { ...base.artifactRef.locator, inode: "10" };
  const spliceMirror = { ...base.artifactRef.immutableMirrorLocator, objectKey: `0x${"a".repeat(64)}` as Hash };
  const alternateSchema = { id: "alternate.schema", version: "1.0.0", schemaHash: `0x${"b".repeat(64)}` as Hash };
  const leaseBoundaryClaim = rebuildClaim(base.claim, { observedStoreEpoch: "12" });
  const leaseBoundaryObservation = rebuildObservation(base.observation, { observedStoreEpoch: "12" });
  const missingObservation = rebuildObservation(base.observation, { rawBytes: null, contentSha256: null, byteLength: null, mediaType: null });
  const outcomeMismatchClaim = rebuildClaim(base.claim, {
    resolutionClaim: createArtifactResolutionClaim({
      artifactRefId: base.artifactRef.artifactRefId,
      resolverPolicyHash: base.claim.resolverPolicy.policyHash,
      observedMirror: base.claim.resolutionClaim.observedMirror,
      outcome: "content-mismatch",
    }),
  });
  const lengthLocator = { ...base.artifactRef.locator, endExclusive: "15" };
  const lengthRef = createReadOnlyArtifactRef({
    locator: lengthLocator,
    immutableMirrorLocator: base.artifactRef.immutableMirrorLocator,
    contentSha256: base.artifactRef.contentSha256,
    byteLength: "5", mediaType: base.artifactRef.mediaType, schema: base.artifactRef.schema,
    resolverPolicyHash: base.artifactRef.resolverPolicyHash, retentionLeaseReceiptId: base.artifactRef.retentionLeaseReceiptId,
  });
  const lengthClaim = rebuildClaim(base.claim, {
    artifactRef: lengthRef,
    resolutionClaim: createArtifactResolutionClaim({
      artifactRefId: lengthRef.artifactRefId,
      resolverPolicyHash: base.claim.resolverPolicy.policyHash,
      observedMirror: base.claim.resolutionClaim.observedMirror,
      outcome: "content-observed",
    }),
  });
  const lengthObservation = rebuildObservation(base.observation, {
    artifactRefId: lengthRef.artifactRefId,
    locator: lengthRef.locator,
  });
  const lengthRaw = rawWith(base.rawFacts, { locator: lengthRef.locator });
  const cases: ArtifactLineageIndependentOracleCaseV1[] = [
    { caseId: "artifact-lineage-positive", mutationId: null, classification: "positive", claim: base.claim, observation: base.observation, rawFacts: base.rawFacts, producerVerdict: "pass" },
    { caseId: "artifact-lineage-positive-lease-lower-boundary", mutationId: null, classification: "positive", claim: rebuildClaim(base.claim, { observedStoreEpoch: "10" }), observation: rebuildObservation(base.observation, { observedStoreEpoch: "10" }), rawFacts: rawWith(base.rawFacts, { observedStoreEpoch: "10" }), producerVerdict: "pass" },
    { caseId: "artifact-lineage-claim-mirror-splice", mutationId: "claim-mirror-splice", classification: "invalid", claim: rebuildClaim(base.claim, { resolutionClaim: createArtifactResolutionClaim({ artifactRefId: base.artifactRef.artifactRefId, resolverPolicyHash: base.claim.resolverPolicy.policyHash, observedMirror: createObservedImmutableMirror({ storeIdentityHash: base.artifactRef.immutableMirrorLocator.storeIdentityHash, objectKey: `0x${"a".repeat(64)}` as Hash, bytes: encodeArtifactBytes(base.bytes), mediaType: base.artifactRef.mediaType, schema: base.artifactRef.schema }), outcome: "content-observed" }) }), observation: base.observation, rawFacts: base.rawFacts, producerVerdict: "pass" },
    { caseId: "artifact-lineage-content-mutation", mutationId: "content-mutation", classification: "negative", claim: mutatedClaim, observation: mutatedObservation, rawFacts: rawWith(base.rawFacts, { rawBytes: mutatedBytesHex }), producerVerdict: "pass" },
    { caseId: "artifact-lineage-artifact-ref-length", mutationId: "artifact-ref-length", classification: "invalid", claim: lengthClaim, observation: lengthObservation, rawFacts: lengthRaw, producerVerdict: "pass" },
    { caseId: "artifact-lineage-length-mismatch", mutationId: "length-mismatch", classification: "invalid", claim: base.claim, observation: rebuildObservation(base.observation, { byteLength: "5" }), rawFacts: base.rawFacts, producerVerdict: "pass" },
    { caseId: "artifact-lineage-media-mismatch", mutationId: "media-mismatch", classification: "invalid", claim: base.claim, observation: rebuildObservation(base.observation, { mediaType: "text/plain" }), rawFacts: base.rawFacts, producerVerdict: "pass" },
    { caseId: "artifact-lineage-schema-mismatch", mutationId: "schema-mismatch", classification: "invalid", claim: base.claim, observation: rebuildObservation(base.observation, { schema: alternateSchema }), rawFacts: base.rawFacts, producerVerdict: "pass" },
    { caseId: "artifact-lineage-locator-splice", mutationId: "locator-splice", classification: "invalid", claim: base.claim, observation: rebuildObservation(base.observation, { locator: spliceLocator }), rawFacts: rawWith(base.rawFacts, { locator: spliceLocator }), producerVerdict: "pass" },
    { caseId: "artifact-lineage-object-key-splice", mutationId: "object-key-splice", classification: "invalid", claim: base.claim, observation: rebuildObservation(base.observation, { immutableMirrorLocator: spliceMirror }), rawFacts: rawWith(base.rawFacts, { immutableMirrorLocator: spliceMirror }), producerVerdict: "pass" },
    { caseId: "artifact-lineage-lease-boundary", mutationId: "lease-boundary", classification: "invalid", claim: leaseBoundaryClaim, observation: leaseBoundaryObservation, rawFacts: rawWith(base.rawFacts, { observedStoreEpoch: "12" }), producerVerdict: "pass" },
    { caseId: "artifact-lineage-missing-raw-bytes", mutationId: "missing-raw-bytes", classification: "invalid", claim: base.claim, observation: missingObservation, rawFacts: rawWith(base.rawFacts, { rawBytes: null }), producerVerdict: "pass" },
    { caseId: "artifact-lineage-hostile-binary", mutationId: "hostile-binary", classification: "invalid", claim: base.claim, observation: base.observation, rawFacts: base.rawFacts, rawBytesForm: "proxy", producerVerdict: "pass" },
    { caseId: "artifact-lineage-derived-binary", mutationId: null, classification: "invalid", claim: base.claim, observation: base.observation, rawFacts: base.rawFacts, rawBytesForm: "derived", producerVerdict: "pass" },
    { caseId: "artifact-lineage-resolution-outcome", mutationId: "resolution-outcome-mismatch", classification: "invalid", claim: outcomeMismatchClaim, observation: base.observation, rawFacts: base.rawFacts, producerVerdict: "pass" },
  ];
  return deepFreeze(cases);
}

export const ARTIFACT_LINEAGE_CASE_MATERIAL = mutationCases();
export const ARTIFACT_LINEAGE_CASES = ARTIFACT_LINEAGE_CASE_MATERIAL;

const computedQualification = computeArtifactLineageCaseRoots(ARTIFACT_LINEAGE_CASE_MATERIAL);
export const ARTIFACT_LINEAGE_CASE_RESULTS = computedQualification.results;
export const ARTIFACT_LINEAGE_CASE_ROOTS = computedQualification.roots;
export const ARTIFACT_LINEAGE_QUALIFICATION_MATERIAL: ArtifactLineageQualificationMaterialV1 = Object.freeze({
  predicateSpec: ARTIFACT_LINEAGE_PREDICATE_SPEC,
  observerRole: ARTIFACT_LINEAGE_OBSERVER_ROLE,
  predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  criticalMutationIds: ARTIFACT_LINEAGE_MUTATION_IDS,
  cases: ARTIFACT_LINEAGE_CASE_MATERIAL,
  caseResults: ARTIFACT_LINEAGE_CASE_RESULTS,
  roots: ARTIFACT_LINEAGE_CASE_ROOTS,
  implWitnessCaseCount: "0",
});

export const ARTIFACT_LINEAGE_QUALIFICATION = qualifyArtifactLineageFacts();

export interface ArtifactLineageVerifierQualificationMaterialV1 {
  readonly predicateSpec: PredicateSpecV1;
  readonly roleMaterials: readonly {
    readonly roleId: string;
    readonly predicateProgramDescriptorDigest: Hash;
    readonly oracleProgramDescriptorDigest: Hash;
    readonly roots: RoleQualificationCaseRoots;
    readonly actuallyExecutedRejectedOrInvalidMutationIds: readonly string[];
  }[];
  readonly caseResults: readonly (ArtifactLineageCaseResultV1 | RoleQualificationCaseResult)[];
  readonly caseSetRoot: Hash;
  readonly positiveCaseRoot: Hash;
  readonly negativeCaseRoot: Hash;
  readonly invalidCaseRoot: Hash;
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleCaseCount: string;
  readonly actuallyExecutedRejectedOrInvalidMutationIds: readonly string[];
  readonly authority: false;
}

const SIDE_ROLE_MATERIALS = [
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION,
  ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION,
  ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION,
] as const;

function actuallyExecutedRejectedOrInvalidMutationIds(
  results: readonly {
    readonly mutationId: string | null;
    readonly oracle: { readonly verdict: "pass" | "fail" | "invalid" };
    readonly predicate?: { readonly verdict: "pass" | "fail" | "invalid" };
  }[],
): readonly string[] {
  return Object.freeze([...new Set(results
    .filter((result) => result.mutationId !== null &&
      result.oracle.verdict !== "pass" &&
      (result.predicate === undefined || result.predicate.verdict !== "pass"))
    .map((result) => result.mutationId!))].sort());
}

const RAW_ACTUALLY_EXECUTED_MUTATION_IDS = actuallyExecutedRejectedOrInvalidMutationIds(ARTIFACT_LINEAGE_CASE_RESULTS);
const ALL_ACTUALLY_EXECUTED_MUTATION_IDS = Object.freeze([...new Set([
  ...RAW_ACTUALLY_EXECUTED_MUTATION_IDS,
  ...SIDE_ROLE_MATERIALS.flatMap((material) => actuallyExecutedRejectedOrInvalidMutationIds(material.caseResults)),
])].sort());

function aggregateOracleRoot(results: readonly (ArtifactLineageCaseResultV1 | RoleQualificationCaseResult)[], field: "oracleCaseDigest" | "caseDigest"): Hash {
  return hashDomain("aloha/artifact-lineage/verifier-aggregate-root/v1", {
    predicateSpecDigest: ARTIFACT_LINEAGE_PREDICATE_SPEC.specDigest,
    field,
    digests: results.map((result) => result[field]).sort(),
  });
}

const aggregateResults = Object.freeze([
  ...ARTIFACT_LINEAGE_CASE_RESULTS,
  ...SIDE_ROLE_MATERIALS.flatMap((material) => material.caseResults),
]);

export const ARTIFACT_LINEAGE_ACTUALLY_EXECUTED_REJECTED_OR_INVALID_MUTATION_IDS = ALL_ACTUALLY_EXECUTED_MUTATION_IDS;
export const ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS = Object.freeze({
  caseSetRoot: aggregateOracleRoot(aggregateResults, "caseDigest"),
  positiveCaseRoot: aggregateOracleRoot(aggregateResults.filter((result) => result.oracle.verdict === "pass"), "oracleCaseDigest"),
  negativeCaseRoot: aggregateOracleRoot(aggregateResults.filter((result) => result.oracle.verdict === "fail"), "oracleCaseDigest"),
  invalidCaseRoot: aggregateOracleRoot(aggregateResults.filter((result) => result.oracle.verdict === "invalid"), "oracleCaseDigest"),
  independentOracleCaseRoot: aggregateOracleRoot(aggregateResults, "oracleCaseDigest"),
  independentOracleCaseCount: String(aggregateResults.length),
});
export const ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL: ArtifactLineageVerifierQualificationMaterialV1 = Object.freeze({
  predicateSpec: ARTIFACT_LINEAGE_PREDICATE_SPEC,
  roleMaterials: Object.freeze([
    {
      roleId: ARTIFACT_LINEAGE_OBSERVER_ROLE.roleId,
      predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
      oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
      roots: { roleId: ARTIFACT_LINEAGE_OBSERVER_ROLE.roleId as ArtifactLineageRoleId, ...ARTIFACT_LINEAGE_CASE_ROOTS },
      actuallyExecutedRejectedOrInvalidMutationIds: RAW_ACTUALLY_EXECUTED_MUTATION_IDS,
    },
    ...SIDE_ROLE_MATERIALS.map((material) => ({
      roleId: material.roleId,
      predicateProgramDescriptorDigest: material.predicateProgramDescriptorDigest,
      oracleProgramDescriptorDigest: material.oracleProgramDescriptorDigest,
      roots: material.roots,
      actuallyExecutedRejectedOrInvalidMutationIds: actuallyExecutedRejectedOrInvalidMutationIds(material.caseResults),
    })),
  ]),
  caseResults: aggregateResults,
  caseSetRoot: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.caseSetRoot,
  positiveCaseRoot: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.positiveCaseRoot,
  negativeCaseRoot: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.negativeCaseRoot,
  invalidCaseRoot: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.invalidCaseRoot,
  independentOracleCaseRoot: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.independentOracleCaseRoot,
  independentOracleCaseCount: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.independentOracleCaseCount,
  actuallyExecutedRejectedOrInvalidMutationIds: ALL_ACTUALLY_EXECUTED_MUTATION_IDS,
  authority: false,
});

export {
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION,
  ARTIFACT_LINEAGE_ROLE_CASE_ROOTS,
  ARTIFACT_LINEAGE_ROLE_QUALIFICATION_MATERIALS,
  ARTIFACT_LINEAGE_ROLE_ACTUALLY_EXECUTED_REJECTED_OR_INVALID_MUTATION_IDS,
  ARTIFACT_LINEAGE_SIDE_ROLE_INDEPENDENT_ORACLE_CASE_ROOT,
  ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION,
  ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION,
} from "./role-qualification.ts";
export type {
  ArtifactLineageRoleId,
  InvocationQualificationFixture,
  RoleQualificationCase,
  RoleQualificationCaseResult,
  RoleQualificationCaseRoots,
  RoleQualificationMaterial,
} from "./role-qualification.ts";
