import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type Hash } from "../../canonical-codec/src/index.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import { createEvidenceEvent, EVIDENCE_SCHEMA_MANIFESTS } from "../../../specs/evidence/src/index.ts";
import { createReadOnlyArtifactRef } from "../../../specs/core-envelope/src/index.ts";
import {
  createRuntimeReleaseBindingV1, createRuntimeReleaseDiscoverySourceQualificationV1,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1, hashQualifiedExecutorRegistryEntry, hashQualifiedExecutorRegistryRoot,
  sealRuntimeReleaseNominationQualificationSetV1,
  runtimeReleaseBindingProvenanceHash, runtimeReleaseBindingSigningBytes, type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import { verifyAndIssueRuntimeReleaseAuthorityV1 } from "../src/index.ts";
import * as runtimeReleasePublic from "../src/index.ts";
import { assertIssuedRuntimeReleaseReadyBindingPort } from "../src/internal/ready-binding-consumer.ts";
import { assertIssuedCurrentRuntimeAuthorityPort } from "../src/internal/ready-binding-consumer.ts";
import { issueUnsignedDryRunRuntimeAuthorityV1 } from "../src/internal/unsigned-authority-owner.ts";
import { issueDeploymentAttestationProofPort } from "../src/internal/attestation-proof-owner.ts";
import { issueCandidatePartitionProofIssuerPort } from "../../../specs/candidate-partition-authority/src/internal/issuer-owner.ts";
import type { CandidatePartitionProofIssuerPortV1 } from "../../../specs/candidate-partition-authority/src/index.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../scheduler/src/internal/authority-owner.ts";
import { issueRuntimeReleaseCandidatePartitionProofIssuer } from "../src/internal/candidate-partition-proof-owner.ts";
import { issueRuntimeReleaseQualifiedExecutorAuthorityIssuer } from "../src/internal/scheduler-authority-owner.ts";
import {
  issueRuntimeReleaseExecutorLeaseV1,
  issueRuntimeReleaseRevmWorkerAuthorityIssuer,
} from "../src/internal/revm-worker-owner.ts";
import {
  issueDeploymentRuntimeInfrastructureV1,
  readDeploymentRuntimeInfrastructureV1,
} from "../src/internal/deployment-runtime-owner.ts";
import { readIssuedRevmWorkerDeploymentPort } from "../../../runtime/revm-workers/src/internal/authority.ts";
import type { RevmWorkerAuthorityBindingV1 } from "../../../runtime/revm-workers/src/protocol.ts";
import { WorkScheduler, type QualifiedExecutorAuthorityCapability, type QualifiedExecutorAuthorityIssuer } from "../../scheduler/src/index.ts";
import { issueQualifiedSharedSchedulerRuntimePort } from "../../scheduler/src/internal/shared-runtime-owner.ts";
import {
  createSchedulerOwnedFamilyExecutionPort,
  issueQualifiedPhysicalExecutionPort,
} from "../../work-plane/src/internal/family-execution-port.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../generated/runtime-composition/index.ts";
import { readGeneratedFamilyRuntimeFactoryMetadata } from "../../family-composition/src/internal/generated-runtime-composition.ts";
import { issueRuntimeReleaseFamilyRuntimeAuthorityCapability } from "../src/internal/family-runtime-owner.ts";
import { issueRuntimeReleaseNominationQualificationVerifier } from "../src/internal/nomination-qualification-owner.ts";
import {
  assertProductionSixStepEvidenceLogAppendSizeV1,
  assertProductionSixStepEvidenceLogRecoverySizeV1,
  recoverProductionSixStepEvidenceSequenceFromReaderV1,
  recoverProductionSixStepEvidenceSequenceV1,
} from "../src/internal/six-step-production-owner.ts";
import { SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1 } from "../../../specs/evidence/src/six-step.ts";
import {
  createGeneratedStrategyRuntimeFactory,
} from "../../strategy-composition/src/internal/generated-runtime-composition.ts";
import {
  sealGeneratedStrategyRuntimeDescriptor,
  strategyPlanningTemplateHash,
  type StrategyGraphBindingV1,
  type StrategyGraphEdgeV1,
  type GeneratedStrategyRuntimeEntryV1,
} from "../../strategy-composition/src/index.ts";
import { compileStrategy } from "../../strategy-sdk/src/index.ts";
import { ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER, ROUTE_CYCLE_STRATEGY } from "../../../strategies/route-cycle/src/index.ts";
import {
  assertIssuedRuntimeReleaseStrategyRuntimeService,
  assertIssuedUnsignedDryRunStrategyRuntimeService,
  issueRuntimeReleaseStrategyRuntimeService,
  issueUnsignedDryRunStrategyRuntimeService,
} from "../src/internal/strategy-runtime-owner.ts";
import { issueProducerIngressTriggerV1 } from "../../producer/src/internal/owners.ts";
import { issueProducerBoundTriggerV1 } from "../../producer/src/index.ts";
import {
  issueRuntimeReleaseQualifiedDiscoverySourcePort,
  readRuntimeReleaseQualifiedDiscoverySourcePort,
} from "../src/internal/discovery-source-authority-owner.ts";
import {
  issueRuntimeReleaseFullFamilyTerminalBindingServiceV1,
} from "../src/internal/full-family-terminal-owner.ts";
import {
  readRuntimeReleaseFullFamilyTerminalBindingV1,
} from "../src/full-family-terminal-consumer.ts";
import { createSearchTerminalFixture } from "../../producer/test/fixtures/search-terminal.ts";
import { issueProducerIngressSourceForTestV1 } from "../../producer/test/fixtures/ingress-source.ts";
import { issueProducerIngressPortV1 } from "../../producer/src/internal/owners.ts";
import type { CanonicalHead } from "../../producer/src/index.ts";

const h = (value: string): Hash => hashDomain("test/runtime-authority", value);
const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1("runtime-release-authority");
const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1("runtime-release-authority");

test("unsigned dry-run lifetime exposes only neutral current authority", () => {
  const descriptor = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "unsigned-dry-run",
    runtimeBindingId: h("unsigned-binding"),
    implementationCommit: "7".repeat(40),
  });
  const authority = issueUnsignedDryRunRuntimeAuthorityV1(descriptor);
  const current = assertIssuedCurrentRuntimeAuthorityPort(authority.readyGeneration).readCurrent();
  assert.deepEqual(current, {
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(descriptor),
    releaseProvenanceHash: null,
  });
  assert.throws(
    () => assertIssuedRuntimeReleaseReadyBindingPort(authority.readyGeneration),
    /not release-issued/,
  );
  authority.revoke();
  assert.throws(() => authority.readyGeneration.readCurrent(), /revoked/);
});

