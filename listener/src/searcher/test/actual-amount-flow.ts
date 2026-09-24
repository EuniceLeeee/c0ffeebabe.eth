import assert from "node:assert/strict";
import { test } from "node:test";
import { actualAmountCaseAdapter, actualAmountStepAdapter } from "../../adapters/actual-amount-flow.js";
import { concatBytes } from "../../encoder.js";
import type { ResolvedPlanNode } from "../../types.js";

const a = "0x0000000000000000000000000000000000000001";
const b = "0x0000000000000000000000000000000000000002";
for (const count of [3, 243, 255]) test(`generic flow compression losslessly preserves ${count} Family actions`, () => {
  const scripts = Array.from({ length: count }, (_, i) => {
    const script = new Uint8Array(220);
    script.fill(123); script[100] = i;
    return script;
  });
  scripts[2] = new Uint8Array([1, 2, 3]);
  scripts[0]!.fill(123); scripts[1]!.fill(123);
  scripts[1]![3] = 1; scripts[1]![4] = 2; scripts[1]![219] = 0;
  const cases = scripts.map((_, i): ResolvedPlanNode => ({ adapterId: "actual-amount-case",
    target: a, tokenIn: a, tokenOut: b, amount: BigInt(i + 1), params: { quotedAmountOut: 100n }, children: [] }));
  const packed = actualAmountStepAdapter.encode({ adapterId: "actual-amount-step", target: a,
    tokenIn: a, tokenOut: b, amount: 0n, params: {}, children: cases }, a,
  concatBytes(...scripts.map((s, i) => actualAmountCaseAdapter.encode(cases[i]!, a, s))));
  const u24 = (at: number) => packed[at]! * 65536 + packed[at + 1]! * 256 + packed[at + 2]!;
  const size = u24(44), base = packed.slice(47, 47 + size);
  let at = 47 + size;
  const modes: number[] = [];
  for (const script of scripts) {
    const mode = packed[at + 64]!, length = u24(at + 65); at += 68;
    const end = at + length;
    let decoded: Uint8Array;
    if (mode === 0) { decoded = packed.slice(at, end); at = end; }
    else {
      decoded = base.slice();
      while (at < end) {
        const offset = u24(at), n = packed[at + 3]!; at += 4;
        decoded.set(packed.slice(at, at + n), offset); at += n;
      }
    }
    assert.deepEqual(decoded, script); modes.push(mode);
  }
  assert.deepEqual(modes.slice(0, 3), [1, 1, 0]); assert.equal(at, packed.length);
  assert.equal(packed[40], count, "case count is not truncated");
});

test("case-count overflow fails before encoding", () => {
  const branch: ResolvedPlanNode = { adapterId: "actual-amount-case", target: a,
    tokenIn: a, tokenOut: b, amount: 1n, params: { quotedAmountOut: 2n }, children: [] };
  assert.throws(() => actualAmountStepAdapter.encode({
    adapterId: "actual-amount-step", target: a, tokenIn: a, tokenOut: b,
    amount: 0n, params: {}, children: Array.from({ length: 256 }, () => branch),
  }, a, new Uint8Array()), /invalid amount-flow records/);
});
