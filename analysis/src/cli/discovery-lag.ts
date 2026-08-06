#!/usr/bin/env node
// discovery-lag — which discovery source is behind, by how much, and is it
// advancing or stalled? Reads the live searcher log (zero-CU, no RPC).
//
// Usage: npm run discovery-lag -- [--log <path>] [--window-bytes <n>] [--json]
//   default --log /var/log/mev-live.log, --window-bytes 67108864 (last 64MB)
import { openSync, readSync, statSync } from "node:fs";

const DEFAULT_LOG = "/var/log/mev-live.log";
const DEFAULT_WINDOW_BYTES = 64 * 1024 * 1024;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const logPath = arg("--log") ?? DEFAULT_LOG;
const windowBytes = Number(arg("--window-bytes") ?? DEFAULT_WINDOW_BYTES);
const asJson = process.argv.includes("--json");

const n1Pattern = /\[searcher\/blockscan-nminus1-state\] (.*)/;
const timingPattern = /\[searcher\/blockscan-family\] (.*)/;
const stagePattern = /\[searcher\/discovery-stage-telemetry\] (.*)/;

interface SourceStat {
  readonly familyId: string;
  readonly sourceId: string;
  count: number;
  firstBlock: number;
  lastBlock: number;
  lastLag: number;
}

function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (start > 0) lines.shift(); // first line is a partial tail fragment
    return lines.join("\n");
  } finally {
    // fd closed by process exit; nothing else to release
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function summarize(name: string, values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    max: values.length ? Math.round(Math.max(...values)) : 0,
  };
}

const sources = new Map<string, SourceStat>();
const behindPairs = new Map<string, number>();
const timingBlocks: number[] = [];
const stageWalls: number[] = [];
const stageFields: Record<string, number[]> = {
  swapScan: [],
  factoryIndex: [],
  incumbentAttestation: [],
  identityRetry: [],
  projection: [],
  canonicalFence: [],
};

const text = readTail(logPath, windowBytes);
for (const line of text.split("\n")) {
  let match = n1Pattern.exec(line);
  if (match) {
    try {
      const record = JSON.parse(match[1]) as {
        sourceBlock?: number;
        causes?: Array<{
          familyId?: string;
          kind?: string;
          kinds?: Array<{
            kind?: string;
            samples?: Array<{
              sourceId?: string;
              message?: string;
            }>;
          }>;
        }>;
      };
      const head = record.sourceBlock ?? 0;
      for (const cause of record.causes ?? []) {
        for (const kind of cause.kinds ?? []) {
          if (kind.kind !== "graph-incomplete") continue;
          for (const sample of kind.samples ?? []) {
            const parsed = /family (.*?) source (.*?) complete through (\d+)/.exec(
              sample.message ?? "",
            );
            if (!parsed) continue;
            const familyId = cause.familyId ?? parsed[1];
            const sourceId = sample.sourceId ?? parsed[2];
            const through = Number(parsed[3]);
            const key = `${familyId}\u001f${sourceId}`;
            const stat = sources.get(key) ?? {
              familyId,
              sourceId,
              count: 0,
              firstBlock: through,
              lastBlock: through,
              lastLag: head - through,
            };
            stat.count += 1;
            stat.lastBlock = through;
            stat.lastLag = head - through;
            if (stat.firstBlock === 0 || through < stat.firstBlock) {
              stat.firstBlock = through;
            }
            sources.set(key, stat);
          }
        }
      }
    } catch {
      // malformed line; ignore
    }
    continue;
  }
  match = timingPattern.exec(line);
  if (match) {
    try {
      const record = JSON.parse(match[1]) as {
        type?: string;
        source_block?: number;
        degraded_recall_reasons?: string[];
      };
      if (record.type !== "block_scan_timing") continue;
      if (record.source_block !== undefined) timingBlocks.push(record.source_block);
      for (const reason of record.degraded_recall_reasons ?? []) {
        const behind = /discovery_source_coverage_behind:(\d+)<(\d+)/.exec(reason);
        if (behind) {
          const key = `${behind[1]}<${behind[2]}`;
          behindPairs.set(key, (behindPairs.get(key) ?? 0) + 1);
        }
      }
    } catch {
      // ignore
    }
    continue;
  }
  match = stagePattern.exec(line);
  if (match) {
    try {
      const record = JSON.parse(match[1]) as {
        timing?: Record<string, number>;
        wallMs?: number;
      };
      if (typeof record.wallMs === "number") stageWalls.push(record.wallMs);
      for (const [field, values] of Object.entries(stageFields)) {
        const value = record.timing?.[field];
        if (typeof value === "number") values.push(value);
      }
    } catch {
      // ignore
    }
  }
}

const head = timingBlocks.length
  ? Math.max(...timingBlocks)
  : Math.max(0, ...[...sources.values()].map((stat) => stat.lastBlock + stat.lastLag));

const rows = [...sources.values()]
  .map((stat) => ({
    family: stat.familyId,
    source: stat.sourceId,
    samples: stat.count,
    firstThrough: stat.firstBlock,
    lastThrough: stat.lastBlock,
    lag: stat.lastLag,
    advanced: stat.lastBlock - stat.firstBlock,
    stalled: stat.count >= 2 && stat.lastBlock - stat.firstBlock === 0,
  }))
  .sort((a, b) => b.lag - a.lag);

if (asJson) {
  console.log(JSON.stringify({
    head,
    logTailBytes: windowBytes,
    sources: rows,
    behindPairs: [...behindPairs.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => {
        const leftA = Number(a.pair.split("<")[0]);
        const leftB = Number(b.pair.split("<")[0]);
        return leftB - leftA;
      })
      .slice(0, 20),
    behindPairTotal: behindPairs.size,
    discoveryStageMs: Object.fromEntries(
      Object.entries(stageFields).map(([field, values]) => [
        field,
        summarize(field, values),
      ]),
    ),
    discoveryWallMs: summarize("wallMs", stageWalls),
  }, null, 2));
  process.exit(0);
}

console.log(`head=${head} (from ${timingBlocks.length} block_scan_timing rows, tail ${windowBytes} bytes)`);
console.log("");
console.log("=== per discovery source (sorted by lag) ===");
for (const row of rows) {
  console.log(
    `${row.stalled ? "STALLED " : "        "}${row.family.padEnd(30)} ${row.source.padEnd(40)} ` +
      `through=${row.lastThrough} lag=${row.lag} samples=${row.samples} advanced=${row.advanced}`,
  );
}
if (rows.length === 0) {
  console.log("(no graph-incomplete causes found in the tail window)");
}
console.log("");
console.log("=== discovery_source_coverage_behind pairs (latest 20 of " +
  `${behindPairs.size}) ===`);
for (const [pair, count] of [...behindPairs.entries()]
  .sort((a, b) => Number(b[0].split("<")[0]) - Number(a[0].split("<")[0]))
  .slice(0, 20)) {
  console.log(`  ${pair}  x${count}`);
}
if (behindPairs.size === 0) {
  console.log("  (none in tail window)");
}
console.log("");
console.log("=== discovery scan telemetry (ms) ===");
console.log(`  wallMs        ${JSON.stringify(summarize("wallMs", stageWalls))}`);
for (const [field, values] of Object.entries(stageFields)) {
  console.log(`  ${field.padEnd(20)} ${JSON.stringify(summarize(field, values))}`);
}
