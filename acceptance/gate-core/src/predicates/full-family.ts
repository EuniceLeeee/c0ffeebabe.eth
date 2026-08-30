import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  decodeArtifactBytes,
  type ArtifactResolutionClaimV1,
} from "../../../../specs/artifact-resolution/src/index.ts";
import {
  assertExactKeys,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  exactOutcomePartitionRootV1,
  validateCandidateFinalOutcomeV1,
  type CandidateFinalOutcomeWireV1,
} from "../../../../specs/candidate-final-outcome/src/index.ts";
import {
  decodeFullFamilySourcePlanEvidenceReceipt,
  decodeFullFamilySourcePlanExecution,
  decodeFullFamilySourcePlanRef,
  fullFamilySourcePlanIdentity,
  sealFullFamilySourceCoverage,
  type SourcePlanExecutionV1,
} from "../../../../specs/full-family-facts/src/source-wire.ts";
import {
  buildFullFamilyPersistedGraph,
  decodeFullFamilyActionOwnerArtifact,
  decodeFullFamilyInstancePublication,
  decodeFullFamilyPersistedGraphEdge,
  decodeFullFamilySourcePlanPhysicalObservation,
  decodeFullFamilyStageCapabilityRef,
  decodeFullFamilySearchSource,
  fullFamilySearchArtifactHash,
  fullFamilySearchPayloadHash,
  sealFullFamilyInstanceCatalog,
  type FullFamilyInstancePublicationV1,
  type FullFamilyPersistedGraphEdgeV1,
  type FullFamilySearchCoarseArtifactV1,
} from "../../../../specs/full-family-facts/src/runtime-wire.ts";
import { decodeReleaseIntent } from "../../../../specs/release-intent/src/index.ts";
import {
  decodeFullFamilyFactLocator,
  decodeFullFamilyArtifactRefIndexV1,
  decodeFullFamilyArtifactRefPageV1,
  decodeFullFamilyFactBundleStorageV1,
  decodeFullFamilyCandidateProofVerifierBinding,
  decodeFullFamilyStoredItemV1,
  decodeFullFamilyEvidenceArtifact,
  decodeFullFamilyOutcomeArtifact,
  decodeFullFamilyReleaseProjectionArtifact,
  decodeFullFamilySourceCoverageArtifact,
  decodeFullFamilyReadyRecord,
  encodeFullFamilyArtifactRefIndexV1,
  encodeFullFamilyArtifactRefPageV1,
  encodeFullFamilyFactBundleStorageV1,
  evaluateFullFamilyPredicate,
  FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS,
  FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST,
  FULL_FAMILY_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  FULL_FAMILY_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  FULL_FAMILY_PREDICATE_SPEC,
  referencedFullFamilyArtifactDigests,
  materializeFullFamilyFactBundleStorageV1,
  type FamilyEvidenceItemV1,
  type FamilyOutcomeItemV1,
  type FamilyReleaseSetV1,
  type FullFamilyFactBundleV1,
  type FullFamilyGeneratedRuntimeMetadataV1,
  type FullFamilyEvidenceRoleV1,
  type FullFamilyReasonCode,
} from "../../../full-family-facts/src/runtime.ts";
import {
  candidatePartitionProofSigningBytes,
  decodeCandidatePartitionProofBytes,
  type CandidateRecordV1,
} from "../../../../specs/candidate-partition-authority/src/index.ts";
import { decodeNominationClosureBytesV1 } from "../../../../specs/nomination-authority/src/index.ts";
import type {
  PredicateEvaluatorV1,
  PredicateIssueSinkV1,
  PredicateRuntimeFactsV1,
} from "../predicate-composition.ts";
import type { GateReasonCode, GateVerdict } from "../predicate-contract.ts";
import {
  COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  createCommonEnvelopeRoleContractV1,
} from "../../../../specs/qualification/src/index.ts";

const FULL_FAMILY_ADAPTER_VERSION = "full-family-gate-core-adapter-v11";
const FULL_FAMILY_INVOCATION_SEAL_ROLE_ID = createCommonEnvelopeRoleContractV1(
  FULL_FAMILY_PREDICATE_SPEC.predicateId,
).signedInvocationRoleId;
const CANDIDATE_PROOF_VERIFIER_AUTHORITY_ROLE = "candidate-partition-proof-verifier";

const BUNDLE_SCHEMA_REF = Object.freeze({
  id: FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST.id,
  version: FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST.version,
  schemaHash: FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST.schemaHash,
});

