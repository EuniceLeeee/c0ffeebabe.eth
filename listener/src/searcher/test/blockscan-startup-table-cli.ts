import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliStartupReplay, defaultStartupTable, readStartupTable, readCompatibleStartupTable, startupTableImplementation, writeStartupTable,
  type StartupTableIdentity } from "../blockscan-startup-table-cli.js";
import { parseAtBlockArgs } from "../blockscan-at-block-cli.js";

const root = mkdtempSync(join(tmpdir(), "mev-startup-table-"));
const identity: StartupTableIdentity = { baselineSha256: "baseline", readySha256: "ready",
  source: { number: 1, hash: "0x" + "12".repeat(32), generation: 1 }, chainId: "1",
  executor: "executor", owner: "owner", executorCode: "chain", rawEntry: false, implementationSha256: "code" };
const rows = ["success", "revert", "revert", "revert", "unsupported"].map((status, i) => ({
  sourceBlock: 1, sourceBlockHash: identity.source.hash, generation: 1,
  edgeId: `edge-${i}`, instanceKey: `instance-${i}`, expectedAmountIn: "100", expectedAmountOut: "99",
  mode: "observe-only", filterApplied: false, status, targetBlock: 2,
  scriptHash: "0x" + "ab".repeat(32), failureStage: ["none", "target", "prefix", "unattributed", undefined][i],
  targetAttempted: i <= 1 ? true : i === 2 ? false : null,
}));
const expected = new Map(rows.map(r => [r.edgeId, { amountIn: 100n, amountOut: 99n, instanceKey: r.instanceKey }]));
const input = join(root, "source.jsonl"), table = defaultStartupTable(join(root, "baseline.json"));
writeFileSync(input, rows.map(r => JSON.stringify(r) + "\n").join(""));
await writeStartupTable(table, { identity, observations: input, expected, provenance: { test: true } });
const first = await readStartupTable(table, identity, expected);
const second = await readStartupTable(table, identity, expected);
assert.deepEqual([...first.rows], [...second.rows]);
assert.equal(first.counts.total, 5);
assert.equal(first.counts.prefixReverted, 1);
assert.equal(first.counts.unattributedReverted, 1);
assert.equal(first.counts.unsupported, 1);
let calls = 0, resets = 0;
const adapter = cliStartupReplay({ async run() { calls++; return false; }, reset() { resets++; } });
adapter.restore(second);
await adapter.run({} as never); await adapter.run({} as never);
assert.equal(calls, 0, "cached baseline must not invoke production startup simulation");
assert.equal(second.filtersAdded, 0);
adapter.reset(); await adapter.run({} as never);
assert.equal(calls, 1); assert.equal(resets, 1);
for (const changed of [{ ...identity, baselineSha256: "other" }, { ...identity, implementationSha256: "new-code" },
  { ...identity, executor: "other" }, { ...identity, owner: "other" }, { ...identity, executorCode: "override" },
  { ...identity, source: { ...identity.source, hash: "0x" + "34".repeat(32) } }, { ...identity, rawEntry: true }]) {
  await assert.rejects(readStartupTable(table, changed, expected), /identity changed/);
}
await assert.rejects(readStartupTable(table, identity, new Map([...expected].slice(1))), /absent/);
const changedAmount = new Map(expected); changedAmount.set("edge-0", { ...expected.get("edge-0")!, amountIn: 101n });
await assert.rejects(readStartupTable(table, identity, changedAmount));
await assert.rejects(writeStartupTable(table, { identity, observations: input, expected, provenance: null }), /EEXIST/);
const manifest = JSON.parse(readFileSync(table, "utf8"));
writeFileSync(join(root, manifest.observations), JSON.stringify(rows[0]) + "\n");
await assert.rejects(readStartupTable(table, identity, expected), /coverage/);
writeFileSync(join(root, manifest.observations), rows.map(r => JSON.stringify(r) + "\n").join("") + "{partial");
await assert.rejects(readStartupTable(table, identity, expected));
const argv = ["--ready", "ready", "--block", "2", "--out", "out", "--benchmark-baseline", "base"];
assert(parseAtBlockArgs([...argv, "--startup-table-only"])!["startup-table-only"]);
assert.throws(() => parseAtBlockArgs([...argv, "--import-startup-results", "old"]), /requires/);
assert.throws(() => parseAtBlockArgs([...argv, "--startup-table-only", "--refresh-startup-table"]), /incompatible/);
console.log(JSON.stringify({ test: "startup-table-cli", result: "pass", observations: 5,
  cacheReplaySimCalls: 0, liveFilteringChanges: 0, mismatchAndTruncationRejected: true, immutable: true }));

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const producerRoot = join(root, "producer"), consumerRoot = join(root, "consumer");
const changedFile = "searcher/detector/blockscan-joint-dfs.ts";
const consumerAttribution = "searcher/blockscan-pool-revert.ts";
for (const directory of [producerRoot, consumerRoot]) mkdirSync(join(directory, "searcher/detector"), { recursive: true });
writeFileSync(join(producerRoot, changedFile), "export const version = 1;\n");
writeFileSync(join(consumerRoot, changedFile), "export const version = 2;\n");
writeFileSync(join(producerRoot, consumerAttribution), "export const sameInputTrace = false;\n");
writeFileSync(join(consumerRoot, consumerAttribution), "export const sameInputTrace = true;\n");
const retiredDiagnostics = ["searcher/blockscan-startup-execution-preflight-baseline.ts", "searcher/standalone-input-funding.ts"];
for (const file of retiredDiagnostics) writeFileSync(join(producerRoot, file), "export const testOnly = true;\n");
const producerIdentity = { ...identity, implementationSha256: startupTableImplementation(producerRoot) };
const consumerIdentity = { ...identity, implementationSha256: startupTableImplementation(consumerRoot) };
const compatibleTable = join(root, "compatible.json"), proofPath = join(root, "compatibility.json");
await writeStartupTable(compatibleTable, { identity: producerIdentity, observations: input, expected, provenance: null });
const originalManifest = readFileSync(compatibleTable);
writeFileSync(join(root, "review.json"), JSON.stringify({ verdict: "compatible", fixture: true }));
const proof = { schemaVersion: 1, scope: "reviewed-historical-latency-only", producerSourceRoot: producerRoot,
  producerImplementationSha256: producerIdentity.implementationSha256,
  consumerImplementationSha256: consumerIdentity.implementationSha256,
  changes: [{ file: changedFile, beforeSha256: sha(readFileSync(join(producerRoot, changedFile))),
    afterSha256: sha(readFileSync(join(consumerRoot, changedFile))) },
    { file: consumerAttribution, beforeSha256: sha(readFileSync(join(producerRoot, consumerAttribution))),
      afterSha256: sha(readFileSync(join(consumerRoot, consumerAttribution))) },
    ...retiredDiagnostics.map(file => ({ file, beforeSha256: sha(readFileSync(join(producerRoot, file))), afterSha256: null }))]
    .sort((a, b) => a.file.localeCompare(b.file)),
  review: { verdict: "compatible", evidencePath: "review.json", evidenceSha256: sha(readFileSync(join(root, "review.json"))) } };
