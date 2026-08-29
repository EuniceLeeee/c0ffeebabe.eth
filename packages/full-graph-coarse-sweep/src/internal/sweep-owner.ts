import {
  assertDecimalString,
  deepFreeze,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type { AssetPortV1 } from "../../../catalog/src/index.ts";
import {
  coarseEdgeSweepBindingRootV1,
  readQualifiedCoarseProjectionReceiptV1,
  readQualifiedCoarseProjectionV1,
  type CoarseEdgeSweepBindingV1,
} from "../../../coarse-economics/src/index.ts";
import { issueCoarseEdgeSweepBindingV1 } from "../../../coarse-economics/src/internal/full-graph-sweep-owner.ts";
import {
  assertGeneratedFamilyRuntimeComposition,
  familyCoarseRouteOwnerRefV1,
  type FamilyRuntimeCompositionV1,
} from "../../../family-composition/src/index.ts";
import {
  familySearchAmount,
  familySearchAmountHash,
  familySearchObjective,
  familySearchRouteBindingHash,
} from "../../../family-sdk/search-runtime/index.ts";
import type { FamilyIssuedRouteHandleV1 } from "../../../family-sdk/runtime/index.ts";
import type { PersistedGraphEdgeV1, RuntimeGraphEdgeV1 } from "../../../graph/src/index.ts";
import {
  encodeFullGraphCoarseSweepV1,
  fullGraphTransitionSequenceRootV1,
  sealFullGraphCoarseSweepV1,
  type FullGraphCoarseSweepCapabilityV1,
  type FullGraphCoarseSweepEntryV1,
  type FullGraphCoarseSweepFamilyTransitionCountV1,
  type FullGraphCoarseSweepV1,
  type FullGraphCoarseSweepInvocationCapabilityV1,
  type FullGraphCoarseSweepManifestV1,
  type FullGraphCoarseSweepEntryChunkV1,
} from "../index.ts";
import { consumeFullGraphCoarseSweepInvocationCapabilityV1 } from "./invocation-owner.ts";
import {
  abortFullGraphSweepSnapshotV1,
  claimFullGraphSweepSnapshotV1,
  commitFullGraphSweepSnapshotV1,
} from "./snapshot-claim-owner.ts";

export interface FullGraphCoarseSweepReleaseBindingV1 {
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseMembershipRoot: Hash;
}

const results = new WeakMap<object, Readonly<{
  manifest: FullGraphCoarseSweepManifestV1;
  chunks: readonly FullGraphCoarseSweepEntryChunkV1[];
}>>();

const FULL_GRAPH_SWEEP_MAX_CONCURRENCY = 32;

interface RuntimeGraphTransitionV1 {
  readonly transitionId: Hash;
  readonly transitionKey: string;
  readonly edge: RuntimeGraphEdgeV1;
  readonly input: AssetPortV1;
  readonly output: AssetPortV1;
}

async function orderedBoundedMap<Input, Output>(
  values: readonly Input[],
  worker: (value: Input, ordinal: number) => Promise<Output>,
): Promise<readonly Output[]> {
  if (values.length === 0) return Object.freeze([]);
  const output: Output[] = new Array(values.length);
  const failures: Array<Readonly<{ readonly ordinal: number; readonly error: unknown }>> = [];
  let nextOrdinal = 0;
  let stopped = false;
  const run = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const ordinal = nextOrdinal;
      if (ordinal >= values.length) return;
      nextOrdinal += 1;
      try {
        output[ordinal] = await worker(values[ordinal]!, ordinal);
      } catch (error) {
        failures.push(Object.freeze({ ordinal, error }));
        stopped = true;
        return;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(FULL_GRAPH_SWEEP_MAX_CONCURRENCY, values.length) },
    () => run(),
  ));
  if (failures.length > 0) {
    failures.sort((left, right) => left.ordinal - right.ordinal);
    throw failures[0]!.error;
  }
  return Object.freeze(output);
}

/** Independent implementation of the planner's complete transition rule:
 * every input port paired with every output port, exact-sorted by identity. */
