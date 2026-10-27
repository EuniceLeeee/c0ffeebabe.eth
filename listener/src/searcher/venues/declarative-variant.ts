import { expandConversionAdmission } from "./declarative-conversion-admission.js";
import { validateDeclarativeValue, validateDeclarativeStatements } from "./declarative-values.js";

type Data = any;
// Field models describe decoded facts and constraints. They are expanded once,
// before registration; request execution still belongs to the existing issuer.
function expandExpression(value: Data): Data {
  if (Array.isArray(value)) return value.map(expandExpression);
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    const op = keys[0].slice(1);
    const args = value[keys[0]];
    if (!Array.isArray(args)) throw new Error("declarative operator arguments must be an array");
    return { op, args: args.map(expandExpression) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandExpression(item)]));
}
function exactKeys(value: Data, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error(`invalid ${label}`);
}
function snapshot(raw: Data): Data {
  validateDeclarativeValue(raw);
  const value = expandExpression(JSON.parse(JSON.stringify(raw)));
  validateDeclarativeValue(value);
  return value;
}
function checks(items: readonly Data[] = []): Data[] {
  if (!Array.isArray(items)) throw new Error("model checks must be an array");
  const statements = items.map(item => {
    exactKeys(item, ["condition", "assert", "error", "when"], "model check");
    const authored = Object.hasOwn(item, "condition");
    exactKeys(item, authored ? ["condition", "error", "when"] : ["assert", "error", "when"], "model check");
    if (!Object.hasOwn(item, authored ? "condition" : "assert") || !Object.hasOwn(item, "error"))
      throw new Error("incomplete model check");
    return { assert: authored ? item.condition : item.assert, error: item.error,
      ...(Object.hasOwn(item, "when") ? { when: item.when } : {}) };
  });
  validateDeclarativeStatements(statements);
  return statements;
}

/** Author constraints with condition/error/when; old expanded constraints are
 * accepted only after the same strict validation for migration consumers. */
export function normalizeDeclarativeChecks(raw: readonly Data[] = []): Data[] {
  return checks(snapshot(raw));
}
function expandReadSet(rows: readonly Data[]): Data {
  if (!Array.isArray(rows)) throw new Error("read set must be an array");
  const op = (name: string, ...args: Data[]) => ({ op: name, args });
  if (rows.length === 0) return [];
  return op("concat", ...rows.map(row => {
    if (Object.hasOwn(row, "each")) {
      exactKeys(row, ["each", "as", "reads"], "read collection");
      return op("flatMap", row.each, row.as, expandReadSet(row.reads));
    }
    if (Object.hasOwn(row, "when")) {
      exactKeys(row, ["when", "reads"], "conditional reads");
      return op("if", row.when, expandReadSet(row.reads), []);
    }
    if (Object.hasOwn(row, "use")) {
      exactKeys(row, ["use", "with"], "read set reference");
      return op("expression", row.use, row.with ?? {});
    }
    if (Object.hasOwn(row, "code")) {
      exactKeys(row, ["id", "code"], "runtime code read");
      return [{ id: row.id, kind: "get-code", address: op("address", row.code) }];
    }
    if (Object.hasOwn(row, "storage")) {
      exactKeys(row, ["id", "storage"], "storage read");
      exactKeys(row.storage, ["address", "slot"], "storage fields");
      if (!["address", "slot"].every(key => Object.hasOwn(row.storage, key))) throw new Error("incomplete storage read");
      return [{ id: row.id, kind: "get-storage", ...row.storage }];
    }
    if (Object.hasOwn(row, "call")) {
      exactKeys(row, ["id", "target", "call", "caller", "required", "completion"], "view call");
      exactKeys(row.call, ["abi", "function", "args"], "view signature");
      return [{ id: row.id, kind: "eth-call", to: op("address", row.target),
        data: op("encode", row.call.abi, row.call.function, row.call.args ?? []),
        ...(Object.hasOwn(row, "caller") ? { caller: row.caller } : {}),
        ...(Object.hasOwn(row, "required") ? { required: row.required } : {}),
        completion: row.completion ?? "return-data" }];
    }
    if (Object.hasOwn(row, "simulation")) {
      exactKeys(row, ["simulation"], "active proof declaration");
      if (row.simulation.kind !== "effect-delta-simulation") throw new Error("active proof request kind");
      return [row.simulation];
    }
    throw new Error("unknown declared read kind");
  }));
}
function expandModel(model: Data): Data[] {
  exactKeys(model, ["checks", "fields", "output"], "field model");
  if (!Array.isArray(model.fields)) throw new Error("model fields must be an array");
  const names = new Set<string>();
  const statements = checks(model.checks);
  for (const field of model.fields) {
    exactKeys(field, ["name", "value", "checks"], "model field");
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(field.name) || names.has(field.name) || !Object.hasOwn(field, "value"))
      throw new Error("duplicate or invalid model field");
    names.add(field.name);
    statements.push({ let: field.name, value: field.value }, ...checks(field.checks));
  }
  if (Object.hasOwn(model, "output")) statements.push({ return: model.output });
  validateDeclarativeStatements(statements);
  return statements;
}

