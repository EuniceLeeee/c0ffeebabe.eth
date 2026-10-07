import assert from "node:assert/strict";
import test from "node:test";
import { parseBlockScanObservedHeader } from "../../../../blockscan-observed-header.js";
import { curveHistoricalHeader } from "./historical-price-input.js";
const source = { number: 123, hash: "0x" + "ab".repeat(32), generation: 1 };
const raw = { number: "0x7b", hash: source.hash, parentHash: "0x" + "cd".repeat(32),
  timestamp: "0x123", baseFeePerGas: "0x1", gasUsed: "0x2", gasLimit: "0x3", transactions: [] };
const header = parseBlockScanObservedHeader(raw, 123, 1n);
const saved = { schemaVersion: 1, readyPath: "/ready.json", readySha256: "ready-hash", runtime: {} };
const input = () => ({ readyPath: saved.readyPath, readySha256: saved.readySha256, chainId: "1", broadcast: false,
  executionMode: "source-block", topologySource: source, stateSource: header, sourceHeader: raw });
test("current production split files and legacy inline headers bind the same environment", () => {
  assert.deepEqual(curveHistoricalHeader(saved, source, input()), header);
  assert.strictEqual(curveHistoricalHeader({ ...saved, header }, source), header);
  assert.deepEqual(curveHistoricalHeader({ ...saved, header }, source, input()), header);
  assert.equal(Object.hasOwn(saved, "header"), false, "the price artifact must not be rewritten");
});
test("missing provenance fails before starting a fork", () => {
  assert.throws(() => curveHistoricalHeader(saved, source), /price-input/);
});
test("foreign Ready, chain, source, environment and conflicting inline header fail closed", () => {
  const mutations: ((p: any) => void)[] = [
    p => p.readyPath = "/different.json", p => p.readySha256 = "wrong",
    p => p.chainId = "2", p => p.broadcast = true, p => p.executionMode = "next-block",
    p => p.topologySource.number++, p => p.topologySource.hash = "0x" + "ef".repeat(32),
    p => p.sourceHeader.number = "0x7c", p => p.sourceHeader.hash = "0x" + "ef".repeat(32),
    p => p.sourceHeader.timestamp = "0x124", p => p.sourceHeader.baseFeePerGas = "0x2",
    p => p.stateSource.timestamp++, p => p.stateSource.baseFeePerGas = 2n,
    p => delete p.sourceHeader, p => delete p.stateSource,
  ];
  for (const mutate of mutations) {
    const provenance = structuredClone(input()); mutate(provenance);
    assert.throws(() => curveHistoricalHeader(saved, source, provenance));
  }
  assert.throws(() => curveHistoricalHeader({ ...saved, header: { ...header, timestamp: 1 } }, source, input()));
});
