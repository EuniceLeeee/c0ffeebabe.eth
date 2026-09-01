import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { once } from "node:events";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism, cpus, tmpdir, totalmem } from "node:os";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { sealInstanceCatalog } from "../../catalog/src/index.ts";
import { erc20AssetReferenceV1, erc20AssetRefV1 } from "../../asset-ref/src/index.ts";
import {
  encodeEconomicSafetyObjectiveTemplatesV1,
} from "../../economics-safety/src/index.ts";
import { buildPersistedGraph } from "../../graph/src/index.ts";
import {
  createAttestationProgramPortFromFamilyComposition,
} from "../../attestation/src/internal/family-program-adapter.ts";
import {
  createAttestationService,
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../../attestation/src/internal/composition.ts";
import type { AttestationServiceV1, RejectionTransportExecutorV1 } from "../../attestation/src/index.ts";
import {
  releaseApproval,
  attestationProofPortForReleaseApproval,
  readyBindingPortForReleaseApproval,
  runtimeAuthorityForReleaseApproval,
  TEST_ATTESTATION_PROOF_KEY_ID,
  TEST_CANDIDATE_PARTITION_PROOF_KEY_ID,
  testAttestationCompositionForRuntimeAuthority,
} from "../../attestation/test/authority-fixture.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import {
  candidatePartitionProofPublicKeyHexFixture,
  createCandidatePartitionProofIssuerFixture,
} from "../../checkpoint/test/candidate-partition-authority-fixture.ts";
import {
  CheckpointStore,
  type CheckpointSixStepArtifactPortV1,
} from "../../checkpoint/src/index.ts";
import { issueCheckpointSixStepArtifactPortV1 } from "../../checkpoint/src/internal/six-step-artifact-port-owner.ts";
import {
  candidatePartitionBootstrapReader,
  createCandidatePartitionBootstrap,
} from "../../checkpoint/src/candidate-partition.ts";
import { createCanonicalSource, SQLiteCanonicalJournalStore, type CanonicalHead } from "../../canonical-source/src/index.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";
import { createReadyPromotionAuthority, ReadyGenerationServiceV1 } from "../../ready-generation/src/index.ts";
import { startStartupRuntime } from "../../startup-runtime/src/index.ts";
import { issueStartupReadyPort } from "../../startup-runtime/src/internal/ready-owner.ts";
import { encodeEvmLogObservation, sealRecentObservation, type ObservedBlockV1 } from "../../observation/src/index.ts";
import {
  candidatePartitionRoot,
  mergeAndDedupeNominations,
  sealSourceCoverage,
  sealPersistedSourcePlanExecution,
  sealPersistedSourcePlanExecutionSet,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  sourcePlanIdentity,
  SOURCE_EVIDENCE_VERSION_V1,
  type CandidateRecordV1,
  type RecentLogEvidenceRefV1,
  type SourcePlanEvidenceReceiptV1,
  type SourcePlanEvidenceRefV1,
  type SourcePlanExecutionV1,
  type SourcePlanRefV1,
} from "../../discovery/src/index.ts";
import {
  issueFamilyRawEvidenceReadPort,
  type FamilySourcePlanPhysicalPortV1,
  type FamilyRuntimeAuthorityBindingV1,
  type RuntimeStageExecutorV1,
} from "../../family-sdk/runtime/index.ts";
import type { TransportFactV1 } from "../../capability-interpreters/src/index.ts";
import { asCapabilityId, asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../capability-contracts/src/index.ts";
import { asFamilyId } from "../../family-sdk/runtime-refs/index.ts";
import { sealCapabilityIndex } from "../../../specs/capability-index/src/index.ts";
import { decodeReleaseQualifiedCapabilitySetV1 } from "../../../specs/capability-index/src/index.ts";
import { sealReleaseIntent } from "../../../specs/release-intent/src/index.ts";
import {
  createRuntimeReleaseBindingV1,
  createRuntimeReleaseDiscoverySourceQualificationV1,
  decodeRuntimeReleaseQualifiedCapabilityProjectionV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  runtimeReleaseDiscoverySourceAuthorityRootV1,
  runtimeReleaseBindingProvenanceHash,
  runtimeReleaseBindingSigningBytes,
  sealRuntimeReleaseNominationQualificationSetV1,
  type RuntimeReleaseBindingV1,
  type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import { verifyRuntimeReleaseBindingSignatureV1 } from "../../../tools/runtime-release-packager/src/index.ts";
import { verifyReleaseRequirementDenominatorV1 } from "../../../tools/runtime-release-packager/src/release-acceptance.ts";
import {
  evaluateQualifiedLineageFixture,
  evaluateQualifiedReleaseDenominatorFixture,
} from "../../../acceptance/gate-core/test/lineage-fixture.test.ts";
import {
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
} from "../../../specs/nomination-authority/src/index.ts";
import { generateCatalog } from "../../../tools/catalog-generator/src/index.ts";
import { currentCatalogInput, readCurrentCatalogInput } from "../../../tools/catalog-generator/src/current-release.ts";
import {
  PUBLIC_ENTRY,
  UNIV2_STANDARD_DEFINITION,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
  UNIV2_STANDARD_IDENTITY_DEFINITION,
  UNIV2_STANDARD_STATE_PORT,
  UNIV2_STANDARD_COARSE_PORT,
  UNIV2_STANDARD_EXACT_PORT,
  UNIV2_STANDARD_SWAP_ACTION_PORT,
  UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY,
  UNIV2_STANDARD_RUNTIME_DEFINITIONS,
  UNIV2_STANDARD_STAGE_DEFINITIONS,
  UNIV2_STANDARD_STAGE_EXPORT_NAMES,
  FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1,
  buildIdentityBaseReadRequests,
  buildIdentityPairReadRequests,
  nominateUniV2,
  UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM,
  UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME,
  UNIV2_STANDARD_SOURCE_PLAN_ID,
  UNIV2_STANDARD_SOURCE_PLAN_RUNTIME,
  UNIV2_SYNC_EVENT_TOPIC0,
  UNIV2_GET_RESERVES_SELECTOR,
} from "../../../families/univ2-standard/src/public.ts";
import {
  missingExternalRuntimeAnchorEvidenceV1,
} from "../../../apps/searcher-runtime/src/index.ts";
import {
  issueSearcherRuntimeApplicationOwnerV1,
  type SearcherRuntimeApplicationV1,
} from "../../../apps/searcher-runtime/src/internal/application-owner.ts";
import {
  issueProductionFullFamilyCollectorPortV1,
  readProductionFullFamilyCollectorResultV1,
} from "../../../acceptance/collectors/src/production-full-family-port.ts";
import {
  issueProductionSixStepCollectorPortV1,
  readProductionSixStepCollectorResultV1,
} from "../../../acceptance/collectors/src/production-six-step-port.ts";
import {
  issueProductionTerminalPhaseCollectorPortV1,
  readProductionTerminalPhaseCollectorResultV1,
} from "../../../acceptance/collectors/src/production-terminal-phase-port.ts";
import {
  ProductionTerminalPhaseLocatorIndexV1,
} from "../../../acceptance/collectors/src/terminal-phase-locator-index.ts";
import {
  readReleaseOwnedObserverStoreV1,
} from "../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import {
  encodeFullFamilyCandidateProofVerifierBinding,
} from "../../../specs/full-family-facts/src/index.ts";
import {
  issueSearcherProductionEvidenceOwnerV1,
  SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES,
} from "../../../apps/searcher-runtime/src/production-evidence.ts";
import {
  createRethSearcherRuntimeSourceV1,
  type RethSearcherRuntimeSourceV1,
} from "../../../apps/searcher-runtime/src/internal/reth-source.ts";
import {
  readIssuedProducerHeadFactsCapabilityV1,
  readIssuedProducerHeadTerminalCapabilityV1,
} from "../../producer/src/internal/owners.ts";
import {
  validateUnsignedDryRunReceiptValue,
  type UnsignedDryRunReceiptV1,
} from "../../search-pipeline/src/index.ts";
import { decodeExecutorExecuteCalldata, decodePackedCallProgram } from "../../execution-program/src/index.ts";
import {
  createRethQualifiedExecutorStateOwner,
  createQualifiedFinalSimulationPort,
  createSourceBoundExecutorProjection,
} from "../../final-sim/src/index.ts";
import { issueQualifiedFinalSimulationPortFactoryV1 } from "../../final-sim/src/internal/final-simulation-owner.ts";
import {
  RevmSimulationClient,
  type RevmWorkerQualification,
} from "../../../runtime/revm-workers/src/index.ts";
import { createNodeRevmWorkerFactory } from "../../../runtime/revm-workers/src/node-worker-factory.ts";
import {
  createGeneratedFamilyRuntimeComposition,
  type GeneratedFamilyRuntimeAuthorityBindingV1,
} from "../src/index.ts";
import {
  createGeneratedFamilyRuntimeFactory,
  issueGeneratedFamilyLifecycleRuntimePort,
  issueGeneratedFamilyRuntimeAuthorityCapability,
  readGeneratedFamilyRuntimeFactoryMetadata,
  type GeneratedFamilyLifecycleRuntimePortV1,
} from "../src/internal/generated-runtime-composition.ts";
import {
  issueRuntimeReleaseFamilyRuntimeAuthorityCapability,
} from "../../runtime-release-authority/src/internal/family-runtime-owner.ts";
import { readActiveSignedRuntimeAuthorityDescriptorV1 } from "../../runtime-release-authority/src/internal/runtime-authority-descriptor-owner.ts";
import {
  buildRuntimeReleaseComposition,
  verifyAndIssueRuntimeReleaseAuthorityV1,
} from "../../runtime-release-authority/src/index.ts";
import { issueRuntimeReleaseRevmWorkerDeploymentPort } from "../../runtime-release-authority/src/internal/revm-worker-owner.ts";
import { issueRuntimeReleaseRevmWorkerAuthorityIssuer } from "../../runtime-release-authority/src/internal/revm-worker-owner.ts";
import { issueRuntimeReleaseQualifiedExecutorAuthorityIssuer } from "../../runtime-release-authority/src/internal/scheduler-authority-owner.ts";
import { issueRuntimeReleaseQualifiedDiscoverySourcePort, readRuntimeReleaseQualifiedDiscoverySourcePort } from "../../runtime-release-authority/src/internal/discovery-source-authority-owner.ts";
import { issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1 } from "../../runtime-release-authority/src/internal/economic-safety-owner.ts";
import { issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1 } from "../../runtime-release-authority/src/internal/performance-deployment-owner.ts";
import { issueInstalledRuntimeReleasePerformancePolicyPortV1 } from "../../runtime-release-authority/src/internal/performance-policy-owner.ts";
import { issueRevmWorkerDeploymentPort } from "../../../runtime/revm-workers/src/internal/authority.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../scheduler/src/internal/authority-owner.ts";
import { WorkScheduler, type QualifiedExecutorAuthorityCapability } from "../../scheduler/src/index.ts";
import {
  issueQualifiedSharedSchedulerRuntimePort,
  readQualifiedSharedSchedulerRuntimePort,
} from "../../scheduler/src/internal/shared-runtime-owner.ts";
import {
  createSchedulerOwnedFamilyExecutionPort,
  issueQualifiedPhysicalExecutionPort,
} from "../../work-plane/src/internal/family-execution-port.ts";
import {
  createReleaseFamilyRuntimeComposition,
} from "../../../generated/runtime-composition/index.ts";
import { ROUTE_CYCLE_STRATEGY } from "../../../strategies/route-cycle/src/index.ts";
import {
  createDeploymentPerformanceWindowBasisV1,
  createHardwareProfileObservationV1,
  DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
  encodeDeploymentPerformanceWindowBasisV1,
  encodeHardwareProfileObservationV1,
  encodeProductionPerformanceProfile,
  PERFORMANCE_ELIGIBILITY_RULE_HASH,
} from "../../../specs/performance/src/index.ts";
import { observeProductionPerformanceDatabaseV1 } from "../../performance-collector/src/raw-sqlite-observer.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const h = (value: string): Hash => hashDomain("test/univ2-generated-runtime", value);
const checkpointSixStepArtifacts = (): CheckpointSixStepArtifactPortV1 => issueCheckpointSixStepArtifactPortV1(Object.freeze({
  async emitVerifiedOutcome() { return Object.freeze(Object.create(null)); },
  async emitReadyEdge() { return Object.freeze(Object.create(null)); },
}));

interface MutableSqliteStatementV1 {
  all(...parameters: readonly unknown[]): readonly Record<string, unknown>[];
  run(...parameters: readonly unknown[]): unknown;
}

interface MutableSqliteDatabaseV1 {
  exec(sql: string): void;
  prepare(sql: string): MutableSqliteStatementV1;
  close(): void;
}

function openMutableSqlite(path: string): MutableSqliteDatabaseV1 {
  const require = createRequire(import.meta.url);
  const loaded = require("node:sqlite") as { readonly DatabaseSync?: new (filename: string) => MutableSqliteDatabaseV1 };
  if (typeof loaded.DatabaseSync !== "function") throw new TypeError("node:sqlite does not expose DatabaseSync");
  return new loaded.DatabaseSync(path);
}

function mutateProductionEvent(
  sourcePath: string,
  label: string,
  namespace: string,
  eventType: string,
  matches: (event: Record<string, unknown>) => boolean,
  mutate: (event: Record<string, unknown>) => void,
): string {
  const destination = join(dirname(sourcePath), `mutation-${label}.sqlite`);
  const source = openMutableSqlite(sourcePath);
  try {
    source.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  const database = openMutableSqlite(destination);
  try {
    const rows = database.prepare(`
      SELECT sequence, bytes, offset_start
      FROM durable_append_log
      WHERE namespace=?
    `).all(namespace);
    const matchingRows = rows.filter(row => {
      if (!(row.bytes instanceof Uint8Array)) return false;
      const event = decodeCanonicalJson(row.bytes) as Record<string, unknown>;
      return event.eventType === eventType && matches(event);
    });
    assert.equal(matchingRows.length, 1);
    const row = matchingRows[0]!;
    if (!(row.bytes instanceof Uint8Array) || typeof row.offset_start !== "string") throw new TypeError("candidate mutation row is malformed");
    const event = structuredClone(decodeCanonicalJson(row.bytes)) as Record<string, unknown>;
    mutate(event);
    const withoutId = { ...event };
    delete withoutId.eventId;
    event.eventId = hashDomain("aloha/searcher-production-evidence-event/v1", withoutId);
    const bytes = encodeCanonicalBytes(event);
    database.exec("DROP TRIGGER durable_append_log_no_update");
    database.prepare(`
      UPDATE durable_append_log
      SET event_id=?, content_sha256=?, bytes=?, byte_length=?, offset_end=?
      WHERE namespace=? AND sequence=?
    `).run(
      event.eventId,
      sha256Hex(bytes),
      bytes,
      bytes.byteLength.toString(),
      (BigInt(row.offset_start) + BigInt(bytes.byteLength)).toString(),
      namespace,
      row.sequence,
    );
    database.exec(`
      CREATE TRIGGER durable_append_log_no_update
      BEFORE UPDATE ON durable_append_log
      BEGIN
        SELECT RAISE(ABORT, 'durable append-log is append-only');
      END
    `);
  } finally {
    database.close();
  }
  return destination;
}

function mutateProductionCompletePerformanceEvent(
  sourcePath: string,
  label: string,
  mutate: (event: Record<string, unknown>) => void,
): string {
  return mutateProductionEvent(
    sourcePath,
    label,
    SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.performance,
    "performance-facts-complete",
    event => (event.payload as Record<string, unknown>).sixStepFacts !== null,
    mutate,
  );
}
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;

const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: h("cutoff-hash"),
  stateRoot: h("cutoff-state"),
});
const producerHead = Object.freeze({
  ...cutoff,
  parentHash: h("cutoff-parent-hash"),
});
const pool = address("1");
const poolB = address("5");
const token0 = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const token1 = address("d");
const factory = address("f");
const executorAddress = address("e");
const rawEvidenceBytes = encodeEvmLogObservation(Object.freeze({
  kind: "evm-log" as const,
  version: 1 as const,
  blockNumber: "99",
  blockHash: h("evidence-block"),
  transactionHash: h("evidence-tx"),
  logIndex: "0",
  address: pool,
  topics: Object.freeze([UNIV2_SYNC_EVENT_TOPIC0]),
  data: "0x",
}));
const rawEvidenceHash = sha256Hex(rawEvidenceBytes);
const rawEvidenceLocator = Object.freeze({
  kind: "raw-evidence-locator" as const,
  version: SOURCE_EVIDENCE_VERSION_V1,
  rawLocatorHash: rawEvidenceHash,
  bytes: rawEvidenceBytes,
});

