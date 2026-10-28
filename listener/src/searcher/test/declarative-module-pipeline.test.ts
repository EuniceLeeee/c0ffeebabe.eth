import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, toBeHex, Interface } from "ethers";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { createDeclarativeMathRegistry } from "../venues/declarative-math.js";
import { applyExactTrialState, emptyExactTrialState } from "../exact-trial-state.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const address = (value: number) => getAddress(toBeHex(value, 20));
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const op = (op: string, ...args: any[]) => ({ op, args });
function fixture(document: any = clone(root), options: Parameters<typeof createDeclarativeProtocolRuntime>[2] = {}) {
  const runtime = createDeclarativeProtocolRuntime(document, [clone(custodian), clone(infinifi)], options);
  const descriptor: any = { familyId: root.scope.family, lineageId: runtime.variants[0]!.document.lineageId,
    instanceKey: address(1).toLowerCase(), vault: address(1), asset: address(2), share: address(1),
    verifiedDirections: { deposit: true, redeem: true }, runtimeRequirements: [] };
  const routes: readonly any[] = runtime.definition.routes.project({ descriptor });
  const route = routes[0]!;
  return { runtime, descriptor, route, routes,
    input: { descriptor, route, amountIn: 170n, source, executor: address(10), runtimeEvidence: [] } };
}
const result = (id: string, n: bigint, actualSource = source): any => ({ id, ok: true, completion: "returned", data: toBeHex(n, 32), source: actualSource,
  provenance: { kind: "fixture", fingerprint: "fixture" } });
const reads = (id: string, target: any, data = "0x12345678") => [{ id, kind: "eth-call", to: target, data, completion: "return-data" }];
const decoded = (id: string) => op("word", op("get", op("returned", id), "data"));
const quoteAbi = new Interface(["function preview(uint256) view returns(uint256)"]);
const quoteFlow = () => ({ version: 1, sourceKind: "view",
  chainQuote: { step: "quote", requestId: "flow-quote", signature: "function preview(uint256) view returns(uint256)", amountPath: [0], outputPath: [0] }, steps: [
  { id: "relationship", requirements: { transports: ["eth-call"] }, requests: reads("flow-relationship", "$target"),
    decode: [{ return: op("addressWord", op("get", op("returned", "flow-relationship"), "data")) }] },
  { id: "quote", requirements: { transports: ["eth-call"] }, requests: reads("flow-quote", "$steps.relationship", quoteAbi.encodeFunctionData("preview", [170n])),
    decode: [{ return: decoded("flow-quote") }] },
], result: "$steps.quote" });

test("unmodified three production JSONs keep runtime bytes, directions and quote requests with empty extension blocks", () => {
  const before = fixture();
  const doc: any = clone(root); doc.modules = { math: {}, quoteFlow: {}, pricingFlow: {} };
  const after = fixture(doc);
  assert.deepEqual(before.routes, after.routes);
  const program = (f: ReturnType<typeof fixture>) => f.runtime.definition.exact.methods(f.input as any)[1] as any;
  assert.deepEqual(program(before).program.buildRequests(before.input), program(after).program.buildRequests(after.input));
  assert.equal(before.runtime.definition.execution.buildRuntimeLeg!(before.input as any)!.program,
    after.runtime.definition.execution.buildRuntimeLeg!(after.input as any)!.program);
  for (const variant of after.runtime.moduleCoverage)
    assert(variant.modules.every(module => module.state === "undefined"));
  assert.equal(Object.hasOwn(root, "modules"), false);
});

