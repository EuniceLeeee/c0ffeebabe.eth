import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";

/**
 * Durable universe-rebuild checkpoint (adversarial audit §1-§4). Three
 * durable states only:
 * - verifiedMemos: cross-rebuild reusable Family + InstanceKey proofs;
 * - inProgressRun: the single unfinished rebuild at one fixed cutoff;
 * - readyGeneration: the last complete usable Graph/catalog snapshot.
 * No long-term raw tx inbox, no recovery from progress counters, no
 * permanent candidate journal.
 */

export interface DurableVerifiedMemo {
  readonly familyCandidateKey: string;
  readonly familyInstanceKey: string;
  readonly familyId: string;
  readonly candidateKey: string;
  readonly instanceKey: string;
  /** Static candidate identity only; no swapCount/lastSwapBlock etc. */
  readonly candidateFingerprint: string;
  /** Per-Family definition hash; never the global catalog hash. */
  readonly familyDefinitionHash: string;
  readonly validity: {
    readonly policy: "immutable-code" | "dependency-proof";
    readonly authorityFingerprint: string;
    readonly proofSource: { readonly number: number; readonly hash: string };
  };
  readonly verifiedIdentity: unknown;
  readonly compiledDescriptor: unknown;
  readonly staticProjection: unknown;
  readonly evidenceFingerprint: string;
  readonly memoFingerprint: string;
}

export interface RetryableAttempt {
  readonly status: "retryable";
  readonly familyCandidateKey: string;
  readonly familyId: string;
  /** Enough to retry one instance; never the full raw tx. */
  readonly candidateSnapshot: unknown;
  readonly evidenceRef?: {
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly txHash?: string;
    readonly logIndex?: number;
  };
  readonly stage:
    | "nomination"
    | "identity"
    | "materialization"
    | "projection";
  readonly failureCode: "rpc" | "deadline" | "aborted" | "resource-limited";
  readonly requestFingerprint?: string;
  readonly reasonCode: string;
  readonly attemptCount: number;
  readonly lastAttemptAt: string;
}

export type RunOutcome =
  | {
    readonly status: "verified";
    readonly familyCandidateKey: string;
    readonly familyInstanceKey: string;
    readonly memoFingerprint: string;
  }
  | {
    readonly status: "terminal-rejected";
    readonly familyCandidateKey: string;
    readonly reasonCode: string;
    readonly evidenceFingerprint: string;
  }
  | RetryableAttempt;

export interface InProgressUniverseRun {
  readonly runId: string;
  readonly cutoff: CanonicalSource;
  readonly fromBlock: number;
  readonly universeHash: string;
  readonly candidateSetHash: string;
  readonly candidateCount: number;
  /** Compact exact partition; sufficient to resume without rescanning. */
  readonly candidatesByKey: Readonly<Record<string, unknown>>;
  /** Swap range fully scanned; never advances appliedThrough by itself. */
  readonly observedThrough: { readonly number: number; readonly hash: string };
  /**
   * Null until the completed exact partition is promoted.  An in-progress
   * run must never advertise an applied cursor merely because observation or
   * some instance attestations finished.
   */
  readonly appliedThrough: null;
  readonly outcomesByCandidateKey: Readonly<Record<string, RunOutcome>>;
}

export interface ReadyUniverseGeneration {
  readonly generation: number;
  readonly cutoff: CanonicalSource;
  readonly universeRange: {
    readonly fromBlock: number;
    readonly toBlock: number;
  };
  readonly universeHash: string;
  readonly catalogHash: string;
  readonly activeInstanceKeys: readonly string[];
  readonly publicationSetHash: string;
  readonly observedThrough: { readonly number: number; readonly hash: string };
  readonly appliedThrough: { readonly number: number; readonly hash: string };
  readonly sourceCoverage: readonly {
    readonly familyId: string;
    readonly sourceId: string;
    readonly completeThroughBlock: number;
    readonly completeThroughHash: string | null;
  }[];
  readonly graphSnapshot: unknown;
  readonly graphHash: string;
  readonly catalogSnapshot: unknown;
}

export interface AttestationCheckpointWrite {
  readonly outcome: RunOutcome;
  /** Present exactly when a verified outcome introduces/replaces its memo. */
  readonly memo?: DurableVerifiedMemo;
}

