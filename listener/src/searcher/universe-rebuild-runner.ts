import { createHash } from "node:crypto";
import {
  AttestationCheckpointWriter,
  UniverseRebuildCheckpointStore,
  assertDurableVerifiedMemoFingerprint,
  canonicalJson,
  hasDurableCandidateSnapshot,
  type DurableVerifiedMemo,
  type DurableSourceReceipt,
  type InProgressUniverseRun,
  type LegacyDurableVerifiedMemo,
  type ReadyUniverseGeneration,
  type RetryableAttempt,
  type RunOutcome,
  type StartupCheckpointEnvelope,
} from "./universe-rebuild-checkpoint.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import { strictEdgeCollectionFromBlock } from
  "./strict-edge-collection-policy.js";

/**
 * Durable universe rebuild runner (adversarial audit §5-§6). Every rebuild
 * scans exactly the latest production edge window at a frozen canonical cutoff,
 * restores the fixed-cutoff run by durable candidate key, verifies only the
 * diff (new / invalidated / failed candidates), persists outcomes through
 * the serial writer, and - only when every candidate is accounted as
 * verified, terminal-rejected, or retryable - seals the ready generation
 * with one final CAS. Retryable is durable work, not an unfinished run.
 *
 * The runner is dependency-injected so the flow contract is testable
 * without live RPC: scan/dedupe/attest/seal/rehydrate/graph are typed
 * inputs; the runner owns the durable-state choreography.
 */