function compilerFacts() {
  const current = currentCatalogInput(repositoryRoot);
  const extensionEntrypoints = Object.values(UNIV2_STANDARD_DEFINITION.extensions).flatMap(slot =>
    slot.kind === "present" ? [[slot.module.modulePath, slot.module.exportName] as const] : []);
  const actionEntrypoints = UNIV2_STANDARD_DEFINITION.actionOwners.map(owner =>
    [owner.modulePath, owner.exportName] as const);
  const nominationEntrypoints = UNIV2_STANDARD_DEFINITION.manifest.sourcePlans.flatMap(plan =>
    plan.nominationProgram.kind === "present"
      ? [
          [plan.nominationProgram.program.modulePath, plan.nominationProgram.program.exportName] as const,
          [plan.nominationProgram.program.mutationCorpus.modulePath, plan.nominationProgram.program.mutationCorpus.exportName] as const,
          [plan.nominationProgram.program.independentOracle.modulePath, plan.nominationProgram.program.independentOracle.exportName] as const,
        ]
      : []);
  const paths = [
    ["families/univ2-standard/src/public.ts", "UNIV2_STANDARD_DEFINITION"],
    ...Object.values(UNIV2_STANDARD_STAGE_EXPORT_NAMES).map(exportName => ["families/univ2-standard/src/runtime/definitions.ts", exportName] as const),
    ...UNIV2_STANDARD_DEFINITION.manifest.sourcePlans.map(plan => [plan.modulePath, plan.exportName] as const),
    ...nominationEntrypoints,
    ...extensionEntrypoints,
    ...actionEntrypoints,
    ...Object.values(UNIV2_STANDARD_DEFINITION.runtimeAdapters ?? {}).map(adapter => [adapter.modulePath, adapter.exportName] as const),
    ["strategies/route-cycle/src/index.ts", "ROUTE_CYCLE_STRATEGY"],
    ["strategies/route-cycle/src/index.ts", "ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER"],
    ["tools/catalog-generator/src/index.ts", "generateCatalogWithImpact"],
    ...current.valuationOwners.flatMap(owner => [
      [owner.declaration.modulePath, owner.declaration.exportName] as const,
      [owner.declaration.qualificationModulePath, owner.declaration.qualificationSpecExportName] as const,
      [owner.declaration.qualificationModulePath, owner.declaration.criticalMutationCorpusExportName] as const,
      [owner.declaration.qualificationModulePath, owner.declaration.independentOracleCasesExportName] as const,
    ]),
  ] as const;
  const uniquePaths = paths.filter(([modulePath, exportName], index) =>
    paths.findIndex(([candidateModulePath, candidateExportName]) =>
      candidateModulePath === modulePath && candidateExportName === exportName) === index);
  const observed = readCurrentCatalogInput(repositoryRoot).compilerClosures;
  return uniquePaths.map(([modulePath, exportName]) => {
    const fact = observed.find(candidate =>
      candidate.modulePath === modulePath && candidate.exportName === exportName);
    if (fact === undefined) throw new TypeError(`formal catalog compiler fact missing ${modulePath}#${exportName}`);
    return fact;
  });
}

function generatedDescriptor() {
  const current = currentCatalogInput(repositoryRoot);
  const publicEntry = {
    familyId: UNIV2_STANDARD_FAMILY_ID,
    manifestRoot: hashDomain("aloha/family-manifest/v1", UNIV2_STANDARD_DEFINITION.manifest),
    modulePath: "families/univ2-standard/src/public.ts",
    exportName: "UNIV2_STANDARD_DEFINITION",
  } as const;
  const capabilities = Object.values(UNIV2_STANDARD_DEFINITION.extensions).flatMap(slot =>
    slot.kind === "present" ? [slot.module] : []);
  const capabilityIndex = sealCapabilityIndex(capabilities.map(capability => ({
    capabilityId: capability.capabilityId,
    version: capability.version,
    schemaHash: capability.schemaHash,
    interpreterHash: capability.interpreterHash,
    dependencyIds: capability.dependencyIds,
    modulePath: capability.modulePath,
    exportName: capability.exportName,
  })));
  const observedCapabilitySet = readCurrentCatalogInput(repositoryRoot).proposedCapabilitySet;
  const proposedCapabilityRefs = capabilities.map(capability => {
    const ref = observedCapabilitySet.refs.find(candidate =>
      candidate.capabilityId === capability.capabilityId && candidate.version === capability.version);
    if (
      ref === undefined
      || ref.schemaHash !== capability.schemaHash
      || ref.interpreterHash !== capability.interpreterHash
    ) throw new TypeError(`formal catalog capability proposal missing ${capability.capabilityId}`);
    return Object.freeze({
      capabilityId: asCapabilityId(ref.capabilityId),
      version: asCapabilityVersion(ref.version),
      schemaHash: asSchemaRef(ref.schemaHash),
      interpreterHash: ref.interpreterHash,
      ownerRef: asOwnerRef(ref.ownerRef),
    });
  });
  const strategyPublicEntry = {
    strategyId: ROUTE_CYCLE_STRATEGY.strategyId,
    manifestRoot: hashDomain("aloha/strategy-manifest/v1", {
      strategyId: ROUTE_CYCLE_STRATEGY.strategyId,
      version: ROUTE_CYCLE_STRATEGY.version,
      pluginCodeHash: ROUTE_CYCLE_STRATEGY.pluginCodeHash,
    }),
    modulePath: "strategies/route-cycle/src/index.ts",
    exportName: "ROUTE_CYCLE_STRATEGY",
  } as const;
  const artifacts = generateCatalog({
    repositoryRoot,
    releaseIntent: sealReleaseIntent([publicEntry], [strategyPublicEntry]),
    capabilityIndex,
    proposedCapabilityRefs,
    compilerClosures: compilerFacts(),
    families: [{ definition: UNIV2_STANDARD_DEFINITION, publicEntry }],
    strategies: [{ definition: ROUTE_CYCLE_STRATEGY, publicEntry: strategyPublicEntry }],
    valuationOwners: current.valuationOwners,
  });
  return artifacts.familyRuntimeDescriptor;
}

function executorSet(binding: FamilyRuntimeAuthorityBindingV1): GeneratedFamilyRuntimeAuthorityBindingV1["executors"] {
  return Object.freeze(UNIV2_STANDARD_STAGE_DEFINITIONS.map(definition => ({
    stage: definition.stage,
    executor: {
      async execute({ program }: Parameters<RuntimeStageExecutorV1["execute"]>[0]) {
        const payload = decodeCanonicalJson(program.frozenProgram.canonicalPayloadBytes) as { readonly requestIds?: readonly Hash[]; readonly requestId?: Hash; readonly kind?: string };
        const requestIds = payload.requestIds ?? (payload.requestId === undefined ? [] : [payload.requestId]);
        const identityData = [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(pool), addressWord(pool)];
        const reservesData = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
        const facts: readonly TransportFactV1[] = requestIds.map((requestId, index) => ({
          kind: "returned" as const,
          requestId,
          requestFingerprint: program.frozenProgram.requestFingerprint,
          dataHex: payload.kind === "family-identity-input" ? identityData[index]! : reservesData,
          source: {
            chainId: cutoff.chainId,
            blockNumber: cutoff.number,
            blockHash: cutoff.hash,
            stateRoot: cutoff.stateRoot,
            executorAuthorityRoot: binding.executorAuthorityRoot,
            workerEpoch: binding.workerEpoch,
            executorSessionHash: binding.executorSessionHash,
          },
        }));
        return facts;
      },
    },
  })));
}

function nominationObservation() {
  return {
    pool,
    evidence: {
      cutoff,
      blockNumber: "99",
      blockHash: h("evidence-block"),
      txHash: h("evidence-tx"),
      logIndex: "0",
      emitter: pool,
      topic0: UNIV2_SYNC_EVENT_TOPIC0,
      rawLocatorHash: rawEvidenceHash,
    },
  } as const;
}

function createService(
  lifecycle: GeneratedFamilyLifecycleRuntimePortV1,
  approval: ReturnType<typeof releaseApproval>,
  candidatePartitionReader: ReturnType<typeof candidatePartitionBootstrapReader>,
): AttestationServiceV1 {
  const frameworkRuntime = createFrameworkFailureRuntime(approval, { classify() { return null; } });
  const rejectionExecutor: RejectionTransportExecutorV1 = { async execute() { return { transport: [], effects: [] }; } };
  const rejectionAuthority = createRejectionExecutorAuthorityIssuer(approval);
  const rejectionRuntime = createRejectionFactRuntime(rejectionAuthority.issue(rejectionExecutor));
  const programs = createAttestationProgramPortFromFamilyComposition({ lifecycle });
  return createAttestationService({
    composition: approval,
    frameworkRuntime,
    rejectionRuntime,
    programs,
    instanceLifecycle: { getOrBuild: (_key, build) => build() },
    candidatePartitionReader,
  });
}

function recentObservation(candidate: CandidateRecordV1) {
  const recentEvidence = candidate.evidence.filter(
    (value): value is RecentLogEvidenceRefV1 => value.kind === "recent-log",
  );
  if (recentEvidence.length !== candidate.evidence.length) {
    throw new Error("UniV2 recent observation fixture contains source-plan evidence");
  }
  const blocks: ObservedBlockV1[] = [];
  let parentHash = h("observation-parent");
  for (let number = 51; number <= 100; number += 1) {
    const hash = number === 100
      ? cutoff.hash
      : number === 99
        ? h("evidence-block")
        : h(`observation-block:${number}`);
    blocks.push({
      number: String(number),
      hash,
      parentHash,
      evidence: number === 99 ? recentEvidence : [],
    });
    parentHash = hash;
  }
  return sealRecentObservation(cutoff, { from: "51", to: "100" }, blocks, [rawEvidenceLocator]);
}

function testNominationQualificationSet(proposalLeafDigests: readonly Hash[]) {
  return sealRuntimeReleaseNominationQualificationSetV1(proposalLeafDigests.map(proposalLeafDigest => ({
    proposalLeafDigest,
    criticalMutationCorpusRoot: h(`nomination-mutations:${proposalLeafDigest}`),
    independentOracleCaseRoot: h(`nomination-oracle:${proposalLeafDigest}`),
    qualificationSpecDigest: h(`nomination-spec:${proposalLeafDigest}`),
    verifierQualificationCertificateRoot: h(`nomination-certificate:${proposalLeafDigest}`),
  })));
}

async function qualifiedUniV2RecentNomination(input: {
  readonly sourcePlan: ReturnType<typeof generatedDescriptor>["families"][number]["sourcePlans"][number];
  readonly recent: ReturnType<typeof recentObservation>;
  readonly releaseBinding: RuntimeReleaseBindingV1;
}) {
  const signal = new AbortController().signal;
  const physical: FamilySourcePlanPhysicalPortV1 = Object.freeze({
    async request() {
      throw new Error("UniV2 nomination-only source plan must not issue physical requests");
    },
  });
  const result = await UNIV2_STANDARD_SOURCE_PLAN_RUNTIME.execute({
    plan: input.sourcePlan.planRef,
    cutoff,
    previousAppliedThrough: null,
  }, physical, signal);
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(input.releaseBinding);
  const sourceAuthorityRoot = runtimeReleaseDiscoverySourceAuthorityRootV1(
    input.releaseBinding.discoverySourceQualification,
  );
  const sourceAnchorRoot = hashDomain("aloha/runtime-release-discovery-source-anchor/v1", {
    releaseBindingId: input.releaseBinding.bindingId,
    releaseProvenanceHash,
    sourceAuthorityRoot,
    qualificationRoot: input.releaseBinding.discoverySourceQualification.qualificationRoot,
    cutoff,
    chainIdResult: `0x${BigInt(cutoff.chainId).toString(16)}`,
    block: Object.freeze({
      number: `0x${BigInt(cutoff.number).toString(16)}`,
      hash: cutoff.hash,
      stateRoot: cutoff.stateRoot,
    }),
  });
  const persistedExecution = sealPersistedSourcePlanExecution({
    execution: result.execution,
    sourcePlanLeafDigest: input.sourcePlan.leafDigest,
    sourcePlanSchemaHash: input.sourcePlan.schemaHash,
    sourcePlanClosureRoot: input.sourcePlan.closureRoot,
    sourceAuthorityRoot,
    releaseBindingId: input.releaseBinding.bindingId,
    releaseProvenanceHash,
    sourceAnchorRoot,
    previousExecutionRoot: null,
  });
  const sourceCoverage = sealSourceCoverage(cutoff, [input.sourcePlan.planRef], [result.execution]);
  const sourceExecutionSet = sealPersistedSourcePlanExecutionSet(cutoff, [persistedExecution]);
  const rawEvidence = issueFamilyRawEvidenceReadPort({
    values: [rawEvidenceLocator, ...result.rawEvidenceLocators],
    recent: input.recent,
    sourceEvidence: [result.sourceEvidence],
  });
  const nominations = await UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM.evaluate({
    execution: result.execution,
    sourceEvidence: result.sourceEvidence,
    recent: input.recent,
    rawEvidence,
  }, signal);
  const candidates = mergeAndDedupeNominations(nominations);
  const sourceIdentity = sourcePlanIdentity(input.sourcePlan.planRef);
  const qualification = input.releaseBinding.nominationQualificationSet.entries.find(entry =>
    entry.proposalLeafDigest === input.sourcePlan.nominationProgramProposal.proposalLeafDigest);
  if (qualification === undefined) throw new Error("signed UniV2 nomination qualification is missing");
  const relevantEvidenceRefHashes = input.recent.evidence.map(nominationEvidenceRefHash).sort();
  const receipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    sourcePlanIdentity: sourceIdentity,
    sourcePlanLeafDigest: input.sourcePlan.leafDigest,
    nominationProgramRoot: input.sourcePlan.nominationProgramProposal.nominationProgramRoot,
    nominationProgramProposalLeafDigest: input.sourcePlan.nominationProgramProposal.proposalLeafDigest,
    qualificationRoot: qualification.qualificationLeafDigest,
    denominator: Object.freeze({
      kind: "recent-observation" as const,
      recentObservationRoot: input.recent.observationRoot,
      relevantEvidenceRefHashes: Object.freeze(relevantEvidenceRefHashes),
      relevantEvidenceRoot: hashCanonicalPartition(
        "aloha/relevant-nomination-evidence/v1",
        relevantEvidenceRefHashes,
      ),
      relevantEvidenceCount: String(relevantEvidenceRefHashes.length),
    }),
    claims: nominations.map(nomination => Object.freeze({
      sourcePlanIdentity: sourceIdentity,
      familyCandidateKey: candidates.find(candidate =>
        candidate.instanceNominationKey === nomination.instanceNominationKey)!.familyCandidateKey,
      instanceNominationKey: nomination.instanceNominationKey,
      evidenceRefHash: nominationEvidenceRefHash(nomination.evidence),
    })),
  });
  const nominationClosure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot: input.recent.observationRoot,
    sourceExecutionSetRoot: sourceExecutionSet.executionSetRoot,
    sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
    sourcePlanIdentities: [sourceIdentity],
    receipts: [receipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  });
  return Object.freeze({
    candidates,
    nominationClosure,
    sourceCoverage,
    sourceExecutionSet,
    sourcePlanEvidence: Object.freeze([result.sourceEvidence]),
    sourcePlanRawEvidenceLocators: result.rawEvidenceLocators,
  });
}

