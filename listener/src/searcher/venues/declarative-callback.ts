import { Interface, MaxUint256, getAddress, getBytes, hexlify, type ParamType } from "ethers";
import { RuntimeAmountProgram, runtimeDeferredPayment, runtimePayment, runtimeProgramScript,
  type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { executionNativeSides } from "../execution-asset-boundary.js";
import { encodeDeclarativeCall } from "./declarative-call-codec.js";

export type CallbackValue = bigint | number | string | boolean | { readonly runtime: string };
export type CallbackCheck = { left: CallbackValue; operator: "eq" | "gte"; right: CallbackValue };
export interface CallbackCall {
  readonly target: string; readonly signature: string; readonly args: readonly unknown[];
  readonly save?: Record<string, number>; readonly checks?: readonly CallbackCheck[];
}
export interface DeclarativeDeferredExecution {
  readonly stepId: string;
  /** args omits this bytes argument; only the common compiler inserts it. */
  readonly dataArgument: number;
  readonly call: CallbackCall;
  readonly callback: {
    readonly signature: string;
    readonly dataArgument: number;
    readonly debtArgument: number;
    readonly outputArgument: number;
    readonly expectedDebt: CallbackValue;
    readonly expectedOutput: CallbackValue;
    readonly bindings: readonly { argument: number; equals: CallbackValue }[];
    readonly payment: {
      readonly mode: "transfer" | "approve-pull";
      /** Transfer receiver or the spender that pulls after callback return. */
      readonly recipient: string;
      readonly requireBool?: boolean;
      readonly verifyAllowance?: boolean;
    };
  };
}
export interface CallbackEmitter {
  word(value: CallbackValue): { reg: number; temporary: boolean };
  release(value: { reg: number; temporary: boolean }): void;
  take(): number;
  call(call: CallbackCall, options: {
    callback: { incomingOffset: number; outgoingOffset: number };
    patches: readonly { offset: number; reg: number }[];
  }): void;
  check(value: CallbackCheck): void;
}
const TOKEN = new Interface(["function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)"]);
function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("invalid deferred declaration");
}
function positive(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MaxUint256) throw new Error("invalid deferred payment amount");
}
function scalar(type: ParamType): boolean { return ["uint256", "address", "bool", "bytes32"].includes(type.type); }
function byteArgument(signature: string, index: number) {
  const abi = new Interface([signature]), fs = abi.fragments.filter(f => f.type === "function");
  if (fs.length !== 1) throw new Error("deferred declaration requires one function");
  const fn = abi.getFunction(fs[0]!.format("sighash"))!;
  if (!Number.isSafeInteger(index) || index < 0 || fn.inputs[index]?.type !== "bytes") throw new Error("deferred data argument must be bytes");
  return { abi, fn };
}
function dummy(type: ParamType): unknown {
  if (type.type === "address") return "0x0000000000000000000000000000000000000000";
  if (type.type === "bool") return false;
  if (type.type.startsWith("bytes")) return `0x${"00".repeat(Number(type.type.slice(5)))}`;
  return 0n;
}
function headSize(type: ParamType): number {
  if (type.baseType === "tuple") return type.components!.some(dynamicType) ? 32 : type.components!.reduce((n, t) => n + headSize(t), 0);
  if (type.baseType === "array") return type.arrayLength === -1 || dynamicType(type.arrayChildren!) ? 32 : type.arrayLength! * headSize(type.arrayChildren!);
  return 32;
}
function dynamicType(type: ParamType): boolean {
  if (type.baseType === "tuple") return type.components!.some(dynamicType);
  if (type.baseType === "array") return type.arrayLength === -1 || dynamicType(type.arrayChildren!);
  return type.type === "bytes" || type.type === "string";
}
function payloadOffset(signature: string, index: number, data: string): number {
  const { fn } = byteArgument(signature, index), bytes = getBytes(data);
  const head = 4 + fn.inputs.slice(0, index).reduce((n, t) => n + headSize(t), 0);
  const relative = BigInt(hexlify(bytes.slice(head, head + 32)));
  if (relative > BigInt(bytes.length)) throw new Error("deferred payload offset bounds");
  const start = 4 + Number(relative) + 32;
  if (start > bytes.length) throw new Error("deferred payload bounds");
  return start;
}

/** Validate the static declaration before exposing a capability. Values such
 * as targets and expected amounts are resolved and checked at invocation time. */
