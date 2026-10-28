import { Interface, getAddress, keccak256, ZeroAddress } from "ethers";
import type { AdapterRequestResult } from "./adapter-request-program.js";
import { RequiredAdapterRequestError } from "./adapter-request-failure.js";
import { hashCanonical } from "./canonical-value.js";
import { assertSameSource, assertSource, effectsProjection, returnedResult, requireRuntimeCode,
  tokenDeltaAtLeast, totalSupplyDeltaAtLeast, sameAddress } from "./protocols/standard-family/common.js";

// Closed, bounded JSON operations shared by Family identity, pricing and execution
// compilation. Definitions cannot import code or perform transport/IO.
export type DeclarativeValue = any;
type Value = DeclarativeValue;
export type DeclarativeEnvironment = Record<string, Value>;
type Env = DeclarativeEnvironment;
export interface DeclarativeValuesDocument {
  readonly inputs?: readonly string[];
  readonly abi: Record<string, readonly string[]>;
  readonly constants: Record<string, Value>;
  readonly expressions: Record<string, Value>;
  readonly programs?: Record<string, readonly Value[]>;
}
const ops = new Set(["mul", "max", "program", "number", "lower", "unique", "decodeAll", "pow", "successful", "word", "bool", "objectEntries", "objectFromEntries", "uint", "address", "sameAddress", "hash", "codeHash", "get", "defined", "not", "and", "or", "eq", "ne", "gt", "gte", "lt", "lte", "add", "sub", "div", "min", "coalesce", "if", "merge", "omit", "concat", "map", "flatMap", "filter", "some", "every", "at", "length", "string", "join", "sortId", "result", "returned", "code", "decode", "encode", "shape", "wordSurface", "source", "assertSource", "effects", "tokenDelta", "supplyDelta", "event", "addressWord", "bytes", "maskHash", "matches", "expression", "math", "model", "requestFailure"]);
const arity: Record<string, [number, number]> = Object.fromEntries([
  ["mul", [2, 2]], ["max", [2, 2]],
  ...["number", "lower", "unique", "successful", "word", "bool", "objectEntries", "objectFromEntries"].map(k => [k, [1, 1]]), ["program", [2, 2]], ["pow", [2, 2]], ["decodeAll", [3, 3]],
  ...["uint", "address", "hash", "codeHash", "defined", "not", "length", "string", "sortId", "result", "returned", "code", "shape", "wordSurface", "source", "effects", "tokenDelta", "supplyDelta", "event", "requestFailure"].map(k => [k, [1, 1]]),
  ...["get", "sameAddress", "eq", "ne", "gt", "gte", "lt", "lte", "add", "sub", "div", "min", "coalesce", "omit", "at", "join", "assertSource", "maskHash", "matches", "expression", "math", "model"].map(k => [k, [2, 2]]),
  ...["if", "map", "flatMap", "filter", "some", "every", "encode", "bytes"].map(k => [k, [3, 3]]),
  ["decode", [4, 4]], ["addressWord", [1, 2]],
  ...["and", "or", "merge", "concat"].map(k => [k, [1, 10000]]),
]) as Record<string, [number, number]>;
const reserved = new Set(["constants", "missing", "index"]);
function binding(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || reserved.has(name) || forbidden.has(name)) throw new Error("invalid declarative binding");
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function freeze<T>(x: T): T { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
export function validateDeclarativeValue(x: Value, path = "document"): void {
  if (typeof x === "function" || typeof x === "bigint" || x === undefined) throw new Error(`non-JSON definition: ${path}`);
  if (typeof x === "number" && !Number.isSafeInteger(x)) throw new Error(`unsafe JSON number: ${path}`);
  if (!x || typeof x !== "object") return;
  if (Array.isArray(x)) { x.forEach((v, i) => validateDeclarativeValue(v, `${path}.${i}`)); return; }
  for (const k of Object.keys(x)) if (forbidden.has(k)) throw new Error(`forbidden definition key: ${k}`);
  if ("op" in x && (!ops.has(x.op) || !Array.isArray(x.args) || Object.keys(x).some(k => k !== "op" && k !== "args")))
    throw new Error(`unknown expression: ${path}`);
  if ("op" in x && (x.args.length < arity[x.op][0] || x.args.length > arity[x.op][1])) throw new Error("invalid operation arity");
  Object.entries(x).forEach(([k, v]) => validateDeclarativeValue(v, `${path}.${k}`));
}

export function validateDeclarativeStatements(items: readonly Value[]): void {
  if (!Array.isArray(items)) throw new Error("expected declarative statements");
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid declarative statement");
    const actions = ["let", "assert", "evaluate", "return", "try", "attempt"].filter(key => key in item);
    if (actions.length !== 1) throw new Error("invalid declarative statement");
    const action = actions[0];
    const allowed = new Set([action, "when", ...(action === "let" ? ["value"] : []),
      ...(action === "assert" ? ["error"] : []), ...(action === "try" ? ["recoverWhen"] : []),
      ...(action === "attempt" ? ["catch"] : [])]);
    if (Object.keys(item).some(key => !allowed.has(key))) throw new Error("unknown declaration statement field");
    if (action === "let") binding(item.let);
    if (action === "try") validateDeclarativeStatements(item.try);
    if (action === "attempt") { validateDeclarativeStatements(item.attempt); validateDeclarativeStatements(item.catch); }
  }
}

