import { getAddress } from "ethers";
import { createMutationLookup } from "./mutation-index.js";
import type { CompiledMutationIndex, MutationPricingEntry, UnifiedObservation } from "./adapter-family-plugin.js";

/** Extract only a necessary, side-effect-free equality from an existing mutation predicate. */
type Expression = unknown;
type Equality = { readonly observation: Expression; readonly entry: Expression; readonly prefix?: readonly Expression[] };
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

function pathExpression(value: unknown, root: string): boolean {
  if (typeof value === "string") {
    if (!value.startsWith("$")) return true;
    return !value.slice(1).split(".").some(part => forbidden.has(part)) &&
      (value === root || value.startsWith(root + "."));
  }
  if (value === null || ["undefined", "number", "boolean", "bigint"].includes(typeof value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as { op?: string; args?: unknown[] };
  if (!Array.isArray(node.args)) return false;
  if (node.op === "get" || node.op === "at") {
    const key = node.args[1];
    const literalKey = typeof key === "string" ? !key.startsWith("$") && !forbidden.has(key)
      : typeof key === "number" && Number.isSafeInteger(key);
    return literalKey && pathExpression(node.args[0], root);
  }
  return (node.op === "lower" || node.op === "string") && node.args.length === 1 &&
    pathExpression(node.args[0], root);
}

function references(value: unknown, root: string): boolean {
  if (typeof value === "string") return value === root || value.startsWith(root + ".");
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(item => references(item, root));
}

function safePrefix(value: unknown): boolean {
  if (pathExpression(value, "$observation")) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as { op?: string; args?: unknown[] };
  return ["and", "or", "eq", "ne", "not", "defined"].includes(node.op ?? "") &&
    Array.isArray(node.args) && node.args.every(safePrefix);
}

export function declarativeMutationEquality(predicate: unknown): Equality | undefined {
  if (!predicate || typeof predicate !== "object" || Array.isArray(predicate)) return;
  const node = predicate as { op?: string; args?: unknown[] };
  if (!Array.isArray(node.args)) return;
  if (node.op === "and") {
    const prefix: Expression[] = [];
    for (const term of node.args) {
      const result = declarativeMutationEquality(term);
      if (result) {
        prefix.push(...(result.prefix ?? []));
        return prefix.length ? { ...result, prefix } : result;
      }
      // A prefix that depends on a descriptor needs per-entry evaluation.
      if (!safePrefix(term)) return;
      prefix.push(term);
    }
  }
  if (node.op !== "eq" || node.args.length !== 2) return;
  for (const [observation, entry] of [node.args, [...node.args].reverse()]) {
    if (references(observation, "$observation") && pathExpression(observation, "$observation") &&
        references(entry, "$descriptor") && pathExpression(entry, "$descriptor")) {
      return { observation, entry };
    }
  }
}

/** Restrict the address index by a necessary equality. Its caller still runs the full predicate. */
export function compileKeyedAddressMutations<D, R>(
  entries: readonly MutationPricingEntry<D, R>[],
  select: (entry: MutationPricingEntry<D, R>) => { addresses: readonly string[]; keys: readonly string[] },
  options: {
    kinds: readonly ("log" | "call")[];
    entryKey: (entry: MutationPricingEntry<D, R>) => unknown;
    observationKey: (observation: UnifiedObservation) => readonly [unknown] | undefined;
  },
): CompiledMutationIndex {
  const fallback = createMutationLookup();
  const byAddress = new Map<string, Map<unknown, Set<string>>>();
  for (const entry of entries) {
    const dependencies = new Set(entry.dependencies.map(address => address.toLowerCase()));
    const selected = select(entry);
    for (const emitter of selected.addresses) {
      const address = getAddress(emitter).toLowerCase();
      if (!dependencies.has(address)) continue;
      let value: unknown;
      try {
        value = options.entryKey(entry);
      } catch {
        // Let the original predicate evaluate keys which may be short-circuited.
        fallback.add(address, selected.keys);
        continue;
      }
      const byValue = byAddress.get(address) ?? new Map<unknown, Set<string>>();
      const keys = byValue.get(value) ?? new Set<string>();
      for (const key of selected.keys) {
        if (typeof key !== "string" || key.length === 0) throw new Error("mutation state key must be a non-empty string");
        keys.add(key.toLowerCase());
      }
      byValue.set(value, keys);
      byAddress.set(address, byValue);
    }
  }
  const addresses = Object.freeze([...new Set([...fallback.addresses(), ...byAddress.keys()])]);
  const lookup = new Map([...byAddress].map(([address, values]) => [
    address, new Map([...values].map(([value, keys]) => [value, Object.freeze([...keys])])),
  ]));
  const logs = options.kinds.includes("log"), calls = options.kinds.includes("call");
  const empty: readonly string[] = Object.freeze([]);
  return Object.freeze({
    dependencies: addresses,
    affectedStateKeys({ observation }: { readonly observation: UnifiedObservation }): readonly string[] {
      const address = observation.kind === "log" && logs ? observation.address
        : observation.kind === "call" && calls ? observation.target : undefined;
      if (address === undefined) return empty;
      const unindexed = fallback.get(address);
      const values = lookup.get(address.toLowerCase());
      if (!values) return unindexed;
      try {
        const key = options.observationKey(observation);
        if (!key) return empty;
        const matched = values.get(key[0]) ?? empty;
        return unindexed.length ? [...unindexed, ...matched] : matched;
      } catch {
        // The caller evaluates the original predicate in its original candidate order.
        return [...unindexed, ...Array.from(values.values()).flat()];
      }
    },
  });
}