export function validateDeclarativeDeferredDefinition(
  spec: DeclarativeDeferredExecution,
  steps?: readonly { id: string; call?: unknown; math?: unknown; static?: boolean; approval?: unknown; effects?: readonly unknown[] }[],
): void {
  keys(spec, ["stepId", "dataArgument", "call", "callback"]);
  keys(spec.call, ["target", "signature", "args"], ["save", "checks"]);
  const cb = spec.callback;
  keys(cb, ["signature", "dataArgument", "debtArgument", "outputArgument", "expectedDebt", "expectedOutput", "bindings", "payment"]);
  keys(cb.payment, ["mode", "recipient"], ["requireBool", "verifyAllowance"]);
  if (!["transfer", "approve-pull"].includes(cb.payment.mode)) throw new Error("unknown deferred payment mode");
  if ([cb.payment.requireBool, cb.payment.verifyAllowance].some(value => value !== undefined && typeof value !== "boolean"))
    throw new Error("invalid deferred payment check");
  if (cb.payment.mode === "transfer" && cb.payment.verifyAllowance) throw new Error("transfer settlement has no allowance");
  const incoming = byteArgument(cb.signature, cb.dataArgument);
  if (incoming.fn.inputs.some((t, i) => i !== cb.dataArgument && !scalar(t))) throw new Error("callback arguments require static scalar bindings");
  for (const index of [cb.debtArgument, cb.outputArgument]) {
    if (!Number.isSafeInteger(index) || index < 0 || incoming.fn.inputs[index]?.type !== "uint256")
      throw new Error("callback debt/output must be uint256 arguments");
  }
  if (cb.debtArgument === cb.outputArgument) throw new Error("callback debt and output must be distinct");
  if (!Array.isArray(cb.bindings)) throw new Error("callback bindings must be an array");
  const covered = new Set([cb.dataArgument, cb.debtArgument, cb.outputArgument]);
  for (const binding of cb.bindings) {
    keys(binding, ["argument", "equals"]);
    if (!Number.isSafeInteger(binding.argument) || binding.argument < 0 || !incoming.fn.inputs[binding.argument] || covered.has(binding.argument))
      throw new Error("duplicate or invalid callback binding");
    covered.add(binding.argument);
  }
  if (covered.size !== incoming.fn.inputs.length) throw new Error("every callback argument must be bound");
  const outer = byteArgument(spec.call.signature, spec.dataArgument);
  if (!Array.isArray(spec.call.args) || spec.call.args.length !== outer.fn.inputs.length - 1) throw new Error("deferred call args must omit the data argument");

  if (typeof spec.stepId !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(spec.stepId)) throw new Error("invalid deferred step id");
  if (steps) {
    const terminal = steps[steps.length - 1];
    if (!terminal || terminal.id !== spec.stepId || terminal.call === undefined || terminal.math !== undefined || terminal.static || terminal.effects?.length)
      throw new Error("deferred callback must replace the terminal call step");
    for (const step of steps.slice(0, -1)) if (step.math === undefined &&
        (step.static !== true || step.approval !== undefined || step.effects?.length))
      throw new Error("deferred preparation must be read-only calls or math");
  }
}

/** Emits an output-first ERC20 callback using the existing authenticated VM
 * frame and continuation. JSON cannot supply a script or byte offset. Every
 * branch measures fresh output/input and retains both old token inventories. */
