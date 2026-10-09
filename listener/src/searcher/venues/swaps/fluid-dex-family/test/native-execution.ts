import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { inspectRuntime, type RuntimeCall } from "../../../../test/runtime-program-testkit.js";
import { applyRuntimeAssetBoundary, applyQuotedAssetBoundary, executionAssetBoundaryAdapter } from "../../../../execution-asset-boundary.js";
import { RUNTIME_ERC20, RUNTIME_WRAP } from "../../../runtime-execution.js";
import { createIdentityAssetMetadataPlan } from "../../../../identity-asset-metadata.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { fluidDexStrictFamilyPlugin as family } from "../../fluid-dex-family-plugin.js";
import { fluidDexFamilyOwnedAction } from "../action.js";
import { FLUID_DEX_ADDRESS_DEAD, FLUID_DEX_INTERFACE, FLUID_DEX_NATIVE_TOKEN, fluidDexAsset } from "../codec.js";
import { FLUID_DEX_FACTORY_LINEAGE_ID, FLUID_DEX_FAMILY_ID } from "../manifest.js";
import type { FluidDexDescriptor, FluidDexExactEvidence, FluidDexIdentity, FluidDexRoute } from "../types.js";

const pool = ethers.getAddress("0x1111111111111111111111111111111111111111");
const actor = ethers.getAddress("0x2222222222222222222222222222222222222222");
const token = ethers.getAddress("0x3333333333333333333333333333333333333333");
const other = ethers.getAddress("0x4444444444444444444444444444444444444444");
const source = { number: 26017168, hash: "0x" + "ab".repeat(32), generation: 1 };
const word = (n: bigint) => ethers.toBeHex(n, 32);
const subscript = new ethers.Interface(["function execSubscript(bytes)"]);

// Synthetic declarations/metadata, never historical identity or admission.
function fixture(raw0: string, raw1: string): FluidDexDescriptor {
  const plan = createIdentityAssetMetadataPlan([fluidDexAsset("token0", raw0), fluidDexAsset("token1", raw1)], source);
  const responses: AdapterRequestResult[] = plan.append([]).map(r => ({ id: r.id, ok: true,
    source, provenance: { kind: "fixture", fingerprint: "fluid-native-offline" }, completion: "returned",
    data: r.kind === "get-code" ? "0x6000" : word(18n) }));
  const [asset0, asset1] = plan.decode(responses);
  const identity: FluidDexIdentity = { familyId: FLUID_DEX_FAMILY_ID, lineageId: FLUID_DEX_FACTORY_LINEAGE_ID,
    subject: pool, provenance: [], facts: { pool, rawToken0: raw0, rawToken1: raw1,
      token0: asset0.token, token1: asset1.token, token0Decimals: asset0.decimals!, token1Decimals: asset1.decimals!,
      factoryBinding: { factory: other, dexId: 1n, reverseDex: pool },
      quoteBinding: { target: pool, recipient: FLUID_DEX_ADDRESS_DEAD,
        completion: "return-or-revert-data", successEncoding: "FluidDexSwapResult(uint256)-revert" } } };
  return family.instance.finalizeDescriptor({ identity, draft: family.instance.compileDraft(identity), sharedBindings: [] });
}

function runtime(d: FluidDexDescriptor, r: FluidDexRoute) {
  const input = { descriptor: d, route: r, executor: actor, source, runtimeEvidence: [] };
  for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "exact", "quote"]) {
    Object.defineProperty(input, key, { get() { throw new Error(`runtime read forbidden ${key}`); } });
  }
  const leg = family.execution.buildRuntimeLeg!(input);
  assert(leg, "native directions must not fall back to quoted execution");
  return leg;
}
function quoted(d: FluidDexDescriptor, r: FluidDexRoute, amount: bigint, minimum = 17n) {
  const exactEvidence: FluidDexExactEvidence = { kind: "fluid-dex-declared-revert-quote", source,
    pool, routeKey: r.routeKey, swap0To1: r.swap0To1, tokenIn: r.tokenIn, tokenOut: r.tokenOut,
    amountIn: amount, amountOut: 19n, completion: "reverted-as-declared" };
  return family.execution.buildFragment({ descriptor: d, route: r, executor: actor, runtimeEvidence: [],
    amountIn: amount, quotedAmountOut: 19n, minAmountOut: minimum, exactEvidence });
}
function scriptProgram(script: Uint8Array, amount: bigint): string {
  assert.equal(script[0], 0x0e);
  assert.equal(BigInt(ethers.hexlify(script.slice(1, 33))), amount);
  assert.equal(Number(BigInt(ethers.hexlify(script.slice(33, 36)))), script.length - 36);
  return ethers.hexlify(script.slice(36));
}

