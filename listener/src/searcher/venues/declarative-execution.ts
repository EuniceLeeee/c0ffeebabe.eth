import { Interface, MaxUint256, getAddress, hexlify, type ParamType } from "ethers";
import { RuntimeAmountProgram, encodeRuntimeAmountNode } from "../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "./runtime-execution.js";
import { executionNativeSides } from "../execution-asset-boundary.js";
import { encodeDeclarativeCall } from "./declarative-call-codec.js";
import type { BoundRuntimeMath, ExpandedRuntimeMathOperation } from "./declarative-runtime-math.js";
import { emitDeclarativeDeferredExecution, validateDeclarativeDeferredDefinition, type DeclarativeDeferredExecution } from "./declarative-callback.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import { bindFamilyOwnedAction, type FamilyOwnedActionAdapter } from "./family-owned-action.js";

type Value = any;
type Environment = Record<string, Value>;
export interface DeclarationValues {
  evaluate(value: Value, env: Environment): Value;
}
interface SharedConversionExecution {
  readonly settlement: { readonly directOutput: boolean };
  readonly protectedAddresses: Value;
  readonly contextChecks?: readonly { readonly condition: Value; readonly error: string }[];
  readonly requireCanonicalSource?: boolean;
  readonly rejectRuntimeEvidence?: boolean;
  readonly preflight?: readonly Value[];
  readonly effects: readonly Value[];
}
export interface DeclarativeExecutionOptions { readonly math?: BoundRuntimeMath }
export interface DeclarativeQuoteOutput {
  readonly version: 1;
  readonly steps: readonly {
    readonly id: string; readonly call?: Value; readonly static?: true;
    readonly math?: { readonly model: string; readonly inputs: Value; readonly outputs: Record<string, string>; readonly checks?: readonly Check[] };
  }[];
  readonly result: { readonly runtime: string };
}
export type DeclarativeConversionExecution = SharedConversionExecution & (
  | { readonly version: 1; readonly approval?: Value; readonly call: Value; readonly steps?: never }
  | { readonly version: 2; readonly steps: readonly {
      readonly id: string; readonly call?: Value; readonly static?: boolean;
      readonly math?: { readonly model: string; readonly inputs: Value; readonly outputs: Record<string, string>; readonly checks?: readonly Check[] };
      readonly approval?: Value; readonly effects?: readonly Value[];
    }[]; readonly deferred?: Value; readonly quoteOutput?: DeclarativeQuoteOutput; readonly call?: never; readonly approval?: never }
);
type RuntimeValue = bigint | number | string | boolean | { runtime: string };
type Check = { left: RuntimeValue; operator: "eq" | "gte"; right: RuntimeValue };
type Call = {
  target: string; signature: string; args: readonly Value[];
  save?: Record<string, number>; checks?: readonly Check[]; value?: RuntimeValue;
};
type Operation =
  | ({ kind: "math" } & ExpandedRuntimeMathOperation)
  | { kind: "callback"; spec: DeclarativeDeferredExecution; input: Parameters<typeof emitDeclarativeDeferredExecution>[2] }
  | { kind: "call"; call: Call; static: boolean }
  | { kind: "check"; check: Check }
  | { kind: "capture"; name: string; token?: string; account?: string; supply?: boolean; native?: boolean }
  | { kind: "difference"; name: string; left: string; right: string }
  | { kind: "result"; value: RuntimeValue }
  | { kind: "allowance"; token: string; spender: string };

const tokenAbi = new Interface([
  "function balanceOf(address) view returns(uint256)",
  "function totalSupply() view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)",
]);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const interfaces = new Map<string, Interface>();
function callInterface(signature: string): Interface {
  let abi = interfaces.get(signature);
  if (!abi) { abi = new Interface([signature]); interfaces.set(signature, abi); }
  return abi;
}
const reference = (name: string): { runtime: string } => ({ runtime: name });
function keys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => forbidden.has(key) || !allowed.includes(key))) {
    throw new Error(`invalid declared ${label}`);
  }
}
function uint(value: RuntimeValue): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("unsafe declared integer");
  const n = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value as bigint | number | string);
  if (n < 0n || n > MaxUint256) throw new Error("declared runtime word is not uint256");
  return n;
}
function dynamic(value: unknown): value is { runtime: string } {
  return value !== null && typeof value === "object" && Object.hasOwn(value, "runtime");
}
function scalarWord(type: ParamType): boolean {
  return /^(uint[0-9]*|int[0-9]*|address|bool|bytes[0-9]+)$/.test(type.type);
}

/** A quote declaration is data for the shared read-only compiler, never an
 * arbitrary bytecode/script source. Empty module handling belongs to catalog. */
