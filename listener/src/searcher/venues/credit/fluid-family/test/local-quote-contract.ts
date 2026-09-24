import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { FLUID_CAPACITY_ABI, FLUID_CAPACITY_ID, FLUID_VAULT_T1_RESOLVER,
  decodeFluidCapacity, fluidCapacityRequests, type FluidCreditCapacity } from "../capacity.js";
import { fluidMaxBorrowRequest, fluidMaxInputForBorrowCapacity } from "../borrow-math.js";
import { fluidCreditDomain } from "../credit.js";
import { createFluidCreditExact, fluidCreditLocalExactProgram } from "../exact.js";
import { fluidLocalBorrowQuote } from "../local-quote.js";
import { fluidCreditExecution } from "../execution.js";
import type { FluidCreditDescriptor, FluidCreditRoute } from "../types.js";
import { BORROW_STATE, capacityFixture } from "./quote-fixture.js";

export function verifyFluidLocalQuoteContract(input: { descriptor: FluidCreditDescriptor; route: FluidCreditRoute;
  source: CanonicalSource; executor: string }): void {
  const { descriptor, route, source } = input;
  const originalInput = structuredClone(input);
  const initialResults = capacityFixture(source, descriptor);
  const originalResults = structuredClone(initialResults);
  const state = decodeFluidCapacity(descriptor, initialResults, source);
  const program = fluidCreditLocalExactProgram;
  const quoteInput = (amountIn: bigint) => ({ ...input,
    descriptor: { ...descriptor, localQuoteModel: "t1-view-v1" as const }, amountIn, runtimeEvidence: [] });
  const quote = (amountIn: bigint, results = initialResults) => program.decode({ programInput: quoteInput(amountIn),
    initialResults: results, dependentEvidence: [] });
  const first = initialResults[0];
  assert(first.ok);
  assert.equal((first.data.length - 2) / 32 / 2, 88, "all 88 static tuple words must remain in their deployed positions");
  assert.equal(state.vaultType, "T1");
  assert.equal(state.borrowable, 30_833_211_853n);
  assert.equal(state.minimumBorrowing, 10376n);
  for (const key of Object.keys(BORROW_STATE) as (keyof typeof BORROW_STATE)[]) {
    assert.equal(state[key], BORROW_STATE[key], `resolver and existing state agree on ${key}`);
  }
  const request = fluidCapacityRequests(descriptor.vault)[0];
  assert.equal(request.kind, "eth-call");
  if (request.kind !== "eth-call") throw new Error("expected resolver state call");
  assert.equal(request.to, FLUID_VAULT_T1_RESOLVER);
  assert.equal(request.id, FLUID_CAPACITY_ID);
  assert.equal(request.completion, "return-data");
  assert.equal(FLUID_CAPACITY_ABI.decodeFunctionData("getVaultEntireData", request.data)[0], ethers.getAddress(descriptor.vault));
  assert.deepEqual(program.requirements(quoteInput(10n ** 18n)), { transports: ["eth-call"] });
  assert.equal(program.buildDependentProgram, undefined, "amount quote never starts a simulation or another read round");
  const local = createFluidCreditExact("local"), simulation = createFluidCreditExact("simulate");
  const supportedInput = { ...quoteInput(10n ** 18n), descriptor: { ...descriptor, localQuoteModel: "t1-view-v1" as const } };
  const localMethod = local.methods(supportedInput)[0];
  assert.equal(localMethod.program, program);
  assert.equal(Object.hasOwn(localMethod, "chainAmountQuote"), false, "local math does not masquerade as chain-produced output");
  assert.equal(Object.hasOwn(localMethod, "stateOnlyReads"), false, "time-dependent rates/limits cannot promise cross-source reuse");
  assert.equal(simulation.methods(supportedInput)[0].chainAmountQuote, true);
  assert.equal(local.methods({ ...supportedInput, descriptor: { ...descriptor, localQuoteModel: undefined } })[0].chainAmountQuote,
    true, "unknown bytecode must retain execution quoting, not assume the current T1 model");
  assert.throws(() => program.buildRequests({ ...supportedInput, descriptor: { ...descriptor, localQuoteModel: undefined } }),
    /verified runtime model/);
  assert.notDeepEqual(local.cacheCompatibilityProjection(quoteInput(10n ** 18n)),
    simulation.cacheCompatibilityProjection(quoteInput(10n ** 18n)), "local and effect-proven cache evidence remain distinct");

  let previous = 0n;
  for (const amountIn of [10n ** 18n, 17n * 10n ** 18n, 1766743380904387863297n]) {
    const result = quote(amountIn);
    assert.deepEqual(program.buildRequests(quoteInput(amountIn)), [request], "amount changes do not change state reads");
    assert.equal(result.amountOut, fluidMaxBorrowRequest(amountIn, BORROW_STATE));
    assert.equal(result.amountOut, fluidLocalBorrowQuote(amountIn, state));
    assert(result.amountOut > previous); previous = result.amountOut;
    assert(result.amountOut < amountIn * state.oracleRate * state.collateralFactorBps / (10n ** 27n * 10000n),
      "local output preserves tick/fee/integer amount math, not linear mid multiplication");
    assert.equal(result.evidence.kind, "fluid-credit-local-amount");
    assert.equal(result.evidence.collateralAmount, amountIn);
    assert.equal(result.evidence.debtAmount, result.amountOut);
    assert.equal(result.evidence.executor, input.executor);
    assert.equal(result.evidence.routeKey, route.routeKey);
    assert.deepEqual(result.evidence.source, source);
    assert.equal("nftId" in result.evidence, false, "local math cannot invent an opened position");
    assert.equal("debtDelta" in result.evidence, false, "local math cannot invent observed receipts");
    const executionInput = { ...quoteInput(amountIn), quotedAmountOut: result.amountOut,
      minAmountOut: result.amountOut, exactEvidence: result.evidence };
    const fragment = fluidCreditExecution.buildFragment(executionInput);
    assert.equal(fragment.nodes[0].amount, amountIn);
    assert.equal(fragment.nodes[0].params.debtDelta, result.amountOut);
    assert.throws(() => fluidCreditExecution.buildFragment({ ...executionInput, amountIn: amountIn + 1n }), /incompatible local/);
    assert.throws(() => fluidCreditExecution.buildFragment({ ...executionInput, quotedAmountOut: result.amountOut + 1n }), /incompatible local/);
    assert.throws(() => fluidCreditExecution.buildFragment({ ...executionInput,
      descriptor: { ...descriptor, localQuoteModel: undefined } }), /incompatible local/);
    assert.throws(() => fluidCreditExecution.buildFragment({ ...executionInput,
      exactEvidence: { ...result.evidence, source: { ...source, number: source.number + 1 } } }), /foreign source/);
    const riskInput = { ...input, collateralAmount: amountIn, debtBps: 10000n, runtimeEvidence: [] };
    assert.throws(() => fluidCreditDomain.risk.quoteOutputByDebtBps({ ...riskInput,
      evidence: result.evidence as never }), /requires compatible/, "risk needs separate operate evidence");
    assert.throws(() => fluidCreditDomain.risk.evidence.decode({ programInput: riskInput,
      results: initialResults }), /missing/, "resolver bytes cannot stand in for an operate receipt");
  }
  assert.notEqual(quote(17n * 10n ** 18n).amountOut, quote(10n ** 18n).amountOut * 17n,
    "amount-specific rounding is not a point quote multiplied by 17");
  for (const invalid of [0n, -1n, 9999n, 1n << 127n]) {
    assert.throws(() => program.buildRequests(quoteInput(invalid)), /int128/);
    assert.throws(() => quote(invalid), /int128/);
    assert.throws(() => fluidLocalBorrowQuote(invalid, state), /collateral amount/);
  }
  assert.equal(program.buildRequests(quoteInput(10000n)).length, 1, "10000 is a legal input boundary, not proof of sufficient debt");
  assert.throws(() => quote(10000n), /minimum borrow/);
  assert.throws(() => quote((1n << 127n) - 1n), /capacity exceeded/);
  const amount = 10n ** 18n, debt = quote(amount).amountOut;
  assert.equal(quote(amount, capacityFixture(source, descriptor, { borrowable: debt })).amountOut, debt);
  assert.throws(() => quote(amount, capacityFixture(source, descriptor, { borrowable: debt - 1n })), /capacity exceeded/);
  assert.throws(() => quote(amount, capacityFixture(source, descriptor, { minimumBorrowing: debt + 1n })), /minimum borrow/);
  const empty = capacityFixture(source, descriptor, { borrowable: 0n });
  assert.equal(decodeFluidCapacity(descriptor, empty, source).borrowable, 0n, "zero capacity remains valid current state");
  assert.throws(() => quote(amount, empty), /capacity exceeded/);
  assert(fluidLocalBorrowQuote(amount, { ...state, borrowFeeBps: 100n }) < debt, "nonzero fee lowers the same amount quote");

  for (const capacity of [0n, 9999n, 10000n]) {
    assert.equal(fluidMaxInputForBorrowCapacity(state, capacity), 0n, "no legal minimum debt has no usable input bound");
  }
  let previousBound = 0n;
  for (const capacity of [10376n, 1000000n, state.borrowable]) {
    const bound = fluidMaxInputForBorrowCapacity(state, capacity);
    assert(bound > previousBound); previousBound = bound;
    assert(fluidMaxBorrowRequest(bound, state) <= capacity);
    assert(fluidMaxBorrowRequest(bound + 1n, state) > capacity, "input bound is maximal under the same integer quote");
  }
  const fractional = fluidMaxInputForBorrowCapacity(state, state.borrowable, 8500n);
  assert(fluidMaxBorrowRequest(fractional, state, 8500n) <= state.borrowable);
  assert(fluidMaxBorrowRequest(fractional + 1n, state, 8500n) > state.borrowable);

  for (const invalid of [
    { vault: ethers.ZeroAddress }, { vault: descriptor.supplyToken },
    { factory: ethers.ZeroAddress }, { liquidity: ethers.ZeroAddress }, { liquidity: descriptor.vault },
    { vaultId: descriptor.factoryBinding.vaultId + 1n },
    { supplyToken: descriptor.borrowToken }, { borrowToken: descriptor.supplyToken },
    { supplyDecimals: descriptor.supplyDecimals + 1 }, { borrowDecimals: descriptor.borrowDecimals + 1 },
    { minimumBorrowing: 0n }, { borrowable: state.borrowable + 1n, borrowableUntilLimit: state.borrowable },
    { oracle: ethers.ZeroAddress }, { oracleRate: 0n }, { supplyExchangePrice: 0n }, { borrowExchangePrice: 0n },
  ] satisfies Partial<FluidCreditCapacity>[]) {
    assert.throws(() => decodeFluidCapacity(descriptor, capacityFixture(source, descriptor, invalid), source), /binding|limits\/config/);
  }
  // Non-T1 resolver returns only vault plus an otherwise zero static tuple.
  const zeroTuple = first.data.slice(0, 66) + "00".repeat(87 * 32);
  assert.throws(() => decodeFluidCapacity(descriptor, [{ ...first, data: zeroTuple }], source), /non-T1/);
  for (const foreign of [{ ...source, number: source.number + 1 }, { ...source, generation: source.generation + 1 },
    { ...source, hash: source.hash === ethers.ZeroHash ? ethers.toBeHex(1n, 32) : ethers.ZeroHash }]) {
    assert.throws(() => program.decode({ programInput: { ...quoteInput(amount), source: foreign },
      initialResults, dependentEvidence: [] }), /foreign source/);
  }
  const failed: AdapterRequestResult = { id: first.id, source, ok: false, failure: "rpc" };
  assert.throws(() => quote(amount, [failed]), /unresolved/);
  assert.throws(() => quote(amount, []), /unexpected local/);
  assert.throws(() => quote(amount, [first, first]), /unexpected local/);
  assert.throws(() => program.decode({ programInput: quoteInput(amount), initialResults,
    dependentEvidence: [{} as never] }), /unexpected local/);
  assert.throws(() => decodeFluidCapacity(descriptor, [first, first], source), /duplicate/);
  assert.throws(() => quote(amount, [{ ...first, data: first.data.slice(0, -64) }]));
  assert.throws(() => quote(amount, [{ ...first, data: first.data + "00".repeat(32) }]), /noncanonical/);
  assert.throws(() => program.buildRequests({ ...quoteInput(amount), route: { ...route, tokenIn: route.tokenOut } }), /route/);
  assert.deepEqual(input, originalInput, "success and failed quotes must not mutate input/source/binding");
  assert.deepEqual(initialResults, originalResults, "decoding must not mutate reusable source bytes");
}
