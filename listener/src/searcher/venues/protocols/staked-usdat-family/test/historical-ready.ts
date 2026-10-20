// Family acceptance at the landed transaction's block end. The sample is
// checked after production discovery; it is never inserted into admission.
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
import { ERC4626_FAMILY_ID } from "../../erc4626-family/manifest.js";
import { ERC4626_INTERFACE } from "../../erc4626-family/abi.js";
import { STAKED_USDAT_FAMILY_ID } from "../manifest.js";

const TX = "0x63fb77b723f3bd7fd4d9539ef1e1e248cb5499153dbfc225e8b24ae1522ec6e7";
const TARGET = "0xd166337499e176bbc38a1fbd113ab144e5bd2df7";
const N = 25462190;
const HASH = "0x3b02e4d1911cefa4a6e5cef387db42da16821da9d48196421156ae63ab1bac13";

async function main() {
  const required = ["--rpc-file", "--revm-bin", "--out", "--prior-ready"];
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    assert([...required, "--from-block", "--to-block", "--executor", "--owner"].includes(process.argv[i]!) &&
      !args.has(process.argv[i]!) && process.argv[i + 1]);
    args.set(process.argv[i]!, process.argv[i + 1]!);
  }
  assert(required.every(key => args.has(key)));
  const fromBlock = Number(args.get("--from-block") ?? N), toBlock = Number(args.get("--to-block") ?? N);
  assert.equal(fromBlock, N); assert.equal(toBlock, N);
  const out = resolve(args.get("--out")!); assert(!existsSync(out));
  const executor = ethers.getAddress(args.get("--executor") ?? "0x1000000000000000000000000000000000000002");
  const owner = ethers.getAddress(args.get("--owner") ?? "0x1000000000000000000000000000000000000001");
  const priorPath = realpathSync(args.get("--prior-ready")!), priorBytes = readFileSync(priorPath);
  assert(!existsSync(priorPath + ".lock") && !existsSync(priorPath + ".attestation-journal"));
  const prior = await new UniverseRebuildCheckpointStore({ path: priorPath }).load();
  assert(prior?.readyGeneration && prior.inProgressRun === null);
  assert.equal(prior.readyGeneration.cutoff.number, N); assert.equal(prior.readyGeneration.cutoff.hash, HASH);
  const oldMemos = activeReadyMemos(prior).filter(m => m.familyId === ERC4626_FAMILY_ID && same(m.instanceKey, TARGET));
  assert.equal(oldMemos.length, 1, "prior Ready supplies real discovery provenance only");
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  process.env.SEARCHER_DRY_RUN = "1"; process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0";
  process.env.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE = "1";
  process.env.MAINNET_RPC_URL = rpcUrl; process.env.SEARCHER_REVM_SIM_BIN = args.get("--revm-bin")!;
  process.env.BOTVM_ADDRESS = executor; process.env.BOTVM_OWNER = owner;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(resolve(out, name), json(value) + "\n", { flag: "wx", mode: 0o600 });
  let stage = "receipt";
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [TX]);
    assert(receipt && same(receipt.transactionHash, TX) && BigInt(receipt.status) === 1n);
    assert.equal(Number(BigInt(receipt.blockNumber)), N); assert.equal(receipt.blockHash, HASH);
    const events = receipt.logs.filter((log: any) => same(log.address, TARGET) && Number(BigInt(log.logIndex)) === 234);
    assert.equal(events.length, 1); const event = ERC4626_INTERFACE.parseLog(events[0]);
    assert(event?.name === "Deposit"); assert.equal(event.args.assets, 1012540431n);
    const header = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(N), false]);
    assert.equal(header.hash, HASH); save("receipt.json", receipt); save("header.json", header);
    const familyIds = [ERC4626_FAMILY_ID, STAKED_USDAT_FAMILY_ID];
    const wiring = createRebuildWiring({ rpcUrl, familyIds, executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent);
    const oldMemoDefinitionCurrent = wiring.isReadyMemoDefinitionCurrent(oldMemos[0]!);
    assert.equal(oldMemoDefinitionCurrent, false, "the pre-split ordinary memo must not authorize the new Family");
    save("input-provenance.json", { priorReady: priorPath, sha256: sha(priorBytes), source: prior.readyGeneration.cutoff,
      oldMemoFingerprint: oldMemos[0]!.memoFingerprint, oldMemoDefinitionCurrent, familyIds,
      discoveryMode: "fresh-production-single-block-discovery", preservedOriginal: true,
      scope: "Prior evidence remains immutable. Both current Families independently consume the same real block; no memo/descriptor/hash remapping." });
    stage = "production-single-block-ready";
    const checkpoint = resolve(out, "ready.json");
    const ready = await rebuildUniverse({ ...wiring, store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `staked-usdat-single-${N}`, observationRange: { fromBlock, toBlock }, attestationConcurrency: 1,
      log: message => console.log(message) });
    const published = await new UniverseRebuildCheckpointStore({ path: checkpoint }).load();
    assert(published && published.inProgressRun === null); assert.equal(ready.cutoff.number, N); assert.equal(ready.cutoff.hash, HASH);
    const { graph } = resolveStrictReadyRuntime(ready);
    const targetMemos = activeReadyMemos(published).filter(m => same(m.instanceKey, TARGET));
    assert.equal(targetMemos.length, 1); assert.equal(targetMemos[0]!.familyId, STAKED_USDAT_FAMILY_ID);
    assert.equal(wiring.isReadyMemoDefinitionCurrent(targetMemos[0]!), true);
    const targetEdges = graph.filter(edge => same(edge.target, TARGET));
    assert.equal(targetEdges.length, 1, "queued redemption must not become a synchronous graph edge");
    assert(same(targetEdges[0]!.tokenOut, TARGET));
    save("ready-summary.json", { tx: TX, source: ready.cutoff, range: ready.universeRange, graphHash: ready.graphHash,
      targetMemo: targetMemos[0], targetEdges, actors: { executor, owner }, signing: false, broadcast: false,
      scope: "Current new-ID natural strict/Graph and production prices; no opportunity or performance claim" });
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(N), "--through", "prices", "--execution-mode", "source-block",
      "--out", resolve(out, "prices"), "--executor", executor, "--owner", owner, "--revm-bin", args.get("--revm-bin")!]);
  } catch (error) {
    const message = String(error instanceof Error ? error.stack : error).split(rpcUrl).join("[REDACTED]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
    save("failure.json", { stage, message }); console.error(json({ stage, message })); process.exitCode = 1;
  } finally {
    provider.destroy(); assert(readFileSync(priorPath).equals(priorBytes), "original Ready changed");
    assert(!existsSync(priorPath + ".lock") && !existsSync(priorPath + ".attestation-journal"));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error("StakedUSDat historical Ready input/check failed; existing evidence preserved"); process.exitCode = 1;
});
