import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeDeferredOpeningFloor, runtimeDeferredPayment, type RuntimeSettlementRequest } from "../../../../../adapters/runtime-amount-program.js";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { inspectRuntime, type RuntimeCall } from "../../../../test/runtime-program-testkit.js";
import { applyRuntimeAssetBoundary, applyQuotedAssetBoundary, executionAssetBoundaryAdapter, mapRuntimeAssetSettlementRequest } from "../../../../execution-asset-boundary.js";
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

// These are contract fixtures. The historical runner separately binds actual
// deployment code, source, production issuer, balances and transaction receipts.
const debtABI = new ethers.Interface(["function borrow(uint256,bytes)", "function settle(uint256,bytes)"]);
const receiver = ethers.getAddress("0x5555555555555555555555555555555555555555");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type DirectFault = "zero-debit" | "under-debit" | "over-debit" | "zero-output" | "short-output" | "extra-output" |
  "wrong-recipient" | "old-output" | "receiver-input" | "native-loss" | "short-wrap" | "short-transfer";
function rawSettlement(d: FluidDexDescriptor, r: FluidDexRoute, settlement?: RuntimeSettlementRequest) {
  const input = { descriptor: d, route: r, executor: actor, source, runtimeEvidence: [], ...(settlement ? { settlement } : {}) };
  for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "exact", "quote"]) Object.defineProperty(input, key, {
    get() { throw new Error(`runtime read forbidden ${key}`); },
  });
  return family.execution.buildRuntimeLeg!(input);
}
function directCase(d: FluidDexDescriptor, r: FluidDexRoute, recipient: string, amount: bigint, fault?: DirectFault, rootProgram?: string) {
  const nativeIn = r.executionAssets!.input === "native", nativeOut = r.executionAssets!.output === "native";
  const request = { kind: "direct-output" as const, recipient };
  // Mirrors the common issuer's raw/native mapping; the actual issuer is
  // exercised in the separately bound historical matrix, not claimed here.
  const raw = rawSettlement(d, r, { ...request, recipient: nativeOut ? actor : recipient }); assert(raw);
  const leg = applyRuntimeAssetBoundary({ route: r, executor: actor, leg: { ...raw, settlementRequest: request } });
  const balances = new Map<string, bigint>(), key = (t: string, a: string) => t.toLowerCase() + ":" + a.toLowerCase();
  const get = (t: string, a: string) => balances.get(key(t, a)) ?? 0n;
  const add = (t: string, a: string, v: bigint) => { const next = get(t, a) + v; assert(next >= 0n); balances.set(key(t, a), next); };
  add(r.tokenIn, actor, amount + 101n); add(r.tokenOut, actor, 103n);
  add(r.tokenIn, receiver, 107n); add(r.tokenOut, receiver, 10n ** 30n);
  const before = new Map(balances); let native = 211n, allowance = 999n, swaps = 0, quotes = 0;
  const expected = amount * 2n;
  const revertedCall = (c: RuntimeCall) => {
    assert(same(c.target, pool)); assert.equal(c.revertBytes, 36); assert.equal(c.value, 0n);
    assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
    const args = FLUID_DEX_INTERFACE.decodeFunctionData("swapIn", c.data);
    assert.equal(args[0], r.swap0To1); assert.equal(args[1], amount); assert.equal(args[2], 0n);
    assert.equal(args[3], FLUID_DEX_ADDRESS_DEAD); quotes++;
    return { success: false, data: FLUID_DEX_INTERFACE.encodeErrorResult("FluidDexSwapResult", [expected]) };
  };
  const call = (c: RuntimeCall): string => {
    if (same(c.target, receiver) && c.data.startsWith(debtABI.getFunction("borrow")!.selector)) {
      assert(rootProgram); const args = debtABI.decodeFunctionData("borrow", c.data); assert.equal(args[0], expected);
      add(r.tokenIn, actor, amount + 1n);
      const bytes = ethers.getBytes(args[1]), cap = BigInt(ethers.hexlify(bytes.slice(1, 33))); assert.equal(cap, expected);
      inspectRuntime(ethers.hexlify(bytes.slice(36)), cap, { call, revertedCall, nativeBalance: () => native,
        calldata: debtABI.encodeFunctionData("settle", [expected, args[1]]) }); return "0x";
    }
    if (same(c.target, actor)) {
      const script = ethers.getBytes(subscript.decodeFunctionData("execSubscript", c.data)[0]);
      inspectRuntime(scriptProgram(script, amount), amount, { call, revertedCall, nativeBalance: () => native }); return "0x";
    }
    if (c.data.startsWith(RUNTIME_ERC20.getFunction("balanceOf")!.selector)) {
      assert(c.static); return word(get(c.target, RUNTIME_ERC20.decodeFunctionData("balanceOf", c.data)[0]));
    }
    if (c.data.startsWith(RUNTIME_ERC20.getFunction("approve")!.selector)) {
      const args = RUNTIME_ERC20.decodeFunctionData("approve", c.data); assert(same(args[0], pool));
      allowance = args[1]; return word(1n);
    }
    if (same(c.target, pool)) {
      const args = FLUID_DEX_INTERFACE.decodeFunctionData("swapIn", c.data);
      assert.equal(args[0], r.swap0To1); assert.equal(args[1], amount); assert.equal(args[2], 1n);
      assert(same(args[3], nativeOut ? actor : recipient)); swaps++;
      const debit = fault === "zero-debit" ? 0n : amount + (fault === "under-debit" ? -1n : fault === "over-debit" ? 1n : 0n);
      const credit = fault === "zero-output" ? 0n : expected + (fault === "short-output" ? -1n : fault === "extra-output" ? 1n : 0n);
      assert.equal(c.value, nativeIn ? amount : 0n);
      if (nativeIn) native -= debit;
      else { assert.equal(allowance, amount); add(r.tokenIn, actor, -debit); }
      if (nativeOut) native += fault === "wrong-recipient" ? 0n : credit;
      else add(r.tokenOut, fault === "wrong-recipient" ? same(recipient, actor) ? receiver : actor : recipient, credit);
      if (fault === "old-output") add(r.tokenOut, actor, -1n);
      if (fault === "receiver-input") add(r.tokenIn, receiver, -1n);
      if (fault === "native-loss") native--;
      return word(expected);
    }
    assert(same(c.target, ADDR.WETH));
    if (c.data.startsWith(RUNTIME_ERC20.getFunction("transfer")!.selector)) {
      const args = RUNTIME_ERC20.decodeFunctionData("transfer", c.data); assert(same(args[0], recipient));
      add(ADDR.WETH, actor, -args[1]); add(ADDR.WETH, recipient, args[1] - (fault === "short-transfer" ? 1n : 0n)); return word(1n);
    }
    const args = RUNTIME_WRAP.parseTransaction({ data: c.data })!;
    if (args.name === "withdraw") { add(ADDR.WETH, actor, -args.args[0]); native += args.args[0]; }
    else { assert.equal(args.name, "deposit"); native -= c.value; add(ADDR.WETH, actor, c.value - (fault === "short-wrap" ? 1n : 0n)); }
    return "0x";
  };
  inspectRuntime(rootProgram ?? leg.program, amount, { call, revertedCall, nativeBalance: () => native });
  if (fault !== undefined) return; // Negative fixtures must fail inside the emitted program.
  assert.equal(quotes, rootProgram ? 2 : 1); assert.equal(swaps, 1); assert.equal(native, 211n);
  assert.equal(get(r.tokenIn, actor), rootProgram ? amount + 102n : 101n);
  assert.equal(get(r.tokenOut, recipient), before.get(key(r.tokenOut, recipient))! + expected);
  if (!same(recipient, actor)) { assert.equal(get(r.tokenOut, actor), 103n); assert.equal(get(r.tokenIn, receiver), 107n); }
  if (!nativeIn) assert.equal(allowance, 0n);
}

