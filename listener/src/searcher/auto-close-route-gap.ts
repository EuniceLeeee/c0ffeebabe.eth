import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  backfillV4PoolId,
  type V4BackfillOptions,
  type V4BackfillResult,
} from "./backfill-v4-poolid.js";
import { appendForceIncludePoolIds } from "./force-include.js";

type BackfillV4PoolIdFn = (
  poolId: string,
  opts: V4BackfillOptions,
) => Promise<V4BackfillResult>;

export interface AutoCloseRouteGapOptions {
  reportPath: string;
  rpcUrl?: string;
  activePoolsPath?: string;
  forceIncludePath?: string;
  findingsPath?: string;
  backfillV4PoolIdFn?: BackfillV4PoolIdFn;
  log?: (line: string) => void;
}

export interface AutoCloseFailure {
  protocol: string;
  id: string;
  error: string;
}

export interface AutoCloseRouteGapResult {
  routeGapDecisive: boolean;
  closedV4PoolIds: string[];
  forceIncludeAdded: string[];
  needsActivePools: string[];
  failed: AutoCloseFailure[];
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_AUTO_CLOSE_FINDINGS_PATH = resolve(
  "searcher",
  "pools",
  "auto-close-findings.jsonl",
);

type AutoCloseFinding =
  | {
      ts: string;
      kind: "closed";
      protocol: string;
      id: string;
      report: string;
    }
  | {
      ts: string;
      kind: "needs_active_pools";
      protocol: string;
      id: string;
      report: string;
    }
  | {
      ts: string;
      kind: "failed";
      protocol: string;
      id: string;
      error: string;
      report: string;
    };

export async function autoCloseRouteGap(
  opts: AutoCloseRouteGapOptions,
): Promise<AutoCloseRouteGapResult> {
  const log = opts.log ?? console.log;
  const report = readReport(opts.reportPath);
  const findingsPath = resolveFindingsPath(opts.findingsPath);
  if (!isRecord(report.verdict) || report.verdict.route_gap_decisive !== true) {
    log("no route_gap_decisive, nothing to close");
    return {
      routeGapDecisive: false,
      closedV4PoolIds: [],
      forceIncludeAdded: [],
      needsActivePools: [],
      failed: [],
    };
  }

  // Real bundle-postmortem schema (verified against the node): the winner's per-pool coverage is in
  // analyzed_competitors[].touchedVenues[] { protocol, id, in_graph } — NOT competing_candidates
  // (which only carries hash/index/backrun_positioned). Close every not-in-graph venue observed.
  const competitors = Array.isArray(report.analyzed_competitors) ? report.analyzed_competitors : [];

  const backfill = opts.backfillV4PoolIdFn ?? backfillV4PoolId;
  const closedV4PoolIds: string[] = [];
  const forceIncludeAdded: string[] = [];
  const needsActivePools: string[] = [];
  const failed: AutoCloseFailure[] = [];
  const seen = new Set<string>();

  for (const competitor of competitors) {
    if (!isRecord(competitor) || !Array.isArray(competitor.touchedVenues)) continue;
    // Auto-close is fail-closed: an unknown or non-atomic winner has not proved a
    // reproducible route gap and must remain a manual-analysis case.
    if (competitor.winner_style !== "atomic_loop") {
      continue;
    }
    for (const rawVenue of competitor.touchedVenues) {
      if (!isRecord(rawVenue) || rawVenue.in_graph !== false) continue;
      const protocol = rawVenue.protocol;
      const id = rawVenue.id;
      if (typeof protocol !== "string" || typeof id !== "string") continue;
      const key = `${protocol}:${id.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        // Data-driven venue identity: a bytes32 id is a pool-key venue
        // (backfill its canonical id); anything else is an address venue.
        // No protocol/family name is consulted.
        if (BYTES32_RE.test(id)) {
          const poolId = normalizePoolId(id);
          const result = await backfill(poolId, {
            rpcUrl: opts.rpcUrl,
            activePoolsPath: opts.activePoolsPath,
          });
          const appendResult = appendForceIncludePoolIds([result.poolId], opts.forceIncludePath);
          if (result.added) closedV4PoolIds.push(result.poolId);
          forceIncludeAdded.push(...appendResult.added);
          appendFinding(findingsPath, {
            ts: new Date().toISOString(),
            kind: "closed",
            protocol,
            id: result.poolId,
            report: opts.reportPath,
          });
          continue;
        }

        const address = normalizeAddress(id);
        const appendResult = appendForceIncludePoolIds([address], opts.forceIncludePath);
        forceIncludeAdded.push(...appendResult.added);
        const note = `needs_active_pools:${address}`;
        needsActivePools.push(note);
        log(note);
        appendFinding(findingsPath, {
          ts: new Date().toISOString(),
          kind: "needs_active_pools",
          protocol,
          id: address,
          report: opts.reportPath,
        });
      } catch (err) {
        const failure = { protocol, id, error: errorMessage(err) };
        failed.push(failure);
        log(`[auto-close] failed ${protocol}:${id}: ${failure.error}`);
        appendFinding(findingsPath, {
          ts: new Date().toISOString(),
          kind: "failed",
          ...failure,
          report: opts.reportPath,
        });
        continue;
      }
    }
  }

  log(
    `[auto-close] route_gap_decisive: closed ${closedV4PoolIds.length} v4 poolIds, ` +
      `appended ${forceIncludeAdded.length} force-include entries`,
  );

  return {
    routeGapDecisive: true,
    closedV4PoolIds,
    forceIncludeAdded,
    needsActivePools,
    failed,
  };
}

function readReport(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`postmortem report ${path} must be a JSON object`);
  return parsed;
}

function normalizePoolId(value: string): string {
  if (!BYTES32_RE.test(value)) {
    throw new Error(`poolId must be bytes32, got ${value}`);
  }
  return value.toLowerCase();
}

function normalizeAddress(value: string): string {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`pool address must be an address, got ${value}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveFindingsPath(path?: string): string {
  return (
    path?.trim() ||
    process.env.SEARCHER_AUTO_CLOSE_FINDINGS_PATH?.trim() ||
    DEFAULT_AUTO_CLOSE_FINDINGS_PATH
  );
}

function appendFinding(path: string, finding: AutoCloseFinding): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(finding) + "\n");
  } catch (err) {
    console.warn(
      `[auto-close] WARN: could not append finding to ${path}: ${errorMessage(err)}`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const AUTO_CLOSE_USAGE =
  "usage: npm run auto-close-route-gap -- --report <report.json> " +
  "[--rpc <url>] [--active-pools <path>] [--force-include <path>] [--findings <path>]";

function parseArgs(args: string[]): {
  reportPath: string;
  rpcUrl?: string;
  activePoolsPath?: string;
  forceIncludePath?: string;
  findingsPath?: string;
} {
  let reportPath: string | undefined;
  let rpcUrl: string | undefined;
  let activePoolsPath: string | undefined;
  let forceIncludePath: string | undefined;
  let findingsPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--report") {
      reportPath = args[++i];
      if (!reportPath) throw new Error("--report requires a path");
    } else if (arg === "--rpc") {
      rpcUrl = args[++i];
      if (!rpcUrl) throw new Error("--rpc requires a URL");
    } else if (arg === "--active-pools") {
      activePoolsPath = args[++i];
      if (!activePoolsPath) throw new Error("--active-pools requires a path");
    } else if (arg === "--force-include") {
      forceIncludePath = args[++i];
      if (!forceIncludePath) throw new Error("--force-include requires a path");
    } else if (arg === "--findings") {
      findingsPath = args[++i];
      if (!findingsPath) throw new Error("--findings requires a path");
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(AUTO_CLOSE_USAGE);
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  if (!reportPath) {
    throw new Error(AUTO_CLOSE_USAGE);
  }

  return {
    reportPath,
    rpcUrl,
    activePoolsPath,
    forceIncludePath,
    findingsPath: resolveFindingsPath(findingsPath),
  };
}

async function main(): Promise<void> {
  const result = await autoCloseRouteGap(parseArgs(process.argv.slice(2)));
  if (result.failed.length > 0) {
    console.error(
      `[auto-close] failed venues: ${result.failed
        .map((failure) => `${failure.protocol}:${failure.id} (${failure.error})`)
        .join(", ")}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[auto-close] FAIL: ${errorMessage(err)}`);
    process.exit(1);
  });
}
