import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import sample from "./public-sample.json";
import {
  candidateFingerprint, candidatesFromCall, createProbeWiring, createRebuildWiring,
  memoCheapBindingValid, rebuildFamilyCandidateKey,
} from "../../../../universe-rebuild-production.js";
import {
  durableVerifiedMemoFingerprint, UniverseRebuildCheckpointStore,
  type DurableVerifiedMemo, type StartupCheckpointEnvelope,
} from "../../../../universe-rebuild-checkpoint.js";
import { StrictProductionRuntimeRoot } from "../../../../strict-production-runtime-session.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import type { TokenEdge } from "../../../../planner/token-graph.js";
import {
  recheckFamilyInstanceMemoBinding, type PreparedFamilyInstance,
} from "../../../adapter-family-runtime.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { isPricedFamily } from "../../../family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from
  "../../../production-family-composition.js";
import { BALANCE, FEES, MULTICALL, ORACLE, POOL, TOKEN } from "../codec.js";
import { ELLA_ID } from "../manifest.js";
import type { EllaDescriptor } from "../types.js";

// Local integration: production discovery decoder -> probe/seal -> memo reuse ->
// rehydrate/aggregate/Graph -> dependency root. The code/storage/balances come
// from public-sample.json; later binding/price transitions are synthetic. This
// does not exercise rebuildUniverse discovery coverage, checkpoint CAS or replay.
const fixture = sample.states[0];
const slots: Readonly<Record<string, string>> = fixture.slots;
const word = (value: bigint | string) => ethers.toBeHex(BigInt(value), 32);
const addressAt = (slot: string) => ethers.toBeHex(BigInt(slots[slot]), 20).toLowerCase();
const pool = "0x33c577296b0cdece6186ea48cd8fe98bd1a6e3a4";
const token = addressAt("1"), factory = addressAt("10"), oracle = addressAt("15");
const aggregator = "0x3547473da7deb396acf07d57340a8ef931d7414e";
const otherOracle = "0x1000000000000000000000000000000000000005";
const otherAggregator = "0x1000000000000000000000000000000000000006";
const start: CanonicalSource = { number: fixture.block, hash: fixture.blockHash, generation: 1 };
const source = (offset: number): CanonicalSource => ({
  number: start.number + offset, hash: word(BigInt(start.number + offset)), generation: offset + 1,
});
interface FixtureState {
  readonly oracle: string;
  readonly aggregator: string;
  readonly price: bigint;
  readonly failIdentity?: boolean;
}
const initial: FixtureState = { oracle, aggregator, price: BigInt(fixture.calls.tokenPrice) };
const states = new Map<number, FixtureState>([[start.number, initial]]);
interface RpcRequest { readonly id: number; readonly method: string; readonly params: readonly unknown[] }
const requests: RpcRequest[] = [];
const unexpected: string[] = [];
let cutoff = start;
let failedIdentityReads = 0;

