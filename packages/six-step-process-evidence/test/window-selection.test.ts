import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST,
  sealSixStepWindowSelectionFactsV1,
  type SixStepWindowEligibleSuccessV1,
} from "../src/internal/window-selection-owner.ts";

const h = (value: string): Hash => hashDomain("test/six-step-window-selection/v1", value);

function success(
  label: string,
  ordinal: string,
  lane: "blockscan" | "backrun",
  candidateStableKey = h(`candidate:${label}`),
): SixStepWindowEligibleSuccessV1 {
  return Object.freeze({
    ordinal,
    lane,
    candidateStableKey,
    producerTerminalId: h(`terminal:${label}`),
    performanceEventId: h(`performance:${label}`),
    producerTerminalEventId: h(`producer:${label}`),
  });
}

test("multiple eligible successes select the first fixed-order entry and bind the full denominator", () => {
  const later = success("later", "2", "blockscan");
  const backrun = success("backrun", "1", "backrun", h("candidate:first"));
  const blockscan = success("blockscan", "1", "blockscan", h("candidate:last"));
  const first = sealSixStepWindowSelectionFactsV1({
    finalDurableWindowId: h("window"),
    windowId: h("performance-window"),
    eligibleSuccesses: [later, backrun, blockscan],
  });
  const reordered = sealSixStepWindowSelectionFactsV1({
    finalDurableWindowId: h("window"),
    windowId: h("performance-window"),
    eligibleSuccesses: [blockscan, later, backrun],
  });
  assert.equal(SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST.length, 66);
  assert.equal(first.eligibleSuccessCount, "3");
  assert.equal(first.selectedIndex, "0");
  assert.equal(first.selectedProducerTerminalId, blockscan.producerTerminalId);
  assert.deepEqual(first.orderedEligible.map(entry => entry.producerTerminalId), [
    blockscan.producerTerminalId,
    backrun.producerTerminalId,
    later.producerTerminalId,
  ]);
  assert.equal(reordered.selectionRoot, first.selectionRoot, "caller order must not select another success");
});

test("selection facts reject duplicate terminal authority and change on an order-key splice", () => {
  const left = success("left", "1", "blockscan");
  const right = success("right", "2", "blockscan");
  const base = sealSixStepWindowSelectionFactsV1({
    finalDurableWindowId: h("window"),
    windowId: h("performance-window"),
    eligibleSuccesses: [left, right],
  });
  const spliced = sealSixStepWindowSelectionFactsV1({
    finalDurableWindowId: h("window"),
    windowId: h("performance-window"),
    eligibleSuccesses: [{ ...left, ordinal: "3" }, right],
  });
  assert.notEqual(spliced.selectionRoot, base.selectionRoot);
  assert.throws(
    () => sealSixStepWindowSelectionFactsV1({
      finalDurableWindowId: h("window"),
      windowId: h("performance-window"),
      eligibleSuccesses: [left, { ...right, producerTerminalId: left.producerTerminalId }],
    }),
    /conflicting complete appends/,
  );
});

test("an empty active denominator remains typed missing material", () => {
  const value = sealSixStepWindowSelectionFactsV1({
    finalDurableWindowId: h("window"),
    windowId: h("performance-window"),
    eligibleSuccesses: [],
  });
  assert.equal(value.eligibleSuccessCount, "0");
  assert.equal(value.selectedIndex, null);
  assert.equal(value.selectedProducerTerminalId, null);
});
