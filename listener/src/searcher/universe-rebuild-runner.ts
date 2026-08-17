import { createHash } from "node:crypto";
import {
  AttestationCheckpointWriter,
  UniverseRebuildCheckpointStore,
  canonicalJson,
  type DurableVerifiedMemo,
  type InProgressUniverseRun,
  type ReadyUniverseGeneration,
  type RetryableAttempt,
  type RunOutcome,
  type StartupCheckpointEnvelope,
} from "./universe-rebuild-checkpoint.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";

/**
 * Durable universe rebuild runner (adversarial audit §5-§6). Every rebuild
 * re-scans the latest two-day Swap window at a frozen canonical cutoff,
 * restores the fixed-cutoff run by durable candidate key, verifies only the
 * diff (new / invalidated / failed candidates), persists outcomes through
 * the serial writer, and - only when retryable is empty and the candidate
 * partition is exact - seals the ready generation with one final CAS.
 *
 * The runner is dependency-injected so the flow contract is testable
 * without live RPC: scan/dedupe/attest/seal/rehydrate/graph are typed
 * inputs; the runner owns the durable-state choreography.
 */

export class UniverseRunIncomplete extends Error {
  readonly runId: string;
  readonly retryableCount: number;
  constructor(input: { readonly runId: string; readonly retryableCount: number }) {
    super(
      "universe rebuild incomplete: " + input.retryableCount +
        " retryable outcome(s) remain for run " + input.runId,
    );
    this.runId = input.runId;
    this.retryableCount = input.retryableCount;
  }
}

export interface UniverseRebuildDependencies {
  /** Freeze the canonical head (number + hash) this run is fixed to. */
  readonly freezeCanonicalHead: () => Promise<CanonicalSource>;
  /**
   * Scan the swap window [fromBlock..cutoff.number] at the frozen cutoff
   * hash. Returns raw observed logs; deduplication happens in the runner
   * via the supplied candidate key function.
   */
  readonly scanSwapWindow: (input: {
    readonly fromBlock: number;
    readonly cutoff: CanonicalSource;
  }) => Promise<readonly unknown[]>;
  /** Full log identity key (block + txHash + logIndex + address + topics). */
  readonly familyCandidateKey: (candidate: unknown) => string;
  /** Unique family candidates for the run (dedupe by familyCandidateKey). */
  readonly dedupeFamilyCandidates: (
    observations: readonly unknown[],
  ) => readonly unknown[];
  /**
   * Cross-run memo reuse: returns a memo only when Family + InstanceKey,
   * candidate fingerprint and per-Family definition hash all match and the
   * proof source is still canonical.
   */
  readonly findReusableMemo: (input: {
    readonly candidate: unknown;
    readonly checkpoint: StartupCheckpointEnvelope;
    readonly cutoff: CanonicalSource;
  }) => Promise<DurableVerifiedMemo | null>;
  /** One full lifecycle for one candidate at the fixed cutoff. */
  readonly attestFamilyInstanceOnce: (input: {
    readonly candidate: unknown;
    readonly cutoff: CanonicalSource;
    readonly evidenceRef?: {
      readonly blockNumber: number;
      readonly blockHash: string;
      readonly txHash?: string;
      readonly logIndex?: number;
    };
  }) => Promise<
    | { readonly status: "verified"; readonly result: unknown }
    | { readonly status: "terminal-rejected"; readonly reasonCode: string }
    | Omit<RetryableAttempt, "status" | "familyCandidateKey" | "familyId" |
        "attemptCount" | "lastAttemptAt"> & { readonly status: "retryable" }
  >;
  readonly sealDurableVerifiedMemo: (input: {
    readonly candidate: unknown;
    readonly result: unknown;
    readonly proofSource: CanonicalSource;
    readonly familyCandidateKey: string;
  }) => DurableVerifiedMemo;
  /** Re-issue process-local handles from a memo (no identity RPC). */
  readonly rehydrateVerifiedInstance: (input: {
    readonly memo: DurableVerifiedMemo;
    readonly cutoff: CanonicalSource;
  }) => unknown;
  readonly aggregateOnceByFamily: (instances: readonly unknown[]) => readonly {
    readonly familyId: string;
    readonly instances: readonly unknown[];
  }[];
  readonly buildGraphSnapshot: (publications: readonly {
    readonly familyId: string;
    readonly instances: readonly unknown[];
  }[]) => unknown;
  readonly buildCoverage: (input: {
    readonly observations: readonly unknown[];
    readonly cutoff: CanonicalSource;
  }) => ReadyUniverseGeneration["sourceCoverage"];
  /** Assert the cutoff hash still holds before the final CAS. */
  readonly assertCanonicalHead: (cutoff: CanonicalSource) => Promise<void>;
}

