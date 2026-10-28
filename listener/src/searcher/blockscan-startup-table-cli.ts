// Historical CLI data only. Optional filtering uses the production sim-reject cache.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, copyFileSync, createReadStream, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { StartupExecutionPreflight } from "./blockscan-startup-execution-preflight.js";
export { applyStartupTargetFilters } from "./blockscan-startup-filter.js";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export interface StartupTableIdentity {
  baselineSha256: string;
  readySha256: string;
  source: { number: number; hash: string; generation: number };
  chainId: string;
  executor: string;
  owner: string;
  executorCode: string;
  rawEntry: boolean;
  implementationSha256: string;
}
export type StartupTableRow = Readonly<Record<string, unknown>>;
type ExpectedRow = { amountIn?: bigint; amountOut?: bigint; instanceKey: string };
export const defaultStartupTable = (baseline: string) => resolve(baseline) + ".startup.json";

/** Bind execution code, including Family encoders, without binding diagnostics,
 * output locations or enumeration budgets. An execution edit invalidates reuse. */
function implementationFiles(root: string): [string, string][] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === "test" || item.name === "tests" || item.name === "node_modules") continue;
      const path = resolve(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && /\.(?:ts|js)$/.test(item.name) &&
        !/^blockscan-(?:at-block-cli|startup-table-cli)\.(?:ts|js)$/.test(item.name) &&
        // Standalone diagnostic entrypoints are not loaded by startup execution.
        !["check-last-hop-math.ts", "saved-route-replay-cli.ts", "saved-startup-replay-cli.ts"].includes(item.name)) files.push(path);
    }
  };
  walk(root);
  return files.sort().map(path => [relative(root, path), sha(readFileSync(path))]);
}

export function startupTableImplementation(root = fileURLToPath(new URL("../", import.meta.url))): string {
  return sha(JSON.stringify(implementationFiles(root)));
}

/** Historical experiment only: authenticate observations against their original
 * producer, and separately pin the reviewed consumer. Never relabel old results
 * as simulations of the new code. Exact hash pairs are review inputs, not an
 * automatic assertion that arbitrary edits in these files are equivalent. */
