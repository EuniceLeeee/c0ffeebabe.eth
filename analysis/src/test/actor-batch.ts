import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { partitionPriorMoversByActor } from "../cli/bundle-postmortem.js";
import { buildCensusReport, type CensusPerTx } from "../cli/census-report.js";
import { classifyTxShape, type RawLog } from "../pnl/tx-shape.js";

interface BlockFixture {
  block: number;
  builderHint: string;
  feeRecipient: string;
  actor: string;
  executor: string;
  selector: string;
  transactions: Array<{
    hash: string;
    nonce: number;
    transactionIndex: number;
    to: string;
    selector: string;
  }>;
  swapLogs: RawLog[];
}

const fixture = JSON.parse(readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "coffee-block-25514736.json",
), "utf8")) as BlockFixture;

test("block 25514736 pins the 16-tx top-of-block actor batch without inventing one synthetic tx", () => {
  const perTx: CensusPerTx[] = fixture.transactions.map((tx) => ({
    hash: tx.hash,
    from: fixture.actor,
    blockNumber: fixture.block,
    nonce: tx.nonce,
    to: tx.to,
    selector: tx.selector,
    blockBuilderHint: fixture.builderHint,
    blockFeeRecipient: fixture.feeRecipient,
    realizedUsd: 0,
    touchedVenues: [],
    txIndex: tx.transactionIndex,
    receiptLogs: fixture.swapLogs.filter((log) => log.transactionHash === tx.hash),
    sameBlockSwapLogs: fixture.swapLogs,
    winner_style: tx.transactionIndex <= 15 ? "atomic_loop" : undefined,
  }));

  // This is the original failure mode: tx #1 reuses a pool touched by tx #0,
  // so an actor-blind classifier attributes Coffee's own earlier tx as a
  // backrun source.
  const actorBlind = classifyTxShape({
    receiptLogs: perTx[1]!.receiptLogs!,
    txIndex: 1,
    sameBlockSwapLogs: fixture.swapLogs,
  });
  assert.equal(actorBlind.shape, "backrun");
  assert.equal(actorBlind.source_swap_hash, fixture.transactions[0]!.hash);
  const postmortemPrior = partitionPriorMoversByActor([{
    txHash: fixture.transactions[0]!.hash,
    transactionIndex: 0,
    emitter: "0xe0554a476a092703abdb3ef35c80e0d76d32939f",
  }], new Map([[fixture.transactions[0]!.hash, fixture.actor]]), fixture.actor);
  assert.deepEqual(postmortemPrior.external, []);
  assert.deepEqual(postmortemPrior.sameActor.map((mover) => mover.txHash), [fixture.transactions[0]!.hash]);

  const report = buildCensusReport(perTx, 0.1, { from: fixture.block, to: fixture.block }, [fixture.actor]);
  assert.equal(report.actor_batches.length, 1);
  assert.equal(report.summary.actor_batch_candidates, 1);
  assert.equal(report.summary.top_of_block_actor_batches, 1);
  assert.equal(report.summary.max_actor_batch_txs, 16);
  const batch = report.actor_batches[0]!;
  assert.equal(batch.classification, "actor_batch_candidate");
  assert.equal(batch.tx_count, 16);
  assert.deepEqual(batch.transaction_indices, Array.from({ length: 16 }, (_, i) => i));
  assert.deepEqual(batch.nonces, Array.from({ length: 16 }, (_, i) => 189585 + i));
  assert.equal(batch.transaction_indices_contiguous, true);
  assert.equal(batch.nonces_contiguous, true);
  assert.equal(batch.top_of_block, true);
  assert.equal(batch.top_of_block_run_length, 16);
  assert.equal(batch.longest_contiguous_run_length, 16);
  assert.equal(batch.block_builder_hint, fixture.builderHint);
  assert.equal(batch.block_fee_recipient, fixture.feeRecipient);
  assert.deepEqual(batch.tx_shape_counts, {
    atomic_state_arb: 16,
    backrun: 0,
    unknown: 0,
  });
  assert.deepEqual(
    batch.shared_pools.find((pool) => pool.pool_id === "0xe0554a476a092703abdb3ef35c80e0d76d32939f"),
    {
      pool_id: "0xe0554a476a092703abdb3ef35c80e0d76d32939f",
      tx_count: 9,
    },
  );

  const tx1 = report.matched_competitors.find((tx) => tx.transaction_index === 1)!;
  assert.equal(tx1.tx_shape, "atomic_state_arb");
  assert.equal(tx1.source_swap_hash, undefined);
  assert.deepEqual(tx1.same_actor_prior_swap_hashes, [fixture.transactions[0]!.hash]);
  assert.equal(tx1.actor_batch_position, 2);
  assert.equal(tx1.actor_batch_size, 16);

  const selfTransfer = report.matched_competitors.find((tx) => tx.transaction_index === 16)!;
  assert.equal(selfTransfer.tx_shape, "unknown");
  assert.equal(selfTransfer.actor_batch_id, undefined);
});

