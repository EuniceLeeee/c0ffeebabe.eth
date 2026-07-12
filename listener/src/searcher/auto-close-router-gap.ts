import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import {
  appendForceIncludeRouters,
  DEFAULT_FORCE_INCLUDE_ROUTERS_PATH,
} from "./force-include.js";
import { buildMempoolToAddressFilter } from "./main.js";

export type ResolveSourceSwapToFn = (
  txHash: string,
  rpcUrl?: string,
) => Promise<{ sourceTo: string | null }>;

export interface AutoCloseRouterGapOptions {
  reportPath: string;
  rpcUrl?: string;
  forceIncludePath?: string;
  findingsPath?: string;
  currentAllowlist?: Set<string>;
  resolveSourceSwapToFn?: ResolveSourceSwapToFn;
  append?: boolean;
  log?: (line: string) => void;
}

export interface AutoCloseRouterGapResult {
  routeGapDecisive: boolean;
  routersAdded: string[];
  alreadyAdmitted: string[];
  noSourceSwap: string[];
  skippedNonComparable: string[];
  failed: { hash: string; error: string }[];
}

const V2_SWAP_TOPIC0 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP_TOPIC0 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V4_SWAP_TOPIC0 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const SWAP_TOPIC0S = new Set([V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, V4_SWAP_TOPIC0]);

const DEFAULT_AUTO_CLOSE_ROUTER_FINDINGS_PATH = resolve(
  "searcher",
  "pools",
  "auto-close-router-findings.jsonl",
);

interface ParsedRpcReceipt {
  hash: string | null;
  index: number;
  to: string | null;
  logs: { address: string; topics: string[] }[];
}

type AutoCloseRouterFinding =
  | {
      ts: string;
      kind: "router_added";
      hash: string;
      sourceTo: string;
      report: string;
    }
  | {
      ts: string;
      kind: "already_admitted";
      hash: string;
      sourceTo: string;
      report: string;
    }
  | {
      ts: string;
      kind: "no_source_swap";
      hash: string;
      report: string;
    }
  | {
      ts: string;
      kind: "skipped_non_comparable";
      hash: string;
      winnerStyle: string;
      report: string;
    }
  | {
      ts: string;
      kind: "failed";
      hash: string;
      error: string;
      report: string;
    };

export async function autoCloseRouterGap(
  opts: AutoCloseRouterGapOptions,
): Promise<AutoCloseRouterGapResult> {
  const log = opts.log ?? console.log;
  const report = readReport(opts.reportPath);
  const findingsPath = resolveFindingsPath(opts.findingsPath);
  if (!isRecord(report.verdict) || report.verdict.route_gap_decisive !== true) {
    log("no route_gap_decisive, nothing to close");
    return emptyResult(false);
  }

  const competitors = Array.isArray(report.analyzed_competitors)
    ? report.analyzed_competitors
    : [];
  const allowlist = buildAllowlist(opts.currentAllowlist);
  const resolveSourceSwapTo = opts.resolveSourceSwapToFn ?? resolveSourceSwapToFromRpc;
  const routersAdded: string[] = [];
  const alreadyAdmitted: string[] = [];
  const noSourceSwap: string[] = [];
  const skippedNonComparable: string[] = [];
  const failed: { hash: string; error: string }[] = [];
  const reportedAdded = new Set<string>();
  const reportedAdmitted = new Set<string>();

  for (const competitor of competitors) {
    if (!isRecord(competitor)) continue;
    const hash = typeof competitor.hash === "string" ? competitor.hash : null;
    const winnerStyle =
      typeof competitor.winner_style === "string" ? competitor.winner_style : "";

    if (winnerStyle !== "atomic_loop") {
      if (hash) {
        skippedNonComparable.push(hash);
        appendFinding(findingsPath, {
          ts: new Date().toISOString(),
          kind: "skipped_non_comparable",
          hash,
          winnerStyle,
          report: opts.reportPath,
        });
      }
      continue;
    }

    if (!hash) continue;

    try {
      const { sourceTo } = await resolveSourceSwapTo(hash, opts.rpcUrl);
      if (sourceTo === null) {
        noSourceSwap.push(hash);
        appendFinding(findingsPath, {
          ts: new Date().toISOString(),
          kind: "no_source_swap",
          hash,
          report: opts.reportPath,
        });
        continue;
      }

      const normalizedSourceTo = ethers.getAddress(sourceTo);
      const key = normalizedSourceTo.toLowerCase();
      if (allowlist.has(key)) {
        appendAdmitted(alreadyAdmitted, reportedAdmitted, normalizedSourceTo);
        appendFinding(findingsPath, {
          ts: new Date().toISOString(),
          kind: "already_admitted",
          hash,
          sourceTo: normalizedSourceTo,
          report: opts.reportPath,
        });
        continue;
      }

      if (opts.append === false) {
        log(`[auto-close-router] dry-run would add ${normalizedSourceTo}`);
        continue;
      }

      const appendResult = appendForceIncludeRouters(
        [normalizedSourceTo],
        opts.forceIncludePath,
      );
      allowlist.add(key);
      if (appendResult.added.length > 0) {
        for (const added of appendResult.added) {
          const addedKey = added.toLowerCase();
          if (reportedAdded.has(addedKey)) continue;
          reportedAdded.add(addedKey);
          routersAdded.push(added);
        }
        appendFinding(findingsPath, {
          ts: new Date().toISOString(),
          kind: "router_added",
          hash,
          sourceTo: normalizedSourceTo,
          report: opts.reportPath,
        });
      } else {
        appendAdmitted(alreadyAdmitted, reportedAdmitted, normalizedSourceTo);
        appendFinding(findingsPath, {
          ts: new Date().toISOString(),
          kind: "already_admitted",
          hash,
          sourceTo: normalizedSourceTo,
          report: opts.reportPath,
        });
      }
    } catch (err) {
      const failure = { hash, error: errorMessage(err) };
      failed.push(failure);
      log(`[auto-close-router] failed ${hash}: ${failure.error}`);
      appendFinding(findingsPath, {
        ts: new Date().toISOString(),
        kind: "failed",
        ...failure,
        report: opts.reportPath,
      });
    }
  }

  log(
    `[auto-close-router] route_gap_decisive: routersAdded=${routersAdded.length} ` +
      `alreadyAdmitted=${alreadyAdmitted.length} noSourceSwap=${noSourceSwap.length} ` +
      `skippedNonComparable=${skippedNonComparable.length} failed=${failed.length}`,
  );

  return {
    routeGapDecisive: true,
    routersAdded,
    alreadyAdmitted,
    noSourceSwap,
    skippedNonComparable,
    failed,
  };
}

