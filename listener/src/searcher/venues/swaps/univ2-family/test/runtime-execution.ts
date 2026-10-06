import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { RuntimeAmountLeg } from "../../../../../adapters/runtime-amount-program.js";
import { encodeRuntimeAmountNode, RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { univ3Adapter } from "../../../../../adapters/univ3.js";
import { MAX_SQRT_RATIO, MIN_SQRT_RATIO } from "../../../../solver/v3-math.js";
import { quoteV2ExactInput } from "../../../../solver/v2-constant-product-math.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { UNIV2_PAIR_INTERFACE } from "../../univ2-abi.js";
import { UNIV3_POOL_INTERFACE } from "../../univ3-abi.js";
import { univ2Execution } from "../execution.js";
import { UNIV2_FACTORY_LINEAGE_ID, UNIV2_FAMILY_ID } from "../manifest.js";
import { univ2Routes } from "../routes.js";
import type { UniV2Descriptor } from "../types.js";
import { univ3Execution } from "../../univ3-family/execution.js";
import { UNIV3_FACTORY_LINEAGE_ID, UNIV3_FAMILY_ID } from "../../univ3-family/manifest.js";
import { univ3Routes } from "../../univ3-family/routes.js";
import type { UniV3Descriptor } from "../../univ3-family/types.js";
import { MOONISWAP_ACTION, MOONISWAP_ID, MOONISWAP_LINEAGE, POOL } from "../../mooniswap-family/codec.js";
import { mooniswapExecution } from "../../mooniswap-family/execution.js";
import { mooniswapRoutes } from "../../mooniswap-family/routes.js";
import type { MooniswapDescriptor } from "../../mooniswap-family/types.js";

const token0 = `0x${"11".repeat(20)}`, token1 = `0x${"22".repeat(20)}`;
const pool = `0x${"33".repeat(20)}`, factory = `0x${"44".repeat(20)}`, executor = `0x${"55".repeat(20)}`;
const erc20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256)"]);
const abi = ethers.AbiCoder.defaultAbiCoder();
const base = { pool, token0, token1, instanceKey: instanceKey(pool), provenance: [], runtimeRequirements: [] };
const v2: UniV2Descriptor = { ...base, familyId: UNIV2_FAMILY_ID, lineageId: UNIV2_FACTORY_LINEAGE_ID,
  quoteModel: { kind: "constant-product" }, feeRule: { kind: "constant-bps", feeBps: 30n, evidence: "standard-v2-default" },
  factoryBinding: { factory, reversePool: pool } };
const v3: UniV3Descriptor = { ...base, familyId: UNIV3_FAMILY_ID, lineageId: UNIV3_FACTORY_LINEAGE_ID,
  fee: 3000n, tickSpacing: 60, factoryBinding: { factory, reversePool: pool },
  quoterBinding: { quoter: null, router: null, provenance: "unavailable" },
  swapAccess: { kind: "no-is-swapper-getter", codeHash: `0x${"66".repeat(32)}` } };
const moon: MooniswapDescriptor = { ...base, familyId: MOONISWAP_ID, lineageId: MOONISWAP_LINEAGE, codeHash: `0x${"77".repeat(32)}` };

interface Call {
  target: string;
  data: string;
  template: string;
  static: boolean;
  incoming: number;
  outgoing: number;
  patches: { offset: number; reg: number }[];
}
interface Allowance { token: string; spender: string; minimum: bigint; grant: bigint }

