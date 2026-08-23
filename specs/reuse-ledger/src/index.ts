import {
  assertExactKeys,
  assertGitSha40,
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  fieldArray,
  fieldBoolean,
  hashDomain,
  type ExactFieldDecoder,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export const REFERENCE_REPOSITORY_ID = "impl" as const;
export const REFERENCE_COMMIT = "5f104cedd4b4778316c177ce4fa08a6761af85b1" as const;
export const REUSE_LEDGER_SCHEMA_VERSION = 1 as const;
export const REFERENCE_LOCK_SCHEMA_VERSION = 1 as const;

export type AdoptionMode =
  | "isolated-pure-kernel"
  | "invariant-only-rewrite"
  | "reference-witness"
  | "rejected";

export type DependencyKind = "source" | "external" | "future";

export interface SourceRangeV1 {
  readonly startLine: number;
  readonly endLine: number;
}

export interface SourceDependencyV1 {
  readonly kind: "source";
  readonly path: string;
  readonly blob: string;
  readonly relation: string;
}

export interface ExternalDependencyV1 {
  readonly kind: "external";
  readonly packageName: string;
  readonly version: string;
  readonly relation: string;
}

export interface FutureDependencyV1 {
  readonly kind: "future";
  readonly contract: string;
  readonly status: "pending";
  readonly relation: string;
}

export type DependencyV1 = SourceDependencyV1 | ExternalDependencyV1 | FutureDependencyV1;

export interface FactOracleV1 {
  readonly kind: "independent-observer" | "mathematical-oracle" | "chain-oracle" | "reference-witness";
  readonly oracleId: string;
  readonly source: string;
  readonly claim: string;
}

export interface ReviewMetadataV1 {
  readonly reviewId: string;
  readonly reviewMode: "adversarial" | "two-person" | "mechanical";
  readonly reviewer: string;
  readonly reviewedCommit: string;
  readonly notes: string;
}

export interface ReuseLedgerEntryV1 {
  readonly entryId: string;
  readonly sourceRepo: string;
  readonly sourceCommit: string;
  readonly sourcePath: string;
  readonly sourceBlob: string;
  readonly symbol: string;
  readonly sourceRange: SourceRangeV1;
  readonly adoptionMode: AdoptionMode;
  readonly destination: string;
  readonly oldDependencyClosure: readonly DependencyV1[];
  readonly newDependencyClosure: readonly DependencyV1[];
  readonly factOracle: FactOracleV1;
  readonly affectedCapabilityRoot: Hash;
  readonly reviewMetadata: ReviewMetadataV1;
  readonly productionImportAllowed: boolean;
}

export interface ReuseLedgerV1 {
  readonly schemaVersion: typeof REUSE_LEDGER_SCHEMA_VERSION;
  readonly sourceRepo: string;
  readonly sourceCommit: string;
  readonly entries: readonly ReuseLedgerEntryV1[];
  readonly reuseLedgerRoot: Hash;
}

export interface ReferenceLockEntryV1 {
  readonly entryId: string;
  readonly sourceRepo: string;
  readonly sourceCommit: string;
  readonly sourcePath: string;
  readonly sourceBlob: string;
  readonly license: string;
  readonly allowedDisposition: AdoptionMode;
}

export interface ReferenceLockV1 {
  readonly schemaVersion: typeof REFERENCE_LOCK_SCHEMA_VERSION;
  readonly sourceRepo: string;
  readonly sourceCommit: string;
  readonly entries: readonly ReferenceLockEntryV1[];
  readonly referenceLockRoot: Hash;
}

const ADOPTION_MODES = [
  "isolated-pure-kernel",
  "invariant-only-rewrite",
  "reference-witness",
  "rejected",
] as const;
const DEPENDENCY_KINDS = ["source", "external", "future"] as const;
const ORACLE_KINDS = ["independent-observer", "mathematical-oracle", "chain-oracle", "reference-witness"] as const;
const REVIEW_MODES = ["adversarial", "two-person", "mechanical"] as const;
const HASH_DECODER: ExactFieldDecoder<Hash> = (value, path) => assertHash(value, path);
const GIT_DECODER: ExactFieldDecoder<string> = (value, path) => assertGitSha40(value, path);
const TEXT_DECODER: ExactFieldDecoder<string> = (value, path) => assertNonEmptyString(value, path);

function enumDecoder<T extends readonly string[]>(values: T): ExactFieldDecoder<T[number]> {
  return (value, path) => {
    const decoded = TEXT_DECODER(value, path);
    if (!(values as readonly string[]).includes(decoded)) throw new TypeError(`value is outside enum at ${path}`);
    return decoded as T[number];
  };
}

function pathDecoder(value: unknown, path: string): string {
  const decoded = TEXT_DECODER(value, path);
  if (decoded.startsWith("/") || decoded.startsWith(".") || decoded.includes("\\") || decoded.includes("..") || decoded.includes("?") || decoded.includes("#")) {
    throw new TypeError(`non-relative source path at ${path}`);
  }
  return decoded;
}

function positiveLine(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`positive line number required at ${path}`);
  }
  return value;
}

