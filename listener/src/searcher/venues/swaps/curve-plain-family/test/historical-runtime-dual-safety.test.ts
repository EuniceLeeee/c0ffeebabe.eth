import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { curveHistoricalExecutionProbe, curveHistoricalExecutionRules, assertNoInputRollback, curveHistoricalManualInput, curveHistoricalQuoteTargets, curveHistoricalReferenceInput, observedNativeInventory } from "./historical-runtime-dual.js";
import { curveRefreshGuardRequests } from "../refresh-scope.js";
import type { CurvePlainDescriptor } from "../types.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";

// Pure helper regressions only; these fixtures are not historical EVM evidence.
const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const TOKEN_IN = "0x2000000000000000000000000000000000000001";
const TOKEN_OUT = "0x2000000000000000000000000000000000000002";
const word = (n: bigint) => ethers.toBeHex(n, 32);

function amountDonor() {
  const source = { number: 123, hash: "0x" + "ab".repeat(32), generation: 2 };
  const parent = "0x" + "cd".repeat(32);
  const edge = { canonicalEdgeId: "donor-fixture", adapterId: "univ2-standard", target: OWNER,
    instanceKey: OWNER, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, slotKind: "swap" };
  const edgeId = blockScanEdgeKey(edge as any);
  const row = { ...edge, edgeId, status: "quoted", amountIn: 17n, amountOut: 900n,
    quotedAt: { number: 122, hash: parent, generation: 1 } };
  const cfg = { minCapitalFraction: 0.001 }, readyPath = "/fixture/ready.json", readySha256 = "33".repeat(32);
  const saved = { cfg, readyPath, readySha256, header: { ...source, parentHash: parent }, runtime: {
    sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
    graph: { edges: [edge] }, pricing: { sourceBlock: source.number, sourceBlockHash: source.hash,
      generation: source.generation, effectiveMids: { source, rows: new Map([[edgeId, row]]) } } } };
  const declaration = { benchmark: "effective-update", liveStarted: false, broadcast: false, signing: false,
    head: "44".repeat(20), cfg, graphEdges: 1, notifications: [source], bindings: [readyPath,
      "/fixture/listener/benchmarks/effective-update.ts", "/fixture/listener/src/searcher/blockscan-runtime-loop.ts",
      "/fixture/listener/src/searcher/main.ts"].map(path => ({ path, sha256: readySha256 })) };
  return { saved, declaration, edgeKeys: [edgeId] };
}
const missingReference = () => ({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
  status: "missing-valuation", amountIn: null, amountOut: null });

test("Curve donor mode borrows only authenticated input and keeps target missing valuation", () => {
  const row = missingReference(), before = structuredClone(row);
  const result = curveHistoricalReferenceInput(row, amountDonor());
  assert.equal(result.kind, "spliced-recorded-input"); assert.equal(result.amountIn, 17n);
  assert.equal(result.expectedOut, undefined); assert.equal(result.borrowed!.freshness, "carried");
  assert.equal(result.borrowed!.donorRow.amountOut, 900n, "donor output is provenance only");
  assert.match(result.borrowed!.naturalTargetValuation, /unmet/);
  assert.deepEqual(row, before, "must not relabel or overwrite the target row");
});

test("Curve donor mode cannot replace quoted target inputs or hide quote failures", () => {
  const row = { ...missingReference(), status: "quoted", amountIn: 21n, amountOut: 23n };
  assert.deepEqual(curveHistoricalReferenceInput(row, amountDonor()),
    { kind: "current-production-effective", amountIn: 21n, expectedOut: 23n, borrowed: undefined });
  for (const status of ["quote-failed", "unreachable", "capacity-exceeded"])
    assert.throws(() => curveHistoricalReferenceInput({ ...missingReference(), status }, amountDonor()), /missing valuation/);
  assert.throws(() => curveHistoricalReferenceInput(missingReference()), /explicitly bound donor/);
  assert.throws(() => curveHistoricalReferenceInput({ ...missingReference(), amountIn: 1n }, amountDonor()));
});

