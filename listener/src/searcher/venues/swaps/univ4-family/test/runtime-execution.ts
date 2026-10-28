import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { univ4Execution } from "../execution.js";
import { UNIV4_FAMILY_ID, UNIV4_MANAGER_LINEAGE_ID } from "../manifest.js";
import { univ4Routes } from "../routes.js";
import { buildUniV4RuntimeLeg } from "../runtime-execution.js";
import { applyRuntimeAssetBoundary } from "../../../../execution-asset-boundary.js";
import type { UniV4Descriptor, UniV4Route } from "../types.js";

// Independent ABI declarations and synthetic replies: these checks exercise the
// production Family encoder, not an EVM, PoolManager, balances or callback auth.
const managerAbi = new ethers.Interface([
  "function unlock(bytes) returns(bytes)",
  "function unlockCallback(bytes) returns(bytes)",
  "function swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes) returns(int256)",
  "function take(address,address,uint256)",
  "function sync(address)",
  "function settle() payable returns(uint256)",
]);
const tokenAbi = new ethers.Interface([
  "function transfer(address,uint256) returns(bool)",
  "function withdraw(uint256)",
  "function deposit() payable",
]);
const abi = ethers.AbiCoder.defaultAbiCoder();
const token0 = `0x${"11".repeat(20)}`, token1 = `0x${"22".repeat(20)}`;
const manager = `0x${"33".repeat(20)}`, executor = `0x${"44".repeat(20)}`;
const other = `0x${"55".repeat(20)}`, codeHash = `0x${"66".repeat(32)}`;
const MAX_I128 = (1n << 127n) - 1n;
const address = (value: string) => ethers.getAddress(value).toLowerCase();

