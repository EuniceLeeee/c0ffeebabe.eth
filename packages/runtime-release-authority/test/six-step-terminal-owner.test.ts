import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  createRuntimeReleaseBindingV1,
  createRuntimeReleaseDiscoverySourceQualificationV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  runtimeReleaseBindingProvenanceHash,
  runtimeReleaseBindingSigningBytes,
  sealRuntimeReleaseNominationQualificationSetV1,
  type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import { verifyAndIssueRuntimeReleaseAuthorityV1 } from "../src/index.ts";
import {
  issueRuntimeReleaseSixStepTerminalBindingServiceV1,
} from "../src/internal/six-step-terminal-owner.ts";
import {
  readRuntimeReleaseSixStepTerminalBindingV1,
} from "../src/six-step-terminal-consumer.ts";
import {
  issueRuntimeReleaseStrategyRuntimeService,
} from "../src/internal/strategy-runtime-owner.ts";
import {
  createGeneratedStrategyRuntimeFactory,
} from "../../strategy-composition/src/internal/generated-runtime-composition.ts";
import {
  readGeneratedFamilyRuntimeFactoryMetadata,
} from "../../family-composition/src/internal/generated-runtime-composition.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../generated/runtime-composition/index.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
} from "../../scheduler/src/index.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../scheduler/src/internal/authority-owner.ts";
import { issueQualifiedSharedSchedulerRuntimePort } from "../../scheduler/src/internal/shared-runtime-owner.ts";
import {
  createSchedulerOwnedFamilyExecutionPort,
  issueQualifiedPhysicalExecutionPort,
} from "../../work-plane/src/internal/family-execution-port.ts";
import {
  sealGeneratedStrategyRuntimeDescriptor,
  strategyPlanningTemplateHash,
  type GeneratedStrategyRuntimeEntryV1,
} from "../../strategy-composition/src/index.ts";
import { compileStrategy } from "../../strategy-sdk/src/index.ts";
import {
  ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
  ROUTE_CYCLE_STRATEGY,
} from "../../../strategies/route-cycle/src/index.ts";
import { createSearchTerminalFixture } from "../../producer/test/fixtures/search-terminal.ts";
import { issueProducerIngressSourceForTestV1 } from "../../producer/test/fixtures/ingress-source.ts";
import { issueProducerIngressPortV1 } from "../../producer/src/internal/owners.ts";
import type { CanonicalHead } from "../../producer/src/index.ts";
import {
  readIssuedSearchTerminalSixStepTraceV1,
  type SearchTerminalCapabilityV1,
} from "../../search-pipeline/src/index.ts";
import { erc20AssetReferenceV1 } from "../../asset-ref/src/index.ts";
import {
  economicSafetyObjectivePolicyRootV1,
  encodeEconomicSafetyObjectiveTemplatesV1,
} from "../../economics-safety/src/index.ts";
import {
  issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1,
  issueRuntimeReleaseEconomicSafetyServiceV1,
} from "../src/internal/economic-safety-owner.ts";
import {
  issueRuntimeReleaseFamilyRuntimeAuthorityCapability,
} from "../src/internal/family-runtime-owner.ts";

const h = (value: unknown): Hash => hashDomain("test/runtime-release-six-step/v1", value);
const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1("six-step-terminal-owner");
const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1("six-step-terminal-owner");
const NATIVE_EQUIVALENT_VALUATION_OWNER_REF_V1 = valuationQualification.registry.entries[0]!.ownerRef;
const pipelineHash = (domain: string, value: unknown): Hash => hashDomain(domain, value);
const executor = Object.freeze({
  executorKind: "revm",
  engineBuildFingerprint: h("engine"),
  executableFingerprint: h("executable"),
  closureFingerprint: h("closure"),
  protocolFingerprint: h("protocol"),
  schemaFingerprint: h("schema"),
  releaseRoleManifestRoot: h("manifest"),
  candidateCommit: "3".repeat(40),
});
const FAMILY_RUNTIME_METADATA = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
const nominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1(
  FAMILY_RUNTIME_METADATA.nominationProgramProposalLeafDigests.map(proposalLeafDigest => ({
  proposalLeafDigest,
  criticalMutationCorpusRoot: h("nomination-mutations"),
  independentOracleCaseRoot: h("nomination-oracle"),
  qualificationSpecDigest: h("nomination-spec"),
  verifierQualificationCertificateRoot: h("nomination-certificate"),
  })),
);
const TEST_STRATEGY_CAPABILITY_ROOT = FAMILY_RUNTIME_METADATA.proposedCapabilitySetRoot;

