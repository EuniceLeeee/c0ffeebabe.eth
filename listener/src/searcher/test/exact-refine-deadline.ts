import assert from "node:assert/strict";
import {
  resolveExactRefineDeadline,
} from "../blockscan-runtime-loop.js";

assert.equal(
  resolveExactRefineDeadline({
    nowMs: 1_000,
    passDeadlineAtMs: 20_000,
    refinementReserveMs: 2_000,
  }),
  5_000,
  "the default exact stage must be hard-capped at four seconds",
);
assert.equal(
  resolveExactRefineDeadline({
    nowMs: 1_000,
    passDeadlineAtMs: 3_500,
    refinementReserveMs: 500,
  }),
  3_000,
  "the outer pass reserve must shorten the exact deadline",
);
assert.equal(
  resolveExactRefineDeadline({
    nowMs: 1_000,
    passDeadlineAtMs: 20_000,
    refinementReserveMs: 2_000,
    hardBudgetMs: 100,
  }),
  2_000,
  "configured exact hard budgets must retain the one-second safety floor",
);
assert.equal(
  resolveExactRefineDeadline({
    nowMs: 1_000,
    passDeadlineAtMs: 900,
    refinementReserveMs: 0,
  }),
  1_000,
  "an expired pass must not receive a fresh exact budget",
);

console.log("exact-refine-deadline PASS (4/4)");
