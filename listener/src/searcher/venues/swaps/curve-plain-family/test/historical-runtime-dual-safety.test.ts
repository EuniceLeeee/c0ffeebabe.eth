import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { assertNoInputRollback, curveHistoricalQuoteTargets, observedNativeInventory } from "./historical-runtime-dual.js";
import { curveRefreshGuardRequests } from "../refresh-scope.js";
import type { CurvePlainDescriptor } from "../types.js";

// Pure helper regressions only; these fixtures are not historical EVM evidence.
const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const TOKEN_IN = "0x2000000000000000000000000000000000000001";
const TOKEN_OUT = "0x2000000000000000000000000000000000000002";
const word = (n: bigint) => ethers.toBeHex(n, 32);

test("historical reads include current Family implementation guards without permitting unrelated targets", () => {
  const pool = "0x4dece678ceceb27446b35c672dc7d61f30bad69e";
  const implementation = "0xc629a01ec23ab04e1050500a3717a2a5c0701497";
  const descriptor = { pool, binding: { coins: [TOKEN_IN, TOKEN_OUT], quoteAbi: "int128",
    codeHash: ethers.keccak256(`0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`) },
  } as CurvePlainDescriptor;
  const targets = curveHistoricalQuoteTargets(descriptor);
  const guards = curveRefreshGuardRequests(descriptor);
  assert(guards.some(r => r.kind === "get-code" && r.address.toLowerCase() === implementation));
  for (const request of guards) {
    const address = request.kind === "get-code" ? request.address : request.kind === "eth-call" ? request.to : null;
    assert(address && targets.has(address.toLowerCase()));
  }
  assert.deepEqual([...targets].sort(), [pool, implementation].sort());
  assert(!targets.has(EXECUTOR) && !targets.has(TOKEN_IN));
  const unknown = { ...descriptor, binding: { ...descriptor.binding, codeHash: ethers.id("unknown-runtime") } };
  assert.deepEqual([...curveHistoricalQuoteTargets(unknown)].sort(), [pool, TOKEN_IN, TOKEN_OUT].sort());
  assert(!curveHistoricalQuoteTargets(unknown).has(implementation));
});

test("native diff distinguishes unchanged accounts/scalars from creation, deletion and balance changes", () => {
  const unchanged = { before: 17n, after: 17n, delta: 0n };
  assert.deepEqual(observedNativeInventory({ pre: {}, post: {} }, EXECUTOR, 17n), unchanged);
  for (const post of [{ nonce: 1 }, { storage: { [word(1n)]: word(2n) } }, { balance: "0x11" }]) {
    assert.deepEqual(observedNativeInventory({ pre: { [EXECUTOR]: { balance: "0x11" } },
      post: { [EXECUTOR]: post } }, EXECUTOR, 17n), unchanged);
  }
  for (const after of [0n, 16n, 18n]) {
    assert.throws(() => observedNativeInventory({ pre: { [EXECUTOR]: { balance: "0x11" } },
      post: { [EXECUTOR]: { balance: ethers.toQuantity(after) } } }, EXECUTOR, 17n), /changed native inventory/);
  }
  assert.throws(() => observedNativeInventory({ pre: { [EXECUTOR]: { balance: "0x11" } }, post: {} }, EXECUTOR, 17n));
  assert.throws(() => observedNativeInventory({ pre: {}, post: { [EXECUTOR]: { balance: "0x11" } } }, EXECUTOR, 17n), /native prestate/);
  assert.throws(() => observedNativeInventory(null, EXECUTOR, 17n), /prestate diff unavailable/);
});

test("zero input requires root revert and atomic inventory/authorization rollback, allowing only sender gas/nonce", () => {
  const inSlot = word(21n), outSlot = word(22n);
  const input = { trace: { error: "execution reverted" }, diff: { pre: {}, post: {} },
    tokenIn: TOKEN_IN, inSlot, tokenOut: TOKEN_OUT, outSlot, outputBefore: 1000000n,
    nativeBefore: 17n, finalAllowances: [[0n]] };
  const result = assertNoInputRollback(input);
  assert.equal(result.input.delta, 0n); assert.equal(result.output.delta, 0n); assert.equal(result.native.delta, 0n);
  assert.doesNotThrow(() => assertNoInputRollback({ ...input, diff: {
    pre: { [OWNER]: { balance: "0x100" } }, post: { [OWNER]: { balance: "0x80", nonce: 1 } },
  } }));
  for (const trace of [{}, { calls: [{ error: "execution reverted" }] }, { error: "out of gas" }]) {
    assert.throws(() => assertNoInputRollback({ ...input, trace }), /did not revert atomically/);
  }
  assert.throws(() => assertNoInputRollback({ ...input, diff: null }), /prestate diff unavailable/);
  for (const after of [999999n, 1000001n, 0n]) {
    assert.throws(() => assertNoInputRollback({ ...input, diff: {
      pre: { [TOKEN_OUT]: { storage: { [outSlot]: word(1000000n) } } },
      post: { [TOKEN_OUT]: { storage: { [outSlot]: word(after) } } },
    } }));
  }
  assert.throws(() => assertNoInputRollback({ ...input, diff: {
    pre: { [TOKEN_OUT]: { storage: { [outSlot]: word(1000000n) } } }, post: {},
  } }));
  assert.throws(() => assertNoInputRollback({ ...input, diff: {
    pre: { [TOKEN_IN]: { storage: { [inSlot]: word(1n) } } }, post: {},
  } }), /prestate disagrees/);
  assert.throws(() => assertNoInputRollback({ ...input, finalAllowances: [[1n]] }), /left ERC20 authorization/);
  assert.throws(() => assertNoInputRollback({ ...input, diff: {
    pre: {}, post: { [TOKEN_IN]: { storage: { [word(99n)]: word(1n) } } },
  } }), /non-sender state changes/);
  assert.throws(() => assertNoInputRollback({ ...input, diff: {
    pre: {}, post: { [OWNER]: { storage: { [word(99n)]: word(1n) } } },
  } }), /sender code\/storage/);
});
