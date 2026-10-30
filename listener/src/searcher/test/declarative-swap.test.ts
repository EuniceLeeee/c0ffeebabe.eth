import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Interface, MaxUint256, ZeroAddress, ZeroHash, hexlify, toBeHex } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { createDeclarativeSwapRuntime } from "../venues/declarative-swap.js";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { projectDeclarativePrices } from "../venues/declarative-pricing-projection.js";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";

// One fixture driver for Swap declarations. Recorded reads prove field parity;
// the independent program interpreter proves guards, not EVM or admission.
// Real same-state execution/rollback uses protocol-json-acceptance.ts.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const load = (url: URL) => JSON.parse(readFileSync(url, "utf8"));
const fixtures = [load(new URL("./fixtures/swap-json/balancer-v1-fields.json", import.meta.url))];
const listenerRoot = new URL("../../../", import.meta.url);
const word = (value: bigint) => toBeHex(value, 32);
const token = new Interface([
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);
const lower = (value: string) => value.toLowerCase();

function harness(fixture: any, definition = load(new URL(fixture.definition, listenerRoot))) {
  const runtime = createDeclarativeSwapRuntime(clone(definition));
  const family: any = runtime.definition;
  function answer(request: any, replacement?: string, source = fixture.source) {
    const saved = request.kind === "get-code"
      ? fixture.responses.code.find((row: any) => lower(row.address) === lower(request.address))
      : request.kind === "eth-call"
        ? fixture.responses.calls.find((row: any) => lower(row.to) === lower(request.to) && row.data === request.data)
        : undefined;
    assert(saved, `no recorded full request for ${request.kind}:${request.id}`);
    return { id: request.id, data: replacement ?? saved.result, source, ok: true, completion: "returned",
      provenance: { kind: "synthetic-binding-of-saved-public-inputs", fingerprint: "fixture-not-admission" } };
  }
  function identity(reply = answer) {
    const variant = family.identity.variants[0], rounds: string[][] = [];
    let evidence: any;
    for (let step = 0; step <= fixture.expected.identityRounds.length; step++) {
      const input = { candidate: fixture.candidate, evidence, step }, decision = variant.decide(input);
      if (decision.status !== "continue") return { decision, rounds };
      const requests = variant.buildRequests(input);
      rounds.push(requests.map((request: any) => request.id));
      evidence = variant.decode({ step: input, results: requests.map((request: any) => reply(request)) });
    }
    throw new Error("fixture identity did not terminate");
  }
  function descriptor() {
    const result = identity(); assert.equal(result.decision.status, "verified");
    const verified = result.decision.identity;
    return family.instance.finalizeDescriptor({ identity: verified, draft: family.instance.compileDraft(verified), sharedBindings: [] });
  }
  function quote(amountIn: bigint, direction: string, d = descriptor()) {
    const route = family.routes.project({ descriptor: d }).find((route: any) => route.direction === direction);
    assert(route, "fixture direction must be naturally projected");
    const input = { descriptor: d, route, amountIn, source: fixture.source, executor: fixture.executor, runtimeEvidence: [] };
    const method = family.exact.methods(input).find((method: any) => method.kind === "request-program");
    assert(method); const program = method.program;
    const initialResults = program.buildRequests(input).map((request: any) => answer(request));
    const dependentEvidence: any[] = [], rounds: any[] = [];
    for (let completedRound = 0; completedRound < 16; completedRound++) {
      const round = program.buildDependentProgram?.({ programInput: input, completedRound, initialResults, priorEvidence: dependentEvidence });
      if (!round) return { input, method, initialResults, dependentEvidence, rounds,
        quoted: program.decode({ programInput: input, initialResults, dependentEvidence }) };
      rounds.push(round.requests);
      dependentEvidence.push(round.decode(round.requests.map((request: any) => answer(request))));
    }
    throw new Error("fixture quote exceeded dependent-round bound");
  }
  function prices(d = descriptor()) {
    const routes = family.routes.project({ descriptor: d });
    const draft = family.pricing.compileDraft({ descriptor: d, routes, stateKey: family.pricing.stateKey(routes[0]) });
    const staticRequests = family.pricing.staticEvidence.buildRequests(draft);
    const staticEvidence = family.pricing.staticEvidence.decode({ draft, results: staticRequests.map((request: any) => answer(request)) });
    const pricingDescriptor = family.pricing.finalizePricingDescriptor({ draft, staticEvidence, sharedBindings: [] });
    const current = { descriptor: pricingDescriptor, routes, source: fixture.source };
    const requests = family.pricing.current.buildRequests(current), initialResults = requests.map((request: any) => answer(request));
    const dependent = family.pricing.current.buildDependentProgram?.({ current, completedRound: 0, initialResults, priorEvidence: [] });
    const snapshot = family.pricing.current.decodeSnapshot({ ...current, initialResults, dependentEvidence: [] });
    return { ...current, staticRequests, requests, initialResults, dependent, snapshot,
      mids: family.pricing.current.deriveMids({ ...current, snapshot }) };
  }
  return { fixture, definition, runtime, family, answer, identity, descriptor, quote, prices };
}

for (const fixture of fixtures) {
  const h = () => harness(fixture);
  test(`${fixture.familyId}: fixture bytes bind provenance and three source-bound identity rounds`, () => {
    for (const provenance of fixture.provenance) {
      const bytes = readFileSync(new URL(provenance.path, listenerRoot));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.sha256);
    }
    const x = h(), verified = x.identity();
    assert.equal(verified.decision.status, "verified");
    assert.deepEqual(verified.rounds, fixture.expected.identityRounds);
    const descriptor = x.descriptor();
    assert.equal(descriptor.familyId, fixture.familyId);
    assert.equal(descriptor.lineageId, fixture.expected.lineageId);
    assert.deepEqual(JSON.parse(JSON.stringify(x.runtime.projection(descriptor), (_key, value) =>
      typeof value === "bigint" ? String(value) : value)), fixture.expected.binding);
    for (const rejection of fixture.expected.identityRejections) {
      const result = x.identity(request => x.answer(request, request.id === rejection.requestId ? rejection.replacement : undefined));
      assert.equal(result.decision.status, rejection.status, rejection.requestId);
      assert.equal(result.decision.reasonCode, rejection.reasonCode, rejection.requestId);
    }
    const variant = x.family.identity.variants[0], step = { candidate: fixture.candidate, step: 0 };
    const results = variant.buildRequests(step).map((request: any) => x.answer(request));
    for (const changed of [results.slice(1), [...results, results[0]], results.map((row: any, i: number) => i ? row :
      { ...row, source: { ...fixture.source, hash: ZeroHash } })])
      assert.throws(() => variant.decode({ step, results: changed }));
    const carried = variant.decode({ step, results });
    const next = { candidate: { ...fixture.candidate, pool: toBeHex(999, 20) }, evidence: carried, step: 1 };
    assert.throws(() => variant.buildRequests(next), /binding|continuation|candidate/);
  });

  test(`${fixture.familyId}: discovery ABI roundtrip is nomination, malformed calls/logs cannot nominate`, () => {
    const x = h(), descriptor = x.descriptor();
    for (const call of x.definition.discovery.definition.calls) {
      const abi = new Interface([call.signature]);
      const functionName = abi.fragments.find((fragment: any) => fragment.type === "function")!.format("sighash");
      const data = abi.encodeFunctionData(functionName, [descriptor.tokens[0], 10n, descriptor.tokens[1], 1n, MaxUint256]);
      const observation = { kind: "call", source: fixture.source, target: descriptor.pool, data };
      const candidate = x.family.discovery.decodeCandidate({ observation, matchedPatternId: call.id });
      assert.deepEqual({ ...candidate, pool: lower(candidate.pool) }, fixture.candidate);
      for (const badData of [data + "00", data.slice(0, -2), "0x"])
        assert.equal(x.family.discovery.decodeCandidate({ observation: { ...observation, data: badData }, matchedPatternId: call.id }), null);
    }
    const event = x.definition.discovery.definition.events[0], abi = new Interface([event.signature]);
    const fragment = abi.fragments.find((fragment: any) => fragment.type === "event")!.format("sighash");
    const encoded = abi.encodeEventLog(fragment, [fixture.executor, descriptor.tokens[0], descriptor.tokens[1], 10n, 20n]);
    const observation = { kind: "log", source: fixture.source, address: descriptor.pool, ...encoded };
    const candidate = x.family.discovery.decodeCandidate({ observation, matchedPatternId: event.id });
    assert.deepEqual({ ...candidate, pool: lower(candidate.pool) }, fixture.candidate);
    for (const changed of [{ data: encoded.data + "00" }, { topics: encoded.topics.slice(0, -1) }])
      assert.equal(x.family.discovery.decodeCandidate({ observation: { ...observation, ...changed }, matchedPatternId: event.id }), null);
  });

  test(`${fixture.familyId}: all directed pairs retain one graph and binding identity`, () => {
    const x = h(), base = x.descriptor();
    for (const count of [2, 3, 8]) {
      const descriptor = { ...base, tokens: Array.from({ length: count }, (_, i) => toBeHex(i + 101, 20)),
        weights: Array<bigint>(count).fill(10n ** 18n) };
      const routes = x.family.routes.project({ descriptor });
      assert.equal(routes.length, count * (count - 1));
      assert.equal(new Set(routes.map((route: any) => route.routeKey)).size, routes.length);
      for (const route of routes) {
        assert.notEqual(route.tokenIn, route.tokenOut);
        const graph = x.family.routes.projectGraph({ descriptor, route });
        assert.equal(graph.executionTarget, descriptor.pool);
        assert.equal(graph.routeActionAdapterId, route.adapterId);
        assert.equal(graph.centralScoreKey, route.routeKey);
        assert(x.family.execution.buildRuntimeLeg({ descriptor, route, executor: fixture.executor, source: fixture.source, runtimeEvidence: [] }));
      }
      assert.throws(() => x.family.routes.projectGraph({ descriptor, route: { ...routes[0], tokenOut: toBeHex(999, 20) } }));
    }
  });

  test(`${fixture.familyId}: pricing uses one recorded balance round and touch-only refresh`, () => {
    const x = h(), p = x.prices();
    assert.deepEqual(p.staticRequests, []);
    assert.deepEqual(p.requests.map((request: any) => request.id), fixture.expected.pricing.requestIds);
    assert.equal(p.dependent, null, "no extra pricing read round");
    assert.deepEqual(p.snapshot.balances.map(String), fixture.expected.pricing.balances);
    assert.equal(p.mids.size, p.routes.length);
    for (const [index, route] of p.routes.entries()) {
      const mid = p.mids.get(route.routeKey); assert.equal(mid.kind, "external-swap");
      assert.equal(mid.mid, Number(fixture.expected.pricing.rawMidNumerator) / Number(fixture.expected.pricing.rawMidDenominators[index]));
    }
    assert.equal(x.family.pricing.refreshPolicyForInstance(p), fixture.expected.pricing.statePolicy);
    const dependencies = x.family.pricing.dependencies(p); assert.deepEqual(dependencies, [fixture.candidate.pool]);
    const stateKey = x.family.pricing.stateKey(p.routes[0]);
    const index = x.family.pricing.mutation.compile({ entries: [{ ...p, stateKey, dependencies }] });
    for (const kind of ["call", "log"]) for (const target of [fixture.candidate.pool, p.descriptor.tokens[0], toBeHex(999, 20)]) {
      const observation = kind === "call" ? { kind, source: fixture.source, target, data: "0xdeadbeef" }
        : { kind, source: fixture.source, address: target, data: "0x", topics: [] };
      const expected = target === fixture.candidate.pool ? [stateKey] : [];
      assert.deepEqual(index.affectedStateKeys({ observation }), expected);
      assert.deepEqual(x.family.pricing.mutation.affectedStateKeys({ ...p, observation }), expected);
    }
    assert.notDeepEqual(x.family.pricing.current.deriveMids({ ...p, snapshot: { ...p.snapshot,
      balances: [p.snapshot.balances[0] * 2n, p.snapshot.balances[1]] } }), p.mids);
    const empty = { ...p.snapshot, balances: [0n, p.snapshot.balances[1]] };
    assert.equal(x.family.pricing.current.classifyUnavailable({ ...p, snapshot: empty }).size, 2);
    assert.equal(x.family.pricing.current.deriveMids({ ...p, snapshot: empty }).size, 0);
  });

  test(`${fixture.familyId}: exact keeps original specified input, nonlinear pinned quotes and source provenance`, () => {
    const x = h();
    for (const expected of fixture.expected.quotes) {
      if (expected.expected === "reject-zero-output") {
        assert.throws(() => x.quote(BigInt(expected.amountIn), expected.direction), /output|spendable/); continue;
      }
      const q = x.quote(BigInt(expected.amountIn), expected.direction);
      assert.equal(q.method.chainAmountQuote, true);
      assert.equal(q.quoted.amountOut, BigInt(expected.amountOut));
      assert.equal(q.quoted.evidence.amountIn, BigInt(expected.amountIn));
      assert.deepEqual(q.initialResults.map((row: any) => row.id), fixture.expected.pricing.requestIds);
      assert.equal(q.rounds.length, 1); assert.equal(q.rounds[0].length, 1);
      const calc = new Interface(x.definition.standard.abi.pool);
      assert.equal(calc.parseTransaction({ data: q.rounds[0][0].data })!.args[4], BigInt(expected.amountIn));
      for (const changed of [[], [...q.dependentEvidence, ...q.dependentEvidence]])
        assert.throws(() => q.method.program.decode({ programInput: q.input, initialResults: q.initialResults, dependentEvidence: changed }));
      assert.throws(() => q.method.program.decode({ programInput: { ...q.input, source: { ...fixture.source, generation: 2 } },
        initialResults: q.initialResults, dependentEvidence: q.dependentEvidence }));
    }
    const direction = fixture.expected.quotes[0].direction;
    assert.equal(x.quote(0n, direction).quoted.amountOut, 0n);
    assert.deepEqual(x.quote(0n, direction).initialResults, []);
    assert.throws(() => x.quote(-1n, direction), /negative|uint256/);
    assert.throws(() => x.quote(MaxUint256 + 1n, direction), /uint256/);
    const max = BigInt(fixture.expected.pricing.balances[0]) / 2n + 1n;
    assert.throws(() => x.quote(max, direction), /MAX_IN_RATIO/);
  });

  test(`${fixture.familyId}: quoted and runtime bytecode preserve ABI input, debit, receipt, approvals and old inventory`, () => {
    const x = h();
    for (const direction of new Set<string>(fixture.expected.quotes.map((row: any) => row.direction))) {
      const expected = fixture.expected.quotes.find((row: any) => row.direction === direction && row.expected === "quoted");
      const q = x.quote(BigInt(expected.amountIn), direction), { descriptor, route } = q.input;
      const input: any = { descriptor, route, executor: fixture.executor, source: fixture.source, runtimeEvidence: [] };
      for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
        Object.defineProperty(input, key, { get() { throw new Error(`runtime read of ${key}`); } });
      const leg = x.family.execution.buildRuntimeLeg(input); assert(leg);
      assert.equal(leg.settlement?.directOutput === true, fixture.expected.settlement.directOutput);
      assert.equal(leg.settlement?.deferredInput === true, fixture.expected.settlement.deferredInput);
      assert.equal(x.family.execution.buildRuntimeLeg({ descriptor, route, executor: fixture.executor, source: fixture.source,
        runtimeEvidence: [], settlement: { kind: "direct-output", recipient: toBeHex(990, 20) } }), null);
      const quotedInput = { ...q.input, quotedAmountOut: q.quoted.amountOut, minAmountOut: q.quoted.amountOut, exactEvidence: q.quoted.evidence };
      const fragment = x.family.execution.buildFragment(quotedInput);
      assert.deepEqual(fragment.requirements, []);
      assert.equal(fragment.nodes.length, 1);
      const node = fragment.nodes[0], action = x.family.actionAdapters.find((action: any) => action.id === node.adapterId);
      assert(action.encode(node, fixture.executor, new Uint8Array()).length > 0);
      assert.throws(() => action.encode(node, fixture.executor, new Uint8Array([1])));
      for (const changed of [{ amountIn: q.input.amountIn + 1n }, { executor: toBeHex(990, 20) },
        { exactEvidence: { ...q.quoted.evidence, binding: "foreign" } }])
        assert.throws(() => x.family.execution.buildFragment({ ...quotedInput, ...changed }), `quoted must reject ${Object.keys(changed).join(",")}`);
      const call = new Interface([x.definition.standard.execution.call.signature]);
      const functionName = call.fragments.find((fragment: any) => fragment.type === "function")!.format("sighash");
      function run(program: string, minimum: bigint, fault: { debit?: bigint; receipt?: bigint; returned?: bigint; clear?: boolean; native?: bigint } = {}) {
        const amount = q.input.amountIn, returned = fault.returned ?? q.quoted.amountOut;
        const beforeIn = amount + 101n, beforeOut = q.quoted.amountOut + 103n;
        let swapped = false, allowance = 77n;
        const trace = inspectRuntime(program, amount, { nativeBalance: () => 17n + (swapped ? fault.native ?? 0n : 0n), call(c) {
          if (c.data.startsWith(token.getFunction("balanceOf")!.selector)) return word(lower(c.target) === lower(route.tokenIn)
            ? beforeIn - (swapped ? fault.debit ?? amount : 0n) : beforeOut + (swapped ? fault.receipt ?? returned : 0n));
          if (c.data.startsWith(token.getFunction("allowance")!.selector)) return word(allowance);
          if (c.data.startsWith(token.getFunction("approve")!.selector)) {
            const args = token.decodeFunctionData("approve", c.data);
            assert.equal(lower(c.target), lower(route.tokenIn)); assert.equal(lower(args[0]), lower(descriptor.pool));
            if (fault.clear !== false || args[1] !== 0n) allowance = args[1];
            return word(1n);
          }
          assert.equal(lower(c.target), lower(descriptor.pool));
          const args = call.decodeFunctionData(functionName, c.data);
          assert.deepEqual([lower(args[0]), args[1], lower(args[2]), args[3], args[4]],
            [lower(route.tokenIn), amount, lower(route.tokenOut), minimum, MaxUint256]);
          assert.equal(allowance, amount); swapped = true;
          return call.encodeFunctionResult(functionName, [returned, 0n]);
        } });
        assert(swapped); assert.equal(allowance, 0n);
        assert.equal(beforeIn - amount, 101n, "old input inventory untouched");
        assert.equal(trace.registers[0], amount, "runtime amount remains the actual incoming amount");
        return trace;
      }
      for (const [program, minimum] of [[leg.program, 1n], [node.params.runtimeAmountProgram, q.quoted.amountOut]] as const) {
        const trace = run(program, minimum);
        assert.deepEqual(trace.calls.filter(c => c.data.startsWith(token.getFunction("approve")!.selector))
          .map(c => token.decodeFunctionData("approve", c.data)[1]), [0n, q.input.amountIn, 0n]);
        for (const fault of [{ debit: 0n }, { debit: q.input.amountIn - 1n }, { debit: q.input.amountIn + 1n },
          { receipt: 0n }, { receipt: q.quoted.amountOut - 1n }, { returned: 0n }, { clear: false }, { native: 1n }])
          assert.throws(() => run(program, minimum, fault), `execution guard ${JSON.stringify(fault, (_key, value) => typeof value === "bigint" ? String(value) : value)}`);
      }
      for (const executor of [ZeroAddress, descriptor.pool, descriptor.factory, ...descriptor.tokens])
        assert.throws(() => x.family.execution.buildRuntimeLeg({ descriptor, route, executor, source: fixture.source, runtimeEvidence: [] }));
    }
  });

  test(`${fixture.familyId}: quoted minimum remains positive and bounded by the proved quote`, () => {
    const x = h();
    for (const expected of fixture.expected.quotes.filter((row: any) => row.expected === "quoted")) {
      const q = x.quote(BigInt(expected.amountIn), expected.direction);
      const input = { ...q.input, quotedAmountOut: q.quoted.amountOut, exactEvidence: q.quoted.evidence };
      for (const minAmountOut of [0n, -1n, q.quoted.amountOut + 1n])
        assert.throws(() => x.family.execution.buildFragment({ ...input, minAmountOut }), `invalid minimum ${minAmountOut}`);
    }
  });

  test(`${fixture.familyId}: production amount-selector construction uses runtime only with zero Exact or quoted calls`, async () => {
    const x = h(), descriptor = x.descriptor();
    for (const route of x.family.routes.project({ descriptor })) {
      const input = { descriptor, route, executor: fixture.executor, source: fixture.source, runtimeEvidence: [] };
      const legs = [x.family.execution.buildRuntimeLeg(input),
        { actionAdapterId: "fixture-return", program: hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }];
      const edges: any[] = [
        { adapterId: route.adapterId, target: route.target, tokenIn: route.tokenIn, tokenOut: route.tokenOut },
        { adapterId: "fixture-return", target: fixture.executor, tokenIn: route.tokenOut, tokenOut: route.tokenIn },
      ];
      let exact = 0, quoted = 0, rpc = 0, simulated = 0;
      const events: any[] = [];
      const session: any = { source: fixture.source, fundingActionIds: () => ["fixture-funding"],
        buildRuntimeAmountLeg({ edge }: any) { return legs[edges.indexOf(edge)]; },
        issueExact() { exact++; throw new Error("unexpected Exact"); },
        buildExecution() { quoted++; throw new Error("quoted fallback"); },
        buildFundingRoot(input: any) { return { adapterId: "fixture", target: fixture.executor,
          tokenIn: route.tokenIn, tokenOut: route.tokenIn, amount: input.amount, params: {}, children: input.children }; },
      };
      const selector = createBlockScanSimAmountSelector({ source: fixture.source, executor: fixture.executor,
        record: event => events.push(event), async simulate(plan) {
          simulated++;
          assert.equal(plan.root.children[0].adapterId, "runtime-amount-flow");
          assert.equal(JSON.parse(plan.root.children[0].params.legs as string)[0].program, legs[0].program);
          // Synthetic simulator response exercises only production construction.
          // It does not claim that this artificial loop exists or is profitable.
          return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: route.tokenIn, calldata: "0x" };
        } });
      await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
        flashToken: route.tokenIn, profitToken: route.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n,
        templateName: "shared-declaration-construction-not-history" } as any,
      { call() { rpc++; throw new Error("unexpected RPC"); } } as any, { executor: fixture.executor } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
      assert.deepEqual([exact, quoted, rpc], [0, 0, 0]); assert(simulated >= 4);
      const constructions = events.filter(event => event.type === "sim_amount_construction");
      assert(constructions.length > 0); assert(constructions.every(event => event.mode === "runtime-actual"));
    }
  });

  test(`${fixture.familyId}: strict receipt consumes genuine trigger once and rejects malformed/ambiguous ownership`, async () => {
    const x = h(), descriptor = x.descriptor(), routes = x.family.routes.project({ descriptor });
    const event = x.definition.swap.events[0], abi = new Interface([event.signature]);
    const eventName = abi.fragments.find((fragment: any) => fragment.type === "event")!.format("sighash");
    const encoded = abi.encodeEventLog(eventName, [fixture.executor, routes[0].tokenIn, routes[0].tokenOut, 10n, 20n]);
    const log = { address: descriptor.pool, ...encoded };
    const graph = routes.map((route: any) => ({ adapterId: route.adapterId, target: route.target, instanceKey: route.instanceKey,
      tokenIn: route.tokenIn, tokenOut: route.tokenOut }));
    const trigger = { triggerId: "owned:0", logIndex: 0, emitter: descriptor.pool, topic0: encoded.topics[0] };
    const context: any = { logs: [log], graph, edgesByTarget: new Map([[descriptor.pool, graph]]),
      sourceGeneration: { id: "fixture-receipt" }, resolveBinding: () => ({ familyId: fixture.familyId, descriptor }),
      matchedOwnedTriggers: [trigger], control: { deadlineAtMs: Date.now() + 10000, signal: new AbortController().signal } };
    const receipt = x.family.swap.receiptObservation;
    const result = await receipt.decodeReceiptImpacts(context);
    assert.equal(result.status, "resolved"); assert.equal(result.impacts.length, 1);
    assert.equal(result.impacts[0].impact.amountIn, 10n); assert.equal(result.impacts[0].impact.amountOut, 20n);
    assert.deepEqual(result.consumedTriggerIds, [trigger.triggerId]);
    for (const changed of [
      { matchedOwnedTriggers: [trigger, trigger] }, { matchedOwnedTriggers: [{ ...trigger, emitter: toBeHex(999, 20) }] },
      { logs: [{ ...log, data: log.data + "00" }] }, { logs: [{ ...log, topics: log.topics.slice(0, -1) }] },
      { edgesByTarget: new Map([[descriptor.pool, [graph[0], graph[0]]]]) },
    ]) assert.equal((await receipt.decodeReceiptImpacts({ ...context, ...changed })).status, "unresolved");
    assert.equal((await receipt.decodeReceiptImpacts({ ...context, matchedOwnedTriggers: [] })).status, "no-match");
    const absent = await receipt.decodeReceiptImpacts({ ...context, graph: [], edgesByTarget: new Map() });
    assert.equal(absent.status, "resolved"); assert.equal(absent.impacts.length, 0); assert.equal(absent.mutations.length, 1);
    // A singleton event's 32-byte id cannot be rebound to an unrelated graph instance,
    // even if a faulty declaration's custom matching expression says true.
    const wrong: any = clone(x.definition), poolId = toBeHex(123, 32);
    wrong.swap.events[0].pool = poolId; wrong.swap.events[0].match = true;
    wrong.swap.events[0].impact = { pool: "$edge.target", poolId, matchedAdapterId: "$edge.adapterId",
      tokenIn: "$edge.tokenIn", tokenOut: "$edge.tokenOut", amountIn: { op: "uint", args: ["10"] } };
    const boundary = harness(fixture, wrong).family.swap.receiptObservation;
    assert.equal((await boundary.decodeReceiptImpacts({ ...context, graph: [graph[0]], edgesByTarget: new Map() })).status, "unresolved");
  });

  test(`${fixture.familyId}: absent optional modules stay visible as empty and do not add state reads`, () => {
    const x = h(), p = x.prices();
    const old: any = clone(x.definition);
    for (const [key, value] of Object.entries(old.modules)) if (Object.keys(value as object).length === 0) delete old.modules[key];
    for (const key of ["localApply", "overlay", "poolMaterialization", "replay"]) delete old.swap[key];
    const legacy = harness(fixture, old), prior = legacy.prices();
    assert.deepEqual(prior.requests, p.requests);
    assert.deepEqual(legacy.runtime.moduleCoverage, x.runtime.moduleCoverage);
    assert.deepEqual(legacy.runtime.moduleViews, x.runtime.moduleViews);
    for (const name of ["oracleVictim", "executionMath", "trialState"]) {
      const row = x.runtime.moduleCoverage[0].modules.find((row: any) => row.key === name);
      assert.equal(row?.state, "undefined");
      assert.deepEqual(x.runtime.moduleViews[0].modules[name], {});
    }
    for (const name of ["localApply", "overlay", "poolMaterialization", "replay"])
      assert.equal(legacy.family.swap[name], undefined);
    const unknown: any = clone(x.definition); unknown.modules.futureUnregistered = {};
    assert.throws(() => harness(fixture, unknown), /unknown declarative module/);
  });
}

