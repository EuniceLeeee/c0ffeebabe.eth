import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
} from "../../canonical-codec/src/index.ts";
import {
  CanonicalSource,
  CanonicalSourceError,
  SQLiteCanonicalJournalStore,
  type CanonicalHeader,
  type CanonicalHeadObservationReaderPortV1,
  type CanonicalHeaderAbsenceEvidenceV1,
  type CanonicalJournalStorePort,
} from "../src/index.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const header = (overrides: Partial<CanonicalHeader> = {}): CanonicalHeader => ({
  chainId: "1",
  number: "100",
  hash: hash("1"),
  parentHash: hash("0"),
  stateRoot: hash("2"),
  ...overrides,
});

const view = (value: CanonicalHeader) => ({
  chainId: value.chainId,
  number: value.number,
  hash: value.hash,
  stateRoot: value.stateRoot,
});

const journalResources: Array<{ store: SQLiteCanonicalJournalStore; directory: string; closed: boolean }> = [];
test.after(() => {
  for (const resource of journalResources) {
    if (!resource.closed) resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

function provider(initial: CanonicalHeader, chainGenesis = "0") {
  let head = initial;
  let absenceEvidence: CanonicalHeaderAbsenceEvidenceV1 | null = null;
  let readMode: "found" | "throw" | "unavailable" | "chain-proven-absent" = "found";
  const headerProvider = {
    async getLatestHeader() {
      if (readMode === "throw") throw new Error("rpc unavailable");
      return head;
    },
    async getHeader(number: string) {
      if (readMode === "throw") throw new Error("rpc unavailable");
      if (readMode === "unavailable") return { kind: "unavailable" as const, failureCode: "rpc-pruned" };
      if (readMode === "chain-proven-absent") {
        if (!absenceEvidence) throw new Error("test absence evidence missing");
        return { kind: "chainProvenAbsent" as const, evidence: absenceEvidence };
      }
      if (head.number !== number) return { kind: "unavailable" as const, failureCode: "not-indexed" };
      return { kind: "found" as const, header: head };
    },
  };
  const directory = mkdtempSync(join(tmpdir(), "aloha-canonical-journal-"));
  const journalFilename = join(directory, "canonical.sqlite");
  const journalStore = new SQLiteCanonicalJournalStore(journalFilename);
  const resource = { store: journalStore, directory, closed: false };
  journalResources.push(resource);
  const source = new CanonicalSource(headerProvider, { chainGenesis, journalStore });
  return {
    source,
    headerProvider,
    journalFilename,
    journalStore,
    closeJournal() { if (!resource.closed) { journalStore.close(); resource.closed = true; } },
    reopenSource() {
      if (!resource.closed) {
        journalStore.close();
        resource.closed = true;
      }
      const reopenedStore = new SQLiteCanonicalJournalStore(journalFilename);
      const reopenedResource = { store: reopenedStore, directory, closed: false };
      journalResources.push(reopenedResource);
      return {
        source: new CanonicalSource(headerProvider, {
          chainGenesis,
          journalStore: reopenedStore,
        }),
        close() {
          if (!reopenedResource.closed) {
            reopenedStore.close();
            reopenedResource.closed = true;
          }
        },
      };
    },
    openPeer() {
      const peerStore = new SQLiteCanonicalJournalStore(journalFilename);
      const peerResource = { store: peerStore, directory, closed: false };
      journalResources.push(peerResource);
      return {
        source: new CanonicalSource(headerProvider, { chainGenesis, journalStore: peerStore }),
        close() {
          if (!peerResource.closed) {
            peerStore.close();
            peerResource.closed = true;
          }
        },
      };
    },
    setHead(next: CanonicalHeader) { head = next; },
    failTransport() { readMode = "throw"; },
    makeUnavailable() { readMode = "unavailable"; },
    serveAbsenceEvidence(evidence: CanonicalHeaderAbsenceEvidenceV1) {
      absenceEvidence = evidence;
      readMode = "chain-proven-absent";
    },
    async observeReorg(replacement: CanonicalHeader) {
      head = replacement;
      readMode = "found";
      const current = source.currentView;
      if (current === null) throw new Error("test view is absent");
      const observed = await source.checkStillCanonical(current);
      if (observed.ok || observed.absenceEvidence === null) throw new Error("test reorg was not observed");
      absenceEvidence = observed.absenceEvidence;
      return absenceEvidence;
    },
  };
}

test("freezes exact chain/number/hash/stateRoot and requires a complete 50-block range", async () => {
  const harness = provider(header({ number: "149" }), "100");
  const cutoff = await harness.source.freezeView();
  assert.deepEqual(cutoff, view(header({ number: "149" })));
  assert.equal((await harness.source.checkStillCanonical(cutoff)).ok, true);
  assert.equal(await harness.source.ageInBlocks(cutoff), "0");
  assert.deepEqual(harness.source.recentObservationRange(cutoff), { from: "100", to: "149" });

  const early = provider(header({ number: "48" }));
  const earlyView = await early.source.freezeView();
  assert.throws(
    () => early.source.recentObservationRange(earlyView),
    (error: unknown) => error instanceof CanonicalSourceError
      && error.code === "recent-observation-window-unavailable",
  );
});

test("same-height chain/hash/state mutations fail closed while transport is retryable", async () => {
  for (const [mutation, message] of [
    [{ chainId: "2" }, /chain-id-mismatch/],
    [{ hash: hash("3") }, /hash-mismatch/],
    [{ stateRoot: hash("4") }, /state-root-mismatch/],
  ] as const) {
    const fixture = provider(header());
    const view = await fixture.source.freezeView();
    fixture.setHead(header(mutation));
    await assert.rejects(() => fixture.source.assertStillCanonical(view), message);
  }

  const transport = provider(header());
  const view = await transport.source.freezeView();
  transport.failTransport();
  const check = await transport.source.checkStillCanonical(view);
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.retryable, true);
});

test("an unavailable historical read is retryable; only journal-backed absence is terminal", async () => {
  const fixture = provider(header());
  const view = await fixture.source.freezeView();
  fixture.makeUnavailable();
  const unavailable = await fixture.source.checkStillCanonical(view);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.equal(unavailable.reason, "transport");
    assert.equal(unavailable.retryable, true);
    assert.equal(unavailable.absenceEvidence, null);
  }

  const proof = await fixture.observeReorg(header({ hash: hash("9"), stateRoot: hash("8") }));
  const absent = await fixture.source.checkStillCanonical(view);
  assert.equal(absent.ok, false);
  if (!absent.ok) {
    assert.equal(absent.reason, "missing-header");
    assert.equal(absent.retryable, false);
    assert.equal(absent.absenceEvidence?.number, view.number);
    assert.equal(absent.absenceEvidence?.canonicalJournalRoot, proof.canonicalJournalRoot);
  }
});

test("absence evidence cannot be forged, replayed across issuers, or mutated", async () => {
  const first = provider(header());
  const firstView = await first.source.freezeView();
  const forged: CanonicalHeaderAbsenceEvidenceV1 = {
    chainId: firstView.chainId,
    number: firstView.number,
    expectedHash: firstView.hash,
    expectedStateRoot: firstView.stateRoot,
    replacementHash: hash("9"),
    replacementStateRoot: hash("8"),
    journalEpoch: first.source.journalEpoch,
    canonicalJournalRoot: hash("7"),
  };
  first.serveAbsenceEvidence(forged);
  await assert.rejects(
    () => first.source.checkStillCanonical(firstView),
    /was not issued by the canonical journal/,
  );

  const issuer = provider(header());
  const issuedView = await issuer.source.freezeView();
  const issued = await issuer.observeReorg(header({ hash: hash("9"), stateRoot: hash("8") }));
  const other = provider(header());
  const otherView = await other.source.freezeView();
  other.serveAbsenceEvidence(issued);
  await assert.rejects(
    () => other.source.checkStillCanonical(otherView),
    /was not issued by the canonical journal/,
  );

  const mutations: readonly CanonicalHeaderAbsenceEvidenceV1[] = [
    { ...issued, chainId: "2" },
    { ...issued, number: "101" },
    { ...issued, expectedHash: hash("6") },
    { ...issued, expectedStateRoot: hash("5") },
    { ...issued, replacementHash: hash("4") },
    { ...issued, replacementStateRoot: hash("3") },
    { ...issued, journalEpoch: (BigInt(issued.journalEpoch) + 1n).toString() },
    { ...issued, canonicalJournalRoot: hash("2") },
  ];
  for (const mutation of mutations) {
    const verifier = provider(header());
    const verifierView = await verifier.source.freezeView();
    verifier.serveAbsenceEvidence(mutation);
    await assert.rejects(
      () => verifier.source.checkStillCanonical(verifierView),
      /number mismatch|was not issued by the canonical journal/,
    );
  }
});

test("an observed reorg permanently revokes the exact cutoff across provider rollback and restart", async () => {
  const fixture = provider(header());
  const oldView = await fixture.source.freezeView();
  fixture.setHead(header({ hash: hash("9"), stateRoot: hash("8") }));
  const mismatch = await fixture.source.checkStillCanonical(oldView);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.reason, "hash-mismatch");
    assert.equal(mismatch.absenceEvidence?.expectedHash, oldView.hash);
  }

  fixture.setHead(header());
  await assert.rejects(() => fixture.source.assertStillCanonical(oldView), /no longer available/);
  await assert.rejects(() => fixture.source.freezeView(), /revoked canonical cutoff/);

  const reopened = fixture.reopenSource();
  await assert.rejects(() => reopened.source.assertStillCanonical(oldView), /no longer available/);
  await assert.rejects(() => reopened.source.freezeView(), /revoked canonical cutoff/);

  fixture.setHead(header({ number: "101", hash: hash("3"), stateRoot: hash("4") }));
  const later = await reopened.source.freezeView();
  assert.equal(later.number, "101");
  await assert.rejects(() => reopened.source.assertStillCanonical(oldView), /no longer available/);
});

