import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { issueSearcherProductionEvidenceOwnerV1 } from "../../../apps/searcher-runtime/src/production-evidence.ts";
import { createContractEconomicSafetyService } from "../../../packages/search-pipeline/test/economic-safety-fixture.ts";
import type { RuntimeAnchorReceiptV1 } from "../../../apps/searcher-runtime/src/deployment.ts";
import {
  encodeFullGraphCoarseSweepV1,
  fullGraphTransitionSequenceRootV1,
  sealFullGraphCoarseSweepV1,
  type FullGraphCoarseSweepV1,
} from "../../../packages/full-graph-coarse-sweep/src/index.ts";
import { validateMaterializedFullGraphSweepV1 } from "../../../acceptance/collectors/src/full-family-observer.ts";
import {
  qualifiedCoarseProjectionReceiptRootV1,
  sealCoarseEdgeProjectionV1,
  type QualifiedCoarseProjectionReceiptV1,
} from "../../../packages/coarse-economics/src/index.ts";
import {
  encodeNativeFullFamilyAuditBodyV1,
  nativeFullFamilyAuditSequenceRootV1,
  nativeFullFamilyCoarseRouteFactRootV1,
  type NativeFullFamilyAuditV1,
} from "../../../packages/search-pipeline/src/index.ts";
import {
  buildPreReleaseFactLogRecordsV1,
  encodePreReleaseFactLogJsonlV1,
  readPreReleaseFactLogV1,
  readPreReleaseFactLogStructuralFixtureV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/pre-release-fact-log/v1", value);
const release = Object.freeze({
  candidateReleaseCommit: "a".repeat(40),
  runtimeBindingId: h("runtime-binding"),
  releaseProvenanceHash: h("release-provenance"),
});
const economicSafety = createContractEconomicSafetyService(release.releaseProvenanceHash, h);

function joinContract() {
  return Object.freeze({
    head: Object.freeze([
      Object.freeze({ routePath: "payload.admissionId", candidateSetPath: "payload.admissionId" }),
      Object.freeze({ routePath: "payload.headFactsRoot", candidateSetPath: "payload.headFactsRoot" }),
      Object.freeze({ routePath: "payload.headHash", candidateSetPath: "payload.headHash" }),
    ]),
    lane: Object.freeze([
      Object.freeze({ routePath: "payload.lane", candidateLanePath: "lane" }),
      Object.freeze({ routePath: "payload.correlationId", candidateLanePath: "correlationId" }),
      Object.freeze({ routePath: "payload.coverageRoot", candidateLanePath: "coverageRoot" }),
      Object.freeze({ routePath: "payload.accounting.root", candidateLanePath: "accountingRoot" }),
    ]),
    candidate: Object.freeze({
      routeEntriesPath: "payload.accounting.entries",
      terminalObservationsPath: "payload.candidateTerminalObservations",
      routeLanePath: "payload.lane",
      terminalLanePath: "lane",
      identity: Object.freeze({ routePath: "candidateId", terminalPath: "candidateId" }),
      matching: "filter-terminal-by-route-lane-then-exact-order-and-cardinality",
      equalFields: Object.freeze(["disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal"]),
    }),
  });
}

function runtimeAnchor(): RuntimeAnchorReceiptV1 {
  return Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1",
    bindingId: release.runtimeBindingId,
    releaseProvenanceHash: release.releaseProvenanceHash,
    manifestHash: h("manifest"),
    manifestArtifactSha256: h("manifest-artifact"),
    runtimeArtifactRoot: h("runtime-artifact"),
    implementationClosureDigest: h("implementation-closure"),
    candidateReleaseCommit: release.candidateReleaseCommit,
    entrypointSha256: h("entrypoint"),
    nodeExecutableSha256: h("node"),
    bundleModulePath: "/opt/aloha/release.mjs",
    bundleModuleSha256: h("bundle"),
    serviceName: "aloha-searcher",
    systemdUnit: "aloha-searcher.service",
    bootId: "boot-1",
    invocationId: "invocation-1",
    logDevice: "8",
    logInode: "9",
    pid: "42",
    processStartTicks: "7",
    dryRun: true,
  });
}

function emptySweep(): FullGraphCoarseSweepV1 {
  const source = Object.freeze({ chainId: "1", number: "50", hash: h("head"), stateRoot: h("state") });
  const bindingBody = Object.freeze({
    runtimeBindingId: release.runtimeBindingId,
    releaseProvenanceHash: release.releaseProvenanceHash,
    candidateReleaseCommit: release.candidateReleaseCommit,
    releaseMembershipRoot: h("membership"),
    definitionCatalogRoot: h("definition-catalog"),
    familyCompositionRoot: h("family-composition"),
    generationId: "generation-1",
    readyRecordHash: h("ready"),
    graphRoot: h("graph"),
    readyCutoff: source,
    recentObservationRange: Object.freeze({ from: "1", to: "50", blockCount: "50" as const }),
    currentSourceSessionId: h("current-source-session"),
    actualCurrentSource: source,
    amountSeedHash: h("amount-seed"),
    executionContextHash: h("execution-context"),
    objectiveRef: h("objective"),
  });
  const binding = Object.freeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/full-graph-coarse-sweep-binding/v1", bindingBody),
  });
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-graph-coarse-sweep-v1" as const,
    binding,
    expectedTransitionCount: "0",
    expectedTransitionIds: Object.freeze([]) as readonly Hash[],
    expectedTransitionRoot: fullGraphTransitionSequenceRootV1("expected", []),
    observedTransitionCount: "0",
    observedTransitionIds: Object.freeze([]) as readonly Hash[],
    observedTransitionRoot: fullGraphTransitionSequenceRootV1("observed", []),
    missingTransitionCount: "0",
    missingTransitionIds: Object.freeze([]) as readonly Hash[],
    missingTransitionRoot: fullGraphTransitionSequenceRootV1("missing", []),
    familyTransitionCounts: Object.freeze([]),
    entries: Object.freeze([]),
  });
  const sweep = sealFullGraphCoarseSweepV1(body);
  validateMaterializedFullGraphSweepV1(sweep);
  return sweep;
}

function nativeAudit(
  sweep: FullGraphCoarseSweepV1,
  routes: readonly Readonly<{
    candidateId: Hash;
    routeHash: Hash;
    legs: readonly Readonly<{
      edgeId: Hash;
      receipt: CanonicalJson | null;
      familyObservation: CanonicalJson | null;
      owningFamilyId?: string;
    }>[];
    assessment?: CanonicalJson | null;
    action?: boolean;
  }>[] = [],
  includeSweepProjectedEdges = false,
): NativeFullFamilyAuditV1 {
  const bindingBody = Object.freeze({
    correlationId: h("native-audit-correlation"),
    sourceSessionId: sweep.binding.currentSourceSessionId,
    generationId: sweep.binding.generationId,
    readyRecordHash: sweep.binding.readyRecordHash,
    readyCutoff: sweep.binding.readyCutoff,
    graphRoot: sweep.binding.graphRoot,
    releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
    actualCurrentSource: sweep.binding.actualCurrentSource,
    planningProblemHash: h("native-audit-planning-problem"),
    plannerEnumerationRoot: h("native-audit-enumeration"),
  });
  const binding = Object.freeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/native-full-family-audit-binding/v1", bindingBody),
  });
  const denominatorKeys: Hash[] = [];
  const observedRoots: Hash[] = [];
  const missingLegKeys: Hash[] = [];
  const coarseRoutes = Object.freeze(routes.map(route => {
    const legs = Object.freeze(route.legs.map((leg, index) => {
      const denominatorKey = hashDomain("aloha/native-full-family-audit-leg-key/v1", {
        candidateId: route.candidateId, legIndex: String(index), edgeId: leg.edgeId,
      });
      denominatorKeys.push(denominatorKey);
      if (leg.receipt === null) missingLegKeys.push(denominatorKey);
      else observedRoots.push(hashDomain("aloha/native-full-family-audit-observed-receipt/v1", {
        denominatorKey,
        receiptRoot: (leg.receipt as Readonly<Record<string, CanonicalJson>>).receiptRoot,
        familyObservation: leg.familyObservation,
      }));
      const factBody = Object.freeze({
        searchAuditBindingRoot: binding.bindingRoot,
        candidateId: route.candidateId,
        routeHash: route.routeHash,
        routeBindingHash: h(`native-route-binding-${route.candidateId}`),
        legIndex: String(index),
        edgeId: leg.edgeId,
        owningFamilyId: leg.owningFamilyId ?? `family-${index}`,
        owningFamilyDefinitionHash: h(`native-family-definition-${index}`),
        owningInstanceKey: `native-instance-${index}`,
        instancePublicationHash: h(`native-instance-publication-${index}`),
        projectionHash: h(`native-projection-${index}`),
        receipt: leg.receipt,
        familyObservation: leg.familyObservation,
      });
      return Object.freeze({
        ...factBody,
        factRoot: hashDomain("aloha/native-full-family-coarse-leg-fact/v1", factBody),
      });
    }));
    const routeBody = Object.freeze({
      searchAuditBindingRoot: binding.bindingRoot,
      candidateId: route.candidateId,
      routeHash: route.routeHash,
      routeBindingHash: h(`native-route-binding-${route.candidateId}`),
      assessment: route.assessment === undefined ? Object.freeze({ kind: "synthetic-assessment" }) : route.assessment,
      legs,
    });
    return Object.freeze({
      ...routeBody,
      routeFactRoot: nativeFullFamilyCoarseRouteFactRootV1(routeBody as never),
    });
  }));
  const edgeById = new Map<Hash, Readonly<{
    edgeId: Hash;
    owningFamilyId: string;
    owningFamilyDefinitionHash: Hash;
    owningInstanceKey: string;
    instancePublicationHash: Hash;
    projectionHash: Hash;
  }>>();
  if (includeSweepProjectedEdges) {
    for (const [index, entry] of sweep.entries.entries()) {
      if (edgeById.has(entry.edge.edgeId)) continue;
      edgeById.set(entry.edge.edgeId, Object.freeze({
        edgeId: entry.edge.edgeId,
        owningFamilyId: entry.edge.owningFamilyId,
        owningFamilyDefinitionHash: h(`native-sweep-family-definition-${index}`),
        owningInstanceKey: `native-sweep-instance-${index}`,
        instancePublicationHash: h(`native-sweep-instance-publication-${index}`),
        projectionHash: h(`native-sweep-projection-${index}`),
      }));
    }
  }
  for (const route of coarseRoutes) for (const leg of route.legs) if (!edgeById.has(leg.edgeId)) edgeById.set(leg.edgeId, leg);
  const projectedEdges = Object.freeze([...edgeById.values()].map(edge => {
    const factBody = Object.freeze({
      searchAuditBindingRoot: binding.bindingRoot,
      edge: Object.freeze({ edgeId: edge.edgeId }),
      edgeId: edge.edgeId,
      owningFamilyId: edge.owningFamilyId,
      owningFamilyDefinitionHash: edge.owningFamilyDefinitionHash,
      owningInstanceKey: edge.owningInstanceKey,
      instancePublicationHash: edge.instancePublicationHash,
      projectionHash: edge.projectionHash,
    });
    return Object.freeze({
      ...factBody,
      factRoot: hashDomain("aloha/native-full-family-projected-edge-fact/v1", factBody),
    });
  }));
  const actionLineage = Object.freeze(routes.flatMap(route => {
    if (route.action !== true) return [];
    const actionBody = Object.freeze({
      searchAuditBindingRoot: binding.bindingRoot,
      candidateId: route.candidateId,
      routeHash: route.routeHash,
      orderedEdgeIds: Object.freeze(route.legs.map(leg => leg.edgeId)),
      executionProgramOwnerEvidence: Object.freeze({ evidenceRoot: h(`native-action-${route.candidateId}`) }),
    });
    return [Object.freeze({
      ...actionBody,
      factRoot: hashDomain("aloha/native-full-family-action-lineage-fact/v1", actionBody),
    })];
  }));
  const observedEdgeIds = new Set(coarseRoutes.flatMap(route => route.legs.flatMap(leg => leg.receipt === null ? [] : [leg.edgeId])));
  const missingProjectedEdgeIds = Object.freeze(projectedEdges.flatMap(edge => observedEdgeIds.has(edge.edgeId) ? [] : [edge.edgeId]));
  const auditBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.native-full-family-audit-v1" as const,
    binding,
    expectedCandidateCount: String(coarseRoutes.length),
    expectedLegCount: String(denominatorKeys.length),
    observedReceiptCount: String(observedRoots.length),
    missingLegKeys: Object.freeze(missingLegKeys),
    expectedProjectedEdgeCount: String(projectedEdges.length),
    observedProjectedEdgeCount: String(observedEdgeIds.size),
    missingProjectedEdgeIds,
    expectedActionLineageCount: String(actionLineage.length),
    observedActionLineageCount: String(actionLineage.length),
    missingActionCandidateIds: Object.freeze([]) as readonly Hash[],
    denominatorRoot: nativeFullFamilyAuditSequenceRootV1("denominator", denominatorKeys),
    observedReceiptRoot: nativeFullFamilyAuditSequenceRootV1("observed-receipts", observedRoots),
    missingLegRoot: nativeFullFamilyAuditSequenceRootV1("missing-legs", missingLegKeys),
    projectedEdgeDenominatorRoot: nativeFullFamilyAuditSequenceRootV1("projected-edge-denominator", projectedEdges.map(edge => edge.factRoot)),
    missingProjectedEdgeRoot: nativeFullFamilyAuditSequenceRootV1("missing-projected-edges", missingProjectedEdgeIds),
    actionDenominatorRoot: nativeFullFamilyAuditSequenceRootV1("action-denominator", actionLineage.map(action => action.candidateId)),
    actionObservedRoot: nativeFullFamilyAuditSequenceRootV1("action-observed", actionLineage.map(action => action.factRoot)),
    coarseRoutes,
    projectedEdges,
    actionLineage,
  });
  return encodeNativeFullFamilyAuditBodyV1(auditBody as never).audit;
}

function nativeAuditWithProjectedCount(count: number): NativeFullFamilyAuditV1 {
  const base = nativeAudit(emptySweep());
  const projectedEdges = Object.freeze(Array.from({ length: count }, (_, index) => {
    const edgeId = h(`native-projected-${index}`);
    const factBody = Object.freeze({
      searchAuditBindingRoot: base.binding.bindingRoot,
      edge: Object.freeze({ edgeId }),
      edgeId,
      owningFamilyId: "synthetic-family",
      owningFamilyDefinitionHash: h("synthetic-family-definition"),
      owningInstanceKey: `synthetic-instance-${index}`,
      instancePublicationHash: h(`synthetic-publication-${index}`),
      projectionHash: h(`synthetic-projection-${index}`),
    });
    return Object.freeze({
      ...factBody,
      factRoot: hashDomain("aloha/native-full-family-projected-edge-fact/v1", factBody),
    });
  }));
  const ids = Object.freeze(projectedEdges.map(edge => edge.edgeId));
  const { auditRoot: _auditRoot, ...body } = base;
  return encodeNativeFullFamilyAuditBodyV1({
    ...body,
    expectedProjectedEdgeCount: String(count),
    observedProjectedEdgeCount: "0",
    projectedEdges,
    missingProjectedEdgeIds: ids,
    projectedEdgeDenominatorRoot: nativeFullFamilyAuditSequenceRootV1(
      "projected-edge-denominator",
      projectedEdges.map(edge => edge.factRoot),
    ),
    missingProjectedEdgeRoot: nativeFullFamilyAuditSequenceRootV1("missing-projected-edges", ids),
  } as never).audit;
}

