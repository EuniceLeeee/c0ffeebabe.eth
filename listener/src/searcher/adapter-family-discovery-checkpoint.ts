import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { DiscoverySourceKind } from
  "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";

const CHECKPOINT_FORMAT = "adapter-family-discovery-checkpoint-v1";
const EVENT_SOURCE_IDS: ReadonlySet<DiscoverySourceKind> = new Set([
  "factory-log",
  "landed-log",
  "observed-call",
]);

export interface AdapterFamilyDiscoveryCheckpointBinding {
  readonly chainId: string;
  readonly catalogHash: string;
  readonly sourceRegistryFingerprint: string;
}

export type AdapterFamilyDiscoveryCheckpointCoverageAuthority =
  | "append-only"
  | "contiguous-history";

export interface AdapterFamilyDiscoveryCheckpointCandidateWatermark {
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
  readonly coverageAuthority:
    AdapterFamilyDiscoveryCheckpointCoverageAuthority | "snapshot";
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string | null;
}

export interface AdapterFamilyDiscoveryCheckpointWatermark
  extends Omit<
    AdapterFamilyDiscoveryCheckpointCandidateWatermark,
    "coverageAuthority"
  > {
  readonly coverageAuthority:
    AdapterFamilyDiscoveryCheckpointCoverageAuthority;
}

/** Canonical, serializable durable state. Runtime authority stays opaque. */
export interface AdapterFamilyDiscoveryCheckpointSnapshot
  extends AdapterFamilyDiscoveryCheckpointBinding {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly revision: number;
  readonly source: CanonicalSource;
  readonly watermarks: readonly AdapterFamilyDiscoveryCheckpointWatermark[];
  readonly checkpointFingerprint: string;
}

declare const checkpointAuthorityBrand: unique symbol;
export interface AdapterFamilyDiscoveryCheckpointAuthority {
  readonly [checkpointAuthorityBrand]: true;
}

declare const preparedCheckpointBrand: unique symbol;
export interface PreparedAdapterFamilyDiscoveryCheckpoint {
  readonly [preparedCheckpointBrand]: true;
}

declare const checkpointReceiptBrand: unique symbol;
export interface AdapterFamilyDiscoveryCheckpointReceipt {
  readonly [checkpointReceiptBrand]: true;
}

export interface AdapterFamilyDiscoveryCheckpointCandidateIssuer {
  readonly authority: AdapterFamilyDiscoveryCheckpointAuthority;
  prepare(input: {
    readonly source: CanonicalSource;
    readonly watermarks:
      readonly AdapterFamilyDiscoveryCheckpointCandidateWatermark[];
  }): PreparedAdapterFamilyDiscoveryCheckpoint;
}

export interface AdapterFamilyDiscoveryCheckpointRestartState
  extends AdapterFamilyDiscoveryCheckpointBinding {
  readonly authority: "trusted" | "append-only";
  /** The source is audit evidence only; a restart must not reuse its generation. */
  readonly source: CanonicalSource | null;
  readonly watermarks: readonly AdapterFamilyDiscoveryCheckpointWatermark[];
}

export type AdapterFamilyDiscoveryCheckpointLoadResult =
  | {
    readonly status: "trusted";
    readonly receipt: AdapterFamilyDiscoveryCheckpointReceipt;
    readonly snapshot: AdapterFamilyDiscoveryCheckpointSnapshot;
  }
  | {
    readonly status: "degraded-append-only";
    readonly receipt: AdapterFamilyDiscoveryCheckpointReceipt;
    readonly reason:
      | "invalid-or-mismatched-checkpoint"
      | "canonical-verification-failed"
      | "concurrent-storage-change";
  }
  | {
    readonly status: "empty";
    readonly receipt: AdapterFamilyDiscoveryCheckpointReceipt;
  };

