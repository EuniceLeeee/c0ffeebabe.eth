import assert from "node:assert/strict";
import test from "node:test";
import {
  computeReuseLedgerRoot,
  decodeReferenceLock,
  decodeReuseLedger,
  deriveReferenceLock,
} from "../src/index.ts";
import {
  CURRENT_REFERENCE_LOCK,
  CURRENT_REUSE_LEDGER,
  REQUIRED_AUDIT_ENTRY_IDS,
} from "../src/current-ledger.ts";

test("current audited ledger is exact, frozen, and has no LP row", () => {
  assert.equal(CURRENT_REUSE_LEDGER.entries.length, 27);
  assert.deepEqual(
    CURRENT_REUSE_LEDGER.entries.map(entry => entry.entryId),
    [...REQUIRED_AUDIT_ENTRY_IDS].sort(),
  );
  assert.equal(Object.isFrozen(CURRENT_REUSE_LEDGER), true);
  assert.equal(Object.isFrozen(CURRENT_REUSE_LEDGER.entries), true);
  assert.equal(CURRENT_REUSE_LEDGER.entries.some(entry => /lp/i.test(entry.destination)), false);
  assert.deepEqual(decodeReuseLedger(CURRENT_REUSE_LEDGER), CURRENT_REUSE_LEDGER);
  assert.deepEqual(decodeReferenceLock(CURRENT_REFERENCE_LOCK), CURRENT_REFERENCE_LOCK);
});
test("reference lock is mechanically derived from the same exact source/blob set", () => {
  assert.deepEqual(deriveReferenceLock(CURRENT_REUSE_LEDGER), CURRENT_REFERENCE_LOCK);
  assert.equal(CURRENT_REFERENCE_LOCK.entries.length, CURRENT_REUSE_LEDGER.entries.length);
  for (const entry of CURRENT_REUSE_LEDGER.entries) {
    const lock = CURRENT_REFERENCE_LOCK.entries.find(candidate => candidate.entryId === entry.entryId);
    assert.ok(lock);
    assert.equal(lock.sourceCommit, entry.sourceCommit);
    assert.equal(lock.sourcePath, entry.sourcePath);
    assert.equal(lock.sourceBlob, entry.sourceBlob);
    assert.equal(lock.allowedDisposition, entry.adoptionMode);
  }
});

test("entry id binds source path and symbol, so a symbol-only edit cannot hide", () => {
  const entry = CURRENT_REUSE_LEDGER.entries[0]!;
  const mutated = { ...entry, symbol: `${entry.symbol}.changed` };
  const candidate = {
    ...CURRENT_REUSE_LEDGER,
    entries: [mutated, ...CURRENT_REUSE_LEDGER.entries.slice(1)],
    reuseLedgerRoot: computeReuseLedgerRoot([mutated, ...CURRENT_REUSE_LEDGER.entries.slice(1)]),
  };
  assert.throws(() => decodeReuseLedger(candidate), /entryId does not bind source path and symbol/);
});

test("unknown fields and missing required fields fail closed", () => {
  assert.throws(() => decodeReuseLedger({ ...CURRENT_REUSE_LEDGER, extra: true }), /unknown field/);
  const { factOracle: _factOracle, ...withoutOracle } = CURRENT_REUSE_LEDGER.entries[0]!;
  const entries = [withoutOracle, ...CURRENT_REUSE_LEDGER.entries.slice(1)];
  assert.throws(() => decodeReuseLedger({
    ...CURRENT_REUSE_LEDGER,
    entries,
    reuseLedgerRoot: computeReuseLedgerRoot(entries as typeof CURRENT_REUSE_LEDGER.entries),
  }), /missing field/);
});
