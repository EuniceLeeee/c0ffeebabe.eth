import { createHash } from "node:crypto";
import {
  AttestationCheckpointWriter,
  UniverseRebuildCheckpointStore,
  canonicalJson,
  type DurableVerifiedMemo,
  type DurableSourceReceipt,
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
  }) => Promise<{
    readonly observations: readonly unknown[];
    readonly sourceReceipts: readonly DurableSourceReceipt[];
  }>;
  /** Full log identity key (block + txHash + logIndex + address + topics). */
  readonly familyCandidateKey: (candidate: unknown) => string;
  /** Unique family candidates for the run (dedupe by familyCandidateKey). */
  readonly dedupeFamilyCandidates: (
    observations: readonly unknown[],
  ) => readonly unknown[];
  /** JSON-safe durable form used by candidatesByKey and retry/probe resume. */
  readonly encodeCandidateSnapshot?: (candidate: unknown) => unknown;
  /** Restore the exact candidate value (including bigint/Map fields). */
  readonly decodeCandidateSnapshot?: (snapshot: unknown) => unknown;
  /** Exact Family x source set declared by the loaded strict catalog. */
  readonly requiredSourceCoverageKeys: () => readonly string[];
  /**
   * Audit P0-STOP-1 (source-plan binding): current code identity of each
   * required source plan. Every durable receipt's queryFingerprint must
   * equal the plan fingerprint for its source kind. A mismatch means the
   * sealing code/query/capability changed after the receipt was written
   * (e.g. pattern id kept but topic or discovery capability changed): the
   * stale receipt can no longer prove the source complete and the run
   * fails closed instead of promoting ready. The plan fingerprints bind
   * code identity only (catalog capability hashes + pattern declarations
   * + chunk policy) and never the input snapshot: a startup-universe key
   * proves the nomination partition was consumed, not that no chain
   * instance exists outside it.
   */
  readonly expectedSourcePlanFingerprints: () => {
    readonly startup: string;
    readonly events: string;
  };
  /** Compact evidence pointer retained for a first-attempt retryable. */
  readonly candidateEvidenceRef?: (candidate: unknown) => {
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly txHash?: string;
    readonly logIndex?: number;
  } | undefined;
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
    | {
        readonly status: "terminal-rejected";
        readonly reasonCode: string;
        /**
         * Family-declared chain-proven negative evidence, bound to the
         * exact request program, trusted result set, Family definition,
         * implementation authority and fixed cutoff. Any change re-attests.
         */
        readonly binding: {
          readonly familyDefinitionHash: string;
          readonly requestFingerprint: string;
          readonly trustedResultsFingerprint: string;
          readonly authorityFingerprint: string;
          readonly candidateFingerprint: string;
          readonly cutoff: { readonly number: number; readonly hash: string };
        };
      }
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
  }[], cutoff: CanonicalSource) => unknown;
  readonly buildCoverage: (input: {
    readonly sourceReceipts: readonly DurableSourceReceipt[];
    readonly cutoff: CanonicalSource;
  }) => ReadyUniverseGeneration["sourceCoverage"];
  /** Assert the cutoff hash still holds before the final CAS. */
  readonly assertCanonicalHead: (cutoff: CanonicalSource) => Promise<void>;
}

export interface RebuildUniverseInput extends UniverseRebuildDependencies {
  readonly store: UniverseRebuildCheckpointStore;
  readonly runId: string;
  readonly lookbackBlocks: number;
  /**
   * Optional lower bound carried by the explicit universe snapshot. It may
   * expand the default rolling window into history, but can never narrow it.
   * An incumbent fixed run always keeps its already-durable fromBlock.
   */
  readonly universeWindowFrom?: number;
  /** Bounded identity/materialization workers; defaults to 24. */
  readonly attestationConcurrency?: number;
  /** Optional progress logging. */
  readonly log?: (message: string) => void;
}