export interface AdapterFamilyDiscoveryCheckpointDurableBackend {
  read(): Promise<string | null>;
  compareAndSwap(input: {
    readonly expectedSerialized: string | null;
    readonly nextSerialized: string;
    /** Runs synchronously after temp fsync and immediately before rename. */
    readonly beforeCommit: () => boolean;
  }): Promise<boolean>;
}

interface PreparedCheckpointRecord {
  readonly authority: AdapterFamilyDiscoveryCheckpointAuthority;
  readonly source: CanonicalSource;
  readonly watermarks: readonly AdapterFamilyDiscoveryCheckpointWatermark[];
}

interface ReceiptRecord {
  readonly authority: AdapterFamilyDiscoveryCheckpointAuthority;
  readonly restart: AdapterFamilyDiscoveryCheckpointRestartState;
  readonly snapshot: AdapterFamilyDiscoveryCheckpointSnapshot | null;
}

interface ExpectedMatrixEntry {
  readonly familyId: FamilyId;
  readonly sourceId: DiscoverySourceKind;
}

const preparedCheckpointRecords = new WeakMap<
  object,
  PreparedCheckpointRecord
>();
const checkpointReceiptRecords = new WeakMap<object, ReceiptRecord>();

/**
 * Durable, issuer-owned discovery continuity store. It does not grant
 * point-in-time inventory closure or catalog deletion authority.
 */
