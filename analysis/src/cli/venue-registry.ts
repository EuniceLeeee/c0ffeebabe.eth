import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EdgeKind } from "../../../listener/src/searcher/strategy-taxonomy.js";
import type { AggregatedVenue } from "../discovery/venue-aggregate.js";
import {
  ingestAggregates,
  listVenues,
  seedRegistry,
  setClassification,
  setStatus,
  type VenueRecord,
  type VenueRegistry,
  type VenueStatus,
} from "../discovery/venue-registry.js";
import { parseArgs, writeText } from "../util.js";

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE = resolve(CLI_DIR, "..", "..", "venue-registry.json");
const EDGE_KINDS: readonly EdgeKind[] = ["swap", "credit", "lp", "flash", "protocol"];
const STATUSES: readonly VenueStatus[] = ["candidate", "known", "routable", "excluded"];

const USAGE = `Usage: npm run venue-registry -- [--store <path>] [--ingest <aggregated.json>]
       npm run venue-registry -- [--store <path>] --set <address> [--kind <edgeKind>] [--status <status>]
       npm run venue-registry -- [--store <path>] --list [--status <status>] [--kind <edgeKind>] [--json]

Defaults to ${DEFAULT_STORE}.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();

  const storePath = optionalPathArg(args, "store") || DEFAULT_STORE;
  let registry = await readRegistry(storePath);
  const shouldWrite = Boolean(args.ingest || args.set);

  if (args.ingest) {
    registry = ingestAggregates(registry, await readAggregates(requiredPathArg(args, "ingest")));
  }

  if (args.set) {
    const address = requiredStringArg(args, "set");
    const kind = optionalEnumArg(args, "kind", EDGE_KINDS);
    const status = optionalEnumArg(args, "status", STATUSES);
    if (!kind && !status) usage();
    if (kind) registry = setClassification(registry, address, kind);
    if (status) registry = setStatus(registry, address, status);
  }

  if (shouldWrite) {
    registry = { ...registry, updatedAt: new Date().toISOString() };
    await writeText(storePath, `${JSON.stringify(registry, null, 2)}\n`);
  }

  if (args.list) {
    const status = optionalEnumArg(args, "status", STATUSES);
    const kind = optionalEnumArg(args, "kind", EDGE_KINDS);
    const rows = listVenues(registry, { status, kind });
    const output = args.json ? `${JSON.stringify(rows, null, 2)}\n` : renderTable(rows);
    process.stdout.write(output);
  } else if (!shouldWrite) {
    usage();
  }

  console.error(renderSummary(registry));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function readRegistry(path: string): Promise<VenueRegistry> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRegistry(parsed)) throw new Error(`Store ${path} must contain a VenueRegistry JSON object`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return seedRegistry();
    throw error;
  }
}

async function readAggregates(path: string): Promise<AggregatedVenue[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Ingest file ${path} must contain an AggregatedVenue[] JSON array`);
  return parsed as AggregatedVenue[];
}

function isRegistry(value: unknown): value is VenueRegistry {
  return Boolean(
    value
    && typeof value === "object"
    && "venues" in value
    && typeof (value as { venues?: unknown }).venues === "object"
    && (value as { venues?: unknown }).venues !== null,
  );
}

function renderTable(rows: VenueRecord[]): string {
  if (rows.length === 0) return "(no venues)\n";
  const table = [
    ["address", "status", "class", "source", "txs", "edgeKinds", "protocolActions", "name", "adapterHint"],
    ...rows.map((row) => [
      row.address,
      row.status,
      row.classification?.edgeKind ?? "",
      row.classification?.source ?? "",
      String(row.txCount),
      row.edgeKinds.join(","),
      row.protocolActions.join(","),
      row.name ?? "",
      row.adapterHint ?? "",
    ]),
  ];
  const widths = table[0].map((_value, index) =>
    Math.max(...table.map((row) => row[index].length))
  );
  return `${table
    .map((row) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd())
    .join("\n")}\n`;
}

function renderSummary(reg: VenueRegistry): string {
  const rows = Object.values(reg.venues);
  const statusCounts = countBy(STATUSES, (status) => rows.filter((row) => row.status === status).length);
  const classificationCounts = countBy(
    EDGE_KINDS,
    (edgeKind) => rows.filter((row) => row.classification?.edgeKind === edgeKind).length,
  );
  const unclassified = rows.filter((row) => !row.classification).length;
  return [
    "[analysis/venue-registry]",
    `total=${rows.length}`,
    ...Object.entries(statusCounts).map(([status, count]) => `status.${status}=${count}`),
    ...Object.entries(classificationCounts).map(([kind, count]) => `class.${kind}=${count}`),
    `class.unclassified=${unclassified}`,
  ].join(" ");
}

function countBy<T extends string>(keys: readonly T[], count: (key: T) => number): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, count(key)])) as Record<T, number>;
}

function optionalEnumArg<T extends string>(
  args: Record<string, string | boolean>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  usage();
}

function requiredPathArg(args: Record<string, string | boolean>, key: string): string {
  const value = optionalPathArg(args, key);
  if (value) return value;
  usage();
}

function optionalPathArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (value === undefined) return "";
  if (typeof value === "string" && value.trim()) return resolveCliPath(value);
  usage();
}

function requiredStringArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value;
  usage();
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}
