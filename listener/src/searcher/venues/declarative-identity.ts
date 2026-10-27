import { compileDeclarativeValues, validateDeclarativeValue, validateDeclarativeStatements } from "./declarative-values.js";
import type { FamilyCandidate, VerifiedIdentity, IdentityVariant } from "./adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "./adapter-request-program.js";
import { RequiredAdapterRequestError } from "./adapter-request-failure.js";

// The document contains values and a closed set of pure operations. It cannot
// load code, perform I/O, supply a callback, or bypass the existing issuer.
type Value = any;
type Env = Record<string, Value>;
export interface DeclarativeIdentityDocument {
  readonly version: 1;
  readonly inputs?: readonly string[];
  readonly abi: Record<string, readonly string[]>;
  readonly constants: Record<string, Value>;
  readonly expressions: Record<string, Value>;
  readonly programs?: Record<string, readonly Value[]>;
  readonly identity: {
    readonly select: readonly Value[];
    readonly stages: Record<string, { requirements: Value; optionalFailures?: string[]; requests: Value; decode: readonly Value[] }>;
    readonly decide: readonly Value[];
  };
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const reserved = new Set(["candidate", "evidence", "results", "profile", "constants", "missing", "index"]);
function binding(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || reserved.has(name) || forbidden.has(name)) throw new Error("invalid declarative binding");
}
function freeze<T>(x: T): T { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }

export function compileDeclarativeIdentity<C extends FamilyCandidate, I extends VerifiedIdentity>(
  raw: DeclarativeIdentityDocument,
  profile: { id: string; familyId: I["familyId"]; lineageId: I["lineageId"]; parameters?: Readonly<Record<string, unknown>> },
  math: Readonly<Record<string, (value: bigint) => bigint>> = {},
): IdentityVariant<C, I, unknown> {
  validateDeclarativeValue(raw);
  if (Object.keys(raw).some(key => !["version", "inputs", "scope", "abi", "constants", "discovery", "expressions", "programs", "identity"].includes(key)))
    throw new Error("unknown definition field");
  const roots = new Set(["candidate", "evidence", "results", "profile", "constants", "missing", "index", "error"]);
  for (const name of raw.inputs ?? []) { binding(name); roots.add(name); }
  function visit(value: Value, fn: (value: Value) => void): void {
    fn(value);
    if (value && typeof value === "object") Object.values(value).forEach(v => visit(v, fn));
  }
  visit(raw, node => {
    if (!node || typeof node !== "object") return;
    if (typeof node.let === "string") { binding(node.let); roots.add(node.let); }
    if (["map", "flatMap", "filter", "some", "every"].includes(node.op)) { binding(node.args[1]); roots.add(node.args[1]); }
    if (node.op === "expression" || node.op === "program") Object.keys(node.args[1] ?? {}).forEach(key => { binding(key); roots.add(key); });
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
  validateDeclarativeStatements(raw.identity.select); validateDeclarativeStatements(raw.identity.decide);
  for (const stage of Object.values(raw.identity.stages)) {
    if (Object.keys(stage).some(key => !["requirements", "optionalFailures", "requests", "decode"].includes(key)))
      throw new Error("unknown identity stage field");
    validateDeclarativeStatements(stage.decode);
  }
  if (raw.version !== 1) throw new Error("unsupported declarative identity version");
  const doc = freeze(JSON.parse(JSON.stringify(raw))) as DeclarativeIdentityDocument;
  const values = compileDeclarativeValues(doc, math);
  const evaluate = values.evaluate, run = values.run;
  const environment = (step: Value, results: readonly AdapterRequestResult[] = []) => ({ candidate: step.candidate,
    evidence: step.evidence, results, missing: undefined, profile: { id: profile.id, familyId: profile.familyId, lineageId: profile.lineageId, ...profile.parameters }, constants: doc.constants });
  const stage = (step: Value) => {
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
    decide: step => { return freeze(run(doc.identity.decide, environment(step))); },
  };
}
