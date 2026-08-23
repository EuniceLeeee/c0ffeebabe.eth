import {
  SharedWorkCache,
  canonicalizeWorkKey,
  consumerLease,
  type ConsumerLease,
  type SharedProviderKey,
  type SharedSourceKey,
} from "../../../packages/shared-work/src/index.ts";
import {
  assertExactKeys,
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
} from "../../../packages/canonical-codec/src/index.ts";
import { monotonicNow } from "../../../packages/scheduler/src/index.ts";

export type StateSource = SharedSourceKey;
export type StateProvider = SharedProviderKey;

export interface StateReadRequest {
  readonly requestId: string;
  readonly ownerRef: string;
  readonly provider: StateProvider;
  readonly source: StateSource;
  readonly target: unknown;
  readonly calldata?: unknown;
  readonly storageKey?: unknown;
  readonly requestCodec: string;
  readonly instanceRef: unknown;
  readonly stateSchema: string;
  readonly interpreterFingerprint: string;
  readonly parameters?: unknown;
  readonly window?: unknown;
  readonly lookback?: unknown;
  readonly chunk?: unknown;
  readonly callerMode?: "top-level" | "impersonated-call-frame";
  readonly observeAccounts?: readonly unknown[];
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
}

export interface StateReadBackendInput {
  readonly request: StateReadRequest;
  readonly signal: AbortSignal;
}

export interface StateReadBackendResult<Raw> {
  readonly source: StateSource;
  readonly raw: Raw;
  readonly backendReceipt?: unknown;
}

export interface StateReadBackend<Raw> {
  read(input: StateReadBackendInput): Promise<StateReadBackendResult<Raw>>;
  readBatch?(input: {
    readonly requests: readonly StateReadRequest[];
    readonly signal: AbortSignal;
  }): Promise<readonly StateReadBackendResult<Raw>[]>;
}

export interface StateFact<Raw> {
  readonly kind: "state-fact";
  readonly keyHash: string;
  readonly provider: StateProvider;
  readonly source: StateSource;
  readonly requestId: string;
  readonly raw: Raw;
  readonly backendReceipt: unknown | null;
}

export type StateRuntimeFailureCode =
  | "abort"
  | "deadline"
  | "transport-error"
  | "source-stale"
  | "invalid-request"
  | "resource-limit";

export class StateRuntimeError extends Error {
  readonly code: StateRuntimeFailureCode;
  readonly retryClass: "retryable" | "invalid-program";
  readonly requestId: string;
  readonly keyHash: string;

  constructor(input: {
    readonly code: StateRuntimeFailureCode;
    readonly requestId: string;
    readonly keyHash: string;
    readonly message: string;
  }) {
    super(input.message);
    this.name = "StateRuntimeError";
    this.code = input.code;
    this.retryClass =
      input.code === "invalid-request" ? "invalid-program" : "retryable";
    this.requestId = input.requestId;
    this.keyHash = input.keyHash;
  }
}

export interface StateRuntimeOptions<Raw> {
  readonly backend: StateReadBackend<Raw>;
  readonly cache?: SharedWorkCache<
    StateReadRequest,
    StateReadBackendResult<Raw>
  >;
  readonly clock?: () => number;
  readonly sourceFence: (source: StateSource) => void;
}

export interface StateReadUnresolved {
  readonly kind: "unresolved";
  readonly failure: StateRuntimeError;
  readonly keyHash: string;
  readonly source: StateSource;
}

function sourceEqual(
  left: StateSource | undefined,
  right: StateSource | undefined,
): boolean {
  return (
    Boolean(left && right) &&
    left!.chainId === right!.chainId &&
    left!.number === right!.number &&
    left!.hash === right!.hash &&
    left!.stateRoot === right!.stateRoot
  );
}

function sourceCopy(source: StateSource): StateSource {
  assertExactKeys(source, ["chainId", "number", "hash", "stateRoot"]);
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
    throw new TypeError("state source is incomplete");
  }
  return Object.freeze({ ...source });
}

function requestIdOf(value: unknown): string {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { requestId?: unknown }).requestId === "string"
    ? (value as { requestId: string }).requestId
    : "invalid";
}

