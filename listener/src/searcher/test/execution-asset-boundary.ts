import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { materializeAdapterRequests } from "../reth-adapter-work-runtime.js";
import { declareRequestProgram, physicalAdapterRequestFingerprint, type AdapterRequest } from "../venues/adapter-request-program.js";
import { applyRuntimeAssetBoundary, applyQuotedAssetBoundary, executionNativeSides,
  executionAssetBoundaryAdapter } from "../execution-asset-boundary.js";
import { RUNTIME_ERC20, RUNTIME_WRAP } from "../venues/runtime-execution.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";

const token = "0x1111111111111111111111111111111111111111";
const actor = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const subscript = new ethers.Interface(["function execSubscript(bytes)"]);
const rawCall = new ethers.Interface(["function exchange(uint256)"]);
const word = (value: bigint) => ethers.toBeHex(value, 32);
const weth = ADDR.WETH.toLowerCase();

function caseRun(nativeIn: boolean, quoted: boolean | "strict", failure?: "overspend" | "short-output" | "native-loss" | "short-unwrap", partial = false) {
  const amount = 100n, stock = 777n;
  const route = { tokenIn: nativeIn ? weth : token, tokenOut: nativeIn ? token : weth,
    executionAssets: { input: nativeIn ? "native" as const : "erc20" as const,
      output: nativeIn ? "erc20" as const : "native" as const } };
  // A synthetic Family provides ONLY the native protocol call. No wrapper
  // helper, native balance read, or off-chain quote is invoked by its emitter.
  const raw = new RuntimeAmountProgram().call(target, rawCall.encodeFunctionData("exchange", [0n]), {
    patches: [{ offset: 4, reg: 0 }], ...(nativeIn ? { valueReg: 0 } : {}),
  });
  const leg = { actionAdapterId: "synthetic-raw-native", program: ethers.hexlify(raw.bytes()) };
  let program: string;
  if (quoted === "strict") {
    const req: AdapterRequest = { id: "native-proof", kind: "effect-delta-simulation",
      executionAssetBoundary: { ...route, amountIn: amount, minimum: 200n },
      call: { caller: { kind: "executor" }, executionMode: "executor-program", to: actor,
        data: buildSubscriptCalldata(runtimeProgramScript(raw.bytes(), amount)) },
      overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: route.tokenIn, amount }] },
      observeTokenBalances: [route.tokenIn, route.tokenOut].map(token => ({ token, account: { kind: "executor" } })),
      observe: ["token-delta", "native-delta"],
    };
    const declared = declareRequestProgram({ requirements: () => ({ transports: ["effect-delta-simulation"],
      caller: "executor", effects: ["token-delta", "native-delta"] }), buildRequests: () => [req], decode: () => null }, {});
    const materialized = materializeAdapterRequests(declared.requests, { executor: actor });
    const compiled = materialized[0]; assert(compiled.kind === "effect-delta-simulation");
    assert(!Object.hasOwn(compiled, "executionAssetBoundary"));
    const script = ethers.getBytes(subscript.decodeFunctionData("execSubscript", compiled.call.data)[0]);
    assert.equal(BigInt(ethers.hexlify(script.slice(1, 33))), amount);
    program = ethers.hexlify(script.slice(36));
    assert.notEqual(compiled.call.data, req.call.data);
    assert.notEqual(physicalAdapterRequestFingerprint(req), physicalAdapterRequestFingerprint({ ...req,
      executionAssetBoundary: { ...req.executionAssetBoundary!, minimum: 199n } }));
    const invalid = [
      { ...req, observe: ["token-delta"] }, { ...req, observeTokenBalances: [] },
      { ...req, call: { ...req.call, executionMode: "top-level" } },
      { ...req, executionAssetBoundary: { ...req.executionAssetBoundary, amountIn: 0n } },
    ];
    for (const request of invalid) assert.throws(() => declareRequestProgram({
      requirements: () => declared.requirements, buildRequests: () => [request as AdapterRequest], decode: () => null,
    }, {}));
    assert.throws(() => materializeAdapterRequests([{ ...req, call: { ...req.call, to: target } }], { executor: actor }));
  } else if (quoted) {
    const original: any = { requirements: [], nodes: [{ adapterId: leg.actionAdapterId, target,
      tokenIn: route.tokenIn, tokenOut: route.tokenOut, amount, params: {}, children: [] }] };
    const fragment = applyQuotedAssetBoundary({ route, executor: actor, amountIn: amount, minimum: 200n, fragment: original });
    assert.equal(fragment.nodes[0].adapterId, "execution-asset-boundary");
    assert.equal(fragment.nodes[0].children[0], original.nodes[0]);
    const script = executionAssetBoundaryAdapter.encode(fragment.nodes[0], actor, runtimeProgramScript(raw.bytes(), amount));
    assert.equal(script[0], 0x0e); program = ethers.hexlify(script.slice(36));
  } else program = applyRuntimeAssetBoundary({ route, executor: actor, leg }).program;
  const balances = new Map([[route.tokenIn, stock + amount], [route.tokenOut, stock]]);
  let native = stock, rawCalls = 0;
  function executeScript(script: string) {
    const bytes = ethers.getBytes(script);
    assert.equal(bytes[0], 0x0e);
    const supplied = BigInt(ethers.hexlify(bytes.slice(1, 33)));
    assert.equal(Number(BigInt(ethers.hexlify(bytes.slice(33, 36)))), bytes.length - 36);
    inspectRuntime(ethers.hexlify(bytes.slice(36)), supplied, { call, nativeBalance: () => native });
  }
  function call(c: RuntimeCall): string {
    const address = c.target.toLowerCase();
    if (address === actor) { executeScript(subscript.decodeFunctionData("execSubscript", c.data)[0]); return "0x"; }
    if (address === target) {
      rawCalls++;
      const input = rawCall.decodeFunctionData("exchange", c.data)[0]; assert.equal(input, amount);
      const paid = partial ? 40n : amount;
      if (nativeIn) { assert.equal(c.value, amount); native -= paid; }
      else { assert.equal(c.value, 0n); balances.set(token, balances.get(token)! - paid - (failure === "overspend" ? 1n : 0n)); }
      const received = failure === "short-output" ? 0n : 200n;
      if (nativeIn) balances.set(token, balances.get(token)! + received);
      else native += received;
      if (failure === "native-loss") native -= 1000n;
      return "0x";
    }
    if (c.data.startsWith(RUNTIME_ERC20.getFunction("balanceOf")!.selector)) {
      assert.equal(RUNTIME_ERC20.decodeFunctionData("balanceOf", c.data)[0].toLowerCase(), actor);
      return word(balances.get(address)!);
    }
    assert.equal(address, weth);
    const parsed = RUNTIME_WRAP.parseTransaction({ data: c.data }); assert(parsed);
    if (parsed.name === "withdraw") {
      assert.equal(parsed.args[0], amount); balances.set(weth, balances.get(weth)! - amount);
      native += amount - (failure === "short-unwrap" ? 1n : 0n);
    } else {
      assert.equal(parsed.name, "deposit"); native -= c.value; balances.set(weth, balances.get(weth)! + c.value);
    }
    return "0x";
  }
  inspectRuntime(program, amount, { call, nativeBalance: () => native });
  assert.equal(rawCalls, 1); assert.equal(native, stock);
  assert.equal(balances.get(route.tokenIn), stock + (partial ? 60n : 0n));
  assert.equal(balances.get(route.tokenOut), stock + 200n);
}

