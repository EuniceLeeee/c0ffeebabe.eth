import type { StateBackend } from "../shared/state/state-backend.js";
import type { RevmFatalReason } from "./revm-sim-client.js";

type RpcErrorShape = { code?: unknown; data?: unknown; message?: unknown };

/** ethers labels every JSON-RPC eth_call error CALL_EXCEPTION, including 429
 * and provider failures. Only its structured original error supplies evidence. */
export function getEthersCallRpcError(error: unknown): RpcErrorShape | undefined {
  if (!error || typeof error !== "object") return undefined;
  const item = error as { code?: unknown; info?: { error?: unknown; payload?: { method?: unknown } } };
  const method = item.info?.payload?.method;
  const inner = item.info?.error;
  return item.code === "CALL_EXCEPTION" && (method === "eth_call" || method === "eth_estimateGas") &&
    inner !== null && typeof inner === "object" ? inner as RpcErrorShape : undefined;
}


export function isRpcThrottleError(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause; depth++) {
    const item = cause as { code?: unknown; data?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
    const rpcError = getEthersCallRpcError(cause);
    if (rpcError !== undefined) { cause = rpcError; continue; }
    // Contract revert text is not evidence of transport throttling.
    if (item.code === 3 || item.code === "CALL_EXCEPTION" ||
        (item.code === -32000 && typeof item.data === "string" && /^0x[0-9a-f]*$/i.test(item.data))) return false;
    if (item.code === 429 || item.status === 429 || item.statusCode === 429) return true;
    const message = typeof item.message === "string" ? item.message : String(cause);
    // Ignore revert text itself, not a transport failure it may be wrapping.
    if (/\bexecution revert(?:ed)?\b/i.test(message)) {
      cause = item.cause;
      continue;
    }
    if (/\bHTTP[ :]+429\b|\btoo many requests\b|\brate.?limit\b|(?:compute units|throughput|quota).*(?:exceed|limit|capacity)/i.test(message) ||
        /\b(?:quota|compute[ -]units?)\b.*\b(?:exhaust(?:ed|ion)|deplet(?:ed|ion))\b/i.test(message)) return true;
    cause = item.cause;
  }
  return false;
}

/** A spent allocation cannot recover from a short throughput backoff. */
export function isRpcQuotaExhaustedError(error: unknown): boolean {
  if (!isRpcThrottleError(error)) return false;
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause; depth++) {
    const rpcError = getEthersCallRpcError(cause);
    if (rpcError !== undefined) { cause = rpcError; continue; }
    const item = cause as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
    const message = typeof item.message === "string" ? item.message : String(cause);
    if (item.code !== 429 && item.status !== 429 && item.statusCode !== 429 &&
        /\bexecution revert(?:ed)?\b/i.test(message)) { cause = item.cause; continue; }
    if (/\b(?:monthly|daily)\b.*\b(?:limit|quota|capacity)\b|\b(?:quota|credits?|compute[ -]units?)\b.*\b(?:exhaust(?:ed|ion)|deplet(?:ed|ion))\b/i.test(message)) return true;
    cause = item.cause;
  }
  return false;
}

type RpcThrottleReason = Extract<RevmFatalReason, { kind: "rpc-throttle" }>;
export interface LiveRpcThrottleRecord {
  readonly sourceBlock: number;
  readonly failedBlocks: number;
  readonly limit: 5;
  readonly action: "observe" | "recovered" | "stop";
  readonly category?: RpcThrottleReason["category"];
}

/** Observe failed source passes, not individual requests. The failed source
 * must still close/drain; only a later healthy, drained source resets the streak.
 * This policy never retries RPC or changes the ordinary head scheduler. */
export class LiveRpcThrottleObservation {
  private readonly failedBlocks = new Set<number>();
  private recoveredThrough = -1;
  private stopped = false;
  constructor(
    private readonly stop: (reason: RpcThrottleReason) => void,
    private readonly record: (event: LiveRpcThrottleRecord) => void = event => {
      console.warn(`[searcher/rpc-throttle-observation] ${JSON.stringify(event)}`);
    },
  ) {}

  observeError(sourceBlock: number, error: unknown): void {
    if (!isRpcThrottleError(error)) return;
    const exhausted = isRpcQuotaExhaustedError(error);
    this.observe(sourceBlock, { kind: "rpc-throttle",
      category: exhausted ? "rpc-quota" : "rpc-rate-limit" }, exhausted);
  }

  observeFatal(sourceBlock: number, reason: RpcThrottleReason): void {
    // The engine's rpc-quota category also covers throughput/capacity limits.
    // Without the original provider evidence it is not proof of a spent quota.
    this.observe(sourceBlock, reason, false);
  }

  private observe(sourceBlock: number, reason: RpcThrottleReason, exhausted: boolean): void {
    if (this.stopped) return;
    // Retirement-time failures from an older source cannot poison a healthy
    // successor. An explicitly spent allocation remains terminal regardless.
    if (!exhausted && (sourceBlock <= this.recoveredThrough || this.failedBlocks.has(sourceBlock))) return;
    this.failedBlocks.add(sourceBlock);
    const stop = exhausted || this.failedBlocks.size >= 5;
    this.stopped = stop;
    try {
      this.record({ sourceBlock, failedBlocks: this.failedBlocks.size, limit: 5,
        action: stop ? "stop" : "observe", category: reason.category });
    } catch { /* Diagnostics cannot change admission or shutdown. */ }
    if (stop) this.stop(reason);
  }

  observeRecovery(sourceBlock: number): void {
    if (this.stopped || sourceBlock <= this.recoveredThrough ||
        [...this.failedBlocks].some(block => block >= sourceBlock)) return;
    this.recoveredThrough = sourceBlock;
    if (this.failedBlocks.size === 0) return;
    this.failedBlocks.clear();
    try {
      this.record({ sourceBlock, failedBlocks: 0, limit: 5, action: "recovered" });
    } catch { /* Diagnostics cannot change the recovery boundary. */ }
  }
}

/** Observe transport failures before a Family turns them into unresolved quotes.
 * A tripped guard never dispatches again, including a caller's retry. */
export function guardRpcThrottle(
  backend: Pick<StateBackend, "call">,
  onThrottle: () => void,
): Pick<StateBackend, "call"> {
  let tripped = false;
  return {
    async call(...args) {
      if (tripped) throw new Error("RPC HTTP 429 guard is closed");
      try {
        return await backend.call(...args);
      } catch (error) {
        if (!tripped && isRpcThrottleError(error)) { tripped = true; onThrottle(); }
        throw error;
      }
    },
  };
}