export async function readCompatibleStartupTable(path: string, consumer: StartupTableIdentity,
  expected: ReadonlyMap<string, ExpectedRow>, compatibilityPath: string,
  consumerRoot = fileURLToPath(new URL("../", import.meta.url))) {
  const bytes = readFileSync(compatibilityPath), proof = JSON.parse(bytes.toString("utf8"));
  assert(proof.schemaVersion === 1 && proof.scope === "reviewed-historical-latency-only" &&
    proof.review?.verdict === "compatible" && typeof proof.review.evidenceSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(proof.review.evidenceSha256), "reviewed compatibility manifest required");
  assert(typeof proof.producerSourceRoot === "string" && proof.producerSourceRoot.startsWith("/"));
  const before = implementationFiles(proof.producerSourceRoot), after = implementationFiles(consumerRoot);
  const producerHash = sha(JSON.stringify(before)), consumerHash = sha(JSON.stringify(after));
  assert.equal(producerHash, proof.producerImplementationSha256, "startup producer code changed");
  assert.equal(consumerHash, proof.consumerImplementationSha256, "reviewed consumer code changed");
  assert.equal(consumerHash, consumer.implementationSha256, "consumer identity differs from loaded code");
  const oldFiles = new Map(before), newFiles = new Map(after);
  const changes = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()
    .filter(file => oldFiles.get(file) !== newFiles.get(file))
    .map(file => ({ file, beforeSha256: oldFiles.get(file) ?? null, afterSha256: newFiles.get(file) ?? null }));
  // Only the exact hash pairs in the independent review may be reused. The
  // effective/reference files are eligible for consumer projection/index edits,
  // not changes to sampled amounts, quote execution, restore checks or filters.
  // Lifecycle-only persistence/transport wiring may reuse the old observations,
  // not claim new-code simulations. Exact hashes and review evidence remain
  // mandatory; Family/compiler and all but the named diagnosis-only simulator
  // files remain ineligible.
  const eligible = new Set([
    "searcher/detector/blockscan-hop-quotes.ts", "searcher/detector/blockscan-paired-enumerator.ts",
    "searcher/detector/blockscan-joint-dfs.ts", "searcher/detector/blockscan-scanner-production.ts",
    "searcher/strict-current-runtime-coordinator.ts", "searcher/blockscan-eth-view.ts",
    "searcher/blockscan-amount-reference.ts", "searcher/blockscan-effective-mid.ts",
    "searcher/detector/blockscan-scanner-core.ts",
    "searcher/main.ts",
    "searcher/blockscan-runtime-loop.ts", "searcher/blockscan-live-continuation.ts",
    "searcher/blockscan-historical-benchmark.ts", "searcher/blockscan-activity-transport.ts",
    "searcher/blockscan-startup-filter.ts", "searcher/blockscan-startup-execution-preflight.ts",
    "searcher/blockscan-sim-reject-cache.ts",
    // Consumer-only attribution wiring. Startup simulation/amount/Family
    // producers remain unchanged and separately authenticated by the review.
    "searcher/blockscan-pool-revert.ts",
    // Reviewed diagnosis-only wiring may preserve old startup observations;
    // exact source inventories and independent review still bind every change.
    "searcher/simulator/eth-simulate-v1.ts", "searcher/simulator/direct-revert-hop.ts",
  ]);
  const additions = new Set(["searcher/blockscan-live-continuation.ts", "searcher/blockscan-activity-transport.ts",
    "searcher/blockscan-startup-filter.ts"]);
  // These retired diagnostic implementations had test-only callers. Keep them
  // in the producer fingerprint and exact review delta; this permits removal
  // only, never substitution of execution code or arbitrary simulator removal.
  const retiredDiagnostics = new Set(["searcher/blockscan-startup-execution-preflight-baseline.ts",
    "searcher/standalone-input-funding.ts"]);
  assert(changes.length > 0 && changes.every(change => change.afterSha256 === null
    ? change.beforeSha256 !== null && retiredDiagnostics.has(change.file)
    : eligible.has(change.file) && (change.beforeSha256 !== null || additions.has(change.file))),
  "execution or unreviewed file changed");
  assert.deepEqual(changes, proof.changes, "source delta differs from reviewed compatibility manifest");
  assert(typeof proof.review.evidencePath === "string");
  assert.equal(sha(readFileSync(resolve(dirname(compatibilityPath), proof.review.evidencePath))),
    proof.review.evidenceSha256, "compatibility review evidence changed");
  const producer = { ...consumer, implementationSha256: producerHash };
  const table = await readStartupTable(path, producer, expected);
  return { ...table, compatibility: { manifestPath: resolve(compatibilityPath), manifestSha256: sha(bytes),
    producerIdentity: producer, consumerIdentity: consumer, changes,
    scope: "historical-fixed-observations; not new-code startup simulation evidence" } };
}

function sameIdentity(actual: StartupTableIdentity, expected: StartupTableIdentity) {
  assert.deepEqual(actual, expected,
    "startup table baseline/execution identity changed; no automatic resimulation or warmup");
}