function payload(): RuntimeReleaseBindingPayloadV1 {
  return {
    schemaVersion: 1,
    kind: "aloha.runtime-release-binding",
    releaseAuthorityApprovalId: h("approval"),
    releaseAuthorityApprovalPayloadHash: h("approval-payload"),
    releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"),
    externalTrustAnchorRoot: h("trust-anchor"),
    externalIssuerKeySetRoot: h("issuer-keys"),
    qualificationRegistryApprovalId: h("registry-approval"),
    qualificationRegistryRoot: h("registry"),
    qualificationEpoch: "1",
    qualificationAudienceHash: h("audience"),
    predicateCompositionRootDigest: h("predicate-composition"),
    gateCoreRuntimeClosureDigest: h("gate-runtime"),
    gateCoreImplementationClosureDigest: h("gate-core"),
    searcherRuntime: {
      runtimeArtifactRoot: h("searcher-artifact"),
      implementationClosureDigest: h("searcher-closure"),
      nodeExecutableSha256: h("node"),
      entrypointSha256: h("entrypoint"),
      bundleModulePath: "/etc/aloha/deployment-bundle.mjs",
      bundleModuleSha256: h("bundle"),
    },
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-1",
      profile: "reth-json-rpc-v1",
      chainId: "1",
      endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"),
      qualificationRoot: h("source-qualification"),
    }),
    qualifiedExecutorRegistry: [executor],
    qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([executor]),
    valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
    valuationOwnerQualificationCertificates: valuationQualification.certificates,
    qualifiedValuationOwnerSetRoot: valuationQualification.root,
    actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
    actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
    qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
    safetyProfile: actionOwnerQualification.profile,
    safetyProfileRoot: actionOwnerQualification.profileRoot,
    qualifiedCapabilityRefsRoot: TEST_STRATEGY_CAPABILITY_ROOT,
    nominationProgramSetRoot: nominationQualificationSet.programSetRoot,
    nominationQualificationSet,
    nominationQualificationSetRoot: nominationQualificationSet.root,
    selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(executor),
    selectedExecutor: executor,
    releaseRoleManifestRoot: executor.releaseRoleManifestRoot,
    candidateReleaseCommit: executor.candidateCommit,
    workerEpoch: "epoch-1",
    executorSessionHash: h("executor-session"),
    frameworkAuthorityRoot: h("framework-authority"),
    executorAuthorityRoot: h("executor-authority"),
    releaseAuthorityRoot: h("release-authority"),
    attestationProofIssuerKeyId: h("attestation-proof-key"),
    candidatePartitionProofIssuerKeyId: h("partition-proof-key"),
  };
}

function rawKey(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): `0x${string}` {
  const der = publicKey.export({ format: "der", type: "spki" });
  return `0x${der.subarray(-32).toString("hex")}`;
}

function issueAuthority() {
  const keys = generateKeyPairSync("ed25519");
  const signerKeyId = h("signer");
  const value = payload();
  const signatureHex = `0x${sign(null, Buffer.from(runtimeReleaseBindingSigningBytes(value, signerKeyId)), keys.privateKey).toString("hex")}` as `0x${string}`;
  const binding = createRuntimeReleaseBindingV1(value, signerKeyId, signatureHex);
  return Object.freeze({
    binding,
    authority: verifyAndIssueRuntimeReleaseAuthorityV1(binding, { signerKeyId, publicKeyHex: rawKey(keys.publicKey) }),
  });
}

function familyExecutionFor(release: ReturnType<typeof issueAuthority>) {
  const binding = release.binding;
  const capability = Object.freeze(Object.create(null)) as QualifiedExecutorAuthorityCapability;
  const provenance = Object.freeze({
    authorityRoot: binding.executorAuthorityRoot,
    workerEpoch: binding.workerEpoch,
    executorSession: binding.executorSessionHash,
    version: 1,
  });
  const issuer: QualifiedExecutorAuthorityIssuer = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: binding.qualifiedExecutorRegistryRoot,
    authorityRoot: binding.executorAuthorityRoot,
    open: () => capability,
    rotate: () => capability,
    revoke: () => undefined,
    assert: (value: object) => {
      if (value !== capability) throw new TypeError("unknown executor capability");
      return provenance;
    },
    provenance: (value: object) => {
      if (value !== capability) throw new TypeError("unknown executor capability");
      return provenance;
    },
  }));
  const schedulerRuntime = issueQualifiedSharedSchedulerRuntimePort({
    scheduler: new WorkScheduler(),
    issuer,
    capability,
  });
  const physicalExecution = issueQualifiedPhysicalExecutionPort({
    issuer,
    capability,
    schedulerRuntime,
    execute: async () => Object.freeze({
      kind: "returned" as const,
      requestId: h("family-execution-request"),
      dataHex: "0x01",
    }),
  });
  return createSchedulerOwnedFamilyExecutionPort({
    issuer,
    capability,
    physicalExecution,
  });
}

