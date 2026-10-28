// Thin same-N production caller: no candidate injection, alternate pricing or search.
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { activeReadyMemos, UniverseRebuildCheckpointStore } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";
import { runAtBlock } from "../../../../blockscan-at-block-cli.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { ETHERTOKEN_NATIVE_FAMILY_ID } from "../manifest.js";

export const SAMPLE = {
  tx: "0xdf54ad38d4b812c4ab23ba6225543caaa433897f9454414c70bf7fda1290694e",
  block: 25648967,
  hash: "0x65058fd339c9dbdabc378620f354a7e48b2dfae2df896536c985885f66085c1d",
  token: "0xc0829421c1d260bd3cb3e0f06cfe2d52db2ce315",
  amount: 1056367846106427n,
} as const;

export function assertOriginalReceipt(receipt: any): void {
  assert(receipt && receipt.transactionHash.toLowerCase() === SAMPLE.tx && BigInt(receipt.status) === 1n);
  assert.equal(Number(BigInt(receipt.blockNumber)), SAMPLE.block);
  assert.equal(receipt.blockHash.toLowerCase(), SAMPLE.hash);
  // This deployed EtherToken emits Destruction(uint256), without an account topic.
  const events = new ethers.Interface(["event Destruction(uint256 amount)"]);
  const burns = receipt.logs.filter((log: any) => log.address.toLowerCase() === SAMPLE.token &&
    log.topics[0]?.toLowerCase() === events.getEvent("Destruction")!.topicHash)
    .map((log: any) => {
      assert.equal(log.topics.length, 1);
      assert.equal(log.blockHash.toLowerCase(), SAMPLE.hash);
      assert.equal(log.transactionHash.toLowerCase(), SAMPLE.tx);
      assert.equal(Number(BigInt(log.blockNumber)), SAMPLE.block);
      assert.equal(log.removed, false);
      return events.decodeEventLog("Destruction", log.data, log.topics);
    });
  assert(burns.some((burn: any) => BigInt(burn.amount) === SAMPLE.amount), "real receipt must bind the original burned amount");
}

export function selectTargetEdges(graph: ReturnType<typeof resolveStrictReadyRuntime>["graph"]) {
  return graph.filter(edge => edge.canonicalEdgeId?.startsWith(String(ETHERTOKEN_NATIVE_FAMILY_ID) + "\u001f") &&
    edge.instanceKey === SAMPLE.token && edge.tokenIn.toLowerCase() === SAMPLE.token);
}

export function assertSourceCoverage(coverage: readonly {
  familyId: string; sourceId: string; completeThroughBlock: number; completeThroughHash: string | null;
  observationScope?: unknown;
}[], required: readonly string[]): void {
  const keys = coverage.map(row => row.familyId + "|" + row.sourceId);
  assert(required.length > 0 && new Set(keys).size === keys.length && new Set(required).size === required.length);
  assert.deepEqual([...keys].sort(), [...required].sort(), "saved Ready scan scope differs from this production wiring");
  for (const row of coverage) {
    assert.equal(row.observationScope, undefined, "coverage must describe the full block, not selected TXs");
    assert.equal(row.completeThroughBlock, SAMPLE.block);
    assert(typeof row.completeThroughHash === "string", "unbound source coverage hash");
    assert.equal(row.completeThroughHash.toLowerCase(), SAMPLE.hash);
  }
}