function resealSweep(
  sweep: FullGraphCoarseSweepV1,
  options: Readonly<{
    binding?: Partial<FullGraphCoarseSweepV1["binding"]>;
    entries?: readonly FullGraphCoarseSweepV1["entries"][number][];
  }> = {},
): FullGraphCoarseSweepV1 {
  const rawBinding = Object.freeze({ ...sweep.binding, ...(options.binding ?? {}) });
  const { bindingRoot: _bindingRoot, ...bindingBody } = rawBinding;
  const binding = Object.freeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/full-graph-coarse-sweep-binding/v1", bindingBody),
  });
  const entries = Object.freeze([...(options.entries ?? sweep.entries)].map((rawEntry, index) => {
    const { entryRoot: _entryRoot, ...rawEntryBody } = rawEntry;
    let receipt = rawEntryBody.receipt;
    if (rawEntry.status === "observed" && receipt !== null) {
      const rawReceipt = receipt as unknown as Readonly<Record<string, unknown>>;
      const rawProjection = rawReceipt.projection as Readonly<Record<string, unknown>>;
      const {
        schemaVersion: _projectionSchemaVersion,
        kind: _projectionKind,
        projectionId: _projectionId,
        ...projectionDraft
      } = rawProjection;
      const projection = sealCoarseEdgeProjectionV1(Object.freeze({
        ...projectionDraft,
        generationId: binding.generationId,
        graphRoot: binding.graphRoot,
        source: binding.actualCurrentSource,
        objectiveRef: binding.objectiveRef,
      }) as never);
      const { receiptRoot: _receiptRoot, ...rawReceiptBody } = rawReceipt;
      const receiptBody: Omit<QualifiedCoarseProjectionReceiptV1, "receiptRoot"> = Object.freeze({
        ...rawReceiptBody,
        releaseProvenanceHash: binding.releaseProvenanceHash,
        releaseMembershipRoot: binding.releaseMembershipRoot,
        projection,
      }) as unknown as Omit<QualifiedCoarseProjectionReceiptV1, "receiptRoot">;
      receipt = Object.freeze({ ...receiptBody, receiptRoot: qualifiedCoarseProjectionReceiptRootV1(receiptBody) });
    }
    const entryBody = Object.freeze({
      ...rawEntryBody,
      bindingRoot: binding.bindingRoot,
      ordinal: String(index),
      receipt,
    });
    return Object.freeze({
      ...entryBody,
      entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", entryBody as unknown as CanonicalJson),
    });
  }));
  const expectedTransitionIds = Object.freeze(entries.map(entry => entry.transitionId));
  const observedTransitionIds = Object.freeze(entries.filter(entry => entry.status === "observed").map(entry => entry.transitionId));
  const missingTransitionIds = Object.freeze(entries.filter(entry => entry.status === "missing").map(entry => entry.transitionId));
  const counts = new Map<string, { expected: number; observed: number; missing: number }>();
  for (const entry of entries) {
    const current = counts.get(entry.edge.owningFamilyId) ?? { expected: 0, observed: 0, missing: 0 };
    current.expected += 1;
    if (entry.status === "observed") current.observed += 1;
    else current.missing += 1;
    counts.set(entry.edge.owningFamilyId, current);
  }
  const familyTransitionCounts = Object.freeze([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([familyId, value]) => Object.freeze({
      familyId,
      expectedTransitionCount: String(value.expected),
      observedTransitionCount: String(value.observed),
      missingTransitionCount: String(value.missing),
    })));
  return sealFullGraphCoarseSweepV1(Object.freeze({
    schemaVersion: 1,
    kind: "aloha.full-graph-coarse-sweep-v1",
    binding,
    expectedTransitionCount: String(expectedTransitionIds.length),
    expectedTransitionIds,
    expectedTransitionRoot: fullGraphTransitionSequenceRootV1("expected", expectedTransitionIds),
    observedTransitionCount: String(observedTransitionIds.length),
    observedTransitionIds,
    observedTransitionRoot: fullGraphTransitionSequenceRootV1("observed", observedTransitionIds),
    missingTransitionCount: String(missingTransitionIds.length),
    missingTransitionIds,
    missingTransitionRoot: fullGraphTransitionSequenceRootV1("missing", missingTransitionIds),
    familyTransitionCounts,
    entries,
  }) as unknown as Omit<FullGraphCoarseSweepV1, "sweepRoot">);
}

function activeGraphFor(sweep: FullGraphCoarseSweepV1 = emptySweep()) {
  return Object.freeze({
    checkpointRootEnvelopeHash: h("checkpoint-root"),
    checkpointRevision: "1",
    readyClosureStorageHash: h("ready-closure"),
    readyRecordHash: sweep.binding.readyRecordHash,
    generationId: sweep.binding.generationId,
    releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
    cutoff: sweep.binding.readyCutoff,
    instanceCatalogRoot: h("instance-catalog"),
    instanceCatalogStorageHash: h("instance-catalog-storage"),
    graphStorageHash: h("graph-storage"),
    graphRoot: sweep.binding.graphRoot,
    edgeCount: "0",
    orderedEdgeIds: Object.freeze([]),
    orderedEdges: Object.freeze([]),
    expectedTransitionCount: sweep.expectedTransitionCount,
    expectedTransitionRoot: sweep.expectedTransitionRoot,
    orderedTransitions: Object.freeze([]),
    familyEdgeCounts: Object.freeze([]),
    familyTransitionCounts: Object.freeze([]),
  });
}

function structuralReportFor(sweep: FullGraphCoarseSweepV1) {
  return Object.freeze({
    release,
    factBinding: Object.freeze({
      databaseContentSha256: h("database"),
      terminalSnapshotTrustRoot: h("terminal-snapshot-trust"),
    }),
    factLocators: Object.freeze({
      processEvidenceDatabasePath: "/tmp/facts.sqlite",
      checkpointDatabasePath: "/tmp/runtime-checkpoint.sqlite",
      frozenCheckpointSnapshotPublication: Object.freeze({
        sourcePath: "/tmp/runtime-checkpoint.sqlite", snapshotPath: "/tmp/frozen-checkpoint.sqlite",
        contentSha256: h("checkpoint"), byteLength: "1", device: "1", inode: "1",
        uid: "0", gid: "0", mode: "384", fileFsynced: true, directoryFsynced: true,
      }),
      processEvidenceDatabase: Object.freeze({
        path: "/tmp/facts.sqlite", device: "1", inode: "1", contentSha256: h("database"),
      }),
    }),
    factIndex: Object.freeze({
      terminalPhase: Object.freeze({
        finalDurableWindowId: h("window"), terminalLocatorDirectory: "/tmp/terminal-locators",
        observerContentStore: Object.freeze({ directory: "/tmp/store", device: "1", inode: "1", storeIdentityHash: h("store") }),
        index: Object.freeze({ path: `/tmp/terminal-locators/${h("window").slice(2)}.json`, device: "1", inode: "1", contentSha256: h("index"), byteLength: "1", indexRoot: h("index-root") }),
        fullGraphCoarseSweep: Object.freeze({
          artifactRefId: h("artifact"), contentSha256: h("sweep-content"), sweepRoot: sweep.sweepRoot,
          expectedTransitionCount: sweep.expectedTransitionCount, expectedTransitionRoot: sweep.expectedTransitionRoot,
          observedTransitionCount: sweep.observedTransitionCount, observedTransitionRoot: sweep.observedTransitionRoot,
          missingTransitionCount: sweep.missingTransitionCount, missingTransitionRoot: sweep.missingTransitionRoot,
          familyTransitionCounts: sweep.familyTransitionCounts,
        }),
      }),
      processEvidenceQuery: Object.freeze({
        databasePath: "/tmp/facts.sqlite",
        routeDenominator: Object.freeze({ namespace: "searcher-production-evidence/route-denominators/v1", eventType: "route-denominator", accountingEntriesPath: "payload.accounting.entries" }),
        candidateSet: Object.freeze({ namespace: "searcher-production-evidence/candidate-sets/v1", eventType: "candidate-set", laneDenominatorsPath: "payload.laneDenominators", terminalObservationsPath: "payload.candidateTerminalObservations" }),
        joins: joinContract(), exactAdmission: Object.freeze({ sourcePath: "payload.accounting.entries[].disposition", disposition: "selected" }),
      }),
    }),
    nominationQualificationReuse: unavailableReuse(),
    judgmentRoot: h("judgment"),
  });
}

function rawObservation(events: readonly Readonly<Record<string, unknown>>[] = []) {
  return Object.freeze({
    kind: "aloha.raw-production-performance-observation-v1" as const,
    status: "raw-complete" as const,
    reasons: Object.freeze([]),
    databaseSha256Before: h("database"), databaseSha256After: h("database"),
    storageSetRootBefore: h("storage"), storageSetRootAfter: h("storage"),
    sqliteSchemaRoot: h("schema"), rawRowRoot: h("raw"), eventRoot: h("events"),
    terminalPhaseRowCount: "0", terminalPhaseRowRoot: h("terminal-rows"), sixStepWindowSelection: null,
    release: null, servingPartitions: Object.freeze([]), profile: null, commitment: null,
    events: Object.freeze(events), bundle: null,
  });
}

function evidenceEvent(
  eventType: string,
  sequence: string,
  payload: Readonly<Record<string, unknown>>,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-evidence-event" as const,
    eventId: h(`synthetic-event-${eventType}-${sequence}`),
    eventType,
    sequence,
    namespace: `searcher-production-evidence/${eventType}/v1`,
    release: Object.freeze({
      bindingId: release.runtimeBindingId,
      releaseProvenanceHash: release.releaseProvenanceHash,
      candidateReleaseCommit: release.candidateReleaseCommit,
    }),
    runtimeAnchor: Object.freeze({}),
    serving: null,
    payload,
  });
}

function currentSourceDenominatorEvents(
  finalSource: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>,
  selected: Readonly<{
    readonly ordinal: number;
    readonly source: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>;
  }> | null = null,
) {
  const admissions = Array.from({ length: 100 }, (_, index) => {
    const ordinal = index + 1;
    const source = selected?.ordinal === ordinal ? selected.source : finalSource;
    return Object.freeze({
      admissionId: h(`active-admission-${ordinal}`),
      ordinal: String(ordinal),
      source,
      event: evidenceEvent("eligible-head", String(ordinal), Object.freeze({
        admissionId: h(`active-admission-${ordinal}`),
        ordinal: String(ordinal),
        head: Object.freeze({ ...source, parentHash: h(`parent-${ordinal}`) }),
      })),
    });
  });
  const coverage = (admission: typeof admissions[number], sequence: string) => evidenceEvent(
    "head-coverage",
    sequence,
    Object.freeze({
      admissionId: admission.admissionId,
      headHash: admission.source.hash,
      currentSourcePhysicalFacts: Object.freeze({ source: admission.source }),
      currentSourceLogicalFacts: Object.freeze([
        Object.freeze({ source: admission.source }),
        Object.freeze({ source: admission.source }),
      ]),
      coarseTimingFacts: Object.freeze([Object.freeze({ source: admission.source })]),
    }),
  );
  const finalAdmission = admissions[99]!;
  const events: Readonly<Record<string, unknown>>[] = [
    ...admissions.map(value => value.event),
    coverage(finalAdmission, "101"),
  ];
  let selectedPerformanceEventId: Hash | null = null;
  if (selected !== null) {
    const admission = admissions[selected.ordinal - 1]!;
    events.push(coverage(admission, "102"));
    const performance = evidenceEvent("performance-facts-complete", "103", Object.freeze({
      admissionId: admission.admissionId,
      runtimeFacts: Object.freeze({
        producerSchedulerJoin: Object.freeze({ source: admission.source }),
      }),
      sixStepFacts: null,
    }));
    selectedPerformanceEventId = performance.eventId;
    events.push(performance);
  }
  return Object.freeze({
    events: Object.freeze(events),
    selection: Object.freeze({ selectedPerformanceEventId }),
  });
}

function selectedOutcomeObservation(
  terminalKind: string,
  reasonCode: string | null,
  includeTerminal = true,
) {
  const admissionId = h(`selected-outcome-admission-${terminalKind}-${reasonCode ?? "null"}`);
  const candidateId = h(`selected-outcome-candidate-${terminalKind}-${reasonCode ?? "null"}`);
  const entry = Object.freeze({
    candidateId,
    disposition: "selected",
    terminalKind,
    routeHash: h(`selected-outcome-route-${terminalKind}`),
    reasonCode,
    evidenceHash: h(`selected-outcome-evidence-${terminalKind}`),
    policyTerminal: null,
    legs: Object.freeze([]),
  });
  const route = evidenceEvent("route-denominator", "1", Object.freeze({
    admissionId,
    headFactsRoot: h("selected-outcome-head-facts"),
    headHash: h("selected-outcome-head"),
    lane: "blockscan",
    correlationId: h("selected-outcome-correlation"),
    coverageRoot: h("selected-outcome-coverage"),
    denominatorKind: "accounted",
    plannerCandidateIdentity: Object.freeze({}),
    accounting: Object.freeze({ entries: Object.freeze([entry]), root: h("selected-outcome-accounting") }),
  }));
  const candidate = evidenceEvent("candidate-set", "2", Object.freeze({
    admissionId,
    headFactsRoot: h("selected-outcome-head-facts"),
    headHash: h("selected-outcome-head"),
    laneDenominators: Object.freeze([Object.freeze({
      lane: "blockscan",
      correlationId: h("selected-outcome-correlation"),
      coverageRoot: h("selected-outcome-coverage"),
      accountingRoot: h("selected-outcome-accounting"),
    })]),
    candidateTerminalObservations: includeTerminal
      ? Object.freeze([Object.freeze({ ...entry, lane: "blockscan" })])
      : Object.freeze([]),
  }));
  const performance = evidenceEvent("performance-facts-complete", "3", Object.freeze({
    admissionId,
    runtimeFacts: Object.freeze({ producerSchedulerJoin: null }),
    sixStepFacts: null,
  }));
  return Object.freeze({ admissionId, candidateId, events: Object.freeze([route, candidate, performance]) });
}