export function validateDeclarativeQuoteOutput(raw: unknown): asserts raw is DeclarativeQuoteOutput {
  keys(raw, ["version", "steps", "result"], "quote output");
  const definition = raw as DeclarativeQuoteOutput;
  if (definition.version !== 1 || !Array.isArray(definition.steps) || !definition.steps.length || definition.steps.length > 64)
    throw new Error("declared quote output steps");
  keys(definition.result, ["runtime"], "quote output result");
  if (typeof definition.result.runtime !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(definition.result.runtime) || forbidden.has(definition.result.runtime))
    throw new Error("declared quote output result");
  const ids = new Set<string>(), captures = new Set<string>(["amountIn"]);
  const save = (name: unknown) => {
    if (typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || forbidden.has(name) || captures.has(name))
      throw new Error("duplicate or invalid quote runtime capture");
    captures.add(name);
  };
  const refs = (value: unknown): void => {
    if (dynamic(value)) {
      keys(value, ["runtime"], "quote runtime reference");
      if (!captures.has(value.runtime)) throw new Error("unknown quote runtime capture");
    } else if (value && typeof value === "object") Object.values(value).forEach(refs);
  };
  for (const step of definition.steps) {
    keys(step, ["id", "call", "static", "math"], "quote output step");
    if (typeof step.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(step.id) || forbidden.has(step.id) || ids.has(step.id))
      throw new Error("duplicate or invalid quote output step id");
    ids.add(step.id);
    if ((step.call !== undefined ? 1 : 0) + (step.math !== undefined ? 1 : 0) !== 1)
      throw new Error("quote output step requires exactly one call or math definition");
    if (step.call !== undefined) {
      if (step.static !== true) throw new Error("quote output calls must be static");
      keys(step.call, ["target", "signature", "args", "save", "checks"], "quote output call");
      if (!["target", "signature", "args"].every(key => Object.hasOwn(step.call, key))) throw new Error("declared quote output call shape");
      refs(step.call.args);
      if (step.call.save !== undefined) {
        if (!step.call.save || typeof step.call.save !== "object" || Array.isArray(step.call.save)) throw new Error("quote output call captures");
        for (const [name, index] of Object.entries(step.call.save)) {
          save(name);
          if (!Number.isSafeInteger(index) || (index as number) < 0) throw new Error("quote output return index");
        }
      }
      refs(step.call.checks);
    } else {
      if (step.static !== undefined) throw new Error("quote output math cannot contain call flags");
      keys(step.math, ["model", "inputs", "outputs", "checks"], "quote output math");
      if (!["model", "inputs", "outputs"].every(key => Object.hasOwn(step.math!, key))) throw new Error("declared quote output math shape");
      if (typeof step.math!.model !== "string" || !step.math!.outputs || typeof step.math!.outputs !== "object" || Array.isArray(step.math!.outputs))
        throw new Error("declared quote output math shape");
      refs(step.math!.inputs);
      Object.values(step.math!.outputs).forEach(save);
      refs(step.math!.checks);
    }
  }
  refs(definition.result);
  if (definition.result.runtime === "amountIn") throw new Error("quote output must be a computed result");
}

/** Lower only static calls and whitelisted arithmetic. Names are local to this
 * quote block, including its return value, so direct execution can inline the
 * same operations without clobbering execution captures or invocation r0. */
function quoteOperations(definition: DeclarativeQuoteOutput, resolved: (value: Value) => Value,
  options: DeclarativeExecutionOptions): { operations: Operation[]; result: { runtime: string } } {
  validateDeclarativeQuoteOutput(definition);
  const operations: Operation[] = [];
  const provenance = new Map<string, { read: boolean; input: boolean }>([["amountIn", { read: false, input: true }]]);
  const name = (value: string) => value === "amountIn" ? value : `quoteLocal${value}`;
  const refs = (value: Value): { read: boolean; input: boolean } => {
    if (dynamic(value)) {
      keys(value, ["runtime"], "quote runtime reference");
      const origin = provenance.get(value.runtime);
      if (!origin) throw new Error(`unknown quote runtime capture ${value.runtime}`);
      return origin;
    }
    const origins = value && typeof value === "object" ? Object.values(value).map(refs) : [];
    return { read: origins.some(origin => origin.read), input: origins.some(origin => origin.input) };
  };
  const rename = (value: Value): Value => dynamic(value) ? reference(name(value.runtime)) : Array.isArray(value)
    ? value.map(rename) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rename(item)])) : value;
  const save = (capture: string, origin: { read: boolean; input: boolean }) => {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(capture) || forbidden.has(capture) || provenance.has(capture))
      throw new Error("duplicate or invalid quote runtime capture");
    provenance.set(capture, origin);
  };
  const checks = (items: Value) => {
    if (items !== undefined && !Array.isArray(items)) throw new Error("quote output checks must be an array");
    for (const item of items ?? []) { refs(item); operations.push({ kind: "check", check: rename(item) }); }
  };
  for (const step of definition.steps) {
    if (step.call !== undefined) {
      const call = resolved(step.call) as Call;
      keys(call, ["target", "signature", "args", "save", "checks"], "quote output call");
      // Runtime references are ABI input words, never targets or signatures.
      if (typeof call.target !== "string" || typeof call.signature !== "string" || !Array.isArray(call.args))
        throw new Error("declared quote output call shape");
      const origin = refs(call.args);
      const saved = Object.entries(call.save ?? {});
      for (const [capture] of saved) save(capture, { read: true, input: origin.input });
      operations.push({ kind: "call", static: true, call: { ...call, args: rename(call.args), checks: undefined,
        save: Object.fromEntries(saved.map(([capture, offset]) => [name(capture), offset])) } });
      checks(call.checks);
    } else {
      if (!options.math) throw new Error("runtime math module is undefined");
      const math = resolved(step.math);
      const inputs = Object.fromEntries(Object.entries(math.inputs).map(([key, value]) =>
        [key, dynamic(value) ? value : uint(value as RuntimeValue)]));
      // Even an injected math registry cannot add a CALL/value/approval opcode.
      for (const operation of options.math.expand(math.model, inputs, math.outputs, `Quote${step.id}Math`)) {
        keys(operation, ["name", "op", "left", "right"], "quote runtime math operation");
        if (!["add", "sub", "mul", "div", "shr", "and", "min", "eq"].includes(operation.op))
          throw new Error("quote output arithmetic operation");
        const origin = refs([operation.left, operation.right]);
        save(operation.name, origin);
        operations.push({ kind: "math", name: name(operation.name), op: operation.op,
          left: rename(operation.left), right: rename(operation.right) });
      }
      checks(math.checks);
    }
  }
  const origin = refs(definition.result);
  if (!origin.read || !origin.input) throw new Error("quote output must derive from chain reads and actual input");
  const result = reference(name(definition.result.runtime));
  operations.push({ kind: "check", check: { left: result, operator: "gte", right: 1n } });
  return { operations, result };
}

