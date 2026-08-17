import {
  ethers,
  type JsonRpcError,
  type JsonRpcPayload,
} from "ethers";

export interface DexDiscoveryReadControl {
  /** Absolute wall-clock deadline shared by the enclosing discovery generation. */
  readonly deadlineAtMs?: number;
  /** Aborting this signal aborts the underlying HTTP request, not only its waiter. */
  readonly signal?: AbortSignal;
  /** Optional dedicated background-read semaphore. */
  readonly run?: <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

let rpcId = 0;

export function supportsAbortableDexDiscoveryTransport(
  provider: ethers.JsonRpcProvider,
): boolean {
  return typeof (
    provider as ethers.JsonRpcProvider & {
      readonly _getConnection?: unknown;
    }
  )._getConnection === "function";
}

export async function readDexDiscoveryBlockNumber(
  provider: ethers.JsonRpcProvider,
  control?: DexDiscoveryReadControl,
): Promise<number> {
  const raw = await sendDexDiscoveryRpc<string>(
    provider,
    "eth_blockNumber",
    [],
    control,
  );
  const value = Number(BigInt(raw));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid DEX discovery block number ${raw}`);
  }
  return value;
}

/** Abortable JSON-RPC transport shared by startup and current-source reads. */
export async function sendDexDiscoveryRpc<T>(
  provider: ethers.JsonRpcProvider,
  method: string,
  params: readonly unknown[],
  control: DexDiscoveryReadControl = {},
): Promise<T> {
  validateDexDiscoveryControl(control);
  if (!hasDexDiscoveryControl(control)) {
    return provider.send(method, [...params]) as Promise<T>;
  }
  throwIfDexDiscoveryCancelled(control);
  if (control.run) {
    const { run, ...unbudgeted } = control;
    return run((budgetSignal) =>
      sendDexDiscoveryRpc<T>(provider, method, params, {
        ...unbudgeted,
        signal: mergeDexDiscoverySignals(
          unbudgeted.signal,
          budgetSignal,
        ),
      }));
  }
  const payload: JsonRpcPayload = {
    id: ++rpcId,
    jsonrpc: "2.0",
    method,
    params: [...params],
  };
  const connection = provider._getConnection();
  const controller = new AbortController();
  const detachParent = linkDexDiscoveryAbort(control.signal, controller);
  let deadlineExpired = false;
  const deadlineDelay = control.deadlineAtMs === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, control.deadlineAtMs - Date.now());
  const deadlineTimer = Number.isFinite(deadlineDelay)
    ? setTimeout(() => {
        deadlineExpired = true;
        controller.abort(dexDiscoveryDeadlineError(control.deadlineAtMs!));
      }, deadlineDelay)
    : null;
  try {
    const response = await fetch(connection.url, {
      method: "POST",
      headers: { ...connection.headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    throwIfDexDiscoveryCancelled(control);
    if (!response.ok) {
      throw new Error(
        `DEX discovery ${method} HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body = await response.json() as Partial<JsonRpcError> & {
      result?: unknown;
    };
    throwIfDexDiscoveryCancelled(control);
    if (body.error) throw provider.getRpcError(payload, body as JsonRpcError);
    if (!("result" in body)) {
      throw new Error(`DEX discovery ${method} returned no result`);
    }
    return body.result as T;
  } catch (error) {
    if (control.signal?.aborted) {
      throw control.signal.reason ?? dexDiscoveryAbortError(error);
    }
    if (
      deadlineExpired ||
      (
        control.deadlineAtMs !== undefined &&
        Date.now() >= control.deadlineAtMs
      )
    ) {
      throw dexDiscoveryDeadlineError(control.deadlineAtMs!, error);
    }
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    detachParent();
  }
}

function validateDexDiscoveryControl(control: DexDiscoveryReadControl): void {
  if (
    control.deadlineAtMs !== undefined &&
    !Number.isFinite(control.deadlineAtMs)
  ) {
    throw new Error(
      `invalid DEX discovery deadline ${String(control.deadlineAtMs)}`,
    );
  }
}

export function hasDexDiscoveryControl(
  control: DexDiscoveryReadControl | undefined,
): boolean {
  return control?.deadlineAtMs !== undefined ||
    control?.signal !== undefined ||
    control?.run !== undefined;
}

export function mergeDexDiscoveryReadControls(
  parent: DexDiscoveryReadControl | undefined,
  nested: DexDiscoveryReadControl | undefined,
): DexDiscoveryReadControl {
  const signals = [parent?.signal, nested?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const deadlines = [parent?.deadlineAtMs, nested?.deadlineAtMs].filter(
    (deadline): deadline is number => deadline !== undefined,
  );
  return {
    ...(deadlines.length === 0
      ? {}
      : { deadlineAtMs: Math.min(...deadlines) }),
    ...(signals.length === 0
      ? {}
      : { signal: mergeDexDiscoverySignals(...signals) }),
    ...((parent?.run ?? nested?.run) === undefined
      ? {}
      : { run: parent?.run ?? nested?.run }),
  };
}

export function mergeDexDiscoverySignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function linkDexDiscoveryAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = (): void => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export function throwIfDexDiscoveryCancelled(
  control: DexDiscoveryReadControl | undefined,
  cause?: unknown,
): void {
  if (control?.signal?.aborted) {
    throw control.signal.reason ?? dexDiscoveryAbortError(cause);
  }
  if (
    control?.deadlineAtMs !== undefined &&
    Date.now() >= control.deadlineAtMs
  ) {
    throw dexDiscoveryDeadlineError(control.deadlineAtMs, cause);
  }
}

export function isDexDiscoveryCancellationError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return code === "ABORTED" || code === "DEADLINE_EXCEEDED";
}

function dexDiscoveryAbortError(cause?: unknown): Error {
  return Object.assign(
    new Error(
      "DEX discovery aborted",
      cause === undefined ? undefined : { cause },
    ),
    { code: "ABORTED" },
  );
}

function dexDiscoveryDeadlineError(
  deadlineAtMs: number,
  cause?: unknown,
): Error {
  return Object.assign(
    new Error(
      `DEX discovery deadline expired at ${deadlineAtMs}`,
      cause === undefined ? undefined : { cause },
    ),
    { code: "DEADLINE_EXCEEDED" },
  );
}

export function normalizeDexDiscoveryBlockTag(
  blockTag: ethers.BlockTag,
): string {
  try {
    return ethers.toQuantity(blockTag);
  } catch {
    if (blockTag === "latest") return blockTag;
    throw new Error(
      `DEX discovery requires a numeric block tag, received ${String(blockTag)}`,
    );
  }
}
