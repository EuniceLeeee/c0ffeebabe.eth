import {
  canonicalJson,
  canonicalJsonFingerprint,
  type ReadyFamilyPartition,
  type ReadyResultHistoryPartition,
  type ReadyUniverseGeneration,
  type RunOutcome,
} from "./universe-rebuild-checkpoint.js";

export type ForcedReadyStatus = "verified" | "terminal-rejected" | "retryable";
export type ReadyInputClass = "A" | "B" | "C" | "D";

/** Scope is the complete input, never the unfinished work queue. Definitions
 * are the existing per-Family final hashes; this module invents no new rule
 * hash and has no protocol, discovery, memo-proof or RPC semantics. */
export function reconcileReadyInputs(input: {
  readonly candidatesByFamily: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly familyDefinitionHashes: Readonly<Record<string, string>>;
  readonly previousPartitions?: Readonly<Record<string, ReadyFamilyPartition>>;
  readonly history?: readonly ReadyResultHistoryPartition[];
  readonly cutoff: ReadyUniverseGeneration["cutoff"];
  readonly sameProofSource: boolean;
  readonly forcedStatuses: ReadonlySet<ForcedReadyStatus>;
}): {
  readonly inheritedOutcomes: ReadonlyMap<string, RunOutcome>;
  readonly forcedKeys: ReadonlySet<string>;
  readonly classes: Readonly<Record<ReadyInputClass, number>>;
  readonly removed: number;
} {
  const inherited = new Map<string, RunOutcome>();
  const forced = new Set<string>();
  const classes: Record<ReadyInputClass, number> = { A: 0, B: 0, C: 0, D: 0 };
  let removed = 0;
  for (const [familyId, candidates] of input.candidatesByFamily) {
    const previous = input.previousPartitions?.[familyId];
    const currentHash = input.familyDefinitionHashes[familyId];
    const history = input.history?.find(partition => partition.familyId === familyId &&
      partition.familyDefinitionHash === currentHash && canonicalJson(partition.cutoff) === canonicalJson(input.cutoff));
    // A new member has no changed old definition. It is B, not D.
    const definitionChanged = previous?.familyDefinitionHash !== undefined &&
      previous.familyDefinitionHash !== currentHash;
    const sameDefinition = previous?.familyDefinitionHash !== undefined &&
      previous.familyDefinitionHash === currentHash;
    const samePartition = previous !== undefined && previous.candidateSetHash ===
      canonicalJsonFingerprint(candidates, "universe-candidate-partition-v1:");
    for (const [key, snapshot] of Object.entries(candidates)) {
      const oldSnapshot = previous?.candidatesByKey[key];
      const sameMember = samePartition || (oldSnapshot !== undefined &&
        canonicalJson(oldSnapshot) === canonicalJson(snapshot));
      classes[sameMember ? (definitionChanged ? "C" : "A") : (definitionChanged ? "D" : "B")]++;
      const old = previous?.outcomesByCandidateKey[key] ?? history?.outcomesByCandidateKey[key];
      if (old && old.status !== "covered" && input.forcedStatuses.has(old.status)) {
        forced.add(key);
      }
      // Coverage is derived from a CURRENT accepted winner and is regenerated
      // after winners have been registered. It is never independent proof.
      if (sameMember && sameDefinition && input.sameProofSource && old &&
          old.status !== "covered" && !forced.has(key)) inherited.set(key, old);
      else if (!forced.has(key) && history?.outcomesByCandidateKey[key] &&
          history.outcomesByCandidateKey[key]!.status !== "covered" &&
          canonicalJson(history.candidatesByKey[key]) === canonicalJson(snapshot)) {
        inherited.set(key, history.outcomesByCandidateKey[key]!);
      }
    }
    for (const key of Object.keys(previous?.candidatesByKey ?? {})) {
      if (!(key in candidates)) removed++;
    }
  }
  for (const [id, previous] of Object.entries(input.previousPartitions ?? {})) {
    if (!input.candidatesByFamily.has(id)) removed += Object.keys(previous.candidatesByKey).length;
  }
  return Object.freeze({ inheritedOutcomes: inherited, forcedKeys: forced,
    classes: Object.freeze(classes), removed });
}