export function compileDeclarativeValues(
  raw: DeclarativeValuesDocument,
  math: Readonly<Record<string, (value: bigint) => bigint>> = {},
  models: Readonly<Record<string, (value: any) => any>> = {},
) {
  validateDeclarativeValue(raw);
  const doc = freeze(JSON.parse(JSON.stringify(raw))) as DeclarativeValuesDocument;
  const abi = Object.fromEntries(Object.entries(doc.abi).map(([k, v]) => [k, new Interface(v)]));
  const visit = (value: Value, fn: (value: Value) => void): void => {
    fn(value); if (value && typeof value === "object") Object.values(value).forEach(v => visit(v, fn));
  };
  for (const name of doc.inputs ?? []) binding(name);
  visit(doc, node => {
    if (!node || typeof node !== "object") return;
    if (["map", "flatMap", "filter", "some", "every"].includes(node.op)) binding(node.args[1]);
    if (node.op === "model" && (typeof node.args[0] !== "string" || !Object.hasOwn(models, node.args[0])))
      throw new Error("unknown math model");
    if (node.op === "expression" || node.op === "program") {
      if (!node.args[1] || typeof node.args[1] !== "object" || Array.isArray(node.args[1])) throw new Error("declaration arguments must be named");
      Object.keys(node.args[1]).forEach(binding);
    }
  });
  Object.values(doc.programs ?? {}).forEach(validateDeclarativeStatements);
  const active = new Set<string>(), checked = new Set<string>();
  const check = (kind: string, name: string): void => {
    const key = kind + ":" + name;
    if (active.has(key)) throw new Error("cyclic declarative expression/program");
    if (checked.has(key)) return;
    const table = kind === "expression" ? doc.expressions : doc.programs ?? {};
    if (!Object.prototype.hasOwnProperty.call(table, name)) throw new Error("unknown named declaration");
    active.add(key);
    visit(table[name], node => { if (node?.op === "expression" || node?.op === "program") {
      if (typeof node.args[0] !== "string" || node.args[0].startsWith("$")) throw new Error("declaration names must be literal");
      check(node.op, node.args[0]);
    } });
    active.delete(key); checked.add(key);
  };
  Object.keys(doc.expressions).forEach(name => check("expression", name));
  Object.keys(doc.programs ?? {}).forEach(name => check("program", name));
  let budget = 0;
  function evaluateInternal(x: Value, env: Env): Value {
    if (++budget > 100000) throw new Error("declarative expression budget exceeded");
    if (typeof x === "string" && x.startsWith("$")) {
      const parts = x.slice(1).split(".");
      if (!Object.prototype.hasOwnProperty.call(env, parts[0])) throw new Error(`unbound declarative reference ${x}`);
      let value: Value = env;
      for (const part of parts) {
        if (forbidden.has(part)) throw new Error("forbidden reference");
        if (parts[0] === "constants" && (value == null || !Object.prototype.hasOwnProperty.call(value, part)))
          throw new Error(`unknown declarative constant ${x}`);
        if (value == null) return undefined;
        value = Object.prototype.hasOwnProperty.call(value, part) ? value[part] : undefined;
      }
      return value;
    }
    if (Array.isArray(x)) return x.map(v => evaluateInternal(v, env));
    if (!x || typeof x !== "object") return x;
    if (!("op" in x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, evaluateInternal(v, env)]).filter(([, v]) => v !== undefined));
    const args = x.args, e = (i: number) => evaluateInternal(args[i], env);
    switch (x.op) {
      case "uint": return BigInt(e(0));
      case "number": { const v = Number(e(0)); if (!Number.isSafeInteger(v)) throw new Error("unsafe declaration number"); return v; }
      case "lower": return String(e(0)).toLowerCase();
      case "unique": return [...new Set(e(0))];
      case "objectEntries": return Object.entries(e(0));
      case "objectFromEntries": { const rows = e(0); for (const row of rows) if (forbidden.has(String(row[0]))) throw new Error("forbidden declaration key"); return Object.fromEntries(rows); }
      case "pow": { const exponent = BigInt(e(1)); if (exponent < 0n || exponent > 256n) throw new Error("declaration exponent bound"); return BigInt(e(0)) ** exponent; }
      case "successful": { const r = env.results.find((r: AdapterRequestResult) => r.id === e(0)); if (!r) throw new Error("declaration result missing"); if (!r.ok) throw new RequiredAdapterRequestError(r); return r; }
      case "word": { const data = e(0); if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) throw new Error("malformed declaration word"); return BigInt(data); }
      case "bool": { const data = e(0); if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) throw new Error("malformed declaration bool"); const value = BigInt(data); if (value > 1n) throw new Error("malformed declaration bool"); return value === 1n; }
      case "decodeAll": return abi[e(0)].decodeFunctionResult(e(1), e(2));
      case "program": { const name = e(0); if (!Object.prototype.hasOwnProperty.call(doc.programs ?? {}, name)) throw new Error("unknown declaration program"); return runInternal(doc.programs![name], { ...env, ...e(1) }); }
      case "get": { const obj = e(0), key = String(e(1)); if (forbidden.has(key)) throw new Error("forbidden lookup"); return obj?.[key]; }
      case "defined": return e(0) !== undefined && e(0) !== null;
      case "not": return !e(0);
      case "and": return args.every((v: Value) => Boolean(evaluateInternal(v, env)));
      case "or": return args.some((v: Value) => Boolean(evaluateInternal(v, env)));
      case "if": return e(0) ? e(1) : e(2);
      case "coalesce": { const a = e(0); return a == null ? e(1) : a; }
      case "eq": return e(0) === e(1);
      case "ne": return e(0) !== e(1);
      case "gt": return e(0) > e(1);
      case "gte": return e(0) >= e(1);
      case "lt": return e(0) < e(1);
      case "lte": return e(0) <= e(1);
      case "add": return e(0) + e(1);
      case "mul": return e(0) * e(1);
      case "max": { const a = e(0), b = e(1); return a > b ? a : b; }
      case "sub": return e(0) - e(1);
      case "div": return e(0) / e(1);
      case "min": { const a = e(0), b = e(1); return a < b ? a : b; }
      case "address": return getAddress(e(0));
      case "sameAddress": return sameAddress(e(0), e(1));
      case "hash": return hashCanonical(e(0));
      case "codeHash": return keccak256(e(0));
      case "merge": return Object.assign({}, ...args.map((v: Value) => evaluateInternal(v, env)));
      case "omit": { const value = { ...e(0) }; for (const key of e(1)) delete value[key]; return value; }
      case "concat": return args.flatMap((v: Value) => evaluateInternal(v, env));
      case "map": case "flatMap": case "filter": case "some": case "every": {
        const rows = e(0); if (!Array.isArray(rows)) throw new Error("collection expression requires array");
        if (rows.length > 10000) throw new Error("collection budget exceeded");
        const f = (item: Value, index: number) => evaluateInternal(args[2], { ...env, [args[1]]: item, index });
        return rows[x.op](f);
      }
      case "at": return e(0)?.[e(1)];
      case "length": return e(0).length;
      case "string": return String(e(0));
      case "join": return e(0).join(e(1));
      case "sortId": return [...e(0)].sort((a, b) => a.id.localeCompare(b.id));
      case "result": return env.results.find((r: AdapterRequestResult) => r.id === e(0));
      case "returned": return returnedResult(env.results, e(0));
      case "code": return requireRuntimeCode(env.results, e(0));
      case "decode": return abi[e(0)].decodeFunctionResult(e(1), e(2))[e(3) ?? 0];
      case "encode": return abi[e(0)].encodeFunctionData(e(1), e(2) ?? []);
      case "shape": { const r = env.results.find((r: AdapterRequestResult) => r.id === e(0)); return !r?.ok ? "missing" : r.completion === "returned" ? "returned" : "reverted"; }
      case "wordSurface": {
        const r = env.results.find((r: AdapterRequestResult) => r.id === e(0));
        if (!r) throw new Error("balance surface result missing");
        if (!r.ok) return { status: "unresolved", result: r };
        return { status: r.completion === "returned" && /^0x[0-9a-fA-F]{64}$/.test(r.data) ? "valid" : "invalid" };
      }
      case "source": return assertSameSource(e(0));
      case "assertSource": assertSource(e(0), e(1)); return true;
      case "effects": return effectsProjection(e(0));
      case "tokenDelta": return tokenDeltaAtLeast(e(0));
      case "supplyDelta": return totalSupplyDeltaAtLeast(e(0));
      case "event": {
        const input = e(0), iface = abi[input.abi];
        return (input.result.effects?.logs ?? []).some((log: Value) => {
          if (!sameAddress(log.address, input.address)) return false;
          try { const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            return parsed !== null && parsed.name === input.name && Object.entries(input.fields).every(([key, value]) => parsed.args[key] === value);
          } catch { return false; }
        });
      }
      case "addressWord": { const data = e(0); if (!/^0x0{24}[a-fA-F0-9]{40}$/.test(data)) throw new Error(e(1)?.malformed ?? "malformed address word"); const a = getAddress(`0x${data.slice(-40)}`); if (a === ZeroAddress) throw new Error(e(1)?.zero ?? "zero address word"); return a; }
      case "bytes": return `0x${e(0).slice(2 + e(1) * 2, 2 + (e(1) + e(2)) * 2)}`;
      case "maskHash": { let code = e(0); for (const [offset, size] of e(1)) code = code.slice(0, 2 + offset * 2) + "0".repeat(size * 2) + code.slice(2 + (offset + size) * 2); return keccak256(code); }
      case "matches": return new RegExp(e(1)).test(e(0));
      case "expression": { const name = e(0); if (!(name in doc.expressions)) throw new Error(`unknown named expression ${name}`); return evaluateInternal(doc.expressions[name], { ...env, ...e(1) }); }
      case "math": { const name = e(0); const amount = e(1); if (typeof amount !== "bigint" || !Object.hasOwn(math, name)) throw new Error("unknown scalar math function"); const result = math[name](amount); if (typeof result !== "bigint") throw new Error("scalar math output"); return result; }
      case "model": { const name = e(0); if (typeof name !== "string" || !Object.hasOwn(models, name)) throw new Error("unknown math model"); return models[name](e(1)); }
      case "requestFailure": { const r = e(0); if (!r || r.ok) throw new Error("expected request failure"); throw new RequiredAdapterRequestError(r); }
      default: throw new Error(`unknown operation ${x.op}`);
    }
  }
  function runInternal(program: readonly Value[], env: Env): Value {
    visit(program, item => { if (item?.let && !Object.prototype.hasOwnProperty.call(env, item.let)) env[item.let] = undefined; });
    for (const statement of program) {
      if ("when" in statement && !evaluateInternal(statement.when, env)) continue;
      if ("let" in statement) { env[statement.let] = evaluateInternal(statement.value, env); continue; }
      if ("assert" in statement) { if (!evaluateInternal(statement.assert, env)) throw new Error(evaluateInternal(statement.error, env)); continue; }
      if ("evaluate" in statement) { evaluateInternal(statement.evaluate, env); continue; }
      if ("return" in statement) return evaluateInternal(statement.return, env);
      if ("attempt" in statement) {
        try { const result = runInternal(statement.attempt, env); if (result !== undefined) return result; }
        catch (error) {
          if (error instanceof RequiredAdapterRequestError) throw error;
          const result = runInternal(statement.catch, { ...env, error: { message: error instanceof Error ? error.message : String(error) } });
          if (result !== undefined) return result;
        }
        continue;
      }
      if ("try" in statement) {
        try { runInternal(statement.try, env); } catch (error) {
          if (error instanceof RequiredAdapterRequestError || !evaluateInternal(statement.recoverWhen, env)) throw error;
        }
        continue;
      }
      throw new Error("unknown declarative statement");
    }
    return undefined;
  }
  const prepare = (env: Env): Env => ({ missing: undefined, ...Object.fromEntries((doc.inputs ?? []).map(name => [name, undefined])), ...env, constants: doc.constants });
  return Object.freeze({
    evaluate(value: Value, env: Env): Value { budget = 0; return evaluateInternal(value, prepare(env)); },
    run(statements: readonly Value[], env: Env): Value { budget = 0; return runInternal(statements, prepare(env)); },
  });
}
