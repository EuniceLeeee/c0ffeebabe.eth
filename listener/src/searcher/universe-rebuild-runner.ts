import { createHash } from "node:crypto";
import {
  AttestationCheckpointWriter,
  UniverseRebuildCheckpointStore,
  assertDurableVerifiedMemoFingerprint,
  activeReadyMemos,
  buildReadyCatalogSnapshot,
  canonicalJson,
  canonicalJsonFingerprint,
  hasDurableCandidateSnapshot,
  prepareReadyFamilyUpdate,
  immutableReadyValue,
  validateReadyFamilyGraph,
  type CandidateCoverageBinding,
  type CoveredCandidateOutcome,
  type DurableVerifiedMemo,
  type DurableSourceReceipt,
  type InProgressUniverseRun,
  type LegacyDurableVerifiedMemo,
  type ReadyUniverseGeneration,
  type ReadyFamilyPartition,
  type ReadyFamilyUpdateInput,
  type ReadyFamilyUpdateScope,
  type RetryableAttempt,
  type RunOutcome,
  type StartupCheckpointEnvelope,
} from "./universe-rebuild-checkpoint.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import { strictEdgeCollectionFromBlock } from
  "./strict-edge-collection-policy.js";
import type { ReadyRpcThrottle } from "./ready-rpc-throttle.js";
import { assertCurrentCandidateCoverage, createCandidateRevalidation } from "./ready-candidate-processing.js";
import { normalizeForcedReadyStatuses, reconcileReadyInputs, retainReadyResultHistory,
  type ForcedReadyStatus } from "./ready-input-reconciliation.js";

/**
 * Durable universe rebuild runner (adversarial audit §5-§6). Every rebuild
 * obtains the complete discovery partition at a frozen canonical cutoff,
 * using a scan or an exactly bound sealed input, restores the fixed-cutoff run
 * by durable candidate key, verifies only the
 * diff (new / invalidated / failed candidates), persists outcomes through
 * the serial writer, and - only when every candidate is accounted as
 * verified, covered, terminal-rejected, or retryable - seals the ready generation
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
  readonly readyThrottle?: ReadyRpcThrottle;
  /** Stable complete caller discovery-input identity, separate from force or
   * attempt identity. Its existing output also binds sealed discovery reuse;
   * an old interrupted run without an input seal cannot acquire this binding. */
  readonly readyReviewInputFingerprint?: () => string;
  readonly hasExplicitStartupCandidates?: boolean;
  /** Freeze the canonical head, or one explicitly requested historical cutoff. */
  readonly freezeCanonicalHead: (
    requestedBlock?: number,
  ) => Promise<CanonicalSource>;
  /**
   * Scan Family-declared activity over [fromBlock..cutoff.number] at the
   * frozen cutoff hash. Log and call observations share this one result and
   * source-completion boundary; deduplication happens in the runner.
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
  /** Present on new baselines to retain exact per-Family outcome partitions. */
  readonly candidateFamilyId?: (candidate: unknown) => string;
  readonly familyDefinitionHash?: (familyId: string) => string;
  readonly familyDiscoveryDefinitionHash?: (familyId: string) => string;
  /** Family-owned equivalence of complete candidate tasks. Used only after
   * ordinary input/hash rules decide that a candidate needs a fresh attempt. */
  readonly candidateCoverage?: (candidate: unknown) => CandidateCoverageBinding | null;
  /** One representative per Family instance. An explicit selection pins its durable evidence keys. */
  readonly dedupeFamilyCandidates: (
    observations: readonly unknown[],
    selected?: ReadonlySet<string>,
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
    /** Complete candidates decoded directly or restored from durable memos. */
    readonly knownCandidates: readonly unknown[];
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
  /** Operator activation only; inactive Family memos stay durable for re-enabling. */
  readonly isFamilyEnabled?: (familyId: string) => boolean;
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
   * + transport policy) and never the input snapshot: a startup-universe key
   * proves the nomination partition was consumed, not that no chain
   * instance exists outside it.
   */
  readonly expectedSourcePlanFingerprints: () => {
    readonly startup: string;
    readonly activity: string;
  };
  /** Compact evidence pointer retained for a first-attempt retryable. */
  readonly candidateEvidenceRef?: (candidate: unknown) => {
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly txHash?: string;
    readonly logIndex?: number;
  } | undefined;
  /**
   * A source-stage candidate that is complete enough to identify and retry,
   * but not complete enough to enter the Family lifecycle yet. This keeps a
   * failed reverse binding in exact accounting without making it a Ready
   * generation barrier.
   */
  readonly preAttestationRetryable?: (candidate: unknown) =>
    | (Omit<RetryableAttempt, "status" | "familyCandidateKey" | "familyId" |
        "attemptCount" | "lastAttemptAt"> & { readonly status: "retryable" })
    | null;
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
  /** Pure definition check for rematerializing the already-validated Ready
   * at its unchanged cutoff. Not cross-block authority or discovery reuse. */
  readonly isReadyMemoDefinitionCurrent?: (memo: DurableVerifiedMemo) => boolean;
  /** Pure production full-Graph/route/funding validation before subset publication. */
  readonly assertReadyGraphSnapshot?: (input: {
    readonly publications: readonly { readonly familyId: string; readonly instances: readonly unknown[] }[];
    readonly graphSnapshot: unknown;
    readonly cutoff: CanonicalSource;
  }) => void;
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
  /** Optional exact complete nomination input, including a first build. */
  readonly currentCandidateKeys?: ReadonlySet<string>;
  /** Existing caller input identity for an explicit first-build pool file. */
  readonly currentInputFingerprint?: string;
  /** Current nominated universe. Only these inputs and newly discovered candidates are eligible.
   * An optional exact selection is keyed by the normal Family+instance candidate key. */
  readonly previousReadyReview?: {
    readonly inputFingerprint: string;
    /** Explicit maintenance update of a paused review. The CLI authenticates
     * its unchanged source, candidate file, executor and force policy first. */
    readonly replacesInputFingerprint?: string;
    readonly candidateKeys?: ReadonlySet<string>;
    readonly retainedFamilyIds?: ReadonlySet<string>;
    /** Retry prior rejections and retryables in scope, keeping normal verified memo checks. */
    readonly retryNegativeOutcomes?: boolean;
    /** Fresh proof context. Only outcomes sealed by this exact review may resume. */
    readonly revalidateParentProofs?: boolean;
    /** Override only these historical result states; completed attempts in
     * the same sealed run still resume without being attempted twice. */
    readonly forceStatuses?: readonly ForcedReadyStatus[];
  };
  /** Explicit copied-parent scope; persists across scratch resume and promotion. */
  readonly familyUpdateScope?: ReadyFamilyUpdateScope;
  readonly scopedCandidateKeys?: ReadonlySet<string>;
  readonly store: UniverseRebuildCheckpointStore;
  readonly runId: string;
  /**
   * Same production scan with a bounded shorter window for preflight smoke.
   * Omit for the canonical 14,400-block rebuild; values may never widen it.
   */
  readonly observationWindowBlocks?: number;
  /**
   * Explicit historical source range. This selects the time range only; it
   * feeds the same scan/dedupe/attest/Graph pipeline as the rolling window.
   */
  readonly observationRange?: {
    readonly fromBlock: number;
    readonly toBlock: number;
  };
  /** Bounded identity/materialization workers; defaults to 24. */
  readonly attestationConcurrency?: number;
  /** Legacy completion policy. New runs also seal their Family definitions,
   * so unchanged completed partitions resume without per-memo validation.
   * Missing or changed evidence still follows the original admission rules. */
  readonly resumeCompletedOutcomes?: boolean;
  /** Optional progress logging. */
  readonly log?: (message: string) => void;
}

