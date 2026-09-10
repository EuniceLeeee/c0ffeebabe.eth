import type { CanonicalHeader } from "./canonical-header-journal.js";
import { ethereumBlockActivityCoverage } from "../shared/state/ethereum-block-activity.js";
import { postJsonRpc, StateCallAbortedError, type JsonRpcHttpResponse, type StateCallControl } from "../shared/state/state-backend.js";
import { isRpcThrottleError } from "./rpc-throttle-guard.js";

export interface BlockScanObservedHeader extends CanonicalHeader {
  readonly timestamp: number;
  readonly baseFeePerGas: bigint | null;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  readonly transactionHashes: readonly string[];
  /** Non-transaction balance changes cannot silently look like clean accounts. */
  readonly passiveTouchedAddresses?: readonly string[];
}

/** One raw request, without provider retries. Cancellation destroys the local
 * request/response before rejection; it cannot promise remote execution stops.
 * No endpoint, remote message/body or unsanitized cause escapes this boundary. */
export async function readBlockScanObservedHeader(
  rpcUrl: string,
  chainId: bigint,
  blockNumber: number,
  control?: StateCallControl,
): Promise<BlockScanObservedHeader> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error("invalid source header number");
  const { signal, deadlineAtMs } = control ?? {};
  if (deadlineAtMs !== undefined && !Number.isFinite(deadlineAtMs)) throw new Error("invalid source header deadline");
  const controller = new AbortController();
  const cancel = (kind: "signal" | "deadline"): void => {
    if (!controller.signal.aborted) controller.abort(new StateCallAbortedError(`source header ${kind} aborted`, kind));
  };
  const onAbort = (): void => cancel("signal");
  const assertOpen = (): void => {
    if (signal?.aborted) cancel("signal");
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) cancel("deadline");
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (): void => {
    if (deadlineAtMs === undefined) return;
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) { cancel("deadline"); return; }
    timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
  };
  try {
    assertOpen();
    signal?.addEventListener("abort", onAbort, { once: true });
    armDeadline();
    let response: JsonRpcHttpResponse;
    try {
      response = await postJsonRpc(rpcUrl, {
        jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber",
        params: [`0x${blockNumber.toString(16)}`, true],
      }, controller.signal);
    } catch (error) {
      assertOpen();
      // Even URL parsing, socket errors and cancellation reasons may contain
      // credentials. Preserve only our local error category, never the cause.
      if (error instanceof SyntaxError) throw new SyntaxError("source header response contained invalid JSON");
      throw new Error("source header transport failed");
    }
    assertOpen();
    const body = response.body !== null && typeof response.body === "object" && !Array.isArray(response.body)
      ? response.body as Record<string, unknown> : null;
    const validEnvelope = body?.jsonrpc === "2.0" && body.id === 1;
    const rpcError = validEnvelope && body.error !== null && typeof body.error === "object" && !Array.isArray(body.error)
      ? body.error as Record<string, unknown> : null;
    const code = rpcError && Number.isSafeInteger(rpcError.code) ? rpcError.code as number : undefined;
    if (response.statusCode === 429) {
      // A misleading revert-shaped body must not hide an actual HTTP 429.
      throw Object.assign(new Error("source header HTTP 429"), { statusCode: 429 });
    }
    if (code !== undefined && isRpcThrottleError(rpcError)) {
      throw Object.assign(new Error("source header HTTP 429 RPC throttle"), { statusCode: response.statusCode, code });
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Object.assign(new Error(`source header HTTP ${response.statusCode}`), { statusCode: response.statusCode });
    }
    if (!validEnvelope || !body || (Object.hasOwn(body, "error") === Object.hasOwn(body, "result"))) {
      throw new Error("invalid source header JSON-RPC envelope");
    }
    if (Object.hasOwn(body, "error")) {
      if (code === undefined || typeof rpcError?.message !== "string") throw new Error("invalid source header JSON-RPC error");
      throw Object.assign(new Error(`source header RPC error code ${code}`), { code });
    }
    const header = parseBlockScanObservedHeader(body.result, blockNumber, chainId);
    assertOpen();
    return header;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Normalize the existing header RPC without discarding its transaction list or
 * withdrawal recipients. The provider remains the canonical observation source. */
export function parseBlockScanObservedHeader(value: unknown, expectedNumber: number, chainId: bigint): BlockScanObservedHeader {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("missing source header");
  const block = value as Record<string, unknown>;
  const quantity = (value: unknown): bigint => {
    if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
      throw new Error("invalid source header quantity");
    }
    return BigInt(value);
  };
  const hash = (value: unknown): string => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("invalid source header hash");
    return value.toLowerCase();
  };
  const number = Number(quantity(block.number)), timestamp = Number(quantity(block.timestamp));
  if (!Number.isSafeInteger(number) || number !== expectedNumber || !Number.isSafeInteger(timestamp)) {
    throw new Error("source header height or timestamp mismatch");
  }
  if (!Array.isArray(block.transactions)) {
    throw new Error("source header lacks full activity anchors");
  }
  const transactionHashes = block.transactions.map(tx => hash(
    tx !== null && typeof tx === "object" && !Array.isArray(tx) ? tx.hash : tx));
  if (new Set(transactionHashes).size !== transactionHashes.length) throw new Error("duplicate source transaction");
  // No strong coverage means fresh amount quotes; it need not stop raw pricing.
  const coverage = ethereumBlockActivityCoverage(chainId, block);
  return Object.freeze({ number, hash: hash(block.hash), parentHash: hash(block.parentHash), timestamp,
    baseFeePerGas: block.baseFeePerGas == null ? null : quantity(block.baseFeePerGas),
    gasUsed: quantity(block.gasUsed), gasLimit: quantity(block.gasLimit),
    transactionHashes: Object.freeze(transactionHashes),
    ...(coverage === null ? {} : { passiveTouchedAddresses: coverage.passiveTouchedAddresses }),
  });
}