test("generated composition binds real UniV2 public definitions, then seals catalog and graph", async () => {
  assert.equal(PUBLIC_ENTRY.runtimeDefinitions.identity, UNIV2_STANDARD_IDENTITY_DEFINITION);
  assert.equal(PUBLIC_ENTRY.runtimeDefinitions, UNIV2_STANDARD_RUNTIME_DEFINITIONS);
  const descriptor = generatedDescriptor();
  assert.equal(descriptor.families[0]!.entry.familyDefinitionHash, UNIV2_STANDARD_FAMILY_DEFINITION_HASH);
  assert.deepEqual(
    descriptor.families[0]!.stages.map(stage => stage.exportName).sort(),
    Object.values(UNIV2_STANDARD_STAGE_EXPORT_NAMES).sort(),
  );
  const family = descriptor.families[0]!;
  const recentSourcePlan = family.sourcePlans.find(sourcePlan =>
    sourcePlan.sourcePlanId === UNIV2_STANDARD_SOURCE_PLAN_ID);
  if (recentSourcePlan === undefined) throw new Error("generated UniV2 recent source plan is missing");
  const binding: FamilyRuntimeAuthorityBindingV1 = {
    familyId: asFamilyId(UNIV2_STANDARD_FAMILY_ID),
    familyDefinitionHash: family.entry.familyDefinitionHash,
    releaseAuthorityRoot: h("release-authority"),
    programAuthorityHash: h("program-authority"),
    executorAuthorityRoot: h("executor-authority"),
    workerEpoch: "epoch-1",
    executorSessionHash: h("executor-session"),
  };
  const authorities: readonly GeneratedFamilyRuntimeAuthorityBindingV1[] = [{
    familyDefinitionHash: family.entry.familyDefinitionHash,
    definitionBindingRoot: family.stageDefinitionRoot,
    binding,
    executors: executorSet(binding),
  }];
  const composition = createGeneratedFamilyRuntimeComposition({
    descriptor,
    authorities,
    definitions: [UNIV2_STANDARD_STAGE_DEFINITIONS],
    extensions: [family.extensions.map(extension => {
      if (extension.exportName === "UNIV2_STANDARD_STATE_PORT") return UNIV2_STANDARD_STATE_PORT;
      if (extension.exportName === "UNIV2_STANDARD_COARSE_PORT") return UNIV2_STANDARD_COARSE_PORT;
      if (extension.exportName === "UNIV2_STANDARD_EXACT_PORT") return UNIV2_STANDARD_EXACT_PORT;
      throw new Error(`unknown UniV2 extension ${extension.exportName}`);
    })],
    actionOwners: [[UNIV2_STANDARD_SWAP_ACTION_PORT]],
    runtimeAdapters: [family.runtimeAdapters.map(adapter => ({
      factory: UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY,
      modulePath: adapter.modulePath,
      exportName: adapter.exportName,
      closureRoot: adapter.closureRoot,
      leafDigest: adapter.leafDigest,
    }))],
  });
  const extensionPorts: Readonly<Record<string, object>> = {
    UNIV2_STANDARD_STATE_PORT,
    UNIV2_STANDARD_COARSE_PORT,
    UNIV2_STANDARD_EXACT_PORT,
  };
  for (const extension of family.extensions) {
    assert.equal(
      composition.resolveCapability(family.entry.familyDefinitionHash, extension.capabilityRef),
      extensionPorts[extension.exportName],
    );
  }
  assert.equal(
    composition.resolveActionOwner(family.entry.familyDefinitionHash, family.actionOwners[0]!.ownerRef),
    UNIV2_STANDARD_SWAP_ACTION_PORT,
  );
  const generatedAdapter = composition.resolveAdapter(
    family.entry.familyDefinitionHash,
    FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1,
  );
  assert.equal(typeof generatedAdapter.run, "function");
  assert.throws(
    () => composition.resolveAdapter(family.entry.familyDefinitionHash, "search/other/v1"),
    /not release-qualified/,
  );
  assert.throws(
    () => composition.resolveAdapter(family.entry.familyDefinitionHash, "physical-lifecycle/v1"),
    /search runtime adapter role is not supported/,
  );
  const nominated = nominateUniV2(nominationObservation());
  assert.equal(nominated.status, "nominated");
  const nomination = nominated.candidate;
  if ("kind" in nomination.evidence) throw new Error("UniV2 fixture expected recent-log evidence");
  const candidate: CandidateRecordV1 = mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    instanceNominationKey: nomination.instanceNominationKey,
    evidence: {
      kind: "recent-log" as const,
      version: 1 as const,
      ownerRef: null,
      sourcePlanRef: null,
      blockNumber: nomination.evidence.blockNumber,
      blockHash: nomination.evidence.blockHash,
      txHash: nomination.evidence.txHash,
      logIndex: nomination.evidence.logIndex,
      address: nomination.evidence.emitter,
      topic: nomination.evidence.topic0,
      rawLocatorHash: nomination.evidence.rawLocatorHash,
    },
  }])[0]!;
  const approval = releaseApproval(
    h("framework-authority"),
    h("executor-authority"),
    "epoch-1",
    h("executor-session"),
    h("release-authority"),
    descriptor.proposedCapabilitySetRoot,
    "http://127.0.0.1:8545",
    testNominationQualificationSet([
      recentSourcePlan.nominationProgramProposal.proposalLeafDigest,
    ]),
  );
  const generatedFactory = createGeneratedFamilyRuntimeFactory({
    descriptor,
    definitions: [UNIV2_STANDARD_STAGE_DEFINITIONS],
    extensions: [family.extensions.map(extension => {
      if (extension.exportName === "UNIV2_STANDARD_STATE_PORT") return UNIV2_STANDARD_STATE_PORT;
      if (extension.exportName === "UNIV2_STANDARD_COARSE_PORT") return UNIV2_STANDARD_COARSE_PORT;
      if (extension.exportName === "UNIV2_STANDARD_EXACT_PORT") return UNIV2_STANDARD_EXACT_PORT;
      throw new Error(`unknown UniV2 extension ${extension.exportName}`);
    })],
    actionOwners: [[UNIV2_STANDARD_SWAP_ACTION_PORT]],
    runtimeAdapters: [family.runtimeAdapters.map(adapter => ({
      factory: UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY,
      modulePath: adapter.modulePath,
      exportName: adapter.exportName,
      closureRoot: adapter.closureRoot,
      leafDigest: adapter.leafDigest,
    }))],
    sourcePlans: [family.sourcePlans.map(plan => {
      if (plan.sourcePlanId === UNIV2_STANDARD_SOURCE_PLAN_ID) return UNIV2_STANDARD_SOURCE_PLAN_RUNTIME;
      if (plan.sourcePlanId === UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID) return UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME;
      throw new Error(`unknown UniV2 source plan ${plan.sourcePlanId}`);
    })],
    nominationPrograms: [family.sourcePlans.map(plan => {
      if (plan.sourcePlanId === UNIV2_STANDARD_SOURCE_PLAN_ID) return UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM;
      if (plan.sourcePlanId === UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID) return UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM;
      throw new Error(`unknown UniV2 nomination program ${plan.sourcePlanId}`);
    })],
  });
  const qualificationSet = approval.resolver.resolve(approval.capability).provenance.runtimeBinding.nominationQualificationSet;
  const generatedCapability = issueGeneratedFamilyRuntimeAuthorityCapability({
    factory: generatedFactory,
    runtimeAuthority: readActiveSignedRuntimeAuthorityDescriptorV1(runtimeAuthorityForReleaseApproval(approval)),
    qualifiedCapabilityRefsRoot: descriptor.proposedCapabilitySetRoot,
    nominationProgramSetRoot: descriptor.nominationProgramSetRoot,
    nominationQualifications: family.sourcePlans.map(plan => ({
      proposalLeafDigest: plan.nominationProgramProposal.proposalLeafDigest,
      qualificationLeafDigest: qualificationSet.entries.find(entry =>
        entry.proposalLeafDigest === plan.nominationProgramProposal.proposalLeafDigest,
      )?.qualificationLeafDigest ?? h(`test-only-qualification:${plan.sourcePlanId}`),
    })),
    authorities,
    assertCurrent() {
      approval.resolver.resolve(approval.capability);
    },
  });
  const lifecycle = issueGeneratedFamilyLifecycleRuntimePort(generatedFactory, generatedCapability);
  const partitionBootstrap = createCandidatePartitionBootstrap();
  const service = createService(
    lifecycle,
    approval,
    candidatePartitionBootstrapReader(partitionBootstrap),
  );
  const directory = mkdtempSync(join(tmpdir(), "aloha-univ2-integration-"));
  const filename = join(directory, "checkpoint.sqlite");
  const journalStore = new SQLiteCanonicalJournalStore(join(directory, "canonical-journal.sqlite"));
  const source = createCanonicalSource({
    async getLatestHeader() { return producerHead; },
    async getHeader(number) {
      return number === cutoff.number
        ? { kind: "found" as const, header: producerHead }
        : { kind: "unavailable" as const, failureCode: "not-indexed" };
    },
  }, { journalStore });
  const policy = {
    observationWindowBlocks: "50" as const,
    targetRefreshAgeBlocks: "10",
    maxServingAgeBlocks: "30",
    minPromotionMarginBlocks: "2",
    maxInProgressRuns: "1" as const,
  };
  const promotionAuthority = createReadyPromotionAuthority(
    () => ({ definitionCatalogRoot: h("definitions"), policy }),
    readyBindingPortForReleaseApproval(approval),
  );
  let durable = createSqliteDurableStore(filename);
  try {
    await source.freezeView();
    const releaseBinding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
    const checkpoint = new CheckpointStore(
      durable,
      source,
      {},
      promotionAuthority,
      service.validationAuthority,
      createCandidatePartitionProofIssuerFixture(releaseBinding),
      checkpointSixStepArtifacts(),
      partitionBootstrap,
    );
    const recent = recentObservation(candidate);
    const discovery = await qualifiedUniV2RecentNomination({
      sourcePlan: recentSourcePlan,
      recent,
      releaseBinding,
    });
    assert.deepEqual(discovery.candidates, [candidate]);
    const root = await checkpoint.loadAndValidateRoot();
    const run = await checkpoint.beginNewRunAndPersistPartition({
      expectedRootRevision: root.revision,
      parentGenerationId: root.readyGenerationId,
      cutoff,
      recentObservation: recent,
      definitionCatalogRoot: h("definitions"),
      sourcePlanEvidence: discovery.sourcePlanEvidence,
      sourceCoverage: discovery.sourceCoverage,
      sourceExecutionSet: discovery.sourceExecutionSet,
      nominationClosure: discovery.nominationClosure,
      candidates: discovery.candidates,
      recentRawEvidenceLocators: [rawEvidenceLocator],
      sourcePlanRawEvidenceLocators: discovery.sourcePlanRawEvidenceLocators,
    });

    const session = service.openRunSession({ candidatePartition: run.candidatePartition });
    const identityResult = await session.resolveIdentityOrReuseProofOnce(candidate.familyCandidateKey, new AbortController().signal);
    assert.equal(identityResult.kind, "identityVerified");
    if (identityResult.kind !== "identityVerified") throw new Error("UniV2 identity did not verify through Attestation");
    const identityWriter = checkpoint.createOutcomeWriter(run.runId, {
      writerCapability: session.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await identityWriter.enqueue(identityResult.persistenceCapability);
    await identityWriter.closeAfterAllProducersAndFlush();
    assert.equal(durable.listIndex(`partial-outcome/${run.runId}`).length, 1);

    // Simulate a process restart. The next service receives only the current
    // authority and the opaque capability rehydrated by checkpoint.
    durable.close();
    durable = createSqliteDurableStore(filename);
    const restartedBootstrap = createCandidatePartitionBootstrap();
    const restartedService = createService(
      lifecycle,
      approval,
      candidatePartitionBootstrapReader(restartedBootstrap),
    );
    const restartedCheckpoint = new CheckpointStore(
      durable,
      source,
      {},
      promotionAuthority,
      restartedService.validationAuthority,
      createCandidatePartitionProofIssuerFixture(releaseBinding),
      checkpointSixStepArtifacts(),
      restartedBootstrap,
    );
    const restartedRun = await restartedCheckpoint.loadRun(run.runId);
    const resume = await restartedCheckpoint.loadAttestationResumeCapabilities(run.runId);
    const resumeCapabilities = resume.identity;
    assert.equal(resumeCapabilities.length, 1);
    const resumedSession = restartedService.openRunSession({
      candidatePartition: restartedRun.candidatePartition,
      identityResumeCapabilities: resumeCapabilities,
    });
    const resumedIdentity = await resumedSession.resolveIdentityOrReuseProofOnce(candidate.familyCandidateKey, new AbortController().signal);
    assert.equal(resumedIdentity.kind, "identityVerified");
    if (resumedIdentity.kind !== "identityVerified") throw new Error("UniV2 identity resume did not verify");
    const finalResult = await resumedSession.materializeAndProjectOnce(
      resumedIdentity.continuation,
      new AbortController().signal,
    );
    assert.equal(finalResult.outcome.kind, "verified", JSON.stringify(finalResult.outcome));
    if (finalResult.outcome.kind !== "verified") throw new Error("UniV2 lifecycle did not verify through Attestation");
    const finalWriter = restartedCheckpoint.createOutcomeWriter(run.runId, {
      writerCapability: resumedSession.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await finalWriter.enqueue(finalResult.persistenceCapability);
    await finalWriter.closeAfterAllProducersAndFlush();
    assert.equal(durable.listIndex(`partial-outcome/${run.runId}`).length, 0);
    const attestedPartition = resumedSession.sealExactPartition([finalResult.persistenceCapability.outcomeHash]);
    const sealedRun = await restartedCheckpoint.sealAttestationPartition(run.runId, attestedPartition);
    assert.ok(sealedRun);
    resume.claim.commit();

    const outcomeStorageHash = durable.readIndex(`outcome/${run.runId}`, candidate.familyCandidateKey);
    assert.ok(outcomeStorageHash);
    const outcomeRecord = durable.readContent(outcomeStorageHash);
    assert.ok(outcomeRecord);
    const persistedOutcome = restartedService.validationAuthority.validateDurableOutcome(
      decodeCanonicalJson(outcomeRecord.bytes),
      {
        runId: run.runId,
        cutoff,
        candidatePartitionRoot: restartedRun.candidatePartitionBinding.candidatePartitionRoot,
        candidate,
      },
    );
    assert.equal(persistedOutcome.kind, "verified");
    if (persistedOutcome.kind !== "verified") throw new Error("persisted UniV2 outcome did not verify");
    const catalog = sealInstanceCatalog(cutoff, [persistedOutcome.publication]);
    const graph = buildPersistedGraph(catalog);
    assert.equal(catalog.instanceCount, "1");
    assert.equal(graph.edgeCount, String(persistedOutcome.publication.transitions.length));
    assert.ok(graph.graphRoot.startsWith("0x"));
  } finally {
    durable.close();
    journalStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generated composition rejects a definition set that is not the exact five named imports", () => {
  const descriptor = generatedDescriptor();
  const family = descriptor.families[0]!;
  const binding: FamilyRuntimeAuthorityBindingV1 = {
    familyId: asFamilyId(UNIV2_STANDARD_FAMILY_ID),
    familyDefinitionHash: family.entry.familyDefinitionHash,
    releaseAuthorityRoot: h("release-authority"),
    programAuthorityHash: h("program-authority"),
    executorAuthorityRoot: h("executor-authority"),
    workerEpoch: "epoch-1",
    executorSessionHash: h("executor-session"),
  };
  assert.throws(
    () => createGeneratedFamilyRuntimeComposition({
      descriptor,
      authorities: [{ familyDefinitionHash: family.entry.familyDefinitionHash, definitionBindingRoot: family.stageDefinitionRoot, binding, executors: executorSet(binding) }],
      definitions: [[...UNIV2_STANDARD_STAGE_DEFINITIONS].map((definition, index) => index === 1 ? UNIV2_STANDARD_STAGE_DEFINITIONS[0]! : definition)],
      extensions: [family.extensions.map(extension => extension.exportName === "UNIV2_STANDARD_STATE_PORT" ? UNIV2_STANDARD_STATE_PORT : extension.exportName === "UNIV2_STANDARD_COARSE_PORT" ? UNIV2_STANDARD_COARSE_PORT : UNIV2_STANDARD_EXACT_PORT)],
      actionOwners: [[UNIV2_STANDARD_SWAP_ACTION_PORT]],
      runtimeAdapters: [family.runtimeAdapters.map(adapter => ({
        factory: UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY,
        modulePath: adapter.modulePath,
        exportName: adapter.exportName,
        closureRoot: adapter.closureRoot,
        leafDigest: adapter.leafDigest,
      }))],
    }),
    /definition stages contain duplicates|stage definition identity mismatch|generated stage ref does not match/,
  );
});

test("generated adapter registry is fail-closed for role, import, closure, and ref mutations", () => {
  const descriptor = generatedDescriptor();
  const family = descriptor.families[0]!;
  const binding: FamilyRuntimeAuthorityBindingV1 = {
    familyId: asFamilyId(UNIV2_STANDARD_FAMILY_ID),
    familyDefinitionHash: family.entry.familyDefinitionHash,
    releaseAuthorityRoot: h("release-authority-mutation"),
    programAuthorityHash: h("program-authority-mutation"),
    executorAuthorityRoot: h("executor-authority-mutation"),
    workerEpoch: "epoch-1",
    executorSessionHash: h("executor-session-mutation"),
  };
  const base = {
    descriptor,
    authorities: [{ familyDefinitionHash: family.entry.familyDefinitionHash, definitionBindingRoot: family.stageDefinitionRoot, binding, executors: executorSet(binding) }],
    definitions: [UNIV2_STANDARD_STAGE_DEFINITIONS],
    extensions: [family.extensions.map(extension => extension.exportName === "UNIV2_STANDARD_STATE_PORT" ? UNIV2_STANDARD_STATE_PORT : extension.exportName === "UNIV2_STANDARD_COARSE_PORT" ? UNIV2_STANDARD_COARSE_PORT : UNIV2_STANDARD_EXACT_PORT)],
    actionOwners: [[UNIV2_STANDARD_SWAP_ACTION_PORT]],
    runtimeAdapters: [family.runtimeAdapters.map(() => UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY)],
  };
  const mutate = (change: (adapter: typeof family.runtimeAdapters[number]) => object) => ({
    ...base,
    descriptor: {
      ...descriptor,
      families: descriptor.families.map(item => ({
        ...item,
        runtimeAdapters: item.runtimeAdapters.map(adapter => ({ ...adapter, ...change(adapter) })),
      })),
    },
  });
  for (const input of [
    mutate(() => ({ role: "search/v2" })),
    mutate(() => ({ modulePath: "families/forged/adapter.ts" })),
    mutate(() => ({ exportName: "forgedFactory" })),
    mutate(() => ({ closureRoot: h("forged-closure") })),
    mutate(adapter => ({ capabilityRefs: { ...adapter.capabilityRefs, state: { ...adapter.capabilityRefs.state, schemaHash: h("forged-schema") } } })),
  ]) {
    assert.throws(() => createGeneratedFamilyRuntimeComposition(input), /descriptor root mismatch|adapter leaf digest mismatch|adapter root mismatch|capability binding mismatch|not release-qualified/);
  }
});

type HttpHandler = (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void | Promise<void>;

function httpBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function startLocalRpc(
  reservesByPool: Readonly<Record<string, string>>,
  head: typeof cutoff,
): Promise<Readonly<{
  endpoint: string;
  callRequests: readonly Record<string, unknown>[];
  canonicalRequests: readonly Record<string, unknown>[];
  recentRpcFacts: { headers: number; logs: number };
  setRuntimeHead(head: CanonicalHead): void;
  setRuntimeReserves(reserves: Readonly<Record<string, string>>): void;
  close(): Promise<void>;
}>> {
  const callRequests: Record<string, unknown>[] = [];
  const canonicalRequests: Record<string, unknown>[] = [];
  const recentRpcFacts = { headers: 0, logs: 0 };
  const recentHeaderNumbers = new Set<string>();
  const recentLogBlockHashes = new Set<string>();
  const initialHeadNumber = BigInt(head.number);
  const recentFrom = initialHeadNumber > 49n ? initialHeadNumber - 49n : 0n;
  const observationHash = (number: bigint): Hash => number === initialHeadNumber
    ? head.hash
    : number === initialHeadNumber - 1n
      ? h("evidence-block")
      : h(`observation-block:${number}`);
  let runtimeHead: CanonicalHead = Object.freeze({
    ...head,
    parentHash: observationHash(initialHeadNumber - 1n),
  });
  const runtimeHeadsByNumber = new Map<string, CanonicalHead>([[runtimeHead.number, runtimeHead]]);
  let runtimeReserves = reservesByPool;
  const handler: HttpHandler = async (incoming, outgoing) => {
    const payload = JSON.parse(await httpBody(incoming)) as Record<string, unknown>;
    assert.equal(payload.jsonrpc, "2.0");
    const method = String(payload.method ?? "");
    let result: unknown;
    if (method === "eth_chainId") {
      canonicalRequests.push(payload);
      result = `0x${BigInt(head.chainId).toString(16)}`;
    } else if (method === "eth_getBlockByNumber") {
      canonicalRequests.push(payload);
      const params = payload.params as readonly unknown[];
      const tag = String(params[0]);
      if (tag === "pending") {
        assert.equal(params[1], true);
        result = {
          number: `0x${(BigInt(runtimeHead.number) + 1n).toString(16)}`,
          parentHash: runtimeHead.hash,
          transactions: [],
        };
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
        return;
      }
      assert.equal(params[1], false);
      const number = tag === "latest" ? BigInt(runtimeHead.number) : BigInt(tag);
      const knownRuntimeHead = runtimeHeadsByNumber.get(number.toString());
      assert.ok(tag === "latest" || knownRuntimeHead !== undefined || (number >= recentFrom && number <= initialHeadNumber));
      if (tag !== "latest") {
        recentHeaderNumbers.add(number.toString());
        recentRpcFacts.headers = recentHeaderNumbers.size;
      }
      result = tag === "latest"
        ? {
            number: `0x${number.toString(16)}`,
            hash: runtimeHead.hash,
            parentHash: runtimeHead.parentHash,
            stateRoot: runtimeHead.stateRoot,
          }
        : knownRuntimeHead !== undefined
          ? {
              number: `0x${number.toString(16)}`,
              hash: knownRuntimeHead.hash,
              parentHash: knownRuntimeHead.parentHash,
              stateRoot: knownRuntimeHead.stateRoot,
            }
        : {
            number: `0x${number.toString(16)}`,
            hash: observationHash(number),
            parentHash: number === 0n ? h("genesis-parent") : observationHash(number - 1n),
            stateRoot: number === initialHeadNumber ? head.stateRoot : h(`observation-state:${number}`),
          };
    } else if (method === "eth_getLogs") {
      canonicalRequests.push(payload);
      const params = payload.params as readonly Record<string, unknown>[];
      const blockHash = typeof params[0]?.blockHash === "string" ? params[0].blockHash : null;
      if (blockHash === null) {
        result = [];
      } else {
        recentLogBlockHashes.add(blockHash);
        recentRpcFacts.logs = recentLogBlockHashes.size;
        const evidenceNumber = initialHeadNumber - 1n;
        result = blockHash === observationHash(evidenceNumber)
          ? Object.keys(reservesByPool).sort().map((poolAddress, index) => ({
              address: poolAddress,
              topics: [UNIV2_SYNC_EVENT_TOPIC0],
              data: "0x",
              blockNumber: `0x${evidenceNumber.toString(16)}`,
              blockHash,
              transactionHash: h(`evidence-tx:${index}`),
              logIndex: `0x${index.toString(16)}`,
              removed: false,
            }))
          : [];
      }
    } else if (method === "eth_call") {
      const params = payload.params as readonly Record<string, unknown>[];
      const data = params[0]?.data;
      if (typeof params[1] === "string") {
        canonicalRequests.push(payload);
        assert.equal(params[1], `0x${initialHeadNumber.toString(16)}`);
        assert.ok(
          data === "0x956aae3a" || data === "0x93656c17" || data === "0x8d654023",
          `unexpected complete-snapshot discovery selector ${String(data)}`,
        );
        result = `0x${word(0n)}`;
      } else {
        callRequests.push(payload);
        assert.equal(params[1]?.requireCanonical, true);
        assert.equal(params[1]?.blockHash, runtimeHead.hash);
        assert.equal(data, UNIV2_GET_RESERVES_SELECTOR);
        const target = String(params[0]?.to ?? "").toLowerCase();
        result = runtimeReserves[target];
        if (result === undefined) {
          outgoing.writeHead(500, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "unknown pool" } }));
          return;
        }
      }
    } else {
      throw new Error(`unexpected local Reth method ${method}`);
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
  };
  const server = createServer((incoming, outgoing) => { void handler(incoming, outgoing); });
  // The fixed 100-head test performs CPU-only raw-observer mutations before
  // the final acceptance sweep. Keep the local RPC socket alive across that
  // deliberate gap instead of racing Node's five-second server default.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const serverAddress = server.address();
  if (serverAddress === null || typeof serverAddress === "string") throw new Error("local RPC did not bind");
  let closed = false;
  return Object.freeze({
    endpoint: `http://127.0.0.1:${serverAddress.port}`,
    callRequests,
    canonicalRequests,
    recentRpcFacts,
    setRuntimeHead(nextHead) {
      runtimeHead = Object.freeze({ ...nextHead });
      runtimeHeadsByNumber.set(runtimeHead.number, runtimeHead);
    },
    setRuntimeReserves(nextReserves) {
      runtimeReserves = nextReserves;
    },
    async close() {
      if (closed) return;
      closed = true;
      server.close();
      await once(server, "close");
    },
  });
}

function rawEd25519PublicKeyHex(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): `0x${string}` {
  const der = publicKey.export({ format: "der", type: "spki" });
  return `0x${Buffer.from(der).subarray(-32).toString("hex")}`;
}

function runtimeFixturePool(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("runtime fixture program input is invalid");
  const payload = input as Record<string, unknown>;
  if (payload.kind === "family-identity-input") {
    return String((payload.nomination as Record<string, unknown>).pool).toLowerCase();
  }
  const identity = payload.identity as Record<string, unknown> | undefined;
  const memo = identity?.identity as Record<string, unknown> | undefined;
  const facts = memo?.facts as Record<string, unknown> | undefined;
  if (typeof facts?.pool === "string") return facts.pool.toLowerCase();
  throw new TypeError(`runtime fixture cannot resolve pool for ${String(payload.kind)}`);
}

function externallyPackagedVerticalComposition(
  discoveryEndpoint: string,
  bundleModulePath: string,
) {
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1("univ2-integration");
  const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1("univ2-integration");
  const family = metadata.families[0];
  if (family === undefined || !metadata.families.some(entry => entry.familyId === UNIV2_STANDARD_FAMILY_ID)) {
    throw new Error("generated release factory does not contain UniV2 Family");
  }
  const gateCore = evaluateQualifiedReleaseDenominatorFixture();
  const certificate = gateCore.result.certificate;
  const selectedExecutor = Object.freeze({
    executorKind: "revm",
    engineBuildFingerprint: h("vertical-revm-engine"),
    executableFingerprint: h("vertical-revm-executable"),
    closureFingerprint: h("vertical-revm-closure"),
    protocolFingerprint: h("vertical-revm-protocol"),
    schemaFingerprint: h("vertical-revm-schema"),
    releaseRoleManifestRoot: certificate.releaseRoleManifestRoot,
    candidateCommit: certificate.candidateReleaseCommit,
  });
  const proposedCapabilitySet = generatedProposedCapabilitySet();
  if (proposedCapabilitySet.root !== metadata.proposedCapabilitySetRoot) {
    throw new TypeError("generated Family metadata and proposed capability set root mismatch");
  }
  const nominationQualificationSet = testNominationQualificationSet(
    metadata.nominationProgramProposalLeafDigests,
  );
  const entrypointPath = realpathSync(resolve(repositoryRoot, "apps/searcher-runtime/src/cli.ts"));
  const nodeExecutablePath = realpathSync(process.execPath);
  const entrypointSha256 = sha256Hex(readFileSync(entrypointPath));
  const nodeExecutableSha256 = sha256Hex(readFileSync(nodeExecutablePath));
  const bundleModuleSha256 = sha256Hex(readFileSync(bundleModulePath));
  const searcherRuntime = Object.freeze({
    runtimeArtifactRoot: hashCanonicalPartition("aloha/test/offline-searcher-runtime-artifacts/v1", [
      nodeExecutableSha256,
      entrypointSha256,
      bundleModuleSha256,
    ].sort()),
    implementationClosureDigest: hashDomain("aloha/test/offline-searcher-runtime-closure/v1", {
      entrypointPath,
      entrypointSha256,
      bundleModulePath,
      bundleModuleSha256,
    }),
    nodeExecutableSha256,
    entrypointSha256,
    bundleModulePath,
    bundleModuleSha256,
  });
  const discoverySourceQualification = createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: "reth-mainnet",
    backendEpoch: "reth-backend-1",
    profile: "reth-json-rpc-v1",
    chainId: "1",
    endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1(discoveryEndpoint),
    qualificationRoot: h("vertical-discovery-source-qualification"),
  });
  const { approval: releaseApproval } = verifyReleaseRequirementDenominatorV1(
    gateCore.externalQualifications,
  );
  const payload: RuntimeReleaseBindingPayloadV1 = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.runtime-release-binding",
    releaseAuthorityApprovalId: releaseApproval.approvalId,
    releaseAuthorityApprovalPayloadHash: releaseApproval.payloadHash,
    releaseAcceptanceRequirementSetRoot: releaseApproval.releaseAcceptanceRequirementSetRoot,
    externalTrustAnchorRoot: releaseApproval.externalTrustAnchorRoot,
    externalIssuerKeySetRoot: releaseApproval.issuerKeySetRoot,
    qualificationRegistryApprovalId: releaseApproval.registryApprovalId,
    qualificationRegistryRoot: releaseApproval.registryRoot,
    qualificationEpoch: releaseApproval.epoch,
    qualificationAudienceHash: releaseApproval.audienceHash,
    predicateCompositionRootDigest: releaseApproval.predicateCompositionRootDigest,
    gateCoreRuntimeClosureDigest: releaseApproval.gateCoreRuntimeClosureDigest,
    gateCoreImplementationClosureDigest: releaseApproval.gateCoreImplementationClosureDigest,
    searcherRuntime,
    discoverySourceQualification,
    qualifiedExecutorRegistry: [selectedExecutor],
    qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([selectedExecutor]),
    valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
    valuationOwnerQualificationCertificates: valuationQualification.certificates,
    qualifiedValuationOwnerSetRoot: valuationQualification.root,
    actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
    actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
    qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
    safetyProfile: actionOwnerQualification.profile,
    safetyProfileRoot: actionOwnerQualification.profileRoot,
    qualifiedCapabilityRefsRoot: proposedCapabilitySet.root,
    nominationProgramSetRoot: nominationQualificationSet.programSetRoot,
    nominationQualificationSet,
    nominationQualificationSetRoot: nominationQualificationSet.root,
    selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(selectedExecutor),
    selectedExecutor,
    releaseRoleManifestRoot: releaseApproval.releaseRoleManifestRoot,
    candidateReleaseCommit: releaseApproval.candidateReleaseCommit,
    workerEpoch: "vertical-epoch",
    executorSessionHash: h("vertical-executor-session"),
    frameworkAuthorityRoot: h("vertical-framework-authority"),
    executorAuthorityRoot: h("vertical-executor-authority"),
    releaseAuthorityRoot: h("vertical-release-authority"),
    attestationProofIssuerKeyId: TEST_ATTESTATION_PROOF_KEY_ID,
    candidatePartitionProofIssuerKeyId: TEST_CANDIDATE_PARTITION_PROOF_KEY_ID,
  });
  const signer = generateKeyPairSync("ed25519");
  const signerKeyId = h("vertical-external-runtime-release-signer");
  const signerPin = Object.freeze({
    signerKeyId,
    publicKeyHex: rawEd25519PublicKeyHex(signer.publicKey),
  });
  const signatureHex = `0x${sign(
    null,
    Buffer.from(runtimeReleaseBindingSigningBytes(payload, signerKeyId)),
    signer.privateKey,
  ).toString("hex")}` as `0x${string}`;
  const verifyPayload = (value: RuntimeReleaseBindingPayloadV1) => verifyRuntimeReleaseBindingSignatureV1(
    createRuntimeReleaseBindingV1(value, signerKeyId, signatureHex),
    signerPin,
  );
  assert.throws(
    () => verifyPayload({
      ...payload,
      releaseAuthorityApprovalPayloadHash: h("foreign-release-authority-approval-payload"),
    }),
    /signature invalid/,
    "a release authority approval splice must invalidate the external signature",
  );
  assert.throws(
    () => verifyPayload({
      ...payload,
      searcherRuntime: {
        ...payload.searcherRuntime,
        bundleModuleSha256: h("foreign-deployment-bundle"),
      },
    }),
    /signature invalid/,
    "a searcher runtime artifact splice must invalidate the external signature",
  );
  const foreignNominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1(
    payload.nominationQualificationSet.entries.map((entry, index) => ({
      proposalLeafDigest: entry.proposalLeafDigest,
      criticalMutationCorpusRoot: index === 0
        ? h("foreign-nomination-mutation-corpus")
        : entry.criticalMutationCorpusRoot,
      independentOracleCaseRoot: entry.independentOracleCaseRoot,
      qualificationSpecDigest: entry.qualificationSpecDigest,
      verifierQualificationCertificateRoot: entry.verifierQualificationCertificateRoot,
    })),
  );
  assert.throws(
    () => verifyPayload({
      ...payload,
      nominationProgramSetRoot: foreignNominationQualificationSet.programSetRoot,
      nominationQualificationSet: foreignNominationQualificationSet,
      nominationQualificationSetRoot: foreignNominationQualificationSet.root,
    }),
    /signature invalid/,
    "a nomination qualification splice must invalidate the external signature",
  );
  const externallyVerifiedBinding = verifyPayload(payload);
  const authority = verifyAndIssueRuntimeReleaseAuthorityV1(externallyVerifiedBinding, signerPin);
  const release = authority.resolver.resolve(authority.capability);
  const approval = testAttestationCompositionForRuntimeAuthority(authority);
  assert.equal(release.releaseAuthorityApprovalId, certificate.releaseAuthorityApprovalId);
  assert.equal(release.qualifiedExecutorRegistryRoot, hashQualifiedExecutorRegistryRoot([selectedExecutor]));
  assert.equal(release.nominationQualificationSetRoot, nominationQualificationSet.root);
  assert.equal(release.searcherRuntime.bundleModuleSha256, bundleModuleSha256);
  const schedulerCapability = Object.freeze(Object.create(null)) as QualifiedExecutorAuthorityCapability;
  const schedulerProvenance = Object.freeze({
    authorityRoot: release.executorAuthorityRoot,
    workerEpoch: release.workerEpoch,
    executorSession: release.executorSessionHash,
    version: 1,
  });
  const schedulerIssuer = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: release.qualifiedExecutorRegistryRoot,
    authorityRoot: release.executorAuthorityRoot,
    open: () => schedulerCapability,
    rotate: () => schedulerCapability,
    revoke: () => undefined,
    assert: (value: object) => {
      if (value !== schedulerCapability) throw new TypeError("unknown vertical executor capability");
      return schedulerProvenance;
    },
    provenance: (value: object) => {
      if (value !== schedulerCapability) throw new TypeError("unknown vertical executor capability");
      return schedulerProvenance;
    },
  }));
  const schedulerRuntime = issueQualifiedSharedSchedulerRuntimePort({
    scheduler: new WorkScheduler(),
    issuer: schedulerIssuer,
    capability: schedulerCapability,
  });
  const physicalExecution = issueQualifiedPhysicalExecutionPort({
    issuer: schedulerIssuer,
    capability: schedulerCapability,
    schedulerRuntime,
    async execute({ intent }) {
      const payload = intent.programInput as { readonly requestIds?: readonly Hash[]; readonly requestId?: Hash; readonly kind?: string };
      const requestIds = payload.requestIds ?? (payload.requestId === undefined ? [] : [payload.requestId]);
      const candidatePool = runtimeFixturePool(payload);
      const identityData = [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(candidatePool), addressWord(candidatePool)];
      const reservesData = candidatePool === pool
        ? `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`
        : candidatePool === poolB
          ? `0x${word(2_000_000n)}${word(1_000_000n)}${word(42n)}`
          : (() => { throw new TypeError("runtime fixture pool is unknown"); })();
      return Object.freeze(requestIds.map((requestId, index) => Object.freeze({
        kind: "returned" as const,
        requestId,
        dataHex: payload.kind === "family-identity-input" ? identityData[index]! : reservesData,
      })));
    },
  });
  const execution = createSchedulerOwnedFamilyExecutionPort({
    issuer: schedulerIssuer,
    capability: schedulerCapability,
    physicalExecution,
  });
  const capability = issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
    authority,
    execution,
    createReleaseFamilyRuntimeComposition,
  );
  return Object.freeze({
    composition: createReleaseFamilyRuntimeComposition(capability),
    metadata,
    approval,
    authority,
    binding: release,
    gateCoreCertificate: certificate,
    schedulerIssuer,
    schedulerCapability,
    schedulerRuntime,
    physicalExecution,
    familyRuntime: Object.freeze({
      openComposition: () => createReleaseFamilyRuntimeComposition(capability),
    }),
  });
}

