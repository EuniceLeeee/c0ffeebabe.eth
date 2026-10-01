import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { BLOCKSCAN_MULTICALL3, blockScanMulticallIface } from "../../../../blockscan-multicall.js";
import { getSqrtRatioAtTick } from "../../../../solver/v3-math.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import type { ExactQuoteInput } from "../../../adapter-family-plugin.js";
import { univ4StrictFamilyPlugin } from "../../univ4-family-plugin.js";
import { v4PoolId } from "../../univ4-common.js";
import { UNIV4_STATE_VIEW_INTERFACE, UNIV4_QUOTER_INTERFACE } from "../../univ4-abi.js";
import { createUniV4Exact } from "../exact.js";
import { UNIV4_LOCAL_TICK_INTERFACE, localV4StateRequests, localV4DependentRequests, readLocalV4State } from "../local-state.js";
import type { UniV4Descriptor, UniV4Route } from "../types.js";

type Input = ExactQuoteInput<UniV4Descriptor, UniV4Route>;
const SOURCE: CanonicalSource = { number: 26_090_582, hash: `0x${"ab".repeat(32)}`, generation: 3 };
const Q96 = 1n << 96n;
const BALANCE = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function getEthBalance(address) view returns (uint256)"]);
const TOKEN0 = "0x1000000000000000000000000000000000000001";
const TOKEN1 = "0x2000000000000000000000000000000000000002";
const EXECUTOR = "0x3000000000000000000000000000000000000003";

function fixture(native = false, reverse = false, spacing = 60): Input {
  const poolKey = { currency0: native ? ethers.ZeroAddress : TOKEN0, currency1: TOKEN1,
    fee: 3_000, tickSpacing: spacing, hooks: ethers.ZeroAddress };
  const candidate = { candidateKind: "univ4-pool-key" as const, sourceKind: "pool-surface" as const,
    manager: ADDR.UNISWAP_V4_POOL_MANAGER, poolId: v4PoolId(poolKey), poolKey };
  const decision = univ4StrictFamilyPlugin.identity.variants[0]!.decide({ candidate, step: 1,
    evidence: { phase: "manager-active-proof", managerCodeHash: `0x${"11".repeat(32)}`,
      sqrtPriceX96: Q96, liquidity: 10n ** 18n } });
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") throw new Error("V4 test identity");
  const descriptor = univ4StrictFamilyPlugin.instance.finalizeDescriptor({ identity: decision.identity,
    draft: univ4StrictFamilyPlugin.instance.compileDraft(decision.identity), sharedBindings: [] });
  return { descriptor, route: univ4StrictFamilyPlugin.routes.project({ descriptor })[reverse ? 1 : 0]!,
    source: SOURCE, executor: EXECUTOR, amountIn: 10n ** 12n, runtimeEvidence: [] };
}

function success(id: string, data: string, source = SOURCE): AdapterRequestResult {
  return { id, data, source, ok: true, completion: "returned",
    provenance: { kind: "fixture", fingerprint: id } };
}
function call(request: AdapterRequest) {
  assert.equal(request.kind, "eth-call");
  if (request.kind !== "eth-call") throw new Error("test call expected");
  return request;
}
function core(input: Input, opts: { tick?: number; sqrt?: bigint; liquidity?: bigint; balance?: bigint; lpFee?: bigint; protocolFee?: bigint } = {}) {
  const [slot, liquidity, balance] = localV4StateRequests(input);
  const tick = opts.tick ?? 0;
  return [success(slot!.id, UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getSlot0",
    [opts.sqrt ?? getSqrtRatioAtTick(tick), tick, opts.protocolFee ?? 0n, opts.lpFee ?? 3_000n])),
  success(liquidity!.id, UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getLiquidity", [opts.liquidity ?? 10n ** 18n])),
  success(balance!.id, BALANCE.encodeFunctionResult("balanceOf", [opts.balance ?? 10n ** 30n]))];
}
function calls(request: AdapterRequest) {
  return blockScanMulticallIface.decodeFunctionData("aggregate3", call(request).data)[0] as readonly { callData: string; target: string; allowFailure: boolean }[];
}
function aggregate(request: AdapterRequest, values: readonly string[]) {
  return success(request.id, blockScanMulticallIface.encodeFunctionResult("aggregate3", [
    values.map(returnData => ({ success: true, returnData })),
  ]));
}
function bitmap(input: Input, results: readonly AdapterRequestResult[], value: (word: number) => bigint = () => 0n) {
  const next = localV4DependentRequests(input, results);
  assert.equal(next?.length, 1);
  const req = next![0]!;
  const indexes = calls(req).map(item => Number(UNIV4_LOCAL_TICK_INTERFACE.decodeFunctionData("getTickBitmap", item.callData)[1]));
  return { indexes, result: aggregate(req, indexes.map(index =>
    UNIV4_LOCAL_TICK_INTERFACE.encodeFunctionResult("getTickBitmap", [value(index)]))) };
}

