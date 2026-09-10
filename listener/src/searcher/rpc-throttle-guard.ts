import type { StateBackend } from "../shared/state/state-backend.js";

export function isRpcThrottleError(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause; depth++) {
    const item = cause as { code?: unknown; data?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
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
