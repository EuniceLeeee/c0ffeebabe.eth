import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ethers } from "ethers";
import { createRebuildWiring } from "../universe-rebuild-production.js";
import { createCatalogLogAccumulator } from "../catalog-log-accumulator.js";
type C = { key: string; block: number; score: number; fingerprint: string; evidence: string };
type L = { block: number; identity: string; data: string; candidates: C[]; opaque: string[] };
const prefer = (a: C, b: C) => b.block !== a.block ? b.block > a.block : b.score !== a.score ? b.score > a.score : b.fingerprint.localeCompare(a.fingerprint) < 0;
const write = (h: ReturnType<typeof createHash>, l: L) => { h.update(JSON.stringify(l)); h.update("\0"); };
const c = (key: string, block: number, evidence: string, score = 1, fingerprint = key): C => ({ key, block, evidence, score, fingerprint });
const l = (block: number, identity: string, candidates: C[] = [], opaque: string[] = [], data = identity): L => ({ block, identity, candidates, opaque, data });
const make = () => createCatalogLogAccumulator<L, C>({ fromBlock: 1, toBlock: 1001, chunkBlocks: 500, blockNumber: l => l.block,
  identity: l => l.identity, updateDigest: write, candidates: l => l.candidates, candidateKey: c => c.key, prefer, opaqueKeys: l => l.opaque });
// Independent former full-window oracle retains all source events before admission.
function oracle(logs: L[], calls: { block: number; data: string }[]) {
  const seen = new Set<string>(), candidates = new Map<string, C>(), opaque = new Map<string, L>();
  for (const log of logs) {
    for (const key of log.opaque) if (!opaque.has(key)) opaque.set(key, log);
    if (seen.has(log.identity)) continue; seen.add(log.identity);
    for (const c of log.candidates) { const old = candidates.get(c.key); if (old === undefined || prefer(old, c)) candidates.set(c.key, c); }
  }
  const source = createHash("sha256").update("catalog-activity-observations-v1:");
  for (const log of logs) write(source, log); for (const call of calls) source.update(call.data);
  const chunks = [];
  for (let first = 1; first <= 1001; first += 500) {
    const last = Math.min(1001, first + 499), h = createHash("sha256").update("catalog-activity-chunk-v1:"); let count = 0;
    for (const log of logs) if (log.block >= first && log.block <= last) { write(h, log); count++; }
    for (const call of calls) if (call.block >= first && call.block <= last) { h.update(call.data); count++; }
    chunks.push({ first, last, count, hash: h.digest("hex") });
  }
  return { candidates: [...candidates.values()], opaqueLogs: [...new Set(opaque.values())],
    count: logs.length, sourceHash: source.digest("hex"), chunks };
}
function actual(logs: L[], calls: { block: number; data: string }[]) {
  const value = make(); for (const log of logs) value.append(log);
  for (const call of calls) { const chunk = value.digestState.chunks[Math.floor((call.block - 1) / 500)]!;
    value.digestState.observationHash.update(call.data); chunk.hash.update(call.data); chunk.resultCount++; }
  return { ...value.representatives(), count: value.count(), sourceHash: value.digestState.observationHash.digest("hex"),
    chunks: value.digestState.chunks.map(x => ({ first: x.fromBlock, last: x.toBlock, count: x.resultCount, hash: x.hash.digest("hex") })) };
}
test("source/chunk hashes/counts, complete candidates/insertion order, first opaque evidence", () => {
  const logs = [l(1,"a1",[c("A",1,"first")],["opaque-a","opaque-b"]), l(2,"b2",[c("B",2,"b")]),
    l(10,"a10",[c("A",10,"newer")],["opaque-a"]), l(501,"c501",[c("C",501,"c")]), l(1001,"a1001",[c("A",1001,"latest")])];
  const calls = [{ block: 2, data: "call1\0" }, { block: 501, data: "call2\0" }];
  assert.deepEqual(actual(logs,calls),oracle(logs,calls)); assert.deepEqual(actual(logs,[]).candidates.map(x=>x.key),["A","B","C"]);
  assert.equal(actual(logs,[]).opaqueLogs[0]!.identity,"a1");
});
test("duplicate full identity conflicting data keeps first admission but hashes/counts both", () => {
  const logs = [l(1,"same",[c("A",1,"first")],["opaque"],"first"), l(1,"same",[c("B",1,"conflict")],["other"],"conflict")];
  assert.deepEqual(actual(logs,[]),oracle(logs,[])); assert.equal(actual(logs,[]).count,2); assert.deepEqual(actual(logs,[]).candidates.map(x=>x.key),["A"]);
});
test("same block/score/fingerprint tie retains first evidence", () => {
  const logs=[l(1,"first",[c("A",1,"first")]),l(1,"second",[c("A",1,"second")])];
  assert.deepEqual(actual(logs,[]),oracle(logs,[])); assert.equal(actual(logs,[]).candidates[0]!.evidence,"first");
});
test("mixed Families and ordered chunk boundaries preserve complete feed", () => {
  const logs=[l(500,"multi",[c("family:A",500,"a"),c("family:B",500,"b")]),l(501,"new",[c("family:A",501,"new")]),l(1000,"opaque",[],["x"]),l(1001,"end",[],["y"])];
  const calls=[{block:1001,data:"tail\0"}]; assert.deepEqual(actual(logs,calls),oracle(logs,calls));
});
test("invalid/out-of-range and backward chunk cannot re-enter after duplicate expiry", () => {
  for(const block of [0,1002,NaN]) assert.throws(()=>make().append(l(block,"bad")),/outside ordered scan range/);
  const value=make(); value.append(l(501,"new")); assert.throws(()=>value.append(l(500,"old")),/outside ordered scan range/);
});
test("empty and repeated-instance scans retain all source evidence with compact admission", () => {
  assert.deepEqual(actual([],[]),oracle([],[])); const logs=Array.from({length:10000},(_,i)=>l(1+Math.floor(i/10),String(i),[c("A",1+Math.floor(i/10),String(i))],["opaque"]));
  const result=actual(logs,[]); assert.deepEqual(result,oracle(logs,[])); assert.equal(result.candidates.length,1); assert.equal(result.opaqueLogs.length,1); assert.equal(result.count,10000);
});