export interface RebuildUniverseInput extends UniverseRebuildDependencies {
  readonly store: UniverseRebuildCheckpointStore;
  readonly runId: string;
  readonly lookbackBlocks: number;
  /** Optional progress logging. */
  readonly log?: (message: string) => void;
}

export async function rebuildUniverse(
  input: RebuildUniverseInput,
): Promise<ReadyUniverseGeneration> {
  const log = input.log ?? ((): void => undefined);
  const cutoff = await input.freezeCanonicalHead();
  const fromBlock = Math.max(0, cutoff.number - input.lookbackBlocks + 1);

  // 1. Re-scan the latest two-day Swap window at the frozen cutoff.
  const observations = await input.scanSwapWindow({ fromBlock, cutoff });
  const candidates = input.dedupeFamilyCandidates(observations);

  // 2. Create or resume the same fixed-cutoff run.
  let checkpoint = await input.store.load() ?? null;
  checkpoint = await input.store.beginOrResumeRun({
    expectedRevision: checkpoint?.revision ?? 0,
    runId: input.runId,
    cutoff,
    fromBlock,
    universeHash: hashCandidateSet(candidates, input.familyCandidateKey),
    candidateSetHash: hashCandidateSet(candidates, input.familyCandidateKey),
    candidateCount: candidates.length,
    observedThrough: Object.freeze({
      number: cutoff.number,
      hash: cutoff.hash,
    }),
  });
  const run = checkpoint.inProgressRun;
  if (run === null || run.runId !== input.runId) {
    throw new Error("universe rebuild: run did not begin");
  }

  // 3. Restore by durable key; verify only the diff.
  const writer = new AttestationCheckpointWriter({
    store: input.store,
    runId: input.runId,
  });
  // Best-effort graceful stop: SIGTERM/SIGINT flush the completed outcomes
  // (the store's stale-lock recovery lets the next run reclaim afterwards).
  writer.installSignalFlush();
  const scheduled: Promise<void>[] = [];
  for (const candidate of candidates) {
    const candidateKey = input.familyCandidateKey(candidate);
    const oldOutcome = run.outcomesByCandidateKey[candidateKey];
    if (oldOutcome?.status === "verified") {
      continue;
    }
    const reusableMemo = await input.findReusableMemo({
      candidate,
      checkpoint,
      cutoff,
    });
    if (reusableMemo !== null) {
      writer.record(Object.freeze({
        status: "verified",
        familyCandidateKey: candidateKey,
        familyInstanceKey: reusableMemo.familyInstanceKey,
        memoFingerprint: reusableMemo.memoFingerprint,
      }));
      continue;
    }
    const evidenceRef = oldOutcome?.status === "retryable"
      ? oldOutcome.evidenceRef
      : undefined;
    const attemptCount = oldOutcome?.status === "retryable"
      ? oldOutcome.attemptCount
      : 0;
    scheduled.push((async (): Promise<void> => {
      const result = await input.attestFamilyInstanceOnce({
        candidate,
        cutoff,
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      });
      if (result.status === "verified") {
        const memo = input.sealDurableVerifiedMemo({
          candidate,
          result: result.result,
          proofSource: cutoff,
          familyCandidateKey: candidateKey,
        });
        writer.record(Object.freeze({
          status: "verified",
          familyCandidateKey: candidateKey,
          familyInstanceKey: memo.familyInstanceKey,
          memoFingerprint: memo.memoFingerprint,
        }), memo);
        return;
      }
      if (result.status === "terminal-rejected") {
        writer.record(Object.freeze({
          status: "terminal-rejected",
          familyCandidateKey: candidateKey,
          reasonCode: result.reasonCode,
          evidenceFingerprint: "chain-proof:" + result.reasonCode,
        }));
        return;
      }
      writer.record(Object.freeze({
        status: "retryable",
        familyCandidateKey: candidateKey,
        familyId: String((candidate as { familyId?: unknown }).familyId ?? ""),
        candidateSnapshot: result.candidateSnapshot,
        ...(result.evidenceRef === undefined
          ? {}
          : { evidenceRef: Object.freeze(result.evidenceRef) }),
        stage: result.stage,
        failureCode: result.failureCode,
        ...(result.requestFingerprint === undefined
          ? {}
          : { requestFingerprint: result.requestFingerprint }),
        reasonCode: result.reasonCode,
        attemptCount: attemptCount + 1,
        lastAttemptAt: new Date().toISOString(),
      }));
    })());
  }
  await Promise.all(scheduled);
  await writer.flush();

  // 4. Reload and inspect the run.
  checkpoint = await input.store.load() ?? checkpoint;
  const currentRun = checkpoint.inProgressRun;
  if (currentRun === null || currentRun.runId !== input.runId) {
    throw new Error("universe rebuild: run lost after flush");
  }
  const pending = Object.values(currentRun.outcomesByCandidateKey).filter(
    (item) => item.status === "retryable",
  );
  if (pending.length > 0) {
    throw new UniverseRunIncomplete({
      runId: input.runId,
      retryableCount: pending.length,
    });
  }

  // 5. Exact partition: every active candidate is verified or chain-proven
  //    terminal-rejected, nothing else.
  assertExactCandidatePartition(
    currentRun,
    candidates,
    input.familyCandidateKey,
  );

  // 6. Rehydrate from verified memos, aggregate once per family, seal ready.
  const instances: unknown[] = [];
  const activeMemos: DurableVerifiedMemo[] = [];
  for (const candidate of candidates) {
    const candidateKey = input.familyCandidateKey(candidate);
    const outcome = currentRun.outcomesByCandidateKey[candidateKey];
    if (outcome?.status !== "verified") continue;
    // Memos are keyed by familyCandidateKey in the envelope; the outcome's
    // memoFingerprint must match the memo's own fingerprint.
    const memo = checkpoint.verifiedMemos[candidateKey] ??
      await findMemoByKey(input, checkpoint, candidateKey);
    if (memo === undefined || memo.memoFingerprint !== outcome.memoFingerprint) {
      throw new Error(
        "universe rebuild: verified outcome " + candidateKey +
          " lost its memo " + outcome.memoFingerprint,
      );
    }
    activeMemos.push(memo);
    instances.push(input.rehydrateVerifiedInstance({ memo, cutoff }));
  }
  const publications = input.aggregateOnceByFamily(instances);
  const graphSnapshot = input.buildGraphSnapshot(publications);
  const catalogSnapshot = buildCatalogSnapshot(activeMemos);
  const ready = Object.freeze({
    generation: (checkpoint.readyGeneration?.generation ?? 0) + 1,
    cutoff: Object.freeze({ ...cutoff }),
    universeHash: currentRun.universeHash,
    catalogHash: hashCatalog(catalogSnapshot),
    activeInstanceKeys: Object.freeze(activeMemos.map((memo) =>
      memo.familyInstanceKey
    ).sort()),
    publicationSetHash: hashPublications(catalogSnapshot),
    observedThrough: Object.freeze({ ...currentRun.observedThrough }),
    appliedThrough: Object.freeze({
      number: cutoff.number,
      hash: cutoff.hash,
    }),
    sourceCoverage: input.buildCoverage({ observations, cutoff }),
    graphSnapshot,
    graphHash: hashGraph(graphSnapshot),
    catalogSnapshot,
  }) as ReadyUniverseGeneration;

  // 7. Final single CAS: Graph, coverage and cutoff become ready together.
  await input.assertCanonicalHead(cutoff);
  await input.store.casCommitReadyGeneration({
    expectedRevision: checkpoint.revision,
    runId: input.runId,
    ready,
  });
  log(
    "universe rebuild ready: generation=" + ready.generation +
      " instances=" + ready.activeInstanceKeys.length +
      " candidates=" + candidates.length,
  );
  return ready;
}

