import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import { matchCalls } from "./venues/tx-evidence-nomination.js";

/**
 * F6 generic call-seed scanner (zero per-family logic). Tx-bound Families
 * declare callPatterns on their discovery semantics; a pool entry with no
 * txHash seed (bare graph/cache row) gets real candidate transactions by
 * scanning the address's recent activity in the node's retained log window,
 * tracing each candidate transaction, and keeping the first whose trace
 * carries the family's own declared selector (direct or nested call). The
 * seed txHash rides in the opaque payload so the existing
 * createTxEvidenceNomination re-reads receipt/trace and re-verifies.
 *
 * The catalog is the only enumeration source: families without
 * evidenceChannel "nominate" + callPatterns are skipped structurally.
 */
export async function scanRecentCallSeeds(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
  readonly nominations: readonly CaptureNominationInput[];
  readonly maxSeedsPerAddress?: number;
}): Promise<readonly CaptureNominationInput[]> {
  const maxSeeds = Math.max(1, input.maxSeedsPerAddress ?? 3);
  const extra: CaptureNominationInput[] = [];
  for (const nomination of input.nominations) {
    const address = ethers.getAddress(nomination.address).toLowerCase();
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (hasTxHash(opaque)) continue;
    const label = String(
      opaque.adapter ?? opaque.adapterId ?? opaque.venueId ?? "",
    ).toLowerCase();
    if (label === "") continue;
    let family;
    try {
      family = input.catalog.ownerOfAction(label);
    } catch {
      continue;
    }
    let plugin;
    try {
      plugin = input.catalog.forStrictFamily(family).plugin;
    } catch {
      continue;
    }
    if (!("discovery" in plugin)) continue;
    const discovery = plugin.discovery;
    if (discovery.evidenceChannel !== "nominate") continue;
    const callPatterns = discovery.callPatterns ?? [];
    if (callPatterns.length === 0) continue;
    const trace = input.provider.traceTransaction;
    if (trace === undefined) continue;
    const txHashes = await recentTxHashesForAddress({
      provider: input.provider,
      source: input.source,
      address,
      maxSeeds,
    });
    for (const txHash of txHashes) {
      try {
        const raw = await trace(txHash);
        const call = matchCalls(callPatterns, raw);
        if (call === null) continue;
        extra.push(Object.freeze({
          address: call.target.toLowerCase(),
          opaque: Object.freeze({
            ...opaque,
            txHash,
            transactionHash: txHash,
          }) as never,
        }));
      } catch {
        // One unreadable trace must not block the next candidate.
      }
    }
  }
  return Object.freeze(extra);
}

function hasTxHash(opaque: Readonly<Record<string, unknown>>): boolean {
  for (const key of ["txHash", "transactionHash"]) {
    const value = opaque[key];
    if (typeof value === "string" && ethers.isHexString(value, 32)) return true;
  }
  return false;
}

/**
 * Collects distinct recent transaction hashes touching the address by
 * walking the node's retained log window newest-first (chunked, so a
 * high-volume emitter never overflows the node cap).
 */
async function recentTxHashesForAddress(input: {
  readonly provider: CaptureNominationProvider;
  readonly source: CanonicalSource;
  readonly address: string;
  readonly maxSeeds: number;
}): Promise<readonly string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const chunk = 10_000;
  let to = input.source.number;
  for (let guard = 0; guard < 10 && found.length < input.maxSeeds; guard++) {
    const from = Math.max(0, to - chunk + 1);
    let logs;
    try {
      logs = await input.provider.getLogs({
        address: input.address,
        fromBlock: from,
        toBlock: to,
        topics: [],
      });
    } catch {
      break;
    }
    for (let index = logs.length - 1; index >= 0; index--) {
      const tx = logs[index].transactionHash;
      if (tx === undefined || seen.has(tx.toLowerCase())) continue;
      seen.add(tx.toLowerCase());
      found.push(tx.toLowerCase());
      if (found.length >= input.maxSeeds) break;
    }
    to = from - 1;
    if (logs.length === 0 && found.length === 0) break;
  }
  return Object.freeze(found);
}