export function emitDeclarativeDeferredExecution(
  program: RuntimeAmountProgram,
  spec: DeclarativeDeferredExecution,
  input: { readonly executor: string; readonly route: { tokenIn: string; tokenOut: string; executionAssets?: any };
    readonly settlement: Extract<RuntimeSettlementRequest, { kind: "deferred-input" }>; readonly fullInput: boolean },
  emit: CallbackEmitter,
): void {
  validateDeclarativeDeferredDefinition(spec);
  const cb = spec.callback;
  if (executionNativeSides(input.route)) throw new Error("native deferred execution is not declared by this compiler");
  const { settlement } = input;
  positive(settlement.paymentAmount);
  if (settlement.paymentInput !== undefined) throw new Error("debt-sized deferred continuation is not declared");
  const actor = getAddress(input.executor), tokenIn = getAddress(input.route.tokenIn), tokenOut = getAddress(input.route.tokenOut);
  const recipient = getAddress(cb.payment.recipient);
  if (actor === recipient || tokenIn === tokenOut) throw new Error("invalid deferred payment asset/recipient");
  const incoming = byteArgument(cb.signature, cb.dataArgument);

  const held: { reg: number; temporary: boolean }[] = [];
  const word = (value: CallbackValue) => { const result = emit.word(value); held.push(result); return result.reg; };
  const temporary = () => { const reg = emit.take(); held.push({ reg, temporary: true }); return reg; };
  const output = word(cb.expectedOutput), debt = word(cb.expectedDebt), one = word(1n), amount = word(settlement.paymentAmount);
  const beforeIn = temporary(), beforeOut = temporary(), beforeNative = temporary(), scratch = temporary(), other = temporary();
  program.math("sub", scratch, output, one).math("sub", scratch, debt, one).math("sub", scratch, 0, debt);
  if (input.fullInput) program.equal(debt, 0);
  const balance = TOKEN.encodeFunctionData("balanceOf", [actor]);
  program.call(tokenIn, balance, { static: true }).load(beforeIn, 0)
    .call(tokenOut, balance, { static: true }).load(beforeOut, 0).nativeBalance(beforeNative);

  const callback = new RuntimeAmountProgram(), seeds: { offset: number; reg: number }[] = [];
  const seed = (dst: number, parent: number) => { seeds.push({ offset: 36 + callback.bytes().length + 2, reg: parent }); callback.constant(dst, 0n); };
  // bytes() requires a nonempty program; a fixed constant also sets the shared
  // positive-debt floor before any caller-authenticated ABI word is used.
  callback.constant(12, 1n);
  seed(8, output); seed(9, debt); seed(10, beforeIn); seed(11, beforeOut);
  callback.calldata(2, 0).constant(3, 224n).math("shr", 2, 2, 3).constant(3, BigInt(incoming.fn.selector)).equal(2, 3);
  for (const binding of cb.bindings) {
    seed(3, word(binding.equals)); callback.calldata(2, 4 + binding.argument * 32).equal(2, 3);
  }
  callback.calldata(1, 4 + cb.debtArgument * 32).equal(1, 9).math("sub", 2, 1, 12);
  runtimePayment(callback, 1, 2);
  callback.calldata(2, 4 + cb.outputArgument * 32).equal(2, 8)
    .call(tokenOut, balance, { static: true }).load(6, 0).math("sub", 7, 6, 11).equal(7, 8)
    .constant(3, settlement.paymentAmount).math("sub", 7, 7, 3);
  const payment = runtimeDeferredPayment({ tokenOut, executor: actor, ...settlement });
  const paymentStart = callback.bytes().length + 7;
  seeds.push({ offset: paymentStart + payment.floorOffset, reg: other });
  callback.run(payment.script.slice(36), 0, 4)
    .call(tokenIn, balance, { static: true }).load(3, 0).math("sub", 3, 3, 10).equal(3, 0);
  if (cb.payment.mode === "transfer") {
    const recipientBalance = TOKEN.encodeFunctionData("balanceOf", [recipient]);
    callback.call(tokenIn, recipientBalance, { static: true }).load(6, 0);
    runtimePayment(callback, 1, 2).transfer(tokenIn, recipient);
    if (cb.payment.requireBool) callback.load(3, 0).equal(3, 12);
    callback.call(tokenIn, recipientBalance, { static: true }).load(3, 0).math("sub", 3, 3, 6).equal(3, 1);
  } else {
    callback.call(tokenIn, TOKEN.encodeFunctionData("approve", [recipient, 0n]), { patches: [{ offset: 36, reg: 1 }] });
    if (cb.payment.requireBool) callback.load(3, 0).equal(3, 12);
    if (cb.payment.verifyAllowance) callback.call(tokenIn, TOKEN.encodeFunctionData("allowance", [actor, recipient]), { static: true }).load(3, 0).equal(3, 1);
  }
  const payload = runtimeProgramScript(callback.bytes());
  const args = [...spec.call.args]; args.splice(spec.dataArgument, 0, hexlify(payload));
  const encoded = encodeDeclarativeCall(spec.call.signature, args);
  const outgoingOffset = payloadOffset(spec.call.signature, spec.dataArgument, encoded.data);
  const callbackArgs = incoming.fn.inputs.map((t, i) => i === cb.dataArgument ? hexlify(payload) : dummy(t));
  const incomingOffset = payloadOffset(cb.signature, cb.dataArgument, incoming.abi.encodeFunctionData(incoming.fn, callbackArgs));
  const clear = () => {
    if (cb.payment.mode !== "approve-pull") return;
    program.call(tokenIn, TOKEN.encodeFunctionData("approve", [recipient, 0n]));
    if (cb.payment.requireBool) program.load(scratch, 0).equal(scratch, one);
    if (cb.payment.verifyAllowance) program.call(tokenIn, TOKEN.encodeFunctionData("allowance", [actor, recipient]), { static: true })
      .load(scratch, 0).constant(other, 0n).equal(scratch, other);
  };
  clear();
  program.math("add", other, beforeOut, amount);
  emit.call({ ...spec.call, args }, { callback: { incomingOffset, outgoingOffset },
    patches: [{ offset: outgoingOffset + 1, reg: 0 }, ...seeds.map(p => ({ offset: outgoingOffset + p.offset, reg: p.reg }))] });
  for (const check of spec.call.checks ?? []) emit.check(check);
  clear();
  program.call(tokenIn, balance, { static: true }).load(scratch, 0)
    .math("add", other, beforeIn, 0).math("sub", other, other, debt).equal(scratch, other)
    .call(tokenOut, balance, { static: true }).load(scratch, 0)
    .math("add", other, beforeOut, output).math("sub", other, other, amount).equal(scratch, other)
    .nativeBalance(scratch).equal(scratch, beforeNative);
  held.forEach(emit.release);
}