export class AdapterFamilyDiscoveryCheckpointStore {
  readonly authority: AdapterFamilyDiscoveryCheckpointAuthority;
  readonly #binding: AdapterFamilyDiscoveryCheckpointBinding;
  readonly #expectedMatrix: readonly ExpectedMatrixEntry[];
  readonly #backend: AdapterFamilyDiscoveryCheckpointDurableBackend;
  readonly #verifyCanonicalCheckpoint: (
    snapshot: AdapterFamilyDiscoveryCheckpointSnapshot,
  ) => void | Promise<void>;
  readonly #assertGenerationCurrent: (source: CanonicalSource) => void;
  #candidateIssuer: AdapterFamilyDiscoveryCheckpointCandidateIssuer | null;
  #loaded = false;
  #loading = false;
  #storageRaw: string | null = null;
  #committed: AdapterFamilyDiscoveryCheckpointReceipt | null = null;

  constructor(input: {
    readonly catalog: Pick<FamilyCapabilityCatalog, "catalogHash" | "listAll">;
    readonly chainId: string;
    readonly sourceRegistryFingerprint: string;
    readonly backend: AdapterFamilyDiscoveryCheckpointDurableBackend;
    /** Verify the source and every distinct non-null watermark block/hash. */
    readonly verifyCanonicalCheckpoint: (
      snapshot: AdapterFamilyDiscoveryCheckpointSnapshot,
    ) => void | Promise<void>;
    readonly assertGenerationCurrent: (source: CanonicalSource) => void;
  }) {
    if (
      typeof input.backend?.read !== "function" ||
      typeof input.backend?.compareAndSwap !== "function"
    ) {
      throw new Error("discovery checkpoint requires a durable CAS backend");
    }
    if (
      typeof input.verifyCanonicalCheckpoint !== "function" ||
      typeof input.assertGenerationCurrent !== "function"
    ) {
      throw new Error(
        "discovery checkpoint requires fixed canonical and generation gates",
      );
    }
    this.#binding = freezeBinding({
      chainId: input.chainId,
      catalogHash: input.catalog.catalogHash,
      sourceRegistryFingerprint: input.sourceRegistryFingerprint,
    });
    this.#expectedMatrix = expectedMatrix(input.catalog);
    this.#backend = input.backend;
    this.#verifyCanonicalCheckpoint = input.verifyCanonicalCheckpoint;
    this.#assertGenerationCurrent = input.assertGenerationCurrent;
    this.authority = Object.freeze({}) as
      AdapterFamilyDiscoveryCheckpointAuthority;
    this.#candidateIssuer = Object.freeze({
      authority: this.authority,
      prepare: (candidate: {
        readonly source: CanonicalSource;
        readonly watermarks:
          readonly AdapterFamilyDiscoveryCheckpointCandidateWatermark[];
      }): PreparedAdapterFamilyDiscoveryCheckpoint => {
        const source = freezeSource(candidate.source);
        const watermarks = validateAndFreezeMatrix(
          candidate.watermarks,
          this.#expectedMatrix,
          source,
        );
        const prepared = Object.freeze({}) as
          PreparedAdapterFamilyDiscoveryCheckpoint;
        preparedCheckpointRecords.set(prepared, Object.freeze({
          authority: this.authority,
          source,
          watermarks,
        }));
        return prepared;
      },
    });
  }

  /** One composition owner may check out the long-lived ingress capability. */
  takeCandidateIssuer(): AdapterFamilyDiscoveryCheckpointCandidateIssuer {
    const issuer = this.#candidateIssuer;
    if (issuer === null) {
      throw new Error("discovery checkpoint candidate issuer was already taken");
    }
    this.#candidateIssuer = null;
    return issuer;
  }

  capture(): AdapterFamilyDiscoveryCheckpointReceipt | null {
    return this.#committed;
  }

  binding(): AdapterFamilyDiscoveryCheckpointBinding {
    return this.#binding;
  }

  checkpointSnapshot(
    receipt: AdapterFamilyDiscoveryCheckpointReceipt,
  ): AdapterFamilyDiscoveryCheckpointSnapshot | null {
    return this.#resolveReceipt(receipt).snapshot;
  }

  restartState(
    receipt: AdapterFamilyDiscoveryCheckpointReceipt,
  ): AdapterFamilyDiscoveryCheckpointRestartState {
    return this.#resolveReceipt(receipt).restart;
  }

  async loadForRestart(): Promise<AdapterFamilyDiscoveryCheckpointLoadResult> {
    if (this.#loading) {
      throw new Error("discovery checkpoint store is already loading");
    }
    this.#loading = true;
    this.#loaded = false;
    try {
      const raw = await this.#backend.read();
      this.#storageRaw = raw;
      this.#committed = null;
      if (raw === null) {
        this.#loaded = true;
        return Object.freeze({
          status: "empty" as const,
          receipt: this.#issueAppendOnlyReceipt(),
        });
      }

      let snapshot: AdapterFamilyDiscoveryCheckpointSnapshot;
      try {
        snapshot = parseCheckpoint(raw);
        assertSameBinding(snapshot, this.#binding);
        const normalized = validateAndFreezeMatrix(
          snapshot.watermarks,
          this.#expectedMatrix,
          snapshot.source,
        );
        if (!sameWatermarkArray(snapshot.watermarks, normalized)) {
          throw new Error("discovery checkpoint matrix is not canonical");
        }
        if (serializeCheckpoint(snapshot) !== raw) {
          throw new Error("discovery checkpoint is not canonically serialized");
        }
      } catch {
        this.#loaded = true;
        return Object.freeze({
          status: "degraded-append-only" as const,
          receipt: this.#issueAppendOnlyReceipt(),
          reason: "invalid-or-mismatched-checkpoint" as const,
        });
      }

      try {
        await this.#verifyCanonicalCheckpoint(snapshot);
      } catch {
        this.#loaded = true;
        return Object.freeze({
          status: "degraded-append-only" as const,
          receipt: this.#issueAppendOnlyReceipt(),
          reason: "canonical-verification-failed" as const,
        });
      }

      const afterVerify = await this.#backend.read();
      if (afterVerify !== raw) {
        // Keep the verified first read as the CAS token. Rebasing onto the
        // unverified concurrent bytes would let an expected:null commit
        // overwrite the winning writer with a new revision-1 checkpoint.
        this.#loaded = true;
        return Object.freeze({
          status: "degraded-append-only" as const,
          receipt: this.#issueAppendOnlyReceipt(),
          reason: "concurrent-storage-change" as const,
        });
      }

      const receipt = this.#issueTrustedReceipt(snapshot);
      this.#committed = receipt;
      this.#loaded = true;
      return Object.freeze({
        status: "trusted" as const,
        receipt,
        snapshot,
      });
    } finally {
      this.#loading = false;
    }
  }

  async compareAndCommit(input: {
    readonly expected: AdapterFamilyDiscoveryCheckpointReceipt | null;
    readonly staged: PreparedAdapterFamilyDiscoveryCheckpoint;
  }): Promise<boolean> {
    if (!this.#loaded) {
      throw new Error("discovery checkpoint store must load before commit");
    }
    const prepared = preparedCheckpointRecords.get(input.staged);
    if (prepared === undefined || prepared.authority !== this.authority) {
      throw new Error("checkpoint candidate is forged or foreign");
    }
    preparedCheckpointRecords.delete(input.staged);
    if (this.#committed !== input.expected) return false;

    const previous = input.expected === null
      ? null
      : this.#resolveReceipt(input.expected).snapshot;
    if (input.expected !== null && previous === null) {
      throw new Error("append-only restart receipt cannot be a CAS incumbent");
    }
    if (previous !== null) {
      assertSourceSuccessor(previous.source, prepared.source);
    }
    const snapshot = createSnapshot({
      binding: this.#binding,
      revision: (previous?.revision ?? 0) + 1,
      source: prepared.source,
      watermarks: prepared.watermarks,
    });
    const serialized = serializeCheckpoint(snapshot);

    await this.#verifyCanonicalCheckpoint(snapshot);
    if (this.#committed !== input.expected) return false;
    const committed = await this.#backend.compareAndSwap({
      expectedSerialized: this.#storageRaw,
      nextSerialized: serialized,
      beforeCommit: () => {
        if (this.#committed !== input.expected) return false;
        this.#assertGenerationCurrent(snapshot.source);
        return this.#committed === input.expected;
      },
    });
    if (!committed) return false;
    const receipt = this.#issueTrustedReceipt(snapshot);
    this.#storageRaw = serialized;
    this.#committed = receipt;
    return true;
  }

  #resolveReceipt(
    receipt: AdapterFamilyDiscoveryCheckpointReceipt,
  ): ReceiptRecord {
    const record = checkpointReceiptRecords.get(receipt);
    if (record === undefined || record.authority !== this.authority) {
      throw new Error("checkpoint receipt is forged or foreign");
    }
    return record;
  }

  #issueTrustedReceipt(
    snapshot: AdapterFamilyDiscoveryCheckpointSnapshot,
  ): AdapterFamilyDiscoveryCheckpointReceipt {
    const receipt = Object.freeze({}) as
      AdapterFamilyDiscoveryCheckpointReceipt;
    checkpointReceiptRecords.set(receipt, Object.freeze({
      authority: this.authority,
      snapshot,
      restart: freezeRestartState({
        ...this.#binding,
        authority: "trusted",
        source: snapshot.source,
        watermarks: snapshot.watermarks,
      }),
    }));
    return receipt;
  }

  #issueAppendOnlyReceipt(): AdapterFamilyDiscoveryCheckpointReceipt {
    const receipt = Object.freeze({}) as
      AdapterFamilyDiscoveryCheckpointReceipt;
    checkpointReceiptRecords.set(receipt, Object.freeze({
      authority: this.authority,
      snapshot: null,
      restart: freezeRestartState({
        ...this.#binding,
        authority: "append-only",
        source: null,
        watermarks: this.#expectedMatrix.map((entry) => Object.freeze({
          ...entry,
          coverageAuthority: "append-only" as const,
          completeThroughBlock: -1,
          completeThroughHash: null,
        })),
      }),
    }));
    return receipt;
  }
}

