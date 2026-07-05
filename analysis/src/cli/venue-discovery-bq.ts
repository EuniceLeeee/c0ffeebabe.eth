import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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

/** Auto-detect: JSON array ('['), NDJSON ('{' per line), or a BigQuery CSV export (header row).
 *  BigQuery JSON stringifies numbers, so string block_number/log_index/receipt_status are coerced. */
async function readRows(path: string): Promise<BqLogRow[]> {
  const content = await readAll(path);
  const trimmed = content.trimStart();
  if (!trimmed) return [];
  if (trimmed[0] === "[") {
    const arr = JSON.parse(content) as unknown[];
    if (!Array.isArray(arr)) throw new Error("JSON input must be an array of row objects");
    return arr.map((r) => coerceRow(r as Record<string, unknown>));
  }
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  if (lines[0].trimStart().startsWith("{")) {
    return lines.map((line, i) => {
      try {
        return coerceRow(JSON.parse(line.trim()) as Record<string, unknown>);
      } catch (error) {
        throw new Error(`Invalid NDJSON at line ${i + 1}: ${(error as Error).message}`);
      }
    });
  }
  return parseCsv(lines);
}

async function readAll(path: string): Promise<string> {
  if (path) return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function coerceRow(row: Record<string, unknown>): BqLogRow {
  return {
    ...(row as unknown as BqLogRow),
    block_number: toNum(row.block_number),
    transaction_index: toNum(row.transaction_index),
    log_index: toNum(row.log_index),
    receipt_status: toNum(row.receipt_status),
  };
}

function toNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
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
