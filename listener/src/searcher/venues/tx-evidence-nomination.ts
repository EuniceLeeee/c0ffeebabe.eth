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
          // Empty/zero-address TX seeds discover naturally. A concrete address
          // instead binds the evidence; malformed claims must not become seeds.
          const address = nomination.address?.trim();
          const boundAddress = !address || address === ethers.ZeroAddress
            ? undefined : ethers.getAddress(address).toLowerCase();
          const poolId = (nomination.opaque as Readonly<Record<string, unknown>>).poolId;
          const receipt = await provider.getTransactionReceipt(txHash);
          if (receipt === null) continue;
          const logObservation = await matchLogs(logs, receipt.logs, source, boundAddress, poolId);
          if (logObservation !== null) {
            results.push(logObservation);
            continue;
          }
          if (input.traceTransaction !== false &&
              provider.traceTransaction !== undefined &&
              calls.length > 0 &&
              // CallPattern projects an address, not an opaque bytes32 id.
              // Do not replace missing instance-bound log evidence with a
              // different instance's call through the same entrypoint.
              !((boundAddress !== undefined || poolId !== undefined) && logs.some(pattern =>
                pattern.emitter?.mode === "singleton-indexed-bytes32"))) {
            const trace = await provider.traceTransaction(txHash);
            const call = matchCalls(calls, trace, boundAddress);
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
  boundAddress?: string,
  poolId?: unknown,
): Promise<UnifiedObservation | null> {
  for (const log of receiptLogs) {
    const topic = log.topics[0]?.toLowerCase();
    if (!patterns.some(pattern => {
      if (pattern.topic.toLowerCase() !== topic) return false;
      const emitter = pattern.emitter;
      if (emitter === undefined || emitter.mode === "address") {
        return boundAddress === undefined || log.address.toLowerCase() === boundAddress;
      }
      if (log.address.toLowerCase() !== emitter.address.toLowerCase() ||
          source.number < emitter.fromBlock) return false;
      const indexed = log.topics[emitter.topicIndex];
      if (!ethers.isHexString(indexed, 32)) return false;
      if (emitter.mode === "singleton-indexed-address") {
        return /^0x0{24}/i.test(indexed) && (boundAddress === undefined ||
          "0x" + indexed.slice(-40).toLowerCase() === boundAddress);
      }
      // A concrete shared entrypoint without its logical id cannot prove
      // which instance was nominated. Only an unbound TX seed may discover.
      if (boundAddress !== undefined && poolId === undefined) return false;
      return (boundAddress === undefined || log.address.toLowerCase() === boundAddress) &&
        (poolId === undefined || (typeof poolId === "string" &&
          ethers.isHexString(poolId, 32) && indexed.toLowerCase() === poolId.toLowerCase()));
    })) continue;
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

export function matchCalls(
  patterns: readonly CallPattern[],
  raw: unknown,
  boundAddress?: string,
): { readonly target: string; readonly sender: string | null; readonly data: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const frame = raw as {
    readonly to?: unknown;
    readonly from?: unknown;
    readonly input?: unknown;
    readonly calls?: unknown;
    readonly error?: unknown;
    readonly revertReason?: unknown;
  };
  // Reverted ancestors invalidate their whole subtree as successful evidence.
  if (frame.error || frame.revertReason) return null;
  if (
    typeof frame.to === "string" && ethers.isAddress(frame.to) &&
    typeof frame.input === "string" && ethers.isHexString(frame.input) &&
    frame.input.length >= 10
  ) {
    const target = ethers.getAddress(frame.to);
    const data = frame.input;
    const selector = data.slice(0, 10).toLowerCase();
    if (patterns.some((pattern) => {
      if (pattern.selector.toLowerCase() !== selector) return false;
      if (boundAddress === undefined) return true;
      if (pattern.candidateAddress.from === "call-target") {
        return target.toLowerCase() === boundAddress.toLowerCase();
      }
      // Public entrypoints may carry the logical candidate in calldata.
      // Use the declared ABI projection, never equate entrypoint and instance.
      try {
        const abi = new ethers.Interface([`function ${pattern.signature}`]);
        const candidate = abi.decodeFunctionData(pattern.selector, data)[pattern.candidateAddress.index];
        return typeof candidate === "string" && ethers.isAddress(candidate) &&
          candidate.toLowerCase() === boundAddress.toLowerCase();
      } catch {
        return false;
      }
    })) {
      return {
        target,
        sender: typeof frame.from === "string" && ethers.isAddress(frame.from)
          ? ethers.getAddress(frame.from)
          : null,
        data,
      };
    }
  }
  if (Array.isArray(frame.calls)) {
    for (const call of frame.calls) {
      const found = matchCalls(patterns, call, boundAddress);
      if (found !== null) return found;
    }
  }
  return null;
}
