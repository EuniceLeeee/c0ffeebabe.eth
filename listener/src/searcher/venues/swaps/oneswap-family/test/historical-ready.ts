// Revalidate an immutable retained Ready through current production; no prices or opportunity run.
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { sourcePin } from "../../../../test/family-integration/three-family/historical-dual.js";
import { json, sha } from "../../../protocols/set-redemption-family/test/historical-runtime-observations.js";
import { ID } from "../manifest.js";
async function main() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i], value = process.argv[i + 1]; assert(["--prior-ready", "--rpc-file", "--out"].includes(key) && value && !values.has(key)); values.set(key, value); }
  assert.equal(values.size, 3); assert.equal(process.env.SEARCHER_FAMILY_ONESWAP_ENABLED, "1");
  const out = resolve(values.get("--out")!), prior = resolve(values.get("--prior-ready")!); assert(!existsSync(out)); mkdirSync(out, { mode: 0o700 });
  const save = (name: string, data: unknown) => writeFileSync(resolve(out, name), json(data), { flag: "wx", mode: 0o600 });
  const priorSha = sha(readFileSync(prior)), initial = sourcePin(); save("source-before.json", initial);
  const original = await new UniverseRebuildCheckpointStore({ path: prior }).load(); assert(original && !original.inProgressRun);
  const source = original.readyGeneration.cutoff; assert.equal(source.number, 26130639); assert.equal(source.hash, "0x69fe42671a3df6c3bfcdc98f44d7078870696568246b1d9dfd976d2f3a0e42e5");
  const originalTargets = activeReadyMemos(original).filter(m => m.familyId === ID); assert.equal(originalTargets.length, 2);
  const rpcUrl = JSON.parse(readFileSync(values.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(typeof rpcUrl === "string");
  const redact = (v: unknown) => String(v).split(rpcUrl).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  let stage = "header";
  try {
    const header = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]); assert.equal(header.hash, source.hash); save("header.json", header);
    const checkpoint = resolve(out, "ready.json"); copyFileSync(prior, checkpoint, constants.COPYFILE_EXCL);
    save("input-provenance.json", { prior, priorSha, source, claim: "Current production selective revalidation; historical candidates preserved. No new natural discovery, valuation, opportunity or performance claim." });
    const wiring = createRebuildWiring({ rpcUrl, familyIds: [ID], executionIdentity: { executor: "0x1000000000000000000000000000000000000002", transactionOrigin: "0x1000000000000000000000000000000000000001" } });
    assert(wiring.isFamilyEnabled?.(ID)); const store = new UniverseRebuildCheckpointStore({ path: checkpoint });
    stage = "production-ready-revalidation";
    const ready = await rebuildUniverse({ ...wiring, store, runId: "oneswap-current-26130639", observationRange: { fromBlock: source.number, toBlock: source.number }, attestationConcurrency: 1, log: m => console.log(redact(m)) });
    assert.equal(ready.cutoff.hash, source.hash); const { graph } = resolveStrictReadyRuntime(ready), final = await store.load(); assert(final && !final.inProgressRun);
    const memos = activeReadyMemos(final).filter(m => m.familyId === ID); assert.equal(memos.length, 2);
    for (const m of memos) { assert(wiring.isReadyMemoDefinitionCurrent?.(m)); assert(originalTargets.some(t => t.instanceKey === m.instanceKey)); assert.equal(graph.filter(e => e.instanceKey === m.instanceKey).length, 2); }
    save("result.json", { result: "ready-revalidated", source: ready.cutoff, memos, edges: graph.filter(e => memos.some(m => m.instanceKey === e.instanceKey)), prices: "NOT RUN", performance: "NOT RUN" });
  } catch (e) { save("failure.json", { stage, message: redact(e instanceof Error ? e.message : e) }); process.exitCode = 1; }
  finally { provider.destroy(); save("source-after.json", sourcePin()); assert.equal(sha(readFileSync(prior)), priorSha); assert.deepEqual(sourcePin(), initial); }
}
main().catch(() => { console.error("OneSwap Ready failed; preserve first failure"); process.exitCode = 1; });