function invalidRequest(request: unknown, error: unknown): StateRuntimeError {
  return new StateRuntimeError({
    code: "invalid-request",
    requestId: requestIdOf(request),
    keyHash: "invalid",
    message: error instanceof Error ? error.message : String(error),
  });
}

const STATE_REQUEST_KEYS = [
  "requestId",
  "ownerRef",
  "provider",
  "source",
  "target",
  "calldata",
  "storageKey",
  "requestCodec",
  "instanceRef",
  "stateSchema",
  "interpreterFingerprint",
  "parameters",
  "window",
  "lookback",
  "chunk",
  "callerMode",
  "observeAccounts",
  "deadlineAtMs",
  "signal",
] as const;

function assertAllowedKeys(value: unknown, keys: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("state request must be an object");
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key))
      throw new TypeError(`unknown state request field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError(
        `state request field ${key} must be an enumerable data property`,
      );
  }
}

function assertRequestEnvelope(request: StateReadRequest): void {
  try {
    assertAllowedKeys(request, STATE_REQUEST_KEYS);
    for (const field of [
      "requestId",
      "ownerRef",
      "provider",
      "source",
      "target",
      "requestCodec",
      "instanceRef",
      "stateSchema",
      "interpreterFingerprint",
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(request, field))
        throw new TypeError(`${field} is required`);
    }
    if (typeof request.requestId !== "string" || request.requestId.length === 0)
      throw new TypeError("requestId must be non-empty");
    if (typeof request.ownerRef !== "string" || request.ownerRef.length === 0)
      throw new TypeError("ownerRef must be non-empty");
    assertExactKeys(request.provider, ["provider", "backendEpoch"]);
    if (
      typeof request.provider.provider !== "string" ||
      request.provider.provider.length === 0 ||
      typeof request.provider.backendEpoch !== "string" ||
      request.provider.backendEpoch.length === 0
    )
      throw new TypeError("provider identity is incomplete");
    assertExactKeys(request.source, ["chainId", "number", "hash", "stateRoot"]);
    sourceCopy(request.source);
    if (
      typeof request.requestCodec !== "string" ||
      request.requestCodec.length === 0 ||
      typeof request.stateSchema !== "string" ||
      request.stateSchema.length === 0 ||
      typeof request.interpreterFingerprint !== "string" ||
      request.interpreterFingerprint.length === 0
    )
      throw new TypeError(
        "state request codec/schema/fingerprint is incomplete",
      );
    for (const field of ["target", "instanceRef"] as const) {
      if (
        !Object.prototype.hasOwnProperty.call(request, field) ||
        request[field] === undefined
      )
        throw new TypeError(`${field} is required`);
    }
    for (const field of [
      "calldata",
      "storageKey",
      "parameters",
      "window",
      "lookback",
      "chunk",
      "callerMode",
      "observeAccounts",
      "deadlineAtMs",
    ] as const) {
      if (
        Object.prototype.hasOwnProperty.call(request, field) &&
        request[field] === undefined
      )
        throw new TypeError(`${field} must be omitted rather than undefined`);
    }
    if (
      request.callerMode !== undefined &&
      request.callerMode !== "top-level" &&
      request.callerMode !== "impersonated-call-frame"
    )
      throw new TypeError("callerMode is unsupported");
    if (
      request.observeAccounts !== undefined &&
      !Array.isArray(request.observeAccounts)
    )
      throw new TypeError("observeAccounts must be an array");
    if (
      request.deadlineAtMs !== undefined &&
      !Number.isFinite(request.deadlineAtMs)
    )
      throw new TypeError("deadlineAtMs must be finite");
    // Validate every semantic value through the canonical codec.  `signal` is
    // an out-of-band control object and is deliberately excluded.
    encodeCanonicalJson(requestSemanticEnvelope(request));
  } catch (error) {
    if (error instanceof StateRuntimeError) throw error;
    throw invalidRequest(request, error);
  }
}

function requestSemanticEnvelope(
  request: StateReadRequest,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    requestId: request.requestId,
    ownerRef: request.ownerRef,
    provider: request.provider,
    source: request.source,
    target: request.target,
    requestCodec: request.requestCodec,
    instanceRef: request.instanceRef,
    stateSchema: request.stateSchema,
    interpreterFingerprint: request.interpreterFingerprint,
  };
  for (const field of [
    "calldata",
    "storageKey",
    "parameters",
    "window",
    "lookback",
    "chunk",
    "callerMode",
    "observeAccounts",
    "deadlineAtMs",
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(request, field))
      result[field] = request[field];
  }
  return result;
}

function normalizeRequest(request: StateReadRequest): StateReadRequest {
  assertRequestEnvelope(request);
  try {
    const canonical = decodeCanonicalJson(
      encodeCanonicalJson(requestSemanticEnvelope(request)),
    ) as Record<string, unknown>;
    return Object.freeze({
      ...canonical,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }) as StateReadRequest;
  } catch (error) {
    throw invalidRequest(request, error);
  }
}

function keyFor(request: StateReadRequest) {
  // Every field is retained, including provider epoch, all source anchors,
  // optional calldata/storage parameters, caller mode and observation scope.
  return canonicalizeWorkKey({
    ownerRef: request.ownerRef,
    provider: request.provider,
    source: request.source,
    capabilityFingerprint: hashDomain("aloha/state-read-capability/v1", {
      requestCodec: request.requestCodec,
      stateSchema: request.stateSchema,
      interpreterFingerprint: request.interpreterFingerprint,
    }),
    target: request.target,
    request: {
      calldata:
        request.calldata === undefined
          ? { present: false }
          : { present: true, value: request.calldata },
      storageKey:
        request.storageKey === undefined
          ? { present: false }
          : { present: true, value: request.storageKey },
      requestCodec: request.requestCodec,
      instanceRef: request.instanceRef,
      stateSchema: request.stateSchema,
      interpreterFingerprint: request.interpreterFingerprint,
      parameters:
        request.parameters === undefined
          ? { present: false }
          : { present: true, value: request.parameters },
      window:
        request.window === undefined
          ? { present: false }
          : { present: true, value: request.window },
      lookback:
        request.lookback === undefined
          ? { present: false }
          : { present: true, value: request.lookback },
      chunk:
        request.chunk === undefined
          ? { present: false }
          : { present: true, value: request.chunk },
      callerMode:
        request.callerMode === undefined
          ? { present: false }
          : { present: true, value: request.callerMode },
      observeAccounts:
        request.observeAccounts === undefined
          ? { present: false }
          : { present: true, value: request.observeAccounts },
    },
    calldata:
      request.calldata === undefined
        ? { present: false }
        : { present: true, value: request.calldata },
    storageKey:
      request.storageKey === undefined
        ? { present: false }
        : { present: true, value: request.storageKey },
    requestCodec: request.requestCodec,
    instanceRef: request.instanceRef,
    stateSchema: request.stateSchema,
    interpreterFingerprint: request.interpreterFingerprint,
    parameters:
      request.parameters === undefined
        ? { present: false }
        : { present: true, value: request.parameters },
    window:
      request.window === undefined
        ? { present: false }
        : { present: true, value: request.window },
    lookback:
      request.lookback === undefined
        ? { present: false }
        : { present: true, value: request.lookback },
    chunk:
      request.chunk === undefined
        ? { present: false }
        : { present: true, value: request.chunk },
    callerMode:
      request.callerMode === undefined
        ? { present: false }
        : { present: true, value: request.callerMode },
    observeAccounts:
      request.observeAccounts === undefined
        ? { present: false }
        : { present: true, value: request.observeAccounts },
  });
}

function errorCode(error: unknown): StateRuntimeFailureCode {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (
    code === "abort" ||
    code === "deadline" ||
    code === "transport-error" ||
    code === "source-stale" ||
    code === "resource-limit"
  )
    return code;
  if (error instanceof DOMException && error.name === "AbortError")
    return "abort";
  return "transport-error";
}

function assertSourceFence(
  fence: (source: StateSource) => void,
  source: StateSource,
  requestId: string,
  keyHash: string,
): void {
  try {
    fence(source);
  } catch (error) {
    throw new StateRuntimeError({
      code: "source-stale",
      requestId,
      keyHash,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Source-bound raw state acquisition.  No protocol storage or quote math lives here. */
export class StateRuntime<Raw> {
  private readonly backend: StateReadBackend<Raw>;
  private readonly cache: SharedWorkCache<
    StateReadRequest,
    StateReadBackendResult<Raw>
  >;
  private readonly clock: () => number;
  private readonly sourceFence: (source: StateSource) => void;

  constructor(options: StateRuntimeOptions<Raw>) {
    if (!options.backend || typeof options.backend.read !== "function")
      throw new TypeError("state backend is required");
    if (typeof options.sourceFence !== "function")
      throw new TypeError("state source fence is required");
    this.backend = options.backend;
    this.clock = options.clock ?? monotonicNow;
    this.sourceFence = options.sourceFence;
    this.cache =
      options.cache ??
      new SharedWorkCache<StateReadRequest, StateReadBackendResult<Raw>>({
        key: (request) => keyFor(request),
        validity: (value, request) => sourceEqual(value.source, request.source),
        clock: this.clock,
      });
  }

  key(request: StateReadRequest): string {
    return keyFor(normalizeRequest(request)).hash;
  }

  async read(
    request: StateReadRequest,
    consumer?: ConsumerLease,
  ): Promise<StateFact<Raw>> {
    const normalized = normalizeRequest(request);
    const source = sourceCopy(normalized.source);
    let key: ReturnType<typeof keyFor>;
    try {
      key = keyFor(normalized);
    } catch (error) {
      throw invalidRequest(normalized, error);
    }
    assertSourceFence(this.sourceFence, source, normalized.requestId, key.hash);
    const lease =
      consumer ??
      consumerLease(normalized.requestId, {
        deadlineAtMs: normalized.deadlineAtMs,
        signal: normalized.signal,
      });
    try {
      const result = await this.cache.getOrBuild(
        normalized,
        lease,
        async (signal) => {
          const backendResult = await this.backend.read({
            request: Object.freeze({ ...normalized, source }),
            signal,
          });
          try {
            sourceCopy(backendResult?.source);
          } catch (error) {
            throw new StateRuntimeError({
              code: "source-stale",
              requestId: normalized.requestId,
              keyHash: key.hash,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          if (!backendResult || !sourceEqual(backendResult.source, source)) {
            throw new StateRuntimeError({
              code: "source-stale",
              requestId: normalized.requestId,
              keyHash: key.hash,
              message: "state backend returned a different source",
            });
          }
          return Object.freeze({
            source,
            raw: backendResult.raw,
            ...(backendResult.backendReceipt === undefined
              ? {}
              : { backendReceipt: backendResult.backendReceipt }),
          });
        },
      );
      // Validate again after a settled-cache hit; current source is never
      // inferred from a previous head or a pinned fallback.
      if (!sourceEqual(result.source, source)) {
        throw new StateRuntimeError({
          code: "source-stale",
          requestId: normalized.requestId,
          keyHash: key.hash,
          message: "cached state fact is not bound to current source",
        });
      }
      if (normalized.signal?.aborted)
        throw new StateRuntimeError({
          code: "abort",
          requestId: normalized.requestId,
          keyHash: key.hash,
          message: "state consumer aborted before publication",
        });
      assertSourceFence(
        this.sourceFence,
        source,
        normalized.requestId,
        key.hash,
      );
      return Object.freeze({
        kind: "state-fact",
        keyHash: key.hash,
        provider: Object.freeze({ ...normalized.provider }),
        source,
        requestId: normalized.requestId,
        raw: result.raw,
        backendReceipt: result.backendReceipt ?? null,
      });
    } catch (error) {
      if (error instanceof StateRuntimeError) throw error;
      const code = errorCode(error);
      throw new StateRuntimeError({
        code,
        requestId: normalized.requestId,
        keyHash: key.hash,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async readDecoded<Fact>(
    request: StateReadRequest,
    decode: (input: StateFact<Raw>) => Fact,
    consumer?: ConsumerLease,
  ): Promise<Fact> {
    return decode(await this.read(request, consumer));
  }

  async readOutcome(
    request: StateReadRequest,
    consumer?: ConsumerLease,
  ): Promise<StateFact<Raw> | StateReadUnresolved> {
    try {
      return await this.read(request, consumer);
    } catch (error) {
      if (error instanceof StateRuntimeError) {
        let source: StateSource;
        try {
          source = sourceCopy(request.source);
        } catch {
          source = Object.freeze({
            chainId: "",
            number: "",
            hash: "",
            stateRoot: "",
          });
        }
        return Object.freeze({
          kind: "unresolved",
          failure: error,
          keyHash: error.keyHash,
          source,
        });
      }
      throw error;
    }
  }

  async readBatch(
    requests: readonly StateReadRequest[],
    consumerPrefix = "batch",
  ): Promise<readonly StateFact<Raw>[]> {
    const normalized = requests.map((request) => normalizeRequest(request));
    for (const request of normalized) {
      const key = keyFor(request);
      assertSourceFence(
        this.sourceFence,
        sourceCopy(request.source),
        request.requestId,
        key.hash,
      );
    }
    const consumers = normalized.map((request, index) => ({
      key: request,
      consumer: consumerLease(`${consumerPrefix}:${index}`, {
        deadlineAtMs: request.deadlineAtMs,
        signal: request.signal,
      }),
    }));
    let results: readonly StateReadBackendResult<Raw>[];
    try {
      results = await this.cache.getOrBuildBatch(
        consumers,
        async ({ keys, signal }) => {
          const built =
            this.backend.readBatch && keys.length > 1
              ? await this.backend.readBatch({ requests: keys, signal })
              : await Promise.all(
                  keys.map((request) =>
                    this.backend.read({
                      request: Object.freeze({
                        ...request,
                        source: sourceCopy(request.source),
                      }),
                      signal,
                    }),
                  ),
                );
          if (built.length !== keys.length)
            throw new StateRuntimeError({
              code: "transport-error",
              requestId: "batch",
              keyHash: "batch",
              message: "state batch result count mismatch",
            });
          for (let index = 0; index < keys.length; index += 1) {
            try {
              sourceCopy(built[index]?.source);
            } catch (error) {
              throw new StateRuntimeError({
                code: "source-stale",
                requestId: keys[index].requestId,
                keyHash: keyFor(keys[index]).hash,
                message: error instanceof Error ? error.message : String(error),
              });
            }
            if (
              !built[index] ||
              !sourceEqual(built[index].source, keys[index].source)
            )
              throw new StateRuntimeError({
                code: "source-stale",
                requestId: keys[index].requestId,
                keyHash: keyFor(keys[index]).hash,
                message: "state batch returned a different source",
              });
          }
          return built;
        },
      );
    } catch (error) {
      if (error instanceof StateRuntimeError) throw error;
      const code =
        error instanceof Error &&
        "code" in error &&
        (error as { code?: unknown }).code === "deadline"
          ? "deadline"
          : error instanceof Error &&
              "code" in error &&
              (error as { code?: unknown }).code === "abort"
            ? "abort"
            : "transport-error";
      throw new StateRuntimeError({
        code,
        requestId: normalized[0]?.requestId ?? "batch",
        keyHash: normalized[0] ? keyFor(normalized[0]).hash : "batch",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return normalized.map((request, index) => {
      const result = results[index];
      const key = keyFor(request);
      if (!result)
        throw new StateRuntimeError({
          code: "transport-error",
          requestId: request.requestId,
          keyHash: key.hash,
          message: "state batch omitted a key",
        });
      const source = sourceCopy(request.source);
      if (!sourceEqual(result.source, source))
        throw new StateRuntimeError({
          code: "source-stale",
          requestId: request.requestId,
          keyHash: key.hash,
          message: "cached state fact is not bound to current source",
        });
      if (request.signal?.aborted)
        throw new StateRuntimeError({
          code: "abort",
          requestId: request.requestId,
          keyHash: key.hash,
          message: "state consumer aborted before publication",
        });
      // A batch can settle after a reorg; every logical consumer gets its own
      // final fence check before a fact becomes observable.
      assertSourceFence(this.sourceFence, source, request.requestId, key.hash);
      return Object.freeze({
        kind: "state-fact" as const,
        keyHash: key.hash,
        provider: Object.freeze({ ...request.provider }),
        source,
        requestId: request.requestId,
        raw: result.raw,
        backendReceipt: result.backendReceipt ?? null,
      });
    });
  }

  snapshot() {
    return this.cache.snapshot();
  }
}

export const createStateRuntime = <Raw>(
  options: StateRuntimeOptions<Raw>,
): StateRuntime<Raw> => new StateRuntime(options);
export const SourceBoundStateRuntime = StateRuntime;