function syntheticSweep(transitionCount: number, sameEdge = false) {
  const base = emptySweep();
  const transitions = Array.from({ length: transitionCount }, (_, index) => {
    const edgeId = h(`edge-${sameEdge ? 0 : index}`);
    const transitionRef = h(`transition-ref-${sameEdge ? 0 : index}`);
    const inputIndex = sameEdge ? index % 2 : index;
    const outputIndex = sameEdge ? Math.floor(index / 2) : index;
    const inputAssetRef = h(`input-asset-${inputIndex}`);
    const inputPortRef = h(`input-port-${inputIndex}`);
    const outputAssetRef = h(`output-asset-${outputIndex}`);
    const outputPortRef = h(`output-port-${outputIndex}`);
    const owningFamilyId = sameEdge ? "matrix-family" : `family-${index % 7}`;
    const transitionId = hashDomain("aloha/full-graph-coarse-transition/v1", {
      edgeId, transitionRef, inputAssetRef, inputPortRef, outputAssetRef, outputPortRef, owningFamilyId,
    });
    return Object.freeze({ transitionId, edgeId, transitionRef, inputAssetRef, inputPortRef, outputAssetRef, outputPortRef, owningFamilyId });
  }).sort((left, right) => {
    const leftKey = `${left.edgeId}\u001f${left.transitionRef}\u001f${left.inputAssetRef}\u001f${left.inputPortRef}\u001f${left.outputAssetRef}\u001f${left.outputPortRef}`;
    const rightKey = `${right.edgeId}\u001f${right.transitionRef}\u001f${right.inputAssetRef}\u001f${right.inputPortRef}\u001f${right.outputAssetRef}\u001f${right.outputPortRef}`;
    return leftKey.localeCompare(rightKey);
  });
  const familyCounts = [...new Set(transitions.map(value => value.owningFamilyId))].sort().map(familyId => {
    const count = String(transitions.filter(value => value.owningFamilyId === familyId).length);
    return Object.freeze({ familyId, expectedTransitionCount: count, observedTransitionCount: count, missingTransitionCount: "0" });
  });
  const transitionIds = Object.freeze(transitions.map(value => value.transitionId));
  const expectedTransitionRoot = fullGraphTransitionSequenceRootV1("expected", transitionIds);
  const observedTransitionRoot = fullGraphTransitionSequenceRootV1("observed", transitionIds);
  const edgePorts = new Map<Hash, {
    inputs: Map<string, Readonly<{ assetRef: Hash; portRef: Hash }>>;
    outputs: Map<string, Readonly<{ assetRef: Hash; portRef: Hash }>>;
  }>();
  for (const value of transitions) {
    const ports = edgePorts.get(value.edgeId) ?? { inputs: new Map(), outputs: new Map() };
    ports.inputs.set(`${value.inputAssetRef}:${value.inputPortRef}`, Object.freeze({ assetRef: value.inputAssetRef, portRef: value.inputPortRef }));
    ports.outputs.set(`${value.outputAssetRef}:${value.outputPortRef}`, Object.freeze({ assetRef: value.outputAssetRef, portRef: value.outputPortRef }));
    edgePorts.set(value.edgeId, ports);
  }
  const entries = Object.freeze(transitions.map((value, index) => {
    const ports = edgePorts.get(value.edgeId)!;
    const ownerDescriptor = Object.freeze({
      ownerRef: h(`owner-${value.owningFamilyId}`),
      capabilityId: `test.${value.owningFamilyId}.coarse`,
      capabilityVersion: "1",
      schemaRef: h(`schema-${value.owningFamilyId}`),
      interpreterHash: h(`interpreter-${value.owningFamilyId}`),
      implementationHash: h(`implementation-${value.owningFamilyId}`),
      boundVerifierHash: h(`bound-verifier-${value.owningFamilyId}`),
    });
    const projection = sealCoarseEdgeProjectionV1(Object.freeze({
      edgeId: value.edgeId,
      transitionRef: value.transitionRef,
      routeBindingHash: h(`route-binding-${index}`),
      generationId: base.binding.generationId,
      graphRoot: base.binding.graphRoot,
      source: base.binding.actualCurrentSource,
      objectiveRef: base.binding.objectiveRef,
      ownerRef: ownerDescriptor.ownerRef,
      capabilityDigest: h(`capability-${index}`),
      dependencyRoot: h(`dependency-${index}`),
      stateFactsRoot: h(`state-facts-${index}`),
      sampleInput: Object.freeze({ assetRef: value.inputAssetRef, amount: "1" }),
      estimatedOutput: Object.freeze({ assetRef: value.outputAssetRef, amount: "2" }),
      conservativeOutputUpperBound: null,
      inputCapacityUpperBound: null,
      status: "rankable" as const,
      reasonCode: null,
    }));
    const receiptBody = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.qualified-coarse-projection-receipt-v1" as const,
      releaseProvenanceHash: base.binding.releaseProvenanceHash,
      releaseMembershipRoot: base.binding.releaseMembershipRoot,
      ownerQualificationLeafDigest: hashDomain("aloha/coarse-owner-qualification-leaf/v1", ownerDescriptor),
      ownerDescriptor,
      projection,
      boundVerification: null,
    });
    const receipt = Object.freeze({
      ...receiptBody,
      receiptRoot: qualifiedCoarseProjectionReceiptRootV1(receiptBody),
    });
    const entryBody = Object.freeze({
      bindingRoot: base.binding.bindingRoot, ordinal: String(index), transitionId: value.transitionId,
      edge: Object.freeze({
        edgeId: value.edgeId,
        opaqueTransitionRef: value.transitionRef,
        owningFamilyId: value.owningFamilyId,
        inputAssetPorts: Object.freeze([...ports.inputs.values()]),
        outputAssetPorts: Object.freeze([...ports.outputs.values()]),
      }),
      inputAssetRef: value.inputAssetRef, inputPortRef: value.inputPortRef,
      outputAssetRef: value.outputAssetRef, outputPortRef: value.outputPortRef,
      status: "observed" as const, missingReason: null, receipt,
      familyObservation: Object.freeze({ kind: "synthetic-family-observation" }),
    });
    return Object.freeze({
      ...entryBody,
      entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", entryBody),
    });
  }));
  const sweep = sealFullGraphCoarseSweepV1(Object.freeze({
    ...base, expectedTransitionCount: String(transitionCount), expectedTransitionIds: transitionIds,
    expectedTransitionRoot, observedTransitionCount: String(transitionCount), observedTransitionIds: transitionIds,
    observedTransitionRoot, familyTransitionCounts: Object.freeze(familyCounts), entries,
  }) as unknown as Omit<FullGraphCoarseSweepV1, "sweepRoot">);
  const edgeIds = [...new Set(transitions.map(value => value.edgeId))].sort() as Hash[];
  const familyEdgeCounts = [...new Set(transitions.map(value => value.owningFamilyId))].sort().map(familyId => Object.freeze({
    familyId,
    edgeCount: String(new Set(transitions.filter(value => value.owningFamilyId === familyId).map(value => value.edgeId)).size),
  }));
  const activeGraph = Object.freeze({
    ...activeGraphFor(sweep), edgeCount: String(edgeIds.length), orderedEdgeIds: Object.freeze(edgeIds),
    orderedEdges: Object.freeze(edgeIds.map(edgeId => Object.freeze({ edgeId }))),
    orderedTransitions: Object.freeze(transitions), familyEdgeCounts: Object.freeze(familyEdgeCounts),
    familyTransitionCounts: Object.freeze(familyCounts.map(value => Object.freeze({ familyId: value.familyId, transitionCount: value.expectedTransitionCount }))),
  });
  return Object.freeze({ sweep, activeGraph });
}

function unavailableReuse() {
  return Object.freeze({
    status: "unavailable" as const,
    code: "verified-release-authority-composition-unavailable" as const,
    advisoryOnly: true as const,
  });
}

function availableReuse() {
  const entry = Object.freeze({
    proposalLeafDigest: h("proposal"),
    criticalMutationCorpusRoot: h("mutation-corpus"),
    independentOracleCaseRoot: h("oracle-cases"),
    qualificationSpecDigest: h("qualification-spec"),
    verifierQualificationCertificateRoot: h("qualification-certificate"),
    qualificationLeafDigest: h("qualification-leaf"),
  });
  const preSignBase = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.nomination-qualification-pre-sign-report" as const,
    advisoryOnly: true as const,
    priorDeploymentFactId: h("prior-deployment-fact"),
    priorRuntimeBindingId: h("prior-runtime-binding"),
    priorSnapshotRoot: h("prior-snapshot"),
    currentSnapshotRoot: h("current-snapshot"),
    currentFamilyProposalOwnershipRoot: h("family-proposal-ownership"),
    currentSemanticLedgerHash: h("semantic-ledger"),
    currentSemanticOutputRoot: h("semantic-output"),
    currentBoundaryVerificationReceiptRoot: h("boundary-verification"),
    reusedFamilies: Object.freeze([Object.freeze({
      familyId: "univ2-standard",
      artifactId: "family:univ2-standard",
      nominationProposalLeafDigests: Object.freeze([entry.proposalLeafDigest]),
      nominationQualificationEntries: Object.freeze([entry]),
    })]),
    requalificationDenominator: Object.freeze([Object.freeze({
      familyId: "univ3-standard",
      artifactId: "family:univ3-standard",
      nominationProposalLeafDigests: Object.freeze([h("affected-proposal")]),
      reason: "catalog-impact-affected" as const,
    })]),
  });
  const preSignReport = Object.freeze({
    ...preSignBase,
    reportRoot: hashDomain("aloha/nomination-qualification-pre-sign-report/v1", preSignBase),
  });
  const postSignBase = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.nomination-qualification-post-sign-report" as const,
    advisoryOnly: true as const,
    preSignReportRoot: preSignReport.reportRoot,
    currentDeploymentFactId: h("current-deployment-fact"),
    currentRuntimeBindingId: release.runtimeBindingId,
    currentSnapshotRoot: preSignReport.currentSnapshotRoot,
    verifiedQualificationEntryCount: 2,
  });
  return Object.freeze({
    status: "available" as const,
    advisoryOnly: true as const,
    preSignReport,
    postSignReport: Object.freeze({
      ...postSignBase,
      reportRoot: hashDomain("aloha/nomination-qualification-post-sign-report/v1", postSignBase),
    }),
  });
}

function sealAdvisoryReport(report: Readonly<Record<string, unknown>>): CanonicalJson {
  const { judgmentRoot: _judgmentRoot, ...payload } = report;
  return Object.freeze({
    ...payload,
    judgmentRoot: hashDomain("aloha/pre-release-acceptance-advisory-judgment/v1", payload as CanonicalJson),
  }) as CanonicalJson;
}

