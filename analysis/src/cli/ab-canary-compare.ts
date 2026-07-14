#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import { compareBlockScanLogs, type AbCompareOptions, type ManualVerdictArtifact } from "../ab-canary.js";

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberArg(args: string[], name: string, fallback: number): number {
  const raw = value(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

const args = process.argv.slice(2);
const aLog = value(args, "--a-log");
const bLog = value(args, "--b-log");
const out = value(args, "--out");
const manualPath = value(args, "--manual-verdict");
if (!aLog || !bLog || !out || !manualPath) {
  throw new Error("usage: ab-canary-compare --a-log <path> --b-log <path> --manual-verdict <json> --out <json> [metric options]");
}
const manualSource = fs.readFileSync(manualPath);
const manual = JSON.parse(manualSource.toString("utf8")) as ManualVerdictArtifact;
if (manual.schema_version !== 2 || !manual.experiment_id?.trim() || !manual.author?.trim()
    || !(["win", "lose", "inconclusive"] as string[]).includes(manual.verdict)
    || !manual.evidence?.trim() || !Number.isFinite(Date.parse(manual.written_at))
    || !/^[a-f0-9]{64}$/.test(manual.a_log_sha256)
    || !/^[a-f0-9]{64}$/.test(manual.b_log_sha256)
    || !/^[a-f0-9]{48}$/.test(manual.seal_nonce)) {
  throw new Error("--manual-verdict must be a trusted schema-v2 manual verdict artifact");
}
const aSource = fs.readFileSync(aLog);
const bSource = fs.readFileSync(bLog);
const aHash = createHash("sha256").update(aSource).digest("hex");
const bHash = createHash("sha256").update(bSource).digest("hex");
if (manual.a_log_sha256 !== aHash || manual.b_log_sha256 !== bHash
    || manual.a_log_bytes !== aSource.length || manual.b_log_bytes !== bSource.length) {
  throw new Error("manual verdict was not sealed against these exact A/B log bytes");
}
const comparatorStartedAt = new Date().toISOString();
if (Date.parse(manual.written_at) >= Date.parse(comparatorStartedAt)) {
  throw new Error("manual verdict must be written before the comparator starts");
}
const options: AbCompareOptions = {
  goal: args.includes("--expect-equal") ? "equivalence" : "improvement",
  metric: value(args, "--metric") ?? "total_ms",
  direction: (value(args, "--direction") ?? "lower") as AbCompareOptions["direction"],
  aggregate: (value(args, "--aggregate") ?? "p50") as AbCompareOptions["aggregate"],
  minPairedBlocks: numberArg(args, "--min-paired-blocks", 120),
  warmupBlocks: numberArg(args, "--warmup-blocks", 10),
  minImprovementPct: numberArg(args, "--min-improvement-pct", 5),
  minAbsoluteDelta: numberArg(args, "--min-absolute-delta", 0),
  maxRegressionPct: numberArg(args, "--max-regression-pct", 5),
  requireOutputMatch: args.includes("--require-output-match"),
};
if (options.goal === "equivalence" && !options.requireOutputMatch) {
  throw new Error("--expect-equal requires --require-output-match");
}
if (!(["lower", "higher"] as string[]).includes(options.direction)) throw new Error("invalid --direction");
if (!(["mean", "p50", "p95"] as string[]).includes(options.aggregate)) throw new Error("invalid --aggregate");
const result = compareBlockScanLogs(aSource.toString("utf8"), bSource.toString("utf8"), options);
const boundResult = {
  ...result,
  comparator_started_at: comparatorStartedAt,
  manual_verdict_path: manualPath,
  manual_verdict_sha256: createHash("sha256").update(manualSource).digest("hex"),
  manual_verdict_written_at: manual.written_at,
  manual_seal_nonce: manual.seal_nonce,
  a_log_sha256: aHash,
  b_log_sha256: bHash,
};
fs.writeFileSync(out, `${JSON.stringify(boundResult, null, 2)}\n`);
console.log(JSON.stringify(boundResult));