function assertExactCandidatePartition(
  run: InProgressUniverseRun,
  candidates: readonly unknown[],
  familyCandidateKey: (candidate: unknown) => string,
): void {
  const active = new Set(candidates.map((candidate) =>
    familyCandidateKey(candidate)
  ));
  const accounted = new Set<string>();
  for (const [key, outcome] of Object.entries(run.outcomesByCandidateKey)) {
    if (!active.has(key)) {
      throw new Error(
        "universe rebuild: outcome " + key +
          " has no active candidate in this window",
      );
    }
    if (outcome.status !== "verified" && outcome.status !== "terminal-rejected") {
      throw new Error(
        "universe rebuild: unaccounted outcome " + key + " = " + outcome.status,
      );
    }
    accounted.add(key);
  }
  for (const key of active) {
    if (!accounted.has(key)) {
      throw new Error(
        "universe rebuild: active candidate " + key + " has no outcome",
      );
    }
  }
}

async function findMemoByKey(
  input: { readonly store: UniverseRebuildCheckpointStore },
  checkpoint: StartupCheckpointEnvelope,
  familyCandidateKey: string,
): Promise<DurableVerifiedMemo | undefined> {
  const incumbent = checkpoint.verifiedMemos[familyCandidateKey];
  if (incumbent !== undefined) return incumbent;
  const reloaded = await input.store.load();
  if (reloaded === null) return undefined;
  return reloaded.verifiedMemos[familyCandidateKey];
}

