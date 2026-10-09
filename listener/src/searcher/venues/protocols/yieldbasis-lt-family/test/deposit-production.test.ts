import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/yieldbasis-lt.production.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import { depositProgram, DEPOSIT_DEBT_POLICY } from "../deposit.js";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { ASSET, CANDIDATE, EXECUTOR, FOREIGN, LT, SOURCE, answerFor, descriptor, identityWith, word } from "./fixtures.js";

test("deposit identity fits the actual four-round budget and requires full program proof", () => {
  const v = plugin.identity.variants[0]!; const reply = answerFor({ deposit: true });
  let evidence: any;
  const rounds: string[][] = [];
  for (let step = 0; step <= 4; step++) {
    const input = { candidate: CANDIDATE, evidence, step };
    const decision = v.decide(input);
    if (decision.status === "verified") {
      assert.equal(step, 4); assert.equal(decision.identity.depositPathVerified, true);
      assert.equal(rounds[2]!.filter(id => id === "active-deposit").length, 1);
      assert.deepEqual(rounds[3], ["active-deposit-program"]); return;
    }
    assert.equal(decision.status, "continue"); assert(step < 4);
    const declared = declareRequestProgram({ requirements: v.requirements, buildRequests: v.buildRequests, decode: () => null }, input);
    rounds.push(declared.requests.map(r => r.id));
    evidence = v.decode({ step: input, results: declared.requests.map(reply) });
    if (evidence.phase === "deposit") assert.equal(v.decide({ ...input, evidence }).status, "continue", "raw mint is not executor proof");
  }
  assert.fail("identity did not finish within central budget");
});

test("raw success but guarded program revert preserves withdrawal without granting deposit", () => {
  const i = identityWith(answerFor({ deposit: true, programReverts: true }));
  assert.equal(i.redemptionPathVerified, true); assert.equal(i.depositPathVerified, false);
  const d = descriptor(answerFor({ deposit: true, programReverts: true }));
  assert.deepEqual(plugin.routes.project({ descriptor: d }).map(r => r.direction), ["withdraw"]);
  assert.throws(() => identityWith(r => r.id === "active-deposit-program"
    ? { id: r.id, source: SOURCE, ok: false, failure: "resource-limited" } : answerFor({ deposit: true })(r)));
});

test("deposit Exact is one guarded request; quoted action and runtime use production emitter", () => {
  const reply = answerFor({ deposit: true }), d = descriptor(reply);
  const r = plugin.routes.project({ descriptor: d }).find(r => r.direction === "deposit")!;
  assert(r); assert.equal(r.tokenIn.toLowerCase(), ASSET.toLowerCase()); assert.equal(r.tokenOut.toLowerCase(), LT.toLowerCase());
  for (const amountIn of [1_000_000_000_000n, 2_000_000_000_000_000n, 41_885_594_439_574_942n]) {
    const i = { descriptor: d, route: r, amountIn, source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
    const m = plugin.exact.methods(i)[1]!; assert(m.kind === "request-program");
    assert.equal(m.program.buildDependentProgram, undefined);
    const declared = declareRequestProgram({ ...m.program, decode: () => undefined }, i);
    assert.equal(declared.requests.length, 1);
    const request = declared.requests[0]!; assert(request.kind === "effect-delta-simulation");
    assert.equal(request.call.executionMode, "executor-program"); assert.equal(request.preCalls, undefined);
    const q = m.program.decode({ programInput: i, initialResults: declared.requests.map(reply), dependentEvidence: [] });
    assert.equal(q.amountOut, 2n * amountIn);
    const fragmentInput = { ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence };
    const f = plugin.execution.buildFragment(fragmentInput);
    assert.deepEqual(f.requirements, []);
    const action = plugin.actionAdapters.find(a => a.id === r.adapterId)!;
    assert.deepEqual(action.encode(f.nodes[0]!, EXECUTOR, new Uint8Array()),
      runtimeProgramScript(depositProgram(d, EXECUTOR, { minimumShares: q.amountOut }).bytes(), amountIn));
    assert.throws(() => plugin.execution.buildFragment({ ...fragmentInput, executor: FOREIGN }));
    assert.throws(() => plugin.execution.buildFragment({ ...fragmentInput, exactEvidence: { ...q.evidence, debtPolicy: "invented" } as never }));
    assert.throws(() => m.program.decode({ programInput: i, initialResults: [], dependentEvidence: [] }));
    assert.throws(() => action.encode({ ...f.nodes[0]!, params: { ...f.nodes[0]!.params, debt: 1n } }, EXECUTOR, new Uint8Array()));
  }
  const runtimeInput = { descriptor: d, route: r, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
    get amountIn(): never { throw Error("runtime read quoted amount"); },
    get exactEvidence(): never { throw Error("runtime read Exact evidence"); } };
  const leg = plugin.execution.buildRuntimeLeg!(runtimeInput)!;
  assert.equal(leg.program, ethers.hexlify(depositProgram(d, EXECUTOR).bytes()));
});

test("deposit raw mid is normalized NAV, not inverse withdrawal or Exact output", () => {
  for (const decimals of [8n, 18n]) {
    const reply = answerFor({ deposit: true, assetDecimals: decimals }), d = descriptor(reply);
    const routes = plugin.routes.project({ descriptor: d }), p = plugin.pricing;
    const draft = p.compileDraft({ descriptor: d, stateKey: d.instanceKey, routes });
    const staticProgram = p.staticEvidence!;
    const staticEvidence = staticProgram.decode({ programInput: draft, results: staticProgram.buildRequests(draft).map(reply) });
    const pd = p.finalizePricingDescriptor({ draft, staticEvidence });
    const requests = p.current.buildRequests({ descriptor: pd, source: SOURCE, stateKey: d.instanceKey } as never);
    const results = requests.map(r => r.id === "current:deposit" ? { ...reply(r), data: word(2n * 10n ** 18n) } : reply(r));
    const snapshot = p.current.decodeSnapshot({ descriptor: pd, initialResults: results, dependentEvidence: [], source: SOURCE } as never);
    const route = routes.find(r => r.direction === "deposit")!, point = snapshot.quotes[route.routeKey]!;
    assert.equal(point.amountIn, 10n ** decimals); assert.equal(point.amountOut, 5n * 10n ** 17n);
  }
  assert.equal(DEPOSIT_DEBT_POLICY, "pool-balanced-v1");
});