function artifactSchemaRef(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }) {
  return Object.freeze({ id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash });
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function mapReasonCode(code: FullFamilyReasonCode): GateReasonCode {
  switch (code) {
    case "release-set-mismatch":
    case "family-denominator-mismatch":
    case "family-definition-mismatch":
      return "registry-mismatch";
    case "producer-verdict-injection":
      return "predicate-observation-mismatch";
    case "malformed-fact":
      return "schema-invalid";
    case "contract-failed":
      return "predicate-failed";
    default:
      return "predicate-observation-mismatch";
  }
}

interface RuntimeArtifactIndexV1 {
  readonly refsById: ReadonlyMap<Hash, PredicateRuntimeFactsV1["refs"][number]>;
  readonly claimsByRef: ReadonlyMap<Hash, ArtifactResolutionClaimV1>;
  readonly policiesByHash: ReadonlyMap<Hash, PredicateRuntimeFactsV1["policies"][number]>;
  readonly leasesById: ReadonlyMap<Hash, PredicateRuntimeFactsV1["leases"][number]>;
}

type ReportIssue = (code: GateReasonCode, path: string) => void;

function indexRuntime(runtime: PredicateRuntimeFactsV1, report: ReportIssue): RuntimeArtifactIndexV1 {
  const refsById = new Map<Hash, PredicateRuntimeFactsV1["refs"][number]>();
  for (const [index, ref] of runtime.refs.entries()) {
    if (refsById.has(ref.artifactRefId)) report("artifact-ref-mismatch", `$.artifactRefs[${index}]`);
    refsById.set(ref.artifactRefId, ref);
  }
  const claimsByRef = new Map<Hash, ArtifactResolutionClaimV1>();
  const claimIds = new Set<Hash>();
  for (const [index, claim] of runtime.claims.entries()) {
    if (claimIds.has(claim.claimId) || claimsByRef.has(claim.artifactRefId)) {
      report("artifact-claim-mismatch", `$.artifactClaims[${index}]`);
    }
    claimIds.add(claim.claimId);
    claimsByRef.set(claim.artifactRefId, claim);
  }
  const policiesByHash = new Map<Hash, PredicateRuntimeFactsV1["policies"][number]>();
  for (const [index, policy] of runtime.policies.entries()) {
    if (policiesByHash.has(policy.policyHash)) report("resolver-policy-mismatch", `$.resolverPolicies[${index}]`);
    policiesByHash.set(policy.policyHash, policy);
  }
  const leasesById = new Map<Hash, PredicateRuntimeFactsV1["leases"][number]>();
  for (const [index, lease] of runtime.leases.entries()) {
    if (leasesById.has(lease.receiptId)) report("retention-lease-mismatch", `$.retentionLeases[${index}]`);
    leasesById.set(lease.receiptId, lease);
  }
  return Object.freeze({ refsById, claimsByRef, policiesByHash, leasesById });
}

function bindArtifact(
  artifactRefId: Hash,
  expectedContentSha256: Hash,
  runtime: PredicateRuntimeFactsV1,
  index: RuntimeArtifactIndexV1,
  report: ReportIssue,
): Uint8Array | null {
  const path = `$.artifactRefs.${artifactRefId}`;
  const ref = index.refsById.get(artifactRefId);
  if (ref === undefined) {
    report("artifact-ref-mismatch", path);
    return null;
  }
  if (ref.contentSha256 !== expectedContentSha256) report("artifact-content-mismatch", `${path}.contentSha256`);
  const claim = index.claimsByRef.get(artifactRefId);
  if (claim === undefined) {
    report("artifact-claim-missing", path);
    return null;
  }
  if (claim.resolverPolicyHash !== ref.resolverPolicyHash || claim.outcome !== "content-observed" || claim.observedMirror === null) {
    report("artifact-claim-mismatch", `${path}.claim`);
    return null;
  }
  const policy = index.policiesByHash.get(ref.resolverPolicyHash);
  if (policy === undefined) report("resolver-policy-missing", path);
  const lease = index.leasesById.get(ref.retentionLeaseReceiptId);
  if (lease === undefined) report("retention-lease-missing", path);
  if (policy === undefined || lease === undefined) return null;
  if (BigInt(ref.byteLength) > BigInt(policy.maxByteLength)) report("resolver-policy-mismatch", path);
  const mirror = claim.observedMirror;
  if (
    mirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash
    || mirror.objectKey !== ref.immutableMirrorLocator.objectKey
    || mirror.contentSha256 !== ref.contentSha256
    || mirror.byteLength !== ref.byteLength
    || mirror.mediaType !== ref.mediaType
    || !sameJson(mirror.schema, ref.schema)
  ) report("artifact-content-mismatch", path);
  if (
    lease.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash
    || lease.objectKey !== ref.immutableMirrorLocator.objectKey
    || lease.contentSha256 !== ref.contentSha256
  ) report("retention-lease-mismatch", path);
  let bytes: Uint8Array;
  try {
    bytes = decodeArtifactBytes(mirror.bytes, `${path}.observedMirror.bytes`);
  } catch {
    report("artifact-content-mismatch", `${path}.observedMirror.bytes`);
    return null;
  }
  if (sha256Hex(bytes) !== expectedContentSha256 || String(bytes.byteLength) !== ref.byteLength) {
    report("artifact-content-mismatch", `${path}.observedMirror.bytes`);
  }
  let observationMatches = 0;
  for (const observation of runtime.observations) {
    const matches = observation.rawArtifactRefs.filter(candidate => candidate.artifactRefId === artifactRefId);
    observationMatches += matches.length;
    if (matches.some(candidate => !sameJson(candidate, ref)) || (matches.length > 0 && !observation.observedClaimIds.includes(claim.claimId))) {
      report("observation-mismatch", `$.observations.${observation.observationId}`);
    }
  }
  if (observationMatches !== 1) report("predicate-observation-missing", path);
  return bytes;
}

function validateExactArtifactClosure(
  expected: ReadonlyMap<Hash, Hash>,
  runtime: PredicateRuntimeFactsV1,
  index: RuntimeArtifactIndexV1,
  report: ReportIssue,
): void {
  if (expected.size !== index.refsById.size) report("artifact-ref-mismatch", "$.artifactRefs");
  for (const ref of runtime.refs) if (!expected.has(ref.artifactRefId)) report("artifact-ref-mismatch", `$.artifactRefs.${ref.artifactRefId}`);
  if (runtime.claims.length !== expected.size || index.claimsByRef.size !== expected.size) report("artifact-claim-mismatch", "$.artifactClaims");
  for (const claim of runtime.claims) if (!expected.has(claim.artifactRefId)) report("artifact-claim-mismatch", `$.artifactClaims.${claim.claimId}`);
  const expectedPolicies = new Set(runtime.refs.filter(ref => expected.has(ref.artifactRefId)).map(ref => ref.resolverPolicyHash));
  const expectedLeases = new Set(runtime.refs.filter(ref => expected.has(ref.artifactRefId)).map(ref => ref.retentionLeaseReceiptId));
  if (!sameIds([...expectedPolicies], runtime.policies.map(policy => policy.policyHash))) report("resolver-policy-mismatch", "$.resolverPolicies");
  if (!sameIds([...expectedLeases], runtime.leases.map(lease => lease.receiptId))) report("retention-lease-mismatch", "$.retentionLeases");
  const observationIds = runtime.observations.map(observation => observation.observationId);
  if (new Set(observationIds).size !== observationIds.length) report("observation-mismatch", "$.observations");
  for (const observation of runtime.observations) {
    for (const ref of observation.rawArtifactRefs) {
      if (!expected.has(ref.artifactRefId)) report("observation-mismatch", `$.observations.${observation.observationId}.rawArtifactRefs`);
    }
  }
}

function decodeCanonicalArtifact<T>(
  bytes: Uint8Array,
  decode: (value: Uint8Array) => T,
  path: string,
  report: ReportIssue,
): T | null {
  try {
    const value = decode(bytes);
    if (!sameBytes(bytes, encodeCanonicalBytes(value))) {
      report("canonical-bytes-mismatch", path);
      return null;
    }
    return value;
  } catch {
    report("schema-invalid", path);
    return null;
  }
}

function validateReadyBinding(
  bundle: FullFamilyFactBundleV1,
  readyBytes: Uint8Array,
  report: ReportIssue,
): void {
  const ready = decodeCanonicalArtifact(
    readyBytes,
    value => decodeFullFamilyReadyRecord(value),
    "$.runtime.readyRecord",
    report,
  );
  if (ready === null) return;
  const runtime = bundle.runtime;
  if (
    ready.generationId !== runtime.generationId
    || !sameJson(ready.cutoff, runtime.readyCutoff)
    || ready.recentObservationRange.from !== runtime.recentObservationStartBlock
    || ready.recentObservationRange.to !== runtime.recentObservationEndBlock
    || ready.definitionCatalogRoot !== runtime.definitionCatalogRoot
    || ready.sourceCoverageRoot !== runtime.sourceCoverageRoot
    || ready.candidatePartitionRoot !== runtime.candidatePartitionRoot
    || ready.nominationClosureRoot !== runtime.nominationClosureRoot
    || ready.nominationClosureStorageHash !== runtime.nominationClosureStorageHash
    || ready.candidatePartitionProofStorageHash !== runtime.candidatePartitionProofStorageHash
    || ready.releaseProvenanceHash !== runtime.releaseProvenanceHash
    || ready.instanceCatalogRoot !== runtime.instanceCatalogRoot
    || ready.graphRoot !== runtime.graphRoot
    || ready.readyRecordHash !== runtime.readyRecordHash
    || ready.instanceCount !== runtime.instanceCount
    || ready.edgeCount !== runtime.edgeCount
  ) report("predicate-observation-mismatch", "$.runtime.readyRecord");
}

function validateReleaseIntentBinding(
  bundle: FullFamilyFactBundleV1,
  bytes: Uint8Array,
  report: ReportIssue,
): void {
  const release = decodeCanonicalArtifact(
    bytes,
    value => decodeReleaseIntent(decodeCanonicalJson(value)),
    "$.releaseIntent.sourceArtifact",
    report,
  );
  if (release === null) return;
  if (
    release.releaseIntentRoot !== bundle.runtime.releaseIntentRoot
    || !sameIds(release.families.map(entry => entry.familyId), bundle.releaseIntent.entries.map(entry => entry.familyId))
  ) report("registry-mismatch", "$.releaseIntent.sourceArtifact");
}

interface FullFamilyNestedExpectationV1 {
  readonly schema: Readonly<{ readonly id: string; readonly version: string; readonly schemaHash: Hash }>;
  readonly semanticIdentity: unknown;
  readonly validate: (bytes: Uint8Array, report: ReportIssue) => void;
}

function validateExactNestedPayload<T>(
  bytes: Uint8Array,
  decode: (value: Uint8Array) => T,
  expected: T,
  path: string,
  report: ReportIssue,
): void {
  const decoded = decodeCanonicalArtifact(bytes, decode, path, report);
  if (decoded !== null && !sameJson(decoded, expected)) report("predicate-observation-mismatch", path);
}

function registerNestedExpectation(
  output: Map<Hash, FullFamilyNestedExpectationV1>,
  artifactRefId: Hash,
  expectation: FullFamilyNestedExpectationV1,
): void {
  const previous = output.get(artifactRefId);
  if (previous !== undefined) {
    if (!sameJson(previous.schema, expectation.schema)
      || !sameJson(previous.semanticIdentity, expectation.semanticIdentity)) {
      throw new TypeError("full-family artifact ref is reused for different semantics");
    }
    return;
  }
  output.set(artifactRefId, expectation);
}

function releaseProjectionExpectation(
  role: "definition-catalog" | "runtime-composition",
  releaseSet: FamilyReleaseSetV1,
  path: string,
): FullFamilyNestedExpectationV1 {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-family-release-projection-artifact" as const,
    role,
    contractRoot: releaseSet.contractRoot,
    count: releaseSet.count,
    entrySetRoot: releaseSet.entrySetRoot,
    entries: releaseSet.entries,
  });
  return Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.releaseProjection),
    semanticIdentity: payload,
    validate: (bytes: Uint8Array, report: ReportIssue) => validateExactNestedPayload(
      bytes,
      decodeFullFamilyReleaseProjectionArtifact,
      payload,
      path,
      report,
    ),
  });
}

interface ProductionFamilyCatalogV1 {
  readonly releaseIntentRoot: Hash;
  readonly proposedCapabilitySetRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly entries: readonly Readonly<{
    readonly familyId: string;
    readonly familyDefinitionHash: Hash;
    readonly actionOwnerRefs: readonly Hash[];
    readonly sourcePlanRefs: FullFamilyGeneratedRuntimeMetadataV1["families"][number]["sourcePlanRefs"];
    readonly definitionCatalogLeafDigest: Hash;
  }>[];
}

function exactHash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || value === `0x${"0".repeat(64)}`) {
    throw new TypeError(`invalid hash at ${path}`);
  }
  return value as Hash;
}

