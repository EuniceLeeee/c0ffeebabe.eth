import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { classicMetaUpdateRequests } from "../../curve-underlying-family/classic-meta-update.js";
import type { CurveUnderlyingDescriptor } from "../../curve-underlying-family/types.js";
import { ethers } from "ethers";
import { curveHistoricalRecipient, assertCurveHistoricalDirectLeg, curveHistoricalBalanceMapping, assertCurveRecipientInventory, curveHistoricalAllowancePolicy, assertOutputRejection, curveHistoricalExecutionProbe, curveHistoricalExecutionRules, assertNoInputRollback, curveHistoricalManualInput, curveHistoricalQuoteTargets, curveHistoricalReferenceInput, observedNativeInventory } from "./historical-runtime-dual.js";
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


test("explicit output rejection requires the exact output-transfer error and untouched protocol state", () => {
  const pool = "0x3000000000000000000000000000000000000001";
  const error = "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["retired fixture"]).slice(2);
  const transfer = { type: "CALL", from: pool, to: TOKEN_OUT, input: new ethers.Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [EXECUTOR, 100n]),
    error: "execution reverted", output: error };
  const transferred = { type: "CALL", from: pool, to: TOKEN_IN,
    input: new ethers.Interface(["function transferFrom(address,address,uint256)"])
      .encodeFunctionData("transferFrom", [EXECUTOR, pool, 599n]), output: word(1n) };
  const poolCall = (calls: unknown[]) => ({ type: "CALL", to: pool, error: "execution reverted", calls });
  const base = { trace: { error: "execution reverted", calls: [poolCall([transferred, transfer])] },
    diff: { pre: {}, post: {} }, pool, tokenOut: TOKEN_OUT, expectedReason: "retired fixture",
    tokenIn: TOKEN_IN, inSlot: word(3n), inputBefore: 700n, nativeBefore: 17n, quotedAmountOut: 100n, requestedAmountIn: 599n };
  assert.equal(assertOutputRejection(base).input.delta, 0n);
  for (const output of [undefined, "", "0x"])
    assert.equal(assertOutputRejection({ ...base,
      trace: { error: "execution reverted", calls: [poolCall([{ ...transferred, output }, transfer])] } }).input.delta, 0n);
  for (const output of [null, "0x01", word(2n)])
    assert.throws(() => assertOutputRejection({ ...base,
      trace: { error: "execution reverted", calls: [poolCall([{ ...transferred, output }, transfer])] } }), /full input transfer/);
  assert.throws(() => assertOutputRejection({ ...base,
    trace: { error: "execution reverted", calls: [poolCall([{ ...transferred, error: "execution reverted" }, transfer])] } }), /full input transfer/);
  assert.throws(() => assertOutputRejection({ ...base,
    trace: { error: "execution reverted", calls: [poolCall([transferred]), poolCall([transfer])] } }), /full input transfer/);

  assert.throws(() => assertOutputRejection({ ...base, requestedAmountIn: 600n }), /full input transfer/);
  assert.throws(() => assertOutputRejection({ ...base,
    trace: { error: "execution reverted", calls: [poolCall([transfer, transferred])] } }), /full input transfer/);
  assert.throws(() => assertOutputRejection({ ...base,
    trace: { error: "execution reverted", calls: [poolCall([{ ...transferred, output: word(0n) }, transfer])] } }), /full input transfer/);
  assert.throws(() => assertOutputRejection({ ...base, trace: { calls: [transfer] } }), /did not revert/);
  assert.throws(() => assertOutputRejection({ ...base, expectedReason: "different error" }), /not observed/);
  assert.throws(() => assertOutputRejection({ ...base, tokenOut: TOKEN_IN }), /not observed/);
  assert.throws(() => assertOutputRejection({ ...base, quotedAmountOut: 101n }), /not observed/);
  assert.throws(() => assertOutputRejection({ ...base, trace: { error: "execution reverted", calls: [] } }), /not observed/);
  assert.throws(() => assertOutputRejection({ ...base,
    diff: { pre: { [TOKEN_IN]: { storage: { [word(3n)]: word(700n) } } },
      post: { [TOKEN_IN]: { storage: { [word(3n)]: word(699n) } } } } }), /consumed input/);
  assert.throws(() => assertOutputRejection({ ...base,
    diff: { pre: {}, post: { [pool]: { storage: { [word(0n)]: word(1n) } } } } }), /non-sender/);
});

