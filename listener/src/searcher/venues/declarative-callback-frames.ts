import { AbiCoder, Interface, MaxUint256, getBytes, hexlify, type ParamType } from "ethers";
import { runtimeProgramScript, type RuntimeAmountProgram, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { concatBytes, encodeReturn } from "../../encoder.js";
import { assertPublicRuntimeCaptureName, encodeDeclarativeCall } from "./declarative-call-codec.js";
import type { BoundRuntimeMath, ExpandedRuntimeMathOperation } from "./declarative-runtime-math.js";

export type FrameValue = bigint | number | string | boolean | { readonly runtime: string };
export interface FrameCheck { readonly left: FrameValue; readonly operator: "eq" | "gte"; readonly right: FrameValue }
export interface FrameCall {
  readonly target: string; readonly signature: string; readonly args: readonly unknown[];
  readonly value?: FrameValue; readonly save?: Readonly<Record<string, number>>; readonly checks?: readonly FrameCheck[];
}
export interface FrameArgument {
  readonly index: number; readonly name: string;
  /** Signed ABI values are normalized to a positive magnitude before use. */
  readonly encoding: "word" | "positive" | "negative";
  readonly equals?: FrameValue; readonly minimum?: FrameValue; readonly maximum?: FrameValue;
}
export interface DeclarativeCallbackFrame {
  readonly call: FrameCall & { readonly dataArgument: number };
  readonly callback: {
    readonly signature: string; readonly dataArgument: number;
    readonly arguments: readonly FrameArgument[];
    /** Explicit parent captures: no ambient access to an enclosing register. */
    readonly captures: Readonly<Record<string, FrameValue>>;
    readonly steps: readonly FrameStep[];
    /** Static ABI return data (for example an unlock callback's empty bytes). */
    readonly returns?: { readonly types: readonly string[]; readonly values: readonly unknown[] };
  };
}
export interface FrameContinuation { readonly debt: FrameValue; readonly output: FrameValue }
export interface FramedSettlementContext {
  readonly request: Extract<RuntimeSettlementRequest, { kind: "deferred-input" }>;
  readonly executor: string; readonly tokenIn: string; readonly tokenOut: string; readonly recipient: string;
  readonly minimum: bigint; readonly fullInput: boolean;
  /** Parent read/math witness, compared with actual callback receipt and final balance. */
  readonly expectedOutput: FrameValue;
  readonly constraints: readonly { actual: "debt" | "output"; operator: "eq" | "gte" | "lte"; value: FrameValue }[];
  readonly native?: { input: boolean; output: boolean };
}
export type FrameNativeBoundary = { readonly kind: "wrap-output" } | { readonly kind: "unwrap-payment"; readonly debt: FrameValue };
export type FrameStep = { readonly id: string; readonly when?: boolean } & (
  | { readonly call: FrameCall; readonly static?: boolean; readonly frame?: never; readonly math?: never; readonly check?: never; readonly continuation?: never; readonly nativeBoundary?: never }
  | { readonly frame: DeclarativeCallbackFrame; readonly call?: never; readonly static?: never; readonly math?: never; readonly check?: never; readonly continuation?: never; readonly nativeBoundary?: never }
  | { readonly math: { readonly model: string; readonly inputs: Readonly<Record<string, FrameValue>>;
      readonly outputs: Readonly<Record<string, string>>; readonly checks?: readonly FrameCheck[] };
      readonly call?: never; readonly static?: never; readonly frame?: never; readonly check?: never; readonly continuation?: never; readonly nativeBoundary?: never }
  | { readonly check: FrameCheck; readonly call?: never; readonly static?: never; readonly frame?: never; readonly math?: never; readonly continuation?: never; readonly nativeBoundary?: never }
  | { readonly continuation: FrameContinuation; readonly call?: never; readonly static?: never; readonly frame?: never; readonly math?: never; readonly check?: never; readonly nativeBoundary?: never }
  | { readonly nativeBoundary: FrameNativeBoundary; readonly continuation?: never; readonly call?: never; readonly static?: never; readonly frame?: never; readonly math?: never; readonly check?: never }
);
export type CallbackFrameOperation =
  | { kind: "seed"; name: string; value: FrameValue }
  | { kind: "argument"; name: string; index: number; type: string; encoding: FrameArgument["encoding"] }
  | ({ kind: "math" } & ExpandedRuntimeMathOperation)
  | { kind: "call"; call: FrameCall; static: boolean }
  | { kind: "frame"; spec: DeclarativeCallbackFrame; math?: BoundRuntimeMath; depth: number; settlement?: FramedSettlementContext }
  | { kind: "continuation" | "continuation-end"; spec: FrameContinuation; context: FramedSettlementContext }
  | { kind: "native-open" | "native-close"; context: FramedSettlementContext }
  | { kind: "native-boundary"; spec: FrameNativeBoundary }
  | { kind: "check"; check: FrameCheck };
export interface CallbackFrameEmitter {
  readonly program: RuntimeAmountProgram;
  take(): number;
  captureNative(name: string): FrameValue;
  capture(name: string, token: string, account: string): FrameValue;
  check(check: FrameCheck): void;
  word(value: FrameValue): { reg: number; temporary: boolean };
  release(value: { reg: number; temporary: boolean }): void;
  call(call: FrameCall, options: { callback: { incomingOffset: number; outgoingOffset: number };
    patches: readonly { offset: number; reg: number }[] }): void;
  compile(operations: readonly CallbackFrameOperation[], seeds: { offset: number; value: FrameValue }[]): RuntimeAmountProgram;
}
const forbidden = new Set(["__proto__", "constructor", "prototype", "amountIn", "frameSelector"]);
function record(value: unknown, required: readonly string[], optional: readonly string[], label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => forbidden.has(key) || !required.includes(key) && !optional.includes(key)))
    throw new Error(`invalid callback frame ${label}`);
}
function name(value: unknown): asserts value is string {
  assertPublicRuntimeCaptureName(value);
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(value) || (forbidden.has(value) || value.startsWith("frame"))) throw new Error("invalid callback capture name");
}
function iface(signature: string) {
  const abi = new Interface([signature]), fs = abi.fragments.filter(f => f.type === "function");
  if (fs.length !== 1) throw new Error("callback frame requires one function");
  return { abi, fn: abi.getFunction(fs[0]!.format("sighash"))! };
}
function scalar(type: ParamType): boolean { return /^(?:u?int(?:[0-9]+)?|address|bool|bytes32)$/.test(type.type); }
function dynamic(type: ParamType): boolean {
  if (type.baseType === "tuple") return type.components!.some(dynamic);
  if (type.baseType === "array") return type.arrayLength === -1 || dynamic(type.arrayChildren!);
  return type.type === "bytes" || type.type === "string";
}
function head(type: ParamType): number {
  if (dynamic(type)) return 32;
  if (type.baseType === "tuple") return type.components!.reduce((n, child) => n + head(child), 0);
  if (type.baseType === "array") return type.arrayLength! * head(type.arrayChildren!);
  return 32;
}
function bytesArgument(signature: string, index: number) {
  const result = iface(signature);
  if (!Number.isSafeInteger(index) || index < 0 || result.fn.inputs[index]?.type !== "bytes")
    throw new Error("callback frame payload must be one bytes argument");
  return result;
}
function dummy(type: ParamType): unknown {
  if (type.type === "address") return "0x0000000000000000000000000000000000000000";
  if (type.type === "bool") return false;
  if (type.type.startsWith("bytes")) return `0x${"00".repeat(Number(type.type.slice(5)))}`;
  return 0n;
}
function payloadOffset(signature: string, index: number, data: string): number {
  const { fn } = bytesArgument(signature, index), bytes = getBytes(data);
  const at = 4 + fn.inputs.slice(0, index).reduce((n, type) => n + head(type), 0);
  const offset = BigInt(hexlify(bytes.slice(at, at + 32)));
  if (offset > BigInt(bytes.length)) throw new Error("callback payload offset bounds");
  const start = 4 + Number(offset) + 32;
  if (start > bytes.length) throw new Error("callback payload bounds");
  return start;
}
function refs(value: unknown, names: ReadonlySet<string>): void {
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "runtime")) {
      record(value, ["runtime"], [], "reference");
      if (typeof value.runtime !== "string" || !names.has(value.runtime)) throw new Error("unknown callback runtime capture");
    } else Object.values(value).forEach(item => refs(item, names));
  }
}
function check(raw: unknown, names: ReadonlySet<string>): void {
  record(raw, ["left", "operator", "right"], [], "check");
  if (!["eq", "gte"].includes(raw.operator)) throw new Error("invalid callback check operator");
  refs([raw.left, raw.right], names);
}
function call(raw: unknown, names: Set<string>, staticCall: boolean, frameCall = false): void {
  record(raw, ["target", "signature", "args", ...(frameCall ? ["dataArgument"] : [])], ["value", "save", "checks"], "call");
  if (typeof raw.target !== "string" || typeof raw.signature !== "string" || !Array.isArray(raw.args) || staticCall && raw.value !== undefined)
    throw new Error("invalid callback call declaration");
  refs([raw.args, raw.value], names);
  if (raw.save !== undefined) {
    if (!raw.save || typeof raw.save !== "object" || Array.isArray(raw.save)) throw new Error("invalid callback call captures");
    const { fn } = iface(raw.signature);
    for (const [capture, index] of Object.entries(raw.save)) {
      name(capture);
      if (names.has(capture) || !Number.isSafeInteger(index) || (index as number) < 0 ||
          (index as number) >= fn.outputs.length || !fn.outputs.every(scalar)) throw new Error("invalid callback return capture");
      names.add(capture);
    }
  }
  if (raw.checks !== undefined && !Array.isArray(raw.checks)) throw new Error("invalid callback call checks");
  raw.checks?.forEach((item: unknown) => check(item, names));
}

