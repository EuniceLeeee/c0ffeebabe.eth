import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "ethers";
import { createRevmStrictSimulationTransport } from "../revm-strict-simulation-transport.js";
import { RevmFatalError, RevmStrictError, type DaemonResponse, type RevmFatalReason,
  type RevmRequestControl, type StrictSimulateRequest } from "../revm-sim-client.js";
import { createStrictCentralAdapterRuntime, type StrictSimulationTransport } from "../strict-central-adapter-runtime.js";
import { executeAdapterWork } from "../adapter-work-intent.js";
import { RevmStrictSourceOwner, type RevmStrictSourceLease } from "../revm-strict-source-owner.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { materializeAdapterRequests } from "../reth-adapter-work-runtime.js";

type Invocation = Parameters<StrictSimulationTransport["simulate"]>[0];
type MutableInvocation = { -readonly [K in keyof Invocation]: Invocation[K] };
type PrefixInvocation = Parameters<NonNullable<StrictSimulationTransport["simulatePrefix"]>>[0];
const addr = (n: string) => `0x${n.repeat(40)}`, hash = (n: string) => `0x${n.repeat(64)}`;
const EXECUTOR = addr("a"), ACTOR = addr("b"), ORIGIN = addr("c"), OBSERVED = addr("d"), TARGET = addr("e"), TOKEN = addr("f");
const SOURCE = Object.freeze({ number: 25_700_444, hash: hash("1"), generation: 44 });
const PIN = Object.freeze({ chainId: 1, blockHash: SOURCE.hash, stateRoot: hash("2") });
const RPC_URL = "http://user:secret@localhost:8545/private-key", GAS = 1_000_000;
function invocation(): MutableInvocation {
  return { source: { ...SOURCE }, callerAuthority: { executor: EXECUTOR, transactionOrigin: ORIGIN,
    observedSender: OBSERVED, verifiedActors: { probe: ACTOR } }, request: { id: "sim", kind: "effect-delta-simulation",
    call: { caller: { kind: "executor" }, executionMode: "impersonated-call-frame", to: TARGET, data: "0xdead" },
    overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: TOKEN, amount: 137n }], nativeBalanceWei: 17n },
    observe: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] } };
}
function response(req: StrictSimulateRequest): DaemonResponse {
  return { ok: true, success: true, output: "0xbeef", gasUsed: "21000", latencyMs: 1,
    sourceAttestation: { kind: "node-attested", ...PIN, stateRoot: PIN.stateRoot, blockNumber: SOURCE.number, parentHash: hash("3") },
    strict: { outcome: { kind: "Success", phase: "main", output: "0xbeef" }, executionGasUsed: "21000",
      tokenDeltas: (req.observeTokenBalances ?? []).map(({ token, account }) => ({ token, account, delta: "-137" })),
      nativeDeltas: (req.observeNativeBalances ?? []).map(account => ({ account, before: "17", after: "154", delta: "137" })),
      totalSupplyDeltas: (req.observeTotalSupply ?? []).map(token => ({ token, delta: "-137" })),
      logs: req.observeLogs ? [{ address: TARGET, topics: [hash("4")], data: "0x00" }] : [] } };
}
function failure(req: StrictSimulateRequest, kind: "Revert" | "Halt", phase: "main" | "preCall" = "main"): DaemonResponse {
  const r = response(req), where = phase === "main" ? { phase } : { phase, preCallIndex: 0 };
  r.success = false; r.strict!.outcome = kind === "Revert" ? { kind, ...where, output: "0xdeadbeef" } : { kind, ...where, reason: "OutOfGas" };
  r.output = kind === "Revert" ? "0xdeadbeef" : undefined; r.revertReason = kind === "Revert" ? r.output : undefined;
  r.strict!.tokenDeltas = []; r.strict!.nativeDeltas = []; r.strict!.totalSupplyDeltas = []; r.strict!.logs = []; return r;
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function fixture(run: (req: StrictSimulateRequest, control?: RevmRequestControl) => Promise<DaemonResponse> = async req => response(req)) {
  const calls: StrictSimulateRequest[] = [], controls: (RevmRequestControl | undefined)[] = [], fatals: RevmFatalReason[] = [], sources: Invocation["source"][] = [];
  const lease: RevmStrictSourceLease = { source: { ...SOURCE }, sourcePin: { ...PIN },
    async strictSimulate(req, control) { calls.push(req); controls.push(control); return run(req, control); },
    async closeAndDrain() { throw new Error("request transport must not retire source lease"); } };
  const options = { rpcUrl: RPC_URL, executionGasLimit: GAS,
    async leaseFor(source: Invocation["source"]) { sources.push(source); return lease; }, onFatal(reason: RevmFatalReason) { fatals.push(reason); } };
  return { transport: createRevmStrictSimulationTransport(options), options, calls, controls, fatals, sources, lease };
}
function notEvidence(e: unknown): boolean {
  assert(e instanceof Error); assert.notEqual((e as Error & { code?: unknown }).code, "CALL_EXCEPTION");
  assert(!e.message.includes("secret")); assert(!e.message.includes("private-key")); return true;
}
function prefixInvocation(request: PrefixInvocation["request"] = {
  id: "view", kind: "eth-call", to: TARGET, data: "0x1234", caller: { kind: "executor" }, completion: "return-data",
}): PrefixInvocation {
  return { ...invocation(), request, prefix: { executor: EXECUTOR, calldata: "0x12345678", inputToken: TOKEN, inputAmount: 123n } };
}
const PROGRAM_CODE = { code: "0x60006000f3", keccak256: keccak256("0x60006000f3") };
function programInvocation(): MutableInvocation {
  const v = invocation();
  v.request = { ...v.request,
    call: { caller: { kind: "executor" }, executionMode: "executor-program", to: EXECUTOR,
      data: buildSubscriptCalldata(new Uint8Array([0])) },
    overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: TOKEN, amount: 137n }] },
    observeTokenBalances: [{ token: TOKEN, account: { kind: "executor" } }],
    observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"],
  };
  return v;
}
function programResponse(req: StrictSimulateRequest): DaemonResponse {
  const r = response(req);
  const code = req.executorRuntimeCode ?? req.trialPrefix?.executorRuntimeCode;
  r.strict!.counterfactualExecutorCode = { address: req.trialPrefix?.executor ?? req.to, keccak256: code!.keccak256 };
  return r;
}
function nativeProgramInvocation(nativeInput = true): MutableInvocation {
  const v = programInvocation(), weth = ADDR.WETH.toLowerCase();
  const tokenIn = nativeInput ? weth : TOKEN, tokenOut = nativeInput ? TOKEN : weth;
  v.request = { ...v.request, executionAssetBoundary: { tokenIn, tokenOut, amountIn: 137n, minimum: 1n,
    executionAssets: { input: nativeInput ? "native" : "erc20", output: nativeInput ? "erc20" : "native" } },
    overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: tokenIn, amount: 137n }] },
    observeTokenBalances: [tokenIn, tokenOut].map(token => ({ token, account: { kind: "executor" } })),
  };
  return v;
}
test("Ready strict issuer automatically applies the same native envelope as the work runtime", async () => {
  for (const nativeInput of [true, false]) {
    const f = fixture(async req => programResponse(req));
    const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: PROGRAM_CODE });
    const v = nativeProgramInvocation(nativeInput);
    const runtime = createStrictCentralAdapterRuntime({ simulator: t, executor: EXECUTOR, transactionOrigin: ORIGIN,
      generationFence: { assertCurrent() {} }, provider: { call: async () => assert.fail("raw RPC"),
        getCode: async () => assert.fail(), getStorage: async () => assert.fail() } });
    const outcome = await executeAdapterWork({ runtime, intent: { stage: "identity", familyId: "test:native-strict" as never,
      source: SOURCE, generation: SOURCE.generation, programInput: undefined, program: {
        requirements: () => ({ transports: ["effect-delta-simulation"], caller: "executor", effects: v.request.observe }),
        buildRequests: () => [v.request], decode: ({ results }) => results,
      } } });
    assert.equal(outcome.status, "resolved");
    assert.equal(f.calls.length, 1);
    const materialized = materializeAdapterRequests([v.request], v.callerAuthority)[0];
    assert(materialized.kind === "effect-delta-simulation");
    assert.equal(f.calls[0].data, materialized.call.data);
    assert.notEqual(f.calls[0].data, v.request.call.data);
    assert.deepEqual(f.calls[0].sourcePin, PIN);
    assert.deepEqual(f.calls[0].executorRuntimeCode, PROGRAM_CODE);
    assert.equal(f.calls[0].transactionOrigin, ORIGIN);
  }
});
for (const [name, mutate] of [
  ["wrong mode", v => v.request.call.executionMode = "impersonated-call-frame"],
  ["missing native observation", v => v.request.observe = ["token-delta"]],
  ["missing token observation", v => v.request.observe = ["native-delta"]],
  ["missing input/output scope", v => v.request.observeTokenBalances = []],
  ["foreign input/output account", v => v.request.observeTokenBalances[0].account = ACTOR],
  ["wrong native graph token", v => v.request.executionAssetBoundary.tokenIn = TOKEN],
  ["negative amount", v => v.request.executionAssetBoundary.amountIn = -1n],
  ["extra declaration", v => v.request.executionAssetBoundary.executorRuntimeCode = PROGRAM_CODE],
] as readonly [string, (v: any) => void][]) test(`native strict boundary rejects ${name} before a lease`, async () => {
  const f = fixture(), v = nativeProgramInvocation(); mutate(v);
  const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: PROGRAM_CODE });
  await assert.rejects(t.simulate(v), notEvidence);
  assert.equal(f.sources.length, 0); assert.equal(f.calls.length, 0);
});
test("executor program binds trusted code, actor/origin, source and canonical self entry", async () => {
  const f = fixture(async req => programResponse(req));
  const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: PROGRAM_CODE });
  const v = programInvocation(); await t.simulate(v);
  const w = f.calls[0]!;
  assert.equal(t.executorProgramCodeHash, PROGRAM_CODE.keccak256);
  assert.equal(w.from, EXECUTOR); assert.equal(w.to, EXECUTOR); assert.equal(w.transactionOrigin, ORIGIN);
  assert.equal(w.callerMode, "impersonated-call-frame"); assert.equal(w.data, v.request.call.data);
  assert.deepEqual(w.executorRuntimeCode, PROGRAM_CODE); assert.deepEqual(w.preCalls, []);
  assert.deepEqual(w.sourcePin, PIN); assert.deepEqual(w.tokenDeals, [{ token: TOKEN, to: EXECUTOR, amount: "137" }]);
});
for (const [name, mutate] of [
  ["missing origin", v => delete v.callerAuthority.transactionOrigin],
  ["zero origin", v => v.callerAuthority.transactionOrigin = addr("0")],
  ["aliased origin", v => v.callerAuthority.transactionOrigin = EXECUTOR],
  ["wrong target", v => v.request.call.to = TARGET],
  ["non-executor role", v => v.request.call.caller = { kind: "verified-actor", evidenceId: "probe" }],
  ["setup outside program", v => v.request.preCalls = [{ caller: { kind: "executor" }, to: TOKEN, data: "0x" }]],
  ["family-supplied code", v => v.request.executorRuntimeCode = PROGRAM_CODE],
  ["wrong selector", v => v.request.call.data = "0x09c5eabe" + v.request.call.data.slice(10)],
  ["trailing bytes", v => v.request.call.data += "00"],
  ["truncated bytes", v => v.request.call.data = v.request.call.data.slice(0, -2)],
] as readonly [string, (v: any) => void][]) test(`executor program rejects ${name} before acquiring a lease`, async () => {
  const f = fixture(), v = programInvocation(); mutate(v);
  const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: PROGRAM_CODE });
  await assert.rejects(t.simulate(v), notEvidence);
  assert.equal(f.sources.length, 0); assert.equal(f.calls.length, 0);
});
test("executor program has no untrusted-code or raw-call fallback", async () => {
  const f = fixture(); await assert.rejects(f.transport.simulate(programInvocation()), notEvidence);
  assert.equal(f.sources.length, 0);
});
test("executor program following a prefix reuses its code and does not refill the current input", async () => {
  const f = fixture(async req => programResponse(req));
  const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: PROGRAM_CODE });
  await t.simulatePrefix!(prefixInvocation(programInvocation().request));
  const w = f.calls[0]!;
  assert.equal(w.executorRuntimeCode, undefined); assert.equal(w.tokenDeals, undefined);
  assert.equal(w.nativeBalanceWei, undefined); assert.deepEqual(w.trialPrefix!.executorRuntimeCode, PROGRAM_CODE);
  assert.equal(w.trialPrefix!.inputAmount, "123"); assert.equal(w.to, EXECUTOR);
});
for (const proof of [undefined, { address: TARGET, keccak256: PROGRAM_CODE.keccak256 },
  { address: EXECUTOR, keccak256: hash("5") }]) test("executor program requires matching code evidence even on revert", async () => {
  for (const reverted of [false, true]) {
    const f = fixture(async req => { const r = reverted ? failure(req, "Revert") : programResponse(req);
      r.strict!.counterfactualExecutorCode = proof; return r; });
    const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: PROGRAM_CODE });
    await assert.rejects(t.simulate(programInvocation()), RevmFatalError);
    assert.equal(f.fatals.length, 1);
  }
});
test("production issuer accepts executor-program and binds code, origin and source in evidence", async () => {
  const fingerprints = new Set<string>();
  for (const [code, origin, prefix] of [[PROGRAM_CODE, ORIGIN, false],
    [{ code: "0x00", keccak256: keccak256("0x00") }, ORIGIN, false],
    [PROGRAM_CODE, OBSERVED, false], [PROGRAM_CODE, ORIGIN, true]] as const) {
    const f = fixture(async req => programResponse(req));
    const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: code });
    const base = createStrictCentralAdapterRuntime({ simulator: t, executor: EXECUTOR, transactionOrigin: origin,
      generationFence: { assertCurrent() {} }, provider: {
        call: async () => assert.fail("must not call raw RPC"), getCode: async () => assert.fail(), getStorage: async () => assert.fail(),
      } });
    const runtime = prefix ? base.withExactPrefix!(prefixInvocation().prefix, SOURCE) : base;
    const request = programInvocation().request;
    const outcome = await executeAdapterWork({ runtime, intent: {
      stage: "exact-refine", familyId: "test:executor-program" as never, source: SOURCE, generation: SOURCE.generation,
      programInput: undefined, program: { requirements: () => ({ transports: ["effect-delta-simulation"],
        caller: "executor", effects: request.observe }), buildRequests: () => [request], decode: ({ results }) => results },
    } });
    assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("unresolved program");
    const result = outcome.executed.evidence[0]!; assert(result.ok); fingerprints.add(result.provenance.fingerprint);
    assert.equal(f.calls.length, 1);
  }
  assert.equal(fingerprints.size, 4);
});
test("prefix eth-call keeps caller/source/origin and dispatches isolated requests without a baseline cache", async () => {
  const f = fixture(), input = prefixInvocation(), controller = new AbortController();
  const control = { signal: controller.signal, deadlineAtMs: Date.now() + 30_000 };
  const result = await f.transport.simulatePrefix!({ ...input, control });
  await f.transport.simulatePrefix!({ ...input, prefix: { ...input.prefix, inputAmount: 456n } });
  assert.equal(result.completion, "returned"); assert.equal(result.data, "0xbeef");
  assert.equal(Object.hasOwn(result, "effects"), false);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0]!.trialPrefix!.inputAmount, "123");
  assert.equal(f.calls[1]!.trialPrefix!.inputAmount, "456");
  assert.equal(f.calls[0]!.from, EXECUTOR); assert.equal(f.calls[0]!.to, TARGET);
  assert.deepEqual(f.calls[0]!.sourcePin, PIN); assert.equal(f.calls[0]!.transactionOrigin, ORIGIN);
  assert.equal(f.calls[0]!.callerMode, "impersonated-call-frame"); assert.equal(f.calls[0]!.executionGasLimit, GAS);
  assert.equal(f.calls[0]!.tokenDeals, undefined); assert.equal(f.calls[0]!.nativeBalanceWei, undefined);
  assert.equal(f.controls[0]!.signal, controller.signal); assert.equal(f.controls[0]!.deadlineAtMs, control.deadlineAtMs);
});
test("real prefix transport results satisfy central RequestProgram validation for every request kind", async () => {
  const f = fixture(async req => {
    if (req.data === "0xbad0") return failure(req, "Revert");
    const r = response(req);
    if (req.stateRead?.kind === "get-storage") {
      r.output = hash("7"); r.strict!.outcome = { kind: "Success", phase: "main", output: r.output };
    }
    return r;
  });
  const base = createStrictCentralAdapterRuntime({ simulator: f.transport, executor: EXECUTOR, transactionOrigin: ORIGIN,
    generationFence: { assertCurrent(generation, source) { assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE); } },
    provider: { call: async () => assert.fail("prefix view must not read baseline"),
      getCode: async () => assert.fail("prefix view must not read baseline code"),
      getStorage: async () => assert.fail("prefix view must not read baseline storage") },
  });
  const runtime = base.withExactPrefix!(prefixInvocation().prefix, SOURCE);
  const requests: PrefixInvocation["request"][] = [
    { id: "call", kind: "eth-call", to: TARGET, data: "0x1234", completion: "return-data" },
    { id: "revert", kind: "eth-call", to: TARGET, data: "0xbad0", completion: "return-or-revert-data" },
    { id: "code", kind: "get-code", address: TARGET },
    { id: "storage", kind: "get-storage", address: TARGET, slot: hash("1") },
    ...(["state-override-simulation", "effect-delta-simulation"] as const).map(kind => ({
      ...invocation().request, id: kind, kind, overrideIntent: { caller: { kind: "executor" as const } },
    })),
  ];
  for (const request of requests) {
    const isSimulation = request.kind === "state-override-simulation" || request.kind === "effect-delta-simulation";
    const outcome = await executeAdapterWork({ runtime, intent: {
      stage: "exact-refine", familyId: "test:prefix-wire-validation" as never,
      source: SOURCE, generation: SOURCE.generation, programInput: undefined,
      program: { requirements: () => ({ transports: [request.kind],
          ...(isSimulation ? { caller: "executor" as const, effects: request.observe } : {}) }),
        buildRequests: () => [request], decode: ({ results }) => results },
    } });
    assert.equal(outcome.status, "resolved", `${request.id} must pass RequestProgram result validation`);
    if (outcome.status !== "resolved") throw new Error("unresolved prefix work");
    const result = outcome.executed.evidence[0]; assert(result?.ok);
    assert.equal(result.completion, request.id === "revert" ? "reverted-as-declared" : "returned");
    assert.equal(Object.hasOwn(result, "effects"), isSimulation);
  }
  assert.equal(f.calls.length, requests.length);
});
for (const caller of [undefined, { kind: "none" }, { kind: "executor" }, { kind: "observed-sender" },
  { kind: "verified-actor", evidenceId: "probe" }, { kind: "transaction-origin" }] as const) {
  test(`prefix read preserves symbolic caller ${caller?.kind ?? "omitted"} independently of executor`, async () => {
    const f = fixture(), request = { id: "view", kind: "eth-call" as const, to: TARGET, data: "0x", caller, completion: "return-data" as const };
    await f.transport.simulatePrefix!(prefixInvocation(request));
    const expected = caller?.kind === "executor" ? EXECUTOR : caller?.kind === "observed-sender" ? OBSERVED
      : caller?.kind === "verified-actor" ? ACTOR : caller?.kind === "transaction-origin" ? ORIGIN : addr("0");
    assert.equal(f.calls[0]!.from, expected); assert.equal(f.calls[0]!.trialPrefix!.executor, EXECUTOR);
    assert.equal(f.calls[0]!.transactionOrigin, ORIGIN);
  });
}
for (const kind of ["get-code", "get-storage"] as const) test(`prefix ${kind} reads advanced trial without effects`, async () => {
  const f = fixture(async req => { const r = response(req); r.output = hash("7"); r.strict!.outcome = { kind: "Success", phase: "main", output: r.output }; return r; });
  const request = kind === "get-code" ? { id: kind, kind, address: TARGET } : { id: kind, kind, address: TARGET, slot: "0x1" };
  const result = await f.transport.simulatePrefix!(prefixInvocation(request)), wire = f.calls[0]!;
  assert.equal(result.data, hash("7")); assert.equal(wire.to, TARGET); assert.equal(wire.data, "0x");
  assert.equal(Object.hasOwn(result, "effects"), false);
  assert.deepEqual(wire.stateRead, kind === "get-code" ? { kind, address: TARGET } : { kind, address: TARGET, slot: `0x${"0".repeat(63)}1` });
  assert.deepEqual(wire.observeTokenBalances, []); assert.deepEqual(wire.observeNativeBalances, []);
  assert.deepEqual(wire.observeTotalSupply, []); assert.equal(wire.observeLogs, false);
});
for (const kind of ["state-override-simulation", "effect-delta-simulation"] as const) test(`prefix ${kind} validates but never reapplies current-leg deals`, async () => {
  const f = fixture(), base = invocation().request;
  const input = prefixInvocation({ ...base, kind, overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: TARGET, amount: 700n }] },
    preCalls: [{ caller: { kind: "executor" }, to: TOKEN, data: "0x4567" }] });
  const result = await f.transport.simulatePrefix!(input), wire = f.calls[0]!;
  assert.equal(result.completion, "returned"); assert.equal(wire.tokenDeals, undefined); assert.equal(wire.nativeBalanceWei, undefined);
  assert.equal(wire.trialPrefix!.inputToken, TOKEN); assert.equal(wire.trialPrefix!.inputAmount, "123");
  assert.deepEqual(wire.preCalls, [{ from: EXECUTOR, to: TOKEN, calldata: "0x4567" }]);
  assert.deepEqual(wire.observeTokenBalances, [{ token: TARGET, account: EXECUTOR }]);
});
test("prefix current eth-call revert is evidence; prefix failure is never current quote revert", async () => {
  const good = fixture(async req => failure(req, "Revert"));
  assert.deepEqual(await good.transport.simulatePrefix!(prefixInvocation()), { data: "0xdeadbeef", completion: "reverted-as-declared" });
  for (const kind of ["Revert", "Halt"] as const) {
    const f = fixture(async req => failure(req, kind, "preCall"));
    await assert.rejects(f.transport.simulatePrefix!(prefixInvocation()), (error: any) => {
      notEvidence(error); assert.equal(error.data, undefined); assert.equal(error.effects, undefined);
      assert.deepEqual(error.exactPrefixFailure, { phase: "preCall", kind, preCallIndex: 0,
        ...(kind === "Revert" ? { output: "0xdeadbeef" } : { reason: "OutOfGas" }) });
      assert(Object.isFrozen(error.exactPrefixFailure)); return true;
    });
    assert.equal(f.fatals.length, 0); // Prefix is valid preCall index 0 even without current-leg preCalls.
  }
});
test("prefix main halt has attested diagnostic detail without quote-revert fields", async () => {
  const f = fixture(async req => failure(req, "Halt"));
  await assert.rejects(f.transport.simulatePrefix!(prefixInvocation()), (error: any) => {
    notEvidence(error); assert.equal(error.data, undefined); assert.equal(error.effects, undefined);
    assert.deepEqual(error.exactPrefixFailure, { phase: "main", kind: "Halt", reason: "OutOfGas" });
    assert(Object.isFrozen(error.exactPrefixFailure)); return true;
  });
});
test("prefix simulation main revert retains declared empty effects", async () => {
  const f = fixture(async req => failure(req, "Revert")), base = invocation().request;
  const result = await f.transport.simulatePrefix!(prefixInvocation({ ...base, overrideIntent: { caller: { kind: "executor" } } }));
  assert.equal(result.completion, "reverted-as-declared");
  assert.deepEqual(result.effects, { tokenDeltas: [], nativeDeltas: [], totalSupplyDeltas: [], logs: [] });
});
test("prefix preCall indices include prefix, reject out-of-envelope index", async () => {
  for (const index of [1, 2]) {
    const f = fixture(async req => { const r = failure(req, "Revert", "preCall"); (r.strict!.outcome as any).preCallIndex = index; return r; });
    const base = invocation().request;
    const input = prefixInvocation({ ...base, overrideIntent: { caller: { kind: "executor" } }, preCalls: [{ caller: { kind: "executor" }, to: TOKEN, data: "0x" }] });
    await assert.rejects(f.transport.simulatePrefix!(input), notEvidence); assert.equal(f.fatals.length, index === 1 ? 0 : 1);
  }
});
test("prefix and code are detached before awaiting lease; code attests executor, not final target", async () => {
  const wait = deferred<RevmStrictSourceLease>();
  const code = { code: "0x60006000", keccak256: keccak256("0x60006000") };
  const f = fixture(async req => { const r = response(req); r.strict!.counterfactualExecutorCode = { address: EXECUTOR, keccak256: keccak256("0x60006000") }; return r; });
  const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: code, leaseFor: () => wait.promise });
  const input = prefixInvocation(), pending = t.simulatePrefix!(input);
  (input.prefix as any).inputAmount = 999n; (input.prefix as any).calldata = "0x9999"; code.code = "0x00";
  wait.resolve(f.lease); await pending;
  assert.equal(f.calls[0]!.trialPrefix!.inputAmount, "123"); assert.equal(f.calls[0]!.trialPrefix!.calldata, "0x12345678");
  assert.equal(f.calls[0]!.trialPrefix!.executorRuntimeCode!.code, "0x60006000");
  assert.equal(f.calls[0]!.executorRuntimeCode, undefined); assert(Object.isFrozen(f.calls[0]!.trialPrefix));
});
test("prefix proof corruption latches both normal and prefix transport paths", async () => {
  const code = { code: "0x6000", keccak256: keccak256("0x6000") };
  const f = fixture(async req => { const r = response(req); r.strict!.counterfactualExecutorCode = { address: TARGET, keccak256: code.keccak256 }; return r; });
  const t = createRevmStrictSimulationTransport({ ...f.options, executorRuntimeCode: code });
  await assert.rejects(t.simulatePrefix!(prefixInvocation()), RevmFatalError);
  await assert.rejects(t.simulate(invocation()), RevmFatalError); assert.equal(f.calls.length, 1); assert.equal(f.fatals.length, 1);
});
test("prefix late cancellation and source mismatch cannot publish returned data", async () => {
  for (const cause of ["cancel", "source"] as const) {
    const controller = new AbortController();
    const f = fixture(async req => { const r = response(req); if (cause === "cancel") controller.abort(); else r.sourceAttestation = { ...r.sourceAttestation!, blockHash: hash("9") }; return r; });
    await assert.rejects(f.transport.simulatePrefix!({ ...prefixInvocation(), control: { signal: controller.signal } }), notEvidence);
    assert.equal(f.fatals.length, cause === "source" ? 1 : 0);
  }
});
const badPrefixes: [string, (v: any) => void][] = [
  ["executor mismatch", v => v.prefix.executor = ACTOR], ["missing origin", v => delete v.callerAuthority.transactionOrigin],
  ["zero executor", v => { v.prefix.executor = addr("0"); v.callerAuthority.executor = addr("0"); }],
  ["empty calldata", v => v.prefix.calldata = "0x"], ["zero amount", v => v.prefix.inputAmount = 0n],
  ["overflow amount", v => v.prefix.inputAmount = 1n << 256n], ["native root token", v => v.prefix.inputToken = addr("0")],
  ["family code", v => v.prefix.executorRuntimeCode = { code: "0x6000", keccak256: keccak256("0x6000") }],
  ["invalid eth-call completion", v => v.request.completion = "other"], ["forged caller", v => v.request.caller = { kind: "executor", address: ACTOR }],
  ["bad slot", v => v.request = { id: "s", kind: "get-storage", address: TARGET, slot: "1" }],
  ["oversize slot", v => v.request = { id: "s", kind: "get-storage", address: TARGET, slot: `0x${"f".repeat(65)}` }],
];
for (const [label, mutate] of badPrefixes) test(`prefix pre-I/O rejection: ${label}`, async () => {
  const f = fixture(), input = prefixInvocation(); mutate(input);
  await assert.rejects(f.transport.simulatePrefix!(input), notEvidence); assert.equal(f.sources.length, 0); assert.equal(f.calls.length, 0);
});
for (const override of ["native", "multiple-tokens", "top-level", "default-mode"] as const) test(`prefix simulation rejects unsupported ${override}`, async () => {
  const f = fixture(), base = invocation().request;
  const request = { ...base, call: { ...base.call }, overrideIntent: { ...base.overrideIntent, nativeBalanceWei: undefined as bigint | undefined } };
  if (override === "native") request.overrideIntent.nativeBalanceWei = 1n;
  if (override === "multiple-tokens") request.overrideIntent.tokenBalances = [{ token: TOKEN, amount: 1n }, { token: TARGET, amount: 1n }];
  if (override === "top-level") request.call.executionMode = "top-level";
  if (override === "default-mode") request.call.executionMode = undefined;
  await assert.rejects(f.transport.simulatePrefix!(prefixInvocation(request)), notEvidence); assert.equal(f.sources.length, 0);
});
for (const kind of ["state-override-simulation", "effect-delta-simulation"] as const) test(`${kind}: bound source, origin, native effects and controls`, async () => {
  const f = fixture(), input = invocation(); input.request = { ...input.request, kind };
  const controller = new AbortController(); input.control = { signal: controller.signal, deadlineAtMs: Date.now() + 30_000 };
  const result = await f.transport.simulate(input), req = f.calls[0]!;
  assert.deepEqual(f.sources, [SOURCE]); assert(Object.isFrozen(f.sources[0])); assert.equal(req.rpcUrl, RPC_URL);
  assert.equal(req.blockNumber, SOURCE.number); assert.deepEqual(req.sourcePin, PIN); assert.equal(req.from, EXECUTOR);
  assert.equal(req.transactionOrigin, ORIGIN); assert.equal(req.callerMode, "impersonated-call-frame"); assert.equal(req.executionGasLimit, GAS);
  assert.equal(req.nativeBalanceWei, "17"); assert.equal(req.tokenDeals?.[0]?.amount, "137");
  assert.deepEqual(req.observeTokenBalances, [{ token: TOKEN, account: EXECUTOR }, { token: TARGET, account: EXECUTOR }]);
  assert.equal(req.observeTokens, undefined); assert.equal(req.observeAccounts, undefined);
  assert.deepEqual(req.observeNativeBalances, [EXECUTOR]); assert.deepEqual(req.observeTotalSupply, [TARGET]);
  assert.equal(f.controls[0]?.signal, controller.signal); assert.equal(f.controls[0]?.deadlineAtMs, input.control.deadlineAtMs);
  assert.equal(result.data, "0xbeef"); assert.equal(result.effects?.nativeDeltas?.[0]?.delta, 137n);
  assert.equal(result.effects?.tokenDeltas?.[0]?.delta, -137n); assert(Object.isFrozen(result.effects?.tokenDeltas?.[0]));
  assert(Object.isFrozen(result.effects?.logs?.[0]?.topics)); assert.deepEqual(f.fatals, []);
});
test("sparse exact pairs never probe poisonous Cartesian cross-pairs", async () => {
  const pairs = [{ token: TOKEN, account: ACTOR }, { token: TARGET, account: OBSERVED }];
  const f = fixture(async req => { assert.deepEqual(req.observeTokenBalances, pairs); assert.equal(req.observeTokens, undefined); assert.equal(req.observeAccounts, undefined); return response(req); });
  const input = invocation(); input.request = { ...input.request, observeTokenBalances: pairs };
  assert.equal((await f.transport.simulate(input)).effects?.tokenDeltas?.length, 2);
});
test("independent supply targets preserve default, explicit empty, and detached source-bound scope", async () => {
  for (const scope of [undefined, [], [TOKEN], [TOKEN, TARGET]]) {
    const f = fixture(), input = invocation(); input.request = { ...input.request, observeTotalSupplies: scope };
    const materialized = materializeAdapterRequests([input.request], input.callerAuthority)[0];
    assert.deepEqual((materialized as any).observeTotalSupplies, scope);
    if (scope) assert(Object.isFrozen((materialized as any).observeTotalSupplies));
    const result = await f.transport.simulate(input), expected = scope ?? [TARGET];
    assert.deepEqual(f.calls[0]?.observeTotalSupply, expected);
    assert.deepEqual(result.effects?.totalSupplyDeltas?.map(d => d.token), expected);
  }
  const wait = deferred<RevmStrictSourceLease>(), f = fixture(), input = invocation(), scope = [TOKEN];
  const t = createRevmStrictSimulationTransport({ ...f.options, leaseFor: () => wait.promise });
  input.request = { ...input.request, observeTotalSupplies: scope }; const pending = t.simulate(input);
  scope[0] = TARGET; wait.resolve(f.lease); await pending;
  assert.deepEqual(f.calls[0]?.observeTotalSupply, [TOKEN]); assert(Object.isFrozen(f.calls[0]?.observeTotalSupply));
});
test("wrong or missing independent supply response fails closed", async () => {
  for (const fault of ["wrong", "missing", "extra"]) {
    const f = fixture(async req => { const r = response(req);
      if (fault === "wrong") r.strict!.totalSupplyDeltas![0]!.token = TARGET;
      if (fault === "missing") r.strict!.totalSupplyDeltas = [];
      if (fault === "extra") r.strict!.totalSupplyDeltas!.push({ token: TARGET, delta: "0" });
      return r;
    });
    const input = invocation(); input.request = { ...input.request, observeTotalSupplies: [TOKEN] };
    await assert.rejects(f.transport.simulate(input), RevmFatalError); assert.equal(f.fatals.length, 1);
  }
});
test("malformed or undeclared supply targets cannot reach a source lease", async () => {
  for (const scope of [null, "bad", {}, [null], ["0x"], [addr("0")], [TOKEN, TOKEN],
    [TOKEN, TOKEN.toUpperCase().replace("0X", "0x")], new Array(1), Object.assign([TOKEN], { extra: true })]) {
    const f = fixture(), input = invocation(); input.request = { ...input.request, observeTotalSupplies: scope } as never;
    await assert.rejects(f.transport.simulate(input), notEvidence); assert.equal(f.sources.length, 0);
  }
  const f = fixture(), input = invocation(); input.request = { ...input.request, observe: [], observeTotalSupplies: [] };
  await assert.rejects(f.transport.simulate(input), notEvidence); assert.equal(f.sources.length, 0);
});
test("explicit empty overrides defaults; undeclared effects perform no probes", async () => {
  const f = fixture(), input = invocation(); input.request = { ...input.request, observeTokenBalances: [] };
  assert.deepEqual((await f.transport.simulate(input)).effects?.tokenDeltas, []); assert.deepEqual(f.calls[0]?.observeTokenBalances, []);
  input.request = { ...input.request, observe: ["return-data"], observeTokenBalances: undefined };
  assert.deepEqual((await f.transport.simulate(input)).effects, {}); assert.deepEqual(f.calls[1]?.observeTokenBalances, []);
  assert.deepEqual(f.calls[1]?.observeNativeBalances, []); assert.deepEqual(f.calls[1]?.observeTotalSupply, []); assert.equal(f.calls[1]?.observeLogs, false);
});
for (const caller of [{ kind: "executor" }, { kind: "observed-sender" }, { kind: "verified-actor", evidenceId: "probe" }, { kind: "transaction-origin" }] as const) {
  test(`symbolic ${caller.kind} uses invocation authority`, async () => {
    const f = fixture(), input = invocation(); input.request = { ...input.request, call: { ...input.request.call, caller },
      overrideIntent: { ...input.request.overrideIntent, caller }, preCalls: [{ caller, to: TOKEN, data: "0x1234" }], observeTokenBalances: [{ token: TOKEN, account: caller }] };
    await f.transport.simulate(input); const expected = caller.kind === "executor" ? EXECUTOR : caller.kind === "observed-sender" ? OBSERVED : caller.kind === "verified-actor" ? ACTOR : ORIGIN;
    assert.equal(f.calls[0]?.from, expected); assert.equal(f.calls[0]?.preCalls?.[0]?.from, expected); assert.equal(f.calls[0]?.tokenDeals?.[0]?.to, expected);
    assert.equal(f.calls[0]?.observeTokenBalances?.[0]?.account, expected);
  });
}
test("top-level retains sender semantics, without injecting unrelated inner origin", async () => {
  const f = fixture(), input = invocation(); input.request = { ...input.request, call: { ...input.request.call, executionMode: undefined } };
  await f.transport.simulate(input); assert.equal(f.calls[0]?.callerMode, "top-level"); assert.equal(f.calls[0]?.transactionOrigin, undefined);
});
test("constructor and nested invocation snapshots survive mutation during lease await", async () => {
  const wait = deferred<RevmStrictSourceLease>(), f = fixture(), opts = { ...f.options, leaseFor: () => wait.promise };
  const t = createRevmStrictSimulationTransport(opts), input = invocation(), controller = new AbortController();
  const actor = { kind: "verified-actor", evidenceId: "probe" } as const;
  input.request = { ...input.request, call: { ...input.request.call, caller: actor }, overrideIntent: { ...input.request.overrideIntent, caller: actor } };
  input.control = { signal: controller.signal, deadlineAtMs: Date.now() + 30_000 }; const pending = t.simulate(input);
  opts.rpcUrl = "https://wrong.invalid"; opts.executionGasLimit = 1; opts.leaseFor = () => { throw new Error("mutated"); };
  (input.source as any).hash = hash("9"); (input.source as any).generation = 99;
  (input.callerAuthority.verifiedActors as Record<string, string>).probe = addr("9"); (input.callerAuthority as any).transactionOrigin = addr("8");
  (input.request.call as any).data = "0xbad0"; (input.request.overrideIntent.tokenBalances![0] as any).amount = 999n;
  (input.request.observe as string[]).length = 0; (input.control as any).deadlineAtMs = 1;
  wait.resolve(f.lease); await pending; assert.equal(f.calls[0]?.data, "0xdead"); assert.equal(f.calls[0]?.from, ACTOR);
  assert.equal(f.calls[0]?.transactionOrigin, ORIGIN); assert.equal(f.calls[0]?.tokenDeals?.[0]?.amount, "137");
  assert.equal(f.calls[0]?.rpcUrl, RPC_URL); assert.equal(f.calls[0]?.executionGasLimit, GAS); assert.equal(f.controls[0]?.signal, controller.signal);
});
// Deliberately malformed values test the public runtime boundary, not TS assignability.
const badInputs: [string, (v: any) => void][] = [
  ["source hash", v => v.source.hash = "0x12"], ["source number", v => v.source.number = 1.5], ["source generation", v => v.source.generation = -1], ["source extra", v => v.source.extra = 1],
  ["null preCalls", v => v.request.preCalls = null], ["null deals", v => v.request.overrideIntent.tokenBalances = null], ["null mode", v => v.request.call.executionMode = null],
  ["coercible kind", v => v.request.kind = { toString: () => "effect-delta-simulation" }],
  ["unknown request", v => v.request.extra = 1], ["request kind", v => v.request.kind = "eth-call"], ["request id", v => v.request.id = ""], ["required flag", v => v.request.required = "yes"],
  ["address", v => v.request.call.to = "secret"], ["odd hex", v => v.request.call.data = "0x1"], ["nonhex", v => v.request.call.data = "0xzz"], ["mode", v => v.request.call.executionMode = "other"],
  ["call extra", v => v.request.call.value = 1n], ["forged caller", v => v.request.call.caller = { kind: "executor", address: ACTOR }], ["unknown caller", v => v.request.call.caller = { kind: "other" }],
  ["override role", v => v.request.overrideIntent.caller = { kind: "observed-sender" }],
  ["preCall role", v => v.request.preCalls = [{ caller: { kind: "observed-sender" }, to: TARGET, data: "0x" }]],
  ["preCall data", v => v.request.preCalls = [{ caller: { kind: "executor" }, to: TARGET, data: "0x1" }]],
  ["negative token", v => v.request.overrideIntent.tokenBalances[0].amount = -1n], ["overflow token", v => v.request.overrideIntent.tokenBalances[0].amount = 1n << 256n],
  ["non-bigint token", v => v.request.overrideIntent.tokenBalances[0].amount = "137"], ["duplicate deal", v => v.request.overrideIntent.tokenBalances.push({ token: TOKEN, amount: 1n })],
  ["negative native", v => v.request.overrideIntent.nativeBalanceWei = -1n], ["overflow native", v => v.request.overrideIntent.nativeBalanceWei = 1n << 256n],
  ["missing executor", v => delete v.callerAuthority.executor], ["missing origin", v => delete v.callerAuthority.transactionOrigin], ["zero origin", v => v.callerAuthority.transactionOrigin = addr("0")],
  ["malformed origin", v => v.callerAuthority.transactionOrigin = "0x1234"], ["forged authority", v => v.callerAuthority.from = ACTOR],
  ["missing actor", v => { v.request.call.caller = { kind: "verified-actor", evidenceId: "missing" }; v.request.overrideIntent.caller = v.request.call.caller; }],
  ["unknown effect", v => v.request.observe.push("other")], ["trace", v => v.request.observe.push("trace")], ["duplicate effect", v => v.request.observe.push("logs")],
  ["bad pair", v => v.request.observeTokenBalances = [{ token: "0x", account: ACTOR }]], ["duplicate pair", v => v.request.observeTokenBalances = [{ token: TOKEN, account: ACTOR }, { token: TOKEN, account: ACTOR }]],
  ["none account", v => v.request.observeTokenBalances = [{ token: TOKEN, account: { kind: "none" } }]], ["mixed account role", v => v.request.observeTokenBalances = [{ token: TOKEN, account: { kind: "observed-sender" } }]],
  ["undeclared pairs", v => { v.request.observe = []; v.request.observeTokenBalances = [{ token: TOKEN, account: ACTOR }]; }],
  ["array hole", v => v.request.preCalls = new Array(1)], ["array extra", v => v.request.observe.extra = "secret"],
  ["invalid deadline", v => v.control = { deadlineAtMs: NaN }], ["invalid signal", v => v.control = { signal: {} }],
];
for (const [name, mutate] of badInputs) test(`pre-I/O rejection: ${name}`, async () => {
  const f = fixture(), input = invocation(); mutate(input); await assert.rejects(f.transport.simulate(input), notEvidence);
  assert.equal(f.sources.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.fatals.length, 0);
});
for (const change of [{ rpcUrl: "not a url" }, { rpcUrl: RPC_URL + "#fragment" }, { executionGasLimit: 0 }, { executionGasLimit: Infinity }, { leaseFor: undefined }, { onFatal: undefined }, { client: {} }, { executor: EXECUTOR }])
  test(`invalid/legacy constructor ${Object.keys(change)}`, () => { const f = fixture(); assert.throws(() => createRevmStrictSimulationTransport({ ...f.options, ...change } as never), notEvidence); });
