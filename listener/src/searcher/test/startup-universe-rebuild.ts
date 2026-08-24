import assert from "node:assert/strict";
import {
  observationScanFromWithBaseline,
  resolveProducerBaseline,
} from "../startup-universe-rebuild.js";
import type { ReadyUniverseGeneration } from "../universe-rebuild-checkpoint.js";

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});

function ready(): ReadyUniverseGeneration {
  return Object.freeze({
    generation: 1,
    cutoff: SOURCE,
    universeRange: Object.freeze({
      fromBlock: SOURCE.number - 14_399,
      toBlock: SOURCE.number,
    }),
    universeHash: "u",
    catalogHash: "c",
    activeInstanceKeys: Object.freeze(["inst:a", "inst:b"]),
    publicationSetHash: "p",
    candidateAccounting: Object.freeze({
      total: 2,
      verified: 2,
      terminalRejected: 0,
      retryable: 0,
      remainingUnaccounted: 0 as const,
    }),
    observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    sourceCoverage: Object.freeze([]),
    graphSnapshot: Object.freeze({}),
    graphHash: "g",
    catalogSnapshot: Object.freeze({ instances: Object.freeze([]) }),
  }) as ReadyUniverseGeneration;
}

async function main(): Promise<void> {
  // Baseline resolution.
  const atHead = resolveProducerBaseline({ ready: ready(), currentHead: SOURCE.number });
  assert.equal(atHead.currentAtHead, true);
  assert.equal(atHead.observationScanFrom, SOURCE.number);
  assert.deepEqual([...atHead.activeInstanceKeys].sort(), ["inst:a", "inst:b"]);
  const behind = resolveProducerBaseline({
    ready: ready(),
    currentHead: SOURCE.number + 100,
  });
  assert.equal(behind.currentAtHead, false, "head moved past the ready cutoff");

  // Producer freeze: the observed-event scan never starts before the ready
  // cutoff (the ready run already covered the window).
  assert.equal(
    observationScanFromWithBaseline({
      baseline: atHead,
      defaultScanFrom: SOURCE.number - 14_399,
      universeWindowFrom: SOURCE.number - 14_399,
    }),
    SOURCE.number,
    "the historical window is not re-scanned after ready",
  );
  // Without a baseline the window still applies (universe from..to).
  assert.equal(
    observationScanFromWithBaseline({
      baseline: null,
      defaultScanFrom: SOURCE.number,
      universeWindowFrom: SOURCE.number - 14_399,
    }),
    SOURCE.number - 14_399,
    "no baseline: the universe window bound applies",
  );
  // The incremental default is never pushed before the ready cutoff.
  assert.equal(
    observationScanFromWithBaseline({
      baseline: behind,
      defaultScanFrom: SOURCE.number - 1_000,
      universeWindowFrom: SOURCE.number - 14_399,
    }),
    Math.max(SOURCE.number - 1_000, SOURCE.number),
    "incremental default stays at or after the ready cutoff",
  );

  console.log("universe rebuild startup baseline PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
