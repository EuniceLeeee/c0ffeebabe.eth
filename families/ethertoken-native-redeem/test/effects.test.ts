import assert from "node:assert/strict";
import test from "node:test";
import { validateEtherTokenNativeRedeem, type Address } from "../kernel/effects.ts";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const token = address("1");
const actor = address("2");
const other = address("3");

test("EtherToken requires empty return bytes and exact native redemption scope", () => {
  const input = {
    completion: "returned" as const,
    returnDataHex: "0x",
    tokenDeltas: [{ token, account: actor, delta: -6n }],
    nativeDeltas: [{ account: actor, delta: 6n }],
    supplyDeltas: [{ token, delta: -6n }],
    token,
    actor,
    amountIn: 6n,
  };
  assert.equal(validateEtherTokenNativeRedeem(input), 6n);
  assert.throws(() => validateEtherTokenNativeRedeem({ ...input, returnDataHex: "0x00" }));
  assert.throws(() => validateEtherTokenNativeRedeem({
    ...input,
    nativeDeltas: [...input.nativeDeltas, { account: other, delta: -1n }],
  }));
});
