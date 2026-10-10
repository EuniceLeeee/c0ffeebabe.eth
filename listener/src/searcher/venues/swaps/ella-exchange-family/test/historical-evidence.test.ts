import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { POOL } from "../codec.js";
import { assertAcceptanceBinding, assertInventoryRejection, requireProductionReference } from "./historical-evidence.js";

const pool = "0x1000000000000000000000000000000000000004";
const executor = "0x1000000000000000000000000000000000000002";
const reason = (s: string) => "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [s]).slice(2);
const valid = () => ({ error: "execution reverted", gas: "0x500000", gasUsed: "0x10000", calls: [
  { type: "CALL", from: executor, to: pool, input: POOL.encodeFunctionData("swapBase1"), value: "0x10",
    error: "execution reverted", gas: "0x400000", gasUsed: "0x1000", output: reason("No fund to execute the trade") },
] });
test("inventory evidence binds the inner deployed call, not an outer generic revert", () => {
  assertInventoryRejection(valid(), pool, executor, 16n);
});
test("wrong amount/caller/call, missing trace, gas exhaustion and other revert are not capacity proof", () => {
  const corrupt = [
    (x: any) => { x.calls[0].value = "0x11"; },
    (x: any) => { x.calls[0].from = pool; },
    (x: any) => { x.calls[0].input = "0x"; },
    (x: any) => { x.calls[0].output = reason("other failure"); },
    (x: any) => { x.calls[0].gasUsed = x.calls[0].gas; },
    (x: any) => { x.gasUsed = x.gas; },
    (x: any) => { x.calls = []; },
    (x: any) => { x.calls.push({ ...x.calls[0] }); },
    (x: any) => { delete x.error; },
  ];
  for (const mutate of corrupt) { const trace = valid(); mutate(trace); assert.throws(() => assertInventoryRejection(trace, pool, executor, 16n)); }
});

test("reference amounts cannot silently disappear or hide failed reads", () => {
  requireProductionReference({ amountIn: 16n, status: "quoted" });
  requireProductionReference({ amountIn: 16n, status: "no-output" });
  for (const row of [{ amountIn: 0n, status: "quoted" }, { amountIn: 16n, status: "missing-valuation" },
    { amountIn: 16n, status: "quote-failed" }]) assert.throws(() => requireProductionReference(row));
});

test("Ready/pricing source and actors must match; neither height nor a file hash alone suffices", () => {
  const source = { number: 100, hash: ethers.id("source") };
  const owner = "0x1000000000000000000000000000000000000001";
  const saved = { readyPath: "/tmp/ready.json", readySha256: "a".repeat(64), stateSource: source,
    topologySource: source, executor, owner, broadcast: false, policy: { dryRun: true } };
  const check = (s: any) => assertAcceptanceBinding({ saved: s, readyPath: saved.readyPath,
    readySha256: saved.readySha256, source, executor, owner });
  check(saved);
  for (const mutate of [
    (s: any) => { s.executor = owner; }, (s: any) => { s.owner = executor; },
    (s: any) => { s.stateSource.hash = ethers.id("wrong"); },
    (s: any) => { s.topologySource.number++; },
    (s: any) => { s.readySha256 = "b".repeat(64); },
    (s: any) => { s.policy.dryRun = false; },
  ]) { const broken = structuredClone(saved); mutate(broken); assert.throws(() => check(broken)); }
});
