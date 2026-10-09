import assert from "node:assert/strict";
import test from "node:test";
import { assertObservedLeg } from "./historical-dual.js";

test("historical dual observer rejects quote substitution, partial debit and inventory use", () => {
  const actor = "0x1000000000000000000000000000000000000002";
  const tokens = ["0x2000000000000000000000000000000000000001", "0x2000000000000000000000000000000000000002", "0x2000000000000000000000000000000000000003"];
  const good = { tokenDeltas: tokens.map((token, i) => ({ token, account: actor, delta: [-100n, 201n, 0n][i]! })), nativeDeltas: [{ account: actor, delta: 0n }] };
  const check = (v: typeof good) => assertObservedLeg(v, tokens[0]!, tokens[1]!, tokens[2]!, 100n, 201n);
  check(good);
  for (const [i, delta] of [[0, -99n], [0, -101n], [1, 200n], [2, -1n]] as const) {
    const changed = structuredClone(good); changed.tokenDeltas[i]!.delta = delta; assert.throws(() => check(changed));
  }
  assert.throws(() => check({ ...good, nativeDeltas: [{ account: actor, delta: -1n }] }));
  assert.throws(() => check({ ...good, tokenDeltas: [...good.tokenDeltas, good.tokenDeltas[0]!] }));
});