export async function rebuildUniverse(
  input: RebuildUniverseInput,
): Promise<ReadyUniverseGeneration> {
  const definitionHash = input.familyDefinitionHash;
  const definitions = new Map<string, string>();
  if (definitionHash) input = { ...input, familyDefinitionHash: (id: string): string => {
    if (!definitions.has(id)) definitions.set(id, definitionHash(id));
    return definitions.get(id)!;
  } };
  const familyUpdateScope = input.familyUpdateScope === undefined ? undefined : immutableReadyValue(input.familyUpdateScope);
  const log = input.log ?? ((): void => undefined);
  if (
    input.observationRange !== undefined &&
    input.observationWindowBlocks !== undefined
  ) {
    throw new Error(
      "universe rebuild: explicit range and rolling window are mutually exclusive",
    );
  }
  const explicitRange = input.observationRange === undefined
    ? null
    : validateExplicitObservationRange(input.observationRange);
  const encodeCandidate = input.encodeCandidateSnapshot ?? ((value) => value);
  const decodeCandidate = input.decodeCandidateSnapshot ?? ((value) => value);
  let checkpoint = await input.store.load() ?? null;
  if (familyUpdateScope !== undefined || checkpoint?.inProgressRun?.familyUpdateScope !== undefined) {
    if (familyUpdateScope === undefined || checkpoint?.readyGeneration?.familyPartitions === undefined) {
      throw new Error("Ready Family scoped rebuild requires its partitioned parent and scope");
    }
    const ids = [...familyUpdateScope.familyIds].sort();
    const covered = readyCoverageFamilyIds(input.requiredSourceCoverageKeys());
    if (ids.length === 0 || new Set(ids).size !== ids.length || canonicalJson(ids) !== canonicalJson(covered) ||
      (checkpoint.inProgressRun === null
        ? checkpoint.checkpointFingerprint !== familyUpdateScope.parentCheckpointFingerprint
        : canonicalJson(checkpoint.inProgressRun.familyUpdateScope ?? null) !== canonicalJson(familyUpdateScope))) {
      throw new Error("Ready Family scoped rebuild parent/scope mismatch");
    }
    for (const id of new Set([...Object.keys(checkpoint.readyGeneration.familyPartitions), ...ids])) {
      if (input.isFamilyEnabled?.(id) !== ids.includes(id)) throw new Error("Ready Family scoped rebuild activation mismatch");
    }
  }
  if (checkpoint !== null) {
    const memoEntries = Object.entries(checkpoint.verifiedMemos) as readonly [
      string,
      DurableVerifiedMemo | LegacyDurableVerifiedMemo,
    ][];
    const legacyMemos = memoEntries.filter(
      ([, memo]) => input.isFamilyEnabled?.(memo.familyId) !== false &&
        !hasDurableCandidateSnapshot(memo),
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
      // The checkpoint store authenticates persisted data. Definition/proof
      // eligibility is decided by the complete Family partition below.
      if (input.isFamilyEnabled?.(memo.familyId) === false) continue;
      if (!hasDurableCandidateSnapshot(memo)) {
        throw new Error(
          "universe rebuild: verified memo has no retained candidate snapshot " +
            memo.familyCandidateKey,
        );
      }
    }
  }
  if (!checkpoint?.inProgressRun?.reviewInputFingerprint) {
    checkpoint = await migrateAlreadyReadyKeptRun(input.store, checkpoint, log);
  }
  const incumbentRun = checkpoint?.inProgressRun ?? null;
  const defaultReview = !input.previousReadyReview && !familyUpdateScope && checkpoint?.readyGeneration?.familyPartitions &&
    (!incumbentRun || incumbentRun.reviewInputFingerprint) && input.readyReviewInputFingerprint;
  const review: RebuildUniverseInput["previousReadyReview"] = input.previousReadyReview ??
    (defaultReview ? { inputFingerprint: defaultReview() } : undefined);
  const explicitForcedStatuses = normalizeForcedReadyStatuses(review?.forceStatuses);
  const forcedStatuses = new Set<ForcedReadyStatus>(explicitForcedStatuses ?? []);
  if (review?.retryNegativeOutcomes) { forcedStatuses.add("terminal-rejected"); forcedStatuses.add("retryable"); }
  if (review?.revalidateParentProofs) {
    forcedStatuses.add("verified"); forcedStatuses.add("terminal-rejected"); forcedStatuses.add("retryable");
  }
  // Old unfinished reviews already bind legacy flags in their original
  // review fingerprint. New runs additionally seal the effective selection.
  const legacyForcedReview = incumbentRun?.reviewInputFingerprint !== undefined &&
    incumbentRun.familyDefinitionHashes === undefined && incumbentRun.forcedOutcomeStatuses === undefined &&
    explicitForcedStatuses === undefined;
  const forcedOutcomeStatuses = legacyForcedReview ? undefined : normalizeForcedReadyStatuses([...forcedStatuses]);
  const selected = review?.candidateKeys ?? input.currentCandidateKeys ?? input.scopedCandidateKeys;
  if (review && (!checkpoint?.readyGeneration?.familyPartitions || familyUpdateScope ||
      !/^[0-9a-f]{64}$/.test(review.inputFingerprint))) {
    throw new Error("Ready review requires a partitioned parent and bound current input");
  }
  const replacingReview = review?.replacesInputFingerprint !== undefined;
  if (replacingReview && (!incumbentRun?.reviewInputFingerprint ||
      review!.replacesInputFingerprint !== incumbentRun.reviewInputFingerprint ||
      review!.inputFingerprint === incumbentRun.reviewInputFingerprint ||
      canonicalJson(incumbentRun.forcedOutcomeStatuses ?? null) !== canonicalJson(forcedOutcomeStatuses ?? null))) {
    throw new Error("Ready review replacement does not bind the paused input/policy");
  }
  if (incumbentRun && incumbentRun.reviewInputFingerprint !== review?.inputFingerprint && !replacingReview) {
    throw new Error("Ready review input differs from the unfinished run");
  }
  if (incumbentRun && incumbentRun.currentInputFingerprint !== input.currentInputFingerprint) {
    throw new Error("Ready complete candidate input differs from the unfinished run");
  }
  if (input.resumeCompletedOutcomes && incumbentRun === null) {
    throw new Error("universe rebuild: completed-outcome resume requires an unfinished run");
  }
  const retainedCandidates = Object.freeze(
    (review ? [] : [
      ...Object.values(checkpoint?.verifiedMemos ?? {}),
      // Failed candidates remain retryable even without new activity in the
      // rolling window. They still need a successful attestation to enter Graph.
      ...Object.values(checkpoint?.retryableAttemptsByCandidateKey ?? {}),
    ])
      .filter((entry) => input.isFamilyEnabled?.(entry.familyId) !== false)
      .sort((left, right) =>
        left.familyCandidateKey.localeCompare(right.familyCandidateKey)
      )
      .map((entry) => decodeCandidate(entry.candidateSnapshot)),
  );
  // A rolling update without a replacement range or replacement pool still
  // includes the previous nominated pool. Explicit inputs define their own scope.
  const retainedFamilies = familyUpdateScope?.familyIds ?? (defaultReview && !input.hasExplicitStartupCandidates &&
    !explicitRange ? Object.keys(checkpoint?.readyGeneration?.familyPartitions ?? {})
      .filter(id => input.isFamilyEnabled?.(id) !== false) : []);
  const partitionCandidates = retainedFamilies.flatMap(id =>
    Object.values(checkpoint?.readyGeneration?.familyPartitions?.[id]?.candidatesByKey ?? {}).map(decodeCandidate));
  const retainedCandidateInputs = Object.freeze(
    [...retainedCandidates, ...partitionCandidates].map((candidate) => Object.freeze({
      kind: "startup-candidate",
      candidate,
    })),
  );
  // Layered re-adoption model:
  // 1. An unfinished fixed run keeps its time world forever — same runId,
  //    same cutoff, same fromBlock. Only with NO unfinished run do we freeze
  //    a new head and create a new run.
  // 2. Discovery plan drift (a new/changed discovery surface since the run
  //    sealed its receipts) only decides whether the SAME fixed range must be
  //    re-scanned with the current catalog; it never changes the run.
  // 3. Matching sealed Family inputs inherit outcomes as a batch. Remaining
  //    work keeps the original memo/source checks and strict lifecycle.
  let discoveryPlanChanged = false;
  let cutoff: CanonicalSource;
  let fromBlock: number;
  let observations: readonly unknown[];
  let candidates: readonly unknown[];
  let sourceReceipts: readonly DurableSourceReceipt[];
  // A resumed legacy run may contain a different original startup list even
  // when its source plan still matches. Only a fresh scan or an already-sealed
  // complete input can bind the current caller fingerprint to its discoveries.
  // Implicit historical additions are not part of that raw caller binding;
  // preserve their existing scan/retention policy rather than caching a union.
  const canSealDiscoveryInput = retainedCandidateInputs.length === 0 &&
    (incumbentRun === null || incumbentRun.reviewInputFingerprint !== undefined ||
      incumbentRun.currentInputFingerprint !== undefined);
  const discoveryFingerprint = canSealDiscoveryInput
    ? defaultReview ? review!.inputFingerprint : input.readyReviewInputFingerprint?.()
    : undefined;
  const discoveryInputBinding: ReadyUniverseGeneration["discoveryInputBinding"] =
    discoveryFingerprint !== undefined && /^[0-9a-f]{64}$/.test(discoveryFingerprint)
      ? Object.freeze({ inputFingerprint: discoveryFingerprint,
          selectedCandidateSetHash: selected === undefined ? null : hashCandidateSet([...selected], value => value as string) })
      : undefined;
  if (incumbentRun !== null) {
    if (review && !replacingReview && !receiptsMatchCurrentSourcePlan(incumbentRun.sourceReceipts, input.expectedSourcePlanFingerprints())) {
      throw new Error("Ready review discovery plan differs from the unfinished run");
    }
    if (incumbentRun.runId !== input.runId) {
      throw new Error(
        "universe rebuild checkpoint: another run is in progress (" +
          incumbentRun.runId + ")",
      );
    }
    if (
      explicitRange !== null &&
      (incumbentRun.fromBlock !== explicitRange.fromBlock ||
        incumbentRun.cutoff.number !== explicitRange.toBlock)
    ) {
      throw new Error(
        "universe rebuild checkpoint: in-progress fixed range " +
          incumbentRun.fromBlock + ".." + incumbentRun.cutoff.number +
          " differs from requested range " + explicitRange.fromBlock +
          ".." + explicitRange.toBlock,
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
      if (input.resumeCompletedOutcomes && !replacingReview) {
        throw new Error("universe rebuild: completed-outcome resume source plan changed");
      }
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
      ]), selected);
      if (input.reverseBindOpaqueCandidates !== undefined) {
        // Retain-channel candidates: opaque observations (e.g. univ4 swap
        // logs carrying only a poolId) are resolved to complete candidates
        // through each Family plugin's declared reverseBinding, then merged
        // with the event-window partition. The wiring owns the driver; the
        // plugin owns the chain lookups.
        const reverseBound = await input.reverseBindOpaqueCandidates({
          observations,
          cutoff,
          knownCandidates: candidates,
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
          ]), selected);
        }
      }
    }
  } else {
    // ★ Only with no unfinished run do we create a new time world.
    cutoff = await input.freezeCanonicalHead(explicitRange?.toBlock);
    if (familyUpdateScope !== undefined && (canonicalJson(cutoff) !== canonicalJson(checkpoint!.readyGeneration!.cutoff) ||
      explicitRange?.fromBlock !== checkpoint!.readyGeneration!.universeRange.fromBlock ||
      explicitRange?.toBlock !== checkpoint!.readyGeneration!.universeRange.toBlock)) {
      throw new Error("Ready Family scoped rebuild must use the exact parent source/range");
    }
    if (
      explicitRange !== null &&
      cutoff.number !== explicitRange.toBlock
    ) {
      throw new Error(
        "universe rebuild: requested cutoff " + explicitRange.toBlock +
          " resolved to block " + cutoff.number,
      );
    }
    fromBlock = explicitRange?.fromBlock ?? strictEdgeCollectionFromBlock(
      cutoff.number,
      input.observationWindowBlocks,
    );
    const restoredDiscovery = (() => {
      const parent = checkpoint?.readyGeneration;
      if (!discoveryInputBinding || !parent?.discoveryInputBinding || !parent.familyPartitions ||
          parent.familyUpdate !== undefined || parent.familyUpdateScope !== undefined || parent.activationRestriction !== undefined ||
          familyUpdateScope !== undefined || canonicalJson(parent.discoveryInputBinding) !== canonicalJson(discoveryInputBinding) ||
          canonicalJson(parent.cutoff) !== canonicalJson(cutoff) ||
          parent.universeRange.fromBlock !== fromBlock || parent.universeRange.toBlock !== cutoff.number) return null;
      try {
        const required = input.requiredSourceCoverageKeys();
        const entries = Object.entries(parent.familyPartitions).sort(([a], [b]) => a.localeCompare(b));
        if (entries.some(([, partition]) => !partition.enabled) ||
            canonicalJson(entries.map(([id]) => id)) !== canonicalJson(readyCoverageFamilyIds(required)) ||
            canonicalJson(parent.sourceCoverage.map(row => row.familyId + "|" + row.sourceId).sort()) !== canonicalJson([...required].sort()) ||
            parent.sourceCoverage.some(row => row.completeThroughBlock !== cutoff.number || row.completeThroughHash !== cutoff.hash)) return null;
        const receipts = entries[0]?.[1].sourceReceipts ?? Object.freeze([]);
        const sealedReceipts = canonicalJson(receipts);
        if (entries.some(([, partition]) => canonicalJson(partition.sourceReceipts) !== sealedReceipts)) return null;
        assertExactSourceCoverageSet(receipts, required);
        if (!receiptsMatchCurrentSourcePlan(receipts, input.expectedSourcePlanFingerprints())) return null;
        if (input.preAttestationRetryable) {
          for (const [id, partition] of entries) {
            const inheritsDefinition = partition.familyDefinitionHash !== undefined &&
              partition.familyDefinitionHash === input.familyDefinitionHash?.(id);
            if (inheritsDefinition && !forcedStatuses.has("retryable")) continue;
            // Unresolved nominations need discovery/reverse binding to obtain
            // their missing inputs. Keep an unchanged retryable batch intact,
            // but do not freeze its old marker when this round must retry it.
            if (Object.values(partition.candidatesByKey).some(snapshot =>
              input.preAttestationRetryable!(decodeCandidate(snapshot)) !== null)) return null;
          }
        }
        const rows = entries.flatMap(([, partition]) => Object.entries(partition.candidatesByKey))
          .sort(([a], [b]) => a.localeCompare(b));
        const restored = rows.map(([key, snapshot]) => {
          const candidate = decodeCandidate(snapshot);
          if (input.familyCandidateKey(candidate) !== key) throw new Error("sealed discovery candidate key changed");
          return candidate;
        });
        return { candidates: Object.freeze(restored), sourceReceipts: receipts };
      } catch {
        // Any missing proof of equality takes the original discovery path.
        return null;
      }
    })();
    if (restoredDiscovery !== null) {
      observations = Object.freeze([]);
      candidates = restoredDiscovery.candidates;
      sourceReceipts = restoredDiscovery.sourceReceipts;
      log("universe rebuild restored sealed discovery: candidates=" + candidates.length + " sourceReceipts=" + sourceReceipts.length);
    } else {
      // A crash before this scan is sealed may rescan; after beginOrResumeRun,
      // the compact exact partition is durable and no scan is repeated.
      const scanned = await input.scanSwapWindow({ fromBlock, cutoff });
      observations = Object.freeze([...scanned.observations]);
      sourceReceipts = scanned.sourceReceipts;
      candidates = input.dedupeFamilyCandidates(Object.freeze([
        ...observations,
        ...retainedCandidateInputs,
      ]), selected);
      if (input.reverseBindOpaqueCandidates !== undefined) {
        // Opaque observations use the same Family-owned reverse binding as
        // before; a restored complete partition already contains its output.
        const reverseBound = await input.reverseBindOpaqueCandidates({
          observations,
          cutoff,
          knownCandidates: candidates,
        });
        if (reverseBound.length > 0) {
          candidates = input.dedupeFamilyCandidates(Object.freeze([
            ...observations,
            ...retainedCandidateInputs,
            ...reverseBound.map((candidate) => Object.freeze({
              kind: "startup-candidate",
              candidate,
            })),
          ]), selected);
        }
      }
    }
  }
  if (input.scopedCandidateKeys && !familyUpdateScope) throw new Error("candidate selection requires an explicit supplement scope");
  if (selected) {
    candidates = candidates.filter(candidate => selected.has(input.familyCandidateKey(candidate)));
    const retainedKeys = new Set(candidates.map(input.familyCandidateKey));
    if (retainedKeys.size !== selected.size) {
      const missing = [...selected].filter(key => !retainedKeys.has(key));
      throw new Error("Ready review could not resolve every selected Family candidate: " +
        "missing=" + missing.length + " examples=" + missing.slice(0, 3).join(","));
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
  const candidateFamilyIds: Record<string, string> = {};
  const candidatesByFamily = new Map<string, Record<string, unknown>>();
  for (const id of readyCoverageFamilyIds(input.requiredSourceCoverageKeys())) candidatesByFamily.set(id, {});
  if (input.candidateFamilyId) for (const candidate of candidates) {
    const key = input.familyCandidateKey(candidate), id = input.candidateFamilyId(candidate);
    candidateFamilyIds[key] = id;
    if (!candidatesByFamily.has(id)) throw new Error("Ready candidate Family lacks source coverage: " + id);
    candidatesByFamily.get(id)![key] = candidatesByKey[key];
  }
  const familyDefinitionHashes = input.familyDefinitionHash && input.candidateFamilyId
    ? Object.freeze(Object.fromEntries([...candidatesByFamily.keys()].sort().map(id => [id, input.familyDefinitionHash!(id)])))
    : undefined;
  const definitionInputChanged = incumbentRun !== null && !review && familyDefinitionHashes !== undefined &&
    canonicalJson(incumbentRun.familyDefinitionHashes ?? null) !== canonicalJson(familyDefinitionHashes);
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
  checkpoint = discoveryPlanChanged || definitionInputChanged || replacingReview
    ? await input.store.reconcileFixedRunPlan({
        ...(replacingReview && { reviewReplacement: {
          previous: review!.replacesInputFingerprint!, next: review!.inputFingerprint,
        } }),
        ...(familyDefinitionHashes === undefined ? {} : { familyDefinitionHashes, candidateFamilyIds }),
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
        ...(input.currentInputFingerprint === undefined ? {} : { currentInputFingerprint: input.currentInputFingerprint }),
        ...(review && { reviewInputFingerprint: review.inputFingerprint }),
        ...(familyDefinitionHashes === undefined ? {} : { familyDefinitionHashes }),
        ...(forcedOutcomeStatuses === undefined ? {} : { forcedOutcomeStatuses }),
        ...(familyUpdateScope === undefined ? {} : { familyUpdateScope }),
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
  const parent = checkpoint.readyGeneration;
  const history = parent ? retainReadyResultHistory(parent, {}, parent.cutoff) : undefined;
  const previousOutcomes = new Map<string, RunOutcome>();
  for (const partition of history ?? []) {
    for (const [key, row] of Object.entries(partition.outcomesByCandidateKey)) previousOutcomes.set(key, row);
  }
  for (const partition of Object.values(parent?.familyPartitions ?? {})) {
    for (const [key, row] of Object.entries(partition.outcomesByCandidateKey)) previousOutcomes.set(key, row);
  }
  const reconciliation = familyDefinitionHashes === undefined ? undefined : reconcileReadyInputs({
    candidatesByFamily, familyDefinitionHashes, previousPartitions: parent?.familyPartitions,
    history, cutoff, sameProofSource: parent !== null && canonicalJson(parent.cutoff) === canonicalJson(cutoff),
    forcedStatuses,
  });
  const inheritedOutcomes = new Map(reconciliation?.inheritedOutcomes ?? []);
  // The independent probe queue can advance after a Ready was published.
  // Never roll its newer attempt back or resurrect a completed queue entry
  // merely because the parent still contains its historical retryable row.
  for (const [key, row] of previousOutcomes) {
    if (row.status !== "retryable") continue;
    const queued = checkpoint.retryableAttemptsByCandidateKey[key];
    if (queued === undefined) {
      inheritedOutcomes.delete(key);
      previousOutcomes.delete(key);
      continue;
    }
    const { runId: _probeRunId, cutoff: probeSource, ...attempt } = queued;
    previousOutcomes.set(key, attempt);
    if (inheritedOutcomes.has(key)) {
      if (canonicalJson(probeSource) === canonicalJson(cutoff) &&
          canonicalJson(attempt.candidateSnapshot) === canonicalJson(candidatesByKey[key])) inheritedOutcomes.set(key, attempt);
      else inheritedOutcomes.delete(key);
    }
  }
  const historicalVerifiedKeys = new Set([
    ...Object.keys(checkpoint.verifiedMemos).filter(key =>
      !previousOutcomes.has(key) || previousOutcomes.get(key)!.status === "verified"),
    ...[...previousOutcomes].filter(([, row]) => row.status === "verified").map(([key]) => key),
  ]);
  const forcedKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = input.familyCandidateKey(candidate), row = previousOutcomes.get(key);
    const status = row?.status ?? (checkpoint.verifiedMemos[key] ? "verified" : undefined);
    if (status && status !== "covered" && forcedStatuses.has(status)) forcedKeys.add(key);
  }

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
    if (outcome.status !== "verified" || review || familyDefinitionHashes !== undefined) continue;
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
  const revalidation = createCandidateRevalidation({
    dependencies: input, candidates, cutoff,
    // History orders work only. A memo becomes a winner only when the
    // original reuse/retention/attestation path accepts it in this run.
    historicalVerifiedKeys,
  });
  // Completed outcomes inherit only under their sealed input/source binding.
  // Legacy runs retain their original explicit completion/retry policy.
  // Negative and covered rows never fabricate a verified Graph instance.
  const attestationCounts: Record<RunOutcome["status"], number> = {
    verified: 0,
    "terminal-rejected": 0,
    retryable: 0,
    covered: 0,
  };
  let completedPending = 0;
  const logAttestationProgress = (phase: "start" | "progress"): void => {
    const processed = completedPending;
    log(
      "universe rebuild attestation " + phase + ": processed=" + processed +
        "/" + candidates.length +
        " pending=" + (candidates.length - completedPending) +
        " verified=" + attestationCounts.verified +
        " terminalRejected=" + attestationCounts["terminal-rejected"] +
        " retryable=" + attestationCounts.retryable + " covered=" + attestationCounts.covered,
    );
  };
  logAttestationProgress("start");
  const recordAttestationProgress = (status: RunOutcome["status"]): void => {
    attestationCounts[status]++;
    completedPending++;
    if (
      completedPending === 1 ||
      completedPending % 100 === 0 ||
      completedPending === candidates.length
    ) {
      logAttestationProgress("progress");
    }
  };
  type Phase = "ordinary" | "review" | "strict";
  // Equal pool tasks serialize within each phase: once one succeeds, queued
  // competitors observe its coverage before doing an RPC. Different pools
  // retain the existing global concurrency/throttle policy.
  const poolTails = new Map<string, Promise<void>>();
  const inPool = async <T>(candidate: unknown, work: () => Promise<T>): Promise<T> => {
    const key = revalidation.poolTaskKey(candidate);
    const previous = poolTails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.then(() => undefined, () => undefined);
    poolTails.set(key, tail);
    try { return await next; }
    finally { if (poolTails.get(key) === tail) poolTails.delete(key); }
  };
  const processCandidate = async (
    candidate: unknown, phase: Phase, deferStrict = false,
  ): Promise<RunOutcome["status"] | "needs-strict"> => {
    const candidateKey = input.familyCandidateKey(candidate);
    const completedOutcome = run.outcomesByCandidateKey[candidateKey];
    const oldOutcome = completedOutcome ?? previousOutcomes.get(candidateKey);
    const forced = forcedKeys.has(candidateKey) && !(incumbentRun !== null && completedOutcome !== undefined);
    if (input.resumeCompletedOutcomes && completedOutcome !== undefined &&
        completedOutcome.status !== "verified" && completedOutcome.status !== "covered") {
      return completedOutcome.status;
    }
    let reusableMemo: DurableVerifiedMemo | null = null;
    if (!forced && phase !== "strict" && (!review || historicalVerifiedKeys.has(candidateKey)) &&
        (oldOutcome === undefined || oldOutcome.status === "verified") &&
        (familyDefinitionHashes === undefined || attestationCheckpoint.verifiedMemos[candidateKey] !== undefined)) {
      try {
        reusableMemo = await input.findReusableMemo({
          candidate,
          checkpoint: attestationCheckpoint,
          cutoff,
        });
        input.readyThrottle?.assertOpen();
      } catch (error) {
        if (input.readyThrottle?.isThrottle(error)) throw error;
        log(
          "universe rebuild memo revalidation failed for " + candidateKey +
            ": " + (error instanceof Error ? error.message : String(error)),
        );
      }
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
        completedOutcome?.status === "verified" &&
        completedOutcome.familyInstanceKey === reusableMemo.familyInstanceKey &&
        completedOutcome.memoFingerprint === reusableMemo.memoFingerprint
      ) {
        revalidation.confirmVerified(candidate, reusableMemo);
        return "verified";
      }
      writer.record(Object.freeze({
        status: "verified",
        familyCandidateKey: candidateKey,
        familyInstanceKey: reusableMemo.familyInstanceKey,
        memoFingerprint: reusableMemo.memoFingerprint,
      }));
      revalidation.confirmVerified(candidate, reusableMemo);
      return "verified";
    }
    if (phase === "review" || deferStrict) return "needs-strict";
    return await inPool(candidate, async () => {
      const covered = forced ? null : revalidation.coveredOutcome(candidate);
      if (covered !== null) {
        writer.record(covered);
        return "covered";
      }
      const sourceRetryable = input.preAttestationRetryable?.(candidate) ?? null;
      if (sourceRetryable !== null) {
        const attemptCount = oldOutcome?.status === "retryable"
          ? oldOutcome.attemptCount
          : 0;
        writer.record(Object.freeze({
          ...sourceRetryable,
          status: "retryable" as const,
          familyCandidateKey: candidateKey,
          familyId: String((candidate as { familyId?: unknown }).familyId ?? ""),
          attemptCount: attemptCount + 1,
          lastAttemptAt: new Date().toISOString(),
        }));
        return "retryable";
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
      input.readyThrottle?.assertOpen();
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
        revalidation.confirmVerified(candidate, memo);
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
    });
  };
  const requestedConcurrency = input.attestationConcurrency ?? 24;
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new Error("universe rebuild attestation concurrency is invalid");
  }
  input.readyThrottle?.limitConcurrency(requestedConcurrency);
  const reviewedCounts = { reusedPrevious: 0, restoredVerified: 0, newlyVerified: 0 };
  const runBatch = async (items: readonly unknown[], phase: Phase, deferred?: unknown[]) => {
    const work = async (candidate: unknown) => {
      const status = await processCandidate(candidate, phase, deferred !== undefined);
      return { candidate, status };
    };
    const completed = ({ candidate, status }: Awaited<ReturnType<typeof work>>) => {
      if (status === "needs-strict") {
        if (!deferred) throw new Error("strict candidate deferred without a pending set");
        deferred.push(candidate);
      }
      else {
        if (review && status === "verified") {
          if (phase === "strict") reviewedCounts.newlyVerified++;
          else if (run.outcomesByCandidateKey[input.familyCandidateKey(candidate)]?.status === "verified") reviewedCounts.restoredVerified++;
          else reviewedCounts.reusedPrevious++;
        }
        recordAttestationProgress(status);
      }
    };
    if (input.readyThrottle) {
      await input.readyThrottle.runCandidates(items, work, completed);
      return;
    }
    let next = 0;
    let failed = false;
    const workers = await Promise.allSettled(Array.from({
      length: Math.min(requestedConcurrency, items.length),
    }, async () => {
      while (!failed && next < items.length) {
        const candidate = items[next++];
        try { completed(await work(candidate)); }
        catch (error) {
          failed = true;
          log("universe rebuild attestation failed: candidate=" + input.familyCandidateKey(candidate) +
            " phase=" + phase + " error=" + (error instanceof Error ? error.message : String(error)));
          throw error;
        }
      }
    }));
    for (const result of workers) if (result.status === "rejected") throw result.reason;
  };
  const runPhase = async (items: readonly unknown[], phase: Phase, deferred?: unknown[]) => {
    // The original prechecks have already decided this strict set. Await the
    // old-success batch before allowing competing nominations to enter it.
    for (const batch of phase === "strict" ? revalidation.batches(items) : [items]) {
      await runBatch(batch, phase, deferred);
    }
  };
  try {
    // All callers submit a complete scope. The same reconciliation admits
    // unchanged partitions, then sends only unresolved tasks to one processor.
    const inherited = new Map(inheritedOutcomes);
    if (incumbentRun !== null) {
      for (const [key, row] of Object.entries(run.outcomesByCandidateKey)) {
        const id = candidateFamilyIds[key];
        const sameDefinition = id !== undefined && familyDefinitionHashes !== undefined &&
          run.familyDefinitionHashes?.[id] === familyDefinitionHashes[id];
        if (!sameDefinition) continue;
        // This attempt belongs to this exact sealed run, including its force
        // policy. A completed failed attempt also overrides a parent's success.
        inherited.delete(key);
        if (row.status !== "covered") inherited.set(key, row);
      }
    }
    // Legacy activation callers can still assert their retained set; it has
    // no separate processing branch or authority to bypass input comparison.
    for (const id of review?.retainedFamilyIds ?? []) {
      const partition = parent?.familyPartitions?.[id];
      if (!incumbentRun || !input.resumeCompletedOutcomes || !partition ||
          partition.familyDefinitionHash !== familyDefinitionHashes?.[id] ||
          canonicalJson(partition.candidatesByKey) !== canonicalJson(candidatesByFamily.get(id) ?? {}) ||
          canonicalJson(parent!.cutoff) !== canonicalJson(cutoff) || forcedStatuses.size !== 0) {
        throw new Error("retained Family inputs differ from the sealed parent: " + id);
      }
    }
    const accepted = new Set<string>();
    const inheritedWrites: { readonly outcome: RunOutcome }[] = [];
    const currentCandidates = new Map(candidates.map(candidate => [input.familyCandidateKey(candidate), candidate] as const));
    const admit = (key: string, row: RunOutcome): void => {
      accepted.add(key);
      if (canonicalJson(run.outcomesByCandidateKey[key] ?? null) !== canonicalJson(row)) inheritedWrites.push({ outcome: row });
      attestationCounts[row.status]++;
      completedPending++;
    };
    // Register every accepted winner before any pending nomination can claim
    // coverage. This indexes sealed results; it does not recheck their proof.
    for (const [key, row] of [...inherited].sort(([a], [b]) => a.localeCompare(b))) {
      if (row.status !== "verified" || !currentCandidates.has(key)) continue;
      const memo = attestationCheckpoint.verifiedMemos[key];
      if (!memo || memo.familyInstanceKey !== row.familyInstanceKey || memo.memoFingerprint !== row.memoFingerprint) {
        const parentRow = parent?.familyPartitions?.[candidateFamilyIds[key] ?? ""]?.outcomesByCandidateKey[key];
        if (parentRow?.status === "verified") throw new Error("inherited verified outcome lost its sealed memo: " + key);
        // Compatibility operations may have evicted an inactive historical
        // memo. An index entry without its evidence returns to normal work.
        inherited.delete(key);
        continue;
      }
      const duplicateOf = await claimInstanceKey(memo.familyInstanceKey, key);
      if (duplicateOf !== undefined) {
        recordDuplicateInstance(key, memo, duplicateOf);
        accepted.add(key); attestationCounts["terminal-rejected"]++; completedPending++;
        continue;
      }
      revalidation.inheritVerified(currentCandidates.get(key)!, memo);
      admit(key, row);
    }
    for (const [key, row] of inherited) {
      if (row.status === "verified" || row.status === "covered" || !currentCandidates.has(key)) continue;
      if (row.status === "terminal-rejected" && row.reasonCode === "duplicate-instance") {
        const winnerKey = row.requestFingerprint.slice("duplicate-instance:".length);
        const winner = attestationCheckpoint.verifiedMemos[winnerKey];
        if (!row.requestFingerprint.startsWith("duplicate-instance:") || !winner ||
            seenInstanceKeys.get(winner.familyInstanceKey) !== winnerKey) continue;
      }
      admit(key, row);
    }
    writer.recordBatch(inheritedWrites);
    if (accepted.size > 0) logAttestationProgress("progress");
    const pending = candidates.filter(candidate => !accepted.has(input.familyCandidateKey(candidate)));
    const priorVerified = pending.filter(candidate => historicalVerifiedKeys.has(input.familyCandidateKey(candidate)));
    const ordinary = pending.filter(candidate => !historicalVerifiedKeys.has(input.familyCandidateKey(candidate)));
    const sameSealedInput = incumbentRun !== null && !discoveryPlanChanged && !definitionInputChanged &&
      familyDefinitionHashes !== undefined &&
      canonicalJson(incumbentRun.familyDefinitionHashes ?? null) === canonicalJson(familyDefinitionHashes);
    log("Ready input reconciliation " + JSON.stringify({
      // Resume compares the sealed COMPLETE input, never the pending list.
      classes: sameSealedInput ? { A: candidates.length, B: 0, C: 0, D: 0 } : reconciliation?.classes ?? null,
      removed: sameSealedInput ? 0 : reconciliation?.removed ?? 0,
      inherited: accepted.size, priorVerified: priorVerified.length, remaining: ordinary.length,
      forced: forcedKeys.size,
    }));
    const strictPrevious: unknown[] = [];
    await runPhase(priorVerified, "review", strictPrevious);
    await runPhase(strictPrevious, "strict");
    const strictRemaining: unknown[] = [];
    await runPhase(ordinary, "ordinary", strictRemaining);
    await runPhase(strictRemaining, "strict");
    if (review) log("Ready review results " + JSON.stringify({ ...reviewedCounts,
      terminalRejected: attestationCounts["terminal-rejected"], retryable: attestationCounts.retryable,
      covered: attestationCounts.covered }));
  } catch (error) {
    log("universe rebuild attestation stopped: processed=" + completedPending +
      "/" + candidates.length + " pending=" + (candidates.length - completedPending) +
      " error=" + (error instanceof Error ? error.message : String(error)));
    throw error;
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
  const graphSnapshot = immutableReadyValue(input.buildGraphSnapshot(publications, cutoff));
  input.assertReadyGraphSnapshot?.({ publications, graphSnapshot, cutoff });
  const catalogSnapshot = buildReadyCatalogSnapshot(activeMemos);
  const familyPartitions = buildReadyFamilyPartitions(input, currentRun);
  const resultHistory = retainReadyResultHistory(checkpoint.readyGeneration, familyPartitions, cutoff);
  const ready = Object.freeze({
    ...(currentRun.familyUpdateScope === undefined ? {} : { familyUpdateScope: currentRun.familyUpdateScope }),
    ...(discoveryInputBinding === undefined ? {} : { discoveryInputBinding }),
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
    ...(familyPartitions === undefined ? {} : { familyPartitions }),
    ...(resultHistory === undefined ? {} : { resultHistory }),
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

function buildReadyFamilyPartitions(
  input: UniverseRebuildDependencies,
  run: InProgressUniverseRun,
): Readonly<Record<string, ReadyFamilyPartition>> | undefined {
  if (input.candidateFamilyId === undefined || input.familyDiscoveryDefinitionHash === undefined) return undefined;
  const candidatesByFamily = new Map<string, Record<string, unknown>>();
  for (const key of input.requiredSourceCoverageKeys()) candidatesByFamily.set(key.slice(0, key.indexOf("|")), {});
  for (const [key, snapshot] of Object.entries(run.candidatesByKey)) {
    const candidate = input.decodeCandidateSnapshot?.(snapshot) ?? snapshot;
    const familyId = input.candidateFamilyId(candidate);
    const candidates = candidatesByFamily.get(familyId);
    if (candidates === undefined) throw new Error("Ready candidate Family lacks source coverage: " + familyId);
    candidates[key] = snapshot;
  }
  return Object.freeze(Object.fromEntries([...candidatesByFamily].sort(([a], [b]) => a.localeCompare(b))
    .map(([familyId, candidates]) => [familyId, Object.freeze({
      enabled: true,
      ...(input.familyDefinitionHash && { familyDefinitionHash: input.familyDefinitionHash(familyId) }),
      candidatesByKey: Object.freeze(candidates),
      candidateSetHash: hashUniverseCandidatePartition(candidates),
      discoveryDefinitionHash: input.familyDiscoveryDefinitionHash!(familyId),
      outcomesByCandidateKey: Object.freeze(Object.fromEntries(Object.keys(candidates).sort()
        .map(key => [key, run.outcomesByCandidateKey[key]!]))),
      sourceReceipts: run.sourceReceipts,
    })])));
}

const READY_REFRESH_MAX_ATTEMPTS = 3;

/** Same attestation/Graph pipeline, restricted to the existing Ready set.
 * Never scans, invents source receipts, retries excluded candidates or moves
 * the historical cutoff. Only explicitly retryable attestations get bounded
 * retries; non-verified results cannot shrink the reused set.
 */
export async function refreshReadyInstances(input: UniverseRebuildDependencies & {
  readonly store: UniverseRebuildCheckpointStore;
  readonly attestationConcurrency?: number;
  readonly log?: (message: string) => void;
}): Promise<ReadyUniverseGeneration> {
  const checkpoint = await input.store.load();
  if (checkpoint === null) throw new Error("ready refresh checkpoint is absent");
  assertRestrictionNotExpanded(checkpoint.readyGeneration, input.isFamilyEnabled);
  const oldMemos = activeReadyMemos(checkpoint);
  assertReadyFamilyActivation(oldMemos, input.isFamilyEnabled);
  const ready = checkpoint.readyGeneration!;
  const cutoff = ready.cutoff;
  const concurrency = input.attestationConcurrency ?? 24;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("ready refresh concurrency must be a positive integer");
  }
  const decodeCandidate = input.decodeCandidateSnapshot ?? ((value: unknown) => value);
  await input.assertCanonicalHead(cutoff);
  const memos = new Array<DurableVerifiedMemo>(oldMemos.length);
  const currentCandidateSnapshots = new Map<string, unknown>();
  const oldCovered = new Map<string, CoveredCandidateOutcome>();
  const coveredCandidates: unknown[] = [];
  for (const partition of Object.values(ready.familyPartitions ?? {})) {
    if (!partition.enabled) continue;
    for (const [key, snapshot] of Object.entries(partition.candidatesByKey)) {
      // Original memo reuse may retain an older observation snapshot. Coverage
      // always binds the Ready partition's nomination, just like activation.
      currentCandidateSnapshots.set(key, snapshot);
    }
    for (const row of Object.values(partition.outcomesByCandidateKey)) {
      if (row.status !== "covered") continue;
      if (input.isFamilyEnabled?.(row.familyId) === false) {
        throw new Error("ready refresh covered Family is disabled; activation required");
      }
      const candidate = decodeCandidate(partition.candidatesByKey[row.familyCandidateKey]);
      if (input.familyCandidateKey(candidate) !== row.familyCandidateKey) {
        throw new Error("ready refresh covered candidate key changed");
      }
      oldCovered.set(row.familyCandidateKey, row);
      coveredCandidates.push(candidate);
    }
  }
  // With no derived rows, leave even decoder calls to the original worker.
  const currentCandidates = new Map(oldCovered.size === 0 ? [] : oldMemos.map(old =>
    [old.familyCandidateKey, decodeCandidate(currentCandidateSnapshots.get(old.familyCandidateKey) ?? old.candidateSnapshot)] as const));
  const revalidation = createCandidateRevalidation({
    dependencies: input, candidates: [...currentCandidates.values(), ...coveredCandidates], cutoff,
    historicalVerifiedKeys: new Set(oldMemos.map(memo => memo.familyCandidateKey)),
    preserveHistoricalVerified: true,
  });
  const inheritedFamilies = currentReadyDefinitionFamilies(input, ready.familyPartitions);
  let next = 0;
  let completed = 0;
  let refreshed = 0;
  let stop = false;
  const pendingIndexes: number[] = [];
  for (let index = 0; index < oldMemos.length; index++) {
    const old = oldMemos[index]!;
    if (!inheritedFamilies.has(old.familyId)) { pendingIndexes.push(index); continue; }
    memos[index] = old;
    if (oldCovered.size !== 0) revalidation.inheritVerified(currentCandidates.get(old.familyCandidateKey)!, old);
    completed++;
  }
  const refreshOne = async (index: number): Promise<void> => {
      input.readyThrottle?.assertOpen();
      const old = oldMemos[index]!;
      const candidate = decodeCandidate(old.candidateSnapshot);
      if (input.familyCandidateKey(candidate) !== old.familyCandidateKey) {
        throw new Error("ready refresh candidate key changed");
      }
      // Ready already validated this exact set at this exact cutoff. Do not
      // re-attest unrelated dependency-proof Funding when only code-defined
      // descriptors changed; its stored proof is neither moved nor renewed.
      const reusable = input.isReadyMemoDefinitionCurrent === undefined
        ? await input.findReusableMemo({ candidate, checkpoint, cutoff })
        : input.isReadyMemoDefinitionCurrent(old) ? old : null;
      input.readyThrottle?.assertOpen();
      if (reusable !== null) {
        memos[index] = reusable;
      } else {
        if (stop) return;
        let attempt = 1;
        let result = await input.attestFamilyInstanceOnce({ candidate, cutoff });
        input.readyThrottle?.assertOpen();
        while (result.status !== "verified") {
          const failure = `ready refresh ${old.familyCandidateKey}: attempt=${attempt}/${READY_REFRESH_MAX_ATTEMPTS} ${result.status} ${result.reasonCode}`;
          input.log?.(failure);
          if (result.status !== "retryable" || attempt === READY_REFRESH_MAX_ATTEMPTS) {
            throw new Error(`${failure}; incumbent unchanged`);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, attempt * 250));
          if (stop) return;
          attempt++;
          result = await input.attestFamilyInstanceOnce({ candidate, cutoff });
          input.readyThrottle?.assertOpen();
        }
        memos[index] = input.sealDurableVerifiedMemo({
          candidate, result: result.result, proofSource: cutoff,
          familyCandidateKey: old.familyCandidateKey,
        });
        refreshed++;
      }
      if (oldCovered.size !== 0) {
        revalidation.confirmVerified(currentCandidates.get(old.familyCandidateKey)!, memos[index]!);
      }
      completed++;
      if (completed === 1 || completed % 100 === 0 || completed === oldMemos.length) {
        input.log?.(`ready instance refresh ${completed}/${oldMemos.length} reattested=${refreshed}`);
      }
  };
  if (input.readyThrottle) {
    input.readyThrottle.limitConcurrency(concurrency);
    await input.readyThrottle.runCandidates(pendingIndexes, refreshOne, () => {});
  } else {
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, pendingIndexes.length) }, async () => {
      try {
        for (;;) {
          if (stop) return;
          const position = next++;
          if (position >= pendingIndexes.length) return;
          await refreshOne(pendingIndexes[position]!);
        }
      } catch (error) { stop = true; throw error; }
    }));
    const failed = workers.find(worker => worker.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  // Every refresh input is already a historical verified instance, so keep
  // the original per-worker reuse -> strict -> stop sequence above. There is
  // no remaining candidate batch to prioritize or admit in this exact set.
  const coveredOutcomes = coveredCandidates.map(candidate => {
    const row = revalidation.coveredOutcome(candidate);
    if (!row) throw new Error("ready refresh coverage cannot retain its winner; incumbent unchanged");
    return row;
  });
  const coverageUnchanged = coveredOutcomes.every(row => canonicalJson(row) === canonicalJson(oldCovered.get(row.familyCandidateKey)));
  if (coverageUnchanged && memos.every((memo, index) => memo.memoFingerprint === oldMemos[index]!.memoFingerprint)) {
    await input.assertCanonicalHead(cutoff);
    if ((await input.store.load())?.revision !== checkpoint.revision) {
      throw new Error("ready refresh checkpoint changed during validation");
    }
    return ready;
  }
  const instances = memos.map((memo) => input.rehydrateVerifiedInstance({ memo, cutoff }));
  const graphSnapshot = input.buildGraphSnapshot(input.aggregateOnceByFamily(instances), cutoff);
  await input.assertCanonicalHead(cutoff);
  const updated = await input.store.casRefreshReadyInstances({
    expectedRevision: checkpoint.revision, memos, graphSnapshot,
    ...(oldCovered.size === 0 ? {} : { coveredOutcomes }),
  });
  return updated.readyGeneration!;
}

/** Explicit activation-only subset of one completed Ready. No discovery,
 * attestation or retry fallback, and never an authority to activate new Families.
 */
export async function restrictReadyFamilies(input: UniverseRebuildDependencies & {
  readonly store: UniverseRebuildCheckpointStore;
  readonly log?: (message: string) => void;
}): Promise<ReadyUniverseGeneration> {
  const checkpoint = immutableReadyValue(await input.store.load());
  if (checkpoint === null) throw new Error("Ready restriction checkpoint is absent");
  const oldMemos = activeReadyMemos(checkpoint);
  const ready = checkpoint.readyGeneration!;
  if (input.isFamilyEnabled === undefined || input.isReadyMemoDefinitionCurrent === undefined ||
    input.assertReadyGraphSnapshot === undefined) {
    throw new Error("Ready restriction requires activation, definition and Graph validators");
  }
  assertRestrictionNotExpanded(ready, input.isFamilyEnabled);
  const enabledIds = readyActivationFamilies(ready, input.requiredSourceCoverageKeys(), input.isFamilyEnabled);
  const knownIds = Object.keys(ready.familyPartitions ?? Object.fromEntries(ready.sourceCoverage.map(entry => [entry.familyId, true])));
  const priorDisabled = new Set(ready.activationRestriction?.disabledFamilyIds ?? []);
  const enabledByFamily = new Map<string, boolean>();
  for (const id of knownIds) enabledByFamily.set(id, enabledIds.includes(id));
  const retained = oldMemos.filter(memo => enabledByFamily.get(memo.familyId));
  const disabledFamilyIds = Object.freeze([...enabledByFamily].filter(([id, enabled]) => !enabled && !priorDisabled.has(id)).map(([id]) => id).sort());
  const oldCoverage = new Set(ready.sourceCoverage.map(entry => entry.familyId + "|" + entry.sourceId));
  if (input.requiredSourceCoverageKeys().some(key => !oldCoverage.has(key))) {
    throw new Error("Ready restriction cannot expand historical source coverage; rebuild required");
  }
  const inheritedFamilies = currentReadyDefinitionFamilies(input, ready.familyPartitions);
  for (const memo of retained) {
    if (inheritedFamilies.has(memo.familyId)) continue;
    if (input.isReadyMemoDefinitionCurrent(memo) !== true) {
      throw new Error("Ready restriction retained definition is stale: " + memo.familyCandidateKey);
    }
  }
  assertReadyCoverageCurrent(input, ready.familyPartitions, new Set(enabledIds));
  await input.assertCanonicalHead(ready.cutoff);
  const instances = retained.map(memo => input.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff }));
  const publications = input.aggregateOnceByFamily(instances);
  const graphSnapshot = immutableReadyValue(input.buildGraphSnapshot(publications, ready.cutoff));
  const graphValidation = validateReadyFamilyGraph({ checkpoint,
    mutation: { kind: "restrict", disabledFamilyIds }, graphSnapshot,
    assertGraph: graph => input.assertReadyGraphSnapshot!({ publications, graphSnapshot: graph, cutoff: ready.cutoff }) });
  await input.assertCanonicalHead(ready.cutoff);
  if (disabledFamilyIds.length === 0) {
    if (canonicalJson(graphSnapshot) !== canonicalJson(ready.graphSnapshot)) {
      throw new Error("Ready restriction no-op Graph differs from incumbent");
    }
    if ((await input.store.load())?.revision !== checkpoint.revision) {
      throw new Error("Ready restriction checkpoint changed during validation");
    }
    return ready;
  }
  const next = await input.store.casRestrictReadyFamilies({
    expectedRevision: checkpoint.revision, disabledFamilyIds, graphSnapshot, graphValidation,
  });
  input.log?.(`Ready activation restriction: generation=${next.readyGeneration!.generation} ` +
    `retained=${retained.length} excluded=${oldMemos.length - retained.length} scans=0 attestations=0`);
  return next.readyGeneration!;
}

