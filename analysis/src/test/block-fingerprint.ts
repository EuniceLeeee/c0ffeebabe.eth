import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBlockFingerprint,
  buildCensusReport,
  renderBlockFingerprint,
} from "../cli/census-report.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const COINBASE = "0xdddddddddddddddddddddddddddddddddddddddd";

test("raw block fingerprint keeps top, sparse, singleton, and failed watch matches visible", () => {
  const block = {
    miner: COINBASE.toUpperCase().replace("0X", "0x"),
    extraData: `0x${Buffer.from("builder.test", "utf8").toString("hex")}`,
  };
  const matches = [
    tx(A, 0),
    tx(A, 1),
    tx(A, 2),
    tx(C, 3),
    tx(B, 4),
    // A failed tx is still raw sender activity; buildBlockFingerprint runs
    // before receipt filtering and does not inspect status.
    { ...tx(B, 6), receiptStatus: "0x0" },
  ];

  const fingerprint = buildBlockFingerprint(123, block, matches);

  assert.equal(fingerprint.builder_hint, "builder.test");
  assert.equal(fingerprint.coinbase, COINBASE);
  assert.equal(fingerprint.matched_tx_count, 6);
  assert.deepEqual(fingerprint.per_sender, [
    {
      from: A,
      tx_count: 3,
      min_index: 0,
      max_index: 2,
      consecutive: true,
      top_of_block: true,
    },
    {
      from: C,
      tx_count: 1,
      min_index: 3,
      max_index: 3,
      consecutive: true,
      top_of_block: false,
    },
    {
      from: B,
      tx_count: 2,
      min_index: 4,
      max_index: 6,
      consecutive: false,
      top_of_block: false,
    },
  ]);

  assert.equal(
    renderBlockFingerprint(fingerprint),
    "block 123 builder=builder.test 0xaaaaaaaa…: 3 txs idx 0-2 TOP-OF-BLOCK | "
      + "0xcccccccc…: 1 txs idx 3-3 consecutive | 0xbbbbbbbb…: 2 txs idx 4-6 spread",
  );

  const report = buildCensusReport([], 0.1, { from: 123, to: 123 }, [A, B, C], [fingerprint]);
  assert.deepEqual(report.summary.block_fingerprints, [fingerprint]);
});

test("a single watched tx at index zero is raw top-of-block activity, not a claimed bundle", () => {
  const fingerprint = buildBlockFingerprint(124, { miner: COINBASE, extraData: "0x" }, [tx(A, 0)]);
  assert.equal(fingerprint.per_sender[0]?.top_of_block, true);
  assert.equal(fingerprint.per_sender[0]?.tx_count, 1);
});

function tx(from: string, index: number): Record<string, unknown> {
  return {
    hash: `0x${String(index + 1).padStart(64, "0")}`,
    from,
    to: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    transactionIndex: `0x${index.toString(16)}`,
  };
}
