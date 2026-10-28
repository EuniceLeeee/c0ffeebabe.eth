import assert from "node:assert/strict";
import type { CanonicalSource } from "../../../adapter-request-program.js";

/** Ready issuance and an at-block pricing run have separate lifecycle fences. */
export function assertHistoricalPriceState(saved: any, readySha256: string, executionSource: CanonicalSource) {
  assert.equal(saved.schemaVersion, 1); assert.equal(saved.readySha256, readySha256);
  const runtime = saved.runtime, pricing = runtime.pricing;
  for (const frame of [runtime, pricing]) {
    assert.equal(frame.sourceBlock, executionSource.number);
    assert.equal(frame.sourceBlockHash, executionSource.hash);
    assert(Number.isSafeInteger(frame.generation) && frame.generation >= 0);
  }
  assert.equal(pricing.generation, runtime.generation);
  const priceSource = { number: pricing.sourceBlock, hash: pricing.sourceBlockHash, generation: pricing.generation };
  assert(pricing.effectiveMids?.complete);
  assert.deepEqual(pricing.effectiveMids.source, priceSource);
  return { pricing, priceSource };
}

export function assertHistoricalPriceRowSource(row: { quotedAt?: CanonicalSource }, priceSource: CanonicalSource) {
  assert.deepEqual(row.quotedAt, priceSource);
}
