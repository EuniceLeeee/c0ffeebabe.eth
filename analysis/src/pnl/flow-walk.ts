/**
 * flow-walk — receipt flow reconstruction (the leg-by-leg transfer walk behind F-010/011/012).
 *
 * From one receipt: the ORDERED value movements (transfers + mint/burn + WETH wrap/unwrap), token
 * symbol/decimals resolution, address role labels (executor / venue / flash provider / mint-burn),
 * per-address per-token nets, conserved intermediaries (in == out), and the executor's net take.
 * This is the root analysis the winner_style rules layer on: "who ended up with what, via whom".
 */
import { decodeTransfer } from "../decode/erc20.js";
import { lower, TOKEN_META, TOPICS } from "../registry/protocols.js";
import { hexToBigInt, RpcClient } from "../rpc/client.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SELECTOR_SYMBOL = "0x95d89b41";
const SELECTOR_DECIMALS = "0x313ce567";

const VENUE_TOPIC_LABELS: Array<{ topic: string; label: string }> = [
  { topic: lower(TOPICS.univ2Swap), label: "univ2" },
  { topic: lower(TOPICS.univ3Swap), label: "univ3" },
  { topic: lower(TOPICS.univ4Swap), label: "univ4-manager" },
  { topic: lower(TOPICS.curveTokenExchange), label: "curve" },
  { topic: lower(TOPICS.curveTokenExchangeUnderlying), label: "curve" },
  { topic: lower(TOPICS.balancerV2Swap), label: "balancerV2" },
  { topic: lower(TOPICS.pancakeV3Swap), label: "pancakeV3" },
  { topic: lower(TOPICS.dodoSwap), label: "dodo" },
  { topic: lower(TOPICS.psmSellGem), label: "psm" },
  { topic: lower(TOPICS.psmBuyGem), label: "psm" },
];
const FLASH_TOPIC_SET = new Set(
  [TOPICS.balancerV2FlashLoan, TOPICS.morphoFlashLoan, TOPICS.univ3Flash, TOPICS.aaveV3FlashLoan].map(lower),
);

export interface FlowStep {
  logIndex: number;
  kind: "transfer" | "mint" | "burn" | "wrap" | "unwrap";
  token: string;
  from: string;
  to: string;
  amount: bigint;
}

export interface ResolvedTokenMeta {
  symbol: string;
  decimals: number | null;
}

export interface FlowReport {
  steps: FlowStep[];
  tokens: Map<string, ResolvedTokenMeta>;
  labels: Map<string, string>;
  netByToken: Map<string, Map<string, bigint>>;
  conservedIntermediaries: Array<{ token: string; address: string; throughputRaw: string }>;
  executorNetByToken: Map<string, bigint>;
}

type Json = Record<string, any>;

export function walkFlowSteps(receipt: Json | null): FlowStep[] {
  const steps: FlowStep[] = [];
  const topicTransfer = lower(TOPICS.transfer);
  const topicWethDeposit = lower(TOPICS.wethDeposit);
  const topicWethWithdrawal = lower(TOPICS.wethWithdrawal);
  for (const log of receipt?.logs ?? []) {
    const logIndex = Number(hexToBigInt(log?.logIndex ?? "0x0"));
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    const emitter = lower(String(log?.address ?? ""));
    if (topic0 === topicTransfer) {
      const transfer = decodeTransfer(log);
      if (!transfer || transfer.amount === 0n) continue;
      const from = lower(transfer.from);
      const to = lower(transfer.to);
      const kind = from === ZERO_ADDRESS ? "mint" : to === ZERO_ADDRESS ? "burn" : "transfer";
      steps.push({ logIndex, kind, token: lower(transfer.token), from, to, amount: transfer.amount });
    } else if (topic0 === topicWethDeposit || topic0 === topicWethWithdrawal) {
      // WETH Deposit(dst, wad) / Withdrawal(src, wad): the native-ETH conversion legs a pure
      // Transfer walk misses (coffee's unwrap profit-take pattern).
      const party = `0x${String(log?.topics?.[1] ?? "").slice(-40)}`.toLowerCase();
      const amount = hexToBigInt(log?.data ?? "0x0");
      if (amount === 0n) continue;
      steps.push(topic0 === topicWethDeposit
        ? { logIndex, kind: "wrap", token: emitter, from: party, to: party, amount }
        : { logIndex, kind: "unwrap", token: emitter, from: party, to: party, amount });
    }
  }
  return steps.sort((a, b) => a.logIndex - b.logIndex);
}

