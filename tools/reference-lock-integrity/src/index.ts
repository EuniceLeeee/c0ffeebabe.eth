import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  CURRENT_REFERENCE_LOCK,
  CURRENT_REUSE_LEDGER,
  REQUIRED_AUDIT_ENTRY_IDS,
} from "../../../specs/reuse-ledger/src/current-ledger.ts";
import {
  decodeReferenceLock,
  decodeReuseLedger,
  REFERENCE_COMMIT,
  REFERENCE_REPOSITORY_ID,
  type DependencyV1,
  type ReferenceLockV1,
  type ReuseLedgerEntryV1,
  type ReuseLedgerV1,
} from "../../../specs/reuse-ledger/src/index.ts";

export type IntegrityStatus = "pass" | "invalid";

export interface IntegrityCheckV1 {
  readonly id: string;
  readonly status: IntegrityStatus;
  readonly detail: string;
}

export interface IntegrityReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.reference-lock-integrity-report";
  readonly verdict: IntegrityStatus;
  readonly repoPath: string;
  readonly sourceRepo: string;
  readonly sourceCommit: string;
  readonly ledgerRoot: Hash | null;
  readonly referenceLockRoot: Hash | null;
  readonly checks: readonly IntegrityCheckV1[];
}

export interface ReferenceLockIntegrityOptions {
  readonly repoPath: string;
  readonly ledger?: unknown;
  readonly referenceLock?: unknown;
  readonly requiredEntryIds?: readonly string[];
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly detail: string;
}

function git(repoPath: string, args: readonly string[]): GitResult {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
      detail: "",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", detail };
  }
}

function readCanonicalArtifact(path: string): unknown {
  return decodeCanonicalJson(readFileSync(path));
}

function loadLedger(value: unknown | undefined): ReuseLedgerV1 {
  if (value === undefined) return CURRENT_REUSE_LEDGER;
  if (typeof value === "string") return decodeReuseLedger(readCanonicalArtifact(value));
  return decodeReuseLedger(value);
}

function loadLock(value: unknown | undefined): ReferenceLockV1 {
  if (value === undefined) return CURRENT_REFERENCE_LOCK;
  if (typeof value === "string") return decodeReferenceLock(readCanonicalArtifact(value));
  return decodeReferenceLock(value);
}

function check(id: string, status: IntegrityStatus, detail: string): IntegrityCheckV1 {
  return Object.freeze({ id, status, detail });
}

function ids(values: readonly { readonly entryId: string }[]): readonly string[] {
  return [...values].map(value => value.entryId).sort();
}

function compareExactSet(
  actual: readonly string[],
  expected: readonly string[],
  id: string,
): IntegrityCheckV1 {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter(value => !actualSet.has(value));
  const unknown = actual.filter(value => !expectedSet.has(value));
  if (missing.length > 0 || unknown.length > 0 || actual.length !== actualSet.size) {
    return check(id, "invalid", `missing=${missing.join(",") || "none"};unknown=${unknown.join(",") || "none"};duplicate=${actual.length !== actualSet.size}`);
  }
  return check(id, "pass", `exact=${actual.length}`);
}

function dependencyKey(dependency: DependencyV1): string {
  if (dependency.kind === "source") return `source:${dependency.path}`;
  if (dependency.kind === "external") return `external:${dependency.packageName}@${dependency.version}`;
  return `future:${dependency.contract}`;
}

function sourceBlob(repoPath: string, commit: string, path: string): GitResult {
  return git(repoPath, ["rev-parse", `${commit}:${path}`]);
}

function sourceText(repoPath: string, commit: string, path: string): string | null {
  try {
    return execFileSync("git", ["-C", repoPath, "show", `${commit}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function sourceLineCount(repoPath: string, commit: string, path: string): number | null {
  const text = sourceText(repoPath, commit, path);
  if (text === null) return null;
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function verifySymbol(repoPath: string, entry: ReuseLedgerEntryV1, checks: IntegrityCheckV1): IntegrityCheckV1 {
  const source = sourceText(repoPath, entry.sourceCommit, entry.sourcePath);
  if (source === null) return check(checks.id, "invalid", "source bytes unavailable for symbol check");
  const symbols = entry.symbol.split(";").map(symbol => symbol.trim()).filter(Boolean);
  const missing = symbols.filter(symbol => !source.includes(symbol));
  const directExport = symbols.some(symbol => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\bexport\\s+(?:(?:async)\\s+)?(?:function|const|class|interface|type)\\s+${escaped}\\b`).test(source)
      || new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(source);
  });
  if (missing.length > 0 || !directExport) {
    return check(checks.id, "invalid", `missing=${missing.join(",") || "none"};directExport=${directExport}`);
  }
  return check(checks.id, "pass", `symbols=${symbols.length};directExport=${directExport}`);
}

