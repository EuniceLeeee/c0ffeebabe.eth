import flow from "./sampled-conversion-flow.json";
import type { DeclarativeIdentityDocument } from "./declarative-identity.js";

/** Declarative templates are data, not handler names. Parameter expansion has
 * no evaluation, dynamic module loading, transport or admission authority. */
export function expandConversionDefinition(definition: {
  readonly version: number;
  readonly workflow: string;
  readonly abi: unknown;
  readonly parameters: unknown;
}): DeclarativeIdentityDocument {
  if (definition.version !== 1 || definition.workflow !== "sampled-conversion-v1")
    throw new Error("unsupported conversion definition");
  function jsonValue(value: unknown): void {
    if (value === undefined || typeof value === "function" || typeof value === "bigint" ||
        (typeof value === "number" && !Number.isSafeInteger(value))) throw new Error("definition must be lossless JSON");
    if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("forbidden definition key");
      jsonValue(item);
    });
  }
  jsonValue(definition);
  const root = JSON.parse(JSON.stringify(definition));
  function lookup(path: string): any {
    let value = root;
    for (const key of path.split(".")) {
      if (["__proto__", "constructor", "prototype"].includes(key) || !value || !Object.prototype.hasOwnProperty.call(value, key))
        throw new Error(`unknown declaration parameter ${path}`);
      value = value[key];
    }
    return value;
  }
  function expand(value: any): any {
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") {
      if (Object.prototype.hasOwnProperty.call(value, "parameter")) {
        if (Object.keys(value).length !== 1) throw new Error("invalid declaration slot");
        return lookup(value.parameter);
      }
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const expandedKey = expand(key);
        if (["__proto__", "constructor", "prototype"].includes(expandedKey) || Object.prototype.hasOwnProperty.call(result, expandedKey))
          throw new Error("duplicate or forbidden expanded definition key");
        result[expandedKey] = expand(item);
      }
      return result;
    }
    if (typeof value !== "string") return value;
    const expanded = value.replace(/\{\{([a-zA-Z][a-zA-Z0-9_.]*)\}\}/g, (_, name) => {
      const replacement = lookup(`parameters.${name}`);
      if (typeof replacement !== "string" || replacement.includes("{{")) throw new Error("invalid declaration text parameter");
      return replacement;
    });
    if (expanded.includes("{{") || expanded.includes("}}")) throw new Error("unresolved declaration parameter");
    return expanded;
  }
  return expand(flow) as DeclarativeIdentityDocument;
}
