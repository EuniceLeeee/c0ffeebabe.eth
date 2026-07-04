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
import { ADDR, TOPICS } from "../registry/protocols.js";

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
const V5 = hash(9);
const W5 = hash(10);
const V6 = hash(11);
const W6 = hash(12);

const ALICE = address("a");
const BOB = address("b");
const CAROL = address("c");
const DAN = address("d");
const ERIN = address("e");
const FAY = address("7");
const ATOMIC = address("f");
const EXECUTOR = address("9");
const OUT_OF_ALLOWLIST_TO = address("8");

const POOL_A = address("1");
const POOL_B = address("2");
const POOL_C = address("3");
const POOL_D_OUT_OF_GRAPH = address("4");
const POOL_E = address("5");
const POOL_F = address("6");
const POOL_G = address("7");
const POOL_H = address("8");
const POOL_I = address("a");
const POOL_J = address("b");
const POOL_K = address("c");
const POOL_L = address("d");
const W1_PROFIT_WEI = 400_000_000_000_000n;

test("onchain block scan attributes competed backrun losses per victim", async () => {
  const block = blockFixture([
    tx(V1, 0, ALICE, EXECUTOR, [POOL_D_OUT_OF_GRAPH]),
    tx(W1, 1, BOB, EXECUTOR, [POOL_D_OUT_OF_GRAPH, POOL_A], { wethProfitWei: W1_PROFIT_WEI }),
    tx(V2, 2, CAROL, EXECUTOR, [POOL_C]),
    tx(W2, 3, BOB, EXECUTOR, [POOL_C, POOL_D_OUT_OF_GRAPH]),
    tx(V3, 4, DAN, EXECUTOR, [POOL_E]),
    tx(W3, 5, BOB, EXECUTOR, [POOL_E, POOL_F]),
    tx(V4, 6, ATOMIC, EXECUTOR, [POOL_G]),
    tx(W4, 7, ATOMIC, EXECUTOR, [POOL_G, POOL_H]),
    tx(V5, 8, ERIN, OUT_OF_ALLOWLIST_TO, [POOL_I]),
    tx(W5, 9, BOB, EXECUTOR, [POOL_I, POOL_J]),
    tx(V6, 10, FAY, EXECUTOR, [POOL_K]),
    tx(W6, 11, BOB, EXECUTOR, [POOL_K, POOL_L]),
  ]);
  const graph = graphFixture([
    POOL_A,
    POOL_B,
    POOL_C,
    POOL_E,
    POOL_F,
    POOL_G,
    POOL_H,
    POOL_I,
    POOL_J,
    POOL_K,
    POOL_L,
  ]);
  const funnel = buildFunnelIndex([
    { run_id: "old-run", type: "opportunity_seen", victim_hash: V1, opportunity_id: "old" },
    { run_id: "latest-run", type: "mempool_filter_config", to_addresses: [EXECUTOR] },
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
    ethUsd: 2000,
  });

  const byVictim = new Map(result.cases.map((item) => [item.victim_tx, item]));
  assert.equal(result.competed_backruns, 6);
  assert.equal(byVictim.get(V1)?.primary_gap, "source_not_seen");
  assert.equal(byVictim.get(V1)?.source_not_seen_reason, "pool_not_in_graph");
  assert.equal(byVictim.get(V1)?.winner_profit_wei, W1_PROFIT_WEI.toString());
  assert.equal(byVictim.get(V1)?.winner_profit_usd, 0.8);
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
  assert.equal(byVictim.get(V5)?.primary_gap, "source_not_seen");
  assert.equal(byVictim.get(V5)?.source_not_seen_reason, "to_not_admissible");
  assert.equal(byVictim.get(V6)?.primary_gap, "source_not_seen");
  assert.equal(byVictim.get(V6)?.source_not_seen_reason, "not_received");
  assert.equal(byVictim.get(V6)?.source_not_seen_note, "not_further_separable_without_external_mempool_archive");

  assert.equal(result.summary.source_not_seen, 3);
  assert.equal(result.summary.venue_missing, 1);
  assert.equal(result.summary.outbid, 1);
  assert.equal(result.summary.scan_not_triggered, 1);
  assert.equal(result.source_not_seen_reasons.pool_not_in_graph, 1);
  assert.equal(result.source_not_seen_reasons.to_not_admissible, 1);
  assert.equal(result.source_not_seen_reasons.not_received, 1);
  assert.equal(result.winner_profit_by_primary_gap.source_not_seen?.median_usd, 0.8);
  assert.equal(result.winner_profit_by_primary_gap.source_not_seen?.p90_usd, 0.8);
  assert.equal(result.winner_profit_by_primary_gap.source_not_seen?.dust_share, 1);
  assert.equal(funnel.run_id, "latest-run");

  console.log("[onchain-loss-scan] per-case attribution PASS");
});

type FixtureTx = OnchainScanTx & {
  pools: string[];
  wethProfitWei?: bigint;
};

function blockFixture(items: FixtureTx[]): OnchainScanBlock {
  return {
    number: BLOCK,
    timestamp: 1783094400,
    transactions: items.map(({ pools: _pools, ...item }) => item),
    receipts: items.map((item) => receipt(item)),
  };
}

function tx(
  txHash: string,
  index: number,
  from: string,
  to: string,
  pools: string[],
  opts: { wethProfitWei?: bigint } = {},
): FixtureTx {
  return { hash: txHash, transactionIndex: index, from, to, pools, ...opts };
}

function receipt(item: FixtureTx): OnchainScanReceipt {
  const txHash = item.hash;
  const index = item.transactionIndex ?? 0;
  const from = item.from ?? "";
  const to = item.to ?? null;
  const poolLogs = item.pools.map((pool, logIndex) => ({
    address: pool,
    topics: [TOPICS.univ2Swap],
    data: "0x",
    transactionHash: txHash,
    transactionIndex: quantity(index),
    logIndex: quantity(logIndex),
  }));
  const profitLog = item.wethProfitWei === undefined
    ? []
    : [{
      address: ADDR.WETH,
      topics: [TOPICS.transfer, topicAddress(item.pools[0] ?? from), topicAddress(to ?? from)],
      data: uint256(item.wethProfitWei),
      transactionHash: txHash,
      transactionIndex: quantity(index),
      logIndex: quantity(poolLogs.length),
    }];
  return {
    transactionHash: txHash,
    transactionIndex: quantity(index),
    blockNumber: quantity(BLOCK),
    from,
    to,
    status: "0x1",
    logs: [...poolLogs, ...profitLog],
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

function topicAddress(addr: string): string {
  return `0x${addr.slice(2).padStart(64, "0")}`;
}

function uint256(n: bigint): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}
