import { readFile } from "node:fs/promises";
import { analyzeBlockScanKpiLog } from "../blockscan-kpi.js";
import { parseArgs } from "../util.js";

const args = parseArgs(process.argv.slice(2));
const logPath = readString(args.log) ?? "/var/log/mev-live.log";
const startLine = readPositiveInteger(args["start-line"], "--start-line");

const report = analyzeBlockScanKpiLog(await readFile(logPath, "utf8"), {
  ...(startLine === undefined ? {} : { startLine }),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function readString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(
  value: string | boolean | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return Number(value);
}
