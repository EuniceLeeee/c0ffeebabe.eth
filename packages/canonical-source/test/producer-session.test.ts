import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalSource,
  ProducerHeadScheduler,
  CanonicalSourceError,
  type CanonicalHead,
  type CanonicalJournalStorePort,
  type CanonicalSourceView,
  type ProducerGraphViewV1,
} from "../src/index.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;

function head(number: string, digit: string): CanonicalHead {
  return Object.freeze({
    chainId: "1",
    number,
    hash: hash(digit),
    parentHash: hash("0"),
    stateRoot: hash(String((Number(digit) + 1) % 10)),
  });
}

function cutoffView(value: CanonicalHead): CanonicalSourceView {
  return Object.freeze({
    chainId: value.chainId,
    number: value.number,
    hash: value.hash,
    stateRoot: value.stateRoot,
  });
}

class MemoryJournalStore implements CanonicalJournalStorePort {
  #token: string | null = null;
  #bytes: Uint8Array | null = null;

  load() {
    return this.#bytes === null || this.#token === null
      ? null
      : { token: this.#token, bytes: new Uint8Array(this.#bytes) };
  }

  compareAndSwap(expectedToken: string | null, bytes: Uint8Array): string {
    if (expectedToken !== this.#token) throw new Error("memory journal CAS conflict");
    this.#token = this.#token === null ? "1" : String(Number(this.#token) + 1);
    this.#bytes = new Uint8Array(bytes);
    return this.#token;
  }
}

function graph(cutoff: CanonicalSourceView, generationId = "generation-a") {
  const binding = {
    generationId,
    readyRecordHash: hash("1"),
    generationRefreshPolicyHash: hash("2"),
    cutoff,
    definitionCatalogRoot: hash("3"),
    instanceCatalogRoot: hash("4"),
    graphRoot: hash("5"),
    runtimeAuthority: Object.freeze({
      authorityBindingHash: hash("a"),
      implementationCommit: "a".repeat(40),
    }),
    candidatePartitionCommitmentStorageHash: hash("7"),
    nominationClosureRoot: hash("8"),
    nominationClosureStorageHash: hash("9"),
  };
  const edges = Object.freeze([Object.freeze({ edgeId: hash("0") })]);
  const value: ProducerGraphViewV1 & { mutableBinding: typeof binding } = {
    binding,
    edges,
    assertActive() {},
    mutableBinding: binding,
  };
  return value;
}

function sourceFixture(initial: CanonicalHead) {
  let latest = initial;
  const history = new Map([[initial.number, initial]]);
  const provider = {
    async getLatestHeader() {
      return latest;
    },
    async getHeader(number: string) {
      const value = history.get(number);
      return value === undefined
        ? { kind: "unavailable" as const, failureCode: "not-indexed" }
        : { kind: "found" as const, header: value };
    },
  };
  const source = new CanonicalSource(provider, { journalStore: new MemoryJournalStore() });
  return {
    source,
    setLatest(next: CanonicalHead) {
      latest = next;
      history.set(next.number, next);
    },
  };
}

test("producer session uses the current head and pins the ready generation", async () => {
  const cutoff = head("100", "1");
  const current = head("101", "3");
  const fixture = sourceFixture(current);
  const lease = graph(cutoffView(cutoff));
  const observation = await fixture.source.observeCurrentHead();
  const session = await fixture.source.openHeadSession(observation, lease);

  assert.equal(session.source.number, "101");
  assert.equal(session.source.hash, current.hash);
  assert.equal(session.source.parentHash, current.parentHash);
  assert.equal(session.source.stateRoot, current.stateRoot);
  assert.equal(session.source.number === lease.binding.cutoff.number, false);
  assert.equal(session.generationId, "generation-a");
  assert.equal(session.lease, lease);
  await session.assertCurrent();
  await session.close();
  await assert.rejects(
    () => session.assertCurrent(),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "producer-session-closed",
  );
});

test("producer session rejects cloned, foreign, DTO, and stale head observations", async () => {
  const current = head("101", "3");
  const first = sourceFixture(current);
  const second = sourceFixture(current);
  const lease = graph(cutoffView(head("100", "1")));
  const capability = await first.source.observeCurrentHead();

  await assert.rejects(
    () => first.source.openHeadSession({ ...capability } as never, lease),
    /not issued by this source/,
  );
  await assert.rejects(
    () => first.source.openHeadSession(first.source.headObservationReader.read(capability) as never, lease),
    /not issued by this source/,
  );
  await assert.rejects(
    () => second.source.openHeadSession(capability, lease),
    /not issued by this source/,
  );

  await first.source.freezeView();
  await assert.rejects(
    () => first.source.openHeadSession(capability, lease),
    /journal anchor is no longer current/,
  );
});

test("head reorg permanently invalidates the current-source session", async () => {
  const current = head("101", "3");
  const fixture = sourceFixture(current);
  const observation = await fixture.source.observeCurrentHead();
  const session = await fixture.source.openHeadSession(observation, graph(cutoffView(head("100", "1"))));
  fixture.setLatest({ ...current, stateRoot: hash("9") });

  await assert.rejects(
    () => session.assertCurrent(),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "state-root-mismatch",
  );
  await assert.rejects(
    () => session.assertCurrent(),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "state-root-mismatch",
  );
});

test("producer rejects a historical canonical head once a newer latest head exists", async () => {
  const historical = head("100", "1");
  const latest = head("101", "3");
  const fixture = sourceFixture(historical);
  const historicalObservation = await fixture.source.observeCurrentHead();
  fixture.setLatest(latest);

  await assert.rejects(
    () => fixture.source.openHeadSession(historicalObservation, graph(cutoffView(head("99", "7")))),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "number-mismatch",
  );

  const latestObservation = await fixture.source.observeCurrentHead();
  const session = await fixture.source.openHeadSession(latestObservation, graph(cutoffView(historical)));
  fixture.setLatest(head("102", "5"));
  await assert.rejects(
    () => session.assertCurrent(),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "number-mismatch",
  );
});

test("generation and topology mutations fail closed", async () => {
  const current = head("101", "3");
  const fixture = sourceFixture(current);
  const lease = graph(cutoffView(head("100", "1")));
  const session = await fixture.source.openHeadSession(await fixture.source.observeCurrentHead(), lease);
  lease.mutableBinding.graphRoot = hash("0");

  await assert.rejects(
    () => session.assertCurrent(),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "generation-mismatch",
  );
  await assert.rejects(
    () => session.assertCurrent(),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "generation-mismatch",
  );
});

test("producer session rejects a non-projection runtime authority before opening", async () => {
  const current = head("101", "3");
  const fixture = sourceFixture(current);
  const observation = await fixture.source.observeCurrentHead();
  const active = graph(cutoffView(head("100", "1")));
  const advisory = {
    ...active,
    binding: {
      ...active.binding,
      runtimeAuthority: {
        authorityBindingHash: hash("b"),
        implementationCommit: "b".repeat(40),
        runtimeBindingId: hash("c"),
      },
      candidatePartitionCommitmentStorageHash: null,
      nominationClosureStorageHash: null,
    },
  };

  await assert.rejects(
    () => fixture.source.openHeadSession(
      observation,
      advisory as never,
    ),
    /unknown field/,
  );
});

test("nomination closure lineage mutations fail closed", async () => {
  const current = head("101", "3");
  const fixture = sourceFixture(current);
  const lease = graph(cutoffView(head("100", "1")));
  const session = await fixture.source.openHeadSession(await fixture.source.observeCurrentHead(), lease);
  lease.mutableBinding.nominationClosureRoot = hash("0");

  await assert.rejects(
    () => session.assertCurrent(),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "generation-mismatch",
  );
});

test("head scheduler keeps one active and only the latest pending head", async () => {
  const first = head("100", "1");
  const second = head("101", "3");
  const latest = head("102", "5");
  const starts: string[] = [];
  const drops: string[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>(resolve => { releaseFirst = resolve; });
  const scheduler = new ProducerHeadScheduler(
    async (value) => {
      starts.push(value.number);
      if (value.number === first.number) await firstDone;
    },
    undefined,
    drop => drops.push(drop.head.number),
  );

  assert.equal(scheduler.schedule(first, { sourceHeadSeenAtMs: 1, sourceHeadSeenMonotonicMs: 1 }), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(scheduler.schedule(second, { sourceHeadSeenAtMs: 2, sourceHeadSeenMonotonicMs: 2 }), true);
  assert.equal(scheduler.schedule(latest, { sourceHeadSeenAtMs: 3, sourceHeadSeenMonotonicMs: 3 }), true);
  assert.deepEqual(drops, ["101"]);

  releaseFirst();
  for (let attempt = 0; attempt < 20 && starts.length < 2; attempt += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.deepEqual(starts, ["100", "102"]);
  await scheduler.shutdown();
  assert.deepEqual(scheduler.telemetry(), {
    submitted: 3,
    started: 2,
    completed: 2,
    coalesced: 1,
    latestSubmitted: latest,
    active: null,
    pending: null,
  });
});