export async function resolveSourceSwapToFromRpc(
  txHash: string,
  rpcUrl?: string,
): Promise<{ sourceTo: string | null }> {
  const provider = new ethers.JsonRpcProvider(
    rpcUrl?.trim() ||
      process.env.MAINNET_RPC_URL?.trim() ||
      process.env.RPC_URL?.trim() ||
      "http://127.0.0.1:8545",
  );
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`receipt not found for ${txHash}`);

  const competitorPools = swapPoolEmitters(receipt.logs);
  if (competitorPools.size === 0) return { sourceTo: null };

  const rawReceipts = await provider.send("eth_getBlockReceipts", [
    ethers.toQuantity(receipt.blockNumber),
  ]);
  const receipts = parseRpcReceipts(rawReceipts)
    .filter((candidate) => candidate.index < receipt.index)
    .sort((a, b) => b.index - a.index);

  for (const candidate of receipts) {
    const pools = swapPoolEmitters(candidate.logs);
    if (!sharesAny(competitorPools, pools)) continue;

    const sourceTo = await resolveReceiptTo(provider, candidate);
    return { sourceTo };
  }

  return { sourceTo: null };
}

function readReport(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`competitor report ${path} must be a JSON object`);
  return parsed;
}

function emptyResult(routeGapDecisive: boolean): AutoCloseRouterGapResult {
  return {
    routeGapDecisive,
    routersAdded: [],
    alreadyAdmitted: [],
    noSourceSwap: [],
    skippedNonComparable: [],
    failed: [],
  };
}

function buildAllowlist(currentAllowlist?: Set<string>): Set<string> {
  const raw = currentAllowlist
    ? [...currentAllowlist]
    : buildMempoolToAddressFilter([]);
  return new Set(raw.map((addr) => addr.toLowerCase()));
}

function appendAdmitted(out: string[], seen: Set<string>, address: string): void {
  const key = address.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(address);
}

function swapPoolEmitters(logs: Iterable<{ address: string; topics: readonly string[] }>): Set<string> {
  const pools = new Set<string>();
  for (const log of logs) {
    if (!isSwapLog(log)) continue;
    const address = normalizeAddress(log.address);
    if (address) pools.add(address.toLowerCase());
  }
  return pools;
}

function isSwapLog(log: { topics: readonly string[] }): boolean {
  const topic0 = log.topics[0];
  return typeof topic0 === "string" && SWAP_TOPIC0S.has(topic0.toLowerCase());
}

