import assert from "node:assert/strict";
import {
  assertExactProbeProducerAvailable,
  ExactProbeProducerBusyError,
  exactProducerYieldShouldWait,
  resolveExactRefineDeadline,
} from "../blockscan-runtime-loop.js";

assert.equal(
  exactProducerYieldShouldWait({ producerCriticalActive: true, producerLagBlocks: 0 }),
  true,
  "exact must yield while the producer generation is in progress",
);
assert.equal(
  exactProducerYieldShouldWait({ producerCriticalActive: true, producerLagBlocks: 5 }),
  true,
);
assert.equal(
  exactProducerYieldShouldWait({ producerCriticalActive: false, producerLagBlocks: 2 }),
  true,
  "the lag>=2 fallback must keep yielding when the producer is clearly behind",
);
assert.equal(
  exactProducerYieldShouldWait({ producerCriticalActive: false, producerLagBlocks: 1 }),
  false,
  "an idle producer at lag 1 must not block exact (the N-1/N stampede starts at the active generation, not at idle lag)",
);
assert.equal(
  exactProducerYieldShouldWait({ producerCriticalActive: false, producerLagBlocks: 0 }),
  false,
);

assert.throws(
  () => assertExactProbeProducerAvailable({
    producerCriticalActive: true,
    producerLagBlocks: 0,
  }),
  ExactProbeProducerBusyError,
  "an exact batch must be skipped when the producer stays critical after yielding",
);
assert.throws(
  () => assertExactProbeProducerAvailable({
    producerCriticalActive: false,
    producerLagBlocks: 2,
  }),
  ExactProbeProducerBusyError,
  "an exact batch must be skipped while the producer remains materially behind",
);
assert.doesNotThrow(() => assertExactProbeProducerAvailable({
  producerCriticalActive: false,
  producerLagBlocks: 1,
}));

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

console.log("exact-producer-yield PASS (12/12)");