for (const [name, t0, t1] of [["native0", FLUID_DEX_NATIVE_TOKEN, token], ["native1", token, FLUID_DEX_NATIVE_TOKEN],
  ["WETH ERC20", ADDR.WETH, token], ["ERC20", token, other]] as const) {
  test(`${name}: explicit direct debit/receipt and quote declarations preserve default bytes`, () => {
    const d = fixture(t0, t1);
    for (const r of family.routes.project({ descriptor: d })) {
      const leg = rawSettlement(d, r); assert(leg); assert.deepEqual(leg.settlement, { quoteOutput: true, directOutput: true });
      const old = new RuntimeAmountProgram();
      if (r.executionAssets!.input !== "native") {
        old.call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("approve", [pool, 0n]))
          .call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("approve", [pool, 0n]), { patches: [{ offset: 36, reg: 0 }] });
      }
      old.call(pool, FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [r.swap0To1, 0n, 1n, actor]), {
        patches: [{ offset: 36, reg: 0 }], ...(r.executionAssets!.input === "native" ? { valueReg: 0 } : {}),
      });
      if (r.executionAssets!.input !== "native") old.call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("approve", [pool, 0n]));
      assert.equal(leg.program, ethers.hexlify(old.bytes()));
      assert.equal(rawSettlement(d, r, { kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x" }), null);
      for (const recipient of [actor, receiver]) for (const amount of [1n, 100n, 1234567890123456789n]) directCase(d, r, recipient, amount);
      for (const kind of ["quote-output", "direct-output"] as const) for (const recipient of
        [ethers.ZeroAddress, FLUID_DEX_ADDRESS_DEAD, pool, r.tokenIn, r.tokenOut, "invalid"]) {
        assert.throws(() => rawSettlement(d, r, { kind, recipient }));
      }
      for (const recipient of [actor, receiver]) {
        for (const fault of ["zero-debit", "under-debit", "over-debit", "zero-output", "short-output", "extra-output", "wrong-recipient", "native-loss"] as const)
          assert.throws(() => directCase(d, r, recipient, 100n, fault), fault);
        if (!same(recipient, actor)) for (const fault of ["old-output", "receiver-input"] as const)
          assert.throws(() => directCase(d, r, recipient, 100n, fault), fault);
        if (r.executionAssets!.output === "native") {
          assert.throws(() => directCase(d, r, recipient, 100n, "short-wrap"));
          if (!same(recipient, actor)) assert.throws(() => directCase(d, r, recipient, 100n, "short-transfer"));
        }
        assert.throws(() => directCase(d, r, recipient, 0n));
      }
    }
  });
  test(`${name}: unfunded quote accepts only the declared revert and positive output`, () => {
    const d = fixture(t0, t1);
    for (const r of family.routes.project({ descriptor: d })) for (const recipient of [undefined, actor, receiver]) {
      const leg = rawSettlement(d, r, { kind: "quote-output", ...(recipient ? { recipient } : {}) }); assert(leg);
      const bounded = applyRuntimeAssetBoundary({ route: r, executor: actor, leg }); assert.equal(bounded, leg);
      const run = (amount: bigint, success: boolean, data: string) => inspectRuntime(leg.program, amount, {
        call() { throw Error("quote must not fund, approve, unwrap or wrap"); },
        nativeBalance() { throw Error("quote must not read actor funding"); },
        revertedCall(c) { assert.equal(c.value, 0n); const args = FLUID_DEX_INTERFACE.decodeFunctionData("swapIn", c.data);
          assert.equal(args[1], amount); assert.equal(args[3], FLUID_DEX_ADDRESS_DEAD); return { success, data }; },
      }, { output: true, readOnly: true });
      const good = FLUID_DEX_INTERFACE.encodeErrorResult("FluidDexSwapResult", [13n]);
      assert.equal(run(7n, false, good).registers[0], 13n);
      for (const data of ["0x", good + "00", good.slice(0, -2), "0xdeadbeef" + good.slice(10),
        FLUID_DEX_INTERFACE.encodeErrorResult("FluidDexError", [51049n]), FLUID_DEX_INTERFACE.encodeErrorResult("FluidDexSwapResult", [0n])]) {
        assert.throws(() => run(7n, false, data));
      }
      assert.throws(() => run(7n, true, good)); assert.throws(() => run(0n, false, good));
    }
  });
}
test("revert-call emitter rejects value, callbacks, static ambiguity and excessive length", () => {
  for (const config of [{ revertBytes: -1 }, { revertBytes: 65537 }, { revertBytes: 1.5 },
    { revertBytes: 36, static: true }, { revertBytes: 36, valueReg: 0 },
    { revertBytes: 36, callback: { incomingOffset: 0, outgoingOffset: 0 } }]) {
    assert.throws(() => new RuntimeAmountProgram().call(pool, "0x", config));
  }
});