function rewriteSealedReport(
  path: string,
  mutate: (report: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): void {
  const report = decodeCanonicalBytes(Uint8Array.from(readFileSync(path))) as Readonly<Record<string, unknown>>;
  writeFileSync(path, encodeCanonicalBytes(sealAdvisoryReport(mutate(report))));
}

function rewriteFullyRerootedReuse(
  path: string,
  mutate: (reuse: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): void {
  rewriteSealedReport(path, report => {
    const changed = mutate(report.nominationQualificationReuse as Readonly<Record<string, unknown>>);
    const rawPre = changed.preSignReport as Readonly<Record<string, unknown>>;
    const { reportRoot: _preRoot, ...preBase } = rawPre;
    const preSignReport = Object.freeze({
      ...preBase,
      reportRoot: hashDomain("aloha/nomination-qualification-pre-sign-report/v1", preBase as CanonicalJson),
    });
    const rawPost = changed.postSignReport as Readonly<Record<string, unknown>>;
    const { reportRoot: _postRoot, ...rawPostBase } = rawPost;
    const postBase = Object.freeze({ ...rawPostBase, preSignReportRoot: preSignReport.reportRoot });
    const postSignReport = Object.freeze({
      ...postBase,
      reportRoot: hashDomain("aloha/nomination-qualification-post-sign-report/v1", postBase as CanonicalJson),
    });
    return { ...report, nominationQualificationReuse: { ...changed, preSignReport, postSignReport } };
  });
}

function createPhysicalInput(
  nominationQualificationReuse: CanonicalJson = unavailableReuse(),
  sweep: FullGraphCoarseSweepV1 = emptySweep(),
  nativeAuditOverride: NativeFullFamilyAuditV1 | null = null,
): Readonly<{
  reportPath: string;
  sweepObjectPath: string;
  terminalBindingObjectPath: string;
  chunkObjectPaths: readonly string[];
  nativeChunkObjectPaths: readonly string[];
}> {
  const root = mkdtempSync(join(tmpdir(), "aloha-pre-release-fact-log-"));
  const databasePath = join(root, "production-evidence.sqlite");
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath, release: {
    bindingId: release.runtimeBindingId,
    releaseProvenanceHash: release.releaseProvenanceHash,
    candidateReleaseCommit: release.candidateReleaseCommit,
  }, runtimeAnchor: runtimeAnchor(), economicSafety });
  owner.close();
  const databaseStat = statSync(databasePath, { bigint: true });
  const databaseSha256 = sha256Hex(readFileSync(databasePath));

  const encodedSweep = encodeFullGraphCoarseSweepV1(sweep);
  const sweepBytes = encodedSweep.manifestBytes;
  const sweepContentSha256 = sha256Hex(sweepBytes);
  const storeDirectory = join(root, "observer-content");
  mkdirSync(storeDirectory, { mode: 0o700 });
  const storeIdentityHash = h("observer-store");
  const markerPath = join(storeDirectory, ".aloha-observer-store-identity-v1");
  writeFileSync(markerPath, `${storeIdentityHash}\n`, { mode: 0o400 });
  chmodSync(markerPath, 0o400);
  const finalDurableWindowId = h("window");
  const audit = nativeAuditOverride ?? nativeAudit(sweep);
  const { auditRoot: _nativeAuditRoot, ...nativeAuditBody } = audit;
  const encodedNativeAudit = encodeNativeFullFamilyAuditBodyV1(nativeAuditBody);
  const terminalBindingPayload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-full-family-terminal-binding-v1" as const,
    runtimeBindingId: release.runtimeBindingId,
    candidateReleaseCommit: release.candidateReleaseCommit,
    releaseProvenanceHash: release.releaseProvenanceHash,
    finalDurableWindowId,
    producerTerminalId: h("producer-terminal"),
    producerHeadFactsRoot: h("producer-head-facts"),
    producerTerminalBindingRoot: h("producer-terminal-binding"),
    laneTerminalSetRoot: h("lane-terminal-set"),
    searchTerminalHash: h("search-terminal"),
    terminalKind: "route-set-terminal" as const,
    terminalLineageHash: h("terminal-lineage"),
    readyRecordHash: audit.binding.readyRecordHash,
    generationId: audit.binding.generationId,
    graphRoot: audit.binding.graphRoot,
    generatedRuntime: Object.freeze({
      releaseIntentRoot: h("release-intent"),
      definitionCatalogRoot: h("generated-definition-catalog"),
      runtimeDescriptorRoot: h("runtime-descriptor"),
      families: Object.freeze([Object.freeze({
        familyId: "synthetic-family",
        familyDefinitionHash: h("synthetic-family-definition"),
        sourcePlanRoot: h("synthetic-source-plan"),
        sourcePlanRefs: Object.freeze([]),
      })]),
    }),
    readyCutoff: audit.binding.readyCutoff,
    actualCurrentSource: audit.binding.actualCurrentSource,
    nativeAuditManifest: encodedNativeAudit.manifest,
  });
  const terminalBinding = Object.freeze({
    ...terminalBindingPayload,
    bindingRoot: hashDomain("aloha/runtime-release-full-family-terminal-binding/v1", terminalBindingPayload),
  });
  const terminalBindingBytes = encodeCanonicalBytes(terminalBinding);
  const terminalBindingContentSha256 = sha256Hex(terminalBindingBytes);
  const terminalBindingArtifactRefId = h("terminal-binding-ref");
  const terminalBindingObjectPath = join(storeDirectory, terminalBindingContentSha256.slice(2));
  writeFileSync(terminalBindingObjectPath, terminalBindingBytes, { mode: 0o400 });
  chmodSync(terminalBindingObjectPath, 0o400);
  const nativeChunkObjectPaths: string[] = [];
  for (const chunk of encodedNativeAudit.chunks) {
    const chunkPath = join(storeDirectory, chunk.ref.contentSha256.slice(2));
    writeFileSync(chunkPath, chunk.bytes, { mode: 0o400 });
    chmodSync(chunkPath, 0o400);
    nativeChunkObjectPaths.push(chunkPath);
  }
  const sweepObjectPath = join(storeDirectory, sweepContentSha256.slice(2));
  writeFileSync(sweepObjectPath, sweepBytes, { mode: 0o400 });
  chmodSync(sweepObjectPath, 0o400);
  const chunkObjectPaths: string[] = [];
  for (const chunk of encodedSweep.chunks) {
    const chunkPath = join(storeDirectory, chunk.ref.contentSha256.slice(2));
    writeFileSync(chunkPath, chunk.bytes, { mode: 0o400 });
    chmodSync(chunkPath, 0o400);
    chunkObjectPaths.push(chunkPath);
  }
  const storeStat = statSync(storeDirectory, { bigint: true });

  const sweepArtifactRefId = h("sweep-artifact-ref");
  const indexBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-locator-index-v1" as const,
    finalDurableWindowId,
    fullFamilyTerminalBindingArtifact: Object.freeze({
      contentSha256: terminalBindingContentSha256,
      ref: Object.freeze({
        artifactRefId: terminalBindingArtifactRefId,
        contentSha256: terminalBindingContentSha256,
        byteLength: terminalBindingBytes.byteLength.toString(),
        locator: Object.freeze({ kind: "content-object", storeIdentityHash, objectKey: terminalBindingContentSha256 }),
        immutableMirrorLocator: Object.freeze({ kind: "content-object", storeIdentityHash, objectKey: terminalBindingContentSha256 }),
      }),
      claim: null,
      lease: null,
    }),
    fullGraphCoarseSweepArtifact: Object.freeze({
      contentSha256: sweepContentSha256,
      ref: Object.freeze({
        artifactRefId: sweepArtifactRefId,
        contentSha256: sweepContentSha256,
        byteLength: sweepBytes.byteLength.toString(),
        locator: Object.freeze({ kind: "content-object", storeIdentityHash, objectKey: sweepContentSha256 }),
        immutableMirrorLocator: Object.freeze({ kind: "content-object", storeIdentityHash, objectKey: sweepContentSha256 }),
      }),
      claim: null,
      lease: null,
    }),
  });
  const index = Object.freeze({
    ...indexBody,
    indexRoot: hashDomain("aloha/production-terminal-phase-locator-index/v1", indexBody),
  });
  const indexBytes = encodeCanonicalBytes(index);
  const terminalLocatorDirectory = join(root, "terminal-locators");
  mkdirSync(terminalLocatorDirectory, { mode: 0o700 });
  const indexPath = join(terminalLocatorDirectory, `${finalDurableWindowId.slice(2)}.json`);
  writeFileSync(indexPath, indexBytes, { mode: 0o600 });
  const indexStat = statSync(indexPath, { bigint: true });

  const factIndex = Object.freeze({
    terminalPhase: Object.freeze({
      finalDurableWindowId,
      terminalLocatorDirectory,
      observerContentStore: Object.freeze({
        directory: storeDirectory,
        device: storeStat.dev.toString(),
        inode: storeStat.ino.toString(),
        storeIdentityHash,
      }),
      index: Object.freeze({
        path: indexPath,
        device: indexStat.dev.toString(),
        inode: indexStat.ino.toString(),
        contentSha256: sha256Hex(indexBytes),
        byteLength: indexBytes.byteLength.toString(),
        indexRoot: index.indexRoot,
      }),
      locator: Object.freeze({ locatorRoot: h("locator-root"), artifactRefId: h("locator-ref"), contentSha256: h("locator-content") }),
      manifest: Object.freeze({ manifestRoot: h("manifest-root"), artifactRefId: h("manifest-ref"), contentSha256: h("manifest-content") }),
      fullFamilyTerminalBinding: Object.freeze({
        artifactRefId: terminalBindingArtifactRefId,
        contentSha256: terminalBindingContentSha256,
      }),
      fullGraphCoarseSweep: Object.freeze({
        artifactRefId: sweepArtifactRefId,
        contentSha256: sweepContentSha256,
        sweepRoot: sweep.sweepRoot,
        expectedTransitionCount: sweep.expectedTransitionCount,
        expectedTransitionRoot: sweep.expectedTransitionRoot,
        observedTransitionCount: sweep.observedTransitionCount,
        observedTransitionRoot: sweep.observedTransitionRoot,
        missingTransitionCount: sweep.missingTransitionCount,
        missingTransitionRoot: sweep.missingTransitionRoot,
        familyTransitionCounts: sweep.familyTransitionCounts,
      }),
      sixStepPhysicalStatus: "observed" as const,
      sixStepPhysicalReason: null,
    }),
    processEvidenceQuery: Object.freeze({
      databasePath,
      routeDenominator: Object.freeze({
        namespace: "searcher-production-evidence/route-denominators/v1" as const,
        eventType: "route-denominator" as const,
        accountingEntriesPath: "payload.accounting.entries" as const,
      }),
      candidateSet: Object.freeze({
        namespace: "searcher-production-evidence/candidate-sets/v1" as const,
        eventType: "candidate-set" as const,
        laneDenominatorsPath: "payload.laneDenominators" as const,
        terminalObservationsPath: "payload.candidateTerminalObservations" as const,
      }),
      joins: joinContract(),
      exactAdmission: Object.freeze({
        sourcePath: "payload.accounting.entries[].disposition" as const,
        disposition: "selected" as const,
      }),
    }),
  });
  const frozenCheckpointSnapshotPublication = Object.freeze({
    sourcePath: join(root, "runtime-checkpoint.sqlite"),
    snapshotPath: join(root, "frozen-b-checkpoint.sqlite"),
    contentSha256: h("checkpoint-snapshot"),
    byteLength: "1",
    device: "1",
    inode: "1",
    uid: "0" as const,
    gid: "0" as const,
    mode: "384" as const,
    fileFsynced: true as const,
    directoryFsynced: true as const,
  });
  const reportPayload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.pre-release-acceptance-advisory-judgment" as const,
    status: "incomplete",
    reasons: Object.freeze([]),
    release,
    physicalProcess: Object.freeze({
      processAnchorHash: h("process-anchor"), pid: "1", processStartTicks: "1",
      bootIdHash: h("boot-id"), executableHash: h("executable"), dryRun: true as const,
    }),
    authority: Object.freeze({
      advisoryOnly: true,
      candidateGeneratedAuthority: null,
      runtimeReleaseBinding: null,
      releaseAuthority: null,
      submissionAuthority: null,
      sign: false,
      broadcast: false,
      promote: false,
    }),
    factBinding: Object.freeze({
      processImportReceiptId: h("process-import"),
      databaseContentSha256: databaseSha256,
      terminalSnapshotTrustRoot: h("terminal-snapshot-trust"),
    }),
    factLocators: Object.freeze({
      processEvidenceDatabasePath: databasePath,
      checkpointDatabasePath: frozenCheckpointSnapshotPublication.sourcePath,
      frozenCheckpointSnapshotPublication,
      observerStoreDirectory: storeDirectory,
      authorizationLedgerPath: join(root, "authorization-ledger.json"),
      processEvidenceDatabase: Object.freeze({
        path: databasePath,
        device: databaseStat.dev.toString(),
        inode: databaseStat.ino.toString(),
        contentSha256: databaseSha256,
      }),
      logWindow: Object.freeze({
        path: join(root, "runtime.log"), device: "1", inode: "1",
        startInclusive: "0", endExclusive: "1", contentSha256: h("log"),
      }),
    }),
    artifactLocators: Object.freeze([]),
    factIndex,
    evaluations: Object.freeze([]),
    nominationQualificationReuse,
    judgedAtUnixNs: "1",
  });
  const report = sealAdvisoryReport(reportPayload);
  const reportPath = join(root, "advisory-report.json");
  writeFileSync(reportPath, encodeCanonicalBytes(report));
  return Object.freeze({
    reportPath,
    sweepObjectPath,
    terminalBindingObjectPath,
    chunkObjectPaths: Object.freeze(chunkObjectPaths),
    nativeChunkObjectPaths: Object.freeze(nativeChunkObjectPaths),
  });
}

test("structural fixture reopens physical advisory locators but cannot claim root-owned authority", () => {
  const input = createPhysicalInput();
  const records = readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor());
  assert.ok(records.some(record => record.kind === "aloha.pre-release-full-graph-summary-v1"));
  assert.ok(records.some(record => record.kind === "aloha.pre-release-fact-error-v1"));
  assert.ok(records.some(record => (
    record.kind === "aloha.pre-release-nomination-qualification-reuse-claim-v1"
    && record.producerStatus === "unavailable"
    && record.producerCode === "verified-release-authority-composition-unavailable"
    && record.advisoryOnly === true
    && record.sourceClassification === "self-consistent-advisory-claim"
  )));
  assert.ok(records.every(record => !("verdict" in record)));
  assert.ok(records.every(record => record.advisoryOnly === true));
  assert.ok(records.filter(record => record.sourceClassification !== "self-consistent-advisory-claim")
    .every(record => record.sourceClassification === "invalid-basis"));
  const jsonl = Buffer.from(encodePreReleaseFactLogJsonlV1(records)).toString("utf8");
  assert.ok(jsonl.endsWith("\n"));
  for (const line of jsonl.trimEnd().split("\n")) decodeCanonicalBytes(Uint8Array.from(Buffer.from(line)));
});

test("fails closed when the content-addressed Full-Graph object changes", () => {
  const input = createPhysicalInput();
  chmodSync(input.sweepObjectPath, 0o600);
  writeFileSync(input.sweepObjectPath, encodeCanonicalBytes({ changed: true }));
  chmodSync(input.sweepObjectPath, 0o400);
  assert.throws(() => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()), /(?:byte length|content hash) changed/);
});

test("fails closed when the indexed Full-Family terminal binding content object changes", () => {
  const input = createPhysicalInput();
  chmodSync(input.terminalBindingObjectPath, 0o600);
  writeFileSync(input.terminalBindingObjectPath, encodeCanonicalBytes({ changed: true }));
  chmodSync(input.terminalBindingObjectPath, 0o400);
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()),
    /(?:byte length|content hash) changed/,
  );
});

test("native audit schema and hash mutations fail closed before advisory facts are emitted", () => {
  const sweep = emptySweep();
  const audit = nativeAudit(sweep);
  assert.throws(
    () => buildPreReleaseFactLogRecordsV1(
      structuralReportFor(sweep) as never,
      rawObservation() as never,
      sweep,
      activeGraphFor() as never,
      Object.freeze({ ...audit, unexpected: true }) as never,
    ),
    /keys mismatch|unexpected/i,
  );
  assert.throws(
    () => buildPreReleaseFactLogRecordsV1(
      structuralReportFor(sweep) as never,
      rawObservation() as never,
      sweep,
      activeGraphFor() as never,
      Object.freeze({ ...audit, auditRoot: h("tampered-native-audit-root") }) as never,
    ),
    /manifest root mismatch/,
  );
});

test("fails closed when a physical middle Full-Graph entry chunk is missing", () => {
  const fixture = syntheticSweep(300);
  const input = createPhysicalInput(unavailableReuse(), fixture.sweep);
  assert.ok(input.chunkObjectPaths.length >= 3);
  unlinkSync(input.chunkObjectPaths[1]!);
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, fixture.activeGraph as never),
    /ENOENT|no such file/i,
  );
});

test("physical native audit chunks fail closed when missing, reordered, next-mutated, or cross-audit", () => {
  const sweep = emptySweep();
  const audit = nativeAuditWithProjectedCount(300);
  const make = () => createPhysicalInput(unavailableReuse(), sweep, audit);

  const missing = make();
  assert.ok(missing.nativeChunkObjectPaths.length >= 3);
  unlinkSync(missing.nativeChunkObjectPaths[1]!);
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(missing.reportPath, activeGraphFor() as never),
    /ENOENT|no such file/i,
  );

  const reordered = make();
  chmodSync(reordered.nativeChunkObjectPaths[0]!, 0o600);
  writeFileSync(reordered.nativeChunkObjectPaths[0]!, readFileSync(reordered.nativeChunkObjectPaths[1]!));
  chmodSync(reordered.nativeChunkObjectPaths[0]!, 0o400);
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(reordered.reportPath, activeGraphFor() as never),
    /byte length|content hash|content mismatch/i,
  );

  const nextMutated = make();
  const rawChunk = decodeCanonicalBytes(
    new Uint8Array(readFileSync(nextMutated.nativeChunkObjectPaths[0]!)),
  ) as Readonly<Record<string, unknown>>;
  chmodSync(nextMutated.nativeChunkObjectPaths[0]!, 0o600);
  writeFileSync(nextMutated.nativeChunkObjectPaths[0]!, encodeCanonicalBytes({ ...rawChunk, nextChunkRef: null }));
  chmodSync(nextMutated.nativeChunkObjectPaths[0]!, 0o400);
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(nextMutated.reportPath, activeGraphFor() as never),
    /byte length|content hash|content mismatch/i,
  );

  const cross = make();
  const other = createPhysicalInput(unavailableReuse(), sweep, nativeAuditWithProjectedCount(301));
  chmodSync(cross.nativeChunkObjectPaths[0]!, 0o600);
  writeFileSync(cross.nativeChunkObjectPaths[0]!, readFileSync(other.nativeChunkObjectPaths[0]!));
  chmodSync(cross.nativeChunkObjectPaths[0]!, 0o400);
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(cross.reportPath, activeGraphFor() as never),
    /byte length|content hash|content mismatch/i,
  );
});

test("fails closed when the advisory fact index describes a different join", () => {
  const input = createPhysicalInput();
  rewriteSealedReport(input.reportPath, report => {
    const factIndex = report.factIndex as Readonly<Record<string, unknown>>;
    const query = factIndex.processEvidenceQuery as Readonly<Record<string, unknown>>;
    const joins = query.joins as Readonly<Record<string, unknown>>;
    return {
      ...report,
      factIndex: {
        ...factIndex,
        processEvidenceQuery: {
          ...query,
          joins: { ...joins, head: [] },
        },
      },
    };
  });
  assert.throws(() => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()), /joins mismatch/);
});

test("exact-decodes available reuse reports and emits only advisory claims", () => {
  const input = createPhysicalInput(availableReuse());
  const records = readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor());
  const summary = records.find(record => record.kind === "aloha.pre-release-nomination-qualification-reuse-claim-v1");
  assert.equal(summary?.producerStatus, "available");
  assert.equal(summary?.reusedFamilyCount, "1");
  assert.equal(summary?.requalificationFamilyCount, "1");
  assert.equal(summary?.verifiedQualificationEntryCount, "2");
  assert.equal(records.filter(
    record => record.kind === "aloha.pre-release-nomination-qualification-reused-family-claim-v1",
  ).length, 1);
  const entry = records.find(
    record => record.kind === "aloha.pre-release-nomination-qualification-reused-entry-claim-v1",
  );
  assert.equal(entry?.familyId, "univ2-standard");
  assert.equal(entry?.proposalLeafDigest, h("proposal"));
  assert.equal(records.filter(
    record => record.kind === "aloha.pre-release-nomination-requalification-denominator-claim-v1",
  ).length, 1);
  const reuseClaims = records.filter(record => /nomination-(?:qualification|requalification)/.test(record.kind));
  assert.ok(reuseClaims.every(record => record.advisoryOnly === true));
  assert.ok(reuseClaims.every(record => record.sourceClassification === "self-consistent-advisory-claim"));
  assert.ok(reuseClaims.every(record => record.kind.endsWith("-claim-v1")));
  assert.ok(reuseClaims.every(record => !("status" in record) && !("verdict" in record)));
});

