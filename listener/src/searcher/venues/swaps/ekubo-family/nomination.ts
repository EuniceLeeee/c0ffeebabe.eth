import { ethers } from "ethers";
import type { CaptureNominationInput, CaptureNominationProvider, CaptureNominationSemantics,
  CaptureReverseBindingSemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { EKUBO_CORE, EKUBO_CORE_DEPLOY_BLOCK, EKUBO_POOL_INITIALIZED_TOPIC } from "../ekubo/abi.js";
import { assertSource, decodeInitialized, decodeSwapCall } from "./codec.js";

type InitIndex = ReadonlyMap<string, Extract<UnifiedObservation, { kind: "log" }>>;
// Evidence cache, never admission authority: source hash AND provider isolated,
// at most two sources per provider, failures evicted, identity re-reads behavior.
const indexes = new WeakMap<CaptureNominationProvider, Map<string, Promise<InitIndex>>>();
const LOG_RANGE = 50_000;
function initializeIndex(provider: CaptureNominationProvider, source: CanonicalSource): Promise<InitIndex> {
  assertSource(source, source);
  let bySource = indexes.get(provider);
  if (!bySource) { bySource = new Map(); indexes.set(provider, bySource); }
  const key = `${source.number}:${source.hash.toLowerCase()}:${source.generation}`;
  const prior = bySource.get(key);
  if (prior) return prior;
  const pending = (async () => {
    const result = new Map<string, Extract<UnifiedObservation, { kind: "log" }>>();
    for (let fromBlock = EKUBO_CORE_DEPLOY_BLOCK; fromBlock <= source.number; fromBlock += LOG_RANGE) {
      const logs = await provider.getLogs({ address: EKUBO_CORE, topics: [EKUBO_POOL_INITIALIZED_TOPIC],
        fromBlock, toBlock: Math.min(source.number, fromBlock + LOG_RANGE - 1) });
      for (const log of logs) {
        const found = decodeInitialized(log);
        if (!found) continue;
        if (result.has(found.poolId)) throw new Error("ekubo duplicate initialization evidence");
        result.set(found.poolId, Object.freeze({ ...log, topics: Object.freeze([...log.topics]), kind: "log", source: Object.freeze({ ...source }) }));
      }
    }
    return result;
  })();
  if (bySource.size >= 2) bySource.delete(bySource.keys().next().value!);
  bySource.set(key, pending);
  void pending.catch(() => { if (bySource.get(key) === pending) bySource.delete(key); });
  return pending;
}
function opaqueRecord(input: CaptureNominationInput): Readonly<Record<string, unknown>> {
  return input.opaque !== null && typeof input.opaque === "object" && !Array.isArray(input.opaque)
    ? input.opaque as Readonly<Record<string, unknown>> : {};
}
function eligible(input: CaptureNominationInput): boolean {
  const opaque = opaqueRecord(input);
  return ["ekubo", "ekubo-core-pool-v1", "ekubo-router-swap", "custom-swap:ekubo-router-v1"]
    .includes(String(opaque.adapter ?? opaque.venueId ?? opaque.adapterId ?? opaque.familyId));
}
function poolId(input: CaptureNominationInput): string | null {
  const value = opaqueRecord(input).poolId ?? input.address;
  return typeof value === "string" && ethers.isHexString(value, 32) ? value.toLowerCase() : null;
}
export const reverseBindEkubo: CaptureReverseBindingSemantics["reverseBinding"] = async input => {
  const outcomes = [];
  for (const nomination of input.nominations) {
    if (!eligible(nomination) || poolId(nomination) === null) {
      outcomes.push({ status: "unsupported" as const, reason: "not-ekubo-pool-id-nomination" }); continue;
    }
    try {
      const observation = (await initializeIndex(input.provider, input.source)).get(poolId(nomination)!);
      outcomes.push(observation ? { status: "verified" as const, observation }
        : { status: "failed" as const, reason: "no-vanilla-core-initialization-at-source" });
    } catch {
      outcomes.push({ status: "failed" as const, reason: "ekubo-initialization-read-failed" });
    }
  }
  return Object.freeze(outcomes);
};

function traceCalls(trace: unknown, source: CanonicalSource, transactionHash: string): UnifiedObservation[] {
  const out: UnifiedObservation[] = [];
  const queue: unknown[] = [trace];
  // Trace envelopes/frames are untrusted input. Bound traversal and require a
  // real successful CALL frame; delegatecall bytes cannot nominate this router.
  for (let count = 0; queue.length && count < 10_000; count++) {
    const item = queue.pop();
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const frame = item as Readonly<Record<string, unknown>>;
    if (frame.error || frame.revertReason) continue;
    if (frame.result && typeof frame.result === "object") queue.push(frame.result);
    if (Array.isArray(frame.calls)) queue.push(...frame.calls);
    if (frame.type !== "CALL" || typeof frame.to !== "string" || typeof frame.input !== "string") continue;
    const observation: UnifiedObservation = { kind: "call", source, target: frame.to, data: frame.input, transactionHash };
    try { if (decodeSwapCall(observation)) out.push(observation); } catch { /* malformed frame */ }
  }
  return out;
}
export const ekuboNomination: CaptureNominationSemantics = {
  async nominate(input) {
    const observations: UnifiedObservation[] = [];
    for (const nomination of input.nominations) {
      if (!eligible(nomination)) continue;
      const opaque = opaqueRecord(nomination);
      const txHash = nomination.evidence?.transactionHash ?? opaque.txHash ?? opaque.transactionHash;
      if (typeof txHash !== "string" || !ethers.isHexString(txHash, 32)) continue;
      try {
        assertSource(input.source, input.source);
        const receipt = await input.provider.getTransactionReceipt(txHash);
        if (!receipt || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber! > input.source.number) continue;
        const id = poolId(nomination);
        for (const log of receipt.logs) {
          const found = decodeInitialized(log);
          if (found && (id === null || found.poolId === id)) observations.push({ ...log, kind: "log", source: input.source, transactionHash: txHash });
        }
        if (!input.provider.traceTransaction) continue;
        for (const observation of traceCalls(await input.provider.traceTransaction(txHash), input.source, txHash)) {
          const found = decodeSwapCall(observation)!;
          if (id === null || found.poolId === id) observations.push(observation);
        }
      } catch { /* Unavailable evidence stays unresolved; no synthetic calls. */ }
    }
    return Object.freeze(observations);
  },
};
