import assert from "node:assert/strict";
import test from "node:test";
import {
  CURVE_SEARCH_SELECTORS,
  decodeCurveUint256,
  decodeCurveUint256Array,
  decodeCurveUint256Array8,
  encodeCurveStateCall,
  trimCurveArray,
} from "../src/search-codec.ts";
import { CURVE_METAREGISTRY } from "../src/manifest.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const words = (...values: bigint[]) => `0x${values.map(word).join("")}`;

test("Curve search calls are selector- and target-bound", () => {
  const pool = address("a");
  assert.deepEqual(encodeCurveStateCall("A", pool), {
    target: pool,
    data: `0x${CURVE_SEARCH_SELECTORS.A.slice(2)}`,
    responseEncoding: "abi-curve-A-v1",
  });
  const balances = encodeCurveStateCall("underlyingBalances", pool);
  assert.equal(balances.target, CURVE_METAREGISTRY);
  assert.equal(balances.data, `0x${CURVE_SEARCH_SELECTORS.underlyingBalances.slice(2)}${word(BigInt(pool))}`);
  const dy = encodeCurveStateCall("getDyUnderlying", pool, [1, 0, "123"]);
  assert.equal(dy.target, pool);
  assert.equal(dy.data, `0x${CURVE_SEARCH_SELECTORS.getDyUnderlying.slice(2)}${word(1n)}${word(0n)}${word(123n)}`);
  assert.throws(() => encodeCurveStateCall("getDyUnderlying", pool), /indices are required/);
  assert.throws(() => encodeCurveStateCall("getDyUnderlying", pool, [2 ** 127, 0, "1"]), /int128/);
});

test("Curve search decodes fixed and dynamic ABI arrays without coercing shapes", () => {
  assert.equal(decodeCurveUint256(words(123n), "single"), 123n);
  const fixed = decodeCurveUint256Array8(words(1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n), "fixed");
  assert.deepEqual(fixed, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
  const dynamic = decodeCurveUint256Array(`0x${word(32n)}${word(2n)}${word(9n)}${word(10n)}`, "dynamic");
  assert.deepEqual(dynamic, [9n, 10n]);
  assert.deepEqual(trimCurveArray([4n, 5n, 0n, 0n], 2, "trim"), [4n, 5n]);
});

test("Curve search rejects malformed ABI returns and non-zero fixed-array tails", () => {
  assert.throws(() => decodeCurveUint256("0x01", "single"), /one uint256 ABI word/);
  assert.throws(() => decodeCurveUint256(`0x${"0".repeat(63)}g`, "single"), /raw even-length ABI bytes/);
  assert.throws(() => decodeCurveUint256Array8(words(1n, 2n), "fixed"), /exactly eight/);
  assert.throws(() => decodeCurveUint256(`0x${"0".repeat(128)}`, "single"), /one uint256 ABI word/);
  assert.throws(() => decodeCurveUint256Array(`0x${word(64n)}${word(0n)}`, "dynamic"), /invalid ABI array offset/);
  assert.throws(() => decodeCurveUint256Array(`0x${word(32n)}${word(2n)}${word(9n)}`, "dynamic"), /invalid ABI array length/);
  assert.throws(() => trimCurveArray([4n, 5n, 1n], 2, "trim"), /non-zero trailing/);
  assert.throws(() => trimCurveArray([4n], 2, "trim"), /outside the ABI array/);
});