test("rejects a mutated nomination qualification pre-sign report root", () => {
  const input = createPhysicalInput(availableReuse());
  rewriteSealedReport(input.reportPath, report => {
    const reuse = report.nominationQualificationReuse as Readonly<Record<string, unknown>>;
    const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
    return { ...report, nominationQualificationReuse: { ...reuse, preSignReport: { ...pre, reportRoot: h("bad-pre-root") } } };
  });
  assert.throws(() => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()), /preSignReport\.reportRoot mismatch/);
});

test("rejects a mutated nomination qualification post-sign report root", () => {
  const input = createPhysicalInput(availableReuse());
  rewriteSealedReport(input.reportPath, report => {
    const reuse = report.nominationQualificationReuse as Readonly<Record<string, unknown>>;
    const post = reuse.postSignReport as Readonly<Record<string, unknown>>;
    return { ...report, nominationQualificationReuse: { ...reuse, postSignReport: { ...post, reportRoot: h("bad-post-root") } } };
  });
  assert.throws(() => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()), /postSignReport\.reportRoot mismatch/);
});

test("rejects a mutated outer advisory judgment root", () => {
  const input = createPhysicalInput(availableReuse());
  const report = decodeCanonicalBytes(Uint8Array.from(readFileSync(input.reportPath))) as Readonly<Record<string, unknown>>;
  writeFileSync(input.reportPath, encodeCanonicalBytes({ ...report, judgmentRoot: h("bad-judgment-root") } as CanonicalJson));
  assert.throws(() => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()), /report\.judgmentRoot mismatch/);
});

test("rejects a mutated reused qualification entry", () => {
  const input = createPhysicalInput(availableReuse());
  rewriteSealedReport(input.reportPath, report => {
    const reuse = report.nominationQualificationReuse as Readonly<Record<string, unknown>>;
    const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
    const families = pre.reusedFamilies as readonly Readonly<Record<string, unknown>>[];
    const family = families[0]!;
    const entries = family.nominationQualificationEntries as readonly Readonly<Record<string, unknown>>[];
    return {
      ...report,
      nominationQualificationReuse: {
        ...reuse,
        preSignReport: {
          ...pre,
          reusedFamilies: [{
            ...family,
            nominationQualificationEntries: [{ ...entries[0]!, criticalMutationCorpusRoot: h("mutated-entry") }],
          }],
        },
      },
    };
  });
  assert.throws(() => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()), /preSignReport\.reportRoot mismatch/);
});

test("a fully re-rooted reuse entry remains explicitly a self-consistent advisory claim", () => {
  const input = createPhysicalInput(availableReuse());
  rewriteFullyRerootedReuse(input.reportPath, reuse => {
    const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
    const families = pre.reusedFamilies as readonly Readonly<Record<string, unknown>>[];
    const family = families[0]!;
    const entries = family.nominationQualificationEntries as readonly Readonly<Record<string, unknown>>[];
    return {
      ...reuse,
      preSignReport: {
        ...pre,
        reusedFamilies: [{
          ...family,
          nominationQualificationEntries: [{ ...entries[0]!, criticalMutationCorpusRoot: h("attacker-reroot") }],
        }],
      },
    };
  });
  const records = readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor());
  const reuseClaims = records.filter(record => /nomination-(?:qualification|requalification)/.test(record.kind));
  assert.ok(reuseClaims.length > 0);
  assert.ok(reuseClaims.every(record => record.kind.endsWith("-claim-v1")));
  assert.ok(reuseClaims.every(record => record.advisoryOnly === true));
  assert.ok(reuseClaims.every(record => record.sourceClassification === "self-consistent-advisory-claim"));
  assert.ok(reuseClaims.every(record => !("status" in record) && !("verdict" in record)));
  assert.equal(
    (reuseClaims.find(record => record.kind.includes("reused-entry"))?.entry as Readonly<Record<string, unknown>>)
      .criticalMutationCorpusRoot,
    h("attacker-reroot"),
  );
});

test("rejects a fully re-rooted report after deleting the requalification denominator", () => {
  const input = createPhysicalInput(availableReuse());
  rewriteFullyRerootedReuse(input.reportPath, reuse => {
    const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
    return { ...reuse, preSignReport: { ...pre, requalificationDenominator: [] } };
  });
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()),
    /proposal partition must equal verified entry count/,
  );
});

test("rejects a fully re-rooted post-sign binding that does not join the outer release", () => {
  const input = createPhysicalInput(availableReuse());
  rewriteFullyRerootedReuse(input.reportPath, reuse => {
    const post = reuse.postSignReport as Readonly<Record<string, unknown>>;
    return { ...reuse, postSignReport: { ...post, currentRuntimeBindingId: h("attacker-binding") } };
  });
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()),
    /current runtime binding does not join report release/,
  );
});

test("rejects a fully re-rooted post-sign snapshot that does not join pre-sign", () => {
  const input = createPhysicalInput(availableReuse());
  rewriteFullyRerootedReuse(input.reportPath, reuse => {
    const post = reuse.postSignReport as Readonly<Record<string, unknown>>;
    return { ...reuse, postSignReport: { ...post, currentSnapshotRoot: h("attacker-snapshot") } };
  });
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()),
    /current snapshot binding mismatch/,
  );
});

test("rejects duplicate or overlapping reuse partition identities after full re-rooting", () => {
  const cases = [
    {
      label: "Family overlap",
      expected: /Family partition must be globally unique and disjoint/,
      mutate(reuse: Readonly<Record<string, unknown>>) {
        const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
        const reused = pre.reusedFamilies as readonly Readonly<Record<string, unknown>>[];
        const denominator = pre.requalificationDenominator as readonly Readonly<Record<string, unknown>>[];
        return {
          ...reuse,
          preSignReport: {
            ...pre,
            requalificationDenominator: [{ ...denominator[0]!, familyId: reused[0]!.familyId }],
          },
        };
      },
    },
    {
      label: "artifact overlap",
      expected: /artifact partition must be globally unique and disjoint/,
      mutate(reuse: Readonly<Record<string, unknown>>) {
        const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
        const reused = pre.reusedFamilies as readonly Readonly<Record<string, unknown>>[];
        const denominator = pre.requalificationDenominator as readonly Readonly<Record<string, unknown>>[];
        return {
          ...reuse,
          preSignReport: {
            ...pre,
            requalificationDenominator: [{ ...denominator[0]!, artifactId: reused[0]!.artifactId }],
          },
        };
      },
    },
    {
      label: "proposal overlap",
      expected: /proposal partition must be globally unique and disjoint/,
      mutate(reuse: Readonly<Record<string, unknown>>) {
        const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
        const reused = pre.reusedFamilies as readonly Readonly<Record<string, unknown>>[];
        const proposals = reused[0]!.nominationProposalLeafDigests as readonly Hash[];
        const denominator = pre.requalificationDenominator as readonly Readonly<Record<string, unknown>>[];
        return {
          ...reuse,
          preSignReport: {
            ...pre,
            requalificationDenominator: [{ ...denominator[0]!, nominationProposalLeafDigests: [proposals[0]!] }],
          },
        };
      },
    },
    {
      label: "duplicate proposal",
      expected: /proposal partition must be globally unique and disjoint/,
      mutate(reuse: Readonly<Record<string, unknown>>) {
        const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
        const reused = pre.reusedFamilies as readonly Readonly<Record<string, unknown>>[];
        const family = reused[0]!;
        const proposals = family.nominationProposalLeafDigests as readonly Hash[];
        const entries = family.nominationQualificationEntries as readonly Readonly<Record<string, unknown>>[];
        const post = reuse.postSignReport as Readonly<Record<string, unknown>>;
        return {
          ...reuse,
          preSignReport: {
            ...pre,
            reusedFamilies: [{
              ...family,
              nominationProposalLeafDigests: [proposals[0]!, proposals[0]!],
              nominationQualificationEntries: [entries[0]!, entries[0]!],
            }],
          },
          postSignReport: { ...post, verifiedQualificationEntryCount: 3 },
        };
      },
    },
    {
      label: "empty Family proposal set",
      expected: /Family proposal set must be non-empty/,
      mutate(reuse: Readonly<Record<string, unknown>>) {
        const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
        const denominator = pre.requalificationDenominator as readonly Readonly<Record<string, unknown>>[];
        const post = reuse.postSignReport as Readonly<Record<string, unknown>>;
        return {
          ...reuse,
          preSignReport: {
            ...pre,
            requalificationDenominator: [{ ...denominator[0]!, nominationProposalLeafDigests: [] }],
          },
          postSignReport: { ...post, verifiedQualificationEntryCount: 1 },
        };
      },
    },
  ];
  for (const item of cases) {
    const input = createPhysicalInput(availableReuse());
    rewriteFullyRerootedReuse(input.reportPath, item.mutate);
    assert.throws(() => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()), item.expected, item.label);
  }
});

test("rejects extra fields in nomination qualification reuse reports", () => {
  const input = createPhysicalInput(availableReuse());
  rewriteSealedReport(input.reportPath, report => {
    const reuse = report.nominationQualificationReuse as Readonly<Record<string, unknown>>;
    const pre = reuse.preSignReport as Readonly<Record<string, unknown>>;
    return { ...report, nominationQualificationReuse: { ...reuse, preSignReport: { ...pre, unexpected: true } } };
  });
  assert.throws(() => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraphFor()), /unexpected|exact/i);
});

test("candidate joins retain every denominator entry while exact list selects only selected", () => {
  const admissionId = h("admission");
  const headFactsRoot = h("head-facts");
  const headHash = h("joined-head");
  const correlationId = h("correlation");
  const coverageRoot = h("coverage");
  const accountingRoot = h("accounting");
  const first = Object.freeze({
    candidateId: h("candidate-a"), disposition: "selected", terminalKind: "passed", routeHash: h("route-a"),
    reasonCode: null, evidenceHash: h("evidence-a"), policyTerminal: null, legs: Object.freeze([]),
  });
  const second = Object.freeze({
    candidateId: h("candidate-b"), disposition: "pruned", terminalKind: "chainProvenRejected", routeHash: h("route-b"),
    reasonCode: "exact:rejected", evidenceHash: h("evidence-b"), policyTerminal: null, legs: Object.freeze([]),
  });
  const routePayload = Object.freeze({
    admissionId, headFactsRoot, headHash, lane: "blockscan", correlationId, coverageRoot,
    denominatorKind: "accounted", plannerCandidateIdentity: Object.freeze({}),
    accounting: Object.freeze({ entries: Object.freeze([first, second]), root: accountingRoot }),
  });
  const terminalA = Object.freeze({ ...first, lane: "blockscan" as const });
  const terminalB = Object.freeze({ ...second, lane: "blockscan" as const });
  const candidatePayload = Object.freeze({
    admissionId, headFactsRoot, headHash,
    laneDenominators: Object.freeze([Object.freeze({ lane: "blockscan", correlationId, coverageRoot, accountingRoot })]),
    candidateTerminalObservations: Object.freeze([terminalA, terminalB]),
  });
  const event = (eventType: "route-denominator" | "candidate-set", payload: CanonicalJson, sequence: string) => Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-evidence-event" as const,
    eventId: h(`event-${sequence}`),
    eventType,
    sequence,
    namespace: eventType === "route-denominator"
      ? "searcher-production-evidence/route-denominators/v1" as const
      : "searcher-production-evidence/candidate-sets/v1" as const,
    release: Object.freeze({ bindingId: release.runtimeBindingId, releaseProvenanceHash: release.releaseProvenanceHash, candidateReleaseCommit: release.candidateReleaseCommit }),
    runtimeAnchor: Object.freeze({}),
    serving: null,
    payload: payload as Readonly<Record<string, unknown>>,
  });
  const observation = Object.freeze({
    kind: "aloha.raw-production-performance-observation-v1" as const,
    status: "incomplete" as const,
    reasons: Object.freeze([]),
    databaseSha256Before: h("database"), databaseSha256After: h("database"),
    storageSetRootBefore: h("storage"), storageSetRootAfter: h("storage"),
    sqliteSchemaRoot: h("schema"), rawRowRoot: h("raw"), eventRoot: h("events"),
    terminalPhaseRowCount: "0", terminalPhaseRowRoot: h("terminal-rows"), sixStepWindowSelection: null,
    release: null, servingPartitions: Object.freeze([]), profile: null, commitment: null,
    events: Object.freeze([event("route-denominator", routePayload, "1"), event("candidate-set", candidatePayload, "2")]),
    bundle: null,
  });
  const report = Object.freeze({
    release,
    factBinding: Object.freeze({ databaseContentSha256: h("database"), terminalSnapshotTrustRoot: h("trust") }),
    factLocators: Object.freeze({ processEvidenceDatabasePath: "/tmp/facts.sqlite", checkpointDatabasePath: "/tmp/checkpoint.sqlite", frozenCheckpointSnapshotPublication: Object.freeze({ sourcePath: "/tmp/checkpoint.sqlite", snapshotPath: "/tmp/frozen-checkpoint.sqlite", contentSha256: h("checkpoint"), byteLength: "1", device: "1", inode: "1", uid: "0", gid: "0", mode: "384", fileFsynced: true, directoryFsynced: true }), processEvidenceDatabase: Object.freeze({ path: "/tmp/facts.sqlite", device: "1", inode: "1", contentSha256: h("database") }) }),
    factIndex: Object.freeze({
      terminalPhase: Object.freeze({ finalDurableWindowId: h("window"), terminalLocatorDirectory: "/tmp/terminal-locators", observerContentStore: Object.freeze({ directory: "/tmp/store", device: "1", inode: "1", storeIdentityHash: h("store") }), index: Object.freeze({ path: `/tmp/terminal-locators/${h("window").slice(2)}.json`, device: "1", inode: "1", contentSha256: h("index"), byteLength: "1", indexRoot: h("index-root") }), fullGraphCoarseSweep: Object.freeze({ artifactRefId: h("artifact"), contentSha256: h("sweep-content"), sweepRoot: emptySweep().sweepRoot, expectedTransitionCount: "0", expectedTransitionRoot: emptySweep().expectedTransitionRoot, observedTransitionCount: "0", observedTransitionRoot: emptySweep().observedTransitionRoot, missingTransitionCount: "0", missingTransitionRoot: emptySweep().missingTransitionRoot, familyTransitionCounts: Object.freeze([]) }) }),
      processEvidenceQuery: Object.freeze({ databasePath: "/tmp/facts.sqlite", routeDenominator: Object.freeze({ namespace: "searcher-production-evidence/route-denominators/v1" as const, eventType: "route-denominator" as const, accountingEntriesPath: "payload.accounting.entries" as const }), candidateSet: Object.freeze({ namespace: "searcher-production-evidence/candidate-sets/v1" as const, eventType: "candidate-set" as const, laneDenominatorsPath: "payload.laneDenominators" as const, terminalObservationsPath: "payload.candidateTerminalObservations" as const }), joins: joinContract(), exactAdmission: Object.freeze({ sourcePath: "payload.accounting.entries[].disposition" as const, disposition: "selected" as const }) }),
    }),
    nominationQualificationReuse: unavailableReuse(),
    judgmentRoot: h("judgment"),
  });
  const records = buildPreReleaseFactLogRecordsV1(report as never, observation as never, emptySweep(), activeGraphFor() as never);
  assert.equal(records.filter(record => record.kind === "aloha.pre-release-route-accounting-entry-v1").length, 2);
  assert.equal(records.filter(record => record.kind === "aloha.pre-release-candidate-join-fact-v1").length, 2);
  const exact = records.find(record => record.kind === "aloha.pre-release-selected-exact-list-v1")!;
  assert.equal(exact.selectedEntryRoot, hashCanonicalPartition(
    "aloha/pre-release/selected-route-entries/v1",
    [first as unknown as CanonicalJson],
    128,
  ));
  assert.equal("selectedCandidateIds" in exact, false);
  assert.equal("selectedEntries" in exact, false);
  assert.equal(exact.selectedCount, "1");
  const routeSummary = records.find(record => record.kind === "aloha.pre-release-route-denominator-v1")!;
  const candidateSummary = records.find(record => record.kind === "aloha.pre-release-candidate-set-v1")!;
  assert.equal("payload" in routeSummary, false);
  assert.equal("entries" in (routeSummary.accounting as Readonly<Record<string, unknown>>), false);
  assert.equal("candidateTerminalObservations" in candidateSummary, false);
  assert.ok(candidateSummary.materialLocator !== null);
  const joins = records.filter(record => record.kind === "aloha.pre-release-candidate-join-fact-v1");
  assert.ok(joins.every(record => (record.differences as readonly unknown[]).length === 0));
  assert.ok(records.every(record => record.sourceClassification === "invalid-basis"
    || record.sourceClassification === "self-consistent-advisory-claim"));

  const withCandidateTerminals = (terminals: readonly CanonicalJson[]) => Object.freeze({
    ...observation,
    events: Object.freeze([
      event("route-denominator", routePayload, "1"),
      event("candidate-set", Object.freeze({ ...candidatePayload, candidateTerminalObservations: Object.freeze(terminals) }), "2"),
    ]),
  });
  const reordered = buildPreReleaseFactLogRecordsV1(
    report as never,
    withCandidateTerminals([terminalB, terminalA]) as never,
    emptySweep(),
    activeGraphFor() as never,
  );
  const reorderedJoins = reordered.filter(record => record.kind === "aloha.pre-release-candidate-join-fact-v1");
  assert.deepEqual(reorderedJoins.map(record => record.terminalCandidateId), [first.candidateId, second.candidateId]);
  assert.deepEqual(reorderedJoins.map(record => record.terminalIndex), ["1", "0"]);
  assert.ok(reorderedJoins.every(record => (record.differences as readonly unknown[]).length === 0));

  for (const mutation of [
    { terminals: [terminalA, terminalA, terminalB], reason: "duplicate-candidate-terminal-identity" },
    { terminals: [terminalA], reason: "candidate-terminal-identity-missing" },
    { terminals: [terminalA, Object.freeze({ ...terminalB, lane: "backrun" })], reason: "orphan-candidate-terminal-identity" },
    { terminals: [terminalA, Object.freeze({ ...terminalB, candidateId: h("foreign-candidate") })], reason: "orphan-candidate-terminal-identity" },
  ] as const) {
    const mutated = buildPreReleaseFactLogRecordsV1(
      report as never,
      withCandidateTerminals(mutation.terminals) as never,
      emptySweep(),
      activeGraphFor() as never,
    );
    assert.ok((mutated.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[])
      .includes(mutation.reason), mutation.reason);
  }
});

