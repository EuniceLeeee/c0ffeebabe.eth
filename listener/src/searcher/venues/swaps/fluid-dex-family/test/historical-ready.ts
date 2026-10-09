// Thin historical caller: production discovery/strict/Graph, then source-block prices.
// Expected TX/pool are evidence assertions only, never discovery or admission inputs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const RPC_FILE = "/tmp/ds-rpc.json";
const HELP = `Usage: node --import tsx historical-ready.ts
  --tx HASH --block N --expect-pool ADDRESS --out NEW_DIRECTORY
  --executor ADDRESS --owner ADDRESS --revm-bin EXISTING_BINARY
  --check  Validate arguments only; no RPC/config reads, imports or output writes.
RPC comes only from /tmp/ds-rpc.json MAINNET_RPC_URL; no .env or private keys.
Runs Fluid-only natural from=N/to=N rebuild, then production source-block prices.
No target injection, activation override, signing, broadcast or performance verdict.
`;

export function parseHistoricalReadyArgs(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, allowPositionals: false, options: {
    tx: { type: "string" }, block: { type: "string" }, "expect-pool": { type: "string" },
    out: { type: "string" }, executor: { type: "string" }, owner: { type: "string" },
    "revm-bin": { type: "string" }, check: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (v.help) return null;
  assert(v.tx && /^0x[\da-fA-F]{64}$/.test(v.tx), "--tx must be a transaction hash");
  const block = Number(v.block);
  assert(v.block && /^\d+$/.test(v.block) && Number.isSafeInteger(block) && block > 0, "invalid --block");
  const address = (value: string | undefined, name: string) => {
    assert(value && /^0x[\da-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value), `invalid ${name}`);
    return value.toLowerCase();
  };
  assert(v.out && v["revm-bin"], "--out and --revm-bin are required");
  return { tx: v.tx.toLowerCase(), block, expected: address(v["expect-pool"], "--expect-pool"),
    executor: address(v.executor, "--executor"), owner: address(v.owner, "--owner"),
    out: resolve(v.out), revmBin: resolve(v["revm-bin"]), check: v.check === true };
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const redactUrls = (value: string) => value.replace(/(?:https?|wss?):\/\/[^\s"'<>`]+/g, "[REDACTED_URL]");

function sourceFingerprint(revmBin: string) {
  const family = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = resolve(family, "../../../../../..");
  const paths = [
    "listener/src/searcher/universe-rebuild-production.ts",
    "listener/src/searcher/universe-rebuild-runner.ts",
    "listener/src/searcher/universe-rebuild-checkpoint.ts",
    "listener/src/searcher/strict-ready-runtime.ts",
    "listener/src/searcher/strict-production-family-declarations.ts",
    "listener/src/searcher/blockscan-at-block-cli.ts",
    "listener/src/searcher/blockscan-runtime-loop.ts",
    "listener/src/searcher/main.ts",
    "listener/src/searcher/revm-sim-client.ts",
    "listener/src/searcher/identity-asset-metadata.ts",
    "listener/src/searcher/execution-asset-boundary.ts",
    "listener/src/searcher/revm-strict-simulation-transport.ts",
    "listener/src/searcher/reth-adapter-work-runtime.ts",
    "listener/src/searcher/venues/adapter-family-runtime.ts",
    "listener/src/searcher/venues/adapter-family-plugin.ts",
    "listener/src/searcher/venues/adapter-request-program.ts",
    "listener/src/searcher/venues/runtime-execution.ts",
    "listener/src/searcher/venues/production-family-composition.ts",
    "listener/src/searcher/venues/production-families/fluid-dex.production.ts",
    "listener/src/searcher/generated/production-family-entries.generated.ts",
    "listener/src/searcher/generated/family-capability-shadow.generated.json",
    "listener/src/shared/executor/botvm-executor.ts",
    "out/BotVM.sol/BotVM.json",
  ];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) paths.push(relative(root, path));
    }
  };
  visit(family);
  const files = paths.sort().map(path => ({ path, sha256: sha256(readFileSync(resolve(root, path))) }));
  const git = (...args: string[]) => execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { root, head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    scope: "Fluid source/test tree and named production entrypoints/boundaries, not a complete import closure",
    dirty: git("status", "--short", "--untracked-files=all", "--", ...paths),
    files, filesSha256: sha256(JSON.stringify(files)), revmBinarySha256: sha256(readFileSync(revmBin)) };
}

async function main() {
  const args = parseHistoricalReadyArgs(process.argv.slice(2));
  if (!args) { console.log(HELP); return; }
  if (args.check) { console.log("Fluid historical-ready arguments valid; no RPC/config read or output written"); return; }
  assert(!existsSync(args.out), "--out must be new; existing evidence is never overwritten");
  mkdirSync(args.out, { recursive: true, mode: 0o700 });
  let rpcUrl = "", stage = "source-fingerprint", completed = false;
  const redact = (value: string) => redactUrls(rpcUrl ? value.split(rpcUrl).join("[REDACTED_RPC]") : value);
  const save = (name: string, value: unknown) => writeFileSync(resolve(args.out, name),
    JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "string") return redact(v);
      if (v instanceof Error) return Object.fromEntries(Object.getOwnPropertyNames(v).map(key => [key, (v as any)[key]]));
      return v;
    }, 2) + "\n", { flag: "wx", mode: 0o600 });
  let before: ReturnType<typeof sourceFingerprint> | undefined;
  let provider: import("ethers").JsonRpcProvider | undefined;
  let restoreStrict: (() => void) | undefined;
  try {
    save("input.json", { ...args, rpcConfiguration: RPC_FILE, executionMode: "source-block", broadcast: false,
      claim: "single-block Fluid diagnostic only; no historical dual-execution or performance acceptance" });
    before = sourceFingerprint(args.revmBin); save("source-before.json", before);
    stage = "rpc-configuration";
    rpcUrl = JSON.parse(readFileSync(RPC_FILE, "utf8")).MAINNET_RPC_URL;
    assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl), "MAINNET_RPC_URL missing from approved JSON");
    Object.assign(process.env, { SEARCHER_TEST_DISABLE_DOTENV: "1", SEARCHER_DRY_RUN: "1",
      SEARCHER_BLOCKSCAN_SUBMIT: "0", SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE: "1",
      MAINNET_RPC_URL: rpcUrl, SEARCHER_LIVE_RPC_URL: rpcUrl, SEARCHER_REVM_SIM_BIN: args.revmBin,
      BOTVM_ADDRESS: args.executor, BOTVM_OWNER: args.owner });
    // Load production modules only for an explicit online run, after disabling .env loading.
    stage = "production-imports";
    const { ethers } = await import("ethers");
    const { loadBotVmRuntimeCode } = await import("../../../../../shared/executor/botvm-executor.js");
    const { UniverseRebuildCheckpointStore } = await import("../../../../universe-rebuild-checkpoint.js");
    const { createRebuildWiring } = await import("../../../../universe-rebuild-production.js");
    const { rebuildUniverse } = await import("../../../../universe-rebuild-runner.js");
    const { runAtBlock, parseAtBlockJson } = await import("../../../../blockscan-at-block-cli.js");
    const { resolveStrictReadyRuntime } = await import("../../../../strict-ready-runtime.js");
    const { RevmSimClient } = await import("../../../../revm-sim-client.js");
    const { FLUID_DEX_FAMILY_ID } = await import("../manifest.js");
    const { FLUID_DEX_SWAP_TOPIC } = await import("../codec.js");
    const request = new ethers.FetchRequest(rpcUrl); request.timeout = 30_000;
    provider = new ethers.JsonRpcProvider(request, 1, { staticNetwork: true, batchMaxCount: 1 });
    const read = async (name: string, method: string, params: unknown[]) => {
      try {
        const result = await provider!.send(method, params);
        save(name, { method, params, result }); return result;
      } catch (error) { save(name, { method, params, error }); throw error; }
    };
    // Observe the unchanged production client; do not alter scheduling, requests or results.
    const original = RevmSimClient.prototype.strictSimulate;
    let sequence = 0;
    RevmSimClient.prototype.strictSimulate = async function (input, control) {
      const name = `strict-${String(++sequence).padStart(3, "0")}`;
      save(`${name}-request.json`, input);
      try {
        const result = await original.call(this, input, control);
        save(`${name}-response.json`, result); return result;
      } catch (error) { save(`${name}-failure.json`, { error }); throw error; }
    };
    restoreStrict = () => { RevmSimClient.prototype.strictSimulate = original; };
    stage = "receipt";
    assert.equal(BigInt(await read("chain.json", "eth_chainId", [])), 1n, "wrong chain");
    const receipt = await read("receipt.json", "eth_getTransactionReceipt", [args.tx]);
    assert(receipt && receipt.transactionHash.toLowerCase() === args.tx && BigInt(receipt.status) === 1n,
      "missing, mismatched or unsuccessful receipt");
    const block = Number(BigInt(receipt.blockNumber));
    assert.equal(block, args.block, "receipt block differs from --block");
    const header = await read("header.json", "eth_getBlockByNumber", [ethers.toQuantity(block), false]);
    assert(header && ethers.isHexString(header.hash, 32) && ethers.isHexString(header.stateRoot, 32));
    assert.equal(Number(BigInt(header.number)), block);
    assert.equal(header.hash.toLowerCase(), receipt.blockHash.toLowerCase(), "receipt/header hash mismatch");
    assert.equal(header.transactions[Number(BigInt(receipt.transactionIndex))]?.toLowerCase(), args.tx,
      "receipt transaction index differs from header");
    save("source.json", { chainId: 1, number: block, hash: header.hash, stateRoot: header.stateRoot,
      timestamp: header.timestamp, transactionHash: args.tx, transactionIndex: receipt.transactionIndex,
      state: "N block-end; not original transaction call-prestate" });
    save("executor-runtime-code.json", loadBotVmRuntimeCode(args.owner));
    stage = "production-single-block-ready";
    const checkpoint = resolve(args.out, "ready.json");
    const wiring = createRebuildWiring({ rpcUrl, familyIds: [FLUID_DEX_FAMILY_ID],
      executionIdentity: { executor: args.executor, transactionOrigin: args.owner } });
    // Neither TX nor expected pool is supplied to the production discovery/strict pipeline.
    const ready = await rebuildUniverse({ ...wiring, store: new UniverseRebuildCheckpointStore({ path: checkpoint }),
      runId: `fluid-single-${block}`, observationRange: { fromBlock: block, toBlock: block },
      attestationConcurrency: 1, log: message => console.log(redact(message)) });
    assert.equal(ready.cutoff.number, block); assert.equal(ready.cutoff.hash.toLowerCase(), header.hash.toLowerCase());
    stage = "post-publication-target-assertions";
    const { graph } = resolveStrictReadyRuntime(ready);
    const targetEdges = graph.filter(edge => edge.target.toLowerCase() === args.expected);
    const targetLogs = receipt.logs.filter((log: { address: string; topics: string[] }) =>
      log.address.toLowerCase() === args.expected && log.topics[0]?.toLowerCase() === FLUID_DEX_SWAP_TOPIC);
    save("ready-summary.json", { cutoff: ready.cutoff, graphHash: ready.graphHash, totalEdges: graph.length,
      activeInstanceKeys: ready.activeInstanceKeys, targetEdges, targetLogs });
    assert(targetLogs.length > 0, "expected pool has no real Fluid swap log in the sample receipt");
    assert(targetEdges.length > 0, "expected pool has no naturally admitted direction");
    stage = "production-prices";
    await runAtBlock(["--ready", checkpoint, "--block", String(block), "--through", "prices",
      "--execution-mode", "source-block", "--out", resolve(args.out, "prices"),
      "--executor", args.executor, "--owner", args.owner, "--revm-bin", args.revmBin,
      "--executor-runtime-code", resolve(args.out, "executor-runtime-code.json")]);
    const prices = parseAtBlockJson(readFileSync(resolve(args.out, "prices/prices.json"), "utf8"));
    assert.equal(prices.runtime.sourceBlock, block);
    assert.equal(prices.runtime.sourceBlockHash.toLowerCase(), header.hash.toLowerCase(), "price source hash mismatch");
    completed = true;
  } catch (error) {
    save("failure.json", { stage, error });
    console.error(redact(`Fluid historical-ready failed at ${stage}: ${String(error)}`)); process.exitCode = 1;
  } finally {
    restoreStrict?.(); provider?.destroy();
    try {
      const after = sourceFingerprint(args.revmBin); save("source-after.json", after);
      assert(before && before.head === after.head && before.filesSha256 === after.filesSha256
        && before.revmBinarySha256 === after.revmBinarySha256, "source or engine changed during run");
      save("result.json", { productionCallsCompleted: completed, sourceStable: true,
        priceRowsMustBeInspected: true, dualExecution: "not_run", performance: "not_run", broadcast: false });
    } catch (error) {
      save("source-verification-failure.json", { error }); process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(redactUrls(`Fluid historical-ready input/output setup failed: ${String(error)}`)); process.exitCode = 1;
  });
}