test("genuine main Revert has exact CALL_EXCEPTION bytes, then healthy success", async () => {
  let first = true; const f = fixture(async req => { if (first) { first = false; return failure(req, "Revert"); } return response(req); });
  await assert.rejects(f.transport.simulate(invocation()), (e: any) => e.code === "CALL_EXCEPTION" && e.data === "0xdeadbeef");
  await f.transport.simulate(invocation()); assert.equal(f.calls.length, 2); assert.equal(f.fatals.length, 0);
});
for (const [kind, phase] of [["Halt", "main"], ["Halt", "preCall"], ["Revert", "preCall"]] as const) test(`${kind}/${phase} is not revert evidence`, async () => {
  const f = fixture(async req => failure(req, kind, phase)), input = invocation(); input.request = { ...input.request, preCalls: [{ caller: { kind: "executor" }, to: TOKEN, data: "0x" }] };
  await assert.rejects(f.transport.simulate(input), notEvidence); assert.equal(f.fatals.length, 0);
});
for (const kind of ["validation", "execution", "observation"] as const) test(`ordinary ${kind} rejection does not poison source`, async () => {
  let first = true; const f = fixture(async req => { if (first) { first = false; throw new RevmStrictError(kind, "secret"); } return response(req); });
  await assert.rejects(f.transport.simulate(invocation()), notEvidence); await f.transport.simulate(invocation()); assert.equal(f.calls.length, 2); assert.equal(f.fatals.length, 0);
});
test("unattested thrown CALL_EXCEPTION is not evidence", async () => {
  const f = fixture(async () => { throw Object.assign(new Error("secret"), { code: "CALL_EXCEPTION", data: "0xdead" }); });
  await assert.rejects(f.transport.simulate(invocation()), notEvidence); assert.equal(f.fatals.length, 0);
});
const safeClientErrors = [
  ["revm-sim request deadline timed out", "strict simulation deadline reached"],
  ["revm-sim request aborted", "strict simulation cancelled"],
] as const;
for (const [message, expected] of safeClientErrors) for (const stage of ["lease", "request"] as const) {
  test(`known client ${message} is safely distinguished at ${stage}`, async () => {
    let first = true;
    const failOnce = () => { if (first) { first = false; throw new Error(message); } };
    const f = fixture(async req => { if (stage === "request") failOnce(); return response(req); });
    const transport = createRevmStrictSimulationTransport({ ...f.options,
      async leaseFor(source) { if (stage === "lease") failOnce(); return f.options.leaseFor(source); },
    });
    await assert.rejects(transport.simulate(invocation()), error => {
      assert(error instanceof RevmStrictError); assert.equal(error.kind, "execution");
      assert.equal(error.message, expected); return notEvidence(error);
    });
    await transport.simulate(invocation());
    assert.equal(f.fatals.length, 0, "timeout/cancellation must not poison the source");
  });
}
test("only exact Error messages map; malicious text and error-like objects stay redacted", async () => {
  for (const error of [
    new Error(`revm-sim request deadline timed out ${RPC_URL}`),
    new Error(`revm-sim request aborted: ${RPC_URL}`),
    new Error(`${RPC_URL} revm-sim request aborted`),
    new Error("revm-sim request deadline timed out\n"),
    "revm-sim request aborted",
    { message: "revm-sim request deadline timed out", secret: RPC_URL },
  ]) {
    const f = fixture(async () => { throw error; });
    await assert.rejects(f.transport.simulate(invocation()), actual => {
      assert(actual instanceof RevmStrictError); assert.equal(actual.kind, "execution");
      assert.equal(actual.message, "strict simulation transport failed"); return notEvidence(actual);
    });
    assert.equal(f.fatals.length, 0);
  }
});
test("safe error mapping preserves strict error kinds and fatal/control precedence", async () => {
  const strict = fixture(async () => { throw new RevmStrictError("observation", safeClientErrors[0][0]); });
  await assert.rejects(strict.transport.simulate(invocation()), error => {
    assert(error instanceof RevmStrictError); assert.equal(error.kind, "observation");
    assert.equal(error.message, safeClientErrors[0][1]); return true;
  });
  const controller = new AbortController();
  const cancelled = fixture(async () => { controller.abort(new Error(RPC_URL)); throw new Error(safeClientErrors[0][0]); });
  await assert.rejects(cancelled.transport.simulate({ ...invocation(), control: { signal: controller.signal } }),
    { message: "strict simulation cancelled" });
  const fatal = fixture(async () => {
    const error = new RevmFatalError({ kind: "source-fault" }); error.message = safeClientErrors[1][0]; throw error;
  });
  await assert.rejects(fatal.transport.simulate(invocation()), RevmFatalError);
  await assert.rejects(fatal.transport.simulate(invocation()), RevmFatalError);
  assert.equal(fatal.calls.length, 1); assert.equal(fatal.fatals.length, 1);
});
const corruptions: [string, (r: any) => void, "source-fault" | "protocol-fault"][] = [
  ["missing attestation", r => delete r.sourceAttestation, "source-fault"], ["wrong hash", r => r.sourceAttestation.blockHash = hash("9"), "source-fault"],
  ["wrong number", r => r.sourceAttestation.blockNumber++, "source-fault"], ["wrong chain", r => r.sourceAttestation.chainId = 2, "source-fault"],
  ["wrong root", r => r.sourceAttestation.stateRoot = hash("9"), "source-fault"], ["bad parent", r => r.sourceAttestation.parentHash = "0x", "source-fault"],
  ["missing strict", r => delete r.strict, "protocol-fault"], ["missing outcome", r => delete r.strict.outcome, "protocol-fault"], ["unknown outcome", r => r.strict.outcome.kind = "other", "protocol-fault"],
  ["unknown phase", r => r.strict.outcome.phase = "other", "protocol-fault"], ["success contradiction", r => r.success = false, "protocol-fault"],
  ["output contradiction", r => r.output = "0x1234", "protocol-fault"], ["odd output", r => { r.output = "0x1"; r.strict.outcome.output = "0x1"; }, "protocol-fault"],
  ["unexpected revert", r => r.revertReason = "0x", "protocol-fault"], ["error on success", r => r.errorKind = "execution", "protocol-fault"],
  ["gas contradiction", r => r.gasUsed = "1", "protocol-fault"], ["gas over budget", r => { r.gasUsed = String(GAS + 1); r.strict.executionGasUsed = r.gasUsed; }, "protocol-fault"],
  ["negative gas", r => { r.gasUsed = "-1"; r.strict.executionGasUsed = "-1"; }, "protocol-fault"],
  ["missing pair", r => r.strict.tokenDeltas.pop(), "protocol-fault"], ["extra pair", r => r.strict.tokenDeltas.push({ token: TARGET, account: ACTOR, delta: "1" }), "protocol-fault"],
  ["wrong pair", r => r.strict.tokenDeltas[0].account = ACTOR, "protocol-fault"], ["bad delta", r => r.strict.tokenDeltas[0].delta = "01", "protocol-fault"],
  ["overflow delta", r => r.strict.tokenDeltas[0].delta = (1n << 256n).toString(), "protocol-fault"], ["native arithmetic", r => r.strict.nativeDeltas[0].delta = "999", "protocol-fault"],
  ["missing native", r => r.strict.nativeDeltas = [], "protocol-fault"], ["supply scope", r => r.strict.totalSupplyDeltas[0].token = TOKEN, "protocol-fault"], ["bad log", r => r.strict.logs[0].topics = ["0x12"], "protocol-fault"],
];
for (const [name, mutate, kind] of corruptions) test(`fatal response: ${name}`, async () => {
  const f = fixture(async req => { const r = response(req); mutate(r); return r; });
  await assert.rejects(f.transport.simulate(invocation()), e => { assert(e instanceof RevmFatalError); assert.equal(f.fatals.length, 1); assert.equal(f.fatals[0]?.kind, kind); return true; });
  await assert.rejects(f.transport.simulate(invocation()), notEvidence); assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 1); assert.equal(f.fatals.length, 1);
});
for (const field of ["number", "hash", "generation", "pinHash", "chainId"] as const) test(`lease ${field} mismatch: no dispatch`, async () => {
  const f = fixture(); if (field === "pinHash") (f.lease.sourcePin as any).blockHash = hash("9");
  else if (field === "chainId") (f.lease.sourcePin as any).chainId = 0; else (f.lease.source as any)[field] = field === "hash" ? hash("9") : SOURCE[field] + 1;
  await assert.rejects(f.transport.simulate(invocation()), e => e instanceof RevmFatalError); assert.equal(f.calls.length, 0); assert.equal(f.fatals.length, 1);
});
test("Revert requires attestation, consistent tags and empty effects", async () => {
  for (const mutate of [(r: any) => delete r.sourceAttestation, (r: any) => r.revertReason = "0xab", (r: any) => r.strict.nativeDeltas.push({ account: EXECUTOR, before: "0", after: "1", delta: "1" })]) {
    const f = fixture(async req => { const r = failure(req, "Revert"); mutate(r); return r; });
    await assert.rejects(f.transport.simulate(invocation()), e => e instanceof RevmFatalError); assert.equal(f.fatals.length, 1);
  }
});
test("lease identity mutation during completion cannot publish", async () => {
  const f = fixture(async req => { (f.lease.source as any).generation++; return response(req); });
  await assert.rejects(f.transport.simulate(invocation()), e => e instanceof RevmFatalError);
});
for (const outcome of ["Success", "Revert", "reject"] as const) test(`late abort prevents ${outcome}`, async () => {
  const controller = new AbortController(), f = fixture(async req => { controller.abort(Object.assign(new Error("secret"), { code: "CALL_EXCEPTION" }));
    if (outcome === "reject") throw Object.assign(new Error("secret"), { code: "CALL_EXCEPTION" }); return outcome === "Success" ? response(req) : failure(req, "Revert"); });
  const input = invocation(); input.control = { signal: controller.signal }; await assert.rejects(f.transport.simulate(input), notEvidence); assert.equal(f.fatals.length, 0);
});
test("expired or cancelled lease wait cannot dispatch", async () => {
  const f = fixture(), input = invocation(); input.control = { deadlineAtMs: Date.now() - 1 }; await assert.rejects(f.transport.simulate(input), notEvidence); assert.equal(f.sources.length, 0);
  const wait = deferred<RevmStrictSourceLease>(), controller = new AbortController(), t = createRevmStrictSimulationTransport({ ...f.options, leaseFor: () => wait.promise });
  input.control = { signal: controller.signal }; const pending = t.simulate(input); controller.abort(); wait.resolve(f.lease);
  await assert.rejects(pending, notEvidence); assert.equal(f.calls.length, 0);
});
test("late deadline blocks Success and Revert without detached timeout", async () => {
  for (const outcome of ["Success", "Revert"] as const) { const now = Date.now; let clock = now(); Date.now = () => clock;
    try { const f = fixture(async req => { clock += 2; return outcome === "Success" ? response(req) : failure(req, "Revert"); });
      const input = invocation(); input.control = { deadlineAtMs: clock + 1 }; await assert.rejects(f.transport.simulate(input), notEvidence);
    } finally { Date.now = now; }
  }
});
test("late fatal latches before throwing/reentrant callback, with no further lease", async () => {
  const controller = new AbortController(), f = fixture(async () => { controller.abort(); throw new RevmFatalError({ kind: "rpc-throttle", category: "http429", httpStatus: 429 }); });
  let count = 0, reentered: Promise<unknown> | undefined;
  const t = createRevmStrictSimulationTransport({ ...f.options, onFatal(reason) { count++; assert.equal(reason.kind, "rpc-throttle"); reentered = t.simulate(invocation()).catch(notEvidence); throw new Error("secret"); } });
  const input = invocation(); input.control = { signal: controller.signal }; await assert.rejects(t.simulate(input), e => e instanceof RevmFatalError); await reentered;
  assert.equal(count, 1); assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 1);
});