test("production Exact drives JSON dependent rounds and checks final canonical source and requested amount", () => {
  const doc: any = clone(root); doc.standard.modules = { quoteFlow: quoteFlow() };
  const f = fixture(doc); const method = f.runtime.definition.exact.methods(f.input as any)[1] as any;
  assert.equal(method.chainAmountQuote, true);
  const program = method.program;
  assert.equal(program.buildRequests(f.input)[0].id, "flow-relationship");
  const initial = [result("flow-relationship", BigInt(address(3)))];
  const second = program.buildDependentProgram({ programInput: f.input, completedRound: 0, initialResults: initial, priorEvidence: [] });
  assert.equal(second.requests[0].to, address(3));
  const completed = second.decode([result("flow-quote", 341n)]);
  assert.equal(program.buildDependentProgram({ programInput: f.input, completedRound: 1, initialResults: initial, priorEvidence: [completed] }), null);
  const output = program.decode({ programInput: f.input, initialResults: initial, dependentEvidence: [completed] });
  assert.equal(output.amountOut, 341n); assert.equal(output.evidence.amountIn, 170n);
  assert.throws(() => second.decode([result("flow-quote", 341n, { ...source, number: 101 })]));
  assert.throws(() => program.decode({ programInput: f.input, initialResults: initial, dependentEvidence: [] }));
  assert.throws(() => program.decode({ programInput: { ...f.input, amountIn: 171n }, initialResults: initial, dependentEvidence: [completed] }), /amount mismatch/);
  doc.standard.modules.quoteFlow.result = "1";
  assert.throws(() => (fixture(doc).runtime.definition.exact.methods(f.input as any)[1] as any).program.decode({
    programInput: f.input, initialResults: initial, dependentEvidence: [completed],
  } as any));
});

test("declared chain quote cannot use a missing step or a constant zero-I/O proof", () => {
  const doc: any = clone(root); doc.standard.modules = { quoteFlow: quoteFlow() };
  doc.standard.modules.quoteFlow.chainQuote.step = "missing";
  assert.throws(() => fixture(doc), /undefined flow step/);
  doc.standard.modules.quoteFlow = { version: 1, sourceKind: "view", steps: [], result: 1 };
  assert.throws(() => fixture(doc));
});

test("local math quote provenance cannot be mislabelled as a chain-produced amount quote", () => {
  const doc: any = clone(root); doc.standard.modules = { quoteFlow: { ...quoteFlow(), sourceKind: "local-math",
    localStateUnsupportedReason: "fixture has no sequential state model" } };
  delete doc.standard.modules.quoteFlow.chainQuote;
  const blocked = fixture(doc);
  assert.equal(blocked.runtime.moduleCoverage[0]!.modules.find(row => row.key === "quoteFlow")!.state, "blocked");
  assert.throws(() => blocked.runtime.definition.exact.methods(blocked.input as any), /unavailable/);
  assert(blocked.runtime.definition.execution.buildRuntimeLeg!(blocked.input as any), "unrelated existing execution remains usable");
  doc.standard.modules.math = { version: 1, entries: { identity: { model: "fixture:identity", version: 1 } } };
  const math = createDeclarativeMathRegistry([{ id: "fixture:identity", version: 1,
    validateInput() {}, evaluate: value => value, validateOutput() {} }]);
  const f = fixture(doc, { math }); const method = f.runtime.definition.exact.methods(f.input as any)[1] as any;
  assert.equal(method.chainAmountQuote, undefined);
  assert.equal(method.trialState.unsupportedReason, "fixture has no sequential state model");
  delete doc.standard.modules.quoteFlow.localStateUnsupportedReason;
  assert.throws(() => fixture(doc, { math }), /sequential trial state/);
});

test("production pricing uses the same dependent-round contract and rejects forged source/output coverage", () => {
  const doc: any = clone(root);
  doc.standard.modules = { pricingFlow: { version: 1, steps: [
    { id: "state", requirements: { transports: ["eth-call"] }, requests: reads("state", "$target"), decode: [{ return: decoded("state") }] },
    { id: "prices", requirements: { transports: ["eth-call"] }, requests: reads("price", "$target"), decode: [{ return: decoded("price") }] },
  ], result: { source: "$source", quotes: op("objectFromEntries", op("map", "$routes", "route", ["$route.routeKey",
    { amountIn: "$descriptor.oneAsset", amountOut: "$steps.prices" }])) } } };
  const f = fixture(doc), pricing = f.runtime.definition.pricing.current;
  const descriptor = { ...f.descriptor, routes: f.routes, oneAsset: 10n, oneShare: 10n };
  const current = { descriptor, routes: f.routes, source };
  assert.equal(pricing.buildRequests(current)[0]!.id, "state");
  const initial = [result("state", 1n)];
  const bound = pricing.buildDependentProgram!({ current, completedRound: 0, initialResults: initial, priorEvidence: [] })!;
  const evidence = bound.decode([result("price", 21n)]);
  const snapshot = pricing.decodeSnapshot({ descriptor, initialResults: initial, dependentEvidence: [evidence] });
  assert.equal(snapshot.quotes[f.route.routeKey]!.amountIn, 10n);
  assert.equal(snapshot.quotes[f.route.routeKey]!.amountOut, 21n);
  assert.throws(() => pricing.decodeSnapshot({ descriptor: { ...descriptor, oneShare: 11n }, initialResults: initial, dependentEvidence: [evidence] }), /incompatible quote/);
  doc.standard.modules.pricingFlow.result.source = { ...source, number: 101 };
  const changed = fixture(doc).runtime.definition.pricing.current;
  assert.throws(() => changed.decodeSnapshot({ descriptor, initialResults: initial, dependentEvidence: [evidence] }));
});