function exactString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid string at ${path}`);
  return value;
}

function exactArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`invalid array at ${path}`);
  return value;
}

function decodeProductionDefinitionCatalog(bytes: Uint8Array): ProductionFamilyCatalogV1 {
  const decoded = decodeCanonicalObject(bytes, "definitionCatalog");
  assertExactKeys(decoded, [
    "schemaVersion", "releaseIntentRoot", "capabilityIndexRoot", "proposedCapabilitySetRoot", "entries",
    "definitionCatalogRoot",
  ], "definitionCatalog");
  if (decoded.schemaVersion !== 1) throw new TypeError("definition catalog schema version mismatch");
  exactHash(decoded.capabilityIndexRoot, "definitionCatalog.capabilityIndexRoot");
  const entries = exactArray(decoded.entries, "definitionCatalog.entries").map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("definition catalog entry invalid");
    const entry = value as Record<string, unknown>;
    assertExactKeys(entry, [
      "familyId", "familyDefinitionHash", "issuerRef", "authorityRef", "lifecycleRefs", "extensionRefs",
      "actionOwnerRefs", "factContractRefs", "sourcePlanRefs", "definitionCatalogLeafDigest", "capabilityCatalogRoot",
    ], `definitionCatalog.entries[${index}]`);
    const familyId = exactString(entry.familyId, `definitionCatalog.entries[${index}].familyId`);
    const familyDefinitionHash = exactHash(entry.familyDefinitionHash, `definitionCatalog.entries[${index}].familyDefinitionHash`);
    exactHash(entry.issuerRef, `definitionCatalog.entries[${index}].issuerRef`);
    exactHash(entry.authorityRef, `definitionCatalog.entries[${index}].authorityRef`);
    exactHash(entry.capabilityCatalogRoot, `definitionCatalog.entries[${index}].capabilityCatalogRoot`);
    const lifecycle = entry.lifecycleRefs as Record<string, unknown>;
    assertExactKeys(lifecycle, ["nomination", "identity", "materialization", "projection", "rehydration"], `definitionCatalog.entries[${index}].lifecycleRefs`);
    for (const [stage, ref] of Object.entries(lifecycle)) {
      const stageRef = decodeFullFamilyStageCapabilityRef(ref, `definitionCatalog.entries[${index}].lifecycleRefs.${stage}`);
      if (stageRef.familyId !== familyId || stageRef.familyDefinitionHash !== familyDefinitionHash || stageRef.stage !== stage) {
        throw new TypeError("definition catalog lifecycle binding mismatch");
      }
    }
    for (const [extensionIndex, ref] of exactArray(entry.extensionRefs, `definitionCatalog.entries[${index}].extensionRefs`).entries()) {
      const stageRef = decodeFullFamilyStageCapabilityRef(ref, `definitionCatalog.entries[${index}].extensionRefs[${extensionIndex}]`);
      if (stageRef.familyId !== familyId || stageRef.familyDefinitionHash !== familyDefinitionHash || stageRef.stage !== "capability") {
        throw new TypeError("definition catalog extension binding mismatch");
      }
    }
    const actionOwnerRefs = exactArray(entry.actionOwnerRefs, `definitionCatalog.entries[${index}].actionOwnerRefs`)
      .map(ownerRef => exactHash(ownerRef, `definitionCatalog.entries[${index}].actionOwnerRefs`));
    for (const [factIndex, fact] of exactArray(entry.factContractRefs, `definitionCatalog.entries[${index}].factContractRefs`).entries()) {
      if (fact === null || typeof fact !== "object" || Array.isArray(fact)) throw new TypeError("fact contract ref invalid");
      assertExactKeys(fact, ["factContractId", "version", "schemaHash"], `definitionCatalog.entries[${index}].factContractRefs[${factIndex}]`);
      const record = fact as Record<string, unknown>;
      exactString(record.factContractId, "factContractId");
      exactString(record.version, "factContractVersion");
      exactHash(record.schemaHash, "factContractSchemaHash");
    }
    const sourcePlanRefs = exactArray(entry.sourcePlanRefs, `definitionCatalog.entries[${index}].sourcePlanRefs`)
      .map((plan, planIndex) => decodeFullFamilySourcePlanRef(plan, `definitionCatalog.entries[${index}].sourcePlanRefs[${planIndex}]`));
    if (sourcePlanRefs.some(plan => plan.familyDefinitionHash !== familyDefinitionHash)) throw new TypeError("catalog source plan family splice");
    return Object.freeze({
      familyId,
      familyDefinitionHash,
      actionOwnerRefs: Object.freeze(actionOwnerRefs),
      sourcePlanRefs: Object.freeze(sourcePlanRefs),
      definitionCatalogLeafDigest: exactHash(entry.definitionCatalogLeafDigest, `definitionCatalog.entries[${index}].definitionCatalogLeafDigest`),
    });
  });
  if (entries.length === 0 || new Set(entries.map(entry => entry.familyId)).size !== entries.length
    || !sameJson(entries.map(entry => entry.familyId), [...entries].sort((a, b) => a.familyId.localeCompare(b.familyId)).map(entry => entry.familyId))) {
    throw new TypeError("definition catalog denominator invalid");
  }
  const definitionCatalogRoot = exactHash(decoded.definitionCatalogRoot, "definitionCatalog.definitionCatalogRoot");
  if (definitionCatalogRoot !== hashDomain("aloha/family-definition-catalog/v1", entries.map(entry => entry.definitionCatalogLeafDigest).sort())) {
    throw new TypeError("definition catalog root mismatch");
  }
  return Object.freeze({
    releaseIntentRoot: exactHash(decoded.releaseIntentRoot, "definitionCatalog.releaseIntentRoot"),
    proposedCapabilitySetRoot: exactHash(decoded.proposedCapabilitySetRoot, "definitionCatalog.proposedCapabilitySetRoot"),
    definitionCatalogRoot,
    entries: Object.freeze(entries),
  });
}

function decodeProductionRuntimeMetadata(bytes: Uint8Array): FullFamilyGeneratedRuntimeMetadataV1 & { readonly proposedCapabilitySetRoot: Hash } {
  const decoded = decodeCanonicalObject(bytes, "runtimeComposition");
  assertExactKeys(decoded, [
    "proposedCapabilitySetRoot", "nominationProgramSetRoot", "nominationProgramProposalLeafDigests", "releaseIntentRoot",
    "definitionCatalogRoot", "descriptorRoot", "families",
  ], "runtimeComposition");
  exactHash(decoded.nominationProgramSetRoot, "runtimeComposition.nominationProgramSetRoot");
  for (const digest of exactArray(decoded.nominationProgramProposalLeafDigests, "runtimeComposition.nominationProgramProposalLeafDigests")) {
    exactHash(digest, "runtimeComposition.nominationProgramProposalLeafDigests");
  }
  const families = exactArray(decoded.families, "runtimeComposition.families").map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("runtime family invalid");
    const family = value as Record<string, unknown>;
    assertExactKeys(family, [
      "familyId", "familyDefinitionHash", "lifecycleRefs", "stageDefinitionRoot", "sourcePlanRoot", "sourcePlanRefs",
      "extensions", "runtimeAdapters", "actionOwners",
    ], `runtimeComposition.families[${index}]`);
    const familyId = exactString(family.familyId, `runtimeComposition.families[${index}].familyId`);
    const familyDefinitionHash = exactHash(family.familyDefinitionHash, `runtimeComposition.families[${index}].familyDefinitionHash`);
    exactHash(family.stageDefinitionRoot, `runtimeComposition.families[${index}].stageDefinitionRoot`);
    const sourcePlanRefs = exactArray(family.sourcePlanRefs, `runtimeComposition.families[${index}].sourcePlanRefs`)
      .map((plan, planIndex) => decodeFullFamilySourcePlanRef(plan, `runtimeComposition.families[${index}].sourcePlanRefs[${planIndex}]`));
    if (sourcePlanRefs.some(plan => plan.familyDefinitionHash !== familyDefinitionHash)) throw new TypeError("runtime source plan family splice");
    if (new Set(sourcePlanRefs.map(fullFamilySourcePlanIdentity)).size !== sourcePlanRefs.length) throw new TypeError("runtime source plan duplicate");
    exactArray(family.extensions, `runtimeComposition.families[${index}].extensions`);
    exactArray(family.runtimeAdapters, `runtimeComposition.families[${index}].runtimeAdapters`);
    exactArray(family.actionOwners, `runtimeComposition.families[${index}].actionOwners`);
    return Object.freeze({
      familyId,
      familyDefinitionHash,
      sourcePlanRoot: exactHash(family.sourcePlanRoot, `runtimeComposition.families[${index}].sourcePlanRoot`),
      sourcePlanRefs: Object.freeze([...sourcePlanRefs].sort((left, right) => fullFamilySourcePlanIdentity(left).localeCompare(fullFamilySourcePlanIdentity(right)))),
    });
  });
  if (families.length === 0 || new Set(families.map(family => family.familyId)).size !== families.length) throw new TypeError("runtime family denominator invalid");
  return Object.freeze({
    proposedCapabilitySetRoot: exactHash(decoded.proposedCapabilitySetRoot, "runtimeComposition.proposedCapabilitySetRoot"),
    releaseIntentRoot: exactHash(decoded.releaseIntentRoot, "runtimeComposition.releaseIntentRoot"),
    definitionCatalogRoot: exactHash(decoded.definitionCatalogRoot, "runtimeComposition.definitionCatalogRoot"),
    descriptorRoot: exactHash(decoded.descriptorRoot, "runtimeComposition.descriptorRoot"),
    families: Object.freeze([...families].sort((left, right) => left.familyId.localeCompare(right.familyId))),
  });
}

function exactReleaseFamilyEntries(releaseSet: FamilyReleaseSetV1, entries: readonly Readonly<{ familyId: string; familyDefinitionHash: Hash }>[]): boolean {
  return releaseSet.count === String(entries.length) && sameJson(
    releaseSet.entries.map(entry => ({ familyId: entry.familyId, familyDefinitionHash: entry.familyDefinitionHash })),
    entries.map(entry => ({ familyId: entry.familyId, familyDefinitionHash: entry.familyDefinitionHash })),
  );
}

function productionDefinitionCatalogExpectation(releaseSet: FamilyReleaseSetV1): FullFamilyNestedExpectationV1 {
  return Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.definitionCatalog),
    semanticIdentity: Object.freeze({ role: "definition-catalog", sourceArtifactContentSha256: releaseSet.sourceArtifactContentSha256 }),
    validate: (bytes: Uint8Array, report: ReportIssue) => {
      try {
        const catalog = decodeProductionDefinitionCatalog(bytes);
        if (!exactReleaseFamilyEntries(releaseSet, catalog.entries)) {
          throw new TypeError("definition catalog release projection mismatch");
        }
      } catch {
        report("registry-mismatch", "$.definitionCatalog.sourceArtifact");
      }
    },
  });
}

function productionRuntimeCompositionExpectation(releaseSet: FamilyReleaseSetV1): FullFamilyNestedExpectationV1 {
  return Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.runtimeComposition),
    semanticIdentity: Object.freeze({ role: "runtime-composition", sourceArtifactContentSha256: releaseSet.sourceArtifactContentSha256 }),
    validate: (bytes: Uint8Array, report: ReportIssue) => {
      try {
        const metadata = decodeProductionRuntimeMetadata(bytes);
        if (releaseSet.contractRoot !== metadata.descriptorRoot || !exactReleaseFamilyEntries(releaseSet, metadata.families)) {
          throw new TypeError("runtime composition release projection mismatch");
        }
      } catch {
        report("registry-mismatch", "$.runtimeComposition.sourceArtifact");
      }
    },
  });
}

function deriveProductionRuntimeMetadata(
  bundle: FullFamilyFactBundleV1,
  bytesByRef: ReadonlyMap<Hash, Uint8Array>,
  report: ReportIssue,
): FullFamilyGeneratedRuntimeMetadataV1 | null {
  const catalogBytes = bytesByRef.get(bundle.definitionCatalog.sourceArtifactRefId);
  const runtimeBytes = bytesByRef.get(bundle.runtimeComposition.sourceArtifactRefId);
  if (catalogBytes === undefined || runtimeBytes === undefined) {
    report("predicate-observation-missing", "$.runtimeComposition.sourceArtifact");
    return null;
  }
  try {
    const catalog = decodeProductionDefinitionCatalog(catalogBytes);
    const metadata = decodeProductionRuntimeMetadata(runtimeBytes);
    if (catalog.releaseIntentRoot !== metadata.releaseIntentRoot
      || catalog.releaseIntentRoot !== bundle.runtime.releaseIntentRoot
      || catalog.proposedCapabilitySetRoot !== metadata.proposedCapabilitySetRoot
      || metadata.definitionCatalogRoot !== bundle.runtime.definitionCatalogRoot
      || metadata.descriptorRoot !== bundle.runtime.generatedRuntimeDescriptorRoot
      || metadata.descriptorRoot !== bundle.runtime.runtimeCompositionRoot
      || catalog.entries.length !== metadata.families.length) {
      throw new TypeError("production release artifact root splice");
    }
    for (const family of metadata.families) {
      const entry = catalog.entries.find(value => value.familyId === family.familyId);
      if (entry === undefined
        || entry.familyDefinitionHash !== family.familyDefinitionHash
        || !sameJson(
          [...entry.sourcePlanRefs].sort((left, right) => fullFamilySourcePlanIdentity(left).localeCompare(fullFamilySourcePlanIdentity(right))),
          family.sourcePlanRefs,
        )) {
        throw new TypeError("production release artifact family splice");
      }
    }
    return metadata;
  } catch {
    report("registry-mismatch", "$.runtimeComposition.sourceArtifact");
    return null;
  }
}

function instanceIdentityRef(familyDefinitionHash: Hash, instanceKey: string): Hash {
  return hashDomain("aloha/full-family/instance-identity-ref/v1", {
    familyDefinitionHash,
    instanceKey,
  });
}

function decodeCanonicalObject(bytes: Uint8Array, path: string): Record<string, unknown> {
  const decoded = decodeCanonicalJson(bytes);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError(`${path} must be an object`);
  }
  return decoded as Record<string, unknown>;
}

function validateCapabilityArtifact(
  bytes: Uint8Array,
  item: FamilyEvidenceItemV1,
  familyDefinitionHash: Hash,
  capabilityKind: "coarse" | "exact",
): void {
  const decoded = decodeCanonicalObject(bytes, "generatedCapabilityRef");
  const ref = decodeFullFamilyStageCapabilityRef(decoded, "generatedCapabilityRef");
  if (ref.familyId !== item.familyId
    || ref.familyDefinitionHash !== familyDefinitionHash
    || ref.stage !== "capability"
    || ref.capabilityId !== `family.${item.familyId}.${capabilityKind}`
    || ref.ownerRef !== item.subjectKey
    || ref.ownerRef !== item.itemId) {
    throw new TypeError("generated capability evidence binding mismatch");
  }
}

function validateCoarseArtifact(bytes: Uint8Array, item: FamilyEvidenceItemV1, expectedStatus: "rankable" | "unavailable"): FullFamilySearchCoarseArtifactV1 {
  const observation = decodeCanonicalObject(bytes, "familySearchCoarseObservation");
  assertExactKeys(observation, [
    "schemaVersion", "kind", "familyId", "familyDefinitionHash", "releaseMembershipRoot",
    "binding", "routeHandleBindingHash", "amountHash", "projectionId", "stateOutcome",
    "coarseOutcome", "observationRoot",
  ], "familySearchCoarseObservation");
  const { observationRoot, ...observationBody } = observation;
  const binding = observation.binding as { readonly edgeId?: unknown };
  const coarseOutcome = observation.coarseOutcome as { readonly kind?: unknown; readonly artifact?: unknown };
  if (observation.schemaVersion !== 1
    || observation.kind !== "aloha.family-runtime-coarse-edge-sweep-observation-v1"
    || observationRoot !== hashDomain("aloha/family-runtime-coarse-edge-sweep-observation/v1", observationBody)
    || observation.familyId !== item.familyId
    || binding.edgeId !== item.subjectKey
    || coarseOutcome.kind !== "verified") {
    throw new TypeError("coarse owner observation binding mismatch");
  }
  const value = coarseOutcome.artifact;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("coarse owner observation artifact is invalid");
  }
  assertExactKeys(value, [
    "kind", "status", "source", "routeBindingHash", "objectiveRef", "amountHash", "payload", "payloadHash",
    "artifactHash", "projectionHash", "stateFactsRoot", "input", "output", "conservativeOutputUpperBound",
    "inputCapacityUpperBound", "rankKey", "reasonCode",
  ], "familySearchCoarse");
  const coarse = value as unknown as FullFamilySearchCoarseArtifactV1;
  const source = decodeFullFamilySearchSource(coarse.source, "familySearchCoarse.source");
  const payload = decodeCanonicalJson(encodeCanonicalJson(coarse.payload));
  const payloadHash = fullFamilySearchPayloadHash("coarse", payload);
  if (coarse.kind !== "coarse" || coarse.status !== expectedStatus
    || coarse.payloadHash !== payloadHash
    || coarse.artifactHash !== fullFamilySearchArtifactHash({
      kind: "coarse",
      source,
      routeBindingHash: coarse.routeBindingHash,
      objectiveRef: coarse.objectiveRef,
      amountHash: coarse.amountHash,
      payloadHash,
    })
    || coarse.artifactHash !== item.itemId
    || (expectedStatus === "rankable") !== (coarse.rankKey !== null)) {
    throw new TypeError("coarse production artifact binding mismatch");
  }
  return coarse;
}

function validateActionOwnerArtifact(
  bytes: Uint8Array,
  item: FamilyEvidenceItemV1,
  familyDefinitionHash: Hash,
): void {
  const owner = decodeFullFamilyActionOwnerArtifact(decodeCanonicalJson(bytes));
  if (owner.familyId !== item.familyId
    || owner.familyDefinitionHash !== familyDefinitionHash
    || owner.actionOwnerRef !== item.itemId
    || owner.actionOwnerRef !== item.subjectKey) {
    throw new TypeError("generated action owner evidence binding mismatch");
  }
}

function evidenceExpectation(
  role: FullFamilyEvidenceRoleV1,
  item: FamilyEvidenceItemV1,
  readyRecordHash: Hash,
  path: string,
): FullFamilyNestedExpectationV1 {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-family-evidence-artifact" as const,
    readyRecordHash,
    role,
    familyId: item.familyId,
    itemId: item.itemId,
    subjectKey: item.subjectKey,
  });
  return Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.evidence),
    semanticIdentity: payload,
    validate: (bytes: Uint8Array, report: ReportIssue) => validateExactNestedPayload(
      bytes,
      decodeFullFamilyEvidenceArtifact,
      payload,
      path,
      report,
    ),
  });
}

function outcomeExpectation(
  item: FamilyOutcomeItemV1,
  readyRecordHash: Hash,
  path: string,
): FullFamilyNestedExpectationV1 {
  return Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.outcome),
    semanticIdentity: Object.freeze({
      readyRecordHash,
      familyId: item.familyId,
      itemId: item.itemId,
      candidateKey: item.candidateKey,
      instanceKey: item.instanceKey,
      outcome: item.outcome,
    }),
    validate: (bytes: Uint8Array, report: ReportIssue) => {
      const artifact = decodeCanonicalArtifact(bytes, decodeFullFamilyOutcomeArtifact, path, report);
      if (artifact !== null && (
        artifact.readyRecordHash !== readyRecordHash
        || artifact.familyId !== item.familyId
        || artifact.itemId !== item.itemId
        || artifact.candidateKey !== item.candidateKey
        || artifact.instanceKey !== item.instanceKey
        || artifact.outcome !== item.outcome
      )) report("predicate-observation-mismatch", path);
    },
  });
}

function productionEvidenceExpectation(
  role: FullFamilyEvidenceRoleV1,
  item: FamilyEvidenceItemV1,
  familyDefinitionHash: Hash,
  path: string,
): FullFamilyNestedExpectationV1 | null {
  const wrap = (
    schema: FullFamilyNestedExpectationV1["schema"],
    validateProduction: (bytes: Uint8Array) => void,
  ): FullFamilyNestedExpectationV1 => Object.freeze({
    schema,
    semanticIdentity: Object.freeze({ role, familyId: item.familyId, itemId: item.itemId, subjectKey: item.subjectKey }),
    validate: (bytes: Uint8Array, report: ReportIssue) => {
      try {
        validateProduction(bytes);
      } catch {
        report("predicate-observation-mismatch", path);
      }
    },
  });
  if (role === "declared-coarse-capability" || role === "declared-exact-capability") {
    return wrap(
      artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.generatedCapabilityRef),
      bytes => validateCapabilityArtifact(bytes, item, familyDefinitionHash, role === "declared-coarse-capability" ? "coarse" : "exact"),
    );
  }
  if (role === "instance-publication") {
    return wrap(artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.instancePublication), bytes => {
      const publication = decodeFullFamilyInstancePublication(decodeCanonicalObject(bytes, "instancePublication"));
      if (publication.familyId !== item.familyId
        || publication.familyDefinitionHash !== familyDefinitionHash
        || publication.instancePublicationHash !== item.itemId
        || instanceIdentityRef(publication.familyDefinitionHash, publication.instanceKey) !== item.subjectKey) {
        throw new TypeError("instance publication evidence binding mismatch");
      }
    });
  }
  if (role === "projected-edge") {
    return wrap(artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.graphEdge), bytes => {
      const edge = decodeFullFamilyPersistedGraphEdge(decodeCanonicalObject(bytes, "persistedGraphEdge"));
      if (edge.edgeId !== item.itemId
        || edge.owningFamilyId !== item.familyId
        || edge.owningFamilyDefinitionHash !== familyDefinitionHash
        || instanceIdentityRef(edge.owningFamilyDefinitionHash, edge.owningInstanceKey) !== item.subjectKey) {
        throw new TypeError("persisted graph edge evidence binding mismatch");
      }
    });
  }
  if (role === "coarse-rankable" || role === "coarse-unavailable") {
    return wrap(
      artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.coarseObservation),
      bytes => validateCoarseArtifact(bytes, item, role === "coarse-rankable" ? "rankable" : "unavailable"),
    );
  }
  if (role === "owned-action") {
    return wrap(
      artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.generatedActionOwner),
      bytes => validateActionOwnerArtifact(bytes, item, familyDefinitionHash),
    );
  }
  return null;
}

function expectedNestedArtifacts(
  bundle: FullFamilyFactBundleV1,
  requireProductionArtifacts: boolean,
): ReadonlyMap<Hash, FullFamilyNestedExpectationV1> {
  const output = new Map<Hash, FullFamilyNestedExpectationV1>();
  registerNestedExpectation(output, bundle.runtime.readyRecordArtifactRefId, Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.readyRecord),
    semanticIdentity: Object.freeze({ role: "ready-record", runtime: bundle.runtime }),
    validate: (bytes: Uint8Array, report: ReportIssue) => validateReadyBinding(bundle, bytes, report),
  }));
  registerNestedExpectation(output, bundle.releaseIntent.sourceArtifactRefId, Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.releaseIntent),
    semanticIdentity: Object.freeze({
      role: "release-intent",
      contractRoot: bundle.releaseIntent.contractRoot,
      entrySetRoot: bundle.releaseIntent.entrySetRoot,
      entries: bundle.releaseIntent.entries,
    }),
    validate: (bytes: Uint8Array, report: ReportIssue) => validateReleaseIntentBinding(bundle, bytes, report),
  }));
  registerNestedExpectation(output, bundle.sourceCoverage.artifactRefId, Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceCoverage),
    semanticIdentity: bundle.sourceCoverage.artifact,
    validate: (bytes: Uint8Array, report: ReportIssue) => validateExactNestedPayload(
      bytes,
      decodeFullFamilySourceCoverageArtifact,
      bundle.sourceCoverage.artifact,
      "$.sourceCoverage.artifact",
      report,
    ),
  }));
  registerNestedExpectation(output, bundle.lineage.nominationClosure.artifactRefId, Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.nominationClosure),
    semanticIdentity: bundle.lineage.nominationClosure.artifact,
    validate: (bytes: Uint8Array, report: ReportIssue) => validateExactNestedPayload(
      bytes,
      decodeNominationClosureBytesV1,
      bundle.lineage.nominationClosure.artifact,
      "$.lineage.nominationClosure",
      report,
    ),
  }));
  registerNestedExpectation(output, bundle.lineage.candidatePartitionProof.artifactRefId, Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidatePartitionProof),
    semanticIdentity: bundle.lineage.candidatePartitionProof.artifact,
    validate: (bytes: Uint8Array, report: ReportIssue) => validateExactNestedPayload(
      bytes,
      decodeCandidatePartitionProofBytes,
      bundle.lineage.candidatePartitionProof.artifact,
      "$.lineage.candidatePartitionProof",
      report,
    ),
  }));
  registerNestedExpectation(output, bundle.lineage.candidateProofVerifierBinding.artifactRefId, Object.freeze({
    schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidateProofVerifierBinding),
    semanticIdentity: bundle.lineage.candidateProofVerifierBinding.artifact,
    validate: (bytes: Uint8Array, report: ReportIssue) => validateExactNestedPayload(
      bytes,
      decodeFullFamilyCandidateProofVerifierBinding,
      bundle.lineage.candidateProofVerifierBinding.artifact,
      "$.lineage.candidateProofVerifierBinding",
      report,
    ),
  }));
  for (const [executionIndex, binding] of bundle.sourceCoverage.artifact.executions.entries()) {
    registerNestedExpectation(output, binding.executionArtifactRefId, Object.freeze({
      schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceExecution),
      semanticIdentity: Object.freeze({
        role: "source-plan-execution",
        ownerRef: binding.ownerRef,
        sourcePlanRef: binding.sourcePlanRef,
        familyDefinitionHash: binding.familyDefinitionHash,
        executionRoot: binding.executionRoot,
        evidenceRoot: binding.evidenceRoot,
        resultPartitionRoot: binding.resultPartitionRoot,
      }),
      validate: (bytes: Uint8Array, report: ReportIssue) => {
        const execution = decodeCanonicalArtifact(bytes, value => decodeFullFamilySourcePlanExecution(decodeCanonicalJson(value)), `$.sourceCoverage.executions[${executionIndex}].execution`, report);
        if (execution !== null && (
          execution.plan.ownerRef !== binding.ownerRef
          || execution.plan.sourcePlanRef !== binding.sourcePlanRef
          || execution.plan.familyDefinitionHash !== binding.familyDefinitionHash
          || execution.executionRoot !== binding.executionRoot
          || execution.sourceEvidenceRoot !== binding.evidenceRoot
          || execution.resultPartitionRoot !== binding.resultPartitionRoot
        )) report("predicate-observation-mismatch", `$.sourceCoverage.executions[${executionIndex}].execution`);
      },
    }));
    registerNestedExpectation(output, binding.evidenceArtifactRefId, Object.freeze({
      schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceEvidence),
      semanticIdentity: Object.freeze({
        role: "source-plan-evidence",
        ownerRef: binding.ownerRef,
        sourcePlanRef: binding.sourcePlanRef,
        familyDefinitionHash: binding.familyDefinitionHash,
        evidenceRoot: binding.evidenceRoot,
      }),
      validate: (bytes: Uint8Array, report: ReportIssue) => {
        const evidence = decodeCanonicalArtifact(bytes, value => decodeFullFamilySourcePlanEvidenceReceipt(decodeCanonicalJson(value)), `$.sourceCoverage.executions[${executionIndex}].evidence`, report);
        if (evidence !== null && (
          evidence.plan.ownerRef !== binding.ownerRef
          || evidence.plan.sourcePlanRef !== binding.sourcePlanRef
          || evidence.plan.familyDefinitionHash !== binding.familyDefinitionHash
          || evidence.evidenceRoot !== binding.evidenceRoot
        )) report("predicate-observation-mismatch", `$.sourceCoverage.executions[${executionIndex}].evidence`);
      },
    }));
    for (const [observationIndex, observation] of binding.physicalObservations.entries()) {
      registerNestedExpectation(output, observation.artifactRefId, Object.freeze({
        schema: artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourcePhysicalObservation),
        semanticIdentity: Object.freeze({
          role: "source-plan-physical-observation",
          rawLocatorHash: observation.rawLocatorHash,
          ownerRef: binding.ownerRef,
          sourcePlanRef: binding.sourcePlanRef,
        }),
        validate: (bytes: Uint8Array, report: ReportIssue) => {
          const physical = decodeCanonicalArtifact(bytes, value => decodeFullFamilySourcePlanPhysicalObservation(decodeCanonicalJson(value)), `$.sourceCoverage.executions[${executionIndex}].physicalObservations[${observationIndex}]`, report);
          if (physical !== null && (
            physical.familyDefinitionHash !== binding.familyDefinitionHash
            || physical.plan.ownerRef !== binding.ownerRef
            || physical.plan.sourcePlanRef !== binding.sourcePlanRef
          )) report("predicate-observation-mismatch", `$.sourceCoverage.executions[${executionIndex}].physicalObservations[${observationIndex}]`);
        },
      }));
    }
  }
  registerNestedExpectation(output, bundle.definitionCatalog.sourceArtifactRefId,
    requireProductionArtifacts
      ? productionDefinitionCatalogExpectation(bundle.definitionCatalog)
      : releaseProjectionExpectation("definition-catalog", bundle.definitionCatalog, "$.definitionCatalog.sourceArtifact"));
  registerNestedExpectation(output, bundle.runtimeComposition.sourceArtifactRefId,
    requireProductionArtifacts
      ? productionRuntimeCompositionExpectation(bundle.runtimeComposition)
      : releaseProjectionExpectation("runtime-composition", bundle.runtimeComposition, "$.runtimeComposition.sourceArtifact"));
  const partitionRoles = Object.freeze([
    ["sourcePlans", "source-plan"],
    ["universeCandidates", "universe-candidate"],
    ["instancePublications", "instance-publication"],
    ["projectedEdges", "projected-edge"],
    ["declaredCoarseCapabilities", "declared-coarse-capability"],
    ["coarseRankable", "coarse-rankable"],
    ["coarseUnavailable", "coarse-unavailable"],
    ["unrankedAdmissions", "unranked-admission"],
    ["declaredExactCapabilities", "declared-exact-capability"],
    ["ownedActions", "owned-action"],
  ] as const);
  for (const [familyIndex, family] of bundle.families.entries()) {
    for (const [partitionName, role] of partitionRoles) {
      for (const [itemIndex, item] of family[partitionName].items.entries()) {
        const path = `$.families[${familyIndex}].${partitionName}.items[${itemIndex}]`;
        registerNestedExpectation(
          output,
          item.evidenceArtifactRefId,
          (requireProductionArtifacts ? productionEvidenceExpectation(role, item, family.familyDefinitionHash, path) : null)
            ?? evidenceExpectation(role, item, bundle.runtime.readyRecordHash, path),
        );
      }
    }
    for (const [itemIndex, item] of family.outcomes.items.entries()) {
      registerNestedExpectation(
        output,
        item.evidenceArtifactRefId,
        outcomeExpectation(item, bundle.runtime.readyRecordHash, `$.families[${familyIndex}].outcomes.items[${itemIndex}]`),
      );
    }
  }
  return output;
}

function validateSourceExecutionClosure(
  bundle: FullFamilyFactBundleV1,
  generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1,
  bytesByRef: ReadonlyMap<Hash, Uint8Array>,
  report: ReportIssue,
): void {
  const readyBytes = bytesByRef.get(bundle.runtime.readyRecordArtifactRefId);
  let readyReleaseProvenanceHash: Hash | null = null;
  if (readyBytes !== undefined) {
    try {
      readyReleaseProvenanceHash = decodeFullFamilyReadyRecord(readyBytes).releaseProvenanceHash;
    } catch {
      report("schema-invalid", "$.runtime.readyRecord");
    }
  }
  let physicalAuthority: Readonly<{
    releaseBindingId: Hash;
    releaseProvenanceHash: Hash;
    sourceAuthorityRoot: Hash;
    sourceAnchorRoot: Hash;
  }> | null = null;
  const declaredPlans = generatedRuntime.families.flatMap(family => family.sourcePlanRefs)
    .sort((left, right) => fullFamilySourcePlanIdentity(left).localeCompare(fullFamilySourcePlanIdentity(right)));
  const bindings = new Map(bundle.sourceCoverage.artifact.executions.map(binding => [hashDomain(
    "aloha/source-plan-identity/v1",
    { ownerRef: binding.ownerRef, sourcePlanRef: binding.sourcePlanRef },
  ), binding]));
  if (bindings.size !== declaredPlans.length) {
    report("predicate-observation-mismatch", "$.sourceCoverage.executions");
    return;
  }
  const executions: SourcePlanExecutionV1[] = [];
  for (const plan of declaredPlans) {
    const identity = fullFamilySourcePlanIdentity(plan);
    const binding = bindings.get(identity);
    if (binding === undefined) {
      report("predicate-observation-missing", `$.sourceCoverage.executions.${identity}`);
      continue;
    }
    const executionBytes = bytesByRef.get(binding.executionArtifactRefId);
    const evidenceBytes = bytesByRef.get(binding.evidenceArtifactRefId);
    if (executionBytes === undefined || evidenceBytes === undefined) continue;
    let execution: SourcePlanExecutionV1;
    let evidence: ReturnType<typeof decodeFullFamilySourcePlanEvidenceReceipt>;
    try {
      execution = decodeFullFamilySourcePlanExecution(decodeCanonicalJson(executionBytes));
      evidence = decodeFullFamilySourcePlanEvidenceReceipt(decodeCanonicalJson(evidenceBytes));
    } catch {
      continue;
    }
    if (!sameJson(execution.plan, plan) || !sameJson(evidence.plan, plan)
      || !sameJson(execution.cutoff, bundle.runtime.readyCutoff) || !sameJson(evidence.cutoff, bundle.runtime.readyCutoff)
      || execution.executionRoot !== binding.executionRoot
      || execution.sourceEvidenceRoot !== binding.evidenceRoot
      || evidence.evidenceRoot !== binding.evidenceRoot
      || execution.resultPartitionRoot !== binding.resultPartitionRoot
      || !sameJson(execution.sourceEvidenceRefs, evidence.refs)
      || !sameJson(execution.rawLocatorHashes, evidence.rawLocatorHashes)) {
      report("predicate-observation-mismatch", `$.sourceCoverage.executions.${identity}`);
      continue;
    }
    const physicalHashes = binding.physicalObservations.map(observation => observation.rawLocatorHash);
    if (plan.completeness !== "nomination-only" && physicalHashes.length === 0) {
      report("predicate-observation-missing", `$.sourceCoverage.executions.${identity}.physicalObservations`);
      continue;
    }
    if (!sameJson(physicalHashes, evidence.rawLocatorHashes)) {
      report("predicate-observation-mismatch", `$.sourceCoverage.executions.${identity}.physicalObservations`);
      continue;
    }
    for (const observation of binding.physicalObservations) {
      const bytes = bytesByRef.get(observation.artifactRefId);
      if (bytes === undefined) continue;
      try {
        const physical = decodeFullFamilySourcePlanPhysicalObservation(decodeCanonicalJson(bytes));
        if (observation.contentSha256 !== observation.rawLocatorHash
          || !sameJson(physical.plan, plan)
          || !sameJson(physical.cutoff, bundle.runtime.readyCutoff)
          || physical.familyDefinitionHash !== plan.familyDefinitionHash) {
          report("predicate-observation-mismatch", `$.sourceCoverage.executions.${identity}.physicalObservations`);
        }
        const authority = {
          releaseBindingId: physical.releaseBindingId,
          releaseProvenanceHash: physical.releaseProvenanceHash,
          sourceAuthorityRoot: physical.sourceAuthorityRoot,
          sourceAnchorRoot: physical.sourceAnchorRoot,
        };
        if (readyReleaseProvenanceHash === null || authority.releaseProvenanceHash !== readyReleaseProvenanceHash) {
          report("predicate-observation-mismatch", `$.sourceCoverage.executions.${identity}.physicalObservations.releaseProvenanceHash`);
        }
        if (authority.releaseBindingId !== bundle.runtime.releaseBindingId) {
          report("predicate-observation-mismatch", `$.sourceCoverage.executions.${identity}.physicalObservations.releaseBindingId`);
        }
        if (physicalAuthority === null) physicalAuthority = authority;
        else if (!sameJson(physicalAuthority, authority)) {
          report("predicate-observation-mismatch", `$.sourceCoverage.executions.${identity}.physicalObservations.authority`);
        }
      } catch {
        report("schema-invalid", `$.sourceCoverage.executions.${identity}.physicalObservations`);
      }
    }
    executions.push(execution);
  }
  if (executions.length !== declaredPlans.length) return;
  try {
    const derived = sealFullFamilySourceCoverage(bundle.runtime.readyCutoff, declaredPlans, executions);
    if (!sameJson(derived, bundle.sourceCoverage.artifact.sourceCoverage)) {
      report("predicate-observation-mismatch", "$.sourceCoverage.sourceCoverage");
    }
  } catch {
    report("predicate-observation-mismatch", "$.sourceCoverage.sourceCoverage");
  }
}

function validateCandidateLineage(
  bundle: FullFamilyFactBundleV1,
  runtime: PredicateRuntimeFactsV1,
  bytesByRef: ReadonlyMap<Hash, Uint8Array>,
  report: ReportIssue,
  requireExternalAuthority: boolean,
): void {
  const trusted = runtime.trustedObserverInvocation ?? null;
  const verifierRefId = bundle.lineage.candidateProofVerifierBinding.artifactRefId;
  if (trusted === null
    || trusted.roleId !== FULL_FAMILY_INVOCATION_SEAL_ROLE_ID
    || !trusted.authenticatedArtifactRefIds.includes(verifierRefId)) {
    report("predicate-observation-missing", "$.lineage.candidateProofVerifierBinding.signedObserverClosure");
    return;
  }
  const verifierBytes = bytesByRef.get(verifierRefId);
  const proofBytes = bytesByRef.get(bundle.lineage.candidatePartitionProof.artifactRefId);
  if (verifierBytes === undefined || proofBytes === undefined) return;
  try {
    const verifier = decodeFullFamilyCandidateProofVerifierBinding(verifierBytes);
    const proof = decodeCandidatePartitionProofBytes(proofBytes);
    if (requireExternalAuthority) {
      const selectedAuthority = runtime.trustedPredicateAuthority;
      const authorityBinding = selectedAuthority?.artifactBindings.find(
        binding => binding.roleId === CANDIDATE_PROOF_VERIFIER_AUTHORITY_ROLE,
      );
      if (
        selectedAuthority === undefined
        || selectedAuthority.predicateId !== FULL_FAMILY_PREDICATE_SPEC.predicateId
        || selectedAuthority.artifactBindings.length !== 1
        || authorityBinding === undefined
        || authorityBinding.artifactRefId !== verifierRefId
        || authorityBinding.contentSha256 !== bundle.lineage.candidateProofVerifierBinding.contentSha256
        || !sameJson(authorityBinding.schema, artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidateProofVerifierBinding))
      ) {
        report("predicate-observation-mismatch", "$.lineage.candidateProofVerifierBinding.releaseAuthorityPin");
        return;
      }
    }
    if (verifier.candidateReleaseCommit !== trusted.candidateReleaseCommit) {
      report("predicate-observation-mismatch", "$.lineage.candidateProofVerifierBinding.candidateReleaseCommit");
    }
    const publicKeyBytes = Buffer.from(verifier.proofPublicKeyHex.slice(2), "hex");
    const spkiPrefix = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
    const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, publicKeyBytes]), format: "der", type: "spki" });
    const valid = verifySignature(
      null,
      Buffer.from(candidatePartitionProofSigningBytes(proof)),
      publicKey,
      Buffer.from(proof.signatureHex.slice(2), "hex"),
    );
    if (!valid) report("predicate-observation-mismatch", "$.lineage.candidatePartitionProof.signatureHex");
  } catch {
    report("schema-invalid", "$.lineage.candidatePartitionProof.signatureHex");
  }
}

/**
 * The qualified observer has already read these records through Checkpoint's
 * authority-bound Ready full-family reader. This verifier still recomputes
 * every wire/root join from the signed subject-ref closure. The neutral wire
 * validator proves exact structural/hash consistency; it deliberately does
 * not claim that a self-consistent issuer proof verifies its external Ed25519
 * signature. That authenticity fact belongs to the qualified Checkpoint
 * observer invocation authenticated by GateCore.
 */
function validateOutcomeLineageClosure(
  bundle: FullFamilyFactBundleV1,
  runtime: PredicateRuntimeFactsV1,
  bytesByRef: ReadonlyMap<Hash, Uint8Array>,
  report: ReportIssue,
): void {
  const trusted = runtime.trustedObserverInvocation ?? null;
  const proof = bundle.lineage.candidatePartitionProof.artifact;
  const verifier = bundle.lineage.candidateProofVerifierBinding.artifact;
  const readyBytes = bytesByRef.get(bundle.runtime.readyRecordArtifactRefId);
  let ready: ReturnType<typeof decodeFullFamilyReadyRecord> | null = null;
  if (readyBytes !== undefined) {
    try {
      ready = decodeFullFamilyReadyRecord(readyBytes);
    } catch {
      report("schema-invalid", "$.runtime.readyRecord.exactOutcomePartitionRoot");
    }
  }
  const artifacts: Array<Readonly<{
    item: FamilyOutcomeItemV1;
    familyDefinitionHash: Hash;
    artifact: ReturnType<typeof decodeFullFamilyOutcomeArtifact>;
    path: string;
  }>> = [];
  for (const [familyIndex, family] of bundle.families.entries()) {
    for (const [itemIndex, item] of family.outcomes.items.entries()) {
      const path = `$.families[${familyIndex}].outcomes.items[${itemIndex}]`;
      if (trusted === null
        || trusted.roleId !== FULL_FAMILY_INVOCATION_SEAL_ROLE_ID
        || !trusted.authenticatedArtifactRefIds.includes(item.evidenceArtifactRefId)) {
        report("predicate-observation-missing", `${path}.checkpointReadVerifiedObserverClosure`);
        continue;
      }
      const bytes = bytesByRef.get(item.evidenceArtifactRefId);
      if (bytes === undefined) continue;
      try {
        const artifact = decodeFullFamilyOutcomeArtifact(bytes);
        validateCandidateFinalOutcomeV1({
          runId: artifact.runId,
          cutoff: artifact.cutoff,
          candidatePartitionRoot: artifact.candidatePartitionRoot,
          candidate: artifact.candidate,
        }, artifact.rawOutcome);
        if (artifact.runId !== proof.runId
          || !sameJson(artifact.cutoff, bundle.runtime.readyCutoff)
          || artifact.candidatePartitionRoot !== bundle.runtime.candidatePartitionRoot
          || artifact.exactOutcomePartitionRoot !== ready?.exactOutcomePartitionRoot
          || artifact.candidate.familyId !== family.familyId
          || artifact.candidate.familyDefinitionHash !== family.familyDefinitionHash
          || artifact.candidate.familyCandidateKey !== item.candidateKey
          || artifact.rawOutcome.releaseProvenanceHash !== bundle.runtime.releaseProvenanceHash
          || artifact.rawOutcome.releaseAuthorityRoot !== verifier.releaseAuthorityRoot) {
          throw new TypeError("outcome lineage mismatch");
        }
        artifacts.push(Object.freeze({ item, familyDefinitionHash: family.familyDefinitionHash, artifact, path }));
      } catch {
        report("predicate-observation-mismatch", `${path}.rawOutcome`);
      }
    }
  }
  const expectedCount = bundle.families.reduce((sum, family) => sum + family.outcomes.items.length, 0);
  if (artifacts.length !== expectedCount || ready === null) return;
  const candidates = artifacts.map(entry => entry.artifact.candidate)
    .sort((left, right) => left.familyCandidateKey.localeCompare(right.familyCandidateKey));
  const outcomes = artifacts.map(entry => entry.artifact.rawOutcome as CandidateFinalOutcomeWireV1)
    .sort((left, right) => left.familyCandidateKey.localeCompare(right.familyCandidateKey));
  if (new Set(candidates.map(candidate => candidate.familyCandidateKey)).size !== candidates.length
    || hashCanonicalPartition("aloha/candidate-partition/v2", candidates) !== bundle.runtime.candidatePartitionRoot) {
    report("predicate-observation-mismatch", "$.runtime.candidatePartitionRoot.rawCandidates");
    return;
  }
  const first = outcomes[0];
  if (first === undefined) {
    // A zero-candidate release has no raw outcome authority coordinates from
    // which acceptance could independently reconstruct this root. The
    // qualified Checkpoint observer's Ready verification remains authoritative.
    return;
  }
  if (outcomes.some(outcome => (
    outcome.attestationAuthorityRoot !== first.attestationAuthorityRoot
    || outcome.releaseAuthorityRoot !== first.releaseAuthorityRoot
    || outcome.releaseProvenanceHash !== first.releaseProvenanceHash
    || outcome.executorAuthorityRoot !== first.executorAuthorityRoot
  ))) {
    report("predicate-observation-mismatch", "$.families.outcomes.authoritySet");
    return;
  }
  const root = exactOutcomePartitionRootV1({
    runId: proof.runId,
    cutoff: bundle.runtime.readyCutoff,
    candidatePartitionRoot: bundle.runtime.candidatePartitionRoot,
    attestationAuthorityRoot: first.attestationAuthorityRoot,
    releaseAuthorityRoot: first.releaseAuthorityRoot,
    releaseProvenanceHash: first.releaseProvenanceHash,
    executorAuthorityRoot: first.executorAuthorityRoot,
    outcomes,
  });
  if (root !== ready.exactOutcomePartitionRoot
    || artifacts.some(entry => entry.artifact.exactOutcomePartitionRoot !== root)) {
    report("predicate-observation-mismatch", "$.runtime.readyRecord.exactOutcomePartitionRoot");
  }
}

function validateProductionArtifactClosure(
  bundle: FullFamilyFactBundleV1,
  bytesByRef: ReadonlyMap<Hash, Uint8Array>,
  report: ReportIssue,
): void {
  let definitionCatalog: ProductionFamilyCatalogV1;
  try {
    const bytes = bytesByRef.get(bundle.definitionCatalog.sourceArtifactRefId);
    if (bytes === undefined) throw new TypeError("definition catalog missing");
    definitionCatalog = decodeProductionDefinitionCatalog(bytes);
  } catch {
    report("registry-mismatch", "$.definitionCatalog.sourceArtifact");
    return;
  }
  const publications: FullFamilyInstancePublicationV1[] = [];
  const observedEdges = new Map<Hash, FullFamilyPersistedGraphEdgeV1>();
  for (const [familyIndex, family] of bundle.families.entries()) {
    const catalogEntry = definitionCatalog.entries.find(entry => entry.familyId === family.familyId);
    if (catalogEntry === undefined || catalogEntry.familyDefinitionHash !== family.familyDefinitionHash) {
      report("registry-mismatch", `$.families[${familyIndex}].familyDefinitionHash`);
      continue;
    }
    for (const [index, item] of family.instancePublications.items.entries()) {
      const bytes = bytesByRef.get(item.evidenceArtifactRefId);
      if (bytes === undefined) continue;
      try {
        const publication = decodeFullFamilyInstancePublication(decodeCanonicalObject(bytes, "instancePublication"));
        publications.push(publication);
      } catch {
        report("predicate-observation-mismatch", `$.families[${familyIndex}].instancePublications.items[${index}]`);
      }
    }
    for (const [index, item] of family.projectedEdges.items.entries()) {
      const bytes = bytesByRef.get(item.evidenceArtifactRefId);
      if (bytes === undefined) continue;
      try {
        const edge = decodeFullFamilyPersistedGraphEdge(decodeCanonicalObject(bytes, "persistedGraphEdge"));
        observedEdges.set(edge.edgeId, edge);
      } catch {
        report("predicate-observation-mismatch", `$.families[${familyIndex}].projectedEdges.items[${index}]`);
      }
    }
    for (const [partition, expectedStatus] of [
      [family.coarseRankable, "rankable"],
      [family.coarseUnavailable, "unavailable"],
    ] as const) {
      for (const item of partition.items) {
        const bytes = bytesByRef.get(item.evidenceArtifactRefId);
        if (bytes === undefined) continue;
        try {
          const coarse = validateCoarseArtifact(bytes, item, expectedStatus);
          if (!observedEdges.has(item.subjectKey)) throw new TypeError("coarse edge missing");
          if (!sameJson(coarse.source, bundle.runtime.actualCurrentSource)) throw new TypeError("coarse current source mismatch");
        } catch {
          report("predicate-observation-mismatch", `$.families[${familyIndex}].coarse`);
        }
      }
    }
    for (const [index, item] of family.ownedActions.items.entries()) {
      const bytes = bytesByRef.get(item.evidenceArtifactRefId);
      if (bytes === undefined) continue;
      try {
        const owner = decodeFullFamilyActionOwnerArtifact(decodeCanonicalJson(bytes));
        if (owner.familyId !== family.familyId
          || owner.familyDefinitionHash !== family.familyDefinitionHash
          || owner.actionOwnerRef !== item.itemId
          || owner.actionOwnerRef !== item.subjectKey
          || !catalogEntry.actionOwnerRefs.includes(owner.actionOwnerRef)) {
          throw new TypeError("action owner/catalog lineage mismatch");
        }
      } catch {
        report("predicate-observation-mismatch", `$.families[${familyIndex}].ownedActions.items[${index}]`);
      }
    }
  }
  try {
    const catalog = sealFullFamilyInstanceCatalog(bundle.runtime.readyCutoff, publications);
    const graph = buildFullFamilyPersistedGraph(catalog);
    if (catalog.instanceCatalogRoot !== bundle.runtime.instanceCatalogRoot
      || catalog.instanceCount !== bundle.runtime.instanceCount) {
      report("predicate-observation-mismatch", "$.runtime.instanceCatalogRoot");
    }
    if (graph.graphRoot !== bundle.runtime.graphRoot || graph.edgeCount !== bundle.runtime.edgeCount
      || observedEdges.size !== graph.edges.length
      || graph.edges.some(edge => !sameJson(observedEdges.get(edge.edgeId), edge))) {
      report("predicate-observation-mismatch", "$.runtime.graphRoot");
    }
  } catch {
    report("predicate-observation-mismatch", "$.runtime.instanceCatalogRoot");
  }
}

function evaluateLiveWithGeneratedRuntime(
  suppliedRuntime: FullFamilyGeneratedRuntimeMetadataV1 | null,
  runtime: PredicateRuntimeFactsV1,
  issues: PredicateIssueSinkV1,
  requireProductionArtifacts: boolean,
): GateVerdict {
  let bindingInvalid = false;
  const report: ReportIssue = (code, path) => {
    bindingInvalid = true;
    issues.add(code, path);
  };
  if (runtime.facts.length !== 1) {
    report("predicate-observation-missing", "$.predicateFacts");
    return "invalid";
  }
  let locator: ReturnType<typeof decodeFullFamilyFactLocator>;
  try {
    locator = decodeFullFamilyFactLocator(runtime.facts[0] as object);
  } catch {
    report("schema-invalid", "$.predicateFacts[0]");
    return "invalid";
  }
  const index = indexRuntime(runtime, report);
  const bundleBytes = bindArtifact(locator.bundleArtifactRefId, locator.bundleContentSha256, runtime, index, report);
  const bundleRef = index.refsById.get(locator.bundleArtifactRefId);
  if (
    bundleRef === undefined
    || bundleRef.mediaType !== "application/json"
    || !sameJson(bundleRef.schema, BUNDLE_SCHEMA_REF)
  ) report("artifact-content-mismatch", "$.predicateFacts[0].bundleArtifactRefId");
  if (bundleBytes === null) return "invalid";
  const storage = decodeCanonicalArtifact(
    bundleBytes,
    value => decodeFullFamilyFactBundleStorageV1(value),
    "$.predicateFacts[0].bundleArtifactRefId",
    report,
  );
  if (storage === null) return "invalid";
  if (!sameBytes(bundleBytes, encodeFullFamilyFactBundleStorageV1(storage))) {
    report("canonical-bytes-mismatch", "$.predicateFacts[0].bundleArtifactRefId");
  }
  const traversed = new Map<Hash, Readonly<{ readonly contentSha256: Hash; readonly bytes: Uint8Array }>>();
  let bundle: FullFamilyFactBundleV1;
  try {
    const qualificationEvidenceRoles = Object.freeze({
      "source-plans": "source-plan",
      "universe-candidates": "universe-candidate",
      "instance-publications": "instance-publication",
      "projected-edges": "projected-edge",
      "declared-coarse-capabilities": "declared-coarse-capability",
      "coarse-rankable": "coarse-rankable",
      "coarse-unavailable": "coarse-unavailable",
      "unranked-admissions": "unranked-admission",
      "declared-exact-capabilities": "declared-exact-capability",
      "owned-actions": "owned-action",
    } as const);
    bundle = materializeFullFamilyFactBundleStorageV1(
      storage,
      (artifactRefId, contentSha256) => {
        const existing = traversed.get(artifactRefId);
        if (existing !== undefined) {
          if (existing.contentSha256 !== contentSha256) throw new TypeError("stored artifact ref digest splice");
          return existing.bytes;
        }
        const bytes = bindArtifact(artifactRefId, contentSha256, runtime, index, report);
        if (bytes === null) throw new TypeError("stored artifact unavailable");
        traversed.set(artifactRefId, Object.freeze({ contentSha256, bytes }));
        return bytes;
      },
      input => {
        if (requireProductionArtifacts || input.itemKind === "outcome") {
          return decodeFullFamilyStoredItemV1(input);
        }
        if (input.role === "outcomes") throw new TypeError("qualification evidence item kind mismatch");
        const artifact = decodeFullFamilyEvidenceArtifact(input.bytes);
        if (artifact.familyId !== input.familyId || artifact.role !== qualificationEvidenceRoles[input.role]) {
          throw new TypeError("qualification evidence artifact role splice");
        }
        return Object.freeze({
          familyId: artifact.familyId,
          itemId: artifact.itemId,
          subjectKey: artifact.subjectKey,
          evidenceArtifactRefId: input.artifactRefId,
          evidenceContentSha256: input.contentSha256,
        });
      },
    );
  } catch {
    report("schema-invalid", "$.predicateFacts[0].bundleArtifactRefId.storageClosure");
    return "invalid";
  }
  let expected: Map<Hash, Hash>;
  let nestedExpectations: ReadonlyMap<Hash, FullFamilyNestedExpectationV1>;
  try {
    expected = new Map(referencedFullFamilyArtifactDigests(bundle));
    nestedExpectations = expectedNestedArtifacts(bundle, requireProductionArtifacts);
    if (nestedExpectations.size !== expected.size
      || [...expected.keys()].some(artifactRefId => !nestedExpectations.has(artifactRefId))) {
      throw new TypeError("full-family nested semantic denominator mismatch");
    }
    for (const [artifactRefId, artifact] of traversed) {
      const existing = expected.get(artifactRefId);
      if (existing !== undefined && existing !== artifact.contentSha256) {
        throw new TypeError("stored artifact ref conflicts with semantic evidence ref");
      }
      expected.set(artifactRefId, artifact.contentSha256);
    }
    const existing = expected.get(locator.bundleArtifactRefId);
    if (existing !== undefined && existing !== locator.bundleContentSha256) throw new TypeError("bundle ref conflicts with evidence ref");
    expected.set(locator.bundleArtifactRefId, locator.bundleContentSha256);
  } catch {
    report("artifact-ref-mismatch", "$.predicateFacts[0]");
    return "invalid";
  }
  validateExactArtifactClosure(expected, runtime, index, report);
  const bytesByRef = new Map<Hash, Uint8Array>();
  for (const [artifactRefId, digest] of expected) {
    const bytes = artifactRefId === locator.bundleArtifactRefId
      ? bundleBytes
      : traversed.get(artifactRefId)?.bytes ?? bindArtifact(artifactRefId, digest, runtime, index, report);
    if (bytes !== null) bytesByRef.set(artifactRefId, bytes);
  }
  for (const [artifactRefId, artifact] of traversed) {
    if (nestedExpectations.has(artifactRefId)) continue;
    const ref = index.refsById.get(artifactRefId);
    const path = `$.artifactRefs.${artifactRefId}`;
    let expectedSchema: ReturnType<typeof artifactSchemaRef> | null = null;
    let canonical = false;
    try {
      const value = decodeCanonicalObject(artifact.bytes, "storedArtifact");
      if (value.kind === "aloha.full-family-artifact-ref-index-v1") {
        const decoded = decodeFullFamilyArtifactRefIndexV1(artifact.bytes);
        canonical = sameBytes(artifact.bytes, encodeFullFamilyArtifactRefIndexV1(decoded));
        expectedSchema = artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.artifactRefIndex);
      } else if (value.kind === "aloha.full-family-artifact-ref-page-v1") {
        const decoded = decodeFullFamilyArtifactRefPageV1(artifact.bytes);
        canonical = sameBytes(artifact.bytes, encodeFullFamilyArtifactRefPageV1(decoded));
        expectedSchema = artifactSchemaRef(FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.artifactRefPage);
      }
    } catch {
      canonical = false;
    }
    if (expectedSchema === null) report("schema-invalid", path);
    else if (ref === undefined || ref.mediaType !== "application/json" || !sameJson(ref.schema, expectedSchema)) {
      report("artifact-content-mismatch", `${path}.schema`);
    }
    if (!canonical) report("canonical-bytes-mismatch", path);
  }
  for (const [artifactRefId, expectation] of nestedExpectations) {
    const ref = index.refsById.get(artifactRefId);
    if (ref === undefined) continue;
    if (ref.mediaType !== "application/json" || !sameJson(ref.schema, expectation.schema)) {
      report("artifact-content-mismatch", `$.artifactRefs.${artifactRefId}.schema`);
      continue;
    }
    const bytes = bytesByRef.get(artifactRefId);
    if (bytes !== undefined) expectation.validate(bytes, report);
  }
  const generatedRuntime = requireProductionArtifacts
    ? deriveProductionRuntimeMetadata(bundle, bytesByRef, report)
    : suppliedRuntime;
  if (generatedRuntime === null) return "invalid";
  validateSourceExecutionClosure(bundle, generatedRuntime, bytesByRef, report);
  validateCandidateLineage(bundle, runtime, bytesByRef, report, requireProductionArtifacts);
  validateOutcomeLineageClosure(bundle, runtime, bytesByRef, report);
  if (requireProductionArtifacts) validateProductionArtifactClosure(bundle, bytesByRef, report);
  const result = evaluateFullFamilyPredicate(bundle, generatedRuntime);
  for (const reason of result.reasons) issues.add(mapReasonCode(reason.code), reason.path);
  return bindingInvalid ? "invalid" : result.verdict;
}

export const FULL_FAMILY_PREDICATE_ADAPTER_VERSION = FULL_FAMILY_ADAPTER_VERSION;

/** Qualification-only seam. The release export below remains fixed to branded generated metadata. */
export function createFullFamilyPredicateEvaluatorForQualification(
  generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1,
): PredicateEvaluatorV1 {
  return Object.freeze({
    predicateId: FULL_FAMILY_PREDICATE_SPEC.predicateId,
    commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
    adapterVersion: FULL_FAMILY_ADAPTER_VERSION,
    predicateSpec: FULL_FAMILY_PREDICATE_SPEC,
    predicateProgramDescriptorDigest: FULL_FAMILY_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: FULL_FAMILY_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    evaluateLive: (runtime: PredicateRuntimeFactsV1, issues: PredicateIssueSinkV1) => evaluateLiveWithGeneratedRuntime(generatedRuntime, runtime, issues, false),
  });
}

export const FULL_FAMILY_PREDICATE_EVALUATOR: PredicateEvaluatorV1 = Object.freeze({
  predicateId: FULL_FAMILY_PREDICATE_SPEC.predicateId,
  commonEnvelopeRoleContractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
  adapterVersion: FULL_FAMILY_ADAPTER_VERSION,
  predicateSpec: FULL_FAMILY_PREDICATE_SPEC,
  predicateProgramDescriptorDigest: FULL_FAMILY_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  oracleProgramDescriptorDigest: FULL_FAMILY_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
  evaluateLive: (runtime: PredicateRuntimeFactsV1, issues: PredicateIssueSinkV1) => evaluateLiveWithGeneratedRuntime(null, runtime, issues, true),
});