async function scanRows(path: string, identity: StartupTableIdentity, expected?: ReadonlyMap<string, ExpectedRow>) {
  const digest = createHash("sha256"), rows = new Map<string, StartupTableRow>();
  const counts = { total: 0, succeeded: 0, targetReverted: 0, prefixReverted: 0,
    fundingReverted: 0, unattributedReverted: 0, unsupported: 0, unavailable: 0 };
  const stream = createReadStream(path);
  stream.on("data", bytes => digest.update(bytes));
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    assert(line.trim(), "empty startup observation");
    const row = JSON.parse(line) as StartupTableRow;
    assert.equal(row.sourceBlock, identity.source.number);
    assert.equal(row.sourceBlockHash, identity.source.hash);
    assert.equal(row.generation, identity.source.generation);
    assert.equal(row.mode, "observe-only");
    assert.equal(row.filterApplied, false);
    assert(typeof row.edgeId === "string" && !rows.has(row.edgeId), "missing/duplicate startup direction");
    if (expected) {
      const entry = expected.get(row.edgeId);
      assert(entry, "startup direction is absent from effective baseline");
      assert.equal(row.instanceKey, entry.instanceKey);
      assert.equal(row.expectedAmountIn, String(entry.amountIn));
      assert.equal(row.expectedAmountOut, String(entry.amountOut));
    }
    if (row.status === "success" || row.status === "revert") {
      assert.equal(row.targetBlock, identity.source.number + 1);
      assert(typeof row.scriptHash === "string" && /^0x[0-9a-f]{64}$/.test(row.scriptHash));
      if (row.status === "success") {
        assert.equal(row.failureStage, "none");
        assert.equal(row.targetAttempted, true);
        counts.succeeded++;
      } else {
        assert(["target", "prefix", "funding", "unattributed"].includes(String(row.failureStage)));
        const key = `${row.failureStage}Reverted` as "targetReverted" | "prefixReverted" | "fundingReverted" | "unattributedReverted";
        counts[key]++;
      }
    } else if (row.status === "unsupported") counts.unsupported++;
    else if (row.status === "unverified") counts.unavailable++;
    else throw new Error("incomplete/infrastructure startup result is not reusable");
    rows.set(row.edgeId, Object.freeze(row)); counts.total++;
  }
  if (expected) assert.equal(rows.size, expected.size, "startup table coverage is incomplete");
  return { rows, counts, sha256: digest.digest("hex") };
}

export async function writeStartupTable(path: string, input: {
  identity: StartupTableIdentity; observations: string;
  expected: ReadonlyMap<string, ExpectedRow>; provenance: unknown; expectedOutcomesSha256?: string;
}) {
  // Immutable sidecar + immutable data. No overwrite of an existing result.
  const dataPath = resolve(dirname(path), basename(path) + ".observations.jsonl");
  copyFileSync(input.observations, dataPath, constants.COPYFILE_EXCL);
  const checked = await scanRows(dataPath, input.identity, input.expected);
  if (input.expectedOutcomesSha256) {
    const stable = [...checked.rows].map(([id, row]) => {
      const { simulationMs: _s, nodeQueueMs: _q, revertDataHash: _r, ...result } = row;
      return [id, result] as const;
    }).sort(([a], [b]) => a.localeCompare(b));
    assert.equal(sha(JSON.stringify(stable)), input.expectedOutcomesSha256, "original simulation results changed");
  }
  const manifest = { schemaVersion: 1, complete: true, mode: "observe-only", identity: input.identity,
    observations: basename(dataPath), observationsSha256: checked.sha256, counts: checked.counts,
    provenance: input.provenance };
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return manifest;
}

export async function readStartupTable(path: string, identity: StartupTableIdentity,
  expected: ReadonlyMap<string, ExpectedRow>) {
  const bytes = readFileSync(path), manifest = JSON.parse(bytes.toString("utf8"));
  assert(manifest.schemaVersion === 1 && manifest.complete === true && manifest.mode === "observe-only",
    "incomplete startup table");
  sameIdentity(manifest.identity, identity);
  assert(typeof manifest.observations === "string" && manifest.observations === basename(manifest.observations));
  const loaded = await scanRows(resolve(dirname(path), manifest.observations), identity, expected);
  assert.equal(loaded.sha256, manifest.observationsSha256, "startup observation data changed");
  assert.deepEqual(loaded.counts, manifest.counts);
  return { ...loaded, manifestSha256: sha(bytes), path: resolve(path), identity,
    mode: "observe-only" as const, reused: true, startupSimRequests: 0, filtersAdded: 0 };
}

/** Preserve production startup-once lifecycle in the CLI, without manufacturing
 * success receipts or changing any pool/price/graph filter. */
export function cliStartupReplay(production: StartupExecutionPreflight) {
  let restored = false;
  return {
    restore(table: Awaited<ReturnType<typeof readStartupTable>>) {
      assert(table.reused && table.mode === "observe-only" && table.filtersAdded === 0);
      restored = true;
    },
    run: ((work) => restored ? Promise.resolve(false) : production.run(work)) as StartupExecutionPreflight["run"],
    reset() { restored = false; production.reset(); },
  };
}
