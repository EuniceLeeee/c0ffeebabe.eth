import assert from "node:assert/strict";
import test from "node:test";
import {
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { createReadOnlyArtifactRef } from "../../../specs/core-envelope/src/index.ts";
import {
  createRuntimeAcceptanceFactLocator,
  deriveLegacyAuthorityClosureReceipt,
  encodeLegacyAuthorityClosureFacts,
  encodeRuntimeRestartFacts,
  hashRuntimeCandidateDeltaPartition,
  hashRuntimeCandidateOutcomePartition,
  hashRuntimeFactRefRoot,
  hashRuntimeGraphViewLeaseObservations,
  LEGACY_CLOSURE_ROOT_ROLES,
  RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS,
  sealLegacyAuthorityClosureFacts,
  sealLegacyClosureFact,
  sealLegacyClosureRawArtifact,
  sealLegacyClosureRawDenominator,
  sealLegacyClosureRawEdge,
  sealLegacyClosureRawEntrypoint,
  sealRuntimeFactRef,
  type LegacyAuthorityClosureFactsV1,
  type LegacyClosureRootRoleV1,
  type RuntimeCandidateDeltaPartitionV1,
  type RuntimeCandidateOutcomeV1,
  type RuntimeRestartFactsV1,
} from "../../../specs/runtime-acceptance-facts/src/index.ts";
import {
  LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR,
  RUNTIME_RESTART_PREDICATE_EVALUATOR,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR,
} from "../src/predicates/runtime-acceptance.ts";
import type { PredicateRuntimeFactsV1 } from "../src/predicate-composition.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const sha = (digit: string): string => digit.repeat(40);
const STORE_IDENTITY_HASH = h("1");
const CLOSURE_SPEC_DIGESTS = Object.freeze([
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR.predicateSpec.specDigest,
  LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR.predicateSpec.specDigest,
] as const);
const CLOSURE_CERTIFICATE_IDS = Object.freeze([h("5"), h("6")] as const);

interface BuiltRuntimeV1 {
  readonly runtime: PredicateRuntimeFactsV1;
  readonly bundle: LegacyAuthorityClosureFactsV1;
}

function buildRuntime(
  rootValue?: object,
  nestedOverride?: {
    readonly role: LegacyClosureRootRoleV1;
    readonly value: object;
    readonly mediaType?: string;
  },
  qualificationOverride?: {
    readonly predicateSpecDigests?: readonly [Hash, Hash];
    readonly qualificationCertificateIds?: readonly [Hash, Hash];
    readonly trustedBindings?: PredicateRuntimeFactsV1["trustedReleaseQualificationBindings"];
  },
): BuiltRuntimeV1 {
  const policy = createResolverPolicy({
    schemaVersion: 1,
    kind: "aloha.artifact-resolver-policy",
    allowedLocatorKind: "content-object",
    digestAlgorithm: "sha256",
    maxByteLength: "1048576",
    requireExactLengthMediaAndSchema: true,
    minimumRemainingStoreEpochs: "0",
    failureOutcome: "invalid",
  });
  const nestedSchema = {
    id: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureRootFactPayload.id,
    version: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureRootFactPayload.version,
    schemaHash: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureRootFactPayload.schemaHash,
  } as const;
  const rawSchema = { id: "aloha.test.raw-typescript", version: "1.0.0", schemaHash: h("2") } as const;
  function issueNested(bytes: Uint8Array, schema: typeof nestedSchema | typeof rawSchema, mediaType: string) {
    const contentSha256 = sha256Hex(bytes);
    const lease = createRetentionLeaseReceipt({
      storeIdentityHash: STORE_IDENTITY_HASH,
      objectKey: contentSha256,
      contentSha256,
      validFromStoreEpoch: "1",
      validThroughStoreEpoch: "10",
      issuerId: "gate-core-test",
      issuerQualificationId: h("8"),
      qualificationRegistryRoot: h("9"),
    });
    const locator = { kind: "content-object" as const, storeIdentityHash: STORE_IDENTITY_HASH, objectKey: contentSha256 };
    const ref = createReadOnlyArtifactRef({
      locator,
      immutableMirrorLocator: locator,
      contentSha256,
      byteLength: String(bytes.byteLength),
      mediaType,
      schema,
      resolverPolicyHash: policy.policyHash,
      retentionLeaseReceiptId: lease.receiptId,
    });
    const factRef = sealRuntimeFactRef({
      artifactRefId: ref.artifactRefId,
      contentSha256,
      byteLength: String(bytes.byteLength),
      schema,
      locator,
    });
    return { bytes, lease, ref, factRef, mediaType, schema };
  }
  const rawNesteds: ReturnType<typeof issueNested>[] = [];
  const artifact = (name: string, logicalKey: string) => {
    const issued = issueNested(new TextEncoder().encode(`observed:${name}\n`), rawSchema, "text/plain");
    rawNesteds.push(issued);
    return sealLegacyClosureRawArtifact({
      logicalKey,
      contentSha256: issued.factRef.contentSha256,
      byteLength: issued.factRef.byteLength,
      factRefId: issued.factRef.factId,
      locatorId: issued.factRef.locatorId,
      locator: issued.factRef.locator,
    });
  };
  const boundary = artifact("boundary", "candidate/neutral/boundary/commit");
  const binding = artifact("binding", "external/strict-authority/runtime-release-binding/binding.json");
  const approval = artifact("approval", "external/strict-authority/release-authority-approval/approval.json");
  const manifest = artifact("manifest", "external/neutral/deployment-manifest/manifest.json");
  const bundleArtifact = artifact("bundle", "external/neutral/runtime-bundle/bundle.mjs");
  const composition = artifact("composition", "external/neutral/deployment-composition/composition.mjs");
  const sourceConfig = artifact("source-config", "external/neutral/deployment-source/source.json");
  const runtimePolicy = artifact("runtime-policy", "external/neutral/runtime-policy/policy.json");
  const executorState = artifact("executor-state", "external/neutral/executor-state/executor.json");
  const releaseIntent = artifact("release-intent", "external/neutral/release-intent/release.json");
  const candidateProof = artifact("candidate-proof", "external/neutral/candidate-proof-verifier/proof.json");
  const releaseEnvironment = artifact("release-environment", "external/neutral/release-environment/release.env");
  const unit = artifact("unit", "external/neutral/systemd-unit/aloha.service");
  const database = artifact("database", "external/neutral/runtime-sqlite/runtime.sqlite");
  const ready = artifact("ready", "external/neutral/runtime-event/aloha.runtime-process-ready-event");
  const main = artifact("main", "external/neutral/main-executable/node");
  const child = artifact("child", "external/neutral/child-executable/revm-worker");
  const loaded = artifact("loaded", "external/neutral/loaded-object/libc.so");
  const log = artifact("log", "external/neutral/runtime-log-window/runtime.log");
  const artifacts = [boundary, binding, approval, manifest, bundleArtifact, composition, sourceConfig, runtimePolicy, executorState, releaseIntent, candidateProof, releaseEnvironment, unit, database, ready, main, child, loaded, log];
  const edge = (relation: Parameters<typeof sealLegacyClosureRawEdge>[0]["relation"], source: typeof boundary, target: typeof boundary) => sealLegacyClosureRawEdge({
    relation,
    sourceArtifactId: source.artifactId,
    targetArtifactId: target.artifactId,
    targetLogicalKey: target.logicalKey,
    locatorId: source.locatorId,
    locator: source.locator,
  });
  const edges = [
    edge("binds", boundary, binding), edge("binds", binding, approval), edge("binds", approval, manifest),
    edge("binds", manifest, bundleArtifact), edge("binds", manifest, composition), edge("binds", manifest, sourceConfig),
    edge("binds", manifest, runtimePolicy), edge("binds", manifest, executorState), edge("binds", manifest, releaseIntent),
    edge("binds", manifest, candidateProof), edge("binds", manifest, releaseEnvironment), edge("deploys", manifest, unit), edge("executes", unit, main),
    edge("emits", database, ready), edge("binds", ready, main), edge("binds", ready, bundleArtifact),
    edge("emits", ready, log), edge("spawns", main, child), edge("loads", main, loaded), edge("loads", child, loaded),
  ];
  const entrypoint = sealLegacyClosureRawEntrypoint({
    entrypointKind: "consumer",
    logicalKey: ready.logicalKey,
    artifactId: ready.artifactId,
    locatorId: ready.locatorId,
    locator: ready.locator,
  });
  const nested = LEGACY_CLOSURE_ROOT_ROLES.map((role) => {
    const complete = role === "consumer-object-lineage" || role === "production-entrypoint-denominator";
    const provisional = sealLegacyClosureFact({
      role,
      entrypointIds: complete ? [entrypoint.entrypointId] : [],
      artifactIds: complete ? artifacts.map((item) => item.artifactId) : [boundary.artifactId],
      edgeIds: complete ? edges.map((item) => item.edgeId) : [],
      factRefId: h("f"),
    });
    const canonicalValue = withoutFactRefIdForTest(provisional);
    const value = nestedOverride?.role === role ? nestedOverride.value : canonicalValue;
    const mediaType = nestedOverride?.role === role ? (nestedOverride.mediaType ?? "application/json") : "application/json";
    const issued = issueNested(encodeCanonicalBytes(value), nestedSchema, mediaType);
    const closure = sealLegacyClosureFact({ ...canonicalValue, factRefId: issued.factRef.factId });
    return { role, closure, ...issued };
  });
  const closures = nested.map((entry) => entry.closure);
  const denominator = sealLegacyClosureRawDenominator({ artifacts, edges, entrypoints: [entrypoint], closures });
  const predicateSpecDigests = qualificationOverride?.predicateSpecDigests ?? CLOSURE_SPEC_DIGESTS;
  const qualificationCertificateIds = qualificationOverride?.qualificationCertificateIds ?? CLOSURE_CERTIFICATE_IDS;
  const closureReceipt = deriveLegacyAuthorityClosureReceipt(predicateSpecDigests, qualificationCertificateIds, denominator);
  const factRefs = [...rawNesteds.map((entry) => entry.factRef), ...nested.map((entry) => entry.factRef)];
  const bundle = sealLegacyAuthorityClosureFacts(closureReceipt, factRefs, denominator);
  const bundleValue = rootValue ?? bundle;
  const bundleBytes = rootValue === undefined ? encodeLegacyAuthorityClosureFacts(bundle) : encodeCanonicalBytes(bundleValue);
  const bundleContentSha256 = sha256Hex(bundleBytes);
  const bundleLease = createRetentionLeaseReceipt({
    storeIdentityHash: STORE_IDENTITY_HASH,
    objectKey: bundleContentSha256,
    contentSha256: bundleContentSha256,
    validFromStoreEpoch: "1",
    validThroughStoreEpoch: "10",
    issuerId: "gate-core-test",
    issuerQualificationId: h("a"),
    qualificationRegistryRoot: h("b"),
  });
  const bundleLocator = { kind: "content-object" as const, storeIdentityHash: STORE_IDENTITY_HASH, objectKey: bundleContentSha256 };
  const bundleSchema = {
    id: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureFacts.id,
    version: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureFacts.version,
    schemaHash: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureFacts.schemaHash,
  } as const;
  const bundleRef = createReadOnlyArtifactRef({
    locator: bundleLocator,
    immutableMirrorLocator: bundleLocator,
    contentSha256: bundleContentSha256,
    byteLength: String(bundleBytes.byteLength),
    mediaType: "application/json",
    schema: bundleSchema,
    resolverPolicyHash: policy.policyHash,
    retentionLeaseReceiptId: bundleLease.receiptId,
  });
  const nestedArtifacts = [...rawNesteds, ...nested];
  const allRefs = [bundleRef, ...nestedArtifacts.map((entry) => entry.ref)];
  const allLeases = [bundleLease, ...nestedArtifacts.map((entry) => entry.lease)];
  const allClaims = allRefs.map((ref, index) => {
    const bytes = index === 0 ? bundleBytes : nestedArtifacts[index - 1]!.bytes;
    const schema = index === 0 ? bundleSchema : nestedArtifacts[index - 1]!.schema;
    const mediaType = index === 0 ? "application/json" : nestedArtifacts[index - 1]!.mediaType;
    const mirror = createObservedImmutableMirror({
      storeIdentityHash: STORE_IDENTITY_HASH,
      objectKey: ref.contentSha256,
      bytes: encodeArtifactBytes(bytes),
      mediaType,
      schema,
    });
    return createArtifactResolutionClaim({
      artifactRefId: ref.artifactRefId,
      resolverPolicyHash: policy.policyHash,
      observedMirror: mirror,
      outcome: "content-observed",
    });
  });
  const locator = createRuntimeAcceptanceFactLocator({ factKind: "legacy-closure", artifactRefId: bundleRef.artifactRefId, contentSha256: bundleContentSha256 });
  return {
    bundle,
    runtime: {
      facts: [locator],
      refs: allRefs,
      claims: allClaims,
      policies: [policy],
      leases: allLeases,
      observations: [{ observationId: h("c"), rawArtifactRefs: allRefs, observedClaimIds: allClaims.map((claim) => claim.claimId) }],
      trustedReleaseQualificationBindings: qualificationOverride?.trustedBindings ?? Object.freeze([
        Object.freeze({
          predicateId: SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR.predicateId,
          predicateSpecDigest: CLOSURE_SPEC_DIGESTS[0],
          verifierQualificationId: CLOSURE_CERTIFICATE_IDS[0],
        }),
        Object.freeze({
          predicateId: LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR.predicateId,
          predicateSpecDigest: CLOSURE_SPEC_DIGESTS[1],
          verifierQualificationId: CLOSURE_CERTIFICATE_IDS[1],
        }),
      ]),
    },
  };
}

interface NestedArtifactV1 {
  readonly bytes: Uint8Array;
  readonly lease: ReturnType<typeof createRetentionLeaseReceipt>;
  readonly ref: ReturnType<typeof createReadOnlyArtifactRef>;
  readonly factRef: ReturnType<typeof sealRuntimeFactRef>;
}

interface RuntimeFactManifestV1 {
  readonly id: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly schema: { readonly decode: (value: unknown) => unknown };
}

function processAnchor(pid: string, ticks: string) {
  return {
    systemId: "test-host",
    commitSha: sha("a"),
    executableHash: h("c"),
    deploymentManifestHash: h("d"),
    serviceIdentityHash: h("e"),
    pid,
    processStartTicks: ticks,
    bootIdHash: h("f"),
  };
}

interface BuiltRestartRuntimeV1 {
  readonly runtime: PredicateRuntimeFactsV1;
  readonly bundle: RuntimeRestartFactsV1;
}

function buildRestartRuntime(): BuiltRestartRuntimeV1 {
  const policy = createResolverPolicy({
    schemaVersion: 1,
    kind: "aloha.artifact-resolver-policy",
    allowedLocatorKind: "content-object",
    digestAlgorithm: "sha256",
    maxByteLength: "1048576",
    requireExactLengthMediaAndSchema: true,
    minimumRemainingStoreEpochs: "0",
    failureOutcome: "invalid",
  });
  const nestedByFactId = new Map<Hash, NestedArtifactV1>();
  function issueFact<T extends Readonly<Record<string, unknown>>>(
    payload: T,
    manifest: RuntimeFactManifestV1,
  ): T & { readonly factRefId: Hash } {
    const decoded = manifest.schema.decode(payload) as T;
    const bytes = encodeCanonicalBytes(decoded);
    const contentSha256 = sha256Hex(bytes);
    const lease = createRetentionLeaseReceipt({
      storeIdentityHash: STORE_IDENTITY_HASH,
      objectKey: contentSha256,
      contentSha256,
      validFromStoreEpoch: "1",
      validThroughStoreEpoch: "10",
      issuerId: "gate-core-test",
      issuerQualificationId: h("8"),
      qualificationRegistryRoot: h("9"),
    });
    const locator = { kind: "content-object" as const, storeIdentityHash: STORE_IDENTITY_HASH, objectKey: contentSha256 };
    const schema = { id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash } as const;
    const ref = createReadOnlyArtifactRef({
      locator,
      immutableMirrorLocator: locator,
      contentSha256,
      byteLength: String(bytes.byteLength),
      mediaType: "application/json",
      schema,
      resolverPolicyHash: policy.policyHash,
      retentionLeaseReceiptId: lease.receiptId,
    });
    const factRef = sealRuntimeFactRef({
      artifactRefId: ref.artifactRefId,
      contentSha256,
      byteLength: String(bytes.byteLength),
      schema,
      locator,
    });
    const existing = nestedByFactId.get(factRef.factId);
    if (existing === undefined) nestedByFactId.set(factRef.factId, { bytes, lease, ref, factRef });
    return Object.freeze({ ...decoded, factRefId: factRef.factId });
  }
  const outcome = (
    key: string,
    dependency: string,
    result: RuntimeCandidateOutcomeV1["outcome"],
    resultDigit: string,
  ): RuntimeCandidateOutcomeV1 => issueFact({
    candidateKey: h(key),
    runCandidateKey: h(key),
    dependencyClosureRoot: h(dependency),
    outcomeHash: h(resultDigit),
    outcome: result,
  }, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.candidateOutcomeFactPayload);
  const partition = (items: readonly RuntimeCandidateOutcomeV1[]) => {
    const sorted = [...items].sort((left, right) => left.runCandidateKey.localeCompare(right.runCandidateKey));
    return { count: String(sorted.length), root: hashRuntimeCandidateOutcomePartition(sorted), items: sorted };
  };
  const deltaItem = (payload: Omit<RuntimeCandidateDeltaPartitionV1["items"][number], "factRefId">) =>
    issueFact(payload, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.candidateDeltaFactPayload);
  const delta = (
    change: RuntimeCandidateDeltaPartitionV1["change"],
    items: RuntimeCandidateDeltaPartitionV1["items"],
  ): RuntimeCandidateDeltaPartitionV1 => {
    const sorted = [...items].sort((left, right) => left.runCandidateKey.localeCompare(right.runCandidateKey));
    return { change, count: String(sorted.length), root: hashRuntimeCandidateDeltaPartition(change, sorted), items: sorted };
  };

  const beforeProcess = processAnchor("100", "10");
  const afterProcess = processAnchor("200", "20");
  const source = { chainId: "1", number: "100", hash: h("1"), stateRoot: h("2") };
  const before = issueFact({
    runtimeCommitSha: sha("a"),
    processAnchorHash: hashDomain("aloha/process-anchor/v1", beforeProcess),
    processAnchor: beforeProcess,
    systemdUnit: "aloha-searcher.service",
    systemdExecStartHash: h("3"),
    executableHash: h("c"),
    logAnchor: { systemId: "test-host", bootIdHash: h("f"), device: "1", inode: "10", startInclusive: "1", endExclusive: "100", contentSha256: h("4") },
    sourceAnchor: source,
    releaseIntentRoot: h("5"),
    definitionCatalogRoot: h("6"),
    sourceCoverageRoot: h("d"),
    strategyCatalogRoot: h("7"),
    instanceCatalogRoot: h("8"),
    graphRoot: h("9"),
    readyRecordHash: h("a"),
    generationId: "generation-1",
  }, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.processAnchorFactPayload);
  const after = issueFact({
    ...withoutFactRefIdForTest(before),
    processAnchorHash: hashDomain("aloha/process-anchor/v1", afterProcess),
    processAnchor: afterProcess,
    logAnchor: { ...before.logAnchor, inode: "11", contentSha256: h("a") },
  }, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.processAnchorFactPayload);

  const previousOne = outcome("1", "1", "verified", "1");
  const previousTwo = outcome("2", "2", "rejected", "2");
  const previousFour = outcome("4", "4", "verified", "4");
  const currentOne = previousOne;
  const currentThree = outcome("3", "3", "verified", "3");
  const currentFour = outcome("4", "5", "retryable", "5");
  const currentFive = outcome("5", "6", "retryable", "6");
  const previous = partition([previousOne, previousTwo, previousFour]);
  const current = partition([currentOne, currentThree, currentFour, currentFive]);
  const differencePayload = {
    previousCandidates: previous,
    currentCandidates: current,
    memoReused: delta("memo-reused", [deltaItem({ candidateKey: h("1"), runCandidateKey: h("1"), previousDependencyClosureRoot: h("1"), currentDependencyClosureRoot: h("1"), previousOutcomeHash: h("1"), currentOutcomeHash: h("1") })]),
    newCandidates: delta("new", [deltaItem({ candidateKey: h("3"), runCandidateKey: h("3"), previousDependencyClosureRoot: null, currentDependencyClosureRoot: h("3"), previousOutcomeHash: null, currentOutcomeHash: h("3") })]),
    invalidatedDependencyClosure: delta("invalidated-dependency", [deltaItem({ candidateKey: h("4"), runCandidateKey: h("4"), previousDependencyClosureRoot: h("4"), currentDependencyClosureRoot: h("5"), previousOutcomeHash: h("4"), currentOutcomeHash: h("5") })]),
    retryable: delta("retryable", [deltaItem({ candidateKey: h("5"), runCandidateKey: h("5"), previousDependencyClosureRoot: null, currentDependencyClosureRoot: h("6"), previousOutcomeHash: null, currentOutcomeHash: h("6") })]),
    rejectionNotReused: delta("rejection-not-reused", [deltaItem({ candidateKey: h("2"), runCandidateKey: h("2"), previousDependencyClosureRoot: h("2"), currentDependencyClosureRoot: null, previousOutcomeHash: h("2"), currentOutcomeHash: null })]),
    unchangedOldInstanceAttestations: delta("unchanged-old-instance-attestation", []),
  };
  const difference = issueFact(differencePayload, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartDifferenceFactPayload);
  const changedProbeOutcome = outcome("1", "1", "verified", "8");
  const singleTargetProbe = issueFact({
    targetRunCandidateKey: h("1"),
    beforeOutcomes: partition([previousOne, currentThree]),
    afterOutcomes: partition([changedProbeOutcome, currentThree]),
    changedRunCandidateKeys: { count: "1", root: hashDomain("aloha/runtime-acceptance/hash-partition/v1", [h("1")]), items: [h("1")] },
    targetBeforeOutcomeHash: h("1"),
    targetAfterOutcomeHash: h("8"),
  }, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.singleTargetProbeFactPayload);
  const durable = partition([previousOne]);
  const sigtermRecovery = issueFact({
    observedSignal: "SIGTERM" as const,
    signalProcessAnchorHash: before.processAnchorHash,
    flushedOutcomes: durable,
    afterRestartOutcomes: durable,
    durableOutcomeRoot: durable.root,
  }, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.sigtermRecoveryFactPayload);
  const graphViewLeaseObservations = [{
    eventType: "head-coverage" as const,
    eventId: h("c"),
    processAnchorHash: after.processAnchorHash,
    pid: after.processAnchor.pid,
    processStartTicks: after.processAnchor.processStartTicks,
    generationId: after.generationId,
    graphRoot: after.graphRoot,
    readyRecordHash: after.readyRecordHash,
    sourceCoverageRoot: after.sourceCoverageRoot,
    headHash: h("e"),
  }];
  const graphReuse = issueFact({
    mode: "direct-reuse" as const,
    beforeGraphRoot: before.graphRoot,
    afterGraphRoot: after.graphRoot,
    beforeReadyRecordHash: before.readyRecordHash,
    afterReadyRecordHash: after.readyRecordHash,
    graphViewLeaseObservations,
    graphViewLeaseRoot: hashRuntimeGraphViewLeaseObservations(graphViewLeaseObservations),
  }, RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.graphReuseFactPayload);
  const nested = [...nestedByFactId.values()];
  const factRefs = nested.map((entry) => entry.factRef);
  const bundle = {
    schemaVersion: 1 as const,
    kind: "aloha.runtime-restart-facts" as const,
    before,
    after,
    graphReuse,
    difference,
    singleTargetProbe,
    sigtermRecovery,
    factRefs,
    factRefsRoot: hashRuntimeFactRefRoot(factRefs),
  } as RuntimeRestartFactsV1;
  const bundleBytes = encodeRuntimeRestartFacts(bundle);
  const bundleContentSha256 = sha256Hex(bundleBytes);
  const bundleLease = createRetentionLeaseReceipt({
    storeIdentityHash: STORE_IDENTITY_HASH,
    objectKey: bundleContentSha256,
    contentSha256: bundleContentSha256,
    validFromStoreEpoch: "1",
    validThroughStoreEpoch: "10",
    issuerId: "gate-core-test",
    issuerQualificationId: h("a"),
    qualificationRegistryRoot: h("b"),
  });
  const bundleLocator = { kind: "content-object" as const, storeIdentityHash: STORE_IDENTITY_HASH, objectKey: bundleContentSha256 };
  const bundleSchema = {
    id: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartFacts.id,
    version: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartFacts.version,
    schemaHash: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartFacts.schemaHash,
  } as const;
  const bundleRef = createReadOnlyArtifactRef({
    locator: bundleLocator,
    immutableMirrorLocator: bundleLocator,
    contentSha256: bundleContentSha256,
    byteLength: String(bundleBytes.byteLength),
    mediaType: "application/json",
    schema: bundleSchema,
    resolverPolicyHash: policy.policyHash,
    retentionLeaseReceiptId: bundleLease.receiptId,
  });
  const allRefs = [bundleRef, ...nested.map((entry) => entry.ref)];
  const allLeases = [bundleLease, ...nested.map((entry) => entry.lease)];
  const allBytes = [bundleBytes, ...nested.map((entry) => entry.bytes)];
  const allClaims = allRefs.map((ref, index) => createArtifactResolutionClaim({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: policy.policyHash,
    observedMirror: createObservedImmutableMirror({
      storeIdentityHash: STORE_IDENTITY_HASH,
      objectKey: ref.contentSha256,
      bytes: encodeArtifactBytes(allBytes[index]!),
      mediaType: "application/json",
      schema: ref.schema!,
    }),
    outcome: "content-observed",
  }));
  return {
    bundle,
    runtime: {
      facts: [createRuntimeAcceptanceFactLocator({ factKind: "restart", artifactRefId: bundleRef.artifactRefId, contentSha256: bundleContentSha256 })],
      refs: allRefs,
      claims: allClaims,
      policies: [policy],
      leases: allLeases,
      observations: [{ observationId: h("c"), rawArtifactRefs: allRefs, observedClaimIds: allClaims.map((claim) => claim.claimId) }],
    },
  };
}

function withoutFactRefIdForTest<T extends { readonly factRefId: Hash }>(
  value: T,
): Omit<T, "factRefId"> {
  const { factRefId: _factRefId, ...payload } = value;
  return payload;
}

function evaluate(evaluator: typeof SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, runtime: PredicateRuntimeFactsV1): string {
  const verdict = evaluator.evaluateLive(runtime, { add: () => undefined });
  return verdict;
}

test("runtime acceptance adapters require a content-addressed locator and exact normalized joins", () => {
  const built = buildRuntime();
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, built.runtime), "pass");
  assert.equal(evaluate(LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR, built.runtime), "pass");
  assert.equal(evaluate(RUNTIME_RESTART_PREDICATE_EVALUATOR, { ...built.runtime, facts: [built.bundle] }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, facts: [built.bundle.receipt] }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, facts: [{ schemaVersion: 1, kind: "aloha.legacy-authority-zero-aggregate-facts", receipt: built.bundle.receipt, aggregateId: h("d") }] }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, refs: built.runtime.refs.slice(1) }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, claims: built.runtime.claims.slice(1) }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, policies: [] }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, leases: built.runtime.leases.slice(1) }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, observations: [] }), "invalid");
});