/** Structural validation is registration-time and pure. ABI declarations never
 * supply caller authority, byte offsets, register numbers, or executable bytes. */
export function validateDeclarativeCallbackFrame(raw: unknown, depth = 0): asserts raw is DeclarativeCallbackFrame {
  if (depth > 4) throw new Error("callback frame nesting budget");
  record(raw, ["call", "callback"], [], "definition");
  record(raw.call, ["target", "signature", "args", "dataArgument"], ["value", "save", "checks"], "outer call");
  for (const capture of Object.keys(raw.call.save ?? {})) name(capture);
  const outer = bytesArgument(raw.call.signature, raw.call.dataArgument);
  if (!Array.isArray(raw.call.args) || raw.call.args.length !== outer.fn.inputs.length - 1) throw new Error("callback call args must omit payload");
  record(raw.callback, ["signature", "dataArgument", "arguments", "captures", "steps"], ["returns"], "body");
  const cb = raw.callback, incoming = bytesArgument(cb.signature, cb.dataArgument);
  if (incoming.fn.inputs.some((type, index) => index !== cb.dataArgument && !scalar(type))) throw new Error("callback parameters require static scalar fields");
  if (!Array.isArray(cb.arguments) || !cb.captures || typeof cb.captures !== "object" || Array.isArray(cb.captures))
    throw new Error("invalid callback imports");
  const names = new Set<string>(["amountIn"]);
  for (const capture of Object.keys(cb.captures)) { name(capture); if (names.has(capture)) throw new Error("duplicate callback capture"); names.add(capture); }
  const covered = new Set([cb.dataArgument]);
  for (const arg of cb.arguments) {
    record(arg, ["index", "name", "encoding"], ["equals", "minimum", "maximum"], "argument"); name(arg.name);
    if (!Number.isSafeInteger(arg.index) || arg.index < 0 || covered.has(arg.index) || !incoming.fn.inputs[arg.index] || names.has(arg.name))
      throw new Error("duplicate or invalid callback argument");
    const type = incoming.fn.inputs[arg.index]!.type;
    if (!["word", "positive", "negative"].includes(arg.encoding) || /^int/.test(type) === (arg.encoding === "word"))
      throw new Error("callback signed field requires a declared sign");
    if (["address", "bool"].includes(type) && arg.equals === undefined) throw new Error("callback address/bool argument must be bound");
    covered.add(arg.index);
    for (const key of ["equals", "minimum", "maximum"]) if (arg[key] !== undefined) refs(arg[key], names);
    names.add(arg.name);
  }
  if (covered.size !== incoming.fn.inputs.length) throw new Error("every callback field must be declared");
  if (!Array.isArray(cb.steps) || !cb.steps.length || cb.steps.length > 64) throw new Error("callback step budget");
  const ids = new Set<string>();
  for (const step of cb.steps) {
    record(step, ["id"], ["call", "frame", "math", "check", "continuation", "nativeBoundary", "static", "when"], "step"); name(step.id);
    if (ids.has(step.id) || [step.call, step.frame, step.math, step.check, step.continuation, step.nativeBoundary].filter(value => value !== undefined).length !== 1)
      throw new Error("callback step must define one operation");
    ids.add(step.id);
    if (step.when !== undefined && typeof step.when !== "boolean" && typeof step.when !== "string" && typeof step.when !== "object") throw new Error("invalid callback condition");
    if (step.static !== undefined && (step.call === undefined || typeof step.static !== "boolean")) throw new Error("invalid callback static flag");
    if (step.call) call(step.call, names, step.static === true);
    else if (step.frame) {
      // Captures and outer arguments refer only to this frame. The nested body's
      // names are validated in its own invocation-local environment.
      refs(step.frame.callback?.captures, names);
      call(step.frame.call, names, false, true); validateDeclarativeCallbackFrame(step.frame, depth + 1);
    } else if (step.check) check(step.check, names);
    else if (step.continuation) { record(step.continuation, ["debt", "output"], [], "continuation"); refs(step.continuation, names); }
    else if (step.nativeBoundary) {
      if (!["wrap-output", "unwrap-payment"].includes(step.nativeBoundary.kind)) throw new Error("invalid native callback boundary");
      record(step.nativeBoundary, ["kind", ...(step.nativeBoundary.kind === "unwrap-payment" ? ["debt"] : [])], [], "native boundary");
      refs(step.nativeBoundary, names);
    }
    else {
      record(step.math, ["model", "inputs", "outputs"], ["checks"], "math");
      if (typeof step.math.model !== "string" || !step.math.outputs || typeof step.math.outputs !== "object" || Array.isArray(step.math.outputs))
        throw new Error("invalid callback math");
      refs(step.math.inputs, names);
      for (const capture of Object.values(step.math.outputs)) { name(capture); if (names.has(capture)) throw new Error("duplicate callback math capture"); names.add(capture); }
      if (step.math.checks !== undefined && !Array.isArray(step.math.checks)) throw new Error("invalid callback math checks");
      step.math.checks?.forEach((item: unknown) => check(item, names));
    }
  }
  if (cb.returns !== undefined) {
    record(cb.returns, ["types", "values"], [], "return");
    if (!Array.isArray(cb.returns.types) || !Array.isArray(cb.returns.values) || cb.returns.types.length !== cb.returns.values.length)
      throw new Error("invalid callback return ABI");
    const ensureStatic = (value: unknown): void => {
      if (value && typeof value === "object") {
        if (Object.hasOwn(value, "runtime")) throw new Error("callback return must be static ABI data");
        Object.values(value).forEach(ensureStatic);
      }
    };
    ensureStatic(cb.returns.values);
    if (getBytes(AbiCoder.defaultAbiCoder().encode(cb.returns.types, cb.returns.values)).length > 4096) throw new Error("callback return size budget");
  }
}
function runtimeValue(value: FrameValue): bigint | { readonly runtime: string } {
  if (typeof value === "object") return value;
  const n = typeof value === "boolean" ? value ? 1n : 0n : BigInt(value);
  if (typeof value === "number" && !Number.isSafeInteger(value) || n < 0n || n > MaxUint256) throw new Error("callback runtime word bounds");
  return n;
}

