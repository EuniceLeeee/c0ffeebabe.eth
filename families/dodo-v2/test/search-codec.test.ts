import assert from "node:assert/strict";
import test from "node:test";
import {
  DODO_SEARCH_SELECTORS,
  decodeDodoFeeRate,
  decodeDodoPmm,
  decodeDodoQuery,
  encodeDodoStateCall,
} from "../src/search-codec.ts";
import { DODO_V2_QUOTE_ACTOR } from "../src/manifest.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const words = (...values: bigint[]) => `0x${values.map(word).join("")}`;

test("DODO search calls bind the pool, actor, route, and amount", () => {
  const pool = address("a");
  assert.deepEqual(encodeDodoStateCall("pmm", pool), {
    target: pool,
    data: `0x${DODO_SEARCH_SELECTORS.pmm.slice(2)}`,
    responseEncoding: "abi-dodo-pmm-v1",
  });
  const fee = encodeDodoStateCall("userFeeRate", pool);
  assert.equal(fee.data, `0x${DODO_SEARCH_SELECTORS.userFeeRate.slice(2)}${word(BigInt(DODO_V2_QUOTE_ACTOR))}`);
  const query = encodeDodoStateCall("querySellQuote", pool, "123");
  assert.equal(query.data, `0x${DODO_SEARCH_SELECTORS.querySellQuote.slice(2)}${word(BigInt(DODO_V2_QUOTE_ACTOR))}${word(123n)}`);
  assert.throws(() => encodeDodoStateCall("querySellBase", pool), /amount/);
  assert.throws(() => encodeDodoStateCall("querySellBase", pool, "-1"), /amount/);
});

test("DODO search decodes PMM, fee, and the single-word query return", () => {
  const pmm = decodeDodoPmm(words(2n, 3n, 4n, 5n, 6n, 7n, 1n));
  assert.deepEqual(pmm, { i: 2n, K: 3n, B: 4n, Q: 5n, B0: 6n, Q0: 7n, R: 1 });
  assert.deepEqual(decodeDodoFeeRate(words(10n, 20n)), { lpFeeRate: 10n, mtFeeRate: 20n });
  assert.equal(decodeDodoQuery(words(987n)), 987n);
});

test("DODO search rejects malformed ABI returns and invalid protocol domains", () => {
  assert.throws(() => decodeDodoPmm(words(1n, 2n, 3n)), /exactly 7/);
  assert.throws(() => decodeDodoPmm(words(1n, 2n, 3n, 4n, 5n, 6n, 3n)), /PMM enum/);
  assert.throws(() => decodeDodoFeeRate(words(10n ** 18n, 0n)), /fee domain/);
  assert.throws(() => decodeDodoQuery(`${words(987n)}00`, "query"), /exactly 1/);
  assert.throws(() => decodeDodoQuery(`${words(987n)}${words(12n).slice(2)}`, "query"), /exactly 1/);
  assert.throws(() => decodeDodoPmm(`0x${"0".repeat(63)}g`, "pmm"), /raw even-length/);
});