export class UniverseRunIncomplete extends Error {
  readonly runId: string;
  readonly remainingUnaccounted: number;
  constructor(input: {
    readonly runId: string;
    readonly remainingUnaccounted: number;
  }) {
    super(
      "universe rebuild incomplete: " + input.remainingUnaccounted +
        " candidate(s) remain unaccounted for run " + input.runId,
    );
    this.runId = input.runId;
    this.remainingUnaccounted = input.remainingUnaccounted;
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
  /**
   * Optional retain-channel candidate resolution (central driver; plugin
   * semantics).  After the event-window dedupe, opaque observations that
   * produced no candidate (e.g. univ4 swap logs carry only a poolId, never a
   * complete PoolKey) are handed to each Family plugin's declared
   * reverseBinding capability, which re-materializes a real observation from
   * chain truth (PositionManager / factory-child / registry).  The resolved
   * observations are re-run through catalog matching + decodeCandidate and
   * their candidates merged into the run partition.  No protocol semantics
   * in this file: the wiring supplies the driver, plugins own the lookups.
   */
  readonly reverseBindOpaqueCandidates?: (input: {
    readonly observations: readonly unknown[];
    readonly cutoff: CanonicalSource;
  }) => Promise<readonly unknown[]>;
  /** JSON-safe durable form used by candidatesByKey and retry/probe resume. */
  /** JSON-safe durable form used by candidatesByKey and retry/probe resume. */
  readonly encodeCandidateSnapshot?: (candidate: unknown) => unknown;
  /** Restore the exact candidate value (including bigint/Map fields). */
  readonly decodeCandidateSnapshot?: (snapshot: unknown) => unknown;
  /** One-time catalog-driven reconstruction for deployed pre-snapshot memos. */
  readonly upgradeLegacyVerifiedMemo?: (
    memo: LegacyDurableVerifiedMemo,
  ) => DurableVerifiedMemo;
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
  /** Bounded identity/materialization workers; defaults to 24. */
  readonly attestationConcurrency?: number;
  /** Optional progress logging. */
  readonly log?: (message: string) => void;
}

export async function rebuildUniverse(
  input: RebuildUniverseInput,
): Promise<ReadyUniverseGeneration> {
  const log = input.log ?? ((): void => undefined);
  const encodeCandidate = input.encodeCandidateSnapshot ?? ((value) => value);
  const decodeCandidate = input.decodeCandidateSnapshot ?? ((value) => value);
  let checkpoint = await input.store.load() ?? null;
  if (checkpoint !== null) {
    const memoEntries = Object.entries(checkpoint.verifiedMemos) as readonly [
      string,
      DurableVerifiedMemo | LegacyDurableVerifiedMemo,
    ][];
    const legacyMemos = memoEntries.filter(
      ([, memo]) => !hasDurableCandidateSnapshot(memo),
    );
    if (legacyMemos.length > 0) {
      if (input.upgradeLegacyVerifiedMemo === undefined) {
        throw new Error(
          "universe rebuild: legacy verified memos require a candidate snapshot upgrader",
        );
      }
      const upgrades = Object.freeze(Object.fromEntries(legacyMemos.map(
        ([candidateKey, memo]) => [
          candidateKey,
          input.upgradeLegacyVerifiedMemo!(
            memo as LegacyDurableVerifiedMemo,
          ),
        ],
      )));
      checkpoint = await input.store.casUpgradeLegacyVerifiedMemos({
        expectedRevision: checkpoint.revision,
        upgrades,
      });
      log(
        "universe rebuild upgraded legacy verified memos: count=" +
          legacyMemos.length,
      );
    }
    for (const memo of Object.values(checkpoint.verifiedMemos) as readonly (
      DurableVerifiedMemo | LegacyDurableVerifiedMemo
    )[]) {
      if (!hasDurableCandidateSnapshot(memo)) {
        throw new Error(
          "universe rebuild: verified memo has no retained candidate snapshot " +
            memo.familyCandidateKey,
        );
      }
      assertDurableVerifiedMemoFingerprint(memo);
    }
  }
  checkpoint = await migrateAlreadyReadyKeptRun(input.store, checkpoint, log);
  const incumbentRun = checkpoint?.inProgressRun ?? null;
  const retainedCandidateInputs = Object.freeze(
    Object.values(checkpoint?.verifiedMemos ?? {})
      .sort((left, right) =>
        left.familyCandidateKey.localeCompare(right.familyCandidateKey)
      )
      .map((memo) => Object.freeze({
        kind: "startup-candidate",
        candidate: decodeCandidate(memo.candidateSnapshot),
      })),
  );
  // Layered re-adoption model:
  // 1. An unfinished fixed run keeps its time world forever — same runId,
  //    same cutoff, same fromBlock. Only with NO unfinished run do we freeze
  //    a new head and create a new run.
  // 2. Discovery plan drift (a new/changed discovery surface since the run
  //    sealed its receipts) only decides whether the SAME fixed range must be
  //    re-scanned with the current catalog; it never changes the run.
  // 3. Per-candidate verification reuses memos via findReusableMemo: a valid
  //    memo skips the lifecycle, anything else is attested.
  let discoveryPlanChanged = false;
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
    // ★ The unfinished run's time world never changes.
    cutoff = incumbentRun.cutoff;
    fromBlock = incumbentRun.fromBlock;
    if (receiptsMatchCurrentSourcePlan(
      incumbentRun.sourceReceipts,
      input.expectedSourcePlanFingerprints(),
    )) {
      // Layer 2 fast path: the discovery source plan is unchanged, so the
      // durable partition is restored without any rescan.
      observations = Object.freeze([]);
      candidates = Object.freeze(Object.entries(incumbentRun.candidatesByKey)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, candidate]) => decodeCandidate(candidate)));
      sourceReceipts = incumbentRun.sourceReceipts;
    } else {
      // ★ Layer 2 slow path: discovery plan drift — re-run discovery over the
      // SAME fixed range with the current catalog; the run identity
      // (runId/cutoff/fromBlock) stays untouched and verified memos are
      // reused per candidate.
      discoveryPlanChanged = true;
      log(
        "universe rebuild discovery plan change: re-running discovery over " +
          "the same fixed range " + fromBlock + ".." + cutoff.number +
          ":" + cutoff.hash + "; verified memos are reused per candidate",
      );
      const rescanned = await input.scanSwapWindow({ fromBlock, cutoff });
      observations = Object.freeze([...rescanned.observations]);
      sourceReceipts = rescanned.sourceReceipts;
      candidates = input.dedupeFamilyCandidates(Object.freeze([
        ...observations,
        ...retainedCandidateInputs,
      ]));
      if (input.reverseBindOpaqueCandidates !== undefined) {
        // Retain-channel candidates: opaque observations (e.g. univ4 swap
        // logs carrying only a poolId) are resolved to complete candidates
        // through each Family plugin's declared reverseBinding, then merged
        // with the event-window partition. The wiring owns the driver; the
        // plugin owns the chain lookups.
        const reverseBound = await input.reverseBindOpaqueCandidates({
          observations,
          cutoff,
        });
        if (reverseBound.length > 0) {
          // Merge through the shared alias-collapsing dedupe
          // (rebuildFamilyInstanceDedupeKey) instead of familyCandidateKey:
          // a retained startup-universe entry spells a univ4 pool as
          // address+poolId while the reverse-bound candidate spells it as
          // manager+poolId, and familyCandidateKey keeps those spellings
          // distinct. Two memos for one instance would then duplicate the
          // instance key set and the ready promotion fails closed ("ready
          // generation is not bound to completed run").
          candidates = input.dedupeFamilyCandidates(Object.freeze([
            ...observations,
            ...retainedCandidateInputs,
            ...reverseBound.map((candidate) => Object.freeze({
              kind: "startup-candidate",
              candidate,
            })),
          ]));
        }
      }
    }
  } else {
    // ★ Only with no unfinished run do we create a new time world.
    cutoff = await input.freezeCanonicalHead();
    fromBlock = strictEdgeCollectionFromBlock(cutoff.number);
    // A crash before this scan is sealed may rescan; after beginOrResumeRun,
    // the compact exact partition is durable and no scan is repeated.
    const scanned = await input.scanSwapWindow({ fromBlock, cutoff });
    observations = Object.freeze([...scanned.observations]);
    sourceReceipts = scanned.sourceReceipts;
    candidates = input.dedupeFamilyCandidates(Object.freeze([
      ...observations,
      ...retainedCandidateInputs,
    ]));
    if (input.reverseBindOpaqueCandidates !== undefined) {
      // Retain-channel candidates: opaque observations (e.g. univ4 swap
      // logs carrying only a poolId) are resolved to complete candidates
      // through each Family plugin's declared reverseBinding, then merged
      // with the event-window partition. The wiring owns the driver; the
      // plugin owns the chain lookups.
      const reverseBound = await input.reverseBindOpaqueCandidates({
        observations,
        cutoff,
      });
      if (reverseBound.length > 0) {
        // Merge through the shared alias-collapsing dedupe
        // (rebuildFamilyInstanceDedupeKey) instead of familyCandidateKey:
        // a retained startup-universe entry spells a univ4 pool as
        // address+poolId while the reverse-bound candidate spells it as
        // manager+poolId, and familyCandidateKey keeps those spellings
        // distinct. Two memos for one instance would then duplicate the
        // instance key set and the ready promotion fails closed ("ready
        // generation is not bound to completed run").
        candidates = input.dedupeFamilyCandidates(Object.freeze([
          ...observations,
          ...retainedCandidateInputs,
          ...reverseBound.map((candidate) => Object.freeze({
            kind: "startup-candidate",
            candidate,
          })),
        ]));
      }
    }
  }
  log(
    "universe rebuild fixed source range: run=" + input.runId +
      " from=" + fromBlock + " cutoff=" + cutoff.number + ":" + cutoff.hash +
      " resumed=" + String(incumbentRun !== null && !discoveryPlanChanged) +
      " discoveryPlanChanged=" + String(discoveryPlanChanged) +
      " retained=" + retainedCandidateInputs.length,
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

  // 2. Create or resume the same fixed-cutoff run; a discovery plan change
  // reconciles the SAME run's partition/receipts (time identity immutable).
  checkpoint = discoveryPlanChanged
    ? await input.store.reconcileFixedRunPlan({
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
      })
    : await input.store.beginOrResumeRun({
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
  // One verified outcome per family instance. Two candidate keys can verify
  // to the same instance (e.g. two curve pools sharing one underlying), and
  // the ready promotion requires a unique instance set (it fails closed on
  // duplicates). Keep the first verified candidate per instance (sorted by
  // key); the duplicates become terminal-rejected "duplicate-instance" so
  // the Graph carries the instance exactly once. The pass is idempotent and
  // also repairs an incumbent run on resume (no re-verification needed).
  const seenInstanceKeys = new Map<string, string>();
  const duplicateInstanceOutcomes: RunOutcome[] = [];
  for (const [candidateKey, outcome] of Object.entries(
    run.outcomesByCandidateKey,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    if (outcome.status !== "verified") continue;
    const first = seenInstanceKeys.get(outcome.familyInstanceKey);
    if (first !== undefined) {
      const memo = checkpoint.verifiedMemos[candidateKey];
      duplicateInstanceOutcomes.push(Object.freeze({
        status: "terminal-rejected",
        familyCandidateKey: candidateKey,
        reasonCode: "duplicate-instance",
        familyDefinitionHash: memo?.familyDefinitionHash ??
          "duplicate-instance",
        requestFingerprint: "duplicate-instance:" + first,
        trustedResultsFingerprint: "duplicate-instance:" + first,
        authorityFingerprint: memo?.validity?.authorityFingerprint ??
          "duplicate-instance",
        candidateFingerprint: memo?.candidateFingerprint ??
          "duplicate-instance",
        cutoff: Object.freeze({
          number: run.cutoff.number,
          hash: run.cutoff.hash,
        }),
      }));
      continue;
    }
    seenInstanceKeys.set(outcome.familyInstanceKey, candidateKey);
  }
  for (const outcome of duplicateInstanceOutcomes) writer.record(outcome);
  // Serial gate for fresh attestations: two candidates of one instance must
  // not both record verified when they attest concurrently.
  let instanceGateTail: Promise<void> = Promise.resolve();
  const instanceGate = async <T>(fn: () => Promise<T>): Promise<T> => {
    const next = instanceGateTail.then(fn, fn);
    instanceGateTail = next.then(() => undefined, () => undefined);
    return next;
  };
  const claimInstanceKey = async (
    familyInstanceKey: string,
    candidateKey: string,
  ): Promise<string | undefined> => await instanceGate(async () => {
    const first = seenInstanceKeys.get(familyInstanceKey);
    if (first !== undefined && first !== candidateKey) return first;
    seenInstanceKeys.set(familyInstanceKey, candidateKey);
    return undefined;
  });
  const recordDuplicateInstance = (
    candidateKey: string,
    memo: DurableVerifiedMemo,
    duplicateOf: string,
  ): void => writer.record(Object.freeze({
    status: "terminal-rejected",
    familyCandidateKey: candidateKey,
    reasonCode: "duplicate-instance",
    familyDefinitionHash: memo.familyDefinitionHash,
    requestFingerprint: "duplicate-instance:" + duplicateOf,
    trustedResultsFingerprint: "duplicate-instance:" + duplicateOf,
    authorityFingerprint: memo.validity.authorityFingerprint,
    candidateFingerprint: memo.candidateFingerprint,
    cutoff: Object.freeze({
      number: cutoff.number,
      hash: cutoff.hash,
    }),
  }));
  const pendingCandidates = candidates.filter((candidate) => {
    const candidateKey = input.familyCandidateKey(candidate);
    const oldOutcome = run.outcomesByCandidateKey[candidateKey];
    // Residual retryable outcomes are preserved, never re-attested during
    // startup: they stay durable in the run, stay out of the Graph, and are
    // closed later by the probe. Re-attesting them here would block startup
    // on the same slow/failing keys every restart. (Probe runs re-attest
    // exactly one retryable key at a time.)
    if (oldOutcome?.status === "retryable") return false;
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
  const pendingCandidateKeys = new Set(
    pendingCandidates.map((candidate) => input.familyCandidateKey(candidate)),
  );
  const attestationCounts: Record<RunOutcome["status"], number> = {
    verified: 0,
    "terminal-rejected": 0,
    retryable: 0,
  };
  for (const candidate of candidates) {
    const candidateKey = input.familyCandidateKey(candidate);
    if (pendingCandidateKeys.has(candidateKey)) continue;
    const outcome = run.outcomesByCandidateKey[candidateKey];
    if (outcome !== undefined) attestationCounts[outcome.status]++;
  }
  const initiallyAccounted = candidates.length - pendingCandidates.length;
  let completedPending = 0;
  const logAttestationProgress = (phase: "start" | "progress"): void => {
    const processed = initiallyAccounted + completedPending;
    log(
      "universe rebuild attestation " + phase + ": processed=" + processed +
        "/" + candidates.length +
        " pending=" + (pendingCandidates.length - completedPending) +
        " verified=" + attestationCounts.verified +
        " terminalRejected=" + attestationCounts["terminal-rejected"] +
        " retryable=" + attestationCounts.retryable,
    );
  };
  logAttestationProgress("start");
  const recordAttestationProgress = (status: RunOutcome["status"]): void => {
    attestationCounts[status]++;
    completedPending++;
    if (
      completedPending === 1 ||
      completedPending % 100 === 0 ||
      completedPending === pendingCandidates.length
    ) {
      logAttestationProgress("progress");
    }
  };
  let nextCandidate = 0;
  const processCandidate = async (
    candidate: unknown,
  ): Promise<RunOutcome["status"]> => {
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
      const duplicateOf = await claimInstanceKey(
        reusableMemo.familyInstanceKey,
        candidateKey,
      );
      if (duplicateOf !== undefined) {
        recordDuplicateInstance(candidateKey, reusableMemo, duplicateOf);
        return "terminal-rejected";
      }
      if (
        oldOutcome?.status === "verified" &&
        oldOutcome.familyInstanceKey === reusableMemo.familyInstanceKey &&
        oldOutcome.memoFingerprint === reusableMemo.memoFingerprint
      ) {
        return "verified";
      }
      writer.record(Object.freeze({
        status: "verified",
        familyCandidateKey: candidateKey,
        familyInstanceKey: reusableMemo.familyInstanceKey,
        memoFingerprint: reusableMemo.memoFingerprint,
      }));
      return "verified";
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
      const duplicateOf = await claimInstanceKey(
        memo.familyInstanceKey,
        candidateKey,
      );
      if (duplicateOf !== undefined) {
        recordDuplicateInstance(candidateKey, memo, duplicateOf);
        return "terminal-rejected";
      }
      writer.record(Object.freeze({
        status: "verified",
        familyCandidateKey: candidateKey,
        familyInstanceKey: memo.familyInstanceKey,
        memoFingerprint: memo.memoFingerprint,
      }), memo);
      return "verified";
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
      return "terminal-rejected";
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
    return "retryable";
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
        const candidate = pendingCandidates[index];
        try {
          recordAttestationProgress(await processCandidate(candidate));
        } catch (error) {
          log(
            "universe rebuild attestation failed: candidate=" +
              input.familyCandidateKey(candidate) +
              " processed=" + (initiallyAccounted + completedPending) +
              "/" + candidates.length +
              " pending=" + (pendingCandidates.length - completedPending) +
              " error=" + (error instanceof Error
                ? error.message
                : String(error)),
          );
          throw error;
        }
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
  const retryable = Object.values(currentRun.outcomesByCandidateKey).filter(
    (item) => item.status === "retryable",
  );
  if (retryable.length > 0) {
    log(
      "universe rebuild ready with " + retryable.length +
        " residual retryable outcome(s); they stay out of the Graph " +
        "and move to the independent probe queue",
    );
  }

  // 5. Exact accounting: retryable counts as handled for this run; only a
  //    candidate with no outcome remains unaccounted and blocks Ready.
  const candidateAccounting = assertExactCandidatePartition(
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
    candidateAccounting,
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
  // Promotion clears inProgressRun. Residual retryables remain durable in a
  // separate queue, so the next startup freezes a new rolling cutoff instead
  // of repeatedly publishing the same completed historical run.
  return ready;
}

/**
 * Audit P0-STOP-1: every durable receipt must have been sealed by the same
 * source/query implementation the current catalog declares. queryFingerprint
 * is the receipt-side plan identity; a mismatch (pattern id kept but topic,
 * emitter or discovery capability changed) fails closed so a stale receipt
 * can never prove a source complete for the current code.
 */
/** Non-throwing plan match probe used by the layered runner. */
export function receiptsMatchCurrentSourcePlan(
  receipts: readonly DurableSourceReceipt[],
  plan: { readonly startup: string; readonly events: string },
): boolean {
  try {
    assertReceiptsMatchCurrentSourcePlan(receipts, plan);
    return true;
  } catch {
    return false;
  }
}

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
): ReadyUniverseGeneration["candidateAccounting"] {
  const active = new Set(candidates.map((candidate) =>
    familyCandidateKey(candidate)
  ));
  return exactCandidateAccounting(run, active);
}

function exactCandidateAccounting(
  run: InProgressUniverseRun,
  active: ReadonlySet<string>,
): ReadyUniverseGeneration["candidateAccounting"] {
  if (active.size !== run.candidateCount) {
    throw new Error(
      "universe rebuild: candidate partition/count mismatch: " +
        active.size + " != " + run.candidateCount,
    );
  }
  const accounted = new Set<string>();
  for (const [key, outcome] of Object.entries(run.outcomesByCandidateKey)) {
    if (!active.has(key)) {
      throw new Error(
        "universe rebuild: outcome " + key +
          " has no active candidate in this window",
      );
    }
    const status: string = outcome.status;
    if (
      status !== "verified" &&
      status !== "terminal-rejected" &&
      status !== "retryable"
    ) {
      throw new Error(
        "universe rebuild: unaccounted outcome " + key + " = " + status,
      );
    }
    accounted.add(key);
  }
  if (accounted.size !== active.size) {
    const missing = [...active].filter((key) => !accounted.has(key)).sort();
    throw new UniverseRunIncomplete({
      runId: run.runId,
      remainingUnaccounted: missing.length,
    });
  }
  const outcomes = Object.values(run.outcomesByCandidateKey);
  return Object.freeze({
    total: run.candidateCount,
    verified: outcomes.filter((outcome) => outcome.status === "verified").length,
    terminalRejected: outcomes.filter((outcome) =>
      outcome.status === "terminal-rejected"
    ).length,
    retryable: outcomes.filter((outcome) => outcome.status === "retryable").length,
    remainingUnaccounted: 0 as const,
  });
}

async function migrateAlreadyReadyKeptRun(
  store: UniverseRebuildCheckpointStore,
  checkpoint: StartupCheckpointEnvelope | null,
  log: (message: string) => void,
): Promise<StartupCheckpointEnvelope | null> {
  const run = checkpoint?.inProgressRun;
  const ready = checkpoint?.readyGeneration;
  if (checkpoint === null || run === null || run === undefined || ready == null) {
    return checkpoint;
  }
  if (
    ready.cutoff.number !== run.cutoff.number ||
    ready.cutoff.hash.toLowerCase() !== run.cutoff.hash.toLowerCase() ||
    ready.cutoff.generation !== run.cutoff.generation
  ) {
    return checkpoint;
  }
  let candidateAccounting: ReadyUniverseGeneration["candidateAccounting"];
  try {
    candidateAccounting = exactCandidateAccounting(
      run,
      new Set(Object.keys(run.candidatesByKey)),
    );
  } catch (error) {
    log(
      "universe rebuild kept-run migration skipped: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return checkpoint;
  }
  try {
    const migrated = await store.casCommitReadyGeneration({
      expectedRevision: checkpoint.revision,
      runId: run.runId,
      ready: Object.freeze({ ...ready, candidateAccounting }),
    });
    log(
      "universe rebuild migrated already-ready kept run: run=" + run.runId +
        " retryableQueue=" + candidateAccounting.retryable,
    );
    return migrated;
  } catch (error) {
    // A run can have changed after its last Ready (for example, a successful
    // probe added a memo). In that case the existing roots/instance set no
    // longer bind the run, so normal fixed-run recovery must rebuild it.
    log(
      "universe rebuild kept-run migration requires normal recovery: " +
        (error instanceof Error ? error.message : String(error)),
    );
    const reloaded = await store.load();
    return reloaded === null || reloaded.revision === checkpoint.revision
      ? checkpoint
      : reloaded;
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
 * Audit §6: probe exactly one retryable failure at its fixed cutoff.
 * Uses the saved candidateSnapshot + evidenceRef, never rescanning the
 * window or re-attesting the other candidates; success writes the verified
 * memo and removes the independently queued retryable in the same CAS.
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
  const queued = checkpoint.retryableAttemptsByCandidateKey[
    input.familyCandidateKey
  ];
  const queuedTarget = queued !== undefined && queued.runId === input.runId;
  const runOutcome = run?.runId === input.runId
    ? run.outcomesByCandidateKey[input.familyCandidateKey]
    : undefined;
  const old = queuedTarget ? queued : runOutcome;
  if (old === undefined || old.status !== "retryable") {
    throw new Error(
      "universe rebuild probe: target is not a retryable failure",
    );
  }
  const cutoff = queuedTarget ? queued.cutoff : run!.cutoff;
  // The probe must continue at the retryable's original fixed cutoff.
  await input.assertCanonicalHead(cutoff);
  const result = await input.attestFamilyInstanceOnce({
    candidate: input.decodeCandidateSnapshot(old.candidateSnapshot),
    cutoff,
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
      proofSource: cutoff,
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
  const write = {
    runId: input.runId,
    familyCandidateKey: input.familyCandidateKey,
    expectedAttemptCount: old.attemptCount,
    nextOutcome: next,
    ...(verifiedMemo === undefined ? {} : { memo: verifiedMemo }),
  };
  if (queuedTarget) {
    await input.store.casReplaceQueuedRetryable(write);
  } else {
    await input.store.casReplaceRunOutcome(write);
  }
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