function rpcResult(request: RpcRequest): unknown {
  const { method, params } = request;
  if (method === "eth_chainId") return "0x1";
  if (method === "eth_getBlockByNumber") {
    assert.equal(params[0], ethers.toQuantity(start.number), "only the stored proof header is requested");
    return {
      number: params[0], hash: start.hash, parentHash: ethers.ZeroHash,
      nonce: "0x0000000000000000", sha3Uncles: ethers.ZeroHash,
      logsBloom: "0x" + "00".repeat(256), transactionsRoot: ethers.ZeroHash,
      stateRoot: ethers.ZeroHash, receiptsRoot: ethers.ZeroHash, miner: ethers.ZeroAddress,
      difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1",
      gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", transactions: [],
      uncles: [], baseFeePerGas: "0x1", mixHash: ethers.ZeroHash,
    };
  }
  assert.equal(params.at(-1), ethers.toQuantity(cutoff.number), "every state read is pinned to the cutoff");
  const state = states.get(cutoff.number)!;
  if (method === "eth_getCode") {
    const target = String(params[0]).toLowerCase();
    if (target === pool) return sample.poolCode;
    if (target === factory) return sample.factoryCode;
    assert([token, oracle, aggregator, otherOracle, otherAggregator].includes(target), `unexpected code ${target}`);
    return "0x6000";
  }
  if (method === "eth_getStorageAt") {
    assert.equal(String(params[0]).toLowerCase(), pool);
    const slot = BigInt(String(params[1]));
    if (slot === 15n) return word(state.oracle);
    if (slot === 11n || slot === 12n || slot === BigInt(ethers.id("eip1967.proxy.implementation")) - 1n) return word(0n);
    assert(String(slot) in slots, `unexpected storage ${slot}`);
    return slots[String(slot)];
  }
  assert.equal(method, "eth_call", `unexpected RPC ${method}`);
  const call = params[0] as { to: string; data: string };
  const target = call.to.toLowerCase(), selector = call.data.slice(0, 10);
  if (target === state.oracle && selector === ORACLE.getFunction("aggregator")!.selector) {
    if (state.failIdentity) {
      failedIdentityReads++;
      throw new Error("fixture identity read unavailable");
    }
    return word(state.aggregator);
  }
  if (target === token && selector === TOKEN.getFunction("decimals")!.selector) return word(18n);
  if (target === pool && selector === POOL.getFunction("tokenPrice")!.selector) return word(state.price);
  if (target === token && selector === TOKEN.getFunction("balanceOf")!.selector) {
    assert.equal(TOKEN.decodeFunctionData("balanceOf", call.data)[0].toLowerCase(), pool);
    return word(fixture.calls.balanceOf);
  }
  if (target === MULTICALL.toLowerCase() && selector === BALANCE.getFunction("getEthBalance")!.selector) {
    assert.equal(BALANCE.decodeFunctionData("getEthBalance", call.data)[0].toLowerCase(), pool);
    return word(fixture.nativeBalance);
  }
  if (target === factory) {
    for (const name of ["getFees", "getSystemCut", "getFeesAddress"] as const) {
      if (selector === FEES.getFunction(name)!.selector) return word(fixture.calls[name]);
    }
  }
  throw new Error(`unexpected call ${target} ${selector}`);
}

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
  request.on("end", () => {
    const parsed = JSON.parse(body) as RpcRequest | RpcRequest[];
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const results = batch.map(rpc => {
      requests.push(rpc);
      try { return { jsonrpc: "2.0", id: rpc.id, result: rpcResult(rpc) }; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "fixture identity read unavailable") unexpected.push(message);
        return { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message } };
      }
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
  });
});

function pricingReads() {
  return requests.filter(request => {
    if (request.method === "eth_getStorageAt") return [11n, 12n].includes(BigInt(String(request.params[1])));
    if (request.method !== "eth_call") return false;
    const selector = (request.params[0] as { data: string }).data.slice(0, 10);
    return ![TOKEN.getFunction("decimals")!.selector, ORACLE.getFunction("aggregator")!.selector].includes(selector);
  });
}

function assertIdentityOnly(at: CanonicalSource) {
  assert.deepEqual(unexpected, []);
  assert(requests.some(r => r.method === "eth_call" &&
    (r.params[0] as { data: string }).data.startsWith(ORACLE.getFunction("aggregator")!.selector)),
  "reuse really rechecks the mutable oracle identity");
  assert.equal(pricingReads().length, 0, "memo recheck must not fetch price, fees, balances or fee counters");
  for (const r of requests.filter(r => ["eth_call", "eth_getCode", "eth_getStorageAt"].includes(r.method))) {
    assert.equal(r.params.at(-1), ethers.toQuantity(at.number));
  }
}

function checkpoint(memo: DurableVerifiedMemo): StartupCheckpointEnvelope {
  return { ...UniverseRebuildCheckpointStore.emptyEnvelope(), verifiedMemos: { [memo.familyCandidateKey]: memo } };
}