/** Publish desired activation plus completed scoped supplements in one CAS.
 * Old evidence can restore a disabled set only while both definitions remain current.
 * Stale/missing Families must first use the ordinary scoped rebuild pipeline.
 */
export async function updateReadyFamilies(input: UniverseRebuildDependencies & {
  readonly store: UniverseRebuildCheckpointStore;
  readonly expectedRevision?: number;
  readonly supplements?: ReadyFamilyUpdateInput["supplements"];
  readonly log?: (message: string) => void;
}): Promise<ReadyUniverseGeneration> {
  const supplements = immutableReadyValue(input.supplements ?? []);
  const checkpoint = immutableReadyValue(await input.store.load());
  if (checkpoint === null) throw new Error("Ready Family update checkpoint is absent");
  if (input.expectedRevision !== undefined && checkpoint.revision !== input.expectedRevision) {
    throw new Error("Ready Family update incumbent changed during preparation");
  }
  if (input.isFamilyEnabled === undefined || input.isReadyMemoDefinitionCurrent === undefined ||
    input.familyDiscoveryDefinitionHash === undefined || input.assertReadyGraphSnapshot === undefined) {
    throw new Error("Ready Family update requires activation, definition and Graph validators");
  }
  const ready = checkpoint.readyGeneration;
  if (ready === null) throw new Error("Ready Family update checkpoint is absent");
  const coverageKeys = immutableReadyValue(input.requiredSourceCoverageKeys());
  const enabledFamilyIds = readyActivationFamilies(ready, coverageKeys, input.isFamilyEnabled, supplements.flatMap(entry => entry.familyIds));
  const update = Object.freeze({ enabledFamilyIds, supplements });
  const plan = prepareReadyFamilyUpdate(checkpoint, update);
  const availableCoverage = new Set(plan.sourceCoverage.map(entry => entry.familyId + "|" + entry.sourceId));
  if (coverageKeys.some(key => !availableCoverage.has(key))) throw new Error("Ready Family update lacks required source coverage");
  for (const id of enabledFamilyIds) {
    if (plan.familyPartitions[id]!.discoveryDefinitionHash !== input.familyDiscoveryDefinitionHash(id)) {
      throw new Error("Ready Family discovery definition is stale; scoped rebuild required: " + id);
    }
  }
  const inheritedFamilies = currentReadyDefinitionFamilies(input, plan.familyPartitions);
  for (const memo of plan.activeMemos) {
    if (inheritedFamilies.has(memo.familyId)) continue;
    if (input.isReadyMemoDefinitionCurrent(memo) !== true) {
      throw new Error("Ready Family retained definition is stale; scoped rebuild required: " + memo.familyId);
    }
  }
  assertReadyCoverageCurrent(input, plan.familyPartitions, new Set(enabledFamilyIds));
  await input.assertCanonicalHead(ready.cutoff);
  const instances = plan.activeMemos.map(memo => input.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff }));
  const publications = input.aggregateOnceByFamily(instances);
  const graphSnapshot = immutableReadyValue(input.buildGraphSnapshot(publications, ready.cutoff));
  const graphValidation = validateReadyFamilyGraph({ checkpoint, mutation: { kind: "update", ...update }, graphSnapshot,
    assertGraph: graph => input.assertReadyGraphSnapshot!({ publications, graphSnapshot: graph, cutoff: ready.cutoff }) });
  await input.assertCanonicalHead(ready.cutoff);
  if (update.supplements.length === 0 && canonicalJson(plan.familyPartitions) === canonicalJson(ready.familyPartitions)) {
    if (canonicalJson(graphSnapshot) !== canonicalJson(ready.graphSnapshot) ||
      (await input.store.load())?.revision !== checkpoint.revision) {
      throw new Error("Ready Family no-op validation differs from incumbent");
    }
    return ready;
  }
  const next = await input.store.casUpdateReadyFamilies({ expectedRevision: checkpoint.revision, ...update, graphSnapshot, graphValidation });
  input.log?.(`Ready Family update: generation=${next.readyGeneration!.generation} ` +
    `active=${plan.activeMemos.length} excluded=${plan.excludedMemos.length} replaced=${plan.replacedFamilyIds.join(",")}`);
  return next.readyGeneration!;
}

