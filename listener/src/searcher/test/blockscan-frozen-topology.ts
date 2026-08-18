import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bindFrozenTopologyToHeader,
  type BlockScanFrozenTopologyDependencies,
} from "../blockscan-runtime-loop.js";

const topology: BlockScanFrozenTopologyDependencies = Object.freeze({
  topologyKey: `strict-ready:7:0x${"ab".repeat(32)}`,
  async observeHeader(blockNumber: number) {
    return Object.freeze({
      number: blockNumber,
      hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      parentHash: `0x${Math.max(0, blockNumber - 1).toString(16).padStart(64, "0")}`,
    });
  },
});

assert.equal("lane" in topology, false);
assert.equal("prepare" in topology, false);
assert.equal("publish" in topology, false);
assert.equal("scheduleBackfill" in topology, false);

const header = await topology.observeHeader(101);
const captured = bindFrozenTopologyToHeader(topology, header);
assert.deepEqual(captured, {
  dexComplete: true,
  protocolComplete: true,
  sourceBlockHash: header.hash,
});
assert.equal(Object.isFrozen(captured), true);
assert.throws(
  () => bindFrozenTopologyToHeader(
    { ...topology, topologyKey: "" },
    header,
  ),
  /frozen topology key is empty/,
);

const runtimeLoopSource = readFileSync(
  new URL("../blockscan-runtime-loop.ts", import.meta.url),
  "utf8",
);
for (const forbidden of [
  "BlockScanDiscoveryDependencies",
  "readonly discovery?",
  "scheduleBackfill",
  "LiveDiscoveryPublicationState",
  "runtime-pool-refresh",
] as const) {
  assert.equal(
    runtimeLoopSource.includes(forbidden),
    false,
    `strict producer loop retained mutable topology authority: ${forbidden}`,
  );
}

console.log("blockscan frozen topology contract: PASS");