test("Six-Step evidence restart derives sequence 100 from the canonical production event kind", () => {
  const boundary = createReadOnlyArtifactRef({
    locator: {
      kind: "checkpoint-record",
      storeIdentityHash: h("recovery-boundary-store"),
      namespaceHash: h("recovery-boundary-namespace"),
      keyHash: h("recovery-boundary-key"),
      revision: "1",
      recordHash: h("recovery-boundary-record"),
    },
    immutableMirrorLocator: {
      kind: "content-object",
      storeIdentityHash: h("recovery-mirror-store"),
      objectKey: h("recovery-boundary-content"),
    },
    contentSha256: h("recovery-boundary-content"),
    byteLength: "1",
    mediaType: "application/octet-stream",
    schema: null,
    resolverPolicyHash: h("recovery-resolver-policy"),
    retentionLeaseReceiptId: h("recovery-retention-lease"),
  });
  const fact = createEvidenceEvent({
    schemaVersion: 1,
    kind: "aloha.fact-evidence-event",
    source: {
      systemId: "recovery-test",
      emitterKind: "native",
      emitterCodeHash: h("recovery-emitter"),
      rawBoundaryArtifactRef: boundary,
    },
    runtime: {
      commitSha: "a".repeat(40),
      executableHash: h("recovery-executable"),
      deploymentManifestHash: h("recovery-deployment"),
      serviceIdentityHash: h("recovery-service"),
      pid: "1",
      processStartTicks: "1",
      bootIdHash: h("recovery-boot"),
      logRangeArtifactRefId: h("recovery-log-range"),
    },
    artifactLineage: {
      inputArtifactIds: [h("recovery-input")],
      outputArtifactId: h("recovery-output"),
      productionReceiptId: h("recovery-receipt"),
    },
    scope: {
      kind: "builder-run",
      builderRunId: "recovery-builder",
      producerSessionId: null,
      generationId: null,
      generationRefreshPolicyHash: h("recovery-refresh-policy"),
    },
    correlationId: "recovery-correlation",
    runSequence: "0",
    cutoff: { number: "1", hash: h("recovery-block"), stateRoot: h("recovery-state") },
    definitionCatalogRoot: h("recovery-definition-catalog"),
    strategyCatalogRoot: null,
    instanceCatalogRoot: null,
    graphRoot: null,
    familyId: "recovery-family",
    candidateKey: "recovery-candidate",
    familyDefinitionHash: h("recovery-family-definition"),
    capabilities: [],
    instanceKey: "recovery-instance",
    stage: { ordinal: 1, id: "universe_instance", version: 1 },
    parentEventIds: [],
    parentOutputHashes: [],
    inputSchema: { id: "recovery-input", version: "1.0.0", schemaHash: h("recovery-input-schema") },
    inputs: { source: "production-recovery" },
    factSchema: { id: "recovery-fact", version: "1.0.0", schemaHash: h("recovery-fact-schema") },
    facts: { observed: true },
    outcome: "verified",
    reasonCode: null,
    latency: { startedMonotonicNs: "1", finishedMonotonicNs: "2", durationUs: "1" },
    extensions: [],
  });
  const event = encodeCanonicalBytes(fact);
  const native = encodeCanonicalBytes({ kind: "aloha.six-step-native-boundary-record" });
  const staleAlias = encodeCanonicalBytes({ kind: "aloha.evidence-event" });
  const records = [native, staleAlias, ...Array.from({ length: 100 }, () => event)];
  const bytes = Buffer.concat(records.flatMap(record => [Buffer.from(record), Buffer.from("\n")]));
  assert.equal(recoverProductionSixStepEvidenceSequenceV1(bytes), 100n);
  const recoverInSmallChunks = (input: Uint8Array, size = BigInt(input.byteLength)): bigint =>
    recoverProductionSixStepEvidenceSequenceFromReaderV1(size, (buffer, position) => {
      const start = Number(position);
      const length = Math.min(buffer.byteLength, 7, input.byteLength - start);
      buffer.set(input.subarray(start, start + length));
      return length;
    });
  assert.equal(recoverInSmallChunks(bytes), 100n);
  assert.throws(
    () => recoverInSmallChunks(bytes.subarray(0, bytes.byteLength - 1)),
    /incomplete record/,
  );
  assert.throws(
    () => recoverInSmallChunks(bytes.subarray(0, bytes.byteLength - 1), BigInt(bytes.byteLength)),
    /truncated during recovery/,
  );
  const malformedCanonicalEvent = encodeCanonicalBytes({ kind: EVIDENCE_SCHEMA_MANIFESTS.event.id });
  assert.throws(
    () => recoverInSmallChunks(Buffer.concat([
      Buffer.from(malformedCanonicalEvent),
      Buffer.from("\n"),
    ])),
  );
  const limit = BigInt(SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes);
  const nativeRecord = Buffer.concat([
    Buffer.from(encodeCanonicalBytes({ kind: "aloha.six-step-native-boundary-record", padding: "a".repeat(65_536) })),
    Buffer.from("\n"),
  ]);
  const repeatCount = Number(limit / BigInt(nativeRecord.byteLength)) + 1;
  const recoveredSize = BigInt(nativeRecord.byteLength * repeatCount);
  assert.ok(recoveredSize > limit);
  assert.equal(recoverProductionSixStepEvidenceSequenceFromReaderV1(
    recoveredSize,
    (buffer, position) => {
      let sourceOffset = Number(position % BigInt(nativeRecord.byteLength));
      let written = 0;
      while (written < buffer.byteLength) {
        const length = Math.min(buffer.byteLength - written, nativeRecord.byteLength - sourceOffset);
        buffer.set(nativeRecord.subarray(sourceOffset, sourceOffset + length), written);
        written += length;
        sourceOffset = 0;
      }
      return written;
    },
  ), 0n);
  assert.doesNotThrow(() => assertProductionSixStepEvidenceLogRecoverySizeV1(recoveredSize));
  assert.throws(
    () => assertProductionSixStepEvidenceLogRecoverySizeV1(-1n),
    /must be non-negative/,
  );
  assert.doesNotThrow(() => assertProductionSixStepEvidenceLogAppendSizeV1(recoveredSize, 1n));
  assert.doesNotThrow(() => assertProductionSixStepEvidenceLogAppendSizeV1(recoveredSize, limit));
  assert.throws(
    () => assertProductionSixStepEvidenceLogAppendSizeV1(recoveredSize, limit + 1n),
    /record exceeds its byte policy/,
  );
  assert.throws(
    () => assertProductionSixStepEvidenceLogAppendSizeV1(-1n, 1n),
    /start must be non-negative/,
  );
  assert.throws(
    () => assertProductionSixStepEvidenceLogAppendSizeV1(0n, -1n),
    /record exceeds its byte policy/,
  );
});
const executor = { executorKind: "revm", engineBuildFingerprint: h("engine"), executableFingerprint: h("exe"), closureFingerprint: h("closure"), protocolFingerprint: h("protocol"), schemaFingerprint: h("schema"), releaseRoleManifestRoot: h("manifest"), candidateCommit: "3".repeat(40) };
const generatedFamilyMetadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
const nominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1(
  generatedFamilyMetadata.nominationProgramProposalLeafDigests.map(proposalLeafDigest => ({
    proposalLeafDigest,
    criticalMutationCorpusRoot: h(`nomination-mutations:${proposalLeafDigest}`),
    independentOracleCaseRoot: h(`nomination-oracle:${proposalLeafDigest}`),
    qualificationSpecDigest: h(`nomination-spec:${proposalLeafDigest}`),
    verifierQualificationCertificateRoot: h(`nomination-certificate:${proposalLeafDigest}`),
  })),
);
const payload: RuntimeReleaseBindingPayloadV1 = {
  schemaVersion: 1, kind: "aloha.runtime-release-binding",
  releaseAuthorityApprovalId: h("approval"), releaseAuthorityApprovalPayloadHash: h("approval-payload"), releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"),
  externalTrustAnchorRoot: h("anchor"), externalIssuerKeySetRoot: h("keys"), qualificationRegistryApprovalId: h("registry-approval"),
  qualificationRegistryRoot: h("registry"), qualificationEpoch: "1", qualificationAudienceHash: h("audience"),
  predicateCompositionRootDigest: h("composition"), gateCoreRuntimeClosureDigest: h("runtime"), gateCoreImplementationClosureDigest: h("core"),
  searcherRuntime: { runtimeArtifactRoot: h("searcher-artifact"), implementationClosureDigest: h("searcher-closure"), nodeExecutableSha256: h("searcher-node"), entrypointSha256: h("searcher-entrypoint"), bundleModulePath: "/etc/aloha/deployment-bundle.mjs", bundleModuleSha256: h("searcher-bundle") },
  discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: "reth-mainnet",
    backendEpoch: "reth-backend-1",
    profile: "reth-json-rpc-v1",
    chainId: "1",
    endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"),
    qualificationRoot: h("discovery-source-qualification"),
  }),
  qualifiedExecutorRegistry: [executor], qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([executor]),
  valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
  valuationOwnerQualificationCertificates: valuationQualification.certificates,
  qualifiedValuationOwnerSetRoot: valuationQualification.root,
  actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
  actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
  qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
  safetyProfile: actionOwnerQualification.profile,
  safetyProfileRoot: actionOwnerQualification.profileRoot,
  qualifiedCapabilityRefsRoot: generatedFamilyMetadata.proposedCapabilitySetRoot,
  nominationProgramSetRoot: nominationQualificationSet.programSetRoot,
  nominationQualificationSet,
  nominationQualificationSetRoot: nominationQualificationSet.root,
  selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(executor), selectedExecutor: executor,
  releaseRoleManifestRoot: executor.releaseRoleManifestRoot, candidateReleaseCommit: executor.candidateCommit, workerEpoch: "epoch-1", executorSessionHash: h("session"),
  frameworkAuthorityRoot: h("framework"), executorAuthorityRoot: h("executor-authority"), releaseAuthorityRoot: h("release-authority"),
  attestationProofIssuerKeyId: h("proof"), candidatePartitionProofIssuerKeyId: h("partition-proof"),
};
function rawKey(value: ReturnType<typeof generateKeyPairSync>["publicKey"]): `0x${string}` { const der = value.export({ format: "der", type: "spki" }); return `0x${der.subarray(-32).toString("hex")}`; }
function issued(bindingPayload: RuntimeReleaseBindingPayloadV1 = payload) {
  const keys = generateKeyPairSync("ed25519"); const signerKeyId = h("signer");
  const signatureHex = `0x${sign(null, Buffer.from(runtimeReleaseBindingSigningBytes(bindingPayload, signerKeyId)), keys.privateKey).toString("hex")}`;
  const binding = createRuntimeReleaseBindingV1(bindingPayload, signerKeyId, signatureHex);
  return { authority: verifyAndIssueRuntimeReleaseAuthorityV1(binding, { signerKeyId, publicKeyHex: rawKey(keys.publicKey) }), binding, keys, signerKeyId };
}

