// Thin Family-scoped production Ready/price caller. TX identifies N only;
// expected instances are checked AFTER natural discovery, never inserted.
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { runAtBlock } from "../../../../blockscan-at-block-cli.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { ERC4626_SILO_REDEEM_FAMILY_ID } from "../manifest.js";
const WITHDRAW_TOPIC = ethers.id("Withdraw(address,address,address,uint256,uint256)");

async function main() {
  const args = new Map<string, string>();
  const required = ["--tx", "--rpc-file", "--out", "--executor", "--owner", "--revm-bin", "--expect-vault"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert([...required, "--reuse-ready"].includes(key) && !args.has(key) && value && !value.startsWith("--"));
    args.set(key, value);
  }
  assert(required.every(key => args.has(key)));
  const tx = args.get("--tx")!, out = resolve(args.get("--out")!);
  assert(ethers.isHexString(tx, 32)); assert(!existsSync(out));
  const expected = ethers.getAddress(args.get("--expect-vault")!).toLowerCase();
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
  const wiring = createRebuildWiring({ rpcUrl, familyIds: [ERC4626_SILO_REDEEM_FAMILY_ID],
    executionIdentity: { executor, transactionOrigin: owner } });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name),
    JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n", { flag: "wx", mode: 0o600 });
  let stage = "receipt";
  let reusePath: string | undefined, reuseBytes: Buffer | undefined;
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [tx]);
    assert(receipt && receipt.transactionHash.toLowerCase() === tx.toLowerCase() && BigInt(receipt.status) === 1n);
    const block = Number(BigInt(receipt.blockNumber));
    const header = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash);
    assert(receipt.logs.some((log: any) => log.address.toLowerCase() === expected && log.topics[0]?.toLowerCase() === WITHDRAW_TOPIC));
    save("receipt.json", receipt); save("header.json", header);
    const checkpoint = resolve(out, "ready.json");
    let familyUpdateScope;
    if (args.has("--reuse-ready")) {
      const original = resolve(args.get("--reuse-ready")!);
      assert(!existsSync(original + ".lock") && !existsSync(original + ".attestation-journal"), "original Ready is active");
      reusePath = original; reuseBytes = readFileSync(original);
      const prior = await new UniverseRebuildCheckpointStore({ path: original }).load();
      assert(prior?.readyGeneration && prior.inProgressRun === null);
      assert.equal(prior.readyGeneration.cutoff.number, block); assert.equal(prior.readyGeneration.cutoff.hash, header.hash);
      assert.deepEqual(prior.readyGeneration.universeRange, { fromBlock: block, toBlock: block });
      assert.equal(prior.readyGeneration.observationScope, undefined);
      if (prior.readyGeneration.familyPartitions !== undefined) {
        assert(prior.readyGeneration.familyPartitions[ERC4626_SILO_REDEEM_FAMILY_ID], "target family partition missing");
        familyUpdateScope = { parentCheckpointFingerprint: prior.checkpointFingerprint, familyIds: [ERC4626_SILO_REDEEM_FAMILY_ID] };
      } else {
        // Older authenticated checkpoints have no partitions. The production
        // ordinary rebuild still filters retained candidates by this Family's
        // wiring; never manufacture a partition to satisfy the scoped updater.
        assert(Object.values(prior.verifiedMemos).some(m => m.familyId === ERC4626_SILO_REDEEM_FAMILY_ID));
      }
      copyFileSync(original, checkpoint, constants.COPYFILE_EXCL);
      assert(readFileSync(checkpoint).equals(reuseBytes) && readFileSync(original).equals(reuseBytes));
      save("reused-ready.json", { original, sha256: createHash("sha256").update(reuseBytes).digest("hex"),
        ...familyUpdateScope, legacyUnpartitioned: familyUpdateScope === undefined,
        policy: "byte-identical copy then production target-Family revalidation; original untouched" });
    }
    stage = "production-single-block-ready";
    const ready = await rebuildUniverse({ ...wiring, store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `silo-single-${block}`, observationRange: { fromBlock: block, toBlock: block },
      ...(familyUpdateScope ? { familyUpdateScope } : {}),
      attestationConcurrency: 1, log: message => console.log(message) });
    assert.equal(ready.cutoff.number, block); assert.equal(ready.cutoff.hash, header.hash);
    const { graph } = resolveStrictReadyRuntime(ready);
    const targetEdges = graph.filter(edge => edge.target.toLowerCase() === expected);
    save("ready-summary.json", { tx, block, blockHash: header.hash, graphHash: ready.graphHash,
      instances: ready.activeInstanceKeys, totalEdges: graph.length, targetEdges, attestationConcurrency: 1,
      broadcast: false, claim: "preserved natural single-block Ready plus current production revalidation; not fresh-from-zero discovery, opportunity or performance acceptance" });
    assert.equal(targetEdges.length, 1, "synchronous redeem edge must be naturally admitted");
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(block), "--through", "prices",
      "--execution-mode", "source-block", "--out", resolve(out, "prices"), "--executor", executor,
      "--owner", owner, "--revm-bin", args.get("--revm-bin")!]);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).split(rpcUrl).join("[REDACTED]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message }); console.error(JSON.stringify({ stage, message })); process.exitCode = 1;
  } finally {
    if (reusePath && reuseBytes) {
      assert(!existsSync(reusePath + ".lock") && !existsSync(reusePath + ".attestation-journal"));
      assert(readFileSync(reusePath).equals(reuseBytes), "original Ready changed");
    }
    provider.destroy();
  }
}
main().catch(() => { console.error("Silo historical-ready invalid input; existing files untouched"); process.exitCode = 1; });
