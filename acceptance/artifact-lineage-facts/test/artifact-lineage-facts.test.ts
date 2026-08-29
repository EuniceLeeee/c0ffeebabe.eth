import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as ts from "typescript";
import { hashDomain, sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import {
  ARTIFACT_LINEAGE_CASE_MATERIAL,
  ARTIFACT_LINEAGE_CASE_RESULTS,
  ARTIFACT_LINEAGE_CASE_ROOTS,
  ARTIFACT_LINEAGE_QUALIFICATION,
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION,
  ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION,
  ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION,
  ARTIFACT_LINEAGE_ROLE_QUALIFICATION_MATERIALS,
  ARTIFACT_LINEAGE_ACTUALLY_EXECUTED_REJECTED_OR_INVALID_MUTATION_IDS,
  ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS,
  ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL,
  ARTIFACT_LINEAGE_SCHEMA_MANIFESTS,
  computeArtifactLineageCaseRoots,
  createArtifactLineageClaim,
  decodeArtifactLineageClaim,
  evaluateArtifactLineageCase,
  evaluateArtifactLineageOracle,
  encodeArtifactLineageFactBundle,
  encodeArtifactLineageObservation,
  decodeArtifactLineageObservation,
  type ArtifactLineageIndependentOracleCaseV1,
} from "../src/qualification.ts";
import {
  ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_MUTATION_IDS,
  ARTIFACT_LINEAGE_SIDECAR_MUTATION_IDS,
  ARTIFACT_LINEAGE_PREDICATE_SPEC,
  decodeArtifactLineageFactBundle,
  evaluateArtifactLineagePredicate,
} from "../src/runtime.ts";
import {
  ARTIFACT_BYTES_CHUNK_BYTE_LENGTH,
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import { createReadOnlyArtifactRef } from "../../../specs/core-envelope/src/index.ts";
import { QUALIFIED_FACT_SCHEMA_MANIFESTS } from "../../../specs/qualified-facts/src/index.ts";

const zeroHash = `0x${"0".repeat(64)}`;

test("package exposes only explicit runtime, qualification and oracle entrypoints", async () => {
  const unexportedRoot: string = "@aloha/artifact-lineage-facts";
  await assert.rejects(
    import(unexportedRoot),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});

function compilerClosure(entry: string): readonly string[] {
  const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const loadedConfig = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(loadedConfig.error, undefined);
  const parsedConfig = ts.parseJsonConfigFileContent(loadedConfig.config, ts.sys, fileURLToPath(new URL("..", import.meta.url)));
  const program = ts.createProgram({ rootNames: [fileURLToPath(new URL(entry, import.meta.url))], options: parsedConfig.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")), []);
  return program.getSourceFiles().map((source) => source.fileName.replaceAll("\\", "/"));
}

test("live runtime compiler closure excludes qualification oracle and case material", () => {
  const sourceNames = compilerClosure("../src/runtime.ts");
  assert.ok(sourceNames.some((path) => path.endsWith("/artifact-lineage-facts/src/runtime.ts")));
  assert.ok(sourceNames.some((path) => path.endsWith("/artifact-lineage-facts/src/predicate.ts")));
  assert.ok(sourceNames.some((path) => path.endsWith("/artifact-lineage-facts/src/spec.ts")));
  assert.equal(sourceNames.some((path) => path.endsWith("/artifact-lineage-facts/src/reference-model.ts")), false);
  assert.equal(sourceNames.some((path) => path.endsWith("/artifact-lineage-facts/src/qualification.ts")), false);
});

test("offline qualification and oracle entrypoints own their separate compiler closures", () => {
  const qualificationSources = compilerClosure("../src/qualification.ts");
  assert.ok(qualificationSources.some((path) => path.endsWith("/artifact-lineage-facts/src/qualification.ts")));
  assert.ok(qualificationSources.some((path) => path.endsWith("/artifact-lineage-facts/src/reference-model.ts")));

  const oracleSources = compilerClosure("../src/reference-model.ts");
  assert.ok(oracleSources.some((path) => path.endsWith("/artifact-lineage-facts/src/reference-model.ts")));
  assert.equal(oracleSources.some((path) => path.endsWith("/artifact-lineage-facts/src/qualification.ts")), false);
  assert.equal(oracleSources.some((path) => path.endsWith("/artifact-lineage-facts/src/predicate.ts")), false);
  assert.equal(oracleSources.some((path) => path.endsWith("/artifact-lineage-facts/src/schema.ts")), false);
});

test("oracle source has no production artifact-lineage decoder dependency", () => {
  const sourcePath = fileURLToPath(new URL("../src/reference-model.ts", import.meta.url));
  const source = ts.sys.readFile(sourcePath);
  assert.equal(typeof source, "string");
  assert.doesNotMatch(source!, /decodeArtifactLineage(?:Claim|Observation|RawFacts)/);
  assert.doesNotMatch(source!, /\bdecodeArtifactBytes\b/);
});

test("slice exposes frozen executable schemas and refinement-bound predicate spec", () => {
  assert.match(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.claim.schemaHash, /^0x[0-9a-f]{64}$/);
  assert.match(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.observation.schemaHash, /^0x[0-9a-f]{64}$/);
  assert.match(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.factBundle.schemaHash, /^0x[0-9a-f]{64}$/);
  assert.equal(ARTIFACT_LINEAGE_PREDICATE_SPEC.claimSchemaRefs.length, 1);
  assert.equal(ARTIFACT_LINEAGE_PREDICATE_SPEC.observationSchemaRefs.some((schema) =>
    schema.id === QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.id &&
    schema.version === QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.version &&
    schema.schemaHash === QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.schemaHash,
  ), true);
  assert.deepEqual(ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.observationSchema, {
    id: QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.id,
    version: QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.version,
    schemaHash: QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.schemaHash,
  });
  assert.deepEqual(
    ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.requiredCriticalMutationIds,
    ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS,
  );
  assert.match(ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH, /^0x[0-9a-f]{64}$/);
  assert.equal(
    ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH,
    hashDomain("aloha/gate-core/invocation-audience/v1", {
      predicateSpecDigest: ARTIFACT_LINEAGE_PREDICATE_SPEC.specDigest,
      roleId: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.roleId,
      observationSchema: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.observationSchema,
      contractMajor: 1,
    }),
  );
  assert.deepEqual(
    [...ARTIFACT_LINEAGE_PREDICATE_SPEC.criticalMutationIds].sort(),
    [...new Set([
      ...ARTIFACT_LINEAGE_MUTATION_IDS,
      ...ARTIFACT_LINEAGE_SIDECAR_MUTATION_IDS,
      ...ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS,
    ])].sort(),
  );
  assert.ok(ARTIFACT_LINEAGE_PREDICATE_SPEC.independentOracleKinds.length > 0);
  assert.notEqual(ARTIFACT_LINEAGE_PREDICATE_SPEC.specDigest, zeroHash);
  assert.ok(JSON.stringify(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.claim.schema.descriptor).includes("refinementSpecDigest"));
});

test("canonical fact bundle bytes round-trip exactly", () => {
  const positive = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-positive")!;
  const bundle = { claim: positive.claim, observation: positive.observation, rawFacts: positive.rawFacts };
  const encoded = encodeArtifactLineageFactBundle(bundle);
  assert.deepEqual(decodeArtifactLineageFactBundle(encoded), bundle);
  assert.deepEqual(encodeArtifactLineageFactBundle(decodeArtifactLineageFactBundle(encoded)), encoded);
  assert.deepEqual(decodeArtifactLineageObservation(encodeArtifactLineageObservation(positive.observation)), positive.observation);
  assert.equal(typeof positive.rawFacts.rawBytes, "string");
  assert.equal("producerProcessAnchor" in positive.claim, false);
});

test("mirror byte budget is enforced before mirror decode and fact-bundle refinement", () => {
  const positive = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-positive")!;
  const { policyHash: _policyHash, ...policyDraft } = positive.claim.resolverPolicy;
  const tinyPolicy = createResolverPolicy({ ...policyDraft, maxByteLength: "1" });
  const overBudgetClaim = { ...positive.claim, resolverPolicy: tinyPolicy };
  assert.throws(
    () => decodeArtifactLineageClaim(overBudgetClaim),
    /exceed resolver policy before decode/,
  );
  assert.throws(
    () => decodeArtifactLineageFactBundle({
      claim: overBudgetClaim,
      observation: positive.observation,
      rawFacts: positive.rawFacts,
    }),
    /exceed resolver policy before decode/,
  );
  assert.throws(
    () => ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.claim.schema.decode(overBudgetClaim),
    /exceed resolver policy before decode/,
  );
  assert.throws(
    () => ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.factBundle.schema.decode({
      claim: overBudgetClaim,
      observation: positive.observation,
      rawFacts: positive.rawFacts,
    }),
    /exceed resolver policy before decode/,
  );
  const { claimId: _claimId, ...claimDraft } = positive.claim;
  assert.throws(
    () => createArtifactLineageClaim({ ...claimDraft, resolverPolicy: tinyPolicy }),
    /exceed resolver policy before decode/,
  );
});

test("claim qualification accepts the first mandatory multi-chunk mirror", () => {
  const positive = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-positive")!;
  const bytes = new Uint8Array(ARTIFACT_BYTES_CHUNK_BYTE_LENGTH + 1);
  bytes[bytes.length - 1] = 1;
  const contentSha256 = sha256Hex(bytes);
  const policy = createResolverPolicy({
    schemaVersion: 1,
    kind: "aloha.artifact-resolver-policy",
    allowedLocatorKind: "content-object",
    digestAlgorithm: "sha256",
    maxByteLength: String(bytes.byteLength),
    requireExactLengthMediaAndSchema: true,
    minimumRemainingStoreEpochs: positive.claim.resolverPolicy.minimumRemainingStoreEpochs,
    failureOutcome: "invalid",
  });
  const storeIdentityHash = positive.claim.artifactRef.immutableMirrorLocator.storeIdentityHash;
  const lease = createRetentionLeaseReceipt({
    storeIdentityHash,
    objectKey: contentSha256,
    contentSha256,
    validFromStoreEpoch: positive.claim.retentionLease.validFromStoreEpoch,
    validThroughStoreEpoch: positive.claim.retentionLease.validThroughStoreEpoch,
    issuerId: positive.claim.retentionLease.issuerId,
    issuerQualificationId: positive.claim.retentionLease.issuerQualificationId,
    qualificationRegistryRoot: positive.claim.retentionLease.qualificationRegistryRoot,
  });
  const locator = { kind: "content-object" as const, storeIdentityHash, objectKey: contentSha256 };
  const ref = createReadOnlyArtifactRef({
    locator,
    immutableMirrorLocator: locator,
    contentSha256,
    byteLength: String(bytes.byteLength),
    mediaType: positive.claim.artifactRef.mediaType,
    schema: positive.claim.artifactRef.schema,
    resolverPolicyHash: policy.policyHash,
    retentionLeaseReceiptId: lease.receiptId,
  });
  const mirror = createObservedImmutableMirror({
    storeIdentityHash,
    objectKey: contentSha256,
    bytes: encodeArtifactBytes(bytes),
    mediaType: ref.mediaType,
    schema: ref.schema,
  });
  const resolutionClaim = createArtifactResolutionClaim({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: policy.policyHash,
    observedMirror: mirror,
    outcome: "content-observed",
  });
  const claim = createArtifactLineageClaim({
    schemaVersion: 1,
    kind: "aloha.artifact-lineage-claim",
    artifactRef: ref,
    resolverPolicy: policy,
    resolutionClaim,
    retentionLease: lease,
    observedStoreEpoch: positive.claim.observedStoreEpoch,
  });
  assert.equal(claim.resolutionClaim.observedMirror?.bytes.chunks.length, 2);
  assert.deepEqual(decodeArtifactLineageClaim(claim), claim);
});

test("independent oracle rejects hostile and non-canonical mirror chunk envelopes without production decode", () => {
  const positive = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-positive")!;
  const mirror = positive.claim.resolutionClaim.observedMirror!;
  let trapHits = 0;
  const proxyChunks = new Proxy([...mirror.bytes.chunks], {
    get() { trapHits += 1; throw new Error("oracle proxy get must not run"); },
    ownKeys() { trapHits += 1; throw new Error("oracle proxy keys must not run"); },
    getOwnPropertyDescriptor() { trapHits += 1; throw new Error("oracle proxy descriptor must not run"); },
  });
  const hostileClaim = {
    ...positive.claim,
    resolutionClaim: {
      ...positive.claim.resolutionClaim,
      observedMirror: { ...mirror, bytes: { ...mirror.bytes, chunks: proxyChunks } },
    },
  };
  assert.equal(evaluateArtifactLineageOracle(hostileClaim, positive.observation, positive.rawFacts).verdict, "invalid");
  assert.equal(trapHits, 0);
  const legacyClaim = {
    ...positive.claim,
    resolutionClaim: {
      ...positive.claim.resolutionClaim,
      observedMirror: { ...mirror, bytes: positive.observation.rawBytes },
    },
  };
  assert.equal(evaluateArtifactLineageOracle(legacyClaim, positive.observation, positive.rawFacts).verdict, "invalid");
});

test("oracle corpus has exact positive, negative and invalid material", () => {
  assert.equal(ARTIFACT_LINEAGE_CASE_RESULTS.length, ARTIFACT_LINEAGE_CASE_MATERIAL.length);
  assert.equal(ARTIFACT_LINEAGE_QUALIFICATION.factsConsistent, true);
  assert.equal(ARTIFACT_LINEAGE_QUALIFICATION.authority, false);
  assert.equal(ARTIFACT_LINEAGE_QUALIFICATION.material.implWitnessCaseCount, "0");
  assert.match(ARTIFACT_LINEAGE_QUALIFICATION.material.oracleProgramDescriptorDigest, /^0x[0-9a-f]{64}$/);
  assert.match(ARTIFACT_LINEAGE_QUALIFICATION.material.predicateProgramDescriptorDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(ARTIFACT_LINEAGE_CASE_ROOTS.independentOracleCaseCount, String(ARTIFACT_LINEAGE_CASE_MATERIAL.length));
  assert.notEqual(ARTIFACT_LINEAGE_CASE_ROOTS.caseSetRoot, zeroHash);
  assert.ok(ARTIFACT_LINEAGE_CASE_RESULTS.some((entry) => entry.oracle.verdict === "pass"));
  assert.ok(ARTIFACT_LINEAGE_CASE_RESULTS.some((entry) => entry.oracle.verdict === "fail"));
  assert.ok(ARTIFACT_LINEAGE_CASE_RESULTS.some((entry) => entry.oracle.verdict === "invalid"));
  for (const mutationId of ARTIFACT_LINEAGE_MUTATION_IDS) {
    const covered = ARTIFACT_LINEAGE_CASE_RESULTS.find((entry) => entry.mutationId === mutationId);
    assert.ok(covered, `missing ${mutationId}`);
    assert.notEqual(covered.oracle.verdict, "pass", mutationId);
  }
  assert.ok(ARTIFACT_LINEAGE_CASE_RESULTS.every((entry) => /^0x[0-9a-f]{64}$/.test(entry.oracleProgramDescriptorDigest)));
  assert.ok(ARTIFACT_LINEAGE_CASE_RESULTS.every((entry) => entry.classificationMatchesOracle));
  assert.ok(ARTIFACT_LINEAGE_CASE_RESULTS.every((entry) => entry.predicateMatchesOracle));
});

test("every sidecar and invocation role has its own independent corpus and roots", () => {
  const materials = [
    ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION,
    ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION,
    ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION,
    ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION,
  ];
  const roots = new Set<string>();
  for (const material of materials) {
    assert.equal(material.authority, false);
    assert.ok(material.cases.some((entry) => entry.classification === "positive"));
    assert.ok(material.cases.some((entry) => entry.classification === "negative"));
    assert.ok(material.cases.some((entry) => entry.classification === "invalid"));
    assert.equal(material.cases.length, Number(material.roots.independentOracleCaseCount));
    assert.equal(material.caseResults.length, material.cases.length);
    assert.equal(material.caseResults.every((entry) => entry.classificationMatchesOracle), true, material.roleId);
    assert.equal(material.caseResults.every((entry) => entry.mutationId === null || entry.oracle.verdict !== "pass"), true, material.roleId);
    assert.deepEqual(
      material.actuallyExecutedRejectedOrInvalidMutationIds,
      material.cases.filter((entry) => entry.mutationId !== null).map((entry) => entry.mutationId).sort(),
    );
    assert.notEqual(material.roots.caseSetRoot, zeroHash);
    assert.notEqual(material.roots.independentOracleCaseRoot, zeroHash);
    assert.notEqual(material.oracleProgramDescriptorDigest, zeroHash);
    roots.add(material.roots.caseSetRoot);
  }
  assert.equal(roots.size, materials.length);
  assert.notEqual(ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION.roots.caseSetRoot, ARTIFACT_LINEAGE_CASE_ROOTS.caseSetRoot);
  assert.notEqual(ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION.roots.caseSetRoot, ARTIFACT_LINEAGE_CASE_ROOTS.caseSetRoot);
  assert.notEqual(ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION.roots.caseSetRoot, ARTIFACT_LINEAGE_CASE_ROOTS.caseSetRoot);
  assert.notEqual(ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION.roots.caseSetRoot, ARTIFACT_LINEAGE_CASE_ROOTS.caseSetRoot);
});

test("verifier aggregate executes the exact predicate mutation set", () => {
  assert.deepEqual(
    ARTIFACT_LINEAGE_ACTUALLY_EXECUTED_REJECTED_OR_INVALID_MUTATION_IDS,
    ARTIFACT_LINEAGE_PREDICATE_SPEC.criticalMutationIds,
  );
  const roleMaterials = ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL.roleMaterials;
  assert.equal(new Set(roleMaterials.map((material) => material.roleId)).size, roleMaterials.length);
  const invocationRoleMaterial = roleMaterials.find((material) => material.roleId === ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION.roleId);
  assert.deepEqual(
    invocationRoleMaterial?.actuallyExecutedRejectedOrInvalidMutationIds,
    ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION.actuallyExecutedRejectedOrInvalidMutationIds,
  );
  assert.deepEqual(
    [...new Set(roleMaterials.flatMap((material) => material.actuallyExecutedRejectedOrInvalidMutationIds))].sort(),
    ARTIFACT_LINEAGE_ACTUALLY_EXECUTED_REJECTED_OR_INVALID_MUTATION_IDS,
  );
  assert.equal(ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL.authority, false);
  assert.equal(ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL.independentOracleCaseCount, String(ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL.caseResults.length));
  assert.notEqual(ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.caseSetRoot, zeroHash);
  assert.notEqual(ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.independentOracleCaseRoot, zeroHash);
});

test("producer witness changes cannot change either verdict", () => {
  const positive = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-positive")!;
  const alteredWitness: ArtifactLineageIndependentOracleCaseV1 = { ...positive, producerVerdict: "invalid" };
  assert.deepEqual(evaluateArtifactLineageCase(alteredWitness), evaluateArtifactLineageCase(positive));
  assert.equal(evaluateArtifactLineageCase(alteredWitness).verdict, "pass");
});

test("oracle and predicate are separately executed and exactly agree", () => {
  const positive = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-positive")!;
  const oracle = evaluateArtifactLineageOracle(positive.claim, positive.observation, positive.rawFacts);
  const result = ARTIFACT_LINEAGE_CASE_RESULTS.find((entry) => entry.caseId === positive.caseId)!;
  assert.deepEqual(result.oracle, oracle);
  assert.deepEqual(result.predicate, result.oracle);
  assert.equal(result.classificationMatchesOracle, true);
  assert.equal(result.predicateMatchesOracle, true);
});

test("lease lower boundary passes while expiry policy is invalid", () => {
  const lower = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-positive-lease-lower-boundary")!;
  const upper = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-lease-boundary")!;
  assert.equal(evaluateArtifactLineageCase(lower).verdict, "pass");
  assert.deepEqual(evaluateArtifactLineageCase(upper).reasons, ["lease-remaining-too-short"]);
  assert.equal(evaluateArtifactLineageCase(upper).verdict, "invalid");
});

test("hostile and derived binaries are rejected before traps or conversion", () => {
  const positive = ARTIFACT_LINEAGE_CASE_MATERIAL.find((entry) => entry.caseId === "artifact-lineage-positive")!;
  const sourceBytes = new Uint8Array([0, 1, 2]);
  let trapHits = 0;
  const hostile = new Proxy(sourceBytes, {
    get() { trapHits += 1; throw new Error("hostile get"); },
    getOwnPropertyDescriptor() { trapHits += 1; throw new Error("hostile descriptor"); },
    getPrototypeOf() { trapHits += 1; throw new Error("hostile prototype"); },
    ownKeys() { trapHits += 1; throw new Error("hostile keys"); },
  });
  const result = evaluateArtifactLineagePredicate(positive.claim, positive.observation, { ...positive.rawFacts, rawBytes: hostile });
  assert.equal(result.verdict, "invalid");
  assert.deepEqual(result.reasons, ["raw-shape-invalid"]);
  assert.equal(trapHits, 0);
  const derived = new (class extends Uint8Array {})(sourceBytes);
  assert.equal(evaluateArtifactLineagePredicate(positive.claim, positive.observation, { ...positive.rawFacts, rawBytes: derived }).verdict, "invalid");
  const hostileFacts = new Proxy({ ...positive.rawFacts }, {
    get() { trapHits += 1; throw new Error("hostile facts get"); },
    getOwnPropertyDescriptor() { trapHits += 1; throw new Error("hostile facts descriptor"); },
    getPrototypeOf() { trapHits += 1; throw new Error("hostile facts prototype"); },
    ownKeys() { trapHits += 1; throw new Error("hostile facts keys"); },
  });
  assert.equal(evaluateArtifactLineagePredicate(positive.claim, positive.observation, hostileFacts).verdict, "invalid");
  assert.equal(trapHits, 0);
});

test("content mutation fails while exact bindings and outcome are invalid", () => {
  const content = ARTIFACT_LINEAGE_CASE_RESULTS.find((entry) => entry.mutationId === "content-mutation")!;
  assert.equal(content.oracle.verdict, "fail");
  assert.deepEqual(content.oracle.reasons, ["subject-content-mismatch"]);
  for (const mutationId of ["artifact-ref-length", "length-mismatch", "media-mismatch", "schema-mismatch", "locator-splice", "object-key-splice", "resolution-outcome-mismatch"] as const) {
    const mutation = ARTIFACT_LINEAGE_CASE_RESULTS.find((entry) => entry.mutationId === mutationId)!;
    assert.equal(mutation.oracle.verdict, "invalid", mutationId);
  }
});

test("case roots reject duplicate, extra and missing mutation material", () => {
  const duplicate = [...ARTIFACT_LINEAGE_CASE_MATERIAL, ARTIFACT_LINEAGE_CASE_MATERIAL[0]!];
  assert.throws(() => computeArtifactLineageCaseRoots(duplicate), /duplicate|empty/);
  const missing = ARTIFACT_LINEAGE_CASE_MATERIAL.filter((entry) => entry.mutationId !== "artifact-ref-length");
  assert.throws(() => computeArtifactLineageCaseRoots(missing), /missing/);
  const extra = ARTIFACT_LINEAGE_CASE_MATERIAL.map((entry) => entry.mutationId === "artifact-ref-length" ? { ...entry, mutationId: "unexpected" } : entry);
  assert.throws(() => computeArtifactLineageCaseRoots(extra), /extra|duplicate/);
});