function decodeSourceRange(value: unknown, path: string): SourceRangeV1 {
  const decoded = decodeExactObject(value, {
    startLine: positiveLine,
    endLine: positiveLine,
  }, path);
  if (decoded.endLine < decoded.startLine) throw new TypeError(`source range is reversed at ${path}`);
  return Object.freeze(decoded);
}

function decodeDependency(value: unknown, path: string): DependencyV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`dependency must be an object at ${path}`);
  const kind = TEXT_DECODER((value as Record<string, unknown>).kind, `${path}.kind`);
  if (kind === "source") {
    return Object.freeze(decodeExactObject(value, {
      kind: (item, itemPath) => enumDecoder(["source"] as const)(item, itemPath),
      path: pathDecoder,
      blob: GIT_DECODER,
      relation: TEXT_DECODER,
    }, path));
  }
  if (kind === "external") {
    return Object.freeze(decodeExactObject(value, {
      kind: (item, itemPath) => enumDecoder(["external"] as const)(item, itemPath),
      packageName: TEXT_DECODER,
      version: TEXT_DECODER,
      relation: TEXT_DECODER,
    }, path));
  }
  if (kind === "future") {
    return Object.freeze(decodeExactObject(value, {
      kind: (item, itemPath) => enumDecoder(["future"] as const)(item, itemPath),
      contract: TEXT_DECODER,
      status: (item, itemPath) => enumDecoder(["pending"] as const)(item, itemPath),
      relation: TEXT_DECODER,
    }, path));
  }
  throw new TypeError(`unknown dependency kind ${kind} at ${path}.kind`);
}

function decodeOracle(value: unknown, path: string): FactOracleV1 {
  return Object.freeze(decodeExactObject(value, {
    kind: enumDecoder(ORACLE_KINDS),
    oracleId: TEXT_DECODER,
    source: TEXT_DECODER,
    claim: TEXT_DECODER,
  }, path));
}

function decodeReview(value: unknown, path: string): ReviewMetadataV1 {
  return Object.freeze(decodeExactObject(value, {
    reviewId: TEXT_DECODER,
    reviewMode: enumDecoder(REVIEW_MODES),
    reviewer: TEXT_DECODER,
    reviewedCommit: GIT_DECODER,
    notes: TEXT_DECODER,
  }, path));
}