async function main() {
  const args = new Map<string, string>();
  const names = ["--rpc-file", "--out", "--executor", "--owner", "--revm-bin"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert([...names, "--reuse-ready"].includes(key) && !args.has(key) && value && !value.startsWith("--"));
    args.set(key, value);
  }
  assert(names.every(key => args.has(key)));
  const out = resolve(args.get("--out")!); assert(!existsSync(out));
  const executor = ethers.getAddress(args.get("--executor")!).toLowerCase();
  const owner = ethers.getAddress(args.get("--owner")!).toLowerCase();
  assert.notEqual(owner, executor);
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  process.env.SEARCHER_DRY_RUN = "1";
  process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0";
  process.env.MAINNET_RPC_URL = rpcUrl;
  process.env.SEARCHER_REVM_SIM_BIN = args.get("--revm-bin")!;
  process.env.BOTVM_ADDRESS = executor; process.env.BOTVM_OWNER = owner;
  // Valuation scope uses the original public route's protocol types, not pools.
  const families = [String(ETHERTOKEN_NATIVE_FAMILY_ID), "protocol:astra-multitoken", "univ2-standard"];
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  const wiring = createRebuildWiring({ rpcUrl, familyIds: families,
    executionIdentity: { executor, transactionOrigin: owner } });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name),
    JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n", { flag: "wx", mode: 0o600 });
  let stage = "receipt";
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [SAMPLE.tx]);
    save("receipt.json", receipt);
    assertOriginalReceipt(receipt);
    const header = await provider.send("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash, receipt.blockHash);
    save("header.json", header);
    const checkpoint = resolve(out, "ready.json");
    stage = "production-single-block-ready";
    let ready;
    if (args.has("--reuse-ready")) {
      stage = "saved-ready-validation";
      const original = resolve(args.get("--reuse-ready")!);
      const digest = () => createHash("sha256").update(readFileSync(original)).digest("hex");
      const originalSha256 = digest();
      const prior = await new UniverseRebuildCheckpointStore({ path: original }).load();
      assert(prior?.readyGeneration && prior.inProgressRun === null);
      assert.deepEqual(prior.readyGeneration.universeRange, { fromBlock: SAMPLE.block, toBlock: SAMPLE.block });
      assert.equal(prior.readyGeneration.observationScope, undefined, "TX selection is not a full single block");
      assertSourceCoverage(prior.readyGeneration.sourceCoverage, wiring.requiredSourceCoverageKeys());
      assert(wiring.familyDiscoveryDefinitionHash, "current discovery definition validator required");
      for (const id of families) {
        const partition: { readonly discoveryDefinitionHash: string } | undefined = prior.readyGeneration.familyPartitions?.[id];
        assert(partition, "saved Ready must contain every declared Family partition");
        assert.equal(partition.discoveryDefinitionHash, wiring.familyDiscoveryDefinitionHash(id), "stale discovery definition");
      }
      const memos = activeReadyMemos(prior);
      assert(memos.length > 0 && memos.every(m => families.includes(m.familyId) && wiring.isReadyMemoDefinitionCurrent?.(m)),
        "saved Ready must be in scope and current; stale evidence requires normal selective revalidation");
      assert.equal(prior.readyGeneration.cutoff.number, SAMPLE.block);
      assert.equal(prior.readyGeneration.cutoff.hash, header.hash);
      resolveStrictReadyRuntime(prior.readyGeneration);
      copyFileSync(original, checkpoint, constants.COPYFILE_EXCL);
      assert.equal(digest(), originalSha256);
      assert.equal(createHash("sha256").update(readFileSync(checkpoint)).digest("hex"), originalSha256);
      save("reused-ready.json", { original, originalSha256, policy: "read-only reuse of current same-N admission; no retry or graph mutation" });
      ready = prior.readyGeneration;
    } else {
      ready = await rebuildUniverse({ ...wiring, store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
        runId: `ethertoken-single-${SAMPLE.block}`, observationRange: { fromBlock: SAMPLE.block, toBlock: SAMPLE.block },
        attestationConcurrency: 1, log: message => console.log(message) });
    }
    assert.equal(ready.cutoff.number, SAMPLE.block); assert.equal(ready.cutoff.hash, header.hash);
    const { graph } = resolveStrictReadyRuntime(ready);
    const targetEdges = selectTargetEdges(graph);
    save("ready-summary.json", { family: ETHERTOKEN_NATIVE_FAMILY_ID, families, tx: SAMPLE.tx,
      block: SAMPLE.block, blockHash: header.hash, graphHash: ready.graphHash, instances: ready.activeInstanceKeys,
      totalEdges: graph.length, targetEdges, attestationConcurrency: 1, broadcast: false,
      claim: "natural single-block strict/Graph only; not original pre-call, full opportunity or latency acceptance" });
    assert.equal(targetEdges.length, 1, "native redemption must first be naturally admitted");
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(SAMPLE.block), "--through", "prices",
      "--execution-mode", "source-block", "--out", resolve(out, "prices"), "--executor", executor,
      "--owner", owner, "--revm-bin", args.get("--revm-bin")!]);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).split(rpcUrl).join("[REDACTED]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message }); console.error(JSON.stringify({ stage, message })); process.exitCode = 1;
  } finally { provider.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("EtherToken historical-ready invalid input; existing files untouched"); process.exitCode = 1; });
