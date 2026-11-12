import {
  assertDurableVerifiedMemoFingerprint,
  durableCandidateSnapshotFingerprint,
  type CandidateCoverageBinding,
  type CoveredCandidateOutcome,
  type DurableVerifiedMemo,
} from "./universe-rebuild-checkpoint.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import type { UniverseRebuildDependencies } from "./universe-rebuild-runner.js";

/** The caller has already applied its original hash, reuse, retry and resume
 * rules. This subprocess only orders the resulting redo set and accounts for
 * equivalent tasks after the caller accepts a current verified result. It has
 * no memo lookup, attestation, retention or retry authority of its own. */
export function createCandidateRevalidation(input: {
  readonly dependencies: UniverseRebuildDependencies;
  readonly candidates: readonly unknown[];
  readonly cutoff: CanonicalSource;
  readonly historicalVerifiedKeys: ReadonlySet<string>;
  readonly preserveHistoricalVerified?: boolean;
}): {
  readonly confirmVerified: (candidate: unknown, memo: DurableVerifiedMemo) => void;
  readonly inheritVerified: (candidate: unknown, memo: DurableVerifiedMemo) => void;
  readonly poolTaskKey: (candidate: unknown) => string;
  readonly batches: (redoCandidates: readonly unknown[]) => readonly (readonly unknown[])[];
  readonly coveredOutcome: (candidate: unknown) => CoveredCandidateOutcome | null;
} {
  const deps = input.dependencies;
  const candidatesByKey = new Map(input.candidates.map(candidate =>
    [deps.familyCandidateKey(candidate), candidate] as const));
  const coverageByKey = new Map<string, CandidateCoverageBinding | null>();
  const coverage = (candidate: unknown): CandidateCoverageBinding | null => {
    const key = deps.familyCandidateKey(candidate);
    if (coverageByKey.has(key)) return coverageByKey.get(key)!;
    const binding = deps.candidateCoverage?.(candidate) ?? null;
    if (binding && (!binding.key || !binding.fingerprint || !binding.candidateFingerprint ||
        deps.candidateFamilyId === undefined || deps.familyDefinitionHash === undefined)) {
      throw new Error("Ready candidate coverage requires a bound Family, candidate and definition");
    }
    coverageByKey.set(key, binding);
    return binding;
  };
  const confirmed = new Map<string, {
    readonly candidateKey: string;
    readonly memo: DurableVerifiedMemo;
    readonly binding: CandidateCoverageBinding;
  }>();
  const register = (candidate: unknown, memo: DurableVerifiedMemo, sealedPartition: boolean): void => {
      const key = deps.familyCandidateKey(candidate);
      // Historical memos outside this run are scheduling hints, never winners.
      if (!candidatesByKey.has(key)) return;
      const binding = coverage(candidate);
      if (!binding || binding.candidateFingerprint !== memo.candidateFingerprint) return;
      // Additional checks apply only to the new authority to cover another
      // candidate. They do not change ordinary memo acceptance or validity.
      if (!sealedPartition) assertDurableVerifiedMemoFingerprint(memo);
      if (memo.familyCandidateKey !== key || deps.candidateFamilyId!(candidate) !== memo.familyId) {
        throw new Error("Ready candidate coverage winner binding differs: " + key);
      }
      if (!confirmed.has(binding.key)) confirmed.set(binding.key, { candidateKey: key, memo, binding });
  };
  return Object.freeze({
    confirmVerified: (candidate: unknown, memo: DurableVerifiedMemo): void => register(candidate, memo, false),
    // The runner accepted this sealed partition as a whole. Registering its
    // pool index must not repeat each memo's definition/proof validation.
    inheritVerified: (candidate: unknown, memo: DurableVerifiedMemo): void => register(candidate, memo, true),
    poolTaskKey: (candidate: unknown): string => coverage(candidate)?.key ?? deps.familyCandidateKey(candidate),
    batches(redoCandidates: readonly unknown[]): readonly (readonly unknown[])[] {
      const historical: unknown[] = [], remaining: unknown[] = [];
      for (const candidate of redoCandidates) {
        (input.historicalVerifiedKeys.has(deps.familyCandidateKey(candidate))
          ? historical : remaining).push(candidate);
      }
      // Callers await each batch using their existing scheduler. Merely
      // sorting one concurrent queue would let competitors start too early.
      return [historical, remaining].filter(batch => batch.length !== 0);
    },
    coveredOutcome(candidate: unknown): CoveredCandidateOutcome | null {
      const key = deps.familyCandidateKey(candidate);
      // Existing independent verified instances retain their own proof. This
      // also preserves the exact-set contract of refreshReadyInstances.
      if ((input.preserveHistoricalVerified && input.historicalVerifiedKeys.has(key)) || !candidatesByKey.has(key)) return null;
      const binding = coverage(candidate);
      if (!binding) return null;
      const winner = confirmed.get(binding.key);
      if (!winner || winner.candidateKey === key) return null;
      const familyId = deps.candidateFamilyId!(candidate);
      return Object.freeze({
        status: "covered",
        familyCandidateKey: key,
        familyId,
        candidateFingerprint: binding.candidateFingerprint,
        candidateSnapshotFingerprint: durableCandidateSnapshotFingerprint(
          deps.encodeCandidateSnapshot?.(candidate) ?? candidate,
        ),
        familyDefinitionHash: deps.familyDefinitionHash!(familyId),
        coverageKey: binding.key,
        coverageFingerprint: binding.fingerprint,
        winnerFamilyCandidateKey: winner.candidateKey,
        winnerMemoFingerprint: winner.memo.memoFingerprint,
        winnerCoverageFingerprint: winner.binding.fingerprint,
        cutoff: Object.freeze({ number: input.cutoff.number, hash: input.cutoff.hash }),
      });
    },
  });
}

/** Activation keeps its zero-attestation contract. A saved skip may only be
 * retained while both Family-owned bindings still describe the current task. */
export function assertCurrentCandidateCoverage(input: {
  readonly dependencies: UniverseRebuildDependencies;
  readonly candidate: unknown;
  readonly winnerCandidate: unknown;
  readonly outcome: CoveredCandidateOutcome;
}): void {
  const deps = input.dependencies;
  const row = input.outcome;
  const binding = deps.candidateCoverage?.(input.candidate);
  const winnerBinding = deps.candidateCoverage?.(input.winnerCandidate);
  if (!binding || !winnerBinding ||
      deps.familyCandidateKey(input.candidate) !== row.familyCandidateKey ||
      deps.familyCandidateKey(input.winnerCandidate) !== row.winnerFamilyCandidateKey ||
      deps.candidateFamilyId?.(input.candidate) !== row.familyId ||
      deps.familyDefinitionHash?.(row.familyId) !== row.familyDefinitionHash ||
      binding.key !== row.coverageKey || winnerBinding.key !== row.coverageKey ||
      binding.fingerprint !== row.coverageFingerprint ||
      binding.candidateFingerprint !== row.candidateFingerprint ||
      winnerBinding.fingerprint !== row.winnerCoverageFingerprint) {
    throw new Error("Ready candidate coverage is no longer current; review required: " + row.familyCandidateKey);
  }
}
