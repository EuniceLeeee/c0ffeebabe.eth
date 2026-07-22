import { ethers } from "ethers";
import type { ProtocolDiscoveryContext } from "./venues/route-leg-adapter.js";

const ERC20_BALANCE = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
]);
const BALANCE_SLOT_CANDIDATES = 32;
const MAX_ACCESS_LIST_KEYS = 64;
const MAX_VERIFY_ATTEMPTS = 1 + MAX_ACCESS_LIST_KEYS + BALANCE_SLOT_CANDIDATES * 2;
const DEFAULT_DISCOVERY_BUDGET_MS = 10_000;
const RETRYABLE_CODES = new Set([
  "TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const COORDINATOR_RETRYABLE_CODES = new Set([
  "TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

/** Process-lifetime memo; code upgrades and different holders cannot share a slot key. */
const balanceSlotMemo = new Map<string, string>();

/**
 * Locate and verify the exact balanceOf(holder) storage key for an ERC20.
 *
 * The access-list path handles namespaced/diamond layouts. The bounded
 * Solidity/Vyper scan is only a compatibility fallback. A guessed slot is
 * never returned: every candidate must make balanceOf read `probeValue` under
 * the same state override used by the later active protocol probe.
 */
export async function discoverErc20BalanceStorageSlot(input: {
  readonly context: ProtocolDiscoveryContext;
  readonly token: string;
  readonly holder: string;
  readonly codeHash: string;
  readonly probeValue: bigint;
  readonly deadlineAtMs?: number;
}): Promise<string | null> {
  const simulate = input.context.backend.simulateCalls?.bind(input.context.backend);
  if (!simulate || input.probeValue <= 0n) return null;

  const token = ethers.getAddress(input.token);
  const holder = ethers.getAddress(input.holder);
  const deadlineAtMs = input.deadlineAtMs ?? Date.now() + DEFAULT_DISCOVERY_BUDGET_MS;
  if (!Number.isFinite(deadlineAtMs)) throw new Error("invalid ERC20 slot discovery deadline");
  let attempts = 0;
  const assertBudget = (): void => {
    if (Date.now() >= deadlineAtMs || attempts >= MAX_VERIFY_ATTEMPTS) {
      throw probeBudgetCensored("ERC20 balance slot discovery exhausted its bounded probe budget");
    }
  };
  const memoKey = [
    token.toLowerCase(),
    holder.toLowerCase(),
    input.codeHash.toLowerCase(),
  ].join("|");
  const balanceOfData = ERC20_BALANCE.encodeFunctionData("balanceOf", [holder]);

  const verifies = async (slotKey: string): Promise<boolean> => {
    assertBudget();
    attempts++;
    let result;
    try {
      [result] = await simulate({
        calls: [{ from: holder, to: token, data: balanceOfData }],
        stateOverrides: {
          [token]: { stateDiff: { [slotKey]: ethers.toBeHex(input.probeValue, 32) } },
        },
      });
    } catch (error) {
      if (isRetryableProbeFailure(error)) throw normalizedRetryableFailure(error);
      throw error;
    }
    if (!result || result.status !== 1) return false;
    try {
      return BigInt(ERC20_BALANCE.decodeFunctionResult("balanceOf", result.returnData)[0]) ===
        input.probeValue;
    } catch {
      return false;
    }
  };

  const memoized = balanceSlotMemo.get(memoKey);
  if (memoized !== undefined) {
    if (await verifies(memoized)) return memoized;
    balanceSlotMemo.delete(memoKey);
  }

  const createAccessList = input.context.backend.createAccessList?.bind(input.context.backend);
  if (createAccessList) {
    let accessList: readonly { readonly address: string; readonly storageKeys: readonly string[] }[] | null = null;
    try {
      assertBudget();
      accessList = await createAccessList({ from: holder, to: token, data: balanceOfData });
      assertBudget();
    } catch (error) {
      // Unsupported/reverting access-list generation may fall back to the
      // verified layout scan. Transport/time-budget failures remain retryable;
      // never turn them into a semantic "not an ERC20" negative.
      if (isRetryableProbeFailure(error)) throw normalizedRetryableFailure(error);
      assertBudget();
    }
    if (accessList) {
      const storageKeys = [...new Set(accessList
        .filter((entry) => entry.address.toLowerCase() === token.toLowerCase())
        .flatMap((entry) => entry.storageKeys.map((item) => item.toLowerCase())))];
      if (storageKeys.length > MAX_ACCESS_LIST_KEYS) {
        throw probeBudgetCensored(
          `ERC20 access-list returned ${storageKeys.length} candidate keys; bounded probe limit is ${MAX_ACCESS_LIST_KEYS}`,
        );
      }
      for (const slotKey of storageKeys) {
        if (await verifies(slotKey)) {
          balanceSlotMemo.set(memoKey, slotKey);
          return slotKey;
        }
      }
    }
  }

  const abi = ethers.AbiCoder.defaultAbiCoder();
  for (let slot = 0; slot < BALANCE_SLOT_CANDIDATES; slot++) {
    for (const layout of ["solidity", "vyper"] as const) {
      const slotKey = ethers.keccak256(layout === "solidity"
        ? abi.encode(["address", "uint256"], [holder, BigInt(slot)])
        : abi.encode(["uint256", "address"], [BigInt(slot), holder]));
      if (await verifies(slotKey)) {
        balanceSlotMemo.set(memoKey, slotKey);
        return slotKey;
      }
    }
  }
  return null;
}

function isRetryableProbeFailure(error: unknown): boolean {
  for (const value of errorChain(error)) {
    if (
      typeof value === "string" &&
      /timeout|timed out|rate.?limit|too many requests|fetch failed|socket|network|connection (?:closed|reset|refused)|temporar(?:y|ily) unavailable|\b(?:429|502|503|504)\b/i.test(value)
    ) return true;
    if (value instanceof TypeError && /fetch failed/i.test(value.message)) return true;
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const code = String(record.code ?? "").toUpperCase();
    if (
      RETRYABLE_CODES.has(code) ||
      code.startsWith("ECONN") ||
      code.startsWith("UND_ERR_")
    ) return true;
    const status = Number(record.status ?? record.statusCode);
    if (RETRYABLE_HTTP_STATUSES.has(status)) return true;
    const message = value instanceof Error ? value.message : String(record.message ?? "");
    if (
      /timeout|timed out|rate.?limit|too many requests|fetch failed|socket|network|connection (?:closed|reset|refused)|temporar(?:y|ily) unavailable|\b(?:429|502|503|504)\b/i
        .test(message)
    ) return true;
  }
  return false;
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();
  while (pending.length > 0 && values.length < 16) {
    const next = pending.shift()!;
    values.push(next.value);
    if (!next.value || typeof next.value !== "object" || next.depth >= 4) continue;
    if (seen.has(next.value)) continue;
    seen.add(next.value);
    const record = next.value as Record<string, unknown>;
    for (const key of ["cause", "error", "response"] as const) {
      if (record[key] !== undefined) {
        pending.push({ value: record[key], depth: next.depth + 1 });
      }
    }
  }
  return values;
}

function normalizedRetryableFailure(error: unknown): unknown {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (
    COORDINATOR_RETRYABLE_CODES.has(code)
  ) return error;
  return Object.assign(
    new Error("retryable ERC20 storage probe RPC failure"),
    { code: "NETWORK_ERROR", cause: error },
  );
}

function probeBudgetCensored(message: string): Error {
  return Object.assign(new Error(message), {
    code: "TIMEOUT",
    reason: "PROBE_BUDGET_CENSORED",
    retryable: true,
  });
}