type FixtureItem =
  | { readonly kind: "label"; readonly name: string }
  | { readonly bytes: readonly number[]; readonly ref?: string };

function push1(value: number): FixtureItem {
  return { bytes: [0x60, value & 0xff] };
}

function push32(value: string): FixtureItem {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("fixture PUSH32 value must be 32 bytes");
  return { bytes: [0x7f, ...Buffer.from(value.slice(2), "hex")] };
}

function push4(value: string): FixtureItem {
  if (!/^0x[0-9a-fA-F]{8}$/.test(value)) throw new Error("fixture PUSH4 value must be four bytes");
  return { bytes: [0x63, ...Buffer.from(value.slice(2), "hex")] };
}

function pushLabel(name: string): FixtureItem {
  return { bytes: [0x60, 0], ref: name };
}

function fixtureAddressWord(value: string): string {
  return `0x${"0".repeat(24)}${value.slice(2).toLowerCase()}`;
}

function assembleFixture(items: readonly FixtureItem[]): string {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const item of items) {
    if ("kind" in item) {
      if (labels.has(item.name)) throw new Error(`duplicate fixture label ${item.name}`);
      labels.set(item.name, offset);
    } else {
      offset += item.bytes.length;
    }
  }
  const bytes: number[] = [];
  for (const item of items) {
    if ("kind" in item) continue;
    const encoded = [...item.bytes];
    if (item.ref !== undefined) {
      const destination = labels.get(item.ref);
      if (destination === undefined || destination > 0xff) throw new Error(`fixture label ${item.ref} is out of PUSH1 range`);
      encoded[encoded.length - 1] = destination;
    }
    bytes.push(...encoded);
  }
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function strictTokenCode(expectedRecipient: string): string {
  return assembleFixture([
    push1(0x44), { bytes: [0x36, 0x14, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push1(0), { bytes: [0x35] }, push1(224), { bytes: [0x1c] }, push4("0xa9059cbb"), { bytes: [0x14, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push32(fixtureAddressWord(expectedRecipient)), push1(4), { bytes: [0x35, 0x14, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push1(0), push1(36), { bytes: [0x35, 0x11, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push1(1), push1(0), { bytes: [0x52] }, push1(32), push1(0), { bytes: [0xf3] },
    { kind: "label", name: "invalid" }, { bytes: [0x5b, 0x60, 0, 0x60, 0, 0xfd] },
  ]);
}

function strictPairCode(expectedRecipient: string): string {
  return assembleFixture([
    push1(0xa4), { bytes: [0x36, 0x14, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push1(0), { bytes: [0x35] }, push1(224), { bytes: [0x1c] }, push4("0x022c0d9f"), { bytes: [0x14, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push32(fixtureAddressWord(expectedRecipient)), push1(68), { bytes: [0x35, 0x14, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push1(0), push1(4), { bytes: [0x35, 0x11] },
    push1(0), push1(36), { bytes: [0x35, 0x11, 0x17, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push32(`0x${word(128n)}`), push1(100), { bytes: [0x35, 0x14, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push1(132), { bytes: [0x35] }, push1(0), { bytes: [0x14, 0x15] }, pushLabel("invalid"), { bytes: [0x57] },
    push1(0), push1(0), { bytes: [0xf3] },
    { kind: "label", name: "invalid" }, { bytes: [0x5b, 0x60, 0, 0x60, 0, 0xfd] },
  ]);
}

function patchedExecutorRuntimeCode(owner: string): string {
  const artifactPath = resolve(repositoryRoot, "contracts/out/AlohaCallExecutor.sol/AlohaCallExecutor.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    readonly deployedBytecode: {
      readonly object: string;
      readonly immutableReferences?: Readonly<Record<string, readonly { readonly start: number; readonly length: number }[]>>;
    };
  };
  let body = artifact.deployedBytecode.object.slice(2);
  const ownerWord = owner.slice(2).padStart(64, "0");
  for (const references of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const reference of references) {
      if (reference.length !== 32) throw new Error("unexpected executor immutable width");
      const start = reference.start * 2;
      body = `${body.slice(0, start)}${ownerWord}${body.slice(start + reference.length * 2)}`;
    }
  }
  return `0x${body}`;
}

function fixtureRuntimeCode(contractName: "EconomicSafetyTokenFixture" | "EconomicSafetyPairFixture"): string {
  const artifactPath = resolve(repositoryRoot, `contracts/out/EconomicSafetyFixtures.sol/${contractName}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { readonly deployedBytecode: { readonly object: string } };
  return artifact.deployedBytecode.object.startsWith("0x") ? artifact.deployedBytecode.object : `0x${artifact.deployedBytecode.object}`;
}

const executorBalanceSlot = "0xd0d045a07f9a74a2c48a464add9b06f25f501dbdf5bd4dd5a7489f86f449adda";
const poolABalanceSlot = "0xf043c50fe795c69f30b8ff78b84032dc53a9d87ca283ae10a1dacfbb648e83ef";
const poolBBalanceSlot = "0x6cf371e1ca35ebabdfe944c65642deafa5ee08c43b49c6c3b521e4cc1c994c9a";
const pairToken0Slot = `0x${word(0n)}`;
const pairToken1Slot = `0x${word(1n)}`;

function amountWord(calldata: string, index: number): bigint {
  const body = calldata.slice(2);
  return BigInt(`0x${body.slice(8 + index * 64, 8 + (index + 1) * 64)}`);
}

function addressWordFromCalldata(calldata: string, index: number): string {
  const body = calldata.slice(2);
  return `0x${body.slice(8 + index * 64 + 24, 8 + (index + 1) * 64)}`;
}

function generatedProposedCapabilitySet() {
  const input = JSON.parse(readFileSync(resolve(repositoryRoot, "generated/catalog-generation.inputs.json"), "utf8")) as {
    readonly proposedCapabilitySet: unknown;
  };
  return decodeReleaseQualifiedCapabilitySetV1(input.proposedCapabilitySet);
}

function qualifiedCapabilityProjection(binding: RuntimeReleaseBindingV1) {
  const set = generatedProposedCapabilitySet();
  return decodeRuntimeReleaseQualifiedCapabilityProjectionV1({
    schemaVersion: 1,
    kind: "aloha.runtime-release-qualified-capability-projection",
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    qualifiedCapabilityRefsRoot: set.root,
    refs: set.refs,
  });
}

/**
 * Build an offline structural release composition. The binding must travel
 * through GateCore qualification, the external packager, an external Ed25519
 * signature and candidate-side verification before runtime owners can use it.
 * Test-only proof issuers remain explicit, so this path never claims
 * production/live acceptance credit.
 */
async function createOfflineStructuralUniV2Services(
  cutoffView: typeof cutoff,
  reservesByPool: Readonly<Record<string, string>>,
) {
  const directory = mkdtempSync(join(tmpdir(), "aloha-univ2-offline-structural-lineage-"));
  const rpc = await startLocalRpc(reservesByPool, cutoffView);
  const bundleModulePath = join(directory, "deployment-bundle.mjs");
  const bundleModuleBytes = new TextEncoder().encode("export const offlineStructuralOnly = true;\n");
  writeFileSync(bundleModulePath, bundleModuleBytes);
  const released = externallyPackagedVerticalComposition(rpc.endpoint, realpathSync(bundleModulePath));
  const { authority, binding } = released;
  const runtimeAnchor = Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1" as const,
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    manifestHash: h("vertical-manifest"),
    manifestArtifactSha256: h("vertical-manifest-artifact"),
    runtimeArtifactRoot: h("vertical-runtime"),
    implementationClosureDigest: h("vertical-closure"),
    candidateReleaseCommit: binding.candidateReleaseCommit,
    entrypointSha256: h("vertical-entrypoint"),
    nodeExecutableSha256: h("vertical-node"),
    bundleModulePath: "/opt/aloha/release.mjs",
    bundleModuleSha256: h("vertical-bundle"),
    serviceName: "aloha-searcher",
    systemdUnit: "aloha-searcher.service",
    bootId: "boot-vertical",
    invocationId: "invocation-vertical",
    logDevice: "8",
    logInode: "9",
    pid: "42",
    processStartTicks: "7",
    dryRun: true,
  });
  const descriptor = generatedDescriptor();
  const caller = address("6");
  const objectivePayload = {
    numeraireAssetRef: erc20AssetRefV1(cutoffView.chainId, token0),
    minNetGain: "1",
    maxGas: "1000000",
    maxValueAtRisk: "100",
  } as const;
  const objective = { objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload };
  let runtimeSource: RethSearcherRuntimeSourceV1 | null = null;
  let durable: ReturnType<typeof createSqliteDurableStore> | null = null;
  try {
    runtimeSource = createRethSearcherRuntimeSourceV1({
      canonical: {
        profile: "reth-json-rpc-v1",
        endpoint: rpc.endpoint,
        chainId: cutoffView.chainId,
        journalPath: join(directory, "canonical-journal.sqlite"),
      },
      ingress: {
        profile: "reth-json-rpc-v1",
        endpoint: rpc.endpoint,
        pending: "public-pending-v1",
        blockscan: {
          objective,
          callerId: caller,
          deadlineMs: 20_000,
          admission: { topK: 4, boundedUnrankedBudget: 0 },
        },
      },
    });
    durable = createSqliteDurableStore(join(directory, "checkpoint.sqlite"));
    const ownedRuntimeSource = runtimeSource;
    const ownedDurable = durable;
    const canonical = ownedRuntimeSource.canonical;

    const selected = binding.selectedExecutor;
    const workerQualification: RevmWorkerQualification = Object.freeze({
      engineBuildFingerprint: selected.engineBuildFingerprint,
      executableFingerprint: selected.executableFingerprint,
    });
    const deploymentPort = issueRuntimeReleaseRevmWorkerDeploymentPort(
      authority,
      issueRevmWorkerDeploymentPort({
      factory: createNodeRevmWorkerFactory({
        command: resolve(repositoryRoot, "runtime/revm-worker-rust/target/debug/aloha-revm-worker"),
        args: ["--worker-epoch", binding.workerEpoch],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          REVM_ENGINE_BUILD_FINGERPRINT: workerQualification.engineBuildFingerprint,
          REVM_EXECUTABLE_BUILD_FINGERPRINT: workerQualification.executableFingerprint,
          REVM_EXECUTABLE_FINGERPRINT: workerQualification.executableFingerprint,
        },
        qualification: workerQualification,
      }),
      qualification: workerQualification,
      selectedExecutor: binding.selectedExecutor,
      selectedExecutorLeafHash: binding.selectedExecutorLeafHash,
      qualifiedExecutorRegistryRoot: binding.qualifiedExecutorRegistryRoot,
      }),
    );

    const policy = Object.freeze({
      observationWindowBlocks: "50" as const,
      targetRefreshAgeBlocks: "199",
      maxServingAgeBlocks: "200",
      minPromotionMarginBlocks: "2",
      maxInProgressRuns: "1" as const,
    });
    const qualifiedSource = issueRuntimeReleaseQualifiedDiscoverySourcePort(authority, {
      profile: "reth-json-rpc-v1",
      endpoint: rpc.endpoint,
      chainId: cutoffView.chainId,
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-1",
    });
    const providerRoot = readRuntimeReleaseQualifiedDiscoverySourcePort(authority, qualifiedSource).sourceAuthorityRoot;
    const processors = cpus();
    const hardwareProfile = createHardwareProfileObservationV1({
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      availableParallelism: availableParallelism().toString(),
      logicalCpuCount: processors.length.toString(),
      cpuModelSetRoot: hashDomain("aloha/hardware-profile-cpu-model-set/v1", [...new Set(processors.map(cpu => cpu.model))].sort()),
      totalMemoryBytes: totalmem().toString(),
    });
    const performanceProfile = DEFAULT_PRODUCTION_PERFORMANCE_PROFILE;
    const performanceBasis = createDeploymentPerformanceWindowBasisV1({
      bindingId: binding.bindingId,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
      candidateReleaseCommit: binding.candidateReleaseCommit,
      performanceProfileHash: performanceProfile.profileHash,
      eligibilityRuleHash: PERFORMANCE_ELIGIBILITY_RULE_HASH,
      targetCount: "100",
      providerRoot,
      hardwareProfileRoot: hardwareProfile.profileRoot,
      commitContextBindingId: h("vertical-performance-commit-context"),
      commitAppendRecordId: h("vertical-performance-commit-append-record"),
    });
    const services = buildRuntimeReleaseComposition({
      authority,
      economicSafetyEvaluator: issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1(
        authority,
        encodeEconomicSafetyObjectiveTemplatesV1([{
          objectiveRef: objective.objectiveRef,
          profitAsset: erc20AssetReferenceV1(cutoffView.chainId, token0),
          profitAccount: executorAddress,
          minNetGain: objectivePayload.minNetGain,
          maxGas: objectivePayload.maxGas,
          maxValueAtRisk: objectivePayload.maxValueAtRisk,
          priorityFeePerGas: "0",
          bidCostNative: "0",
          valuationOwnerRef: binding.valuationOwnerQualificationCertificates[0]!.ownerRef,
        }]),
      ),
      catalog: { qualifiedCapabilityProjection: qualifiedCapabilityProjection(binding) },
      attestation: {
        proofPort: attestationProofPortForReleaseApproval(released.approval),
      },
      candidatePartitionProofIssuer: createCandidatePartitionProofIssuerFixture(binding),
      checkpoint: { durable, canonical },
      scheduler: {
        issuer: released.schedulerIssuer,
        capability: released.schedulerCapability,
        runtime: released.schedulerRuntime,
        physicalExecution: released.physicalExecution,
      },
      revm: { deploymentPort },
      ready: { policy, monotonicNow: () => "1" },
      performance: {
        policy: issueInstalledRuntimeReleasePerformancePolicyPortV1({
          authority,
          deployment: issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1({
            authority,
            basisBytes: encodeDeploymentPerformanceWindowBasisV1(performanceBasis),
            profileBytes: encodeProductionPerformanceProfile(performanceProfile),
            hardwareBytes: encodeHardwareProfileObservationV1(hardwareProfile),
          }),
        }),
      },
      finalSimulation: {
        endpoint: rpc.endpoint,
        timeoutMs: 5_000,
        executorAddress,
        callerAddress: caller,
        qualifiedExecutorCodeHash: h("offline-structural-executor-code"),
        executorConfig: {},
        accounts: [],
      },
      sixStep: {
        process: {
          systemId: `${runtimeAnchor.serviceName}/${runtimeAnchor.systemdUnit}`,
          commitSha: runtimeAnchor.candidateReleaseCommit,
          executableHash: runtimeAnchor.entrypointSha256,
          deploymentManifestHash: runtimeAnchor.manifestHash,
          serviceIdentityHash: hashDomain("aloha/production-six-step-service-identity/v1", {
            bindingId: runtimeAnchor.bindingId,
            serviceName: runtimeAnchor.serviceName,
            systemdUnit: runtimeAnchor.systemdUnit,
            invocationId: runtimeAnchor.invocationId,
          }),
          pid: runtimeAnchor.pid,
          processStartTicks: runtimeAnchor.processStartTicks,
          bootIdHash: hashDomain("aloha/searcher-runtime-boot-id/v1", runtimeAnchor.bootId),
        },
        emitterCodeHash: runtimeAnchor.implementationClosureDigest,
        observerContentDirectory: join(directory, "six-step-observer-content"),
        evidenceDirectory: join(directory, "six-step-evidence"),
      },
      startup: {
        source: qualifiedSource,
        processEpoch: "vertical-offline-structural-process-epoch",
      },
    });
    let closed = false;
    return Object.freeze({
      services,
      released,
      authority,
      canonical,
      durable: ownedDurable,
      directory,
      binding,
      policy,
      recentRpcFacts: rpc.recentRpcFacts,
      runtimeSource: ownedRuntimeSource,
      rpc,
      caller,
      runtimeAnchor,
      productionEvidence: missingExternalRuntimeAnchorEvidenceV1(),
      async close() {
        if (closed) return;
        closed = true;
        await services.revmPool.retireAll();
        ownedDurable.close();
        ownedRuntimeSource.close();
        await rpc.close();
        rmSync(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    durable?.close();
    runtimeSource?.close();
    await rpc.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test("offline structural release refuses a single-certificate denominator", () => {
  const single = evaluateQualifiedLineageFixture();
  assert.throws(
    () => verifyReleaseRequirementDenominatorV1([single.externalQualification]),
    /denominator|requirement count|qualification|release-role manifest/,
  );
});

test("offline structural release fixture qualifies the exact generated predicate denominator", () => {
  const qualified = evaluateQualifiedReleaseDenominatorFixture();
  const verified = verifyReleaseRequirementDenominatorV1(qualified.externalQualifications);
  assert.equal(
    verified.externalQualifications.length,
    verified.approval.releaseAcceptanceRequirements.length,
  );
});

test("offline structural UniV2 path carries owner-issued Six-Step evidence through the raw observer", async (t) => {
  execFileSync("forge", ["build"], { cwd: resolve(repositoryRoot, "contracts"), stdio: "inherit" });
  execFileSync("cargo", ["build", "--quiet", "--manifest-path", resolve(repositoryRoot, "runtime/revm-worker-rust/Cargo.toml")], { cwd: repositoryRoot, stdio: "inherit" });

  const poolA = pool;
  const poolTwo = poolB;
  const reservesA = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
  const reservesB = `0x${word(2_000_000n)}${word(1_000_000n)}${word(42n)}`;
  const structural = await createOfflineStructuralUniV2Services(cutoff, { [poolA]: reservesA, [poolTwo]: reservesB });
  const { released } = structural;
  const { services, canonical: source, runtimeSource, caller } = structural;
  assert.deepEqual(structural.productionEvidence, {
    schemaVersion: 1,
    kind: "aloha.searcher-production-evidence-status",
    factStatus: "incomplete",
    reasonCode: "external-runtime-anchor-missing",
    runtimeAnchorReceipt: null,
  });
  assert.equal(released.binding.releaseAuthorityApprovalId, released.gateCoreCertificate.releaseAuthorityApprovalId);
  let startup: Awaited<ReturnType<typeof services.startup.startStartup>> | null = null;
  let application: SearcherRuntimeApplicationV1 | null = null;
  let completedHeadCount = 0;
  t.after(async () => {
    try {
      if (application === null) await startup?.close();
      else await application.stop();
    } catch (error) {
      throw new Error(`vertical application cleanup failed after ${completedHeadCount} completed heads`, { cause: error });
    }
    await structural.close();
    released.composition.revoke();
    released.authority.revoke();
  });
  // Initialize the empty durable root through the checkpoint owner. Startup
  // then owns the complete discovery → attestation → promotion choreography.
  await services.checkpoint.loadAndValidateRoot();
  startup = await services.startup.startStartup();
  assert.deepEqual(structural.recentRpcFacts, { headers: 50, logs: 50 }, "startup must observe the exact 50-block window once before promotion");
  const ready = startup.ready;
  const closure = await services.checkpoint.loadReadyClosure(ready);
  const declaredSourcePlanCount = released.metadata.families.reduce((count, family) => count + family.sourcePlanRefs.length, 0);
  assert.equal(closure.sourceCoverage.entries.length, declaredSourcePlanCount);
  const univ2RecentSourcePlan = closure.sourceCoverage.entries.find(entry =>
    entry.familyDefinitionHash === UNIV2_STANDARD_FAMILY_DEFINITION_HASH
    && entry.completeness === "nomination-only");
  assert.ok(univ2RecentSourcePlan);
  assert.equal(univ2RecentSourcePlan.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(univ2RecentSourcePlan.appliedThrough, cutoff.number);
  assert.equal(univ2RecentSourcePlan.contributesOmissionAuthority, false);
  const univ2HistorySourcePlan = closure.sourceCoverage.entries.find(entry =>
    entry.familyDefinitionHash === UNIV2_STANDARD_FAMILY_DEFINITION_HASH
    && entry.completeness === "contiguous-history");
  assert.ok(univ2HistorySourcePlan);
  assert.equal(univ2HistorySourcePlan.from, "0");
  assert.equal(univ2HistorySourcePlan.appliedThrough, cutoff.number);
  assert.equal(univ2HistorySourcePlan.contributesOmissionAuthority, true);
  const graph = closure.graph;
  await startup.withProducerSession(await source.observeCurrentHead(), async session => {
    assert.equal(session.head.hash, cutoff.hash);
    assert.equal(session.lease.binding.graphRoot, graph.graphRoot);
  });
  const executor = executorAddress;
  const tokenCode = fixtureRuntimeCode("EconomicSafetyTokenFixture");
  const pairCode = fixtureRuntimeCode("EconomicSafetyPairFixture");
  const strictAccounts = Object.freeze({
    [caller]: { balance: "0", nonce: "0", code: "0x" },
    [executor]: { balance: "0", nonce: "1", code: patchedExecutorRuntimeCode(caller) },
    [token0]: { balance: "0", nonce: "0", code: tokenCode, storage: {
      [executorBalanceSlot]: `0x${word(100n)}`,
      [poolABalanceSlot]: `0x${word(1_000_000n)}`,
      [poolBBalanceSlot]: `0x${word(2_000_000n)}`,
    } },
    [token1]: { balance: "0", nonce: "0", code: tokenCode, storage: {
      [executorBalanceSlot]: `0x${word(0n)}`,
      [poolABalanceSlot]: `0x${word(2_000_000n)}`,
      [poolBBalanceSlot]: `0x${word(1_000_000n)}`,
    } },
    [poolA]: { balance: "0", nonce: "0", code: pairCode, storage: {
      [pairToken0Slot]: addressWord(token0),
      [pairToken1Slot]: addressWord(token1),
    } },
    [poolTwo]: { balance: "0", nonce: "0", code: pairCode, storage: {
      [pairToken0Slot]: addressWord(token0),
      [pairToken1Slot]: addressWord(token1),
    } },
  });
  const releaseSchedulerIssuer = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(
    released.authority,
    released.schedulerIssuer,
  );
  const revmAuthority = issueRuntimeReleaseRevmWorkerAuthorityIssuer(
    released.authority,
    releaseSchedulerIssuer,
  );
  const workerQualification = Object.freeze({
    engineBuildFingerprint: structural.binding.selectedExecutor.engineBuildFingerprint,
    executableFingerprint: structural.binding.selectedExecutor.executableFingerprint,
    qualifiedExecutorRegistryRoot: structural.binding.qualifiedExecutorRegistryRoot,
    selectedExecutorLeafHash: structural.binding.selectedExecutorLeafHash,
    releaseRoleManifestRoot: structural.binding.selectedExecutor.releaseRoleManifestRoot,
  });
  const finalSimulationScheduler = readQualifiedSharedSchedulerRuntimePort(
    released.schedulerRuntime,
    released.schedulerIssuer,
    released.schedulerCapability,
  );
  let finalSimulationSource: Readonly<Pick<CanonicalHead, "chainId" | "number" | "hash" | "stateRoot">> = cutoff;
  const stateOwner = createRethQualifiedExecutorStateOwner({
    endpoint: "http://reth.vertical.test",
    fetch: (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { readonly id: string; readonly method: string; readonly params: readonly unknown[] };
      const target = typeof request.params[0] === "string" ? request.params[0].toLowerCase() : "";
      let result: unknown;
      if (request.method === "eth_getBlockByHash") {
        assert.equal(request.params[0], finalSimulationSource.hash);
        result = {
          hash: finalSimulationSource.hash,
          number: `0x${BigInt(finalSimulationSource.number).toString(16)}`,
          stateRoot: finalSimulationSource.stateRoot,
          timestamp: "0x7",
          gasLimit: "0x1c9c380",
          baseFeePerGas: "0x0",
          miner: address("4"),
          mixHash: h("vertical-mix"),
        };
      } else if (request.method === "eth_getBalance") {
        result = "0x0";
      } else if (request.method === "eth_getTransactionCount") {
        result = strictAccounts[target as keyof typeof strictAccounts]?.nonce === "1" ? "0x1" : "0x0";
      } else if (request.method === "eth_getCode") {
        result = strictAccounts[target as keyof typeof strictAccounts]?.code ?? "0x";
      } else if (request.method === "eth_getStorageAt") {
        const slot = String(request.params[1] ?? "").toLowerCase();
        result = (strictAccounts[target as keyof typeof strictAccounts] as { readonly storage?: Readonly<Record<string, string>> } | undefined)?.storage?.[slot] ?? `0x${word(0n)}`;
      } else {
        throw new Error(`unexpected Reth state method ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  const observedPrograms = new Map<Hash, Readonly<{ programHash: Hash; programBytes: string }>>();
  const runtimeSessionIds = new Set<Hash>();
  const rpcRequests = structural.rpc.callRequests;
  const strategyRuntime = services.strategyRuntime;
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "aloha-univ2-production-evidence-"));
  t.after(() => rmSync(evidenceDirectory, { recursive: true, force: true }));
  const evidencePath = join(evidenceDirectory, "production-evidence.sqlite");
  const evidence = issueSearcherProductionEvidenceOwnerV1({
    databasePath: evidencePath,
    economicSafety: services.economicSafety,
    strategyRuntime,
    release: {
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
    },
    runtimeAnchor: structural.runtimeAnchor,
  });
  const observerStoreCapability = services.observerStore.issueObserverStore({
    directory: join(structural.directory, "six-step-observer-content"),
  });
  const observerSink = readReleaseOwnedObserverStoreV1(observerStoreCapability).sink;
  const terminalLocatorIndex = new ProductionTerminalPhaseLocatorIndexV1({
    directory: join(evidenceDirectory, "observer-store/terminal-locators"),
    sink: observerSink,
  });
  const fullFamilyObservation = issueProductionFullFamilyCollectorPortV1({
    releaseIntentCanonicalBytes: encodeCanonicalBytes(currentCatalogInput(repositoryRoot).releaseIntent),
    familyCatalogSourceBytes: new Uint8Array(readFileSync(resolve(repositoryRoot, "generated/family-catalog/index.ts"))),
    runtimeCompositionSourceBytes: new Uint8Array(readFileSync(resolve(repositoryRoot, "generated/runtime-composition/index.ts"))),
    strategyCatalogSourceBytes: new Uint8Array(readFileSync(resolve(repositoryRoot, "generated/strategy-catalog/index.ts"))),
    candidateProofVerifierBindingBytes: encodeFullFamilyCandidateProofVerifierBinding({
      schemaVersion: 1,
      kind: "aloha.full-family-candidate-proof-verifier-binding",
      runtimeBindingId: structural.binding.bindingId,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(structural.binding),
      releaseAuthorityRoot: structural.binding.releaseAuthorityRoot,
      candidateReleaseCommit: structural.binding.candidateReleaseCommit,
      proofKeyId: structural.binding.candidatePartitionProofIssuerKeyId,
      proofPublicKeyHex: candidatePartitionProofPublicKeyHexFixture(),
    }),
    sink: observerSink,
  });
  const sixStepObservation = issueProductionSixStepCollectorPortV1(observerSink);
  const terminalPhaseObservation = issueProductionTerminalPhaseCollectorPortV1({
    sink: observerSink,
    locatorIndex: terminalLocatorIndex,
  });
  const applicationOwner = issueSearcherRuntimeApplicationOwnerV1({
    strategyRuntime,
    performanceRuntime: services.performance,
    fullGraphCoarseSweep: services.fullGraphCoarseSweep,
    fullFamilyTerminalBinding: services.fullFamilyTerminalBinding,
    sixStepTerminalBinding: services.sixStepTerminalBinding,
    fullFamilyObservation,
    sixStepObservation,
    terminalPhaseObservation,
    economicSafety: services.economicSafety,
    release: {
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
    },
    source: runtimeSource,
    coreInput: {
      amountSeed: { amountIn: "100", recipient: executor },
      execution: { transactionOrigin: caller, executorAddress: executor },
    },
    finalSimulationFactory: issueQualifiedFinalSimulationPortFactoryV1({
      async issue(currentSource, currentSourceCapability) {
        const sessionId = currentSource.sessionId;
        assert.equal(runtimeSessionIds.has(sessionId), false, "each canonical head must own a fresh ProducerSession");
        runtimeSessionIds.add(sessionId);
        const executorSnapshot = await stateOwner.issue({
          session: currentSourceCapability,
          authority: revmAuthority,
          executorAddress: executor,
          callerAddress: caller,
          qualifiedExecutorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", strictAccounts[executor]!.code),
          executorConfig: { gasLimit: "1000000", value: "0" },
          accounts: [
            { address: token0, storageSlots: [executorBalanceSlot, poolABalanceSlot, poolBBalanceSlot] },
            { address: token1, storageSlots: [executorBalanceSlot, poolABalanceSlot, poolBBalanceSlot] },
            { address: poolA, storageSlots: [pairToken0Slot, pairToken1Slot] },
            { address: poolTwo, storageSlots: [pairToken0Slot, pairToken1Slot] },
          ],
        });
        const projection = createSourceBoundExecutorProjection({ snapshot: executorSnapshot, authority: revmAuthority });
        return createQualifiedFinalSimulationPort({
          scheduler: finalSimulationScheduler,
          client: new RevmSimulationClient({ pool: services.revmPool }),
          qualification: workerQualification,
          schemaHash: h("vertical-program-schema"),
          projection: {
            project(input) {
              const previous = observedPrograms.get(input.program.programHash);
              if (previous !== undefined && previous.programBytes !== input.program.programBytes) {
                throw new TypeError("same final-simulation program hash observed with different bytes");
              }
              observedPrograms.set(input.program.programHash, Object.freeze({
                programHash: input.program.programHash,
                programBytes: input.program.programBytes,
              }));
              return projection.project(input);
            },
          },
        });
      },
    }),
    evidence,
  });
  application = applicationOwner.open(startup);
  let previousHead: CanonicalHead | null = null;
  let successfulHeadRequestCount = 0;
  const neutralReserves = Object.freeze({
    [poolA]: `0x${word(1_000_000n)}${word(1_000_000n)}${word(42n)}`,
    [poolTwo]: `0x${word(1_000_000n)}${word(1_000_000n)}${word(42n)}`,
  });
  for (let index = 0; index < 100; index += 1) {
    if (index > 0) {
      if (previousHead === null) throw new Error("vertical performance head parent is missing");
      const nextHead = Object.freeze({
        chainId: cutoff.chainId,
        number: (BigInt(cutoff.number) + BigInt(index)).toString(),
        hash: h(`vertical-performance-head:${index}`),
        parentHash: previousHead.hash,
        stateRoot: h(`vertical-performance-state:${index}`),
      });
      finalSimulationSource = nextHead;
      structural.rpc.setRuntimeHead(nextHead);
    }
    try {
      const observedHead = await runtimeSource.headSource.next(new AbortController().signal);
      if (observedHead === null) throw new Error(`vertical Reth source did not emit canonical head ${index + 1}`);
      const admission: { readonly accepted: boolean } | null = await application.submitHead(observedHead);
      if (admission === null) throw new Error(`vertical Reth ingress did not observe canonical head ${index + 1}`);
      assert.equal(admission.accepted, true);
      await application.waitForIdle();
      previousHead = observedHead;
    } catch (error) {
      throw new Error(`vertical performance head ${index + 1} failed after ${evidence.replay().producerTerminalCount} durable terminals`, { cause: error });
    }
    completedHeadCount = index + 1;
    if (index === 0) {
      evidence.replay();
      successfulHeadRequestCount = rpcRequests.length;
      structural.rpc.setRuntimeReserves(neutralReserves);
    }
  }
  const terminalCapability = application.readFinalDurableProducerTerminal();
  const terminalEvidence = readIssuedProducerHeadTerminalCapabilityV1(terminalCapability);
  const finalHeadFacts = terminalEvidence.facts === null ? null : readIssuedProducerHeadFactsCapabilityV1(terminalEvidence.facts);
  assert.equal(terminalEvidence.terminal.status, "completed", JSON.stringify(terminalEvidence.terminal));
  assert.equal(finalHeadFacts?.complete, true);
  const performanceReplay = evidence.replay();
  const rawPerformanceObservation = observeProductionPerformanceDatabaseV1(evidencePath);
  const ordinalByAdmissionId = new Map(rawPerformanceObservation.events
    .filter(event => event.eventType === "eligible-head" || event.eventType === "orphan-replacement")
    .map(event => [event.payload.admissionId, event.payload.ordinal]));
  const incompletePerformanceEvents = rawPerformanceObservation.events
    .filter(event => event.eventType === "performance-facts-incomplete")
    .map(event => ({
      ordinal: ordinalByAdmissionId.get(event.payload.admissionId) ?? "unknown",
      admissionId: event.payload.admissionId,
      terminalId: event.payload.terminalId,
      reasons: event.payload.missingFactReasons,
    }));
  assert.equal(performanceReplay.producerTerminalCount, "100");
  assert.equal(performanceReplay.performanceFactsCompleteCount, "100", `incomplete performance events: ${JSON.stringify(incompletePerformanceEvents)}`);

  assert.equal(rawPerformanceObservation.status, "raw-complete", JSON.stringify(rawPerformanceObservation.reasons));
  assert.equal(rawPerformanceObservation.databaseSha256After, rawPerformanceObservation.databaseSha256Before);
  assert.equal(rawPerformanceObservation.storageSetRootAfter, rawPerformanceObservation.storageSetRootBefore);
  assert.equal(rawPerformanceObservation.bundle?.heads.length, 100);
  const rawCompleteEvents = rawPerformanceObservation.events.filter(event => event.eventType === "performance-facts-complete");
  const rawProducerTerminals = rawPerformanceObservation.events.filter(event => event.eventType === "producer-terminal");
  assert.equal(rawCompleteEvents.length, 100);
  assert.equal(rawProducerTerminals.length, 100);
  const successfulEvents = rawCompleteEvents.filter(event => event.payload.sixStepFacts !== null);
  assert.equal(successfulEvents.length, 1, "exactly one durable head must carry owner-issued Six-Step success");
  const rawCompleteEvent = successfulEvents[0]!;
  const successfulAdmissionId = rawCompleteEvent.payload.admissionId;
  const rawCandidateEvent = rawPerformanceObservation.events.find(event =>
    event.eventType === "candidate-set" && event.payload.admissionId === successfulAdmissionId);
  const rawCoverageEvent = rawPerformanceObservation.events.find(event =>
    event.eventType === "head-coverage" && event.payload.admissionId === successfulAdmissionId);
  const rawProducerTerminalEvent = rawProducerTerminals.find(event =>
    (event.payload.terminal as Record<string, unknown>).terminalId === rawCompleteEvent.payload.terminalId);
  assert.ok(rawCandidateEvent, "successful head candidate facts are missing");
  assert.ok(rawCoverageEvent, "successful head coverage facts are missing");
  assert.ok(rawProducerTerminalEvent, "successful head Producer terminal is missing");
  const rawSixStep = rawCompleteEvent.payload.sixStepFacts as Record<string, unknown>;
  const rawStage12 = rawSixStep.stage12 as Record<string, unknown>;
  const rawStage36 = rawSixStep.stage36 as Record<string, unknown>;
  const resolvedSixStep = rawStage36.resolved as Record<string, unknown>;
  const receipt = resolvedSixStep.dryRun as unknown as UnsignedDryRunReceiptV1;
  validateUnsignedDryRunReceiptValue(receipt);
  assert.equal(receipt.signer, null);
  assert.equal(receipt.transactionHash, null);
  assert.equal(receipt.generationId, ready.generationId);
  assert.equal(receipt.readyRecordHash, ready.readyRecordHash);
  assert.equal(receipt.graphRoot, graph.graphRoot);
  assert.equal(receipt.orderedEdgeIds.length, 2);
  assert.equal(rawCoverageEvent.payload.complete, true);
  const candidateRefs = rawCandidateEvent.payload.candidateRefs as readonly Hash[];
  assert.ok(candidateRefs.length > 1, "head denominator must retain non-selected candidates");
  const candidateObservations = rawCandidateEvent.payload.candidateTerminalObservations as readonly Record<string, unknown>[];
  assert.equal(candidateObservations.length, candidateRefs.length);
  assert.equal(candidateObservations.filter(observation => observation.performanceOutcome === "verified").length, 1);
  assert.equal(candidateObservations.filter(observation =>
    observation.performanceOutcome === "chain-proven-rejected"
      || observation.performanceOutcome === "policy-rejected").length, candidateObservations.length - 1);
  const verifiedObservation = candidateObservations.find(observation => observation.performanceOutcome === "verified");
  assert.equal(verifiedObservation?.terminalLineageHash, receipt.lineageHash);
  assert.equal(verifiedObservation?.sixStepEvidenceRoot, rawSixStep.stage36Root);
  const executionEvidence = resolvedSixStep.executionProgramOwnerEvidence as Record<string, unknown>;
  const finalSimulationEvidence = resolvedSixStep.finalSimulationOwnerEvidence as Record<string, unknown>;
  assert.equal(executionEvidence.programHash, receipt.programHash);
  assert.equal(finalSimulationEvidence.finalSimulationReceiptHash, receipt.finalSimulationReceiptHash);
  assert.equal((executionEvidence.facts as Record<string, unknown>).kind, "aloha.search-runtime.execution-program-owner-facts-v1");
  assert.equal((finalSimulationEvidence.facts as Record<string, unknown>).kind, "aloha.qualified-final-simulation-owner-facts-v1");
  const sourceLogicalFacts = rawCoverageEvent.payload.currentSourceLogicalFacts as readonly Record<string, unknown>[];
  const blockscanSourceFacts = sourceLogicalFacts.find(value => value.lane === "blockscan");
  const backrunSourceFacts = sourceLogicalFacts.find(value => value.lane === "backrun");
  const sourcePhysicalFacts = rawCoverageEvent.payload.currentSourcePhysicalFacts as Record<string, unknown>;
  assert.ok(blockscanSourceFacts);
  assert.ok(backrunSourceFacts);
  assert.equal(backrunSourceFacts.kind, "aloha.current-source-rpc.logical-scope-facts-v1");
  assert.deepEqual(backrunSourceFacts.source, cutoff);
  assert.deepEqual({
    logicalReads: backrunSourceFacts.logicalReads,
    settledHits: backrunSourceFacts.settledHits,
    inFlightJoins: backrunSourceFacts.inFlightJoins,
    consumerAborts: backrunSourceFacts.consumerAborts,
    consumerDeadlines: backrunSourceFacts.consumerDeadlines,
  }, { logicalReads: 0, settledHits: 0, inFlightJoins: 0, consumerAborts: 0, consumerDeadlines: 0 });
  assert.ok(Number(blockscanSourceFacts.logicalReads) > 1, `expected repeated logical reserve reads: ${JSON.stringify(blockscanSourceFacts)}`);
  assert.equal(sourcePhysicalFacts.physicalBuilds, 2, JSON.stringify(sourcePhysicalFacts));
  assert.equal(blockscanSourceFacts.settledHits, Number(blockscanSourceFacts.logicalReads) - 2, JSON.stringify(blockscanSourceFacts));
  assert.equal(blockscanSourceFacts.inFlightJoins, 0, JSON.stringify(blockscanSourceFacts));
  const producerTerminal = rawProducerTerminalEvent.payload.terminal as Record<string, unknown>;
  assert.equal(producerTerminal.status, "completed");
  assert.equal(producerTerminal.reason, "completed-with-no-backrun-input");
  assert.equal(runtimeSessionIds.size, 100, "each durable head must use an isolated ProducerSession");
  assert.equal(successfulHeadRequestCount, 2, "the successful head must issue one physical reserve read per distinct pool");
  assert.equal(
    (rawCandidateEvent.payload.candidateTerminalObservations as readonly unknown[]).length,
    candidateRefs.length,
  );
  const selectedParents = rawStage12.selectedParents as readonly Record<string, unknown>[];
  const selectedGraphLegs = rawStage36.selectedGraphLegs as readonly Record<string, unknown>[];
  assert.deepEqual(selectedParents.map(parent => parent.edgeId), receipt.orderedEdgeIds);
  assert.deepEqual(selectedGraphLegs.map(leg => leg.edgeId), receipt.orderedEdgeIds);
  assert.deepEqual(
    selectedParents.map(parent => parent.edgeId),
    selectedGraphLegs.map(leg => leg.edgeId),
    "Stage1/2 selected parents must preserve the exact Stage3 Graph-leg order",
  );
  const productionArtifactSetRoots = (rawStage36.resolved as Record<string, unknown>).productionArtifactSetRoots as readonly unknown[];
  assert.equal(rawStage12.stage3ArtifactSetRoot, productionArtifactSetRoots[0]);
  for (const parent of selectedParents) {
    assert.match(String(parent.stage1EventId), /^0x[0-9a-f]{64}$/);
    assert.match(String(parent.stage1ArtifactSetRoot), /^0x[0-9a-f]{64}$/);
    assert.match(String(parent.stage2EventId), /^0x[0-9a-f]{64}$/);
    assert.match(String(parent.stage2ArtifactSetRoot), /^0x[0-9a-f]{64}$/);
    assert.match(String(parent.instancePublicationRoot), /^0x[0-9a-f]{64}$/);
    assert.match(String(parent.edgeContentRoot), /^0x[0-9a-f]{64}$/);
  }
  for (const forbidden of ["candidates", "outcomes", "verifiedInstances", "instanceCatalog", "graph"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(rawStage12, forbidden), false);
  }
  assert.deepEqual(rawPerformanceObservation.reasons, []);
  for (const mutation of [
    {
      id: "stage12-parent-reorder",
      apply(event: Record<string, unknown>) {
        const facts = (event.payload as Record<string, unknown>).sixStepFacts as Record<string, unknown>;
        const stage12 = facts.stage12 as Record<string, unknown>;
        const parents = stage12.selectedParents as readonly unknown[];
        stage12.selectedParents = [parents[1], parents[0], ...parents.slice(2)];
      },
    },
    {
      id: "stage12-parent-edge-splice",
      apply(event: Record<string, unknown>) {
        const facts = (event.payload as Record<string, unknown>).sixStepFacts as Record<string, unknown>;
        const stage12 = facts.stage12 as Record<string, unknown>;
        const parents = stage12.selectedParents as Record<string, unknown>[];
        parents[0]!.edgeId = h("stage12-edge-splice");
      },
    },
  ] as const) {
    const mutatedPath = mutateProductionCompletePerformanceEvent(evidencePath, mutation.id, mutation.apply);
    const observed = observeProductionPerformanceDatabaseV1(mutatedPath);
    assert.equal(observed.status, "invalid", mutation.id);
  }
  if (previousHead === null) throw new TypeError("vertical performance final head is missing");
  const producerRpcRequests = Object.freeze([...rpcRequests]);
  assert.ok(structural.rpc.canonicalRequests.some(request => request.method === "eth_chainId"));
  assert.ok(structural.rpc.canonicalRequests.some(request => request.method === "eth_getBlockByNumber"));
  assert.ok(structural.rpc.canonicalRequests.some(request => request.method === "eth_getBlockByNumber"
    && (request.params as readonly unknown[])[0] === "pending"
    && (request.params as readonly unknown[])[1] === true));
  assert.equal(producerRpcRequests.length, 200, "each of 100 heads must read both distinct graph pools exactly once");
  for (const [index, request] of producerRpcRequests.entries()) {
    const params = request.params as readonly Record<string, unknown>[];
    assert.equal(params[1]?.requireCanonical, true);
    const expectedHeadIndex = Math.floor(index / 2);
    assert.equal(
      params[1]?.blockHash,
      expectedHeadIndex === 0 ? cutoff.hash : h(`vertical-performance-head:${expectedHeadIndex}`),
    );
    assert.equal(params[0]?.data, UNIV2_GET_RESERVES_SELECTOR);
  }
  const rpcTargets = producerRpcRequests.map(request => String((request.params as readonly Record<string, unknown>[])[0]?.to).toLowerCase());
  assert.equal(rpcTargets.filter(target => target === poolA).length, 100);
  assert.equal(rpcTargets.filter(target => target === poolTwo).length, 100);
  await application.run();
  const sweepRequests = rpcRequests.slice(producerRpcRequests.length);
  assert.equal(rpcRequests.length, 202, "terminal full-Graph sweep must remain outside the 100-head F5 request denominator");
  assert.equal(sweepRequests.length, 2, "the two-edge Ready Graph must issue two acceptance-only physical reads");
  assert.deepEqual(
    sweepRequests.map(request => String((request.params as readonly Record<string, unknown>[])[0]?.to).toLowerCase()).sort(),
    [poolA, poolTwo].sort(),
  );
  for (const request of sweepRequests) {
    const params = request.params as readonly Record<string, unknown>[];
    assert.equal(params[1]?.requireCanonical, true);
    assert.equal(params[1]?.blockHash, previousHead.hash);
    assert.equal(params[0]?.data, UNIV2_GET_RESERVES_SELECTOR);
  }
  const fullFamilyResult = readProductionFullFamilyCollectorResultV1(application.readFullFamilyObservation());
  assert.equal(fullFamilyResult.kind, "aloha.production-full-family-observation-v1", JSON.stringify(fullFamilyResult.missing));
  assert.deepEqual(fullFamilyResult.missing, []);
  const sixStepResult = readProductionSixStepCollectorResultV1(application.readSixStepObservation());
  assert.equal(sixStepResult.status, "observed");
  const terminalResult = readProductionTerminalPhaseCollectorResultV1(application.readTerminalPhaseObservation());
  assert.equal(terminalResult.manifest.sixStep.status, "observed");
  assert.equal(terminalResult.manifest.finalDurableWindowId, fullFamilyResult.finalDurableWindowId);
  const durableTerminal = await terminalLocatorIndex.read(terminalResult.manifest.finalDurableWindowId);
  assert.equal(durableTerminal.index.indexRoot, terminalResult.locatorIndexRoot);
  assert.equal(durableTerminal.manifest.manifestRoot, terminalResult.manifest.manifestRoot);
  assert.equal(durableTerminal.fullFamilyProjection.status, "observed");
  assert.equal(durableTerminal.sixStepPhysicalStatus, "observed", durableTerminal.sixStepPhysicalReason ?? undefined);
  const observedProgram = observedPrograms.get(receipt.programHash);
  if (observedProgram === undefined) throw new Error("successful final simulation did not receive its execution program");
  const packed = decodePackedCallProgram(decodeExecutorExecuteCalldata(observedProgram.programBytes));
  assert.deepEqual(packed, (executionEvidence.facts as Record<string, unknown>).callSequence);
  assert.equal(packed.length, 4);
  const selectedPoolTargets = selectedGraphLegs.map(leg => String(leg.owningInstanceKey).toLowerCase());
  assert.deepEqual([...selectedPoolTargets].sort(), [poolA, poolTwo].sort());
  assert.deepEqual([packed[1]!.target, packed[3]!.target], selectedPoolTargets);
  assert.ok([token0, token1].includes(packed[0]!.target));
  assert.ok([token0, token1].includes(packed[2]!.target));
  assert.notEqual(packed[0]!.target, packed[2]!.target);
  assert.ok(packed.every(call => call.value === "0"));
  assert.equal(packed[0]!.calldata.slice(0, 10), "0xa9059cbb");
  assert.equal(packed[1]!.calldata.slice(0, 10), "0x022c0d9f");
  assert.equal(packed[2]!.calldata.slice(0, 10), "0xa9059cbb");
  assert.equal(packed[3]!.calldata.slice(0, 10), "0x022c0d9f");
  assert.equal(amountWord(packed[0]!.calldata, 1), 100n);
  assert.equal(addressWordFromCalldata(packed[0]!.calldata, 0), selectedPoolTargets[0]);
  assert.equal(addressWordFromCalldata(packed[1]!.calldata, 2), executor);
  assert.equal(addressWordFromCalldata(packed[2]!.calldata, 0), selectedPoolTargets[1]);
  assert.equal(addressWordFromCalldata(packed[3]!.calldata, 2), executor);
  const firstOutputWord = packed[0]!.target === token0 ? 1 : 0;
  const secondOutputWord = firstOutputWord === 1 ? 0 : 1;
  assert.ok(amountWord(packed[1]!.calldata, firstOutputWord) > 0n);
  assert.equal(amountWord(packed[1]!.calldata, 1 - firstOutputWord), 0n);
  assert.ok(amountWord(packed[3]!.calldata, secondOutputWord) > 0n);
  assert.equal(amountWord(packed[3]!.calldata, 1 - secondOutputWord), 0n);
  assert.equal(amountWord(packed[2]!.calldata, 1), amountWord(packed[1]!.calldata, firstOutputWord));
});