async function terminalForRelease(releaseProvenanceHash: Hash, label: string) {
  const head: CanonicalHead = Object.freeze({
    chainId: "1",
    number: "100",
    hash: h(`terminal-head:${label}`),
    parentHash: h(`terminal-parent:${label}`),
    stateRoot: h(`terminal-state:${label}`),
  });
  const generationId = `terminal-generation:${label}`;
  const fixture = createSearchTerminalFixture({
    head,
    generationId,
    mode: "no-candidate",
    releaseProvenanceHash,
  });
  const source = issueProducerIngressSourceForTestV1({
    async observe() {
      const snapshotBody = Object.freeze({
        pendingNumber: "101",
        parentHash: head.hash,
        orderedTransactionHashes: Object.freeze([]),
        orderedTransactionHashesRoot: hashDomain("aloha/public-pending-transaction-set/v1", []),
        transactionCount: "0",
      });
      const snapshot = Object.freeze({
        ...snapshotBody,
        snapshotHash: hashDomain("aloha/public-pending-snapshot/v1", { head, ...snapshotBody }),
      });
      return Object.freeze({
        head,
        blockscan: Object.freeze({ input: Object.freeze({ kind: "blockscan" }) }),
        backrun: Object.freeze({
          kind: "observed-empty" as const,
          snapshot,
          absenceEvidenceHash: hashDomain("aloha/public-pending-absence-evidence/v1", { head, snapshotHash: snapshot.snapshotHash }),
        }),
      });
    },
  });
  const envelope = await issueProducerIngressPortV1(source).observe({ head, signal: new AbortController().signal });
  if (envelope === null) throw new TypeError("terminal ingress fixture is missing");
  const result = await fixture.run({
    kind: "blockscan",
    session: fixture.session,
    head,
    revision: "0",
    generationId,
    graphRoot: fixture.session.lease.binding.graphRoot,
    input: envelope.blockscanInput,
    signal: new AbortController().signal,
  });
  if (result.outcome.kind !== "route-set-terminal" && result.outcome.kind !== "unsigned-dry-run") {
    throw new TypeError("terminal fixture did not issue a search terminal");
  }
  return result.outcome.terminalCapability;
}