export interface StartupCheckpointEnvelope {
  readonly revision: number;
  readonly verifiedMemos: Readonly<Record<string, DurableVerifiedMemo>>;
  readonly inProgressRun: InProgressUniverseRun | null;
  readonly readyGeneration: ReadyUniverseGeneration | null;
  readonly checkpointFingerprint: string;
}

/** Deterministic canonical JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("checkpoint canonical value number must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(
      "unsupported checkpoint canonical value type: " + typeof value,
    );
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("checkpoint canonical values must be plain records");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(record[key])
  ).join(",") + "}";
}

export function envelopeFingerprint(
  envelope: Omit<StartupCheckpointEnvelope, "checkpointFingerprint">,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      revision: envelope.revision,
      verifiedMemos: envelope.verifiedMemos,
      inProgressRun: envelope.inProgressRun,
      readyGeneration: envelope.readyGeneration,
    }))
    .digest("hex");
}

function parseEnvelope(raw: string): StartupCheckpointEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      "universe rebuild checkpoint is not valid JSON: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record !== "object" || record === null) {
    throw new Error("universe rebuild checkpoint must be an object");
  }
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    throw new Error("universe rebuild checkpoint revision is invalid");
  }
  if (
    typeof record.verifiedMemos !== "object" ||
    record.verifiedMemos === null ||
    typeof record.checkpointFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.checkpointFingerprint)
  ) {
    throw new Error("universe rebuild checkpoint fields are invalid");
  }
  const envelope = record as unknown as StartupCheckpointEnvelope;
  if (
    envelopeFingerprint({
      revision: envelope.revision,
      verifiedMemos: envelope.verifiedMemos,
      inProgressRun: envelope.inProgressRun ?? null,
      readyGeneration: envelope.readyGeneration ?? null,
    }) !== envelope.checkpointFingerprint
  ) {
    throw new Error("universe rebuild checkpoint fingerprint mismatch");
  }
  return Object.freeze(envelope);
}

/**
 * Single-writer file-backed CAS store. Every mutation is read-verify-apply
 * with an expected revision, temp-file + fsync + atomic rename + directory
 * fsync, and a sidecar lock file (matching the discovery checkpoint
 * backend). Corruption, tampering or a CAS conflict fail closed (throw);
 * a partial write can never become the incumbent envelope.
 */
export class UniverseRebuildCheckpointStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lockWaitTimeoutMs: number;
  readonly #lockRetryMs: number;
  #mutex: Promise<void> = Promise.resolve();

  constructor(input: {
    readonly path: string;
    /** Bound for a different process's short atomic-write critical section. */
    readonly lockWaitTimeoutMs?: number;
    readonly lockRetryMs?: number;
  }) {
    this.#path = input.path;
    this.#lockPath = input.path + ".lock";
    this.#lockWaitTimeoutMs = input.lockWaitTimeoutMs ?? 5_000;
    this.#lockRetryMs = input.lockRetryMs ?? 10;
    if (!Number.isSafeInteger(this.#lockWaitTimeoutMs) || this.#lockWaitTimeoutMs < 1) {
      throw new Error("universe rebuild checkpoint lock wait must be positive");
    }
    if (!Number.isSafeInteger(this.#lockRetryMs) || this.#lockRetryMs < 1) {
      throw new Error("universe rebuild checkpoint lock retry must be positive");
    }
  }

  async load(): Promise<StartupCheckpointEnvelope | null> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code === "ENOENT") return null;
      throw error;
    }
    if (raw.trim().length === 0) return null;
    return parseEnvelope(raw);
  }

  #serialize(envelope: StartupCheckpointEnvelope): string {
    return JSON.stringify(envelope, null, 2) + "\n";
  }

  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutex.then(fn, fn);
    this.#mutex = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Sidecar lock with stale-PID recovery: a crashed/killed writer leaves
   * the lock file behind, and the next writer must reclaim it once the
   * recorded holder PID is provably dead (ESRCH). A live holder is allowed
   * to finish its bounded atomic write so the startup writer and an explicit
   * single-pool probe remain one serialized writer instead of killing each
   * other. A holder that exceeds the bound still fails closed.
   */
  async #acquireLock(): Promise<void> {
    const deadline = Date.now() + this.#lockWaitTimeoutMs;
    while (true) {
      try {
        await writeFile(this.#lockPath, String(process.pid) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code !== "EEXIST") throw error;
      }
      let holderPid: number | null = null;
      try {
        const content = await readFile(this.#lockPath, "utf8");
        const parsed = Number(content.trim());
        holderPid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      } catch {
        holderPid = null;
      }
      let holderAlive = false;
      if (holderPid !== null) {
        try {
          process.kill(holderPid, 0);
          holderAlive = true;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
          if (code !== "ESRCH") throw error;
        }
      }
      if (!holderAlive) {
        await unlink(this.#lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "universe rebuild checkpoint CAS lock is held by writer " +
            holderPid,
        );
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(this.#lockRetryMs, deadline - Date.now()))
      );
    }
  }

  async #cas(
    expectedRevision: number | undefined,
    mutate: (current: StartupCheckpointEnvelope | null) => StartupCheckpointEnvelope,
  ): Promise<StartupCheckpointEnvelope> {
    return this.#withLock(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await this.#acquireLock();
      try {
        const current = await this.load();
        if (
          expectedRevision !== undefined &&
          (current?.revision ?? 0) !== expectedRevision
        ) {
          throw new Error(
            "universe rebuild checkpoint CAS conflict: revision " +
              (current?.revision ?? 0) + " != expected " + expectedRevision,
          );
        }
        const next = mutate(current);
        const sealed = Object.freeze({
          ...next,
          checkpointFingerprint: envelopeFingerprint({
            revision: next.revision,
            verifiedMemos: next.verifiedMemos,
            inProgressRun: next.inProgressRun,
            readyGeneration: next.readyGeneration,
          }),
        });
        const serialized = this.#serialize(sealed);
        const tmp = this.#path + ".tmp." + process.pid;
        await writeFile(tmp, serialized, { mode: 0o600 });
        const fs = await import("node:fs/promises");
        const file = await fs.open(tmp, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tmp, this.#path);
        await fs.open(dirname(this.#path), "r").then(async (dir) => {
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }).catch(() => {
          // Directory fsync is best-effort on platforms that refuse it.
        });
        return sealed;
      } finally {
        await import("node:fs/promises").then((fs) =>
          fs.unlink(this.#lockPath).catch(() => undefined)
        );
      }
    });
  }

  /** Append a batch of run outcomes (single CAS; never advances ready). */
  async casMergeRunOutcomes(
    runId: string,
    outcomes: readonly RunOutcome[],
  ): Promise<StartupCheckpointEnvelope> {
    return this.casMergeAttestationWrites(
      runId,
      outcomes.map((outcome) => Object.freeze({ outcome })),
    );
  }

  /**
   * Atomically merge attestation outcomes and their verified memos.  A
   * verified outcome can never become durable before the memo it names; a
   * crash therefore leaves either the old envelope or the complete pair.
   */
  async casMergeAttestationWrites(
    runId: string,
    writes: readonly AttestationCheckpointWrite[],
  ): Promise<StartupCheckpointEnvelope> {
    if (writes.length === 0) {
      throw new Error("universe rebuild checkpoint: empty outcome batch");
    }
    return this.#cas(undefined, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const run = base.inProgressRun;
      if (run === null || run.runId !== runId) {
        throw new Error(
          "universe rebuild checkpoint: no matching in-progress run " + runId,
        );
      }
      const merged: Record<string, RunOutcome> = {
        ...run.outcomesByCandidateKey,
      };
      const memos: Record<string, DurableVerifiedMemo> = {
        ...base.verifiedMemos,
      };
      for (const write of writes) {
        const { outcome, memo } = write;
        if (memo !== undefined) {
          assertMemoMatchesVerifiedOutcome(memo, outcome);
          memos[memo.familyCandidateKey] = Object.freeze(memo);
        }
        if (outcome.status === "verified") {
          const durableMemo = memos[outcome.familyCandidateKey];
          if (durableMemo === undefined) {
            throw new Error(
              "universe rebuild checkpoint: verified outcome has no memo " +
                outcome.familyCandidateKey,
            );
          }
          assertMemoMatchesVerifiedOutcome(durableMemo, outcome);
        } else if (memo !== undefined) {
          throw new Error(
            "universe rebuild checkpoint: non-verified outcome carried memo",
          );
        }
        merged[outcome.familyCandidateKey] = outcome;
      }
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        verifiedMemos: Object.freeze(memos),
        inProgressRun: Object.freeze({
          ...run,
          outcomesByCandidateKey: Object.freeze(merged),
        }),
      });
    });
  }

  /** Replace one retryable outcome, guarded by the attempt count. */
  async casReplaceRunOutcome(input: {
    readonly runId: string;
    readonly familyCandidateKey: string;
    readonly expectedAttemptCount: number;
    readonly nextOutcome: RunOutcome;
    readonly memo?: DurableVerifiedMemo;
  }): Promise<StartupCheckpointEnvelope> {
    return this.#cas(undefined, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const run = base.inProgressRun;
      if (run === null || run.runId !== input.runId) {
        throw new Error(
          "universe rebuild checkpoint: no matching in-progress run " +
            input.runId,
        );
      }
      const old = run.outcomesByCandidateKey[input.familyCandidateKey];
      if (
        old === undefined ||
        old.status !== "retryable" ||
        old.attemptCount !== input.expectedAttemptCount
      ) {
        throw new Error(
          "universe rebuild checkpoint: probe CAS conflict for " +
            input.familyCandidateKey,
        );
      }
      const memos: Record<string, DurableVerifiedMemo> = {
        ...base.verifiedMemos,
      };
      if (input.memo !== undefined) {
        assertMemoMatchesVerifiedOutcome(input.memo, input.nextOutcome);
        memos[input.memo.familyCandidateKey] = Object.freeze(input.memo);
      }
      if (input.nextOutcome.status === "verified") {
        const durableMemo = memos[input.familyCandidateKey];
        if (durableMemo === undefined) {
          throw new Error(
            "universe rebuild checkpoint: verified probe outcome has no memo",
          );
        }
        assertMemoMatchesVerifiedOutcome(durableMemo, input.nextOutcome);
      } else if (input.memo !== undefined) {
        throw new Error(
          "universe rebuild checkpoint: non-verified probe carried memo",
        );
      }
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        verifiedMemos: Object.freeze(memos),
        inProgressRun: Object.freeze({
          ...run,
          outcomesByCandidateKey: Object.freeze({
            ...run.outcomesByCandidateKey,
            [input.familyCandidateKey]: input.nextOutcome,
          }),
        }),
      });
    });
  }

  /** Atomically promote the completed run to the ready generation. */
  async casCommitReadyGeneration(input: {
    readonly expectedRevision: number;
    readonly runId: string;
    readonly ready: ReadyUniverseGeneration;
  }): Promise<StartupCheckpointEnvelope> {
    return this.#cas(input.expectedRevision, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const run = base.inProgressRun;
      if (run === null || run.runId !== input.runId) {
        throw new Error(
          "universe rebuild checkpoint: no matching in-progress run " +
            input.runId,
        );
      }
      assertReadyPromotion(base, run, input.ready);
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        inProgressRun: null,
        readyGeneration: Object.freeze(input.ready),
      });
    });
  }

  /** Create the fixed-cutoff run or return the existing one for it. */
  async beginOrResumeRun(input: {
    readonly expectedRevision: number;
    readonly runId: string;
    readonly cutoff: CanonicalSource;
    readonly fromBlock: number;
    readonly universeHash: string;
    readonly candidateSetHash: string;
    readonly candidateCount: number;
    readonly candidatesByKey: Readonly<Record<string, unknown>>;
    readonly observedThrough: { readonly number: number; readonly hash: string };
  }): Promise<StartupCheckpointEnvelope> {
    if (Object.keys(input.candidatesByKey).length !== input.candidateCount) {
      throw new Error(
        "universe rebuild checkpoint: candidate partition/count mismatch",
      );
    }
    return this.#cas(input.expectedRevision, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const existing = base.inProgressRun;
      if (existing !== null) {
        if (existing.runId !== input.runId) {
          throw new Error(
            "universe rebuild checkpoint: another run is in progress (" +
              existing.runId + ")",
          );
        }
        if (
          existing.cutoff.number !== input.cutoff.number ||
          existing.cutoff.hash.toLowerCase() !== input.cutoff.hash.toLowerCase() ||
          existing.cutoff.generation !== input.cutoff.generation ||
          existing.fromBlock !== input.fromBlock ||
          existing.universeHash !== input.universeHash ||
          existing.candidateSetHash !== input.candidateSetHash ||
          existing.candidateCount !== input.candidateCount ||
          canonicalJson(existing.candidatesByKey) !==
            canonicalJson(input.candidatesByKey) ||
          existing.observedThrough.number !== input.observedThrough.number ||
          existing.observedThrough.hash.toLowerCase() !==
            input.observedThrough.hash.toLowerCase()
        ) {
          throw new Error(
            "universe rebuild checkpoint: runId resumed with different fixed input",
          );
        }
        return base;
      }
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        inProgressRun: Object.freeze({
          runId: input.runId,
          cutoff: Object.freeze({ ...input.cutoff }),
          fromBlock: input.fromBlock,
          universeHash: input.universeHash,
          candidateSetHash: input.candidateSetHash,
          candidateCount: input.candidateCount,
          candidatesByKey: Object.freeze({ ...input.candidatesByKey }),
          observedThrough: Object.freeze({ ...input.observedThrough }),
          appliedThrough: null,
          outcomesByCandidateKey: Object.freeze({}),
        }),
      });
    });
  }

  /** Add/refresh one durable verified memo. */
  async casUpsertMemo(
    memo: DurableVerifiedMemo,
  ): Promise<StartupCheckpointEnvelope> {
    return this.#cas(undefined, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        verifiedMemos: Object.freeze({
          ...base.verifiedMemos,
          [memo.familyCandidateKey]: Object.freeze(memo),
        }),
      });
    });
  }

  /** Seal a fresh envelope for a brand-new checkpoint file. */
  static emptyEnvelope(): StartupCheckpointEnvelope {
    const base = Object.freeze({
      revision: 0,
      verifiedMemos: Object.freeze({}),
      inProgressRun: null,
      readyGeneration: null,
    });
    return Object.freeze({
      ...base,
      revision: 1,
      checkpointFingerprint: envelopeFingerprint({
        ...base,
        revision: 1,
      }),
    });
  }
}

