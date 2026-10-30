import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRuntimeSourceClosure } from "../venues/capability-content-hash.js";
import artifact from "../generated/family-capability-shadow.generated.json";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../venues/production-family-composition.js";
import { explicitSettlementAssertionFailures, legacySettlementRegistrarEvidenceFailures } from "./settlement-registrar-evidence.js";

type Pin = { path: string; sha256: string };
export type VariantReview = {
  id: string;
  interface: "verified" | "partial" | "unverified";
  identity: "verified" | "partial" | "unverified";
  callback: "output-first" | "input-first" | "internal-only" | "separate-funding" | "none" | "unverified";
  recipient: "yes" | "conditional" | "no" | "unverified";
  wiring: "verified" | "gap" | "unverified";
  execution: "verified" | "not-required" | "unverified";
  evidence: { path: string; sha256: string }[];
  executionEvidence?: Pin;
  ordinaryExecutionEvidence?: Pin;
  gaps: string[];
};
export type FamilyReview = { familyId: string; domain: string; coverage: "complete" | "partial";
  source: Pin[]; review: Pin; variants: VariantReview[] };
export type SettlementReview = { schema: "family-settlement-interface-review-v1"; commonSource: Pin[]; families: FamilyReview[] };
const hash = /^[a-f0-9]{64}$/;
function soliditySources(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? soliditySources(resolve(directory, e.name), `${prefix}/${e.name}`)
    : e.name.endsWith(".sol") ? [`${prefix}/${e.name}`] : []);
}
// Include the executor Solidity source tree so imported constants/interfaces and
// newly added helpers cannot be omitted by a hand-picked list of VM roots.
const COMMON_TS_ROOTS = [
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/venues/adapter-family-plugin.ts",
  "listener/src/searcher/venues/adapter-family-runtime.ts", "listener/src/searcher/strict-production-runtime-session.ts",
  "listener/src/searcher/execution-asset-boundary.ts", "listener/src/searcher/simulator/runtime-settlement.ts",
  "listener/src/searcher/simulator/blockscan-sim-amount-selector.ts",
];
export async function requiredCommonSourcePaths(root: string): Promise<string[]> {
  const paths = new Set(soliditySources(resolve(root, "src"), "src"));
  for (const entry of COMMON_TS_ROOTS) {
    const closure = await generateRuntimeSourceClosure({ rootDirectory: resolve(root, "listener"),
      entryFile: resolve(root, entry) });
    paths.add(entry);
    for (const dependency of closure.dependencyArtifacts) {
      if (dependency.logicalId.startsWith("src/")) paths.add("listener/" + dependency.logicalId);
    }
  }
  return [...paths].sort();
}

// Use the existing build-derived capability dependency graph, not a reviewer-chosen
// subset of convenient source files. Hash the current files as well as the graph.
export function requiredFamilySourcePaths(familyId: string, entry: string, generated: typeof artifact): string[] {
  const entryPath = entry.startsWith("src/") ? entry : "src/searcher/venues/production-families/" + entry;
  const paths = new Set(["listener/" + entryPath]);
  for (const e of generated.exact.filter(e => e.identity.familyId === familyId &&
    ["identity", "routes", "execution", "funding", "credit"].includes(e.identity.capability))) {
    for (const path of [e.root.entrySourceFile, ...e.root.additionalSourceFiles, ...e.identity.semanticDependencies]) {
      if (path?.startsWith("src/")) paths.add("listener/" + path);
    }
  }
  assert(paths.size > 1, "missing generated capability source closure");
  return [...paths].sort();
}
export function assertSourceCoverage(row: FamilyReview, required: string[], common: Pin[], requiredCommon: string[]) {
  assert.deepEqual(row.source.map(p => p.path).sort(), [...required].sort(), "Family source pins must cover its capability closure");
  assert.deepEqual(common.map(p => p.path).sort(), [...requiredCommon].sort(), "shared source pins must cover the execution boundary");
}


export function validateInventory(review: SettlementReview, installed: { familyId: string; domain: string }[]) {
  assert.equal(review.schema, "family-settlement-interface-review-v1");
  assert(review.commonSource.length > 0, "shared execution source is required");
  assert.equal(new Set(review.families.map(r => r.familyId)).size, review.families.length, "duplicate Family review");
  assert.deepEqual(review.families.map(r => r.familyId).sort(), installed.map(r => r.familyId).sort(),
    "review must cover all installed Families, including disabled entries");
  for (const row of review.families) {
    assert.equal(row.domain, installed.find(x => x.familyId === row.familyId)?.domain);
    assert(row.source.length > 0 && row.variants.length > 0, `${row.familyId}: source/variants required`);
    assert.equal(new Set(row.variants.map(v => v.id)).size, row.variants.length, "duplicate variant review");
    for (const pin of [...review.commonSource, ...row.source]) {
      assert(pin.path.startsWith("listener/") || pin.path.startsWith("src/"), "source pin must be repository code");
      assert(!pin.path.split("/").includes("..") && hash.test(pin.sha256), "invalid source pin");
    }
    assert(row.review.path.startsWith("docs/research/reports/") && hash.test(row.review.sha256), "verified review reference required");
    for (const v of row.variants) {
      assert(typeof v.id === "string" && v.id.trim().length > 0 && Array.isArray(v.gaps) && Array.isArray(v.evidence), "invalid variant review");
      for (const e of v.evidence) assert(e.path && hash.test(e.sha256), "evidence needs an exact source hash");
    }
  }
}

