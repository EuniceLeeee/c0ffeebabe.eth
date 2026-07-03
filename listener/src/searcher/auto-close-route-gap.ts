import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  backfillV4PoolIdFn?: BackfillV4PoolIdFn;
  log?: (line: string) => void;
}

export interface AutoCloseRouteGapResult {
  routeGapDecisive: boolean;
  closedV4PoolIds: string[];
  forceIncludeAdded: string[];
  needsActivePools: string[];
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export async function autoCloseRouteGap(
  opts: AutoCloseRouteGapOptions,
): Promise<AutoCloseRouteGapResult> {
  const log = opts.log ?? console.log;
  const report = readReport(opts.reportPath);
  if (!isRecord(report.verdict) || report.verdict.route_gap_decisive !== true) {
    log("no route_gap_decisive, nothing to close");
    return {
      routeGapDecisive: false,
      closedV4PoolIds: [],
      forceIncludeAdded: [],
      needsActivePools: [],
    };
  }

  if (!Array.isArray(report.competing_candidates)) {
    throw new Error("postmortem report competing_candidates must be an array");
  }

  const backfill = opts.backfillV4PoolIdFn ?? backfillV4PoolId;
  const closedV4PoolIds: string[] = [];
  const forceIncludeAdded: string[] = [];
  const needsActivePools: string[] = [];

  for (const rawCandidate of report.competing_candidates) {
    if (!isRecord(rawCandidate) || rawCandidate.in_graph !== false) continue;
    const protocol = rawCandidate.protocol;
    const id = rawCandidate.id;
    if (typeof protocol !== "string" || typeof id !== "string") {
      throw new Error("competing_candidates entries must include string protocol and id");
    }

    if (protocol === "univ4") {
      const poolId = normalizePoolId(id);
      const result = await backfill(poolId, {
        rpcUrl: opts.rpcUrl,
        activePoolsPath: opts.activePoolsPath,
      });
      if (result.added) closedV4PoolIds.push(result.poolId);
      const appendResult = appendForceIncludePoolIds([poolId], opts.forceIncludePath);
      forceIncludeAdded.push(...appendResult.added);
      continue;
    }

    if (protocol === "univ2" || protocol === "univ3") {
      const address = normalizeAddress(id);
      const appendResult = appendForceIncludePoolIds([address], opts.forceIncludePath);
      forceIncludeAdded.push(...appendResult.added);
      const note = `needs_active_pools:${address}`;
      needsActivePools.push(note);
      log(note);
      continue;
    }

    throw new Error(`unsupported competing candidate protocol: ${protocol}`);
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

function parseArgs(args: string[]): {
  reportPath: string;
  rpcUrl?: string;
  activePoolsPath?: string;
  forceIncludePath?: string;
} {
  let reportPath: string | undefined;
  let rpcUrl: string | undefined;
  let activePoolsPath: string | undefined;
  let forceIncludePath: string | undefined;

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
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: npm run auto-close-route-gap -- --report <report.json> " +
          "[--rpc <url>] [--active-pools <path>] [--force-include <path>]",
      );
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  if (!reportPath) {
    throw new Error(
      "usage: npm run auto-close-route-gap -- --report <report.json> " +
        "[--rpc <url>] [--active-pools <path>] [--force-include <path>]",
    );
  }

  return { reportPath, rpcUrl, activePoolsPath, forceIncludePath };
}

async function main(): Promise<void> {
  await autoCloseRouteGap(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[auto-close] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
