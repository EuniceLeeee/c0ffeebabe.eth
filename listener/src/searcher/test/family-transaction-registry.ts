import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const familyTransactionRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const familyTransactionDirectory = "src/searcher/test/fixtures/family-transactions";
export type FamilyTransactionDomain = "swap" | "protocol" | "credit" | "funding";
export interface FamilyTransactionLeg {
  readonly id: string;
  readonly familyId: string;
  readonly domain: FamilyTransactionDomain;
  readonly source?: { readonly number: number; readonly hash: string };
  readonly instanceKey?: string;
  readonly lineageId?: string;
  readonly tokenIn?: string;
  readonly tokenOut?: string;
  readonly amountIn?: string;
  readonly routeKey?: string;
  readonly amountScope: string;
  readonly actors?: { readonly executor: string; readonly owner: string };
  readonly credit?: { readonly debtBps: number };
  readonly funding?: { readonly fee?: string };
  readonly historicalAmountOut?: string;
  readonly referenceMissing?: readonly string[];
  readonly provenance?: readonly unknown[];
}
export interface FamilyTransaction {
  readonly version: 1;
  readonly chainId: 1;
  readonly transactionHash: string;
  readonly legs: readonly FamilyTransactionLeg[];
  readonly provenance?: readonly unknown[];
}
const hash = (x: unknown) => typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x);
const address = (x: unknown) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
const uint = (x: unknown) => typeof x === "string" && /^(0|[1-9][0-9]*)$/.test(x) && BigInt(x) < (1n << 256n);
const nonempty = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.trim() === x;
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** A transaction supplies seed values, never a passing result or admission.
 * Missing optional seed fields remain visible; malformed supplied fields fail. */
export function parseFamilyTransaction(value: unknown): FamilyTransaction {
  assert(object(value) && value.version === 1 && value.chainId === 1, "invalid transaction registry version/chain");
  assert(hash(value.transactionHash), "transactionHash must be a lowercase bytes32");
  assert(Array.isArray(value.legs) && value.legs.length > 0, "transaction requires leg references");
  const ids = new Set<string>();
  for (const leg of value.legs) {
    assert(object(leg) && nonempty(leg.id) && !ids.has(leg.id), "invalid/duplicate transaction leg id");
    ids.add(leg.id);
    assert(nonempty(leg.familyId) && ["swap", "protocol", "credit", "funding"].includes(leg.domain), "invalid leg Family/domain");
    assert(nonempty(leg.amountScope), "amount origin must be explicit");
    for (const key of ["instanceKey", "lineageId", "routeKey"]) assert(leg[key] === undefined || nonempty(leg[key]), `invalid ${key}`);
    for (const key of ["tokenIn", "tokenOut"]) assert(leg[key] === undefined || address(leg[key]), `invalid ${key}`);
    for (const key of ["amountIn", "historicalAmountOut"]) assert(leg[key] === undefined || uint(leg[key]), `invalid ${key}`);
    if (leg.source !== undefined) assert(object(leg.source) && Number.isSafeInteger(leg.source.number) && leg.source.number >= 0 && hash(leg.source.hash), "invalid source pin");
    if (leg.actors !== undefined) assert(object(leg.actors) && address(leg.actors.executor) && address(leg.actors.owner) && leg.actors.executor.toLowerCase() !== leg.actors.owner.toLowerCase(), "invalid isolated test actors");
    if (leg.credit !== undefined) assert(leg.domain === "credit" && object(leg.credit) && Number.isSafeInteger(leg.credit.debtBps) && leg.credit.debtBps > 0 && leg.credit.debtBps <= 10_000, "invalid Credit test policy");
    if (leg.funding !== undefined) assert(leg.domain === "funding" && object(leg.funding) && (leg.funding.fee === undefined || uint(leg.funding.fee)), "invalid Funding reference");
    if (leg.referenceMissing !== undefined) assert(Array.isArray(leg.referenceMissing) && leg.referenceMissing.every(nonempty), "invalid referenceMissing");
    if (leg.provenance !== undefined) assert(Array.isArray(leg.provenance), "invalid leg provenance");
  }
  if (value.provenance !== undefined) assert(Array.isArray(value.provenance), "invalid transaction provenance");
  return structuredClone(value) as FamilyTransaction;
}

