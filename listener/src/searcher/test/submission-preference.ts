import assert from "node:assert/strict";
import { test } from "node:test";
import { SubmissionPreference, type DeferredSubmission } from "../execution/submission-preference.js";
import { selectBlockScanProfitEvaluation, type EvEvaluation } from "../ev-evaluator.js";

const observed = (profit: bigint, gas: bigint): EvEvaluation => ({
  valuationAvailable: true, gasMeasurementAvailable: true, feeStateAvailable: true,
  sourceBlockHash: "0x" + "1".repeat(64), ethUsd: null, ethUsdRoundId: null, ethUsdUpdatedAt: null,
  rawProfitEth: profit, expectedProfitEth: profit, gasUnits: 100n, maxBaseFeePerGas: 1n,
  gasCostEth: gas, bidEth: profit * 9900n / 10000n, netEvWei: profit - gas - profit * 9900n / 10000n,
});
const policy = { profitMode: "positive-gross-profit" as const, bribeBps: 9900, bribeAllAboveGas: false };

test("gross mode chooses original post-gas EV economics before gross fallback", () => {
  const selected = selectBlockScanProfitEvaluation(observed(1000n, 100n), policy, 0n);
  assert.equal(selected.profitMode, "positive-ev");
  assert.equal(selected.evaluation.bidEth, 891n);
  assert.equal(selected.evaluation.netEvWei, 9n);
  const fallback = observed(100n, 200n);
  assert.deepEqual(selectBlockScanProfitEvaluation(fallback, policy, 0n), { profitMode: "positive-gross-profit", evaluation: fallback });
  assert.equal(fallback.bidEth, 99n);
  assert.equal(fallback.netEvWei, -199n);
});

test("positive-EV-only mode remains unchanged and minimum-net equality does not pass", () => {
  const loss = observed(100n, 200n);
  assert.deepEqual(selectBlockScanProfitEvaluation(loss, { ...policy, profitMode: "positive-ev" }, 0n),
    { profitMode: "positive-ev", evaluation: loss });
  assert.equal(selectBlockScanProfitEvaluation(observed(1000n, 100n), policy, 9n).profitMode, "positive-gross-profit");
  assert.equal(selectBlockScanProfitEvaluation(observed(100n, 100n), policy, -1n).profitMode, "positive-gross-profit");
  assert.equal(selectBlockScanProfitEvaluation(observed(100n, 200n), policy, -1000n).profitMode, "positive-gross-profit");
});

type Result = { submitted: boolean; submissionAttempted?: boolean; decision: string };
function fixture(control = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000 }) {
  const preference = new SubmissionPreference<Result>(control), sends: string[] = [], settled: string[] = [];
  const entry = (id: string, score: bigint, submits = true): DeferredSubmission<Result> => ({ netEvWei: score,
    async submit() { sends.push(id); return { submitted: submits, decision: id }; },
    discard(reason) { return { submitted: false, decision: id + ":" + reason }; },
  });
  return { preference, sends, settled, entry, record: (_e: DeferredSubmission<Result>, r: Result) => { settled.push(r.decision); } };
}

test("an early gross candidate cannot send before a later preferred submission", async () => {
  const f = fixture(); f.preference.defer(f.entry("gross", -10n));
  await Promise.resolve(); assert.deepEqual(f.sends, []);
  f.preference.notePreferredSubmission();
  await f.preference.flush(f.record);
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.settled, ["gross:preferred_submitted"]);
});

test("without a preferred send, fallback uses highest net EV and never submits weaker alternatives", async () => {
  const f = fixture(); f.preference.defer(f.entry("weaker", -100n)); f.preference.defer(f.entry("best", -1n));
  await f.preference.flush(f.record);
  assert.deepEqual(f.sends, ["best"]);
  assert.deepEqual(f.settled, ["best", "weaker:fallback_superseded"]);
  await assert.rejects(f.preference.flush(f.record), /already settled/);
  assert.throws(() => f.preference.defer(f.entry("late", 0n)), /closed/);
});

test("fallback can try a weaker candidate after a pre-submit rejection; ties are stable", async () => {
  const f = fixture(); f.preference.defer(f.entry("rejected", -1n, false)); f.preference.defer(f.entry("next", -1n));
  await f.preference.flush(f.record); assert.deepEqual(f.sends, ["rejected", "next"]);
});

test("indeterminate fallback submission suppresses a second fallback", async () => {
  const f = fixture();
  f.preference.defer({ ...f.entry("uncertain", 1n), async submit() {
    f.sends.push("uncertain"); return { submitted: false, submissionAttempted: true, decision: "uncertain" };
  } });
  f.preference.defer(f.entry("second", 0n));
  await f.preference.flush(f.record);
  assert.deepEqual(f.sends, ["uncertain"]);
  assert.deepEqual(f.settled, ["uncertain", "second:fallback_superseded"]);
});

test("abort, deadline and an incomplete pass discard fallbacks without a send", async () => {
  for (const reason of ["abort", "deadline", "incomplete"] as const) {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal, deadlineAtMs: reason === "deadline" ? Date.now() - 1 : Date.now() + 5000 });
    f.preference.defer(f.entry("gross", -1n));
    if (reason === "abort") controller.abort(new Error("new head"));
    if (reason === "incomplete") f.preference.cancel(f.record);
    else await assert.rejects(f.preference.flush(f.record), reason === "abort" ? /new head/ : /deadline/);
    assert.deepEqual(f.sends, []); assert.deepEqual(f.settled, ["gross:pass_cancelled"]);
  }
});