// Role labels from the receipt itself: swap-topic emitters become venues, flash-topic emitters
// flash providers, plus the executor set (tx from/to + profit beneficiary).
export function buildAddressLabels(receipt: Json | null, executors: Set<string>): Map<string, string> {
  const labels = new Map<string, string>();
  for (const log of receipt?.logs ?? []) {
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    const emitter = lower(String(log?.address ?? ""));
    const venue = VENUE_TOPIC_LABELS.find((entry) => entry.topic === topic0);
    if (venue) labels.set(emitter, venue.label);
    else if (FLASH_TOPIC_SET.has(topic0) && !labels.has(emitter)) labels.set(emitter, "flash-provider");
  }
  for (const executor of executors) labels.set(executor, "EXECUTOR");
  labels.set(ZERO_ADDRESS, "MINT/BURN");
  return labels;
}

export async function resolveTokenMeta(
  rpc: RpcClient,
  tokens: Iterable<string>,
): Promise<Map<string, ResolvedTokenMeta>> {
  const out = new Map<string, ResolvedTokenMeta>();
  for (const token of tokens) {
    const key = lower(token);
    if (out.has(key)) continue;
    const known = TOKEN_META[key];
    if (known) {
      out.set(key, { symbol: known.symbol, decimals: known.decimals });
      continue;
    }
    out.set(key, {
      symbol: (await callString(rpc, key, SELECTOR_SYMBOL)) ?? `${key.slice(0, 10)}…`,
      decimals: await callUint8(rpc, key, SELECTOR_DECIMALS),
    });
  }
  return out;
}

async function callString(rpc: RpcClient, to: string, data: string): Promise<string | null> {
  try {
    const result = await rpc.call<string>("eth_call", [{ to, data }, "latest"]);
    if (typeof result !== "string" || result.length <= 2) return null;
    const hex = result.slice(2);
    // Dynamic string (offset + len + bytes) or legacy bytes32 symbol.
    const raw = hex.length > 128
      ? hex.slice(128, 128 + Number.parseInt(hex.slice(64, 128), 16) * 2)
      : hex;
    const text = Buffer.from(raw, "hex").toString("utf8").replace(/\0/g, "").trim();
    return text.length > 0 && text.length <= 32 ? text : null;
  } catch {
    return null;
  }
}

async function callUint8(rpc: RpcClient, to: string, data: string): Promise<number | null> {
  try {
    const result = await rpc.call<string>("eth_call", [{ to, data }, "latest"]);
    const value = Number(hexToBigInt(result));
    return Number.isInteger(value) && value >= 0 && value <= 36 ? value : null;
  } catch {
    return null;
  }
}

