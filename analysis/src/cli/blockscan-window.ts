import { readFile } from "node:fs/promises";
import { parseArgs } from "../util.js";
import {
  analyzeWindow,
  type RunStats,
  type WindowReport,
} from "../blockscan-window.js";

const args = parseArgs(process.argv.slice(2));
const logPath = readString(args.log) ?? "/var/log/mev-live.log";
const startLine = readPositiveInteger(args["start-line"]) ?? 1;
const endLine = readPositiveInteger(args["end-line"]);
const minRun = readPositiveInteger(args["min-run"]) ?? 30;

async function main(): Promise<void> {
  const text = await readFile(logPath, "utf8");
  const report: WindowReport = analyzeWindow(text, {
    startLine,
    endLine,
    minRun,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main();

function readString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error("expected a positive integer");
  }
  return Number(value);
}
