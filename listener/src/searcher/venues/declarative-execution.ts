import { Interface, MaxUint256, getAddress, hexlify, type ParamType } from "ethers";
import { RuntimeAmountProgram, encodeRuntimeAmountNode } from "../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "./runtime-execution.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import { bindFamilyOwnedAction, type FamilyOwnedActionAdapter } from "./family-owned-action.js";

type Value = any;
type Environment = Record<string, Value>;
export interface DeclarationValues {
  evaluate(value: Value, env: Environment): Value;
}
export interface DeclarativeConversionExecution {
  readonly version: 1;
  readonly settlement: { readonly directOutput: boolean };
  readonly protectedAddresses: Value;
  readonly contextChecks?: readonly { readonly condition: Value; readonly error: string }[];
  readonly requireCanonicalSource?: boolean;
  readonly rejectRuntimeEvidence?: boolean;
  readonly preflight?: readonly Value[];
  readonly approval?: Value;
  readonly call: Value;
  readonly effects: readonly Value[];
}
type RuntimeValue = bigint | number | string | boolean | { runtime: string };
type Check = { left: RuntimeValue; operator: "eq" | "gte"; right: RuntimeValue };
type Call = {
  target: string; signature: string; args: readonly Value[];
  save?: Record<string, number>; checks?: readonly Check[];
};
type Operation =
  | { kind: "call"; call: Call; static: boolean }
  | { kind: "check"; check: Check }
  | { kind: "capture"; name: string; token?: string; account?: string; supply?: boolean; native?: boolean }
  | { kind: "difference"; name: string; left: string; right: string }
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
): RuntimeAmountProgram {
  keys(definition, ["version", "settlement", "protectedAddresses", "contextChecks", "requireCanonicalSource", "rejectRuntimeEvidence", "preflight", "approval", "call", "effects"], "execution definition");
  if (definition.version !== 1) throw new Error("unsupported declared execution version");
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
  if (request && (request.kind !== "direct-output" || !definition.settlement.directOutput)) {
    throw new Error("unsupported declared settlement request");
  }
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
    keys(call, ["target", "signature", "args", "save", "checks", "when"], "call");
    operations.push({ kind: "call", call, static: isStatic });
    for (const check of call.checks ?? []) operations.push({ kind: "check", check });
  };
  const check = (left: RuntimeValue, operator: Check["operator"], right: RuntimeValue) =>
    operations.push({ kind: "check", check: { left, operator, right } });
  // Zero debit cannot masquerade as a successful conversion, in either mode.
  check(reference("amountIn"), "gte", 1n);
  for (const declaration of definition.preflight ?? []) {
    const call = resolved(declaration);
    if (call.when === undefined || call.when) addCall(call, true);
  }
  if (!Array.isArray(definition.effects)) throw new Error("declared effects must be an array");
  const effects = definition.effects.map(resolved).filter(effect => effect.when === undefined || effect.when);
  const debit = effects.filter(effect => effect.kind === "debit");
  const credit = effects.filter(effect => effect.kind === "credit");
  const same = (a: string, b: string) => getAddress(a) === getAddress(b);
  if (debit.length !== 1 || credit.length !== 1 ||
      !same(debit[0].token, input.route.tokenIn) || !same(debit[0].account, input.executor) ||
      !dynamic(debit[0].equals) || debit[0].equals.runtime !== "amountIn" ||
      !same(credit[0].token, input.route.tokenOut) || !same(credit[0].account, recipient)) {
    throw new Error("declared conversion must bind full debit and fresh receipt to the route");
  }
  for (const [index, effect] of effects.entries()) {
    keys(effect, ["kind", "token", "account", "direction", "equals", "minimum", "when"], "effect");
    if (!["debit", "credit", "supply", "unchanged-token", "unchanged-native"].includes(effect.kind)) throw new Error("unknown declared effect");
    operations.push({ kind: "capture", name: `effect${index}Before`, token: effect.token, account: effect.account,
      supply: effect.kind === "supply", native: effect.kind === "unchanged-native" });
  }
  const rawApproval = definition.approval === undefined ? undefined : resolved(definition.approval);
  if (rawApproval) keys(rawApproval, ["token", "spender", "mode", "requireBool", "verifyAllowance", "when"], "approval");
  const approval = rawApproval && (rawApproval.when === undefined || rawApproval.when) ? rawApproval : undefined;
  const approvalCall = (actual: boolean) => {
    if (!approval) return;
    const amount: RuntimeValue = actual ? reference("amountIn") : 0n;
    addCall({ target: approval.token, signature: "function approve(address,uint256) returns(bool)",
      args: [approval.spender, amount], ...(approval.requireBool ? { save: { approvalResult: 0 },
        checks: [{ left: reference("approvalResult"), operator: "eq", right: true }] } : {}) }, false);
    if (approval.verifyAllowance) addCall({ target: approval.token,
      signature: "function allowance(address,address) view returns(uint256)", args: [input.executor, approval.spender],
      save: { allowanceResult: 0 }, checks: [{ left: reference("allowanceResult"), operator: "eq", right: amount }] }, true);
  };
  if (approval) {
    keys(approval, ["token", "spender", "mode", "requireBool", "verifyAllowance", "when"], "approval");
    if (approval.mode === "ensure") operations.push({ kind: "allowance", token: approval.token, spender: approval.spender });
    else if (approval.mode === "exact-clear") { approvalCall(false); approvalCall(true); }
    else throw new Error("unknown declared approval mode");
  }
  addCall(resolved(definition.call), false);
  if (approval?.mode === "exact-clear") approvalCall(false);
  for (const [index, effect] of effects.entries()) {
    const before = `effect${index}Before`, after = `effect${index}After`, delta = `effect${index}Delta`;
    operations.push({ kind: "capture", name: after, token: effect.token, account: effect.account,
      supply: effect.kind === "supply", native: effect.kind === "unchanged-native" });
    if (effect.kind.startsWith("unchanged-")) { check(reference(after), "eq", reference(before)); continue; }
    const increase = effect.kind === "credit" || effect.kind === "supply" && effect.direction === "increase";
    if (effect.kind === "supply" && !["increase", "decrease"].includes(effect.direction)) throw new Error("declared supply direction");
    operations.push({ kind: "difference", name: delta, left: increase ? after : before, right: increase ? before : after });
    if (effect.kind === "credit") check(reference(delta), "gte", minAmountOut > 0n ? minAmountOut : 1n);
    if (effect.equals !== undefined) check(reference(delta), "eq", effect.equals);
    if (effect.minimum !== undefined && effect.minimum !== minAmountOut) check(reference(delta), "gte", effect.minimum);
  }
  return emit(operations);
}