test("unissued views and failed journal CAS never become in-memory authority", async () => {
  const fixture = provider(header());
  const issuedView = await fixture.source.freezeView();
  await assert.rejects(
    () => fixture.source.assertStillCanonical(view(header({ number: "101", hash: hash("3") }))),
    /was not issued by this durable journal/,
  );

  let failCas = false;
  const conflictingStore: CanonicalJournalStorePort = {
    load: () => fixture.journalStore.load(),
    compareAndSwap(expectedToken, bytes) {
      if (failCas) throw new Error("simulated concurrent writer");
      return fixture.journalStore.compareAndSwap(expectedToken, bytes);
    },
  };
  const contender = new CanonicalSource(fixture.headerProvider, {
    journalStore: conflictingStore,
  });
  const priorEpoch = contender.journalEpoch;
  assert.deepEqual(contender.currentView, issuedView);
  failCas = true;
  fixture.setHead(header({ number: "101", hash: hash("3"), stateRoot: hash("4") }));
  await assert.rejects(() => contender.freezeView(), /canonical journal CAS failed/);
  assert.equal(contender.journalEpoch, priorEpoch);
  assert.deepEqual(contender.currentView, issuedView);
  assert.throws(
    () => contender.assertViewAuthorityActive(view(header({ number: "101", hash: hash("3"), stateRoot: hash("4") }))),
    /not active/,
  );
});

