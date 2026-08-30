import assert from "node:assert/strict";
import test from "node:test";

import { decodeFluidDexSwapEvent } from "../src/abi.ts";
import { FLUID_DEX_CONTRACT_EVIDENCE_TOPIC } from "../src/manifest.ts";

const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const recipient = "0x045d21b97747686c4b4f8d70e6feeadcb3f6d345";
const recipientWord = recipient.slice(2).padStart(64, "0");
const realSwapData = "0x"
  + "0000000000000000000000000000000000000000000000000000000000000000"
  + "000000000000000000000000000000000000000000000000000000021f641ea0"
  + "000000000000000000000000000000000000000000000000000000021f656004"
  + "000000000000000000000000045d21b97747686c4b4f8d70e6feeadcb3f6d345";

test("Fluid DEX decodes the real four-word, non-indexed Swap event shape", () => {
  assert.deepEqual(
    decodeFluidDexSwapEvent([FLUID_DEX_CONTRACT_EVIDENCE_TOPIC], realSwapData, FLUID_DEX_CONTRACT_EVIDENCE_TOPIC),
    {
      swap0to1: false,
      amountIn: 9_116_589_728n,
      amountOut: 9_116_672_004n,
      recipient,
    },
  );
});

test("Fluid DEX rejects non-canonical Swap event mutations", () => {
  const data = (direction: bigint, amountIn: bigint, amountOut: bigint, toWord = recipientWord): string =>
    `0x${word(direction)}${word(amountIn)}${word(amountOut)}${toWord}`;
  const cases = [
    {
      label: "injected indexed topic",
      topics: [FLUID_DEX_CONTRACT_EVIDENCE_TOPIC, FLUID_DEX_CONTRACT_EVIDENCE_TOPIC],
      data: data(0n, 1n, 1n),
    },
    { label: "non-bool direction", topics: [FLUID_DEX_CONTRACT_EVIDENCE_TOPIC], data: data(2n, 1n, 1n) },
    { label: "zero input", topics: [FLUID_DEX_CONTRACT_EVIDENCE_TOPIC], data: data(0n, 0n, 1n) },
    { label: "zero output", topics: [FLUID_DEX_CONTRACT_EVIDENCE_TOPIC], data: data(0n, 1n, 0n) },
    {
      label: "non-canonical address padding",
      topics: [FLUID_DEX_CONTRACT_EVIDENCE_TOPIC],
      data: data(0n, 1n, 1n, `01${recipient.slice(2).padStart(62, "0")}`),
    },
    { label: "zero recipient", topics: [FLUID_DEX_CONTRACT_EVIDENCE_TOPIC], data: data(0n, 1n, 1n, word(0n)) },
    { label: "trailing word", topics: [FLUID_DEX_CONTRACT_EVIDENCE_TOPIC], data: `${data(0n, 1n, 1n)}${word(9n)}` },
  ] as const;
  for (const mutation of cases) {
    assert.throws(
      () => decodeFluidDexSwapEvent(mutation.topics, mutation.data, FLUID_DEX_CONTRACT_EVIDENCE_TOPIC),
      mutation.label,
    );
  }
});