test("closure adapters exact-bind the ordered current predicate and verifier qualification pair", () => {
  const built = buildRuntime();
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, {
    ...built.runtime,
    trustedReleaseQualificationBindings: undefined,
  }), "invalid");

  const swappedSpecs = buildRuntime(undefined, undefined, {
    predicateSpecDigests: [CLOSURE_SPEC_DIGESTS[1], CLOSURE_SPEC_DIGESTS[0]],
  });
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, swappedSpecs.runtime), "invalid");
  assert.equal(evaluate(LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR, swappedSpecs.runtime), "invalid");

  const foreignSpecs = buildRuntime(undefined, undefined, {
    predicateSpecDigests: [h("3"), h("4")],
  });
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, foreignSpecs.runtime), "invalid");

  const foreignCertificates = buildRuntime(undefined, undefined, {
    qualificationCertificateIds: [h("7"), h("8")],
  });
  assert.equal(evaluate(LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR, foreignCertificates.runtime), "invalid");

  const swappedTrustedBindings = Object.freeze([
    Object.freeze({
      predicateId: SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR.predicateId,
      predicateSpecDigest: CLOSURE_SPEC_DIGESTS[1],
      verifierQualificationId: CLOSURE_CERTIFICATE_IDS[1],
    }),
    Object.freeze({
      predicateId: LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_EVALUATOR.predicateId,
      predicateSpecDigest: CLOSURE_SPEC_DIGESTS[0],
      verifierQualificationId: CLOSURE_CERTIFICATE_IDS[0],
    }),
  ]);
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, {
    ...built.runtime,
    trustedReleaseQualificationBindings: swappedTrustedBindings,
  }), "invalid");
});