test("corrupt journal root, duplicate views, and non-canonical ordering fail closed on recovery", async () => {
  const fixture = provider(header());
  await fixture.source.freezeView();
  fixture.setHead(header({ number: "101", hash: hash("3"), stateRoot: hash("4") }));
  await fixture.source.freezeView();
  const snapshot = fixture.journalStore.load();
  assert.ok(snapshot);
  const raw = decodeCanonicalJson(snapshot.bytes) as Record<string, unknown>;
  const issuedViews = raw.issuedViews as readonly unknown[];
  assert.equal(issuedViews.length, 2);

  const corruptions: readonly [string, Record<string, unknown>][] = [
    ["root", { ...raw, journalRoot: hash("9") }],
    ["duplicate", { ...raw, issuedViews: [...issuedViews, issuedViews[0]] }],
    ["order", { ...raw, issuedViews: [...issuedViews].reverse() }],
  ];
  for (const [name, corrupted] of corruptions) {
    const store: CanonicalJournalStorePort = {
      load: () => ({ token: snapshot.token, bytes: encodeCanonicalBytes(corrupted) }),
      compareAndSwap: () => { throw new Error("not reached"); },
    };
    assert.throws(
      () => new CanonicalSource(fixture.headerProvider, { journalStore: store }),
      /root mismatch|duplicate issued views|order is not canonical/,
      name,
    );
  }
});

