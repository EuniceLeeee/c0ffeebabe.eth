// Family-scoped thin caller of current production discovery/strict/Graph/prices.
// Expected pool is checked after publication, never injected into discovery.
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { UniverseRebuildCheckpointStore, type StartupCheckpointEnvelope } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { runAtBlock } from "../../../../blockscan-at-block-cli.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import { CURVE_PLAIN_FAMILY_ID } from "../manifest.js";
import { SWAP_TOPIC, UINT_SWAP_TOPIC, UINT_NG_SWAP_TOPIC } from "../discovery.js";

// Optional same-block background supplies natural valuation paths; production
// wiring still owns discovery, identity and graph publication for every family.
export function curveReadyFamilies(value: string = CURVE_PLAIN_FAMILY_ID): string[] {
  const ids = value.split(",");
  assert(ids.includes(CURVE_PLAIN_FAMILY_ID) && new Set(ids).size === ids.length &&
    ids.every(id => [CURVE_PLAIN_FAMILY_ID, "curve-underlying", "univ3-standard"].includes(id)),
  "scope requires curve-plain and only optional curve-underlying/univ3-standard");
  return ids.sort();
}

/** The production checkpoint reader authenticates prior before this scope check. */
export function readyReuseScope(prior: StartupCheckpointEnvelope | null, block: number, hash: string,
  familyIds = curveReadyFamilies()) {
  assert(prior?.readyGeneration && prior.inProgressRun === null, "completed Ready required");
  assert.equal(prior.readyGeneration.cutoff.number, block);
  assert.equal(prior.readyGeneration.cutoff.hash, hash);
  assert.deepEqual(prior.readyGeneration.universeRange, { fromBlock: block, toBlock: block });
  const partitions = prior.readyGeneration.familyPartitions;
  assert(partitions && familyIds.every(id => Object.hasOwn(partitions, id)), "selected source partitions required");
  const ids = curveReadyFamilies(familyIds.join(","));
  assert.equal(prior.readyGeneration.observationScope, undefined);
  return { parentCheckpointFingerprint: prior.checkpointFingerprint, familyIds: ids };
}

/** Only immutable materialized snapshots: never lock or replay a live source. */
export function copyReadySnapshot(source: string, destination: string) {
  const assertInactive = () => assert(!existsSync(source + ".lock") && !existsSync(source + ".attestation-journal"),
    "reuse requires an inactive materialized Ready without lock or journal");
  assertInactive();
  const bytes = readFileSync(source);
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  assert(readFileSync(destination).equals(bytes), "source Ready changed while copying");
  assertInactive();
  return bytes;
}

