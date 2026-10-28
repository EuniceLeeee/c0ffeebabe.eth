import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { inspectRuntime, type RuntimeCall } from "../../../../test/runtime-program-testkit.js";
import { plugin } from "../../../production-families/set-redemption.production.js";
import { MODULE, SET, TOKEN, WAD } from "../codec.js";
import { ACTOR, RECEIVER, SOURCE, fixture } from "./basic-recipient-fixture.js";
const TRANSFER = new ethers.Interface(["function transfer(address,uint256) returns(bool)"]);
const SUBSCRIPT = new ethers.Interface(["function execSubscript(bytes)"]);
const lower = (s: string) => s.toLowerCase();
const faults = ["no-burn", "short-burn", "extra-burn", "short-selected", "short-side", "wrong-basket-recipient",
  "receiver-input", "receiver-side-redeem", "native-redeem", "no-transfer-debit", "no-transfer-credit", "short-transfer-credit",
  "extra-transfer-credit", "extra-transfer-debit", "wrong-transfer-recipient", "actor-side-transfer", "receiver-side-transfer",
  "actor-input-transfer", "native-transfer"] as const;
type Fault = typeof faults[number] | "none";
function model(selected: number, external: boolean, options: { fault?: Fault; amount?: bigint; count?: number; bonus?: bigint;
  returnKind?: "true" | "false" | "empty"; verify?: boolean; guarded?: boolean; sideIndex?: number } = {}) {
  const d = fixture(options.count), route = plugin.routes.project({ descriptor: d })[selected]; assert(route);
  const A = options.amount ?? 100n, to = external ? RECEIVER : ACTOR, fault = options.fault ?? "none";
  const side = options.sideIndex ?? (selected + 1) % d.components.length;
  const balances = new Map<string, bigint>(), key = (token: string, account: string) => lower(token) + ":" + lower(account);
  const balance = (token: string, account: string) => balances.get(key(token, account)) ?? 0n;
  const add = (token: string, account: string, n: bigint) => balances.set(key(token, account), balance(token, account) + n);
  for (const account of [ACTOR, RECEIVER]) {
    add(d.set, account, account === ACTOR ? 10000n : 7000n);
    d.components.forEach((token, n) => add(token, account, BigInt((account === ACTOR ? 1000 : 2000) + n)));
  }
  const before = new Map(balances), units = d.components.map((_, n) => BigInt(n + 1) * WAD), outputs = units.map(u => A * u / WAD);
  let native = 29n, calls = 0, transfers = 0;
  const input = { descriptor: d, route, executor: ACTOR, source: SOURCE, runtimeEvidence: [], settlement: { kind: "direct-output" as const, recipient: to } };
  for (const field of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
    Object.defineProperty(input, field, { get() { throw Error("runtime read " + field); } });
  const leg = plugin.execution.buildRuntimeLeg!(input); assert(leg); assert.equal(leg.settlement?.directOutput, true); assert.deepEqual(leg.settlementRequest, input.settlement);
  // An intentionally unguarded mutation sentinel proves fault rejection belongs
  // to emitted guards, never to success-only assertions after the interpreter.
  let code = leg.program;
  if (options.guarded === false) {
    const p = new RuntimeAmountProgram().call(route.tokenOut, TOKEN.encodeFunctionData("balanceOf", [ACTOR]), { static: true }).load(1, 0)
      .call(d.module, MODULE.encodeFunctionData("redeem", [d.set, 0n, ACTOR]), { patches: [{ offset: 36, reg: 0 }] });
    if (external) p.call(route.tokenOut, TOKEN.encodeFunctionData("balanceOf", [ACTOR]), { static: true }).load(2, 0).math("sub", 2, 2, 1)
      .call(route.tokenOut, TRANSFER.encodeFunctionData("transfer", [RECEIVER, 0n]), { patches: [{ offset: 36, reg: 2 }] });
    code = ethers.hexlify(p.bytes());
  }
  const call = (c: RuntimeCall): string => {
    const target = lower(c.target);
    if (target === ACTOR) {
      assert(!c.static && c.value === 0n && c.incoming === 0 && c.outgoing === 0);
      assert.deepEqual(c.patches, [{ offset: 69, reg: 0 }]);
      const script = ethers.getBytes(SUBSCRIPT.decodeFunctionData("execSubscript", c.data)[0]);
      assert.equal(script[0], 14); const amount = BigInt(ethers.hexlify(script.slice(1, 33))), size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
      assert.equal(script.length, 36 + size); inspectRuntime(ethers.hexlify(script.slice(36)), amount, { call, nativeBalance: () => native }); return "0x";
    }
    if (target === d.module) {
      assert(!c.static && c.value === 0n && c.incoming === 0 && c.outgoing === 0);
      const args = MODULE.decodeFunctionData("redeem", c.data); assert.deepEqual([lower(args[0]), args[1], lower(args[2])], [d.set, A, ACTOR]);
      calls++; assert.equal(calls, 1);
      const debit = fault === "no-burn" ? 0n : fault === "short-burn" ? A - 1n : fault === "extra-burn" ? A + 1n : A;
      add(d.set, ACTOR, -debit);
      outputs.forEach((o, n) => add(d.components[n], fault === "wrong-basket-recipient" ? RECEIVER : ACTOR,
        o + (n === selected ? options.bonus ?? 0n : 0n) - (fault === "short-selected" && n === selected || fault === "short-side" && n === side ? 1n : 0n)));
      if (fault === "receiver-input") add(d.set, RECEIVER, -1n);
      if (fault === "receiver-side-redeem") add(d.components[side], RECEIVER, -1n);
      if (fault === "native-redeem") native++;
      return "0x";
    }
    if (c.data.startsWith(TRANSFER.getFunction("transfer")!.selector)) {
      assert(!c.static && target === route.tokenOut); transfers++;
      const [recipient, amount] = TRANSFER.decodeFunctionData("transfer", c.data); assert.equal(lower(recipient), RECEIVER);
      add(target, ACTOR, fault === "no-transfer-debit" ? 0n : -amount - (fault === "extra-transfer-debit" ? 1n : 0n));
      add(target, fault === "wrong-transfer-recipient" ? d.module : RECEIVER, fault === "no-transfer-credit" ? 0n : amount + (fault === "extra-transfer-credit" ? 1n : fault === "short-transfer-credit" ? -1n : 0n));
      if (fault === "actor-side-transfer") add(d.components[side], ACTOR, -1n);
      if (fault === "receiver-side-transfer") add(d.components[side], RECEIVER, -1n);
      if (fault === "actor-input-transfer") add(d.set, ACTOR, -1n);
      if (fault === "native-transfer") native++;
      return options.returnKind === "empty" ? "0x" : TRANSFER.encodeFunctionResult("transfer", [options.returnKind !== "false"]);
    }
    assert(c.static && c.value === 0n && c.incoming === 0 && c.outgoing === 0);
    if (c.data.startsWith(TOKEN.getFunction("balanceOf")!.selector)) return TOKEN.encodeFunctionResult("balanceOf", [balance(target, TOKEN.decodeFunctionData("balanceOf", c.data)[0])]);
    assert.equal(target, d.set); const fn = SET.parseTransaction({ data: c.data }); assert(fn);
    if (fn.name === "getComponents") return SET.encodeFunctionResult(fn.name, [d.components]);
    assert.equal(fn.name, "getDefaultPositionRealUnit"); return SET.encodeFunctionResult(fn.name, [units[d.components.indexOf(lower(fn.args[0]))]]);
  };
  const result = inspectRuntime(code, A, { call, nativeBalance: () => native });
  if (options.verify === false) return result;
  assert.equal(calls, 1); assert.equal(transfers, external ? 1 : 0); assert.equal(result.registers[0], A); assert.equal(result.allowances.length, 0); assert.equal(native, 29n);
  assert.equal(balance(d.set, ACTOR), before.get(key(d.set, ACTOR))! - A); assert.equal(balance(d.set, RECEIVER), before.get(key(d.set, RECEIVER)));
  d.components.forEach((token, n) => {
    const out = outputs[n] + (n === selected ? options.bonus ?? 0n : 0n);
    assert.equal(balance(token, ACTOR), before.get(key(token, ACTOR))! + (external && n === selected ? 0n : out));
    assert.equal(balance(token, RECEIVER), before.get(key(token, RECEIVER))! + (external && n === selected ? out : 0n));
  });
  return result;
}
test("four actual route shapes use the full input, preserve basket ownership and forward only actual selected receipt", () => {
  for (let selected = 0; selected < 4; selected++) for (const external of [false, true]) for (const amount of [1n, 100n]) {
    model(selected, external, { amount }); model(selected, external, { amount, bonus: 7n });
    if (external) for (const returnKind of ["false", "empty"] as const) model(selected, external, { amount, returnKind });
  }
});
test("all negative models stop before success postconditions; unguarded sentinels admit the same injected faults", () => {
  for (let selected = 0; selected < 4; selected++) for (const fault of faults) {
    assert.throws(() => model(selected, true, { fault, verify: false }), /checked uint256|runtime amount mismatch/);
    assert.doesNotThrow(() => model(selected, true, { fault, verify: false, guarded: false }));
  }
  for (const external of [false, true]) assert.throws(() => model(0, external, { amount: 0n, verify: false }), /checked uint256/);
});
test("side-output groups retain every boundary with executor-only frames, including more than 25 components", () => {
  for (const count of [9, 17, 33]) for (const selected of [0, count - 1]) {
    model(selected, true, { count });
    for (const fault of ["short-side", "actor-side-transfer", "receiver-side-redeem", "receiver-side-transfer"] as const)
      assert.throws(() => model(selected, true, { count, fault, sideIndex: selected === 0 ? count - 1 : 0, verify: false }), /checked uint256|runtime amount mismatch/);
  }
});
test("only explicit direct is declared; unsafe receiver aliases, forged routes, quote and deferred modes reject", () => {
  const d = fixture(), route = plugin.routes.project({ descriptor: d })[0], input = { descriptor: d, route, executor: ACTOR, source: SOURCE, runtimeEvidence: [] };
  const defaultLeg = plugin.execution.buildRuntimeLeg!(input)!; assert.equal(defaultLeg.settlement?.directOutput, true); assert.equal(defaultLeg.settlement?.quoteOutput, undefined); assert.equal(defaultLeg.settlement?.deferredInput, undefined);
  for (const recipient of [ethers.ZeroAddress, d.set, d.module, d.controller, ...d.components])
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, settlement: { kind: "direct-output", recipient } }));
  for (const kind of ["quote-output", "deferred-input"] as const)
    assert.equal(plugin.execution.buildRuntimeLeg!({ ...input, settlement: kind === "quote-output" ? { kind, recipient: RECEIVER } : { kind, paymentAmount: 1n, paymentProgram: ethers.hexlify(new RuntimeAmountProgram().constant(1, 0n).bytes()) } }), null);
  assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, route: { ...route, tokenOut: RECEIVER }, settlement: { kind: "direct-output", recipient: RECEIVER } }));
});

