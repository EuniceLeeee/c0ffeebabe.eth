import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, toBeHex, Interface } from "ethers";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { verifyDeclarativeQuoteChain, quoteProofSteps } from "../venues/declarative-quote-proof.js";
import root from "../venues/protocols/erc4626-family/erc4626.json";
import custodian from "../venues/protocols/erc4626-family/custodian.json";
import infinifi from "../venues/protocols/erc4626-family/infinifi.json";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const op = (op: string, ...args: any[]) => ({ op, args });
const address = (v: number) => getAddress(toBeHex(v, 20));
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const signature = "function preview(uint256) view returns(uint256)";
const abi = new Interface([signature]);
const result = (id: string, n: bigint, bound = source): any => ({ id, ok: true, completion: "returned", data: abi.encodeFunctionResult("preview", [n]),
  source: bound, provenance: { kind: "fixture", fingerprint: "fixture" } });
const request = (id: string, amount: any) => ({ id, kind: "eth-call", to: "$target", data: op("encode", "preview", "preview", [amount]), completion: "return-data" });
const decoded = (id: string) => op("word", op("get", op("returned", id), "data"));
function fixture(doc: any = clone(root)) {
  const runtime = createDeclarativeProtocolRuntime(doc, [clone(custodian), clone(infinifi)]);
  const descriptor: any = { familyId: root.scope.family, lineageId: runtime.variants[0]!.document.lineageId,
    instanceKey: address(1).toLowerCase(), vault: address(1), asset: address(2), share: address(1),
    verifiedDirections: { deposit: true, redeem: true }, runtimeRequirements: [], tokens: [address(1), address(2), address(3)] };
  const routes: any = runtime.definition.routes.project({ descriptor });
  const input: any = { descriptor, route: routes[0], amountIn: 7n, source, executor: address(10), runtimeEvidence: [] };
  return { runtime, descriptor, routes, input };
}
function chainedDocument() {
  const doc: any = clone(root);
  doc.standard.abi.preview = [signature];
  doc.standard.modules = { quoteFlow: { version: 1, sourceKind: "view", chainQuote: { steps: [
    { step: "assets", requestId: "assets", signature, amountPath: [0], outputPath: [0] },
    { step: "shares", requestId: "shares", signature, amountPath: [0], outputPath: [0] },
  ] }, steps: [
    { id: "assets", requirements: { transports: ["eth-call"] }, requests: [request("assets", op("uint", "7"))], result: decoded("assets") },
    { id: "shares", requirements: { transports: ["eth-call"] }, requests: [request("shares", "$steps.assets")], result: decoded("shares") },
  ], result: "$steps.shares" } };
  return doc;
}
function quote(f: ReturnType<typeof fixture>) {
  const method = f.runtime.definition.exact.methods(f.input)[1] as any;
  const initialResults = [result("assets", 11n)];
  const bound = method.program.buildDependentProgram({ programInput: f.input, completedRound: 0, initialResults, priorEvidence: [] });
  assert.equal(abi.decodeFunctionData("preview", bound.requests[0].data)[0], 11n);
  const dependentEvidence = [bound.decode([result("shares", 19n)])];
  return { method, initialResults, dependentEvidence,
    output: method.program.decode({ programInput: f.input, initialResults, dependentEvidence }) };
}
test("composed quote proves every issued amount without changing the requested input", () => {
  const f = fixture(chainedDocument()); const q = quote(f);
  assert.equal(q.output.amountOut, 19n);
  assert.throws(() => q.method.program.decode({ programInput: { ...f.input, amountIn: 8n }, initialResults: q.initialResults,
    dependentEvidence: q.dependentEvidence }), /amount mismatch/);
  const doc = chainedDocument(); doc.standard.modules.quoteFlow.steps[1].requests[0] = request("shares", op("uint", "10"));
  const g = fixture(doc), method = g.runtime.definition.exact.methods(g.input)[1] as any;
  assert.throws(() => method.program.decode({ programInput: g.input, initialResults: q.initialResults,
    dependentEvidence: q.dependentEvidence }), /amount mismatch/);
  assert.throws(() => quoteProofSteps({ steps: [{ step: "assets", requestId: "assets", signature, amountPath: [0], outputPath: [0] }] }, "view"));
  assert.throws(() => quoteProofSteps({ steps: [{ step: "a", requestId: "x" }, { step: "b", requestId: "y" }] }, "effect-simulation"));
  const proofs = doc.standard.modules.quoteFlow.chainQuote.steps;
  doc.standard.modules.quoteFlow.chainQuote.steps = [...proofs].reverse();
  assert.throws(() => fixture(doc), /flow order/);
});
test("intermediate evidence survives quoted execution and is replay-validated against source, input and output", () => {
  const doc = chainedDocument(); doc.standard.exact.retainReadEvidence = true;
  doc.standard.exact.evidence = op("merge", doc.standard.exact.evidence, { intermediateAssets: "$steps.assets" });
  const f = fixture(doc), q = quote(f);
  assert.equal(q.output.evidence.intermediateAssets, 11n);
  const input = { ...f.input, quotedAmountOut: 19n, minAmountOut: 19n, exactEvidence: q.output.evidence };
  assert(f.runtime.definition.execution.buildFragment(input));
  for (const changed of [
    { ...input, amountIn: 8n }, { ...input, quotedAmountOut: 18n },
    { ...input, exactEvidence: { ...input.exactEvidence, intermediateAssets: 12n } },
    { ...input, exactEvidence: { ...input.exactEvidence, readProof: { ...input.exactEvidence.readProof,
      initialResults: [result("assets", 11n, { ...source, generation: 2 })] } } },
  ]) assert.throws(() => f.runtime.definition.execution.buildFragment(changed));
});
test("pricing-only capability can remain available without a pretend Exact quote", () => {
  const doc: any = clone(root); doc.standard.exact = { unavailableReason: "quote binding has not been migrated" };
  delete doc.standard.readPrograms.quote;
  doc.standard.modules = { pricingFlow: { version: 1, steps: [
    { id: "price", requirements: { transports: ["eth-call"] }, requests: [{ id: "price", kind: "eth-call", to: "$target", data: "0x12345678", completion: "return-data" }], result: decoded("price") },
  ], result: { source: "$source", quotes: op("objectFromEntries", op("map", "$routes", "route", ["$route.routeKey", { amountIn: "$descriptor.oneAsset", amountOut: "$steps.price" }])) } } };
  const f = fixture(doc);
  assert.deepEqual(f.runtime.definition.exact.methods(f.input), []);
  assert(f.runtime.definition.execution.buildRuntimeLeg!(f.input));
  const descriptor = { ...f.descriptor, routes: f.routes, oneAsset: 10n, oneShare: 10n };
  const snapshot = f.runtime.definition.pricing.current.decodeSnapshot({ descriptor, initialResults: [result("price", 20n)], dependentEvidence: [] });
  assert.equal(Object.keys(snapshot.quotes).length, 2);
});
function dynamicDocument() {
  const doc: any = clone(root);
  doc.routes.directions = op("map", op("flatMap", "$descriptor.tokens", "tokenIn",
    op("map", op("filter", "$descriptor.tokens", "tokenOut", op("ne", "$tokenIn", "$tokenOut")), "tokenOut", { tokenIn: "$tokenIn", tokenOut: "$tokenOut" })),
    "pair", { id: op("join", ["$pair.tokenIn", "$pair.tokenOut"], ":"), enabled: true,
      tokenIn: "$pair.tokenIn", tokenOut: "$pair.tokenOut", adapterId: "fixture-convert", taxonomy: { slotKind: "protocol", protocolAction: "convert" }, fields: { pairIndex: "$index" } });
  doc.routes.key = op("join", ["$descriptor.familyId", op("lower", "$descriptor.vault"), op("lower", "$route.tokenIn"), op("lower", "$route.tokenOut")], "\u001f");
  doc.routes.assertions = [];
  doc.standard.assertions = [];
  doc.pricing.stateKey = "$route.routeKey";
  doc.pricing.draft = op("merge", "$descriptor", { routes: "$routes" });
  return doc;
}
test("dynamic verified-token directions bind keys and pair indexes, with isolated pricing state groups", () => {
  const f = fixture(dynamicDocument()), pricing = f.runtime.definition.pricing;
  assert.equal(f.routes.length, 6); assert.deepEqual(f.routes.map((r: any) => r.pairIndex), [0, 1, 2, 3, 4, 5]);
  for (const route of f.routes) {
    f.runtime.assertInvocation(f.descriptor, route);
    assert.equal(pricing.stateKey(route), route.routeKey);
    const draft = pricing.compileDraft({ descriptor: f.descriptor, routes: [route], stateKey: route.routeKey });
    assert.equal(draft.routes.length, 1);
    assert.throws(() => f.runtime.assertInvocation(f.descriptor, { ...route, pairIndex: 999 }));
  }
  assert.throws(() => pricing.compileDraft({ descriptor: f.descriptor, routes: f.routes, stateKey: f.routes[0].routeKey }));
  const entries = f.routes.map((route: any) => ({ descriptor: f.descriptor, routes: [route], stateKey: route.routeKey, dependencies: [f.descriptor.vault] }));
  const index = pricing.mutation!.compile!({ entries });
  assert.deepEqual(new Set(index.affectedStateKeys({ observation: { kind: "log", address: f.descriptor.vault } as any })), new Set(f.routes.map((r: any) => r.routeKey)));
});
test("declared zero-price unavailability withdraws only that direction and never hides RPC failure", () => {
  const doc: any = clone(root);
  doc.standard.pricing.classifyUnavailable = op("map", op("filter", "$routes", "route",
    op("eq", op("get", op("get", "$snapshot.quotes", "$route.routeKey"), "amountOut"), op("uint", "0"))), "route", ["$route.routeKey", "preview_zero"]);
  const f = fixture(doc), pricing = f.runtime.definition.pricing.current;
  const descriptor = { ...f.descriptor, routes: f.routes, oneAsset: 10n, oneShare: 10n };
  const initialResults = [result("current:deposit", 0n), result("current:redeem", 20n)];
  const snapshot = pricing.decodeSnapshot({ descriptor, initialResults, dependentEvidence: [] });
  assert.equal(pricing.classifyUnavailable!({ descriptor, snapshot, routes: f.routes }).get(f.routes[0].routeKey), "preview_zero");
  assert.equal(pricing.deriveMids({ descriptor, snapshot, routes: f.routes }).size, 1);
  assert.throws(() => pricing.decodeSnapshot({ descriptor, initialResults: [
    { id: "current:deposit", ok: false, failure: "rpc", source }, initialResults[1],
  ], dependentEvidence: [] }));
});