function currentReadyDefinitionFamilies(input: UniverseRebuildDependencies,
  partitions: Readonly<Record<string, ReadyFamilyPartition>> | undefined): ReadonlySet<string> {
  return new Set(input.familyDefinitionHash === undefined ? [] : Object.entries(partitions ?? {})
    .filter(([id, partition]) => input.isFamilyEnabled?.(id) !== false && partition.familyDefinitionHash !== undefined &&
      partition.familyDefinitionHash === input.familyDefinitionHash!(id)).map(([id]) => id));
}

function assertReadyCoverageCurrent(
  input: UniverseRebuildDependencies,
  partitions: Readonly<Record<string, ReadyFamilyPartition>> | undefined,
  enabled: ReadonlySet<string>,
): void {
  const covered = Object.entries(partitions ?? {}).flatMap(([id, partition]) =>
    enabled.has(id) ? Object.values(partition.outcomesByCandidateKey).filter(
      (row): row is CoveredCandidateOutcome => row.status === "covered") : []);
  if (covered.length === 0) return;
  const candidates = new Map<string, { readonly familyId: string; readonly snapshot: unknown }>();
  for (const [id, partition] of Object.entries(partitions ?? {})) {
    for (const [key, snapshot] of Object.entries(partition.candidatesByKey)) {
      candidates.set(key, { familyId: id, snapshot });
    }
  }
  const decode = input.decodeCandidateSnapshot ?? ((value: unknown) => value);
  for (const outcome of covered) {
    const candidate = candidates.get(outcome.familyCandidateKey);
    const winner = candidates.get(outcome.winnerFamilyCandidateKey);
    if (!candidate || !winner || !enabled.has(winner.familyId)) {
      throw new Error("Ready candidate coverage lost its active winner; review required");
    }
    assertCurrentCandidateCoverage({ dependencies: input, outcome,
      candidate: decode(candidate.snapshot), winnerCandidate: decode(winner.snapshot) });
  }
}