test("whole-basket observation rejects erased side output and redirected receiver inventory", async () => {
  const { assertBasicRecipientEffects } = await import("./basic-recipient-observations.js");
  const token = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]), d = fixture(), outputs = [100n, 200n, 300n, 400n];
  const event = (abi: ethers.Interface, name: string, address: string, values: unknown[]) => ({ address, ...abi.encodeEventLog(abi.getEvent(name)!, values) });
  const e: any = { tokenDeltas: [ACTOR, RECEIVER, d.set].flatMap(account => [d.set, ...d.components].map(asset => {
    const n = d.components.indexOf(asset), delta = asset === d.set ? account === ACTOR ? -100n : 0n : account === d.set ? -outputs[n] : account === ACTOR ? n === 0 ? 0n : outputs[n] : n === 0 ? outputs[n] : 0n;
    return { token: asset, account, delta };
  })), nativeDeltas: [{ account: ACTOR, delta: 0n }], totalSupplyDeltas: [{ token: d.set, delta: -100n }], logs: [
    event(token, "Transfer", d.set, [ACTOR, ethers.ZeroAddress, 100n]), ...d.components.map((t, n) => event(token, "Transfer", t, [d.set, ACTOR, outputs[n]])),
    event(token, "Transfer", d.components[0], [ACTOR, RECEIVER, 100n]), event(MODULE, "SetTokenRedeemed", d.module, [d.set, ACTOR, ACTOR, 100n]),
  ] };
  const check = (value: any) => assertBasicRecipientEffects(value, d, ACTOR, RECEIVER, d.components[0], RECEIVER, 100n, outputs);
  check(e);
  for (const [account, asset] of [[ACTOR, d.components[2]], [RECEIVER, d.components[3]], [RECEIVER, d.set], [d.set, d.components[1]]]) {
    const wrong = structuredClone(e); wrong.tokenDeltas.find((r: any) => r.account === account && r.token === asset).delta -= 1n; assert.throws(() => check(wrong));
  }
  const wrong = structuredClone(e); wrong.logs[wrong.logs.length - 1] = event(MODULE, "SetTokenRedeemed", d.module, [d.set, ACTOR, RECEIVER, 100n]); assert.throws(() => check(wrong));
  const incomplete = structuredClone(e); incomplete.tokenDeltas.pop(); assert.throws(() => check(incomplete));
});
test("old successful references are quantities only and must bind the same four-component N", async () => {
  const { basicReferences } = await import("./basic-recipient-historical.js"), { SAMPLE } = await import("./historical-runtime-observations.js");
  const d = fixture(), prior: any = { result: "pass", family: "protocol:set-redemption", instanceKey: `${SAMPLE.set}:${SAMPLE.module}`,
    headerBefore: { hash: SAMPLE.hash, number: ethers.toQuantity(SAMPLE.number) }, headerAfter: { hash: SAMPLE.hash }, code: { sourceTreeSha256: "a".repeat(64) }, codeAfter: { sourceTreeSha256: "a".repeat(64) },
    samples: d.components.flatMap(selectedComponent => ["production-P", "historical-amount-at-N"].map((label, i) => ({ selectedComponent, label, amountIn: i === 0 ? "100" : "200", status: "pass", executions: [{ status: "pass" }, { status: "pass" }] }))) };
  assert.deepEqual(basicReferences(prior, d.components).map(r => r.amountIn), [100n, 200n]);
  for (const change of [(r: any) => { r.headerBefore.hash = ethers.ZeroHash; }, (r: any) => { r.samples[0].status = "failed"; }, (r: any) => { r.samples[2].amountIn = "99"; }, (r: any) => { r.samples.pop(); }]) {
    const wrong = structuredClone(prior); change(wrong); assert.throws(() => basicReferences(wrong, d.components));
  }
});
test("executor artifact metadata must bind the actual current Solidity source", async () => {
  const { verifyBasicExecutorSources } = await import("./basic-recipient-historical.js"), fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "set-basic-source-"));
  try {
    fs.mkdirSync(path.join(root, "src")); const file = path.join(root, "src/BotVM.sol"), artifact = path.join(root, "BotVM.json"), text = "pragma solidity ^0.8.24; contract BotVM {}\n";
    fs.writeFileSync(file, text); fs.writeFileSync(artifact, JSON.stringify({ metadata: { settings: { compilationTarget: { "src/BotVM.sol": "BotVM" } }, sources: { "src/BotVM.sol": { keccak256: ethers.keccak256(ethers.toUtf8Bytes(text)) } } } }));
    assert.equal(verifyBasicExecutorSources(root, artifact).sources.length, 1);
    fs.writeFileSync(file, text + "// drift\n"); assert.throws(() => verifyBasicExecutorSources(root, artifact));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