test("native route declarations are bound, not inferred from graph WETH or mutable route fields", () => {
  const doc: any = clone(root); doc.routes.directions[0].executionAssets = { input: "native", output: "erc20" };
  const f = fixture(doc);
  assert.deepEqual(f.route.executionAssets, { input: "native", output: "erc20" });
  f.runtime.assertInvocation(f.descriptor, f.route);
  assert.throws(() => f.runtime.assertInvocation(f.descriptor, { ...f.route, executionAssets: { input: "erc20", output: "erc20" } }));
  doc.routes.directions[0].executionAssets = { input: "guessed", output: "erc20" };
  assert.throws(() => fixture(doc), /raw execution asset/);
});

test("call and log refresh predicates agree in indexed and fallback production paths", () => {
  const doc: any = clone(root); doc.pricing.mutationKinds = ["log", "call"];
  doc.standard.pricing.mutationPredicate = op("or", op("eq", "$observation.kind", "log"), op("eq", "$observation.selector", "0x12345678"));
  const f = fixture(doc), pricing = f.runtime.definition.pricing;
  const current = { descriptor: f.descriptor, routes: f.routes };
  const dependencies = pricing.dependencies(current);
  const index = pricing.mutation!.compile!({ entries: [{ ...current, dependencies, stateKey: f.descriptor.instanceKey }] });
  for (const [observation, expected] of [
    [{ kind: "call", target: f.descriptor.vault, selector: "0x12345678" }, [f.descriptor.instanceKey]],
    [{ kind: "call", target: f.descriptor.vault, selector: "0x87654321" }, []],
    [{ kind: "call", target: address(99), selector: "0x12345678" }, []],
    [{ kind: "log", address: f.descriptor.vault }, [f.descriptor.instanceKey]],
  ] as const) {
    assert.deepEqual(index.affectedStateKeys({ observation: observation as any }), expected);
    assert.deepEqual(pricing.mutation!.affectedStateKeys({ ...current, observation: observation as any }), expected);
  }
});

test("standard identity can declare the existing generic stage machine without a conversion-specific workflow", () => {
  const doc: any = clone(root);
  doc.identity.definition = { version: 1, identity: {
    select: [{ return: "relation" }],
    stages: { relation: { requirements: { transports: ["eth-call"] }, requests: reads("relation", "$candidate.vault"),
      decode: [{ return: { relation: decoded("relation") } }] } },
    decide: [{ return: { status: "continue" } }],
  } };
  doc.standard.identityKind = "registry-member";
  const runtime = fixture(doc).runtime;
  const identity = runtime.definition.identity.variants[0]!;
  assert.equal(identity.kind, "registry-member");
  assert.equal(identity.buildRequests({ candidate: { candidateKind: "fixture", vault: address(1) } } as any)[0]!.id, "relation");
  assert.deepEqual(identity.decide({ candidate: { candidateKind: "fixture", vault: address(1) }, step: 0 } as any), { status: "continue" });
});

test("production runtime forwards the authenticated transaction origin unchanged", () => {
  const doc: any = clone(root);
  doc.standard.execution.contextChecks = [{ condition: op("eq", "$transactionOrigin", address(99)), error: "origin mismatch" }];
  const f = fixture(doc), input = { ...f.input, transactionOrigin: address(99) };
  assert(f.runtime.executionProgram(input));
  assert(f.runtime.definition.execution.buildRuntimeLeg!(input as any));
  assert.throws(() => f.runtime.definition.execution.buildRuntimeLeg!({ ...input, transactionOrigin: address(98) } as any));
});

