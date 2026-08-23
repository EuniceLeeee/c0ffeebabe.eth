import assert from "node:assert/strict";
import test from "node:test";
import { decodeAddressWord, decodeReserves } from "../src/kernel/codec.ts";
import { verifyUniV2Identity } from "../src/kernel/identity.ts";
import { quoteV2ExactInput } from "../src/kernel/math.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");

test("constant-product quote matches the independent invariant oracle", () => {
  for (const [reserveIn, reserveOut, amountIn, fee] of [
    [1_000_000n, 2_000_000n, 10_000n, 30n],
    [17n, 91n, 3n, 5n],
    [(1n << 112n) - 1n, (1n << 111n) + 9n, 10n ** 30n, 100n],
  ] as const) {
    const output = quoteV2ExactInput(reserveIn, reserveOut, amountIn, fee);
    const effective = amountIn * (10_000n - fee);
    assert.equal(output, effective * reserveOut / (reserveIn * 10_000n + effective));
    assert.ok(output < reserveOut);
  }
  assert.throws(() => quoteV2ExactInput(1n, 1n, 1n, 10_000n), /feeBps/);
  assert.throws(() => quoteV2ExactInput(0n, 1n, 1n, 30n), /reserves/);
});

test("ABI word decoders reject padding and width mutations", () => {
  assert.equal(decodeAddressWord(`0x${"0".repeat(24)}${"a".repeat(40)}`), address("a"));
  assert.throws(() => decodeAddressWord(`0x01${"0".repeat(22)}${"a".repeat(40)}`), /padding/);
  const encoded = `0x${word(9n)}${word(13n)}${word(42n)}`;
  assert.deepEqual(decodeReserves(encoded), { reserve0: 9n, reserve1: 13n, blockTimestampLast: 42 });
  assert.throws(() => decodeReserves(`0x${word(1n << 112n)}${word(13n)}${word(42n)}`), /uint112/);
});

test("reverse factory binding is load-bearing in identity", () => {
  const facts = { pool: address("1"), factory: address("2"), token0: address("3"), token1: address("4"), reversePool: address("1") };
  const verified = verifyUniV2Identity(facts);
  assert.equal(verified.status, "verified");
  assert.deepEqual(verifyUniV2Identity({ ...facts, reversePool: address("5") }), { status: "chain-proven-rejected", reasonCode: "factory-reverse-binding-failed" });
  assert.deepEqual(verifyUniV2Identity({ ...facts, token1: facts.token0 }), { status: "chain-proven-rejected", reasonCode: "identical-assets" });
});
