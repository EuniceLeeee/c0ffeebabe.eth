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
import { classifyTxLoopCoverage, type TxLoopCoverage } from "../discovery/loop-coverage.js";
import { parseArgs, writeText } from "../util.js";

const USAGE = `Usage: npm run venue-discovery-bq -- [--input <rows.ndjson|rows.csv>] [--store <venues.json>] [--out <venues.json>] [--loop-coverage|--per-tx]
  Accepts NDJSON (one BqLogRow per line) OR a BigQuery CSV export (header
  tx_hash,...,log_address,topic0,topics,receipt_status; topics = "[0x..,0x..]"). Format auto-detected.
  Default: per-VENUE aggregation (edgeKinds/protocolActions/txCount).
  --loop-coverage (alias --per-tx): per-TX loop coverage — records topic-derived emitter roles,
    unrecognized topics, observed swaps/funding, and production-listener routability without treating
    event recognition as adapter support. Receipt-only identity-dependent evidence remains unassessed;
    comparability remains requires_trace. Emits a schema-v4 { perTx, summary } JSON object instead.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();

  const inputPath = optionalPathArg(args, "input");
  const storePath = optionalPathArg(args, "store");
  const outPath = optionalPathArg(args, "out");

  const rows = await readRows(inputPath);
  const inputs = rowsToVenueInputs(rows);

  if (args["loop-coverage"] || args["per-tx"]) {
    await runLoopCoverage(inputs.map((input) => classifyTxLoopCoverage(input)), outPath);
    return;
  }

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

/** Per-TX receipt-log coverage mode. Candidate rows surface first, but only bundle-postmortem/trace may
 *  promote one to a conserving atomic_loop. */
async function runLoopCoverage(perTx: TxLoopCoverage[], outPath: string): Promise<void> {
  const output = buildLoopCoverageOutput(perTx);
  const { summary } = output;
  const json = `${JSON.stringify(output, null, 2)}\n`;

  process.stdout.write(json);
  if (outPath) await writeText(outPath, json);

  console.error(
    [
      "[analysis/venue-discovery-bq loop-coverage]",
      `txs=${summary.transactionCount}`,
      `txs_with_vault_leg=${summary.txsWithVaultLeg}`,
      `observed_swap_venues=${summary.observedSwapVenueCount}`,
      `swap_route_gap_txs=${summary.swapRouteGapTxs}`,
      `unassessed_swap_txs=${summary.unassessedSwapTxs}`,
      `funding_identity_gap_txs=${summary.fundingIdentityGapTxs}`,
      `funding_route_gap_txs=${summary.fundingRouteGapTxs}`,
      `protocol_adapter_candidates=${summary.protocolAdapterCandidateTxCount}`,
      `requires_trace=${summary.requiresTraceTxCount}`,
      `known_protocol_gap_txs=${summary.knownProtocolGapTxs}`,
      `unclassified_emitter_txs=${summary.unclassifiedEmitterTxs}`,
    ].join(" "),
  );
}

export function buildLoopCoverageOutput(perTx: TxLoopCoverage[]) {
  const sorted = [...perTx].sort(
    (a, b) =>
      b.swapRouteGaps.length - a.swapRouteGaps.length
      || b.fundingRouteGaps.length - a.fundingRouteGaps.length
      || b.fundingIdentityGaps.length - a.fundingIdentityGaps.length
      || Number(b.protocolAdapterCandidate) - Number(a.protocolAdapterCandidate)
      || a.protocolVenueGaps.length - b.protocolVenueGaps.length
      || a.unclassifiedEmitters.length - b.unclassifiedEmitters.length
      || b.protocolVenues.length - a.protocolVenues.length
      || a.tx.localeCompare(b.tx),
  );
  const withProtocol = sorted.filter((t) => t.protocolVenues.length >= 1);
  const withNamedProtocolEvidence = sorted.filter(
    (t) => t.protocolVenues.length >= 1 || t.protocolVenueGaps.length >= 1,
  );
  const withObservedSwaps = sorted.filter((t) => t.observedSwapVenues.length >= 1);
  const withUnassessedSwaps = sorted.filter((t) =>
    t.observedSwapVenues.some((venue) => venue.productionRoutability === "unassessed")
  );
  const summary = {
    schema_version: 4,
    coverage_scope: "receipt_log_emitters_only",
    routability_scope: "production_listener_descriptors_receipt_only",
    transactionCount: perTx.length,
    txsWithVaultLeg: sorted.filter((t) => t.vaults.length >= 1).length,
    txsWithProtocolLeg: withProtocol.length,
    txsWithNamedProtocolEvidence: withNamedProtocolEvidence.length,
    txsWithObservedSwaps: withObservedSwaps.length,
    observedSwapVenueCount: perTx.reduce((count, tx) => count + tx.observedSwapVenues.length, 0),
    observedSwapEmitterCount: perTx.reduce((count, tx) => count + tx.observedSwapEmitterCount, 0),
    swapRouteGapTxs: perTx.filter((t) => t.swapRouteGaps.length > 0).length,
    swapRouteGapCount: perTx.reduce((count, tx) => count + tx.swapRouteGaps.length, 0),
    unassessedSwapTxs: withUnassessedSwaps.length,
    unassessedSwapVenueCount: perTx.reduce(
      (count, tx) => count + tx.observedSwapVenues.filter(
        (venue) => venue.productionRoutability === "unassessed",
      ).length,
      0,
    ),
    observedFundingVenueCount: perTx.reduce((count, tx) => count + tx.observedFundingVenues.length, 0),
    fundingIdentityGapTxs: perTx.filter((t) => t.fundingIdentityGaps.length > 0).length,
    fundingIdentityGapCount: perTx.reduce((count, tx) => count + tx.fundingIdentityGaps.length, 0),
    fundingRouteGapTxs: perTx.filter((t) => t.fundingRouteGaps.length > 0).length,
    fundingRouteGapCount: perTx.reduce((count, tx) => count + tx.fundingRouteGaps.length, 0),
    protocolAdapterCandidateTxCount: perTx.filter((t) => t.protocolAdapterCandidate).length,
    requiresTraceTxCount: sorted.filter((t) => t.comparability === "requires_trace").length,
    knownProtocolGapTxs: perTx.filter((t) => t.protocolVenueGaps.length > 0).length,
    unclassifiedEmitterTxs: perTx.filter((t) => t.unclassifiedEmitters.length > 0).length,
    removed_v4_fields: [
      "perTx[].swapVenues",
      "perTx[].fullyCovered",
      "perTx[].gapVenues",
      "summary.txs",
      "summary.observedSwapVenues",
      "summary.observedSwapEmitters",
      "summary.swapRouteGaps",
      "summary.unassessedSwapVenues",
      "summary.observedFundingVenues",
      "summary.fundingIdentityGaps",
      "summary.fundingRouteGaps",
      "summary.deprecated_aliases",
      "summary.fullyCovered",
      "summary.oneGapWithVault",
      "summary.protocolAdapterCandidates",
      "summary.requiresTrace",
    ],
    receiptRouteCoverageCompleteTxCount: perTx.filter(
      (t) => t.receiptRouteCoverageComplete,
    ).length,
    singleProtocolVenueGapWithProtocolLegTxCount: withProtocol.filter(
      (t) => t.protocolVenueGaps.length === 1
    ).length,
  };
  return { summary, perTx: sorted };
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