for (const [name, raw0, raw1] of [
  ["native token0", FLUID_DEX_NATIVE_TOKEN, token],
  ["native token1", token, FLUID_DEX_NATIVE_TOKEN],
  ["ordinary WETH", ADDR.WETH, token],
  ["ordinary ERC20", token, other],
] as const) {
  test(`${name}: raw runtime and quoted calldata, value, recipient and temporary approvals`, () => {
    const d = fixture(raw0, raw1);
    for (const r of family.routes.project({ descriptor: d })) {
      const nativeIn = r.executionAssets!.input === "native";
      if (name === "ordinary WETH") assert.deepEqual(r.executionAssets, { input: "erc20", output: "erc20" });
      for (const amount of [11n, 123456789n, 10n ** 18n]) for (const isQuoted of [false, true]) {
        const fragment = isQuoted ? quoted(d, r, amount) : undefined;
        if (fragment) { assert.equal(fragment.nodes.length, 1); assert.deepEqual(fragment.requirements, []); }
        const program = fragment ? scriptProgram(fluidDexFamilyOwnedAction.encode(fragment.nodes[0], actor, new Uint8Array()), amount)
          : runtime(d, r).program;
        const trace = inspectRuntime(program, amount, { call: c => c.target === pool ? word(31n) : word(1n),
          nativeBalance() { throw new Error("Family must not own the native boundary"); } });
        assert.deepEqual(trace.allowances, [], "no standing maximum approval instruction");
        const swaps = trace.calls.filter(c => c.target === pool);
        assert.equal(swaps.length, 1);
        const swap = swaps[0], args = FLUID_DEX_INTERFACE.decodeFunctionData("swapIn", swap.data);
        assert.equal(args[0], r.swap0To1); assert.equal(args[1], amount);
        assert.equal(args[2], isQuoted ? 17n : 1n); assert.equal(args[3], actor);
        assert.equal(swap.value, nativeIn ? amount : 0n);
        assert.deepEqual(swap.patches, [{ offset: 36, reg: 0 }]);
        const approvals = trace.calls.filter(c => c.target !== pool);
        assert.equal(approvals.length, nativeIn ? 0 : 3);
        assert.deepEqual(approvals.map(c => {
          assert.equal(c.target, ethers.getAddress(r.tokenIn)); assert.equal(c.value, 0n);
          const a = RUNTIME_ERC20.decodeFunctionData("approve", c.data);
          assert.equal(a[0], pool); return a[1];
        }), nativeIn ? [] : [0n, amount, 0n]);
      }
    }
  });
}

test("native route/mapping and quoted encoder parameter negative cases", () => {
  const d = fixture(FLUID_DEX_NATIVE_TOKEN, token), r = family.routes.project({ descriptor: d })[0];
  assert.throws(() => family.routes.project({ descriptor: { ...d, token1: d.token0 } }), /mapping conflict/);
  assert.throws(() => family.routes.project({ descriptor: { ...d, rawToken1: other } }), /mapping conflict/);
  for (const forged of [
    { ...r, executionAssets: { input: "erc20" as const, output: "erc20" as const } },
    { ...r, swap0To1: false }, { ...r, tokenIn: token },
  ]) {
    assert.throws(() => runtime(d, forged), /binding mismatch/);
    assert.throws(() => quoted(d, forged, 100n), /binding mismatch/);
  }
  const node = quoted(d, r, 100n).nodes[0];
  for (const patch of [{ swap0to1: 1 }, { nativeInput: undefined }, { nativeOutput: true },
    { amountOutMin: -1n }, { amountOutMin: ethers.MaxUint256 + 1n }, { amountOutMin: 17 }]) {
    assert.throws(() => fluidDexFamilyOwnedAction.encode({ ...node, params: { ...node.params, ...patch } }, actor, new Uint8Array()), /parameters/);
  }
  for (const amount of [0n, -1n, ethers.MaxUint256 + 1n]) {
    assert.throws(() => fluidDexFamilyOwnedAction.encode({ ...node, amount }, actor, new Uint8Array()), /shape/);
    assert.throws(() => quoted(d, r, amount), /incompatible exact evidence/);
  }
  for (const executor of [ethers.ZeroAddress, pool, r.tokenIn, r.tokenOut]) {
    assert.throws(() => fluidDexFamilyOwnedAction.encode(node, executor, new Uint8Array()), /invalid executor/);
  }
  assert.throws(() => fluidDexFamilyOwnedAction.encode(node, actor, new Uint8Array([1])), /shape/);
  assert.throws(() => quoted(d, r, 100n, 20n), /incompatible exact evidence/);
});