test("production quote flow materializes the same executor program and decodes its observed receipt", () => {
  const doc: any = clone(root);
  const receipt = { requestId: "execute", source: "$source",
    executor: "$executor", tokenIn: "$route.tokenIn", tokenOut: "$route.tokenOut", amountIn: "$amountIn" };
  doc.standard.modules = { quoteFlow: { version: 1, sourceKind: "effect-simulation",
    chainQuote: { step: "execution", requestId: "execute" },
    steps: [{ id: "execution", requirements: { transports: ["effect-delta-simulation"], caller: "executor",
      effects: ["return-data", "revert-data", "token-delta", "native-delta"] },
      requests: [{ kind: "declarative-execution-simulation", id: "execute", amountIn: "$amountIn" }],
      result: op("programReceipt", receipt) }], result: "$steps.execution" } };
  const f = fixture(doc), method = f.runtime.definition.exact.methods(f.input)[1] as any;
  const requests = method.program.buildRequests(f.input);
  assert.equal(requests[0].kind, "effect-delta-simulation");
  assert.equal(requests[0].call.executionMode, "executor-program");
  assert.equal(requests[0].overrideIntent.tokenBalances[0].amount, 7n);
  const returned: any = { id: "execute", ok: true, completion: "returned", data: "0x", source,
    provenance: { kind: "fixture", fingerprint: "fixture" }, effects: {
      tokenDeltas: [{ token: f.input.route.tokenIn, account: f.input.executor, delta: -7n }, { token: f.input.route.tokenOut, account: f.input.executor, delta: 19n }],
      nativeDeltas: [{ account: f.input.executor, delta: 0n }],
    } };
  assert.equal(method.program.decode({ programInput: f.input, initialResults: [returned], dependentEvidence: [] }).amountOut, 19n);
  assert.throws(() => method.program.decode({ programInput: f.input, initialResults: [{ ...returned, data: toBeHex(19, 32) }], dependentEvidence: [] }), /receipt/);
  doc.standard.modules.quoteFlow.steps[0].requests[0].context = { source };
  const bad = fixture(doc);
  assert.throws(() => (bad.runtime.definition.exact.methods(bad.input)[1] as any).program.buildRequests(bad.input), /replace.*invocation/);
});

