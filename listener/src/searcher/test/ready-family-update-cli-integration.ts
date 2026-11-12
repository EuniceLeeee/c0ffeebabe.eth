import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { UniverseRebuildCheckpointStore } from "../universe-rebuild-checkpoint.js";

// Exercise the actual CLI, production wiring, compressed archive and durable
// checkpoint with a fixed empty block served by this process. No mainnet RPC,
// credentials, contract call or signer is involved in this fixture.
const directory = await mkdtemp(join(tmpdir(), "ready-cli-integration-"));
const execute = promisify(execFile);
const calls: string[] = [];
const unexpected: string[] = [];
let corruptAfterTrace = false, corruptCanonical = false;
const block = {
  number: "0x64", hash: "0x" + "a".repeat(64), parentHash: "0x" + "b".repeat(64),
  timestamp: "0x1", nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0",
  gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x" + "0".repeat(40), extraData: "0x",
  transactions: [], baseFeePerGas: "0x1",
};
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  const answer = (message: { readonly id: unknown; readonly method: string }) => {
    calls.push(message.method);
    let result: unknown;
    switch (message.method) {
      case "eth_chainId": result = "0x1"; break;
      case "eth_getBlockByNumber": result = corruptCanonical ? { ...block, hash: "0x" + "c".repeat(64) } : block; break;
      case "eth_getLogs": result = []; break;
      case "trace_block":
        result = [];
        if (corruptAfterTrace) corruptCanonical = true;
        break;
      default:
        unexpected.push(message.method);
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unexpected fixture RPC" } };
    }
    return { jsonrpc: "2.0", id: message.id, result };
  };
  const payload = JSON.parse(body);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
});