function decodeEntry(value: unknown, path: string): ReuseLedgerEntryV1 {
  const decoded = decodeExactObject(value, {
    entryId: TEXT_DECODER,
    sourceRepo: TEXT_DECODER,
    sourceCommit: GIT_DECODER,
    sourcePath: pathDecoder,
    sourceBlob: GIT_DECODER,
    symbol: TEXT_DECODER,
    sourceRange: decodeSourceRange,
    adoptionMode: enumDecoder(ADOPTION_MODES),
    destination: TEXT_DECODER,
    oldDependencyClosure: (item, itemPath) => fieldArray(item, decodeDependency, itemPath),
    newDependencyClosure: (item, itemPath) => fieldArray(item, decodeDependency, itemPath),
    factOracle: decodeOracle,
    affectedCapabilityRoot: HASH_DECODER,
    reviewMetadata: decodeReview,
    productionImportAllowed: fieldBoolean,
  }, path);
  if (decoded.sourceRepo !== REFERENCE_REPOSITORY_ID) throw new TypeError(`unknown source repository at ${path}.sourceRepo`);
  if (decoded.sourceCommit !== REFERENCE_COMMIT) throw new TypeError(`source commit is not the frozen reference at ${path}.sourceCommit`);
  if (decoded.entryId !== entryIdFor(decoded.sourcePath, decoded.symbol)) throw new TypeError(`entryId does not bind source path and symbol at ${path}.entryId`);
  if (decoded.adoptionMode === "rejected" && decoded.productionImportAllowed) throw new TypeError(`rejected entry cannot be production-importable at ${path}`);
  if (decoded.reviewMetadata.reviewedCommit !== decoded.sourceCommit) throw new TypeError(`review commit mismatch at ${path}`);
  const dependencyKeys = (dependency: DependencyV1): string => dependency.kind === "source"
    ? `${dependency.kind}:${dependency.path}`
    : dependency.kind === "external"
      ? `${dependency.kind}:${dependency.packageName}@${dependency.version}`
      : `${dependency.kind}:${dependency.contract}`;
  for (const closureName of ["oldDependencyClosure", "newDependencyClosure"] as const) {
    const keys = decoded[closureName].map(dependencyKeys);
    if (new Set(keys).size !== keys.length) throw new TypeError(`duplicate dependency in ${path}.${closureName}`);
  }
  return Object.freeze(decoded);
}

function sortEntries(entries: readonly ReuseLedgerEntryV1[]): readonly ReuseLedgerEntryV1[] {
  const sorted = [...entries].sort((left, right) => left.entryId.localeCompare(right.entryId));
  if (new Set(sorted.map(entry => entry.entryId)).size !== sorted.length) throw new TypeError("duplicate reuse ledger entryId");
  return Object.freeze(sorted);
}

export function computeReuseLedgerRoot(entries: readonly ReuseLedgerEntryV1[]): Hash {
  return hashDomain("aloha/reuse-ledger/v1", entries);
}

export function sealReuseLedger(
  entries: readonly ReuseLedgerEntryV1[],
  sourceRepo: string = REFERENCE_REPOSITORY_ID,
  sourceCommit: string = REFERENCE_COMMIT,
): ReuseLedgerV1 {
  if (sourceRepo !== REFERENCE_REPOSITORY_ID) throw new TypeError("reuse ledger source repository mismatch");
  if (sourceCommit !== REFERENCE_COMMIT) throw new TypeError("reuse ledger source commit mismatch");
  const normalized = sortEntries(entries.map((entry, index) => decodeEntry(entry, `reuseLedger.entries[${index}]`)));
  return deepFreeze({
    schemaVersion: REUSE_LEDGER_SCHEMA_VERSION,
    sourceRepo,
    sourceCommit,
    entries: normalized,
    reuseLedgerRoot: computeReuseLedgerRoot(normalized),
  });
}

export function decodeReuseLedger(value: unknown, path = "reuseLedger"): ReuseLedgerV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, itemPath) => {
      if (item !== REUSE_LEDGER_SCHEMA_VERSION) throw new TypeError(`unsupported reuse ledger schema at ${itemPath}`);
      return REUSE_LEDGER_SCHEMA_VERSION;
    },
    sourceRepo: TEXT_DECODER,
    sourceCommit: GIT_DECODER,
    entries: (item, itemPath) => fieldArray(item, decodeEntry, itemPath),
    reuseLedgerRoot: HASH_DECODER,
  }, path);
  const sealed = sealReuseLedger(decoded.entries, decoded.sourceRepo, decoded.sourceCommit);
  if (sealed.reuseLedgerRoot !== decoded.reuseLedgerRoot) throw new TypeError("reuse ledger root mismatch");
  return sealed;
}