export async function buildFlowReport(
  rpc: RpcClient,
  receipt: Json | null,
  executors: Set<string>,
): Promise<FlowReport> {
  const steps = walkFlowSteps(receipt);
  const netByToken = new Map<string, Map<string, bigint>>();
  const throughput = new Map<string, Map<string, bigint>>();
  for (const step of steps) {
    if (step.kind === "wrap" || step.kind === "unwrap") continue;
    let net = netByToken.get(step.token);
    let thru = throughput.get(step.token);
    if (!net) { net = new Map(); netByToken.set(step.token, net); }
    if (!thru) { thru = new Map(); throughput.set(step.token, thru); }
    if (step.from !== ZERO_ADDRESS) net.set(step.from, (net.get(step.from) ?? 0n) - step.amount);
    if (step.to !== ZERO_ADDRESS) {
      net.set(step.to, (net.get(step.to) ?? 0n) + step.amount);
      thru.set(step.to, (thru.get(step.to) ?? 0n) + step.amount);
    }
  }
  const conservedIntermediaries: FlowReport["conservedIntermediaries"] = [];
  const executorNetByToken = new Map<string, bigint>();
  for (const [token, net] of netByToken) {
    let executorNet = 0n;
    for (const [address, amount] of net) {
      if (executors.has(address)) executorNet += amount;
      else if (amount === 0n) {
        const moved = throughput.get(token)?.get(address) ?? 0n;
        if (moved > 0n) conservedIntermediaries.push({ token, address, throughputRaw: moved.toString() });
      }
    }
    if (executorNet !== 0n) executorNetByToken.set(token, executorNet);
  }
  const tokens = await resolveTokenMeta(rpc, netByToken.keys());
  return {
    steps,
    tokens,
    labels: buildAddressLabels(receipt, executors),
    netByToken,
    conservedIntermediaries,
    executorNetByToken,
  };
}

export function formatTokenAmount(amount: bigint, decimals: number | null): string {
  if (decimals == null || decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function renderFlowWalk(report: FlowReport, maxSteps = 40): string {
  const lines: string[] = [];
  const name = (address: string) => {
    const label = report.labels.get(address);
    const short = `${address.slice(0, 10)}…`;
    return label ? `${label}(${short})` : short;
  };
  const tokenName = (token: string) => report.tokens.get(token)?.symbol ?? `${token.slice(0, 10)}…`;
  const amountOf = (step: FlowStep) => formatTokenAmount(step.amount, report.tokens.get(step.token)?.decimals ?? null);
  lines.push(`flow walk (${report.steps.length} steps):`);
  for (const step of report.steps.slice(0, maxSteps)) {
    if (step.kind === "wrap" || step.kind === "unwrap") {
      lines.push(`  #${step.logIndex} ${tokenName(step.token).padEnd(8)} ${amountOf(step).padStart(16)}  ${step.kind.toUpperCase()} by ${name(step.from)}`);
    } else {
      const tag = step.kind === "transfer" ? "" : ` [${step.kind.toUpperCase()}]`;
      lines.push(`  #${step.logIndex} ${tokenName(step.token).padEnd(8)} ${amountOf(step).padStart(16)}  ${name(step.from)} → ${name(step.to)}${tag}`);
    }
  }
  if (report.steps.length > maxSteps) lines.push(`  … ${report.steps.length - maxSteps} more steps (use --max-steps)`);
  lines.push("net by address:");
  for (const [token, net] of report.netByToken) {
    const meta = report.tokens.get(token);
    const entries = [...net.entries()]
      .filter(([, amount]) => amount !== 0n)
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
    for (const [address, amount] of entries.slice(0, 4)) {
      lines.push(`  ${(meta?.symbol ?? token.slice(0, 10)).padEnd(8)} ${formatTokenAmount(amount, meta?.decimals ?? null).padStart(16)}  ${name(address)}`);
    }
  }
  if (report.conservedIntermediaries.length > 0) {
    lines.push("conserved intermediaries (in == out):");
    for (const entry of report.conservedIntermediaries.slice(0, 6)) {
      const meta = report.tokens.get(entry.token);
      lines.push(`  ${(meta?.symbol ?? entry.token.slice(0, 10)).padEnd(8)} throughput ${formatTokenAmount(BigInt(entry.throughputRaw), meta?.decimals ?? null)}  via ${name(entry.address)}`);
    }
  }
  const executorParts = [...report.executorNetByToken.entries()].map(([token, amount]) =>
    `${formatTokenAmount(amount, report.tokens.get(token)?.decimals ?? null)} ${tokenName(token)}`);
  lines.push(`executor net take: ${executorParts.join(", ") || "0 (all conserved)"}`);
  return lines.join("\n");
}