test("runtime acceptance adapters reject mirror, content, length, schema, locator and producer-field splices", () => {
  const built = buildRuntime();
  const firstNestedRef = built.runtime.refs[1]!;
  const firstNestedClaimIndex = built.runtime.claims.findIndex((claim) => claim.artifactRefId === firstNestedRef.artifactRefId);
  const secondNestedClaim = built.runtime.claims.find((claim) => claim.artifactRefId === built.runtime.refs[2]!.artifactRefId)!;
  const firstNestedClaim = built.runtime.claims[firstNestedClaimIndex]!;
  const mirrorSpliceClaim = createArtifactResolutionClaim({
    artifactRefId: firstNestedClaim.artifactRefId,
    resolverPolicyHash: firstNestedClaim.resolverPolicyHash,
    observedMirror: secondNestedClaim.observedMirror,
    outcome: "content-observed",
  });
  const mirrorSpliceClaimIds = built.runtime.claims.map((claim) => claim.claimId === firstNestedClaim.claimId ? mirrorSpliceClaim.claimId : claim.claimId);
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, claims: built.runtime.claims.map((claim, index) => index === firstNestedClaimIndex ? mirrorSpliceClaim : claim), observations: [{ ...built.runtime.observations[0]!, observedClaimIds: mirrorSpliceClaimIds }] }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, facts: [{ ...(built.runtime.facts[0] as object), contentSha256: h("d") }] }), "invalid");
  const badLengthClaim = { ...built.runtime.claims[0]!, observedMirror: { ...built.runtime.claims[0]!.observedMirror!, byteLength: "0" } };
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, claims: [badLengthClaim, ...built.runtime.claims.slice(1)], observations: [{ ...built.runtime.observations[0]!, observedClaimIds: [badLengthClaim.claimId, ...built.runtime.observations[0]!.observedClaimIds.slice(1)] }] }), "invalid");
  const schemaSpliceMirror = { ...built.runtime.claims[0]!.observedMirror!, schema: {
    id: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureRootFactPayload.id,
    version: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureRootFactPayload.version,
    schemaHash: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureRootFactPayload.schemaHash,
  } };
  const schemaSpliceClaim = createArtifactResolutionClaim({ artifactRefId: built.runtime.claims[0]!.artifactRefId, resolverPolicyHash: built.runtime.claims[0]!.resolverPolicyHash, observedMirror: schemaSpliceMirror, outcome: "content-observed" });
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, claims: [schemaSpliceClaim, ...built.runtime.claims.slice(1)], observations: [{ ...built.runtime.observations[0]!, observedClaimIds: [schemaSpliceClaim.claimId, ...built.runtime.observations[0]!.observedClaimIds.slice(1)] }] }), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, { ...built.runtime, facts: [{ ...(built.runtime.facts[0] as object), artifactRefId: built.runtime.refs[1]!.artifactRefId }] }), "invalid");
  const producerFieldBundle = { ...built.bundle, producerVerdict: "pass" };
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, buildRuntime(producerFieldBundle).runtime), "invalid");
  const rawArtifact = built.bundle.denominator.artifacts[0]!;
  const declaredClassification = { ...rawArtifact, repositoryOrigin: "aloha-candidate", authorityShape: "strict-authority" };
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, buildRuntime({ ...built.bundle, denominator: { ...built.bundle.denominator, artifacts: [declaredClassification] } }).runtime), "invalid");
  const renamedClassification = { ...rawArtifact, logicalKey: "reference/legacy-shaped-authority/packages/runtime.ts" };
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, buildRuntime({ ...built.bundle, denominator: { ...built.bundle.denominator, artifacts: [renamedClassification] } }).runtime), "invalid");
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, buildRuntime(undefined, { role: LEGACY_CLOSURE_ROOT_ROLES[0], value: { arbitrary: "canonical-json" } }).runtime), "invalid");
  const validRole = LEGACY_CLOSURE_ROOT_ROLES[0];
  const validClosure = built.bundle.denominator.closures.find((closure) => closure.role === validRole)!;
  assert.equal(evaluate(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_EVALUATOR, buildRuntime(undefined, { role: validRole, value: withoutFactRefIdForTest(validClosure), mediaType: "application/octet-stream" }).runtime), "invalid");
});

