// Opt-in single-block integration for the KyberSwap Elastic family:
// production discovery / strict / Graph / prices only. No pool seeds, no forced
// admission, no execution submission, no opportunity search.
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore } from
  "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { runAtBlock } from "../../../../blockscan-at-block-cli.js";
import { plugin } from
  "../../../production-families/kyberswap-elastic.production.js";

const FAMILY_ID = String(plugin.manifest.familyId);

async function main() {
  const args = new Map<string, string>();
  const names = ["--tx", "--rpc-file", "--out", "--executor", "--owner", "--revm-bin"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert((names.includes(key) || key === "--reuse-ready") && !args.has(key) && value && !value.startsWith("--"));
    args.set(key, value);
  }
  assert(names.every(name => args.has(name)));
  const tx = args.get("--tx")!, out = resolve(args.get("--out")!);
  assert(ethers.isHexString(tx, 32));
  assert(!existsSync(out));
  const executor = ethers.getAddress(args.get("--executor")!).toLowerCase();
  const owner = ethers.getAddress(args.get("--owner")!).toLowerCase();
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  process.env.SEARCHER_DRY_RUN = "1";
  process.env.MAINNET_RPC_URL = rpcUrl;
  process.env.SEARCHER_REVM_SIM_BIN = args.get("--revm-bin")!;
  process.env.BOTVM_ADDRESS = executor;
  process.env.BOTVM_OWNER = owner;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  // Family-scoped production wiring: the scan uses this family's own declared
  // log topics / call patterns, so the family discovers its pools from the
  // block's real logs and traces with no inventory seed and no hand-inserted pool.
  const wiring = createRebuildWiring({
    rpcUrl,
    familyIds: [FAMILY_ID],
    executionIdentity: { executor, transactionOrigin: owner },
  });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(
    resolve(out, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 },
  );
  let stage = "receipt";
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [tx]);
    assert(receipt && receipt.transactionHash.toLowerCase() === tx.toLowerCase() &&
      BigInt(receipt.status) === 1n);
    const block = Number(BigInt(receipt.blockNumber));
    const header = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash);
    save("receipt.json", receipt);
    save("header.json", header);
    const checkpoint = resolve(out, "ready.json");
    // Revalidate a byte-for-byte copy through the production scoped updater.
    // Never manufacture admission/hash fields or mutate the original Ready.
    const reusePath = args.has("--reuse-ready") ? resolve(args.get("--reuse-ready")!) : null;
    let familyUpdateScope;
    let reuseBytes: Buffer | null = null;
    if (reusePath) {
      reuseBytes = readFileSync(reusePath);
      const prior = await new UniverseRebuildCheckpointStore({ path: reusePath }).load();
      assert(prior?.readyGeneration && prior.inProgressRun === null);
      assert.equal(prior.readyGeneration.cutoff.number, block);
      assert.equal(prior.readyGeneration.cutoff.hash, header.hash);
      assert.deepEqual(prior.readyGeneration.universeRange, { fromBlock: block, toBlock: block });
      assert.deepEqual(Object.keys(prior.readyGeneration.familyPartitions ?? {}), [FAMILY_ID]);
      assert.equal(prior.readyGeneration.observationScope, undefined);
      copyFileSync(reusePath, checkpoint, constants.COPYFILE_EXCL);
      assert(readFileSync(checkpoint).equals(reuseBytes));
      familyUpdateScope = { parentCheckpointFingerprint: prior.checkpointFingerprint, familyIds: [FAMILY_ID] };
      save("reused-ready.json", { path: reusePath,
        sha256: createHash("sha256").update(reuseBytes).digest("hex"), ...familyUpdateScope });
    }
    stage = "production-single-block-ready";
    const ready = await rebuildUniverse({
      ...wiring,
      store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `kyberswap-elastic-single-${block}`,
      observationRange: { fromBlock: block, toBlock: block },
      ...(familyUpdateScope ? { familyUpdateScope } : {}),
      attestationConcurrency: 4,
      log: (message) => console.log(message),
    });
    assert.equal(ready.cutoff.number, block);
    assert.equal(ready.cutoff.hash, header.hash);
    if (reusePath) assert(readFileSync(reusePath).equals(reuseBytes!), "original Ready changed");
    save("ready-summary.json", {
      family: FAMILY_ID, tx, block, blockHash: header.hash, graphHash: ready.graphHash,
      instances: ready.activeInstanceKeys, attestationConcurrency: 4, broadcast: false,
    });
    stage = "production-prices";
    await runAtBlock([
      "--ready", checkpoint, "--block", String(block), "--through", "prices",
      "--execution-mode", "source-block", "--out", resolve(out, "prices"),
      "--executor", executor, "--owner", owner, "--revm-bin", args.get("--revm-bin")!,
    ]);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
      .split(rpcUrl).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message });
    console.error(JSON.stringify({ stage, message }));
    process.exitCode = 1;
  } finally {
    provider.destroy();
  }
}
main().catch(() => {
  console.error("kyberswap historical-ready invalid input; no input files overwritten");
  process.exitCode = 1;
});