test("an external same-pool swap remains a backrun source inside actor batch context", () => {
  const actorPriorHash = repeatedHash("a");
  const externalEarlierHash = repeatedHash("d");
  const externalNearestHash = repeatedHash("e");
  const currentHash = repeatedHash("f");
  const sharedPoolLog = fixture.swapLogs.find(
    (log) => log.address === "0xe0554a476a092703abdb3ef35c80e0d76d32939f",
  )!;
  const actorPrior = withTx(sharedPoolLog, 0, 0, actorPriorHash, fixture.executor);
  const externalEarlier = withTx(sharedPoolLog, 1, 1, externalEarlierHash, repeatedAddress("1"));
  const externalNearest = withTx(sharedPoolLog, 2, 2, externalNearestHash, repeatedAddress("2"));
  const current = withTx(sharedPoolLog, 3, 3, currentHash, fixture.executor);

  const result = classifyTxShape({
    receiptLogs: [current],
    txIndex: 3,
    sameBlockSwapLogs: [actorPrior, externalEarlier, externalNearest, current],
    sameActorTxHashes: [actorPriorHash, currentHash],
  });

  assert.equal(result.shape, "backrun");
  assert.equal(result.source_swap_hash, externalNearestHash);
  assert.equal(result.source_router, repeatedAddress("2"));
  assert.deepEqual(result.same_actor_prior_swap_hashes, [actorPriorHash]);
});

test("non-contiguous repeated calls are split into maximal actor runs", () => {
  const indices = [0, 1, 5, 6];
  const profits = [1, 2, 100, 200];
  const perTx: CensusPerTx[] = indices.map((transactionIndex, index) => ({
    hash: repeatedHash(String(index + 1)),
    from: fixture.actor,
    blockNumber: fixture.block,
    nonce: 50 + index,
    to: fixture.executor,
    selector: fixture.selector,
    realizedUsd: profits[index]!,
    touchedVenues: [],
    txIndex: transactionIndex,
    receiptLogs: [],
    sameBlockSwapLogs: [],
  }));

  const report = buildCensusReport(perTx, 0.1, { from: fixture.block, to: fixture.block }, [fixture.actor]);
  assert.equal(report.actor_batches.length, 2);
  assert.deepEqual(report.actor_batches.map((batch) => batch.transaction_indices), [[0, 1], [5, 6]]);
  assert.deepEqual(
    report.actor_batches.map((batch) => batch.realized_profit_usd.complete_sum),
    [3, 300],
  );
  assert.equal(report.summary.top_of_block_actor_batches, 1);
  assert.notEqual(
    report.matched_competitors[0]!.actor_batch_id,
    report.matched_competitors[2]!.actor_batch_id,
  );

  const nonceGap = perTx.slice(0, 2).map((tx, index) => ({
    ...tx,
    txIndex: index,
    nonce: index === 0 ? 70 : 72,
  }));
  const nonceGapReport = buildCensusReport(
    nonceGap,
    0.1,
    { from: fixture.block, to: fixture.block },
    [fixture.actor],
  );
  assert.equal(nonceGapReport.actor_batches.length, 0);
});

function withTx(
  log: RawLog,
  transactionIndex: number,
  logIndex: number,
  transactionHash: string,
  txTo: string,
): RawLog {
  return { ...log, transactionIndex, logIndex, transactionHash, txTo };
}

function repeatedHash(char: string): string {
  return `0x${char.repeat(64)}`;
}

function repeatedAddress(char: string): string {
  return `0x${char.repeat(40)}`;
}
