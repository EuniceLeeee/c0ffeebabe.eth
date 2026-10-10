// Opt-in historical Exact-cache evidence. No synthetic state, admission or cache entries.
// Does not prove natural effective publication, execution parity or stage latency.
import assert from "node:assert/strict";
import { openSync, readFileSync, writeFileSync, closeSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { createAdapterFamilyExactQuoteCache } from "../../../../adapter-family-exact-quote-cache.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { assertIssuedPreparedFamilyInstance, executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { splicedProductionAmount, json, sha, same } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { ERC4626_FAMILY_ID, INFINIFI_LINEAGE_ID } from "../manifest.js";
import { INFINIFI_ABI } from "../infinifi.js";

const N = 25944594, HASH = "0x3fffa168458c84ea4cb5c5587db4e3eddcdad91c260baeff8b763ced64a7886e";
const VAULT = "0xdbdc1ef57537e34680b898e1febd3d68c7389bcb";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const OWNER = "0x1000000000000000000000000000000000000001";

async function main() {
  const args = new Map<string, string>(), names = ["--ready", "--reference-prices", "--reference-edge", "--rpc-file", "--out"];
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(names.includes(process.argv[i]!) && !args.has(process.argv[i]!) && process.argv[i + 1]);
    args.set(process.argv[i]!, process.argv[i + 1]!);
  }
  assert.equal(args.size, names.length);
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [], reads: [],
    claim: "Actual production Exact whole-quote cache hit within each source; fresh requests and changed output across adjacent real historical blocks. Not a coordinator/effective publication or execution/latency verdict.",
    safety: { signing: false, broadcast: false, protocolOverrides: false, actorFunding: false, syntheticCacheEntries: false }, performance: "NOT RUN" };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 180_000;
  const timer = setTimeout(() => abort.abort(new Error("historical cache deadline")), 180_000);
  let rpcUrl = "", count = 0;
  const redact = (e: unknown) => String(e).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  try {
    const readyPath = realpathSync(args.get("--ready")!), referencePath = realpathSync(args.get("--reference-prices")!);
    const declarationPath = realpathSync(resolve(dirname(referencePath), "declaration.json"));
    const paths = [readyPath, referencePath, declarationPath, fileURLToPath(import.meta.url)];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = pins(); report.code = sourcePin();
    const reference = parseAtBlockJson(readFileSync(referencePath, "utf8")), declaration = parseAtBlockJson(readFileSync(declarationPath, "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
    assert.equal(ready.cutoff.number, N); assert.equal(ready.cutoff.hash, HASH);
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === ERC4626_FAMILY_ID && same(m.instanceKey, VAULT));
    assert.equal(memos.length, 1); const memo = memos[0]!;
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [ERC4626_FAMILY_ID], executionIdentity: { executor: EXECUTOR, transactionOrigin: OWNER } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "retained Ready needs production re-attestation");
    const family = asPricedFamily(catalog.forStrictFamily(ERC4626_FAMILY_ID));
    report.admission = { cutoff: ready.cutoff, candidate: memo.candidateSnapshot, fingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash };
    rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(/^https?:\/\//.test(rpcUrl));
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      abort.signal.throwIfAborted(); assert(++count <= 300, "read budget");
      assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const id = count, response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25_000)]) });
      assert(response.ok, "HTTP " + response.status); const body: any = await response.json();
      assert.equal(body.id, id); assert.equal(body.jsonrpc, "2.0"); assert(!body.error, "historical read failed: " + method);
      report.reads.push({ id, method, params, result: body.result }); return body.result;
    };
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const headers = await Promise.all([N, N + 1].map(n => rpc("eth_getBlockByNumber", [ethers.toQuantity(n), false])));
    assert.equal(headers[0].hash, HASH); assert.equal(headers[1].parentHash, HASH);
    assert.equal(Number(BigInt(headers[1].number)), N + 1); report.headers = headers;
    const candidate: any = memo.candidateSnapshot;
    assertHistoricalDiscoveryReceipt(await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, ready.cutoff);
    const cache = createAdapterFamilyExactQuoteCache();
    for (const header of headers) {
      const source: CanonicalSource = { number: Number(BigInt(header.number)), hash: header.hash, generation: Number(BigInt(header.number)) };
      const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
      const d: any = instance.descriptor; assert(d.infinifi && d.lineageId === INFINIFI_LINEAGE_ID);
      const route = instance.routes.find(r => same(r.tokenIn, d.asset)); assert(route);
      const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey); assert(handle);
      assert.equal(graph.filter(e => e.instanceKey === VAULT && same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)).length, 1);
      const borrowed = splicedProductionAmount(reference, declaration, [args.get("--reference-edge")!], route.tokenIn);
      const pin = { blockHash: source.hash, requireCanonical: true };
      const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: OWNER, exactQuoteCache: cache,
        generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
        provider: {
          call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, source.number); return rpc("eth_call", [tx, pin]); },
          getCode: async (address: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getCode", [address, pin]); },
          getStorage: async (address: string, slot: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getStorageAt", [address, slot, pin]); },
        } as never });
      const pendingRewards = BigInt(INFINIFI_ABI.decodeFunctionResult("vested", await rpc("eth_call", [{ to: d.infinifi.yieldSharing,
        data: INFINIFI_ABI.encodeFunctionData("vested") }, pin]))[0]);
      const request = { family, route: handle, source, generation: source.generation, amountIn: borrowed.amountIn,
        executor: EXECUTOR, runtimeEvidence: [], runtime, requireChainAmountQuote: true, control: { signal: abort.signal, deadlineAtMs } };
      const before = cache.snapshot(), beforeReads = count;
      const first = await executeFamilyExactQuote(request); assert.equal(first.status, "resolved"); if (first.status !== "resolved") throw new Error("Exact unresolved");
      const afterFirst = cache.snapshot(), firstReads = count - beforeReads;
      assert(firstReads > 0, "each distinct real block must fetch new quote bytes");
      const second = await executeFamilyExactQuote(request); assert.equal(second.status, "resolved"); if (second.status !== "resolved") throw new Error("cached Exact unresolved");
      const afterSecond = cache.snapshot(), secondReads = count - beforeReads - firstReads;
      assert.equal(secondReads, 0, "same-source second quote should use the production cache");
      assert.equal(second.amountOut, first.amountOut); assert.equal(afterSecond.hits, afterFirst.hits + 1);
      assert.equal(afterFirst.stores, before.stores + 1); assert.equal(afterFirst.misses, before.misses + 1);
      assert.equal(afterSecond.stateStores, 0, "this amount-dependent method must not be reported as a state-only cache");
      report.samples.push({ source, pendingRewards, input: borrowed, amountIn: borrowed.amountIn, amountOut: first.amountOut,
        firstReads, secondReads, before, afterFirst, afterSecond, evidenceRefs: first.evidenceRefs });
    }
    assert.equal(report.samples[0].amountIn, report.samples[1].amountIn);
    assert.notEqual(report.samples[0].amountOut, report.samples[1].amountOut, "real accrued state must change the tested quote");
    assert(report.samples[1].pendingRewards > 0n);
    report.outputDelta = report.samples[1].amountOut - report.samples[0].amountOut;
    report.cache = cache.snapshot(); report.inputsAfter = pins(); report.codeAfter = sourcePin();
    assert.deepEqual(report.inputsAfter, report.inputs); assert.deepEqual(report.codeAfter, report.code);
    for (const header of headers) assert.equal((await rpc("eth_getBlockByNumber", [header.number, false])).hash, header.hash);
    report.result = "pass";
  } catch (error) { report.error = redact(error); process.exitCode = 1; }
  finally { clearTimeout(timer); report.rpcReads = count; writeFileSync(fd, json(report)); closeSync(fd); }
  console.log(json({ result: report.result, samples: report.samples.length, rpcReads: count, out: args.get("--out") }));
}

await main();