test("production local math bootstraps issued state then consumes the previous transition without baseline fallback", () => {
  const doc: any = clone(root);
  const ref = { key: "fixture:reserve", schema: "fixture:v1", binding: "$route.bindingRef.fingerprint", dependencies: ["fixture:oracle"] };
  doc.standard.modules = {
    math: { version: 1, entries: { transition: { model: "fixture:transition", version: 1 } } },
    quoteFlow: { version: 1, sourceKind: "local-math", steps: [{ id: "reserve", requirements: { transports: ["eth-call"] },
      requests: reads("trial-state", "$target"), result: { reserve: decoded("trial-state") } }], result: "$steps.reserve" },
    trialState: { version: 1, reads: [{ id: "reserve", refs: [ref], initial: ["$prepared"] }], model: "transition",
      input: { reserve: "$stateReads.reserve.0.reserve", amount: "$amountIn" }, amountOut: "$modelResult.amountOut",
      stateChanges: [{ ref: "$stateRefs.reserve.0", value: "$modelResult.state" }], stateEffects: ["fixture:reserve"] },
  };
  const math = createDeclarativeMathRegistry([{ id: "fixture:transition", version: 1, validateInput() {},
    evaluate(value) { const { reserve, amount } = value as { reserve: bigint; amount: bigint };
      const amountOut = reserve * amount / 1000n; return { amountOut, state: { reserve: reserve - amountOut } }; }, validateOutput() {} }]);
  const f = fixture(doc, { math }), initial = emptyExactTrialState();
  const input = { ...f.input, trialState: initial.view }, method = f.runtime.definition.exact.methods(input as any)[1] as any;
  assert.equal(method.chainAmountQuote, undefined);
  assert.equal(method.trialState.quote(input).status, "not-applicable");
  const first = method.program.decode({ programInput: input, initialResults: [result("trial-state", 1000n)], dependentEvidence: [] });
  assert.equal(first.amountOut, 170n); assert.equal(first.evidence.executor, f.input.executor);
  const next = applyExactTrialState(initial, first.stateChanges, first.stateEffects);
  const secondInput = { ...input, trialState: next.view }, second = method.trialState.quote(secondInput);
  assert.equal(second.status, "quoted"); assert.equal(second.result.amountOut, 141n);
  assert.equal(method.program.decode({ programInput: secondInput, initialResults: [result("trial-state", 9999n)], dependentEvidence: [] }).amountOut, 141n);
  const invalidated = applyExactTrialState(next, [], ["fixture:oracle"]);
  assert.throws(() => method.trialState.quote({ ...input, trialState: invalidated.view }), /invalidated/);
  assert.throws(() => method.program.decode({ programInput: { ...input, trialState: invalidated.view },
    initialResults: [result("trial-state", 9999n)], dependentEvidence: [] }), /invalidated/);
  doc.standard.exact.guardProgram = "guard";
  doc.standard.readPrograms.guard = { requests: reads("guard", "$target"), decode: [{ return: true }] };
  const guarded = fixture(doc, { math }).runtime.definition.exact.methods(input as any)[1] as any;
  assert.equal(guarded.trialState.quote(secondInput).status, "not-applicable", "local hit cannot skip a source guard");
  doc.standard.modules.trialState = {};
  assert.throws(() => fixture(doc, { math }), /sequential trial state/);
});

test("missing new trial dependencies block that capability while preserving old routes and runtime execution", () => {
  const doc: any = clone(root);
  doc.standard.modules = { trialState: { version: 1, reads: [{ id: "state", refs: [] }], model: "transition",
    input: {}, amountOut: "$modelResult.amountOut", stateChanges: [], stateEffects: [] } };
  const f = fixture(doc), coverage = f.runtime.moduleCoverage[0].modules.find(row => row.key === "trialState")!;
  assert.equal(coverage.state, "blocked");
  assert.deepEqual(coverage.missingDependencies, ["math", "quoteFlow"]);
  assert.deepEqual(f.routes, fixture().routes);
  assert(f.runtime.definition.execution.buildRuntimeLeg!(f.input as any));
  assert.throws(() => f.runtime.definition.exact.methods(f.input as any), /unavailable/);
});
