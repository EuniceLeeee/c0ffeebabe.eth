import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type { PersistedGraphEdgeV1 } from "../../../../packages/graph/src/index.ts";
import type { CanonicalCutoffV1 } from "../../../../packages/discovery/src/index.ts";
import { fullGraphTransitionSequenceRootV1 } from "../../../../packages/full-graph-coarse-sweep/src/index.ts";
import {
  decodeFullFamilyPersistedGraphEdge,
  fullFamilyGeneratedDenominatorRoot,
  type FullFamilyGeneratedRuntimeMetadataV1,
} from "../../../../specs/full-family-facts/src/index.ts";

export type ProductionTerminalPhaseSnapshotTrustCapabilityV1 = object;

export interface ProductionReadyGraphTransitionV1 {
  readonly transitionId: Hash;
  readonly edgeId: Hash;
  readonly transitionRef: Hash;
  readonly inputAssetRef: Hash;
  readonly inputPortRef: Hash;
  readonly outputAssetRef: Hash;
  readonly outputPortRef: Hash;
  readonly owningFamilyId: string;
}

export function derivePlannerCompatibleReadyGraphTransitionsV1(
  edges: readonly PersistedGraphEdgeV1[],
): readonly ProductionReadyGraphTransitionV1[] {
  const transitions = edges.flatMap((rawEdge, edgeIndex) => {
    const edge = decodeFullFamilyPersistedGraphEdge(rawEdge, `activeReadyGraph.edges[${edgeIndex}]`);
    return edge.inputAssetPorts.flatMap(input => edge.outputAssetPorts.map(output => {
      const payload = Object.freeze({
        edgeId: edge.edgeId,
        transitionRef: edge.opaqueTransitionRef,
        inputAssetRef: input.assetRef,
        inputPortRef: input.portRef,
        outputAssetRef: output.assetRef,
        outputPortRef: output.portRef,
        owningFamilyId: edge.owningFamilyId,
      });
      return Object.freeze({
        transitionId: hashDomain("aloha/full-graph-coarse-transition/v1", payload),
        ...payload,
      });
    }));
  }).sort((left, right) => {
    const leftKey = `${left.edgeId}\u001f${left.transitionRef}\u001f${left.inputAssetRef}\u001f${left.inputPortRef}\u001f${left.outputAssetRef}\u001f${left.outputPortRef}`;
    const rightKey = `${right.edgeId}\u001f${right.transitionRef}\u001f${right.inputAssetRef}\u001f${right.inputPortRef}\u001f${right.outputAssetRef}\u001f${right.outputPortRef}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (new Set(transitions.map(value => value.transitionId)).size !== transitions.length) {
    throw new TypeError("active Ready Graph planner transition denominator is duplicated");
  }
  return Object.freeze(transitions);
}

export interface ProductionActiveReadyGraphSnapshotV1 {
  readonly checkpointRootEnvelopeHash: Hash;
  readonly checkpointRevision: string;
  readonly readyClosureStorageHash: Hash;
  readonly readyRecordHash: Hash;
  readonly generationId: string;
  readonly releaseProvenanceHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly instanceCatalogRoot: Hash;
  readonly instanceCatalogStorageHash: Hash;
  readonly graphStorageHash: Hash;
  readonly graphRoot: Hash;
  readonly edgeCount: string;
  readonly orderedEdgeIds: readonly Hash[];
  readonly orderedEdges: readonly PersistedGraphEdgeV1[];
  readonly expectedTransitionCount: string;
  readonly expectedTransitionRoot: Hash;
  readonly orderedTransitions: readonly ProductionReadyGraphTransitionV1[];
  readonly familyEdgeCounts: readonly Readonly<{
    readonly familyId: string;
    readonly edgeCount: string;
  }>[];
  readonly familyTransitionCounts: readonly Readonly<{
    readonly familyId: string;
    readonly transitionCount: string;
  }>[];
}

export interface ProductionTerminalPhaseSnapshotTrustStateV1 {
  readonly snapshotRoot: Hash;
  readonly observerContentDirectory: string;
  readonly observerContentEntrySetRoot: Hash;
  readonly terminalLocatorDirectory: string;
  readonly terminalLocatorEntrySetRoot: Hash;
  readonly sixStepSourceLedger: Readonly<{
    readonly sourceDevice: string;
    readonly sourceInode: string;
    readonly snapshotPath: string;
    readonly snapshotDevice: string;
    readonly snapshotInode: string;
    readonly contentSha256: Hash;
    readonly byteLength: string;
    readonly fsynced: true;
  }>;
  readonly sixStepBoundaryDirectory: string;
  readonly sixStepBoundaryEntrySetRoot: Hash;
  readonly sixStepBoundaryFiles: readonly Readonly<{
    readonly name: string;
    readonly contentSha256: Hash;
    readonly byteLength: string;
    readonly device: string;
    readonly inode: string;
    readonly fsynced: true;
  }>[];
  readonly finalDurableWindowId: Hash;
  readonly indexFileName: string;
  readonly indexContentSha256: Hash;
  readonly indexByteLength: string;
  readonly indexRoot: Hash;
  readonly observerStoreIdentityHash: Hash;
  readonly runtimeBindingId: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: Hash;
  readonly activeReadyGraph: ProductionActiveReadyGraphSnapshotV1;
  readonly activeReadyGraphSnapshotRoot: Hash;
  readonly generatedRuntimeMetadata: FullFamilyGeneratedRuntimeMetadataV1;
  readonly generatedRuntimeDenominatorRoot: Hash;
  readonly trustRoot: Hash;
}

export interface ProductionCoarseSweepTransitionDenominatorV1 {
  readonly readyRecordHash: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyCutoff: CanonicalCutoffV1;
  readonly expectedTransitionCount: string;
  readonly expectedTransitionRoot: Hash;
  readonly familyTransitionCounts: readonly Readonly<{
    readonly familyId: string;
    readonly expectedTransitionCount: string;
  }>[];
}

/** Exact trust join from the root-owned active Ready Graph denominator to the
 * advisory coarse sweep. It grants no release or runtime authority. */
export function assertActiveReadyGraphCoarseSweepDenominatorV1(
  activeGraph: Pick<ProductionActiveReadyGraphSnapshotV1,
    "readyRecordHash" | "generationId" | "graphRoot" | "cutoff" | "expectedTransitionCount"
    | "expectedTransitionRoot" | "orderedTransitions" | "familyTransitionCounts">,
  sweep: ProductionCoarseSweepTransitionDenominatorV1,
): void {
  const activeFamilyCounts = activeGraph.familyTransitionCounts.map(({ familyId, transitionCount }) =>
    Object.freeze({ familyId, expectedTransitionCount: transitionCount }));
  if (sweep.readyRecordHash !== activeGraph.readyRecordHash
    || sweep.generationId !== activeGraph.generationId
    || sweep.graphRoot !== activeGraph.graphRoot
    || encodeCanonicalJson(sweep.readyCutoff) !== encodeCanonicalJson(activeGraph.cutoff)
    || sweep.expectedTransitionCount !== activeGraph.expectedTransitionCount
    || sweep.expectedTransitionRoot !== activeGraph.expectedTransitionRoot
    || encodeCanonicalJson(sweep.familyTransitionCounts) !== encodeCanonicalJson(activeFamilyCounts)) {
    throw new TypeError("terminal-phase root-owned Ready Graph/coarse transition denominator splice");
  }
}

const states = new WeakMap<object, ProductionTerminalPhaseSnapshotTrustStateV1>();

function canonicalActiveReadyGraph(
  input: ProductionActiveReadyGraphSnapshotV1,
): ProductionActiveReadyGraphSnapshotV1 {
  assertPlainObject(input, "snapshotTrust.activeReadyGraph");
  assertExactKeys(input, [
    "checkpointRootEnvelopeHash", "checkpointRevision", "readyClosureStorageHash", "readyRecordHash",
    "generationId", "releaseProvenanceHash", "cutoff", "instanceCatalogRoot", "instanceCatalogStorageHash",
    "graphStorageHash", "graphRoot", "edgeCount", "orderedEdgeIds", "orderedEdges", "expectedTransitionCount",
    "expectedTransitionRoot", "orderedTransitions", "familyEdgeCounts", "familyTransitionCounts",
  ], "snapshotTrust.activeReadyGraph");
  assertPlainObject(input.cutoff, "snapshotTrust.activeReadyGraph.cutoff");
  assertExactKeys(input.cutoff, ["chainId", "number", "hash", "stateRoot"], "snapshotTrust.activeReadyGraph.cutoff");
  const cutoff = Object.freeze({
    chainId: assertNonEmptyString(input.cutoff.chainId, "snapshotTrust.activeReadyGraph.cutoff.chainId"),
    number: assertDecimalString(input.cutoff.number, "snapshotTrust.activeReadyGraph.cutoff.number"),
    hash: assertHash(input.cutoff.hash, "snapshotTrust.activeReadyGraph.cutoff.hash"),
    stateRoot: assertHash(input.cutoff.stateRoot, "snapshotTrust.activeReadyGraph.cutoff.stateRoot"),
  });
  if (!Array.isArray(input.orderedEdges) || !Array.isArray(input.orderedEdgeIds)
    || input.orderedEdges.length === 0 || input.orderedEdges.length !== input.orderedEdgeIds.length) {
    throw new TypeError("snapshot trust active Ready Graph edge denominator is invalid");
  }
  const orderedEdges: readonly PersistedGraphEdgeV1[] = Object.freeze(input.orderedEdges.map((edge, index) => {
    const decoded = decodeFullFamilyPersistedGraphEdge(
      edge,
      `snapshotTrust.activeReadyGraph.orderedEdges[${index}]`,
    );
    const edgeId = decoded.edgeId;
    if (edgeId !== assertHash(input.orderedEdgeIds[index], `snapshotTrust.activeReadyGraph.orderedEdgeIds[${index}]`)
      || (index > 0 && input.orderedEdgeIds[index - 1]! >= edgeId)) {
      throw new TypeError("snapshot trust active Ready Graph edge order/identity mismatch");
    }
    return decoded;
  }));
  const orderedEdgeIds = Object.freeze(input.orderedEdgeIds.map((edgeId, index) =>
    assertHash(edgeId, `snapshotTrust.activeReadyGraph.orderedEdgeIds[${index}]`)));
  const edgeCount = assertDecimalString(input.edgeCount, "snapshotTrust.activeReadyGraph.edgeCount");
  if (edgeCount !== String(orderedEdges.length)) {
    throw new TypeError("snapshot trust active Ready Graph edge count mismatch");
  }
  const instanceCatalogRoot = assertHash(input.instanceCatalogRoot, "snapshotTrust.activeReadyGraph.instanceCatalogRoot");
  const graphRoot = assertHash(input.graphRoot, "snapshotTrust.activeReadyGraph.graphRoot");
  if (graphRoot !== hashDomain("aloha/persisted-graph/v1", {
    cutoff,
    instanceCatalogRoot,
    edges: orderedEdges,
  })) {
    throw new TypeError("snapshot trust active Ready Graph root mismatch");
  }
  const familyCounts = new Map<string, number>();
  for (const [index, edge] of orderedEdges.entries()) {
    const familyId = assertNonEmptyString(edge.owningFamilyId, `snapshotTrust.activeReadyGraph.orderedEdges[${index}].owningFamilyId`);
    familyCounts.set(familyId, (familyCounts.get(familyId) ?? 0) + 1);
  }
  const familyEdgeCounts = Object.freeze([...familyCounts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([familyId, count]) => Object.freeze({ familyId, edgeCount: String(count) })));
  if (encodeCanonicalJson(familyEdgeCounts) !== encodeCanonicalJson(input.familyEdgeCounts)) {
    throw new TypeError("snapshot trust active Ready Graph Family denominator mismatch");
  }
  const orderedTransitions = derivePlannerCompatibleReadyGraphTransitionsV1(orderedEdges);
  const expectedTransitionCount = assertDecimalString(
    input.expectedTransitionCount,
    "snapshotTrust.activeReadyGraph.expectedTransitionCount",
  );
  const expectedTransitionRoot = fullGraphTransitionSequenceRootV1(
    "expected",
    orderedTransitions.map(transition => transition.transitionId),
  );
  if (expectedTransitionCount !== String(orderedTransitions.length)
    || assertHash(input.expectedTransitionRoot, "snapshotTrust.activeReadyGraph.expectedTransitionRoot") !== expectedTransitionRoot
    || input.orderedTransitions.length !== orderedTransitions.length
    || input.orderedTransitions.some((value, index) => {
      const expected = orderedTransitions[index];
      return expected === undefined
        || value.transitionId !== expected.transitionId
        || value.edgeId !== expected.edgeId
        || value.transitionRef !== expected.transitionRef
        || value.inputAssetRef !== expected.inputAssetRef
        || value.inputPortRef !== expected.inputPortRef
        || value.outputAssetRef !== expected.outputAssetRef
        || value.outputPortRef !== expected.outputPortRef
        || value.owningFamilyId !== expected.owningFamilyId;
    })) {
    throw new TypeError("snapshot trust active Ready Graph planner transition denominator mismatch");
  }
  const transitionFamilyCounts = new Map<string, number>();
  for (const transition of orderedTransitions) {
    transitionFamilyCounts.set(
      transition.owningFamilyId,
      (transitionFamilyCounts.get(transition.owningFamilyId) ?? 0) + 1,
    );
  }
  const familyTransitionCounts = Object.freeze([...transitionFamilyCounts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([familyId, count]) => Object.freeze({ familyId, transitionCount: String(count) })));
  if (encodeCanonicalJson(input.familyTransitionCounts) !== encodeCanonicalJson(familyTransitionCounts)) {
    throw new TypeError("snapshot trust active Ready Graph Family transition denominator mismatch");
  }
  return Object.freeze({
    checkpointRootEnvelopeHash: assertHash(input.checkpointRootEnvelopeHash, "snapshotTrust.activeReadyGraph.checkpointRootEnvelopeHash"),
    checkpointRevision: assertDecimalString(input.checkpointRevision, "snapshotTrust.activeReadyGraph.checkpointRevision"),
    readyClosureStorageHash: assertHash(input.readyClosureStorageHash, "snapshotTrust.activeReadyGraph.readyClosureStorageHash"),
    readyRecordHash: assertHash(input.readyRecordHash, "snapshotTrust.activeReadyGraph.readyRecordHash"),
    generationId: assertNonEmptyString(input.generationId, "snapshotTrust.activeReadyGraph.generationId"),
    releaseProvenanceHash: assertHash(input.releaseProvenanceHash, "snapshotTrust.activeReadyGraph.releaseProvenanceHash"),
    cutoff,
    instanceCatalogRoot,
    instanceCatalogStorageHash: assertHash(input.instanceCatalogStorageHash, "snapshotTrust.activeReadyGraph.instanceCatalogStorageHash"),
    graphStorageHash: assertHash(input.graphStorageHash, "snapshotTrust.activeReadyGraph.graphStorageHash"),
    graphRoot,
    edgeCount,
    orderedEdgeIds,
    orderedEdges,
    expectedTransitionCount,
    expectedTransitionRoot,
    orderedTransitions,
    familyEdgeCounts,
    familyTransitionCounts,
  });
}

function canonicalState(
  input: Omit<ProductionTerminalPhaseSnapshotTrustStateV1, "activeReadyGraphSnapshotRoot" | "generatedRuntimeDenominatorRoot" | "trustRoot">,
): ProductionTerminalPhaseSnapshotTrustStateV1 {
  if (!input.observerContentDirectory.startsWith("/") || !input.terminalLocatorDirectory.startsWith("/")
    || !input.sixStepSourceLedger.snapshotPath.startsWith("/") || !input.sixStepBoundaryDirectory.startsWith("/")) {
    throw new TypeError("terminal-phase snapshot trust directories must be absolute");
  }
  if (!/^[0-9a-f]{40}$/.test(input.candidateReleaseCommit)) {
    throw new TypeError("terminal-phase snapshot trust release commit is invalid");
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(input.indexByteLength)) {
    throw new TypeError("terminal-phase snapshot trust index length is invalid");
  }
  const expectedName = `${assertHash(input.finalDurableWindowId, "snapshotTrust.finalDurableWindowId").slice(2)}.json`;
  if (assertNonEmptyString(input.indexFileName, "snapshotTrust.indexFileName") !== expectedName) {
    throw new TypeError("terminal-phase snapshot trust index name/window mismatch");
  }
  const activeReadyGraph = canonicalActiveReadyGraph(input.activeReadyGraph);
  const activeReadyGraphSnapshotRoot = hashDomain(
    "aloha/production-active-ready-graph-snapshot/v1",
    activeReadyGraph as unknown as CanonicalJson,
  );
  const generatedRuntimeDenominatorRoot = fullFamilyGeneratedDenominatorRoot(input.generatedRuntimeMetadata);
  const sourceLedger = Object.freeze({
    sourceDevice: assertDecimalString(input.sixStepSourceLedger.sourceDevice, "snapshotTrust.sixStepSourceLedger.sourceDevice"),
    sourceInode: assertDecimalString(input.sixStepSourceLedger.sourceInode, "snapshotTrust.sixStepSourceLedger.sourceInode"),
    snapshotPath: input.sixStepSourceLedger.snapshotPath,
    snapshotDevice: assertDecimalString(input.sixStepSourceLedger.snapshotDevice, "snapshotTrust.sixStepSourceLedger.snapshotDevice"),
    snapshotInode: assertDecimalString(input.sixStepSourceLedger.snapshotInode, "snapshotTrust.sixStepSourceLedger.snapshotInode"),
    contentSha256: assertHash(input.sixStepSourceLedger.contentSha256, "snapshotTrust.sixStepSourceLedger.contentSha256"),
    byteLength: assertDecimalString(input.sixStepSourceLedger.byteLength, "snapshotTrust.sixStepSourceLedger.byteLength"),
    fsynced: input.sixStepSourceLedger.fsynced,
  });
  if (sourceLedger.fsynced !== true || !Array.isArray(input.sixStepBoundaryFiles) || input.sixStepBoundaryFiles.length === 0) {
    throw new TypeError("terminal-phase snapshot trust Six-Step physical denominator is incomplete");
  }
  const boundaryFiles = Object.freeze(input.sixStepBoundaryFiles.map((file, index) => {
    if (!/^[0-9a-f]{64}\.v8$/.test(file.name) || file.fsynced !== true
      || (index > 0 && input.sixStepBoundaryFiles[index - 1]!.name >= file.name)) {
      throw new TypeError("terminal-phase snapshot trust Six-Step boundary file denominator is invalid");
    }
    return Object.freeze({
      name: file.name,
      contentSha256: assertHash(file.contentSha256, `snapshotTrust.sixStepBoundaryFiles[${index}].contentSha256`),
      byteLength: assertDecimalString(file.byteLength, `snapshotTrust.sixStepBoundaryFiles[${index}].byteLength`),
      device: assertDecimalString(file.device, `snapshotTrust.sixStepBoundaryFiles[${index}].device`),
      inode: assertDecimalString(file.inode, `snapshotTrust.sixStepBoundaryFiles[${index}].inode`),
      fsynced: true as const,
    });
  }));
  const payload = Object.freeze({
    snapshotRoot: assertHash(input.snapshotRoot, "snapshotTrust.snapshotRoot"),
    observerContentDirectory: input.observerContentDirectory,
    observerContentEntrySetRoot: assertHash(input.observerContentEntrySetRoot, "snapshotTrust.observerContentEntrySetRoot"),
    terminalLocatorDirectory: input.terminalLocatorDirectory,
    terminalLocatorEntrySetRoot: assertHash(input.terminalLocatorEntrySetRoot, "snapshotTrust.terminalLocatorEntrySetRoot"),
    sixStepSourceLedger: sourceLedger,
    sixStepBoundaryDirectory: input.sixStepBoundaryDirectory,
    sixStepBoundaryEntrySetRoot: assertHash(input.sixStepBoundaryEntrySetRoot, "snapshotTrust.sixStepBoundaryEntrySetRoot"),
    sixStepBoundaryFiles: boundaryFiles,
    finalDurableWindowId: input.finalDurableWindowId,
    indexFileName: input.indexFileName,
    indexContentSha256: assertHash(input.indexContentSha256, "snapshotTrust.indexContentSha256"),
    indexByteLength: input.indexByteLength,
    indexRoot: assertHash(input.indexRoot, "snapshotTrust.indexRoot"),
    observerStoreIdentityHash: assertHash(input.observerStoreIdentityHash, "snapshotTrust.observerStoreIdentityHash"),
    runtimeBindingId: assertHash(input.runtimeBindingId, "snapshotTrust.runtimeBindingId"),
    candidateReleaseCommit: input.candidateReleaseCommit,
    releaseProvenanceHash: assertHash(input.releaseProvenanceHash, "snapshotTrust.releaseProvenanceHash"),
    activeReadyGraph,
    activeReadyGraphSnapshotRoot,
    generatedRuntimeMetadata: input.generatedRuntimeMetadata,
    generatedRuntimeDenominatorRoot,
  });
  return Object.freeze({
    ...payload,
    trustRoot: hashDomain("aloha/production-terminal-phase-snapshot-trust/v1", payload as unknown as CanonicalJson),
  });
}

/** State-only registrar. Boundary CI permits only the fixed packager snapshot
 * importer (and test closure) to import it; this module observes no caller DTO
 * and exposes no public capability mint. */
export function registerProductionTerminalPhaseSnapshotTrustCapabilityV1(
  capability: ProductionTerminalPhaseSnapshotTrustCapabilityV1,
  input: Omit<ProductionTerminalPhaseSnapshotTrustStateV1, "activeReadyGraphSnapshotRoot" | "generatedRuntimeDenominatorRoot" | "trustRoot">,
): void {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0
    || !Object.isFrozen(capability) || states.has(capability)) {
    throw new TypeError("terminal-phase snapshot trust registration capability is invalid");
  }
  states.set(capability, canonicalState(input));
}

export function readProductionTerminalPhaseSnapshotTrustCapabilityV1(
  capability: ProductionTerminalPhaseSnapshotTrustCapabilityV1,
): ProductionTerminalPhaseSnapshotTrustStateV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("terminal-phase snapshot trust capability is invalid");
  }
  const state = states.get(capability);
  if (state === undefined) throw new TypeError("terminal-phase snapshot trust capability was not owner-registered");
  return state;
}