function graphTransitions(edges: readonly RuntimeGraphEdgeV1[]): readonly RuntimeGraphTransitionV1[] {
  const result = edges.flatMap(edge => edge.inputAssetPorts.flatMap(input => edge.outputAssetPorts.map(output => {
    const identity = deepFreeze({
      edgeId: edge.edgeId,
      transitionRef: edge.opaqueTransitionRef,
      inputAssetRef: input.assetRef,
      inputPortRef: input.portRef,
      outputAssetRef: output.assetRef,
      outputPortRef: output.portRef,
      owningFamilyId: edge.owningFamilyId,
    });
    return Object.freeze({
      transitionId: hashDomain("aloha/full-graph-coarse-transition/v1", identity as unknown as CanonicalJson),
      transitionKey: `${edge.edgeId}\u001f${edge.opaqueTransitionRef}\u001f${input.assetRef}\u001f${input.portRef}\u001f${output.assetRef}\u001f${output.portRef}`,
      edge,
      input,
      output,
    });
  })));
  result.sort((left, right) => left.transitionKey < right.transitionKey ? -1 : left.transitionKey > right.transitionKey ? 1 : 0);
  if (new Set(result.map(transition => transition.transitionId)).size !== result.length) {
    throw new TypeError("full-Graph sweep transition denominator has duplicates");
  }
  return Object.freeze(result);
}

function persistedEdge(edge: RuntimeGraphEdgeV1): PersistedGraphEdgeV1 {
  const { routeHandle: _routeHandle, ...persisted } = edge;
  return deepFreeze(persisted);
}

function currentSource(session: ReturnType<typeof consumeFullGraphCoarseSweepInvocationCapabilityV1>["session"]): FullGraphCoarseSweepV1["binding"]["actualCurrentSource"] {
  return deepFreeze({
    chainId: session.source.chainId,
    number: session.source.number,
    hash: session.source.hash,
    stateRoot: session.source.stateRoot,
  });
}

function missingEntry(
  bindingRoot: Hash,
  ordinal: number,
  transition: RuntimeGraphTransitionV1,
  reason: NonNullable<FullGraphCoarseSweepEntryV1["missingReason"]>,
): FullGraphCoarseSweepEntryV1 {
  const body = deepFreeze({
    bindingRoot,
    ordinal: String(ordinal),
    transitionId: transition.transitionId,
    edge: persistedEdge(transition.edge),
    inputAssetRef: transition.input.assetRef,
    inputPortRef: transition.input.portRef,
    outputAssetRef: transition.output.assetRef,
    outputPortRef: transition.output.portRef,
    status: "missing" as const,
    missingReason: reason,
    receipt: null,
    familyObservation: null,
  });
  return deepFreeze({
    ...body,
    entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", body as unknown as CanonicalJson),
  });
}

