// Thin Family-scoped production Ready/price caller. Expected pool is checked
// only AFTER natural block discovery. No manual candidates, graph or pricing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { runAtBlock } from "../../../../blockscan-at-block-cli.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { BALANCER_V3_FAMILY_ID } from "../manifest.js";
import { decodeSwapLog } from "../discovery.js";

async function main() {
  const args = new Map<string, string>();
  const required = ["--tx", "--rpc-file", "--out", "--executor", "--owner", "--revm-bin", "--expect-pool"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert(required.includes(key) && !args.has(key) && value && !value.startsWith("--"));
    args.set(key, value);
  }
  assert.equal(args.size, required.length);
  const tx = args.get("--tx")!, out = resolve(args.get("--out")!);
  assert(ethers.isHexString(tx, 32)); assert(!existsSync(out));
  const expected = ethers.getAddress(args.get("--expect-pool")!).toLowerCase();
  const executor = ethers.getAddress(args.get("--executor")!).toLowerCase();
  const owner = ethers.getAddress(args.get("--owner")!).toLowerCase();
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  process.env.SEARCHER_DRY_RUN = "1";
  process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0";
  process.env.MAINNET_RPC_URL = rpcUrl;
  process.env.SEARCHER_REVM_SIM_BIN = args.get("--revm-bin")!;
  process.env.BOTVM_ADDRESS = executor; process.env.BOTVM_OWNER = owner;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  const wiring = createRebuildWiring({ rpcUrl, familyIds: [BALANCER_V3_FAMILY_ID],
    executionIdentity: { executor, transactionOrigin: owner } });
  assert(wiring.isFamilyEnabled?.(BALANCER_V3_FAMILY_ID), "enable through existing Family flag; do not change defaults");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name),
    JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n", { flag: "wx", mode: 0o600 });
  let stage = "receipt";
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [tx]);
    assert(receipt && receipt.transactionHash.toLowerCase() === tx.toLowerCase() && BigInt(receipt.status) === 1n);
    const block = Number(BigInt(receipt.blockNumber));
    const header = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash);
    assert(receipt.logs.some((log: any) => decodeSwapLog(log)?.pool.toLowerCase() === expected));
    save("receipt.json", receipt); save("header.json", header);
    const checkpoint = resolve(out, "ready.json");
    stage = "production-single-block-ready";
    const ready = await rebuildUniverse({ ...wiring, store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `balancer-v3-single-${block}`, observationRange: { fromBlock: block, toBlock: block },
      attestationConcurrency: 1, log: message => console.log(message) });
    assert.equal(ready.cutoff.number, block); assert.equal(ready.cutoff.hash, header.hash);
    const { graph } = resolveStrictReadyRuntime(ready);
    const targetEdges = graph.filter(edge => edge.target.toLowerCase() === expected);
    save("ready-summary.json", { tx, block, blockHash: header.hash, graphHash: ready.graphHash,
      instances: ready.activeInstanceKeys, totalEdges: graph.length, targetEdges, attestationConcurrency: 1,
      broadcast: false, claim: "natural single-block strict/Graph; not opportunity or performance acceptance" });
    const tokens = new Set(targetEdges.flatMap(edge => [edge.tokenIn.toLowerCase(), edge.tokenOut.toLowerCase()]));
    assert(tokens.size >= 2 && targetEdges.length === tokens.size * (tokens.size - 1),
      "all pool directions must already be naturally admitted");
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(block), "--through", "prices",
      "--execution-mode", "source-block", "--out", resolve(out, "prices"), "--executor", executor,
      "--owner", owner, "--revm-bin", args.get("--revm-bin")!]);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).split(rpcUrl).join("[REDACTED]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message }); console.error(JSON.stringify({ stage, message })); process.exitCode = 1;
  } finally { provider.destroy(); }
}
main().catch(() => { console.error("Balancer V3 historical-ready invalid input; existing files untouched"); process.exitCode = 1; });
