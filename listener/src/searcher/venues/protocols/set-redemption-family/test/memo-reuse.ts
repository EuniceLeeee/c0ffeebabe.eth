import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import { candidatesFromCall, createProbeWiring, createRebuildWiring, rebuildFamilyCandidateKey } from "../../../../universe-rebuild-production.js";
import { UniverseRebuildCheckpointStore, type DurableVerifiedMemo } from "../../../../universe-rebuild-checkpoint.js";
import { StrictProductionRuntimeRoot } from "../../../../strict-production-runtime-session.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import type { PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { TokenEdge } from "../../../../planner/token-graph.js";
import { FAMILY } from "../manifest.js";
import { MODULE } from "../codec.js";
import { actor, components, fixtureProvider, module, set, source, state } from "./fixture.js";

// Local transport, actual production discovery/probe/seal/findReusableMemo/
// rehydrate/aggregate/Graph/root. No upstream RPC and no claim of chain execution.
const s = state(), start = source(), requests: string[] = []; let cutoff = start;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", b => { body += b.toString(); });
  req.on("end", async () => {
    const parsed = JSON.parse(body), list = Array.isArray(parsed) ? parsed : [parsed];
    const results = await Promise.all(list.map(async ({ id, method, params }: any) => {
      requests.push(method);
      try {
        const p = fixtureProvider(s, cutoff); let result: unknown;
        if (method === "eth_chainId") result = "0x1";
        else if (method === "eth_getBlockByNumber") result = { number: ethers.toQuantity(start.number), hash: start.hash, parentHash: source(99).hash,
          nonce: "0x0000000000000000", sha3Uncles: ethers.ZeroHash, logsBloom: "0x" + "00".repeat(256), transactionsRoot: ethers.ZeroHash,
          stateRoot: ethers.ZeroHash, receiptsRoot: ethers.ZeroHash, miner: ethers.ZeroAddress, difficulty: "0x0", totalDifficulty: "0x0",
          extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", transactions: [], uncles: [], baseFeePerGas: "0x1", mixHash: ethers.ZeroHash };
        else {
          assert.equal(params.at(-1), ethers.toQuantity(cutoff.number));
          if (method === "eth_getCode") result = await p.getCode(params[0], cutoff.number);
          else if (method === "eth_getStorageAt") result = ethers.ZeroHash; // non-proxy authority fence only
          else { assert.equal(method, "eth_call"); result = await p.call(params[0], cutoff.number); }
        }
        return { jsonrpc: "2.0", id, result };
      } catch (e) { return { jsonrpc: "2.0", id, error: { code: -32000, message: String(e) } }; }
    }));
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
  });
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const socket = server.address(); assert(socket && typeof socket === "object");
try {
  const rpcUrl = `http://127.0.0.1:${socket.port}`, probe = createProbeWiring({ rpcUrl }), wiring = createRebuildWiring({ rpcUrl });
  const candidates = candidatesFromCall({ kind: "call", target: module, data: MODULE.encodeFunctionData("redeem", [set, 100n, actor]), transactionHash: ethers.ZeroHash,
    blockNumber: start.number, blockHash: start.hash, traceAddress: [] });
  const candidate = candidates.find(c => c.familyId === FAMILY); assert(candidate);
  const candidateKey = rebuildFamilyCandidateKey(candidate);
  async function seal() {
    const outcome = await probe.attestFamilyInstanceOnce({ candidate, cutoff });
    assert.equal(outcome.status, "verified", outcome.status === "verified" ? undefined : outcome.reasonCode); assert(outcome.status === "verified");
    return JSON.parse(JSON.stringify(probe.sealDurableVerifiedMemo({ candidate, result: outcome.result, proofSource: cutoff, familyCandidateKey: candidateKey }))) as DurableVerifiedMemo;
  }
  function graph(memo: DurableVerifiedMemo) {
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff }) as PreparedFamilyInstance;
    const snapshot = wiring.buildGraphSnapshot(wiring.aggregateOnceByFamily([instance]), cutoff) as { edges: TokenEdge[] };
    const root = new StrictProductionRuntimeRoot({ catalog, readySource: cutoff, readyGraph: snapshot.edges, readyInstances: [instance], readyFundingAssets: [] });
    assert.equal(snapshot.edges.length, 4); return { instance, root, snapshot };
  }
  const old = await seal(), original = graph(old), serialized = JSON.stringify(old);
  const checkpoint = { ...UniverseRebuildCheckpointStore.emptyEnvelope(), verifiedMemos: { [candidateKey]: old } };
  requests.length = 0;
  assert.equal(await wiring.findReusableMemo({ candidate, cutoff: { ...start, generation: 1000 }, checkpoint }), old); assert.equal(requests.length, 0);
  cutoff = source(101); s.units[0] *= 2n;
  assert.equal(await wiring.findReusableMemo({ candidate, cutoff, checkpoint }), old, "price-only change preserves structural binding");
  cutoff = source(102); const newComponent = "0x1000000000000000000000000000000000000077"; s.components[3] = newComponent;
  assert.equal(await wiring.findReusableMemo({ candidate, cutoff, checkpoint }), null, "ordinary fresh-cutoff memo recheck sees membership drift");
  const fresh = await seal(), replacement = graph(fresh);
  assert.notEqual(fresh.memoFingerprint, old.memoFingerprint);
  assert.notEqual(replacement.instance.staticBindingFingerprint, original.instance.staticBindingFingerprint);
  assert(replacement.root.resolveBlockTouchedStateKeys({ kind: "call", target: newComponent, data: "0x12345678" }, cutoff).includes(fresh.instanceKey));
  assert.deepEqual(original.root.resolveBlockTouchedStateKeys({ kind: "call", target: newComponent, data: "0x12345678" }, cutoff), []);
  assert.deepEqual(replacement.root.resolveBlockTouchedStateKeys({ kind: "call", target: components[3], data: "0x12345678" }, cutoff), []);
  assert.equal(JSON.stringify(old), serialized, "incumbent memo retained unchanged; no cache deletion");
  cutoff = source(103); s.enabled = false; assert.equal(await wiring.findReusableMemo({ candidate, cutoff, checkpoint }), null);
  assert.equal((await probe.attestFamilyInstanceOnce({ candidate, cutoff })).status, "retryable");
  cutoff = source(104); s.enabled = true; graph(await seal());
  console.log("Set actual production memo identity recheck/reseal/Graph/dependency replacement and permission recovery: PASS (local HTTP fixture, no full discovery/CAS or chain claim)");
} finally { await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