function physicalExecution(
  issuer: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
) {
  return issueQualifiedPhysicalExecutionPort({
    issuer,
    capability,
    schedulerRuntime: issueQualifiedSharedSchedulerRuntimePort({ scheduler: new WorkScheduler(), issuer, capability }),
    execute: async () => ({ kind: "returned" as const, requestId: h("request"), dataHex: "0x01" }),
  });
}
test("verified runtime release authority is opaque, resolver-owned, and revocable", () => {
  const value = issued(); assert.deepEqual(Reflect.ownKeys(value.authority.capability), []);
  assert.deepEqual(value.authority.resolver.resolve(value.authority.capability), value.binding);
  assert.throws(() => value.authority.resolver.resolve({ ...value.authority.capability }), /not issued/);
  value.authority.revoke(); assert.throws(() => value.authority.resolver.resolve(value.authority.capability), /revoked/);
});
test("ready binding consumer exposes three narrow current facts and fences clone, rotation, and revoke", () => {
  const value = issued();
  const port = assertIssuedRuntimeReleaseReadyBindingPort(value.authority.readyGeneration);
  assert.deepEqual(Object.keys(port), [
    "currentProvenanceHash",
    "currentBindingId",
    "currentImplementationCommit",
  ]);
  assert.equal(port.currentProvenanceHash(), runtimeReleaseBindingProvenanceHash(value.binding));
  assert.equal(port.currentBindingId(), value.binding.bindingId);
  assert.equal(port.currentImplementationCommit(), value.binding.candidateReleaseCommit);
  assert.throws(
    () => assertIssuedRuntimeReleaseReadyBindingPort({ ...port }),
    /not release-issued/,
  );
  value.authority.rotate(value.binding);
  assert.throws(() => port.currentProvenanceHash(), /stale after rotation/);
  assert.throws(() => port.currentBindingId(), /stale after rotation/);
  assert.throws(() => port.currentImplementationCommit(), /stale after rotation/);

  const revoked = issued();
  const revokedPort = assertIssuedRuntimeReleaseReadyBindingPort(revoked.authority.readyGeneration);
  revoked.authority.revoke();
  assert.throws(() => revokedPort.currentProvenanceHash(), /revoked/);
  assert.throws(() => revokedPort.currentBindingId(), /revoked/);
  assert.throws(() => revokedPort.currentImplementationCommit(), /revoked/);
});
test("wrong deployment pin and self-consistent unknown signature cannot issue authority", () => {
  const value = issued(); const other = generateKeyPairSync("ed25519");
  assert.throws(() => verifyAndIssueRuntimeReleaseAuthorityV1(value.binding, { signerKeyId: value.signerKeyId, publicKeyHex: rawKey(other.publicKey) }), /signature invalid/);
  assert.throws(() => verifyAndIssueRuntimeReleaseAuthorityV1(value.binding, { signerKeyId: h("other"), publicKeyHex: rawKey(value.keys.publicKey) }), /pin mismatch/);
});

test("full-family terminal binding accepts only a final Producer head/durable-window join and is rotation-fenced", async () => {
  const value = issued();
  const provenance = runtimeReleaseBindingProvenanceHash(value.binding);
  const service = issueRuntimeReleaseFullFamilyTerminalBindingServiceV1(
    value.authority,
    createReleaseFamilyRuntimeComposition,
  );
  const terminal = await terminalForRelease(provenance, "current");
  assert.deepEqual(Object.keys(service), ["bindFinalHead"]);
  assert.throws(
    () => service.bindFinalHead({ headTerminal: terminal as never, finalDurableWindow: Object.freeze({}), startup: Object.freeze({}) as never }),
    /not owner-issued|not issued/,
  );
  assert.throws(
    () => service.bindFinalHead({ headTerminal: { ...terminal } as never, finalDurableWindow: Object.freeze({}), startup: Object.freeze({}) as never }),
    /not owner-issued|not issued/,
  );

  value.authority.rotate(value.binding);
  assert.throws(
    () => service.bindFinalHead({ headTerminal: terminal as never, finalDurableWindow: Object.freeze({}), startup: Object.freeze({}) as never }),
    /stale|rotation/,
  );
});

const discoveryDeployment = Object.freeze({
  profile: "reth-json-rpc-v1" as const,
  endpoint: "http://127.0.0.1:8545",
  chainId: "1",
  providerIdentity: "reth-mainnet",
  backendEpoch: "reth-backend-1",
});

test("qualified discovery source is opaque, exact release-bound and backend-sensitive", () => {
  assert.equal("issueRuntimeReleaseQualifiedDiscoverySourcePort" in runtimeReleasePublic, false);
  assert.equal("readRuntimeReleaseQualifiedDiscoverySourcePort" in runtimeReleasePublic, false);
  const first = issued();
  const port = issueRuntimeReleaseQualifiedDiscoverySourcePort(first.authority, discoveryDeployment);
  assert.deepEqual(Reflect.ownKeys(port), []);
  const source = readRuntimeReleaseQualifiedDiscoverySourcePort(first.authority, port);
  assert.equal(source.provider.provider, "reth-mainnet");
  assert.equal(source.provider.backendEpoch, "reth-backend-1");
  assert.equal(source.qualification.qualificationRoot, h("discovery-source-qualification"));
  assert.notEqual(source.sourceAuthorityRoot, first.binding.bindingId);
  assert.throws(
    () => readRuntimeReleaseQualifiedDiscoverySourcePort(first.authority, { ...port }),
    /not owner-issued/,
  );
  const second = issued();
  assert.throws(
    () => readRuntimeReleaseQualifiedDiscoverySourcePort(second.authority, port),
    /not owner-issued/,
  );
  assert.throws(
    () => issueRuntimeReleaseQualifiedDiscoverySourcePort(first.authority, {
      ...discoveryDeployment,
      backendEpoch: "reth-backend-2",
    }),
    /does not match signed runtime qualification/,
  );
  assert.throws(
    () => issueRuntimeReleaseQualifiedDiscoverySourcePort(first.authority, {
      ...discoveryDeployment,
      providerIdentity: "reth-foreign",
    }),
    /does not match signed runtime qualification/,
  );
  assert.throws(
    () => issueRuntimeReleaseQualifiedDiscoverySourcePort(first.authority, {
      ...discoveryDeployment,
      endpoint: "http://127.0.0.1:9545",
    }),
    /does not match signed runtime qualification/,
  );
  assert.throws(
    () => issueRuntimeReleaseQualifiedDiscoverySourcePort(null, discoveryDeployment),
    /not issued/,
  );
  let getterCalls = 0;
  const accessor = { ...discoveryDeployment } as Record<string, unknown>;
  Object.defineProperty(accessor, "backendEpoch", {
    enumerable: true,
    get() { getterCalls += 1; return "reth-backend-1"; },
  });
  assert.throws(
    () => issueRuntimeReleaseQualifiedDiscoverySourcePort(first.authority, accessor as never),
    /own data property|accessor/,
  );
  assert.equal(getterCalls, 0);
});