test("opaque-only representative cannot re-enter ordinary candidate decode after a conflicting identity", () => {
  const logs = [l(1, "same-full-identity", [c("A", 1, "first")]),
    l(1, "same-full-identity", [c("B", 1, "conflict")], ["first-opaque-B"])];
  const acc = make(); for (const log of logs) acc.append(log);
  assert.deepEqual(actual(logs, []), oracle(logs, []));
  assert.deepEqual(acc.representatives().candidates.map(x => x.key), ["A"]);
  assert.equal(acc.representatives().opaqueLogs[0]!.candidates[0]!.key, "B");
  // The generic accumulator permits a plugin to decode a different candidate
  // from conflicting data. Exercise the actual production fold with a log
  // that would nominate B if reverse-only evidence were decoded a second time.
  const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: ["univ2-standard"] });
  const candidateA = { familyId: "univ2-standard", adapter: "univ2", address: "0x" + "11".repeat(20) };
  const ordinaryA = { kind: "startup-candidate", candidate: candidateA };
  const opaqueB = { address: "0x" + "22".repeat(20),
    topics: [ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)")], data: "0x",
    blockNumber: 1, blockHash: "0x" + "aa".repeat(32), transactionHash: "0x" + "bb".repeat(32), logIndex: 0 };
  const oldWinner = wiring.dedupeFamilyCandidates([ordinaryA]);
  assert.equal(wiring.dedupeFamilyCandidates([ordinaryA, opaqueB]).length, 2, "unmarked control reproduces re-entry");
  assert.deepEqual(wiring.dedupeFamilyCandidates([ordinaryA, { ...opaqueB, kind: "opaque-log" }]), oldWinner,
    "reverse-binding-only evidence is skipped regardless of plugin identity assumptions");
});
