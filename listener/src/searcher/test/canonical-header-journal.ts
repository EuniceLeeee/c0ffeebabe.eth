import assert from "node:assert/strict";
import {
  CanonicalHeaderJournal,
  type CanonicalHeader,
} from "../canonical-header-journal.js";

function header(
  number: number,
  hashByte: number,
  parentHash: string,
): CanonicalHeader {
  return {
    number,
    hash: hash(hashByte),
    parentHash,
  };
}

function hash(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

function testLinearProofAndIdempotence(): void {
  const journal = new CanonicalHeaderJournal();
  const h10 = header(10, 0x10, hash(0x09));
  const h11 = header(11, 0x11, h10.hash);
  const anchored = journal.ingest(h10);
  assert.equal(anchored.status, "anchored");
  assert.equal(anchored.revision, 1);
  assert.equal(anchored.invalidatedFrom, null);
  const extended = journal.ingest(h11);
  assert.equal(extended.status, "extended");
  assert.equal(extended.revision, 2);
  assert.equal(extended.commonKnownAncestor?.hash, h10.hash);
  const duplicate = journal.ingest(h11);
  assert.equal(duplicate.status, "unchanged");
  assert.equal(duplicate.revision, 2);
  assert.deepEqual(journal.proof(), {
    revision: 2,
    source: { number: 11, hash: h11.hash },
    parentHash: h10.hash,
  });
  console.log("[canonical-header-journal] linear proof/idempotence: PASS");
}

function testSameHeightReplacement(): void {
  const journal = new CanonicalHeaderJournal();
  const h20 = header(20, 0x20, hash(0x19));
  const h21a = header(21, 0x21, h20.hash);
  const h21b = header(21, 0x31, h20.hash);
  journal.ingest(h20);
  journal.ingest(h21a);
  const replaced = journal.ingest(h21b);
  assert.equal(replaced.status, "reorganized");
  assert.equal(replaced.revision, 3);
  assert.equal(replaced.invalidatedFrom, 21);
  assert.equal(replaced.commonKnownAncestor?.hash, h20.hash);
  assert.equal(replaced.sameHeightReplacement, true);
  assert.equal(replaced.parentDiscontinuity, false);
  assert.equal(journal.lookup(21)?.hash, h21b.hash);
  assert.deepEqual(journal.lookupHash(h21a.hash), {
    header: {
      ...h21a,
      hash: h21a.hash.toLowerCase(),
      parentHash: h21a.parentHash.toLowerCase(),
    },
    canonical: false,
  });
  assert.equal(journal.lookupHash(h21b.hash)?.canonical, true);
  console.log("[canonical-header-journal] same-height replacement: PASS");
}

function testDeeperReorgReportsCommonAncestor(): void {
  const journal = new CanonicalHeaderJournal();
  const h30 = header(30, 0x30, hash(0x29));
  const h31a = header(31, 0x31, h30.hash);
  const h32a = header(32, 0x32, h31a.hash);
  const h33a = header(33, 0x33, h32a.hash);
  journal.ingest(h30);
  journal.ingest(h31a);
  journal.ingest(h32a);
  journal.ingest(h33a);

  const h31b = header(31, 0x41, h30.hash);
  const reorg = journal.ingest(h31b);
  assert.equal(reorg.status, "reorganized");
  assert.equal(reorg.revision, 5);
  assert.equal(reorg.invalidatedFrom, 31);
  assert.equal(reorg.commonKnownAncestor?.number, 30);
  assert.equal(reorg.commonKnownAncestor?.hash, h30.hash);
  assert.equal(journal.head?.number, 31);
  assert.equal(journal.lookup(32), null);
  assert.equal(journal.lookup(33), null);
  assert.equal(journal.lookupHash(h33a.hash)?.canonical, false);

  const h32b = header(32, 0x42, h31b.hash);
  const resumed = journal.ingest(h32b);
  assert.equal(resumed.status, "extended");
  assert.equal(resumed.revision, 6);
  assert.equal(resumed.invalidatedFrom, null);
  assert.equal(journal.head?.hash, h32b.hash);
  console.log("[canonical-header-journal] deeper reorg/common ancestor: PASS");
}

function testUnknownParentFailsClosedToNewAnchor(): void {
  const journal = new CanonicalHeaderJournal();
  const h40 = header(40, 0x40, hash(0x39));
  const h41 = header(41, 0x41, h40.hash);
  journal.ingest(h40);
  journal.ingest(h41);
  const disconnected = header(41, 0x51, hash(0xee));
  const result = journal.ingest(disconnected);
  assert.equal(result.status, "reorganized");
  assert.equal(result.invalidatedFrom, 40);
  assert.equal(result.commonKnownAncestor, null);
  assert.equal(result.parentDiscontinuity, true);
  assert.equal(result.sameHeightReplacement, true);
  assert.equal(journal.lookup(40), null);
  assert.equal(journal.lookup(41)?.hash, disconnected.hash);
  console.log("[canonical-header-journal] unknown-parent discontinuity: PASS");
}

function testValidationAndRetention(): void {
  const journal = new CanonicalHeaderJournal({ retentionDepth: 3 });
  let parent = hash(0x60);
  for (let number = 61; number <= 65; number++) {
    const next = header(number, number, parent);
    journal.ingest(next);
    parent = next.hash;
  }
  assert.equal(journal.lookup(62), null);
  assert.equal(journal.lookup(63)?.number, 63);
  assert.throws(
    () => journal.ingest({ number: 66, hash: "0x01", parentHash: parent }),
    /32-byte/,
  );
  assert.throws(
    () => journal.ingest({ number: -1, hash: hash(1), parentHash: hash(2) }),
    /non-negative/,
  );
  console.log("[canonical-header-journal] validation/retention: PASS");
}

function testBackfilledAncestorPreservesCanonicalHead(): void {
  const journal = new CanonicalHeaderJournal();
  const h70 = header(70, 0x70, hash(0x69));
  const h71 = header(71, 0x71, h70.hash);
  journal.ingest(h71);
  const anchored = journal.ingest(h70);
  assert.equal(anchored.status, "anchored");
  assert.equal(anchored.invalidatedFrom, null);
  assert.equal(anchored.sameHeightReplacement, false);
  assert.equal(journal.lookup(70)?.hash, h70.hash);
  assert.equal(
    journal.head?.hash,
    h71.hash,
    "reading an older canonical ancestor must not rewind the head",
  );
  console.log("[canonical-header-journal] ancestor backfill: PASS");
}

testLinearProofAndIdempotence();
testSameHeightReplacement();
testDeeperReorgReportsCommonAncestor();
testUnknownParentFailsClosedToNewAnchor();
testValidationAndRetention();
testBackfilledAncestorPreservesCanonicalHead();
console.log("[canonical-header-journal] PASS 6/6");