function assertRestrictionNotExpanded(
  ready: ReadyUniverseGeneration | null,
  isFamilyEnabled: UniverseRebuildDependencies["isFamilyEnabled"],
): void {
  const disabled = new Set([...(ready?.activationRestriction?.disabledFamilyIds ?? []),
    ...Object.entries(ready?.familyPartitions ?? {}).filter(([, partition]) => !partition.enabled).map(([id]) => id)]);
  if ([...disabled].some(id => isFamilyEnabled?.(id) !== false)) {
    throw new Error("Ready activation restriction cannot re-enable excluded Families; rebuild required");
  }
}

function readyCoverageFamilyIds(keys: readonly string[]): string[] {
  if (new Set(keys).size !== keys.length || keys.some(key => key.indexOf("|") <= 0 || key.endsWith("|") || key.split("|").length !== 2)) {
    throw new Error("Ready Family activation/coverage keys are invalid");
  }
  return [...new Set(keys.map(key => key.slice(0, key.indexOf("|"))))].sort();
}

function readyActivationFamilies(ready: ReadyUniverseGeneration, coverageKeys: readonly string[],
  isEnabled: (id: string) => boolean, extra: readonly string[] = []): readonly string[] {
  const enabled = readyCoverageFamilyIds(coverageKeys);
  const known = new Set([...Object.keys(ready.familyPartitions ?? {}), ...ready.sourceCoverage.map(entry => entry.familyId), ...extra, ...enabled]);
  for (const id of known) {
    const active = isEnabled(id);
    if (typeof active !== "boolean" || active !== enabled.includes(id)) {
      throw new Error("Ready Family activation/coverage mismatch: " + id);
    }
  }
  return Object.freeze(enabled);
}

