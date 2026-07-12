// block-activity — "what did OUR live searcher do at block N?" Reads the live structured events JSONL
// and summarizes our funnel at a target_block: seen / dropped (stage × reason) / submitted, plus an
// optional cross-reference of a competitor's venue ids against our whole run (did we ever touch them).
//
// Zero-CU on the events (pure JSONL read). The events live on the NODE — this defaults to the node
// path so it runs there directly; point --events at a fetched slice to run locally.
//
// Usage: npm run block-activity -- --block <N> [--events <path>] [--blockscan-log <path>]
//   [--venues <id,id,...>]
//   default --events /var/log/mev/events/searcher-live.jsonl (the live node path; the OLD
//   analysis/events + /tmp/mev-live-*.log defaults are stale — the node moved to /var/log/mev).
import { existsSync, readFileSync } from "node:fs";
import {
  blockScanActivityAtBlock,
  blockScanSourceBlockForTarget,
} from "./bundle-postmortem.js";

const DEFAULT_EVENTS = "/var/log/mev/events/searcher-live.jsonl";
const DEFAULT_BLOCKSCAN_LOG = "/var/log/mev-live.log";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const blockStr = arg("--block");
  if (!blockStr) {
    console.error("usage: npm run block-activity -- --block <N> [--events <path>] [--blockscan-log <path>] [--venues <id,...>]");
    process.exit(1);
  }
  const block = Number(blockStr);
  const eventsPath = arg("--events") ?? DEFAULT_EVENTS;
  const blockScanLogPath = arg("--blockscan-log") ?? DEFAULT_BLOCKSCAN_LOG;
  const venues = (arg("--venues") ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!existsSync(eventsPath)) {
    console.error(`events file not found: ${eventsPath} (on the node it is ${DEFAULT_EVENTS}; fetch a slice or run on the node)`);
    process.exit(1);
  }

  const dropCounts = new Map<string, number>(); // "stage|reason" -> n
  const submittedAt: string[] = [];
  const venueHits = new Map<string, number>();
  let seen = 0, dropped = 0, submitted = 0;
  let totalLines = 0;

  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line) continue;
    totalLines++;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    // whole-run venue cross-ref (not block-scoped): did we ever emit these ids?
    if (venues.length > 0) {
      const lower = line.toLowerCase();
      for (const v of venues) if (lower.includes(v)) venueHits.set(v, (venueHits.get(v) ?? 0) + 1);
    }
    if (o.target_block !== block) continue;
    const type = String(o.type ?? "");
    if (type === "opportunity_seen") seen++;
    else if (type === "pipeline_dropped") {
      dropped++;
      const key = `${o.stage ?? "?"}|${o.reason ?? "?"}`;
      dropCounts.set(key, (dropCounts.get(key) ?? 0) + 1);
    } else if (type === "bundle_submitted") { submitted++; submittedAt.push(String(o.opportunity_id ?? "").slice(0, 14)); }
  }

  console.log(`[block-activity] block ${block} — events=${eventsPath} (${totalLines} lines)`);
  console.log(`  opportunity_seen: ${seen}`);
  console.log(`  pipeline_dropped: ${dropped}`);
  for (const [k, n] of [...dropCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const [stage, reason] = k.split("|");
    console.log(`      stage=${stage} reason=${reason}: ${n}`);
  }
  console.log(`  bundle_submitted: ${submitted}${submittedAt.length ? " " + submittedAt.join(",") : ""}`);
  if (venues.length > 0) {
    console.log(`  competitor venue cross-ref (whole run):`);
    for (const v of venues) console.log(`      ${v}: ${venueHits.get(v) ?? 0} mentions${(venueHits.get(v) ?? 0) === 0 ? "  <- NEVER seen" : ""}`);
  }

  const sourceBlock = blockScanSourceBlockForTarget(block);
  let blockScanLog: string;
  try {
    blockScanLog = readFileSync(blockScanLogPath, "utf8");
  } catch {
    console.log(`  blockscan: target_block=${block} source_block=${sourceBlock} status=unknown_log_unavailable log=${blockScanLogPath}`);
    console.log("      solve_rings: unknown");
    console.log("      solve_ring_tokens: unknown");
    return;
  }

  const activity = blockScanActivityAtBlock(blockScanLog, sourceBlock);
  const tokens = [...activity.scannedTokens].sort();
  console.log(`  blockscan: target_block=${block} source_block=${sourceBlock} status=${activity.status} log=${blockScanLogPath}`);
  console.log(`      solve_rings: ${activity.ringCount}`);
  for (const ring of activity.rings) {
    console.log(`          ring=${ring.ring} net=${ring.net ?? "null"}${ring.error ? ` error=${ring.error}` : ""}`);
  }
  console.log(`      solve_ring_tokens: ${tokens.length}${tokens.length > 0 ? ` ${tokens.join(",")}` : ""}`);
}

main();
