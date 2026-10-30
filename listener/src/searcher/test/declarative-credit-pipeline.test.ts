import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import { createDeclarativeCreditRuntime } from "../venues/declarative-credit.js";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { renderDeclarativeProductionEntry } from "../build-declarative-production.js";
import base from "../venues/protocols/erc4626-family/erc4626.json";

// Synthetic whole-compiler fixture: no deployed Credit identity or historical
// acceptance is inferred. Domain-specific proof feeds the common execution.
const op = (op: string, ...args: any[]) => ({ op, args });
const n = (v: number) => op("uint", String(v));
const signature = "function open(uint256,int256,int256,address) returns(uint256,int256,int256)";
const abi = new Interface([signature]);
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const executor = toBeHex(91, 20), vault = toBeHex(1, 20), asset = toBeHex(2, 20);
function declaration() {
  const d: any = JSON.parse(JSON.stringify(base));
  delete d.protocol; delete d.types;
  d.scope.family = d.manifest.familyId = "credit:fixture";
  d.production.domain = d.manifest.domain = "credit";
  d.variantFiles = [];
  d.manifest.supportedLineages = [d.standard.lineageId];
  d.standard.abi.vault = [signature];
  d.standard.execution.settlement.directOutput = false;
  d.standard.execution.call = { target: "$descriptor.vault", signature,
    args: [n(0), { runtime: "amountIn" }, "$creditQuote.amountOut", "$recipient"], save: { output: 2 } };
  d.credit = { version: 1, activeBehaviorProof: "required",
    position: { lifecycle: "standing-position", finalSafety: "position-and-repayment-required", key: "$route.routeKey" },
    risk: { debtBpsCandidates: ["8500"], blocksPrefixInversion: true,
      evidence: { version: 1, steps: [{ id: "open", requirements: { transports: ["effect-delta-simulation"], caller: "executor", effects: ["return-data", "token-delta"] },
        requests: [{ id: "position", kind: "effect-delta-simulation", call: { caller: { kind: "executor" }, to: "$descriptor.vault",
          data: op("encode", "vault", "open", [n(0), "$collateralAmount", op("div", op("mul", "$collateralAmount", "$debtBps"), n(10000)), "$executor"]) },
          overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: "$route.tokenIn", amount: "$collateralAmount" }] },
          observe: ["return-data", "token-delta"], observeTokenBalances: [{ token: "$route.tokenIn", account: { kind: "executor" } }, { token: "$route.tokenOut", account: { kind: "executor" } }] }],
        result: op("decodeCanonical", "vault", "open", op("get", op("returned", "position"), "data"), 2) }], result: "$steps.open" },
      proof: { profile: "new-position-return-and-effects-v1", step: "open", requestId: "position", signature, target: "$descriptor.vault",
        call: { position: [0], collateral: [1], debt: [2], recipient: [3] }, returns: { position: [0], collateral: [1], debt: [2] } },
      quote: { checks: [{ assert: op("eq", "$evidence", op("div", op("mul", "$collateralAmount", "$debtBps"), n(10000))), error: "risk ratio mismatch" }], result: "$evidence" },
    } };
  return d;
}
function fixture(d = declaration()) {
  const runtime = createDeclarativeCreditRuntime(d), family: any = runtime.definition;
  const descriptor = { familyId: d.scope.family, lineageId: d.standard.lineageId, instanceKey: vault,
    vault, asset, share: vault, verifiedDirections: { deposit: true, redeem: false }, runtimeRequirements: [] };
  const route = family.routes.project({ descriptor })[0];
  const input = { descriptor, route, source, executor, runtimeEvidence: [], collateralAmount: 1000n, debtBps: 8500n };
  const result = { id: "position", source, ok: true, completion: "returned", data: abi.encodeFunctionResult("open", [7n, 1000n, 850n]),
    provenance: { kind: "unit-fixture", fingerprint: "not-chain-proof" },
    effects: { tokenDeltas: [{ token: asset, account: executor, delta: -1000n }, { token: vault, account: executor, delta: 850n }] } };
  const exactEvidence = family.credit.risk.evidence.decode({ programInput: input, results: [result] });
  return { d, runtime, family, descriptor, route, input, result, execution: { ...input, amountIn: 1000n, quotedAmountOut: 850n, minAmountOut: 850n, exactEvidence } };
}
test("Credit risk proof reaches common quoted compiler without advertising runtime", () => {
  const f = fixture();
  assert.equal(f.family.execution.buildRuntimeLeg, undefined);
  assert.equal(f.family.credit.risk.quoteOutputByDebtBps({ ...f.input, evidence: f.execution.exactEvidence }), 850n);
  const fragment = f.family.execution.buildFragment(f.execution);
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.nodes[0].amount, 1000n);
  assert.match(fragment.nodes[0].params.runtimeAmountProgram, /^0x[0-9a-f]+$/);
  for (const changed of [{ amountIn: 999n }, { quotedAmountOut: 849n }, { minAmountOut: 0n }, { minAmountOut: 851n },
    { executor: toBeHex(92, 20) }, { exactEvidence: { ...f.execution.exactEvidence, observations: [] } }])
    assert.throws(() => f.family.execution.buildFragment({ ...f.execution, ...changed }));
});
test("Credit production generation chooses shared Credit compiler and leaves Protocol domain unchanged", () => {
  const root = process.cwd(), definitionFile = `${root}/src/searcher/venues/credit/fixture-family/fixture.json`;
  const generated = renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document: declaration() });
  assert.equal(generated.format, "credit-json-v2");
  assert.match(generated.source, /defineCreditFamily\(compileDeclarativeCredit/);
  assert.doesNotMatch(generated.source, /declarative-protocol|buildRuntimeLeg/);
  const p: any = JSON.parse(JSON.stringify(base)); p.variantFiles = [];
  const protocol = createDeclarativeProtocolRuntime(p);
  assert.equal(protocol.definition.manifest.domain, "protocol");
  assert.equal(typeof protocol.definition.execution.buildRuntimeLeg, "function");
});

