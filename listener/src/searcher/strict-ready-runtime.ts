import type { TokenEdge } from "./planner/token-graph.js";
import type { ReadyUniverseGeneration, StartupCheckpointEnvelope } from
  "./universe-rebuild-checkpoint.js";
import {
  hashReadyCatalogSnapshot,
  hashReadyGraphSnapshot,
  hashReadyPublicationSet,
} from "./universe-rebuild-runner.js";

/**
 * Resolve the sole production Graph authority from a committed strict
 * readyGeneration. No raw universe, fallback builder or secondary merge is
 * accepted here.
 */
export function resolveStrictReadyRuntime(
  ready: ReadyUniverseGeneration | null,
): {
  readonly ready: ReadyUniverseGeneration;
  readonly graph: readonly TokenEdge[];
} {
  if (ready === null) {
    throw new Error("strict runtime requires a committed readyGeneration");
  }
  if (
    ready.appliedThrough.number !== ready.cutoff.number ||
    ready.appliedThrough.hash.toLowerCase() !== ready.cutoff.hash.toLowerCase()
  ) {
    throw new Error("strict readyGeneration applied cursor is not at cutoff");
  }
  if (
    !Number.isSafeInteger(ready.universeRange.fromBlock) ||
    ready.universeRange.fromBlock < 0 ||
    ready.universeRange.toBlock !== ready.cutoff.number ||
    ready.universeRange.fromBlock > ready.universeRange.toBlock
  ) {
    throw new Error("strict readyGeneration universe range is invalid");
  }
  if (
    ready.sourceCoverage.length === 0 ||
    ready.sourceCoverage.some((coverage) =>
      coverage.completeThroughBlock !== ready.cutoff.number ||
      coverage.completeThroughHash?.toLowerCase() !==
        ready.cutoff.hash.toLowerCase()
    )
  ) {
    throw new Error("strict readyGeneration source coverage is incomplete");
  }
  if (
    hashReadyGraphSnapshot(ready.graphSnapshot) !== ready.graphHash ||
    hashReadyCatalogSnapshot(ready.catalogSnapshot) !== ready.catalogHash ||
    hashReadyPublicationSet(ready.catalogSnapshot) !== ready.publicationSetHash
  ) {
    throw new Error("strict readyGeneration root mismatch");
  }
  const snapshot = ready.graphSnapshot as {
    readonly format?: unknown;
    readonly edges?: unknown;
  };
  if (
    snapshot.format !== "strict-rebuild-graph-v1" ||
    !Array.isArray(snapshot.edges)
  ) {
    throw new Error("strict readyGeneration graph snapshot is invalid");
  }
  return Object.freeze({
    ready,
    graph: Object.freeze([...snapshot.edges]) as readonly TokenEdge[],
  });
}

/**
 * A probe commits admission evidence, not a new Graph. Check that evidence
 * against the sealed publication even when no rebuild is in progress. Retry
 * counters alone do not dirty Graph, and explicitly disabled Families remain
 * outside the publication. This is a startup guard, never a Graph writer.
 */
export function assertReadyCheckpointPublicationCurrent(
  checkpoint: StartupCheckpointEnvelope,
  familyActivation?: (familyId: string) => boolean | undefined,
): void {
  const ready = checkpoint.readyGeneration;
  if (ready === null) {
    throw new Error("strict startup requires a committed readyGeneration");
  }
  const catalog = ready.catalogSnapshot as {
    readonly format?: string;
    readonly instances?: readonly {
      readonly familyCandidateKey: string;
      readonly familyInstanceKey: string;
      readonly familyId: string;
      readonly memoFingerprint: string;
    }[];
  } | null;
  if (catalog?.format !== "strict-rebuild-catalog-v1" ||
    !Array.isArray(catalog.instances)) {
    throw new Error("strict startup requires the sealed Ready instance catalog");
  }
  const published = new Map(catalog.instances.map(entry =>
    [entry.familyCandidateKey, entry] as const));
  const publishedInstances = new Set(catalog.instances.map(entry => entry.familyInstanceKey));
  const disabled = new Set([
    ...(ready.activationRestriction?.disabledFamilyIds ?? []),
    ...Object.entries(ready.familyPartitions ?? {})
      .filter(([, partition]) => !partition.enabled).map(([id]) => id),
  ]);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [key, entry] of published) {
    const memo = checkpoint.verifiedMemos[key];
    const outcome = checkpoint.inProgressRun?.outcomesByCandidateKey[key];
    if (memo === undefined) removed++;
    else if (memo.familyInstanceKey !== entry.familyInstanceKey ||
      memo.familyId !== entry.familyId || memo.memoFingerprint !== entry.memoFingerprint ||
      (outcome !== undefined && outcome.status !== "verified")) changed++;
  }
  for (const [key, memo] of Object.entries(checkpoint.verifiedMemos)) {
    // The durable cache may retain a non-selected historical candidate alias
    // for an already published instance. Only the catalog-selected memo owns
    // that instance; its removal/replacement is checked above.
    if (published.has(key) || publishedInstances.has(memo.familyInstanceKey)) continue;
    // A supplied production activation view supersedes historical restrictions.
    // Only an installed, explicitly disabled Family returns false; unknown
    // (undefined) and newly enabled Families still require publication.
    if (familyActivation === undefined ? disabled.has(memo.familyId)
      : familyActivation(memo.familyId) === false) continue;
    const outcome = checkpoint.inProgressRun?.outcomesByCandidateKey[key];
    // A failed re-attestation may retain an older memo for future reuse. It
    // remains excluded while queued, unless the current run already verified
    // this exact replacement (the old queue is pruned on Ready promotion).
    if (checkpoint.retryableAttemptsByCandidateKey[key] !== undefined &&
      !(outcome?.status === "verified" && outcome.memoFingerprint === memo.memoFingerprint)) continue;
    added++;
  }
  if (added + removed + changed > 0) {
    throw new Error(
      `strict startup Ready/Graph is stale relative to checkpoint admission: ` +
      `generation=${ready.generation} added=${added} removed=${removed} changed=${changed}; ` +
      "publish an updated Ready/Graph before startup; remaining retryable candidates may stay excluded",
    );
  }
}
