import assert from "node:assert/strict";
import { ethers } from "ethers";
import { runCompetitorScan } from "../competitor-scan.js";
import type { RpcClient } from "../rpc/client.js";

const BLOCK = 25456945;
const POOL = `0x${"a".repeat(40)}`;
const OTHER_POOL_A = `0x${"b".repeat(40)}`;
const OTHER_POOL_B = `0x${"c".repeat(40)}`;
const SOURCE_TO = `0x${"d".repeat(40)}`;
const CANDIDATE_TO = `0x${"e".repeat(40)}`;
const SEED_HASH = `0x${"1".repeat(64)}`;
const UNRESOLVED_MEV_SHARE_HASH = `0x${"2".repeat(64)}`;
const UNRESOLVED_OLD_HASH = `0x${"3".repeat(64)}`;
const CANDIDATE_HASH = `0x${"9".repeat(64)}`;

const TRIPLES = [
  {
    doubleHash: "0xe8c283354c4cf2ca1080447344085c710c0f4ec1e89316572bd0d31f74d16f2f",
    realTxHex: "0x2b3c78ca63a70000000000000000000000000000000000000000000000000000",
    block: BLOCK,
  },
  {
    doubleHash: "0x91c073d166c58934649fc7b28406d774a97fbe3a3f7f6ab82d010ed4ee86dcb0",
    realTxHex: "0xf0da00aced3c262990fe30271729c1e7e74164b4bf23bf3494f48bbb036fdbd2",
    block: BLOCK + 1,
  },
  {
    doubleHash: "0x91f0c30cfdba9280721f7e668408447b5416d46290c616bf5723e2410de3b430",
    realTxHex: "0x4308955f00000000000000000000000000000000000000000000000000000000",
    block: BLOCK + 2,
  },
];

for (const triple of TRIPLES) {
  assert.equal(ethers.keccak256(triple.realTxHex), triple.doubleHash);
}

const receiptByHash = new Map<string, any>([
  [SEED_HASH, receipt(BLOCK, 0, SOURCE_TO, [])],
  [TRIPLES[0].realTxHex, receipt(BLOCK, 3, SOURCE_TO, [{ address: POOL }])],
  [CANDIDATE_HASH, receipt(BLOCK, 4, CANDIDATE_TO, [
    { address: POOL },
    { address: OTHER_POOL_A },
    { address: OTHER_POOL_B },
  ])],
]);

const txsByBlock = new Map<number, string[]>();
for (const triple of TRIPLES) {
  txsByBlock.set(triple.block, [...(txsByBlock.get(triple.block) ?? []), triple.realTxHex]);
}

const receiptCalls: string[] = [];
const blockCalls: number[] = [];
const rpc = {
  getReceipt: async (hash: string) => {
    const key = hash.toLowerCase();
    receiptCalls.push(key);
    return receiptByHash.get(key) ?? null;
  },
  getBlockByNumber: async (blockNumber: number, full = true) => {
    assert.equal(full, true);
    blockCalls.push(blockNumber);
    return { number: quantity(blockNumber), transactions: txsByBlock.get(blockNumber) ?? [] };
  },
  getLogs: async (filter: Record<string, unknown>) => {
    assert.equal(filter.address, POOL);
    assert.equal(filter.fromBlock, quantity(BLOCK));
    assert.equal(filter.toBlock, quantity(BLOCK));
    return [
      { address: POOL, transactionHash: TRIPLES[0].realTxHex, transactionIndex: quantity(3) },
      { address: POOL, transactionHash: CANDIDATE_HASH, transactionIndex: quantity(4) },
    ];
  },
  getCode: async (address: string, blockTag: string) => {
    assert.equal(address, CANDIDATE_TO);
    assert.equal(blockTag, quantity(BLOCK));
    return "0x6000";
  },
} as unknown as RpcClient;

const { output, result: scanResult } = await captureLog(async () =>
  runCompetitorScan({
    eventsPath: "/tmp/offline-doublehash.jsonl",
    events: [
      { type: "opportunity_seen", victim_hash: SEED_HASH },
      {
        type: "pipeline_dropped",
        reason: "plan/no_candidate_plans",
        victim_hash: TRIPLES[0].doubleHash,
        victim_source: "mev-share",
        pool: POOL,
      },
      {
        type: "pipeline_dropped",
        reason: "plan/no_candidate_plans",
        victim_hash: UNRESOLVED_MEV_SHARE_HASH,
        victim_source: "mev-share",
        pool: POOL,
      },
      {
        type: "pipeline_dropped",
        reason: "plan/no_candidate_plans",
        victim_hash: UNRESOLVED_OLD_HASH,
        pool: POOL,
      },
    ],
    rpc,
    concurrency: 2,
  })
);
const results = scanResult.results;
const resolved = results.find((result) => result.index === 1);
const unresolvedMevShare = results.find((result) => result.index === 2);
const unresolvedOld = results.find((result) => result.index === 3);

assert.ok(receiptCalls.includes(TRIPLES[0].doubleHash), "first pass checks the hint hash directly");
assert.ok(
  receiptCalls.includes(TRIPLES[0].realTxHex),
  `second pass resolves to the real tx hash; calls=${receiptCalls.join(",")} output=${output}`,
);
assert.ok(blockCalls.includes(BLOCK), "reverse scan covers the seeded drop-window block");
assert.equal(resolved?.victimHash, TRIPLES[0].realTxHex);
assert.equal(resolved?.victimSource, "mev-share");
assert.equal(resolved?.victimBlock, BLOCK);
assert.equal(resolved?.status, "competitor_took");
assert.equal(unresolvedMevShare?.victimSource, "mev-share");
assert.equal(unresolvedMevShare?.status, "v_not_mined");
assert.equal(unresolvedOld?.victimSource, "unknown");
assert.equal(unresolvedOld?.status, "v_not_mined");
assert.ok(output.includes("| plan/no_candidate_plans | 1 | 0 | 2 |"), output);
assert.ok(output.includes("| mev-share | 1 | 0 | 1 |"), output);
assert.ok(output.includes("| unknown | 0 | 0 | 1 |"), output);
assert.ok(output.includes("victim_source=mev-share"), output);
assert.ok(output.includes(`competitor_tx=${CANDIDATE_HASH}`), output);

console.log("expected_transition: double-hash victim v_not_mined -> resolved competitor_took");
console.log("expected_label: unresolved event victim_source=mev-share stays v_not_mined");
console.log("expected_label: unresolved old event victim_source=unknown stays v_not_mined");
console.log("verdict: fixed");
console.log("PASS competitor-scan-doublehash");

function receipt(block: number, transactionIndex: number, to: string, logs: any[]): any {
  return {
    blockNumber: quantity(block),
    transactionIndex: quantity(transactionIndex),
    gasUsed: "0x5208",
    to,
    logs,
  };
}

function quantity(n: number | bigint): string {
  return `0x${BigInt(n).toString(16)}`;
}

async function captureLog<T>(fn: () => Promise<T>): Promise<{ output: string; result: T }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = original;
  }
}