test("historical allowance checks distinguish cleared Family programs from legacy standing grants", () => {
  for (const adapter of ["curve-exchange-underlying-lending", "curve-exchange-underlying-uint-native"]) {
    assert.equal(curveHistoricalAllowancePolicy(adapter, "exchange-underlying", 73n, 0n), "temporary-cleared");
    for (const residual of [1n, 73n, ethers.MaxUint256, ethers.MaxUint256 - 73n])
      assert.throws(() => curveHistoricalAllowancePolicy(adapter, "exchange-underlying", 73n, residual), /policy mismatch/);
  }
  for (const [adapter, mode] of [["curve-exchange-underlying", "exchange-underlying"], ["curve-exchange-plain", "exchange"]]) {
    for (const residual of [ethers.MaxUint256, ethers.MaxUint256 - 73n])
      assert.equal(curveHistoricalAllowancePolicy(adapter, mode, 73n, residual), "standing-grant");
    for (const residual of [0n, 1n, 73n])
      assert.throws(() => curveHistoricalAllowancePolicy(adapter, mode, 73n, residual), /policy mismatch/);
  }
  assert.equal(curveHistoricalAllowancePolicy("curve-exchange", "received", 73n, 0n), "no-grant");
  assert.throws(() => curveHistoricalAllowancePolicy("curve-exchange", "received", 73n, 1n), /policy mismatch/);
});

test("underlying historical reads retain the bound clock and exclude unrelated targets", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../curve-underlying-family/test/fixtures/classic-meta-update-binding.json", import.meta.url), "utf8"));
  const code = JSON.parse(gunzipSync(Buffer.from(fixture.codesGzipBase64, "base64")).toString());
  const model = {
    kind: "classic-meta-base-3pool-v1", poolCodeHash: ethers.keccak256(code.pool),
    metaRateMultiplier: 10n ** 18n, implementation: fixture.implementation,
    implementationCodeHash: ethers.keccak256(code.implementation),
    basePool: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
    baseCodeHash: "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc",
    baseLPToken: "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490",
    baseCoins: ["0x6b175474e89094c44da98b954eedeac495271d0f", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
    basePrecisions: [1n, 10n ** 12n, 10n ** 12n],
  };
  const descriptor = { pool: fixture.pool, quoteModel: model } as CurveUnderlyingDescriptor;
  const targets = curveHistoricalQuoteTargets(descriptor);
  assert(targets.has(fixture.clock), "bound underlying clock was excluded");
  assert.deepEqual([...targets].sort(), [fixture.pool, fixture.clock, fixture.implementation,
    model.basePool, model.baseLPToken, ...model.baseCoins].sort());
  for (const request of classicMetaUpdateRequests(descriptor)) {
    const address = request.kind === "eth-call" ? request.to : request.kind === "get-code" ? request.address : null;
    assert(address && targets.has(address.toLowerCase()), request.id);
  }
  assert(!targets.has(OWNER) && !targets.has(EXECUTOR) && !targets.has(TOKEN_IN));
  const unknown = { ...descriptor, quoteModel: { ...descriptor.quoteModel!, implementationCodeHash: ethers.ZeroHash } };
  assert(!curveHistoricalQuoteTargets(unknown).has(fixture.clock));
  const oldImplementation = "0x2c7796c0590cc100d70af473993890d457cb2ac9";
  const legacy = { ...descriptor, quoteModel: { ...descriptor.quoteModel!, implementation: oldImplementation,
    poolCodeHash: ethers.keccak256("0x366000600037611000600036600073" + oldImplementation.slice(2) + "5af4602c57600080fd5b6110006000f3"),
    implementationCodeHash: "0xdf4543ae0cb4d3878072c1da2c56ebec96a64237051a7291429a2fb66d5f54da" } };
  assert(!curveHistoricalQuoteTargets(legacy).has(fixture.clock));
  assert.deepEqual([...curveHistoricalQuoteTargets({ pool: fixture.pool } as CurveUnderlyingDescriptor)], [fixture.pool]);
  const lending = { pool: fixture.pool, coins: [TOKEN_OUT], lending: { lpToken: TOKEN_IN, wrappedCoins: [EXECUTOR] } } as CurveUnderlyingDescriptor;
  assert.deepEqual([...curveHistoricalQuoteTargets(lending)].sort(), [fixture.pool, TOKEN_IN, TOKEN_OUT, EXECUTOR].sort());
});

