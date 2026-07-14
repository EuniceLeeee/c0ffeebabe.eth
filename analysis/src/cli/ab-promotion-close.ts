#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closePromotion } from "../ab-promotion-close.js";

const args = process.argv.slice(2);
const reportPath = args[0];
if (!reportPath || args.length > 2 || (args.length === 2 && args[1] !== "--json")) {
  throw new Error("usage: ab-promotion-close <docs/research/reports/*.md> [--json]");
}
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const result = closePromotion(repoRoot, reportPath);
if (args.includes("--json")) {
  console.log(JSON.stringify({ schema_version: 1, result }, null, 2));
} else {
  console.log(`${result.status}\t${result.branch}\t${result.challenger_commit}\t${result.archive_commit}`);
}