// Decode emitted programs using synthetic return words. This tests Family math
// and ABI patches only; it is not an EVM/fork or callback-authentication receipt.
function run(leg: RuntimeAmountLeg | null, amount: bigint, onCall: (call: Call) => string,
  onAllowance: (allowance: Allowance) => void = () => assert.fail("unexpected allowance"), calldata = "0x") {
  assert(leg);
  const bytes = ethers.getBytes(leg.program), registers = Array<bigint>(16).fill(0n);
  registers[0] = amount;
  let ip = 0;
  let returned: Uint8Array = new Uint8Array();
  const take = (size: number) => {
    assert(ip + size <= bytes.length, "instruction bounds");
    const value = bytes.slice(ip, ip + size); ip += size; return value;
  };
  const byte = () => take(1)[0];
  const uint = (size: number) => BigInt(ethers.hexlify(take(size)));
  const reg = () => { const r = byte(); assert(r < 16); return r; };
  const set = (dst: number, value: bigint) => {
    assert(dst > 0 && dst < 16, "r0 must remain the original actual input");
    assert(value >= 0n && value <= ethers.MaxUint256, "checked uint256 math"); registers[dst] = value;
  };
  assert.equal(byte(), 1);
  while (ip < bytes.length) {
    const op = byte();
    if (op === 0) {
      const dst = reg(); set(dst, uint(32));
    } else if (op === 1) {
      const target = ethers.hexlify(take(20)), mode = byte(), valueReg = byte();
      assert(mode <= 1); assert.equal(valueReg, 255, "ERC20-only programs send no native value");
      const incoming = Number(uint(3)), outgoing = Number(uint(3)), count = byte();
      const patches = Array.from({ length: count }, () => ({ offset: Number(uint(3)), reg: reg() }));
      const data = take(Number(uint(3))), template = ethers.hexlify(data);
      for (const patch of patches) {
        assert(patch.offset >= 4 && patch.offset + 32 <= data.length);
        data.set(ethers.getBytes(ethers.toBeHex(registers[patch.reg], 32)), patch.offset);
      }
      returned = ethers.getBytes(onCall({ target, data: ethers.hexlify(data), template,
        static: mode === 1, incoming, outgoing, patches }));
    } else if (op === 2) {
      const kind = byte(), dst = reg(), a = registers[reg()], b = registers[reg()];
      switch (kind) {
        case 0: set(dst, a + b); break;
        case 1: set(dst, a - b); break;
        case 2: set(dst, a * b); break;
        case 3: set(dst, a / b); break;
        case 4: assert(b < 256n); set(dst, a >> b); break;
        default: assert.fail(`unexpected Family math ${kind}`);
      }
    } else if (op === 3) {
      assert.equal(registers[reg()], registers[reg()], "runtime amount mismatch");
    } else if (op === 4) {
      const token = ethers.hexlify(take(20)), spender = ethers.hexlify(take(20));
      onAllowance({ token, spender, minimum: registers[reg()], grant: uint(32) });
    } else if (op === 6) {
      const dst = reg(), offset = Number(uint(3));
      assert(offset + 32 <= returned.length, "return word bounds");
      set(dst, BigInt(ethers.hexlify(returned.slice(offset, offset + 32))));
    } else if (op === 7) {
      const dst = reg(), offset = Number(uint(3)), input = ethers.getBytes(calldata);
      assert(offset + 32 <= input.length, "calldata word bounds");
      set(dst, BigInt(ethers.hexlify(input.slice(offset, offset + 32))));
    } else assert.fail(`unexpected Family opcode ${op}`);
  }
  assert.equal(registers[0], amount);
}

test("V2 runtime patches the nominal debit but prices the actual pair credit in both directions", () => {
  const reserves = [(1n << 80n) + 13n, (1n << 75n) + 37n];
  for (const feeBps of [0n, 25n, 30n, 9999n]) {
    const descriptor = { ...v2, feeRule: { ...v2.feeRule, feeBps } };
    for (const route of univ2Routes.project({ descriptor })) for (const amount of [1n, 1000n, 10n ** 20n]) {
      for (const taxBps of [0n, 100n, 2500n]) {
        const zeroForOne = route.direction === "zero-for-one", received = amount * (10_000n - taxBps) / 10_000n;
        const reserveIn = reserves[zeroForOne ? 0 : 1], reserveOut = reserves[zeroForOne ? 1 : 0];
        // Preexisting pair inventory must not masquerade as this transfer's receipt.
        const before = reserveIn + 123_456n;
        const leg = univ2Execution.buildRuntimeLeg({ descriptor, route, executor, runtimeEvidence: [] });
        assert.equal(leg?.actionAdapterId, "univ2-swap");
        let step = 0;
        run(leg, amount, call => {
          assert.equal(call.incoming, 0); assert.equal(call.outgoing, 0);
          switch (step++) {
            case 0:
              assert.equal(call.target, pool); assert(call.static); assert.equal(call.patches.length, 0);
              assert.equal(call.data, UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves", []));
              return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [...reserves, 123]);
            case 1: case 3:
              assert.equal(call.target, route.tokenIn); assert(call.static); assert.equal(call.patches.length, 0);
              assert.deepEqual([...erc20.decodeFunctionData("balanceOf", call.data)], [pool]);
              return abi.encode(["uint256"], [step === 2 ? before : before + received]);
            case 2:
              assert.equal(call.target, route.tokenIn); assert(!call.static);
              assert.deepEqual(call.patches, [{ offset: 36, reg: 0 }]);
              assert.deepEqual([...erc20.decodeFunctionData("transfer", call.data)], [pool, amount]);
              return "0x"; // valid no-return ERC20, no fabricated bool
            case 4: {
              assert.equal(call.target, pool); assert(!call.static);
              const out = quoteV2ExactInput(reserveIn, reserveOut, received, feeBps);
              assert.deepEqual([...UNIV2_PAIR_INTERFACE.decodeFunctionData("swap", call.data)],
                [zeroForOne ? 0n : out, zeroForOne ? out : 0n, executor, "0x"]);
              assert.deepEqual(call.patches, [{ offset: zeroForOne ? 36 : 4, reg: 6 }]);
              return "0x";
            }
            default: assert.fail("unexpected V2 call");
          }
        });
        assert.equal(step, 5);
      }
    }
  }
});