/** Called only by the runtime-release owner. */
export async function issueFullGraphCoarseSweepCapabilityV1(input: {
  readonly invocation: FullGraphCoarseSweepInvocationCapabilityV1;
  readonly composition: FamilyRuntimeCompositionV1;
  readonly release: FullGraphCoarseSweepReleaseBindingV1;
  readonly assertReleaseCurrent: () => void;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
}): Promise<FullGraphCoarseSweepCapabilityV1> {
  assertGeneratedFamilyRuntimeComposition(input.composition);
  input.assertReleaseCurrent();
  const invocation = consumeFullGraphCoarseSweepInvocationCapabilityV1(input.invocation);
  const session = invocation.session;
  await session.assertCurrent(input.signal);
  await session.lease.assertActive();
  const ready = session.lease.binding;
  const source = currentSource(session);
  if (ready.releaseProvenanceHash !== input.release.releaseProvenanceHash
    || session.generation.releaseProvenanceHash !== input.release.releaseProvenanceHash
    || session.generation.generationId !== ready.generationId
    || session.generation.readyRecordHash !== ready.readyRecordHash
    || session.generation.graphRoot !== ready.graphRoot) {
    throw new TypeError("full-Graph sweep runtime-release/Ready/Graph binding mismatch");
  }
  if (ready.definitionCatalogRoot !== input.composition.definitionCatalogRoot) {
    throw new TypeError("full-Graph sweep Ready/generated Family catalog mismatch");
  }
  const cutoffNumber = BigInt(ready.cutoff.number);
  if (cutoffNumber < 49n) throw new TypeError("full-Graph sweep Ready cutoff cannot anchor 50 blocks");
  const recentObservationRange = deepFreeze({
    from: String(cutoffNumber - 49n),
    to: ready.cutoff.number,
    blockCount: "50" as const,
  });
  const amountSeedHash = hashDomain("aloha/full-graph-coarse-sweep-amount-seed/v1", invocation.amountSeed);
  const objectivePayload = deepFreeze({
    schemaVersion: 1,
    kind: "aloha.full-graph-coarse-sweep-objective-v1",
    generationId: ready.generationId,
    readyRecordHash: ready.readyRecordHash,
    graphRoot: ready.graphRoot,
    readyCutoff: ready.cutoff,
    actualCurrentSource: source,
    amountSeedHash,
  }) as unknown as CanonicalJson;
  const objective = familySearchObjective({
    payload: objectivePayload,
    objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload),
  });
  const bindingBody = deepFreeze({
    runtimeBindingId: input.release.runtimeBindingId,
    releaseProvenanceHash: input.release.releaseProvenanceHash,
    candidateReleaseCommit: input.release.candidateReleaseCommit,
    releaseMembershipRoot: input.release.releaseMembershipRoot,
    definitionCatalogRoot: input.composition.definitionCatalogRoot,
    familyCompositionRoot: input.composition.compositionRoot,
    generationId: ready.generationId,
    readyRecordHash: ready.readyRecordHash,
    graphRoot: ready.graphRoot,
    readyCutoff: ready.cutoff,
    recentObservationRange,
    currentSourceSessionId: session.sessionId,
    actualCurrentSource: source,
    amountSeedHash,
    objectiveRef: objective.objectiveRef,
  });
  const binding = deepFreeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/full-graph-coarse-sweep-binding/v1", bindingBody as unknown as CanonicalJson),
  });
  const snapshotClaim = claimFullGraphSweepSnapshotV1(invocation.canonicalSourceAuthority, hashDomain("aloha/full-graph-coarse-sweep-snapshot/v1", {
    releaseProvenanceHash: input.release.releaseProvenanceHash,
    readyRecordHash: ready.readyRecordHash,
    graphRoot: ready.graphRoot,
    actualCurrentSource: source,
  }));
  let snapshotCommitted = false;
  try {
    const transitions = graphTransitions(session.lease.edges);
    const routeContexts = new Map<Hash, Promise<Readonly<{
      readonly routeHandle: FamilyIssuedRouteHandleV1;
      readonly routeBindingHash: Hash;
    }>>>();
    const routeContext = (edge: RuntimeGraphEdgeV1) => {
      const current = routeContexts.get(edge.edgeId);
      if (current !== undefined) return current;
      const created = (async () => {
        const issuedHandle = await session.lease.resolveRouteHandle(edge.edgeId, edge.routeHandle);
        const routeHandle = issuedHandle.opaque as FamilyIssuedRouteHandleV1;
        const route = input.composition.resolveRouteHandle(routeHandle, edge.owningFamilyDefinitionHash);
        if (route.familyId !== edge.owningFamilyId || route.familyDefinitionHash !== edge.owningFamilyDefinitionHash
          || route.instanceKey !== edge.owningInstanceKey || route.instancePublicationHash !== edge.instancePublicationHash
          || route.staticProjectionHash !== edge.staticProjectionHash || route.projectionHash !== edge.projectionHash) {
          throw new TypeError("full-Graph sweep route handle/persisted edge mismatch");
        }
        return Object.freeze({ routeHandle, routeBindingHash: familySearchRouteBindingHash(route) });
      })();
      routeContexts.set(edge.edgeId, created);
      return created;
    };
    const entries = await orderedBoundedMap(transitions, async (transition, ordinal) => {
      await session.assertCurrent(input.signal);
      await session.lease.assertActive();
      input.assertReleaseCurrent();
      const edge = transition.edge;
      const seam = input.composition.resolveCoarseProjection(edge.owningFamilyDefinitionHash);
      if (seam === null) {
        return missingEntry(binding.bindingRoot, ordinal, transition, "coarse-owner-missing");
      }
      const { routeHandle, routeBindingHash } = await routeContext(edge);
      const edgeBindingBody = deepFreeze({
        schemaVersion: 1 as const,
        kind: "aloha.coarse-edge-sweep-binding-v1" as const,
        familyId: edge.owningFamilyId,
        familyDefinitionHash: edge.owningFamilyDefinitionHash,
        edgeId: edge.edgeId,
        transitionRef: edge.opaqueTransitionRef,
        inputAssetRef: transition.input.assetRef,
        inputPortRef: transition.input.portRef,
        outputAssetRef: transition.output.assetRef,
        outputPortRef: transition.output.portRef,
        routeBindingHash,
        routeOwnerRef: familyCoarseRouteOwnerRefV1(edge.owningFamilyDefinitionHash, routeBindingHash),
        generationId: ready.generationId,
        readyRecordHash: ready.readyRecordHash,
        graphRoot: ready.graphRoot,
        readyCutoff: ready.cutoff,
        source,
        objectiveRef: objective.objectiveRef,
        releaseProvenanceHash: input.release.releaseProvenanceHash,
      });
      const edgeBinding: CoarseEdgeSweepBindingV1 = deepFreeze({
        ...edgeBindingBody,
        bindingRoot: coarseEdgeSweepBindingRootV1(edgeBindingBody),
      });
      const issuedBinding = issueCoarseEdgeSweepBindingV1(edgeBinding);
      const amount = familySearchAmount({
        inputAssetRef: transition.input.assetRef,
        outputAssetRef: transition.output.assetRef,
        amountIn: invocation.amountSeed.amountIn,
        recipient: invocation.amountSeed.recipient,
      });
      const projectionCapability = await input.composition.issueCoarseEdgeSweepProjection(seam.producer, {
        binding: issuedBinding,
        issuedHandle: routeHandle,
        currentSource: Object.freeze({
          sessionId: session.sessionId,
          source,
          assertCurrent: () => session.assertCurrent(input.signal),
        }),
        sourceRead: invocation.sourceRead,
        objective,
        amount,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.deadlineAtMs === undefined ? {} : { deadlineAtMs: input.deadlineAtMs }),
      });
      // Preserve the Family-owned raw observation before admitting the generic
      // qualified receipt; neither is reconstructed from the other.
      const familyObservation = input.composition.readCoarseEdgeSweepObservation(seam.producer, projectionCapability);
      const qualified = readQualifiedCoarseProjectionV1({ service: seam.service, capability: projectionCapability });
      const receipt = readQualifiedCoarseProjectionReceiptV1(qualified);
      if (familyObservation.binding.bindingRoot !== edgeBinding.bindingRoot
        || familyObservation.projectionId !== receipt.projection.projectionId
        || familyObservation.releaseMembershipRoot !== input.release.releaseMembershipRoot
        || receipt.releaseMembershipRoot !== input.release.releaseMembershipRoot
        || receipt.releaseProvenanceHash !== input.release.releaseProvenanceHash
        || receipt.projection.edgeId !== edge.edgeId
        || receipt.projection.routeBindingHash !== routeBindingHash
        || receipt.projection.graphRoot !== ready.graphRoot
        || receipt.projection.source.hash !== source.hash
        || familyObservation.amountHash !== familySearchAmountHash(amount)) {
        throw new TypeError("full-Graph sweep Family observation/qualified receipt join mismatch");
      }
      const entryBody = deepFreeze({
        bindingRoot: binding.bindingRoot,
        ordinal: String(ordinal),
        transitionId: transition.transitionId,
        edge: persistedEdge(edge),
        inputAssetRef: transition.input.assetRef,
        inputPortRef: transition.input.portRef,
        outputAssetRef: transition.output.assetRef,
        outputPortRef: transition.output.portRef,
        status: "observed" as const,
        missingReason: null,
        receipt,
        familyObservation: familyObservation as unknown as CanonicalJson,
      });
      const entry = deepFreeze({
        ...entryBody,
        entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", entryBody as unknown as CanonicalJson),
      });
      await session.assertCurrent(input.signal);
      await session.lease.assertActive();
      input.assertReleaseCurrent();
      return entry;
    });
  await session.assertCurrent(input.signal);
  await session.lease.assertActive();
  input.assertReleaseCurrent();
  if (entries.length !== transitions.length) throw new TypeError("full-Graph sweep transition denominator changed");
  const observed = entries.filter(entry => entry.status === "observed");
  const missing = entries.filter(entry => entry.status === "missing");
  const expectedTransitionIds = Object.freeze(entries.map(entry => entry.transitionId));
  const observedTransitionIds = Object.freeze(observed.map(entry => entry.transitionId));
  const missingTransitionIds = Object.freeze(missing.map(entry => entry.transitionId));
  const familyCounts = new Map<string, { expected: number; observed: number; missing: number }>();
  for (const entry of entries) {
    const counts = familyCounts.get(entry.edge.owningFamilyId) ?? { expected: 0, observed: 0, missing: 0 };
    counts.expected += 1;
    counts[entry.status] += 1;
    familyCounts.set(entry.edge.owningFamilyId, counts);
  }
  const familyTransitionCounts: readonly FullGraphCoarseSweepFamilyTransitionCountV1[] = Object.freeze(
    [...familyCounts.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([familyId, counts]) => Object.freeze({
        familyId,
        expectedTransitionCount: String(counts.expected),
        observedTransitionCount: String(counts.observed),
        missingTransitionCount: String(counts.missing),
      })),
  );
  const body = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-graph-coarse-sweep-v1" as const,
    binding,
    expectedTransitionCount: String(entries.length),
    expectedTransitionIds,
    expectedTransitionRoot: fullGraphTransitionSequenceRootV1("expected", expectedTransitionIds),
    observedTransitionCount: String(observed.length),
    observedTransitionIds,
    observedTransitionRoot: fullGraphTransitionSequenceRootV1("observed", observedTransitionIds),
    missingTransitionCount: String(missing.length),
    missingTransitionIds,
    missingTransitionRoot: fullGraphTransitionSequenceRootV1("missing", missingTransitionIds),
    familyTransitionCounts,
    entries,
  });
  const sweep = deepFreeze(sealFullGraphCoarseSweepV1(body));
    const capability = Object.freeze(Object.create(null)) as FullGraphCoarseSweepCapabilityV1;
    const encoded = encodeFullGraphCoarseSweepV1(sweep);
    results.set(capability, Object.freeze({
      manifest: encoded.manifest,
      chunks: Object.freeze(encoded.chunks.map(value => value.chunk)),
    }));
    commitFullGraphSweepSnapshotV1(snapshotClaim);
    snapshotCommitted = true;
    return capability;
  } finally {
    if (!snapshotCommitted) abortFullGraphSweepSnapshotV1(snapshotClaim);
  }
}

export function readIssuedFullGraphCoarseSweepManifestV1(
  capability: FullGraphCoarseSweepCapabilityV1,
): FullGraphCoarseSweepManifestV1 {
  const result = results.get(capability);
  if (result === undefined) throw new TypeError("full-Graph coarse sweep capability was not owner-issued");
  return result.manifest;
}

export function readIssuedFullGraphCoarseSweepEntryChunkV1(
  capability: FullGraphCoarseSweepCapabilityV1,
  chunkOrdinal: string,
): FullGraphCoarseSweepEntryChunkV1 {
  assertDecimalString(chunkOrdinal, "chunkOrdinal");
  const result = results.get(capability);
  if (result === undefined) throw new TypeError("full-Graph coarse sweep capability was not owner-issued");
  const chunk = result.chunks[Number(chunkOrdinal)];
  if (chunk === undefined || chunk.chunkOrdinal !== chunkOrdinal) {
    throw new TypeError("full-Graph coarse sweep chunk ordinal is unavailable");
  }
  return chunk;
}
