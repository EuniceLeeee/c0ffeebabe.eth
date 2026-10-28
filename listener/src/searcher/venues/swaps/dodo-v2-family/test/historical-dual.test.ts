import assert from "node:assert/strict";
import test from "node:test";
import type { ObservedEffects } from "../../../adapter-request-program.js";
import { assertExecutorCodeProvenance, assertObservedLeg } from "./historical-dual.js";

const executor = "0x1000000000000000000000000000000000000002";
const input = "0x0000000000000000000000000000000000000011", output = "0x0000000000000000000000000000000000000012";
const effects = (): ObservedEffects => ({ tokenDeltas: [
  { token: input, account: executor, delta: -100n }, { token: output, account: executor, delta: 99n },
], nativeDeltas: [{ account: executor, delta: 0n }] });
test("optional executor provenance accepts omission but rejects malformed, wrong-address or wrong-code evidence", () => {
  const hash = "0x" + "ab".repeat(32), valid = { address: executor, keccak256: hash };
  for (const p of [undefined, null, valid]) assert.doesNotThrow(() => assertExecutorCodeProvenance(p, hash));
  for (const p of [false, "", {}, { ...valid, address: input }, { ...valid, address: null },
    { ...valid, keccak256: "0x" }, { ...valid, keccak256: "0x" + "00".repeat(32) }]) {
    assert.throws(() => assertExecutorCodeProvenance(p, hash));
  }
});
test("dual observation requires exact debit, independent output and native conservation", () => {
  assert.doesNotThrow(() => assertObservedLeg(effects(), input, output, 100n, 99n));
  assert.throws(() => assertObservedLeg(effects(), input, output, 101n, 99n));
  assert.throws(() => assertObservedLeg(effects(), input, output, 100n, 100n));
  assert.throws(() => assertObservedLeg(undefined, input, output, 100n, 99n));
  for (const e of [
    { ...effects(), tokenDeltas: [...effects().tokenDeltas!, effects().tokenDeltas![0]!] },
    { ...effects(), tokenDeltas: effects().tokenDeltas!.map(r => ({ ...r, account: input })) },
    { ...effects(), nativeDeltas: [{ account: executor, delta: -1n }] },
    { ...effects(), nativeDeltas: [] },
  ]) assert.throws(() => assertObservedLeg(e, input, output, 100n, 99n));
});