test("V2 explicitly declines pool-get-amount-out and rejects incompatible routes/fees", () => {
  const descriptor: UniV2Descriptor = { ...v2, quoteModel: { kind: "pool-get-amount-out", probe0: 1n, probe1: 1n },
    feeRule: { kind: "included-in-pool-quote", feeBps: 0n, evidence: "pool-quote" } };
  for (const route of univ2Routes.project({ descriptor })) {
    assert.equal(univ2Execution.buildRuntimeLeg({ descriptor, route, executor, runtimeEvidence: [] }), null);
  }
  const route = univ2Routes.project({ descriptor: v2 })[0], input = { descriptor: v2, route, executor, runtimeEvidence: [] };
  for (const bad of [{ ...route, pool: factory }, { ...route, tokenIn: token1 }, { ...route, tokenOut: token0 },
    { ...route, direction: "one-for-zero" as const }, { ...route, feeBps: 25n }, { ...route, familyId: UNIV3_FAMILY_ID },
    { ...route, instanceKey: instanceKey(factory) }, { ...route, bindingRef: { ...route.bindingRef, fingerprint: "foreign" } }]) {
    assert.throws(() => univ2Execution.buildRuntimeLeg({ ...input, route: bad }), /binding/);
  }
  for (const feeBps of [-1n, 10_000n]) {
    const d = { ...v2, feeRule: { ...v2.feeRule, feeBps } };
    assert.throws(() => univ2Execution.buildRuntimeLeg({ ...input, descriptor: d, route: univ2Routes.project({ descriptor: d })[0] }), /fee/);
  }
  assert.throws(() => univ2Execution.buildRuntimeLeg({ ...input, executor: pool }), /addresses/);
});

test("V3 declares callback debt while shared settlement pays only that debt in both directions", () => {
  for (const route of univ3Routes.project({ descriptor: v3 })) {
    const amountIn = 100n, amountOut = 7n;
    const leg = univ3Execution.buildRuntimeLeg({ descriptor: v3, route, executor, runtimeEvidence: [] });
    const fragment = univ3Execution.buildFragment({ descriptor: v3, route, executor, runtimeEvidence: [],
      amountIn, quotedAmountOut: amountOut, minAmountOut: 0n,
      exactEvidence: { kind: "univ3-local-ticks",
        source: { number: 20000000, hash: `0x${"aa".repeat(32)}`, generation: 1 },
        pool, quoter: null, caller: executor, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
        fee: v3.fee, amountIn, amountOut, sqrtPriceX96After: 1n << 96n,
        initializedTicksCrossed: 0, gasEstimate: 0n },
    });
    assert.equal(fragment.nodes.length, 1);
    assert.deepEqual(univ3Adapter.encode(fragment.nodes[0], executor, new Uint8Array()),
      runtimeProgramScript(ethers.getBytes(leg.program), amountIn),
      "quoted V3 construction must share the runtime actual-debt program");
  }
});

