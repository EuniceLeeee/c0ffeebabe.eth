import assert from "node:assert/strict";
import test from "node:test";
import { assertHistoricalPriceRowSource, assertHistoricalPriceState } from "./standard-price-state.js";

// Projection of the real N25462190 Ready and production at-block price frames.
const hash = "0x3b02e4d1911cefa4a6e5cef387db42da16821da9d48196421156ae63ab1bac13";
const executionSource = { number: 25462190, hash, generation: 25462190 };
const priceSource = { number: 25462190, hash, generation: 1 };
const readySha256 = "e7ce3ff33a41ae30aa299caa3366e00f31a62980ae316e21f031b05a3e50d2b1";
const saved = () => ({ schemaVersion: 1, readySha256, runtime: {
  generation: 1, sourceBlock: 25462190, sourceBlockHash: hash,
  pricing: { generation: 1, sourceBlock: 25462190, sourceBlockHash: hash,
    effectiveMids: { complete: true, source: { ...priceSource } } },
} });

test("same historical state accepts independent Ready and pricing lifecycle generations", () => {
  assert.deepEqual(assertHistoricalPriceState(saved(), readySha256, executionSource).priceSource, priceSource);
  assertHistoricalPriceRowSource({ quotedAt: priceSource }, priceSource);
});
test("a different Ready artifact is rejected", () => {
  assert.throws(() => assertHistoricalPriceState(saved(), "f".repeat(64), executionSource));
});
test("a different historical number or hash is rejected", () => {
  for (const mismatch of [{ ...executionSource, number: 25462189 }, { ...executionSource, hash: "0x" + "f".repeat(64) }])
    assert.throws(() => assertHistoricalPriceState(saved(), readySha256, mismatch));
});
test("pricing cannot mix its runtime or effective lifecycle generation", () => {
  const runtime = saved(); runtime.runtime.generation = 2;
  assert.throws(() => assertHistoricalPriceState(runtime, readySha256, executionSource));
  const effective = saved(); effective.runtime.pricing.effectiveMids.source.generation = 2;
  assert.throws(() => assertHistoricalPriceState(effective, readySha256, executionSource));
});
test("a quote from another session or an unquoted row is rejected", () => {
  assert.throws(() => assertHistoricalPriceRowSource({ quotedAt: executionSource }, priceSource));
  assert.throws(() => assertHistoricalPriceRowSource({}, priceSource));
});