/**
 * Serial durable outcome writer (audit §4): workers hand completed outcomes
 * here; batches flush every N outcomes or after a max interval, and a
 * signal hook flushes pending outcomes before exit. A crash loses at most
 * the last batch; the store CAS never advances the ready generation.
 */
export class AttestationCheckpointWriter {
  readonly #store: UniverseRebuildCheckpointStore;
  readonly #runId: string;
  readonly #batchSize: number;
  readonly #maxIntervalMs: number;
  #pending: AttestationCheckpointWrite[] = [];
  #flushing: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: {
    readonly store: UniverseRebuildCheckpointStore;
    readonly runId: string;
    readonly batchSize?: number;
    readonly maxIntervalMs?: number;
  }) {
    this.#store = input.store;
    this.#runId = input.runId;
    this.#batchSize = input.batchSize ?? 25;
    this.#maxIntervalMs = input.maxIntervalMs ?? 5_000;
  }

  record(outcome: RunOutcome, memo?: DurableVerifiedMemo): void {
    this.#pending.push(Object.freeze({
      outcome,
      ...(memo === undefined ? {} : { memo }),
    }));
    if (this.#pending.length >= this.#batchSize) {
      void this.flush();
      return;
    }
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        void this.flush();
      }, this.#maxIntervalMs);
      if (typeof this.#timer.unref === "function") this.#timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.#flushing !== null) return this.#flushing;
    if (this.#pending.length === 0) return;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // Drain until empty: records can arrive while the first CAS is in
    // flight, and a caller awaiting flush() must not finalize a run while a
    // second batch is still only in memory.
    this.#flushing = (async (): Promise<void> => {
      while (this.#pending.length > 0) {
        const batch = this.#pending.splice(0);
        await this.#store.casMergeAttestationWrites(this.#runId, batch);
      }
    })()
      .finally(() => {
        this.#flushing = null;
      });
    return this.#flushing;
  }

  /** Install SIGTERM/SIGINT flush (best-effort; kill -9 loses one batch). */
  installSignalFlush(input?: { readonly terminateAfterFlush?: boolean }): () => void {
    let terminating = false;
    const handle = (signal: "SIGTERM" | "SIGINT"): void => {
      if (terminating) return;
      if (input?.terminateAfterFlush !== true) {
        void this.flush();
        return;
      }
      terminating = true;
      remove();
      void this.flush().finally(() => {
        // Re-deliver after removing our listeners so the OS/default signal
        // semantics stop the startup process only after the durable flush.
        process.kill(process.pid, signal);
      });
    };
    const onTerm = (): void => handle("SIGTERM");
    const onInt = (): void => handle("SIGINT");
    const remove = (): void => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    };
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    return () => {
      remove();
    };
  }
}

