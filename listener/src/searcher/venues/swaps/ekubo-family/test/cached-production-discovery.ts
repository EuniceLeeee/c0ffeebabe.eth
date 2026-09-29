import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { candidatesFromCall } from "../../../../universe-rebuild-production.js";
import { decodeInitialized, decodeMultihopCall } from "../codec.js";
import { EKUBO_FAMILY_ID } from "../manifest.js";

const [rawFile, cacheFile] = process.argv.slice(2);
assert(rawFile && cacheFile, "usage: cached-production-discovery.ts raw.json rpc.jsonl");
const raw = JSON.parse(readFileSync(rawFile, "utf8"));
const source = { number: Number(raw.receipt.blockNumber), hash: raw.receipt.blockHash, generation: Number(raw.receipt.blockNumber) };
const queue = [{ frame: raw.trace, path: [] as number[] }];
const expanded = new Set<string>(), witnessed = new Set<string>();
while (queue.length) {
  const { frame, path } = queue.pop()!;
  if (frame.error || frame.revertReason) continue;
  if (frame.type === "CALL") {
    const keys = decodeMultihopCall({ kind: "call", source, target: frame.to, data: frame.input });
    if (keys) {
      for (const key of keys) witnessed.add(key.poolId);
      // Actual production candidate fan-out, not a test-side decoder loop.
      const candidates = candidatesFromCall({ kind: "call", target: frame.to, sender: frame.from, data: frame.input,
        blockNumber: source.number, blockHash: source.hash, transactionHash: raw.receipt.transactionHash, traceAddress: path });
      for (const candidate of candidates) if (candidate.familyId === EKUBO_FAMILY_ID) expanded.add(String(candidate.poolId));
    }
  }
  for (const [i, child] of (frame.calls ?? []).entries()) queue.push({ frame: child, path: [...path, i] });
}
assert.equal(witnessed.size, 2);
// The same cached responses also contain independently decodable real init
// evidence for BOTH pools. No RPC or candidate injection is performed.
const initializations = new Set<string>();
const visit = (value: any): void => {
  if (!value || typeof value !== "object") return;
  if (typeof value.address === "string" && Array.isArray(value.topics) && typeof value.data === "string") {
    const key = decodeInitialized(value); if (key && witnessed.has(key.poolId)) initializations.add(key.poolId);
  }
  for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
};
for (const line of readFileSync(cacheFile, "utf8").trim().split("\n")) visit(JSON.parse(line));
assert.deepEqual([...initializations].sort(), [...witnessed].sort());
console.log(JSON.stringify({ source, witnessed: [...witnessed], initialized: [...initializations], productionCandidates: [...expanded], rpcRequests: 0 }));
assert.deepEqual([...expanded].sort(), [...witnessed].sort(), "production single-call fan-out must retain every real multihop key");
