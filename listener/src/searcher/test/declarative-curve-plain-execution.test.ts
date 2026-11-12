import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface, AbiCoder, getAddress, getBytes, hexlify, keccak256, toBeHex } from "ethers";
import { createDeclarativeSwapRuntime } from "../venues/declarative-swap.js";
import { decodeDeclarativeExecutionSimulationReceipt } from "../venues/declarative-simulation.js";
import { applyStrictAssetBoundary } from "../execution-asset-boundary.js";
import { inspectRuntime, RuntimeProgramGuardError } from "./runtime-program-testkit.js";

// Synthetic protocol hosts run the installed JSON through the production
// compiler and an independent VM interpreter. They are not EVM/live evidence.
// Expected ABIs are independent of the JSON definition under test.
const modes = {
  received: { received: true, receiver: true, native: false,
    signature: "function exchange_received(int128,int128,uint256,uint256,address) returns(uint256)" },
  "received-no-receiver": { received: true, receiver: false, native: false,
    signature: "function exchange_received(int128,int128,uint256,uint256) returns(uint256)" },
  exchange: { received: false, receiver: false, native: false,
    signature: "function exchange(int128,int128,uint256,uint256) returns(uint256)" },
  "received-uint": { received: true, receiver: true, native: false,
    signature: "function exchange_received(uint256,uint256,uint256,uint256,address) returns(uint256)" },
  "exchange-uint": { received: false, receiver: false, native: false,
    signature: "function exchange(uint256,uint256,uint256,uint256) returns(uint256)" },
  "native-exchange": { received: false, receiver: false, native: true,
    signature: "function exchange(int128,int128,uint256,uint256) payable" },
  "native-exchange-uint": { received: false, receiver: false, native: true,
    signature: "function exchange(uint256,uint256,uint256,uint256) payable" },
} as const;
type Mode = keyof typeof modes;
type NativeSide = "input" | "output" | undefined;
const rootUrl = new URL("../venues/swaps/curve-plain-family/curve-plain.json", import.meta.url);
const load = (url: URL) => JSON.parse(readFileSync(url, "utf8"));
const root = load(rootUrl);
const runtime = createDeclarativeSwapRuntime(root, root.variantFiles.map((file: string) => load(new URL(file, rootUrl))));
const family: any = runtime.definition;
const source = { number: 26389549, hash: toBeHex(26389549, 32), generation: 1 };
const a = (n: number) => getAddress(toBeHex(n, 20));
const inputToken = a(101), outputToken = a(102), pool = a(103), executor = a(104);
const weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const token = new Interface([
  "function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)", "function transfer(address,uint256) returns(bool)",
  "function withdraw(uint256)", "function deposit() payable",
]);
const vm = new Interface(["function execSubscript(bytes)"]);

