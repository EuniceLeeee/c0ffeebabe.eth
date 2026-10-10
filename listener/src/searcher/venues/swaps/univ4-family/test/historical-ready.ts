// Thin same-N production Ready/prices caller; receipt is an assertion, not a seed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { runAtBlock } from "../../../../blockscan-at-block-cli.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { SAT1_SAMPLE as SAMPLE, SAT1_INSTANCE, assertSat1Receipt } from "./history-evidence.js";

async function main() {
  const names = ["--rpc-file", "--out", "--executor", "--owner", "--revm-bin"];
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    assert([...names, "--ready"].includes(key) && !args.has(key) && value && !value.startsWith("--")); args.set(key, value);
  }
  assert(names.every(key => args.has(key)));
  const out = resolve(args.get("--out")!); assert(!existsSync(out));
  const executor = ethers.getAddress(args.get("--executor")!).toLowerCase(), owner = ethers.getAddress(args.get("--owner")!).toLowerCase();
  assert(executor !== owner && executor !== ethers.ZeroAddress && owner !== ethers.ZeroAddress);
  assert.equal(process.env.SEARCHER_TEST_DISABLE_DOTENV, "1", "disable dotenv before imports");
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  Object.assign(process.env, { SEARCHER_DRY_RUN: "1", SEARCHER_BLOCKSCAN_SUBMIT: "0", MAINNET_RPC_URL: rpcUrl,
    SEARCHER_REVM_SIM_BIN: args.get("--revm-bin")!, BOTVM_ADDRESS: executor, BOTVM_OWNER: owner });
  const families = ["univ4", "univ4-fee-hook"];
  const request = new ethers.FetchRequest(rpcUrl); request.timeout = 30000;
  const provider = new ethers.JsonRpcProvider(request, 1, { staticNetwork: true, batchMaxCount: 1 });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name),
    JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n", { flag: "wx", mode: 0o600 });
  let stage = "receipt";
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [SAMPLE.tx]); assertSat1Receipt(receipt);
    const header = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash); save("receipt.json", receipt); save("header.json", header);
    save("input.json", { tx: SAMPLE.tx, N: SAMPLE.block, hash: header.hash, stateRoot: header.stateRoot,
      families, executor, owner, claim: "same-N end-state; not original pre-call, opportunity or timing" });
    const checkpoint = args.has("--ready") ? resolve(args.get("--ready")!) : resolve(out, "ready.json");
    const store = new UniverseRebuildCheckpointStore({ path: checkpoint });
    const wiring = createRebuildWiring({ rpcUrl, familyIds: families, executionIdentity: { executor, transactionOrigin: owner } });
    stage = "natural-single-block-ready";
    const ready = args.has("--ready") ? (await store.load())?.readyGeneration : await rebuildUniverse({ ...wiring, store,
      runId: `v4-sat1-single-${SAMPLE.block}`, observationRange: { fromBlock: SAMPLE.block, toBlock: SAMPLE.block },
      attestationConcurrency: 1, log: message => console.log(message) });
    assert(ready); assert.equal(ready.cutoff.number, SAMPLE.block); assert.equal(ready.cutoff.hash, header.hash);
    assert.equal(ready.universeRange.fromBlock, SAMPLE.block); assert.equal(ready.universeRange.toBlock, SAMPLE.block);
    const { graph } = resolveStrictReadyRuntime(ready);
    const targetEdges = graph.filter(edge => edge.canonicalEdgeId?.startsWith("univ4-fee-hook\u001f") &&
      edge.instanceKey?.toLowerCase() === SAT1_INSTANCE);
    save("ready-summary.json", { family: "univ4-fee-hook", families, tx: SAMPLE.tx, poolId: SAMPLE.poolId,
      block: SAMPLE.block, blockHash: header.hash, graphHash: ready.graphHash, instances: ready.activeInstanceKeys,
      totalEdges: graph.length, targetEdges, checkpoint, reusedReady: args.has("--ready"), attestationConcurrency: 1, broadcast: false,
      readySha256: createHash("sha256").update(readFileSync(checkpoint)).digest("hex") });
    assert.equal(targetEdges.length, 2, "Sat1 must first be naturally admitted with both directions");
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(SAMPLE.block), "--through", "prices", "--execution-mode", "source-block",
      "--out", resolve(out, "prices"), "--executor", executor, "--owner", owner, "--revm-bin", args.get("--revm-bin")!]);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).split(rpcUrl).join("[REDACTED]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message }); console.error(JSON.stringify({ stage, message })); process.exitCode = 1;
  } finally { provider.destroy(); }
}
main().catch(() => { console.error("Sat1 historical-ready invalid input; existing evidence untouched"); process.exitCode = 1; });
