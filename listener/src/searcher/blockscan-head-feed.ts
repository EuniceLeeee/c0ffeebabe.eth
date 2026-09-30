/** Advisory heads only: source validation, hint retention and scheduling belong to the caller. */
export type BlockScanHeadFeedStatus = "connecting" | "subscribed" | "reconnecting" | "closed";

export interface BlockScanHeadFeedOptions {
  url: string;
  signal: AbortSignal;
  onHead: (number: number, hash: string) => void | Promise<void>;
  onStatus?: (status: BlockScanHeadFeedStatus) => void | Promise<void>;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

/** Starts without awaiting the connection. close/abort are terminal and idempotent. */
export function startBlockScanHeadFeed(input: BlockScanHeadFeedOptions): { close(): void } {
  let closed = false;
  let socket: WebSocket | undefined;
  let detach: (() => void) | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectMs = INITIAL_RECONNECT_MS;

  // Callback failures (including rejected promises) must not escape a socket/timer handler.
  function notify(callback: () => void | Promise<void>): void {
    try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Advisory consumer failed. */ }
  }
  function status(value: BlockScanHeadFeedStatus): void {
    notify(() => input.onStatus?.(value));
  }
  function clearHandshake(): void {
    if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
  }
  function retireSocket(): void {
    const previous = socket;
    socket = undefined; // Invalidate queued events before close can dispatch more events.
    clearHandshake();
    detach?.();
    detach = undefined;
    try { previous?.close(); } catch { /* Never forward transport errors or endpoint details. */ }
  }
  function close(): void {
    if (closed) return;
    closed = true;
    input.signal.removeEventListener("abort", close);
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    retireSocket();
    status("closed");
  }
  function reconnect(): void {
    if (closed || reconnectTimer !== undefined) return;
    retireSocket();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectMs);
    reconnectMs = Math.min(MAX_RECONNECT_MS, reconnectMs * 2);
    status("reconnecting");
  }
  function connect(): void {
    if (closed) return;
    status("connecting");
    if (closed) return; // The status callback may abort the feed.
    let current: WebSocket;
    try { current = new WebSocket(input.url); }
    catch { reconnect(); return; }
    socket = current;
    let requested = false;
    let subscription: string | undefined;
    const isCurrent = (): boolean => !closed && socket === current;
    const onFailure = (): void => { if (isCurrent()) reconnect(); };
    const onOpen = (): void => {
      if (!isCurrent() || requested) return;
      requested = true;
      try {
        current.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      } catch { onFailure(); }
    };
    const onMessage = (event: MessageEvent): void => {
      if (!isCurrent() || typeof event.data !== "string") return;
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!isRecord(message) || message.jsonrpc !== "2.0") return;
      if (requested && subscription === undefined && message.id === 1) {
        if ("error" in message || typeof message.result !== "string" || message.result.length === 0) {
          onFailure();
          return;
        }
        subscription = message.result;
        clearHandshake(); // The timeout covers both connect and subscription acknowledgement.
        reconnectMs = INITIAL_RECONNECT_MS;
        status("subscribed");
        return;
      }
      if (subscription === undefined || message.method !== "eth_subscription" || !isRecord(message.params)
        || message.params.subscription !== subscription || !isRecord(message.params.result)) return;
      const { number, hash } = message.params.result;
      if (typeof number !== "string" || !/^0x[1-9a-fA-F][0-9a-fA-F]{0,13}$/.test(number)
        || typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
      const height = Number(number);
      if (!Number.isSafeInteger(height) || height <= 0) return;
      notify(() => input.onHead(height, hash.toLowerCase()));
    };
    current.addEventListener("open", onOpen);
    current.addEventListener("message", onMessage);
    current.addEventListener("error", onFailure);
    current.addEventListener("close", onFailure);
    detach = () => {
      current.removeEventListener("open", onOpen);
      current.removeEventListener("message", onMessage);
      current.removeEventListener("error", onFailure);
      current.removeEventListener("close", onFailure);
    };
    handshakeTimer = setTimeout(onFailure, HANDSHAKE_TIMEOUT_MS);
  }

  if (input.signal.aborted) close();
  else {
    input.signal.addEventListener("abort", close, { once: true });
    connect();
  }
  return { close };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
