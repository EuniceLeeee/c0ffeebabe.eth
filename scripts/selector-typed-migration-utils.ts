/** Offline migration helpers. Production never imports this module. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { FunctionFragment } from "../listener/node_modules/ethers/lib.esm/index.js";
import { normalizeSelectorNativeExecutionDefinition } from "../listener/src/searcher/venues/selector-native-definition.js";
export type Data = Record<string, any>;
export const E = (op: string, ...args: any[]): Data => ({ op, args });
export const R = (runtime: string): Data => ({ runtime });
export const U = (v: string | number | bigint): Data => E("uint", String(v));
export const check = (left: any, operator: "eq" | "gte", right: any): Data => ({ left, operator, right });
export const read = (id: string, target: any, signature: string, args: any[], save: Data, checks?: any[]): Data =>
  ({ id, static: true, call: { target, signature, args, save, ...(checks ? { checks } : {}) } });
export const approval = (spender: any = "$target", requireBool = true): Data =>
  ({ token: "$route.tokenIn", spender, mode: "exact-clear", requireBool, verifyAllowance: true });
export const effects = (direct = true): any[] => [
  { kind: "debit", token: "$route.tokenIn", account: "$executor", equals: R("amountIn") },
  { kind: "credit", token: "$route.tokenOut", account: direct ? "$recipient" : "$executor", minimum: "$minAmountOut" },
  { kind: "unchanged-token", token: "$route.tokenIn", account: "$recipient", when: "$externalRecipient" },
  { kind: "unchanged-token", token: "$route.tokenOut", account: "$executor", when: "$externalRecipient" },
  { kind: "unchanged-native" },
];
export const execution = (steps: any[], direct = true): Data => ({ version: 2,
  settlement: { directOutput: direct }, protectedAddresses: ["$target", "$route.tokenIn", "$route.tokenOut"],
  steps, effects: effects(direct) });
export function model(id: string, inputs: string[], operations: Array<[string, string, any, any]>, outputs: string[]): Data {
  const known = new Set<string>();
  const operand = (v: any): any => typeof v === "number" || typeof v === "bigint" || /^\d+$/.test(v)
    ? { constant: String(v) } : inputs.includes(v) ? { input: v } : known.has(v) ? { local: v }
      : (() => { throw new Error("unknown math operand " + v); })();
  return { id, version: 1, inputs, outputs, operations: operations.map(([name, op, left, right]) => {
    const out = { name, op, left: operand(left), right: operand(right) }; known.add(name); return out;
  }) };
}
export function math(models: Data[]): Data {
  return { version: 1, entries: Object.fromEntries(models.map(m => [mathAlias(m.id), { model: m.id, version: m.version }])), models };
}
const mathAlias = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "");
export function mathStep(id: string, name: string, inputs: Data, outputs: Data, checks?: any[]): Data {
  return { id, math: { model: mathAlias(name), inputs, outputs, ...(checks ? { checks } : {}) } };
}
export const root = resolve(import.meta.dirname, "..");
const programFields = ["parameters", "payment", "values", "resourceValues", "binding", "routes", "context", "state", "checks", "execution", "math", "runtimeMath", "quoteOutput", "runtimeEvidence", "observations", "receiptChecks", "dependencies", "refreshPolicy", "ethCall"];
export function upsert(signature: string, program: Data, sourceFamily: string, recipe: string, enabled = false, domain: "swap" | "protocol" = "protocol"): Data {
  const fn = FunctionFragment.from(signature), selector = fn.selector.toLowerCase();
  const file = resolve(root, "listener/src/searcher/venues/selector-native", `selector-${selector.slice(2)}-family`, `selector-${selector.slice(2)}.json`);
  let author: Data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
    format: "selector-family/v2", selector, signature: fn.format("full"), domain,
    activation: { enabled, envKey: `SEARCHER_FAMILY_SELECTOR_${selector.slice(2).toUpperCase()}_ENABLED` },
    programs: [],
  };
  if (FunctionFragment.from(author.signature).format("sighash") !== fn.format("sighash")) throw new Error("selector collision requires separate ABI file");
  const current = author.programs ?? [Object.fromEntries(programFields.filter(k => Object.hasOwn(author, k)).map(k => [k, author[k]]))];
  const programs = current.filter((p: Data) => Object.keys(p).length && p.meta?.migrationKey !== recipe);
  const hadPrograms = programs.length > 0;
  programs.push({ ...program, meta: { ...(program.meta ?? {}), sourceFamily, migrationKey: recipe,
    sourceCommit: "fdb859a9b9b606a38c3b7afa52452752849ee465" } });
  for (const key of [...programFields, "unsupportedReason"]) delete author[key];
  author.programs = programs;
  if (!hadPrograms) author.activation = { enabled, envKey: `SEARCHER_FAMILY_SELECTOR_${selector.slice(2).toUpperCase()}_ENABLED` };
  const normalized = normalizeSelectorNativeExecutionDefinition(author);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(author, null, 2) + "\n");
  return { selector, signature: normalized.signature, sourceFamily, recipe, file: file.slice(root.length + 1),
    enabledByDefault: author.activation?.enabled ?? true };
}
