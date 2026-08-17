import type { ReadyUniverseGeneration } from "./universe-rebuild-checkpoint.js";

/**
 * Audit §5/§6 producer freeze: after a ready generation exists at the run
 * cutoff, the producer starts from that baseline - the observed/applied
 * cursors never rewind before the ready cutoff, and the historical event
 * window is not re-scanned for pools the ready run already verified.
 */

export interface ProducerBaseline {
  readonly ready: ReadyUniverseGeneration;
  /** Observed-event scan starts at the ready cutoff (never earlier). */
  readonly observationScanFrom: number;
  /** True when the ready generation covers the current head (no re-scan). */
  readonly currentAtHead: boolean;
  readonly activeInstanceKeys: ReadonlySet<string>;
}

export function resolveProducerBaseline(input: {
  readonly ready: ReadyUniverseGeneration;
  readonly currentHead: number;
}): ProducerBaseline {
  const currentAtHead = input.ready.cutoff.number >= input.currentHead;
  return Object.freeze({
    ready: input.ready,
    observationScanFrom: input.ready.cutoff.number,
    currentAtHead,
    activeInstanceKeys: Object.freeze(
      new Set(input.ready.activeInstanceKeys),
    ),
  });
}

/**
 * The historical event window must not start before the ready cutoff: the
 * ready run already observed/attested the two-day window, so the producer
 * resumes from the cutoff instead of re-scanning it. Returns the scan
 * start for the observed-event feed.
 */
export function observationScanFromWithBaseline(input: {
  readonly baseline: ProducerBaseline | null;
  readonly defaultScanFrom: number;
  readonly universeWindowFrom: number;
}): number {
  if (input.baseline === null) {
    return Math.min(input.defaultScanFrom, input.universeWindowFrom);
  }
  return Math.max(
    input.defaultScanFrom,
    Math.max(input.baseline.observationScanFrom, input.universeWindowFrom),
  );
}
