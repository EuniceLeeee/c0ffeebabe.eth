import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFunnelIndex,
  scanOnchainLosses,
  type OnchainScanBlock,
  type OnchainScanReceipt,
  type OnchainScanTx,
} from "../cli/onchain-loss-scan.js";
import type { GraphMembership } from "../cli/bundle-postmortem.js";
import { TOPICS } from "../registry/protocols.js";

const BLOCK = 300;
const FIXED_TIME = "2026-07-04T00:00:00.000Z";

const V1 = hash(1);
const W1 = hash(2);
const V2 = hash(3);
const W2 = hash(4);
const V3 = hash(5);
const W3 = hash(6);
const V4 = hash(7);
const W4 = hash(8);

const ALICE = address("a");
const BOB = address("b");
const CAROL = address("c");
const DAN = address("d");
const ATOMIC = address("f");
const EXECUTOR = address("9");

const POOL_A = address("1");
const POOL_B = address("2");
const POOL_C = address("3");
const POOL_D_OUT_OF_GRAPH = address("4");
const POOL_E = address("5");
const POOL_F = address("6");
const POOL_G = address("7");
const POOL_H = address("8");

test("onchain block scan attributes competed backrun losses per victim", async () => {
  const block = blockFixture([
    tx(V1, 0, ALICE, EXECUTOR, [POOL_A]),
    tx(W1, 1, BOB, EXECUTOR, [POOL_A, POOL_B]),
    tx(V2, 2, CAROL, EXECUTOR, [POOL_C]),
    tx(W2, 3, BOB, EXECUTOR, [POOL_C, POOL_D_OUT_OF_GRAPH]),
    tx(V3, 4, DAN, EXECUTOR, [POOL_E]),
    tx(W3, 5, BOB, EXECUTOR, [POOL_E, POOL_F]),
    tx(V4, 6, ATOMIC, EXECUTOR, [POOL_G]),
    tx(W4, 7, ATOMIC, EXECUTOR, [POOL_G, POOL_H]),
  ]);
  const graph = graphFixture([
    POOL_A,
    POOL_B,
    POOL_C,
    POOL_E,
    POOL_F,
    POOL_G,
    POOL_H,
  ]);
  const funnel = buildFunnelIndex([
    { run_id: "old-run", type: "opportunity_seen", victim_hash: V1, opportunity_id: "old" },
    { run_id: "latest-run", type: "opportunity_seen", victim_hash: V2, opportunity_id: "opp-v2" },
    {
      run_id: "latest-run",
      type: "pipeline_dropped",
      victim_hash: V2,
      opportunity_id: "opp-v2",
      stage: "solver",
      reason: "no-profitable-quote",
    },
    { run_id: "latest-run", type: "opportunity_seen", victim_hash: V3, opportunity_id: "opp-v3" },
    {
      run_id: "latest-run",
      type: "bundle_submitted",
      victim_hash: V3,
      opportunity_id: "opp-v3",
      bid: "1000",
    },
  ]);

  const result = await scanOnchainLosses({
    fromBlock: BLOCK,
    toBlock: BLOCK,
    fetchBlock: async () => block,
    funnel,
    graph,
    now: () => FIXED_TIME,
  });

  const byVictim = new Map(result.cases.map((item) => [item.victim_tx, item]));
  assert.equal(result.competed_backruns, 4);
  assert.equal(byVictim.get(V1)?.primary_gap, "source_not_seen");
  assert.equal(byVictim.get(V1)?.learning_case.trigger, "competitor_not_seen");
  assert.equal(byVictim.get(V1)?.learning_case.source_block, BLOCK - 1);
  assert.equal(byVictim.get(V1)?.learning_case.target_block, BLOCK);
  assert.deepEqual(byVictim.get(V1)?.learning_case.edge_kinds, ["swap"]);
  assert.equal(byVictim.get(V2)?.primary_gap, "venue_missing");
  assert.deepEqual(byVictim.get(V2)?.missing_venues.map((venue) => venue.id), [POOL_D_OUT_OF_GRAPH]);
  assert.equal(byVictim.get(V3)?.primary_gap, "outbid");
  assert.equal(byVictim.get(V4)?.primary_gap, "scan_not_triggered");
  assert.equal(byVictim.get(V4)?.comparable, false);
  assert.equal(byVictim.get(V4)?.learning_case.strategy_kind, "unknown");
  assert.equal(byVictim.get(V4)?.learning_case.status, "manual_required");

  assert.equal(result.summary.source_not_seen, 1);
  assert.equal(result.summary.venue_missing, 1);
  assert.equal(result.summary.outbid, 1);
  assert.equal(result.summary.scan_not_triggered, 1);
  assert.equal(funnel.run_id, "latest-run");

  console.log("[onchain-loss-scan] per-case attribution PASS");
});

function blockFixture(items: Array<OnchainScanTx & { pools: string[] }>): OnchainScanBlock {
  return {
    number: BLOCK,
    timestamp: 1783094400,
    transactions: items.map(({ pools: _pools, ...item }) => item),
    receipts: items.map((item) => receipt(item.hash, item.transactionIndex ?? 0, item.from ?? "", item.to ?? null, item.pools)),
  };
}

function tx(
  txHash: string,
  index: number,
  from: string,
  to: string,
  pools: string[],
): OnchainScanTx & { pools: string[] } {
  return { hash: txHash, transactionIndex: index, from, to, pools };
}

function receipt(
  txHash: string,
  index: number,
  from: string,
  to: string | null,
  pools: string[],
): OnchainScanReceipt {
  return {
    transactionHash: txHash,
    transactionIndex: quantity(index),
    blockNumber: quantity(BLOCK),
    from,
    to,
    status: "0x1",
    logs: pools.map((pool, logIndex) => ({
      address: pool,
      topics: [TOPICS.univ2Swap],
      data: "0x",
      transactionHash: txHash,
      transactionIndex: quantity(index),
      logIndex: quantity(logIndex),
    })),
  };
}

function graphFixture(members: string[]): GraphMembership {
  return {
    status: "loaded",
    path: "fixture-runtime-graph-pools.json",
    entries: members.length,
    members: new Set(members.map((item) => item.toLowerCase())),
  };
}

function hash(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function address(char: string): string {
  return `0x${char.repeat(40)}`.toLowerCase();
}

function quantity(n: number): string {
  return `0x${BigInt(n).toString(16)}`;
}
