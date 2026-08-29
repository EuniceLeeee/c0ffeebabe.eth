import {
  canonicalizeWorkKey,
  type SharedSourceKey,
} from "../../../packages/shared-work/src/index.ts";
import {
  assertExactKeys,
  decodeCanonicalJson,
  decodeJson,
  encodeCanonicalJson,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  WorkScheduler,
  type CallerAuthority,
  type SchedulerError,
  monotonicNow,
} from "../../../packages/scheduler/src/index.ts";

export interface DiscoveryProviderRef {
  readonly provider: string;
  readonly backendEpoch: string;
}

export type DiscoverySource = SharedSourceKey;

export interface DiscoveryTransportRequest {
  readonly requestId: string;
  readonly provider: DiscoveryProviderRef;
  readonly source: DiscoverySource;
  readonly method: string;
  readonly params: unknown;
  readonly requestCodec: string;
  readonly target: unknown;
  readonly manager: unknown;
  readonly topic: unknown;
  readonly lookback: unknown;
  readonly chunk: unknown;
  readonly phase: string;
  readonly workClassRef: string;
  readonly ownerRef: string;
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
}

export interface UnderlyingRpcRequest {
  readonly requestId: string;
  readonly provider: DiscoveryProviderRef;
  readonly source: DiscoverySource;
  readonly method: string;
  readonly params: unknown;
  readonly requestCodec: string;
  readonly target: unknown;
  readonly manager: unknown;
  readonly topic: unknown;
  readonly lookback: unknown;
  readonly chunk: unknown;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export interface DiscoveryTransportPort {
  request<T>(input: UnderlyingRpcRequest): Promise<T>;
}

export interface HttpJsonRpcDiscoveryPortOptions {
  readonly endpoint: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable HTTP only; response interpretation remains fixed here. */
  readonly fetch?: typeof globalThis.fetch;
}

export class HttpJsonRpcDiscoveryError extends Error {
  readonly code: "http" | "rpc" | "malformed-response";

