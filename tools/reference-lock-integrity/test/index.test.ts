import assert from "node:assert/strict";
import test from "node:test";
import {
  computeReuseLedgerRoot,
  type ReuseLedgerEntryV1,
  type ReuseLedgerV1,
} from "../../../specs/reuse-ledger/src/index.ts";
import { CURRENT_REUSE_LEDGER } from "../../../specs/reuse-ledger/src/current-ledger.ts";
import {
  validateReferenceLockIntegrity,
} from "../src/index.ts";

const repoPath = "/private/tmp/mev-s1-impl";

function ledgerWithEntries(entries: readonly ReuseLedgerEntryV1[]): ReuseLedgerV1 {
  return {
    ...CURRENT_REUSE_LEDGER,
    entries: Object.freeze([...entries]),
    reuseLedgerRoot: computeReuseLedgerRoot(entries),
  };
}

function firstEntry(): ReuseLedgerEntryV1 {
  return CURRENT_REUSE_LEDGER.entries[0]!;
}

function mutateFirst(change: Partial<ReuseLedgerEntryV1>): ReuseLedgerV1 {
  const entries = [
    { ...firstEntry(), ...change },
    ...CURRENT_REUSE_LEDGER.entries.slice(1),
  ] as ReuseLedgerEntryV1[];
  return ledgerWithEntries(entries);
}

function invalidCheck(report: ReturnType<typeof validateReferenceLockIntegrity>, id: string): void {
  assert.equal(report.verdict, "invalid");
  assert.equal(report.checks.some(check => check.id === id && check.status === "invalid"), true, `${id} did not fail`);
}

test("passes only against the real old Git commit and exact source/dependency blobs", () => {
  const report = validateReferenceLockIntegrity({ repoPath });
  assert.equal(report.verdict, "pass");
  assert.equal(report.checks.some(check => check.id.startsWith("source.") && check.status === "invalid"), false);
  assert.equal(report.checks.some(check => check.id.startsWith("dependency.source.") && check.status === "invalid"), false);
  assert.equal(report.checks.some(check => check.id.startsWith("symbol.") && check.status === "invalid"), false);
});
test("source blob mutation is invalid even when the ledger root is recomputed", () => {
  invalidCheck(validateReferenceLockIntegrity({ repoPath, ledger: mutateFirst({ sourceBlob: "a".repeat(40) }) }), `source.${firstEntry().entryId}`);
});

test("dependency blob mutation is invalid even when the ledger root is recomputed", () => {
  const entry = firstEntry();
  const dependent = CURRENT_REUSE_LEDGER.entries.find(candidate => candidate.oldDependencyClosure.length > 0)!;
  const dependencies = dependent.oldDependencyClosure.map((dependency, index) => index === 0 && dependency.kind === "source"
    ? { ...dependency, blob: "b".repeat(40) }
    : dependency);
  const entries = CURRENT_REUSE_LEDGER.entries.map(candidate => candidate.entryId === dependent.entryId
    ? { ...candidate, oldDependencyClosure: dependencies }
    : candidate) as ReuseLedgerEntryV1[];
  const report = validateReferenceLockIntegrity({ repoPath, ledger: ledgerWithEntries(entries) });
  assert.equal(report.verdict, "invalid");
  assert.equal(report.checks.some(check => check.id.startsWith(`dependency.source.${dependent.entryId}`) && check.status === "invalid"), true);
  assert.notEqual(entry.entryId, dependent.entryId);
});

test("missing and duplicate required rows fail exact coverage", () => {
  const missing = ledgerWithEntries(CURRENT_REUSE_LEDGER.entries.slice(1));
  invalidCheck(validateReferenceLockIntegrity({ repoPath, ledger: missing }), "ledger.coverage");
  const duplicateEntries = [firstEntry(), ...CURRENT_REUSE_LEDGER.entries] as ReuseLedgerEntryV1[];
  const duplicate = ledgerWithEntries(duplicateEntries);
  invalidCheck(validateReferenceLockIntegrity({ repoPath, ledger: duplicate }), "ledger.decode");
});

test("unknown fields fail exact decoding", () => {
  invalidCheck(validateReferenceLockIntegrity({
    repoPath,
    ledger: { ...CURRENT_REUSE_LEDGER, unexpected: true },
  }), "ledger.decode");
});

test("wrong source commit, path, and symbol cannot be repaired by self-consistent hashes", () => {
  invalidCheck(validateReferenceLockIntegrity({
    repoPath,
    ledger: { ...CURRENT_REUSE_LEDGER, sourceCommit: "c".repeat(40), reuseLedgerRoot: CURRENT_REUSE_LEDGER.reuseLedgerRoot },
  }), "ledger.decode");
  invalidCheck(validateReferenceLockIntegrity({
    repoPath,
    ledger: mutateFirst({ sourcePath: "listener/src/not-a-real-source.ts" }),
  }), "ledger.decode");
  invalidCheck(validateReferenceLockIntegrity({
    repoPath,
    ledger: mutateFirst({ symbol: `${firstEntry().symbol}.fabricated` }),
  }), "ledger.decode");
});

test("fact oracle and affected capability root are mandatory", () => {
  const { factOracle: _factOracle, ...withoutOracle } = firstEntry();
  const entriesWithoutOracle = [withoutOracle, ...CURRENT_REUSE_LEDGER.entries.slice(1)] as ReuseLedgerEntryV1[];
  invalidCheck(validateReferenceLockIntegrity({ repoPath, ledger: ledgerWithEntries(entriesWithoutOracle) }), "ledger.decode");
  const { affectedCapabilityRoot: _affectedCapabilityRoot, ...withoutRoot } = firstEntry();
  const entriesWithoutRoot = [withoutRoot, ...CURRENT_REUSE_LEDGER.entries.slice(1)] as ReuseLedgerEntryV1[];
  invalidCheck(validateReferenceLockIntegrity({ repoPath, ledger: ledgerWithEntries(entriesWithoutRoot) }), "ledger.decode");
});

test("LP rows and out-of-range symbols fail closed", () => {
  invalidCheck(validateReferenceLockIntegrity({
    repoPath,
    ledger: mutateFirst({ destination: "families/lp-template/kernel" }),
  }), "ledger.lp-absence");
  invalidCheck(validateReferenceLockIntegrity({
    repoPath,
    ledger: mutateFirst({ sourceRange: { startLine: 1, endLine: 999_999 } }),
  }), `range.${firstEntry().entryId}`);
});

test("lock/blob binding is not allowed to drift from the ledger", () => {
  const changed = mutateFirst({ sourceBlob: "d".repeat(40) });
  const report = validateReferenceLockIntegrity({ repoPath, ledger: changed });
  assert.equal(report.checks.some(check => check.id.startsWith("reference-lock.entry.") && check.status === "invalid"), true);
});