async function main() {
  const args = new Map<string, string>();
  const required = ["--tx", "--rpc-file", "--out", "--executor", "--owner", "--revm-bin", "--expect-pool"];
  const names = [...required, "--reuse-ready", "--families"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert(names.includes(key) && !args.has(key) && value && !value.startsWith("--")); args.set(key, value);
  }
  assert(required.every(name => args.has(name)));
  const familyIds = curveReadyFamilies(args.get("--families"));
  const tx = args.get("--tx")!, out = resolve(args.get("--out")!);
  assert(ethers.isHexString(tx, 32)); assert(!existsSync(out));
  const expected = ethers.getAddress(args.get("--expect-pool")!).toLowerCase();
  const executor = ethers.getAddress(args.get("--executor")!).toLowerCase(), owner = ethers.getAddress(args.get("--owner")!).toLowerCase();
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  Object.assign(process.env, { SEARCHER_DRY_RUN: "1", SEARCHER_BLOCKSCAN_SUBMIT: "0", SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE: "1",
    MAINNET_RPC_URL: rpcUrl, SEARCHER_REVM_SIM_BIN: args.get("--revm-bin")!, BOTVM_ADDRESS: executor, BOTVM_OWNER: owner });
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  const wiring = createRebuildWiring({ rpcUrl, familyIds, executionIdentity: { executor, transactionOrigin: owner } });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const redact = (value: string) => value.split(rpcUrl).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name),
    JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : typeof v === "string" ? redact(v) : v, 2) + "\n", { flag: "wx", mode: 0o600 });
  // Test-process-only observation around the unchanged production client. The
  // real issuer still owns requests, scheduling, execution and validation.
  const originalStrictSimulate = RevmSimClient.prototype.strictSimulate;
  let simulationIndex = 0;
  RevmSimClient.prototype.strictSimulate = async function (request, control) {
    const name = `strict-${String(++simulationIndex).padStart(3, "0")}.json`;
    const publicRequest = { ...request, rpcUrl: "[REDACTED]" };
    let response: Awaited<ReturnType<typeof originalStrictSimulate>>;
    try { response = await originalStrictSimulate.call(this, request, control); }
    catch (error) {
      save(name, { request: publicRequest, error: String(error instanceof Error ? error.message : error) });
      throw error;
    }
    save(name, { request: publicRequest, response });
    return response;
  };
  let stage = "receipt";
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [tx]);
    assert(receipt && receipt.transactionHash.toLowerCase() === tx.toLowerCase() && BigInt(receipt.status) === 1n);
    const block = Number(BigInt(receipt.blockNumber)), header = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash); save("receipt.json", receipt); save("header.json", header);
    assert(receipt.logs.some((l: any) => l.address.toLowerCase() === expected &&
      [SWAP_TOPIC, UINT_SWAP_TOPIC, UINT_NG_SWAP_TOPIC].includes(l.topics[0])), "target has no real Curve swap in TX");
    save("executor-runtime-code.json", loadBotVmRuntimeCode(owner));
    stage = "production-single-block-ready";
    const checkpoint = resolve(out, "ready.json");
    const reusePath = args.has("--reuse-ready") ? resolve(args.get("--reuse-ready")!) : null;
    let familyUpdateScope;
    let reuseBytes: Buffer | null = null;
    if (reusePath) {
      reuseBytes = copyReadySnapshot(reusePath, checkpoint);
      familyUpdateScope = readyReuseScope(await new UniverseRebuildCheckpointStore({ path: checkpoint }).load(), block, header.hash, familyIds);
      save("reused-ready.json", { path: reusePath,
        sha256: createHash("sha256").update(reuseBytes).digest("hex"), ...familyUpdateScope });
    }
    const ready = await rebuildUniverse({ ...wiring, store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `curve-historical-single-${block}`, observationRange: { fromBlock: block, toBlock: block },
      ...(familyUpdateScope ? { familyUpdateScope } : {}),
      attestationConcurrency: 1, log: message => console.log(message) });
    assert.equal(ready.cutoff.number, block); assert.equal(ready.cutoff.hash, header.hash);
    if (reusePath) assert(readFileSync(reusePath).equals(reuseBytes!), "original Ready changed");
    const { graph } = resolveStrictReadyRuntime(ready), targetEdges = graph.filter(edge => edge.target.toLowerCase() === expected);
    save("ready-summary.json", { tx, block, blockHash: header.hash, graphHash: ready.graphHash, totalEdges: graph.length,
      targetEdges, instances: ready.activeInstanceKeys, familyIds, broadcast: false,
      claim: "natural single-block strict/Graph; not opportunity or representative performance acceptance" });
    assert(targetEdges.length > 0, "target has no naturally admitted direction");
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(block), "--through", "prices", "--execution-mode", "source-block",
      "--out", resolve(out, "prices"), "--executor", executor, "--owner", owner, "--revm-bin", args.get("--revm-bin")!,
      "--executor-runtime-code", resolve(out, "executor-runtime-code.json")]);
  } catch (error) {
    const message = redact(String(error instanceof Error ? error.message : error));
    save("failure.json", { stage, message }); console.error(JSON.stringify({ stage, message })); process.exitCode = 1;
  } finally { RevmSimClient.prototype.strictSimulate = originalStrictSimulate; provider.destroy(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Curve historical-ready invalid input; no input files overwritten"); process.exitCode = 1; });
}