export function assertDeclarativeExecutionSource(value: unknown): asserts value is CanonicalSource {
  const source = value as CanonicalSource | undefined;
  if (!source || !Number.isSafeInteger(source.number) || source.number < 0 ||
      !Number.isSafeInteger(source.generation) || source.generation < 0 || !/^0x[0-9a-fA-F]{64}$/.test(source.hash)) {
    throw new Error("declared execution requires canonical source");
  }
}

/** Compile the shared conversion lifecycle, not a Family-provided program.
 * JSON describes calls, permissions and effects. Registers, input patching,
 * allowance sequencing and before/after checks are owned here. */
export function buildDeclarativeExecutionProgram(
  definition: DeclarativeConversionExecution,
  input: Environment,
  values: DeclarationValues,
  options: DeclarativeExecutionOptions = {},
): RuntimeAmountProgram {
  keys(definition, ["version", "settlement", "protectedAddresses", "contextChecks", "requireCanonicalSource", "rejectRuntimeEvidence", "preflight", "approval", "call", "steps", "deferred", "quoteOutput", "effects"], "execution definition");
  if (definition.version !== 1 && definition.version !== 2) throw new Error("unsupported declared execution version");
  if (definition.version === 1 && (Object.hasOwn(definition, "steps") || Object.hasOwn(definition, "deferred") || Object.hasOwn(definition, "quoteOutput")) || definition.version === 2 &&
      (Object.hasOwn(definition, "call") || Object.hasOwn(definition, "approval"))) throw new Error("mixed execution versions");
  if (definition.version === 2 && (!Array.isArray(definition.steps) || !definition.steps.length))
    throw new Error("declared execution steps must be nonempty");
  function rejectQuotedAmounts(value: unknown): void {
    if (typeof value === "string" && /^\$(amountIn|quotedAmountOut|exactEvidence)(\.|$)/.test(value)) {
      throw new Error("execution declarations must use invocation-local runtime amounts");
    }
    if (value && typeof value === "object") Object.values(value).forEach(rejectQuotedAmounts);
  }
  rejectQuotedAmounts(definition);
  keys(definition.settlement, ["directOutput"], "settlement");
  if (typeof definition.settlement.directOutput !== "boolean") throw new Error("declared settlement capability");
  const request = input.settlement;
  if (!supportsDeclarativeSettlement(definition, input)) throw new Error("unsupported declared settlement request");
  const deferred = request?.kind === "deferred-input";
  const recipient = request?.recipient ?? input.recipient ?? input.executor;
  const minAmountOut = input.minAmountOut === undefined ? 1n : uint(input.minAmountOut);
  const context = executionContext(input);
  const env = { ...context, recipient, minAmountOut, directSettlement: input.settlementRequested === true || request !== undefined,
    externalRecipient: String(recipient).toLowerCase() !== String(input.executor).toLowerCase() };
  for (const check of definition.contextChecks ?? []) {
    keys(check, ["condition", "error"], "execution context check");
    if (values.evaluate(check.condition, env) !== true) throw new Error(check.error);
  }
  const protectedAddresses = values.evaluate(definition.protectedAddresses, env);
  if (!Array.isArray(protectedAddresses)) throw new Error("declared protected addresses");
  runtimeExecutor(input.executor, ...protectedAddresses);
  runtimeExecutor(recipient, ...protectedAddresses);
  if (definition.requireCanonicalSource) assertDeclarativeExecutionSource(input.source);
  if (definition.rejectRuntimeEvidence && input.runtimeEvidence?.length) throw new Error("declared pending execution unsupported");
  const operations: Operation[] = [];
  const resolved = (value: Value) => values.evaluate(value, env);
  const addCall = (call: Call, isStatic: boolean) => {
    keys(call, ["target", "signature", "args", "save", "checks", "when", ...(definition.version === 2 ? ["value"] : [])], "call");
    if (isStatic && call.value !== undefined) throw new Error("static declared calls cannot send value");
    operations.push({ kind: "call", call, static: isStatic });
    for (const check of call.checks ?? []) operations.push({ kind: "check", check });
  };
  const check = (left: RuntimeValue, operator: Check["operator"], right: RuntimeValue) =>
    operations.push({ kind: "check", check: { left, operator, right } });
  // Zero debit cannot masquerade as a successful conversion, in either mode.
  check(reference("amountIn"), "gte", 1n);
  const quote = definition.version === 2 && definition.quoteOutput &&
    (request?.kind === "quote-output" || request?.kind === "direct-output")
    ? quoteOperations(definition.quoteOutput, resolved, options) : undefined;
  if (quote) operations.push(...quote.operations);
  if (request?.kind === "quote-output") {
    if (!quote) throw new Error("declared quote output unavailable");
    operations.push({ kind: "result", value: quote.result });
    return emit(operations, 2);
  }
  for (const declaration of definition.preflight ?? []) {
    const call = resolved(declaration);
    if (call.when === undefined || call.when) addCall(call, true);
  }
  if (!Array.isArray(definition.effects)) throw new Error("declared effects must be an array");
  const effects = definition.effects.map(resolved).filter(effect => effect.when === undefined || effect.when);
  const debit = effects.filter(effect => effect.kind === "debit");
  const credit = effects.filter(effect => effect.kind === "credit");
  const same = (a: string, b: string) => getAddress(a) === getAddress(b);
  const native = definition.version === 2 ? executionNativeSides(input.route) : null;
  // Sending value is a shared operation; a token-only route cannot subsidize
  // it from native inventory even if the JSON omits an unchanged-native row.
  if (definition.version === 2 && !native && !effects.some(effect => effect.kind === "unchanged-native"))
    effects.push({ kind: "unchanged-native" });
  const bindsAsset = (effect: Value, side: "input" | "output") => native?.[side]
    ? effect.asset === "native" && effect.token === undefined
    : effect.asset !== "native" && same(effect.token, side === "input" ? input.route.tokenIn : input.route.tokenOut);
  const fullInput = debit.length === 1 && dynamic(debit[0].equals) && debit[0].equals.runtime === "amountIn";
  const budgetInput = definition.version === 2 && debit.length === 1 && debit[0].equals === undefined &&
    dynamic(debit[0].maximum) && debit[0].maximum.runtime === "amountIn";
  if (debit.length !== 1 || credit.length !== 1 || !bindsAsset(debit[0], "input") ||
      !same(debit[0].account, input.executor) || !(fullInput || budgetInput) ||
      !bindsAsset(credit[0], "output") || !same(credit[0].account, recipient)) {
    throw new Error("declared conversion must bind full debit or bounded budget and fresh receipt to the route");
  }
  if (quote && !fullInput) throw new Error("quoted direct output requires exact actual input debit");
  // The direct path cannot settle a short receipt out of old inventory, or
  // return a cross-asset rebate to either party. These guards are shared and
  // mandatory even if the declaration omitted them.
  if (quote && env.externalRecipient) {
    for (const [token, account] of [[input.route.tokenIn, recipient], [input.route.tokenOut, input.executor]]) {
      if (!effects.some(effect => effect.kind === "unchanged-token" && same(effect.token, token) && same(effect.account, account)))
        effects.push({ kind: "unchanged-token", token, account });
    }
  }
  function validateEffect(effect: Value) {
      keys(effect, ["kind", "token", "account", "direction", "equals", "minimum", "when",
        ...(definition.version === 2 ? ["asset", "maximum"] : [])], "effect");
      if (!["debit", "credit", "supply", "unchanged-token", "unchanged-native"].includes(effect.kind)) throw new Error("unknown declared effect");
      if (effect.asset !== undefined && !["erc20", "native"].includes(effect.asset)) throw new Error("declared effect asset");
      if (effect.asset === "native" && (effect.token !== undefined || !same(effect.account, input.executor) ||
          !["debit", "credit", "unchanged-native"].includes(effect.kind))) throw new Error("native effects require executor balance");
  }
  effects.forEach(validateEffect);
  function captureEffects(items: readonly Value[], prefix: string) {
    for (const [index, effect] of items.entries()) {
      validateEffect(effect);
      operations.push({ kind: "capture", name: `${prefix}${index}Before`, token: effect.token, account: effect.account,
        supply: effect.kind === "supply", native: effect.kind === "unchanged-native" || effect.asset === "native" });
    }
  }
  function assertEffects(items: readonly Value[], prefix: string, routeEffects: boolean) {
    for (const [index, effect] of items.entries()) {
      const before = `${prefix}${index}Before`, after = `${prefix}${index}After`, delta = `${prefix}${index}Delta`;
      operations.push({ kind: "capture", name: after, token: effect.token, account: effect.account,
        supply: effect.kind === "supply", native: effect.kind === "unchanged-native" || effect.asset === "native" });
      if (effect.kind.startsWith("unchanged-")) { check(reference(after), "eq", reference(before)); continue; }
      const increase = effect.kind === "credit" || effect.kind === "supply" && effect.direction === "increase";
      if (effect.kind === "supply" && !["increase", "decrease"].includes(effect.direction)) throw new Error("declared supply direction");
      operations.push({ kind: "difference", name: delta, left: increase ? after : before, right: increase ? before : after });
      if (effect.kind === "credit") check(reference(delta), "gte", routeEffects && minAmountOut > 0n ? minAmountOut : 1n);
      if (effect.kind === "debit" && definition.version === 2) check(reference(delta), "gte", 1n);
      if (effect.equals !== undefined) check(reference(delta), "eq", effect.equals);
      if (effect.maximum !== undefined) check(effect.maximum, "gte", reference(delta));
      if (effect.minimum !== undefined && (!routeEffects || effect.minimum !== minAmountOut)) check(reference(delta), "gte", effect.minimum);
    }
  }
  const measuredEffects = deferred ? effects.filter(effect => !["debit", "credit"].includes(effect.kind)) : effects;
  captureEffects(measuredEffects, "effect");
  function addStep(call: Value, declaredApproval: Value | undefined, isStatic = false) {
    const rawApproval = declaredApproval === undefined ? undefined : resolved(declaredApproval);
    if (rawApproval) keys(rawApproval, ["token", "spender", "mode", "requireBool", "verifyAllowance", "when",
      ...(definition.version === 2 ? ["amount"] : [])], "approval");
    const approval = rawApproval && (rawApproval.when === undefined || rawApproval.when) ? rawApproval : undefined;
    if (isStatic && approval) throw new Error("static declared step cannot approve");
    const approvedAmount = approval?.amount ?? reference("amountIn");
    const approvalCall = (actual: boolean) => {
      if (!approval) return;
      const amount: RuntimeValue = actual ? approvedAmount : 0n;
      addCall({ target: approval.token, signature: "function approve(address,uint256) returns(bool)",
        args: [approval.spender, amount], ...(approval.requireBool ? { save: { approvalResult: 0 },
          checks: [{ left: reference("approvalResult"), operator: "eq", right: true }] } : {}) }, false);
      if (approval.verifyAllowance) addCall({ target: approval.token,
        signature: "function allowance(address,address) view returns(uint256)", args: [input.executor, approval.spender],
        save: { allowanceResult: 0 }, checks: [{ left: reference("allowanceResult"), operator: "eq", right: amount }] }, true);
    };
    if (approval) {
      if (approval.mode === "ensure") {
        if (approval.amount !== undefined) throw new Error("explicit approval amount requires exact-clear policy");
        operations.push({ kind: "allowance", token: approval.token, spender: approval.spender });
      } else if (approval.mode === "exact-clear") { approvalCall(false); approvalCall(true); }
      else throw new Error("unknown declared approval mode");
    }
    addCall(resolved(call), isStatic);
    if (approval?.mode === "exact-clear") approvalCall(false);
  }
  if (definition.version === 1) addStep(definition.call, definition.approval);
  else {
    const ids = new Set<string>(), saves = new Set<string>();
    function validateSaves(call: Value) {
      for (const name of Object.keys(resolved(call).save ?? {})) {
        if (saves.has(name) || /^(?:effect|stepEffect)[0-9]+/.test(name) || quote && name.startsWith("quoteLocal") || ["approvalResult", "allowanceResult"].includes(name))
          throw new Error("duplicate or reserved runtime capture");
        saves.add(name);
      }
    }
    const callback = definition.deferred === undefined ? undefined : resolved(definition.deferred) as DeclarativeDeferredExecution;
    if (callback && callback.stepId !== definition.steps[definition.steps.length - 1]?.id)
      throw new Error("deferred callback must replace the terminal step");
    for (const call of definition.preflight ?? []) validateSaves(call);
    for (const [index, step] of definition.steps.entries()) {
      keys(step, ["id", "call", "math", "static", "approval", "effects"], "execution step");
      if (typeof step.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(step.id) || forbidden.has(step.id) || ids.has(step.id))
        throw new Error("duplicate or invalid execution step id");
      ids.add(step.id);
      if ((step.call !== undefined ? 1 : 0) + (step.math !== undefined ? 1 : 0) !== 1)
        throw new Error("execution step requires exactly one call or math definition");
      if (step.math !== undefined) {
        keys(step.math, ["model", "inputs", "outputs", "checks"], "runtime math step");
        if (step.approval !== undefined || step.effects !== undefined || step.static !== undefined)
          throw new Error("runtime math step cannot contain calls or effects");
        if (!options.math) throw new Error("runtime math module is undefined");
        const math = resolved(step.math);
        const inputs = Object.fromEntries(Object.entries(math.inputs).map(([key, value]) =>
          [key, dynamic(value) ? value : uint(value as RuntimeValue)]));
        const operationsForStep = options.math.expand(math.model, inputs, math.outputs, `${step.id}Math`);
        for (const operation of operationsForStep) {
          if (saves.has(operation.name) || /^(?:effect|stepEffect)[0-9]+/.test(operation.name) || quote && operation.name.startsWith("quoteLocal") ||
              ["amountIn", "approvalResult", "allowanceResult"].includes(operation.name)) throw new Error("duplicate or reserved runtime math capture");
          saves.add(operation.name); operations.push({ kind: "math", ...operation });
        }
        if (math.checks !== undefined && !Array.isArray(math.checks)) throw new Error("runtime math checks must be an array");
        for (const constraint of math.checks ?? []) operations.push({ kind: "check", check: constraint });
        continue;
      }
      const activeCall = deferred && callback?.stepId === step.id ? callback.call : step.call;
      validateSaves(activeCall);
      if (resolved(activeCall).when !== undefined) throw new Error("execution step calls cannot silently skip on when");
      if (step.static !== undefined && typeof step.static !== "boolean") throw new Error("invalid execution step static flag");
      if (step.effects !== undefined && !Array.isArray(step.effects)) throw new Error("step effects must be an array");
      if (deferred) {
        if (callback?.stepId === step.id) {
          if (step.static || step.effects?.length) throw new Error("terminal deferred step requires its dedicated callback invariants");
          operations.push({ kind: "callback", spec: callback, input: { executor: input.executor, route: input.route,
            settlement: request, fullInput: !budgetInput } });
          // These are gross route effects: the authenticated callback proves
          // exact fresh output and exact paid debt before/after its continuation.
          // Retain every declared bound even though net balances include that
          // continuation's output consumption and input acquisition.
          check(callback.callback.expectedOutput, "gte", minAmountOut > 0n ? minAmountOut : 1n);
          for (const [effect, actual] of [[debit[0], callback.callback.expectedDebt], [credit[0], callback.callback.expectedOutput]] as const) {
            if (effect.equals !== undefined) check(actual, "eq", effect.equals);
            if (effect.minimum !== undefined) check(actual, "gte", effect.minimum);
            if (effect.maximum !== undefined) check(effect.maximum, "gte", actual);
          }
          continue;
        }
        if (step.static !== true || step.approval !== undefined || step.effects?.length)
          throw new Error("deferred preparation must be read-only calls or math");
      }
      const stepEffects = (step.effects ?? []).map(resolved).filter(effect => effect.when === undefined || effect.when);
      captureEffects(stepEffects, `stepEffect${index}X`);
      addStep(step.call, step.approval, step.static === true);
      assertEffects(stepEffects, `stepEffect${index}X`, false);
    }
  }
  assertEffects(measuredEffects, "effect", true);
  if (quote) check(reference(`effect${effects.indexOf(credit[0])}Delta`), "eq", quote.result);
  return emit(operations, definition.version);
}

