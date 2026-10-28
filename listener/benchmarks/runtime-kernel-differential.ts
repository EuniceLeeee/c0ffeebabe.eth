/** Offline differential safety tests, using task-owned loopback Anvil only.
 * Covers both legacy scripts and runtime programs. No private key or chain
 * endpoint is used. Gas is deliberately not an equality condition. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { ethers } from "ethers";
import "../src/adapters/index.js";
import { RuntimeAmountProgram as P, runtimeProgramScript, runtimeCallSequenceScript, runtimeCallbackPayment, runtimeDeferredPayment, runtimeDeferredOpeningFloor, withRuntimeHopContext, type RuntimeSettlementRequest } from "../src/adapters/runtime-amount-program.js";
import { compilePlan } from "../src/compiler.js";
import { buildRuntimeSettlementRoot } from "../src/searcher/simulator/runtime-settlement.js";

const owner = "0xb8578b6de173c8554ff0390db5a7effa567dda3c", executor = "0xd1e500860893b64ba12b7b6afddb131b5c75a657";
const root = resolve(process.argv[2]!), huffFile = resolve(process.argv[3]!), out = resolve(process.argv[4]!);
const fixture = (n: number) => ethers.getAddress(`0x${(0x10000000n + BigInt(n)).toString(16).padStart(40, "0")}`);
const a = fixture(1), b = fixture(2), pool = fixture(3), cb = fixture(4), debt = fixture(5), allowanceToken = fixture(6), deferred = fixture(7);
const native = fixture(8), failureTarget = fixture(9), bubbleCallback = fixture(10), weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const echoTarget = fixture(11), echoAbi = new ethers.Interface(["function echo(int256) returns(int256)"]);
const diagnosticKeySlot = ethers.id("BotVM.runtime.hop.diagnostic.key.v1"), diagnosticKey = ethers.id("local differential diagnostic key");
const diagnosticAbi = new ethers.Interface(["error RuntimeHopFailed(uint256 hop,address target,bytes32 flowHash,bytes reason,bytes32 proof)"]);
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const artifact = (name: string, source = "BotVMRuntimeAmount.t.sol") => json(resolve(root, "out", source, `${name}.json`));
function code(artifact: any) {
  const bytes = ethers.getBytes(artifact.deployedBytecode.object);
  for (const refs of Object.values<any>(artifact.deployedBytecode.immutableReferences ?? {})) for (const ref of refs)
    bytes.set(ethers.getBytes(ethers.zeroPadValue(owner, 32)), ref.start);
  return ethers.hexlify(bytes);
}
const hex = readFileSync(huffFile, "utf8").trim();
const candidate = process.argv[5] ? json(resolve(process.argv[5])) : artifact("BotVM", "BotVM.sol");
const versions = [{ name: "solidity-yul", code: code(candidate) },
  { name: "huff", code: hex.startsWith("0x") ? hex : `0x${hex}` }];
const abi = new ethers.Interface(["function execute(bytes)", "function execSubscript(bytes)", "function sweep(address)", "function owner() view returns(address)"]);
const erc = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"]);
const call = new ethers.Interface(["function run(bytes)"]);
const debtAbi = new ethers.Interface(["function run(int256,bytes)"]);
const tokenSlot = (who: string) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [who, 0]));
const pscript = (p: P | string, amount = 20n) => ethers.hexlify(runtimeProgramScript(typeof p === "string" ? ethers.getBytes(p) : p.bytes(), amount));
const allowanceSlot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [pool, tokenSlot(executor)]));
type Case = { name: string; script: string; expected: boolean; callbackFlags?: bigint; caller?: string; debtPaid?: bigint; allowanceMode?: bigint;
  entry?: "execute" | "execSubscript" | "sweep"; nativeBalance?: bigint;
  data?: string; value?: bigint; returnData?: string; wethBalance?: bigint;
  diagnosticKey?: string; expectedRevertData?: string; noHopEnvelope?: true;
  diagnostic?: { flow: string; hop: bigint; target: string; reason?: string } };
const cases: Case[] = [];
const add = (name: string, p: P | string, expected = true, extra: Partial<Case> = {}) => cases.push({ name, script: pscript(p), expected, ...extra });
for (let n = 1n; n <= 64n; ++n) {
  add(`checked-math-${n}`, new P().constant(1, n).math("mul", 2, 0, 1).math("div", 2, 2, 1).equal(2, 0)
    .math("add", 3, 0, 1).math("sub", 3, 3, 1).equal(3, 0).constant(4, 1n).math("shr", 5, 0, 4)
    .constant(6, 10n).equal(5, 6).math("neg", 7, 1).constant(8, BigInt.asUintN(256, -n)).equal(7, 8));
}
add("add-overflow", new P().constant(1, ethers.MaxUint256).math("add", 2, 1, 0), false);
add("multiply-overflow-even", new P().constant(1, 1n << 255n).math("mul", 2, 1, 0), false);
add("subtract-underflow", new P().constant(1, 21n).math("sub", 2, 0, 1), false);
add("divide-zero", new P().constant(1, 0n).math("div", 2, 0, 1), false);
add("invalid-shift", new P().constant(1, 256n).math("shr", 2, 0, 1), false);
add("signed-range", new P().constant(1, 1n << 255n).math("neg", 2, 1), false);
add("equality-reject", new P().constant(1, 0n).equal(0, 1), false);
add("register-bounds", "0x010010" + "00".repeat(32), false);
add("return-bounds", new P().load(1, 0), false);
add("calldata-bounds", new P().calldata(1, 0xfffffe), false);
add("native-balance", new P().nativeBalance(1).constant(2, 0n).equal(1, 2));
add("static-token-balance", new P().call(a, erc.encodeFunctionData("balanceOf", [executor]), { static: true }).load(1, 0)
  .constant(2, 100n).equal(1, 2));
add("actual-transfer", new P().call(a, erc.encodeFunctionData("transfer", [pool, 0n]), { patches: [{ offset: 36, reg: 0 }] }));
add("external-revert", new P().call(a, erc.encodeFunctionData("transfer", [pool, 1000n])), false);
add("no-code-target", new P().call(fixture(99), "0x12345678"), false);
let nested: P = new P().constant(1, 1n);
for (let d = 0; d < 8; ++d) nested = new P().run(nested.bytes());
add("depth-eight", nested); add("depth-nine", new P().run(nested.bytes()), false);
const transfer = new P().call(a, erc.encodeFunctionData("transfer", [pool, 0n]), { patches: [{ offset: 36, reg: 0 }] });
add("readonly-static", new P().run(new P().call(a, erc.encodeFunctionData("balanceOf", [executor]), { static: true }).load(0, 0).bytes(), 0, 2, true)
  .constant(3, 100n).equal(2, 3));
add("readonly-transitive-call", new P().run(new P().run(transfer.bytes()).bytes(), 0, 1, true), false);
add("readonly-allowance", new P().run(new P().allowance(a, pool).bytes(), 0, 1, true), false);
add("nested-local-registers", new P().constant(1, 33n).run(new P().constant(1, 4n).math("add", 0, 0, 1).bytes(), 0, 2)
  .constant(3, 24n).equal(2, 3).constant(3, 33n).equal(1, 3));
add("registers-initially-zero", new P().constant(0, 0n).equal(0, 1).equal(0, 15));
add("nested-registers-initially-zero", new P().constant(15, 33n).run(new P().constant(0, 0n).equal(0, 15).bytes()));
add("atomic-rollback", new P().call(a, erc.encodeFunctionData("transfer", [pool, 20n])).run("0x0108"), false);
for (const flags of [0n, 1n, 256n, 65536n]) {
  const child = pscript(new P().constant(1, 1n));
  add(`callback-auth-${flags}`, new P().call(cb, call.encodeFunctionData("run", [child]),
    { callback: { incomingOffset: 68, outgoingOffset: 68 } }), flags === 0n, { callbackFlags: flags });
}
for (const owed of [0n, 1n, 19n, 20n, 21n, -1n]) {
  const payment = runtimeCallbackPayment(a, debt, 4);
  add(`callback-debt-${owed}`, new P().call(debt, debtAbi.encodeFunctionData("run", [owed, payment.script]),
    { callback: { incomingOffset: 100, outgoingOffset: 100 }, patches: [{ offset: 101, reg: 0 }] }),
    owed >= 0n && owed <= 20n, { debtPaid: owed >= 0n && owed <= 20n ? owed : 0n });
}
add("unauthorized-owner", new P().constant(1, 1n), false, { caller: fixture(88) });
for (let mode = 0n; mode <= 5n; ++mode)
  add(`runtime-allowance-mode-${mode}`, new P().allowance(allowanceToken, pool, 0, 40n),
    [0n, 1n, 4n].includes(mode), { allowanceMode: mode });
add("runtime-allowance-insufficient-grant", new P().allowance(allowanceToken, pool, 0, 19n), false);
const staticCall = ethers.getBytes(new P().call(a, erc.encodeFunctionData("balanceOf", [executor]), { static: true }).bytes());
staticCall[23] = 0; // value register must be 255 in static mode, even if r0 were zero.
add("static-value-register-forbidden", ethers.hexlify(staticCall), false);
const staticCallback = ethers.getBytes(new P().call(a, erc.encodeFunctionData("balanceOf", [executor]), { static: true }).bytes());
staticCallback[26] = 68;
add("static-callback-forbidden", ethers.hexlify(staticCallback), false);
for (const p of ["0x", "0x01", "0x02ff", "0x0108", "0x0108000002000002", "0x0108000000000002", "0x0107"])
  cases.push({ name: `malformed-${p}`, script: ethers.hexlify(runtimeProgramScript(ethers.getBytes(p), 20n)), expected: false });
const tooMany = "0x01" + "030000".repeat(129); add("instruction-limit", tooMany, false);

// Actual generic production composition, including old-inventory and debt
// guards. These mocks are fixtures, not new Family admission evidence.
const swapTo = new ethers.Interface(["function swapTo(address,address,uint256,uint256,uint256,address)"]);
const open = new ethers.Interface(["function open(address,address,uint256,uint256,bytes)"]);
for (const directDebt of [false, true]) for (const c of [
  { name: "success", released: 22n, credit: 30n, debt: 30n, extra: 0n, floor: 2n, expected: true },
  { name: "minimum-profit", released: 22n, credit: 30n, debt: 30n, extra: 0n, floor: 3n, expected: false },
  { name: "opening-inventory-subsidy", released: 19n, credit: 30n, debt: 30n, extra: 0n, floor: 1n, expected: false },
  { name: "prefix-overspend", released: 22n, credit: 30n, debt: 30n, extra: 1n, floor: 1n, expected: false },
  { name: "recipient-undercredit", released: 22n, credit: 29n, debt: 30n, extra: 0n, floor: 1n, expected: false },
  { name: "debt-above-cap", released: 22n, credit: 30n, debt: 31n, extra: 0n, floor: 1n, expected: false },
  { name: "unspent-route-inventory", released: 22n, credit: 30n, debt: 30n, extra: 0n, floor: 1n, expected: false, stray: true },
]) {
  const emit = (index: number, request?: RuntimeSettlementRequest) => {
    const p = new P();
    if (index === 0) {
      if (request?.kind === "quote-output") p.constant(0, 30n);
      else {
        const fixed = request?.kind === "settle-output";
        if (fixed) p.constant(1, request.amountIn);
        p.call(pool, swapTo.encodeFunctionData("swapTo", [a, b, 0n, c.credit, c.extra,
          request?.kind === "direct-output" || fixed ? request.recipient : executor]),
          { patches: [{ offset: 68, reg: fixed ? 1 : 0 }] });
        if (c.stray) p.call(b, new ethers.Interface(["function mint(address,uint256)"]).encodeFunctionData("mint", [executor, 1n]));
      }
    } else if (request?.kind === "deferred-input") {
      const pay = runtimeDeferredPayment({ tokenOut: a, executor, debtOffset: 4, ...request });
      runtimeDeferredOpeningFloor(p, a, executor, request.paymentAmount);
      const outgoing = 196;
      p.call(deferred, open.encodeFunctionData("open", [b, a, c.released, c.debt, pay.script]),
        { patches: [{ offset: outgoing + pay.limitOffset, reg: 0 }, { offset: outgoing + pay.floorOffset, reg: 13 }],
          callback: { incomingOffset: 100, outgoingOffset: outgoing } });
    } else p.constant(1, 1n);
    return { actionAdapterId: "fixture", tokenIn: index === 0 ? a : b, tokenOut: index === 0 ? b : a,
      program: ethers.hexlify(p.bytes()), settlement: index === 0 ? { quoteOutput: true as const, directOutput: true as const,
        ...(directDebt ? { settleOutput: true as const } : {}) } : { deferredInput: deferred, deferredDebtInput: true as const },
      ...(request ? { settlementRequest: request } : {}) };
  };
  const root = buildRuntimeSettlementRoot({ legs: [emit(0), emit(1)], amount: 20n, minimumProfit: c.floor, executor, build: emit });
  assert(root);
  cases.push({ name: `production-settlement-${directDebt ? "debt" : "measured"}-${c.name}`, script: ethers.hexlify(compilePlan(root, executor)), expected: c.expected });
}

const pack = (types: string[], values: any[]) => ethers.solidityPacked(types, values);
const join = (...parts: string[]) => ethers.concat(parts);
const callScript = (target: string, data: string) => pack(["uint8", "address", "uint24", "bytes"], [0, target, ethers.getBytes(data).length, data]);
const section = (op: number, data: string) => pack(["uint8", "uint24", "bytes"], [op, ethers.getBytes(data).length, data]);
const addScript = (name: string, script: string, expected = true, extra: Partial<Case> = {}) => cases.push({ name, script, expected, ...extra });
const transferA = callScript(a, erc.encodeFunctionData("transfer", [pool, 20n]));
addScript("legacy-call", transferA);
addScript("legacy-value-call-zero", pack(["uint8", "address", "uint96", "uint24", "bytes"],
  [1, a, 0, 68, erc.encodeFunctionData("transfer", [pool, 20n])]));
addScript("legacy-self-script", callScript(executor, abi.encodeFunctionData("execSubscript", [transferA])));
addScript("legacy-self-entry-unauthorized", transferA, false, { entry: "execSubscript" });
addScript("legacy-clear-fields", "0x02000044060000100705");
addScript("legacy-short-field", "0x020001", false);
addScript("legacy-return", section(3, "0x1234"));
addScript("legacy-revert", section(13, "0x1234"), false);
addScript("legacy-balance-floor-pass", pack(["uint8", "address", "uint256"], [8, a, 100n]));
addScript("legacy-balance-floor-fail", pack(["uint8", "address", "uint256"], [8, a, 101n]), false);
addScript("legacy-unwrap", "0x04");
const nativeCall = callScript(native, new ethers.Interface(["function pay(uint256)"]).encodeFunctionData("pay", [20n]));
addScript("legacy-native-wrap", section(11, nativeCall));
addScript("legacy-native-wrap-preserves-inventory", section(11, nativeCall), true, { nativeBalance: 777n });
addScript("legacy-native-wrap-child-return", section(11, join(nativeCall, section(3, "0x"))));
addScript("legacy-native-wrap-inventory-loss", section(11, pack(["uint8", "address", "uint96", "uint24", "bytes"],
  [1, native, 1, 4, new ethers.Interface(["function accept() payable"]).encodeFunctionData("accept")])), false, { nativeBalance: 777n });
for (let mode = 0n; mode <= 5n; ++mode) addScript(`legacy-allowance-${mode}`,
  pack(["uint8", "address", "address", "uint256", "uint256"], [10, allowanceToken, pool, 20n, 40n]),
  [0n, 1n, 4n].includes(mode), { allowanceMode: mode });
const legacyCallback = join("0x02000044", callScript(cb, call.encodeFunctionData("run", [transferA])), "0x05");
addScript("legacy-callback", legacyCallback);
addScript("legacy-state-restored-around-runtime", join("0x02000044", pscript(new P().call(a, erc.encodeFunctionData("balanceOf", [executor]), { static: true })),
  callScript(cb, call.encodeFunctionData("run", [transferA])), "0x05"));
addScript("legacy-state-restored-around-runtime-self-call", join("0x02000044",
  pscript(new P().call(executor, abi.encodeFunctionData("execSubscript", ["0x05"]))),
  callScript(cb, call.encodeFunctionData("run", [transferA])), "0x05"));
addScript("owner-sweep", "0x", true, { entry: "sweep" });
addScript("owner-sweep-denied", "0x", false, { entry: "sweep", caller: fixture(88) });
addScript("api-owner", "0x", true, { data: abi.encodeFunctionData("owner"), returnData: ethers.zeroPadValue(owner, 32) });
addScript("api-receive", "0x", true, { data: "0x", value: 123n });
addScript("api-unknown-fallback", "0x", true, { data: "0x12345678", value: 123n });
addScript("api-short-fallback", "0x", true, { data: "0x09" });
for (const entry of ["owner", "execute", "execSubscript", "sweep"])
  addScript(`api-nonpayable-${entry}`, "0x", false, { value: 1n,
    data: abi.encodeFunctionData(entry, entry === "owner" ? [] : [entry === "sweep" ? a : "0x"]) });
for (const data of ["0x09c5eabe", join("0x09c5eabe", ethers.toBeHex(32n, 32)),
  join("0x09c5eabe", ethers.toBeHex(1n << 64n, 32), ethers.toBeHex(0n, 32)),
  join("0x09c5eabe", ethers.toBeHex(32n, 32), ethers.toBeHex(1n, 32)),
  join("0x09c5eabe", ethers.toBeHex(32n, 32), ethers.toBeHex(ethers.MaxUint256, 32)),
  join("0x01681a62", ethers.toBeHex(1n << 160n, 32))])
  addScript(`api-malformed-${cases.length}`, "0x", false, { data });
addScript("legacy-return-exact-bytes", section(3, "0x123456789abc"), true, { returnData: "0x123456789abc" });
addScript("legacy-unwrap-large-word", "0x04", true, { wethBalance: (1n << 224n) + 73n });
const innerCallback = pscript(new P().call(cb, call.encodeFunctionData("run", [pscript(transfer)]),
  { callback: { incomingOffset: 68, outgoingOffset: 68 } }));
add("nested-callback-restores-context", new P().call(cb, call.encodeFunctionData("run", [innerCallback]),
  { callback: { incomingOffset: 68, outgoingOffset: 68 } }).call(cb, call.encodeFunctionData("run", [pscript(transfer)]),
  { callback: { incomingOffset: 68, outgoingOffset: 68 } }));
const swap = new ethers.Interface(["function swap(address,address,uint256,uint256,uint256)"]);
const swapAction = (tin: string, tout: string, amount: bigint, result: bigint, extra = 0n) =>
  callScript(pool, swap.encodeFunctionData("swap", [tin, tout, amount, result, extra]));
const variant = (input: bigint, quote: bigint, action: string) => pack(["uint256", "uint256", "uint8", "uint24", "bytes"],
  [input, quote, 0, ethers.getBytes(action).length, action]);
const qstep = (tin: string, tout: string, entries: string[], template = "0x") => {
  const records = join(pack(["uint24", "bytes"], [ethers.getBytes(template).length, template]), ...entries);
  return pack(["address", "address", "uint8", "uint24", "bytes"], [tin, tout, entries.length, ethers.getBytes(records).length, records]);
};
const quotedFlow = (tolerance: number, output: bigint, extra = 0n, omit = false) => {
  const one = qstep(a, b, [variant(20n, 30n, swapAction(a, b, 20n, output, extra))]);
  const two = qstep(b, a, (omit ? [30n] : [29n, 30n, 31n]).map(n => variant(n, 22n, swapAction(b, a, n, 22n))));
  return section(9, join(pack(["uint256", "uint8", "uint8"], [20n, tolerance, 2]), one, two));
};
for (const tolerance of [0, 1]) for (const output of [28n, 29n, 30n, 31n, 32n])
  addScript(`quoted-flow-${tolerance}-${output}`, quotedFlow(tolerance, output), (output > 30n ? output - 30n : 30n - output) <= BigInt(tolerance));
addScript("quoted-flow-cannot-spend-inventory", quotedFlow(1, 30n, 1n), false);
addScript("quoted-flow-missing-input-case", quotedFlow(1, 29n, 0n, true), false);
const patch = pack(["uint24", "uint8", "uint8"], [155, 1, 29]);
const patched = pack(["uint256", "uint256", "uint8", "uint24", "bytes"], [20n, 30n, 1, ethers.getBytes(patch).length, patch]);
addScript("quoted-flow-template-patch", section(9, join(pack(["uint256", "uint8", "uint8"], [20n, 1, 2]),
  qstep(a, b, [patched], swapAction(a, b, 20n, 30n)), qstep(b, a, [variant(29n, 22n, swapAction(b, a, 29n, 22n))]))));
addScript("quoted-flow-last-variant", section(9, join(pack(["uint256", "uint8", "uint8"], [20n, 0, 2]),
  qstep(a, b, [1n, 2n, 3n, 20n].map(n => variant(n, 30n, swapAction(a, b, n, 30n)))),
  qstep(b, a, [variant(30n, 22n, swapAction(b, a, 30n, 22n))]))));
for (const offset of [188, 1000]) {
  const badPatch = pack(["uint24", "uint8", "uint8"], [offset, 1, 29]);
  const entry = pack(["uint256", "uint256", "uint8", "uint24", "bytes"], [20n, 30n, 1, 5, badPatch]);
  addScript(`quoted-template-bounds-${offset}`, section(9, join(pack(["uint256", "uint8", "uint8"], [20n, 1, 2]),
    qstep(a, b, [entry], swapAction(a, b, 20n, 30n)), qstep(b, a, [variant(30n, 22n, swapAction(b, a, 30n, 22n))]))), false);
}
const rleg = (tin: string, tout: string, minimum: bigint, output: bigint, extra = 0n) => {
  const p = new P().call(pool, swap.encodeFunctionData("swap", [tin, tout, 0n, output, extra]), { patches: [{ offset: 68, reg: 0 }] }).bytes();
  return pack(["address", "address", "uint256", "uint24", "bytes"], [tin, tout, minimum, p.length, p]);
};
const rflow = (first: bigint, second: bigint, extra = 0n) => section(12, join(pack(["uint256", "uint8"], [20n, 2]),
  rleg(a, b, 1n, first), rleg(b, a, 21n, second, extra)));
addScript("runtime-flow-actual", rflow(30n, 22n));
addScript("runtime-flow-actual-nonquote", rflow(54321n, 23n));
addScript("runtime-flow-inventory-shortfall", rflow(30n, 22n, 1n), false);
addScript("runtime-flow-minimum", rflow(30n, 20n), false);
addScript("runtime-flow-zero", rflow(0n, 22n), false);
addScript("runtime-flow-not-closed", section(12, join(pack(["uint256", "uint8"], [20n, 1]), rleg(a, b, 1n, 30n))), false);
addScript("runtime-flow-repeated-token", section(12, join(pack(["uint256", "uint8"], [20n, 4]),
  rleg(a, b, 1n, 30n), rleg(b, a, 1n, 25n), rleg(a, b, 1n, 35n), rleg(b, a, 21n, 24n))));
for (const raw of ["0x00", "0x01", "0x08", "0x09", "0x0a", "0x0b", "0x0c", "0x0e", "0x0f"])
  addScript(`legacy-malformed-${raw}`, raw, false);
const broken = rflow(30n, 22n, 1000n);
addScript("diagnostic-external-call", broken, false, { diagnostic: { flow: ethers.dataSlice(broken, 4), hop: 1n, target: pool } });
addScript("diagnostic-minimum", rflow(30n, 20n), false, { diagnostic: { flow: ethers.dataSlice(rflow(30n, 20n), 4), hop: 1n, target: pool } });
addScript("diagnostic-through-self-call", callScript(executor, abi.encodeFunctionData("execSubscript", [broken])), false,
  { diagnostic: { flow: ethers.dataSlice(broken, 4), hop: 1n, target: pool } });
const forged = diagnosticAbi.encodeErrorResult("RuntimeHopFailed", [5n, fixture(99), ethers.ZeroHash, "0xabcd", ethers.ZeroHash]);
const badProgram = new P().call(failureTarget, new ethers.Interface(["function fail(bytes)"]).encodeFunctionData("fail", [forged])).bytes();
const badFlow = join(pack(["uint256", "uint8"], [20n, 2]),
  pack(["address", "address", "uint256", "uint24", "bytes"], [a, b, 1n, badProgram.length, badProgram]), rleg(b, a, 21n, 22n));
addScript("diagnostic-opaque-foreign-envelope", section(12, badFlow), false,
  { diagnostic: { flow: badFlow, hop: 0n, target: failureTarget, reason: forged } });

// Compact diagnostic opcodes must preserve exact authenticated error bytes in
// both executors, not merely agree that a transaction failed.
const compactFlow = ethers.id("compact differential route");
const compactReason = "0xabcdef";
const compactFailure = new P().call(failureTarget,
  new ethers.Interface(["function fail(bytes)"]).encodeFunctionData("fail", [compactReason])).bytes();
const compactEnvelope = (hop: bigint, target: string, reason: string, key = diagnosticKey, flowHash = compactFlow) =>
  diagnosticAbi.encodeErrorResult("RuntimeHopFailed", [hop, target, flowHash, reason,
    ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32", "bytes32"], [key, hop, target, flowHash, ethers.keccak256(reason)]))]);
add("compact-diagnostic-external-call", new P().diagnosticHop(2, compactFlow).run(compactFailure), false,
  { expectedRevertData: compactEnvelope(2n, failureTarget, compactReason) });
add("compact-diagnostic-inline-same-error", ethers.hexlify(withRuntimeHopContext(2, compactFlow, compactFailure)), false,
  { expectedRevertData: compactEnvelope(2n, failureTarget, compactReason) });
const fullProgram = new P();
for (let i = 0; i < 128; i++) fullProgram.equal(0, 0);
add("compact-diagnostic-full-instruction-boundary", ethers.hexlify(withRuntimeHopContext(0, compactFlow, fullProgram.bytes())));
add("compact-diagnostic-zero-key", new P().diagnosticHop(1, compactFlow).run(compactFailure), false,
  { diagnosticKey: ethers.ZeroHash, expectedRevertData: compactEnvelope(1n, failureTarget, compactReason, ethers.ZeroHash) });
const compactInner = pscript(new P().diagnosticHop(0, compactFlow).run(compactFailure));
add("compact-diagnostic-authenticated-callback", new P().diagnosticHop(1, compactFlow)
  .call(bubbleCallback, call.encodeFunctionData("run", [compactInner]),
    { callback: { incomingOffset: 68, outgoingOffset: 68 } }), false,
  { expectedRevertData: compactEnvelope(1n, bubbleCallback, compactEnvelope(0n, failureTarget, compactReason)) });
const inlineInner = pscript(ethers.hexlify(withRuntimeHopContext(0, compactFlow, compactFailure)));
const inlineOpener = new P().call(bubbleCallback, call.encodeFunctionData("run", [inlineInner]),
  { callback: { incomingOffset: 68, outgoingOffset: 68 } });
add("compact-diagnostic-inline-authenticated-callback", ethers.hexlify(withRuntimeHopContext(1, compactFlow, inlineOpener.bytes())), false,
  { expectedRevertData: compactEnvelope(1n, bubbleCallback, compactEnvelope(0n, failureTarget, compactReason)) });
add("compact-diagnostic-opaque-foreign-error", new P().diagnosticHop(0, compactFlow).run(badProgram), false,
  { expectedRevertData: compactEnvelope(0n, failureTarget, forged) });
const childContext = new P().diagnosticHop(5, ethers.id("different child context")).constant(1, 1n).bytes();
add("compact-diagnostic-frame-restored", new P().diagnosticHop(0, compactFlow).run(childContext).run(compactFailure), false,
  { expectedRevertData: compactEnvelope(0n, failureTarget, compactReason) });
add("compact-diagnostic-child-does-not-leak", new P().run(childContext).run(compactFailure), false,
  { diagnosticKey, noHopEnvelope: true });
add("compact-diagnostic-success-no-key-read", new P().diagnosticHop(0, compactFlow).constant(1, 1n), true, { diagnosticKey });
for (const program of ["0x010900", `0x010906${compactFlow.slice(2)}`, `0x010900${"00".repeat(32)}`])
  add(`compact-diagnostic-malformed-${program}`, program, false, { diagnosticKey, noHopEnvelope: true });

// The compiler's actual compact output is an explicit 0f02 root. Test both
// entry encodings and mixed legacy/callback scopes against compiled EVMs.
const seq = (p: P) => ethers.hexlify(runtimeCallSequenceScript(p.bytes()));
const rawEntry = (script: string) => join("0x061cf194", script);
const addSeq = (name: string, script: string, expected = true, extra: Partial<Case> = {}) => {
  addScript(`sequence-abi-${name}`, script, expected, extra);
  addScript(`sequence-raw-${name}`, script, expected, { ...extra, data: rawEntry(script) });
};
const seqTransfer = seq(new P().directCall(a, erc.encodeFunctionData("transfer", [pool, 20n])));
const cbSeq = (inner: string, target = cb) => seq(new P().call(target, call.encodeFunctionData("run", [inner]),
  { callback: { incomingOffset: 68, outgoingOffset: 68 } }));
addSeq("transfer", seqTransfer);
for (const minimum of [0n, 1n, 2n]) addSeq(`bool-floor-${minimum}`,
  seq(new P().directCall(a, erc.encodeFunctionData("transfer", [pool, 20n])).returnedFloor(0, minimum)), minimum <= 1n);
addSeq("floor-before-return", seq(new P().returnedFloor(0, 0n)), false);
addSeq("return-offset-bounds", seq(new P().directCall(a, erc.encodeFunctionData("transfer", [pool, 20n])).returnedFloor(1, 0n)), false);
addSeq("positive-is-not-negative", seq(new P().directCall(a, erc.encodeFunctionData("transfer", [pool, 20n])).returnedFloor(0, 0n, true)), false);
for (const [n, minimum, negative, expected] of [
  [-20n, 20n, true, true], [-20n, 21n, true, false], [20n, 20n, false, true], [20n, 21n, false, false],
  [0n, 0n, true, false], [1n, 0n, true, false], [-(1n << 255n), 1n << 255n, true, true],
  [-(1n << 255n), (1n << 255n) + 1n, true, false], [-1n, ethers.MaxUint256, false, true],
] as const) addSeq(`signed-${n}-${minimum}-${negative}`, seq(new P()
  .directCall(echoTarget, echoAbi.encodeFunctionData("echo", [n])).returnedFloor(0, minimum, negative)), expected);
addSeq("no-code", seq(new P().directCall(fixture(99), "0x")), false);
addSeq("empty-legacy-self", seq(new P().directCall(executor, abi.encodeFunctionData("execSubscript", ["0x"]))));
addSeq("empty-callback", cbSeq("0x"));
for (const flags of [0n, 1n, 256n, 65536n]) addSeq(`callback-auth-${flags}`, cbSeq(seqTransfer), flags === 0n, { callbackFlags: flags });
addSeq("nested-callback", cbSeq(cbSeq(seqTransfer)));
addSeq("callback-v1-child", cbSeq(pscript(transfer)));
add("v1-callback-sequence-child", new P().call(cb, call.encodeFunctionData("run", [seqTransfer]),
  { callback: { incomingOffset: 68, outgoingOffset: 68 } }));
addSeq("self-sequence", seq(new P().directCall(executor, abi.encodeFunctionData("execSubscript", [seqTransfer]))));
for (const legacy of ["0x05", "0x07", "0x02000044", "0x06000010", "0x020000440705"]) {
  addSeq(`callback-legacy-state-${legacy}`, cbSeq(legacy));
  addSeq(`self-state-restored-${legacy}`, seq(new P()
    .directCall(executor, abi.encodeFunctionData("execSubscript", [legacy]))
    .call(cb, call.encodeFunctionData("run", [seqTransfer]), { callback: { incomingOffset: 68, outgoingOffset: 68 } })));
}
const legacyInjection = join("0x02000044", callScript(cb, call.encodeFunctionData("run", [transferA])));
addSeq("self-cannot-reopen-legacy-callback", seq(new P().directCall(executor,
  abi.encodeFunctionData("execSubscript", [legacyInjection]))), false);
addSeq("callback-cannot-reopen-legacy-callback", cbSeq(legacyInjection), false);
addSeq("two-scoped-callbacks", seq(new P()
  .call(cb, call.encodeFunctionData("run", [seqTransfer]), { callback: { incomingOffset: 68, outgoingOffset: 68 } })
  .call(cb, call.encodeFunctionData("run", [seqTransfer]), { callback: { incomingOffset: 68, outgoingOffset: 68 } })));
const seqFailure = seq(new P().diagnosticHop(2, compactFlow).directCall(failureTarget,
  new ethers.Interface(["function fail(bytes)"]).encodeFunctionData("fail", [compactReason])));
addSeq("exact-diagnostic", seqFailure, false, { expectedRevertData: compactEnvelope(2n, failureTarget, compactReason) });
addSeq("forged-error-is-opaque", seq(new P().diagnosticHop(0, compactFlow).directCall(failureTarget,
  new ethers.Interface(["function fail(bytes)"]).encodeFunctionData("fail", [forged]))), false,
  { expectedRevertData: compactEnvelope(0n, failureTarget, forged) });
addSeq("nested-exact-diagnostic", seq(new P().diagnosticHop(1, compactFlow).call(bubbleCallback,
  call.encodeFunctionData("run", [seqFailure]), { callback: { incomingOffset: 68, outgoingOffset: 68 } })), false,
  { expectedRevertData: compactEnvelope(1n, bubbleCallback, compactEnvelope(2n, failureTarget, compactReason)) });
const missingReason = new ethers.Interface(["error Error(string)"]).encodeErrorResult("Error", ["runtime callback missing"]);
addSeq("missing-exact-diagnostic", seq(new P().diagnosticHop(1, compactFlow).call(cb,
  call.encodeFunctionData("run", [seqTransfer]), { callback: { incomingOffset: 68, outgoingOffset: 68 } })), false,
  { callbackFlags: 1n, expectedRevertData: compactEnvelope(1n, cb, missingReason) });
for (const script of ["0x0f", "0x0f02", "0x0f010a", "0x0f0200", "0x0f0209", "0x0f020a", "0x0f020b", "0x0f020c",
  join("0x0f020906", compactFlow), join("0x0f020900", ethers.ZeroHash),
  join("0x0f020b02", "0x" + "00".repeat(35)), join(seqTransfer, "0xff")])
  addSeq(`malformed-${cases.length}`, script, false);
// Every truncation of one complete direct instruction must reject; a zero
// length ABI script remains valid even when its trailing padding begins 0f.
for (let len = 1; len < ethers.getBytes(seqTransfer).length; len++)
  addSeq(`truncated-${len}`, ethers.dataSlice(seqTransfer, 0, len), false);
addScript("empty-abi-script-trailing-compact-tag", "0x", true,
  { data: join(abi.encodeFunctionData("execute", ["0x"]), "0x0f02ff") });
const tag = join("0x0900", compactFlow);
addSeq("instruction-128", join("0x0f02", ...Array(128).fill(tag)));
addSeq("instruction-129", join("0x0f02", ...Array(129).fill(tag)), false);
addScript("raw-owner-reject", seqTransfer, false, { data: rawEntry(seqTransfer), caller: fixture(88) });
addScript("raw-nonpayable-reject", seqTransfer, false, { data: rawEntry(seqTransfer), value: 1n });
addScript("raw-empty-legacy", "0x", true, { data: rawEntry("0x") });
for (const length of [65511, 65512]) {
  const data = join(erc.encodeFunctionData("transfer", [pool, 20n]), "0x" + "00".repeat(length - 68));
  addSeq(`size-boundary-${length}`, pack(["bytes2", "uint8", "address", "uint24", "bytes"],
    ["0x0f02", 10, a, length, data]), length === 65511);
}

let id = 0;
const child = spawn(process.env.ANVIL_BIN ?? "/usr/local/bin/anvil", ["--host", "127.0.0.1", "--port", "18648", "--hardfork", "prague", "--no-mining", "--silent"], { stdio: "ignore" });
async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const r = await fetch("http://127.0.0.1:18648", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(15000) });
  const v: any = await r.json(); if (v.error) throw Error(JSON.stringify(v.error)); return v.result;
}
const results: unknown[] = [];
try {
  for (let i = 0; ; ++i) {
    assert.equal(child.exitCode, null, "task-owned Anvil must be running");
    try { await rpc("eth_chainId"); break; } catch { assert(i < 40); await delay(100); }
  }
  for (const [address, name] of [[a, "RuntimeTestToken"], [b, "RuntimeTestToken"], [pool, "RuntimeTestSwap"], [cb, "RuntimeTestCallback"], [debt, "RuntimeTestDebtCallback"], [deferred, "RuntimeTestDeferredSwap"]])
    await rpc("anvil_setCode", [address, code(artifact(name!))]);
  await rpc("anvil_setCode", [allowanceToken, code(artifact("AllowanceToken", "BotVMAllowance.t.sol"))]);
  await rpc("anvil_setCode", [native, code(artifact("RuntimeTestNative"))]);
  await rpc("anvil_setCode", [failureTarget, code(artifact("HopFailureMock", "BotVMHopDiagnostic.t.sol"))]);
  await rpc("anvil_setCode", [bubbleCallback, code(artifact("HopCallbackBubbleMock", "BotVMHopDiagnostic.t.sol"))]);
  const mockRoot = process.argv[5] ? dirname(dirname(resolve(process.argv[5]))) : resolve(root, "out");
  await rpc("anvil_setCode", [echoTarget, code(json(resolve(mockRoot, "BotVMCompact.t.sol", "CompactReturnTarget.json")))]);
  await rpc("anvil_setCode", [weth, code(artifact("RuntimeTestWrapped"))]);
  await rpc("anvil_setStorageAt", [weth, tokenSlot(executor), ethers.toBeHex(51n, 32)]);
  await rpc("anvil_setBalance", [weth, "0x1000"]);
  await rpc("anvil_setBalance", [native, "0x1000"]);
  await rpc("anvil_setStorageAt", [allowanceToken, allowanceSlot, ethers.toBeHex(1n, 32)]);
  await rpc("anvil_setStorageAt", [a, tokenSlot(executor), ethers.toBeHex(100n, 32)]);
  await rpc("anvil_setStorageAt", [b, tokenSlot(executor), ethers.toBeHex(77n, 32)]);
  await rpc("anvil_setStorageAt", [debt, ethers.ZeroHash, ethers.zeroPadValue(a, 32)]);
  await rpc("anvil_setBalance", [owner, ethers.toQuantity(10n ** 20n)]);
  await rpc("anvil_setBalance", [fixture(88), ethers.toQuantity(10n ** 20n)]);
  await rpc("anvil_impersonateAccount", [owner]); await rpc("anvil_impersonateAccount", [fixture(88)]);
  let snap = await rpc("evm_snapshot");
  for (const c of cases) {
    const pair: any[] = [];
    for (const v of versions) {
      assert(await rpc("evm_revert", [snap])); snap = await rpc("evm_snapshot");
      await rpc("anvil_setCode", [executor, v.code]);
      const evidenceKey = c.diagnosticKey ?? (c.diagnostic || c.expectedRevertData ? diagnosticKey : ethers.ZeroHash);
      await rpc("anvil_setStorageAt", [executor, diagnosticKeySlot, evidenceKey]);
      await rpc("anvil_setBalance", [executor, ethers.toQuantity(c.nativeBalance ?? 0n)]);
      if (c.wethBalance !== undefined) {
        await rpc("anvil_setStorageAt", [weth, tokenSlot(executor), ethers.toBeHex(c.wethBalance, 32)]);
        await rpc("anvil_setBalance", [weth, ethers.toQuantity(c.wethBalance)]);
      }
      await rpc("anvil_setStorageAt", [cb, ethers.ZeroHash, ethers.toBeHex(c.callbackFlags ?? 0n, 32)]);
      await rpc("anvil_setStorageAt", [allowanceToken, ethers.toBeHex(3n, 32), ethers.toBeHex(c.allowanceMode ?? 0n, 32)]);
      const data = c.data ?? abi.encodeFunctionData(c.entry ?? "execute", [c.entry === "sweep" ? a : c.script]);
      const tx = await rpc("eth_sendTransaction", [{ from: c.caller ?? owner, to: executor, data, value: ethers.toQuantity(c.value ?? 0n), gas: "0x7a1200" }]);
      await rpc("evm_mine");
      const receipt = await rpc("eth_getTransactionReceipt", [tx]);
      const balances = await Promise.all([executor, pool, debt].map(who => rpc("eth_call", [{ to: a, data: erc.encodeFunctionData("balanceOf", [who]) }, "latest"])));
      balances.push(await rpc("eth_getStorageAt", [allowanceToken, allowanceSlot, "latest"]));
      balances.push(await rpc("eth_call", [{ to: b, data: erc.encodeFunctionData("balanceOf", [executor]) }, "latest"]));
      balances.push(await rpc("eth_call", [{ to: b, data: erc.encodeFunctionData("balanceOf", [deferred]) }, "latest"]));
      balances.push(await rpc("eth_call", [{ to: weth, data: erc.encodeFunctionData("balanceOf", [executor]) }, "latest"]));
      balances.push(await rpc("eth_getBalance", [executor, "latest"]));
      balances.push(await rpc("eth_call", [{ to: a, data: erc.encodeFunctionData("balanceOf", [owner]) }, "latest"]));
      const result = { version: v.name, success: receipt.status === "0x1", balances, gas: Number(BigInt(receipt.gasUsed)), revertData: null as string | null };
      pair.push(result);
      if (result.success !== c.expected) {
        const trace = await rpc("debug_traceTransaction", [tx, {}]);
        writeFileSync(`${out}.failure.json`, JSON.stringify({ case: c, result, trace }, (_k, v) => typeof v === "bigint" ? v.toString() : v));
      }
      assert.equal(result.success, c.expected, `${c.name} ${v.name}`);
      if (!c.expected) assert.equal(BigInt(balances[0]), 100n, "rollback");
      if (c.name === "legacy-state-restored-around-runtime-self-call") assert.equal(BigInt(balances[0]), 80n);
      if (c.debtPaid !== undefined) assert.equal(BigInt(balances[2]), c.debtPaid);
      if (c.allowanceMode !== undefined) assert.equal(BigInt(balances[3]), c.expected ? 40n : 1n);
      if (c.returnData !== undefined) {
        const trace = await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]);
        assert.equal(trace.output, c.returnData, `${c.name} return data`);
      }
      if (c.name === "compact-diagnostic-success-no-key-read") {
        const trace = await rpc("debug_traceTransaction", [tx, { disableMemory: true, disableStack: true, disableStorage: true }]);
        assert(trace.structLogs.every((step: { op: string }) => !["SLOAD", "CALL", "STATICCALL"].includes(step.op)),
          "success-path hop metadata must not read diagnostic storage or add token queries");
      }
      if (c.name.startsWith("production-settlement-")) {
        assert.equal(BigInt(balances[0]), c.expected ? 102n : 100n);
        assert.equal(BigInt(balances[4]), 77n, "existing intermediate inventory is preserved");
        assert.equal(BigInt(balances[5]), c.expected ? 30n : 0n, "actual debt credit or atomic rollback");
      }
      if (c.diagnostic || c.expectedRevertData || c.noHopEnvelope) {
        const trace = await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]);
        result.revertData = trace.output;
        writeFileSync(`${out}.last-diagnostic.json`, JSON.stringify({ case: c, result }, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
        if (c.expectedRevertData) assert.equal(trace.output, c.expectedRevertData, `${c.name} exact authenticated envelope`);
        if (c.noHopEnvelope) {
          let parsed = null;
          try { parsed = diagnosticAbi.parseError(trace.output); } catch { /* ordinary failure may be empty */ }
          assert.notEqual(parsed?.name, "RuntimeHopFailed", `${c.name} must not acquire a leaked hop context`);
        }
        if (c.diagnostic) {
        const decoded = diagnosticAbi.decodeErrorResult("RuntimeHopFailed", trace.output);
        assert.equal(decoded.hop, c.diagnostic.hop);
        assert.equal(decoded.target.toLowerCase(), c.diagnostic.target.toLowerCase());
        assert.equal(decoded.flowHash, ethers.keccak256(c.diagnostic.flow));
        if (c.diagnostic.reason) assert.equal(decoded.reason, c.diagnostic.reason);
        assert.equal(decoded.proof, ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "uint256", "address", "bytes32", "bytes32"],
          [evidenceKey, decoded.hop, decoded.target, decoded.flowHash, ethers.keccak256(decoded.reason)])));
        }
      }
    }
    if (JSON.stringify(pair[0].balances) !== JSON.stringify(pair[1].balances))
      writeFileSync(`${out}.balance-failure.json`, JSON.stringify({ case: c, pair }, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
    assert.deepEqual(pair[0].balances, pair[1].balances, c.name);
    if (!c.noHopEnvelope) assert.equal(pair[0].revertData, pair[1].revertData, "authenticated hop evidence must be byte-identical");
    results.push({ name: c.name, pair });
  }
  writeFileSync(out, JSON.stringify({ cases: cases.length, results }, null, 2) + "\n");
  console.log(`PASS: ${cases.length} same-input Solidity+Yul/Huff safety comparisons`);
} finally { child.kill("SIGTERM"); }
