import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { serialize, deserialize } from "node:v8";
import type { HistoricalPricingBaseline } from "./strict-current-runtime-coordinator.js";
import type { BlockScanAmountReference } from "./blockscan-amount-reference.js";
import type { BlockScanStageTiming, BlockScanStageBoundary } from "./blockscan-pass-timeline.js";

export interface HistoricalBenchmarkBaseline {
  readonly version: 1;
  readonly readyPath: string;
  readonly readySha256: string;
  readonly chainId: string;
  readonly executor: string;
  readonly owner: string;
  readonly pricingPolicy: { readonly spreadBps: number; readonly fixedWethInput: bigint | null; readonly cascade: boolean };
  readonly pricing: HistoricalPricingBaseline;
  readonly amounts: ReturnType<BlockScanAmountReference["exportHistoricalBaseline"]>;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function assertHistoricalSamplingPolicy(
  stored: HistoricalBenchmarkBaseline["pricingPolicy"],
  requested: HistoricalBenchmarkBaseline["pricingPolicy"],
): void {
  // With an explicit fixed P, the enumeration threshold cannot affect sampling.
  // Gas-derived/default sampling still requires the original threshold.
  const sameFixedInput = stored.fixedWethInput !== null && stored.fixedWethInput > 0n &&
    stored.fixedWethInput === requested.fixedWethInput;
  assert.deepEqual(sameFixedInput ? { ...stored, spreadBps: requested.spreadBps } : stored,
    requested, "benchmark sampling policy changed; compatible existing baseline required");
}

// Convert immutable map facades to native data before v8 serialization. Preserve
// sharing (especially graph edges and quote paths), with no JSON string ceiling.
export function historicalBaselineData(value: any, seen = new WeakMap<object, any>()): any {
  if (value === null || typeof value !== "object") {
    assert(typeof value !== "function" && typeof value !== "symbol", "baseline must contain data only");
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (typeof value.get === "function" && typeof value.entries === "function" && typeof value.size === "number") {
    const result = new Map(); seen.set(value, result);
    for (const [key, entry] of value.entries()) result.set(historicalBaselineData(key, seen), historicalBaselineData(entry, seen));
    return result;
  }
  if (value instanceof Set) {
    const result = new Set(); seen.set(value, result);
    for (const entry of value) result.add(historicalBaselineData(entry, seen));
    return result;
  }
  assert(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    "baseline cannot serialize runtime authority or class instances");
  const result: any = Array.isArray(value) ? [] : {}; seen.set(value, result);
  for (const key of Object.keys(value)) result[key] = historicalBaselineData(value[key], seen);
  return result;
}

export function writeHistoricalBenchmarkBaseline(path: string, baseline: HistoricalBenchmarkBaseline): void {
  const bytes = serialize(historicalBaselineData(baseline));
  const dataPath = `${path}.bin`;
  writeFileSync(dataPath, bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(path, JSON.stringify({ schema: "historical-production-baseline/v1", file: basename(dataPath), sha256: sha(bytes),
    sourceBlock: baseline.pricing.pricing.sourceBlock, sourceBlockHash: baseline.pricing.pricing.sourceBlockHash,
    readySha256: baseline.readySha256, bytes: bytes.length,
    cacheProfile: "pricing-and-forward-lineage; fresh-Funding-and-Exact-authority; opaque-exact-evidence-not-restored" }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
}

export function readHistoricalBenchmarkBaseline(path: string): { baseline: HistoricalBenchmarkBaseline; sha256: string } {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert(manifest.schema === "historical-production-baseline/v1" && manifest.file === basename(manifest.file),
    "invalid historical production baseline manifest");
  const bytes = readFileSync(resolve(dirname(path), manifest.file));
  assert(bytes.length === manifest.bytes && sha(bytes) === manifest.sha256, "historical baseline bytes changed");
  const baseline = deserialize(bytes) as HistoricalBenchmarkBaseline;
  assert(baseline.version === 1 && baseline.readySha256 === manifest.readySha256 &&
    baseline.pricing.pricing.sourceBlock === manifest.sourceBlock && baseline.pricing.pricing.sourceBlockHash === manifest.sourceBlockHash,
  "historical baseline manifest mismatch");
  return { baseline, sha256: manifest.sha256 };
}

export interface HistoricalBenchmarkSample {
  block: number;
  outcome: string;
  reason?: string;
  totalMs: number;
  callWallMs: number;
  pipelineWallMs?: number;
  persistenceDrainMs?: number;
  completePrices: boolean;
  timing: BlockScanStageTiming;
  stages: Record<string, BlockScanStageBoundary>;
  error?: string;
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
    p90: sorted.length ? sorted[Math.ceil(sorted.length * 0.9) - 1] : null,
    max: sorted.at(-1) ?? null };
}

/** No-candidate blocks are legitimate outcomes, not EV samples. Censored/failed
 * blocks remain visible, and zero/not-run stages never enter stage averages. */
export function historicalBenchmarkSummary(samples: readonly HistoricalBenchmarkSample[], expectedBlocks: number) {
  const censored = (s: HistoricalBenchmarkSample) => !!s.error || !s.completePrices ||
    ["budget_exceeded", "stale_state", "startup_warm", "degraded"].includes(s.outcome) ||
    Object.values(s.stages).some(stage => stage.status === "failed");
  const valid = samples.filter(s => !censored(s));
  return { expectedBlocks, observedBlocks: samples.length, missingBlocks: expectedBlocks - samples.length,
    validBlocks: valid.length, censoredBlocks: samples.filter(censored).map(s => ({ block: s.block, outcome: s.outcome, reason: s.reason, error: s.error })),
    outcomes: Object.fromEntries([...new Set(samples.map(s => s.outcome))].map(outcome => [outcome, samples.filter(s => s.outcome === outcome).length])),
    totalMs: distribution(valid.map(s => s.totalMs)), callWallMs: distribution(valid.map(s => s.callWallMs)),
    allObservedCallWallMs: distribution(samples.map(s => s.callWallMs)),
    persistenceDrainMs: distribution(samples.flatMap(s => s.persistenceDrainMs === undefined ? [] : [s.persistenceDrainMs])),
    afterFirstTransitionTotalMs: distribution(valid.filter(s => s.block !== samples[0]?.block).map(s => s.totalMs)),
    reachedEvBlocks: valid.filter(s => s.stages.ev?.status === "ran").length,
    stages: Object.fromEntries(["state", "enumeration", "exact_refine", "planner_solver", "final_sim", "ev"].map(stage =>
      [stage, distribution(valid.filter(s => s.stages[stage]?.status === "ran").map(s => s.stages[stage]!.stage_ms))])),
    timingContract: "totalMs is production pipeline; callWallMs includes pass cleanup; shared continuation writer runs across blocks and drains only at shutdown (production-writers.json); legacy persistenceDrainMs applies only to earlier per-block-drain samples; service stages can overlap; load/restore and deferred CLI evidence excluded; no WS arrival queue",
  };
}