function assertMemoMatchesVerifiedOutcome(
  memo: DurableVerifiedMemo,
  outcome: RunOutcome,
): asserts outcome is Extract<RunOutcome, { readonly status: "verified" }> {
  if (
    outcome.status !== "verified" ||
    memo.familyCandidateKey !== outcome.familyCandidateKey ||
    memo.familyInstanceKey !== outcome.familyInstanceKey ||
    memo.memoFingerprint !== outcome.memoFingerprint
  ) {
    throw new Error(
      "universe rebuild checkpoint: memo/outcome atomic pair mismatch",
    );
  }
}

function assertReadyPromotion(
  envelope: StartupCheckpointEnvelope,
  run: InProgressUniverseRun,
  ready: ReadyUniverseGeneration,
): void {
  const candidateKeys = Object.keys(run.candidatesByKey).sort();
  const outcomeEntries = Object.entries(run.outcomesByCandidateKey)
    .sort(([left], [right]) => left.localeCompare(right));
  const outcomes = outcomeEntries.map(([, outcome]) => outcome);
  if (
    candidateKeys.length !== run.candidateCount ||
    outcomes.length !== run.candidateCount ||
    outcomeEntries.some(([key, outcome], index) =>
      key !== candidateKeys[index] ||
      outcome.familyCandidateKey !== key ||
      (outcome.status !== "verified" &&
        outcome.status !== "terminal-rejected")
    )
  ) {
    throw new Error(
      "universe rebuild checkpoint: ready promotion requires exact terminal partition",
    );
  }
  const verified = outcomes.filter((outcome): outcome is Extract<
    RunOutcome,
    { readonly status: "verified" }
  > => outcome.status === "verified");
  const expectedInstances = verified.map((outcome) => {
    const memo = envelope.verifiedMemos[outcome.familyCandidateKey];
    if (memo === undefined) {
      throw new Error(
        "universe rebuild checkpoint: ready promotion lost verified memo",
      );
    }
    assertMemoMatchesVerifiedOutcome(memo, outcome);
    return memo.familyInstanceKey;
  }).sort();
  const activeInstances = [...ready.activeInstanceKeys].sort();
  const sameInstances = expectedInstances.length === activeInstances.length &&
    expectedInstances.every((value, index) => value === activeInstances[index]) &&
    new Set(expectedInstances).size === expectedInstances.length &&
    new Set(activeInstances).size === activeInstances.length;
  const sameCutoff = ready.cutoff.number === run.cutoff.number &&
    ready.cutoff.hash.toLowerCase() === run.cutoff.hash.toLowerCase() &&
    ready.cutoff.generation === run.cutoff.generation;
  const observedMatches = ready.observedThrough.number ===
      run.observedThrough.number &&
    ready.observedThrough.hash.toLowerCase() ===
      run.observedThrough.hash.toLowerCase();
  const appliedAtCutoff = ready.appliedThrough.number === run.cutoff.number &&
    ready.appliedThrough.hash.toLowerCase() === run.cutoff.hash.toLowerCase();
  const graphRootMatches = ready.graphHash === createHash("sha256")
    .update("graph-v2:" + canonicalJson(ready.graphSnapshot))
    .digest("hex");
  const catalogRootMatches = ready.catalogHash === createHash("sha256")
    .update("catalog-v1:" + canonicalJson(ready.catalogSnapshot))
    .digest("hex");
  const publicationRootMatches = ready.publicationSetHash ===
    createHash("sha256")
      .update("publications-v2:" + canonicalJson(ready.catalogSnapshot))
      .digest("hex");
  const coverageKeys = new Set(ready.sourceCoverage.map((coverage) =>
    coverage.familyId + "|" + coverage.sourceId
  ));
  if (
    !sameCutoff || !observedMatches || !appliedAtCutoff || !sameInstances ||
    !graphRootMatches || !catalogRootMatches || !publicationRootMatches ||
    ready.universeRange.fromBlock !== run.fromBlock ||
    ready.universeRange.toBlock !== run.cutoff.number ||
    ready.universeHash !== run.universeHash ||
    ready.sourceCoverage.length === 0 ||
    coverageKeys.size !== ready.sourceCoverage.length ||
    ready.sourceCoverage.some((coverage) =>
      coverage.completeThroughBlock !== run.cutoff.number ||
      coverage.completeThroughHash?.toLowerCase() !==
        run.cutoff.hash.toLowerCase()
    )
  ) {
    throw new Error(
      "universe rebuild checkpoint: ready generation is not bound to completed run",
    );
  }
}