function emit(operations: readonly Operation[], version: 1 | 2): RuntimeAmountProgram {
  const program = new RuntimeAmountProgram().constant(14, 0n).constant(15, 1n);
  const slots = new Map<string, number>([["amountIn", 0]]);
  const used = new Set<number>([0, 14, 15]);
  function take(): number {
    for (let n = 1; n < 16; n++) if (!used.has(n)) { used.add(n); return n; }
    throw new Error("declared execution exceeds register budget");
  }
  function save(name: string): number {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || name === "amountIn" || forbidden.has(name)) throw new Error("invalid runtime capture name");
    const prior = slots.get(name);
    if (prior !== undefined) return prior;
    const reg = take(); slots.set(name, reg); return reg;
  }
  function word(value: RuntimeValue): { reg: number; temporary: boolean } {
    if (dynamic(value)) {
      keys(value, ["runtime"], "runtime reference");
      const reg = slots.get(value.runtime);
      if (reg === undefined) throw new Error(`unknown runtime capture ${value.runtime}`);
      return { reg, temporary: false };
    }
    const n = uint(value);
    if (n === 0n || n === 1n) return { reg: n === 0n ? 14 : 15, temporary: false };
    const reg = take(); program.constant(reg, n); return { reg, temporary: true };
  }
  const release = (item: { reg: number; temporary: boolean }) => { if (item.temporary) used.delete(item.reg); };
  function call(input: Call, isStatic: boolean, extra?: {
    callback: { incomingOffset: number; outgoingOffset: number };
    patches: readonly { offset: number; reg: number }[];
  }): void {
    const abi = callInterface(input.signature), fragment = abi.fragments.find(item => item.type === "function");
    if (!fragment || fragment.type !== "function") throw new Error("declared call requires one function");
    const fn = abi.getFunction(fragment.format("sighash"));
    if (!fn || !Array.isArray(input.args) || fn.inputs.length !== input.args.length) throw new Error("declared call arguments");
    const patches: { offset: number; reg: number }[] = [], temporaries: { reg: number; temporary: boolean }[] = [];
    // v1 retains its original static-word encoding byte for byte. v2 derives
    // nested static/dynamic ABI leaf positions using the shared ABI codec.
    const args = version === 2 ? [] : input.args.map((value, index) => {
      if (!dynamic(value)) return value;
      if (!fn.inputs.every(scalarWord)) throw new Error("dynamic runtime ABI arguments require a declared tuple encoder");
      const item = word(value); temporaries.push(item); patches.push({ offset: 4 + index * 32, reg: item.reg });
      const type = fn.inputs[index]!.type;
      return type === "address" ? "0x0000000000000000000000000000000000000000" : type === "bool" ? false : 0n;
    });
    const encoded = version === 2 ? encodeDeclarativeCall(input.signature, input.args) : undefined;
    for (const patch of encoded?.patches ?? []) {
      const item = word(reference(patch.reference)); temporaries.push(item); patches.push({ offset: patch.offset, reg: item.reg });
    }
    const value = input.value === undefined ? undefined : word(input.value);
    if (value) temporaries.push(value);
    program.call(getAddress(input.target), encoded?.data ?? abi.encodeFunctionData(fn, args),
      { static: isStatic, patches: [...patches, ...(extra?.patches ?? [])], ...(value ? { valueReg: value.reg } : {}),
        ...(extra ? { callback: extra.callback } : {}) });
    temporaries.forEach(release);
    for (const [name, index] of Object.entries(input.save ?? {})) {
      if (/^(?:effect[0-9]+|stepEffect[0-9]+X[0-9]+)(?:Before|After|Delta)$/.test(name)) throw new Error("reserved effect capture name");
      if (!Number.isSafeInteger(index) || index < 0 || index >= fn.outputs.length || !fn.outputs.every(scalarWord)) throw new Error("declared return word");
      program.load(save(name), index * 32);
    }
  }
  function references(value: unknown, found = new Set<string>()): Set<string> {
    if (dynamic(value)) found.add(value.runtime);
    if (value && typeof value === "object") Object.values(value).forEach(item => references(item, found));
    return found;
  }
  function emitCheck(check: Check): void {
    keys(check, ["left", "operator", "right"], "check");
    const left = word(check.left), right = word(check.right);
    if (check.operator === "eq") program.equal(left.reg, right.reg);
    else if (check.operator === "gte") { const reg = take(); program.math("sub", reg, left.reg, right.reg); used.delete(reg); }
    else throw new Error("unknown declared runtime comparison");
    release(left); release(right);
  }
  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "call") call(operation.call, operation.static);
    else if (operation.kind === "math") {
      const left = word(operation.left), right = word(operation.right);
      program.math(operation.op, save(operation.name), left.reg, right.reg);
      release(left); release(right);
    } else if (operation.kind === "callback") {
      emitDeclarativeDeferredExecution(program, operation.spec, operation.input,
        { word, release, take, call: (declaration, extra) => call(declaration, false, extra), check: emitCheck });
    }
    else if (operation.kind === "result") {
      const value = word(operation.value);
      program.math("add", 0, value.reg, 14); release(value);
    }
    else if (operation.kind === "allowance") program.allowance(operation.token, operation.spender, 0, MaxUint256);
    else if (operation.kind === "capture") {
      const reg = save(operation.name);
      if (operation.native) program.nativeBalance(reg);
      else {
        const name = operation.supply ? "totalSupply" : "balanceOf";
        program.call(getAddress(operation.token!), tokenAbi.encodeFunctionData(name, operation.supply ? [] : [operation.account]), { static: true }).load(reg, 0);
      }
    } else if (operation.kind === "difference") {
      const left = word(reference(operation.left)), right = word(reference(operation.right));
      program.math("sub", save(operation.name), left.reg, right.reg);
    } else emitCheck(operation.check);
    const needed = references(operations.slice(index + 1));
    for (const remaining of operations.slice(index + 1)) if (remaining.kind === "difference") { needed.add(remaining.left); needed.add(remaining.right); }
    for (const [name, reg] of slots) if (reg !== 0 && !needed.has(name)) { slots.delete(name); used.delete(reg); }
  }
  return program;
}