test("valid ok:false envelope is a nonfatal infrastructure rejection", async () => {
  let first = true;
  const f = fixture(async req => {
    if (first) { first = false; return { ok: false, errorKind: "observation", error: "secret", latencyMs: 1 }; }
    return response(req);
  });
  await assert.rejects(f.transport.simulate(invocation()), notEvidence);
  await f.transport.simulate(invocation()); assert.equal(f.calls.length, 2); assert.equal(f.fatals.length, 0);
});

test("optional root pin still requires valid node attestation; hex identities normalize", async () => {
  const f = fixture(async req => {
    const r = response(req);
    r.sourceAttestation = { ...r.sourceAttestation!, blockHash: SOURCE.hash.toUpperCase().replace("0X", "0x") };
    r.strict!.tokenDeltas.forEach(d => { d.token = d.token.toUpperCase().replace("0X", "0x"); });
    return r;
  });
  delete (f.lease.sourcePin as { stateRoot?: string }).stateRoot;
  const input = invocation(); input.callerAuthority = { ...input.callerAuthority,
    executor: EXECUTOR.toUpperCase().replace("0X", "0x"), transactionOrigin: ORIGIN.toUpperCase().replace("0X", "0x") };
  await f.transport.simulate(input);
  assert.equal(f.calls[0]?.sourcePin?.stateRoot, undefined); assert.equal(f.calls[0]?.from, EXECUTOR);
  assert.equal(f.calls[0]?.transactionOrigin, ORIGIN);
});

