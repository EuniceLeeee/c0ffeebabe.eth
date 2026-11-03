import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { permitAllowsProfitMode, resolveProfitMode, type ProfitMode } from "./profit-mode.js";

const MAX_WALLET_WEI = 200_000_000_000_000_000n;
const MAX_WALL_MS = 12 * 60 * 60 * 1_000;
const MAX_HEARTBEAT_MS = 30_000;

interface SessionPermit {
  profitMode?: ProfitMode;
  schemaVersion: 1;
  runId: string;
  mode: "standalone";
  wallet: string;
  executor: string;
  chainId: 1;
  status: "active";
  firstTargetBlock: number;
  lastTargetBlock: number;
  maxBlocks: number;
  startedAtMs: number;
  deadlineAtMs: number;
  validUntilMs: number;
  baselineBalanceWei: string;
  minimumBalanceWei: string;
  maxWalletWei: string;
}

export interface BoundedLiveSession {
  assertActive(balance?: {
    walletBalanceWei: bigint;
    worstGasCostWei: bigint;
  }): void;
}

function fail(code: string): never {
  throw new Error(`bounded-live:${code}`);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function address(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function wei(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    fail("invalid-permit");
  }
  return BigInt(value);
}

function readPermit(path: string): SessionPermit {
  let fd: number | undefined;
  let parsed: unknown;
  try {
    // Read and inspect the same descriptor, rejecting a symlink at the target.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16_384
      || (stat.mode & 0o077) !== 0 || uid === undefined
      || (stat.uid !== 0 && stat.uid !== uid)) {
      fail("unsafe-permit-file");
    }
    parsed = JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    fail("unreadable-permit");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid-permit");
  const p = parsed as Record<string, unknown>;
  if (p.profitMode !== undefined && p.profitMode !== "positive-ev" && p.profitMode !== "positive-gross-profit") {
    fail("invalid-permit");
  }
  if (p.schemaVersion !== 1 || p.mode !== "standalone" || p.chainId !== 1
    || typeof p.runId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(p.runId)
    || !address(p.wallet) || !address(p.executor)
    || !positiveInteger(p.firstTargetBlock) || !positiveInteger(p.lastTargetBlock)
    || !positiveInteger(p.maxBlocks) || p.maxBlocks > 2_500
    || p.lastTargetBlock - p.firstTargetBlock + 1 !== p.maxBlocks
    || !positiveInteger(p.startedAtMs) || !positiveInteger(p.deadlineAtMs)
    || !positiveInteger(p.validUntilMs)
    || p.deadlineAtMs <= p.startedAtMs || p.deadlineAtMs - p.startedAtMs > MAX_WALL_MS) {
    fail("invalid-permit");
  }
  if (p.status !== "active") fail("inactive");
  const now = Date.now();
  if (now < p.startedAtMs || now >= p.deadlineAtMs
    || now >= p.validUntilMs || p.validUntilMs > p.deadlineAtMs
    || p.validUntilMs - now > MAX_HEARTBEAT_MS) {
    fail("expired");
  }
  const baseline = wei(p.baselineBalanceWei);
  const minimum = wei(p.minimumBalanceWei);
  const cap = wei(p.maxWalletWei);
  if (baseline <= 0n || cap <= 0n || cap > MAX_WALLET_WEI || baseline > cap
    || minimum < (baseline + 1n) / 2n || minimum > baseline) {
    fail("invalid-balance-limits");
  }
  return p as unknown as SessionPermit;
}

function immutableIdentity(p: SessionPermit): string {
  return JSON.stringify([
    p.schemaVersion, p.runId, p.mode, p.wallet.toLowerCase(), p.executor.toLowerCase(),
    p.chainId, p.firstTargetBlock, p.lastTargetBlock, p.maxBlocks,
    p.startedAtMs, p.deadlineAtMs, p.baselineBalanceWei, p.minimumBalanceWei, p.maxWalletWei,
    resolveProfitMode(p.profitMode),
  ]);
}

/** Optional, fail-closed permit pinned for the entire asynchronous submission. */
export function captureBoundedLiveSession(params: {
  wallet: string;
  executor: string;
  chainId: number;
  targetBlock?: number;
  mode?: "standalone" | "victim" | "hash-only";
  profitMode?: ProfitMode;
}): BoundedLiveSession | null {
  const profitMode = resolveProfitMode(params.profitMode);
  const path = process.env.SEARCHER_LIVE_SESSION_PATH;
  if (path === undefined) {
    if (profitMode === "positive-gross-profit") fail("gross-profit-requires-permit");
    return null;
  }
  if (!isAbsolute(path)) fail("invalid-permit-path");
  const runId = process.env.SEARCHER_LIVE_SESSION_ID;
  const initial = readPermit(path);
  if (!permitAllowsProfitMode(initial.profitMode, profitMode)) fail("profit-mode-mismatch");
  if (runId !== initial.runId || params.chainId !== initial.chainId
    || !address(params.wallet) || params.wallet.toLowerCase() !== initial.wallet.toLowerCase()
    || !address(params.executor) || params.executor.toLowerCase() !== initial.executor.toLowerCase()) {
    fail("identity-mismatch");
  }
  if (params.mode !== "standalone") fail("standalone-only");
  if (!positiveInteger(params.targetBlock)
    || params.targetBlock < initial.firstTargetBlock || params.targetBlock > initial.lastTargetBlock) {
    fail("target-outside-window");
  }
  const identity = immutableIdentity(initial);
  return Object.freeze({
    assertActive(balance?: { walletBalanceWei: bigint; worstGasCostWei: bigint }): void {
      // Never reread environment switches: deleting one cannot disable this handle.
      const current = readPermit(path);
      if (immutableIdentity(current) !== identity) fail("permit-changed");
      if (balance !== undefined) {
        const minimum = BigInt(current.minimumBalanceWei);
        if (balance.walletBalanceWei < 0n || balance.worstGasCostWei < 0n
          || balance.walletBalanceWei > BigInt(current.maxWalletWei)
          || balance.walletBalanceWei - balance.worstGasCostWei < minimum) {
          fail("balance-limit");
        }
      }
    },
  });
}