const saveProof = () => writeFileSync(proofPath, JSON.stringify(proof)); saveProof();
const compatible = () => readCompatibleStartupTable(compatibleTable, consumerIdentity, expected, proofPath, consumerRoot);
await assert.rejects(readStartupTable(compatibleTable, consumerIdentity, expected), /identity changed/);
const reused = await compatible();
assert.deepEqual(reused.identity, producerIdentity, "old observations keep their original producer identity");
assert.deepEqual(reused.compatibility.consumerIdentity, consumerIdentity);
assert.deepEqual(readFileSync(compatibleTable), originalManifest, "compatibility never rewrites the table");
assert.equal(reused.startupSimRequests, 0);
for (const directory of [producerRoot, consumerRoot]) {
  const file = join(directory, changedFile), original = readFileSync(file);
  writeFileSync(file, "changed after review");
  await assert.rejects(compatible(), /code changed/); writeFileSync(file, original);
}
const changes = proof.changes; proof.changes = []; saveProof();
await assert.rejects(compatible(), /delta differs/); proof.changes = changes; saveProof();
const forbidden = join(consumerRoot, "searcher/simulation.ts"); writeFileSync(forbidden, "export {};");
const approvedConsumerHash = consumerIdentity.implementationSha256;
consumerIdentity.implementationSha256 = proof.consumerImplementationSha256 = startupTableImplementation(consumerRoot);
saveProof(); await assert.rejects(compatible(), /execution or unreviewed/);
unlinkSync(forbidden); consumerIdentity.implementationSha256 = proof.consumerImplementationSha256 = approvedConsumerHash; saveProof();
for (const changed of [{ ...consumerIdentity, executor: "other" }, { ...consumerIdentity, owner: "other" },
  { ...consumerIdentity, chainId: "2" }, { ...consumerIdentity, rawEntry: true },
  { ...consumerIdentity, baselineSha256: "changed" }, { ...consumerIdentity, readySha256: "changed" },
  { ...consumerIdentity, source: { ...identity.source, number: 2 } }])
  await assert.rejects(readCompatibleStartupTable(compatibleTable, changed, expected, proofPath, consumerRoot), /identity changed/);
await assert.rejects(readCompatibleStartupTable(compatibleTable, consumerIdentity, changedAmount, proofPath, consumerRoot));
writeFileSync(join(root, "review.json"), "tampered"); await assert.rejects(compatible(), /review evidence changed/);
assert(parseAtBlockArgs([...argv, "--startup-compatibility", proofPath])!["startup-compatibility"]);
assert.throws(() => parseAtBlockArgs([...argv, "--startup-compatibility", proofPath, "--refresh-startup-table"]), /read-only/);
console.log(JSON.stringify({ test: "startup-table-explicit-compatibility", result: "pass",
  producerIdentityPreserved: true, exactConsumerAndDeltaBound: true, executionChangesRejected: true, simulations: 0 }));