function verifySourceDependency(
  repoPath: string,
  commit: string,
  entry: ReuseLedgerEntryV1,
  dependency: DependencyV1,
  checks: IntegrityCheckV1[],
  index: number,
): void {
  if (dependency.kind !== "source") {
    if (dependency.kind === "future" && entry.adoptionMode !== "invariant-only-rewrite" && entry.adoptionMode !== "rejected") {
      checks.push(check(`dependency.future.${entry.entryId}.${index}`, "invalid", "pending dependency is only allowed for invariant-only-rewrite or rejected entries"));
      return;
    }
    checks.push(check(`dependency.${dependency.kind}.${entry.entryId}.${index}`, "pass", "non-source dependency is explicit and has no local Git object"));
    return;
  }
  const result = sourceBlob(repoPath, commit, dependency.path);
  if (!result.ok) {
    checks.push(check(`dependency.source.${entry.entryId}.${index}`, "invalid", `missing source dependency ${dependency.path}`));
    return;
  }
  checks.push(check(
    `dependency.source.${entry.entryId}.${index}`,
    result.stdout === dependency.blob ? "pass" : "invalid",
    result.stdout === dependency.blob ? `${dependency.path} blob exact` : `${dependency.path} blob mismatch expected=${dependency.blob} actual=${result.stdout}`,
  ));
}

function verifyEntryGit(repoPath: string, entry: ReuseLedgerEntryV1, checks: IntegrityCheckV1[], index: number): void {
  const blob = sourceBlob(repoPath, entry.sourceCommit, entry.sourcePath);
  if (!blob.ok) {
    checks.push(check(`source.${entry.entryId}`, "invalid", `source path missing: ${entry.sourcePath}`));
  } else {
    checks.push(check(
      `source.${entry.entryId}`,
      blob.stdout === entry.sourceBlob ? "pass" : "invalid",
      blob.stdout === entry.sourceBlob ? `${entry.sourcePath} blob exact` : `${entry.sourcePath} blob mismatch expected=${entry.sourceBlob} actual=${blob.stdout}`,
    ));
  }
  checks.push(verifySymbol(repoPath, entry, check(`symbol.${entry.entryId}`, "pass", "symbol locator checked")));
  const lineCount = sourceLineCount(repoPath, entry.sourceCommit, entry.sourcePath);
  checks.push(check(
    `range.${entry.entryId}`,
    lineCount !== null && entry.sourceRange.startLine <= lineCount && entry.sourceRange.endLine <= lineCount ? "pass" : "invalid",
    lineCount === null ? "source bytes unavailable for range check" : `range ${entry.sourceRange.startLine}-${entry.sourceRange.endLine} of ${lineCount}`,
  ));
  for (const [closureName, closure] of [["old", entry.oldDependencyClosure], ["new", entry.newDependencyClosure]] as const) {
    const seen = new Set<string>();
    for (const [dependencyIndex, dependency] of closure.entries()) {
      const key = dependencyKey(dependency);
      if (seen.has(key)) checks.push(check(`dependency.duplicate.${entry.entryId}.${closureName}.${dependencyIndex}`, "invalid", `duplicate ${key}`));
      seen.add(key);
      verifySourceDependency(repoPath, entry.sourceCommit, entry, dependency, checks, dependencyIndex);
    }
    if (closureName === "new" && entry.adoptionMode === "isolated-pure-kernel" && closure.length !== 0) {
      checks.push(check(`new-closure.${entry.entryId}`, "invalid", "isolated pure kernel must not carry a pending new dependency"));
    }
  }
  checks.push(check(
    `production-import.${entry.entryId}`,
    entry.productionImportAllowed ? "invalid" : "pass",
    entry.productionImportAllowed ? "old source cannot enter production closure" : "production import denied",
  ));
}

function compareLockEntry(ledgerEntry: ReuseLedgerEntryV1, lockEntry: ReferenceLockV1["entries"][number], checks: IntegrityCheckV1): IntegrityCheckV1 {
  const exact = ledgerEntry.entryId === lockEntry.entryId
    && ledgerEntry.sourceRepo === lockEntry.sourceRepo
    && ledgerEntry.sourceCommit === lockEntry.sourceCommit
    && ledgerEntry.sourcePath === lockEntry.sourcePath
    && ledgerEntry.sourceBlob === lockEntry.sourceBlob
    && ledgerEntry.adoptionMode === lockEntry.allowedDisposition;
  return exact ? checks : check(checks.id, "invalid", "reference lock entry does not exactly bind the ledger entry");
}

