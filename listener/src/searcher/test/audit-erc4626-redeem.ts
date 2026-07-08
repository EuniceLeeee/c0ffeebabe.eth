/**
 * ERC4626 redeem audit on a local Anvil mainnet fork.
 *
 * For each POOL_REGISTRY ERC4626 entry, this performs a fork-only deposit -> redeem
 * round-trip when deposits are open, otherwise tries a recent share holder. It decodes
 * the redeem receipt's ERC20 Transfer logs to identify the token(s) actually paid to
 * the receiver, then compares the observed payout against asset() / previewRedeem and
 * the registry's nonStandardRedeem metadata.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { POOL_REGISTRY, type PoolEntry } from "../planner/token-graph.js";

const ERC20 = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const ERC20_BYTES32_SYMBOL = new ethers.Interface(["function symbol() view returns (bytes32)"]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
]);

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO_TOPIC = ethers.zeroPadValue(ethers.ZeroAddress, 32).toLowerCase();
const COMMON_ERC20_BALANCE_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 51];
const TEST_RECEIVER = "0x000000000000000000000000000000000000A462";

let toleranceBps = 5n;
let holderLookbackBlocks = 50_000;

type Verdict =
  | "OK_STANDARD"
  | "OK_NONSTANDARD_FLAGGED"
  | "BUG_UNFLAGGED_NONSTANDARD"
  | "BUG_MISDECLARED"
  | "SKIP";

interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

interface Payout {
  token: string;
  amount: bigint;
}

interface AuditRow {
  vault: string;
  symbol: string;
  asset: string;
  payoutToken: string;
  amountVsPreview: string;
  flag: string;
  verdict: Verdict;
  note?: string;
}

interface RedeemObservation {
  owner: string;
  receiver: string;
  shares: bigint;
  preview: bigint;
  payouts: Payout[];
  source: "deposit" | "holder";
}

function loadEnv(): void {
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required");

  const anvilPort = readIntEnv("AUDIT_ANVIL_PORT", 8626);
  const anvilUrl = `http://127.0.0.1:${anvilPort}`;
  toleranceBps = BigInt(readIntEnv("AUDIT_TOLERANCE_BPS", 5));
  holderLookbackBlocks = readIntEnv("AUDIT_HOLDER_LOOKBACK", 50_000);

  const vaults = POOL_REGISTRY.filter((pool) => pool.adapter === "erc4626");
  const upstream = new ethers.JsonRpcProvider(rpcUrl);
  const state = new AnvilStateBackend(rpcUrl, anvilUrl, anvilPort);
  await state.start();

  try {
    const forkBlock = await resolveForkBlock(upstream);
    console.log(
      `[erc4626-audit] vaults=${vaults.length} forkBlock=${forkBlock} ` +
        `anvil=${anvilUrl} upstream=${redactRpcUrl(rpcUrl)}`,
    );
    console.log(
      `[erc4626-audit] tolerance=${toleranceBps}bps holderLookback=${holderLookbackBlocks} blocks`,
    );
    await state.refreshFork(forkBlock);

    const rows: AuditRow[] = [];
    for (const entry of vaults) {
      await state.resetToBaseline();
      rows.push(await auditVault(state, entry, forkBlock));
    }

    printRows(rows);
    const ok = rows.filter((row) => row.verdict.startsWith("OK_")).length;
    const skip = rows.filter((row) => row.verdict === "SKIP").length;
    const bug = rows.filter((row) => row.verdict.startsWith("BUG_")).length;
    console.log(`${rows.length} vaults, ${ok} OK, ${skip} SKIP, ${bug} BUG`);
    if (bug > 0) process.exitCode = 1;
  } finally {
    state.stop();
    upstream.destroy();
  }
}

async function resolveForkBlock(provider: ethers.JsonRpcProvider): Promise<number> {
  const raw = process.env.AUDIT_BLOCK;
  if (!raw) return provider.getBlockNumber();
  const block = Number(raw);
  if (!Number.isInteger(block) || block <= 0) {
    throw new Error(`AUDIT_BLOCK must be a positive integer, got ${raw}`);
  }
  return block;
}

async function auditVault(
  state: AnvilStateBackend,
  entry: PoolEntry,
  forkBlock: number,
): Promise<AuditRow> {
  const vault = ethers.getAddress(entry.address);
  const fixedTokenIn = entry.fixedTokenIn ? ethers.getAddress(entry.fixedTokenIn) : "";
  const vaultMeta = await readTokenMeta(state, vault, { decimalsFallback: 18 });
  const flag = entry.nonStandardRedeem
    ? `nonStandard->${entry.redeemTokenOut ? short(ethers.getAddress(entry.redeemTokenOut)) : "missing"}`
    : "standard";

  try {
    if (!fixedTokenIn) {
      return skipRow(vault, vaultMeta.symbol, "-", flag, "missing fixedTokenIn");
    }

    const asset = await readAddress(state, vault, ERC4626.encodeFunctionData("asset"));
    const assetMeta = await readTokenMeta(state, asset);
    const assetMatchesRegistry = sameAddress(asset, fixedTokenIn);
    const assetCell = assetMatchesRegistry
      ? label(assetMeta)
      : `${label(assetMeta)} != fixed ${short(fixedTokenIn)}`;

    const observation = await observeRedeem(state, vault, assetMeta, forkBlock);
    const payoutCell = await formatPayoutTokens(state, observation.payouts);
    const amountCheck = amountVsPreview(observation.payouts, asset, observation.preview);
    const verdict = classify(entry, asset, observation, amountCheck.close, assetMatchesRegistry);
    const sourceNote = observation.source === "holder" ? `holder=${short(observation.owner)}` : "deposit";

    return {
      vault: short(vault),
      symbol: vaultMeta.symbol,
      asset: assetCell,
      payoutToken: payoutCell,
      amountVsPreview: amountCheck.text,
      flag,
      verdict,
      note: sourceNote,
    };
  } catch (err) {
    return skipRow(vault, vaultMeta.symbol, "-", flag, compactError(err));
  }
}

async function observeRedeem(
  state: AnvilStateBackend,
  vault: string,
  assetMeta: TokenMeta,
  forkBlock: number,
): Promise<RedeemObservation> {
  const depositSnap = await state.snapshot();
  try {
    const receiver = ethers.getAddress(TEST_RECEIVER);
    const amount = await chooseDepositAmount(state, vault, assetMeta, receiver);
    await dealToken(state, assetMeta.address, receiver, amount);
    await state.send({
      from: receiver,
      to: assetMeta.address,
      data: ERC20.encodeFunctionData("approve", [vault, amount]),
    });
    await state.send({
      from: receiver,
      to: vault,
      data: ERC4626.encodeFunctionData("deposit", [amount, receiver]),
      gas: "0x1000000",
    });
    const shareBalance = await balanceOf(state, vault, receiver);
    const shares = await chooseRedeemShares(state, vault, receiver, shareBalance);
    return redeemAndDecode(state, vault, receiver, receiver, shares, "deposit");
  } catch (err) {
    await state.revert(depositSnap);
    const depositErr = compactError(err);
    const holder = await findRecentShareHolder(state, vault, forkBlock);
    if (!holder) {
      throw new Error(`deposit failed (${depositErr}); no recent holder found`);
    }
    const shares = await chooseRedeemShares(state, vault, holder.address, holder.balance);
    try {
      return await redeemAndDecode(state, vault, holder.address, ethers.getAddress(TEST_RECEIVER), shares, "holder");
    } catch (redeemErr) {
      throw new Error(
        `deposit failed (${depositErr}); holder ${short(holder.address)} redeem failed (${compactError(redeemErr)})`,
      );
    }
  }
}

async function chooseDepositAmount(
  state: AnvilStateBackend,
  vault: string,
  assetMeta: TokenMeta,
  receiver: string,
): Promise<bigint> {
  const base = parseUnitsEnv("AUDIT_DEPOSIT_UNITS", "1", assetMeta.decimals);
  const maxDeposit = await readUint(state, vault, ERC4626.encodeFunctionData("maxDeposit", [receiver])).catch(
    () => ethers.MaxUint256,
  );
  if (maxDeposit === 0n) throw new Error("maxDeposit returned 0");

  const candidates = uniqueBigints([base, base * 10n, base * 100n, maxDeposit]
    .map((amount) => amount > maxDeposit ? maxDeposit : amount)
    .filter((amount) => amount > 0n));
  for (const amount of candidates) {
    const shares = await readUint(state, vault, ERC4626.encodeFunctionData("previewDeposit", [amount])).catch(
      () => 0n,
    );
    if (shares > 0n) return amount;
  }
  return candidates[0] ?? 0n;
}

async function chooseRedeemShares(
  state: AnvilStateBackend,
  vault: string,
  owner: string,
  shareBalance: bigint,
): Promise<bigint> {
  if (shareBalance === 0n) throw new Error("share balance is 0");
  const maxRedeem = await readUint(state, vault, ERC4626.encodeFunctionData("maxRedeem", [owner])).catch(
    () => shareBalance,
  );
  const redeemable = maxRedeem < shareBalance ? maxRedeem : shareBalance;
  if (redeemable === 0n) throw new Error("maxRedeem returned 0");

  const shareMeta = await readTokenMeta(state, vault, { decimalsFallback: 18 });
  const unit = 10n ** BigInt(Math.max(0, shareMeta.decimals));
  const candidates = uniqueBigints([unit, unit / 10n, redeemable / 10n, redeemable]
    .map((shares) => shares > redeemable ? redeemable : shares)
    .filter((shares) => shares > 0n));
  for (const shares of candidates) {
    const preview = await readUint(state, vault, ERC4626.encodeFunctionData("previewRedeem", [shares])).catch(
      () => 0n,
    );
    if (preview > 0n) return shares;
  }
  return candidates[candidates.length - 1] ?? redeemable;
}

async function redeemAndDecode(
  state: AnvilStateBackend,
  vault: string,
  owner: string,
  receiver: string,
  shares: bigint,
  source: "deposit" | "holder",
): Promise<RedeemObservation> {
  const preview = await readUint(state, vault, ERC4626.encodeFunctionData("previewRedeem", [shares]));
  const hash = await state.send({
    from: owner,
    to: vault,
    data: ERC4626.encodeFunctionData("redeem", [shares, receiver, owner]),
    gas: "0x1000000",
  });
  const receipt = await state.provider.getTransactionReceipt(hash);
  if (!receipt || receipt.status !== 1) throw new Error(`redeem receipt missing or failed: ${hash}`);
  return {
    owner,
    receiver,
    shares,
    preview,
    payouts: decodePayouts(receipt.logs, receiver),
    source,
  };
}

function decodePayouts(logs: readonly ethers.Log[], receiver: string): Payout[] {
  const toTopic = ethers.zeroPadValue(ethers.getAddress(receiver), 32).toLowerCase();
  const byToken = new Map<string, bigint>();
  for (const log of logs) {
    if (log.topics.length < 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics[2].toLowerCase() !== toTopic) continue;
    const amount = BigInt(log.data);
    if (amount === 0n) continue;
    const token = ethers.getAddress(log.address);
    byToken.set(token, (byToken.get(token) ?? 0n) + amount);
  }
  return [...byToken.entries()].map(([token, amount]) => ({ token, amount }));
}

async function findRecentShareHolder(
  state: AnvilStateBackend,
  vault: string,
  forkBlock: number,
): Promise<{ address: string; balance: bigint } | null> {
  if (holderLookbackBlocks <= 0) return null;
  const fromBlock = Math.max(0, forkBlock - holderLookbackBlocks);
  let logs: ethers.Log[];
  try {
    logs = await withTimeout(
      state.provider.getLogs({ address: vault, topics: [TRANSFER_TOPIC], fromBlock, toBlock: forkBlock }),
      20_000,
      `getLogs ${short(vault)}`,
    );
  } catch {
    return null;
  }
  for (const log of logs.reverse()) {
    if (log.topics.length < 3) continue;
    const toTopic = log.topics[2].toLowerCase();
    if (toTopic === ZERO_TOPIC) continue;
    const holder = ethers.getAddress("0x" + toTopic.slice(-40));
    const balance = await balanceOf(state, vault, holder).catch(() => 0n);
    if (balance > 0n) return { address: holder, balance };
  }
  return null;
}

function classify(
  entry: PoolEntry,
  asset: string,
  observation: RedeemObservation,
  amountClose: boolean,
  assetMatchesRegistry: boolean,
): Verdict {
  const payoutTokens = observation.payouts.map((payout) => payout.token);
  const singlePayout = payoutTokens.length === 1 ? payoutTokens[0] : null;
  const payoutMatchesAsset = singlePayout !== null && sameAddress(singlePayout, asset);
  const flagged = entry.nonStandardRedeem === true;

  if (flagged) {
    const declared = entry.redeemTokenOut ? ethers.getAddress(entry.redeemTokenOut) : "";
    return singlePayout !== null && declared && sameAddress(declared, singlePayout) && !payoutMatchesAsset
      ? "OK_NONSTANDARD_FLAGGED"
      : "BUG_MISDECLARED";
  }

  return payoutMatchesAsset && amountClose && assetMatchesRegistry
    ? "OK_STANDARD"
    : "BUG_UNFLAGGED_NONSTANDARD";
}

function amountVsPreview(payouts: Payout[], asset: string, preview: bigint): { close: boolean; text: string } {
  const assetPayout = payouts.find((payout) => sameAddress(payout.token, asset));
  const actual = assetPayout?.amount ?? (payouts.length === 1 ? payouts[0].amount : 0n);
  const diff = actual > preview ? actual - preview : preview - actual;
  const tolerance = preview * toleranceBps / 10_000n + 1n;
  const close = assetPayout !== undefined && diff <= tolerance;
  const basis = preview === 0n ? (actual === 0n ? 0n : 10_000n) : (diff * 1_000_000n) / preview;
  const sign = actual >= preview ? "+" : "-";
  const bps = `${sign}${formatCentiBps(basis)}bps`;
  const prefix = close ? "close" : "diff";
  const text = payouts.length > 1 ? `${prefix} ${bps} multi` : `${prefix} ${bps}`;
  return { close, text };
}

async function formatPayoutTokens(state: AnvilStateBackend, payouts: Payout[]): Promise<string> {
  if (payouts.length === 0) return "none";
  const labels = await Promise.all(
    payouts.map(async (payout) => {
      const meta = await readTokenMeta(state, payout.token, { decimalsFallback: 18 });
      return label(meta);
    }),
  );
  return labels.join(",");
}

async function readTokenMeta(
  state: AnvilStateBackend,
  token: string,
  opts: { decimalsFallback?: number } = {},
): Promise<TokenMeta> {
  const address = ethers.getAddress(token);
  const decimals = await readUint(state, address, ERC20.encodeFunctionData("decimals"))
    .then((value) => Number(value))
    .catch(() => opts.decimalsFallback ?? 18);
  const symbol = await readSymbol(state, address).catch(() => short(address));
  return { address, symbol, decimals };
}

async function readSymbol(state: AnvilStateBackend, token: string): Promise<string> {
  const data = ERC20.encodeFunctionData("symbol");
  const raw = await state.call({ to: token, data });
  try {
    return String(ERC20.decodeFunctionResult("symbol", raw)[0]);
  } catch {
    const bytes32 = ERC20_BYTES32_SYMBOL.decodeFunctionResult("symbol", raw)[0] as string;
    return ethers.decodeBytes32String(bytes32).replace(/\0+$/, "");
  }
}

async function readAddress(state: AnvilStateBackend, to: string, data: string): Promise<string> {
  const raw = await state.call({ to, data });
  return ethers.getAddress(ERC4626.decodeFunctionResult("asset", raw)[0] as string);
}

async function readUint(state: AnvilStateBackend, to: string, data: string): Promise<bigint> {
  const raw = await state.call({ to, data });
  return BigInt(raw);
}

async function balanceOf(state: AnvilStateBackend, token: string, account: string): Promise<bigint> {
  return readUint(state, token, ERC20.encodeFunctionData("balanceOf", [account]));
}

async function dealToken(
  state: AnvilStateBackend,
  token: string,
  to: string,
  amount: bigint,
): Promise<void> {
  const tokenAddr = ethers.getAddress(token);
  const toAddr = ethers.getAddress(to);
  if (await balanceOf(state, tokenAddr, toAddr).catch(() => 0n) >= amount) return;

  for (const slotIndex of COMMON_ERC20_BALANCE_SLOTS) {
    const snap = await state.snapshot();
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [toAddr, slotIndex]),
    );
    await state.provider.send("anvil_setStorageAt", [
      tokenAddr,
      slot,
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    if (await balanceOf(state, tokenAddr, toAddr).catch(() => 0n) >= amount) return;
    await state.revert(snap);
  }
  throw new Error(`dealToken: no balance slot found for ${short(tokenAddr)}`);
}

function skipRow(vault: string, symbol: string, asset: string, flag: string, reason: string): AuditRow {
  return {
    vault: short(vault),
    symbol,
    asset,
    payoutToken: "-",
    amountVsPreview: `SKIP: ${reason}`,
    flag,
    verdict: "SKIP",
  };
}

function printRows(rows: AuditRow[]): void {
  const table = [
    ["vault", "symbol", "asset()", "payout_token", "amt_vs_preview", "flag", "VERDICT"],
    ...rows.map((row) => [
      row.vault,
      row.symbol,
      row.asset,
      row.payoutToken,
      row.amountVsPreview,
      row.flag,
      row.verdict,
    ]),
  ];
  const widths = table[0].map((_, index) => Math.max(...table.map((row) => row[index].length)));
  for (const row of table) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join(" | "));
  }
  const notes = rows.filter((row) => row.note).map((row) => `${row.vault} ${row.symbol}: ${row.note}`);
  if (notes.length > 0) {
    console.log("\n[erc4626-audit] notes:");
    for (const note of notes) console.log(`  ${note}`);
  }
}

function label(meta: TokenMeta): string {
  return `${meta.symbol}(${short(meta.address)})`;
}

function short(address: string): string {
  const normalized = ethers.getAddress(address);
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function uniqueBigints(values: bigint[]): bigint[] {
  return [...new Set(values.map((value) => value.toString()))].map((value) => BigInt(value));
}

function parseUnitsEnv(key: string, fallback: string, decimals: number): bigint {
  const raw = process.env[key] ?? fallback;
  return ethers.parseUnits(raw, decimals);
}

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer, got ${raw}`);
  return value;
}

function formatCentiBps(value: bigint): string {
  const whole = value / 100n;
  const frac = value % 100n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

function compactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").slice(0, 180);
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? "<redacted>" : "";
    parsed.password = parsed.password ? "<redacted>" : "";
    if (parsed.search) parsed.search = "?<redacted>";
    return parsed.toString();
  } catch {
    return url.startsWith("http") ? "<rpc-url>" : url;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, labelText: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${labelText} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

main().catch((err) => {
  console.error(`erc4626 redeem audit FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
