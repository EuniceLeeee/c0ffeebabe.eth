import { assertPublicRuntimeCaptureName } from "./declarative-call-codec.js";
import { assertModuleData, type ModuleBlock } from "./declarative-modules.js";

export type RuntimeMathOperator = "add" | "sub" | "mul" | "div" | "shr" | "and" | "min" | "eq" | "neg";
export type RuntimeMathOperand = { readonly input: string } | { readonly local: string } | { readonly constant: string };
/** Statically imported TS math only. The declaration contains no calls, ABI,
 * callback, state reads or handler functions. JSON binds its opaque ID/version. */
export interface RuntimeMathModel {
  readonly id: string;
  readonly version: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly operations: readonly {
    readonly name: string;
    readonly op: RuntimeMathOperator;
    readonly left: RuntimeMathOperand;
    readonly right: RuntimeMathOperand;
  }[];
}
export type RuntimeMathValue = bigint | { readonly runtime: string };
export interface ExpandedRuntimeMathOperation {
  readonly name: string;
  readonly op: RuntimeMathOperator;
  readonly left: RuntimeMathValue;
  readonly right: RuntimeMathValue;
}
export interface BoundRuntimeMath {
  readonly aliases: readonly string[];
  has(alias: string): boolean;
  /** Namespace is allocated by the common execution compiler per step. It must
   * be unique within that execution program; expansion has no global counter. */
  expand(alias: string, bindings: Readonly<Record<string, RuntimeMathValue>>,
    outputNames: Readonly<Record<string, string>>, namespace: string): readonly ExpandedRuntimeMathOperation[];
}
const operators = new Set<RuntimeMathOperator>(["add", "sub", "mul", "div", "shr", "and", "min", "eq", "neg"]);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const maxUint = (1n << 256n) - 1n;
function name(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(value) || forbidden.has(value))
    throw new Error("invalid runtime math name");
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("runtime math requires plain data records");
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || forbidden.has(key) || !("value" in property) || !property.enumerable)
      throw new Error("invalid runtime math data property");
  }
}
function shape(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  record(value);
  if (fields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(key => !fields.includes(key)))
    throw new Error("missing or unknown runtime math field");
}
function integer(value: bigint): bigint {
  if (value < 0n || value > maxUint) throw new Error("runtime math integer bounds");
  return value;
}
function constant(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("runtime math constant must be an unsigned decimal integer");
  return integer(BigInt(value));
}
function names(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length) throw new Error("duplicate or invalid runtime math names");
  for (let index = 0; index < value.length; index++) { if (!Object.hasOwn(value, index)) throw new Error("sparse runtime math names"); name(value[index]); }
}
function validateModel(raw: RuntimeMathModel): RuntimeMathModel {
  assertModuleData(raw);
  shape(raw, ["id", "version", "inputs", "outputs", "operations"]);
  if (typeof raw.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(raw.id) ||
    !Number.isSafeInteger(raw.version) || raw.version < 1) throw new Error("invalid runtime math model identity");
  names(raw.inputs); names(raw.outputs);
  if (!raw.outputs.length || !Array.isArray(raw.operations) || !raw.operations.length) throw new Error("runtime math requires operations and outputs");
  const locals = new Set<string>();
  function operand(value: unknown): void {
    record(value);
    if (Object.hasOwn(value, "input")) {
      shape(value, ["input"]); name(value.input);
      if (!raw.inputs.includes(value.input)) throw new Error("unknown runtime math input");
    } else if (Object.hasOwn(value, "local")) {
      shape(value, ["local"]); name(value.local);
      if (!locals.has(value.local)) throw new Error("runtime math local must be defined before use");
    } else { shape(value, ["constant"]); constant(value.constant); }
  }
  for (const operation of raw.operations) {
    shape(operation, ["name", "op", "left", "right"]); name(operation.name);
    if (typeof operation.op !== "string" || !operators.has(operation.op as RuntimeMathOperator)) throw new Error("unsupported runtime math operator");
    if (locals.has(operation.name) || raw.inputs.includes(operation.name)) throw new Error("runtime math names cannot overwrite inputs or locals");
    operand(operation.left); operand(operation.right);
    // The existing VM negates a nonnegative magnitude below 2^255. The
    // unused operand is canonical, not an alternate sign/overflow policy.
    if (operation.op === "neg" && ((!operation.right || typeof operation.right !== "object" || !("constant" in operation.right)) || operation.right.constant !== "0"))
      throw new Error("runtime signed negation requires zero right operand");
    locals.add(operation.name);
  }
  if (raw.outputs.some(output => !locals.has(output))) throw new Error("runtime math output must name a defined local");
  const model = JSON.parse(JSON.stringify(raw)) as RuntimeMathModel;
  Object.freeze(model.inputs); Object.freeze(model.outputs);
  for (const operation of model.operations) { Object.freeze(operation.left); Object.freeze(operation.right); Object.freeze(operation); }
  Object.freeze(model.operations); return Object.freeze(model);
}
function value(raw: RuntimeMathValue): RuntimeMathValue {
  if (typeof raw === "bigint") return integer(raw);
  shape(raw, ["runtime"]); name(raw.runtime);
  return Object.freeze({ runtime: raw.runtime });
}
function destination(output: unknown): asserts output is string {
  assertPublicRuntimeCaptureName(output);
  name(output);
  if (["amountIn", "approvalResult", "allowanceResult"].includes(output) || /^effect[0-9]+(?:Before|After|Delta)$/.test(output))
    throw new Error("runtime math cannot write a reserved capture");
}
export function createDeclarativeRuntimeMathRegistry(models: readonly RuntimeMathModel[]) {
  const registered = new Map<string, RuntimeMathModel>();
  for (const raw of models) {
    const model = validateModel(raw), key = `${model.id}@${model.version}`;
    if (registered.has(key)) throw new Error("duplicate runtime math model");
    registered.set(key, model);
  }
  function bind(raw: ModuleBlock): BoundRuntimeMath {
    assertModuleData(raw); shape(raw, ["version", "entries"]);
    if (raw.version !== 1) throw new Error("unsupported runtime math bindings version");
    record(raw.entries);
    const aliases = new Map<string, RuntimeMathModel>();
    for (const [alias, binding] of Object.entries(raw.entries)) {
      name(alias); shape(binding, ["model", "version"]);
      if (typeof binding.model !== "string" || !Number.isSafeInteger(binding.version) || (binding.version as number) < 1)
        throw new Error("invalid runtime math binding");
      const model = registered.get(`${binding.model}@${binding.version}`);
      if (!model) throw new Error(`unregistered runtime math model: ${binding.model}@${binding.version}`);
      aliases.set(alias, model);
    }
    return Object.freeze({
      aliases: Object.freeze([...aliases.keys()]),
      has(alias: string) { return aliases.has(alias); },
      expand(alias: string, bindings: Readonly<Record<string, RuntimeMathValue>>,
        outputNames: Readonly<Record<string, string>>, namespace: string): readonly ExpandedRuntimeMathOperation[] {
        const model = aliases.get(alias);
        if (!model) throw new Error(`undefined runtime math alias: ${alias}`);
        name(namespace); shape(bindings, model.inputs); shape(outputNames, model.outputs);
        const inputs = new Map(model.inputs.map(key => [key, value(bindings[key]!)]));
        const occupied = new Set([...inputs.values()].flatMap(input => typeof input === "bigint" ? [] : [input.runtime]));
        const locals = new Map<string, string>();
        // Reserve all destinations before producing any output. A valid model
        // can never overwrite an earlier call's input capture or actual r0.
        for (const [index, operation] of model.operations.entries()) {
          const target = model.outputs.includes(operation.name) ? outputNames[operation.name] : `${namespace}Local${index}`;
          destination(target);
          if (occupied.has(target)) throw new Error("runtime math capture alias collision");
          occupied.add(target); locals.set(operation.name, target);
        }
        const resolve = (operand: RuntimeMathOperand): RuntimeMathValue => {
          if ("input" in operand) return inputs.get(operand.input)!;
          if ("local" in operand) return Object.freeze({ runtime: locals.get(operand.local)! });
          return constant(operand.constant);
        };
        return Object.freeze(model.operations.map(operation => Object.freeze({ name: locals.get(operation.name)!, op: operation.op,
          left: resolve(operation.left), right: resolve(operation.right) })));
      },
    });
  }
  return Object.freeze({ bind });
}
