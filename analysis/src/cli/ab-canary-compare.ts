#!/usr/bin/env node
import fs from "node:fs";
import { compareBlockScanLogs, type AbCompareOptions } from "../ab-canary.js";

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
if (!aLog || !bLog || !out) {
  throw new Error("usage: ab-canary-compare --a-log <path> --b-log <path> --out <json> [metric options]");
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
const result = compareBlockScanLogs(fs.readFileSync(aLog, "utf8"), fs.readFileSync(bLog, "utf8"), options);
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
