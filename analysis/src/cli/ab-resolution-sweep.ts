#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { runResolutionSweep } from "../ab-resolution-sweep.js";

const args = new Set(process.argv.slice(2));
if (["--scan", "--verify", "--apply"].filter((flag) => args.has(flag)).length > 1) {
  throw new Error("usage: ab-resolution-sweep [--scan|--verify|--apply] [--json]");
}
const mode = args.has("--apply") ? "apply" : args.has("--verify") ? "verify" : "scan";
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const results = runResolutionSweep(repoRoot, mode);

if (args.has("--json")) {
  console.log(JSON.stringify({ schema_version: 1, mode, results }, null, 2));
} else if (results.length === 0) {
  console.log("No retained ab/* branches found.");
} else {
  for (const result of results) {
    console.log(`${result.status}\t${result.branch}\t${result.problem_id ?? "unknown"}\t${result.detail}`);
  }
}