export async function rebuildUniverse(
  input: RebuildUniverseInput,
): Promise<ReadyUniverseGeneration> {
  if (!Number.isSafeInteger(input.lookbackBlocks) || input.lookbackBlocks <= 0) {
    throw new Error("universe rebuild lookbackBlocks must be a positive integer");
  }
  if (
    input.universeWindowFrom !== undefined &&
    (!Number.isSafeInteger(input.universeWindowFrom) ||
      input.universeWindowFrom < 0)
  ) {
    throw new Error("universe rebuild explicit fromBlock is invalid");
  }
  const log = input.log ?? ((): void => undefined);
  const encodeCandidate = input.encodeCandidateSnapshot ?? ((value) => value);
  const decodeCandidate = input.decodeCandidateSnapshot ?? ((value) => value);
  let checkpoint = await input.store.load() ?? null;
  const incumbentRun = checkpoint?.inProgressRun ?? null;
  let cutoff: CanonicalSource;
  let fromBlock: number;
  let observations: readonly unknown[];
  let candidates: readonly unknown[];
  let sourceReceipts: readonly DurableSourceReceipt[];
  if (incumbentRun !== null) {
    if (incumbentRun.runId !== input.runId) {
      throw new Error(
        "universe rebuild checkpoint: another run is in progress (" +
          incumbentRun.runId + ")",
      );
    }
    // Once observedThrough is durable, resume the exact compact partition at
    // its original cutoff. Never rescan a moving window or depend on an
    // array index such as "8000".
    cutoff = incumbentRun.cutoff;
    fromBlock = incumbentRun.fromBlock;
    observations = Object.freeze([]);
    candidates = Object.freeze(Object.entries(incumbentRun.candidatesByKey)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, candidate]) => decodeCandidate(candidate)));
    if (incumbentRun.sourceReceipts === undefined) {
      // Backward-compatible migration for the already-running fixed
      // checkpoint: re-run only the exact historical source query, require
      // the resulting candidate partition to be byte-identical, then attach
      // receipts. Never clear or replace the run/cutoff/outcomes.
      const rescanned = await input.scanSwapWindow({ fromBlock, cutoff });
      const rescannedCandidates = input.dedupeFamilyCandidates(
        rescanned.observations,
      );
      const rescannedByKey = Object.freeze(Object.fromEntries(
        rescannedCandidates.map((candidate) => [
          input.familyCandidateKey(candidate),
          encodeCandidate(candidate),
        ]),
      ));
      if (
        hashCandidateSet(rescannedCandidates, input.familyCandidateKey) !==
          incumbentRun.candidateSetHash ||
        hashUniverseCandidatePartition(rescannedByKey) !==
          incumbentRun.universeHash
      ) {
        throw new Error(
          "universe rebuild: fixed-run source receipt rescan changed " +
            "the durable candidate partition",
        );
      }
      assertExactSourceCoverageSet(
        rescanned.sourceReceipts,
        input.requiredSourceCoverageKeys(),
      );
      checkpoint = await input.store.casSetRunSourceReceipts({
        expectedRevision: checkpoint?.revision ?? 0,
        runId: input.runId,
        sourceReceipts: rescanned.sourceReceipts,
      });
      sourceReceipts = rescanned.sourceReceipts;
    } else {
      sourceReceipts = incumbentRun.sourceReceipts;
    }
  } else {
    cutoff = await input.freezeCanonicalHead();
    const defaultFromBlock = Math.max(
      0,
      cutoff.number - input.lookbackBlocks + 1,
    );
    fromBlock = input.universeWindowFrom === undefined
      ? defaultFromBlock
      : Math.min(defaultFromBlock, input.universeWindowFrom);
    // A crash before this scan is sealed may rescan; after beginOrResumeRun,
    // the compact exact partition is durable and no scan is repeated.
    const scanned = await input.scanSwapWindow({ fromBlock, cutoff });
    observations = scanned.observations;
    sourceReceipts = scanned.sourceReceipts;
    candidates = input.dedupeFamilyCandidates(observations);
  }
  log(
    "universe rebuild fixed source range: run=" + input.runId +
      " from=" + fromBlock + " cutoff=" + cutoff.number + ":" + cutoff.hash +
      " resumed=" + String(incumbentRun !== null),
  );
  const candidatesByKey = Object.freeze(Object.fromEntries(
    candidates.map((candidate) => [
      input.familyCandidateKey(candidate),
      encodeCandidate(candidate),
    ]),
  ));
  if (Object.keys(candidatesByKey).length !== candidates.length) {
    throw new Error(
      "universe rebuild: dedupe produced duplicate FamilyCandidateKey entries",
    );
  }
  assertExactSourceCoverageSet(
    sourceReceipts,
    input.requiredSourceCoverageKeys(),
  );
  assertReceiptsMatchCurrentSourcePlan(
    sourceReceipts,
    input.expectedSourcePlanFingerprints(),
  );

  // 2. Create or resume the same fixed-cutoff run.
  checkpoint = await input.store.beginOrResumeRun({
    expectedRevision: checkpoint?.revision ?? 0,
    runId: input.runId,
    cutoff,
    fromBlock,
    universeHash: hashUniverseCandidatePartition(candidatesByKey),
    candidateSetHash: hashCandidateSet(candidates, input.familyCandidateKey),
    candidateCount: candidates.length,
    candidatesByKey,
    observedThrough: Object.freeze({
      number: cutoff.number,
      hash: cutoff.hash,
    }),
    sourceReceipts,
  });
  const run = checkpoint.inProgressRun;
  if (run === null || run.runId !== input.runId) {
    throw new Error("universe rebuild: run did not begin");
  }
  if (incumbentRun !== null) {
    // One canonical fence per resume is sufficient for same-run memos: their
    // authority proof is already bound to this exact historical cutoff.
    // Re-reading code/storage/proof hash for every verified instance would
    // turn a restart into a full-universe RPC pass instead of a diff resume.
    await input.assertCanonicalHead(cutoff);
  }
  const attestationCheckpoint = checkpoint;

  // 3. Restore by durable key; verify only the diff.
  const writer = new AttestationCheckpointWriter({
    store: input.store,
    runId: input.runId,
  });
  // Best-effort graceful stop: SIGTERM/SIGINT flush the completed outcomes
  // (the store's stale-lock recovery lets the next run reclaim afterwards).
  const uninstallSignalFlush = writer.installSignalFlush({
    terminateAfterFlush: true,
  });
  const pendingCandidates = candidates.filter((candidate) => {
    const candidateKey = input.familyCandidateKey(candidate);
    const oldOutcome = run.outcomesByCandidateKey[candidateKey];
    // A verified outcome is revalidated against the current Family hash,
    // deployment/implementation authority and canonical proof source before
    // it is trusted after a process/code restart. A valid memo skips the
    // lifecycle; an invalid one is attested again. Chain-proven terminal
    // outcomes stay terminal ONLY while every binding (Family definition,
    // request program, trusted result set, authority, candidate, cutoff)
    // still equals the current values; any change re-attests.
    if (oldOutcome?.status !== "terminal-rejected") return true;
    const binding = oldOutcome;
    if (
      typeof binding.familyDefinitionHash !== "string" ||
      typeof binding.requestFingerprint !== "string" ||
      typeof binding.authorityFingerprint !== "string" ||
      binding.cutoff?.hash === undefined ||
      binding.cutoff.number !== cutoff.number ||
      binding.cutoff.hash.toLowerCase() !== cutoff.hash.toLowerCase()
    ) {
      // Legacy/unbound or cutoff-mismatched terminal outcome: re-attest.
      return true;
    }
    return false;
  });
  let nextCandidate = 0;
  const processCandidate = async (candidate: unknown): Promise<void> => {
    const candidateKey = input.familyCandidateKey(candidate);
    const oldOutcome = run.outcomesByCandidateKey[candidateKey];
    let reusableMemo: DurableVerifiedMemo | null = null;
    try {
      reusableMemo = await input.findReusableMemo({
        candidate,
        checkpoint: attestationCheckpoint,
        cutoff,
      });
    } catch (error) {
      log(
        "universe rebuild memo revalidation failed for " + candidateKey +
          ": " + (error instanceof Error ? error.message : String(error)),
      );
    }
    if (reusableMemo !== null) {
      if (
        oldOutcome?.status === "verified" &&
        oldOutcome.familyInstanceKey === reusableMemo.familyInstanceKey &&
        oldOutcome.memoFingerprint === reusableMemo.memoFingerprint
      ) {
        return;
      }
      writer.record(Object.freeze({
        status: "verified",
        familyCandidateKey: candidateKey,
        familyInstanceKey: reusableMemo.familyInstanceKey,
        memoFingerprint: reusableMemo.memoFingerprint,
      }));
      return;
    }
    const evidenceRef = oldOutcome?.status === "retryable"
      ? oldOutcome.evidenceRef
      : input.candidateEvidenceRef?.(candidate);
    const attemptCount = oldOutcome?.status === "retryable"
      ? oldOutcome.attemptCount
      : 0;
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
          familyDefinitionHash: result.binding.familyDefinitionHash,
          requestFingerprint: result.binding.requestFingerprint,
          trustedResultsFingerprint: result.binding.trustedResultsFingerprint,
          authorityFingerprint: result.binding.authorityFingerprint,
          candidateFingerprint: result.binding.candidateFingerprint,
          cutoff: Object.freeze({
            number: result.binding.cutoff.number,
            hash: result.binding.cutoff.hash,
          }),
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
  };
  const requestedConcurrency = input.attestationConcurrency ?? 24;
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new Error("universe rebuild attestation concurrency is invalid");
  }
  try {
    await Promise.all(Array.from({
      length: Math.min(requestedConcurrency, Math.max(1, pendingCandidates.length)),
    }, async () => {
      while (true) {
        const index = nextCandidate++;
        if (index >= pendingCandidates.length) return;
        await processCandidate(pendingCandidates[index]);
      }
    }));
  } finally {
    // Even an unexpected worker failure must preserve every sibling that
    // already completed. The failed key remains unaccounted and therefore
    // cannot advance appliedThrough or readyGeneration.
    await writer.flush();
    uninstallSignalFlush();
  }

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
  const graphSnapshot = input.buildGraphSnapshot(publications, cutoff);
  const catalogSnapshot = buildCatalogSnapshot(activeMemos);
  const ready = Object.freeze({
    generation: (checkpoint.readyGeneration?.generation ?? 0) + 1,
    cutoff: Object.freeze({ ...cutoff }),
    universeRange: Object.freeze({
      fromBlock: currentRun.fromBlock,
      toBlock: cutoff.number,
    }),
    universeHash: currentRun.universeHash,
    catalogHash: hashReadyCatalogSnapshot(catalogSnapshot),
    activeInstanceKeys: Object.freeze(activeMemos.map((memo) =>
      memo.familyInstanceKey
    ).sort()),
    publicationSetHash: hashReadyPublicationSet(catalogSnapshot),
    observedThrough: Object.freeze({ ...currentRun.observedThrough }),
    appliedThrough: Object.freeze({
      number: cutoff.number,
      hash: cutoff.hash,
    }),
    sourceCoverage: input.buildCoverage({ sourceReceipts, cutoff }),
    graphSnapshot,
    graphHash: hashReadyGraphSnapshot(graphSnapshot),
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

/**
 * Audit P0-STOP-1: every durable receipt must have been sealed by the same
 * source/query implementation the current catalog declares. queryFingerprint
 * is the receipt-side plan identity; a mismatch (pattern id kept but topic,
 * emitter or discovery capability changed) fails closed so a stale receipt
 * can never prove a source complete for the current code.
 */
export function assertReceiptsMatchCurrentSourcePlan(
  receipts: readonly DurableSourceReceipt[],
  plan: { readonly startup: string; readonly events: string },
): void {
  for (const receipt of receipts) {
    const expected = receipt.sourceKind === "startup-candidate-union"
      ? plan.startup
      : receipt.sourceKind === "catalog-event-union"
        ? plan.events
        : null;
    if (expected === null) {
      throw new Error(
        "universe rebuild: source receipt kind is not bound to a source plan",
      );
    }
    if (receipt.queryFingerprint !== expected) {
      throw new Error(
        "universe rebuild: durable source receipt does not match the " +
          "current source plan; explicit fixed-run migration is required",
      );
    }
  }
}

export function assertExactSourceCoverageSet(
  receipts: readonly DurableSourceReceipt[],
  requiredKeys: readonly string[],
): void {
  const required = new Set(requiredKeys);
  const completed = new Set(receipts.flatMap((receipt) => receipt.coverageKeys));
  if (
    required.size === 0 ||
    required.size !== requiredKeys.length ||
    completed.size !== required.size ||
    [...required].some((key) => !completed.has(key))
  ) {
    throw new Error(
      "universe rebuild: completed source receipt set does not match " +
        "the strict catalog required source exact set",
    );
  }
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
      familyDefinitionHash: result.binding.familyDefinitionHash,
      requestFingerprint: result.binding.requestFingerprint,
      trustedResultsFingerprint: result.binding.trustedResultsFingerprint,
      authorityFingerprint: result.binding.authorityFingerprint,
      candidateFingerprint: result.binding.candidateFingerprint,
      cutoff: Object.freeze({
        number: result.binding.cutoff.number,
        hash: result.binding.cutoff.hash,
      }),
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

function hashUniverseCandidatePartition(
  candidatesByKey: Readonly<Record<string, unknown>>,
): string {
  return createDigest(
    "universe-candidate-partition-v1:" + canonicalJson(candidatesByKey),
  );
}

export function hashReadyPublicationSet(catalogSnapshot: unknown): string {
  return createDigest(
    "publications-v2:" + canonicalJson(catalogSnapshot),
  );
}

export function hashReadyGraphSnapshot(graph: unknown): string {
  return createDigest("graph-v2:" + canonicalJson(graph));
}

export function hashReadyCatalogSnapshot(catalog: unknown): string {
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
