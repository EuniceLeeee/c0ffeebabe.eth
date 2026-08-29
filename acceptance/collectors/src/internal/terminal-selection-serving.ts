import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";

interface TerminalSelectionServingIdentityV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly sourceCoverageRoot: Hash;
}

interface TerminalSelectionPerformanceEventV1 {
  readonly eventId: Hash;
  readonly eventType: string;
  readonly serving: TerminalSelectionServingIdentityV1 | null;
}

interface TerminalSelectionGenerationSegmentV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly generationSourceCoverageRoot: Hash;
  readonly lastHeadOrdinal: string;
}

/** Resolve serving from the exact selected performance event. The final
 * generation segment is authoritative only when the window has no selected
 * success. */
export function resolveTerminalSelectionServingV1(input: Readonly<{
  readonly events: readonly TerminalSelectionPerformanceEventV1[];
  readonly selectedIndex: "0" | null;
  readonly selectedPerformanceEventId: Hash | null;
  readonly finalSegment: TerminalSelectionGenerationSegmentV1;
}>): TerminalSelectionServingIdentityV1 {
  if (input.finalSegment.lastHeadOrdinal !== "100") {
    throw new TypeError("terminal-selection raw SQLite denominator lacks final serving segment");
  }
  if (input.selectedIndex === null) {
    if (input.selectedPerformanceEventId !== null) {
      throw new TypeError("terminal-selection no-success performance selection is not empty");
    }
    return Object.freeze({
      generationId: input.finalSegment.generationId,
      graphRoot: input.finalSegment.graphRoot,
      readyRecordHash: input.finalSegment.readyRecordHash,
      sourceCoverageRoot: input.finalSegment.generationSourceCoverageRoot,
    });
  }
  if (input.selectedPerformanceEventId === null) {
    throw new TypeError("terminal-selection selected performance event is missing");
  }
  const selectedEvents = input.events.filter(event => event.eventId === input.selectedPerformanceEventId);
  const selected = selectedEvents[0];
  if (selectedEvents.length !== 1
    || selected?.eventType !== "performance-facts-complete"
    || selected.serving === null) {
    throw new TypeError("terminal-selection selected performance serving is missing or ambiguous");
  }
  return Object.freeze({ ...selected.serving });
}
