import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBeHex } from "ethers";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import { runReadyFamilyMaintenance } from "../ready-family-update-cli.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { UniverseRebuildCheckpointStore } from "../universe-rebuild-checkpoint.js";

test("ordinary Ready CLI builds and restores the full supplied SQL interval while legacy collection stays bounded", async t => {
  const directory = await mkdtemp(join(tmpdir(), "selector-ready-cli-full-interval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hash = (number: number) => toBeHex(number, 32);
  const cutoff = { number: 20_001, hash: hash(20_001), generation: 20_001 };
  const reads: string[] = [], headers: unknown[] = [];
  for (const method of ["send", "sendControlled", "_send", "getLogs", "getTransaction", "getTransactionReceipt"] as const) {
    t.mock.method(RebuildReadProvider.prototype, method, async (..._args: unknown[]) => {
      reads.push(method); throw new Error("unexpected RPC during supplied selector CLI: " + method);
    });
  }
  t.mock.method(RebuildReadProvider.prototype, "getBlock", async (number: unknown) => {
    headers.push(number); assert.equal(number, cutoff.number);
    return { number: cutoff.number, hash: cutoff.hash };
  });
  const environment = { MAINNET_RPC_URL: "https://offline.invalid", BOTVM_ADDRESS: toBeHex(4999, 20), BOTVM_OWNER: toBeHex(4001, 20) };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const transaction = (block: number, id: number) => readySelectorCensusFromTransaction({ chain_id: 1,
    tx_hash: hash(id), block_number: block, block_hash: hash(block), transaction_index: id, receipt_status: 1,
    to: toBeHex(4005, 20), from: environment.BOTVM_OWNER, value: "0", input: "0x12345678", logs: [], traces: [] });
  const families = join(directory, "families.json"), census = join(directory, "census.json"), checkpoint = join(directory, "ready.json");
  await writeFile(families, "[]");
  await writeFile(census, JSON.stringify([transaction(1, 1), transaction(cutoff.number, 2)]));
  const scope = ["--checkpoint", checkpoint, "--families", families];
  await runReadyFamilyMaintenance(["build", ...scope, "--selector-input", census, "--from-block", "1", "--to-block", String(cutoff.number)]);
  const store = new UniverseRebuildCheckpointStore({ path: checkpoint }), initial = (await store.load())!.readyGeneration!;
  assert.deepEqual(initial.universeRange, { fromBlock: 1, toBlock: cutoff.number });
  assert.equal(initial.selectorCoverage!.counts.transactions, 2);
  assert(initial.selectorCoverage!.entries.every(row => row.status === "unverified"));
  await runReadyFamilyMaintenance(["update", ...scope]);
  const restored = (await store.load())!.readyGeneration!;
  assert.deepEqual(restored.selectorCoverage, initial.selectorCoverage, "ordinary update inherits the exact supplied census");
  assert.deepEqual(restored.universeRange, initial.universeRange);
  const beforeLegacy = headers.length;
  await assert.rejects(runReadyFamilyMaintenance(["build", "--checkpoint", join(directory, "legacy.json"),
    "--families", families, "--archive", join(directory, "archive"), "--from-block", "1", "--to-block", String(cutoff.number)]),
    /bounded baseline range/);
  assert.equal(headers.length, beforeLegacy, "legacy over-limit range fails before any canonical or historical RPC");
  assert.deepEqual(reads, [], "supplied census never triggers an historical collection RPC");
});
