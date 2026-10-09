import assert from "node:assert/strict";
import test from "node:test";
import { recordedDepositTrial } from "./deposit-historical.js";
test("later decode failure keeps earlier success and the failed amount/debt/receipt", async () => {
  const report = { samples: [] as any[] };
  await recordedDepositTrial(report, { amountIn: 11n, debt: 220n }, async () => [{ delta: 22n }], () => 22n);
  await assert.rejects(recordedDepositTrial(report, { amountIn: 110n, debt: 2200n },
    async () => [{ delta: 0n }], () => { throw new Error("mint mismatch"); }));
  assert.equal(report.samples.length, 2);
  assert.equal(report.samples[0].status, "pass");
  assert.deepEqual(report.samples[1], { amountIn: 110n, debt: 2200n, status: "failed", results: [{ delta: 0n }], error: "mint mismatch" });
});
test("issuer failure keeps the started trial without invented results", async () => {
  const report = { samples: [] as any[] };
  await assert.rejects(recordedDepositTrial(report, { amountIn: 11n, debt: 220n },
    async () => { throw new Error("deadline"); }, () => 22n));
  assert.equal(report.samples[0].status, "failed"); assert.equal(report.samples[0].error, "deadline");
  assert.equal(Object.hasOwn(report.samples[0], "results"), false);
});
