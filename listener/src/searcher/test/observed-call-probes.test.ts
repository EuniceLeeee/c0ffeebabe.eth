import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, getBytes, hexlify, Interface, toBeHex } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../venues/adapter-request-program.js";
import { OBSERVED_CALL_MAX_AMOUNT, synthesizeObservedCallTemplates, type ObservedCallSample, type ObservedCallTemplate } from "../venues/observed-call-template.js";
import { runObservedCallProbes, type ObservedCallProbeResult } from "../observed-call-probes.js";
import { inspectRuntime, RuntimeProgramGuardError } from "./runtime-program-testkit.js";

// Independent emitted-program fixture, not EVM, mainnet or Ready evidence.
const a = (n: number) => toBeHex(n, 20);
const INPUT = a(1), OUTPUT = a(2), TARGET = a(3), EXECUTOR = a(4), ACTOR = a(5), EXTRA = a(6);
const ABI = new Interface([
  "function unknownSwap(uint256 amount,uint256 preserved,address receiver)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);
const source = { number: 200, hash: toBeHex(200, 32), generation: 3 };
function sample(repeated = false, amountIn = 100n): ObservedCallSample {
  return { target: TARGET, calldata: ABI.encodeFunctionData("unknownSwap", [amountIn, repeated ? amountIn : 7n, ACTOR]),
    sender: ACTOR, recipient: ACTOR, tokenIn: INPUT, tokenOut: OUTPUT,
    amountIn: amountIn.toString(), amountOut: "777777", source: { chainId: 1, number: 100,
      hash: toBeHex(100, 32), transactionHash: toBeHex(99, 32), traceAddress: [0] }, payment: { kind: "approval", spender: TARGET } };
}
function templates(repeated = false, amount = 100n): readonly ObservedCallTemplate[] {
  const result = synthesizeObservedCallTemplates(sample(repeated, amount));
  if (result.status !== "candidates") assert.fail(JSON.stringify(result));
  return result.templates;
}
type SimRequest = Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }>;
function unpack(request: AdapterRequest) {
  assert(request.kind === "effect-delta-simulation" || request.kind === "state-override-simulation");
  const [raw] = AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${request.call.data.slice(10)}`);
  const bytes = getBytes(raw);
  assert.equal(bytes[0], 0x0e);
  return { request, amount: BigInt(hexlify(bytes.slice(1, 33))), program: hexlify(bytes.slice(36)) };
}
function host(readMaximum = false) {
  const calls: AdapterRequest[] = [];
  const execute = async (request: AdapterRequest): Promise<AdapterRequestResult> => {
    calls.push(request);
    const { request: req, amount, program } = unpack(request);
    let input = 1_000_000n, output = 2_000_000n, allowance = 0n;
    const beforeIn = input, beforeOut = output;
    const receipt = { id: request.id, ok: true as const, source,
      provenance: { kind: "fixture-observed", fingerprint: `receipt:${request.id}` } };
    try {
      inspectRuntime(program, amount, { nativeBalance: () => 500n, call(call) {
        const parsed = ABI.parseTransaction({ data: call.data });
        assert(parsed, "fixture received unknown call");
        if (parsed.name === "balanceOf") {
          assert(call.static); assert.equal(parsed.args[0].toLowerCase(), EXECUTOR);
          return toBeHex(call.target.toLowerCase() === INPUT ? input : call.target.toLowerCase() === OUTPUT ? output : 300n, 32);
        }
        if (parsed.name === "allowance") return toBeHex(allowance, 32);
        if (parsed.name === "approve") { allowance = parsed.args[1]; return toBeHex(1n, 32); }
        assert.equal(parsed.name, "unknownSwap"); assert.equal(parsed.args[2].toLowerCase(), EXECUTOR);
        const actualInput: bigint = readMaximum && parsed.args[1] > parsed.args[0] ? parsed.args[1] : parsed.args[0];
        assert(allowance >= actualInput);
        input -= actualInput; output += actualInput * 3n + 7n;
        return toBeHex(1n, 32);
      } }, { output: true });
      return { ...receipt, completion: "returned", data: "0x", effects: {
        tokenDeltas: req.observeTokenBalances!.map(row => ({ token: row.token, account: EXECUTOR,
          delta: row.token.toLowerCase() === INPUT ? input - beforeIn : row.token.toLowerCase() === OUTPUT ? output - beforeOut : 0n })),
        nativeDeltas: [{ account: EXECUTOR, delta: 0n }],
      } };
    } catch (error) {
      if (!(error instanceof RuntimeProgramGuardError)) throw error;
      return { ...receipt, completion: "reverted-as-declared", data: "0x" };
    }
  };
  return { execute, calls };
}
const params = (values = templates()) => ({ templates: values, executor: EXECUTOR, source, protectedTokens: [EXTRA] });
function accepted(result: ObservedCallProbeResult) {
  if (result.status !== "accepted") assert.fail(JSON.stringify(result));
  return result;
}

test("three actual amounts and both VM controls are required before candidate acceptance", async () => {
  const runtime = host(), result = accepted(await runObservedCallProbes({ ...params(), execute: runtime.execute }));
  assert.equal(result.probePolicy, "observed-plus-quarter-double");
  assert.deepEqual(result.amountBounds, { minimum: "100", maximum: "200" });
  assert.deepEqual(result.positiveProbes.map(probe => [probe.amountIn, probe.amountOut]), [["100", "307"], ["125", "382"], ["200", "607"]]);
  assert.deepEqual(result.controls.map(probe => probe.kind), ["zero-runtime-input", "forced-output-minimum"]);
  assert.equal(runtime.calls.length, 5);
  assert.equal(result.template.sample.amountOut, "777777");
  const zero = runtime.calls.find(request => request.id.endsWith(":zero-runtime-input"))!;
  assert.equal(unpack(zero).amount, 0n);
  assert.deepEqual((zero as SimRequest).overrideIntent.tokenBalances, []);
  // The fixture has old inventory; this controls the program's zero-input guard,
  // not a claim that a real protocol cannot spend pre-existing inventory.
  assert.equal(result.controls[0]!.completion, "reverted-as-declared");
});

test("active probes distinguish equal historical amount words", async () => {
  const runtime = host(), result = accepted(await runObservedCallProbes({ ...params(templates(true)), execute: runtime.execute }));
  assert.equal(result.template.amountInOffset, 4);
  assert.deepEqual(result.candidates.map(candidate => candidate.status), ["accepted", "rejected"]);
  assert.equal(result.candidates[1]!.reason, "positive-execution-reverted");
});

test("two executable bindings remain ambiguous instead of taking the first", async () => {
  const runtime = host(true), result = await runObservedCallProbes({ ...params(templates(true)), execute: runtime.execute });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.candidates.map(candidate => candidate.status), ["accepted", "accepted"]);
});

test("one valid candidate plus a provider failure remains unresolved", async () => {
  const alternatives = templates(true), runtime = host();
  const result = await runObservedCallProbes({ ...params(alternatives), execute: async request =>
    request.id.includes(alternatives[1]!.templateHash) ? { id: request.id, ok: false, source, failure: "rpc" } : runtime.execute(request) });
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.candidates.map(candidate => candidate.status), ["accepted", "unresolved"]);
});

for (const failure of ["rpc", "deadline", "aborted", "resource-limited"] as const) {
  test(`a ${failure} failure cannot count as a negative control`, async () => {
    const runtime = host();
    const result = await runObservedCallProbes({ ...params(), execute: async request => request.id.endsWith(":zero-runtime-input")
      ? { id: request.id, ok: false, source, failure } : runtime.execute(request) });
    assert.equal(result.status, "unresolved");
    assert.equal(result.candidates[0]!.controls.length, 0);
  });
}

test("thrown provider errors are unresolved and do not expose provider details", async () => {
  const result = await runObservedCallProbes({ ...params(), execute: async () => { throw new Error("https://secret.invalid/credential"); } });
  assert.equal(result.status, "unresolved");
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

test("a successful zero/minimum control is an unresolved harness defect", async () => {
  for (const suffix of [":zero-runtime-input", ":forced-output-minimum"]) {
    const runtime = host();
    const result = await runObservedCallProbes({ ...params(), execute: async request => {
      const receipt = await runtime.execute(request);
      return request.id.endsWith(suffix) && receipt.ok ? { ...receipt, completion: "returned" } : receipt;
    } });
    assert.equal(result.status, "unresolved");
    assert.equal(result.candidates[0]!.reason, "runtime-guard-control-did-not-revert");
  }
});

test("source, request and provenance cannot be replaced even for a reported revert", async () => {
  for (const change of [
    (r: AdapterRequestResult) => ({ ...r, source: { ...source, number: 199 } }),
    (r: AdapterRequestResult) => ({ ...r, source: { ...source, generation: 4 } }),
    (r: AdapterRequestResult) => ({ ...r, id: "different-request" }),
    (r: AdapterRequestResult) => ({ ...r, provenance: { kind: "fixture-observed", fingerprint: "" } }),
  ]) {
    const runtime = host();
    const result = await runObservedCallProbes({ ...params(), execute: async request => change(await runtime.execute(request)) });
    assert.equal(result.status, "unresolved");
  }
});

test("contradictory successful balance effects are unresolved, not a candidate rejection", async () => {
  const runtime = host();
  const result = await runObservedCallProbes({ ...params(), execute: async request => {
    const result = await runtime.execute(request);
    return result.ok ? { ...result, effects: { ...result.effects, tokenDeltas: [] } } : result;
  } });
  assert.equal(result.status, "unresolved");
  assert.equal(result.candidates[0]!.reason, "positive-receipt-verification-failed");
});

test("completed positive reverts reject a candidate without inventing a quote", async () => {
  const result = await runObservedCallProbes({ ...params(), execute: async request => ({ id: request.id, ok: true, source,
    provenance: { kind: "fixture-observed", fingerprint: "observed-revert" }, completion: "reverted-as-declared", data: "0x" }) });
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.candidates[0]!.positiveProbes, []);
});

test("input overflow, duplicate probe points and unrelated observations remain unsupported", async () => {
  let calls = 0;
  const execute = async (): Promise<AdapterRequestResult> => { calls++; throw new Error("should not execute"); };
  for (const values of [templates(false, OBSERVED_CALL_MAX_AMOUNT), templates(false, 1n), [...templates(), ...templates(false, 101n)]]) {
    assert.equal((await runObservedCallProbes({ ...params(values), execute })).status, "unsupported");
  }
  assert.equal(calls, 0);
});

test("duplicate templates share one probe sequence and total candidates are bounded", async () => {
  const one = templates()[0]!, runtime = host();
  assert.equal((await runObservedCallProbes({ ...params([one, one]), execute: runtime.execute })).status, "accepted");
  assert.equal(runtime.calls.length, 5);
  assert.equal((await runObservedCallProbes({ ...params(Array.from({ length: 17 }, () => one)), execute: runtime.execute })).status, "unsupported");
  assert.equal(runtime.calls.length, 5);
});

test("asynchronous callers cannot change the captured source or template", async () => {
  const input = { ...params(JSON.parse(JSON.stringify(templates()))), source: { ...source } };
  const runtime = host();
  let first = true;
  const result = await runObservedCallProbes({ ...input, execute: async request => {
    if (first) {
      first = false; input.source.number = 999;
      (input.templates[0]!.sample as any).target = a(99);
    }
    return runtime.execute(request);
  } });
  const success = accepted(result);
  assert.equal(success.source.number, 200);
  assert.equal(success.template.sample.target, TARGET);
});
