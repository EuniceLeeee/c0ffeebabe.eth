import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resetHistoricalForkEnvironment } from "../../shared/state/state-backend.js";

const parent = { number: "0x64", hash: `0x${"ab".repeat(32)}`, stateRoot: `0x${"cd".repeat(32)}` };

test("historical environment reset keeps the same parent and never supplies a new RPC URL or account overrides", async () => {
  const calls: unknown[] = [];
  await resetHistoricalForkEnvironment({ async send(method, params) {
    calls.push([method, params]);
    return method === "anvil_reset" ? null : parent;
  } }, 100);
  assert.deepEqual(calls, [
    ["eth_getBlockByNumber", ["latest", false]],
    ["anvil_reset", [{ forking: { blockNumber: 100 } }]],
    ["eth_getBlockByNumber", ["latest", false]],
  ]);
});

test("parent reset mismatch, missing identity, wrong height and reset errors fail closed", async () => {
  for (const after of [
    { ...parent, hash: `0x${"ef".repeat(32)}` },
    { ...parent, stateRoot: `0x${"ef".repeat(32)}` },
    { ...parent, number: "0x65" }, { ...parent, hash: null }, { ...parent, number: "100" },
  ]) {
    let reads = 0;
    await assert.rejects(resetHistoricalForkEnvironment({ async send(method) {
      if (method === "anvil_reset") return null;
      return reads++ === 0 ? parent : after;
    } }, 100), /historical parent/);
  }
  await assert.rejects(resetHistoricalForkEnvironment({ async send(method) {
    if (method === "anvil_reset") throw new Error("reset unavailable");
    return parent;
  } }, 100), /reset unavailable/);
  for (const number of [-1, NaN, 1.1]) {
    await assert.rejects(resetHistoricalForkEnvironment({ async send() { assert.fail("invalid height reached RPC"); } }, number));
  }
});

test("both historical prefix entrypoints reset before queuing, without changing ordinary live fork startup", () => {
  const source = readFileSync(new URL("../../shared/state/state-backend.ts", import.meta.url), "utf8");
  for (const name of ["queueHistoricalBlockPrefix", "queueHistoricalRawTransactions"]) {
    const offset = source.indexOf(`  async ${name}(`);
    assert(offset >= 0);
    const body = source.slice(offset, source.indexOf("\n  async ", offset + 1));
    assert.match(body, /await this\.restartHistoricalForkAt\(blockNumber - 1\)/);
    assert(body.indexOf("restartHistoricalForkAt") < body.indexOf("setNextBlockContext"));
    assert(body.indexOf("setNextBlockContext") < body.indexOf("sendRawTxNoMine"));
  }
  const start = source.slice(source.indexOf("  async start()"), source.indexOf("\n  stop():"));
  assert.doesNotMatch(start, /restartHistoricalForkAt|resetHistoricalForkEnvironment/);
});