/** Reuse proves an exact Ready set; an operator switch cannot silently shrink it. */
export function assertReadyFamilyActivation(
  memos: readonly { readonly familyId: string }[],
  isFamilyEnabled: UniverseRebuildDependencies["isFamilyEnabled"],
): void {
  const disabled = [...new Set(memos
    .filter((memo) => isFamilyEnabled?.(memo.familyId) === false)
    .map((memo) => memo.familyId))].sort();
  if (disabled.length > 0) {
    throw new Error(
      "Ready contains disabled Families: " + disabled.join(",") +
        "; rebuild Ready with the plugin activation settings before reusing it",
    );
  }
}

function validateExplicitObservationRange(input: {
  readonly fromBlock: number;
  readonly toBlock: number;
}): { readonly fromBlock: number; readonly toBlock: number } {
  if (
    !Number.isSafeInteger(input.fromBlock) ||
    !Number.isSafeInteger(input.toBlock) ||
    input.fromBlock < 0 ||
    input.toBlock < input.fromBlock
  ) {
    throw new Error("universe rebuild: explicit range is invalid");
  }
  const span = input.toBlock - input.fromBlock + 1;
  // Reuse the sole production bound; an explicit range changes the anchor,
  // never the maximum amount of historical authority collected in one run.
  strictEdgeCollectionFromBlock(input.toBlock, span);
  return Object.freeze({
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
  });
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
  plan: {
    readonly startup: string;
    readonly activity: string;
  },
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
  plan: {
    readonly startup: string;
    readonly activity: string;
  },
): void {
  for (const receipt of receipts) {
    const expected = receipt.sourceKind === "startup-candidate-union"
      ? plan.startup
      : receipt.sourceKind === "catalog-activity-union"
        ? plan.activity
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
    (required.size === 0 && receipts.length !== 0) ||
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
      status !== "retryable" &&
      status !== "covered"
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
    ...(outcomes.some(outcome => outcome.status === "covered")
      ? { covered: outcomes.filter(outcome => outcome.status === "covered").length } : {}),
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
}): Promise<Exclude<RunOutcome, CoveredCandidateOutcome>> {
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
  let next: Exclude<RunOutcome, CoveredCandidateOutcome>;
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
  return canonicalJsonFingerprint(candidatesByKey, "universe-candidate-partition-v1:");
}

export function hashReadyPublicationSet(catalogSnapshot: unknown): string {
  return canonicalJsonFingerprint(catalogSnapshot, "publications-v2:");
}

export function hashReadyGraphSnapshot(graph: unknown): string {
  return canonicalJsonFingerprint(graph, "graph-v2:");
}

export function hashReadyCatalogSnapshot(catalog: unknown): string {
  return canonicalJsonFingerprint(catalog, "catalog-v1:");
}

function createDigest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}