function wordKey(value: FrameValue): string {
  const parsed = runtimeValue(value);
  return typeof parsed === "object" ? `runtime:${parsed.runtime}` : `constant:${parsed}`;
}

/** The enclosing call is authenticated by the existing VM frame. The body
 * independently checks selector/arguments; outer conversion effects retain
 * full debit/receipt/native inventory checks. No settlement capability is
 * inferred merely from the existence of a callback. */
export function emitDeclarativeCallbackFrame(spec: DeclarativeCallbackFrame, emit: CallbackFrameEmitter,
  math?: BoundRuntimeMath, depth = 0, settlement?: FramedSettlementContext): void {
  validateDeclarativeCallbackFrame(spec, depth);
  const cb = spec.callback, incoming = bytesArgument(cb.signature, cb.dataArgument);
  const ops: CallbackFrameOperation[] = [];
  const ref = (runtime: string) => ({ runtime });
  const continuations = cb.steps.filter(step => step.continuation !== undefined);
  if (continuations.length > 1 || settlement && (continuations.length !== 1 || cb.steps.some(step => step.frame !== undefined)))
    throw new Error("framed settlement requires one direct callback continuation");
  let opening: { input: FrameValue; output: FrameValue; recipient: FrameValue; native?: FrameValue } | undefined;
  if (settlement) {
    if (depth !== 0 || settlement.request.paymentAmount <= 0n || settlement.request.paymentAmount > MaxUint256)
      throw new Error("invalid framed settlement context");
    if (settlement.native) {
      const boundaries = cb.steps.filter(step => step.nativeBoundary !== undefined);
      const operation = boundaries[0]?.nativeBoundary;
      const continuationAt = cb.steps.indexOf(continuations[0]!), boundaryAt = cb.steps.indexOf(boundaries[0]!);
      if (boundaries.length !== 1 || spec.call.value !== undefined ||
          settlement.native.input && (operation?.kind !== "unwrap-payment" || boundaryAt < continuationAt ||
            wordKey(operation.debt) !== wordKey(continuations[0]!.continuation!.debt) ||
            settlement.recipient.toLowerCase() !== settlement.executor.toLowerCase()) ||
          settlement.native.output && (operation?.kind !== "wrap-output" || boundaryAt > continuationAt))
        throw new Error("native callback boundary must surround its continuation in asset order");
    } else if (cb.steps.some(step => step.nativeBoundary !== undefined && step.when !== false))
      throw new Error("native callback boundary on an ERC20 route");
    opening = {
      input: emit.capture("frameOpeningInput", settlement.tokenIn, settlement.executor),
      output: emit.capture("frameOpeningOutput", settlement.tokenOut, settlement.executor),
      recipient: emit.capture("frameOpeningRecipient", settlement.tokenIn, settlement.recipient),
      ...(settlement.native ? { native: emit.captureNative("frameOpeningNative") } : {}),
    };
    ops.push({ kind: "seed", name: "frameInputBefore", value: opening.input },
      { kind: "seed", name: "frameOutputBefore", value: opening.output },
      { kind: "seed", name: "frameRecipientBefore", value: opening.recipient },
      { kind: "seed", name: "frameExpectedOutput", value: settlement.expectedOutput });
    if (settlement.native) ops.push({ kind: "seed", name: "frameNativeBefore", value: opening.native! },
      { kind: "native-open", context: settlement });
  }
  // Selector capture is internal and cannot be supplied/overwritten by JSON.
  ops.push({ kind: "argument", name: "frameSelector", index: -1, type: "bytes4", encoding: "word" });
  ops.push({ kind: "check", check: { left: ref("frameSelector"), operator: "eq", right: BigInt(incoming.fn.selector) } });
  for (const [name, value] of Object.entries(cb.captures)) ops.push({ kind: "seed", name, value });
  for (const arg of cb.arguments) {
    ops.push({ kind: "argument", name: arg.name, index: arg.index, type: incoming.fn.inputs[arg.index]!.type, encoding: arg.encoding });
    for (const [key, operator] of [["equals", "eq"], ["minimum", "gte"], ["maximum", "gte"]] as const) {
      if (arg[key] === undefined) continue;
      ops.push({ kind: "check", check: { left: key === "maximum" ? arg[key]! : ref(arg.name), operator,
        right: key === "maximum" ? ref(arg.name) : arg[key]! } });
    }
  }
  for (const step of cb.steps) {
    if (step.when !== undefined && typeof step.when !== "boolean") throw new Error("callback condition must resolve to boolean");
    if (step.continuation && !settlement) continue;
    if (step.when === false) {
      if (step.continuation && settlement || step.nativeBoundary && settlement?.native)
        throw new Error("framed continuation/native boundary cannot be skipped");
      continue;
    }
    if (step.call) {
      ops.push({ kind: "call", call: step.call, static: step.static === true });
      step.call.checks?.forEach(check => ops.push({ kind: "check", check }));
    } else if (step.frame) ops.push({ kind: "frame", spec: step.frame, math, depth: depth + 1 });
    else if (step.check) ops.push({ kind: "check", check: step.check });
    else if (step.continuation) {
      ops.push({ kind: "check", check: { left: step.continuation.output, operator: "eq", right: ref("frameExpectedOutput") } });
      for (const constraint of settlement!.constraints) {
        const actual = step.continuation[constraint.actual];
        ops.push({ kind: "check", check: constraint.operator === "lte"
          ? { left: constraint.value, operator: "gte", right: actual }
          : { left: actual, operator: constraint.operator, right: constraint.value } });
      }
      ops.push({ kind: "continuation", spec: step.continuation, context: settlement! });
    }
    else if (step.nativeBoundary) {
      if (!settlement?.native) throw new Error("native callback boundary requires declared deferred native settlement");
      ops.push({ kind: "native-boundary", spec: step.nativeBoundary });
    }
    else if (step.math) {
      if (!math) throw new Error("callback execution math is undefined");
      const inputs = Object.fromEntries(Object.entries(step.math.inputs).map(([name, value]) => [name, runtimeValue(value)]));
      for (const operation of math.expand(step.math.model, inputs, step.math.outputs, `Frame${depth}${step.id}`)) ops.push({ kind: "math", ...operation });
      step.math.checks?.forEach(check => ops.push({ kind: "check", check }));
    }
  }
  if (settlement) ops.push({ kind: "continuation-end", spec: continuations[0]!.continuation!, context: settlement });
  if (settlement?.native) ops.push({ kind: "native-close", context: settlement });
  const seeds: { offset: number; value: FrameValue }[] = [];
  const body = emit.compile(ops, seeds);
  const script = runtimeProgramScript(body.bytes());
  const payload = cb.returns ? concatBytes(script, encodeReturn(getBytes(AbiCoder.defaultAbiCoder().encode(cb.returns.types, cb.returns.values)))) : script;
  const { dataArgument: _, ...outerCall } = spec.call;
  const args = [...spec.call.args]; args.splice(spec.call.dataArgument, 0, hexlify(payload));
  const encoded = encodeDeclarativeCall(spec.call.signature, args);
  const outgoingOffset = payloadOffset(spec.call.signature, spec.call.dataArgument, encoded.data);
  const callbackArgs = incoming.fn.inputs.map((type, index) => index === cb.dataArgument ? hexlify(payload) : dummy(type));
  const incomingOffset = payloadOffset(cb.signature, cb.dataArgument, incoming.abi.encodeFunctionData(incoming.fn, callbackArgs));
  const held = [emit.word(ref("amountIn")), ...seeds.map(seed => emit.word(seed.value))];
  emit.call({ ...outerCall, args }, { callback: { incomingOffset, outgoingOffset }, patches: [
    { offset: outgoingOffset + 1, reg: held[0]!.reg },
    ...seeds.map((seed, index) => ({ offset: outgoingOffset + 36 + seed.offset, reg: held[index + 1]!.reg })),
  ] });
  held.forEach(emit.release);
  if (opening && settlement) {
    // The callee must not consume old actor inventory after callback return.
    emit.check({ left: emit.capture("frameFinalInput", settlement.tokenIn, settlement.executor), operator: "eq", right: opening.input });
    const finalOutput = emit.word(emit.capture("frameFinalOutput", settlement.tokenOut, settlement.executor));
    const before = emit.word(opening.output), expected = emit.word(settlement.expectedOutput), paid = emit.word(settlement.request.paymentAmount);
    const scratch = emit.take();
    emit.program.math("add", scratch, before.reg, expected.reg).math("sub", scratch, scratch, paid.reg).equal(finalOutput.reg, scratch);
    [finalOutput, before, expected, paid, { reg: scratch, temporary: true }].forEach(emit.release);
    if (opening.native !== undefined) emit.check({ left: emit.captureNative("frameFinalNative"), operator: "eq", right: opening.native });
  }
}

