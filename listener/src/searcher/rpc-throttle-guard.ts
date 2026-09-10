import type { StateBackend } from "../shared/state/state-backend.js";

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
        let cause: unknown = error;
        for (let depth = 0; depth < 8 && cause; depth++) {
          const item = cause as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
          if (item.code === 429 || item.status === 429 || item.statusCode === 429 ||
              /\bHTTP[ :]+429\b|\btoo many requests\b|\brate.?limit\b|(?:compute units|throughput|quota).*(?:exceed|limit|capacity)/i.test(
                typeof item.message === "string" ? item.message : String(cause))) {
            if (!tripped) { tripped = true; onThrottle(); }
            break;
          }
          cause = item.cause;
        }
        throw error;
      }
    },
  };
}