/** Decode models declare ordered fields, checks and one output. The shared
 * compiler supplies the interpreter statements; legacy arrays remain readable. */
export function normalizeDeclarativeFieldModel(raw: Data): Data[] {
  const model = snapshot(raw);
  if (Array.isArray(model)) { validateDeclarativeStatements(model); return model; }
  return expandModel(model);
}

/** The author supplies requests/result. Production receives requests/decode,
 * without a per-Family decoder function. Never accept both representations. */
export function normalizeDeclarativeReadProgram(raw: Data): { requests: Data; decode: Data[] } {
  const read = snapshot(raw);
  exactKeys(read, ["requests", "result", "decode"], "read result model");
  if (!Object.hasOwn(read, "requests") || Object.hasOwn(read, "result") === Object.hasOwn(read, "decode"))
    throw new Error("read program requires exactly one result representation");
  const decode = Object.hasOwn(read, "result") ? [{ return: read.result }] : normalizeDeclarativeFieldModel(read.decode);
  validateDeclarativeStatements(decode);
  return { requests: read.requests, decode };
}

export function normalizeDeclarativeVariant<T extends Record<string, Data>>(raw: T): T & {
  identity: Data; programs: Record<string, readonly Data[]>;
} {
  const definition = snapshot(raw);
  if (Object.hasOwn(definition, "assertions")) definition.assertions = normalizeDeclarativeChecks(definition.assertions);
  if (definition.pricing) {
    if (Object.hasOwn(definition.pricing, "finalizeChecks"))
      definition.pricing.finalizeChecks = normalizeDeclarativeChecks(definition.pricing.finalizeChecks);
    if (definition.pricing.static && Object.hasOwn(definition.pricing.static, "decode"))
      definition.pricing.static.decode = normalizeDeclarativeFieldModel(definition.pricing.static.decode);
  }
  if (definition.exact) for (const key of ["checks", "outputChecks"])
    if (Object.hasOwn(definition.exact, key)) definition.exact[key] = normalizeDeclarativeChecks(definition.exact[key]);
  const readPrograms = Object.fromEntries(Object.entries(definition.readPrograms ?? {})
    .map(([name, read]) => [name, normalizeDeclarativeReadProgram(read)]));
  if (Object.hasOwn(definition, "readPrograms")) definition.readPrograms = readPrograms;
  if (!Object.hasOwn(definition, "admission")) return definition;
  if (definition.programs !== undefined || definition.identity !== undefined)
    throw new Error("authored conversion variants use admission/models, not executable identity stages");
  exactKeys(definition.models, Object.keys(definition.models ?? {}), "variant models");
  const expressions = { ...(definition.expressions ?? {}) };
  for (const [name, reads] of Object.entries(definition.requestSets ?? {})) {
    if (Object.hasOwn(expressions, name)) throw new Error("duplicate read set/expression");
    expressions[name] = expandReadSet(reads as readonly Data[]);
  }
  for (const stage of ["match", "surface", "dependencies", "active"]) {
    const config = definition.admission[stage];
    if (config.requests !== undefined || !Array.isArray(config.reads)) throw new Error("admission uses declared reads");
    config.requests = expandReadSet(config.reads);
    delete config.reads;
  }
  const programs = Object.fromEntries(Object.entries(definition.models).map(([name, model]) => [name, expandModel(model)]));
  const admission = expandConversionAdmission(definition.admission);
  for (const name of Object.keys(admission.programs)) if (Object.hasOwn(programs, name))
    throw new Error("variant cannot replace a shared conversion proof model");
  const { admission: _admission, models: _models, requestSets: _requestSets, ...rest } = definition;
  const expanded = { ...rest, expressions, readPrograms, identity: admission.identity, programs: { ...programs, ...admission.programs } };
  validateDeclarativeValue(expanded);
  return expanded;
}
