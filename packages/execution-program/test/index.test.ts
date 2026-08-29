import assert from "node:assert/strict";
import test from "node:test";
import {
  composePackedCallPrograms,
  decodeExecutorExecuteCalldata,
  decodePackedCallProgram,
  encodeExecutorExecuteCalldata,
  encodePackedCallProgram,
  hashEffectTransportDeclaration,
  normalizeEffectTransportDeclaration,
} from "../src/index.ts";

const first = { target: "0x1111111111111111111111111111111111111111" as const, value: "0", calldata: "0x1234" as const };
const second = { target: "0x2222222222222222222222222222222222222222" as const, value: "7", calldata: "0x" as const };

test("packed CALL scripts round-trip and compose in owner order", () => {
  const left = encodePackedCallProgram([first]);
  const right = encodePackedCallProgram([second]);
  const packed = composePackedCallPrograms([left, right]);
  assert.deepEqual(decodePackedCallProgram(packed), [first, second]);
  const calldata = encodeExecutorExecuteCalldata(packed);
  assert.equal(decodeExecutorExecuteCalldata(calldata), packed);
});

test("packed CALL codec rejects version, opcode, length, and ABI mutations", () => {
  const packed = encodePackedCallProgram([first]);
  assert.throws(() => decodePackedCallProgram(`0x02${packed.slice(4)}`), /version/);
  assert.throws(() => decodePackedCallProgram(`${packed.slice(0, 8)}02${packed.slice(10)}`), /opcode/);
  assert.throws(() => decodePackedCallProgram(`${packed}00`), /trailing|length/);
  const calldata = encodeExecutorExecuteCalldata(packed);
  assert.throws(() => decodeExecutorExecuteCalldata(`0x08${calldata.slice(4)}`), /selector/);
  assert.throws(() => decodeExecutorExecuteCalldata(`${calldata}00`), /padding|length/);
});

test("effect transport declaration preserves ordered calls and exact token/account scope", () => {
  const declaration = normalizeEffectTransportDeclaration({
    caller: { ref: { kind: "observed-sender" }, executionMode: "impersonated-call-frame" },
    preCalls: [{ caller: { ref: { kind: "observed-sender" }, executionMode: "impersonated-call-frame" }, to: first.target, data: "0x095ea7b3" }],
    observeTokenBalances: [
      { token: first.target, account: { kind: "observed-sender" } },
      { token: first.target, account: second.target },
    ],
    observeLogs: true,
  });
  assert.equal(declaration.preCalls[0]!.to, first.target);
  assert.equal(declaration.observeTokenBalances.length, 2);
  assert.equal(hashEffectTransportDeclaration(declaration).startsWith("0x"), true);
  assert.throws(() => normalizeEffectTransportDeclaration({
    ...declaration,
    observeTokenBalances: [...declaration.observeTokenBalances, declaration.observeTokenBalances[0]],
  }), /duplicate/);
  assert.throws(() => normalizeEffectTransportDeclaration({
    ...declaration,
    extra: true,
  }), /unknown field/);
});