test("a sibling fatal bars already-outstanding Success and every subsequent admission", async () => {
  const wait = deferred<DaemonResponse>(), entered = deferred<void>(); let first: StrictSimulateRequest | undefined;
  const f = fixture(async req => {
    if (!first) { first = req; entered.resolve(); return wait.promise; }
    throw new RevmFatalError({ kind: "source-fault" });
  });
  const pending = f.transport.simulate(invocation()); await entered.promise;
  await assert.rejects(f.transport.simulate(invocation()), e => e instanceof RevmFatalError);
  wait.resolve(response(first!)); await assert.rejects(pending, e => e instanceof RevmFatalError);
  await assert.rejects(f.transport.simulate(invocation()), e => e instanceof RevmFatalError);
  assert.equal(f.sources.length, 2); assert.equal(f.calls.length, 2); assert.equal(f.fatals.length, 1);
});

test("one quote cancellation does not retire a healthy source or unrelated quote", async () => {
  const controller = new AbortController(); let first = true;
  const f = fixture(async req => { if (first) { first = false; controller.abort(); } return response(req); });
  const input = invocation(); input.control = { signal: controller.signal };
  await assert.rejects(f.transport.simulate(input), notEvidence);
  await f.transport.simulate(invocation()); assert.equal(f.fatals.length, 0); assert.equal(f.calls.length, 2);
});

