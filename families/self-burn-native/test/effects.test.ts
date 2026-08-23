import assert from "node:assert/strict";
import test from "node:test";
import { selfBurnProbeAmounts, validateSelfBurnNativeRedeem, type Address } from "../kernel/effects.ts";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const token = address("1");
const actor = address("2");
const other = address("3");
const TRUE_WORD = `0x${"0".repeat(63)}1`;

test("self-burn binds true return, exact effect scope and variable payout", () => {
  const input = {
    completion: "returned" as const,
    returnDataHex: TRUE_WORD,
    tokenDeltas: [{ token, account: actor, delta: -6n }],
    nativeDeltas: [{ account: actor, delta: 4n }],
    supplyDeltas: [{ token, delta: -6n }],
    token,
    actor,
    amountIn: 6n,
  };
  assert.equal(validateSelfBurnNativeRedeem(input), 4n);
  assert.throws(() => validateSelfBurnNativeRedeem({ ...input, returnDataHex: `0x${"0".repeat(64)}` }));
  assert.throws(() => validateSelfBurnNativeRedeem({
    ...input,
    tokenDeltas: [...input.tokenDeltas, { token, account: other, delta: 1n }],
  }));
  assert.deepEqual(selfBurnProbeAmounts(1_000n), [1n, 10n, 100n, 1_000n]);
  assert.deepEqual(selfBurnProbeAmounts(9n), [1n, 9n]);
});
