import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "../util.js";
import { createPassLatencyAnalyzer } from "../blockscan-pass-latency.js";

const args = parseArgs(process.argv.slice(2));
const logPath = readString(args.log) ?? "/var/log/mev-live.log";
const logStartLine = readPositiveInteger(args["start-line"]) ?? 1;
const endLine = readPositiveInteger(args["end-line"]);
const minRun = readPositiveInteger(args["min-run"]) ?? 100;
const thresholdMs = readPositiveInteger(args["threshold-ms"]) ?? 10_000;

async function main(): Promise<void> {
  const analyzer = createPassLatencyAnalyzer({
    // The analyzed text is the sliced window; core numbering is relative.
    startLine: 1,
    logStartLine,
    minRun,
    thresholdMs,
  });
  const stream = createReadStream(logPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let trailingEmpty = false;
  let pushedLines = 0;
  for await (const line of reader) {
    lineNumber++;
    if (lineNumber < logStartLine) continue;
    if (endLine !== undefined && lineNumber > endLine) break;
    if (trailingEmpty) {
      analyzer.pushLine("");
      pushedLines++;
    }
    trailingEmpty = line === "";
    if (trailingEmpty) continue;
    analyzer.pushLine(line);
    pushedLines++;
  }
  // The legacy string API analyzes one empty line for an empty selection.
  if (pushedLines === 0) analyzer.pushLine("");
  const report = analyzer.finish();
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
