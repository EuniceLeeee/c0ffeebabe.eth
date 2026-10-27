import { createHash } from "node:crypto";

/** Closed type metadata, never source text or an executable Family handler. */
type TypeNode =
  | { readonly type: "string" | "number" | "boolean" | "bigint" }
  | { readonly ref: string }
  | { readonly literal: string | number | boolean }
  | { readonly array: TypeNode }
  | { readonly union: readonly TypeNode[] }
  | { readonly type: "object"; readonly extends: readonly string[];
      readonly fields: Readonly<Record<string, TypeNode>>; readonly optional: readonly string[] };
type TypeDocument = { readonly definitions: Readonly<Record<string, TypeNode>>;
  readonly contracts?: Readonly<Record<string, string>> };
const BUILTINS: Readonly<Record<string, string>> = Object.freeze({
  FamilyCandidate: "../../venues/adapter-family-plugin.js",
  VerifiedIdentity: "../../venues/adapter-family-plugin.js",
  CompiledInstanceDescriptor: "../../venues/adapter-family-plugin.js",
  FamilyRouteDescriptor: "../../venues/adapter-family-plugin.js",
  FamilyId: "../../venues/adapter-family-identifiers.js",
  LineageId: "../../venues/adapter-family-identifiers.js",
  InstanceKey: "../../venues/adapter-family-identifiers.js",
  RouteKey: "../../venues/adapter-family-identifiers.js",
  CanonicalSource: "../../venues/adapter-request-program.js",
});
const OBJECT_BASES = new Set(["FamilyCandidate", "VerifiedIdentity", "CompiledInstanceDescriptor", "FamilyRouteDescriptor", "CanonicalSource"]);
const CONTRACTS = new Set(["candidate", "identity", "identityEvidence", "descriptor", "route", "pricingDraft", "pricingDescriptor", "pricingStatic", "exactEvidence"]);
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor", "any", "unknown", "never", "FamilyTypes"]);
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  if (Object.keys(value).some(key => FORBIDDEN.has(key) || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw new Error(`invalid ${label} fields`);
}
function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(value) || FORBIDDEN.has(value))
    throw new Error(`invalid ${label} name`);
  return value;
}
function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}`);
  const result = value.map(v => name(v, label));
  if (new Set(result).size !== result.length) throw new Error(`duplicate ${label}`);
  return result;
}
function node(raw: unknown, depth = 0): TypeNode {
  if (depth > 32) throw new Error("type schema nesting exceeds bound");
  const value = record(raw, "type node");
  if (Object.hasOwn(value, "ref")) {
    keys(value, ["ref"], ["ref"], "type reference");
    return { ref: name(value.ref, "type reference") };
  }
  if (Object.hasOwn(value, "literal")) {
    keys(value, ["literal"], ["literal"], "type literal");
    const literal = value.literal;
    if (!(typeof literal === "string" || typeof literal === "boolean" || typeof literal === "number" && Number.isSafeInteger(literal)))
      throw new Error("invalid type literal");
    return { literal };
  }
  if (Object.hasOwn(value, "array")) {
    keys(value, ["array"], ["array"], "array type");
    return { array: node(value.array, depth + 1) };
  }
  if (Object.hasOwn(value, "union")) {
    keys(value, ["union"], ["union"], "union type");
    if (!Array.isArray(value.union) || value.union.length < 2 || value.union.length > 64) throw new Error("invalid type union");
    return { union: value.union.map(v => node(v, depth + 1)) };
  }
  if (value.type === "object") {
    keys(value, ["type", "extends", "fields", "optional"], ["type", "fields"], "object type");
    const fields = Object.fromEntries(Object.entries(record(value.fields, "type fields")).map(([key, field]) =>
      [name(key, "field"), node(field, depth + 1)]));
    const optional = names(value.optional ?? [], "optional field");
    if (optional.some(key => !Object.hasOwn(fields, key))) throw new Error("optional field is not declared locally");
    return { type: "object", extends: names(value.extends ?? [], "base type"), fields, optional };
  }
  keys(value, ["type"], ["type"], "scalar type");
  if (!["string", "number", "boolean", "bigint"].includes(String(value.type))) throw new Error("unsupported scalar type");
  return { type: value.type as "string" | "number" | "boolean" | "bigint" };
}
function document(raw: unknown, child: boolean): TypeDocument {
  const value = record(raw, "type document");
  keys(value, child ? ["version", "definitions"] : ["version", "definitions", "contracts"], ["version", "definitions"], "type document");
  if (value.version !== 1) throw new Error("unsupported type schema version");
  const definitions = Object.fromEntries(Object.entries(record(value.definitions, "type definitions")).map(([key, value]) => {
    name(key, "definition");
    if (Object.hasOwn(BUILTINS, key)) throw new Error("type definition shadows a shared brand");
    return [key, node(value)];
  }));
  if (!Object.keys(definitions).length || Object.keys(definitions).length > 256) throw new Error("type definition count outside bound");
  let contracts: Record<string, string> | undefined;
  if (value.contracts !== undefined) {
    contracts = Object.fromEntries(Object.entries(record(value.contracts, "type contracts")).map(([key, value]) => {
      if (!CONTRACTS.has(key)) throw new Error("unknown type contract");
      return [key, name(value, "contract type")];
    }));
  }
  return { definitions, ...(contracts ? { contracts } : {}) };
}

export function validateDeclarativeTypeMetadata(raw: unknown, child = false): void {
  document(raw, child);
}

/** All protocol fields come from JSON. Shared imports are an explicit closed
 * set of existing brands; no Family DTO is moved into this module. */
export function renderDeclarativeFamilyTypes(rootTypes: unknown, childTypes: readonly unknown[] = []): string {
  const root = document(rootTypes, false), children = childTypes.map(value => document(value, true));
  const definitions: Record<string, TypeNode> = {};
  for (const d of [root, ...children]) for (const [key, value] of Object.entries(d.definitions)) {
    if (Object.hasOwn(definitions, key)) throw new Error(`duplicate declared type: ${key}`);
    definitions[key] = value;
  }
  const usedBuiltins = new Set<string>(), active = new Set<string>(), checked = new Set<string>();
  function reference(key: string, requireObject = false): void {
    if (Object.hasOwn(BUILTINS, key)) {
      if (requireObject && !OBJECT_BASES.has(key)) throw new Error("object cannot extend scalar brand");
      usedBuiltins.add(key); return;
    }
    if (!Object.hasOwn(definitions, key)) throw new Error(`unknown declared type reference: ${key}`);
    const target = definitions[key]!;
    if (requireObject && (!("type" in target) || target.type !== "object")) throw new Error("object base must be a declared object");
    if (active.has(key)) throw new Error("cyclic declared type reference");
    if (checked.has(key)) return;
    active.add(key); visit(target); active.delete(key); checked.add(key);
  }
  function visit(value: TypeNode): void {
    if ("ref" in value) reference(value.ref);
    else if ("array" in value) visit(value.array);
    else if ("union" in value) value.union.forEach(visit);
    else if ("type" in value && value.type === "object") {
      value.extends.forEach(base => reference(base, true));
      Object.values(value.fields).forEach(visit);
    }
  }
  Object.keys(definitions).forEach(key => reference(key));
  for (const ref of Object.values(root.contracts ?? {})) {
    if (!Object.hasOwn(definitions, ref)) throw new Error("contract must refer to a declared type");
    reference(ref);
  }
  function render(value: TypeNode, indent = ""): string {
    if ("ref" in value) return value.ref;
    if ("literal" in value) return JSON.stringify(value.literal);
    if ("array" in value) return `ReadonlyArray<${render(value.array, indent)}>`;
    if ("union" in value) return value.union.map(v => `(${render(v, indent)})`).join(" | ");
    if (value.type !== "object") return value.type;
    const fields = Object.entries(value.fields).map(([key, child]) =>
      `${indent}  readonly ${key}${value.optional.includes(key) ? "?" : ""}: ${render(child, indent + "  ")};`);
    const own = `{\n${fields.join("\n")}\n${indent}}`;
    return [...value.extends, own].join(" & ");
  }
  const byModule = new Map<string, string[]>();
  for (const builtin of [...usedBuiltins].sort()) {
    const path = BUILTINS[builtin]!; byModule.set(path, [...byModule.get(path) ?? [], builtin]);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([root, ...children])).digest("hex");
  return ["// Generated from Family JSON type metadata. Do not edit.", `// Type schema SHA-256: ${fingerprint}`,
    ...[...byModule].sort(([a], [b]) => a.localeCompare(b)).map(([path, names]) =>
      `import type { ${names.join(", ")} } from ${JSON.stringify(path)};`), "",
    ...Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) =>
      `export type ${key} = ${render(value)};\n`),
    ...(root.contracts ? ["export type FamilyTypes = {", ...Object.entries(root.contracts).map(([key, type]) =>
      `  readonly ${key}: ${type};`), "};", ""] : []),
  ].join("\n");
}