// Negative controls alter only an actually admitted/sealed memo and retain a
// correct content fingerprint; they never invent a successful admission.
function alteredMemo(memo: DurableVerifiedMemo, patch: Partial<DurableVerifiedMemo>): DurableVerifiedMemo {
  const changed = { ...memo, ...patch, memoFingerprint: "" };
  return { ...changed, memoFingerprint: durableVerifiedMemoFingerprint(changed) };
}

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const listening = server.address();
assert(listening && typeof listening === "object");
const rpcUrl = `http://127.0.0.1:${listening.port}`;
try {
  const [candidate, ...extra] = candidatesFromCall({ kind: "call", target: pool, data: POOL.encodeFunctionData("swapBase1"),
    transactionHash: sample.tx, blockNumber: start.number, blockHash: start.hash, traceAddress: [] });
  assert(candidate); assert.equal(extra.length, 0); assert.equal(candidate.familyId, ELLA_ID);
  assert.equal(candidate.candidateKind, "ella-exchange");
  const candidateKey = rebuildFamilyCandidateKey(candidate);
  const probe = createProbeWiring({ rpcUrl });
  const wiring = createRebuildWiring({ rpcUrl });

  async function attestAndSeal(at: CanonicalSource): Promise<DurableVerifiedMemo> {
    const outcome = await probe.attestFamilyInstanceOnce({ candidate, cutoff: at });
    assert.equal(outcome.status, "verified", outcome.status === "verified" ? undefined : outcome.reasonCode);
    assert(outcome.status === "verified");
    const sealed = probe.sealDurableVerifiedMemo({ candidate, result: outcome.result,
      proofSource: at, familyCandidateKey: candidateKey });
    assert.equal(sealed.familyId, ELLA_ID); assert.equal(sealed.instanceKey, pool);
    assert.equal(sealed.familyCandidateKey, candidateKey);
    assert.equal(sealed.memoFingerprint, durableVerifiedMemoFingerprint(sealed));
    assert.equal(sealed.validity.policy, "immutable-code");
    assert.deepEqual(sealed.validity.proofSource, { number: at.number, hash: at.hash });
    assert(pricingReads().some(r => r.method === "eth_call" &&
      (r.params[0] as { data: string }).data.startsWith(POOL.getFunction("tokenPrice")!.selector)),
    "a fresh admission runs the full pricing lifecycle");
    assert.deepEqual(unexpected, []);
    // Cross the actual JSON persistence boundary before reuse/rehydration.
    return JSON.parse(JSON.stringify(sealed)) as DurableVerifiedMemo;
  }

  function graphRoot(memo: DurableVerifiedMemo, at: CanonicalSource, expected: FixtureState) {
    const readsBefore = requests.length;
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: at }) as PreparedFamilyInstance;
    const descriptor = instance.descriptor as EllaDescriptor;
    assert.equal(descriptor.oracle.toLowerCase(), expected.oracle);
    assert.equal(descriptor.aggregator.toLowerCase(), expected.aggregator);
    assert(instance.staticBindingFingerprint);
    assert.equal(instance.routes.length, 2); assert.equal(instance.routeHandles.length, 2);
    assert.equal(instance.pricingInstances.length, 1);
    assert.deepEqual([...instance.pricingInstances[0].dependencies].map(v => v.toLowerCase()).sort(),
      [pool, token, factory, expected.oracle, expected.aggregator].sort());
    const graph = wiring.buildGraphSnapshot(wiring.aggregateOnceByFamily([instance]), at) as {
      format: string; edges: readonly TokenEdge[];
    };
    assert.equal(graph.format, "strict-rebuild-graph-v1"); assert.equal(graph.edges.length, 2);
    const root = new StrictProductionRuntimeRoot({ catalog, readySource: at,
      readyGraph: graph.edges, readyInstances: [instance], readyFundingAssets: [] });
    const affected = (target: string) => root.resolveBlockTouchedStateKeys({ kind: "call", target, data: "0x12345678" }, at);
    assert.deepEqual(affected(expected.oracle), [pool]);
    assert.deepEqual(affected(expected.aggregator), [pool]);
    if (expected.oracle !== oracle) assert.deepEqual(affected(oracle), [], "old oracle leaves the new dependency root");
    if (expected.aggregator !== aggregator) assert.deepEqual(affected(aggregator), [], "old aggregator leaves the new dependency root");
    assert.equal(requests.length, readsBefore, "rehydrate/Graph/dependency resolution are local");
    return { instance, graph, affected };
  }

  const memo = await attestAndSeal(start);
  const original = graphRoot(memo, start, initial);
  const originalBytes = JSON.stringify(memo);

  requests.length = 0;
  // A fresh wiring/provider rules out an ethers cache masking accidental RPC.
  assert.equal(await createRebuildWiring({ rpcUrl }).findReusableMemo({ candidate,
    checkpoint: checkpoint(memo), cutoff: { ...start, generation: 90 } }), memo);
  assert.equal(requests.length, 0, "same number/hash fast path is zero RPC, even in a new generation");

  for (const [offset, price] of [[1, initial.price], [2, initial.price * 2n]] as const) {
    cutoff = source(offset); states.set(cutoff.number, { ...initial, price }); requests.length = 0;
    const reused = await wiring.findReusableMemo({ candidate, checkpoint: checkpoint(memo), cutoff });
    assert.equal(reused, memo, offset === 1 ? "unchanged identity reuses" : "price-only changes reuse");
    assertIdentityOnly(cutoff);
    assert.deepEqual(reused.validity.proofSource, memo.validity.proofSource, "reuse does not rewrite proof provenance");
    graphRoot(reused, cutoff, initial);
  }

  for (const [offset, state] of [
    [3, { ...initial, oracle: otherOracle }], [4, { ...initial, aggregator: otherAggregator }],
  ] as const) {
    cutoff = source(offset); states.set(cutoff.number, state); requests.length = 0;
    assert.equal(await wiring.findReusableMemo({ candidate, checkpoint: checkpoint(memo), cutoff }), null,
      "unchanged pool code/lineage/key cannot preserve a changed oracle binding");
    assertIdentityOnly(cutoff);
    requests.length = 0;
    const replacement = await attestAndSeal(cutoff);
    assert.equal(replacement.instanceKey, memo.instanceKey);
    assert.equal(replacement.validity.authorityFingerprint, memo.validity.authorityFingerprint);
    const rebuilt = graphRoot(replacement, cutoff, state);
    assert.notEqual(rebuilt.instance.staticBindingFingerprint, original.instance.staticBindingFingerprint);
    assert.notDeepEqual(rebuilt.graph.edges.map(e => e.canonicalEdgeId), original.graph.edges.map(e => e.canonicalEdgeId),
      "new Graph identities bind the replacement descriptor");
    assert.deepEqual(original.affected(otherOracle), []); assert.deepEqual(original.affected(otherAggregator), []);
    assert.equal(JSON.stringify(memo), originalBytes, "revalidation does not mutate the incumbent memo");
  }

  cutoff = source(5); states.set(cutoff.number, { ...initial, failIdentity: true }); requests.length = 0;
  assert.equal(await wiring.findReusableMemo({ candidate, checkpoint: checkpoint(memo), cutoff }), null);
  assert(failedIdentityReads > 0, "the negative actually reaches the failed identity read");
  assertIdentityOnly(cutoff);
  const failed = await probe.attestFamilyInstanceOnce({ candidate, cutoff });
  assert.equal(failed.status, "retryable", "a failed recheck cannot turn into stale admission on fallback");
  assert.equal(pricingReads().length, 0);

  cutoff = source(6); states.set(cutoff.number, initial);
  const projection = { ...memo.staticProjection as Record<string, unknown> };
  delete projection.staticBindingFingerprint;
  const identity = memo.verifiedIdentity as Record<string, unknown>;
  for (const [label, old] of [
    ["legacy missing static fingerprint", alteredMemo(memo, { staticProjection: projection })],
    ["changed lineage", alteredMemo(memo, { verifiedIdentity: { ...identity, lineageId: "different-lineage" } })],
    ["changed instance", alteredMemo(memo, { instanceKey: otherOracle })],
  ] as const) {
    requests.length = 0;
    assert(memoCheapBindingValid({ memo: old, candidate, cutoff, familyId: ELLA_ID }), `${label}: reach identity policy`);
    assert.equal(await wiring.findReusableMemo({ candidate, checkpoint: checkpoint(old), cutoff }), null, label);
    assert.equal(pricingReads().length, 0);
  }

  const legacyCandidate = { ...candidate }; delete legacyCandidate.candidateKind;
  const legacy = alteredMemo(memo, { candidateSnapshot: legacyCandidate, candidateFingerprint: candidateFingerprint(legacyCandidate) });
  assert(memoCheapBindingValid({ memo: legacy, candidate: legacyCandidate, cutoff, familyId: ELLA_ID }));
  requests.length = 0;
  assert.equal(await wiring.findReusableMemo({ candidate: legacyCandidate, checkpoint: checkpoint(legacy), cutoff }), null,
    "missing plugin candidateKind requires full strict attestation");
  assert.equal(pricingReads().length, 0);

  const family = catalog.forFamily(ELLA_ID); assert(isPricedFamily(family));
  let escapedReads = 0, stale = false;
  const poison = async (): Promise<never> => { escapedReads++; throw new Error("unexpected fenced transport"); };
  const fencedRuntime = createStrictCentralAdapterRuntime({
    provider: { getCode: poison, getStorage: poison, call: poison },
    generationFence: { assertCurrent(generation, requested) {
      assert(!stale, "stale generation fence");
      assert.deepEqual({ ...requested, generation }, start, "source escaped pinned fence");
    } },
  });
  const recheck = (at: CanonicalSource, generation = at.generation) => recheckFamilyInstanceMemoBinding({
    family, candidate: { ...candidate, candidateKind: "ella-exchange" }, source: at, generation, runtime: fencedRuntime,
  });
  await assert.rejects(recheck(start, start.generation + 1), /generation/i);
  await assert.rejects(recheck({ ...start, hash: word(99n) }), /source escaped pinned fence/);
  stale = true;
  await assert.rejects(recheck(start), /stale generation fence/);
  assert.equal(escapedReads, 0, "mismatched/stale sources fail before any transport");
  assert.deepEqual(unexpected, []);
  console.log("Ella production memo reuse: same-cutoff zero RPC; unchanged/price-only identity-only reuse; oracle/aggregator reattest/seal/Graph/dependency replacement; failed identity, legacy and lineage/instance misses; source/generation fences: PASS");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
