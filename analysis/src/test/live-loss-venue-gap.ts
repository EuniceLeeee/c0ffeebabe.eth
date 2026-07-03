import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { chdir, cwd } from "node:process";
import {
  classifyVenueGapsFromFixtures,
  classifyVenueGapsFromLogFixtures,
  defaultGraphPoolsPath,
  readActiveV4PoolIds,
  readRoutingGraphPools,
  type VenueGapType,
  type VenueIdentityFixture,
} from "../cli/live-loss.js";
import { ADDR, TOPICS } from "../registry/protocols.js";

// Real on-chain addresses from tx 0x4db34b5c…d4b606 (block 25448858), factories resolved via factory() on the node.
const pools: VenueIdentityFixture[] = [
  { address: "0xdf140bcb286571afb923ae3fc1b81d796fe3a357", venue: "rigelswap", factory: "0x880AE0A0aF8FF8f31F51599891baa8A65dB5e152" },
  { address: "0xf3a4b8efe3e3049f6bc71b47ccb7ce6665420179", venue: "smardex", factory: "0x7753F36E711B66a0350a753aba9F5651BAE76A1D" },
  { address: "0xae26dd8a376baf03304e6877e3692044f4c597e4", venue: "smardex", factory: "0xB878DC600550367e14220d4916Ff678fB284214F" },
  { address: "0x4d54abd78590bf94c8406d019aff724dab659a84", venue: "enzyme" },
  { address: "0x1791bbfa950f7db0b52ecb0729584bad886665f5", venue: "ousd" },
  { address: "0x6d18e1a7faeb1f0467a77c0d293872ab685426dc", venue: "ousd" },
  { address: "0x9a772018fbd77fcd2d25657e5c547baff3fd7d16", venue: "univ3", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
  { address: "0x0de0fa91b6dbab8c8503aaa2d1dfa91a192cb149", venue: "univ2", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" },
  { address: "0xc034dc1816707ae1616bb5a848652aae7495bf0d", venue: "difx", factory: "0xe5aaA01C4732d6B20cBb8522803f84a2cDf96334" },
];

const graphPools = new Set([
  "0x9a772018fbd77fcd2d25657e5c547baff3fd7d16",
  "0x0de0fa91b6dbab8c8503aaa2d1dfa91a192cb149",
]);

const expected = new Map<string, VenueGapType>([
  ["0x9a772018fbd77fcd2d25657e5c547baff3fd7d16", "detection_gap"],
  ["0x0de0fa91b6dbab8c8503aaa2d1dfa91a192cb149", "detection_gap"],
  ["0xdf140bcb286571afb923ae3fc1b81d796fe3a357", "venue_class_gap"],
  ["0xf3a4b8efe3e3049f6bc71b47ccb7ce6665420179", "venue_class_gap"],
  ["0xae26dd8a376baf03304e6877e3692044f4c597e4", "venue_class_gap"],
  ["0xc034dc1816707ae1616bb5a848652aae7495bf0d", "venue_class_gap"],
  ["0x1791bbfa950f7db0b52ecb0729584bad886665f5", "venue_class_gap"],
  ["0x6d18e1a7faeb1f0467a77c0d293872ab685426dc", "venue_class_gap"],
  ["0x4d54abd78590bf94c8406d019aff724dab659a84", "venue_class_gap"],
]);

const gaps = classifyVenueGapsFromFixtures(pools, graphPools);
assert.equal(gaps.length, 9);

for (const gap of gaps) {
  assert.equal(gap.gap_type, expected.get(gap.pool), `${gap.pool} classified as ${gap.gap_type}`);
}

assert.deepEqual(
  new Map(gaps.map((gap) => [gap.pool, gap.gap_type])),
  expected,
);

for (const gap of gaps) {
  console.log(`${abbr(gap.pool)} ${gap.venue} -> ${gap.gap_type}`);
}
console.log("expected_transition: binary {graph_gap|detection_gap} -> precise 5-way matching the hand-trace");

const trackedV4PoolId = `0x${"a".repeat(64)}`;
const untrackedV4PoolId = `0x${"b".repeat(64)}`;
const manager = ADDR.UNIV4_POOL_MANAGER.toLowerCase();
const graphPoolsWithManager = new Set([manager]);
const v4PoolIds = new Set([trackedV4PoolId]);

const trackedV4Gaps = classifyVenueGapsFromLogFixtures(
  [v4SwapLog(trackedV4PoolId)],
  graphPoolsWithManager,
  v4PoolIds,
);
assert.equal(trackedV4Gaps.length, 1);
assert.equal(trackedV4Gaps[0].pool, trackedV4PoolId);
assert.equal(trackedV4Gaps[0].venue, "univ4");
assert.equal(trackedV4Gaps[0].gap_type, "detection_gap");
assert.equal(trackedV4Gaps[0].pool_in_routing_graph, true);
assert.equal(trackedV4Gaps.some((gap) => gap.pool === manager), false);

const untrackedV4Gaps = classifyVenueGapsFromLogFixtures(
  [v4SwapLog(untrackedV4PoolId)],
  graphPoolsWithManager,
  v4PoolIds,
);
assert.equal(untrackedV4Gaps.length, 1);
assert.equal(untrackedV4Gaps[0].pool, untrackedV4PoolId);
assert.equal(untrackedV4Gaps[0].venue, "univ4");
assert.equal(untrackedV4Gaps[0].gap_type, "pool_gap");
assert.equal(untrackedV4Gaps[0].pool_in_routing_graph, false);
assert.equal(untrackedV4Gaps.some((gap) => gap.pool === manager), false);

const activePoolsPath = resolve(tmpdir(), `live-loss-active-pools-${process.pid}.json`);
try {
  const alternateV4PoolId = `0x${"c".repeat(64)}`;
  writeFileSync(activePoolsPath, JSON.stringify({
    pools: [
      { address: manager, adapter: "univ4", poolId: trackedV4PoolId },
      { address: manager, adapter: "univ4-hooked", poolId: alternateV4PoolId },
      { address: "0x1111111111111111111111111111111111111111", adapter: "univ3", poolId: untrackedV4PoolId },
    ],
  }));
  const loadedV4PoolIds = readActiveV4PoolIds(activePoolsPath);
  assert.deepEqual(loadedV4PoolIds, new Set([trackedV4PoolId, alternateV4PoolId]));
} finally {
  rmSync(activePoolsPath, { force: true });
}

assertDefaultGraphLoaderFromAnalysisCwd();

console.log(`${poolId8(trackedV4Gaps[0].pool)} ${trackedV4Gaps[0].venue} -> ${trackedV4Gaps[0].gap_type}`);
console.log(`${poolId8(untrackedV4Gaps[0].pool)} ${untrackedV4Gaps[0].venue} -> ${untrackedV4Gaps[0].gap_type}`);
console.log("default_graph_loader_from_analysis_cwd=pass");
console.log("expected_transition: v4 manager-address membership -> v4 poolId membership");

function abbr(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function poolId8(poolId: string): string {
  return `${poolId.slice(0, 10)}...${poolId.slice(-4)}`;
}

function v4SwapLog(poolId: string): any {
  return {
    address: ADDR.UNIV4_POOL_MANAGER,
    topics: [TOPICS.univ4Swap, poolId],
  };
}

function assertDefaultGraphLoaderFromAnalysisCwd(): void {
  const graphPath = defaultGraphPoolsPath();
  const repoRoot = resolve(dirname(graphPath), "../../..");
  const graphAddress = "0x2222222222222222222222222222222222222222";
  const originalCwd = cwd();
  const hadGraph = existsSync(graphPath);

  if (!hadGraph) {
    mkdirSync(dirname(graphPath), { recursive: true });
    writeFileSync(graphPath, JSON.stringify({ pools: [{ address: graphAddress }] }));
  }

  try {
    chdir(resolve(repoRoot, "analysis"));
    const loaded = readRoutingGraphPools();
    assert.notEqual(loaded, null);
    if (!hadGraph) assert.equal(loaded?.has(graphAddress), true);
  } finally {
    chdir(originalCwd);
    if (!hadGraph) rmSync(graphPath, { force: true });
  }
}