test("risk-proven Credit execution does not require an ordinary Exact method", () => {
  const d = declaration(); d.standard.exact = { unavailableReason: "risk quote only" };
  const f = fixture(d);
  assert.equal(f.family.execution.buildRuntimeLeg, undefined);
  assert.equal(f.family.execution.buildFragment(f.execution).nodes.length, 1);
  assert.throws(() => f.family.execution.buildFragment({ ...f.execution, exactEvidence: { kind: "unproven" } }), /requires issuer-bound risk proof/);
});

test("ordinary Exact availability cannot bypass mandatory Credit risk evidence", () => {
  const f = fixture();
  assert.equal(f.d.standard.exact.unavailableReason, undefined);
  for (const exactEvidence of [undefined, {}, { kind: "unproven" }, { ...f.execution.exactEvidence, kind: "ordinary-exact" }])
    assert.throws(() => f.family.execution.buildFragment({ ...f.execution, exactEvidence }), /requires issuer-bound risk proof/);
  assert.equal(f.family.execution.buildFragment(f.execution).nodes.length, 1);
});

test("Credit capture preserves collateral and debt fields instead of route amountIn", () => {
  const f = fixture(), surface = f.d.discovery.definition.surface;
  const descriptor = { familyId: f.d.scope.family, candidateIdentity: vault, source,
    opaqueBinding: { collateralAmount: "1000", debtBps: "8500", minAmountOut: "850", executor, runtimeEvidence: [],
      observation: { kind: "address-surface", patternId: surface.id, interfaceFingerprints: [surface.fingerprint] } } };
  const capture = f.family.capture.materialize(descriptor);
  assert.equal(capture.kind, "credit");
  assert.equal(capture.collateralAmount, 1000n); assert.equal(capture.debtBps, 8500n);
  assert.equal(capture.minAmountOut, 850n); assert.equal(capture.executor, executor);
  assert.equal(capture.observations[0].patternId, surface.id);
  assert.equal(capture.amountIn, undefined);
  const { collateralAmount: _collateral, debtBps: _ratio, ...routeBinding } = descriptor.opaqueBinding;
  assert.throws(() => f.family.capture.materialize({ ...descriptor, opaqueBinding: { ...routeBinding, amountIn: "1000", path: [] } }), /credit capture/);
});