test("native declarations automatically bridge raw quoted/runtime operations in both directions", () => {
  for (const nativeIn of [true, false]) for (const quoted of [true, false, "strict"] as const) {
    caseRun(nativeIn, quoted); caseRun(nativeIn, quoted, undefined, true);
  }
});
test("central native boundary rejects inventory subsidy and independently measures output", () => {
  for (const quoted of [true, false, "strict"] as const) {
    assert.throws(() => caseRun(true, quoted, "short-unwrap"), /checked uint256/);
    assert.throws(() => caseRun(false, quoted, "overspend"), /checked uint256/);
    for (const nativeIn of [true, false]) for (const failure of ["short-output", "native-loss"] as const)
      assert.throws(() => caseRun(nativeIn, quoted, failure), /checked uint256/);
  }
});
test("ERC20 including WETH stays unchanged; malformed native declarations fail closed", () => {
  const leg = { actionAdapterId: "ordinary", program: "0x010001" + "00".repeat(32) };
  const route = { tokenIn: weth, tokenOut: token };
  assert.equal(applyRuntimeAssetBoundary({ route, executor: actor, leg }), leg);
  assert.equal(applyRuntimeAssetBoundary({ route: { ...route, executionAssets: { input: "erc20", output: "erc20" } }, executor: actor, leg }), leg);
  for (const executionAssets of [null, {}, { input: "native" }, { input: "native", output: "native" },
    { input: "other", output: "erc20" }, { input: "native", output: "erc20", extra: true }])
    assert.throws(() => executionNativeSides({ ...route, executionAssets } as any), /execution (asset|native)/);
  assert.throws(() => executionNativeSides({ tokenIn: token, tokenOut: weth, executionAssets: { input: "native", output: "erc20" } }), /graph binding/);
});

test("quoted transfer/approval requirements stay inside the inventory boundary", () => {
  const fragment: any = { requirements: [
    { kind: "approve", token, spender: target, amount: ethers.MaxUint256 },
    { kind: "transfer-to-pool", token, pool: target, amount: 100n },
  ], nodes: [{ adapterId: "synthetic", target, tokenIn: token, tokenOut: weth, amount: 100n, params: {}, children: [] }] };
  const result = applyQuotedAssetBoundary({ route: { tokenIn: token, tokenOut: weth,
    executionAssets: { input: "erc20", output: "native" } }, executor: actor, amountIn: 100n, minimum: 1n, fragment });
  assert.deepEqual(result.requirements, []);
  assert.deepEqual(result.nodes[0].children.map(n => n.adapterId), ["erc20-approve", "erc20-transfer", "synthetic"]);
  assert.equal(result.nodes[0].children[0].params.minimumAllowance, 100n);
  assert.equal(result.nodes[0].children[1].amount, 100n);
});
