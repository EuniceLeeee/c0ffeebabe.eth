import { createHash } from "node:crypto";
import type { ReadySelectorCensusTransaction } from "./ready-selector-census.js";
import type { RunOutcome } from "./universe-rebuild-checkpoint.js";

/** Inventory is input evidence, never execution authority. Unknown calls are
 * accounted here even when no installed Family can decode a candidate. */
export interface ReadySelectorCoverage {
  readonly format: "ready-selector-coverage/v1";
  readonly scope: "supplied-transactions";
  readonly allInternalCallsEnumerated: false;
  readonly inputFingerprint: string;
  readonly transactions: readonly ReadySelectorCensusTransaction[];
  readonly registeredSelectors: Readonly<Record<string, readonly string[]>>;
  readonly entries: readonly ReadySelectorCoverageEntry[];
  readonly counts: { readonly transactions: number; readonly resources: number;
    readonly verified: number; readonly partiallyVerified: number; readonly unverified: number };
}
export interface ReadySelectorCoverageEntry {
  readonly key: string;
  readonly chainId: number | null;
  readonly address: string;
  readonly selector: string | null;
  readonly poolId: string | null;
  readonly poolNamespace: string | null;
  readonly familyIds: readonly string[];
  readonly transactionHashes: readonly string[];
  readonly candidateKeys: readonly string[];
  readonly verifiedCandidateKeys: readonly string[];
  readonly status: "verified" | "partially-verified" | "unverified";
  readonly reasons: readonly string[];
}
function json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(json).join(",") + "]";
  return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => JSON.stringify(key) + ":" + json(child)).join(",") + "}";
}
export function readySelectorCensusFingerprint(value: readonly ReadySelectorCensusTransaction[]): string {
  return createHash("sha256").update(json(value)).digest("hex");
}
/** Accepts raw census arrays or the ordinary SQL Ready candidate export. No
 * source field is invented for malformed or legacy input. */
export function normalizeReadySelectorCensus(value: unknown): readonly ReadySelectorCensusTransaction[] {
  const rows = Array.isArray(value) ? value : (value as { selectorCensus?: unknown } | null)?.selectorCensus;
  if (!Array.isArray(rows)) throw new Error("Ready selector input requires a selectorCensus array");
  const byKey = new Map<string, ReadySelectorCensusTransaction>();
  for (const raw of rows) {
    const tx = JSON.parse(JSON.stringify(raw)) as ReadySelectorCensusTransaction;
    if (!tx || tx.format !== "ready-selector-census/v1" || tx.status !== "unverified" ||
        !Array.isArray(tx.calls) || !Array.isArray(tx.tokenFlows) || !Array.isArray(tx.resources) || !Array.isArray(tx.logs) ||
        tx.coverage?.allInternalCallsEnumerated !== false || !Array.isArray(tx.coverage.issues) ||
        tx.calls.some(call => call.status !== "unverified" || call.flowAttribution !== "address-correlation-only"))
      throw new Error("invalid Ready selector census; input cannot grant authority");
    const key = tx.transactionHash === null ? "incomplete:" + readySelectorCensusFingerprint([tx]) : `${tx.chainId}|${tx.transactionHash}`;
    const previous = byKey.get(key);
    if (previous && json(previous) !== json(tx)) throw new Error("conflicting Ready selector transaction: " + key);
    byKey.set(key, tx);
  }
  const result = [...byKey].sort(([a], [b]) => a.localeCompare(b)).map(([, tx]) => tx);
  function freeze(v: unknown): void { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } }
  freeze(result);
  return result;
}