function familyCompositionFor(release: ReturnType<typeof issueAuthority>) {
  const capability = issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
    release.authority,
    familyExecutionFor(release),
    createReleaseFamilyRuntimeComposition,
  );
  return createReleaseFamilyRuntimeComposition(capability);
}

function issueEconomicSafety(release: ReturnType<typeof issueAuthority>) {
  const profitAsset = erc20AssetReferenceV1("1", `0x${"1".repeat(40)}`);
  const evaluatorCapability = issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1(
    release.authority,
    encodeEconomicSafetyObjectiveTemplatesV1([{
    objectiveRef: h("economic-objective"),
    profitAsset,
    profitAccount: `0x${"2".repeat(40)}`,
    minNetGain: "1",
    maxGas: "1000000",
    maxValueAtRisk: "1000000000000000000",
    priorityFeePerGas: "0",
    bidCostNative: "0",
    valuationOwnerRef: NATIVE_EQUIVALENT_VALUATION_OWNER_REF_V1,
    }]),
  );
  return issueRuntimeReleaseEconomicSafetyServiceV1({
    authority: release.authority,
    evaluatorCapability,
    familyRuntimeComposition: familyCompositionFor(release),
  });
}

async function successfulTerminal(releaseProvenanceHash: Hash, label: string): Promise<SearchTerminalCapabilityV1> {
  const head: CanonicalHead = Object.freeze({
    chainId: "1",
    number: "100",
    hash: h(`head:${label}`),
    parentHash: h(`parent:${label}`),
    stateRoot: h(`state:${label}`),
  });
  const generationId = `generation:${label}`;
  const fixture = createSearchTerminalFixture({
    head,
    generationId,
    mode: "unsigned-passed",
    releaseProvenanceHash,
    proposedCapabilitySetRoot: TEST_STRATEGY_CAPABILITY_ROOT,
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
  if (envelope === null) throw new TypeError("Six-Step terminal fixture ingress is missing");
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
  if (result.outcome.kind !== "unsigned-dry-run") throw new TypeError("Six-Step terminal fixture did not pass");
  return result.outcome.terminalCapability;
}

function matchingStrategyFactory(terminal: SearchTerminalCapabilityV1) {
  const trace = readIssuedSearchTerminalSixStepTraceV1(terminal);
  const binding = trace.resolved.binding as unknown as { readonly definitionCatalogRoot: Hash };
  const catalogEntry = compileStrategy(ROUTE_CYCLE_STRATEGY, []).entry;
  const issuerClosureRoot = pipelineHash("test/search-pipeline/issuer-closure/v1", "route-cycle");
  const entryBase = Object.freeze({
    catalogEntry,
    issuerModulePath: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.modulePath,
    issuerExportName: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.exportName,
    issuerClosureRoot,
    planningTemplateHash: strategyPlanningTemplateHash(catalogEntry.planningTemplate),
  });
  const entry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
    ...entryBase,
    leafDigest: pipelineHash("aloha/generated-strategy-runtime-leaf/v1", {
      strategyId: catalogEntry.strategyId,
      strategyDefinitionHash: catalogEntry.strategyDefinitionHash,
      definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
      issuerModulePath: entryBase.issuerModulePath,
      issuerExportName: entryBase.issuerExportName,
      issuerClosureRoot,
      planningTemplateHash: entryBase.planningTemplateHash,
    }),
  });
  const descriptor = sealGeneratedStrategyRuntimeDescriptor({
    schemaVersion: 1,
    releaseIntentRoot: pipelineHash("test/search-pipeline/release/v1", 1),
    definitionCatalogRoot: binding.definitionCatalogRoot,
    proposedCapabilitySetRoot: TEST_STRATEGY_CAPABILITY_ROOT,
    strategies: [entry],
  });
  return createGeneratedStrategyRuntimeFactory({ descriptor, issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER] });
}

