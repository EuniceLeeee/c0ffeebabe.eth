import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "./adapter-family-plugin.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import type { CallPattern, LogPattern } from "./adapter-family-plugin.js";

/**
 * Shared plugin-owned nomination for tx-bound Families: the nomination opaque
 * payload carries a candidate transaction hash (from live observations or a
 * transitional seed). The capability re-reads the real receipt and trace at
 * the source block, matches its own declared call/log patterns, and returns
 * the real observation. Legacy caches only seed the txHash; the evidence is
 * re-derived by strict. Identity still re-verifies behavior before
 * admission.
 */
export function createTxEvidenceNomination(input: {
  readonly opaqueLabels: readonly string[];
  readonly callPatterns?: readonly CallPattern[];
  readonly logPatterns?: readonly LogPattern[];
  readonly traceTransaction?: boolean;
}): {
  nominate(input: {
    readonly nominations: readonly CaptureNominationInput[];
    readonly source: CanonicalSource;
    readonly provider: CaptureNominationProvider;
  }): Promise<readonly UnifiedObservation[]>;
} {
  const labels = new Set(input.opaqueLabels.map((label) => label.toLowerCase()));
  const calls = input.callPatterns ?? [];
  const logs = input.logPatterns ?? [];
  return {
    async nominate({ nominations, source, provider }) {
      const results: UnifiedObservation[] = [];
      for (const nomination of nominations) {
        if (!matchesOpaqueLabel(nomination.opaque, labels)) continue;
        const txHash = opaqueTxHash(nomination.opaque);
        if (txHash === null) continue;
        try {
          const receipt = await provider.getTransactionReceipt(txHash);
          if (receipt === null) continue;
          const logObservation = await matchLogs(logs, receipt.logs, source);
          if (logObservation !== null) {
            results.push(logObservation);
            continue;
          }
          if (input.traceTransaction !== false &&
              provider.traceTransaction !== undefined &&
              calls.length > 0) {
            const trace = await provider.traceTransaction(txHash);
            const call = matchCalls(calls, trace);
            if (call !== null) {
              results.push(Object.freeze({
                kind: "call" as const,
                source,
                target: call.target.toLowerCase(),
                ...(call.sender === null
                  ? {}
                  : { sender: call.sender.toLowerCase() }),
                data: call.data.toLowerCase(),
                transactionHash: txHash.toLowerCase(),
              }));
            }
          }
        } catch {
          // One unreadable nomination must not block the next one.
        }
      }
      return Object.freeze(results);
    },
  };
}

function matchesOpaqueLabel(
  opaque: unknown,
  labels: ReadonlySet<string>,
): boolean {
  if (opaque === null || typeof opaque !== "object" || Array.isArray(opaque)) {
    return false;
  }
  const record = opaque as Readonly<Record<string, unknown>>;
  for (const key of ["adapter", "adapterId", "venueId", "familyId"]) {
    const value = record[key];
    if (typeof value === "string" && labels.has(value.toLowerCase())) return true;
  }
  return false;
}

function opaqueTxHash(opaque: unknown): string | null {
  if (opaque === null || typeof opaque !== "object" || Array.isArray(opaque)) {
    return null;
  }
  const record = opaque as Readonly<Record<string, unknown>>;
  for (const key of ["txHash", "transactionHash"]) {
    const value = record[key];
    if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
      return value.toLowerCase();
    }
  }
  // Nested evidence lists (e.g. verified_candidates[].evidence[].txHash).
  const evidence = record.evidence ?? record.candidateEvidence;
  if (Array.isArray(evidence)) {
    for (const entry of evidence) {
      if (entry === null || typeof entry !== "object") continue;
      const nested = entry as Readonly<Record<string, unknown>>;
      const value = nested.txHash ?? nested.transactionHash;
      if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
        return value.toLowerCase();
      }
    }
  }
  return null;
}

async function matchLogs(
  patterns: readonly LogPattern[],
  receiptLogs: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  }[],
  source: CanonicalSource,
): Promise<UnifiedObservation | null> {
  const topics = new Set(patterns.map((pattern) => pattern.topic.toLowerCase()));
  for (const log of receiptLogs) {
    const topic = log.topics[0]?.toLowerCase();
    if (topic === undefined || !topics.has(topic)) continue;
    return Object.freeze({
      kind: "log" as const,
      source,
      address: ethers.getAddress(log.address).toLowerCase(),
      topics: Object.freeze(log.topics.map((t) => t.toLowerCase())),
      data: log.data.toLowerCase(),
      ...(log.transactionHash === undefined
        ? {}
        : { transactionHash: log.transactionHash.toLowerCase() }),
    });
  }
  return null;
}

function matchCalls(
  patterns: readonly CallPattern[],
  raw: unknown,
): { readonly target: string; readonly sender: string | null; readonly data: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const frame = raw as {
    readonly to?: unknown;
    readonly from?: unknown;
    readonly input?: unknown;
    readonly calls?: unknown;
  };
  if (
    typeof frame.to === "string" && ethers.isAddress(frame.to) &&
    typeof frame.input === "string" && ethers.isHexString(frame.input) &&
    frame.input.length >= 10
  ) {
    const selector = frame.input.slice(0, 10).toLowerCase();
    if (patterns.some((pattern) => pattern.selector.toLowerCase() === selector)) {
      return {
        target: ethers.getAddress(frame.to),
        sender: typeof frame.from === "string" && ethers.isAddress(frame.from)
          ? ethers.getAddress(frame.from)
          : null,
        data: frame.input,
      };
    }
  }
  if (Array.isArray(frame.calls)) {
    for (const call of frame.calls) {
      const found = matchCalls(patterns, call);
      if (found !== null) return found;
    }
  }
  return null;
}