test("qualified discovery source is fenced on release rotation and revoke", () => {
  const value = issued();
  const port = issueRuntimeReleaseQualifiedDiscoverySourcePort(value.authority, discoveryDeployment);
  value.authority.rotate(value.binding);
  assert.throws(
    () => readRuntimeReleaseQualifiedDiscoverySourcePort(value.authority, port),
    /stale after rotation/,
  );
  const next = issued();
  const nextPort = issueRuntimeReleaseQualifiedDiscoverySourcePort(next.authority, discoveryDeployment);
  next.authority.revoke();
  assert.throws(
    () => readRuntimeReleaseQualifiedDiscoverySourcePort(next.authority, nextPort),
    /revoked/,
  );
});

test("discovery source authority survives exact endpoint migration but changes on backend rotation", () => {
  const first = issued();
  const firstSource = readRuntimeReleaseQualifiedDiscoverySourcePort(
    first.authority,
    issueRuntimeReleaseQualifiedDiscoverySourcePort(first.authority, discoveryDeployment),
  );
  const unrelated = issued({
    ...payload,
    releaseAcceptanceRequirementSetRoot: h("unrelated-acceptance-requirements"),
  });
  const unrelatedSource = readRuntimeReleaseQualifiedDiscoverySourcePort(
    unrelated.authority,
    issueRuntimeReleaseQualifiedDiscoverySourcePort(unrelated.authority, discoveryDeployment),
  );
  assert.notEqual(first.binding.bindingId, unrelated.binding.bindingId);
  assert.equal(firstSource.sourceAuthorityRoot, unrelatedSource.sourceAuthorityRoot);

  const migratedEndpoint = "http://127.0.0.1:9545";
  const migrated = issued({
    ...payload,
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-1",
      profile: "reth-json-rpc-v1",
      chainId: "1",
      endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1(migratedEndpoint),
      qualificationRoot: h("discovery-source-qualification"),
    }),
  });
  assert.throws(
    () => issueRuntimeReleaseQualifiedDiscoverySourcePort(migrated.authority, discoveryDeployment),
    /does not match signed runtime qualification/,
  );
  const migratedSource = readRuntimeReleaseQualifiedDiscoverySourcePort(
    migrated.authority,
    issueRuntimeReleaseQualifiedDiscoverySourcePort(migrated.authority, {
      ...discoveryDeployment,
      endpoint: migratedEndpoint,
    }),
  );
  assert.notEqual(first.binding.bindingId, migrated.binding.bindingId);
  assert.equal(firstSource.qualification.sourceConfigRoot, migratedSource.qualification.sourceConfigRoot);
  assert.equal(firstSource.sourceAuthorityRoot, migratedSource.sourceAuthorityRoot);

  const rotated = issued({
    ...payload,
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-2",
      profile: "reth-json-rpc-v1",
      chainId: "1",
      endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1(discoveryDeployment.endpoint),
      qualificationRoot: h("discovery-source-qualification-2"),
    }),
  });
  const rotatedSource = readRuntimeReleaseQualifiedDiscoverySourcePort(
    rotated.authority,
    issueRuntimeReleaseQualifiedDiscoverySourcePort(rotated.authority, {
      ...discoveryDeployment,
      backendEpoch: "reth-backend-2",
    }),
  );
  assert.notEqual(firstSource.sourceAuthorityRoot, rotatedSource.sourceAuthorityRoot);
});

function strategyFactoryFor(value: ReturnType<typeof issued>) {
  const catalogEntry = compileStrategy(ROUTE_CYCLE_STRATEGY, []).entry;
  const issuerClosureRoot = h("strategy-issuer-closure");
  const planningTemplateHash = strategyPlanningTemplateHash(catalogEntry.planningTemplate);
  const entry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
    catalogEntry,
    issuerModulePath: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.modulePath,
    issuerExportName: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.exportName,
    issuerClosureRoot,
    planningTemplateHash,
    leafDigest: hashDomain("aloha/generated-strategy-runtime-leaf/v1", {
      strategyId: catalogEntry.strategyId,
      strategyDefinitionHash: catalogEntry.strategyDefinitionHash,
      definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
      issuerModulePath: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.modulePath,
      issuerExportName: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.exportName,
      issuerClosureRoot,
      planningTemplateHash,
    }),
  });
  const descriptor = sealGeneratedStrategyRuntimeDescriptor({
    schemaVersion: 1,
    releaseIntentRoot: h("strategy-release"),
    definitionCatalogRoot: h("strategy-catalog"),
    proposedCapabilitySetRoot: value.binding.qualifiedCapabilityRefsRoot,
    strategies: [entry],
  });
  return createGeneratedStrategyRuntimeFactory({ descriptor, issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER] });
}

function strategyPlanningFixture(value: ReturnType<typeof issued>) {
  const head = Object.freeze({
    chainId: "1",
    number: "100",
    hash: h("strategy-head"),
    parentHash: h("strategy-parent"),
    stateRoot: h("strategy-state"),
  });
  const edges: readonly StrategyGraphEdgeV1[] = Object.freeze([Object.freeze({
    edgeId: h("strategy-edge"),
    opaqueTransitionRef: h("strategy-transition"),
    inputAssetPorts: Object.freeze([Object.freeze({ assetRef: h("strategy-input-asset"), portRef: h("strategy-input-port"), ordinal: "0" })]),
    outputAssetPorts: Object.freeze([Object.freeze({ assetRef: h("strategy-output-asset"), portRef: h("strategy-output-port"), ordinal: "0" })]),
  })]);
  const binding: StrategyGraphBindingV1 = Object.freeze({
    generationId: "strategy-generation",
    definitionCatalogRoot: h("strategy-catalog"),
    graphRoot: h("strategy-graph"),
    readyRecordHash: h("strategy-ready"),
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(value.binding),
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(
      createSignedReleaseRuntimeAuthorityDescriptorV1({
        authorityClass: "signed-release",
        runtimeBindingId: value.binding.bindingId,
        releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(value.binding),
        implementationCommit: value.binding.candidateReleaseCommit,
      }),
    ),
    sourceHash: head.hash,
  });
  const ingress = issueProducerIngressTriggerV1({
    lane: "blockscan",
    head,
    triggerRef: h("strategy-trigger"),
    txHash: null,
    correlationId: h("strategy-correlation"),
    affectedEdgeIds: Object.freeze([]),
    pendingEvidenceHash: null,
  });
  const session = {
    head,
    generationId: binding.generationId,
    lease: { binding: { graphRoot: binding.graphRoot }, edges },
  };
  const trigger = issueProducerBoundTriggerV1({
    ingress,
    laneInput: {
      kind: "blockscan",
      session,
      head,
      revision: "0",
      generationId: binding.generationId,
      graphRoot: binding.graphRoot,
      input: Object.freeze({}),
      signal: new AbortController().signal,
    } as never,
  });
  return Object.freeze({
    binding,
    edges,
    trigger,
    expectedLane: "blockscan" as const,
    objectiveRef: h("strategy-objective"),
    entryAssetRef: h("strategy-entry-asset"),
    returnAssetRef: h("strategy-entry-asset"),
    expectedCorrelationId: h("strategy-correlation"),
    expectedHeadHash: head.hash,
  });
}

