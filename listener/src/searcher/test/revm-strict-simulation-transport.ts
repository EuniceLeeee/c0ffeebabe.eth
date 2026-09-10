import assert from "node:assert/strict";
import test from "node:test";
import { createRevmStrictSimulationTransport } from "../revm-strict-simulation-transport.js";
import { RevmFatalError, RevmStrictError, type DaemonResponse, type RevmFatalReason,
  type RevmRequestControl, type StrictSimulateRequest } from "../revm-sim-client.js";
import type { StrictSimulationTransport } from "../strict-central-adapter-runtime.js";
import { RevmStrictSourceOwner, type RevmStrictSourceLease } from "../revm-strict-source-owner.js";

type Invocation = Parameters<StrictSimulationTransport["simulate"]>[0];
type MutableInvocation = { -readonly [K in keyof Invocation]: Invocation[K] };
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