const BALANCE = new Interface(["function balanceOf(address) view returns(uint256)"]);
/** A continuation is centrally issued code, never JSON-provided script bytes.
 * Receipt, debt and inventory checks remain here for every declaring Family. */
export function emitCallbackContinuation(program: RuntimeAmountProgram, spec: FrameContinuation,
  context: FramedSettlementContext, emit: Pick<CallbackFrameEmitter, "word" | "release" | "take">, after: boolean): void {
  const held: { reg: number; temporary: boolean }[] = [];
  const word = (value: FrameValue) => { const result = emit.word(value); held.push(result); return result.reg; };
  const temp = () => { const reg = emit.take(); held.push({ reg, temporary: true }); return reg; };
  const debt = word(spec.debt), output = word(spec.output);
  const beforeIn = word({ runtime: "frameInputBefore" }), beforeOut = word({ runtime: "frameOutputBefore" });
  const recipientBefore = word({ runtime: "frameRecipientBefore" });
  const scratch = temp(), other = temp(), amount = word(context.request.paymentAmount);
  const balance = (token: string, account: string, register: number) => program.call(token,
    BALANCE.encodeFunctionData("balanceOf", [account]), { static: true }).load(register, 0);
  if (!after) {
    const one = word(1n), minimum = word(context.minimum > 0n ? context.minimum : 1n);
    program.math("sub", scratch, debt, one).math("sub", scratch, 0, debt)
      .math("sub", scratch, output, minimum).math("sub", scratch, output, amount);
    if (context.fullInput && context.request.paymentInput !== "debt") program.equal(debt, 0);
    balance(context.tokenOut, context.executor, scratch).math("sub", scratch, scratch, beforeOut).equal(scratch, output);
    balance(context.tokenIn, context.executor, scratch).equal(scratch, beforeIn);
    program.run(context.request.paymentProgram, context.request.paymentInput === "debt" ? debt : amount, other).equal(other, debt);
    balance(context.tokenIn, context.recipient, scratch).math("sub", scratch, scratch, recipientBefore).equal(scratch, debt);
  } else {
    // Transfer-to-pool (if needed) belongs to the JSON sequence. It cannot
    // consume inventory or leave an unpaid amount at the receiving account.
    balance(context.tokenIn, context.executor, scratch).math("sub", scratch, scratch, beforeIn);
    balance(context.tokenOut, context.executor, scratch).math("sub", scratch, scratch, beforeOut);
    program.math("sub", other, output, amount).equal(scratch, other);
    if (context.recipient.toLowerCase() !== context.executor.toLowerCase())
      balance(context.tokenIn, context.recipient, scratch).math("sub", scratch, scratch, recipientBefore).equal(scratch, debt);
  }
  held.forEach(emit.release);
}