test("runtime-release Strategy service is generated, release-bound, and rotation-fenced", () => {
  const value = issued();
  const service = issueRuntimeReleaseStrategyRuntimeService(value.authority, strategyFactoryFor(value));
  assert.doesNotThrow(() => assertIssuedRuntimeReleaseStrategyRuntimeService(service));
  const metadata = service.readMetadata();
  assert.equal(metadata.releaseProvenanceHash, runtimeReleaseBindingProvenanceHash(value.binding));
  const evidenceExpectation = service.readEvidenceExpectation();
  assert.equal(evidenceExpectation.releaseProvenanceHash, metadata.releaseProvenanceHash);
  assert.equal(evidenceExpectation.definitionCatalogRoot, metadata.definitionCatalogRoot);
  assert.equal(evidenceExpectation.strategyCompositionRoot, metadata.compositionRoot);
  assert.equal(evidenceExpectation.entries.length, 1);
  assert.equal(evidenceExpectation.entries[0]!.catalogEntry.strategyId, ROUTE_CYCLE_STRATEGY.strategyId);
  assert.deepEqual(
    evidenceExpectation.entries[0]!.catalogEntry.planningTemplate,
    ROUTE_CYCLE_STRATEGY.planningTemplate,
  );
  const request = strategyPlanningFixture(value);
  const planning = service.issuePlanningProblem(request);
  assert.equal(planning.strategyCompositionRoot, metadata.compositionRoot);
  assert.equal(planning.planningProblem.objectiveRef, request.objectiveRef);
  assert.equal(planning.planningProblem.triggerCorrelationId, request.expectedCorrelationId);
  assert.equal(planning.planningProblem.triggerHeadHash, request.expectedHeadHash);
  assert.equal(planning.planningProblem.graphRoot, request.binding.graphRoot);
  assert.throws(() => assertIssuedRuntimeReleaseStrategyRuntimeService({ ...service }), /not owner-issued/);
  assert.throws(() => issueRuntimeReleaseStrategyRuntimeService(value.authority, (() => ({})) as never), /not generated/);
  assert.throws(() => service.issuePlanningProblem({ ...request, trigger: { ...request.trigger } as never }), /producer bound trigger is not owner-issued/);
  assert.throws(() => service.issuePlanningProblem({ ...request, expectedCorrelationId: h("wrong-correlation") }), /correlation mismatch/);
  assert.throws(() => service.issuePlanningProblem({ ...request, expectedHeadHash: h("wrong-head") }), /head mismatch/);
  assert.throws(() => service.issuePlanningProblem({
    ...request,
    binding: { ...request.binding, graphRoot: h("wrong-graph") },
  }), /Graph mismatch/);
  value.authority.rotate(value.binding);
  assert.throws(() => service.readMetadata(), /stale|rotation/);
  assert.throws(() => service.readEvidenceExpectation(), /stale|rotation/);
  assert.throws(() => service.issuePlanningProblem(request), /stale|rotation/);
  value.authority.revoke();
  assert.throws(() => service.readMetadata(), /revoked/);
});

test("unsigned Strategy owner exposes generated membership without release provenance", () => {
  const value = issued();
  const descriptor = createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "unsigned-dry-run",
    runtimeBindingId: h("unsigned-strategy-runtime-binding"),
    implementationCommit: value.binding.candidateReleaseCommit,
  });
  let current = true;
  const service = issueUnsignedDryRunStrategyRuntimeService({
    runtimeAuthority: descriptor,
    factory: strategyFactoryFor(value),
    assertCurrent() {
      if (!current) throw new TypeError("unsigned Strategy runtime rotated");
    },
  });
  assert.doesNotThrow(() => assertIssuedUnsignedDryRunStrategyRuntimeService(service));
  const metadata = service.readMetadata();
  const expectation = service.readEvidenceExpectation();
  assert.equal(metadata.runtimeMembershipHash, expectation.runtimeMembershipHash);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, "releaseProvenanceHash"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(expectation, "releaseProvenanceHash"), false);
  current = false;
  assert.throws(() => service.readMetadata(), /rotated/);
  assert.throws(() => assertIssuedUnsignedDryRunStrategyRuntimeService(service), /rotated/);
});

function releaseProjection(binding: ReturnType<typeof issued>["binding"]) {
  return Object.freeze({
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    releaseAuthorityRoot: binding.releaseAuthorityRoot,
    candidatePartitionProofIssuerKeyId: binding.candidatePartitionProofIssuerKeyId,
  });
}

test("candidate-partition consumer receives only a release projection and is fenced on rotation/revoke", () => {
  const value = issued();
  const projection = releaseProjection(value.binding);
  const implementation = issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: () => projection,
    issue: () => { throw new Error("test issuer not called"); },
    verify: () => { throw new Error("test verifier not called"); },
  }) as unknown as CandidatePartitionProofIssuerPortV1);
  const consumer = issueRuntimeReleaseCandidatePartitionProofIssuer(
    value.authority,
    implementation,
    nominationVerifierFor(value),
  );
  assert.deepEqual(consumer.currentRelease(), projection);
  assert.deepEqual(Reflect.ownKeys(consumer.currentRelease()), ["releaseProvenanceHash", "releaseAuthorityRoot", "candidatePartitionProofIssuerKeyId"]);
  assert.throws(
    () => issueRuntimeReleaseCandidatePartitionProofIssuer(value.authority, { ...implementation }, nominationVerifierFor(value)),
    /not release-issued/,
  );
  value.authority.rotate(value.binding);
  assert.throws(() => consumer.currentRelease(), /stale|rotation/);
  const next = issued();
  const nextConsumer = issueRuntimeReleaseCandidatePartitionProofIssuer(next.authority, issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: () => releaseProjection(next.binding),
    issue: () => { throw new Error("test issuer not called"); },
    verify: () => { throw new Error("test verifier not called"); },
  }) as unknown as CandidatePartitionProofIssuerPortV1), nominationVerifierFor(next));
  next.authority.revoke();
  assert.throws(() => nextConsumer.currentRelease(), /revoked/);
});