function decodeLockEntry(value: unknown, path: string): ReferenceLockEntryV1 {
  return Object.freeze(decodeExactObject(value, {
    entryId: TEXT_DECODER,
    sourceRepo: TEXT_DECODER,
    sourceCommit: GIT_DECODER,
    sourcePath: pathDecoder,
    sourceBlob: GIT_DECODER,
    license: TEXT_DECODER,
    allowedDisposition: enumDecoder(ADOPTION_MODES),
  }, path));
}

export function computeReferenceLockRoot(entries: readonly ReferenceLockEntryV1[]): Hash {
  return hashDomain("aloha/reference-lock/v1", entries);
}

export function sealReferenceLock(entries: readonly ReferenceLockEntryV1[]): ReferenceLockV1 {
  const normalized = Object.freeze([...entries].map((entry, index) => decodeLockEntry(entry, `referenceLock.entries[${index}]`)).sort((left, right) => left.entryId.localeCompare(right.entryId)));
  if (new Set(normalized.map(entry => entry.entryId)).size !== normalized.length) throw new TypeError("duplicate reference lock entryId");
  const sourceRepo = normalized[0]?.sourceRepo ?? REFERENCE_REPOSITORY_ID;
  const sourceCommit = normalized[0]?.sourceCommit ?? REFERENCE_COMMIT;
  if (sourceRepo !== REFERENCE_REPOSITORY_ID || sourceCommit !== REFERENCE_COMMIT) throw new TypeError("reference lock source mismatch");
  if (normalized.some(entry => entry.sourceRepo !== sourceRepo || entry.sourceCommit !== sourceCommit)) throw new TypeError("reference lock entries are not homogeneous");
  return deepFreeze({ schemaVersion: REFERENCE_LOCK_SCHEMA_VERSION, sourceRepo, sourceCommit, entries: normalized, referenceLockRoot: computeReferenceLockRoot(normalized) });
}

export function decodeReferenceLock(value: unknown, path = "referenceLock"): ReferenceLockV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, itemPath) => {
      if (item !== REFERENCE_LOCK_SCHEMA_VERSION) throw new TypeError(`unsupported reference lock schema at ${itemPath}`);
      return REFERENCE_LOCK_SCHEMA_VERSION;
    },
    sourceRepo: TEXT_DECODER,
    sourceCommit: GIT_DECODER,
    entries: (item, itemPath) => fieldArray(item, decodeLockEntry, itemPath),
    referenceLockRoot: HASH_DECODER,
  }, path);
  const sealed = sealReferenceLock(decoded.entries);
  if (sealed.sourceRepo !== decoded.sourceRepo || sealed.sourceCommit !== decoded.sourceCommit) throw new TypeError("reference lock header mismatch");
  if (sealed.referenceLockRoot !== decoded.referenceLockRoot) throw new TypeError("reference lock root mismatch");
  return sealed;
}

export function deriveReferenceLock(ledger: ReuseLedgerV1): ReferenceLockV1 {
  return sealReferenceLock(ledger.entries.map(entry => ({
    entryId: entry.entryId,
    sourceRepo: entry.sourceRepo,
    sourceCommit: entry.sourceCommit,
    sourcePath: entry.sourcePath,
    sourceBlob: entry.sourceBlob,
    license: "not-copied-until-reviewed",
    allowedDisposition: entry.adoptionMode,
  })));
}

export function cloneLedgerForMutation(ledger: ReuseLedgerV1): ReuseLedgerV1 {
  return decodeReuseLedger(JSON.parse(JSON.stringify(ledger)));
}

export function entryIdFor(sourcePath: string, symbol: string): string {
  return `reuse.${sourcePath.replace(/[^a-z0-9]+/gi, ".").replace(/^\.|\.$/g, "")}.${symbol.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}