function emit(operations: readonly Operation[]): RuntimeAmountProgram {
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
  function call(input: Call, isStatic: boolean): void {
    const abi = callInterface(input.signature), fragment = abi.fragments.find(item => item.type === "function");
    if (!fragment || fragment.type !== "function") throw new Error("declared call requires one function");
    const fn = abi.getFunction(fragment.format("sighash"));
    if (!fn || !Array.isArray(input.args) || fn.inputs.length !== input.args.length) throw new Error("declared call arguments");
    const patches: { offset: number; reg: number }[] = [], temporaries: { reg: number; temporary: boolean }[] = [];
    // Only static ABI words are patchable in this conversion schema. Reject a
    // dynamic shape instead of guessing offsets or accepting arbitrary bytes.
    const args = input.args.map((value, index) => {
      if (!dynamic(value)) return value;
      if (!fn.inputs.every(scalarWord)) throw new Error("dynamic runtime ABI arguments require a declared tuple encoder");
      const item = word(value); temporaries.push(item); patches.push({ offset: 4 + index * 32, reg: item.reg });
      const type = fn.inputs[index]!.type;
      return type === "address" ? "0x0000000000000000000000000000000000000000" : type === "bool" ? false : 0n;
    });
    program.call(getAddress(input.target), abi.encodeFunctionData(fn, args), { static: isStatic, patches });
    temporaries.forEach(release);
    for (const [name, index] of Object.entries(input.save ?? {})) {
      if (/^effect[0-9]+(?:Before|After|Delta)$/.test(name)) throw new Error("reserved effect capture name");
      if (!Number.isSafeInteger(index) || index < 0 || index >= fn.outputs.length || !fn.outputs.every(scalarWord)) throw new Error("declared return word");
      program.load(save(name), index * 32);
    }
  }
  function references(value: unknown, found = new Set<string>()): Set<string> {
    if (dynamic(value)) found.add(value.runtime);
    if (value && typeof value === "object") Object.values(value).forEach(item => references(item, found));
    return found;
  }
  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "call") call(operation.call, operation.static);
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
    } else {
      keys(operation.check, ["left", "operator", "right"], "check");
      const left = word(operation.check.left), right = word(operation.check.right);
      if (operation.check.operator === "eq") program.equal(left.reg, right.reg);
      else if (operation.check.operator === "gte") { const reg = take(); program.math("sub", reg, left.reg, right.reg); used.delete(reg); }
      else throw new Error("unknown declared runtime comparison");
      release(left); release(right);
    }
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
export function buildDeclarativeRuntimeLeg(definition: DeclarativeConversionExecution, input: Environment, values: DeclarationValues) {
  if (input.settlement && (input.settlement.kind !== "direct-output" || !definition.settlement.directOutput)) return null;
  return { ...runtimeLeg(input.route.adapterId, buildDeclarativeExecutionProgram(definition, { ...executionContext(input, true), minAmountOut: 1n }, values)),
    settlement: definition.settlement.directOutput ? { directOutput: true as const } : {},
    ...(input.settlement ? { settlementRequest: input.settlement } : {}) };
}
export function buildDeclarativeQuotedFragment(definition: DeclarativeConversionExecution, input: Environment, values: DeclarationValues) {
  if (uint(input.amountIn) === 0n) throw new Error("declared quoted input must be positive");
  const program = buildDeclarativeExecutionProgram(definition, input, values);
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
