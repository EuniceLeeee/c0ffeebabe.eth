import assert from "node:assert/strict";
import test from "node:test";
import { protocolRepeatEligible } from "../detector/blockscan-scanner-core.js";
import { resolveAllowProtocolRepeats } from "../detector/blockscan-paired-dfs.js";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const W = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

function edge(tokenIn: string, tokenOut: string, slotKind: string, instanceKey: string) {
  return { tokenIn, tokenOut, slotKind, instanceKey } as any;
}

test("protocol repeat: redemption close passes (original BoringVault cycle)", () => {
  // WETH -> asset -> share -> asset -> WETH
  const edges = [
    edge(W, A, "swap", "univ3"),
    edge(A, B, "swap", "univ4"),
    edge(B, A, "protocol", "boring"),
    edge(A, W, "swap", "univ3"),
  ];
  assert.equal(protocolRepeatEligible(edges), true);
});

test("protocol repeat: a second share purchase is swap-mediated and rejected", () => {
  // Real double-boring shape: buy share, redeem, buy share again with a swap,
  // redeem again. The second share occurrence is swap-mediated, so the policy
  // keeps only the single-redemption cycle.
  const edges = [
    edge(W, A, "swap", "univ3"),
    edge(A, B, "swap", "univ4"),
    edge(B, A, "protocol", "boring"),
    edge(A, B, "swap", "univ4"),
    edge(B, A, "protocol", "boring"),
    edge(A, W, "swap", "univ3"),
  ];
  assert.equal(protocolRepeatEligible(edges), false);
});

test("protocol repeat: swap-only round trip is rejected", () => {
  const edges = [
    edge(W, A, "swap", "p1"),
    edge(A, W, "swap", "p2"),
    edge(W, A, "swap", "p3"),
    edge(A, W, "swap", "p4"),
  ];
  assert.equal(protocolRepeatEligible(edges), false);
});

test("protocol repeat: more than two occurrences is rejected", () => {
  const edges = [
    edge(W, A, "swap", "p1"),
    edge(A, B, "protocol", "v1"),
    edge(B, A, "swap", "p2"),
    edge(A, B, "protocol", "v2"),
    edge(B, A, "swap", "p3"),
    edge(A, W, "swap", "p4"),
  ];
  assert.equal(protocolRepeatEligible(edges), false);
});

test("protocol repeat: same protocol instance cannot re-introduce its own output", () => {
  const edges = [
    edge(W, A, "swap", "p1"),
    edge(A, B, "protocol", "v1"),
    edge(B, A, "protocol", "v1"),
    edge(A, W, "swap", "p2"),
  ];
  assert.equal(protocolRepeatEligible(edges), false);
});

test("protocol repeat: simple cycles without repeats are unaffected", () => {
  const edges = [edge(W, A, "swap", "p1"), edge(A, B, "swap", "p2"), edge(B, W, "swap", "p3")];
  assert.equal(protocolRepeatEligible(edges), true);
});

test("protocol repeat: closing token is exempt even if used mid-cycle", () => {
  const edges = [
    edge(W, A, "swap", "p1"),
    edge(A, C, "swap", "p2"),
    edge(C, A, "protocol", "v1"),
    edge(A, W, "swap", "p3"),
  ];
  assert.equal(protocolRepeatEligible(edges), true);
});

test("protocol repeat: env resolver defaults on and validates", () => {
  assert.equal(resolveAllowProtocolRepeats(undefined), true);
  assert.equal(resolveAllowProtocolRepeats("0"), false);
  assert.equal(resolveAllowProtocolRepeats("1"), true);
  assert.throws(() => resolveAllowProtocolRepeats("2"));
  assert.throws(() => resolveAllowProtocolRepeats("true"));
});