test("production reader requires the fixed root-owned frozen-B checkpoint publication", () => {
  const input = createPhysicalInput();
  assert.throws(
    () => readPreReleaseFactLogV1(input.reportPath, Object.freeze(Object.create(null)) as never),
    /fixed root-owned snapshot|snapshot publication mismatch/,
  );
});

test("mechanical high-cardinality Graph denominator is emitted without sampling", () => {
  const fixture = syntheticSweep(30_000);
  const productionAudit = nativeAudit(fixture.sweep, [Object.freeze({
    candidateId: h("30k-production-candidate"),
    routeHash: h("30k-production-route"),
    assessment: null,
    legs: Object.freeze([Object.freeze({
      edgeId: fixture.sweep.entries[0]!.edge.edgeId,
      receipt: null,
      familyObservation: null,
    })]),
  })], true);
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation() as never,
    fixture.sweep,
    fixture.activeGraph as never,
    productionAudit,
  );
  const summary = records.find(record => record.kind === "aloha.pre-release-full-graph-summary-v1")!;
  assert.equal(summary.expectedTransitionCount, "30000");
  assert.equal(summary.entryCount, "30000");
  assert.ok(BigInt(summary.entryChunkCount as string) > 1n);
  assert.ok(summary.firstEntryChunkRef !== null);
  assert.equal(records.filter(record => record.kind === "aloha.pre-release-full-graph-transition-v1").length, 30_000);
  assert.ok(encodePreReleaseFactLogJsonlV1(records).byteLength > 0);
  assert.ok(records.filter(record => record.kind === "aloha.pre-release-full-graph-transition-v1")
    .every(record => "coarseReceipt" in record && "familyObservation" in record));
  assert.equal(summary.productionPricePublication, false);
  assert.equal(summary.artifactRole, "independent-full-graph-coverage-observation");
  const productionSummary = records.find(record => record.kind === "aloha.pre-release-native-full-family-audit-summary-v1")!;
  assert.equal(productionSummary.consistencyStatus, "inconsistent");
  assert.ok((productionSummary.advisoryReasons as readonly string[]).includes("native-audit-coarse-assessment-missing"));
  assert.ok((productionSummary.advisoryReasons as readonly string[]).includes("native-audit-coarse-leg-receipt-missing"));
  assert.equal(summary.sourceClassification, "invalid-basis");
  assert.ok((records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[])
    .includes("root-owned-terminal-physical-observer-not-executed"));
});

test("large native projected-edge denominator is emitted without sampling", () => {
  const sweep = emptySweep();
  const audit = nativeAuditWithProjectedCount(30_000);
  const input = createPhysicalInput(unavailableReuse(), sweep, audit);
  const activeGraph = Object.freeze({
    ...activeGraphFor(),
    edgeCount: audit.expectedProjectedEdgeCount,
    orderedEdgeIds: Object.freeze(audit.projectedEdges.map(edge => edge.edgeId)),
  });
  const records = readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraph as never);
  const summary = records.find(record => record.kind === "aloha.pre-release-native-full-family-audit-summary-v1")!;
  assert.equal(summary.expectedProjectedEdgeCount, "30000");
  assert.equal(summary.projectedEdgeDenominatorRoot, audit.projectedEdgeDenominatorRoot);
  for (const removed of [
    "missingLegKeys", "missingProjectedEdgeIds", "enumeratedCandidateIds", "coarseResolvedCandidateIds",
    "coarseInvalidCandidateIds", "admittedCandidateIds", "exactCandidateIds", "finalSimulationCandidateIds",
    "missingActionCandidateIds",
  ]) assert.equal(removed in summary, false, removed);
  assert.equal(records.filter(record => record.kind === "aloha.pre-release-native-full-family-projected-edge-v1").length, 30_000);
});

test("physical self-consistently rerooted native audit cannot delete an active Ready Graph edge", () => {
  const sweep = emptySweep();
  const completeAudit = nativeAuditWithProjectedCount(32);
  const projectedEdges = Object.freeze(completeAudit.projectedEdges.slice(0, -1));
  const missingProjectedEdgeIds = Object.freeze(projectedEdges.map(edge => edge.edgeId));
  const { auditRoot: _auditRoot, ...body } = completeAudit;
  const deletedAudit = encodeNativeFullFamilyAuditBodyV1(Object.freeze({
    ...body,
    expectedProjectedEdgeCount: String(projectedEdges.length),
    projectedEdges,
    missingProjectedEdgeIds,
    projectedEdgeDenominatorRoot: nativeFullFamilyAuditSequenceRootV1(
      "projected-edge-denominator",
      projectedEdges.map(edge => edge.factRoot),
    ),
    missingProjectedEdgeRoot: nativeFullFamilyAuditSequenceRootV1(
      "missing-projected-edges",
      missingProjectedEdgeIds,
    ),
  }) as never).audit;
  const activeGraph = Object.freeze({
    ...activeGraphFor(),
    edgeCount: completeAudit.expectedProjectedEdgeCount,
    orderedEdgeIds: Object.freeze(completeAudit.projectedEdges.map(edge => edge.edgeId)),
  });
  const input = createPhysicalInput(unavailableReuse(), sweep, deletedAudit);
  assert.throws(
    () => readPreReleaseFactLogStructuralFixtureV1(input.reportPath, activeGraph as never),
    /projected-edge\/active Ready Graph denominator mismatch/,
  );
});

test("one physical edge with 2x2 ports expands to four exact transitions", () => {
  const fixture = syntheticSweep(4, true);
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation() as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  const summary = records.find(record => record.kind === "aloha.pre-release-full-graph-summary-v1")!;
  assert.equal(summary.edgeCount, "1");
  assert.equal(summary.expectedTransitionCount, "4");
  const transitionFacts = records.filter(record => record.kind === "aloha.pre-release-full-graph-transition-v1");
  assert.equal(transitionFacts.length, 4);
  assert.equal(new Set(transitionFacts.map(record => record.transitionId)).size, 4);
});

test("self-consistent deleted-and-rerooted sweep cannot shrink the physical Graph denominator", () => {
  const fixture = syntheticSweep(32);
  const shrunk = syntheticSweep(31);
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(shrunk.sweep) as never,
    rawObservation() as never,
    shrunk.sweep,
    fixture.activeGraph as never,
  );
  const source = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!;
  assert.equal(source.basisStatus, "invalid");
  assert.ok((source.basisReasons as readonly string[]).some(reason => /denominator mismatch/.test(reason)));
  assert.equal(records.find(record => record.kind === "aloha.pre-release-full-graph-summary-v1")!.sourceClassification, "invalid-basis");
});

test("50-block recent edge range cannot replace the independent current coarse source", () => {
  const fixture = syntheticSweep(8);
  const replaced = resealSweep(fixture.sweep, { binding: {
    actualCurrentSource: Object.freeze({ ...fixture.sweep.binding.readyCutoff, chainId: "2" }),
  } });
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(replaced) as never,
    rawObservation() as never,
    replaced,
    fixture.activeGraph as never,
  );
  const source = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!;
  assert.ok((source.basisReasons as readonly string[]).includes("50-block edge observation/current-source coarse binding mismatch"));
  const recent = records.find(record => record.kind === "aloha.pre-release-edge-observation-window-v1")!;
  const current = records.find(record => record.kind === "aloha.pre-release-current-source-coarse-binding-v1")!;
  assert.equal((recent.recentObservationRange as Readonly<Record<string, unknown>>).blockCount, "50");
  assert.notDeepEqual(current.actualCurrentSource, replaced.binding.readyCutoff);

  const shiftedWindow = resealSweep(fixture.sweep, { binding: {
    recentObservationRange: Object.freeze({ from: "2", to: "51", blockCount: "50" as const }),
  } });
  const shiftedRecords = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(shiftedWindow) as never,
    rawObservation() as never,
    shiftedWindow,
    fixture.activeGraph as never,
  );
  assert.ok((shiftedRecords.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[])
    .includes("50-block edge observation/current-source coarse binding mismatch"));
});

