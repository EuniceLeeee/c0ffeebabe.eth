// Current production revalidation only. Retained Ready is never rewritten.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { sourcePin } from "../../../../test/family-integration/three-family/historical-dual.js";
import { json, sha } from "../../../protocols/set-redemption-family/test/historical-runtime-observations.js";
import { copyReadySnapshot, readyReuseScope, curveReadyTargetHasSwap } from "./historical-ready.js";
import { CURVE_PLAIN_FAMILY_ID as ID } from "../manifest.js";
import { recipientNomination } from "./recipient-nomination.js";
async function main() {
  const values = new Map<string, string>(), keys = ["--prior-ready", "--tx", "--pool", "--revm-bin", "--rpc-file", "--out"];
  for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i], value = process.argv[i + 1]; assert(keys.includes(key) && value && !values.has(key)); values.set(key, value); }
  assert.equal(values.size, keys.length);
  const out = resolve(values.get("--out")!), prior = resolve(values.get("--prior-ready")!); assert(!existsSync(out)); mkdirSync(out, { mode: 0o700 });
  const save = (name: string, data: unknown) => writeFileSync(resolve(out, name), json(data), { flag: "wx", mode: 0o600 });
  const helperPath = new URL("./recipient-nomination.ts", import.meta.url), helperHash = sha(readFileSync(helperPath));
  const initial = sourcePin(), ownHash = sha(readFileSync(new URL(import.meta.url))); save("source-before.json", { ...initial, ownHash, helperHash });
  const original = await new UniverseRebuildCheckpointStore({ path: prior }).load(); assert(original && !original.inProgressRun);
  const source = original.readyGeneration.cutoff, pool = ethers.getAddress(values.get("--pool")!).toLowerCase(), tx = values.get("--tx")!;
  assert(ethers.isHexString(tx, 32)); const old = activeReadyMemos(original).filter(m => m.familyId === ID && m.instanceKey.toLowerCase() === pool); assert(old.length <= 1);
  const rpcUrl = JSON.parse(readFileSync(values.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(typeof rpcUrl === "string");
  const redact = (v: unknown) => String(v).split(rpcUrl).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const executor = "0x1000000000000000000000000000000000000002", owner = "0x1000000000000000000000000000000000000001";
  Object.assign(process.env, { SEARCHER_DRY_RUN: "1", SEARCHER_BLOCKSCAN_SUBMIT: "0", SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE: "1", MAINNET_RPC_URL: rpcUrl,
    SEARCHER_REVM_SIM_BIN: values.get("--revm-bin")!, BOTVM_ADDRESS: executor, BOTVM_OWNER: owner });
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  let stage = "header", reuse: Buffer | undefined;
  try {
    const header = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]); assert.equal(header.hash, source.hash); save("header.json", header);
    const receipt = await provider.send("eth_getTransactionReceipt", [tx]); assert.equal(receipt.blockHash, source.hash); assert.equal(BigInt(receipt.status), 1n); assert.equal(receipt.transactionHash.toLowerCase(), tx.toLowerCase());
    save("receipt.json", receipt);
    let historicalTrace: any;
    if (!curveReadyTargetHasSwap(receipt.logs, pool, [ID])) { historicalTrace = await provider.send("debug_traceTransaction", [tx, { tracer: "callTracer" }]); save("nomination-trace.json", historicalTrace); }
    save("nomination.json", recipientNomination(receipt, pool, historicalTrace));
    const checkpoint = resolve(out, "ready.json"); if (old.length) reuse = copyReadySnapshot(prior, checkpoint);
    save("input-provenance.json", { prior, priorSha256: sha(readFileSync(prior)), revalidation: old.length > 0, source, pool, tx, claim: old.length ? "Current production selective revalidation; no new natural discovery, valuation, opportunity or performance claim." : "Current production single-block discovery/strict/Graph; valuation, opportunity and performance not run.", revmSha256: sha(readFileSync(values.get("--revm-bin")!)) });
    const wiring = createRebuildWiring({ rpcUrl, familyIds: [ID], executionIdentity: { executor, transactionOrigin: owner } });
    const store = new UniverseRebuildCheckpointStore({ path: checkpoint });
    stage = "production-ready-revalidation";
    const ready = await rebuildUniverse({ ...wiring, store, runId: "curve-plain-recipient-" + source.number,
      observationRange: { fromBlock: source.number, toBlock: source.number }, ...(old.length ? { familyUpdateScope: readyReuseScope(original, source.number, source.hash, [ID]) } : {}),
      attestationConcurrency: 1, log: m => console.log(redact(m)) });
    assert.equal(ready.cutoff.hash, source.hash); const { graph } = resolveStrictReadyRuntime(ready), final = await store.load(); assert(final && !final.inProgressRun);
    const memos = activeReadyMemos(final).filter(m => m.familyId === ID && m.instanceKey.toLowerCase() === pool); assert.equal(memos.length, 1); assert(wiring.isReadyMemoDefinitionCurrent?.(memos[0]));
    const descriptor = memos[0].compiledDescriptor as any; assert(descriptor.binding && descriptor.directions); const edges = graph.filter(e => e.instanceKey.toLowerCase() === pool); assert(edges.length >= 2);
    save("result.json", { result: "ready-revalidated", source: ready.cutoff, memos, edges, prices: "NOT RUN", performance: "NOT RUN" });
  } catch (e) { save("failure.json", { stage, message: redact(e instanceof Error ? e.message : e) }); process.exitCode = 1; }
  finally { provider.destroy(); const after = sourcePin(); save("source-after.json", { ...after, ownHash: sha(readFileSync(new URL(import.meta.url))) }); if (reuse) assert(readFileSync(prior).equals(reuse)); assert.deepEqual(after, initial); assert.equal(sha(readFileSync(new URL(import.meta.url))), ownHash); assert.equal(sha(readFileSync(helperPath)), helperHash); }
}
main().catch(() => { console.error("Curve plain recipient Ready failed; preserve first failure"); process.exitCode = 1; });