test("runtime program node is bounded and cannot hide legacy callback children", () => {
  const node = { adapterId: "univ3-swap", target: pool, tokenIn: token0, tokenOut: token1,
    amount: 100n, params: { runtimeAmountProgram: ethers.hexlify(new RuntimeAmountProgram().constant(1, 7n).bytes()) }, children: [] };
  assert.deepEqual(encodeRuntimeAmountNode(node, new Uint8Array()),
    runtimeProgramScript(ethers.getBytes(node.params.runtimeAmountProgram), node.amount));
  assert.equal(encodeRuntimeAmountNode({ ...node, params: {} }, new Uint8Array()), null,
    "legacy capture actions keep their existing encoder");
  for (const program of [true, "0x", "0x01", "0x010", "0x02ff", "not-hex", "0x01" + "00".repeat(65536)]) {
    assert.throws(() => encodeRuntimeAmountNode({ ...node, params: { runtimeAmountProgram: program } }, new Uint8Array()), /node shape/);
  }
  for (const amount of [0n, -1n, ethers.MaxUint256 + 1n]) {
    assert.throws(() => encodeRuntimeAmountNode({ ...node, amount }, new Uint8Array()), /node shape/);
  }
  assert.throws(() => encodeRuntimeAmountNode({ ...node, children: [node] }, new Uint8Array()), /node shape/);
  assert.throws(() => encodeRuntimeAmountNode(node, new Uint8Array([1])), /node shape/);
});

test("V3 runtime callback pays actual debt in both directions", () => {
  for (const route of univ3Routes.project({ descriptor: v3 })) for (const amount of [1n, 123456789n, (1n << 255n) - 1n]) {
    const leg = univ3Execution.buildRuntimeLeg({ descriptor: v3, route, executor, runtimeEvidence: [] });
    assert.equal(leg.actionAdapterId, "univ3-swap");
    for (const debt of [0n, amount / 2n, amount]) {
    let calls = 0;
    run(leg, amount, call => {
      calls++; assert.equal(call.target, pool); assert(!call.static);
      assert.equal(call.incoming, 132); assert.equal(call.outgoing, 196);
      assert.deepEqual(call.patches, [{ offset: 68, reg: 0 }, { offset: 197, reg: 0 }]);
      const zeroForOne = route.direction === "zero-for-one";
      const decoded = UNIV3_POOL_INTERFACE.decodeFunctionData("swap", call.data);
      assert.deepEqual([...decoded].slice(0, 4), [executor, zeroForOne, amount, zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n]);
      const script = ethers.getBytes(decoded[4]);
      assert.equal(script[0], 14);
      assert.equal(BigInt(ethers.hexlify(script.slice(1, 33))), amount);
      assert.equal(Number(BigInt(ethers.hexlify(script.slice(33, 36)))), script.length - 36);
      const args = zeroForOne ? [debt, -7n, decoded[4]] : [-7n, debt, decoded[4]];
      const callbackData = ethers.id("uniswapV3SwapCallback(int256,int256,bytes)").slice(0, 10) + abi.encode(["int256", "int256", "bytes"], args).slice(2);
      let payments = 0;
      run({ actionAdapterId: "callback", program: ethers.hexlify(script.slice(36)) }, amount, payment => {
        payments++; assert.equal(payment.target, route.tokenIn); assert(!payment.static);
        assert.equal(payment.incoming, 0);
        assert.deepEqual([...erc20.decodeFunctionData("transfer", payment.data)], [pool, debt]);
        return "0x";
      }, undefined, callbackData);
      assert.equal(payments, 1);
      const dummy = UNIV3_POOL_INTERFACE.decodeFunctionData("swap", call.template);
      assert.equal(dummy[2], 0n);
      assert.equal(BigInt(ethers.hexlify(ethers.getBytes(dummy[4]).slice(1, 33))), 0n);
      return abi.encode(["int256", "int256"], zeroForOne ? [debt, -7n] : [-7n, debt]);
    });
    assert.equal(calls, 1);
    }
  }
});

