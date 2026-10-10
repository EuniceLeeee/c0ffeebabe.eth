// Family-owned evidence runner: thin calls into current production Ready/prices.
// Expected sample identity is used only after discovery; never seed target edges.
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
import { ELLA_ID } from "../manifest.js";
import { POOL } from "../codec.js";
import sample from "./public-sample.json";

async function main() {
  const names = ["--rpc-file", "--out", "--executor", "--owner", "--revm-bin"];
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    assert(names.includes(key) && !args.has(key) && value && !value.startsWith("--"));
    args.set(key, value);
  }
  assert(names.every(key => args.has(key)));
  const out = resolve(args.get("--out")!); assert(!existsSync(out));
  const executor = ethers.getAddress(args.get("--executor")!).toLowerCase();
  const owner = ethers.getAddress(args.get("--owner")!).toLowerCase();
  assert.notEqual(owner, executor);
  assert.equal(process.env.SEARCHER_TEST_DISABLE_DOTENV, "1", "disable dotenv before module import");
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  Object.assign(process.env, { SEARCHER_DRY_RUN: "1", SEARCHER_BLOCKSCAN_SUBMIT: "0",
    MAINNET_RPC_URL: rpcUrl, SEARCHER_REVM_SIM_BIN: args.get("--revm-bin")!,
    BOTVM_ADDRESS: executor, BOTVM_OWNER: owner });
  const families = [String(ELLA_ID), "univ2-standard", "univ3-standard"];
  const request = new ethers.FetchRequest(rpcUrl); request.timeout = 30000;
  const provider = new ethers.JsonRpcProvider(request, 1, { staticNetwork: true, batchMaxCount: 1 });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name),
    JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n", { flag: "wx", mode: 0o600 });
  let stage = "receipt";
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [sample.tx]);
    assert(receipt && receipt.transactionHash.toLowerCase() === sample.tx && BigInt(receipt.status) === 1n);
    const N = Number(BigInt(receipt.blockNumber)), known = sample.states.find(s => s.block === N);
    assert(known); assert.equal(receipt.blockHash, known.blockHash);
    const bought = receipt.logs.filter((log: any) => log.topics[0]?.toLowerCase() === POOL.getEvent("Bought")!.topicHash);
    const actual = bought.filter((log: any) => {
      assert.equal(log.removed, false); assert.equal(log.transactionHash, receipt.transactionHash);
      assert.equal(log.blockHash, receipt.blockHash); assert.equal(log.blockNumber, receipt.blockNumber);
      const event = POOL.decodeEventLog("Bought", log.data, log.topics);
      return event.isBuy && BigInt(event.amountIn) === BigInt(sample.amountIn) &&
        event.exchange.toLowerCase() === log.address.toLowerCase();
    });
    assert.equal(actual.length, 1); const pool = actual[0].address.toLowerCase();
    const header = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash);
    save("receipt.json", receipt); save("header.json", header);
    save("input.json", { tx: sample.tx, N, hash: header.hash, stateRoot: header.stateRoot, families,
      expectedPool: pool, executor, owner, claim: "same-N end-state integration; not original pre-call or performance" });
    const checkpoint = resolve(out, "ready.json");
    const wiring = createRebuildWiring({ rpcUrl, familyIds: families,
      executionIdentity: { executor, transactionOrigin: owner } });
    stage = "natural-single-block-ready";
    const ready = await rebuildUniverse({ ...wiring, store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `ella-single-${N}`, observationRange: { fromBlock: N, toBlock: N },
      attestationConcurrency: 1, log: message => console.log(message) });
    assert.equal(ready.cutoff.number, N); assert.equal(ready.cutoff.hash, header.hash);
    const { graph } = resolveStrictReadyRuntime(ready);
    const targetEdges = graph.filter(edge => edge.canonicalEdgeId?.startsWith(String(ELLA_ID) + "\u001f") &&
      edge.instanceKey?.toLowerCase() === pool);
    save("ready-summary.json", { family: ELLA_ID, families, tx: sample.tx, pool, block: N,
      blockHash: header.hash, graphHash: ready.graphHash, instances: ready.activeInstanceKeys,
      totalEdges: graph.length, targetEdges, attestationConcurrency: 1, broadcast: false,
      readySha256: createHash("sha256").update(readFileSync(checkpoint)).digest("hex") });
    assert.equal(targetEdges.length, 2, "both Ella directions must be naturally admitted");
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(N), "--through", "prices",
      "--execution-mode", "source-block", "--out", resolve(out, "prices"), "--executor", executor,
      "--owner", owner, "--revm-bin", args.get("--revm-bin")!]);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).split(rpcUrl).join("[REDACTED]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message }); console.error(JSON.stringify({ stage, message })); process.exitCode = 1;
  } finally { provider.destroy(); }
}
main().catch(() => { console.error("Ella historical-ready invalid input; existing evidence untouched"); process.exitCode = 1; });