export function validateReferenceLockIntegrity(options: ReferenceLockIntegrityOptions): IntegrityReportV1 {
  const checks: IntegrityCheckV1[] = [];
  let ledger: ReuseLedgerV1 | null = null;
  let referenceLock: ReferenceLockV1 | null = null;
  try {
    ledger = loadLedger(options.ledger);
    checks.push(check("ledger.decode", "pass", "exact schema decoded"));
  } catch (error) {
    checks.push(check("ledger.decode", "invalid", error instanceof Error ? error.message : String(error)));
  }
  try {
    referenceLock = loadLock(options.referenceLock);
    checks.push(check("reference-lock.decode", "pass", "exact schema decoded"));
  } catch (error) {
    checks.push(check("reference-lock.decode", "invalid", error instanceof Error ? error.message : String(error)));
  }
  if (ledger !== null) {
    checks.push(check("ledger.source-header", ledger.sourceRepo === REFERENCE_REPOSITORY_ID && ledger.sourceCommit === REFERENCE_COMMIT ? "pass" : "invalid", `${ledger.sourceRepo}@${ledger.sourceCommit}`));
    checks.push(compareExactSet(ids(ledger.entries), options.requiredEntryIds ?? REQUIRED_AUDIT_ENTRY_IDS, "ledger.coverage"));
    checks.push(check("ledger.lp-absence", ledger.entries.some(entry => /(^|[^a-z])lp([^a-z]|$)|liquidity.?pool/i.test(`${entry.entryId} ${entry.sourcePath} ${entry.destination} ${entry.symbol}`)) ? "invalid" : "pass", "current ledger has no LP entry"));
    const duplicateSourcePaths = ledger.entries.map(entry => `${entry.sourcePath}:${entry.symbol}`);
    checks.push(check("ledger.duplicate-symbol", new Set(duplicateSourcePaths).size === duplicateSourcePaths.length ? "pass" : "invalid", "symbol locators are unique"));
    const commit = git(options.repoPath, ["rev-parse", `${REFERENCE_COMMIT}^{commit}`]);
    checks.push(check("git.reference-commit", commit.ok && commit.stdout === REFERENCE_COMMIT ? "pass" : "invalid", commit.ok ? commit.stdout : "reference commit is unavailable"));
    ledger.entries.forEach((entry, index) => verifyEntryGit(options.repoPath, entry, checks, index));
  }
  if (ledger !== null && referenceLock !== null) {
    checks.push(check("reference-lock.source-header", referenceLock.sourceRepo === ledger.sourceRepo && referenceLock.sourceCommit === ledger.sourceCommit ? "pass" : "invalid", "lock header matches ledger header"));
    checks.push(compareExactSet(ids(referenceLock.entries), ids(ledger.entries), "reference-lock.coverage"));
    const byId = new Map(ledger.entries.map(entry => [entry.entryId, entry] as const));
    for (const lockEntry of referenceLock.entries) {
      const ledgerEntry = byId.get(lockEntry.entryId);
      if (ledgerEntry === undefined) {
        checks.push(check(`reference-lock.entry.${lockEntry.entryId}`, "invalid", "lock entry has no ledger entry"));
      } else {
        checks.push(compareLockEntry(ledgerEntry, lockEntry, check(`reference-lock.entry.${lockEntry.entryId}`, "pass", "lock entry exact")));
      }
    }
    checks.push(check("reference-lock.lp-absence", referenceLock.entries.some(entry => /(^|[^a-z])lp([^a-z]|$)|liquidity.?pool/i.test(`${entry.entryId} ${entry.sourcePath}`)) ? "invalid" : "pass", "reference lock has no LP entry"));
  }
  const verdict: IntegrityStatus = checks.every(item => item.status === "pass") ? "pass" : "invalid";
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.reference-lock-integrity-report",
    verdict,
    repoPath: options.repoPath,
    sourceRepo: ledger?.sourceRepo ?? REFERENCE_REPOSITORY_ID,
    sourceCommit: ledger?.sourceCommit ?? REFERENCE_COMMIT,
    ledgerRoot: ledger?.reuseLedgerRoot ?? null,
    referenceLockRoot: referenceLock?.referenceLockRoot ?? null,
    checks: Object.freeze(checks),
  });
}

export function encodeIntegrityReport(report: IntegrityReportV1): string {
  return encodeCanonicalJson(report);
}

export function assertIntegrityPass(report: IntegrityReportV1): void {
  if (report.verdict !== "pass") {
    const failures = report.checks.filter(checkItem => checkItem.status !== "pass").map(checkItem => `${checkItem.id}: ${checkItem.detail}`).join("; ");
    throw new Error(`reference-lock integrity failed: ${failures}`);
  }
}