test("real source owner binds endpoint before dispatch and owns acquisition/drain", async () => {
  let creates = 0, dispatches = 0, drains = 0;
  const fatals: RevmFatalReason[] = [], sourceController = new AbortController(), quoteController = new AbortController();
  const owner = new RevmStrictSourceOwner({ onFatal: reason => { fatals.push(reason); }, createClient() {
    creates++;
    return { isTerminal: false, async strictSimulate(req, control) {
      dispatches++; assert.equal(control?.signal?.aborted, false); assert.equal(control?.deadlineAtMs, deadline);
      assert.equal(req.rpcUrl, RPC_URL); return response(req);
    }, async closeAndDrain() { drains++; } };
  } });
  const deadline = Date.now() + 30_000;
  let admitted: Promise<RevmStrictSourceLease> | undefined;
  const options = { rpcUrl: RPC_URL, executionGasLimit: GAS, onFatal(reason: RevmFatalReason) { fatals.push(reason); },
    leaseFor(source: Invocation["source"]) { return admitted ??= owner.acquire({ source, chainId: 1, rpcUrl: RPC_URL, stateRoot: PIN.stateRoot }, { signal: sourceController.signal }); } };
  assert.equal(creates, 0);
  const input = invocation(); input.control = { deadlineAtMs: deadline, signal: quoteController.signal };
  try {
    const wrong = createRevmStrictSimulationTransport({ ...options, rpcUrl: "http://localhost:8546" });
    await assert.rejects(wrong.simulate(input), notEvidence); assert.equal(dispatches, 0); assert.equal(creates, 1);
    const good = createRevmStrictSimulationTransport(options);
    await good.simulate(input); await good.simulate(input);
    assert.equal(dispatches, 2); assert.equal(creates, 1); assert.equal(drains, 0); assert.equal(fatals.length, 0);
  } finally { await owner.shutdown(); }
  assert.equal(drains, 1);
});