test("V4 state requests bind direction/native payout and have no amount-dependent calldata", () => {
  for (const native of [false, true]) for (const reverse of [false, true]) {
    const input = fixture(native, reverse), requests = localV4StateRequests(input);
    assert.deepEqual(requests, localV4StateRequests({ ...input, amountIn: input.amountIn * 1000n }));
    assert.equal(call(requests[0]!).to, input.descriptor.managerBinding.stateView);
    const balance = call(requests[2]!);
    assert.equal(balance.to, reverse ? native ? BLOCKSCAN_MULTICALL3 : TOKEN0 : TOKEN1);
    const method = native && reverse ? "getEthBalance" : "balanceOf";
    assert.equal(BALANCE.decodeFunctionData(method, balance.data)[0].toLowerCase(), ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase());
  }
});

test("V4 49 words floor negative tick compression and preserve known zero words", () => {
  const input = fixture(false, false, 10), results = core(input, { tick: -1, sqrt: Q96 });
  const words = bitmap(input, results);
  assert.equal(words.indexes.length, 49);
  assert.equal(words.indexes[0], -25);
  assert.equal(words.indexes.at(-1), 23);
  const all = [...results, words.result];
  assert.equal(localV4DependentRequests(input, all), null);
  const state = readLocalV4State(input, all)!;
  assert.equal(state.tickBitmap.size, 49);
  assert.equal(state.tickBitmap.get(-1), 0n);
  assert.equal(state.tickBitmap.get(-26), undefined);
  assert.equal(state.ticks.size, 0);
});

test("V4 reads initialized tick gross/net and rejects missing, duplicate or malformed liquidity", () => {
  const input = fixture(), results = core(input);
  const words = bitmap(input, results, word => word === -1 ? 1n << 255n : word === 0 ? 2n : 0n);
  const initial = [...results, words.result], requests = localV4DependentRequests(input, initial)!;
  assert.equal(requests.length, 1);
  assert.deepEqual(calls(requests[0]!).map(item => Number(UNIV4_LOCAL_TICK_INTERFACE.decodeFunctionData("getTickLiquidity", item.callData)[1])), [-60, 60]);
  const tickResult = aggregate(requests[0]!, [
    UNIV4_LOCAL_TICK_INTERFACE.encodeFunctionResult("getTickLiquidity", [1_000n, 800n]),
    UNIV4_LOCAL_TICK_INTERFACE.encodeFunctionResult("getTickLiquidity", [1_000n, -900n]),
  ]);
  const all = [...initial, tickResult];
  assert.equal(localV4DependentRequests(input, all), null);
  assert.deepEqual([...readLocalV4State(input, all)!.ticks], [[-60, 800n], [60, -900n]]);
  assert.throws(() => readLocalV4State(input, initial), /missing/);
  assert.throws(() => localV4DependentRequests(input, [...all, tickResult]), /duplicate/);
  for (const pair of [[0n, 0n], [10n, 11n], [10n, -11n]]) {
    const bad = aggregate(requests[0]!, [UNIV4_LOCAL_TICK_INTERFACE.encodeFunctionResult("getTickLiquidity", pair),
      UNIV4_LOCAL_TICK_INTERFACE.encodeFunctionResult("getTickLiquidity", [1000n, 0n])]);
    assert.throws(() => readLocalV4State(input, [...initial, bad]), /invalid initialized/);
  }
  assert.throws(() => readLocalV4State(input, [...initial, aggregate(requests[0]!, [])]), /incomplete/);
});

test("V4 malformed/failed/foreign state fails closed, never turns into a local cache success", () => {
  const input = fixture(), good = core(input);
  for (const index of [0, 1, 2]) {
    assert.throws(() => localV4DependentRequests(input, good.filter((_, i) => i !== index)), /missing/);
    assert.throws(() => localV4DependentRequests(input, [...good, good[index]!]), /duplicate/);
    const mutate = (item: AdapterRequestResult) => good.map((v, i) => i === index ? item : v);
    assert.throws(() => localV4DependentRequests(input, mutate({ id: good[index]!.id, ok: false, source: SOURCE, failure: "rpc" })), /failed/);
    assert.throws(() => localV4DependentRequests(input, mutate({ ...success(good[index]!.id, "0x"), completion: "reverted-as-declared" } as AdapterRequestResult)), /failed/);
    for (const source of [{ ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, generation: SOURCE.generation + 1 }, { ...SOURCE, hash: ethers.ZeroHash }]) {
      assert.throws(() => localV4DependentRequests(input, mutate({ ...good[index]!, source })), /different sources/);
    }
  }
  for (const opts of [{ lpFee: 1_000_001n }, { protocolFee: 1_001n }, { protocolFee: 1_001n << 12n }]) {
    assert.throws(() => localV4DependentRequests(input, core(input, opts)), /invalid local fee/);
  }
  assert.throws(() => localV4DependentRequests(input, core(input, { tick: 1, sqrt: Q96 })), /price\/tick/);
  const slot = good[0]!;
  if (!slot.ok) throw new Error("fixture");
  assert.throws(() => localV4DependentRequests(input, [{ ...slot, data: slot.data + "00".repeat(32) }, ...good.slice(1)]), /non-canonical/);
  const words = bitmap(input, good);
  assert.throws(() => readLocalV4State(input, [...good, { ...words.result, source: { ...SOURCE, generation: 99 } }]), /different sources/);
});