test("V3 and shared settlement reject debt above cap, negative debt, malformed data and signed overflow", () => {
  for (const route of univ3Routes.project({ descriptor: v3 })) {
    const leg = univ3Execution.buildRuntimeLeg({ descriptor: v3, route, executor, runtimeEvidence: [] });
    for (const debt of [101n, -100n]) {
      assert.throws(() => run(leg, 100n, () => abi.encode(["int256", "int256"],
        route.direction === "zero-for-one" ? [debt, -7n] : [-7n, debt])), /checked uint256 math/);
      assert.throws(() => run(leg, 100n, call => {
        const script = ethers.getBytes(UNIV3_POOL_INTERFACE.decodeFunctionData("swap", call.data)[4]);
        const deltas = route.direction === "zero-for-one" ? [debt, -7n] : [-7n, debt];
        const callbackData = "0x12345678" + abi.encode(["int256", "int256"], deltas).slice(2);
        run({ actionAdapterId: "callback", program: ethers.hexlify(script.slice(36)) }, 100n,
          () => assert.fail("invalid debt reached transfer"), undefined, callbackData);
        return "0x";
      }), /checked uint256 math/);
    }
    assert.throws(() => run(leg, 100n, () => "0x"), /return word bounds/);
    assert.throws(() => run(leg, 1n << 255n, () => assert.fail("overflow reached swap")), /runtime amount mismatch/);
    assert.throws(() => univ3Execution.buildRuntimeLeg({ descriptor: v3, route: { ...route, tokenIn: route.tokenOut }, executor, runtimeEvidence: [] }), /binding/);
    assert.throws(() => univ3Execution.buildRuntimeLeg({ descriptor: v3, route: { ...route, fee: 500n }, executor, runtimeEvidence: [] }), /binding/);
    assert.throws(() => univ3Execution.buildRuntimeLeg({ descriptor: v3, route: { ...route, bindingRef: { ...route.bindingRef, fingerprint: "foreign" } }, executor, runtimeEvidence: [] }), /binding/);
  }
});

test("Mooniswap keeps Family allowance policy and swaps the actual input in both directions", () => {
  for (const route of mooniswapRoutes.project({ descriptor: moon })) for (const amount of [1n, 123456789n, ethers.MaxUint256]) {
    const leg = mooniswapExecution.buildRuntimeLeg({ descriptor: moon, route, executor, runtimeEvidence: [] });
    assert.equal(leg?.actionAdapterId, MOONISWAP_ACTION);
    let allowances = 0, calls = 0;
    run(leg, amount, call => {
      assert.equal(allowances, 1); calls++;
      assert.equal(call.target, pool); assert(!call.static); assert.equal(call.incoming, 0); assert.equal(call.outgoing, 0);
      assert.deepEqual(call.patches, [{ offset: 68, reg: 0 }]);
      assert.equal(POOL.decodeFunctionData("swapFor", call.template)[2], 0n);
      assert.deepEqual([...POOL.decodeFunctionData("swapFor", call.data)], [route.tokenIn, route.tokenOut, amount, 1n, ethers.ZeroAddress, executor]);
      return abi.encode(["uint256"], [7n]);
    }, allowance => {
      allowances++; assert.equal(calls, 0);
      assert.deepEqual(allowance, { token: route.tokenIn, spender: pool, minimum: amount, grant: ethers.MaxUint256 });
    });
    assert.equal(allowances, 1); assert.equal(calls, 1);
  }
});

test("Mooniswap native variants are explicit null; incompatible ERC20 route bindings reject", () => {
  const route = mooniswapRoutes.project({ descriptor: moon })[0], input = { descriptor: moon, route, executor, runtimeEvidence: [] };
  for (const token of ["tokenIn", "tokenOut"] as const) {
    assert.equal(mooniswapExecution.buildRuntimeLeg({ ...input, route: { ...route, [token]: ethers.ZeroAddress } }), null);
  }
  assert.equal(mooniswapExecution.buildRuntimeLeg({ ...input, descriptor: { ...moon, token0: ethers.ZeroAddress } }), null);
  assert.throws(() => mooniswapExecution.buildRuntimeLeg({ ...input, route: { ...route, pool: factory } }), /binding/);
  assert.throws(() => mooniswapExecution.buildRuntimeLeg({ ...input, route: { ...route, tokenOut: token0 } }), /binding/);
  assert.throws(() => mooniswapExecution.buildRuntimeLeg({ ...input, route: { ...route, bindingRef: { ...route.bindingRef, fingerprint: "foreign" } } }), /binding/);
  assert.throws(() => mooniswapExecution.buildRuntimeLeg({ ...input, executor: pool }), /equals pool/);
  assert.throws(() => mooniswapExecution.buildRuntimeLeg({ ...input, executor: ethers.ZeroAddress }), /zero/);
});