test("production sim selector composes Fluid declared-revert/native direct without external Exact or quoted fallback", async () => {
  const { createBlockScanSimAmountSelector } = await import("../../../../simulator/blockscan-sim-amount-selector.js");
  for (const d of [fixture(FLUID_DEX_NATIVE_TOKEN, token), fixture(token, other)]) for (const r of family.routes.project({ descriptor: d })) {
    let exact = 0, quoted = 0, simulations = 0;
    const edges = [{ adapterId: "fluid-dex-swap", target: pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
      { adapterId: "fixture-deferred", target: receiver, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
    const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate(plan) {
      simulations++; assert.equal(plan.root.adapterId, "runtime-amount-flow"); assert(plan.root.params.settlementProgram);
      directCase(d, r, receiver, plan.flashAmount, undefined, plan.root.params.settlementProgram as string);
      return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" };
    } });
    const session: any = { source, blocksPrefixInversion: () => false, fundingActionIds: () => [],
      buildRuntimeAmountLeg({ edge, settlement }: any) {
        if (edge === edges[0]) {
          const mapped = mapRuntimeAssetSettlementRequest({ route: r, executor: actor, request: settlement });
          if (mapped === null) return null;
          const raw = rawSettlement(d, r, mapped); if (!raw) return null;
          return applyRuntimeAssetBoundary({ route: r, executor: actor, leg: { ...raw, settlementRequest: settlement } });
        }
        if (!settlement) return { actionAdapterId: "fixture-deferred", program: "0x010001" + "00".repeat(32), settlement: { deferredInput: receiver } };
        assert.equal(settlement.kind, "deferred-input");
        const payment = runtimeDeferredPayment({ tokenOut: r.tokenIn, executor: actor, debtOffset: 4, ...settlement });
        const p = new RuntimeAmountProgram(); runtimeDeferredOpeningFloor(p, r.tokenIn, actor, settlement.paymentAmount);
        p.call(receiver, debtABI.encodeFunctionData("borrow", [0n, payment.script]), { callback: { incomingOffset: 100, outgoingOffset: 100 },
          patches: [{ offset: 4, reg: 0 }, { offset: 100 + payment.limitOffset, reg: 0 }, { offset: 100 + payment.floorOffset, reg: 13 }] });
        return { actionAdapterId: "fixture-deferred", program: ethers.hexlify(p.bytes()), settlementRequest: settlement };
      }, issueExact() { exact++; throw Error("Exact forbidden"); }, buildExecution() { quoted++; throw Error("quoted forbidden"); },
    };
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 1000000n }, flashToken: r.tokenIn,
      profitToken: r.tokenIn, targetNetProfit: 1n }, tokenPath: { edges }, maxFlashAmount: 2000000n, templateName: "Fluid fixture" } as any,
      { call() { throw Error("RPC forbidden"); } } as any, { executor: actor } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 0, deadlineAtMs: Date.now() + 10000 });
    assert(simulations > 0); assert.equal(exact, 0); assert.equal(quoted, 0);
  }
});