export function reviewFailures(row: FamilyReview): string[] {
  const failures: string[] = [];
  if (row.coverage !== "complete") failures.push("variant coverage is incomplete");
  for (const v of row.variants) {
    const missing = [
      ...(v.interface === "verified" ? [] : ["deployment interface"]),
      ...(v.identity === "verified" ? [] : ["deployment identity"]),
      ...(["output-first", "input-first", "internal-only", "separate-funding", "none"].includes(v.callback) ? [] : ["callback semantics"]),
      ...(["yes", "conditional", "no"].includes(v.recipient) ? [] : ["recipient semantics"]),
      ...(v.wiring === "verified" ? [] : ["capability wiring"]),
      ...(v.execution === "verified" || (v.execution === "not-required" && v.recipient === "no" &&
        (v.callback === "none" || (v.callback === "internal-only" && v.ordinaryExecutionEvidence !== undefined))) ? [] : ["execution evidence"]),
      ...(v.evidence.length > 0 ? [] : ["interface/evidence references"]), ...v.gaps,
    ];
    if (missing.length) failures.push(`${v.id}: ${missing.join("; ")}`);
  }
  return failures;
}

export function checkPins(pins: Pin[], read: (path: string) => Buffer): string[] {
  return pins.flatMap(pin => {
    try { return createHash("sha256").update(read(pin.path)).digest("hex") === pin.sha256 ? [] : [`stale source: ${pin.path}`]; }
    catch { return [`missing source: ${pin.path}`]; }
  });
}

