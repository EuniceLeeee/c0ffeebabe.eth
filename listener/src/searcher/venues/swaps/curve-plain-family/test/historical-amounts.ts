import assert from "node:assert/strict";
import type { CanonicalSource } from "../../../adapter-request-program.js";

export interface HistoricalAmountPoint {
  readonly multiplier: bigint;
  readonly amountIn: bigint;
  readonly priorActualOut?: bigint;
}

/** Read saved executed amounts as test inputs; never mutate current prices/Ready. */
export function curveHistoricalAmounts(input: {
  readonly source: CanonicalSource; readonly pool: string; readonly family: string;
  readonly row: { readonly tokenIn: string; readonly tokenOut: string; readonly amountIn: bigint };
  readonly reference?: any;
}): readonly HistoricalAmountPoint[] {
  const { source, row, reference } = input;
  if (!reference) return [1n, 10n].map(multiplier => ({ multiplier, amountIn: row.amountIn * multiplier }));
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  assert.equal(reference.schemaVersion, 1);
  assert(same(reference.pool, input.pool) && reference.scope?.family === input.family, "foreign reference pool/family");
  for (const pin of [reference.inputs?.source, reference.headerBefore, reference.headerAfter]) {
    assert(pin && pin.number === source.number && same(pin.hash, source.hash), "reference state/environment mismatch");
  }
  assert.equal(reference.safety?.broadcast, false); assert.equal(reference.safety?.signing, false);
  assert.equal(reference.runtimeConstructionRpcAttempts, 0);
  assert(Array.isArray(reference.samples));
  const samples = reference.samples.filter((s: any) => same(s.tokenIn, row.tokenIn) && same(s.tokenOut, row.tokenOut));
  assert.equal(samples.length, 2, "exactly two saved amounts for each current direction required");
  const positive = (value: unknown): bigint => {
    assert(typeof value === "string" && /^[1-9][0-9]*$/.test(value), "positive integer input required");
    const result = BigInt(value); assert(result <= (1n << 256n) - 1n); return result;
  };
  const points = [1n, 10n].map(multiplier => {
    const matches = samples.filter((s: any) => String(s.multiplier) === String(multiplier));
    assert.equal(matches.length, 1, "unique saved P and 10P required");
    const sample = matches[0], amountIn = positive(sample.amountIn);
    assert.equal(amountIn, positive(sample.productionP) * multiplier);
    const executions = sample.executions?.filter((e: any) => e.encoding === "runtime-program");
    assert.equal(executions?.length, 1, "independent runtime execution required");
    const actual = executions[0];
    // A prior quote mismatch may mark status failed, but execution and observed
    // actor balances must independently have passed, including old inventory.
    assert.equal(actual.evmSucceeded, true); assert.equal(actual.executionChecks, "pass");
    assert.equal(BigInt(actual.oldInventoryConsumed), 0n);
    assert.equal(BigInt(actual.balances?.input?.delta), -amountIn);
    const priorActualOut = positive(actual.balances?.output?.delta);
    return { multiplier, amountIn, priorActualOut };
  });
  assert.equal(points[1].amountIn, points[0].amountIn * 10n);
  return points;
}