test("V4 oversized initialized tick coverage declines local state without truncation", () => {
  const input = fixture(false, false, 1), results = core(input);
  const words = bitmap(input, results, () => (1n << 256n) - 1n), all = [...results, words.result];
  assert.equal(localV4DependentRequests(input, all), null);
  assert.equal(readLocalV4State(input, all), null);
});

test("V4 default uses truthful local evidence; ordered trials and reference mode keep Quoter", () => {
  const input = fixture(), exact = createUniV4Exact(), method = exact.methods(input)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("fixture method");
  assert.equal(method.chainAmountQuote, undefined);
  assert.equal(method.stateOnlyReads, undefined, "shared manager balance cannot carry under one pool's touched key");
  assert.equal(typeof method.trialState?.unsupportedReason, "string");
  for (const throughChain of [createUniV4Exact("quoter").methods(input)[1]!, exact.methods({ ...input, trialState: { get: () => undefined } })[1]!]) {
    assert.equal(throughChain.kind, "request-program");
    if (throughChain.kind !== "request-program") throw new Error("fixture method");
    assert.equal(throughChain.chainAmountQuote, true);
    assert.equal(throughChain.program.buildRequests(input).length, 2);
  }
  const initial = core(input), words = bitmap(input, initial);
  const round = { results: [words.result] };
  assert.equal(method.program.buildDependentProgram!({ programInput: input, initialResults: initial, priorEvidence: [round], completedRound: 1 }), null);
  const quoted = method.program.decode({ programInput: input, initialResults: initial, dependentEvidence: [round] });
  assert(quoted.amountOut > 0n);
  assert.equal(quoted.evidence.kind, "univ4-no-hook-local");
  assert.equal(quoted.evidence.amountIn, input.amountIn);
  assert.equal(quoted.evidence.gasEstimate, 0n);
  const fragment = univ4StrictFamilyPlugin.execution.buildFragment({ ...input, quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut, exactEvidence: quoted.evidence });
  assert.equal(fragment.nodes[0]!.adapterId, "univ4-unlock");
  assert.throws(() => univ4StrictFamilyPlugin.execution.buildFragment({ ...input, quotedAmountOut: quoted.amountOut + 1n,
    minAmountOut: quoted.amountOut, exactEvidence: quoted.evidence }), /incompatible exact evidence/);
  assert.throws(() => method.program.decode({ programInput: input, initialResults: core(input, { balance: quoted.amountOut - 1n }), dependentEvidence: [round] }), /output-balance-capacity/);
});

test("V4 coverage and supported-domain fallback quote the unchanged full amount", () => {
  for (const opts of [{ liquidity: 1n }, { lpFee: 1_000_000n }]) {
    const input = fixture(), method = createUniV4Exact().methods(input)[1]!;
    if (method.kind !== "request-program") throw new Error("fixture method");
    const initial = core(input, opts), words = bitmap(input, initial), prior = [{ results: [words.result] }];
    const fallback = method.program.buildDependentProgram!({ programInput: input, initialResults: initial, priorEvidence: prior, completedRound: 1 });
    assert(fallback);
    assert.equal(fallback.requests.length, 2);
    const request = call(fallback.requests[0]!);
    assert.equal(UNIV4_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", request.data)[0].exactAmount, input.amountIn);
    const fallbackResults = [success(request.id, UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [123n, 50_000n])),
      success(fallback.requests[1]!.id, BALANCE.encodeFunctionResult("balanceOf", [123n]))];
    const dependentEvidence = [...prior, fallback.decode(fallbackResults)];
    assert.equal(method.program.buildDependentProgram!({ programInput: input, initialResults: initial, priorEvidence: dependentEvidence, completedRound: 2 }), null);
    const quote = method.program.decode({ programInput: input, initialResults: initial, dependentEvidence });
    assert.equal(quote.amountOut, 123n);
    assert.equal(quote.evidence.kind, "univ4-no-hook-quoter");
    assert.equal(quote.evidence.amountIn, input.amountIn);
  }
});