/**
 * Audit §6: probe exactly one retryable failure at the run's fixed cutoff.
 * Uses the saved candidateSnapshot + evidenceRef, never rescanning the
 * window or re-attesting the other candidates; success writes the verified
 * memo and the run outcome in the same CAS sequence.
 */
export async function probeOneFailure(input: {
  readonly store: UniverseRebuildCheckpointStore;
  readonly runId: string;
  readonly familyCandidateKey: string;
  readonly attestFamilyInstanceOnce: UniverseRebuildDependencies[
    "attestFamilyInstanceOnce"
  ];
  readonly sealDurableVerifiedMemo: UniverseRebuildDependencies[
    "sealDurableVerifiedMemo"
  ];
  readonly assertCanonicalHead: UniverseRebuildDependencies["assertCanonicalHead"];
  readonly decodeCandidateSnapshot: (snapshot: unknown) => unknown;
}): Promise<RunOutcome> {
  const checkpoint = await input.store.load();
  if (checkpoint === null) {
    throw new Error("universe rebuild probe: no checkpoint");
  }
  const run = checkpoint.inProgressRun;
  if (run === null || run.runId !== input.runId) {
    throw new Error(
      "universe rebuild probe: no in-progress run " + input.runId,
    );
  }
  // The probe must continue at the original fixed cutoff.
  await input.assertCanonicalHead(run.cutoff);
  const old = run.outcomesByCandidateKey[input.familyCandidateKey];
  if (old === undefined || old.status !== "retryable") {
    throw new Error(
      "universe rebuild probe: target is not a retryable failure",
    );
  }
  const result = await input.attestFamilyInstanceOnce({
    candidate: input.decodeCandidateSnapshot(old.candidateSnapshot),
    cutoff: run.cutoff,
    ...(old.evidenceRef === undefined
      ? {}
      : { evidenceRef: old.evidenceRef }),
  });
  let next: RunOutcome;
  let verifiedMemo: DurableVerifiedMemo | undefined;
  if (result.status === "verified") {
    const memo = input.sealDurableVerifiedMemo({
      candidate: input.decodeCandidateSnapshot(old.candidateSnapshot),
      result: result.result,
      proofSource: run.cutoff,
      familyCandidateKey: input.familyCandidateKey,
    });
    verifiedMemo = memo;
    next = Object.freeze({
      status: "verified",
      familyCandidateKey: input.familyCandidateKey,
      familyInstanceKey: memo.familyInstanceKey,
      memoFingerprint: memo.memoFingerprint,
    });
  } else if (result.status === "terminal-rejected") {
    next = Object.freeze({
      status: "terminal-rejected",
      familyCandidateKey: input.familyCandidateKey,
      reasonCode: result.reasonCode,
      evidenceFingerprint: "chain-proof:" + result.reasonCode,
    });
  } else {
    next = Object.freeze({
      status: "retryable",
      familyCandidateKey: input.familyCandidateKey,
      familyId: old.familyId,
      candidateSnapshot: result.candidateSnapshot,
      ...(result.evidenceRef === undefined
        ? {}
        : { evidenceRef: Object.freeze(result.evidenceRef) }),
      stage: result.stage,
      failureCode: result.failureCode,
      ...(result.requestFingerprint === undefined
        ? {}
        : { requestFingerprint: result.requestFingerprint }),
      reasonCode: result.reasonCode,
      attemptCount: old.attemptCount + 1,
      lastAttemptAt: new Date().toISOString(),
    });
  }
  await input.store.casReplaceRunOutcome({
    runId: input.runId,
    familyCandidateKey: input.familyCandidateKey,
    expectedAttemptCount: old.attemptCount,
    nextOutcome: next,
    ...(verifiedMemo === undefined ? {} : { memo: verifiedMemo }),
  });
  return next;
}