const RECIPIENT = "0x1000000000000000000000000000000000000004";
const RECIPIENT_IN_SLOT = word(31n), RECIPIENT_OUT_SLOT = word(32n), EXECUTOR_OUT_SLOT = word(22n);
const recipientInventory = { address: RECIPIENT, inSlot: RECIPIENT_IN_SLOT, outSlot: RECIPIENT_OUT_SLOT,
  inputBefore: 107n, outputBefore: 109n, nativeBefore: 19n };

test("optional recipient is a distinct valid test actor, never payer, token or protocol", () => {
  assert.equal(curveHistoricalRecipient(), undefined);
  assert.equal(curveHistoricalRecipient(RECIPIENT, [TOKEN_IN, TOKEN_OUT]), RECIPIENT);
  for (const value of ["invalid", "", ethers.ZeroAddress, OWNER, EXECUTOR])
    assert.throws(() => curveHistoricalRecipient(value));
  for (const reserved of [TOKEN_IN, TOKEN_OUT, RECIPIENT])
    assert.throws(() => curveHistoricalRecipient(reserved, [reserved]), /independent test actor/);
});

test("direct mode cannot accept null, undeclared capability or ignored/misdirected recipient", () => {
  const leg = { actionAdapterId: "curve-exchange-underlying", program: "0x0100",
    settlement: { directOutput: true }, settlementRequest: { kind: "direct-output", recipient: RECIPIENT } } as const;
  assert.doesNotThrow(() => assertCurveHistoricalDirectLeg(leg, RECIPIENT));
  assert.throws(() => assertCurveHistoricalDirectLeg(null, RECIPIENT), /does not support/);
  assert.throws(() => assertCurveHistoricalDirectLeg({ ...leg, settlement: undefined }, RECIPIENT), /not declared/);
  assert.throws(() => assertCurveHistoricalDirectLeg({ ...leg, settlementRequest: undefined }, RECIPIENT), /ignored or changed/);
  assert.throws(() => assertCurveHistoricalDirectLeg(leg, OWNER), /ignored or changed/);
});

test("recipient mapping independently proves two probes and preserves executor/holder controls", async () => {
  const good = word(31n), global = word(99n), bad = word(98n);
  const balance = async (_token: string, actor: string, overrides: any) => {
    const state = overrides[TOKEN_IN].stateDiff;
    if (bad in state) throw new Error("wrong proxy slot");
    if (global in state) return BigInt(state[global]);
    return actor === RECIPIENT ? BigInt(state[good] ?? 0n) : actor === EXECUTOR ? 0n : 41n;
  };
  const input = { token: TOKEN_IN, actor: RECIPIENT, controls: [
    { actor: EXECUTOR, balance: 0n }, { actor: OWNER, balance: 41n },
  ], candidates: [bad, global, good], balance };
  assert.equal(await curveHistoricalBalanceMapping(input), good);
  await assert.rejects(() => curveHistoricalBalanceMapping({ ...input, candidates: [global] }), /unresolved/);
  await assert.rejects(() => curveHistoricalBalanceMapping({ ...input, candidates: [bad] }), /unresolved/);
  await assert.rejects(() => curveHistoricalBalanceMapping({ ...input, controls: [] }), /independent control/);
  await assert.rejects(() => curveHistoricalBalanceMapping({ ...input, controls: [{ actor: RECIPIENT, balance: 0n }] }), /independent control/);
  const onlyFirstProbe = async (token: string, actor: string, overrides: any) => {
    const value = await balance(token, actor, overrides);
    return actor === RECIPIENT && value === 919191919193n ? value - 1n : value;
  };
  await assert.rejects(() => curveHistoricalBalanceMapping({ ...input, balance: onlyFirstProbe }), /unresolved/);
});