export function buildReadySelectorCoverage(input: {
  readonly transactions: readonly ReadySelectorCensusTransaction[];
  readonly registeredSelectors: Readonly<Record<string, readonly string[]>>;
  readonly candidatesByKey: Readonly<Record<string, unknown>>;
  readonly outcomesByCandidateKey: Readonly<Record<string, RunOutcome>>;
}): ReadySelectorCoverage {
  const transactions = normalizeReadySelectorCensus(input.transactions);
  type Row = { chainId: number | null; address: string; selector: string | null; poolId: string | null;
    poolNamespace: string | null; families: Set<string>; txs: Set<string>; candidates: Set<string>; verified: Set<string>; reasons: Set<string> };
  const rows = new Map<string, Row>();
  const transactionKey = (tx: ReadySelectorCensusTransaction) => json([tx.chainId, tx.transactionHash]);
  const fingerprints = new Map(transactions.map(tx => [transactionKey(tx), readySelectorCensusFingerprint([tx])]));
  // Native candidates retain one complete census witness and its call ID.
  // Authenticate the whole transaction once per candidate, rather than a
  // duplicated observation DTO or an O(calls * candidates) repeated hash.
  const candidates = Object.entries(input.candidatesByKey).flatMap(([key, raw]) => {
    const candidate = raw as Record<string, any>;
    try {
      const census = candidate?.census as ReadySelectorCensusTransaction | undefined;
      if (!census || census.transactionHash === null || typeof candidate.callId !== "string" || !Array.isArray(census.calls) ||
          readySelectorCensusFingerprint([census]) !== fingerprints.get(transactionKey(census))) return [];
      const calls = census.calls.filter(call => call.id === candidate.callId);
      return calls.length === 1 ? [{ key, candidate, witness: calls[0]!, transactionKey: transactionKey(census) }] : [];
    } catch { return []; }
  });
  for (const tx of transactions) {
    const add = (address: string, selector: string | null, poolId: string | null, poolNamespace: string | null): Row => {
      const key = json([tx.chainId, address.toLowerCase(), poolNamespace, poolId, selector]);
      let row = rows.get(key);
      if (!row) { row = { chainId: tx.chainId, address: address.toLowerCase(), selector, poolId, poolNamespace,
        families: new Set(selector === null ? [] : input.registeredSelectors[selector] ?? []), txs: new Set(),
        candidates: new Set(), verified: new Set(), reasons: new Set() }; rows.set(key, row); }
      if (tx.transactionHash) row.txs.add(tx.transactionHash);
      if (tx.coverage.issues.length) row.reasons.add("input-provenance-or-observation-incomplete");
      return row;
    };
    for (const call of tx.calls) {
      if (!call.target) continue;
      const matching = candidates.filter(({ candidate, witness, transactionKey: candidateTransaction }) => {
        // A supplied transaction and its trace root can describe the same
        // physical call. Sibling/nested calls cannot borrow that binding.
        const sameCall = witness.id === call.id || witness.traceAddress?.length === 0 && call.traceAddress?.length === 0 &&
          witness.kind !== call.kind;
        return sameCall && candidateTransaction === transactionKey(tx) && candidate.target === call.target &&
          candidate.scope?.target === call.target && candidate.scope?.chainId === tx.chainId &&
          call.selector !== null && input.registeredSelectors[call.selector]?.includes(candidate.familyId) &&
          (call.poolId === undefined || candidate.scope.poolId === call.poolId && candidate.scope.poolNamespace === call.poolNamespace) &&
          witness.target === call.target && witness.sender === call.sender && witness.selector === call.selector &&
          witness.calldata === call.calldata && json(witness.traceAddress) === json(call.traceAddress);
      });
      const invocationRows = matching.length ? matching.map(({ candidate }) => add(call.target!, call.selector,
        candidate.scope.poolId ?? call.poolId ?? null, candidate.scope.poolNamespace ?? call.poolNamespace ?? null)) :
        [add(call.target, call.selector, call.poolId ?? null, call.poolNamespace ?? null)];
      for (const row of invocationRows) {
        if (call.selector === null) row.reasons.add("selector-unavailable");
        else if (row.families.size === 0) row.reasons.add("selector-not-adapted");
        if (call.executionStatus !== "success") row.reasons.add("observed-call-not-successful");
        if (call.flowIndices.length === 0) row.reasons.add("no-address-correlated-token-flow");
        if (row.families.size > 0 && matching.length === 0) row.reasons.add("declared-selector-without-unambiguous-candidate");
      }
      for (const { key, candidate } of matching) {
        const row = add(call.target, call.selector, candidate.scope.poolId ?? call.poolId ?? null,
          candidate.scope.poolNamespace ?? call.poolNamespace ?? null);
        row.candidates.add(key); if (typeof candidate.familyId === "string") row.families.add(candidate.familyId);
        const outcome = input.outcomesByCandidateKey[key];
        if (outcome?.status === "verified" && outcome.familyCandidateKey === key) {
          if (outcome.executionVerification === "startup-simulation") row.reasons.add("awaiting-startup-simulation");
          else row.verified.add(key);
        }
        else if (outcome?.status === "covered") {
          row.reasons.add("covered-by-another-candidate");
        } else row.reasons.add(outcome?.status === "retryable" ? "execution-verification-retryable" :
          outcome?.status === "terminal-rejected" ? "execution-verification-rejected" : "execution-not-verified");
      }
    }
    for (const resource of tx.resources) {
      // Keep unmatched pool/token/actor addresses, but do not attach a router's
      // entry selector to them. Internal calldata is genuinely absent here.
      if (tx.calls.some(call => call.target === resource.address)) continue;
      add(resource.address, null, null, null).reasons.add("resource-observed-selector-unavailable");
    }
  }
  const sorted = (set: Set<string>) => Object.freeze([...set].sort());
  const entries: ReadySelectorCoverageEntry[] = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => {
    const status = row.verified.size === 0 ? "unverified" : row.verified.size === row.candidates.size &&
      row.reasons.size === 0 ? "verified" : "partially-verified";
    return Object.freeze({ key, chainId: row.chainId, address: row.address, selector: row.selector,
      poolId: row.poolId, poolNamespace: row.poolNamespace, familyIds: sorted(row.families),
      transactionHashes: sorted(row.txs), candidateKeys: sorted(row.candidates), verifiedCandidateKeys: sorted(row.verified),
      status, reasons: sorted(row.reasons) });
  });
  return Object.freeze({ format: "ready-selector-coverage/v1", scope: "supplied-transactions", allInternalCallsEnumerated: false,
    inputFingerprint: readySelectorCensusFingerprint(transactions), transactions, entries: Object.freeze(entries),
    registeredSelectors: Object.freeze(Object.fromEntries(Object.entries(input.registeredSelectors)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, ids]) => [key, Object.freeze([...new Set(ids)].sort())]))),
    counts: Object.freeze({ transactions: transactions.length, resources: entries.length,
      verified: entries.filter(row => row.status === "verified").length,
      partiallyVerified: entries.filter(row => row.status === "partially-verified").length,
      unverified: entries.filter(row => row.status === "unverified").length }) });
}

