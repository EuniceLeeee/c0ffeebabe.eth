import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { ethers } from "ethers";
import { createUniV2Exact } from "../venues/swaps/univ2-family/exact.js";
import { univ2Routes } from "../venues/swaps/univ2-family/routes.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";
import { UNIV2_MAX_RESERVE } from "../venues/swaps/univ2-family/reserve-capacity.js";
import { quoteV2ExactInput } from "../solver/v2-constant-product-math.js";
import type { UniV2Descriptor } from "../venues/swaps/univ2-family/types.js";
import type { ExactQuoteInput } from "../venues/adapter-family-plugin.js";
import type { UniV2Route } from "../venues/swaps/univ2-family/types.js";

const addr = (n: number) => ethers.toBeHex(n, 20);
const descriptor = { familyId: "univ2-standard", lineageId: "univ2-standard", instanceKey: addr(3),
  pool: addr(3), token0: addr(1), token1: addr(2), quoteModel: { kind: "constant-product" },
  feeRule: { kind: "constant-bps", feeBps: 30n, evidence: "standard-v2-default" },
  factoryBinding: { factory: addr(4), reversePool: addr(3) },
} as UniV2Descriptor;
const source = { number: 10, hash: ethers.toBeHex(10, 32), generation: 1 };
const [forward, reverse] = univ2Routes.project({ descriptor });
const exact = createUniV2Exact();
function input(amountIn: bigint, route = forward!, retain = true): ExactQuoteInput<UniV2Descriptor, UniV2Route> {
  return { descriptor, route, amountIn, source, executor: addr(5), runtimeEvidence: [],
    ...(retain ? { retainLocalState: true as const } : {}) };
}
function method(current: ReturnType<typeof input>) {
  const selected = exact.methods(current).find(m => m.kind === "request-program");
  assert(selected?.kind === "request-program");
  return selected;
}
function initial(current: ReturnType<typeof input>, reserve0 = 1_000_000n, reserve1 = 2_000_000n,
  balance0 = reserve0, balance1 = reserve1) {
  const selected = method(current);
  const results = selected.program.buildRequests(current).map(request => {
    assert(request.kind === "eth-call");
    const data = request.id === "exact-reserves"
      ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [reserve0, reserve1, 0])
      : UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [request.to === descriptor.token0 ? balance0 : balance1]);
    return { id: request.id, source, ok: true as const, completion: "returned" as const, data,
      provenance: { kind: "fixture" as const, fingerprint: "univ2-local-sequential" } };
  });
  return selected.program.decode({ programInput: current, initialResults: results, dependentEvidence: [] });
}

test("V2 carries actual post balances, both directions, without mutating another trial", () => {
  const first = initial(input(1_000n));
  const repeat = input(first.amountOut, reverse!);
  const transition = method(repeat).isolatedLocalState!;
  const second = transition.quote(repeat, first.evidence);
  assert.equal(second.amountOut, quoteV2ExactInput(2_000_000n - first.amountOut, 1_001_000n, first.amountOut, 30n));
  assert.notEqual(second.amountOut, initial(repeat).amountOut, "initial state would give a wrong repeat quote");
  const other = initial(input(2_000n));
  assert.notEqual(other.amountOut, first.amountOut);
  assert.deepEqual(transition.quote(repeat, first.evidence), second, "interleaved amount must not mutate first state");
  assert.deepEqual(initial(input(1_000n)), first, "source reserves must remain unchanged");
  const sameDirection = input(5_000n);
  assert.equal(method(sameDirection).isolatedLocalState!.quote(sameDirection, first.evidence).amountOut,
    quoteV2ExactInput(1_001_000n, 2_000_000n - first.amountOut, 5_000n, 30n));
  assert.throws(() => transition.quote(repeat, initial(input(1_000n, forward!, false)).evidence), /unavailable/);
  assert.throws(() => transition.quote({ ...repeat, source: { ...source, generation: 2 } }, first.evidence), /foreign/);
});

test("V2 unsynced donations enter both reserves, overflow and deficits fail closed", () => {
  const first = initial(input(1_000n), 1_000_000n, 2_000_000n, 1_000_900n, 2_000_700n);
  const next = input(first.amountOut, reverse!);
  assert.equal(method(next).isolatedLocalState!.quote(next, first.evidence).amountOut,
    quoteV2ExactInput(2_000_700n - first.amountOut, 1_001_900n, first.amountOut, 30n));
  assert.equal(initial(input(1_000n), 1_000_000n, 2_000_000n, UNIV2_MAX_RESERVE - 1n).amountOut, 0n);
  assert.equal(initial(input(1_000n), 1_000_000n, 2_000_000n, 1_000_000n, UNIV2_MAX_RESERVE + 10_000n).amountOut, 0n);
  assert.equal(initial(input(1_000n), 1_000_000n, 2_000_000n, 999_999n).amountOut, 0n);
});

test("ordinary reads unchanged; unsupported amount models and taxed transfers do not opt in", () => {
  assert.equal(method(input(1_000n, forward!, false)).program.buildRequests(input(1_000n, forward!, false)).length, 2);
  assert.equal(method(input(1_000n)).program.buildRequests(input(1_000n)).length, 3);
  const poolQuoted = { ...descriptor, quoteModel: { kind: "pool-get-amount-out", probe0: 1n, probe1: 1n } } as UniV2Descriptor;
  assert.equal(method({ ...input(1_000n), descriptor: poolQuoted }).isolatedLocalState, undefined);
  const taxed = { ...descriptor, tokenTransfers: [{ kind: "verified-transfer-tax", token: addr(1), codeHash: "tax",
    taxNumerator: 100n, taxDenominator: 10_000n }] } as unknown as UniV2Descriptor;
  assert.equal(method({ ...input(1_000n), descriptor: taxed }).isolatedLocalState, undefined);
});

test("warm local V2 transition same-work timing (descriptive, no RPC)", () => {
  const first = initial(input(1_000n));
  const current = input(first.amountOut, reverse!);
  const transition = method(current).isolatedLocalState!;
  for (let i = 0; i < 100; i++) transition.quote(current, first.evidence);
  const count = 2_000, t = performance.now();
  for (let i = 0; i < count; i++) transition.quote(current, first.evidence);
  console.log(JSON.stringify({ benchmark: "v2-local-transition", count, totalMs: performance.now() - t,
    physicalReadsOnRepeat: 0, scope: "same frozen evidence; pure transition, not full Solver/live" }));
});