function directDiff() {
  return { pre: { [TOKEN_OUT]: { storage: { [RECIPIENT_OUT_SLOT]: word(109n) } } },
    post: { [TOKEN_OUT]: { storage: { [RECIPIENT_OUT_SLOT]: word(182n) } } } };
}
const directObservation = (diff: any) => assertCurveRecipientInventory({ diff, tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT, executorOutSlot: EXECUTOR_OUT_SLOT, executorOutputBefore: 103n, recipient: recipientInventory });

test("direct receipt is an independent recipient delta; old input/output/native inventory cannot supply it", () => {
  const result = directObservation(directDiff());
  assert.equal(result.recipientOutput.delta, 73n);
  assert.equal(result.executorOutput.delta, 0n);
  assert.equal(result.recipientInput.delta, 0n);
  assert.equal(result.recipientNative.delta, 0n);
  assert.throws(() => directObservation({ pre: {}, post: {} }), /did not change/);
  assert.throws(() => directObservation({ pre: {}, post: {}, transferReturn: word(1n), quotedOutput: 73n }), /did not change/);
  for (const after of [108n, 109n]) {
    const diff = directDiff(); diff.post[TOKEN_OUT].storage[RECIPIENT_OUT_SLOT] = word(after);
    assert.throws(() => directObservation(diff), /did not receive new output/);
  }
  for (const [token, slot, before, after] of [
    [TOKEN_OUT, EXECUTOR_OUT_SLOT, 103n, 102n], [TOKEN_OUT, EXECUTOR_OUT_SLOT, 103n, 176n],
    [TOKEN_IN, RECIPIENT_IN_SLOT, 107n, 106n], [TOKEN_IN, RECIPIENT_IN_SLOT, 107n, 108n],
  ] as const) {
    const diff: any = directDiff();
    (diff.pre[token] ??= { storage: {} }).storage[slot] = word(before);
    (diff.post[token] ??= { storage: {} }).storage[slot] = word(after);
    assert.throws(() => directObservation(diff), /inventory/);
  }
  const native: any = directDiff();
  native.pre[RECIPIENT] = { balance: "0x13" }; native.post[RECIPIENT] = { balance: "0x12" };
  assert.throws(() => directObservation(native), /native inventory/);
});

test("same-calldata no-input control also protects all recipient inventory", () => {
  const input = { trace: { error: "execution reverted" }, diff: { pre: {}, post: {} } as any,
    tokenIn: TOKEN_IN, inSlot: word(21n), tokenOut: TOKEN_OUT, outSlot: EXECUTOR_OUT_SLOT,
    outputBefore: 1000000n, nativeBefore: 17n, finalAllowances: [[0n]],
    recipient: { ...recipientInventory, outputBefore: 1000000n } };
  const result = assertNoInputRollback(input);
  assert("recipient" in result && result.recipient);
  assert.equal(result.recipient.recipientOutput.delta, 0n);
  assert.equal(result.recipient.recipientInput.delta, 0n);
  assert.equal(result.recipient.recipientNative.delta, 0n);
  for (const [address, field] of [[TOKEN_IN, RECIPIENT_IN_SLOT], [TOKEN_OUT, RECIPIENT_OUT_SLOT]] as const) {
    assert.throws(() => assertNoInputRollback({ ...input, diff: { pre: {},
      post: { [address]: { storage: { [field]: word(1n) } } } } }), /non-sender/);
  }
  assert.throws(() => assertNoInputRollback({ ...input, diff: { pre: {},
    post: { [RECIPIENT]: { balance: "0x12" } } } }), /non-sender/);
  assert.throws(() => assertNoInputRollback({ ...input, trace: {} }), /did not revert atomically/);
});
