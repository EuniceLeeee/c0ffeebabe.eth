import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CheckpointStore,
  PromotionRejectedError,
  installCheckpointSignalHooks,
} from "../src/index.ts";
import { createCanonicalSource, type CanonicalHeader } from "../../canonical-source/src/index.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;

function harness(options: { readonly beforeCommit?: () => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "aloha-checkpoint-"));
  const filename = join(directory, "checkpoint.sqlite");
  const header: CanonicalHeader = { number: "100", hash: hash("1"), stateRoot: hash("2") };
  const source = createCanonicalSource({
    async getLatestHeader() { return header; },
    async getHeader(number) { return number === header.number ? header : null; },
  });
  const durable = createSqliteDurableStore(filename, options);
  const checkpoint = new CheckpointStore(durable, source);
  return {
    directory,
    durable,
    checkpoint,
    source,
    header,
    cleanup() {
      durable.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function candidates() {
  return [
    {
      familyCandidateKey: "candidate-z",
      familyId: "family-a",
      instanceNominationKey: "nomination-z",
      candidateSnapshot: { value: "z" },
    },
    {
      familyCandidateKey: "candidate-a",
      familyId: "family-a",
      instanceNominationKey: "nomination-a",
      candidateSnapshot: { value: "a" },
    },
  ] as const;
}

test("checkpoint persists opaque candidate/outcome keys, periodic flush, and retryable semantics", async () => {
  const h = harness();
  try {
    const run = h.checkpoint.beginNewRun({
      runId: "run-opaque",
      cutoff: h.header,
      candidates: candidates(),
    });
    const writer = h.checkpoint.createOutcomeWriter(run.runId, { flushEveryItems: 2 });
    const loaded = h.checkpoint.loadRun(run.runId);
    const [first, second] = loaded.candidates;
    await writer.enqueue({
      runCandidateKey: first.runCandidateKey,
      status: "retryable",
      stage: "transport",
      attemptCount: "1",
      failureCode: "network",
    });
    await writer.enqueue({
      runCandidateKey: second.runCandidateKey,
      status: "verified",
      stage: "identity",
    });
    await writer.closeAfterAllProducersAndFlush();

    const recovered = h.checkpoint.loadRun(run.runId);
    assert.deepEqual([...recovered.outcomes.keys()].sort(), [first.runCandidateKey, second.runCandidateKey].sort());
    assert.equal(recovered.outcomes.get(first.runCandidateKey)?.terminal, false);
    assert.equal(recovered.outcomes.get(first.runCandidateKey)?.status, "retryable");
    assert.equal(recovered.accounting.retryable, "1");
    assert.equal(recovered.accounting.verified, "1");
    assert.throws(
      () => h.checkpoint.assertExactPartitionAndNoUnresolved(run.runId),
      (error: unknown) => error instanceof PromotionRejectedError,
    );
  } finally {
    h.cleanup();
  }
});

test("partial stage and final outcome are distinct immutable content records", async () => {
  const h = harness();
  try {
    const run = h.checkpoint.beginNewRun({ runId: "run-partial-stage", cutoff: h.header, candidates: [candidates()[0]] });
    const key = h.checkpoint.loadRun(run.runId).candidates[0]!.runCandidateKey;
    const writer = h.checkpoint.createOutcomeWriter(run.runId, { flushEveryItems: 1 });
    await writer.enqueue({ runCandidateKey: key, status: "partial", stage: "identity", payload: { phase: "identity" } });
    await writer.flush();
    const partial = h.checkpoint.loadOutcome(run.runId, key)!;
    await writer.enqueue({ runCandidateKey: key, status: "verified", stage: "projection", payload: { phase: "projection" } });
    await writer.closeAfterAllProducersAndFlush();
    const final = h.checkpoint.loadOutcome(run.runId, key)!;
    assert.notEqual(partial.contentHash, final.contentHash);
    assert.equal(final.terminal, true);
  } finally {
    h.cleanup();
  }
});

test("writer competition is rejected and a partial transaction is invisible after recovery", async () => {
  let failNextCommit = false;
  const h = harness({
    beforeCommit: () => {
      if (failNextCommit) {
        failNextCommit = false;
        throw new Error("simulated crash before WAL commit");
      }
    },
  });
  try {
    const run = h.checkpoint.beginNewRun({ runId: "run-partial", cutoff: h.header, candidates: candidates() });
    const firstWriter = h.checkpoint.createOutcomeWriter(run.runId, { flushEveryItems: 25 });
    assert.throws(
      () => h.checkpoint.createOutcomeWriter(run.runId),
      /writer lease/i,
    );
    const candidate = h.checkpoint.loadRun(run.runId).candidates[0]!;
    await firstWriter.enqueue({ runCandidateKey: candidate.runCandidateKey, status: "verified", stage: "identity" });
    failNextCommit = true;
    await assert.rejects(() => firstWriter.closeAfterAllProducersAndFlush());
    const recovered = h.checkpoint.loadRun(run.runId);
    assert.equal(recovered.outcomes.size, 0);
    assert.equal(recovered.accounting.pending, "2");
  } finally {
    h.cleanup();
  }
});

test("SIGTERM hook only requests stop; close drains and durably flushes", async () => {
  const h = harness();
  try {
    const run = h.checkpoint.beginNewRun({ runId: "run-signal", cutoff: h.header, candidates: [candidates()[0]] });
    const writer = h.checkpoint.createOutcomeWriter(run.runId, { flushEveryItems: 25 });
    const registered = new Map<string, () => void>();
    const hooks = {
      on(signal: "SIGTERM" | "SIGINT", handler: () => void) { registered.set(signal, handler); },
      off(signal: "SIGTERM" | "SIGINT") { registered.delete(signal); },
    };
    const uninstall = installCheckpointSignalHooks(writer, hooks);
    const key = h.checkpoint.loadRun(run.runId).candidates[0]!.runCandidateKey;
    await writer.enqueue({ runCandidateKey: key, status: "verified", stage: "identity" });
    registered.get("SIGTERM")!();
    await writer.closeAfterAllProducersAndFlush();
    assert.equal(h.checkpoint.loadOutcome(run.runId, key)?.status, "verified");
    uninstall();
    assert.equal(registered.size, 0);
  } finally {
    h.cleanup();
  }
});

test("same-height reorg blocks promotion, then exact partition can promote atomically", async () => {
  let current: CanonicalHeader = { number: "100", hash: hash("1"), stateRoot: hash("2") };
  const h = harness();
  try {
    const source = createCanonicalSource({
      async getLatestHeader() { return current; },
      async getHeader(number) { return number === current.number ? current : null; },
    });
    const checkpoint = new CheckpointStore(h.durable, source);
    const run = checkpoint.beginNewRun({ runId: "run-promote", cutoff: current, candidates: [candidates()[0]] });
    const key = checkpoint.loadRun(run.runId).candidates[0]!.runCandidateKey;
    const writer = checkpoint.createOutcomeWriter(run.runId, { flushEveryItems: 1 });
    await writer.enqueue({ runCandidateKey: key, status: "verified", stage: "identity" });
    await writer.closeAfterAllProducersAndFlush();
    current = { number: "100", hash: hash("3"), stateRoot: hash("2") };
    await assert.rejects(
      () => checkpoint.promoteReadyGeneration({
        runId: run.runId,
        canonicalView: run.cutoff,
        generation: generationFor(checkpoint, run),
      }),
      /hash-mismatch/,
    );
    assert.equal(checkpoint.loadRoot().inProgressRunId, run.runId);
    current = { number: "100", hash: hash("1"), stateRoot: hash("2") };
    const generation = await checkpoint.promoteReadyGeneration({
      runId: run.runId,
      canonicalView: run.cutoff,
      generation: generationFor(checkpoint, run),
    });
    assert.equal(generation.promotionRevision, checkpoint.loadRoot().revision);
    assert.equal(checkpoint.loadRoot().inProgressRunId, null);
    assert.equal(checkpoint.loadRoot().readyGenerationId, generation.generationId);
  } finally {
    h.cleanup();
  }
});

test("GC retains active checkpoint reachability while collecting superseded content", async () => {
  const h = harness();
  try {
    const run = h.checkpoint.beginNewRun({ runId: "run-gc", cutoff: h.header, candidates: [candidates()[0]] });
    const key = h.checkpoint.loadRun(run.runId).candidates[0]!.runCandidateKey;
    const writer = h.checkpoint.createOutcomeWriter(run.runId, { flushEveryItems: 1 });
    await writer.enqueue({ runCandidateKey: key, status: "verified", stage: "identity" });
    await writer.closeAfterAllProducersAndFlush();
    const outcome = h.checkpoint.loadOutcome(run.runId, key)!;
    const deleted = h.checkpoint.garbageCollect();
    assert.equal(h.checkpoint.loadOutcome(run.runId, key)?.contentHash, outcome.contentHash);
    assert.ok(deleted.length > 0);
  } finally {
    h.cleanup();
  }
});

function generationFor(checkpoint: CheckpointStore, run: { readonly runId: string; readonly cutoff: CanonicalHeader }) {
  const loaded = checkpoint.loadRun(run.runId);
  const root = checkpoint.loadRoot();
  const makeRoot = (label: string) => checkpoint.putImmutableContent(
    `test/${label}`,
    new TextEncoder().encode(JSON.stringify({ label })),
  );
  return {
    generationId: "generation-1",
    parentGenerationId: null,
    generationRefreshPolicyHash: hash("4"),
    cutoff: loaded.cutoff,
    recentObservationRange: loaded.recentObservationRange,
    definitionCatalogRoot: loaded.definitionCatalogRoot,
    sourceCoverageRoot: loaded.sourceCoverageRoot,
    candidatePartitionRoot: loaded.candidatePartitionRoot,
    verifiedMemoSetRoot: root.verifiedMemoRoot,
    instanceCatalogRoot: makeRoot("instance-catalog"),
    graphRoot: makeRoot("graph"),
    edgeCount: "0",
    instanceCount: "1",
    promotedAtMonotonicNs: "1",
  } as const;
}