test("Swap/Protocol domain is explicit and cannot accidentally consume the other declaration", () => {
  const fixture = fixtures[0], original = load(new URL(fixture.definition, listenerRoot));
  assert.throws(() => createDeclarativeProtocolRuntime(original), /Protocol|protocol/);
  for (const domain of ["protocol", "credit", undefined]) {
    const changed = clone(original); changed.production.domain = domain;
    assert.throws(() => createDeclarativeSwapRuntime(changed), /Swap/);
  }
  const changed = clone(original); changed.manifest.domain = "protocol";
  assert.throws(() => createDeclarativeSwapRuntime(changed));
});

test("shared raw-price projection rejects duplicate, missing, unavailable and non-integer route rows", () => {
  const x = harness(fixtures[0]), descriptor = x.descriptor(), routes = x.family.routes.project({ descriptor });
  const rows = routes.map((route: any) => ({ routeKey: route.routeKey, numerator: 1n, denominator: 2n, depth: 3n }));
  const project = (value: any, unavailable = new Map()) => projectDeclarativePrices({ domain: "swap", routes, unavailable, rows: value });
  assert.equal(project(rows).size, 2);
  for (const changed of [rows.slice(1), [...rows, rows[0]], rows.map((row: any, i: number) => i ? row : { ...row, denominator: 0n }),
    rows.map((row: any, i: number) => i ? row : { ...row, numerator: 1 }),
    rows.map((row: any, i: number) => i ? row : { ...row, depth: -1n }),
    rows.map((row: any, i: number) => i ? row : { ...row, reserveA: 1n << 256n }),
    rows.map((row: any, i: number) => i ? row : { ...row, feeBps: 10001n })]) assert.throws(() => project(changed));
  assert.throws(() => project(rows, new Map([[routes[0].routeKey, "unavailable"]])));
  assert.equal(project(rows.slice(1), new Map([[routes[0].routeKey, "unavailable"]])).size, 1);
});