test("scheduler consumer binds registry, selected worker, session, and rejects foreign capabilities", () => {
  const value = issued();
  const worker = {
    workerEpoch: value.binding.workerEpoch,
    ...value.binding.selectedExecutor,
  };
  const capability = Object.freeze(Object.create(null));
  const implementation = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: value.binding.qualifiedExecutorRegistryRoot,
    authorityRoot: value.binding.executorAuthorityRoot,
    open: ({ worker: supplied }: { readonly worker: typeof worker }) => {
      const { workerEpoch: _suppliedEpoch, ...suppliedExecutor } = supplied;
      const { workerEpoch: _expectedEpoch, ...expectedExecutor } = worker;
      if (JSON.stringify(suppliedExecutor) !== JSON.stringify(expectedExecutor) || supplied.workerEpoch.length === 0) {
        throw new Error("worker mismatch");
      }
      return capability;
    },
    rotate: () => capability,
    revoke: () => undefined,
    assert: (supplied: object) => {
      if (supplied !== capability) throw new Error("unknown capability");
      return { authorityRoot: value.binding.executorAuthorityRoot, workerEpoch: value.binding.workerEpoch, executorSession: value.binding.executorSessionHash, version: 1 };
    },
    provenance: (supplied: object) => {
      if (supplied !== capability) throw new Error("unknown capability");
      return { authorityRoot: value.binding.executorAuthorityRoot, workerEpoch: value.binding.workerEpoch, executorSession: value.binding.executorSessionHash, version: 1 };
    },
  }));
  const consumer = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(value.authority, implementation);
  assert.deepEqual(consumer.provenance(capability), {
    authorityRoot: value.binding.executorAuthorityRoot,
    workerEpoch: value.binding.workerEpoch,
    executorSession: value.binding.executorSessionHash,
    version: 1,
  });
  assert.throws(() => consumer.provenance({ ...capability }), /unknown|not issued/);
  assert.throws(() => consumer.open({ worker: { ...worker, executableFingerprint: h("foreign-executable") } }), /selected runtime executor/);
  value.authority.rotate(value.binding);
  assert.throws(() => consumer.provenance(capability), /stale|rotation/);
});

function schedulerImplementation(value: ReturnType<typeof issued>) {
  const capability = Object.freeze(Object.create(null));
  const worker = { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor };
  const implementation = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: value.binding.qualifiedExecutorRegistryRoot,
    authorityRoot: value.binding.executorAuthorityRoot,
    open: () => capability,
    rotate: () => capability,
    revoke: () => undefined,
    assert: (supplied: object) => {
      if (supplied !== capability) throw new Error("unknown capability");
      return { authorityRoot: value.binding.executorAuthorityRoot, workerEpoch: worker.workerEpoch, executorSession: value.binding.executorSessionHash, version: 1 };
    },
    provenance: (supplied: object) => {
      if (supplied !== capability) throw new Error("unknown capability");
      return { authorityRoot: value.binding.executorAuthorityRoot, workerEpoch: worker.workerEpoch, executorSession: value.binding.executorSessionHash, version: 1 };
    },
  }));
  return implementation;
}

/** Test-only external Scheduler issuer: the runtime owner remains the real authority under test. */
function revmSchedulerImplementation(value: ReturnType<typeof issued>) {
  const worker = { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor };
  let sequence = 0;
  const states = new WeakMap<object, { readonly workerEpoch: string; readonly executorSession: Hash }>();
  const issue = (workerEpoch = worker.workerEpoch): QualifiedExecutorAuthorityCapability => {
    const capability = Object.freeze(Object.create(null)) as QualifiedExecutorAuthorityCapability;
    sequence += 1;
    states.set(capability, {
      workerEpoch,
      executorSession: h(`revm-worker-session:${sequence}`),
    });
    return capability;
  };
  const provenance = (capability: QualifiedExecutorAuthorityCapability) => {
    const state = states.get(capability);
    if (!state) throw new Error("unknown scheduler capability");
    return {
      authorityRoot: value.binding.executorAuthorityRoot,
      workerEpoch: state.workerEpoch,
      executorSession: state.executorSession,
      version: 1,
    };
  };
  return issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: value.binding.qualifiedExecutorRegistryRoot,
    authorityRoot: value.binding.executorAuthorityRoot,
    open: ({ worker: supplied }: { readonly worker: typeof worker }) => {
      const { workerEpoch: _suppliedEpoch, ...suppliedExecutor } = supplied;
      const { workerEpoch: _expectedEpoch, ...expectedExecutor } = worker;
      if (JSON.stringify(suppliedExecutor) !== JSON.stringify(expectedExecutor) || supplied.workerEpoch.length === 0) {
        throw new Error("worker mismatch");
      }
      return issue(supplied.workerEpoch);
    },
    rotate: (input: Parameters<QualifiedExecutorAuthorityIssuer["rotate"]>[0]) => issue(
      typeof input === "object" && input !== null && "worker" in input ? input.worker.workerEpoch : undefined,
    ),
    revoke: () => undefined,
    assert: provenance,
    provenance,
  }));
}

function candidateImplementation(value: ReturnType<typeof issued>) {
  const projection = releaseProjection(value.binding);
  return issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: () => projection,
    issue: () => { throw new Error("not exercised"); },
    verify: () => { throw new Error("not exercised"); },
  }) as unknown as CandidatePartitionProofIssuerPortV1);
}

function nominationVerifierFor(value: ReturnType<typeof issued>) {
  const capability = Object.freeze(Object.create(null)) as QualifiedExecutorAuthorityCapability;
  const provenance = Object.freeze({
    authorityRoot: value.binding.executorAuthorityRoot,
    workerEpoch: value.binding.workerEpoch,
    executorSession: value.binding.executorSessionHash,
    version: 1,
  });
  const issuer = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: value.binding.qualifiedExecutorRegistryRoot,
    authorityRoot: value.binding.executorAuthorityRoot,
    open: () => capability,
    rotate: () => capability,
    revoke: () => undefined,
    assert: (supplied: object) => {
      if (supplied !== capability) throw new TypeError("unknown executor capability");
      return provenance;
    },
    provenance: (supplied: object) => {
      if (supplied !== capability) throw new TypeError("unknown executor capability");
      return provenance;
    },
  }));
  const familyExecution = createSchedulerOwnedFamilyExecutionPort({
    issuer,
    capability,
    physicalExecution: physicalExecution(issuer, capability),
  });
  const familyCapability = issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
    value.authority,
    familyExecution,
    createReleaseFamilyRuntimeComposition,
  );
  return issueRuntimeReleaseNominationQualificationVerifier(
    value.authority,
    createReleaseFamilyRuntimeComposition,
    familyCapability,
  );
}

const deploymentProofPort = () => issueDeploymentAttestationProofPort(Object.freeze({
  issueIdentity: (input: unknown) => input,
  verifyIdentity: (input: unknown) => input,
  issueOutcome: (input: unknown) => input,
  verifyOutcome: (input: unknown) => input,
}));