/** Compact history keeps one latest row per candidate, grouped by its actual
 * definition/source. Removed members remain here without inflating active
 * accounting. Current rows already live in familyPartitions and are not
 * serialized twice. A changed definition never gets stamped onto old evidence. */
export function retainReadyResultHistory(
  parent: ReadyUniverseGeneration | null | undefined,
  partitions: Readonly<Record<string, ReadyFamilyPartition>> | undefined,
  _cutoff: ReadyUniverseGeneration["cutoff"],
): readonly ReadyResultHistoryPartition[] | undefined {
  if (partitions === undefined) return parent?.resultHistory;
  const rows = [...(parent?.resultHistory ?? [])];
  const add = (familyId: string, partition: ReadyFamilyPartition, source: ReadyUniverseGeneration["cutoff"]) => {
    if (partition.familyDefinitionHash === undefined) return;
    const keys = new Set(Object.keys(partition.candidatesByKey));
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.familyId !== familyId) continue;
      const kept = Object.keys(row.candidatesByKey).filter(key => !keys.has(key));
      if (kept.length === 0) { rows.splice(i, 1); continue; }
      if (kept.length === Object.keys(row.candidatesByKey).length) continue;
      const candidatesByKey = Object.fromEntries(kept.map(key => [key, row.candidatesByKey[key]]));
      rows[i] = { ...row, candidatesByKey,
        candidateSetHash: canonicalJsonFingerprint(candidatesByKey, "universe-candidate-partition-v1:"),
        outcomesByCandidateKey: Object.fromEntries(kept.map(key => [key, row.outcomesByCandidateKey[key]!])) };
    }
    if (keys.size === 0) return;
    const index = rows.findIndex(row => row.familyId === familyId && row.familyDefinitionHash === partition.familyDefinitionHash &&
      canonicalJson(row.cutoff) === canonicalJson(source));
    const previous = index < 0 ? undefined : rows[index];
    const candidatesByKey = { ...previous?.candidatesByKey, ...partition.candidatesByKey };
    const row: ReadyResultHistoryPartition = {
      familyId, cutoff: source, familyDefinitionHash: partition.familyDefinitionHash,
      candidatesByKey, candidateSetHash: canonicalJsonFingerprint(candidatesByKey, "universe-candidate-partition-v1:"),
      outcomesByCandidateKey: { ...previous?.outcomesByCandidateKey, ...partition.outcomesByCandidateKey },
    };
    if (index < 0) rows.push(row); else rows[index] = row;
  };
  for (const [id, partition] of Object.entries(parent?.familyPartitions ?? {})) add(id, partition, parent!.cutoff);
  const currentKeys = new Set(Object.values(partitions).flatMap(partition => Object.keys(partition.candidatesByKey)));
  const retired = rows.flatMap(row => {
    const keys = Object.keys(row.candidatesByKey).filter(key => !currentKeys.has(key));
    if (keys.length === 0) return [];
    if (keys.length === Object.keys(row.candidatesByKey).length) return [row];
    const candidatesByKey = Object.fromEntries(keys.map(key => [key, row.candidatesByKey[key]]));
    return [{ ...row, candidatesByKey,
      candidateSetHash: canonicalJsonFingerprint(candidatesByKey, "universe-candidate-partition-v1:"),
      outcomesByCandidateKey: Object.fromEntries(keys.map(key => [key, row.outcomesByCandidateKey[key]!])) }];
  });
  return retired.length === 0 ? undefined : Object.freeze(retired);
}

export function normalizeForcedReadyStatuses(
  values: readonly ForcedReadyStatus[] | undefined,
): readonly ForcedReadyStatus[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some(value =>
      value !== "verified" && value !== "terminal-rejected" && value !== "retryable")) {
    throw new Error("Ready forced outcome status is invalid");
  }
  const statuses = [...new Set(values)].sort() as ForcedReadyStatus[];
  return statuses.length === 0 ? undefined : Object.freeze(statuses);
}
