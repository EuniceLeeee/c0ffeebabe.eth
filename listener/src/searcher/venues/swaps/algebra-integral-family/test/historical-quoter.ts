// Opt-in production discovery/strict/Exact probe. Does not publish or edit Ready,
// execute a swap, benchmark live, submit transactions, or claim original-state parity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { executeFamilyExactQuote } from "../../../adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { plugin } from "../../../production-families/algebra-integral.production.js";
import { ALGEBRA_POOL_INTERFACE, ALGEBRA_SWAP_TOPIC } from "../abi.js";
import { ALGEBRA_BOUND_QUOTER, ALGEBRA_QUOTER_INTERFACE } from "../quoter-model.js";
import { familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import type { AlgebraIntegralDescriptor } from "../types.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";

const json = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function codePin() {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = readdirSync(dir).filter(name => name.endsWith(".ts")).sort();
  return { familySourceSha256: sha(files.map(name => `${name}\0${sha(readFileSync(resolve(dir, name)))}`).join("\n")),
    definitionHash: familyDefinitionHash(String(plugin.manifest.familyId)),
    memoDefinitionHash: familyMemoDefinitionHash(String(plugin.manifest.familyId)) };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const names = ["--tx", "--rpc-file", "--out", "--executor", "--owner"];
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1] && !argv[i + 1]!.startsWith("--"));
    args.set(argv[i]!, argv[i + 1]!);
  }
  assert.equal(args.size, names.length);
  const tx = args.get("--tx")!; assert(ethers.isHexString(tx, 32));
  const executor = ethers.getAddress(args.get("--executor")!), owner = ethers.getAddress(args.get("--owner")!);
  assert.notEqual(executor.toLowerCase(), owner.toLowerCase(), "probe must cover distinct executor and origin");
  const url = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof url === "string" && /^https?:\/\//.test(url));
  const fd = openSync(resolve(args.get("--out")!), "wx", 0o600);
  const report: Record<string, any> = { schema: "algebra-production-quoter-probe-v1", status: "failed",
    tx, executor, transactionOrigin: owner, started: new Date().toISOString(),
    claim: "receipt-only production discovery and strict lifecycle + same-N Exact; NOT Ready/effective, actual payment/receipt, original TX state, performance or merge acceptance",
    rpc: [], samples: [], errors: [], safety: { broadcast: false, signing: false, readyWrites: false } };
  let count = 0, stage = "header";
  const deadline = Date.now() + 120000;
  const redact = (error: unknown) => String(error instanceof Error ? error.message : error)
    .split(url).join("[RPC]").replace(/https?:\/\/[^\s"<>]+/g, "[URL]").slice(0,2000);
  async function rpc(method: string, params: unknown[]): Promise<any> {
    if (++count > 80 || Date.now() >= deadline) throw Error("historical diagnostic budget exceeded");
    const entry: any = { method, params, id: count }; report.rpc.push(entry);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: json({ jsonrpc: "2.0", id: count, method, params }), signal: AbortSignal.timeout(Math.min(12000, deadline - Date.now())) });
    entry.httpStatus = res.status;
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    const answer: any = await res.json();
    assert(answer?.jsonrpc === "2.0" && answer.id === entry.id && Object.hasOwn(answer, "result") !== Object.hasOwn(answer, "error"), "RPC response identity/shape mismatch");
    if (answer.error) { entry.errorCode = answer.error.code; throw Error(`RPC ${answer.error.code}`); }
    entry.result = answer.result;
    return answer.result;
  }
  try {
    report.code = codePin();
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const receipt = await rpc("eth_getTransactionReceipt", [tx]);
    assert(receipt && receipt.transactionHash.toLowerCase() === tx.toLowerCase() && BigInt(receipt.status) === 1n);
    const header = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash);
    const source: CanonicalSource = { number: Number(BigInt(header.number)), hash: header.hash, generation: 1 };
    report.source = { ...source, timestamp: Number(BigInt(header.timestamp)), stateRoot: header.stateRoot };
    const pin = { blockHash: source.hash, requireCanonical: true };
    const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner,
      generationFence: { assertCurrent(generation, requested) { assert.equal(generation, source.generation); assert.deepEqual(requested, source); } },
      provider: {
        async call(call, block) {
          assert.equal(block, source.number);
          if (call.to.toLowerCase() === ALGEBRA_BOUND_QUOTER.toLowerCase() && call.data.startsWith(ALGEBRA_QUOTER_INTERFACE.getFunction("quoteExactInputSingle")!.selector)) {
            assert.equal(call.from?.toLowerCase(), owner.toLowerCase(), "production quote lost transaction origin");
          }
          return rpc("eth_call", [call, pin]);
        },
        async getCode(address, block) { assert.equal(block, source.number); return rpc("eth_getCode", [address, pin]); },
        async getStorage(address, slot, block) { assert.equal(block, source.number); return rpc("eth_getStorageAt", [address, slot, pin]); },
      } });
    stage = "production-lifecycle";
    const publication = await runStrictFamilyLifecycle({ catalog, familyId: plugin.manifest.familyId,
      source, runtime, observations: receipt.logs.map((log: any) => ({ kind: "log" as const, source,
        address: log.address, topics: log.topics, data: log.data, transactionHash: receipt.transactionHash,
        blockNumber: source.number, logIndex: Number(BigInt(log.logIndex)) })) });
    report.instances = publication.instances.map(i => ({ instanceKey: i.instanceKey, routes: i.routes.length, descriptor: i.descriptor }));
    assert(publication.instances.length > 0, "no naturally admitted instance");
    stage = "production-exact";
    for (const instance of publication.instances) {
      const d = instance.descriptor as AlgebraIntegralDescriptor;
      assert.equal(d.executedFee.kind, "cypher-bound-quoter");
      const logs = receipt.logs.filter((l: any) => l.address.toLowerCase() === d.pool.toLowerCase() && l.topics[0]?.toLowerCase() === ALGEBRA_SWAP_TOPIC);
      assert.equal(logs.length, 1, "probe requires one original swap per admitted pool");
      const swap = ALGEBRA_POOL_INTERFACE.parseLog(logs[0])!.args;
      const amounts = [BigInt(swap.amount0), BigInt(swap.amount1)].map(x => x < 0n ? -x : x);
      for (const route of instance.routes) {
        const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!;
        const index = route.tokenIn.toLowerCase() === d.token0.toLowerCase() ? 0 : 1;
        for (const multiplier of [1n, 2n]) {
          const amountIn = amounts[index]! * multiplier;
          const sample: any = { pool: d.pool, tokenIn: route.tokenIn, tokenOut: route.tokenOut, amountIn, multiplier,
            amountSource: "original-leg token delta; reverse direction uses original output as new input, NOT production P" };
          report.samples.push(sample);
          const quote = await executeFamilyExactQuote({ family: catalog.forFamily(plugin.manifest.familyId),
            route: handle, amountIn, source, generation: source.generation, runtime, executor,
            runtimeEvidence: [], requireChainAmountQuote: true });
          sample.status = quote.status;
          if (quote.status !== "resolved") { sample.failure = quote.outcome; throw Error("production Exact unresolved"); }
          sample.amountOut = quote.amountOut; sample.methodId = quote.methodId; sample.evidenceRefs = quote.evidenceRefs;
          assert(quote.amountOut > 0n);
        }
      }
    }
    const endHeader = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(endHeader.hash, header.hash);
    assert.deepEqual(codePin(), report.code, "source changed during diagnostic");
    report.status = "production-lifecycle-and-quoter-only-pass";
  } catch (error) { report.errors.push({ stage, message: redact(error) }); process.exitCode = 1; }
  finally { report.finished = new Date().toISOString(); report.rpcRequests = count;
    writeFileSync(fd, json(report)); fsyncSync(fd); closeSync(fd);
    console.log(json({ status: report.status, source: report.source, instances: report.instances?.length,
      quotes: report.samples.length, requests: count, errors: report.errors, output: args.get("--out") })); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("algebra historical Quoter probe invalid input"); process.exitCode = 1; });
}
