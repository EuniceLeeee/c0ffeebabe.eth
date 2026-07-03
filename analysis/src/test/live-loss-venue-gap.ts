import assert from "node:assert/strict";
import {
  classifyVenueGapsFromFixtures,
  type VenueGapType,
  type VenueIdentityFixture,
} from "../cli/live-loss.js";

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

function abbr(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