export function assertReadySelectorCoverage(value: ReadySelectorCoverage | undefined, authority?: {
  readonly candidatesByKey: Readonly<Record<string, unknown>>;
  readonly outcomesByCandidateKey: Readonly<Record<string, RunOutcome>>;
}): void {
  if (value === undefined) return;
  if (value.format !== "ready-selector-coverage/v1" || value.scope !== "supplied-transactions" ||
      value.allInternalCallsEnumerated !== false || !Array.isArray(value.entries) ||
      readySelectorCensusFingerprint(normalizeReadySelectorCensus(value.transactions)) !== value.inputFingerprint ||
      value.counts.transactions !== value.transactions.length || value.counts.resources !== value.entries.length ||
      value.counts.verified + value.counts.partiallyVerified + value.counts.unverified !== value.entries.length)
    throw new Error("Ready selector coverage binding mismatch");
  const keys = new Set<string>();
  for (const row of value.entries) {
    if (row.key !== json([row.chainId, row.address, row.poolNamespace, row.poolId, row.selector]) || keys.has(row.key) ||
        !Array.isArray(row.candidateKeys) || !Array.isArray(row.verifiedCandidateKeys) || !Array.isArray(row.reasons) ||
        row.verifiedCandidateKeys.some((key: string) => !row.candidateKeys.includes(key)) ||
        new Set(row.candidateKeys).size !== row.candidateKeys.length || new Set(row.verifiedCandidateKeys).size !== row.verifiedCandidateKeys.length)
      throw new Error("Ready selector coverage entry mismatch");
    keys.add(row.key);
    const status = row.verifiedCandidateKeys.length === 0 ? "unverified" :
      row.verifiedCandidateKeys.length === row.candidateKeys.length && row.reasons.length === 0 ? "verified" : "partially-verified";
    if (row.status !== status) throw new Error("Ready selector coverage status mismatch");
    if (!value.transactions.some(tx => tx.chainId === row.chainId && (tx.transactionHash === null || row.transactionHashes.includes(tx.transactionHash)) &&
        (row.selector === null ? tx.resources.some(resource => resource.address === row.address) || tx.calls.some(call => call.target === row.address && call.selector === null)
          : tx.calls.some(call => call.target === row.address && call.selector === row.selector &&
            (call.poolId === undefined || call.poolId === row.poolId && call.poolNamespace === row.poolNamespace)))))
      throw new Error("Ready selector coverage entry has no source observation");
  }
  for (const tx of value.transactions) {
    const has = (address: string, selector: string | null, poolId?: string, poolNamespace?: string): boolean => value.entries.some(row =>
      row.chainId === tx.chainId && row.address === address && row.selector === selector &&
      (tx.transactionHash === null || row.transactionHashes.includes(tx.transactionHash)) &&
      (poolId === undefined || row.poolId === poolId && row.poolNamespace === poolNamespace));
    if (tx.calls.some(call => call.target !== null && !has(call.target, call.selector, call.poolId, call.poolNamespace)) ||
        tx.resources.some(resource => !tx.calls.some(call => call.target === resource.address) && !has(resource.address, null)))
      throw new Error("Ready selector inventory lost an observed entry");
  }
  if (value.counts.verified !== value.entries.filter(row => row.status === "verified").length ||
      value.counts.partiallyVerified !== value.entries.filter(row => row.status === "partially-verified").length ||
      value.counts.unverified !== value.entries.filter(row => row.status === "unverified").length)
    throw new Error("Ready selector coverage status counts mismatch");
  if (authority && json(value) !== json(buildReadySelectorCoverage({ ...authority,
      transactions: value.transactions, registeredSelectors: value.registeredSelectors })))
    throw new Error("Ready selector coverage differs from authoritative candidate outcomes");
}