function fixture(native: boolean, reverse: boolean) {
  const key = { currency0: native ? ethers.ZeroAddress : token0, currency1: token1,
    fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress };
  const poolId = ethers.keccak256(abi.encode(["address", "address", "uint24", "int24", "address"],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const descriptor: UniV4Descriptor = {
    familyId: UNIV4_FAMILY_ID, lineageId: UNIV4_MANAGER_LINEAGE_ID,
    instanceKey: instanceKey(`${manager}:${poolId}`), provenance: [], runtimeRequirements: [],
    poolId, poolKey: key, graphToken0: native ? ADDR.WETH : token0, graphToken1: token1,
    managerBinding: { manager, stateView: other, quoter: other, managerCodeHash: codeHash }, hookPolicy: "no-hook",
  };
  const route = univ4Routes.project({ descriptor })[reverse ? 1 : 0];
  return { descriptor, route, executor };
}
type Input = ReturnType<typeof fixture>;
const cases = [
  { name: "ERC20 zero-for-one", input: fixture(false, false) },
  { name: "ERC20 one-for-zero", input: fixture(false, true) },
  { name: "native input", input: fixture(true, false) },
  { name: "native output", input: fixture(true, true) },
];

function word(bytes: Uint8Array, offset: number, size = 32): bigint {
  assert(offset >= 0 && size > 0 && offset + size <= bytes.length, "return/header word bounds");
  return BigInt(ethers.hexlify(bytes.slice(offset, offset + size)));
}
interface Call {
  target: string;
  data: Uint8Array;
  template: Uint8Array;
  value: bigint;
  valueReg: number;
  incoming: number;
  outgoing: number;
  patches: { offset: number; reg: number }[];
}

// A bounded decoder/evaluator for only the instructions emitted by this Family.
// Synthetic onCall replies are explicitly separate from actual VM execution.
function evaluate(bytes: Uint8Array, amount: bigint, onCall: (call: Call) => string): void {
  const r = Array<bigint>(16).fill(0n); r[0] = amount;
  let ip = 0, count = 0;
  let returned: Uint8Array = new Uint8Array();
  const take = (size: number) => {
    assert(ip + size <= bytes.length, "program bounds");
    const result = bytes.slice(ip, ip + size); ip += size; return result;
  };
  const byte = () => take(1)[0];
  const uint = (size: number) => word(take(size), 0, size);
  const reg = () => { const index = byte(); assert(index < 16); return index; };
  const set = (dst: number, value: bigint) => {
    assert(dst > 0 && dst < 16, "Family must preserve r0");
    assert(value >= 0n && value <= ethers.MaxUint256, "checked uint256 math"); r[dst] = value;
  };
  assert(bytes.length > 1 && bytes.length <= 65536); assert.equal(byte(), 1);
  while (ip < bytes.length) {
    assert(++count <= 128);
    const op = byte();
    if (op === 0) {
      const dst = reg(); set(dst, uint(32));
    } else if (op === 1) {
      const target = ethers.hexlify(take(20)), mode = byte(), valueReg = byte();
      assert.equal(mode, 0, "V4 program emits ordinary calls");
      assert(valueReg === 255 || valueReg < 16);
      const incoming = Number(uint(3)), outgoing = Number(uint(3)), patchCount = byte();
      const patches = Array.from({ length: patchCount }, () => ({ offset: Number(uint(3)), reg: reg() }));
      const data = take(Number(uint(3))), template = data.slice();
      for (const { offset, reg: index } of patches) {
        assert(offset >= 4 && offset + 32 <= data.length, "32-byte patch bounds");
        data.set(ethers.getBytes(ethers.toBeHex(r[index], 32)), offset);
      }
      returned = ethers.getBytes(onCall({ target, data, template, valueReg,
        value: valueReg === 255 ? 0n : r[valueReg], incoming, outgoing, patches }));
    } else if (op === 2) {
      const kind = byte(), dst = reg(), a = r[reg()], b = r[reg()];
      switch (kind) {
        case 1: set(dst, a - b); break;
        case 4: assert(b < 256n); set(dst, a >> b); break;
        case 5: set(dst, a & b); break;
        case 6:
          assert(a < 1n << 255n, "runtime signed range");
          set(dst, BigInt.asUintN(256, -a)); break;
        default: assert.fail(`unexpected V4 math ${kind}`);
      }
    } else if (op === 3) {
      assert.equal(r[reg()], r[reg()], "runtime amount mismatch");
    } else if (op === 6) {
      const dst = reg(); set(dst, word(returned, Number(uint(3))));
    } else assert.fail(`unexpected V4 instruction ${op}`);
  }
  assert.equal(r[0], amount);
}

function unpackCallback(call: Call, amount: bigint): Uint8Array {
  assert.equal(call.target, manager); assert.equal(call.valueReg, 255); assert.equal(call.value, 0n);
  assert.equal(call.incoming, 68); assert.equal(call.outgoing, 68);
  assert.deepEqual(call.patches, [{ offset: 69, reg: 0 }]);
  assert.equal(ethers.hexlify(call.data.slice(0, 4)), "0x48c89491");
  assert.equal(word(call.data, 4), 32n);
  const script = ethers.getBytes(managerAbi.decodeFunctionData("unlock", call.data)[0]);
  assert.equal(word(call.data, 36), BigInt(script.length));
  assert.deepEqual(call.data.slice(68, 68 + script.length), script);
  assert.equal(call.data.length, 68 + Math.ceil(script.length / 32) * 32);
  assert(call.data.slice(68 + script.length).every(byte => byte === 0), "canonical ABI padding");
  assert.deepEqual(call.data.slice(0, 69), call.template.slice(0, 69));
  assert.deepEqual(call.data.slice(101), call.template.slice(101), "only the nested amount word changes");
  assert.equal(word(call.template, 69), 0n);

  // Independently pack the manager's callback ABI and check the declared inbound
  // offset selects exactly the outgoing script, including the terminal RETURN.
  const incoming = ethers.getBytes(managerAbi.encodeFunctionData("unlockCallback", [script]));
  assert.equal(word(incoming, call.incoming - 32), BigInt(script.length));
  assert.deepEqual(incoming.slice(call.incoming), call.data.slice(call.outgoing));
  assert.equal(script[0], 0x0e); assert.equal(word(script, 1), amount);
  const size = Number(word(script, 33, 3)), end = 36 + size;
  assert(size > 1); assert(end + 4 <= script.length);
  assert.equal(script[end], 0x03); assert.equal(word(script, end + 1, 3), 64n);
  const response = script.slice(end + 4);
  assert.equal(response.length, 64); assert.equal(word(response, 0), 32n); assert.equal(word(response, 32), 0n);
  assert.equal(abi.decode(["bytes"], response)[0], "0x");
  return script.slice(36, end);
}

function packedDelta(input: Input, inputDelta: bigint, outputDelta: bigint): string {
  const values = input.route.direction === "zero-for-one" ? [inputDelta, outputDelta] : [outputDelta, inputDelta];
  // Independent two's-complement packing: amount0 occupies the high int128.
  return ethers.concat(values.map(value => ethers.toBeHex(BigInt.asUintN(128, value), 16)));
}
interface ReplyOverrides { debt?: bigint; delta?: string; settled?: string }
function exercise(input: Input, amount: bigint, output: bigint, overrides: ReplyOverrides = {}, seen: string[] = []) {
  const leg = univ4Execution.buildRuntimeLeg(input);
  assert(leg); assert.equal(leg.actionAdapterId, "univ4-unlock");
  const { descriptor: d, route } = input, zero = route.direction === "zero-for-one";
  const debt = overrides.debt ?? amount;
  const outputReg = zero ? 4 : 5;
  const expected: { name: string; target: string; data: string; valueReg: number; value: bigint;
    patches: Call["patches"]; reply: string }[] = [];
  const add = (name: string, iface: ethers.Interface, target: string, args: readonly unknown[],
    patches: Call["patches"] = [], reply = "0x", valueReg = 255, value = 0n) => {
    expected.push({ name, target: address(target), data: iface.encodeFunctionData(name, args), patches, reply, valueReg, value });
  };
  const key = d.poolKey;
  add("swap", managerAbi, manager,
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      [zero, -amount, zero ? 4295128740n : 1461446703485210103287273052203988822378723970341n], "0x"],
    [{ offset: 196, reg: 7 }], overrides.delta ?? packedDelta(input, -debt, output));
  add("take", managerAbi, manager, [route.realTokenOut, executor, output], [{ offset: 68, reg: outputReg }]);
  if (route.realTokenIn === ethers.ZeroAddress) {
    add("sync", managerAbi, manager, [ethers.ZeroAddress]);
    add("settle", managerAbi, manager, [], [], overrides.settled ?? abi.encode(["uint256"], [debt]), 6, debt);
  } else {
    add("sync", managerAbi, manager, [route.realTokenIn]);
    add("transfer", tokenAbi, route.realTokenIn, [manager, debt], [{ offset: 36, reg: 6 }]);
    add("settle", managerAbi, manager, [], [], overrides.settled ?? abi.encode(["uint256"], [debt]));
  }
  let outerCalls = 0, innerCalls = 0;
  evaluate(ethers.getBytes(leg.program), amount, unlock => {
    assert.equal(++outerCalls, 1);
    evaluate(unpackCallback(unlock, amount), amount, call => {
      const e = expected[innerCalls++]; assert(e, "unexpected inner call"); seen.push(e.name);
      assert.equal(call.target, e.target); assert.equal(ethers.hexlify(call.data), e.data, e.name);
      assert.equal(call.incoming, 0); assert.equal(call.outgoing, 0, "inner calls cannot install extra callbacks");
      assert.equal(call.valueReg, e.valueReg); assert.equal(call.value, e.value, e.name);
      assert.deepEqual(call.patches, e.patches, e.name);
      for (const patch of call.patches) assert.equal(word(call.template, patch.offset), 0n, "amount placeholders are zero");
      return e.reply;
    });
    return abi.encode(["bytes"], ["0x"]);
  });
  assert.equal(outerCalls, 1); assert.equal(innerCalls, expected.length);
  return seen;
}

test("V4 runtime hook is wired and unsupported hook variants return null", () => {
  assert.equal(univ4Execution.buildRuntimeLeg, buildUniV4RuntimeLeg);
  for (const { input } of cases) {
    assert.equal(buildUniV4RuntimeLeg({ ...input, descriptor: { ...input.descriptor, hookPolicy: "fee-hook" } }), null);
    assert.equal(buildUniV4RuntimeLeg({ ...input, descriptor: { ...input.descriptor,
      poolKey: { ...input.descriptor.poolKey, hooks: other } } }), null);
  }
});

for (const { name, input } of cases) {
  test(`V4 ${name}: callback packet, signed swap, actual output and exact settlement`, () => {
    for (const [amount, output] of [[1n, 7n], [123456789n, 987654321n], [MAX_I128, MAX_I128]]) {
      const seen = exercise(input, amount, output);
      assert.deepEqual(seen, name === "native input" ? ["swap", "take", "sync", "settle"]
        : ["swap", "take", "sync", "transfer", "settle"]);
    }
  });
  test(`V4 ${name}: partial and zero fills pay and verify actual debt, not the cap`, () => {
    for (const amount of [1n, 100n, MAX_I128]) for (const debt of [0n, amount / 2n, amount - 1n]) {
      const seen = exercise(input, amount, 7n, { debt });
      assert.equal(seen[0], "swap"); assert.equal(seen.at(-1), "settle");
    }
  });
  test(`V4 ${name}: excessive debt, wrong signs and negative output stop before take/settle`, () => {
    for (const [debt, output] of [[-101n, 7n], [100n, 7n], [-(1n << 127n), 7n], [-100n, -1n], [-100n, -(1n << 127n)]]) {
      const seen: string[] = [];
      assert.throws(() => exercise(input, 100n, 7n, { delta: packedDelta(input, debt, output) }, seen), /runtime amount mismatch|checked uint256 math/);
      assert.deepEqual(seen, ["swap"]);
    }
  });
  test(`V4 ${name}: settlement credit cannot underpay, overpay or omit the return word`, () => {
    for (const settled of [0n, 29n, 31n, 100n]) {
      const seen: string[] = [];
      assert.throws(() => exercise(input, 100n, 7n,
        { debt: 30n, settled: abi.encode(["uint256"], [settled]) }, seen), /runtime amount mismatch/);
      assert.equal(seen.at(-1), "settle");
    }
    for (const settled of [0n, 99n, 101n, ethers.MaxUint256]) {
      const seen: string[] = [];
      assert.throws(() => exercise(input, 100n, 7n, { settled: abi.encode(["uint256"], [settled]) }, seen), /runtime amount mismatch/);
      assert.equal(seen.at(-1), "settle");
    }
    for (const data of ["0x", `0x${"00".repeat(31)}`]) {
      assert.throws(() => exercise(input, 100n, 7n, { delta: data }), /return\/header word bounds/);
      assert.throws(() => exercise(input, 100n, 7n, { settled: data }), /return\/header word bounds/);
    }
  });
}

test("V4 rejects amounts outside its supported int128 range before swap", () => {
  for (const { input } of cases) for (const amount of [1n << 127n, (1n << 128n) + 100n, (1n << 255n) - 1n]) {
    const seen: string[] = [];
    assert.throws(() => exercise(input, amount, 7n, {}, seen), /runtime amount mismatch/);
    assert.deepEqual(seen, []);
  }
  // The same range check rejects the signed int256 boundary before swap.
  const input = fixture(false, false), leg = buildUniV4RuntimeLeg(input); assert(leg);
  evaluate(ethers.getBytes(leg.program), 1n << 255n, call => {
    const inner = unpackCallback(call, 1n << 255n);
    assert.throws(() => evaluate(inner, 1n << 255n, () => assert.fail("signed overflow reached swap")), /runtime amount mismatch/);
    return abi.encode(["bytes"], ["0x"]);
  });
});

test("V4 binds pool, manager, key, direction and graph/real currencies before encoding", () => {
  for (const { input } of cases) {
    const r = input.route;
    const badRoutes: UniV4Route[] = [
      { ...r, instanceKey: instanceKey("foreign") }, { ...r, poolId: codeHash }, { ...r, manager: other },
      { ...r, poolKey: { ...r.poolKey, fee: r.poolKey.fee + 1 } },
      { ...r, direction: r.direction === "zero-for-one" ? "one-for-zero" : "zero-for-one" },
      { ...r, tokenIn: r.tokenOut }, { ...r, tokenOut: r.tokenIn },
      { ...r, realTokenIn: other }, { ...r, realTokenOut: other },
      { ...r, executionAssets: undefined },
      { ...r, executionAssets: { input: "native", output: "native" } },
    ];
    for (const route of badRoutes) assert.throws(() => buildUniV4RuntimeLeg({ ...input, route }), /route/);
  }
});

test("V4 declares raw native sides; the issuer adds one boundary outside unlock", () => {
  for (const { input } of cases) {
    const { route } = input;
    assert.deepEqual(route.executionAssets, {
      input: route.realTokenIn === ethers.ZeroAddress ? "native" : "erc20",
      output: route.realTokenOut === ethers.ZeroAddress ? "native" : "erc20",
    });
    const leg = buildUniV4RuntimeLeg(input); assert(leg);
    const issued = applyRuntimeAssetBoundary({ route, executor, leg });
    if (route.realTokenIn === ethers.ZeroAddress || route.realTokenOut === ethers.ZeroAddress)
      assert.notEqual(issued.program, leg.program);
    else assert.equal(issued, leg);
    assert.throws(() => buildUniV4RuntimeLeg({ ...input, executor: manager }), /executor/);
  }
});
