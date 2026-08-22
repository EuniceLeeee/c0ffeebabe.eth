import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "../util.js";
import { analyzePassLatency } from "../blockscan-pass-latency.js";

const args = parseArgs(process.argv.slice(2));
const logPath = readString(args.log) ?? "/var/log/mev-live.log";
const startLine = readPositiveInteger(args["start-line"]) ?? 1;
const endLine = readPositiveInteger(args["end-line"]);
const minRun = readPositiveInteger(args["min-run"]) ?? 100;
const thresholdMs = readPositiveInteger(args["threshold-ms"]) ?? 10_000;

async function main(): Promise<void> {
  const lines: string[] = [];
  const stream = createReadStream(logPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber++;
    if (lineNumber < startLine) continue;
    if (endLine !== undefined && lineNumber > endLine) break;
    lines.push(line);
  }
  if (lines.at(-1) === "") lines.pop();
  const report = analyzePassLatency(lines.join("\n") + "\n", {
    startLine,
    endLine: endLine ?? startLine + lines.length - 1,
    minRun,
    thresholdMs,
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