test("Six-Step terminal binding is release/Strategy exact, opaque, one-shot, and rotation fenced", async () => {
  const release = issueAuthority();
  const provenance = runtimeReleaseBindingProvenanceHash(release.binding);
  const terminal = await successfulTerminal(provenance, "current");
  const strategy = issueRuntimeReleaseStrategyRuntimeService(release.authority, matchingStrategyFactory(terminal));
  const economicSafety = issueEconomicSafety(release);
  const service = issueRuntimeReleaseSixStepTerminalBindingServiceV1(release.authority, strategy, economicSafety);
  const capability = service.bindSuccessfulTerminal(terminal);
  const observed = readRuntimeReleaseSixStepTerminalBindingV1(capability);

  assert.deepEqual(Reflect.ownKeys(capability), []);
  assert.equal(observed.runtimeBindingId, release.binding.bindingId);
  assert.equal(observed.releaseProvenanceHash, provenance);
  assert.equal(observed.candidateReleaseCommit, release.binding.candidateReleaseCommit);
  assert.equal(observed.economicEvaluatorAuthorityRoot, release.binding.releaseAuthorityRoot);
  assert.notEqual(observed.economicEvaluatorImplementationHash, release.binding.searcherRuntime.implementationClosureDigest);
  const evaluatorObservation = observed.economicEvaluatorBindingObservation;
  const expectedExecutorQualification = Object.freeze({
    executorKind: release.binding.selectedExecutor.executorKind,
    engineBuildFingerprint: release.binding.selectedExecutor.engineBuildFingerprint,
    executableFingerprint: release.binding.selectedExecutor.executableFingerprint,
    qualifiedExecutorRegistryRoot: release.binding.qualifiedExecutorRegistryRoot,
    selectedExecutorLeafHash: release.binding.selectedExecutorLeafHash,
    releaseRoleManifestRoot: release.binding.selectedExecutor.releaseRoleManifestRoot,
  });
  assert.deepEqual(evaluatorObservation.executorQualification, expectedExecutorQualification);
  assert.equal(evaluatorObservation.policyRoot, economicSafetyObjectivePolicyRootV1(
    evaluatorObservation.objectiveTemplates,
    evaluatorObservation.actionOwners,
    evaluatorObservation.valuationOwners,
    expectedExecutorQualification,
    evaluatorObservation.safetyProfile,
  ));
  assert.equal(observed.traceRoot, observed.trace.traceRoot);
  assert.equal(observed.strategyCompositionRoot, observed.trace.strategyCompositionRoot);
  assert.equal(observed.correlationId, observed.trace.resolved.correlationId);
  assert.equal(observed.routeCandidateId, observed.trace.resolved.routeCandidateId);

  assert.throws(() => service.bindSuccessfulTerminal(terminal), /already issued/);
  assert.throws(() => service.bindSuccessfulTerminal({ ...terminal }), /not issued/);
  assert.throws(() => readRuntimeReleaseSixStepTerminalBindingV1({ ...capability }), /not issued|invalid/);

  release.authority.rotate(release.binding);
  assert.throws(() => service.bindSuccessfulTerminal(terminal), /stale|rotation/);
  assert.throws(() => readRuntimeReleaseSixStepTerminalBindingV1(capability), /stale|rotation/);
});

test("Six-Step terminal binding rejects a terminal from another release and a non-success terminal", async () => {
  const release = issueAuthority();
  const provenance = runtimeReleaseBindingProvenanceHash(release.binding);
  const terminal = await successfulTerminal(provenance, "strategy-seed");
  const strategy = issueRuntimeReleaseStrategyRuntimeService(release.authority, matchingStrategyFactory(terminal));
  const economicSafety = issueEconomicSafety(release);
  const service = issueRuntimeReleaseSixStepTerminalBindingServiceV1(release.authority, strategy, economicSafety);

  const foreign = issueAuthority();
  const foreignEconomicSafety = issueEconomicSafety(foreign);
  assert.throws(
    () => issueRuntimeReleaseSixStepTerminalBindingServiceV1(release.authority, strategy, foreignEconomicSafety),
    /unavailable|stale/,
  );
  assert.throws(
    () => issueRuntimeReleaseSixStepTerminalBindingServiceV1(release.authority, strategy, { ...economicSafety }),
    /unavailable|stale/,
  );
  const foreignTerminal = await successfulTerminal(runtimeReleaseBindingProvenanceHash(foreign.binding), "foreign");
  assert.throws(() => service.bindSuccessfulTerminal(foreignTerminal), /lineage mismatch/);

  const head: CanonicalHead = Object.freeze({ chainId: "1", number: "100", hash: h("empty-head"), parentHash: h("empty-parent"), stateRoot: h("empty-state") });
  const fixture = createSearchTerminalFixture({
    head,
    generationId: "empty-generation",
    mode: "no-candidate",
    releaseProvenanceHash: provenance,
    proposedCapabilitySetRoot: TEST_STRATEGY_CAPABILITY_ROOT,
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
  if (envelope === null) throw new TypeError("empty terminal ingress is missing");
  const result = await fixture.run({ kind: "blockscan", session: fixture.session, head, revision: "0", generationId: "empty-generation", graphRoot: fixture.session.lease.binding.graphRoot, input: envelope.blockscanInput, signal: new AbortController().signal });
  if (result.outcome.kind !== "route-set-terminal") throw new TypeError("empty terminal fixture did not terminate");
  const emptyTerminal = result.outcome.terminalCapability;
  assert.throws(() => service.bindSuccessfulTerminal(emptyTerminal), /requires a successful/);
});
