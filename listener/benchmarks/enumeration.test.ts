import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { distribution, loadEnumerationInput, parseOptions, publishCompletedSummary } from "./enumeration.js";

test("nearest-rank timing includes every sample, including a slow/truncated result", () => {
  assert.deepEqual(distribution([2, 1, 3, 1500]), { count: 4, min: 1, p50: 2, p95: 1500, max: 1500 });
  assert.throws(() => distribution([]));
  assert.throws(() => distribution([NaN]));
});

test("divergent completed outputs cannot publish a completed summary", () => {
  const saved: string[] = [];
  const save = (name: string) => { saved.push(name); };
  assert.throws(() => publishCompletedSummary({ status: "completed",
    byBlock: [{ stableCompletedOutputs: true }, { stableCompletedOutputs: false }] }, save), /different candidates/);
  assert.deepEqual(saved, []);
  publishCompletedSummary({ status: "completed", byBlock: [{ stableCompletedOutputs: true }] }, save);
  assert.deepEqual(saved, ["summary.json"]);
});

test("benchmark options cannot change production policy and reject invalid repetitions", () => {
  assert.equal(parseOptions(["--input-index", "input.json", "--out", "output"]).repetitions, 10);
  for (const extra of [["--repetitions", "0"], ["--repetitions", "1.5"], ["--budget", "150000"]]) {
    assert.throws(() => parseOptions(["--input-index", "input.json", "--out", "output", ...extra]));
  }
});

test("offline loader validates hashes and exact effective amounts without inventing quotes", () => {
  const dir = mkdtempSync(join(tmpdir(), "mev-enumeration-input-"));
  const put = (name: string, value: unknown) => {
    const bytes = JSON.stringify(value), path = join(dir, name);
    writeFileSync(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  try {
    const graph = put("graph.json", { graphHash: "fixture-graph", edges: [{}] });
    const row = { quoteAmountIn: { $offlineBigInt: "9007199254740993" }, quoteAmountOut: { $offlineBigInt: "2" } };
    const snapshot = put("snapshot.json", { format: "offline-recorded-effective-scanner-input-v1", sourceBlock: 1,
      graphFileSha256: graph.sha256, graphHash: "fixture-graph", projectedMids: [["edge", row]] });
    const index = () => put("index.json", { graphFile: graph.path, graphFileSha256: graph.sha256,
      funding: ["0xTOKEN"], snapshotFiles: [{ block: 1, ...snapshot }] }).path;
    assert.equal(loadEnumerationInput(index()).snapshots[0]!.mids.get("edge")!.quoteAmountIn, 9007199254740993n);
    writeFileSync(snapshot.path, `${readFileSync(snapshot.path, "utf8")} `);
    assert.throws(() => loadEnumerationInput(index()), /hash mismatch/);
    Object.assign(snapshot, put("snapshot.json", { format: "offline-recorded-effective-scanner-input-v1", sourceBlock: 1,
      graphFileSha256: graph.sha256, graphHash: "fixture-graph", projectedMids: [["edge", { ...row, quoteAmountIn: 1 }]] }));
    assert.throws(() => loadEnumerationInput(index()), /invalid effective amountIn/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
