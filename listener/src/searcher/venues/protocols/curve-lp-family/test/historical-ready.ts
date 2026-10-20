// Saved real candidates + one-block production scan -> real strict -> memo
// seal -> production Ready/Graph. The old observation window is not rescanned.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { runAtBlock } from "../../../../blockscan-at-block-cli.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { json, same, sha } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { FAMILY } from "../manifest.js";

async function main(argv = process.argv.slice(2)) {
  const required = ["--plan", "--source-candidates", "--rpc-file", "--revm-bin", "--revm-sha256", "--out"];
  const args = new Map<string, string>(); let withPrices = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!; if (name === "--with-prices") { assert(!withPrices); withPrices = true; continue; }
    assert([...required, "--target"].includes(name) && !args.has(name) && argv[i + 1]); args.set(name, argv[++i]!);
  }
  assert(required.every(name => args.has(name)));
  const out = resolve(args.get("--out")!); assert(!existsSync(out), "preserve previous evidence");
  const planPath = realpathSync(args.get("--plan")!), planBytes = readFileSync(planPath), plan = JSON.parse(planBytes.toString());
  assert.equal(plan.schema, "curve-lp-historical-input-plan-v1");
  const sourcePath = realpathSync(args.get("--source-candidates")!), sourceBytes = readFileSync(sourcePath), saved = JSON.parse(sourceBytes.toString());
  assert.equal(sha(sourceBytes), plan.sourceCandidatesSha256); assert.equal(saved.source.chainId, 1);
  assert.equal(saved.source.blockNumber, plan.source.number); assert(same(saved.source.blockHash, plan.source.hash));
  const executor = ethers.getAddress(plan.actors.executor), owner = ethers.getAddress(plan.actors.owner); assert(!same(executor, owner));
  const targets = plan.targets.filter((target: any) => !args.has("--target") || same(target.pool, args.get("--target")!)); assert(targets.length > 0);
  const candidates = targets.map((target: any) => {
    const rows = saved.candidates.filter((entry: any) => entry.familyId === FAMILY && same(entry.candidateSnapshot.address, target.pool)); assert.equal(rows.length, 1);
    const candidate = rows[0].candidateSnapshot; assert.deepEqual(candidate, target.candidate); assert.equal(candidate.familyId, FAMILY);
    assert.equal(candidate.candidateKind, "curve-lp"); assert(candidate.blockNumber <= plan.source.number);
    assert(ethers.isHexString(candidate.transactionHash, 32) && ethers.isHexString(candidate.blockHash, 32)); return candidate;
  });
  const revmPath = realpathSync(args.get("--revm-bin")!), revmSha256 = sha(readFileSync(revmPath)); assert.equal(revmSha256, args.get("--revm-sha256"));
  const code = sourcePin(), ownSha256 = sha(readFileSync(fileURLToPath(import.meta.url)));
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  process.env.SEARCHER_DRY_RUN = "1"; process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0"; process.env.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE = "1";
  process.env.MAINNET_RPC_URL = rpcUrl; process.env.SEARCHER_REVM_SIM_BIN = revmPath; process.env.BOTVM_ADDRESS = executor; process.env.BOTVM_OWNER = owner;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name), json(value) + "\n", { flag: "wx", mode: 0o600 });
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 }); let stage = "source";
  try {
    const header = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(plan.source.number), false]); assert(same(header.hash, plan.source.hash)); save("header.json", header);
    save("input-provenance.json", { plan: { path: planPath, sha256: sha(planBytes) }, sourceCandidates: { path: sourcePath, sha256: sha(sourceBytes) },
      originalPopulationCount: saved.count, selectedCandidates: candidates, testedState: plan.source, scanRange: { fromBlock: plan.source.number, toBlock: plan.source.number },
      discoveryMode: "saved-real-candidate-snapshot-plus-production-one-block-scan", naturallyDiscoveredAtTestedBlock: false,
      originalDiscoveryBlocks: candidates.map((candidate: any) => candidate.blockNumber), code, harnessSha256: ownSha256, revmSha256, actors: { executor, owner },
      signing: false, broadcast: false, scope: "Saved candidate provenance grants no admission. Current production strict, memo sealing and Graph publication must all execute; no original Ready or queue is changed." });
    const wiring = createRebuildWiring({ rpcUrl, familyIds: [FAMILY], startupCandidates: candidates, executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent);
    stage = "production-strict-and-ready";
    const checkpoint = resolve(out, "ready.json"), ready = await rebuildUniverse({ ...wiring,
      store: new UniverseRebuildCheckpointStore({ path: checkpoint }), runId: `curve-lp-selected-${plan.source.number}-${Date.now()}`,
      observationRange: { fromBlock: plan.source.number, toBlock: plan.source.number }, attestationConcurrency: 1, log: message => console.log(message) });
    const published = await new UniverseRebuildCheckpointStore({ path: checkpoint }).load(); assert(published && published.inProgressRun === null);
    assert.equal(ready.cutoff.number, plan.source.number); assert(same(ready.cutoff.hash, plan.source.hash));
    const { graph } = resolveStrictReadyRuntime(ready), selected = targets.map((target: any) => {
      const memos = activeReadyMemos(published).filter(memo => memo.familyId === FAMILY && same(memo.instanceKey, target.pool)); assert.equal(memos.length, 1, "selected target did not pass current production strict");
      const memo = memos[0]!; assert(wiring.isReadyMemoDefinitionCurrent!(memo));
      assert.equal(memo.validity.proofSource.number, ready.cutoff.number); assert(same(memo.validity.proofSource.hash, ready.cutoff.hash));
      const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff }) as any;
      const edges = graph.filter(edge => edge.instanceKey !== undefined && same(edge.instanceKey, target.pool));
      assert(instance.routes.length > 0); assert.equal(edges.length, instance.routes.length);
      return { pool: target.pool, memo, routes: instance.routes, edges };
    });
    save("ready-summary.json", { result: "selected-production-strict-ready-pass", source: ready.cutoff, range: ready.universeRange, graphHash: ready.graphHash,
      checkpoint: { path: checkpoint, sha256: sha(readFileSync(checkpoint)) }, selected, totalPublishedInstances: activeReadyMemos(published).length,
      naturallyDiscoveredAtTestedBlock: false, population187Accepted: false, signing: false, broadcast: false });
    if (withPrices) { stage = "production-prices"; await runAtBlock(["--ready", checkpoint, "--block", String(plan.source.number), "--through", "prices", "--execution-mode", "source-block",
      "--out", resolve(out, "prices"), "--executor", executor, "--owner", owner, "--revm-bin", revmPath]); }
  } catch (error) {
    const message = String(error instanceof Error ? error.stack : error).split(rpcUrl).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message }); console.error(json({ stage, message })); process.exitCode = 1;
  } finally {
    provider.destroy(); assert(readFileSync(sourcePath).equals(sourceBytes), "original candidate snapshot changed"); assert(readFileSync(planPath).equals(planBytes));
    assert.deepEqual(sourcePin(), code); assert.equal(sha(readFileSync(revmPath)), revmSha256); assert.equal(sha(readFileSync(fileURLToPath(import.meta.url))), ownSha256);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error("Curve LP selected historical Ready failed; existing evidence preserved"); process.exitCode = 1;
});
