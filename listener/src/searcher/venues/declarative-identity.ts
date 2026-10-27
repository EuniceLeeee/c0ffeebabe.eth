import { Interface, getAddress, keccak256, ZeroAddress } from "ethers";
import type { FamilyCandidate, VerifiedIdentity, IdentityVariant } from "./adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "./adapter-request-program.js";
import { RequiredAdapterRequestError } from "./adapter-request-failure.js";
import { hashCanonical } from "./canonical-value.js";
import { assertSameSource, assertSource, effectsProjection, returnedResult, requireRuntimeCode,
  tokenDeltaAtLeast, totalSupplyDeltaAtLeast, sameAddress } from "./protocols/standard-family/common.js";

// The document contains values and a closed set of pure operations. It cannot
// load code, perform I/O, supply a callback, or bypass the existing issuer.
type Value = any;
type Env = Record<string, Value>;
export interface DeclarativeIdentityDocument {
  readonly version: 1;
  readonly abi: Record<string, readonly string[]>;
  readonly constants: Record<string, Value>;
  readonly expressions: Record<string, Value>;
  readonly identity: {
    readonly select: readonly Value[];
    readonly stages: Record<string, { requirements: Value; optionalFailures?: string[]; requests: Value; decode: readonly Value[] }>;
    readonly decide: readonly Value[];
  };
}
const ops = new Set(["uint", "address", "sameAddress", "hash", "codeHash", "get", "defined", "not", "and", "or", "eq", "ne", "gt", "gte", "lt", "lte", "add", "sub", "div", "min", "coalesce", "if", "merge", "omit", "concat", "map", "flatMap", "filter", "some", "every", "at", "length", "string", "join", "sortId", "result", "returned", "code", "decode", "encode", "shape", "wordSurface", "source", "assertSource", "effects", "tokenDelta", "supplyDelta", "event", "addressWord", "bytes", "maskHash", "matches", "expression", "math", "requestFailure"]);
const arity: Record<string, [number, number]> = Object.fromEntries([
  ...["uint", "address", "hash", "codeHash", "defined", "not", "length", "string", "sortId", "result", "returned", "code", "shape", "wordSurface", "source", "effects", "tokenDelta", "supplyDelta", "event", "requestFailure"].map(k => [k, [1, 1]]),
  ...["get", "sameAddress", "eq", "ne", "gt", "gte", "lt", "lte", "add", "sub", "div", "min", "coalesce", "omit", "at", "join", "assertSource", "maskHash", "matches", "expression", "math"].map(k => [k, [2, 2]]),
  ...["if", "map", "flatMap", "filter", "some", "every", "encode", "bytes"].map(k => [k, [3, 3]]),
  ["decode", [4, 4]], ["addressWord", [1, 2]],
  ...["and", "or", "merge", "concat"].map(k => [k, [1, 10000]]),
]) as Record<string, [number, number]>;
const reserved = new Set(["candidate", "evidence", "results", "profile", "constants", "missing", "index"]);
function binding(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || reserved.has(name) || forbidden.has(name)) throw new Error("invalid declarative binding");
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function freeze<T>(x: T): T { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
function validate(x: Value, path = "document"): void {
  if (typeof x === "function" || typeof x === "bigint" || x === undefined) throw new Error(`non-JSON definition: ${path}`);
  if (typeof x === "number" && !Number.isSafeInteger(x)) throw new Error(`unsafe JSON number: ${path}`);
  if (!x || typeof x !== "object") return;
  if (Array.isArray(x)) { x.forEach((v, i) => validate(v, `${path}.${i}`)); return; }
  for (const k of Object.keys(x)) if (forbidden.has(k)) throw new Error(`forbidden definition key: ${k}`);
  if ("op" in x && (!ops.has(x.op) || !Array.isArray(x.args) || Object.keys(x).some(k => k !== "op" && k !== "args")))
    throw new Error(`unknown expression: ${path}`);
  if ("op" in x && (x.args.length < arity[x.op][0] || x.args.length > arity[x.op][1])) throw new Error("invalid operation arity");
  Object.entries(x).forEach(([k, v]) => validate(v, `${path}.${k}`));
}

export function compileDeclarativeIdentity<C extends FamilyCandidate, I extends VerifiedIdentity>(
  raw: DeclarativeIdentityDocument,
  profile: { id: string; familyId: I["familyId"]; lineageId: I["lineageId"]; parameters?: Readonly<Record<string, unknown>> },
  math: Readonly<Record<string, (value: bigint) => bigint>> = {},
): IdentityVariant<C, I, unknown> {
  validate(raw);
  if (Object.keys(raw).some(key => !["version", "scope", "abi", "constants", "discovery", "expressions", "identity"].includes(key)))
    throw new Error("unknown definition field");
  const roots = new Set(["candidate", "evidence", "results", "profile", "constants", "missing", "index"]);
  function visit(value: Value, fn: (value: Value) => void): void {
    fn(value);
    if (value && typeof value === "object") Object.values(value).forEach(v => visit(v, fn));
  }
  visit(raw, node => {
    if (!node || typeof node !== "object") return;
    if (typeof node.let === "string") { binding(node.let); roots.add(node.let); }
    if (["map", "flatMap", "filter", "some", "every"].includes(node.op)) { binding(node.args[1]); roots.add(node.args[1]); }
    if (node.op === "expression") Object.keys(node.args[1] ?? {}).forEach(key => { binding(key); roots.add(key); });
  });
  function constant(path: string): Value {
    let value: Value = raw.constants;
    for (const part of path.split(".").slice(1)) {
      if (forbidden.has(part) || value == null || !Object.prototype.hasOwnProperty.call(value, part))
        throw new Error(`unknown declarative constant ${path}`);
      value = value[part];
    }
    return value;
  }
  visit(raw, node => {
    if (typeof node === "string" && node.startsWith("$constants.")) constant(node);
    if (typeof node === "string" && node.startsWith("$") && !roots.has(node.slice(1).split(".")[0]))
      throw new Error(`unknown declarative reference ${node}`);
    if (node?.op === "expression" && !Object.prototype.hasOwnProperty.call(raw.expressions, node.args[0]))
      throw new Error("unknown named expression");
  });
  const checked = new Set<string>(), checking = new Set<string>();
  function checkExpression(name: string): void {
    if (checking.has(name)) throw new Error("cyclic declarative expression");
    if (checked.has(name)) return;
    checking.add(name);
    visit(raw.expressions[name], node => { if (node?.op === "expression") checkExpression(node.args[0]); });
    checking.delete(name); checked.add(name);
  }
  Object.keys(raw.expressions).forEach(checkExpression);
  function statements(items: readonly Value[]): void {
    if (!Array.isArray(items)) throw new Error("expected declarative statements");
    for (const item of items) {
      const action = ["let", "assert", "evaluate", "return", "try"].filter(key => key in item);
      if (action.length !== 1) throw new Error("invalid declarative statement");
      const allowed = new Set([action[0], "when", ...(action[0] === "let" ? ["value"] : []),
        ...(action[0] === "assert" ? ["error"] : []), ...(action[0] === "try" ? ["recoverWhen"] : [])]);
      if (Object.keys(item).some(key => !allowed.has(key))) throw new Error("unknown statement field");
      if (action[0] === "try") statements(item.try);
    }
  }
  statements(raw.identity.select); statements(raw.identity.decide);
  for (const stage of Object.values(raw.identity.stages)) {
    if (Object.keys(stage).some(key => !["requirements", "optionalFailures", "requests", "decode"].includes(key)))
      throw new Error("unknown identity stage field");
    statements(stage.decode);
  }
  if (raw.version !== 1) throw new Error("unsupported declarative identity version");
  const doc = freeze(JSON.parse(JSON.stringify(raw))) as DeclarativeIdentityDocument;
  const abi = Object.fromEntries(Object.entries(doc.abi).map(([k, v]) => [k, new Interface(v)]));
  let budget = 0;
  function evaluate(x: Value, env: Env): Value {
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
    if (Array.isArray(x)) return x.map(v => evaluate(v, env));
    if (!x || typeof x !== "object") return x;
    if (!("op" in x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, evaluate(v, env)]).filter(([, v]) => v !== undefined));
    const args = x.args, e = (i: number) => evaluate(args[i], env);
    switch (x.op) {
      case "uint": return BigInt(e(0));
      case "get": { const obj = e(0), key = String(e(1)); if (forbidden.has(key)) throw new Error("forbidden lookup"); return obj?.[key]; }
      case "defined": return e(0) !== undefined && e(0) !== null;
      case "not": return !e(0);
      case "and": return args.every((v: Value) => Boolean(evaluate(v, env)));
      case "or": return args.some((v: Value) => Boolean(evaluate(v, env)));
      case "if": return e(0) ? e(1) : e(2);
      case "coalesce": { const a = e(0); return a == null ? e(1) : a; }
      case "eq": return e(0) === e(1);
      case "ne": return e(0) !== e(1);
      case "gt": return e(0) > e(1);
      case "gte": return e(0) >= e(1);
      case "lt": return e(0) < e(1);
      case "lte": return e(0) <= e(1);
      case "add": return e(0) + e(1);
      case "sub": return e(0) - e(1);
      case "div": return e(0) / e(1);
      case "min": { const a = e(0), b = e(1); return a < b ? a : b; }
      case "address": return getAddress(e(0));
      case "sameAddress": return sameAddress(e(0), e(1));
      case "hash": return hashCanonical(e(0));
      case "codeHash": return keccak256(e(0));
      case "merge": return Object.assign({}, ...args.map((v: Value) => evaluate(v, env)));
      case "omit": { const value = { ...e(0) }; for (const key of e(1)) delete value[key]; return value; }
      case "concat": return args.flatMap((v: Value) => evaluate(v, env));
      case "map": case "flatMap": case "filter": case "some": case "every": {
        const rows = e(0); if (!Array.isArray(rows)) throw new Error("collection expression requires array");
        if (rows.length > 10000) throw new Error("collection budget exceeded");
        const f = (item: Value, index: number) => evaluate(args[2], { ...env, [args[1]]: item, index });
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
      case "expression": { const name = e(0); if (!(name in doc.expressions)) throw new Error(`unknown named expression ${name}`); return evaluate(doc.expressions[name], { ...env, ...e(1) }); }
      case "math": { const name = e(0); const amount = e(1); if (typeof amount !== "bigint" || !math[name]) throw new Error("unknown scalar math function"); const result = math[name](amount); if (typeof result !== "bigint") throw new Error("scalar math output"); return result; }
      case "requestFailure": { const r = e(0); if (!r || r.ok) throw new Error("expected request failure"); throw new RequiredAdapterRequestError(r); }
      default: throw new Error(`unknown operation ${x.op}`);
    }
  }
  function run(program: readonly Value[], env: Env): Value {
    visit(program, item => { if (item?.let && !Object.prototype.hasOwnProperty.call(env, item.let)) env[item.let] = undefined; });
    for (const statement of program) {
      if ("when" in statement && !evaluate(statement.when, env)) continue;
      if ("let" in statement) { env[statement.let] = evaluate(statement.value, env); continue; }
      if ("assert" in statement) { if (!evaluate(statement.assert, env)) throw new Error(evaluate(statement.error, env)); continue; }
      if ("evaluate" in statement) { evaluate(statement.evaluate, env); continue; }
      if ("return" in statement) return evaluate(statement.return, env);
      if ("try" in statement) {
        try { run(statement.try, env); } catch (error) {
          if (error instanceof RequiredAdapterRequestError || !evaluate(statement.recoverWhen, env)) throw error;
        }
        continue;
      }
      throw new Error("unknown declarative statement");
    }
    return undefined;
  }
  const environment = (step: Value, results: readonly AdapterRequestResult[] = []) => ({ candidate: step.candidate,
    evidence: step.evidence, results, missing: undefined, profile: { id: profile.id, familyId: profile.familyId, lineageId: profile.lineageId, ...profile.parameters }, constants: doc.constants });
  const stage = (step: Value) => {
    budget = 0;
    const id = run(doc.identity.select, environment(step));
    if (!Object.prototype.hasOwnProperty.call(doc.identity.stages, id)) throw new Error("unknown declared identity stage");
    return doc.identity.stages[id];
  };
  return {
    id: profile.id, kind: "standalone-contract", lineageId: profile.lineageId, applies: () => true,
    requirements: step => stage(step).requirements,
    buildRequests: step => {
      const selected = stage(step);
      const requests = evaluate(selected.requests, environment(step)) as AdapterRequest[];
      if (!Array.isArray(requests) || new Set(requests.map(r => r.id)).size !== requests.length) throw new Error("duplicate declared request id");
      return freeze(requests);
    },
    decode: ({ step, results }) => {
      const selected = stage(step);
      for (const result of results) if (!result.ok && !selected.optionalFailures?.includes(result.id)) throw new RequiredAdapterRequestError(result);
      return freeze(run(selected.decode, environment(step, results)));
    },
    decide: step => { budget = 0; return freeze(run(doc.identity.decide, environment(step))); },
  };
}
