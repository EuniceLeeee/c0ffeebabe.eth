import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ethers } from "ethers";
import { captureBoundedLiveSession } from "../../shared/bounded-live-session.js";
import { buildSignedBackrunTx, submitBundle, submitMevShareBundle, submitStandaloneBundle } from "../../submitter.js";

// No private key, Wallet instance, provider connection, or real fetch is used.
const WALLET = "0x1111111111111111111111111111111111111111";
const EXECUTOR = "0x2222222222222222222222222222222222222222";
const NOW = 1_800_000_000_000;
const BASELINE = 2_000_000_000_000_000n;

async function main(): Promise<void> {
  const savedPath = process.env.SEARCHER_LIVE_SESSION_PATH;
  const savedId = process.env.SEARCHER_LIVE_SESSION_ID;
  const savedNow = Date.now;
  const savedFetch = globalThis.fetch;
  const savedLog = console.log;
  const dir = mkdtempSync(join(process.cwd(), ".bounded-live-session-test."));
  const path = join(dir, "permit.json");
  let checks = 0;
  let signs = 0;
  let auths = 0;
  let sends = 0;
  let balance = BASELINE;
  let onNonce: (() => void) | undefined;
  let onBalance: (() => void) | undefined;
  let onSign: (() => void) | undefined;
  let onAuth: (() => void) | undefined;
  let onFetch: (() => void) | undefined;
  const permit = {
    schemaVersion: 1,
    runId: "mock-run-1",
    mode: "standalone",
    wallet: WALLET,
    executor: EXECUTOR,
    chainId: 1,
    status: "active",
    firstTargetBlock: 101,
    lastTargetBlock: 350,
    maxBlocks: 250,
    startedAtMs: NOW - 1_000,
    deadlineAtMs: NOW + 60_000,
    validUntilMs: NOW + 15_000,
    baselineBalanceWei: BASELINE.toString(),
    minimumBalanceWei: (BASELINE / 2n).toString(),
    maxWalletWei: "200000000000000000",
  };
  function write(patch: Record<string, unknown> = {}): void {
    writeFileSync(path, JSON.stringify({ ...permit, ...patch }), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  function reset(): void {
    Date.now = () => NOW;
    process.env.SEARCHER_LIVE_SESSION_PATH = path;
    process.env.SEARCHER_LIVE_SESSION_ID = permit.runId;
    signs = auths = sends = 0;
    balance = BASELINE;
    onNonce = onBalance = onSign = onAuth = onFetch = undefined;
    write();
  }
  const wallet = {
    address: WALLET,
    getNonce: async () => { onNonce?.(); return 7; },
    signTransaction: async () => { signs++; onSign?.(); return "0x01"; },
    signMessage: async () => { auths++; onAuth?.(); return "mock-auth"; },
  } as unknown as ethers.Wallet;
  const provider = {
    getBalance: async () => { onBalance?.(); return balance; },
  } as unknown as ethers.JsonRpcProvider;
  const params = {
    calldataHex: "0x",
    gasUsed: 100_000,
    wallet,
    botvmAddress: EXECUTOR,
    provider,
    bribeWei: 0n,
    maxBaseFeePerGas: 1_000_000_000n,
    targetBlock: 101,
    submissionMode: "standalone" as const,
  };
  const capture = () => captureBoundedLiveSession({
    wallet: WALLET, executor: EXECUTOR, chainId: 1, targetBlock: 101, mode: "standalone",
  });
  async function blocked(code: string, overrides: Partial<typeof params> = {}): Promise<void> {
    await assert.rejects(buildSignedBackrunTx({ ...params, ...overrides }), { message: `bounded-live:${code}` });
    assert.equal(signs, 0);
    assert.equal(auths, 0);
    assert.equal(sends, 0);
    checks++;
  }
  try {
    console.log = () => {};
    globalThis.fetch = (async () => {
      sends++;
      onFetch?.();
      return { ok: true, status: 200, text: async () => '{"result":{"bundleHash":"mock"}}' } as Response;
    }) as typeof fetch;

    reset();
    delete process.env.SEARCHER_LIVE_SESSION_PATH;
    assert.equal(capture(), null);
    const legacy = await buildSignedBackrunTx({ ...params, targetBlock: undefined, submissionMode: undefined });
    assert.equal(legacy.liveSession, null);
    assert.equal(signs, 1);
    assert.equal(sends, 0);
    checks++;

    reset();
    const result = await submitStandaloneBundle(params);
    assert.equal(signs, 1);
    assert.equal(auths, 1);
    assert.equal(sends, 4);
    assert.equal(result.filter((entry) => entry.accepted).length, 4);
    checks++;

    for (const [patch, code] of [
      [{ schemaVersion: 2 }, "invalid-permit"],
      [{ status: "pending" }, "inactive"],
      [{ status: "stopped" }, "inactive"],
      [{ chainId: 10 }, "invalid-permit"],
      [{ mode: "dual" }, "invalid-permit"],
      [{ runId: "other-run" }, "identity-mismatch"],
      [{ wallet: EXECUTOR }, "identity-mismatch"],
      [{ executor: WALLET }, "identity-mismatch"],
      [{ firstTargetBlock: 102, lastTargetBlock: 351 }, "target-outside-window"],
      [{ lastTargetBlock: 351 }, "invalid-permit"],
      [{ maxBlocks: 2501, lastTargetBlock: 2601 }, "invalid-permit"],
      [{ startedAtMs: NOW + 1 }, "expired"],
      [{ deadlineAtMs: NOW }, "expired"],
      [{ deadlineAtMs: NOW + 12 * 60 * 60 * 1000 }, "invalid-permit"],
      [{ validUntilMs: NOW }, "expired"],
      [{ validUntilMs: NOW + 15001 }, "expired"],
      [{ validUntilMs: NOW + 10001, deadlineAtMs: NOW + 10000 }, "expired"],
      [{ baselineBalanceWei: "1e15" }, "invalid-permit"],
      [{ minimumBalanceWei: "999999999999999" }, "invalid-balance-limits"],
      [{ minimumBalanceWei: "2000000000000001" }, "invalid-balance-limits"],
      [{ maxWalletWei: "200000000000000001" }, "invalid-balance-limits"],
      [{ maxWalletWei: "0" }, "invalid-balance-limits"],
      [{ baselineBalanceWei: "101", minimumBalanceWei: "50" }, "invalid-balance-limits"],
    ] as const) {
      reset();
      write(patch);
      await blocked(code);
    }

    reset();
    await blocked("target-outside-window", { targetBlock: undefined });
    reset();
    await blocked("target-outside-window", { targetBlock: 351 });
    reset();
    await blocked("standalone-only", { submissionMode: undefined });
    reset();
    delete process.env.SEARCHER_LIVE_SESSION_ID;
    await blocked("identity-mismatch");
    reset();
    process.env.SEARCHER_LIVE_SESSION_PATH = "relative.json";
    await blocked("invalid-permit-path");
    reset();
    chmodSync(path, 0o640);
    await blocked("unreadable-permit");
    reset();
    writeFileSync(path, "{broken");
    await blocked("unreadable-permit");
    reset();
    process.env.SEARCHER_LIVE_SESSION_PATH = dir;
    await blocked("unreadable-permit");
    reset();
    const link = join(dir, "symlink.json");
    symlinkSync(path, link);
    process.env.SEARCHER_LIVE_SESSION_PATH = link;
    await blocked("unreadable-permit");
    unlinkSync(link);

    reset();
    balance = 200_000_000_000_000_001n;
    await blocked("balance-limit");
    reset();
    balance = BASELINE / 2n + 130_000_000_000_000n - 1n;
    await blocked("balance-limit");
    reset();
    await blocked("balance-limit", { bribeWei: 1_000_000_000_000_000n });
    reset();
    balance = BASELINE / 2n + 130_000_000_000_000n;
    await buildSignedBackrunTx(params);
    assert.equal(signs, 1); // Exact remaining-balance boundary is permitted.
    checks++;

    reset();
    onNonce = () => { write({ status: "stopped" }); };
    await blocked("inactive");
    reset();
    onBalance = () => {
      delete process.env.SEARCHER_LIVE_SESSION_PATH;
      delete process.env.SEARCHER_LIVE_SESSION_ID;
      write({ status: "stopped" });
    };
    await blocked("inactive");
    reset();
    onSign = () => { write({ status: "stopped" }); };
    await assert.rejects(submitStandaloneBundle(params), { message: "bounded-live:inactive" });
    assert.equal(signs, 1);
    assert.equal(auths, 0);
    assert.equal(sends, 0);
    checks++;

    reset();
    onAuth = () => {
      delete process.env.SEARCHER_LIVE_SESSION_PATH;
      write({ status: "stopped" });
    };
    const stopped = await submitStandaloneBundle(params);
    assert.equal(signs, 1);
    assert.equal(auths, 1);
    assert.equal(sends, 0);
    assert.ok(stopped.every((entry) => !entry.accepted && entry.error === "bounded-live:inactive"));
    checks++;

    reset();
    onFetch = () => { write({ status: "stopped" }); };
    const partial = await submitStandaloneBundle(params);
    assert.equal(sends, 1); // First permitted relay cannot authorize later sends.
    assert.equal(partial.filter((entry) => entry.accepted).length, 1);
    checks++;

    reset();
    const pinned = capture();
    assert.ok(pinned);
    write({ deadlineAtMs: NOW + 120_000 });
    assert.throws(() => pinned.assertActive(), { message: "bounded-live:permit-changed" });
    checks++;
    reset();
    const heartbeat = capture();
    Date.now = () => NOW + 5_000;
    write({ validUntilMs: NOW + 20_000 });
    heartbeat!.assertActive();
    Date.now = () => NOW + 20_000;
    assert.throws(() => heartbeat!.assertActive(), { message: "bounded-live:expired" });
    checks++;

    reset();
    await assert.rejects(submitBundle({ ...params, victimRawTx: "0x02" }), { message: "bounded-live:standalone-only" });
    assert.equal(signs + auths + sends, 0);
    checks++;
    reset();
    await assert.rejects(submitMevShareBundle({ ...params, victimHash: "0x03" }), { message: "bounded-live:standalone-only" });
    assert.equal(signs + auths + sends, 0);
    checks++;

    savedLog(`bounded-live-session: ${checks} mock-only checks passed`);
  } finally {
    if (savedPath === undefined) delete process.env.SEARCHER_LIVE_SESSION_PATH;
    else process.env.SEARCHER_LIVE_SESSION_PATH = savedPath;
    if (savedId === undefined) delete process.env.SEARCHER_LIVE_SESSION_ID;
    else process.env.SEARCHER_LIVE_SESSION_ID = savedId;
    Date.now = savedNow;
    globalThis.fetch = savedFetch;
    console.log = savedLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