function executionContext(input: Environment, runtime = false): Environment {
  const omitted = new Set(["amountIn", "quotedAmountOut", "exactEvidence", ...(runtime ? ["minAmountOut"] : [])]);
  const result: Environment = {};
  for (const key of Object.keys(input)) {
    if (omitted.has(key)) continue;
    const property = Object.getOwnPropertyDescriptor(input, key)!;
    if (!("value" in property)) throw new Error("execution context must contain data fields");
    result[key] = property.value;
  }
  return result;
}

/** Both entry points below call the same compiler. Runtime input stays in r0;
 * quoted execution supplies the fixed input to the exact same program. */
/** The compiler has already checked the corresponding actual balance delta.
 * Expose the same budget declaration to the existing flow composer. */
export function declarativeInputMode(definition: DeclarativeConversionExecution, input: Environment, values: DeclarationValues): "maximum" | undefined {
  if (definition.version !== 2) return undefined;
  const recipient = input.settlement?.recipient ?? input.recipient ?? input.executor;
  const env = { ...executionContext(input, true), recipient, minAmountOut: 1n,
    directSettlement: input.settlementRequested === true || input.settlement !== undefined,
    externalRecipient: String(recipient).toLowerCase() !== String(input.executor).toLowerCase() };
  const debit = definition.effects.map(effect => values.evaluate(effect, env))
    .filter(effect => effect.kind === "debit" && (effect.when === undefined || effect.when));
  return debit.length === 1 && debit[0].equals === undefined && dynamic(debit[0].maximum) &&
    debit[0].maximum.runtime === "amountIn" ? "maximum" : undefined;
}
function validateSettlementDeclaration(definition: DeclarativeConversionExecution): void {
  keys(definition.settlement, ["directOutput"], "settlement");
  if (typeof definition.settlement.directOutput !== "boolean") throw new Error("declared settlement capability");
  if (definition.version === 2 && definition.deferred !== undefined)
    validateDeclarativeDeferredDefinition(definition.deferred, definition.steps);
  if (definition.version === 2 && definition.quoteOutput !== undefined) validateDeclarativeQuoteOutput(definition.quoteOutput);
}
export function supportsDeclarativeSettlement(definition: DeclarativeConversionExecution, input: Environment): boolean {
  validateSettlementDeclaration(definition);
  if (!input.settlement) return true;
  if (input.settlement.kind === "quote-output") return definition.version === 2 && definition.quoteOutput !== undefined &&
    !executionNativeSides(input.route);
  if (input.settlement.kind === "direct-output") return definition.settlement.directOutput &&
    (!(definition.version === 2 && definition.quoteOutput) || !executionNativeSides(input.route)) &&
    (!executionNativeSides(input.route)?.output || getAddress(input.settlement.recipient) === getAddress(input.executor));
  return input.settlement.kind === "deferred-input" && definition.version === 2 && definition.deferred !== undefined &&
    !executionNativeSides(input.route) && input.settlement.paymentInput === undefined &&
    getAddress(input.settlement.recipient ?? input.recipient ?? input.executor) === getAddress(input.executor);
}
export function declarativeSettlementCapabilities(definition: DeclarativeConversionExecution, input: Environment) {
  validateSettlementDeclaration(definition);
  return { ...(definition.settlement.directOutput && !executionNativeSides(input.route)?.output &&
      (!(definition.version === 2 && definition.quoteOutput) || !executionNativeSides(input.route)) ? { directOutput: true as const } : {}),
    ...(definition.version === 2 && definition.quoteOutput !== undefined && !executionNativeSides(input.route) ? { quoteOutput: true as const } : {}),
    ...(definition.version === 2 && definition.deferred !== undefined && !executionNativeSides(input.route)
      ? { deferredInput: getAddress(input.executor) } : {}) };
}
export function buildDeclarativeRuntimeLeg(definition: DeclarativeConversionExecution, input: Environment, values: DeclarationValues,
  options: DeclarativeExecutionOptions = {}) {
  if (!supportsDeclarativeSettlement(definition, input)) return null;
  const inputMode = input.settlement?.kind === "quote-output" ? undefined : declarativeInputMode(definition, input, values);
  return { ...runtimeLeg(input.route.adapterId, buildDeclarativeExecutionProgram(definition, { ...executionContext(input, true), minAmountOut: 1n }, values, options)),
    ...(inputMode ? { inputMode } : {}),
    settlement: declarativeSettlementCapabilities(definition, input),
    ...(input.settlement ? { settlementRequest: input.settlement } : {}) };
}
export function buildDeclarativeQuotedFragment(definition: DeclarativeConversionExecution, input: Environment, values: DeclarationValues,
  options: DeclarativeExecutionOptions = {}) {
  if (input.settlement?.kind === "quote-output") throw new Error("quote output is a runtime preparation, not quoted execution");
  if (uint(input.amountIn) === 0n) throw new Error("declared quoted input must be positive");
  const program = buildDeclarativeExecutionProgram(definition, input, values, options);
  return { requirements: [], nodes: [{ adapterId: input.route.adapterId, target: input.route.target,
    tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
    params: { runtimeAmountProgram: hexlify(program.bytes()) }, children: [] }] };
}
export function createDeclarativeProgramAction(
  descriptor: FamilyOwnedActionAdapter["descriptor"],
  traceCalls: readonly { signature: string; target?: string }[],
): FamilyOwnedActionAdapter {
  const traces = traceCalls.map(item => {
    const abi = callInterface(item.signature);
    const fragment = abi.fragments.find(part => part.type === "function");
    if (!fragment) throw new Error("declared trace call function");
    return { target: item.target?.toLowerCase(), selector: abi.getFunction(fragment.format("sighash"))!.selector.toLowerCase() };
  });
  return bindFamilyOwnedAction({ descriptor, action: {
    id: descriptor.adapterId, isWrapper: false, field2Offset: null,
    matchTrace: (target, selector) => traces.some(item => item.selector === selector.toLowerCase() &&
      (item.target === undefined || item.target === target.toLowerCase())),
    encode(node, _executor, inner) {
      if (node.adapterId !== descriptor.adapterId || Object.keys(node.params).length !== 1) throw new Error("declared quoted node adapter mismatch");
      const script = encodeRuntimeAmountNode(node, inner);
      if (script === null) throw new Error("declared quoted node has no program");
      return script;
    },
  } });
}