function parseRpcReceipts(value: unknown): ParsedRpcReceipt[] {
  if (!Array.isArray(value)) throw new Error("eth_getBlockReceipts returned a non-array value");
  return value.map((receipt, fallbackIndex) => {
    if (!isRecord(receipt)) {
      return { hash: null, index: fallbackIndex, to: null, logs: [] };
    }
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    return {
      hash: typeof receipt.transactionHash === "string" ? receipt.transactionHash : null,
      index: parseReceiptIndex(receipt.transactionIndex, fallbackIndex),
      to: typeof receipt.to === "string" ? receipt.to : null,
      logs: logs.map((log) => {
        if (!isRecord(log)) return { address: "", topics: [] };
        return {
          address: typeof log.address === "string" ? log.address : "",
          topics: Array.isArray(log.topics)
            ? log.topics.filter((topic): topic is string => typeof topic === "string")
            : [],
        };
      }),
    };
  });
}

function parseReceiptIndex(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") return fallback;
  const parsed = value.startsWith("0x")
    ? Number.parseInt(value.slice(2), 16)
    : Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

async function resolveReceiptTo(
  provider: ethers.JsonRpcProvider,
  receipt: ParsedRpcReceipt,
): Promise<string | null> {
  if (receipt.hash) {
    try {
      const tx = await provider.getTransaction(receipt.hash);
      const txTo = normalizeAddress(tx?.to);
      if (txTo) return txTo;
    } catch {
      // Fall through to receipt.to. Some nodes prune transaction bodies but keep receipts.
    }
  }
  return normalizeAddress(receipt.to);
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function sharesAny(a: Set<string>, b: Set<string>): boolean {
  for (const item of b) {
    if (a.has(item)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveFindingsPath(path?: string): string {
  return (
    path?.trim() ||
    process.env.SEARCHER_AUTO_CLOSE_ROUTER_FINDINGS_PATH?.trim() ||
    DEFAULT_AUTO_CLOSE_ROUTER_FINDINGS_PATH
  );
}

function appendFinding(path: string, finding: AutoCloseRouterFinding): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(finding) + "\n");
  } catch (err) {
    console.warn(
      `[auto-close-router] WARN: could not append finding to ${path}: ${errorMessage(err)}`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const AUTO_CLOSE_ROUTER_USAGE =
  "usage: npm run auto-close-router-gap -- --report <report.json> " +
  "[--rpc <url>] [--force-include <path>] [--findings <path>] [--dry-run]";

function parseArgs(args: string[]): {
  reportPath: string;
  rpcUrl?: string;
  forceIncludePath?: string;
  findingsPath?: string;
  dryRun: boolean;
} {
  let reportPath: string | undefined;
  let rpcUrl: string | undefined;
  let forceIncludePath: string | undefined;
  let findingsPath: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--report") {
      reportPath = args[++i];
      if (!reportPath) throw new Error("--report requires a path");
    } else if (arg === "--rpc") {
      rpcUrl = args[++i];
      if (!rpcUrl) throw new Error("--rpc requires a URL");
    } else if (arg === "--force-include") {
      forceIncludePath = args[++i];
      if (!forceIncludePath) throw new Error("--force-include requires a path");
    } else if (arg === "--findings") {
      findingsPath = args[++i];
      if (!findingsPath) throw new Error("--findings requires a path");
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(AUTO_CLOSE_ROUTER_USAGE);
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  if (!reportPath) throw new Error(AUTO_CLOSE_ROUTER_USAGE);

  return {
    reportPath,
    rpcUrl,
    forceIncludePath,
    findingsPath: resolveFindingsPath(findingsPath),
    dryRun,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const forceIncludePath = args.forceIncludePath ?? DEFAULT_FORCE_INCLUDE_ROUTERS_PATH;
  const currentAllowlist = new Set(
    buildMempoolToAddressFilter([]).map((addr) => addr.toLowerCase()),
  );
  const result = await autoCloseRouterGap({
    reportPath: args.reportPath,
    rpcUrl: args.rpcUrl,
    forceIncludePath,
    findingsPath: args.findingsPath,
    currentAllowlist,
    append: !args.dryRun,
  });

  console.log(
    `[auto-close-router] summary routersAdded=${result.routersAdded.length} ` +
      `alreadyAdmitted=${result.alreadyAdmitted.length} noSourceSwap=${result.noSourceSwap.length} ` +
      `skippedNonComparable=${result.skippedNonComparable.length} failed=${result.failed.length}` +
      (args.dryRun ? " dryRun=true" : ""),
  );
  for (const address of result.routersAdded) {
    console.log(`[auto-close-router] added ${address}`);
  }

  if (result.failed.length > 0) {
    console.error(
      `[auto-close-router] failed competitors: ${result.failed
        .map((failure) => `${failure.hash} (${failure.error})`)
        .join(", ")}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[auto-close-router] FAIL: ${errorMessage(err)}`);
    console.error(AUTO_CLOSE_ROUTER_USAGE);
    process.exit(1);
  });
}
