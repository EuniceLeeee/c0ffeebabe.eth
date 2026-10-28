// Opt-in single-block integration for the xWin family:
// production discovery / strict / Graph only. No pool seeds, no forced
// admission, no execution submission, no opportunity search.
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { UniverseRebuildCheckpointStore, type StartupCheckpointEnvelope } from
  "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from
  "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from
  "../../../../universe-rebuild-runner.js";
const SAMPLE = { family: "protocol:token-conversion", tx: "0x10b7f1d5ac14281c916b4f94bd8c781c2795bfdd7d1a527885e83f4f22ec9ae3", number: 26075823, hash: "0x4256c70c1fba6d441343680f94d07e2a1034dddb5628bb11858b9157490b501c" };

/** Called only after the production checkpoint reader authenticates the file. */
export function readyReuseScope(prior: StartupCheckpointEnvelope | null, block: number, hash: string, family: string) {
  assert(prior?.readyGeneration && prior.inProgressRun === null);
  assert.equal(prior.readyGeneration.cutoff.number, block);
  assert.equal(prior.readyGeneration.cutoff.hash, hash);
  assert.deepEqual(prior.readyGeneration.universeRange, { fromBlock: block, toBlock: block });
  const partitions=prior.readyGeneration.familyPartitions;
  if(partitions!==undefined)assert(Object.keys(partitions).includes(family));
  assert.equal(prior.readyGeneration.observationScope, undefined);
  return partitions===undefined?undefined:{ parentCheckpointFingerprint: prior.checkpointFingerprint, familyIds: [family] };
}

async function main() {
  const args = new Map<string, string>();
  const names = ["--sample", "--tx", "--rpc-file", "--rpc-env", "--out", "--executor", "--owner", "--revm-bin", "--executor-program", "--reuse-ready"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert(names.includes(key) && !args.has(key) && value && !value.startsWith("--"));
    args.set(key, value);
  }
  for (const name of ["--sample", "--tx", "--out", "--executor", "--owner", "--revm-bin"]) assert(args.has(name));
  assert(args.has("--rpc-file") !== args.has("--rpc-env"));
  if (args.has("--rpc-env")) assert.equal(args.get("--rpc-env"), "MAINNET_RPC_URL");
  const executorProgram = args.get("--executor-program") === "1";
  if (args.has("--executor-program")) assert(["0", "1"].includes(args.get("--executor-program")!));
  assert.equal(args.get("--sample"), "xwin"); const sample=SAMPLE,FAMILY=sample.family;
  assert.equal(args.get("--tx"),sample.tx);
  const tx = args.get("--tx")!, out = resolve(args.get("--out")!);
  assert(ethers.isHexString(tx, 32));
  assert(!existsSync(out));
  const executor = ethers.getAddress(args.get("--executor")!).toLowerCase();
  const owner = ethers.getAddress(args.get("--owner")!).toLowerCase();
  const rpcUrl = args.has("--rpc-file") ? JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL : process.env.MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  process.env.SEARCHER_DRY_RUN = "1";
  process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0";
  process.env.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE = executorProgram ? "1" : "0";
  process.env.MAINNET_RPC_URL = rpcUrl;
  process.env.SEARCHER_REVM_SIM_BIN = args.get("--revm-bin")!;
  process.env.BOTVM_ADDRESS = executor;
  process.env.BOTVM_OWNER = owner;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  // Family-scoped production wiring: the scan uses this family's own declared
  // log topics / call patterns, so a brand-new family discovers its instances
  // from the block's real logs and traces with no inventory seed and no
  // hand-inserted pool.
  const wiring = createRebuildWiring({
    rpcUrl,
    familyIds: [FAMILY],
    executionIdentity: { executor, transactionOrigin: owner },
  });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(
    resolve(out, name),
    JSON.stringify(value, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  let stage = "receipt";
  try {
    if (executorProgram) save("executor-runtime-code.json", loadBotVmRuntimeCode(owner));
    const receipt = await provider.send("eth_getTransactionReceipt", [tx]);
    assert(
      receipt && receipt.transactionHash.toLowerCase() === tx.toLowerCase() &&
        BigInt(receipt.status) === 1n,
    );
    const block = Number(BigInt(receipt.blockNumber));assert.equal(block,sample.number);assert.equal(receipt.blockHash,sample.hash);
    const header = await provider.send("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    assert.equal(header.hash, receipt.blockHash);
    save("receipt.json", receipt);
    save("header.json", header);
    const checkpoint = resolve(out, "ready.json");
    // Keep the original immutable; the production scoped updater decides what
    // must be rediscovered or reattested. No hand-edited memo/hash/graph fields.
    const reusePath = args.has("--reuse-ready") ? resolve(args.get("--reuse-ready")!) : null;
    let familyUpdateScope;
    let reuseBytes: Buffer | null = null;
    if (reusePath) {
      assert(!existsSync(reusePath + ".lock") && !existsSync(reusePath + ".attestation-journal"), "source Ready is active");
      reuseBytes = readFileSync(reusePath);
      familyUpdateScope = readyReuseScope(await new UniverseRebuildCheckpointStore({ path: reusePath }).load(), block, header.hash,FAMILY);
      copyFileSync(reusePath, checkpoint, constants.COPYFILE_EXCL);
      assert(readFileSync(checkpoint).equals(reuseBytes) && readFileSync(reusePath).equals(reuseBytes), "source Ready changed while copying");
      assert(!existsSync(reusePath + ".lock") && !existsSync(reusePath + ".attestation-journal"), "source Ready became active");
      save("reused-ready.json", { path: reusePath,
        sha256: createHash("sha256").update(reuseBytes).digest("hex"), ...familyUpdateScope, mode:familyUpdateScope?"production-scoped-revalidation":"legacy-checkpoint-production-family-rebuild" });
    }
    stage = "production-single-block-ready";
    const ready = await rebuildUniverse({
      ...wiring,
      store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `xwin-current-single-${block}`,
      observationRange: { fromBlock: block, toBlock: block },
      ...(familyUpdateScope ? { familyUpdateScope } : {}),
      attestationConcurrency: 1,
      log: (message) => console.log(message),
    });
    assert.equal(ready.cutoff.number, block);
    assert.equal(ready.cutoff.hash, header.hash);
    if (reusePath) assert(readFileSync(reusePath).equals(reuseBytes!), "original Ready changed");
    save("ready-summary.json", {
      tx,
      block,
      blockHash: header.hash,
      graphHash: ready.graphHash,
      instances: ready.activeInstanceKeys,
      attestationConcurrency: 1,
      broadcast: false,
    });
    save("scope.json", { kind: familyUpdateScope?"current-production-selective-revalidation":"current-production-family-rebuild", prices: "not run; historical CLI borrows original same-N natural price amountIn only; no new prices calculated" });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
      .split(rpcUrl).join("[REDACTED]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message });
    console.error(JSON.stringify({ stage, message }));
    process.exitCode = 1;
  } finally {
    provider.destroy();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error("xWin historical-ready invalid input; no input files overwritten");
  process.exitCode = 1;
});