export function familyTransactionLegMissing(leg: FamilyTransactionLeg): string[] {
  const missing = ["source", "instanceKey", "lineageId", "tokenIn", "tokenOut", "amountIn"]
    .filter(key => (leg as any)[key] === undefined);
  if (leg.amountIn !== undefined && BigInt(leg.amountIn) === 0n) missing.push("positive amountIn");
  if (leg.domain === "credit" && leg.credit === undefined) missing.push("credit.debtBps");
  if (leg.domain === "funding" && leg.tokenIn && leg.tokenOut && leg.tokenIn.toLowerCase() !== leg.tokenOut.toLowerCase()) missing.push("Funding tokenIn/tokenOut must identify the same borrowed asset");
  return missing;
}

export function familyTransactionInputFingerprint(transaction: FamilyTransaction, leg: FamilyTransactionLeg): string {
  assert(transaction.legs.some(item => item.id === leg.id && JSON.stringify(item) === JSON.stringify(leg)), "leg is not registered by this transaction");
  return digest(JSON.stringify({ version: transaction.version, chainId: transaction.chainId,
    transactionHash: transaction.transactionHash, leg }));
}

export function readFamilyTransaction(path: string): FamilyTransaction {
  const transaction = parseFamilyTransaction(JSON.parse(readFileSync(path, "utf8")));
  assert.equal(basename(path), `${transaction.transactionHash}.json`, "transaction filename must equal its hash");
  return transaction;
}

export function loadFamilyTransactionRegistry(root = familyTransactionRoot) {
  const directory = realpathSync(resolve(root, familyTransactionDirectory));
  const transactions = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    assert(entry.isFile() && /^0x[0-9a-f]{64}\.json$/.test(entry.name), "registry accepts only transaction JSON files, not directories/symlinks");
    const path = resolve(directory, entry.name), transaction = readFamilyTransaction(path);
    return { path, sha256: digest(readFileSync(path)), transaction };
  });
  assert(transactions.length > 0, "empty transaction registry");
  const legs = transactions.flatMap(row => row.transaction.legs.map(leg => ({ ...row, leg,
    missing: familyTransactionLegMissing(leg), inputFingerprint: familyTransactionInputFingerprint(row.transaction, leg) })));
  return { directory, transactions, legs };
}

/** Uses the same validated production composition, retaining disabled entries. */
export async function getInstalledTransactionFamilies() {
  const { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD: load } = await import("../venues/production-family-composition.js");
  assert.equal(load.issues.length, 0, "production catalog has unresolved entries");
  const families = [...load.plugins, ...load.disabledPlugins].map(({ familyId, plugin, sourceFile, activation }) => ({
    familyId: String(familyId), domain: plugin.manifest.domain as FamilyTransactionDomain,
    enabled: activation.enabled, envKey: activation.envKey, sourceFile,
    lineages: [...plugin.manifest.supportedLineages],
    // Owned execution actions, not every token-pair direction in the Graph.
    executionActions: plugin.actionAdapters.filter(action => plugin.manifest.edgeAdapterIds?.includes(action.id)).map(action => ({
      adapterId: String(action.id), action: action.descriptor.action,
    })).sort((a, b) => a.adapterId.localeCompare(b.adapterId)),
    ordinaryRuntimeLeg: "execution" in plugin && typeof plugin.execution.buildRuntimeLeg === "function",
  })).sort((a, b) => a.familyId.localeCompare(b.familyId));
  assert(families.length > 0 && new Set(families.map(row => row.familyId)).size === families.length, "empty/duplicate installed Family catalog");
  return families;
}