try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const checkpoint = join(directory, "checkpoint.json");
  const families = join(directory, "families.json"), candidates = join(directory, "candidates.json");
  const scope = ["--checkpoint", checkpoint, "--archive", join(directory, "archive"), "--families", families];
  const run = async (args: readonly string[]) => {
    const { stdout } = await execute(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("../ready-family-update-cli.ts", import.meta.url)), ...args], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)), timeout: 45_000,
      env: { ...process.env, MAINNET_RPC_URL: `http://127.0.0.1:${port}`,
        BOTVM_ADDRESS: "0x" + "1".repeat(40), BOTVM_OWNER: "0x" + "2".repeat(40) },
    });
    assert.deepEqual(unexpected, [], "fixture must never call an attestation RPC or an unbounded remote method");
    return stdout;
  };
  const store = new UniverseRebuildCheckpointStore({ path: checkpoint });
  const enabled = async () => Object.entries((await store.load())!.readyGeneration!.familyPartitions!)
    .filter(([, partition]) => partition.enabled).map(([id]) => id).sort();
  await writeFile(families, JSON.stringify(["univ3-standard"]));
  await writeFile(candidates, "[]");
  assert.match(await run(["build", ...scope, "--from-block", "100", "--to-block", "100"]), /"status":"baseline-ready"/);
  assert.deepEqual(await enabled(), ["univ3-standard"]);
  assert(calls.includes("eth_getLogs") && calls.includes("trace_block"), "baseline must really create its archive");
  const rawReadCount = calls.filter(method => method === "eth_getLogs" || method === "trace_block").length;

  // All changes go through the same command, with complete desired lists.
  for (const desired of [["univ4", "univ3-standard"], ["univ4"], ["univ4"], [], ["univ4"]]) {
    await writeFile(families, JSON.stringify(desired));
    const output = await run(["update", ...scope, "--candidates", candidates]);
    assert.match(output, /"phase":"update-plan"/);
    assert.match(output, /"status":"reviewed-ready"/);
    assert.deepEqual(await enabled(), [...desired].sort());
    assert.equal((await store.load())!.readyGeneration!.candidateAccounting.total, 0);
    if (desired.length === 0) assert.deepEqual((await store.load())!.readyGeneration!.sourceCoverage, []);
  }
  assert.match(await run(["update", ...scope, "--candidates", candidates, "--force-retryable"]),
    /"forceStatuses":\["retryable"\]/);
  assert.equal(calls.filter(method => method === "eth_getLogs" || method === "trace_block").length,
    rawReadCount, "updates reuse the sealed raw archive instead of obtaining another source range");
  assert.deepEqual((await readdir(directory)).sort(), ["archive", "archive.classified-v1", "candidates.json", "checkpoint.json", "families.json"],
    "complete-input maintenance never creates supplemental checkpoints or staging directories");
  // Even an initially empty full scope is explicit. It requires no fabricated
  // source receipts or archive, and remains valid in a subsequent same-input review.
  await writeFile(families, "[]");
  const emptyPath = join(directory, "initially-empty", "checkpoint.json");
  const emptyScope = ["--checkpoint", emptyPath, "--archive", join(directory, "initially-empty", "archive"),
    "--families", families];
  assert.match(await run(["build", ...emptyScope, "--from-block", "100", "--to-block", "100"]), /"status":"baseline-ready"/);
  assert.match(await run(["update", ...emptyScope, "--candidates", candidates]), /"status":"reviewed-ready"/);
  const empty = (await new UniverseRebuildCheckpointStore({ path: emptyPath }).load())!.readyGeneration!;
  assert.deepEqual(empty.familyPartitions, {});
  assert.deepEqual(empty.sourceCoverage, []);
  assert.deepEqual(empty.activeInstanceKeys, []);
  assert.equal(empty.candidateAccounting.total, 0);

  // A first build also accepts the exact complete candidate table. This
  // nomination carries an existing discovery failure, so its retryable result
  // exercises actual admission/accounting without invoking contract RPCs.
  await writeFile(families, JSON.stringify(["univ3-standard"]));
  const nomination = {
    familyId: "univ3-standard", adapter: "univ3", address: "0x" + "3".repeat(40),
    candidateKind: "startup-universe", blockNumber: 100, blockHash: block.hash,
    __universeRebuildDiscoveryRetryable: { stage: "nomination", failureCode: "rpc", reasonCode: "fixture-missing-discovery-evidence" },
  };
  const selectedBytes = JSON.stringify([nomination]);
  await writeFile(candidates, selectedBytes);
  const selectedPath = join(directory, "selected-baseline", "checkpoint.json");
  const selectedScope = ["--checkpoint", selectedPath, "--archive", join(directory, "selected-baseline", "archive"),
    "--families", families];
  const selectedBuildBase = ["build", ...selectedScope, "--from-block", "100", "--to-block", "100"];
  const selectedBuild = [...selectedBuildBase, "--candidates", candidates];
  const selectedStore = new UniverseRebuildCheckpointStore({ path: selectedPath });
  corruptAfterTrace = true;
  try {
    await assert.rejects(run(selectedBuild), /canonical|cutoff|reorg/i,
      "a changed canonical cutoff must prevent Ready promotion");
  } finally { corruptAfterTrace = false; corruptCanonical = false; }
  const pending = (await selectedStore.load())!.inProgressRun!;
  const selectionHash = createHash("sha256").update(selectedBytes).digest("hex");
  assert.equal(pending.currentInputFingerprint, selectionHash);
  assert(pending.runId.endsWith("-candidates-" + selectionHash));
  assert.equal(pending.candidateCount, 1);
  await writeFile(candidates, selectedBytes + "\n");
  await assert.rejects(run(selectedBuild), /baseline resume input mismatch/,
    "resume retains the original candidate file byte identity even if JSON values are unchanged");
  await assert.rejects(run(selectedBuildBase), /baseline resume input mismatch/,
    "dropping the explicit complete table cannot silently resume an exact-input build");
  await writeFile(candidates, selectedBytes);
  assert.match(await run(selectedBuild), /"status":"baseline-ready"/);
  const selectedReady = (await selectedStore.load())!.readyGeneration!;
  assert.equal(selectedReady.candidateAccounting.total, 1);
  assert.equal(selectedReady.candidateAccounting.retryable, 1);
  const oldOutcome = Object.values(selectedReady.familyPartitions!["univ3-standard"]!.outcomesByCandidateKey)[0]!;
  assert.equal(oldOutcome.status, "retryable");
  assert.match(await run(["update", ...selectedScope, "--candidates", candidates]), /"status":"reviewed-ready"/);
  const retainedOutcome = Object.values((await selectedStore.load())!.readyGeneration!
    .familyPartitions!["univ3-standard"]!.outcomesByCandidateKey)[0]!;
  assert.deepEqual(retainedOutcome, oldOutcome, "same full input must retain an existing retryable outcome unchanged");
  await run(["update", ...selectedScope, "--candidates", candidates, "--force-retryable"]);
  const forcedOutcome = Object.values((await selectedStore.load())!.readyGeneration!
    .familyPartitions!["univ3-standard"]!.outcomesByCandidateKey)[0]!;
  assert.equal(forcedOutcome.status, "retryable");
  assert.notDeepEqual(forcedOutcome, retainedOutcome, "selective force must execute the retryable task instead of inheriting it");
  await writeFile(candidates, "[]");
  await run(["update", ...selectedScope, "--candidates", candidates]);
  assert.equal((await selectedStore.load())!.readyGeneration!.candidateAccounting.total, 0,
    "a later complete empty candidate table removes the previous candidate from current accounting");
  console.log("Ready CLI integration PASS: full family and candidate build/update, empty/restore, bound resume and selective force; local RPC only");
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