/**
 * Single-file durable backend. A sidecar exclusive lock serializes writers;
 * exact serialized-byte comparison supplies the CAS predicate.
 */
export class FileAdapterFamilyDiscoveryCheckpointBackend
  implements AdapterFamilyDiscoveryCheckpointDurableBackend {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lockRetryMs: number;
  readonly #lockAttempts: number;

  constructor(input: {
    readonly path: string;
    readonly lockRetryMs?: number;
    readonly lockAttempts?: number;
  }) {
    if (!isAbsolute(input.path)) {
      throw new Error("discovery checkpoint path must be absolute");
    }
    if (
      input.lockRetryMs !== undefined &&
      (!Number.isSafeInteger(input.lockRetryMs) || input.lockRetryMs < 0)
    ) {
      throw new Error("checkpoint lock retry must be a non-negative integer");
    }
    if (
      input.lockAttempts !== undefined &&
      (!Number.isSafeInteger(input.lockAttempts) || input.lockAttempts < 1)
    ) {
      throw new Error("checkpoint lock attempts must be positive");
    }
    this.#path = input.path;
    this.#lockPath = `${input.path}.lock`;
    this.#lockRetryMs = input.lockRetryMs ?? 5;
    this.#lockAttempts = input.lockAttempts ?? 200;
  }

  read(): Promise<string | null> {
    return readOptional(this.#path);
  }

  async compareAndSwap(input: {
    readonly expectedSerialized: string | null;
    readonly nextSerialized: string;
    readonly beforeCommit: () => boolean;
  }): Promise<boolean> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const lock = await this.#acquireLock();
    let temporary: string | null = null;
    try {
      const current = await readOptional(this.#path);
      if (current !== input.expectedSerialized) return false;
      temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      const output = await open(temporary, "wx", 0o600);
      try {
        await output.writeFile(input.nextSerialized, "utf8");
        await output.sync();
      } finally {
        await output.close();
      }
      if (!input.beforeCommit()) return false;
      // Keep the fence/pointer check and rename in one synchronous
      // linearization window; an awaited rename would permit supersede after
      // the fence but before the filesystem commit.
      renameSync(temporary, this.#path);
      temporary = null;
      await syncDirectory(dirname(this.#path));
      return true;
    } finally {
      if (temporary !== null) await unlinkOptional(temporary);
      await lock.close();
      await unlinkOptional(this.#lockPath);
    }
  }

  async #acquireLock(): Promise<FileHandle> {
    for (let attempt = 0; attempt < this.#lockAttempts; attempt += 1) {
      let lock: FileHandle | null = null;
      try {
        lock = await open(this.#lockPath, "wx", 0o600);
        await lock.writeFile(`${process.pid}\n`, "utf8");
        await lock.sync();
        return lock;
      } catch (error) {
        if (lock !== null) {
          await lock.close();
          await unlinkOptional(this.#lockPath);
        }
        if (!hasCode(error, "EEXIST")) throw error;
        if (attempt + 1 === this.#lockAttempts) {
          throw new Error("discovery checkpoint CAS lock is unavailable");
        }
        await delay(this.#lockRetryMs);
      }
    }
    throw new Error("discovery checkpoint CAS lock is unavailable");
  }
}

function expectedMatrix(
  catalog: Pick<FamilyCapabilityCatalog, "catalogHash" | "listAll">,
): readonly ExpectedMatrixEntry[] {
  canonicalId(catalog.catalogHash, "Family catalog hash");
  const byKey = new Map<string, ExpectedMatrixEntry>();
  for (const family of catalog.listAll()) {
    if (!("discovery" in family.plugin)) continue;
    const familyId = canonicalId(
      family.plugin.manifest.familyId,
      "Family id",
    ) as FamilyId;
    for (const rawSourceId of new Set(family.plugin.discovery.sources)) {
      const sourceId = discoverySourceId(rawSourceId);
      const key = matrixKey(familyId, sourceId);
      if (byKey.has(key)) {
        throw new Error(`duplicate discovery checkpoint matrix row ${key}`);
      }
      byKey.set(key, Object.freeze({ familyId, sourceId }));
    }
  }
  return Object.freeze([...byKey.values()].sort(compareMatrixEntry));
}

function validateAndFreezeMatrix(
  rows: readonly AdapterFamilyDiscoveryCheckpointCandidateWatermark[],
  expected: readonly ExpectedMatrixEntry[],
  source: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointWatermark[] {
  if (!Array.isArray(rows)) {
    throw new Error("discovery checkpoint watermarks must be an array");
  }
  const expectedKeys = new Set(expected.map((entry) =>
    matrixKey(entry.familyId, entry.sourceId)
  ));
  const seen = new Set<string>();
  const hashesByBlock = new Map<number, string>();
  const normalized = rows.map((row) => {
    const familyId = canonicalId(row.familyId, "watermark Family id") as FamilyId;
    const sourceId = discoverySourceId(row.sourceId);
    const key = matrixKey(familyId, sourceId);
    if (!expectedKeys.has(key)) {
      throw new Error(`unknown discovery checkpoint matrix row ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`duplicate discovery checkpoint matrix row ${key}`);
    }
    seen.add(key);
    if (
      row.coverageAuthority !== "append-only" &&
      row.coverageAuthority !== "contiguous-history"
    ) {
      throw new Error("invalid discovery checkpoint coverage authority");
    }
    if (
      row.coverageAuthority === "contiguous-history" &&
      !EVENT_SOURCE_IDS.has(sourceId)
    ) {
      throw new Error(`${sourceId} cannot restore contiguous history`);
    }
    if (
      !Number.isSafeInteger(row.completeThroughBlock) ||
      row.completeThroughBlock < -1 ||
      row.completeThroughBlock > source.number
    ) {
      throw new Error("invalid discovery checkpoint watermark block");
    }
    if (
      (row.completeThroughBlock === -1) !==
        (row.completeThroughHash === null)
    ) {
      throw new Error("checkpoint hash must be null iff watermark is -1");
    }
    if (
      row.coverageAuthority === "contiguous-history" &&
      row.completeThroughBlock < 0
    ) {
      throw new Error("contiguous history requires a canonical block anchor");
    }
    const hash = row.completeThroughHash === null
      ? null
      : canonicalHash(row.completeThroughHash, "watermark hash");
    if (
      row.completeThroughBlock === source.number &&
      hash !== source.hash
    ) {
      throw new Error("watermark hash does not match checkpoint source");
    }
    if (hash !== null) {
      const incumbent = hashesByBlock.get(row.completeThroughBlock);
      if (incumbent !== undefined && incumbent !== hash) {
        throw new Error("checkpoint watermarks disagree at one block height");
      }
      hashesByBlock.set(row.completeThroughBlock, hash);
    }
    return Object.freeze({
      familyId,
      sourceId,
      coverageAuthority: row.coverageAuthority,
      completeThroughBlock: row.completeThroughBlock,
      completeThroughHash: hash,
    });
  });
  if (seen.size !== expectedKeys.size) {
    throw new Error("discovery checkpoint is missing matrix rows");
  }
  normalized.sort(compareMatrixEntry);
  return Object.freeze(normalized);
}

function createSnapshot(input: {
  readonly binding: AdapterFamilyDiscoveryCheckpointBinding;
  readonly revision: number;
  readonly source: CanonicalSource;
  readonly watermarks: readonly AdapterFamilyDiscoveryCheckpointWatermark[];
}): AdapterFamilyDiscoveryCheckpointSnapshot {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error("invalid discovery checkpoint revision");
  }
  const projection = checkpointProjection({
    ...input.binding,
    format: CHECKPOINT_FORMAT,
    revision: input.revision,
    source: input.source,
    watermarks: input.watermarks,
  });
  return Object.freeze({
    format: CHECKPOINT_FORMAT,
    revision: input.revision,
    ...input.binding,
    source: input.source,
    watermarks: input.watermarks,
    checkpointFingerprint: hashCanonical(projection),
  });
}

function parseCheckpoint(raw: string): AdapterFamilyDiscoveryCheckpointSnapshot {
  const parsed: unknown = JSON.parse(raw);
  assertRecord(parsed, "discovery checkpoint");
  assertExactKeys(parsed, [
    "catalogHash",
    "chainId",
    "checkpointFingerprint",
    "format",
    "revision",
    "source",
    "sourceRegistryFingerprint",
    "watermarks",
  ], "discovery checkpoint");
  if (parsed.format !== CHECKPOINT_FORMAT) {
    throw new Error("unsupported discovery checkpoint format");
  }
  if (!Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 1) {
    throw new Error("invalid discovery checkpoint revision");
  }
  const binding = freezeBinding({
    chainId: parsed.chainId as string,
    catalogHash: parsed.catalogHash as string,
    sourceRegistryFingerprint: parsed.sourceRegistryFingerprint as string,
  });
  const source = parseSource(parsed.source);
  if (!Array.isArray(parsed.watermarks)) {
    throw new Error("discovery checkpoint watermarks must be an array");
  }
  const watermarks = Object.freeze(parsed.watermarks.map((rawRow) => {
    assertRecord(rawRow, "discovery checkpoint watermark");
    assertExactKeys(rawRow, [
      "completeThroughBlock",
      "completeThroughHash",
      "coverageAuthority",
      "familyId",
      "sourceId",
    ], "discovery checkpoint watermark");
    return Object.freeze({
      familyId: rawRow.familyId as FamilyId,
      sourceId: rawRow.sourceId as DiscoverySourceKind,
      coverageAuthority: rawRow.coverageAuthority as
        AdapterFamilyDiscoveryCheckpointCoverageAuthority,
      completeThroughBlock: rawRow.completeThroughBlock as number,
      completeThroughHash: rawRow.completeThroughHash as string | null,
    });
  }));
  const snapshot = Object.freeze({
    format: CHECKPOINT_FORMAT,
    revision: Number(parsed.revision),
    ...binding,
    source,
    watermarks,
    checkpointFingerprint: canonicalFingerprint(
      parsed.checkpointFingerprint,
      "checkpoint fingerprint",
    ),
  });
  if (
    snapshot.checkpointFingerprint !==
      hashCanonical(checkpointProjection(snapshot))
  ) {
    throw new Error("discovery checkpoint fingerprint mismatch");
  }
  return snapshot;
}

function checkpointProjection(input: {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly revision: number;
  readonly chainId: string;
  readonly catalogHash: string;
  readonly sourceRegistryFingerprint: string;
  readonly source: CanonicalSource;
  readonly watermarks: readonly AdapterFamilyDiscoveryCheckpointWatermark[];
}): CanonicalValue {
  return {
    format: input.format,
    revision: input.revision,
    chainId: input.chainId,
    catalogHash: input.catalogHash,
    sourceRegistryFingerprint: input.sourceRegistryFingerprint,
    source: {
      number: input.source.number,
      hash: input.source.hash,
      generation: input.source.generation,
    },
    watermarks: input.watermarks.map((row) => ({
      familyId: row.familyId,
      sourceId: row.sourceId,
      coverageAuthority: row.coverageAuthority,
      completeThroughBlock: row.completeThroughBlock,
      completeThroughHash: row.completeThroughHash,
    })),
  };
}

function serializeCheckpoint(
  snapshot: AdapterFamilyDiscoveryCheckpointSnapshot,
): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function freezeBinding(
  input: AdapterFamilyDiscoveryCheckpointBinding,
): AdapterFamilyDiscoveryCheckpointBinding {
  return Object.freeze({
    chainId: canonicalChainId(input.chainId),
    catalogHash: canonicalId(input.catalogHash, "Family catalog hash"),
    sourceRegistryFingerprint: canonicalId(
      input.sourceRegistryFingerprint,
      "source registry fingerprint",
    ),
  });
}

function freezeRestartState(
  input: AdapterFamilyDiscoveryCheckpointRestartState,
): AdapterFamilyDiscoveryCheckpointRestartState {
  return Object.freeze({
    chainId: input.chainId,
    catalogHash: input.catalogHash,
    sourceRegistryFingerprint: input.sourceRegistryFingerprint,
    authority: input.authority,
    source: input.source,
    watermarks: Object.freeze([...input.watermarks]),
  });
}

function assertSameBinding(
  snapshot: AdapterFamilyDiscoveryCheckpointBinding,
  expected: AdapterFamilyDiscoveryCheckpointBinding,
): void {
  if (
    snapshot.chainId !== expected.chainId ||
    snapshot.catalogHash !== expected.catalogHash ||
    snapshot.sourceRegistryFingerprint !== expected.sourceRegistryFingerprint
  ) {
    throw new Error("discovery checkpoint binding mismatch");
  }
}

function assertSourceSuccessor(
  previous: CanonicalSource,
  current: CanonicalSource,
): void {
  if (current.number < previous.number) {
    throw new Error("checkpoint source moved backwards");
  }
  if (current.number === previous.number && current.hash !== previous.hash) {
    throw new Error("same-height checkpoint source hash changed");
  }
}

function freezeSource(source: CanonicalSource): CanonicalSource {
  if (!Number.isSafeInteger(source.number) || source.number < 0) {
    throw new Error("invalid discovery checkpoint source block");
  }
  if (!Number.isSafeInteger(source.generation) || source.generation < 0) {
    throw new Error("invalid discovery checkpoint source generation");
  }
  return Object.freeze({
    number: source.number,
    hash: canonicalHash(source.hash, "checkpoint source hash"),
    generation: source.generation,
  });
}

function parseSource(value: unknown): CanonicalSource {
  assertRecord(value, "checkpoint source");
  assertExactKeys(value, ["generation", "hash", "number"], "checkpoint source");
  return freezeSource({
    number: value.number as number,
    hash: value.hash as string,
    generation: value.generation as number,
  });
}

function canonicalChainId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("invalid discovery checkpoint chain id");
  }
  const canonical = BigInt(value).toString();
  if (canonical !== value) {
    throw new Error("discovery checkpoint chain id is not canonical");
  }
  return canonical;
}

function canonicalHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a canonical 32-byte hash`);
  }
  return value.toLowerCase();
}

function canonicalFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a canonical content fingerprint`);
  }
  return value.toLowerCase();
}

function canonicalId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function discoverySourceId(value: unknown): DiscoverySourceKind {
  if (
    value !== "factory-log" &&
    value !== "landed-log" &&
    value !== "observed-call" &&
    value !== "address-surface" &&
    value !== "canonical-registry"
  ) {
    throw new Error(`unknown discovery source ${String(value)}`);
  }
  return value;
}

function matrixKey(familyId: FamilyId, sourceId: DiscoverySourceKind): string {
  return JSON.stringify([familyId, sourceId]);
}

function compareMatrixEntry(
  left: ExpectedMatrixEntry,
  right: ExpectedMatrixEntry,
): number {
  return left.familyId.localeCompare(right.familyId) ||
    left.sourceId.localeCompare(right.sourceId);
}

function sameWatermarkArray(
  left: readonly AdapterFamilyDiscoveryCheckpointWatermark[],
  right: readonly AdapterFamilyDiscoveryCheckpointWatermark[],
): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index];
    return other !== undefined &&
      row.familyId === other.familyId &&
      row.sourceId === other.sourceId &&
      row.coverageAuthority === other.coverageAuthority &&
      row.completeThroughBlock === other.completeThroughBlock &&
      row.completeThroughHash === other.completeThroughHash;
  });
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function unlinkOptional(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: FileHandle | null = null;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    await directory?.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { readonly code?: unknown }).code === code;
}