test("no-success window joins the coarse source to ordinal=100 final raw facts without a selected performance event", () => {
  const fixture = syntheticSweep(8);
  const denominator = currentSourceDenominatorEvents(fixture.sweep.binding.actualCurrentSource);
  const observation = Object.freeze({
    ...rawObservation(denominator.events),
    sixStepWindowSelection: denominator.selection,
  });
  const report = structuralReportFor(fixture.sweep) as Readonly<Record<string, unknown>>;
  const records = buildPreReleaseFactLogRecordsV1(
    Object.freeze({
      ...report,
      factBinding: Object.freeze({
        ...(report.factBinding as Readonly<Record<string, unknown>>),
        terminalSnapshotTrustRoot: null,
      }),
    }) as never,
    observation as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  const reasons = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[];
  assert.deepEqual(reasons, ["root-owned-terminal-physical-observer-not-executed"]);
  const summary = records.find(record => record.kind === "aloha.pre-release-full-graph-summary-v1")!;
  assert.equal(summary.reportedTerminalSnapshotTrustRoot, null);
  assert.equal(summary.reportedTerminalSnapshotTrustRootSourceClassification, "self-consistent-unverified");
});

test("an earlier selected success joins its own rotated head while the sweep joins ordinal=100", () => {
  const fixture = syntheticSweep(8);
  const earlySource = Object.freeze({
    chainId: fixture.sweep.binding.actualCurrentSource.chainId,
    number: "1",
    hash: h("early-selected-head"),
    stateRoot: h("early-selected-state"),
  });
  const denominator = currentSourceDenominatorEvents(
    fixture.sweep.binding.actualCurrentSource,
    Object.freeze({ ordinal: 1, source: earlySource }),
  );
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    Object.freeze({
      ...rawObservation(denominator.events),
      sixStepWindowSelection: denominator.selection,
    }) as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  const reasons = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[];
  assert.deepEqual(reasons, ["root-owned-terminal-physical-observer-not-executed"]);
  assert.notDeepEqual(earlySource, fixture.sweep.binding.actualCurrentSource);
});

test("same chain and height with a foreign final hash or stateRoot is invalid-basis", () => {
  const fixture = syntheticSweep(8);
  const denominator = currentSourceDenominatorEvents(fixture.sweep.binding.actualCurrentSource);
  for (const mutation of [
    Object.freeze({ hash: h("foreign-final-hash") }),
    Object.freeze({ stateRoot: h("foreign-final-state-root") }),
  ]) {
    const actualCurrentSource = Object.freeze({ ...fixture.sweep.binding.actualCurrentSource, ...mutation });
    const changed = resealSweep(fixture.sweep, { binding: { actualCurrentSource } });
    const records = buildPreReleaseFactLogRecordsV1(
      structuralReportFor(changed) as never,
      Object.freeze({
        ...rawObservation(denominator.events),
        sixStepWindowSelection: denominator.selection,
      }) as never,
      changed,
      fixture.activeGraph as never,
    );
    const reasons = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[];
    assert.ok(reasons.includes("coarse current source does not exact-join ordinal=100 final eligible-head"));
  }
});

test("selected terminal outcomes form an explicit passed/reverted/retryable/invalid/no-sim closure", () => {
  const fixture = syntheticSweep(2);
  const cases = [
    Object.freeze({ terminalKind: "passed", reasonCode: null, outcome: "passed", status: "passed", absence: null }),
    Object.freeze({ terminalKind: "chainProvenRejected", reasonCode: "final-sim:simulation-reverted", outcome: "simulation-reverted", status: "reverted", absence: null }),
    Object.freeze({ terminalKind: "retryable", reasonCode: null, outcome: "retryable", status: "absent", absence: "terminal:retryable-before-final-sim" }),
    Object.freeze({ terminalKind: "invalidProgram", reasonCode: "execution-program:invalid", outcome: "invalid", status: "absent", absence: "execution-program:invalid" }),
    Object.freeze({ terminalKind: "chainProvenRejected", reasonCode: "exact:rejected", outcome: "no-sim", status: "absent", absence: "exact:rejected" }),
  ];
  for (const item of cases) {
    const observation = selectedOutcomeObservation(item.terminalKind, item.reasonCode);
    const records = buildPreReleaseFactLogRecordsV1(
      structuralReportFor(fixture.sweep) as never,
      rawObservation(observation.events) as never,
      fixture.sweep,
      fixture.activeGraph as never,
    );
    const outcome = records.find(record => record.kind === "aloha.pre-release-selected-terminal-outcome-v1")!;
    assert.equal(outcome.outcome, item.outcome);
    assert.equal(outcome.simulationStatus, item.status);
    assert.equal(outcome.simulationAbsenceReason, item.absence);
    assert.equal(outcome.physicalPerformanceFactStatus, "complete");
    assert.notEqual(outcome.physicalPerformanceEvent, null);
  }
});

test("a non-passed selected candidate cannot manufacture scheduler or Six-Step telemetry", () => {
  const fixture = syntheticSweep(2);
  const observation = selectedOutcomeObservation("retryable", "rpc:timeout");
  const events = observation.events.map(event => {
    if (event.eventType !== "performance-facts-complete") return event;
    return Object.freeze({
      ...event,
      payload: Object.freeze({
        ...event.payload,
        runtimeFacts: Object.freeze({
          selectedSchedulerCompletion: Object.freeze({ completionId: h("forged-completion") }),
          producerSchedulerJoin: Object.freeze({ unsignedDryRunCandidateId: h("forged-candidate") }),
        }),
        sixStepFacts: Object.freeze({ stage36Root: h("forged-stage36") }),
      }),
    });
  });
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation(events) as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  const reasons = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[];
  assert.ok(reasons.includes("non-passed-candidate-has-selected-execution-telemetry"));
  assert.equal(records.some(record => record.kind === "aloha.pre-release-six-step-selected-lineage-v1"), false);
});

test("the same candidate identity in both lanes remains two selected terminal facts", () => {
  const fixture = syntheticSweep(2);
  const admissionId = h("dual-lane-selected-admission");
  const candidateId = h("dual-lane-selected-candidate");
  const common = Object.freeze({
    candidateId,
    disposition: "selected",
    terminalKind: "retryable",
    routeHash: h("dual-lane-selected-route"),
    reasonCode: "rpc:timeout",
    evidenceHash: h("dual-lane-selected-evidence"),
    policyTerminal: null,
    legs: Object.freeze([]),
  });
  const route = (lane: "blockscan" | "backrun", sequence: string) => evidenceEvent(
    "route-denominator",
    sequence,
    Object.freeze({
      admissionId,
      headFactsRoot: h("dual-lane-head-facts"),
      headHash: h("dual-lane-head"),
      lane,
      correlationId: h(`dual-lane-correlation-${lane}`),
      coverageRoot: h(`dual-lane-coverage-${lane}`),
      denominatorKind: "accounted",
      plannerCandidateIdentity: Object.freeze({}),
      accounting: Object.freeze({
        entries: Object.freeze([common]),
        root: h(`dual-lane-accounting-${lane}`),
      }),
    }),
  );
  const candidate = evidenceEvent("candidate-set", "3", Object.freeze({
    admissionId,
    headFactsRoot: h("dual-lane-head-facts"),
    headHash: h("dual-lane-head"),
    laneDenominators: Object.freeze(["blockscan", "backrun"].map(lane => Object.freeze({
      lane,
      correlationId: h(`dual-lane-correlation-${lane}`),
      coverageRoot: h(`dual-lane-coverage-${lane}`),
      accountingRoot: h(`dual-lane-accounting-${lane}`),
    }))),
    candidateTerminalObservations: Object.freeze([
      Object.freeze({ ...common, lane: "blockscan" }),
      Object.freeze({ ...common, lane: "backrun" }),
    ]),
  }));
  const performance = evidenceEvent("performance-facts-complete", "4", Object.freeze({
    admissionId,
    runtimeFacts: Object.freeze({ producerSchedulerJoin: null }),
    sixStepFacts: null,
  }));
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation([route("blockscan", "1"), route("backrun", "2"), candidate, performance]) as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  const source = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!;
  assert.ok(!(source.basisReasons as readonly string[]).includes("selected-route-candidate-six-step-partition-mismatch"));
  assert.equal(records.filter(record => record.kind === "aloha.pre-release-selected-terminal-outcome-v1").length, 2);
  assert.equal(records.filter(record => record.kind === "aloha.pre-release-selected-exact-list-v1").length, 2);
});

test("production coarse lineage comes only from the native audit and keeps no-sim explicit", () => {
  const fixture = syntheticSweep(2);
  const transition = fixture.sweep.entries[0]!;
  const sweepReceipt = transition.receipt!;
  const auditReceipt = Object.freeze({ ...sweepReceipt, receiptRoot: h("production-receipt-a") });
  const familyObservation = Object.freeze({ observationRoot: h("production-family-observation-a") });
  const base = selectedOutcomeObservation("retryable", "rpc:timeout");
  const baseRoute = base.events.find(value => value.eventType === "route-denominator")!;
  const baseEntry = ((baseRoute.payload as Readonly<Record<string, unknown>>).accounting as Readonly<Record<string, unknown>>)
    .entries as readonly Readonly<Record<string, unknown>>[];
  const candidateId = baseEntry[0]!.candidateId as Hash;
  const routeHash = baseEntry[0]!.routeHash as Hash;
  const assessmentC = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-route-assessment-v1" as const,
    routeHash,
    routeBindingHash: h(`native-route-binding-${candidateId}`),
    generationId: fixture.sweep.binding.generationId,
    graphRoot: fixture.sweep.binding.graphRoot,
    source: fixture.sweep.binding.actualCurrentSource,
    objectiveRef: fixture.sweep.binding.objectiveRef,
    releaseProvenanceHash: fixture.sweep.binding.releaseProvenanceHash,
    releaseMembershipRoot: fixture.sweep.binding.releaseMembershipRoot,
    orderedProjectionIds: Object.freeze([h("assessment-c-projection")]),
    orderedProjectionReceiptRoots: Object.freeze([auditReceipt.receiptRoot]),
    projectionRoot: h("assessment-c-projection-root"),
    status: "rankable" as const,
    rankAssetRef: h("assessment-c-rank-asset"),
    rankScore: "314159",
    profitUpperBound: Object.freeze({
      assetRef: h("assessment-c-profit-asset"),
      amount: "271828",
      composerProgramRef: h("assessment-c-composer"),
      proofRoot: h("assessment-c-profit-proof"),
    }),
    reasonCodes: Object.freeze(["assessment-c-recognizable"]),
    assessmentId: h("assessment-c"),
  });
  const leg = Object.freeze({
    edgeId: transition.edge.edgeId,
    transitionRef: transition.edge.opaqueTransitionRef,
    inputAssetRef: transition.inputAssetRef,
    inputPortRef: transition.inputPortRef,
    outputAssetRef: transition.outputAssetRef,
    outputPortRef: transition.outputPortRef,
  });
  const audit = nativeAudit(fixture.sweep, [Object.freeze({
    candidateId,
    routeHash,
    assessment: assessmentC as unknown as CanonicalJson,
    legs: Object.freeze([Object.freeze({
      edgeId: transition.edge.edgeId,
      receipt: auditReceipt as unknown as CanonicalJson,
      familyObservation,
      owningFamilyId: transition.edge.owningFamilyId,
    })]),
  })], true);
  const events = base.events.map(value => {
    const payload = value.payload as Readonly<Record<string, unknown>>;
    if (value.eventType === "route-denominator") {
      const accounting = payload.accounting as Readonly<Record<string, unknown>>;
      const entries = accounting.entries as readonly Readonly<Record<string, unknown>>[];
      return Object.freeze({
        ...value,
        payload: Object.freeze({
          ...payload,
          headHash: audit.binding.actualCurrentSource.hash,
          correlationId: audit.binding.correlationId,
          accounting: Object.freeze({
            ...accounting,
            planningProblemHash: audit.binding.planningProblemHash,
            enumerationRoot: audit.binding.plannerEnumerationRoot,
            entries: Object.freeze([Object.freeze({ ...entries[0]!, legs: Object.freeze([leg]) })]),
          }),
        }),
      });
    }
    if (value.eventType === "candidate-set") {
      const laneDenominators = payload.laneDenominators as readonly Readonly<Record<string, unknown>>[];
      const terminals = payload.candidateTerminalObservations as readonly Readonly<Record<string, unknown>>[];
      return Object.freeze({
        ...value,
        payload: Object.freeze({
          ...payload,
          headHash: audit.binding.actualCurrentSource.hash,
          laneDenominators: Object.freeze([
            ...laneDenominators.map(lane => Object.freeze({
              ...lane,
              correlationId: audit.binding.correlationId,
            })),
            Object.freeze({
              ...laneDenominators[0]!,
              lane: "backrun",
              correlationId: audit.binding.correlationId,
            }),
          ]),
          candidateTerminalObservations: Object.freeze([
            ...terminals,
            Object.freeze({ ...terminals[0]!, lane: "backrun", routeHash: h("other-lane-route") }),
          ]),
        }),
      });
    }
    return value;
  });
  const exactCandidateEvent = events.find(value => value.eventType === "candidate-set")!;
  events.push(Object.freeze({
    ...exactCandidateEvent,
    eventId: h("foreign-head-candidate-event"),
    sequence: "99",
    payload: Object.freeze({
      ...exactCandidateEvent.payload,
      headHash: h("foreign-candidate-head"),
    }),
  }));
  const joined = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation(events) as never,
    fixture.sweep,
    fixture.activeGraph as never,
    audit,
  );
  const outcome = joined.find(record => record.kind === "aloha.pre-release-selected-terminal-outcome-v1")!;
  const input = (outcome.coarseInputs as readonly Readonly<Record<string, unknown>>[])[0]!;
  assert.equal(input.source, "native-full-family-audit");
  assert.deepEqual(input.coarseReceipt, auditReceipt);
  assert.notDeepEqual(input.coarseReceipt, sweepReceipt);
  assert.deepEqual(input.familyObservation, familyObservation);
  const nativeLeg = joined.find(record => record.kind === "aloha.pre-release-native-full-family-coarse-leg-v1")!;
  assert.deepEqual(nativeLeg.coarseReceipt, auditReceipt);
  assert.equal(nativeLeg.pricingModel, "per-route-fresh-no-price-table");
  assert.deepEqual(nativeLeg.pricingStateNotApplicable, ["mids", "refreshed", "carried", "implementation-coordinator", "price-cache"]);
  const nativeRoute = joined.find(record => record.kind === "aloha.pre-release-native-full-family-route-v1")!;
  assert.deepEqual(nativeRoute.coarseAssessment, assessmentC);
  const lineage = joined.find(record => record.kind === "aloha.pre-release-native-full-family-candidate-lineage-v1")!;
  assert.deepEqual(lineage.coarseAssessment, assessmentC);
  assert.equal((lineage.terminalObservation as Readonly<Record<string, unknown>>).lane, "blockscan");
  assert.equal(lineage.tailStatus, "no-sim");
  assert.equal(lineage.simulationStatus, "absent");
  assert.equal(lineage.simulationAbsenceReason, "rpc:timeout");
  const summary = joined.find(record => record.kind === "aloha.pre-release-native-full-family-audit-summary-v1")!;
  assert.equal(summary.consistencyStatus, "consistent");
  assert.ok(joined.every(record => record.advisoryOnly === true));

  const otherLaneOnly = events.map(value => {
    const payload = value.payload as Readonly<Record<string, unknown>>;
    if (value.eventType !== "candidate-set" || payload.headHash !== audit.binding.actualCurrentSource.hash) return value;
    const terminals = payload.candidateTerminalObservations as readonly Readonly<Record<string, unknown>>[];
    return Object.freeze({
      ...value,
      payload: Object.freeze({
        ...payload,
        candidateTerminalObservations: Object.freeze(terminals.filter(terminal => terminal.lane === "backrun")),
      }),
    });
  });
  const otherLaneSummary = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation(otherLaneOnly) as never,
    fixture.sweep,
    fixture.activeGraph as never,
    audit,
  ).find(record => record.kind === "aloha.pre-release-native-full-family-audit-summary-v1")!;
  assert.ok((otherLaneSummary.advisoryReasons as readonly string[]).includes("native-audit-selected-tail-lineage-missing"));
  const terminalRouteMismatch = events.map(value => {
    const payload = value.payload as Readonly<Record<string, unknown>>;
    if (value.eventType !== "candidate-set" || payload.headHash !== audit.binding.actualCurrentSource.hash) return value;
    const terminals = payload.candidateTerminalObservations as readonly Readonly<Record<string, unknown>>[];
    return Object.freeze({
      ...value,
      payload: Object.freeze({
        ...payload,
        candidateTerminalObservations: Object.freeze(terminals.map(terminal => terminal.lane === "blockscan"
          ? Object.freeze({ ...terminal, routeHash: h("foreign-terminal-route") })
          : terminal)),
      }),
    });
  });
  const terminalRouteSummary = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation(terminalRouteMismatch) as never,
    fixture.sweep,
    fixture.activeGraph as never,
    audit,
  ).find(record => record.kind === "aloha.pre-release-native-full-family-audit-summary-v1")!;
  assert.ok((terminalRouteSummary.advisoryReasons as readonly string[]).includes("native-audit-terminal-route-hash-mismatch"));

  const mutateRoute = (mutate: (payload: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>) => (
    events.map(value => value.eventType === "route-denominator"
      ? Object.freeze({ ...value, payload: Object.freeze(mutate(value.payload as Readonly<Record<string, unknown>>)) })
      : value)
  );
  const auditReasons = (mutatedEvents: readonly Readonly<Record<string, unknown>>[]) => {
    const records = buildPreReleaseFactLogRecordsV1(
      structuralReportFor(fixture.sweep) as never,
      rawObservation(mutatedEvents) as never,
      fixture.sweep,
      fixture.activeGraph as never,
      audit,
    );
    return records.find(record => record.kind === "aloha.pre-release-native-full-family-audit-summary-v1")!
      .advisoryReasons as readonly string[];
  };
  for (const mutation of [
    Object.freeze({
      reason: "native-audit-production-route-denominator-missing",
      events: mutateRoute(payload => ({ ...payload, correlationId: h("foreign-correlation") })),
    }),
    Object.freeze({
      reason: "native-audit-production-route-denominator-missing",
      events: mutateRoute(payload => ({
        ...payload,
        accounting: { ...(payload.accounting as Readonly<Record<string, unknown>>), planningProblemHash: h("foreign-problem") },
      })),
    }),
    Object.freeze({
      reason: "native-audit-production-route-denominator-missing",
      events: mutateRoute(payload => ({
        ...payload,
        accounting: { ...(payload.accounting as Readonly<Record<string, unknown>>), enumerationRoot: h("foreign-enumeration") },
      })),
    }),
    Object.freeze({
      reason: "native-audit-source-mismatch",
      events: mutateRoute(payload => ({ ...payload, headHash: h("foreign-source") })),
    }),
    Object.freeze({
      reason: "native-audit-route-hash-mismatch",
      events: mutateRoute(payload => {
        const accounting = payload.accounting as Readonly<Record<string, unknown>>;
        const routeEntries = accounting.entries as readonly Readonly<Record<string, unknown>>[];
        return { ...payload, accounting: { ...accounting, entries: [{ ...routeEntries[0]!, routeHash: h("foreign-route") }] } };
      }),
    }),
    Object.freeze({
      reason: "native-audit-candidate-route-missing",
      events: mutateRoute(payload => {
        const accounting = payload.accounting as Readonly<Record<string, unknown>>;
        const routeEntries = accounting.entries as readonly Readonly<Record<string, unknown>>[];
        return { ...payload, accounting: { ...accounting, entries: [{ ...routeEntries[0]!, candidateId: h("foreign-candidate") }] } };
      }),
    }),
    Object.freeze({
      reason: "native-audit-coarse-leg-lineage-mismatch",
      events: mutateRoute(payload => {
        const accounting = payload.accounting as Readonly<Record<string, unknown>>;
        const routeEntries = accounting.entries as readonly Readonly<Record<string, unknown>>[];
        const routeLegs = routeEntries[0]!.legs as readonly Readonly<Record<string, unknown>>[];
        return { ...payload, accounting: { ...accounting, entries: [{ ...routeEntries[0]!, legs: [{ ...routeLegs[0]!, edgeId: h("foreign-edge") }] }] } };
      }),
    }),
  ]) {
    assert.ok(auditReasons(mutation.events).includes(mutation.reason), mutation.reason);
  }

  const actionAudit = nativeAudit(fixture.sweep, [Object.freeze({
    candidateId,
    routeHash,
    action: true,
    legs: Object.freeze([Object.freeze({
      edgeId: transition.edge.edgeId,
      receipt: auditReceipt as unknown as CanonicalJson,
      familyObservation,
      owningFamilyId: transition.edge.owningFamilyId,
    })]),
  })], true);
  const exactLineageHash = h("exact-tail-lineage");
  const exactStage36Root = h("exact-tail-stage36");
  const passedWithoutTail = events.map(value => {
    const payload = value.payload as Readonly<Record<string, unknown>>;
    if (value.eventType === "route-denominator") {
      const accounting = payload.accounting as Readonly<Record<string, unknown>>;
      const routeEntries = accounting.entries as readonly Readonly<Record<string, unknown>>[];
      return Object.freeze({
        ...value,
        payload: Object.freeze({
          ...payload,
          accounting: Object.freeze({
            ...accounting,
            entries: Object.freeze([Object.freeze({ ...routeEntries[0]!, terminalKind: "passed", reasonCode: null })]),
          }),
        }),
      });
    }
    if (value.eventType === "candidate-set") {
      const terminals = payload.candidateTerminalObservations as readonly Readonly<Record<string, unknown>>[];
      return Object.freeze({
        ...value,
        payload: Object.freeze({
          ...payload,
          candidateTerminalObservations: Object.freeze([Object.freeze({
            ...terminals[0]!,
            terminalKind: "passed",
            reasonCode: null,
            terminalLineageHash: exactLineageHash,
            sixStepEvidenceRoot: exactStage36Root,
          })]),
        }),
      });
    }
    return value;
  });
  const sixStepPerformance = (
    admissionId: Hash,
    sequence: string,
    lineageHash: Hash,
    stage36Root: Hash,
  ) => {
    const programHash = h(`tail-program-${sequence}`);
    const finalReceiptHash = h(`tail-final-receipt-${sequence}`);
    return evidenceEvent("performance-facts-complete", sequence, Object.freeze({
      admissionId,
      runtimeFacts: Object.freeze({
        selectedSchedulerCompletion: Object.freeze({ completionId: h(`tail-completion-${sequence}`) }),
        producerSchedulerJoin: Object.freeze({
          correlationId: actionAudit.binding.correlationId,
          generationId: actionAudit.binding.generationId,
          source: actionAudit.binding.actualCurrentSource,
          programHash,
          finalSimulationReceiptHash: finalReceiptHash,
          unsignedDryRunCandidateId: candidateId,
          unsignedDryRunLineageHash: lineageHash,
        }),
      }),
      sixStepFacts: Object.freeze({
        stage12: Object.freeze({ marker: sequence }),
        stage12Root: h(`tail-stage12-${sequence}`),
        stage36Root,
        lineageRoot: h(`tail-six-step-lineage-${sequence}`),
        stage36: Object.freeze({
          resolved: Object.freeze({
            routeCandidateId: candidateId,
            executionProgram: Object.freeze({ programHash }),
            executionProgramOwnerEvidence: Object.freeze({ evidenceRoot: h(`tail-execution-owner-${sequence}`) }),
            finalSimulation: Object.freeze({ receiptHash: finalReceiptHash, effectsHash: h(`tail-effects-${sequence}`) }),
            finalSimulationOwnerEvidence: Object.freeze({ evidenceRoot: h(`tail-final-owner-${sequence}`) }),
            unsignedDryRun: Object.freeze({ candidateId, lineageHash }),
          }),
        }),
      }),
    }));
  };
  const foreignAdmissionId = h("foreign-tail-admission");
  const foreignLineageHash = h("foreign-tail-lineage");
  const foreignStage36Root = h("foreign-tail-stage36");
  const passedCandidate = passedWithoutTail.find(value => {
    const payload = value.payload as Readonly<Record<string, unknown>>;
    return value.eventType === "candidate-set" && payload.headHash === actionAudit.binding.actualCurrentSource.hash;
  })!;
  const passedCandidatePayload = passedCandidate.payload as Readonly<Record<string, unknown>>;
  const passedTerminal = (passedCandidatePayload.candidateTerminalObservations as readonly CanonicalJson[])[0]!;
  const foreignCandidate = Object.freeze({
    ...passedCandidate,
    eventId: h("foreign-tail-candidate-event"),
    sequence: "200",
    payload: Object.freeze({
      ...passedCandidatePayload,
      admissionId: foreignAdmissionId,
      headFactsRoot: h("foreign-tail-head-facts"),
      headHash: h("foreign-tail-head"),
      candidateTerminalObservations: Object.freeze([Object.freeze({
        ...(passedTerminal as Readonly<Record<string, unknown>>),
        terminalLineageHash: foreignLineageHash,
        sixStepEvidenceRoot: foreignStage36Root,
      })]),
    }),
  });
  const foreignSixStepEvents = Object.freeze([
    ...passedWithoutTail,
    foreignCandidate,
    sixStepPerformance(foreignAdmissionId, "201", foreignLineageHash, foreignStage36Root),
  ]);
  const tailMissing = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation(foreignSixStepEvents) as never,
    fixture.sweep,
    fixture.activeGraph as never,
    actionAudit,
  ).find(record => record.kind === "aloha.pre-release-native-full-family-audit-summary-v1")!;
  assert.ok((tailMissing.advisoryReasons as readonly string[]).includes("native-audit-selected-tail-lineage-missing"));
  const exactSixStepEvents = Object.freeze([
    ...foreignSixStepEvents,
    sixStepPerformance(base.admissionId, "202", exactLineageHash, exactStage36Root),
  ]);
  const exactTailRecords = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation(exactSixStepEvents) as never,
    fixture.sweep,
    fixture.activeGraph as never,
    actionAudit,
  );
  const exactTail = exactTailRecords.find(record => record.kind === "aloha.pre-release-native-full-family-candidate-lineage-v1")!;
  assert.equal((exactTail.sixStepLineage as Readonly<Record<string, unknown>>).admissionId, base.admissionId);
  assert.equal((exactTail.sixStepLineage as Readonly<Record<string, unknown>>).candidateId, candidateId);
  assert.ok(!(exactTail.advisoryReasons as readonly string[]).includes("native-audit-selected-tail-lineage-missing"));
});