test("runtime restart adapter joins every typed nested fact through its locator", () => {
  const built = buildRestartRuntime();
  assert.equal(evaluate(RUNTIME_RESTART_PREDICATE_EVALUATOR, built.runtime), "pass");

  const firstNestedRef = built.runtime.refs[1]!;
  const firstNestedClaimIndex = built.runtime.claims.findIndex((claim) => claim.artifactRefId === firstNestedRef.artifactRefId);
  const firstNestedClaim = built.runtime.claims[firstNestedClaimIndex]!;
  const secondNestedClaim = built.runtime.claims.find((claim) => claim.artifactRefId === built.runtime.refs[2]!.artifactRefId)!;
  const splicedClaim = createArtifactResolutionClaim({
    artifactRefId: firstNestedClaim.artifactRefId,
    resolverPolicyHash: firstNestedClaim.resolverPolicyHash,
    observedMirror: secondNestedClaim.observedMirror,
    outcome: "content-observed",
  });
  const claims = built.runtime.claims.map((claim, index) => index === firstNestedClaimIndex ? splicedClaim : claim);
  const observedClaimIds = built.runtime.observations[0]!.observedClaimIds.map((claimId) => claimId === firstNestedClaim.claimId ? splicedClaim.claimId : claimId);
  assert.equal(evaluate(RUNTIME_RESTART_PREDICATE_EVALUATOR, {
    ...built.runtime,
    claims,
    observations: [{ ...built.runtime.observations[0]!, observedClaimIds }],
  }), "invalid");
  assert.equal(evaluate(RUNTIME_RESTART_PREDICATE_EVALUATOR, {
    ...built.runtime,
    refs: built.runtime.refs.slice(0, -1),
  }), "invalid");
  assert.equal(evaluate(RUNTIME_RESTART_PREDICATE_EVALUATOR, {
    ...built.runtime,
    observations: [],
  }), "invalid");
});