test("canonical fence is issuer-owned and cannot be forged, replayed, or used after reorg", async () => {
  const first = provider(header());
  const second = provider(header());
  const view = await first.source.freezeView();
  await second.source.freezeView();
  const forged = {
    token: "forged",
    journalEpoch: first.source.journalEpoch,
    canonicalJournalRoot: hash("f"),
    cutoff: view,
  };
  assert.throws(() => first.source.assertActiveFence(forged), /not issued|no longer active/);

  let issued: Parameters<CanonicalSource["assertActiveFence"]>[0] | null = null;
  await first.source.withCanonicalFence(view, async fence => {
    issued = fence;
    first.source.assertActiveFence(fence);
    assert.throws(() => second.source.assertActiveFence(fence), /not issued/);
    return undefined;
  });
  assert.ok(issued);
  assert.throws(() => first.source.assertActiveFence(issued!), /no longer active/);

  await assert.rejects(
    () => first.source.withCanonicalFence(view, async fence => {
      await first.observeReorg(header({ hash: hash("9"), stateRoot: hash("8") }));
      first.source.assertActiveFence(fence);
    }),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "fence-invalid",
  );
});

test("a provider-observed reorg in a shared journal invalidates another instance's active fence", async () => {
  const first = provider(header());
  const view = await first.source.freezeView();
  const peer = first.openPeer();
  await assert.rejects(
    () => first.source.withCanonicalFence(view, async fence => {
      first.setHead(header({ hash: hash("9"), stateRoot: hash("8") }));
      const observed = await peer.source.checkStillCanonical(view);
      assert.equal(observed.ok, false);
      first.source.assertActiveFence(fence);
    }),
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "fence-invalid",
  );
  assert.throws(() => first.source.assertViewAuthorityActive(view), /not active/);
  peer.close();
});

test("a journal update during an asynchronous provider read invalidates the observation", async () => {
  const first = provider(header());
  const view = await first.source.freezeView();
  const peer = first.openPeer();
  const originalRead = first.headerProvider.getHeader.bind(first.headerProvider);
  let releaseRead!: () => void;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
  let delayNextRead = true;
  first.headerProvider.getHeader = async number => {
    if (!delayNextRead) return originalRead(number);
    delayNextRead = false;
    return new Promise(resolve => {
      releaseRead = () => resolve({ kind: "found" as const, header: header() });
      markReadStarted();
    });
  };
  const pending = first.source.checkStillCanonical(view);
  await readStarted;
  first.setHead(header({ hash: hash("9"), stateRoot: hash("8") }));
  const observed = await peer.source.checkStillCanonical(view);
  assert.equal(observed.ok, false);
  releaseRead();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "fence-invalid",
  );
  peer.close();
});

