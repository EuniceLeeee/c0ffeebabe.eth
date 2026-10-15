// Thin historical caller of production discovery -> strict -> Graph -> prices.
// Expected pools are output-only assertions, never input seeds or admitted edges.
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore, type StartupCheckpointEnvelope } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { runAtBlock } from "../../../../blockscan-at-block-cli.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { DODO_V2_FAMILY_ID } from "../manifest.js";
import { DODO_V2_SWAP_TOPIC } from "../../dodo-v2-abi.js";

export function readyReuseScope(prior: StartupCheckpointEnvelope | null, block: number, hash: string, families: readonly string[]) {
  assert(prior?.readyGeneration && prior.inProgressRun === null);
  assert.equal(prior.readyGeneration.cutoff.number, block); assert.equal(prior.readyGeneration.cutoff.hash, hash);
  assert.deepEqual(prior.readyGeneration.universeRange, { fromBlock: block, toBlock: block });
  assert.deepEqual(Object.keys(prior.readyGeneration.familyPartitions ?? {}).sort(), [...families].sort());
  assert.equal(prior.readyGeneration.observationScope, undefined);
  return { parentCheckpointFingerprint: prior.checkpointFingerprint, familyIds: [...families] };
}
async function main() {
  const args = new Map<string, string>();
  const required = ["--tx", "--rpc-file", "--out", "--executor", "--owner", "--revm-bin", "--expect-pools"];
  const allowed = [...required, "--valuation-families", "--reuse-ready"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert(allowed.includes(key) && !args.has(key) && value && !value.startsWith("--"));
    args.set(key, value);
  }
  for (const name of required) assert(args.has(name));
  const tx = args.get("--tx")!, out = resolve(args.get("--out")!);
  assert(ethers.isHexString(tx, 32)); assert(!existsSync(out));
  const expected = args.get("--expect-pools")!.split(",").map(a => ethers.getAddress(a).toLowerCase());
  assert(expected.length > 0 && new Set(expected).size === expected.length);
  const valuationFamilies = (args.get("--valuation-families") ?? "").split(",").filter(Boolean);
  assert(valuationFamilies.every(f => f === "univ2-standard" || f === "univ3-standard"));
  assert.equal(new Set(valuationFamilies).size, valuationFamilies.length);
  const families = [String(DODO_V2_FAMILY_ID), ...valuationFamilies];
  const executor = ethers.getAddress(args.get("--executor")!).toLowerCase();
  const owner = ethers.getAddress(args.get("--owner")!).toLowerCase();
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  process.env.SEARCHER_DRY_RUN = "1";
  process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0";
  process.env.MAINNET_RPC_URL = rpcUrl;
  process.env.SEARCHER_REVM_SIM_BIN = args.get("--revm-bin")!;
  process.env.BOTVM_ADDRESS = executor;
  process.env.BOTVM_OWNER = owner;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  const wiring = createRebuildWiring({ rpcUrl, familyIds: families,
    executionIdentity: { executor, transactionOrigin: owner } });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name),
    JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  let stage = "receipt", reusePath: string | null = null, reuseBytes: Buffer | null = null;
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [tx]);
    assert(receipt && receipt.transactionHash.toLowerCase() === tx.toLowerCase() && BigInt(receipt.status) === 1n);
    const block = Number(BigInt(receipt.blockNumber));
    const header = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash);
    save("receipt.json", receipt); save("header.json", header);
    const observed = new Set(receipt.logs.filter((log: any) => log.topics[0]?.toLowerCase() === DODO_V2_SWAP_TOPIC)
      .map((log: any) => String(log.address).toLowerCase()));
    assert(expected.every(pool => observed.has(pool)), "expected pool lacks a DODOSwap log in the real TX");
    const checkpoint = resolve(out, "ready.json");
    let familyUpdateScope;
    if (args.has("--reuse-ready")) {
      reusePath = resolve(args.get("--reuse-ready")!);
      assert(!existsSync(reusePath + ".lock") && !existsSync(reusePath + ".attestation-journal"), "original Ready active");
      reuseBytes = readFileSync(reusePath);
      familyUpdateScope = readyReuseScope(await new UniverseRebuildCheckpointStore({ path: reusePath }).load(), block, header.hash, families);
      copyFileSync(reusePath, checkpoint, constants.COPYFILE_EXCL);
      assert(readFileSync(checkpoint).equals(reuseBytes) && readFileSync(reusePath).equals(reuseBytes), "source Ready changed while copying");
      save("reused-ready.json", { path: reusePath, sha256: createHash("sha256").update(reuseBytes).digest("hex"),
        ...familyUpdateScope, scope: "Saved natural same-N Ready copy plus current production revalidation; not fresh-from-zero discovery." });
    }
    stage = "production-single-block-ready";
    const ready = await rebuildUniverse({ ...wiring,
      store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `dodo-gsp-single-${block}`, observationRange: { fromBlock: block, toBlock: block },
      ...(familyUpdateScope ? { familyUpdateScope } : {}),
      attestationConcurrency: 1, log: message => console.log(message) });
    assert.equal(ready.cutoff.number, block); assert.equal(ready.cutoff.hash, header.hash);
    const { graph } = resolveStrictReadyRuntime(ready);
    const targetEdges = graph.filter(edge => expected.includes(edge.target.toLowerCase()));
    save("ready-summary.json", { family: DODO_V2_FAMILY_ID, families, tx, block, blockHash: header.hash,
      graphHash: ready.graphHash, instances: ready.activeInstanceKeys, totalEdges: graph.length,
      targetEdges, attestationConcurrency: 1, broadcast: false,
      claim: "natural single-block strict/Graph only; price rows inspected separately; not dual execution or representative latency" });
    for (const pool of expected) assert.equal(targetEdges.filter(edge => edge.target.toLowerCase() === pool).length, 2,
      `expected two naturally admitted directions for ${pool}`);
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(block), "--through", "prices",
      "--execution-mode", "source-block", "--out", resolve(out, "prices"), "--executor", executor,
      "--owner", owner, "--revm-bin", args.get("--revm-bin")!]);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).split(rpcUrl).join("[REDACTED]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message }); console.error(JSON.stringify({ stage, message })); process.exitCode = 1;
  } finally {
    try {
      if (reusePath && reuseBytes) {
        assert(!existsSync(reusePath + ".lock") && !existsSync(reusePath + ".attestation-journal"));
        assert(readFileSync(reusePath).equals(reuseBytes), "original Ready changed");
      }
    } finally { provider.destroy(); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("DODO historical-ready invalid input; no input files overwritten"); process.exitCode = 1; });