type Failure = "overspend" | "no-output" | "native-loss";
function centralBoundaryCase(nativeIn: boolean, isQuoted: boolean, failure?: Failure) {
  const d = fixture(FLUID_DEX_NATIVE_TOKEN, token);
  const r = family.routes.project({ descriptor: d }).find(r => (r.executionAssets!.input === "native") === nativeIn)!;
  const amount = 100n, receipt = failure === "no-output" ? 0n : 31n, stock = 777n;
  let program: string;
  if (isQuoted) {
    const raw = quoted(d, r, amount);
    const bounded = applyQuotedAssetBoundary({ route: r, executor: actor, amountIn: amount, minimum: 17n, fragment: raw });
    assert.equal(bounded.nodes[0].adapterId, "execution-asset-boundary");
    program = scriptProgram(executionAssetBoundaryAdapter.encode(bounded.nodes[0], actor,
      fluidDexFamilyOwnedAction.encode(raw.nodes[0], actor, new Uint8Array())), amount);
  } else program = applyRuntimeAssetBoundary({ route: r, executor: actor, leg: runtime(d, r) }).program;
  const balances = new Map([[r.tokenIn.toLowerCase(), stock + amount], [r.tokenOut.toLowerCase(), stock]]);
  let native = stock, allowance = 999n, wraps = 0, poolCalls = 0;
  function call(c: RuntimeCall): string {
    const address = c.target.toLowerCase();
    if (c.target === actor) {
      const script = ethers.getBytes(subscript.decodeFunctionData("execSubscript", c.data)[0]);
      inspectRuntime(scriptProgram(script, amount), amount, { call, nativeBalance: () => native }); return "0x";
    }
    if (c.data.startsWith(RUNTIME_ERC20.getFunction("balanceOf")!.selector)) return word(balances.get(address)!);
    if (c.data.startsWith(RUNTIME_ERC20.getFunction("approve")!.selector)) {
      assert(!nativeIn); allowance = RUNTIME_ERC20.decodeFunctionData("approve", c.data)[1]; return word(1n);
    }
    if (c.target === pool) {
      poolCalls++;
      const args = FLUID_DEX_INTERFACE.decodeFunctionData("swapIn", c.data);
      assert.equal(args[1], amount); assert.equal(args[3], actor);
      if (nativeIn) { assert.equal(c.value, amount); native -= amount; }
      else { assert.equal(c.value, 0n); assert.equal(allowance, amount);
        balances.set(r.tokenIn.toLowerCase(), balances.get(r.tokenIn.toLowerCase())! - amount - (failure === "overspend" ? 1n : 0n)); }
      if (nativeIn) balances.set(r.tokenOut.toLowerCase(), balances.get(r.tokenOut.toLowerCase())! + receipt);
      else native += receipt;
      if (failure === "native-loss") native -= stock;
      return word(19n); // Neither quote nor pool return quantity is receipt evidence.
    }
    assert.equal(address, ADDR.WETH.toLowerCase());
    const operation = RUNTIME_WRAP.parseTransaction({ data: c.data })!;
    if (operation.name === "withdraw") {
      assert(nativeIn); assert.equal(operation.args[0], amount);
      balances.set(address, balances.get(address)! - amount); native += amount;
    } else {
      assert.equal(operation.name, "deposit"); wraps++;
      assert.equal(c.value, nativeIn ? 0n : receipt);
      native -= c.value; balances.set(address, balances.get(address)! + c.value);
    }
    return "0x";
  }
  inspectRuntime(program, amount, { call, nativeBalance: () => native });
  assert.equal(native, stock); assert.equal(poolCalls, 1); assert.equal(wraps, 1);
  assert.equal(balances.get(r.tokenIn.toLowerCase()), stock);
  assert.equal(balances.get(r.tokenOut.toLowerCase()), stock + receipt);
  if (!nativeIn) assert.equal(allowance, 0n);
}

test("both native directions and execution interfaces use the central measured boundary", () => {
  for (const nativeIn of [true, false]) for (const isQuoted of [true, false]) centralBoundaryCase(nativeIn, isQuoted);
});
test("old ETH/WETH/token inventory cannot subsidize a native leg or stand in for receipt", () => {
  for (const isQuoted of [true, false]) {
    assert.throws(() => centralBoundaryCase(false, isQuoted, "overspend"), /checked uint256/);
    for (const nativeIn of [true, false]) for (const failure of ["no-output", "native-loss"] as const) {
      assert.throws(() => centralBoundaryCase(nativeIn, isQuoted, failure), /checked uint256/);
    }
  }
});