function unpack(data: string) {
  assert.equal(data.slice(0, 10), vm.getFunction("execSubscript")!.selector);
  const bytes = getBytes(AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${data.slice(10)}`)[0]);
  assert.equal(bytes[0], 14);
  assert.equal(Number(BigInt(hexlify(bytes.slice(33, 36)))), bytes.length - 36);
  return { program: hexlify(bytes.slice(36)), amount: BigInt(hexlify(bytes.slice(1, 33))) };
}

function inputFor(mode: Mode, nativeSide: NativeSide, amountIn = 101n, clone = false, extraCoins = 0): any {
  const coins = nativeSide === "input" ? [native, outputToken] : nativeSide === "output" ? [inputToken, native] : [inputToken, outputToken];
  coins.push(...Array.from({ length: extraCoins }, (_, index) => a(200 + index)));
  const direction = { i: 0, j: 1, executionMode: mode,
    tokenIn: nativeSide === "input" ? weth : inputToken,
    tokenOut: nativeSide === "output" ? weth : outputToken,
    amountIn: 101n, amountOut: 203n,
    executionAssets: {
      input: nativeSide === "input" ? "native" : "erc20", output: nativeSide === "output" ? "native" : "erc20",
    } };
  // Identity behavior is tested separately. Here a synthetic admitted record
  // enters the real instance/route projection before Exact and execution.
  const identity = { familyId: "curve-plain", subject: pool,
    lineageId: clone ? "curve-plain:registry-independent-clone-direct-coin" : "curve-plain:registry-direct-coin-behavior",
    provenance: [{ kind: "synthetic-execution-contract", subject: pool, evidenceHash: keccak256("0x6000") }],
    facts: { pool, binding: { registry: a(105), handlers: clone ? [] : [a(106)], coins,
      decimals: coins.map(() => 18n), classKind: clone ? "clone" : "registry",
      ...(clone ? { implementationCodeHash: "0x260a286cc14e91f4a2d4a966e2e5f5030543a7d2f090a623f5fa15ba174a50f3" } : {}),
      coinAbi: "uint256", balanceAbi: "uint256", codeHash: keccak256("0x6000") }, directions: [direction] },
  };
  const descriptor = family.instance.finalizeDescriptor({ identity,
    draft: family.instance.compileDraft(identity), sharedBindings: [] });
  const routes = family.routes.project({ descriptor });
  assert.equal(routes.length, 1);
  return { descriptor, route: routes[0], executor, source, amountIn, runtimeEvidence: [] };
}

function exactProgram(input: any) {
  const method = family.exact.methods(input).find((m: any) => m.kind === "request-program");
  assert(method, "the installed JSON must provide simulation Exact");
  assert.equal(method.chainAmountQuote, true);
  return method.program;
}

function simulate(request: any, input: any, taxed = false, fault?: "under-debit" | "zero-output" | "native-spend" | "old-token") {
  const route = input.route, mode = modes[route.executionMode as Mode];
  assert(mode);
  const nativeIn = route.executionAssets?.input === "native", nativeOut = route.executionAssets?.output === "native";
  const amount = input.amountIn;
  const balances = new Map<string, bigint>();
  const key = (asset: string, owner: string) => `${asset.toLowerCase()}:${owner.toLowerCase()}`;
  const balance = (asset: string, owner: string) => balances.get(key(asset, owner)) ?? 0n;
  const set = (asset: string, owner: string, value: bigint) => balances.set(key(asset, owner), value);
  set(route.tokenIn, executor, amount + 123n); set(route.tokenOut, executor, 45n);
  set(route.tokenIn, pool, 1_000_000_000n); set(route.tokenOut, pool, 1_000_000_000n);
  const observed: string[] = request.observeTokenBalances.map((row: any) => row.token);
  const extra = observed.filter(asset => asset !== route.tokenIn && asset !== route.tokenOut);
  for (const asset of extra) set(asset, executor, 17n);
  const before = new Map(observed.map(asset => [asset, balance(asset, executor)]));
  let nativeBalance = 77n, allowance = 0n, credited = 0n, exchangeCalls = 0, approvalCalls = 0;
  let returnedOutput = 0n, actualOutput = 0n;
  const pair = new Interface([mode.signature]);
  const host: any = { nativeBalance: () => nativeBalance, call(c: any): string {
    if (c.target === executor && c.data.slice(0, 10) === vm.getFunction("execSubscript")!.selector) {
      const nested = unpack(c.data); inspectRuntime(nested.program, nested.amount, host); return "0x";
    }
    if (c.target === pool) {
      const parsed = pair.parseTransaction({ data: c.data }); assert(parsed); exchangeCalls++;
      const expectedDx = mode.received ? credited : amount;
      assert.deepEqual([...parsed.args].slice(0, 4), [0n, 1n, expectedDx, 1n]);
      if (mode.receiver) assert.equal(parsed.args[4], executor);
      assert.equal(c.value, nativeIn ? amount : 0n);
      if (!mode.received) {
        if (nativeIn) nativeBalance -= fault === "under-debit" ? amount - 1n : amount;
        else {
          assert.equal(allowance, amount);
          set(route.tokenIn, executor, balance(route.tokenIn, executor) - (fault === "under-debit" ? amount - 1n : amount));
        }
      }
      returnedOutput = expectedDx * 2n + 1n;
      actualOutput = fault === "zero-output" ? 0n : taxed && !nativeOut ? returnedOutput * 99n / 100n : returnedOutput;
      if (nativeOut) nativeBalance += actualOutput;
      else set(route.tokenOut, executor, balance(route.tokenOut, executor) + actualOutput);
      if (fault === "native-spend") nativeBalance--;
      if (fault === "old-token") { assert(extra.length); set(extra[0]!, executor, balance(extra[0]!, executor) - 1n); }
      return mode.native ? "0x" : pair.encodeFunctionResult(parsed.name, [returnedOutput]);
    }
    const parsed = token.parseTransaction({ data: c.data }); assert(parsed);
    if (parsed.name === "balanceOf") return token.encodeFunctionResult("balanceOf", [balance(c.target, parsed.args[0])]);
    if (parsed.name === "allowance") return token.encodeFunctionResult("allowance", [allowance]);
    if (parsed.name === "approve") {
      assert.equal(parsed.args[0], pool); approvalCalls++; allowance = parsed.args[1];
      return token.encodeFunctionResult("approve", [true]);
    }
    if (parsed.name === "transfer") {
      assert.equal(c.target, route.tokenIn); assert.equal(parsed.args[0], pool); assert.equal(parsed.args[1], amount);
      set(route.tokenIn, executor, balance(route.tokenIn, executor) - (fault === "under-debit" ? amount - 1n : amount));
      credited = taxed ? amount * 99n / 100n : amount;
      set(route.tokenIn, pool, balance(route.tokenIn, pool) + credited);
      return token.encodeFunctionResult("transfer", [true]);
    }
    assert.equal(c.target, weth);
    if (parsed.name === "withdraw") {
      set(weth, executor, balance(weth, executor) - parsed.args[0]); nativeBalance += parsed.args[0]; return "0x";
    }
    assert.equal(parsed.name, "deposit");
    set(weth, executor, balance(weth, executor) + c.value); nativeBalance -= c.value; return "0x";
  } };
  // Exercise the actual common native envelope, including nested program CALL,
  // WETH.withdraw/deposit and old native inventory conservation.
  const data = request.executionAssetBoundary
    ? applyStrictAssetBoundary({ boundary: request.executionAssetBoundary, executor, data: request.call.data })
    : request.call.data;
  const program = unpack(data); assert.equal(program.amount, amount);
  inspectRuntime(program.program, amount, host);
  assert.equal(exchangeCalls, 1); assert.equal(allowance, 0n);
  assert.equal(approvalCalls, mode.received || nativeIn ? 0 : 3);
  const effects = { tokenDeltas: observed.map(asset => ({ token: asset, account: executor,
    delta: balance(asset, executor) - before.get(asset)! })),
    nativeDeltas: [{ account: executor, delta: nativeBalance - 77n }] };
  return { id: request.id, ok: true, source, completion: "returned", data: "0x",
    provenance: { kind: "synthetic-independent-runtime-host", fingerprint: "not-fork-or-live" },
    effects, actualOutput, returnedOutput, credited };
}

for (const mode of Object.keys(modes) as Mode[]) {
  for (const side of (modes[mode].native ? ["input", "output"] : [undefined]) as NativeSide[]) {
    test(`[family=curve-plain] JSON ${mode}/${side ?? "erc20"} simulates actual funded execution and observed receipt`, () => {
      for (const amount of [101n, 987654n]) for (const taxed of [false, true]) {
        const input = inputFor(mode, side, amount), exact = exactProgram(input), requests = exact.buildRequests(input);
        assert.equal(requests.length, 1);
        const request = requests[0];
        assert.equal(request.kind, "effect-delta-simulation");
        assert.equal(request.call.executionMode, "executor-program");
        assert.deepEqual(request.overrideIntent, { caller: { kind: "executor" }, tokenBalances: [{ token: input.route.tokenIn, amount }] });
        const leg = family.execution.buildRuntimeLeg(input); assert(leg);
        assert.equal(leg.program, unpack(request.call.data).program);
        assert.deepEqual(leg.settlement, {});
        if (modes[mode].native) assert.deepEqual(request.executionAssetBoundary, {
          tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, executionAssets: input.route.executionAssets, amountIn: amount, minimum: 1n,
        });
        else assert.equal(request.executionAssetBoundary, undefined);
        const response = simulate(request, input, taxed);
        const decoded = exact.decode({ programInput: input, initialResults: [response], dependentEvidence: [] });
        assert.equal(decoded.amountOut, response.actualOutput);
        assert.equal(decoded.evidence.kind, "curve-plain-execution-receipt");
        if (taxed && side !== "output") assert(decoded.amountOut < response.returnedOutput);
        if (taxed && modes[mode].received && amount === 101n) assert.equal(response.credited, 99n);
        for (const kind of ["direct-output", "quote-output", "deferred-input"]) assert.equal(family.execution.buildRuntimeLeg({
          ...input, settlement: { kind, recipient: executor },
        }), null);
      }
    });
  }
}

for (const [mode, side] of [["exchange", undefined], ["received", undefined],
  ["native-exchange", "input"], ["native-exchange-uint", "output"]] as const) {
  test(`[family=curve-plain] JSON ${mode}/${side ?? "erc20"} rejects bad debit, output, source and simulation funding`, () => {
    const input = inputFor(mode, side), exact = exactProgram(input), request = exact.buildRequests(input)[0];
    for (const fault of ["under-debit", "zero-output"] as const)
      assert.throws(() => simulate(request, input, false, fault), error => error instanceof RuntimeProgramGuardError);
    if (!side) assert.throws(() => simulate(request, input, false, "native-spend"), error => error instanceof RuntimeProgramGuardError);
    const response = simulate(request, input);
    for (const mutate of [
      (r: any) => { r.source = { ...source, number: source.number + 1 }; },
      (r: any) => { r.effects.nativeDeltas[0].delta = -1n; },
      (r: any) => { r.effects.tokenDeltas[0].delta = -100n; },
      (r: any) => { r.effects.tokenDeltas[1].account = a(999); },
    ]) {
      const bad = structuredClone(response); mutate(bad);
      assert.throws(() => exact.decode({ programInput: input, initialResults: [bad], dependentEvidence: [] }));
    }
    const bad = structuredClone(request); bad.overrideIntent.tokenBalances[0].amount++;
    assert.throws(() => decodeDeclarativeExecutionSimulationReceipt({ request: bad, result: response as any, source, executor,
      tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amountIn: input.amountIn }), /funding mismatch/);
  });
}

test("[family=curve-plain] all modes compile and simulate eight direct coins with protected third-token inventories", () => {
  for (const mode of Object.keys(modes) as Mode[]) for (const side of (modes[mode].native ? ["input", "output"] : [undefined]) as NativeSide[]) {
    const input = inputFor(mode, side, 101n, false, 6), exact = exactProgram(input), request = exact.buildRequests(input)[0];
    assert.equal(request.observeTokenBalances.length, 8);
    const response = simulate(request, input);
    assert.equal(exact.decode({ programInput: input, initialResults: [response], dependentEvidence: [] }).amountOut, response.actualOutput);
  }
});

test("[family=curve-plain] third-coin consumption fails both runtime guards and Exact receipt verification", () => {
  const input = inputFor("exchange", undefined, 101n, false, 1), exact = exactProgram(input), request = exact.buildRequests(input)[0];
  assert.equal(request.observeTokenBalances.length, 3);
  assert.throws(() => simulate(request, input, false, "old-token"), error => error instanceof RuntimeProgramGuardError);
  const response = simulate(request, input);
  response.effects.tokenDeltas[2]!.delta = -1n;
  assert.throws(() => exact.decode({ programInput: input, initialResults: [response], dependentEvidence: [] }), /protected inventory/);
});

test("[family=curve-plain] clone variant uses the same executor simulation and rejects external receipt substitution", () => {
  const input = inputFor("exchange", undefined, 101n, true), exact = exactProgram(input);
  const request = exact.buildRequests(input)[0], response = simulate(request, input);
  assert.equal(exact.decode({ programInput: input, initialResults: [response], dependentEvidence: [] }).amountOut, 203n);
  assert.equal(family.execution.buildRuntimeLeg(input).program, unpack(request.call.data).program);
  assert.throws(() => exact.buildRequests({ ...input, recipient: a(999) }), /default executor receipt/);
});