test("promotion freshness is issuer-owned, policy-bound, and expires with its fence", async () => {
  const value = provider(header());
  const view = await value.source.freezeView();
  const issued = await value.source.withCanonicalFence(view, async fence => {
    const authority = await value.source.observePromotionFreshness(fence, {
      cutoff: view,
      maxPromotionAgeBlocks: "0",
      generationRefreshPolicyHash: hash("7"),
    });
    value.source.assertPromotionFreshness(fence, authority);
    assert.throws(
      () => value.source.assertPromotionFreshness(fence, {
        ...authority,
        receipt: { ...authority.receipt, generationRefreshPolicyHash: hash("8") },
      }),
      /hash mismatch|not issued/,
    );
    return authority;
  });
  const forgedFence = {
    token: "expired",
    journalEpoch: issued.receipt.journalEpoch,
    canonicalJournalRoot: issued.receipt.canonicalJournalRoot,
    cutoff: view,
  };
  assert.throws(() => value.source.assertPromotionFreshness(forgedFence, issued), /not issued|no longer active/);
});

test("unknown fields, accessors, and proxies are rejected before values are copied", async () => {
  const base = header();
  const rogue = { ...base, extra: "ignored" } as CanonicalHeader;
  await assert.rejects(() => provider(rogue).source.freezeView(), /exact observed canonical header/);
  let getterRead = false;
  const accessor = { ...base } as Record<string, unknown>;
  Object.defineProperty(accessor, "hash", { enumerable: true, get() { getterRead = true; return base.hash; } });
  await assert.rejects(() => provider(accessor as unknown as CanonicalHeader).source.freezeView(), /exact observed canonical header/);
  assert.equal(getterRead, false);
  const proxied = new Proxy(base, { ownKeys() { throw new Error("trap"); } });
  await assert.rejects(() => provider(proxied).source.freezeView(), /exact observed canonical header/);
});

test("current-head observations are full-header, process-local opaque capabilities", async () => {
  const first = provider(header());
  const second = provider(header());
  const capability = await first.source.observeCurrentHead();
  const reader: CanonicalHeadObservationReaderPortV1 = first.source.headObservationReader;
  const observation = reader.read(capability);

  assert.deepEqual(Reflect.ownKeys(capability), []);
  assert.deepEqual(observation.head, header());
  assert.equal(observation.head.parentHash, hash("0"));
  assert.equal(observation.journalEpoch, first.source.journalEpoch);
  assert.match(observation.observedMonotonicNs, /^(0|[1-9][0-9]*)$/);
  reader.assert(capability);

  assert.throws(
    () => reader.assert({ ...capability }),
    /not issued by this source/,
  );
  assert.throws(
    () => reader.assert(observation),
    /not issued by this source/,
  );
  assert.throws(
    () => second.source.headObservationReader.assert(capability),
    /not issued by this source/,
  );
});

test("current-head observation requires exact parentHash agreement", async () => {
  const fixture = provider(header());
  fixture.headerProvider.getHeader = async number => ({
    kind: "found" as const,
    header: header({ number, parentHash: hash("9") }),
  });
  await assert.rejects(
    () => fixture.source.observeCurrentHead(),
    /parentHash does not match/,
  );
});

test("journal movement during current-head observation prevents capability issuance", async () => {
  const fixture = provider(header());
  const peer = fixture.openPeer();
  const originalRead = fixture.headerProvider.getHeader.bind(fixture.headerProvider);
  let releaseRead!: () => void;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
  let delayNextRead = true;
  fixture.headerProvider.getHeader = async number => {
    if (!delayNextRead) return originalRead(number);
    delayNextRead = false;
    return new Promise(resolve => {
      releaseRead = () => resolve({ kind: "found" as const, header: header() });
      markReadStarted();
    });
  };

  const pending = fixture.source.observeCurrentHead();
  await readStarted;
  fixture.setHead(header({ number: "101", hash: hash("3"), parentHash: hash("1"), stateRoot: hash("4") }));
  await peer.source.freezeView();
  releaseRead();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof CanonicalSourceError && error.code === "fence-invalid",
  );
  peer.close();
});
