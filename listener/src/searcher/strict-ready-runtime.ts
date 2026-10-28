import type { TokenEdge } from "./planner/token-graph.js";
import type { ReadyUniverseGeneration } from
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