test("a missing selected terminal cannot be described as no-sim", () => {
  const fixture = syntheticSweep(2);
  const observation = selectedOutcomeObservation("retryable", "rpc:timeout", false);
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation(observation.events) as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  const source = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!;
  assert.ok((source.basisReasons as readonly string[]).includes("selected-terminal-observation-missing"));
  const outcome = records.find(record => record.kind === "aloha.pre-release-selected-terminal-outcome-v1")!;
  assert.equal(outcome.outcome, "invalid-basis");
  assert.equal(outcome.simulationAbsenceReason, "terminal-observation-missing");
});

test("duplicate candidate admission is explicit invalid-basis and never Map-overwritten normal", () => {
  const fixture = syntheticSweep(2);
  const payload = Object.freeze({
    admissionId: h("duplicate-admission"), headFactsRoot: h("head-facts"), headHash: h("head"),
    laneDenominators: Object.freeze([]), candidateTerminalObservations: Object.freeze([]),
  });
  const event = (sequence: string) => Object.freeze({
    schemaVersion: 1 as const, kind: "aloha.searcher-production-evidence-event" as const,
    eventId: h(`duplicate-${sequence}`), eventType: "candidate-set" as const, sequence,
    namespace: "searcher-production-evidence/candidate-sets/v1" as const,
    release: Object.freeze({ bindingId: release.runtimeBindingId, releaseProvenanceHash: release.releaseProvenanceHash, candidateReleaseCommit: release.candidateReleaseCommit }),
    runtimeAnchor: Object.freeze({}), serving: null, payload,
  });
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation([event("1"), event("2")]) as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  assert.equal(records.filter(record => record.kind === "aloha.pre-release-candidate-set-v1").length, 2);
  assert.ok((records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[])
    .includes("duplicate-candidate-set-admission"));
  assert.ok(records.filter(record => record.kind !== "aloha.pre-release-nomination-qualification-reuse-claim-v1")
    .every(record => record.sourceClassification === "invalid-basis"));
});

test("cross-candidate final-simulation receipt splice is rejected", () => {
  const fixture = syntheticSweep(2);
  const admissionId = h("six-step-admission");
  const candidateId = h("candidate-a");
  const lineageHash = h("candidate-a-lineage");
  const stage36Root = h("candidate-a-stage36");
  const programHash = h("candidate-a-program");
  const expectedReceipt = h("candidate-a-final-receipt");
  const candidateEvent = Object.freeze({
    schemaVersion: 1 as const, kind: "aloha.searcher-production-evidence-event" as const,
    eventId: h("candidate-event"), eventType: "candidate-set" as const, sequence: "1",
    namespace: "searcher-production-evidence/candidate-sets/v1" as const,
    release: Object.freeze({ bindingId: release.runtimeBindingId, releaseProvenanceHash: release.releaseProvenanceHash, candidateReleaseCommit: release.candidateReleaseCommit }),
    runtimeAnchor: Object.freeze({}), serving: null,
    payload: Object.freeze({
      admissionId, headFactsRoot: h("head-facts"), headHash: h("head"), laneDenominators: Object.freeze([]),
      candidateTerminalObservations: Object.freeze([Object.freeze({
        lane: "blockscan", candidateId, disposition: "selected", terminalKind: "passed",
        terminalLineageHash: lineageHash, sixStepEvidenceRoot: stage36Root,
      })]),
    }),
  });
  const performanceEvent = (receiptHash: Hash) => Object.freeze({
    ...candidateEvent,
    eventId: h("performance-event"), eventType: "performance-facts-complete" as const, sequence: "2",
    namespace: "searcher-production-evidence/performance-facts/v1" as const,
    payload: Object.freeze({
      admissionId,
      runtimeFacts: Object.freeze({
        selectedSchedulerCompletion: Object.freeze({ completionId: h("completion") }),
        producerSchedulerJoin: Object.freeze({
          correlationId: h("correlation"), generationId: "generation-1",
          source: fixture.sweep.binding.actualCurrentSource, programHash,
          finalSimulationReceiptHash: expectedReceipt,
          unsignedDryRunCandidateId: candidateId, unsignedDryRunLineageHash: lineageHash,
        }),
      }),
      sixStepFacts: Object.freeze({
        stage12: Object.freeze({}), stage12Root: h("stage12"), stage36Root, lineageRoot: h("six-step-lineage"),
        stage36: Object.freeze({
          resolved: Object.freeze({
            routeCandidateId: candidateId,
            executionProgram: Object.freeze({ programHash }),
            executionProgramOwnerEvidence: Object.freeze({ evidenceRoot: h("execution-owner") }),
            finalSimulation: Object.freeze({ receiptHash, effectsHash: h("effects") }),
            finalSimulationOwnerEvidence: Object.freeze({ evidenceRoot: h("final-owner") }),
            unsignedDryRun: Object.freeze({ candidateId, lineageHash }),
          }),
        }),
      }),
    }),
  });
  const joined = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation([candidateEvent, performanceEvent(expectedReceipt)]) as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  const lineage = joined.find(record => record.kind === "aloha.pre-release-six-step-selected-lineage-v1")!;
  assert.equal(lineage.candidateId, candidateId);
  assert.equal(lineage.programHash, programHash);
  assert.equal(lineage.finalSimulationReceiptHash, expectedReceipt);
  assert.equal(lineage.finalSimulationEffectsHash, h("effects"));
  assert.equal(lineage.executionOwnerEvidenceRoot, h("execution-owner"));
  assert.equal(lineage.finalSimulationOwnerEvidenceRoot, h("final-owner"));
  assert.equal((lineage.processEvidence as Readonly<Record<string, unknown>>).rawRowRoot, h("raw"));
  assert.equal((lineage.processEvidence as Readonly<Record<string, unknown>>).storageSetRootBefore, h("storage"));
  assert.equal((lineage.processEvidence as Readonly<Record<string, unknown>>).storageSetRootAfter, h("storage"));
  assert.deepEqual(lineage.stage12Snapshot, {});
  assert.equal((lineage.executionProgram as Readonly<Record<string, unknown>>).programHash, programHash);
  assert.equal((lineage.finalSimulation as Readonly<Record<string, unknown>>).receiptHash, expectedReceipt);
  assert.equal(((lineage.stage36Trace as Readonly<Record<string, unknown>>).resolved as Readonly<Record<string, unknown>>)
    .routeCandidateId, candidateId);
  const spliced = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation([candidateEvent, performanceEvent(h("candidate-b-final-receipt"))]) as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  assert.ok((spliced.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[])
    .includes("passed-candidate-selected-execution-lineage-mismatch"));
  assert.equal(spliced.some(record => record.kind === "aloha.pre-release-six-step-selected-lineage-v1"), false);
});

test("selected passed candidate without a physical performance Six-Step event is invalid-basis", () => {
  const fixture = syntheticSweep(2);
  const admissionId = h("missing-six-step-admission");
  const candidateId = h("missing-six-step-candidate");
  const candidateEvent = Object.freeze({
    schemaVersion: 1 as const, kind: "aloha.searcher-production-evidence-event" as const,
    eventId: h("missing-six-step-candidate-event"), eventType: "candidate-set" as const, sequence: "1",
    namespace: "searcher-production-evidence/candidate-sets/v1" as const,
    release: Object.freeze({ bindingId: release.runtimeBindingId, releaseProvenanceHash: release.releaseProvenanceHash, candidateReleaseCommit: release.candidateReleaseCommit }),
    runtimeAnchor: Object.freeze({}), serving: null,
    payload: Object.freeze({
      admissionId, headFactsRoot: h("head-facts"), headHash: h("head"), laneDenominators: Object.freeze([]),
      candidateTerminalObservations: Object.freeze([Object.freeze({
        lane: "blockscan", candidateId, disposition: "selected", terminalKind: "passed",
        terminalLineageHash: h("lineage"), sixStepEvidenceRoot: h("stage36"),
      })]),
    }),
  });
  const records = buildPreReleaseFactLogRecordsV1(
    structuralReportFor(fixture.sweep) as never,
    rawObservation([candidateEvent]) as never,
    fixture.sweep,
    fixture.activeGraph as never,
  );
  const reasons = records.find(record => record.kind === "aloha.pre-release-fact-log-source-v1")!.basisReasons as readonly string[];
  assert.ok(reasons.includes("selected-six-step-lineage-missing"));
  assert.ok(reasons.includes("selected-route-candidate-six-step-partition-mismatch"));
  assert.ok(reasons.includes("selected-performance-fact-missing"));
  assert.equal(records.filter(record => record.kind === "aloha.pre-release-six-step-selected-lineage-v1").length, 0);
});