test("REVM owner issues exact release leases with fresh worker sessions and rejects foreign/cloned inputs", () => {
  const value = issued();
  const implementation = revmSchedulerImplementation(value);
  const scheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(value.authority, implementation);
  const worker = { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor };
  const capabilityA = scheduler.open({ worker });
  const leaseA = issueRuntimeReleaseExecutorLeaseV1(value.authority, scheduler, capabilityA);
  const owner = issueRuntimeReleaseRevmWorkerAuthorityIssuer(value.authority, scheduler);
  const bindingA = owner.issue();
  const bindingB = owner.issue();

  assert.equal(bindingA.authorityRoot, value.binding.executorAuthorityRoot);
  assert.ok(bindingA.workerEpoch.startsWith(`${value.binding.workerEpoch}/`));
  assert.ok(bindingB.workerEpoch.startsWith(`${value.binding.workerEpoch}/`));
  assert.notEqual(bindingA.workerEpoch, bindingB.workerEpoch);
  assert.equal(bindingA.release.bindingId, value.binding.bindingId);
  assert.equal(bindingA.release.releaseProvenanceHash, runtimeReleaseBindingProvenanceHash(value.binding));
  assert.notEqual(bindingA.executorSessionHash, bindingB.executorSessionHash);
  assert.equal(leaseA.workerEpoch, value.binding.workerEpoch);
  assert.notEqual(leaseA.executorSessionHash, bindingA.executorSessionHash);
  owner.assertCurrent(bindingA);
  owner.assertCurrent(bindingB);

  assert.throws(
    () => issueRuntimeReleaseRevmWorkerAuthorityIssuer(value.authority, { ...scheduler }),
    /not release-issued/,
  );
  assert.throws(
    () => issueRuntimeReleaseExecutorLeaseV1(value.authority, scheduler, { ...capabilityA }),
    /unknown|not issued|stale|revoked/,
  );
  assert.throws(
    () => issueRuntimeReleaseExecutorLeaseV1(value.authority, scheduler, Object.freeze(Object.create(null))),
    /unknown|not issued|stale|revoked/,
  );
  assert.throws(
    () => owner.assertCurrent({ ...bindingA, workerEpoch: "foreign-epoch" } as RevmWorkerAuthorityBindingV1),
    /stale|issued|mismatch/,
  );
});

test("REVM owner rejects a scheduler from another release and fences replacement after rotation/revoke", () => {
  const value = issued();
  const foreign = issued();
  const foreignScheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(
    foreign.authority,
    revmSchedulerImplementation(foreign),
  );
  assert.throws(
    () => issueRuntimeReleaseRevmWorkerAuthorityIssuer(value.authority, foreignScheduler),
    /runtime release|match|bound/,
  );

  const scheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(value.authority, revmSchedulerImplementation(value));
  const owner = issueRuntimeReleaseRevmWorkerAuthorityIssuer(value.authority, scheduler);
  const binding = owner.issue();
  value.authority.rotate(value.binding);
  assert.throws(() => owner.issue(), /stale|rotation/);
  assert.throws(() => owner.assertCurrent(binding), /stale|rotation/);

  const revoked = issued();
  const revokedScheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(revoked.authority, revmSchedulerImplementation(revoked));
  const revokedOwner = issueRuntimeReleaseRevmWorkerAuthorityIssuer(revoked.authority, revokedScheduler);
  const revokedBinding = revokedOwner.issue();
  revoked.authority.revoke();
  assert.throws(() => revokedOwner.issue(), /revoked/);
  assert.throws(() => revokedOwner.assertCurrent(revokedBinding), /revoked/);
});

test("same-bundle deployment infrastructure issues real scheduler and REVM brands", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-deployment-runtime-"));
  try {
    const executablePath = join(realpathSync(directory), "aloha-revm-worker");
    const executableBytes = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
    writeFileSync(executablePath, executableBytes);
    chmodSync(executablePath, 0o755);
    const executableFingerprint = sha256Hex(executableBytes);
    const selectedExecutor = Object.freeze({ ...executor, executableFingerprint });
    const value = issued({
      ...payload,
      qualifiedExecutorRegistry: [selectedExecutor],
      qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([selectedExecutor]),
      selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(selectedExecutor),
      selectedExecutor,
    });
    const request = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.deployment-runtime-infrastructure" as const,
      revmWorkerExecutablePath: executablePath,
      revmWorkerExecutableSha256: executableFingerprint,
      externalProofSigner: Object.freeze({
        schemaVersion: 1 as const,
        kind: "aloha.external-proof-signer" as const,
        executablePath,
        executableSha256: executableFingerprint,
        attestationPublicKeyHex: `0x${"11".repeat(32)}` as const,
        candidatePartitionPublicKeyHex: `0x${"22".repeat(32)}` as const,
        nominationQualifications: Object.freeze(value.binding.nominationQualificationSet.entries
          .map((entry, index) => Object.freeze({
            sourcePlanIdentity: h(`deployment-source-plan:${index}`),
            sourcePlanLeafDigest: h(`deployment-source-plan-leaf:${index}`),
            nominationProgramRoot: h(`deployment-nomination-program:${index}`),
            nominationProgramProposalLeafDigest: entry.proposalLeafDigest,
            qualificationLeafDigest: entry.qualificationLeafDigest,
          }))
          .sort((left, right) => left.nominationProgramProposalLeafDigest.localeCompare(right.nominationProgramProposalLeafDigest))),
      }),
    });
    const capability = issueDeploymentRuntimeInfrastructureV1({ binding: value.binding, request });
    const infrastructure = readDeploymentRuntimeInfrastructureV1(capability, value.binding);
    const provenance = infrastructure.scheduler.issuer.provenance(infrastructure.scheduler.capability);
    assert.equal(provenance.authorityRoot, value.binding.executorAuthorityRoot);
    assert.equal(provenance.workerEpoch, value.binding.workerEpoch);
    assert.equal(provenance.executorSession, value.binding.executorSessionHash);
    assert.equal(
      infrastructure.scheduler.issuer.open({
        worker: { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor },
      }),
      infrastructure.scheduler.capability,
    );
    assert.equal(
      readIssuedRevmWorkerDeploymentPort(infrastructure.revmDeployment).qualification.executableFingerprint,
      executableFingerprint,
    );

    assert.throws(
      () => readDeploymentRuntimeInfrastructureV1({ ...capability }, value.binding),
      /not issued/,
    );
    assert.throws(
      () => readIssuedRevmWorkerDeploymentPort({ ...infrastructure.revmDeployment }),
      /not deployment-issued/,
    );
    assert.throws(
      () => infrastructure.scheduler.issuer.provenance({ ...infrastructure.scheduler.capability }),
      /not issued/,
    );
    const foreign = issued({
      ...payload,
      qualifiedExecutorRegistry: [selectedExecutor],
      qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([selectedExecutor]),
      selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(selectedExecutor),
      selectedExecutor,
      executorSessionHash: h("foreign-deployment-session"),
    });
    assert.throws(
      () => readDeploymentRuntimeInfrastructureV1(capability, foreign.binding),
      /release identity mismatch/,
    );
    assert.throws(
      () => issueDeploymentRuntimeInfrastructureV1({
        binding: value.binding,
        request: { ...request, revmWorkerExecutableSha256: h("wrong-worker-bytes") },
      }),
      /does not join/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
