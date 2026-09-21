import assert from "node:assert/strict";
import { ethers } from "ethers";
import { defineCreditFamily } from "../../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { fluidCreditStrictFamilyPlugin } from "../../fluid-family-plugin.js";
import { fluidCreditAdapter } from "../../fluid.js";
import { FLUID_VAULT_INTERFACE } from "../codec.js";
import { fluidMaxBorrowRequest, fluidTickAtRatio } from "../borrow-math.js";
import { fluidCreditBorrowProgram, fluidCreditExact } from "../exact.js";
import { fluidCreditDomain } from "../credit.js";
import { fluidCreditPricing } from "../pricing.js";
import { decodeFluidCurrentState } from "../state.js";
import type { FluidCreditDescriptor, FluidCreditRoute } from "../types.js";
import { BORROW_STATE, ORACLE, stateFixture } from "./quote-fixture.js";

export function verifyFluidQuoteContract(input: { descriptor: FluidCreditDescriptor; route: FluidCreditRoute;
  source: CanonicalSource; executor: string }): void {
  const { descriptor, route, source, executor } = input;
  assert.throws(() => fluidCreditAdapter.creditPolicy.quoteOutputByDebtBps(), /legacy Fluid ratio quote removed/);
  const states = stateFixture(source);
  const snapshot = decodeFluidCurrentState(states);
  assert.equal(snapshot.oracle, ORACLE);
  assert.equal(snapshot.collateralFactorBps, 9200n, "CF, not 94% liquidation threshold or 96% maximum");
  const draft = fluidCreditPricing.compileDraft({ descriptor, stateKey: route.instanceKey, routes: [route] });
  const pricingDescriptor = fluidCreditPricing.finalizePricingDescriptor({ draft, sharedBindings: [] });
  const mids = fluidCreditPricing.current.deriveMids({ descriptor: pricingDescriptor, routes: [route], snapshot });
  assert(Math.abs(mids.get(route.routeKey)!.mid * 1e12 - 1.0423150326027928) < 1e-14,
    "raw-unit collateral-to-debt ratio correctly displays 18-to-6 decimals");
  assert.equal(mids.get(route.routeKey)!.edges[0].slotKind, "lend");
  assert.throws(() => decodeFluidCurrentState(states.map((r, i) => i === 1 ? { ...r,
    source: { ...source, hash: ethers.ZeroHash } } : r)), /foreign source/);
  assert.throws(() => decodeFluidCurrentState(states.map((r, i) => i === 1 ? { ...r,
    ok: false, failure: "deadline" } as AdapterRequestResult : r)), /unresolved/);

  const program = fluidCreditBorrowProgram;
  let previous = 0n;
  // Unit-test values only. Historical acceptance separately reads the actual
  // production effective amount from a saved table, not these fixture values.
  for (const amountIn of [10n ** 18n, 17n * 10n ** 18n, 1766743380904387863297n]) {
    const quoteInput = { ...input, amountIn, runtimeEvidence: [] };
    const initialResults = states.slice(0, 1);
    assert.equal(program.buildRequests(quoteInput)[0].id, "credit-current-config");
    const round = program.buildDependentProgram({ programInput: quoteInput, completedRound: 0,
      initialResults, priorEvidence: [] });
    assert(round);
    assert.equal(round.requests[0].kind, "eth-call");
    if (round.requests[0].kind !== "eth-call") throw new Error("expected oracle call");
    assert.equal(round.requests[0].to, ORACLE);
    const priorEvidence = [round.decode(states.slice(1))];
    const operation = program.buildDependentProgram({ programInput: quoteInput, completedRound: 1,
      initialResults, priorEvidence });
    assert(operation);
    const request = operation.requests[0];
    assert.equal(request.kind, "effect-delta-simulation");
    if (request.kind !== "effect-delta-simulation") throw new Error("expected amount execution");
    assert.deepEqual(request.overrideIntent.tokenBalances, [{ token: descriptor.supplyToken, amount: amountIn }]);
    assert.equal(request.observeTokenBalances?.length, 2, "debt receipt must be observed explicitly");
    const args = FLUID_VAULT_INTERFACE.decodeFunctionData("operate", request.call.data);
    const requested = BigInt(args[2]);
    assert.equal(args[1], amountIn, "specified collateral is never replaced by a point sample");
    assert.equal(args[3], executor);
    assert(requested > previous); previous = requested;
    assert(requested < amountIn * BORROW_STATE.oracleRate * 9200n / (10n ** 27n * 10000n),
      "tick rounding must not be replaced by linear mid multiplication");
    const result: Extract<AdapterRequestResult, { ok: true }> = { id: request.id, source, ok: true, completion: "returned",
      provenance: { kind: "fixture", fingerprint: "fluid-credit-exact" },
      data: FLUID_VAULT_INTERFACE.encodeFunctionResult("operate", [1n, amountIn, requested]),
      effects: { tokenDeltas: [{ token: route.tokenIn, account: executor, delta: -amountIn },
        { token: route.tokenOut, account: executor, delta: requested }] } };
    const dependentEvidence = [...priorEvidence, operation.decode([result])];
    const quote = program.decode({ programInput: quoteInput, initialResults, dependentEvidence });
    assert.equal(quote.amountOut, requested);
    const riskInput = { ...input, collateralAmount: amountIn, debtBps: 10000n, runtimeEvidence: [] };
    const risk = fluidCreditDomain.risk.evidence.decode({ programInput: riskInput, results: [...states, result] });
    assert.equal(risk.debtAmount, quote.amountOut, "Credit and Exact consume the same program and actual receipt");
    assert.equal(fluidCreditDomain.risk.quoteOutputByDebtBps({ ...riskInput, evidence: risk }), quote.amountOut);
    assert.throws(() => fluidCreditDomain.risk.quoteOutputByDebtBps(riskInput), /requires compatible/);
    assert.throws(() => program.decode({ programInput: quoteInput, initialResults,
      dependentEvidence: [...priorEvidence, operation.decode([{ ...result,
        effects: { tokenDeltas: [{ token: route.tokenIn, account: executor, delta: -amountIn },
          { token: route.tokenOut, account: executor, delta: requested - 1n }] } }])] }), /did not prove/);
    assert.throws(() => program.decode({ programInput: quoteInput, initialResults,
      dependentEvidence: [...priorEvidence, operation.decode([{ id: request.id, source,
        ok: false, failure: "rpc" }])] }), /unresolved/);
    assert.throws(() => program.buildRequests({ ...quoteInput, route: { ...route, tokenIn: route.tokenOut } }), /route/);
    assert.equal(program.buildDependentProgram({ programInput: quoteInput, completedRound: 2,
      initialResults, priorEvidence: dependentEvidence }), null);
  }
  for (const invalid of [0n, -1n, 9999n, 1n << 127n]) {
    assert.throws(() => fluidMaxBorrowRequest(invalid, snapshot));
  }
  assert.throws(() => fluidMaxBorrowRequest(10000n, snapshot), /minimum/);
  assert.throws(() => fluidMaxBorrowRequest(10n ** 18n, snapshot, 10400n), /ceiling fraction/);
  assert(fluidMaxBorrowRequest(10n ** 18n, { ...snapshot, borrowFeeBps: 100n }) <
    fluidMaxBorrowRequest(10n ** 18n, snapshot), "read fee affects debt ceiling");
  assert.equal(fluidTickAtRatio(1n << 96n), 0);
  assert.equal(fluidTickAtRatio((1n << 96n) - 1n), -1);
  assert.throws(() => fluidTickAtRatio(1n), /outside tick range/);
  assert.equal(fluidCreditExact.methods()[0].program, fluidCreditBorrowProgram);
  assert.equal(fluidCreditExact.methods()[0].chainAmountQuote, true);
  assert.throws(() => defineCreditFamily({ ...fluidCreditStrictFamilyPlugin,
    pricing: {} as never }), /pricing/);
  assert.throws(() => defineCreditFamily({ ...fluidCreditStrictFamilyPlugin,
    exact: { ...fluidCreditExact, methods: async () => [] } as never }), /synchronous/);
  assert.throws(() => defineCreditFamily({ ...fluidCreditStrictFamilyPlugin, credit: {
    ...fluidCreditDomain, risk: { ...fluidCreditDomain.risk, evidence: {
      ...fluidCreditDomain.risk.evidence, buildDependentProgram: async () => null } as never } } }), /synchronous/);
}
