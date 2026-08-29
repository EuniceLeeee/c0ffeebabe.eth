import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { resolveTerminalSelectionServingV1 } from "../src/internal/terminal-selection-serving.ts";

const h = (value: string): Hash => hashDomain("test/terminal-selection-serving/v1", value);
const serving = (generationId: string) => Object.freeze({
  generationId,
  graphRoot: h(`graph:${generationId}`),
  readyRecordHash: h(`ready:${generationId}`),
  sourceCoverageRoot: h(`coverage:${generationId}`),
});
const finalSegment = Object.freeze({
  generationId: "generation-b",
  graphRoot: h("graph:generation-b"),
  readyRecordHash: h("ready:generation-b"),
  generationSourceCoverageRoot: h("coverage:generation-b"),
  lastHeadOrdinal: "100",
});

test("selected success keeps its own serving identity across a generation rotation", () => {
  const selectedEventId = h("selected-performance-event");
  const selectedServing = serving("generation-a");
  const result = resolveTerminalSelectionServingV1({
    events: Object.freeze([
      Object.freeze({ eventId: selectedEventId, eventType: "performance-facts-complete", serving: selectedServing }),
      Object.freeze({ eventId: h("final-performance-event"), eventType: "performance-facts-complete", serving: serving("generation-b") }),
    ]),
    selectedIndex: "0",
    selectedPerformanceEventId: selectedEventId,
    finalSegment,
  });
  assert.deepEqual(result, selectedServing);
  assert.notDeepEqual(result, serving("generation-b"), "final-window serving must not replace the selected event serving");
});

test("selected serving cannot be spliced from another performance event", () => {
  const selectedEventId = h("selected-performance-event");
  assert.throws(() => resolveTerminalSelectionServingV1({
    events: Object.freeze([
      Object.freeze({ eventId: h("foreign-performance-event"), eventType: "performance-facts-complete", serving: serving("generation-b") }),
    ]),
    selectedIndex: "0",
    selectedPerformanceEventId: selectedEventId,
    finalSegment,
  }), /selected performance serving is missing or ambiguous/);
});

test("no-success terminal uses the final generation segment only", () => {
  assert.deepEqual(resolveTerminalSelectionServingV1({
    events: Object.freeze([]),
    selectedIndex: null,
    selectedPerformanceEventId: null,
    finalSegment,
  }), serving("generation-b"));
});