  constructor(code: "http" | "rpc" | "malformed-response", message: string) {
    super(message);
    this.name = "HttpJsonRpcDiscoveryError";
    this.code = code;
  }
}

function endpointUrl(value: string | URL): string {
  let endpoint: URL;
  try {
    endpoint = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new TypeError("discovery RPC endpoint must be a URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("discovery RPC endpoint must use HTTP(S)");
  }
  return endpoint.href;
}

/**
 * The only network-aware discovery edge.  It emits the exact JSON-RPC
 * result value and owns no SourcePlan, Family, admission or evidence logic.
 */
export class HttpJsonRpcDiscoveryPort implements DiscoveryTransportPort {
  private readonly endpoint: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: HttpJsonRpcDiscoveryPortOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("HTTP discovery options are required");
    this.endpoint = endpointUrl(options.endpoint);
    this.headers = Object.freeze({ ...options.headers });
    for (const [key, value] of Object.entries(this.headers)) {
      if (typeof value !== "string") throw new TypeError(`headers.${key} must be a string`);
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") throw new TypeError("global fetch is required");
  }

  async request<T>(input: UnderlyingRpcRequest): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...this.headers,
      },
      body: encodeCanonicalJson({
        jsonrpc: "2.0",
        id: input.requestId,
        method: input.method,
        params: input.params,
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new HttpJsonRpcDiscoveryError("http", `discovery RPC returned HTTP ${response.status}`);
    }
    let decoded: unknown;
    try {
      decoded = decodeJson(await response.text());
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new TypeError("response must be an object");
      }
      const record = decoded as Record<string, unknown>;
      if (record.jsonrpc !== "2.0" || record.id !== input.requestId) {
        throw new TypeError("JSON-RPC response identity mismatch");
      }
      if (Object.prototype.hasOwnProperty.call(record, "result")) {
        assertExactKeys(record, ["jsonrpc", "id", "result"], "discoveryRpc.response");
        return record.result as T;
      }
      assertExactKeys(record, ["jsonrpc", "id", "error"], "discoveryRpc.response");
      if (record.error === null || typeof record.error !== "object" || Array.isArray(record.error)) {
        throw new TypeError("JSON-RPC error must be an object");
      }
      const error = record.error as Record<string, unknown>;
      assertExactKeys(
        error,
        Object.prototype.hasOwnProperty.call(error, "data") ? ["code", "message", "data"] : ["code", "message"],
        "discoveryRpc.response.error",
      );
      if (typeof error.code !== "number" || !Number.isInteger(error.code) || typeof error.message !== "string") {
        throw new TypeError("JSON-RPC error fields are invalid");
      }
      throw new HttpJsonRpcDiscoveryError("rpc", `JSON-RPC ${error.code}: ${error.message}`);
    } catch (error) {
      if (error instanceof HttpJsonRpcDiscoveryError) throw error;
      throw new HttpJsonRpcDiscoveryError(
        "malformed-response",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export const createHttpJsonRpcDiscoveryPort = (
  options: HttpJsonRpcDiscoveryPortOptions,
): HttpJsonRpcDiscoveryPort => new HttpJsonRpcDiscoveryPort(options);

export type DiscoveryTransportFailureCode =
  | "abort"
  | "deadline"
  | "queue-full"
  | "resource-limit"
  | "transport-error"
  | "source-stale";

export class DiscoveryTransportError extends Error {
  readonly code: DiscoveryTransportFailureCode;
  readonly retryClass = "retryable" as const;
  readonly requestId: string;
  readonly workKeyHash: string;
  readonly physicalSettled: boolean;

  constructor(input: {
    readonly code: DiscoveryTransportFailureCode;
    readonly requestId: string;
    readonly workKeyHash: string;
    readonly message: string;
    readonly physicalSettled: boolean;
  }) {
    super(input.message);
    this.name = "DiscoveryTransportError";
    this.code = input.code;
    this.requestId = input.requestId;
    this.workKeyHash = input.workKeyHash;
    this.physicalSettled = input.physicalSettled;
  }
}

export interface DiscoveryTransportReceipt {
  readonly requestId: string;
  readonly workKeyHash: string;
  readonly provider: DiscoveryProviderRef;
  readonly source: DiscoverySource;
  readonly startedAtMs: number;
  readonly logicalFinishedAtMs: number;
  readonly physicalSettledAtMs: number | null;
  readonly outcome: "resolved" | "unresolved";
  readonly failureCode: DiscoveryTransportFailureCode | null;
  readonly schedulerPermitId: string | null;
}

export interface DiscoveryTransportResult<T> {
  readonly value: T;
  readonly receipt: DiscoveryTransportReceipt;
}

export interface DiscoveryTransportOptions {
  readonly scheduler: WorkScheduler;
  readonly caller: CallerAuthority;
  readonly port: DiscoveryTransportPort;
  readonly clock?: () => number;
  readonly defaultTimeoutMs?: number;
}

function assertSource(source: DiscoverySource): void {
  if (
    !source ||
    typeof source.chainId !== "string" ||
    source.chainId.length === 0 ||
    typeof source.number !== "string" ||
    source.number.length === 0 ||
    typeof source.hash !== "string" ||
    source.hash.length === 0 ||
    typeof source.stateRoot !== "string" ||
    source.stateRoot.length === 0
  ) {
    throw new TypeError("discovery source is incomplete");
  }
}

function keyFor(input: DiscoveryTransportRequest) {
  return canonicalizeWorkKey({
    ownerRef: input.ownerRef,
    provider: input.provider,
    source: input.source,
    capabilityFingerprint: input.requestCodec,
    target: input.target,
    request: {
      requestCodec: input.requestCodec,
      manager: input.manager,
      topic: input.topic,
      lookback: input.lookback,
      chunk: input.chunk,
      method: input.method,
      params: input.params,
    },
    method: input.method,
    params: input.params,
  });
}

function canonicalEnvelope(
  input: DiscoveryTransportRequest,
): DiscoveryTransportRequest {
  const allowed = new Set([
    "requestId",
    "provider",
    "source",
    "method",
    "params",
    "requestCodec",
    "target",
    "manager",
    "topic",
    "lookback",
    "chunk",
    "phase",
    "workClassRef",
    "ownerRef",
    "deadlineAtMs",
    "signal",
  ]);
  for (const key of Reflect.ownKeys(input as object)) {
    if (typeof key !== "string" || !allowed.has(key))
      throw new TypeError(`unknown discovery envelope field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(input as object, key);
    if (!descriptor || !("value" in descriptor))
      throw new TypeError(
        `discovery envelope field ${key} must be a data property`,
      );
  }
  const required = [
    "requestId",
    "provider",
    "source",
    "method",
    "params",
    "requestCodec",
    "target",
    "manager",
    "topic",
    "lookback",
    "chunk",
    "phase",
    "workClassRef",
    "ownerRef",
  ] as const;
  for (const field of required)
    if (
      !Object.prototype.hasOwnProperty.call(input, field) ||
      (input as unknown as Record<string, unknown>)[field] === undefined
    )
      throw new TypeError(`discovery envelope missing ${field}`);
  for (const field of ["deadlineAtMs", "signal"] as const)
    if (
      Object.prototype.hasOwnProperty.call(input, field) &&
      input[field] === undefined
    )
      throw new TypeError(
        `discovery envelope field ${field} must be omitted rather than undefined`,
      );
  const canonical = decodeCanonicalJson(
    encodeCanonicalJson({
      requestId: input.requestId,
      provider: input.provider,
      source: input.source,
      method: input.method,
      params: input.params,
      requestCodec: input.requestCodec,
      target: input.target,
      manager: input.manager,
      topic: input.topic,
      lookback: input.lookback,
      chunk: input.chunk,
      phase: input.phase,
      workClassRef: input.workClassRef,
      ownerRef: input.ownerRef,
      ...(input.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: input.deadlineAtMs }),
    }),
  );
  return Object.freeze({
    ...(canonical as unknown as Record<string, unknown>),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }) as DiscoveryTransportRequest;
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    const onAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      listeners.push(() => signal.removeEventListener("abort", onAbort));
    }
  }
  return Object.freeze({
    signal: controller.signal,
    dispose: () => listeners.forEach((dispose) => dispose()),
  });
}

function schedulerErrorCode(error: unknown): DiscoveryTransportFailureCode {
  const code = error as Partial<SchedulerError>;
  if (code.code === "queue-full" || code.code === "resource-limit")
    return code.code;
  if (code.code === "deadline") return "deadline";
  if (code.code === "aborted") return "abort";
  return "transport-error";
}

/**
 * Public abortable RPC port.  It owns only physical request lifecycle; source
 * completeness, cursors, identity, and candidate admission remain outside.
 */
export class DiscoveryTransport {
  private readonly scheduler: WorkScheduler;
  private readonly caller: CallerAuthority;
  private readonly port: DiscoveryTransportPort;
  private readonly clock: () => number;
  private readonly defaultTimeoutMs: number;

  constructor(options: DiscoveryTransportOptions) {
    if (!options.scheduler || typeof options.scheduler.run !== "function")
      throw new TypeError("discovery scheduler is required");
    if (
      !options.caller ||
      typeof options.caller.callerId !== "string" ||
      options.caller.callerId.length === 0 ||
      typeof options.caller.authorityToken !== "string" ||
      options.caller.authorityToken.length === 0
    )
      throw new TypeError("discovery caller authority is required");
    if (!options.port || typeof options.port.request !== "function")
      throw new TypeError("discovery transport port is required");
    this.scheduler = options.scheduler;
    this.caller = Object.freeze({ ...options.caller });
    this.port = options.port;
    this.clock = options.clock ?? monotonicNow;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0)
      throw new TypeError("defaultTimeoutMs must be positive");
    issuedDiscoveryTransports.add(this);
  }

  async request<T>(input: DiscoveryTransportRequest): Promise<T> {
    const result = await this.requestWithReceipt<T>(input);
    return result.value;
  }

  async requestWithReceipt<T>(
    input: DiscoveryTransportRequest,
  ): Promise<DiscoveryTransportResult<T>> {
    input = canonicalEnvelope(input);
    assertSource(input.source);
    assertExactKeys(input.source, ["chainId", "number", "hash", "stateRoot"]);
    assertExactKeys(input.provider, ["provider", "backendEpoch"]);
    if (typeof input.requestId !== "string" || input.requestId.length === 0)
      throw new TypeError("requestId must be non-empty");
    if (
      typeof input.provider.provider !== "string" ||
      input.provider.provider.length === 0 ||
      typeof input.provider.backendEpoch !== "string" ||
      input.provider.backendEpoch.length === 0
    )
      throw new TypeError("provider identity is incomplete");
    if (typeof input.method !== "string" || input.method.length === 0)
      throw new TypeError("method must be non-empty");
    if (
      typeof input.requestCodec !== "string" ||
      input.requestCodec.length === 0 ||
      typeof input.phase !== "string" ||
      input.phase.length === 0 ||
      typeof input.workClassRef !== "string" ||
      input.workClassRef.length === 0 ||
      typeof input.ownerRef !== "string" ||
      input.ownerRef.length === 0
    )
      throw new TypeError("discovery envelope authority fields are incomplete");
    const key = keyFor(input);
    const startedAtMs = this.clock();
    const deadlineAtMs =
      input.deadlineAtMs ?? startedAtMs + this.defaultTimeoutMs;
    if (!Number.isFinite(deadlineAtMs))
      throw new TypeError("deadlineAtMs must be finite");
    const physicalController = new AbortController();
    const combined = combineSignals([input.signal, physicalController.signal]);
    let schedulerPermitId: string | null = null;
    let physicalSettledAtMs: number | null = null;
    let physicalSettled = false;
    let logicalDone = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectLogical!: (reason?: unknown) => void;
    let resolveLogical!: (value: T) => void;
    const logical = new Promise<T>((resolve, reject) => {
      resolveLogical = resolve;
      rejectLogical = reject;
    });
    const failLogical = (
      code: DiscoveryTransportFailureCode,
      error?: unknown,
    ): void => {
      if (logicalDone) return;
      logicalDone = true;
      const message =
        error instanceof Error
          ? error.message
          : code === "deadline"
            ? "discovery request deadline elapsed"
            : code === "abort"
              ? "discovery request aborted"
              : "discovery request failed";
      rejectLogical(
        new DiscoveryTransportError({
          code,
          requestId: input.requestId,
          workKeyHash: key.hash,
          message,
          physicalSettled,
        }),
      );
    };
    const onAbort = (): void => {
      if (!logicalDone) {
        const code: DiscoveryTransportFailureCode = input.signal?.aborted
          ? "abort"
          : "deadline";
        failLogical(code, input.signal?.reason);
      }
      if (!physicalController.signal.aborted)
        physicalController.abort(input.signal?.reason ?? "logical-cancel");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(
      () => {
        failLogical("deadline");
        if (!physicalController.signal.aborted)
          physicalController.abort("deadline");
      },
      Math.max(0, deadlineAtMs - this.clock()),
    );
    const workId = key.hash;
    const work = {
      workId,
      phase: input.phase,
      workClassRef: input.workClassRef,
      ownerRef: input.ownerRef,
      lane: "startup-RPC-fast" as const,
      resource: "rpc" as const,
      deadlineAtMs,
      signal: input.signal,
    };
    const physical = this.scheduler.run<T>({
      work,
      caller: this.caller,
      execute: async (permit) => {
        schedulerPermitId = permit.permitId;
        const permitSignals = combineSignals([combined.signal, permit.signal]);
        try {
          return await this.port.request<T>({
            requestId: input.requestId,
            provider: Object.freeze({ ...input.provider }),
            source: Object.freeze({ ...input.source }),
            method: input.method,
            params: input.params,
            requestCodec: input.requestCodec,
            target: input.target,
            manager: input.manager,
            topic: input.topic,
            lookback: input.lookback,
            chunk: input.chunk,
            deadlineAtMs,
            signal: permitSignals.signal,
          });
        } finally {
          permitSignals.dispose();
        }
      },
    });
    physical.then(
      (value) => {
        physicalSettled = true;
        physicalSettledAtMs = this.clock();
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        input.signal?.removeEventListener("abort", onAbort);
        combined.dispose();
        if (!logicalDone) {
          logicalDone = true;
          resolveLogical(value);
        }
      },
      (error: unknown) => {
        physicalSettled = true;
        physicalSettledAtMs = this.clock();
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        input.signal?.removeEventListener("abort", onAbort);
        combined.dispose();
        if (!logicalDone) failLogical(schedulerErrorCode(error), error);
      },
    );
    // The physical promise is observed above.  Do not await it here: logical
    // cancellation may return before the socket actually settles, while the
    // scheduler permit remains held until `physical` settles.
    return logical.then(
      (value) =>
        Object.freeze({
          value,
          receipt: Object.freeze({
            requestId: input.requestId,
            workKeyHash: key.hash,
            provider: Object.freeze({ ...input.provider }),
            source: Object.freeze({ ...input.source }),
            startedAtMs,
            logicalFinishedAtMs: this.clock(),
            physicalSettledAtMs,
            outcome: "resolved" as const,
            failureCode: null,
            schedulerPermitId,
          }),
        }),
      (error: unknown) => {
        throw error;
      },
    );
  }
}

const issuedDiscoveryTransports = new WeakSet<object>();

export function assertIssuedDiscoveryTransport(
  value: unknown,
): asserts value is DiscoveryTransport {
  if (value === null || typeof value !== "object" || !issuedDiscoveryTransports.has(value)) {
    throw new TypeError("discovery transport is not owner-issued");
  }
}

export const createDiscoveryTransport = (
  options: DiscoveryTransportOptions,
): DiscoveryTransport => new DiscoveryTransport(options);
export const AbortableRpcTransport = DiscoveryTransport;
export const createAbortableRpcTransport = createDiscoveryTransport;
