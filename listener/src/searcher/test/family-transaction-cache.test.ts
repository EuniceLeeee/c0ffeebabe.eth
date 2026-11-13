import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { ReadyActivityArchive } from "../ready-activity-archive.js";
import { cachedFamilyReady, cachedFamilySimulation, familyFactCacheKey } from "./family-transaction-cache.js";
import type { DaemonResponse, StrictSimulateRequest } from "../revm-sim-client.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
async function scratch(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(resolve(tmpdir(), "family-fact-cache-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function fixture(directory: string, revert = false) {
  const request: StrictSimulateRequest = { rpcUrl: "https://rpc.invalid/secret", blockNumber: 100,
    sourcePin: { chainId: 1, blockHash: hash(1), stateRoot: hash(2) }, from: address(3), to: address(4), data: "0x1234",
    transactionOrigin: address(5), executionGasLimit: 100_000, tokenDeals: [{ token: address(6), to: address(3), amount: "17" }] };
  const response: DaemonResponse = { ok: true, latencyMs: 123,
    sourceAttestation: { kind: "node-attested", blockNumber: 100, chainId: 1, blockHash: hash(1), stateRoot: hash(2), parentHash: hash(0) },
    strict: { outcome: { kind: revert ? "Revert" : "Success", phase: "main", output: revert ? "0xdead" : "0xbeef" },
      executionGasUsed: "1000", tokenDeltas: [], nativeDeltas: [], totalSupplyDeltas: [], logs: [] } };
  const context = { executor: address(3), owner: address(5), executorCodeHash: hash(3), executorArtifactSha256: "artifact",
    sourceTreeSha256: "production-code", executorProvisioning: { mode: "counterfactual" },
    executionEnvironment: { method: "debug_traceCall", source: request.sourcePin } };
  let executions = 0;
  return { directory, request, context, response, executions: () => executions,
    execute: async () => { executions++; return structuredClone(response); } };
}

test("same full simulation input reuses completed success and revert without leaking the RPC URL", async () => {
  await scratch(async directory => {
    for (const revert of [false, true]) {
      const f = fixture(resolve(directory, String(revert)), revert);
      const first = await cachedFamilySimulation(f), second = await cachedFamilySimulation({ ...f,
        request: { ...f.request, rpcUrl: "https://another.invalid/credential" } });
      assert.equal(first.cache.status, "executed"); assert.equal(second.cache.status, "reused");
      assert.equal(f.executions(), 1); assert.deepEqual(second.response, f.response);
      const bytes = await readFile(resolve(f.directory, "simulation", `${first.cache.key}.json`), "utf8");
      assert(!bytes.includes("secret") && !bytes.includes("rpc.invalid") && !bytes.includes("credential"));
      assert.equal(second.response.latencyMs, 123, "cached receipt retains its original measurement");
    }
  });
});

test("calldata, funding, observer, actor, gas, state, method and executor changes cannot hit old simulations", async () => {
  await scratch(async directory => {
    const f = fixture(directory); await cachedFamilySimulation(f);
    const changes: Array<(x: ReturnType<typeof fixture>) => void> = [
      x => { x.request.data = "0xabcd"; }, x => { x.request.tokenDeals![0]!.amount = "18"; },
      x => { x.request.transactionOrigin = address(9); }, x => { x.request.executionGasLimit = 99999; },
      x => { x.request.observeTokens = [address(8)]; }, x => { x.request.preCalls = [{ from: address(3), to: address(7), calldata: "0x" }]; },
      x => { x.request.sourcePin!.blockHash = hash(9); x.response.sourceAttestation!.blockHash = hash(9); },
      x => { x.context.executorCodeHash = hash(9); }, x => { x.context.executorArtifactSha256 = "new-artifact"; },
      x => { x.context.sourceTreeSha256 = "new-code"; }, x => { x.context.executionEnvironment.method = "eth_simulateV1"; },
      x => { x.context.executorProvisioning.mode = "deployed"; },
    ];
    for (const change of changes) {
      const other = fixture(directory); change(other);
      assert.equal((await cachedFamilySimulation(other)).cache.status, "executed");
      assert.equal(other.executions(), 1);
    }
  });
});

test("timeouts, quotas, failed preparation and malformed source evidence are never reusable executions", async () => {
  await scratch(async directory => {
    const f = fixture(directory);
    for (const message of ["HTTP 429", "timeout", "funding failed"]) {
      await assert.rejects(cachedFamilySimulation({ ...f, execute: async () => { throw new Error(message); } }), new RegExp(message));
    }
    assert.equal((await cachedFamilySimulation({ ...f, execute: async () => ({ ok: false, latencyMs: 0 }) })).cache.status, "executed");
    const halted = structuredClone(f.response);
    halted.strict!.outcome = { kind: "Revert", phase: "main", output: "0x", nestedHalt: "out of gas" };
    for (let i = 0; i < 2; i++) assert.equal((await cachedFamilySimulation({ ...f, execute: async () => halted })).cache.status, "executed");
    const bad = structuredClone(f.response); bad.sourceAttestation!.stateRoot = hash(99);
    await assert.rejects(cachedFamilySimulation({ ...f, execute: async () => bad }), /source mismatch/);
    assert.equal((await cachedFamilySimulation(f)).cache.status, "executed");
    assert.equal((await cachedFamilySimulation(f)).cache.status, "reused");
    const abort = new AbortController(); abort.abort();
    await assert.rejects(cachedFamilySimulation({ ...f, control: { signal: abort.signal } }));
  });
});

test("concurrent callers share one completed response and corruption never silently becomes a miss", async () => {
  await scratch(async directory => {
    const f = fixture(directory);
    const rows = await Promise.all([cachedFamilySimulation(f), cachedFamilySimulation(f)]);
    assert.equal(f.executions(), 1); assert.deepEqual(rows.map(r => r.cache.status).sort(), ["executed", "reused"]);
    const path = resolve(directory, "simulation", `${rows[0]!.cache.key}.json`);
    const content = JSON.parse(await readFile(path, "utf8")); content.data = "{}";
    await writeFile(path, JSON.stringify(content));
    await assert.rejects(cachedFamilySimulation(f), /integrity/);
    assert.equal(f.executions(), 1);
  });
});

test("Ready uses one production build for identical input, resumes interrupted work, and never edits old snapshots", async () => {
  await scratch(async directory => {
    const binding = { family: "fixture", source: hash(1), definition: "v1", range: [100, 100], executor: address(2) };
    let builds = 0;
    const build = async (path: string) => { builds++; await writeFile(path, "production-ready"); };
    const first = await cachedFamilyReady({ directory, binding, out: resolve(directory, "first.json"), build });
    const second = await cachedFamilyReady({ directory, binding, out: resolve(directory, "second.json"), build });
    assert.equal(builds, 1); assert.equal(first.status, "built"); assert.equal(second.status, "reused");
    for (const changed of [{ ...binding, definition: "v2" }, { ...binding, executor: address(3) }, { ...binding, source: hash(2) }]) {
      assert.equal((await cachedFamilyReady({ directory, binding: changed, out: resolve(directory, "different.json"), build })).status, "built");
    }
    const interrupted = { ...binding, family: "resume" };
    await assert.rejects(cachedFamilyReady({ directory, binding: interrupted, out: resolve(directory, "resume.json"), build: async path => {
      await writeFile(path, "partial-checkpoint"); throw new Error("interruption");
    } }), /interruption/);
    await cachedFamilyReady({ directory, binding: interrupted, out: resolve(directory, "resume.json"), build: async path => {
      assert.equal(await readFile(path, "utf8"), "partial-checkpoint"); await writeFile(path, "resumed-production-ready");
    } });
    assert.equal(await readFile(resolve(directory, "first.json"), "utf8"), "production-ready");
    assert.equal(await readFile(resolve(directory, "resume.json"), "utf8"), "resumed-production-ready");
  });
});

test("production activity archive shares same-block trace across Family classifiers, not across block hashes", async () => {
  await scratch(async directory => {
    const scope = { chainId: 1, fromBlock: 100, toBlock: 100, cutoffHash: hash(1) };
    const options = { ...scope, directory: resolve(directory, familyFactCacheKey(scope)) };
    const a = new ReadyActivityArchive(options), b = new ReadyActivityArchive(options);
    const key = { blockNumber: 100, method: "debug_traceBlockByNumber" as const };
    const trace = [{ result: { from: address(1), to: address(2), calls: [{ to: address(3), input: "0xabcd" }] } }];
    await a.writeTrace({ ...key, trace });
    assert.deepEqual(await b.readTrace(key), trace);
    await a.readTrace(key);
    await a.writeClassifiedTrace(key, familyFactCacheKey("family-A"), [{ family: "A" }]);
    assert.equal(await b.readClassifiedTrace(key, familyFactCacheKey("family-B")), null);
    const other = { ...scope, cutoffHash: hash(2) };
    assert.equal(await new ReadyActivityArchive({ ...other, directory: resolve(directory, familyFactCacheKey(other)) }).readTrace(key), null);
  });
});

test("Ready cache writer lock is independent of the production checkpoint store lock", async () => {
  const { UniverseRebuildCheckpointStore } = await import("../universe-rebuild-checkpoint.js");
  const directory = await mkdtemp(join(tmpdir(), "family-ready-store-lock-"));
  try {
    const result = await cachedFamilyReady({ directory, binding: { fixture: "real-store-lock" }, out: join(directory, "out.json"),
      build: async path => {
        assert.equal(await new UniverseRebuildCheckpointStore({ path }).load(), null);
        await writeFile(path, "{}\n");
      } });
    assert.equal(result.status, "built");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