export function evidenceFailures(row: FamilyReview, commonSource: Pin[], read: (path: string) => Buffer): string[] {
  const failures = checkPins([row.review, ...row.variants.flatMap(v => [...v.evidence,
    ...(v.executionEvidence ? [v.executionEvidence] : []),
    ...(v.ordinaryExecutionEvidence ? [v.ordinaryExecutionEvidence] : [])])], read);
  if (failures.length) return failures;
  try {
    const reviewed = JSON.parse(read(row.review.path).toString()).families.find((r: any) => r.familyId === row.familyId);
    assert(reviewed, "Family absent from independent interface review");
    assert.deepEqual(row.variants.map(v => v.id).sort(), reviewed.variants.map((v: any) => v.id ?? v.variant).sort(),
      "variant inventory differs from hashed interface review");
    // Internal protocol hooks do not create a caller settlement continuation.
    // Exemption from a new settlement mode still requires ordinary real execution.
    for (const v of row.variants.filter(v => v.execution === "not-required" && v.callback === "internal-only")) {
      assert.equal(v.recipient, "no", "recipient mode cannot skip settlement execution");
      const independent = reviewed.variants.find((x: any) => (x.id ?? x.variant) === v.id);
      assert.equal(independent.callback, "internal-only", "internal-only classification must be independently reviewed");
      assert.equal(independent.recipient, "no", "caller-only recipient must be independently reviewed");
      assert.equal(independent.callerContinuation, false, "caller continuation cannot skip settlement execution");
      assert(v.ordinaryExecutionEvidence, `${v.id}: missing ordinary execution report`);
      const ordinary = JSON.parse(read(v.ordinaryExecutionEvidence.path).toString());
      const requiredAssertions = ["actual-input-debit", "actual-output-receipt", "old-inventory"];
      assert.deepEqual([...legacySettlementRegistrarEvidenceFailures(ordinary),
        ...explicitSettlementAssertionFailures(ordinary, requiredAssertions)], [], `${v.id}: unsupported ordinary execution evidence`);
      assert.equal(ordinary.kind, "family-ordinary-execution-evidence-v1");
      assert.equal(ordinary.familyId, row.familyId);
      assert(Array.isArray(ordinary.variantIds) && ordinary.variantIds.every((x: unknown) => typeof x === "string"));
      assert(ordinary.variantIds.includes(v.id));
      assert.equal(ordinary.result, "pass");
      assert(Number.isSafeInteger(ordinary.positiveExecutions) && ordinary.positiveExecutions > 0);
      assert(Number.isSafeInteger(ordinary.rejections) && ordinary.rejections >= 0);
      assert.deepEqual(ordinary.source, row.source, "ordinary execution did not use the reviewed Family source");
      assert.deepEqual(ordinary.commonSource, commonSource, "ordinary execution did not use the reviewed common executor");
      assert(Array.isArray(ordinary.verifiedAssertions) && ordinary.verifiedAssertions.every((x: unknown) => typeof x === "string"));
      for (const required of requiredAssertions) {
        assert(ordinary.verifiedAssertions.includes(required), `${v.id}: missing ${required}`);
      }
      assert(Array.isArray(ordinary.evidence) && ordinary.evidence.length > 0, "ordinary execution needs saved evidence references");
      for (const pin of ordinary.evidence) assert(typeof pin.path === "string" && pin.path.length > 0 &&
        typeof pin.sha256 === "string" && hash.test(pin.sha256), "ordinary execution needs exact evidence pins");
      failures.push(...checkPins(ordinary.evidence, read));
    }
    for (const v of row.variants.filter(v => v.execution === "verified")) {
      assert(v.executionEvidence, `${v.id}: missing execution report`);
      const behavior = JSON.parse(read(v.executionEvidence.path).toString());
      const requiredAssertions = ["actual-input-debit", "actual-output-receipt", "old-inventory", "rollback",
        ...(v.callback === "output-first" ? ["callback-caller", "callback-debt", "output-before-payment"] : [])];
      assert.deepEqual([...legacySettlementRegistrarEvidenceFailures(behavior),
        ...explicitSettlementAssertionFailures(behavior, requiredAssertions)], [], `${v.id}: unsupported settlement execution evidence`);
      assert.equal(behavior.kind, "family-settlement-behavior-evidence-v1", "interface-only evidence is not an execution");
      assert.equal(behavior.familyId, row.familyId);
      assert(Array.isArray(behavior.variantIds) && behavior.variantIds.every((x: unknown) => typeof x === "string"));
      assert(behavior.variantIds.includes(v.id));
      assert(Array.isArray(behavior.verifiedAssertions) && behavior.verifiedAssertions.every((x: unknown) => typeof x === "string"));
      assert.equal(behavior.result, "pass");
      assert(Number.isSafeInteger(behavior.positiveExecutions) && behavior.positiveExecutions > 0);
      assert(Number.isSafeInteger(behavior.rejections) && behavior.rejections > 0);
      assert.deepEqual(behavior.source, row.source, "execution did not use the reviewed Family source");
      assert.deepEqual(behavior.commonSource, commonSource, "execution did not use the reviewed common executor");
      for (const required of requiredAssertions) {
        assert(behavior.verifiedAssertions.includes(required), `${v.id}: missing ${required}`);
      }
      assert(Array.isArray(behavior.evidence) && behavior.evidence.length > 0, "execution needs saved evidence references");
      failures.push(...checkPins(behavior.evidence, read));
    }
  } catch (error) { failures.push(`invalid review evidence: ${String(error)}`); }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 2 && args[0] === "--family"), "usage: [--family <installed-family-id>]");
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const fresh = spawnSync("npm", ["run", "family-capability-manifest:check"], {
    cwd: resolve(root, "listener"), stdio: "inherit", env: process.env,
  });
  assert.equal(fresh.status, 0, "current generated capability dependency closure is stale");
  const review = JSON.parse(readFileSync(resolve(root, "docs/research/reports/family-settlement-interface-review-20261014.json"), "utf8")) as SettlementReview;
  const installed = [...load.plugins, ...load.disabledPlugins].map(p => ({ familyId: p.familyId, domain: p.plugin.manifest.domain }));
  validateInventory(review, installed);
  const selected = args.length ? review.families.filter(r => r.familyId === args[1]) : review.families;
  assert(selected.length > 0, "unknown installed Family");
  const requiredCommon = await requiredCommonSourcePaths(root);
  const common = checkPins(review.commonSource, path => readFileSync(resolve(root, path)));
  const results = selected.map(row => {
    const module = [...load.plugins, ...load.disabledPlugins].find(p => p.familyId === row.familyId)!;
    assertSourceCoverage(row, requiredFamilySourcePaths(row.familyId, module.sourceFile, artifact), review.commonSource, requiredCommon);
    const failures = [...common, ...evidenceFailures(row, review.commonSource, path => readFileSync(resolve(root, path))), ...checkPins(row.source, path => readFileSync(resolve(root, path))), ...reviewFailures(row)];
    return { familyId: row.familyId, passed: failures.length === 0, failures };
  });
  console.log(JSON.stringify({ scope: "settlement capability acceptance only", installed: installed.length, results }, null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
