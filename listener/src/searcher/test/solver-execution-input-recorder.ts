import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSolverExecutionInputRecorder } from "../solver-execution-input-recorder.js";
import { runOrderedBlockScanPipeline } from "../blockscan-ordered-pipeline.js";

const dir = mkdtempSync(join(tmpdir(), "mev-solver-input-test-"));
const path = join(dir, "inputs.jsonl");
const defaults = { runId: "fixture-run", runtimeCommit: "a".repeat(40), chainId: 1 };
const hash = "0x" + "a".repeat(64), token = "0x" + "1".repeat(40);
const input = {
  source: { number: 100, hash, generation: 1 }, opportunityId: hash,
  route: { routeId: hash, edgeIds: ["edge-a", "edge-b"], tokenRing: [token, token],
    venuePath: [["opaque-family", "opaque-instance"]] as readonly (readonly [string, string])[], flashToken: token },
  solverIndex: 0, candidateIndex: 0, flashAmount: 2n ** 100n, quoteProfit: 13n,
  profitToken: token, templateName: "fixture",
  executionInput: { method: "eth_simulateV1", data: "0x123456", params: [{ value: "0x0" }, { blockHash: hash }] },
};
try {
  const recorder = createSolverExecutionInputRecorder({ ...defaults, path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const first = recorder.record(input);
  recorder.record({ ...input, flashAmount: input.flashAmount + 1n, candidateIndex: 1 });
  assert.equal(first.sequence, 1);
  const rows = readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].flash_amount, input.flashAmount.toString());
  assert.equal(rows[1].flash_amount, (input.flashAmount + 1n).toString());
  assert.deepEqual(rows[0].execution_input, input.executionInput);
  for (const { record_sha256, ...payload } of rows) {
    assert.equal(record_sha256, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
  }
  const persisted = readFileSync(path, "utf8");
  input.executionInput.data = "0xffff";
  assert.equal(readFileSync(path, "utf8"), persisted, "saved bytes never follow mutable in-memory plans");
  recorder.close(); recorder.close();
  assert.equal(recorder.snapshot().records, 2);
  assert.throws(() => recorder.record(input), /recording failed/);
  assert.throws(() => createSolverExecutionInputRecorder({ ...defaults, path }), /EEXIST/);
  assert.equal(readFileSync(path, "utf8"), persisted, "existing evidence must not be overwritten");

  const target = join(dir, "protected.jsonl"); writeFileSync(target, "keep");
  const link = join(dir, "link.jsonl"); symlinkSync(target, link);
  assert.throws(() => createSolverExecutionInputRecorder({ ...defaults, path: link }));
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.throws(() => createSolverExecutionInputRecorder({ ...defaults, path: join(dir, "same.jsonl"),
    protectedPaths: [join(dir, "same.jsonl")] }), /configuration/);
  const alias = join(dir, "directory-alias"); symlinkSync(dir, alias, "dir");
  assert.throws(() => createSolverExecutionInputRecorder({ ...defaults,
    path: join(alias, "routes.jsonl"), protectedPaths: [` ${join(dir, "routes.jsonl")} `] }), /configuration/);
  assert.throws(() => createSolverExecutionInputRecorder({ ...defaults,
    path: ` ${join(dir, "mids.jsonl")} `, protectedPaths: [join(alias, "mids.jsonl")] }), /configuration/);
  for (const limits of [{ maxFileBytes: 10 }, { maxRecordBytes: 10 }]) {
    const bounded = createSolverExecutionInputRecorder({ ...defaults, path: join(dir, Object.keys(limits)[0]!), ...limits });
    assert.throws(() => bounded.record(input), /recording failed/);
    assert.equal(bounded.snapshot().records, 0);
    assert.equal(bounded.snapshot().bytes, 0);
    assert.equal(bounded.snapshot().failed, true);
    bounded.close();
  }

  // Persistence is a producer-side boundary, not a pass-finish batch. An
  // ordered consumer aborted by a new head cannot erase already-produced data.
  const abortPath = join(dir, "aborted.jsonl");
  const beforeAbort = createSolverExecutionInputRecorder({ ...defaults, path: abortPath });
  const controller = new AbortController();
  const reason = new Error("source superseded before final sim");
  await assert.rejects(runOrderedBlockScanPipeline({
    count: 2, workers: [0, 1], signal: controller.signal, deadlineAtMs: Date.now() + 2_000,
    produce: async index => { beforeAbort.record({ ...input, solverIndex: index }); return index; },
    consume: async () => { controller.abort(reason); throw reason; },
  }), error => error === reason);
  beforeAbort.close();
  assert.equal(beforeAbort.snapshot().records, 2);
  assert.equal(readFileSync(abortPath, "utf8").trimEnd().split("\n").length, 2);
  console.log("solver execution input recorder PASS (complete private records, exact integers, abort retention, collision/size fail-closed)");
} finally { rmSync(dir, { recursive: true, force: true }); }