test("identity stages consume observed actor and compile the common executor program without dedicated Family code", () => {
  const reference = fixture(), doc: any = clone(root);
  const candidate: any = { candidateKind: "fixture", vault: reference.descriptor.vault, descriptor: reference.descriptor, route: reference.routes[0] };
  const rawProbe = { id: "probe", kind: "effect-delta-simulation", call: { caller: { kind: "executor" }, to: "$candidate.vault", data: "0x12345678" },
    overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: "$candidate.route.tokenIn", amount: op("uint", "7") }] },
    observe: ["token-delta"], observeTokenBalances: [{ token: "$candidate.route.tokenIn", account: { kind: "executor" } }] };
  doc.identity.definition = { version: 1, identity: {
    select: [{ return: op("if", op("defined", "$evidence"), "program", "actor") }], stages: {
      actor: { requirements: { transports: ["effect-delta-simulation"], caller: "executor", effects: ["token-delta"] }, requests: [rawProbe], decode: [{ return: {
        source: op("get", op("returned", "probe"), "source"),
        executor: op("simulationActor", { requestId: "probe",
          source: op("get", op("returned", "probe"), "source"), tokenIn: "$candidate.route.tokenIn", amountIn: op("uint", "7") }),
      } }] },
      program: { requirements: { transports: ["effect-delta-simulation"], caller: "executor", effects: ["token-delta", "native-delta"] },
        requests: [{ kind: "declarative-execution-simulation", id: "execute", amountIn: op("uint", "7"),
          context: { descriptor: "$candidate.descriptor", route: "$candidate.route", direction: "$candidate.route.direction",
            source: "$evidence.source", executor: "$evidence.executor", runtimeEvidence: [] } }], decode: [{ return: { status: "verified" } }] },
    }, decide: [{ return: { status: "continue" } }],
  } };
  const f = fixture(doc), identity = f.runtime.definition.identity.variants[0]!;
  const first: any = { candidate, step: 0 };
  const probe: any = { id: "probe", ok: true, completion: "returned", data: "0x", source,
    provenance: { kind: "fixture", fingerprint: "fixture" }, effects: { tokenDeltas: [{ token: candidate.route.tokenIn, account: address(10), delta: -7n }] } };
  const evidence: any = identity.decode({ step: first, results: [probe] });
  assert.equal(evidence.executor, address(10));
  const second = identity.buildRequests({ candidate, step: 1, evidence });
  assert.equal(second[0]!.kind, "effect-delta-simulation");
  assert.equal((second[0] as any).call.to, address(10));
  assert.equal((second[0] as any).call.executionMode, "executor-program");
  assert.throws(() => identity.decode({ step: first, results: [{ ...probe, effects: { tokenDeltas: [{ token: candidate.route.tokenIn, account: address(10), delta: 0n }] } }] }), /input debit/);
});