test("Curve donor mode retains shared token, graph, config and bounded-amount checks", () => {
  assert.throws(() => curveHistoricalReferenceInput({ ...missingReference(), tokenIn: EXECUTOR }, amountDonor()));
  const wrongGraph = amountDonor(); wrongGraph.saved.runtime.graph.edges = [];
  assert.throws(() => curveHistoricalReferenceInput(missingReference(), wrongGraph));
  const wrongConfig = amountDonor(); wrongConfig.saved.cfg = { minCapitalFraction: 1 };
  assert.throws(() => curveHistoricalReferenceInput(missingReference(), wrongConfig));
  const oversized = amountDonor(); oversized.saved.runtime.pricing.effectiveMids.rows.values().next().value!.amountIn = ethers.MaxUint256;
  assert.throws(() => curveHistoricalReferenceInput(missingReference(), oversized));
});

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

test("manual CLI inputs are explicit, bounded and independent of target price status", () => {
  const manual = curveHistoricalManualInput(JSON.stringify({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "73" }))!;
  for (const status of ["quoted", "missing-valuation", "quote-failed"]) {
    const row = { ...missingReference(), status, amountIn: status === "quoted" ? 17n : null, amountOut: status === "quoted" ? 19n : null };
    const before = structuredClone(row);
    assert.deepEqual(curveHistoricalReferenceInput(row, undefined, manual),
      { kind: "manual-cli", amountIn: 73n, expectedOut: undefined, borrowed: undefined });
    assert.deepEqual(row, before, "manual input must not change or promote the price row");
  }
  assert.equal(curveHistoricalManualInput(), undefined);
  assert.throws(() => curveHistoricalReferenceInput({ ...missingReference(), tokenIn: TOKEN_OUT }, undefined, manual), /direction mismatch/);
  assert.throws(() => curveHistoricalReferenceInput(missingReference(), amountDonor(), manual), /mixed donor/);
});

test("manual CLI rejects zero, precision loss, overflow, alien fields and invalid directions", () => {
  const input = { tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "73" };
  for (const amountIn of ["0", "-1", "1.5", "01", "1e18", 73, String(ethers.MaxUint256 - 100n)]) {
    assert.throws(() => curveHistoricalManualInput(JSON.stringify({ ...input, amountIn })));
  }
  for (const value of [null, [], { ...input, amountOut: "99" }, { ...input, tokenIn: "invalid" }, { ...input, tokenOut: TOKEN_IN }]) {
    assert.throws(() => curveHistoricalManualInput(JSON.stringify(value)));
  }
  assert.equal(curveHistoricalManualInput(JSON.stringify({ ...input, amountIn: String(ethers.MaxUint256 - 101n) }))!.amountIn, ethers.MaxUint256 - 101n);
});

test("counterfactual current executor rules must be explicit and match compiled and actual VM", () => {
  const historical = curveHistoricalExecutionRules(undefined, "cancun", "London");
  assert.equal(historical.mode, "historical-fork-default");
  assert.equal(historical.requestedHardfork, null);
  assert.equal(historical.actualHardfork, "London");
  const current = curveHistoricalExecutionRules("cancun", "cancun", "Cancun");
  assert.equal(current.mode, "counterfactual-current-executor");
  assert.equal(current.originalTransactionReplay, false);
  assert.throws(() => curveHistoricalExecutionRules("cancun", "shanghai", "Cancun"), /compiled executor/);
  assert.throws(() => curveHistoricalExecutionRules("cancun", "cancun", "London"), /did not apply/);
  for (const hardfork of ["latest", "london", "", "--no-mining"])
    assert.throws(() => curveHistoricalExecutionRules(hardfork, "cancun", "Cancun"));
  assert.throws(() => curveHistoricalExecutionRules("cancun", null, "Cancun"), /EVM target/);
  assert.throws(() => curveHistoricalExecutionRules("cancun", "cancun", null), /node hardfork/);
});

test("current executor probe checks execution-visible block, time, base fee and transient storage", () => {
  const header = { number: 14127510, timestamp: 1643816802, baseFeePerGas: 106022199063n };
  const words = [BigInt(header.number), BigInt(header.timestamp), header.baseFeePerGas, 1n, 99n];
  const encode = (v: bigint[]) => ethers.AbiCoder.defaultAbiCoder().encode(Array(v.length).fill("uint256"), v);
  assert.equal(curveHistoricalExecutionProbe(encode(words), header).opcode44, 99n);
  for (let i = 0; i < 4; i++) {
    const wrong = [...words]; wrong[i]++;
    assert.throws(() => curveHistoricalExecutionProbe(encode(wrong), header));
  }
  assert.throws(() => curveHistoricalExecutionProbe(encode(words.slice(0, 4)), header), /five words/);
});
