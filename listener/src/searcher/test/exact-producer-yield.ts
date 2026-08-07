import assert from "node:assert/strict";
import { exactProducerYieldShouldWait } from "../blockscan-runtime-loop.js";

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

console.log("exact-producer-yield PASS");