function hashCandidateSet(
  candidates: readonly unknown[],
  familyCandidateKey: (candidate: unknown) => string,
): string {
  return createDigest(
    "candidate-set-v1:" +
      candidates.map((candidate) => familyCandidateKey(candidate))
        .sort().join(","),
  );
}

function hashPublications(catalogSnapshot: unknown): string {
  return createDigest(
    "publications-v2:" + canonicalJson(catalogSnapshot),
  );
}

function hashGraph(graph: unknown): string {
  return createDigest("graph-v2:" + canonicalJson(graph));
}

function hashCatalog(catalog: unknown): string {
  return createDigest("catalog-v1:" + canonicalJson(catalog));
}

function buildCatalogSnapshot(
  memos: readonly DurableVerifiedMemo[],
): unknown {
  return Object.freeze({
    format: "strict-rebuild-catalog-v1",
    instances: Object.freeze([...memos]
      .sort((left, right) =>
        left.familyInstanceKey.localeCompare(right.familyInstanceKey)
      )
      .map((memo) => Object.freeze({
        familyCandidateKey: memo.familyCandidateKey,
        familyInstanceKey: memo.familyInstanceKey,
        familyId: memo.familyId,
        instanceKey: memo.instanceKey,
        memoFingerprint: memo.memoFingerprint,
        compiledDescriptor: memo.compiledDescriptor,
        staticProjection: memo.staticProjection,
        evidenceFingerprint: memo.evidenceFingerprint,
      }))),
  });
}

function createDigest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}
