import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { rowsToVenueInputs, type BqLogRow } from "../discovery/bq-rows.js";
import {
  aggregateVenueCandidates,
  mergeAggregates,
  type AggregatedVenue,
} from "../discovery/venue-aggregate.js";
import { extractVenueCandidates } from "../discovery/venue-evidence.js";
import { parseArgs, writeText } from "../util.js";

const USAGE = `Usage: npm run venue-discovery-bq -- [--input <rows.ndjson|rows.csv>] [--store <venues.json>] [--out <venues.json>]
  Accepts NDJSON (one BqLogRow per line) OR a BigQuery CSV export (header
  tx_hash,...,log_address,topic0,topics,receipt_status; topics = "[0x..,0x..]"). Format auto-detected.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();

  const inputPath = optionalPathArg(args, "input");
  const storePath = optionalPathArg(args, "store");
  const outPath = optionalPathArg(args, "out");

  const rows = await readRows(inputPath);
  const inputs = rowsToVenueInputs(rows);
  const current = aggregateVenueCandidates(inputs.map((input) => extractVenueCandidates(input)));
  const output = storePath ? mergeAggregates(await readStore(storePath), current) : current;
  const json = `${JSON.stringify(output, null, 2)}\n`;

  process.stdout.write(json);
  if (outPath) await writeText(outPath, json);
  if (storePath) await writeText(storePath, json);

  console.error(renderHumanSummary({
    txs: inputs.length,
    distinctCandidates: output.length,
    protocolCount: countWithEdge(output, "protocol"),
    creditCount: countWithEdge(output, "credit"),
    lpCount: countWithEdge(output, "lp"),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

/** Auto-detect NDJSON (line starts with '{') vs a BigQuery CSV export (header row). */
async function readRows(path: string): Promise<BqLogRow[]> {
  const input = inputStream(path);
  const reader = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of reader) {
    if (line.trim()) lines.push(line);
  }
  if (lines.length === 0) return [];
  return lines[0].trimStart().startsWith("{") ? parseNdjson(lines) : parseCsv(lines);
}

function parseNdjson(lines: string[]): BqLogRow[] {
  return lines.map((line, i) => {
    try {
      return JSON.parse(line.trim()) as BqLogRow;
    } catch (error) {
      throw new Error(`Invalid NDJSON at line ${i + 1}: ${(error as Error).message}`);
    }
  });
}

/** BigQuery CSV: header line + rows; the `topics` cell is a quoted "[0x..,0x..]" array. */
function parseCsv(lines: string[]): BqLogRow[] {
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [iTx, iFrom, iExec, iLogIdx, iLogAddr, iTopics, iStatus] = [
    "tx_hash", "from_address", "executor", "log_index", "log_address", "topics", "receipt_status",
  ].map(col);
  if (iTx < 0) throw new Error(`CSV missing tx_hash column; header=${header.join(",")}`);

  const rows: BqLogRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const at = (idx: number) => (idx >= 0 ? f[idx] : undefined);
    const num = (v: string | undefined) => (v !== undefined && v !== "" ? Number(v) : undefined);
    rows.push({
      tx_hash: at(iTx) ?? "",
      from_address: at(iFrom),
      executor: at(iExec),
      log_index: num(at(iLogIdx)),
      log_address: at(iLogAddr),
      topics: parseBqTopics(at(iTopics)),
      receipt_status: num(at(iStatus)),
    });
  }
  return rows;
}

/** Quote-aware CSV field split ("" escapes a quote inside a quoted field). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** BigQuery serializes topics ARRAY<STRING> as "[0xhash1,0xhash2,...]" (unquoted elements). */
function parseBqTopics(raw: string | undefined): string[] {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return inner.split(",").map((s) => s.trim()).filter(Boolean);
}

function inputStream(path: string): Readable {
  return path ? createReadStream(path, { encoding: "utf8" }) : process.stdin;
}

async function readStore(path: string): Promise<AggregatedVenue[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Store ${path} must contain an AggregatedVenue[] JSON array`);
    return parsed as AggregatedVenue[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function renderHumanSummary(summary: {
  txs: number;
  distinctCandidates: number;
  protocolCount: number;
  creditCount: number;
  lpCount: number;
}): string {
  return [
    "[analysis/venue-discovery-bq]",
    `txs=${summary.txs}`,
    `distinct_candidates=${summary.distinctCandidates}`,
    `protocol_count=${summary.protocolCount}`,
    `credit_count=${summary.creditCount}`,
    `lp_count=${summary.lpCount}`,
  ].join(" ");
}

function countWithEdge(
  items: AggregatedVenue[],
  edgeKind: AggregatedVenue["edgeKinds"][number],
): number {
  return items.filter((item) => item.edgeKinds.includes(edgeKind)).length;
}

function optionalPathArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (value === undefined) return "";
  if (typeof value === "string" && value.trim()) return resolveCliPath(value);
  usage();
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}