test("dynamic route reuse requires a deeply immutable descriptor; mutable tokens never reuse stale projections", () => {
  const f = fixture(dynamicDocument());
  const deepFreeze = (value: any): any => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
  const immutable = deepFreeze({ ...f.descriptor, tokens: Array.from({ length: 32 }, (_, index) => address(index + 1)) });
  const routes = f.runtime.definition.routes.project({ descriptor: immutable });
  assert.equal(routes.length, 992);
  assert.strictEqual(f.runtime.definition.routes.project({ descriptor: immutable }), routes);
  for (const route of routes) f.runtime.assertInvocation(immutable, route);
  const mutable = Object.freeze({ ...f.descriptor, tokens: [...f.descriptor.tokens] });
  const before = f.runtime.definition.routes.project({ descriptor: mutable });
  mutable.tokens.push(address(4));
  const after = f.runtime.definition.routes.project({ descriptor: mutable });
  assert.equal(before.length, 6); assert.equal(after.length, 12); assert.notStrictEqual(before, after);
});

test("declared prefix restrictions apply to requirements, zero, requests and decode", () => {
  const doc = chainedDocument();
  doc.standard.exact.checks = [{ condition: op("eq", op("length", op("coalesce", "$prefix", [])), 0), error: "prefix unsupported" }];
  doc.standard.inputs = [...(doc.standard.inputs ?? []), "prefix"];
  const f = fixture(doc), q = quote(f), prefixed = { ...f.input, prefix: [{}], trialState: { get: () => undefined } };
  assert.throws(() => q.method.program.requirements(prefixed), /prefix/);
  assert.throws(() => q.method.program.buildRequests(prefixed), /prefix/);
  assert.throws(() => q.method.program.decode({ programInput: prefixed, initialResults: q.initialResults, dependentEvidence: q.dependentEvidence }), /prefix/);
  const zero: any = f.runtime.definition.exact.methods(f.input)[0];
  assert.throws(() => zero.quote({ ...prefixed, amountIn: 0n }), /prefix/);
});
