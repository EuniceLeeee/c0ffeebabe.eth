import { assertModuleData, type ModuleBlock } from "./declarative-modules.js";

export type MathValue = bigint | boolean | string | readonly MathValue[] | { readonly [key: string]: MathValue };
/** A statically imported pure model. No transport, encoding, settlement or
 * protocol lookup belongs in this entry. The JSON selects an opaque ID/version. */
export interface DeclarativeMathModel {
  readonly id: string;
  readonly version: number;
  validateInput(value: MathValue): void;
  evaluate(value: MathValue): MathValue;
  validateOutput(value: MathValue): void;
}
export interface MathBindings { readonly version: 1; readonly entries: Readonly<Record<string, { readonly model: string; readonly version: number }>> }
export type DeclarativeMathFunctions = Readonly<Record<string, (value: any) => any>>;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
function immutable(value: MathValue): MathValue {
  if (["bigint", "boolean", "string"].includes(typeof value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("math values must be lossless, plain data");
  return Object.freeze(Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, field]) => {
    if (forbidden.has(key) || !("value" in field)) throw new Error("invalid math input property");
    return [key, immutable(field.value)];
  })));
}
export function createDeclarativeMathRegistry(models: readonly DeclarativeMathModel[]) {
  const entries = new Map<string, DeclarativeMathModel>();
  for (const model of models) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(model.id) || !Number.isSafeInteger(model.version) || model.version < 1)
      throw new Error("invalid math model identity");
    const key = `${model.id}@${model.version}`;
    if (entries.has(key)) throw new Error("duplicate math model");
    entries.set(key, Object.freeze({ ...model }));
  }
  function bind(raw: ModuleBlock): DeclarativeMathFunctions {
    assertModuleData(raw);
    const input = raw as unknown as MathBindings;
    if (input.version !== 1 || !input.entries || typeof input.entries !== "object" || Array.isArray(input.entries)
      || Object.keys(input).some(key => !["version", "entries"].includes(key))) throw new Error("invalid math bindings");
    return Object.freeze(Object.fromEntries(Object.entries(input.entries).map(([alias, binding]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(alias) || forbidden.has(alias) || !binding ||
        Object.keys(binding).length !== 2 || typeof binding.model !== "string" || !Number.isSafeInteger(binding.version))
        throw new Error("invalid math binding");
      const model = entries.get(`${binding.model}@${binding.version}`);
      if (!model) throw new Error(`unregistered math model: ${binding.model}@${binding.version}`);
      return [alias, (value: MathValue) => {
        const input = immutable(value);
        if (model.validateInput(input) !== undefined) throw new Error("math input validation must be synchronous and return void");
        const output = immutable(model.evaluate(input));
        if (model.validateOutput(output) !== undefined) throw new Error("math output validation must be synchronous and return void");
        return output;
      }];
    })));
  }
  return Object.freeze({ bind });
}
