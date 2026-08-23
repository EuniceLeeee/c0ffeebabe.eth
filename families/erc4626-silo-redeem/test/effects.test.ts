import assert from "node:assert/strict";
import test from "node:test";
import { validateErc4626SiloRedeem, type Address } from "../kernel/effects.ts";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const vault = address("1");
const payoutToken = address("2");
const actor = address("3");
const other = address("4");
const uintWord = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

test("Silo binds returned amount, exact observation scope, share burn and payout", () => {
  const input = {
    completion: "returned" as const,
    returnDataHex: uintWord(5n),
    tokenDeltas: [
      { token: vault, account: actor, delta: -8n },
      { token: payoutToken, account: actor, delta: 5n },
    ],
    supplyDeltas: [{ token: vault, delta: -8n }],
    vault,
    payoutToken,
    actor,
    amountIn: 8n,
  };
  assert.equal(validateErc4626SiloRedeem(input), 5n);
  assert.throws(() => validateErc4626SiloRedeem({ ...input, returnDataHex: uintWord(6n) }));
  assert.throws(() => validateErc4626SiloRedeem({
    ...input,
    tokenDeltas: [...input.tokenDeltas, { token: payoutToken, account: other, delta: -1n }],
  }));
  assert.throws(() => validateErc4626SiloRedeem({
    ...input,
    supplyDeltas: [...input.supplyDeltas, { token: payoutToken, delta: 1n }],
  }));
});
