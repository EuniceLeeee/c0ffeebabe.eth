import { ethers, type JsonRpcError, type JsonRpcPayload } from "ethers";
import { mergePoolProjectionRows } from "./active-pool-discovery.js";
import {
  buildTokenIndex,
  type PoolEntry,
  type TokenEdge,
} from "./planner/token-graph.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "./pool-universe.js";
import { hashTokenGraph, type StrategyViews } from "./strategy-views.js";
import { deriveEdgeTaxonomy } from "./strategy-taxonomy.js";
import {
  ProtocolDiscoveryFamilyGuard,
  type ProtocolDiscoveryFamilyGuardOptions,
  withProtocolDiscoveryFamilyContext,
} from "./protocol-discovery-family-guard.js";
import type { AttestedPoolEntry } from "./venues/identity.js";
import { attestPoolsStrictFromProvider } from "./strict-identity-attestation.js";
import type { CentralAdapterRuntime } from "./adapter-work-intent.js";
import type {
  AttestedProtocolInstance,
  ExecutionFamilyId,
  IdentityAuthority,
  ProtocolCandidate,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryReadControl,
  RouteCandidateSourceKind,
  RouteLegAdapter,
} from "./venues/route-leg-adapter.js";
import {
  bindRouteInstanceIdentity,
  edgeExecutionVariantKey,
  edgeInstanceKey,
} from "./venues/route-instance-identity.js";
import {
  validatedRouteImmutableBindingHash,
} from "./venues/route-immutable-binding.js";

export function createPinnedProtocolDiscoveryContext(input: {
  provider: ethers.JsonRpcProvider;
  /**
   * Optional fallback for a trace that the current node explicitly reports as
   * pruned. Logs, receipts, current-state reads and probes stay on `provider`.
   */
  observedHistoryProvider?: ethers.JsonRpcProvider;
  /**
   * Minimum spacing between separately queued archive trace requests. The
   * production default protects shared archive quotas; tests may lower it.
   */
  observedHistoryTraceMinIntervalMs?: number;
  blockNumber: number;
  fromBlock: number;
  toBlock?: number;
  rpcTimeoutMs?: number;
  chainId?: bigint | number | string;
  probeExecutor?: string;
  graphTokens: readonly string[];
  retainedInstances?: readonly AttestedProtocolInstance[];
  /** Parent pass lifetime; every backend operation also merges its local control. */
  control?: ProtocolDiscoveryReadControl;
}): ProtocolDiscoveryContext {
  const toBlock = input.toBlock ?? input.blockNumber;
  const observedHistoryProvider =
    input.observedHistoryProvider ?? input.provider;
  const rpcTimeoutMs = input.rpcTimeoutMs ?? Math.max(
    1_000,
    Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_RPC_TIMEOUT_MS ?? "15000"),
  );
  const observedHistoryTraceMinIntervalMs =
    input.observedHistoryTraceMinIntervalMs ??
    PROTOCOL_DISCOVERY_ARCHIVE_TRACE_MIN_INTERVAL_MS;
  if (
    !Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0 ||
    !Number.isSafeInteger(input.fromBlock) || input.fromBlock < 0 ||
    !Number.isSafeInteger(toBlock) || toBlock < input.fromBlock || toBlock > input.blockNumber ||
    !Number.isFinite(rpcTimeoutMs) || rpcTimeoutMs < 1 ||
    !Number.isFinite(observedHistoryTraceMinIntervalMs) ||
    observedHistoryTraceMinIntervalMs < 0
  ) {
    throw new Error("invalid protocol discovery block range or RPC timeout");
  }
  let observedHistoryAlignment: Promise<void> | undefined;
  let observedHistoryTraceTail = Promise.resolve();
  let observedHistoryTraceStartedAtMs = Number.NEGATIVE_INFINITY;
  const ensureObservedHistoryAligned = (
    control: ProtocolDiscoveryReadControl,
  ): Promise<void> => {
    observedHistoryAlignment ??=
      assertProtocolDiscoveryObservationProviderAligned({
        provider: input.provider,
        observedHistoryProvider,
        blockNumber: toBlock,
        rpcTimeoutMs,
        control,
      });
    return observedHistoryAlignment;
  };
  const runObservedHistoryTrace = async <T>(
    work: () => Promise<T>,
    control: ProtocolDiscoveryReadControl,
  ): Promise<T> => {
    const previous = observedHistoryTraceTail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    observedHistoryTraceTail = previous.then(
      () => turn,
      () => turn,
    );
    const deadlineAtMs = Math.min(
      Date.now() + rpcTimeoutMs,
      control.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    try {
      await waitForProtocolDiscoveryTraceTurn(
        previous,
        deadlineAtMs,
        control.signal,
        rpcTimeoutMs,
      );
      const spacingMs = Math.max(
        0,
        observedHistoryTraceStartedAtMs +
          observedHistoryTraceMinIntervalMs -
          Date.now(),
      );
      if (spacingMs > 0) {
        await protocolDiscoveryRpcDelay(
          spacingMs,
          deadlineAtMs,
          control.signal,
          "archive debug_traceTransaction queue",
          rpcTimeoutMs,
        );
      }
      observedHistoryTraceStartedAtMs = Date.now();
      return await work();
    } finally {
      release();
    }
  };
  const blockTag = ethers.toQuantity(input.blockNumber);
  return {
    blockNumber: input.blockNumber,
    fromBlock: input.fromBlock,
    toBlock,
    ...(input.chainId === undefined ? {} : { chainId: BigInt(input.chainId).toString() }),
    ...(input.probeExecutor === undefined
      ? {}
      : { probeExecutor: ethers.getAddress(input.probeExecutor) }),
    graphTokens: unique(input.graphTokens.map((token) => token.toLowerCase())),
    retainedInstances: input.retainedInstances ?? [],
    backend: {
      call: (req, control) => sendProtocolDiscoveryRpc<string>(
        input.provider,
        "eth_call",
        [input.provider.getRpcTransaction(req), blockTag],
        rpcTimeoutMs,
        "eth_call",
        mergeProtocolDiscoveryReadControls(input.control, control),
      ),
      getCode: (address, control) => sendProtocolDiscoveryRpc<string>(
        input.provider,
        "eth_getCode",
        [address, blockTag],
        rpcTimeoutMs,
        "eth_getCode",
        mergeProtocolDiscoveryReadControls(input.control, control),
      ),
      getStorageAt: (address, position, control) => sendProtocolDiscoveryRpc<string>(
        input.provider,
        "eth_getStorageAt",
        [address, ethers.toQuantity(position), blockTag],
        rpcTimeoutMs,
        "eth_getStorageAt",
        mergeProtocolDiscoveryReadControls(input.control, control),
      ),
      getLogs: async (req, control) => {
        const logs = await sendProtocolDiscoveryRpc<RawProtocolDiscoveryLog[]>(
          input.provider,
          "eth_getLogs",
          [{
            ...(req.address === undefined ? {} : { address: req.address }),
            topics: req.topics.map((topic) =>
              typeof topic === "string" || topic === null ? topic : [...topic]
            ),
            fromBlock: ethers.toQuantity(req.fromBlock),
            toBlock: ethers.toQuantity(req.toBlock),
          }],
          rpcTimeoutMs,
          "eth_getLogs",
          mergeProtocolDiscoveryReadControls(input.control, control),
        );
        return logs.map(normalizeProtocolDiscoveryLog);
      },
      getTransactionReceipt: async (txHash, control) => {
        const receipt = await sendProtocolDiscoveryRpc<RawProtocolDiscoveryReceipt | null>(
          input.provider,
          "eth_getTransactionReceipt",
          [txHash],
          rpcTimeoutMs,
          "eth_getTransactionReceipt",
          mergeProtocolDiscoveryReadControls(input.control, control),
        );
        if (!receipt) return null;
        return {
          status: receipt.status === null ? null : Number(BigInt(receipt.status)),
          logs: receipt.logs.map(normalizeProtocolDiscoveryLog),
        };
      },
      traceTransaction: async (txHash, control) => {
        const mergedControl =
          mergeProtocolDiscoveryReadControls(input.control, control);
        try {
          return await sendProtocolDiscoveryRpc<unknown>(
            input.provider,
            "debug_traceTransaction",
            [txHash, { tracer: "callTracer" }],
            rpcTimeoutMs,
            "debug_traceTransaction",
            mergedControl,
          );
        } catch (error) {
          if (
            observedHistoryProvider === input.provider ||
            !isProtocolDiscoveryHistoricalStateUnavailable(error)
          ) throw error;
          const historyControl = {
            ...mergedControl,
            deadlineAtMs: Math.min(
              Date.now() + rpcTimeoutMs,
              mergedControl.deadlineAtMs ?? Number.POSITIVE_INFINITY,
            ),
          };
          await ensureObservedHistoryAligned(historyControl);
          return runObservedHistoryTrace(() =>
            sendProtocolDiscoveryRpc<unknown>(
              observedHistoryProvider,
              "debug_traceTransaction",
              [txHash, { tracer: "callTracer" }],
              rpcTimeoutMs,
              "archive debug_traceTransaction",
              historyControl,
              PROTOCOL_DISCOVERY_ARCHIVE_TRACE_RETRY_POLICY,
            ),
            historyControl,
          );
        }
      },
      simulateCalls: async (req, control) => {
        const raw = await sendProtocolDiscoveryRpc<unknown>(
          input.provider,
          "eth_simulateV1",
          [{
            blockStateCalls: [{
              ...(req.stateOverrides === undefined ? {} : { stateOverrides: req.stateOverrides }),
              calls: req.calls.map((call) => ({
                from: call.from,
                to: call.to,
                data: call.data,
              })),
            }],
            validation: false,
            // Behavior families may require causal native-value evidence.
            // The shared transport exposes the synthetic transfer logs; each
            // family still decides whether those logs prove its own semantics.
            traceTransfers: true,
          }, blockTag],
          rpcTimeoutMs,
          "eth_simulateV1",
          mergeProtocolDiscoveryReadControls(input.control, control),
        );
        const firstBlock = Array.isArray(raw) ? raw[0] as { calls?: unknown } : null;
        const calls = firstBlock && Array.isArray(firstBlock.calls) ? firstBlock.calls : [];
        return calls.map((entry) => {
          const call = entry as {
            status?: unknown;
            returnData?: unknown;
            logs?: unknown;
          };
          let status = 0;
          try {
            status = Number(BigInt(String(call.status ?? "0x0")));
          } catch {
            status = 0;
          }
          const logs = Array.isArray(call.logs)
            ? call.logs.flatMap((log) => {
              const item = log as {
                address?: unknown;
                topics?: unknown;
                data?: unknown;
              };
              if (typeof item.address !== "string" || !Array.isArray(item.topics)) return [];
              return [{
                address: item.address,
                topics: item.topics.filter((topic): topic is string => typeof topic === "string"),
                data: typeof item.data === "string" ? item.data : "0x",
                blockNumber: input.blockNumber,
              }];
            })
            : [];
          return {
            status,
            returnData: typeof call.returnData === "string" ? call.returnData : "0x",
            logs,
          };
        });
      },
      createAccessList: async (req, control) => {
        const raw = await sendProtocolDiscoveryRpc<{ accessList?: unknown }>(
          input.provider,
          "eth_createAccessList",
          [{ from: req.from, to: req.to, data: req.data }, blockTag],
          rpcTimeoutMs,
          "eth_createAccessList",
          mergeProtocolDiscoveryReadControls(input.control, control),
        );
        const list = raw && Array.isArray(raw.accessList) ? raw.accessList : [];
        return list.flatMap((entry) => {
          const item = entry as { address?: unknown; storageKeys?: unknown };
          if (typeof item.address !== "string" || !Array.isArray(item.storageKeys)) return [];
          return [{
            address: item.address,
            storageKeys: item.storageKeys.filter((key): key is string => typeof key === "string"),
          }];
        });
      },
    },
  };
}

interface RawProtocolDiscoveryBlockHeader {
  readonly number: string;
  readonly hash: string;
}

/**
 * A separate evidence provider is trusted only after it proves the same
 * canonical block as the current-state provider. The block hash commits the
 * state root and chain history without exposing either endpoint.
 */
export async function assertProtocolDiscoveryObservationProviderAligned(input: {
  provider: ethers.JsonRpcProvider;
  observedHistoryProvider?: ethers.JsonRpcProvider;
  blockNumber: number;
  rpcTimeoutMs?: number;
  control?: ProtocolDiscoveryReadControl;
}): Promise<void> {
  const observedHistoryProvider = input.observedHistoryProvider;
  if (!observedHistoryProvider || observedHistoryProvider === input.provider) {
    return;
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
    throw new Error("invalid protocol discovery provider alignment block");
  }
  const rpcTimeoutMs = input.rpcTimeoutMs ?? Math.max(
    1_000,
    Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_RPC_TIMEOUT_MS ?? "15000"),
  );
  if (!Number.isFinite(rpcTimeoutMs) || rpcTimeoutMs < 1) {
    throw new Error("invalid protocol discovery provider alignment timeout");
  }
  const blockTag = ethers.toQuantity(input.blockNumber);
  const [stateHeader, observedHeader] = await Promise.all([
    sendProtocolDiscoveryRpc<RawProtocolDiscoveryBlockHeader | null>(
      input.provider,
      "eth_getBlockByNumber",
      [blockTag, false],
      rpcTimeoutMs,
      "current-state block header",
      input.control,
    ),
    sendProtocolDiscoveryRpc<RawProtocolDiscoveryBlockHeader | null>(
      observedHistoryProvider,
      "eth_getBlockByNumber",
      [blockTag, false],
      rpcTimeoutMs,
      "observed-history block header",
      input.control,
    ),
  ]);
  if (
    !stateHeader?.hash ||
    !observedHeader?.hash ||
    typeof stateHeader.number !== "string" ||
    typeof observedHeader.number !== "string" ||
    Number(BigInt(stateHeader.number)) !== input.blockNumber ||
    Number(BigInt(observedHeader.number)) !== input.blockNumber ||
    stateHeader.hash.toLowerCase() !== observedHeader.hash.toLowerCase()
  ) {
    throw new Error(
      `protocol discovery observed-history provider is not aligned at block ` +
        `${input.blockNumber}`,
    );
  }
}

interface RawProtocolDiscoveryLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash: string;
  readonly blockNumber: string;
}

interface RawProtocolDiscoveryReceipt {
  readonly status: string | null;
  readonly logs: readonly RawProtocolDiscoveryLog[];
}

function normalizeProtocolDiscoveryLog(log: RawProtocolDiscoveryLog) {
  return {
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    transactionHash: log.transactionHash,
    blockNumber: Number(BigInt(log.blockNumber)),
  };
}

let protocolDiscoveryRpcId = 0;
const PROTOCOL_DISCOVERY_RPC_MAX_ATTEMPTS = 3;
const PROTOCOL_DISCOVERY_RPC_RETRY_BASE_MS = 500;
// A modest steady-state pace avoids bursty shared-quota traffic. A real 429
// holds the serialized queue inside the stronger 1/2/4/8s retry backoff below,
// so every successful request does not need a one-second tax.
const PROTOCOL_DISCOVERY_ARCHIVE_TRACE_MIN_INTERVAL_MS = 100;
const PROTOCOL_DISCOVERY_FAMILY_CONCURRENCY = 8;
const RETRYABLE_PROTOCOL_DISCOVERY_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const NEVER_ABORTED_PROTOCOL_DISCOVERY_SIGNAL = new AbortController().signal;

interface ProtocolDiscoveryRpcRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly backoff: "linear" | "exponential";
}

const PROTOCOL_DISCOVERY_DEFAULT_RETRY_POLICY:
  ProtocolDiscoveryRpcRetryPolicy = Object.freeze({
    maxAttempts: PROTOCOL_DISCOVERY_RPC_MAX_ATTEMPTS,
    baseDelayMs: PROTOCOL_DISCOVERY_RPC_RETRY_BASE_MS,
    backoff: "linear",
  });

const PROTOCOL_DISCOVERY_ARCHIVE_TRACE_RETRY_POLICY:
  ProtocolDiscoveryRpcRetryPolicy = Object.freeze({
    maxAttempts: 5,
    baseDelayMs: 1_000,
    backoff: "exponential",
  });

async function sendProtocolDiscoveryRpc<T>(
  provider: ethers.JsonRpcProvider,
  method: string,
  params: unknown[],
  timeoutMs: number,
  label: string,
  control: ProtocolDiscoveryReadControl = {},
  retryPolicy: ProtocolDiscoveryRpcRetryPolicy =
    PROTOCOL_DISCOVERY_DEFAULT_RETRY_POLICY,
): Promise<T> {
  // Ethers does not expose an AbortSignal per provider.send call. Reuse its
  // connection URL and resolved auth headers, but issue this deadline-bound
  // request through fetch so AbortController closes the actual transport.
  const connection = provider._getConnection();
  const deadlineAtMs = Math.min(
    Date.now() + timeoutMs,
    control.deadlineAtMs ?? Number.POSITIVE_INFINITY,
  );
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
    throwIfProtocolDiscoveryRpcAborted(control.signal);
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) throw protocolDiscoveryRpcTimeout(label, timeoutMs);
    const payload: JsonRpcPayload = {
      id: ++protocolDiscoveryRpcId,
      jsonrpc: "2.0",
      method,
      params,
    };
    try {
      return await runProtocolDiscoveryReadBudget(
        control,
        async (budgetSignal) => {
          throwIfProtocolDiscoveryRpcAborted(control.signal);
          throwIfProtocolDiscoveryRpcAborted(budgetSignal);
          const attemptRemainingMs = deadlineAtMs - Date.now();
          if (attemptRemainingMs <= 0) {
            throw protocolDiscoveryRpcTimeout(label, timeoutMs);
          }
          const controller = new AbortController();
          let timedOut = false;
          const detachParent = control.signal
            ? linkProtocolDiscoveryRpcAbort(control.signal, controller)
            : () => {};
          const detachBudget =
            budgetSignal === control.signal
              ? () => {}
              : linkProtocolDiscoveryRpcAbort(budgetSignal, controller);
          const timer = setTimeout(() => {
            timedOut = true;
            controller.abort(protocolDiscoveryRpcTimeout(label, timeoutMs));
          }, attemptRemainingMs);
          try {
            const response = await fetch(connection.url, {
              method: "POST",
              headers: { ...connection.headers, "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
            throwIfProtocolDiscoveryRpcAborted(control.signal);
            throwIfProtocolDiscoveryRpcAborted(budgetSignal);
            if (Date.now() >= deadlineAtMs) {
              const error = protocolDiscoveryRpcTimeout(label, timeoutMs);
              controller.abort(error);
              throw error;
            }
            if (!response.ok) {
              throw Object.assign(
                new Error(
                  `protocol discovery ${label} HTTP ` +
                    `${response.status} ${response.statusText}`,
                ),
                {
                  status: response.status,
                  retryAfterMs: parseRetryAfterMs(
                    response.headers.get("retry-after"),
                  ),
                },
              );
            }
            const body = await response.json() as Partial<JsonRpcError> & {
              result?: unknown;
            };
            throwIfProtocolDiscoveryRpcAborted(control.signal);
            throwIfProtocolDiscoveryRpcAborted(budgetSignal);
            if (Date.now() >= deadlineAtMs) {
              throw protocolDiscoveryRpcTimeout(label, timeoutMs);
            }
            if (body.error) {
              throw provider.getRpcError(payload, body as JsonRpcError);
            }
            if (!("result" in body)) {
              throw new Error(
                `protocol discovery ${label} returned no result`,
              );
            }
            return body.result as T;
          } catch (error) {
            if (control.signal?.aborted) {
              throw control.signal.reason ??
                protocolDiscoveryRpcAborted(label, error);
            }
            if (budgetSignal.aborted) {
              throw budgetSignal.reason ??
                protocolDiscoveryRpcAborted(label, error);
            }
            if (timedOut) {
              throw protocolDiscoveryRpcTimeout(label, timeoutMs, error);
            }
            throw error;
          } finally {
            clearTimeout(timer);
            detachBudget();
            detachParent();
          }
        },
      );
    } catch (error) {
      if (control.signal?.aborted) {
        throw control.signal.reason ?? protocolDiscoveryRpcAborted(label, error);
      }
      if (
        attempt >= retryPolicy.maxAttempts ||
        !isRetryableProtocolDiscoveryRpcTransportFailure(error)
      ) throw error;
      const retryDelayMs = protocolDiscoveryRetryDelayMs(
        error,
        attempt,
        retryPolicy,
      );
      if (retryDelayMs >= deadlineAtMs - Date.now()) {
        throw protocolDiscoveryRpcTimeout(label, timeoutMs, error);
      }
      await protocolDiscoveryRpcDelay(
        retryDelayMs,
        deadlineAtMs,
        control.signal,
        label,
        timeoutMs,
      );
    }
  }
  throw new Error(`protocol discovery ${label} exhausted RPC attempts`);
}

function runProtocolDiscoveryReadBudget<T>(
  control: ProtocolDiscoveryReadControl,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return control.run
    ? control.run(work)
    : work(control.signal ?? NEVER_ABORTED_PROTOCOL_DISCOVERY_SIGNAL);
}

function isRetryableProtocolDiscoveryRpcTransportFailure(error: unknown): boolean {
  for (const item of protocolDiscoveryErrorChain(error)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const status = Number(record.status ?? record.statusCode);
    if (RETRYABLE_PROTOCOL_DISCOVERY_HTTP_STATUSES.has(status)) return true;
    const code = String(record.code ?? "").toUpperCase();
    if (
      code.startsWith("ECONN") ||
      code.startsWith("UND_ERR_") ||
      new Set([
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "ENOTFOUND",
        "EPIPE",
      ]).has(code)
    ) return true;
    if (item instanceof TypeError && /fetch failed/i.test(item.message)) return true;
  }
  return false;
}

function isProtocolDiscoveryHistoricalStateUnavailable(error: unknown): boolean {
  return protocolDiscoveryErrorChain(error).some((item) => {
    const message = item instanceof Error
      ? item.message
      : item && typeof item === "object" && "message" in item
        ? String((item as { message?: unknown }).message ?? "")
        : "";
    return (
      /state at block .* pruned/i.test(message) ||
      /historical state.*(?:unavailable|pruned|missing)/i.test(message) ||
      /missing trie node/i.test(message) ||
      /state .* not available/i.test(message)
    );
  });
}

function protocolDiscoveryRetryDelayMs(
  error: unknown,
  attempt: number,
  retryPolicy: ProtocolDiscoveryRpcRetryPolicy,
): number {
  const retryAfterMs = protocolDiscoveryErrorChain(error)
    .map((item) =>
      item && typeof item === "object" && "retryAfterMs" in item
        ? Number((item as { retryAfterMs?: unknown }).retryAfterMs)
        : NaN
    )
    .find((value) => Number.isFinite(value) && value >= 0);
  const policyDelayMs = retryPolicy.backoff === "exponential"
    ? retryPolicy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
    : retryPolicy.baseDelayMs * attempt;
  return retryAfterMs !== undefined
    ? Math.max(policyDelayMs, retryAfterMs)
    : policyDelayMs;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function protocolDiscoveryRpcDelay(
  delayMs: number,
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
  label: string,
  timeoutMs: number,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? protocolDiscoveryRpcAborted(label),
    );
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(protocolDiscoveryRpcTimeout(label, timeoutMs));
  }
  return new Promise<void>((resolve, reject) => {
    let detachAbort = (): void => {};
    const timer = setTimeout(() => {
      detachAbort();
      if (Date.now() >= deadlineAtMs) {
        reject(protocolDiscoveryRpcTimeout(label, timeoutMs));
      } else {
        resolve();
      }
    }, Math.min(delayMs, remainingMs));
    if (signal) {
      const abort = (): void => {
        clearTimeout(timer);
        detachAbort();
        reject(signal.reason ?? protocolDiscoveryRpcAborted(label));
      };
      signal.addEventListener("abort", abort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", abort);
    }
  });
}

function waitForProtocolDiscoveryTraceTurn(
  previous: Promise<void>,
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? protocolDiscoveryRpcAborted(
        "archive debug_traceTransaction queue",
      ),
    );
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(
      protocolDiscoveryRpcTimeout(
        "archive debug_traceTransaction queue",
        timeoutMs,
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (): void => finish(
      signal?.reason ??
        protocolDiscoveryRpcAborted(
          "archive debug_traceTransaction queue",
        ),
    );
    const timer = setTimeout(
      () => finish(
        protocolDiscoveryRpcTimeout(
          "archive debug_traceTransaction queue",
          timeoutMs,
        ),
      ),
      remainingMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    previous.then(
      () => finish(),
      () => finish(),
    );
  });
}

function throwIfProtocolDiscoveryRpcAborted(
  signal: AbortSignal | undefined,
): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? protocolDiscoveryRpcAborted("RPC");
}

function linkProtocolDiscoveryRpcAbort(
  source: AbortSignal,
  target: AbortController,
): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = (): void => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function protocolDiscoveryRpcAborted(
  label: string,
  cause?: unknown,
): Error {
  return Object.assign(
    new Error(
      `protocol discovery ${label} aborted`,
      cause === undefined ? undefined : { cause },
    ),
    { code: "ABORTED" },
  );
}

function protocolDiscoveryRpcTimeout(
  label: string,
  timeoutMs: number,
  cause?: unknown,
): Error {
  return Object.assign(
    new Error(
      `protocol discovery ${label} timed out after ${timeoutMs}ms`,
      cause === undefined ? undefined : { cause },
    ),
    { code: "TIMEOUT" },
  );
}

export type ProtocolDiscoveryStage =
  | "feature_flag"
  | "candidate"
  | "identity"
  | "probe"
  | "arbitration";

export interface ProtocolDiscoveryEvent {
  readonly event: "protocol_discovery";
  readonly adapterId: string;
  readonly target: string | null;
  readonly selectors: readonly string[];
  readonly sources: readonly string[];
  readonly verdict: "rejected" | "would_admit";
  readonly stage: ProtocolDiscoveryStage;
  readonly reason: string | null;
  readonly wouldAdmitEdges: number;
}

/**
 * One independently verified route. The semantic key names WHAT the route
 * converts; the execution fingerprint names HOW it executes. Observed/shortlist
 * selectors never enter either: they are candidate provenance, not identity.
 */
export interface VerifiedRouteClaim {
  readonly semanticRouteKey: string;
  readonly producerAdapterId: string;
  readonly edgeAdapterId: string;
  /** Identity root that admitted the instance (identitySource|venueId|factory). */
  readonly authorityFingerprint: string;
  readonly authorityClass: IdentityAuthority["class"];
  readonly authorityStrength: number;
  /** Execution surface shape (edge adapter + execution-relevant edge fields). */
  readonly executionFingerprint: string;
  readonly edge: TokenEdge;
}

export interface VerifiedProtocolAdmission {
  readonly adapterId: string;
  readonly instance: AttestedProtocolInstance;
  readonly edges: readonly TokenEdge[];
  readonly claims: readonly VerifiedRouteClaim[];
}

/**
 * Materialize the exact discovery-owned pool row used by strategy views,
 * graph rebuilds and replay artifacts. The owner qualifier is collection
 * provenance only; route identity remains family-neutral on the edges.
 */
export function projectVerifiedProtocolPool(
  admission: VerifiedProtocolAdmission,
): PoolEntry {
  if (admission.instance.ownerAdapterId !== admission.adapterId) {
    throw new Error(
      `protocol projection owner mismatch ${admission.adapterId}/` +
        `${admission.instance.ownerAdapterId ?? "missing"}`,
    );
  }
  return {
    ...admission.instance.pool,
    discoveryOwnerAdapterId: admission.adapterId,
    verifiedRoutes: admission.edges.map(edgeToVerifiedRouteSpec),
  };
}

export function semanticRouteKey(chainId: string | undefined, edge: TokenEdge): string {
  return [
    chainId ?? "0",
    edgeInstanceKey(edge),
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.protocolAction ?? "",
  ].join("|");
}

export function executionFingerprint(edge: TokenEdge): string {
  return edgeExecutionVariantKey(edge);
}

export function authorityFingerprint(instance: AttestedProtocolInstance): string {
  return [
    instance.pool.identitySource ?? "",
    instance.pool.venueId ?? "",
    instance.pool.factory?.toLowerCase() ?? "",
  ].join("|");
}

export function deriveVerifiedRouteClaims(
  producerAdapterId: string,
  instance: AttestedProtocolInstance,
  edges: readonly TokenEdge[],
  chainId: string | undefined,
  authority: IdentityAuthority,
): VerifiedRouteClaim[] {
  const authorityFingerprintValue = authorityFingerprint(instance);
  return edges.map((edge) => ({
    semanticRouteKey: semanticRouteKey(chainId, edge),
    producerAdapterId,
    edgeAdapterId: edge.adapterId,
    authorityFingerprint: authorityFingerprintValue,
    authorityClass: authority.class,
    authorityStrength: authority.strength,
    executionFingerprint: executionFingerprint(edge),
    edge,
  }));
}

export interface ProtocolDiscoveryResult {
  readonly events: readonly ProtocolDiscoveryEvent[];
  readonly wouldAdmit: readonly VerifiedProtocolAdmission[];
  /** Instance keys evaluated this pass. Lifecycle replacement may only touch these keys. */
  readonly evaluatedInstanceKeys: ReadonlySet<string>;
  /**
   * Candidate-source + identity/probe completeness owned by each enabled
   * family. This is the graph-coverage source of truth; the aggregate booleans
   * below remain compatibility summaries only.
   */
  readonly familySourceCoverage: readonly ProtocolDiscoveryFamilySourceCoverage[];
  /** False means identity/probe hit a retryable read failure. */
  readonly evaluationComplete: boolean;
  /** False means a candidate source or identity/probe read failed. */
  readonly sourceComplete: boolean;
}

export interface ProtocolDiscoveryFamilySourceCoverage {
  readonly familyId: ExecutionFamilyId;
  readonly sourceId: RouteCandidateSourceKind;
  readonly complete: boolean;
  readonly issues: readonly string[];
}

export type ProtocolIdentityAttester = (
  adapter: RouteLegAdapter,
  candidate: ProtocolCandidate,
  context: ProtocolDiscoveryContext,
) => Promise<AttestedPoolEntry<PoolEntry> | null>;

export function createCanonicalProtocolIdentityAttester(input?: {
  /**
   * F8: production-shaped identity runtime (revm simulation transport +
   * verified-actor authority). When absent the attestation falls back to
   * the context-declared runtime, then to the minimal provider runtime;
   * families needing effect-delta simulation stay fail-closed.
   */
  readonly identityRuntime?: CentralAdapterRuntime;
}): ProtocolIdentityAttester {
  return async (_adapter, candidate, context) => {
    try {
    const runtime = input?.identityRuntime ??
      (context.identityRuntime as CentralAdapterRuntime | undefined);
    const backend = context.backend;
    // The discovery backend exposes getStorageAt/getLogs/... with a
    // per-call control parameter; the strict provider shape uses
    // getStorage/slot and a blockTag. Adapt structurally (the backend is
    // already pinned to the canonical block by the discovery lane).
    const strictProvider = {
      call: (tx: { readonly to: string; readonly data: string }) =>
        backend.call(tx),
      getCode: (address: string) => backend.getCode(address),
      getStorage: (address: string, slot: string) =>
        backend.getStorageAt(address, BigInt(slot)),
      getLogs: (filter: {
        readonly address?: string;
        readonly fromBlock?: number;
        readonly toBlock?: number;
        readonly topics?: readonly (string | null)[];
      }) => backend.getLogs(filter as never),
      getTransactionReceipt: (hash: string) =>
        backend.getTransactionReceipt(hash),
      traceTransaction: (hash: string) => backend.traceTransaction(hash),
    };
    const result = await attestPoolsStrictFromProvider({
      provider: strictProvider as never,
      blockNumber: context.blockNumber,
      pools: [candidate.pool],
      ...(runtime === undefined ? {} : { runtime }),
    });
    const accepted = result.accepted[0];
    const rejected = result.rejected[0];
    console.log(
      `[attester-debug] ${candidate.pool.address.slice(0, 8)} accepted=${result.accepted.length} ` +
        `rejected=${result.rejected.length} first=${result.rejected[0]?.reason ?? "-"}`,
    );
    if (rejected !== undefined && isRetryableIdentityRejection(rejected.reason)) {
      // A transient chain read failure is retryable discovery work, not a
      // deterministic negative proof: surface it so the caller retains
      // prior ownership instead of evicting the route.
      throw new RetryableProtocolDiscoveryError(`identity retryable: ${rejected.reason}`);
    }
    if (accepted) {
      return accepted as unknown as AttestedPoolEntry<PoolEntry>;
    }
    return null;
    } catch (error) {
      console.log(
        `[attester-debug] ${candidate.pool.address.slice(0, 8)} THREW: ` +
          (error instanceof Error ? error.message.slice(0, 200) : String(error)),
      );
      throw error;
    }
  };
}

/**
 * Generic retryable-classification for strict identity rejections: the
 * strict authority marks transient chain-read failures with a stable
 * reason suffix; everything else is a deterministic rejection.
 */
function isRetryableIdentityRejection(reason: string): boolean {
  return reason.includes("resource-limited") ||
    reason.includes(":retry") ||
    reason.includes(":timeout") ||
    reason.endsWith(":rpc") ||
    reason.includes(":rpc:");
}

/**
 * Evaluate active, retained, and observed candidates through one fail-closed
 * per-candidate outlet: normalize -> identity -> adapter evidence/probe ->
 * single-adapter edge assertion. No candidate is discarded before its own
 * verification; cross-adapter disagreement is adjudicated post-probe over
 * VerifiedRouteClaims. The function itself never mutates a graph; callers
 * atomically project the verified result with prepareProtocolDiscoveryProjection.
 */
export async function runProtocolDiscovery(input: {
  adapters: readonly RouteLegAdapter[];
  context: ProtocolDiscoveryContext;
  protocolEdgesEnabled: boolean;
  attestIdentity: ProtocolIdentityAttester;
  candidatesByAdapter?: ReadonlyMap<string, readonly ProtocolCandidate[]>;
  sourceComplete?: boolean;
  sourceErrors?: readonly {
    readonly adapterId: string | null;
    readonly sourceKind: RouteCandidateSourceKind;
    readonly impactedFamilyIds: readonly ExecutionFamilyId[];
    readonly target: string | null;
    readonly reason: string;
    readonly retryable?: boolean;
  }[];
  includeRetained?: boolean;
  familyGuardOptions?: ProtocolDiscoveryFamilyGuardOptions;
  /** Parent pass lifetime shared by identity/probe family callbacks. */
  control?: ProtocolDiscoveryReadControl;
}): Promise<ProtocolDiscoveryResult> {
  const passControl = mergeProtocolDiscoveryReadControls(
    protocolDiscoveryReadControlFromFamilyOptions(input.familyGuardOptions),
    input.control,
  );
  throwIfProtocolDiscoveryParentStopped(passControl);
  const events: ProtocolDiscoveryEvent[] = [];
  const wouldAdmit: VerifiedProtocolAdmission[] = [];
  const evaluatedInstanceKeys = new Set<string>();
  const candidateSourceComplete = input.sourceComplete ?? true;
  let evaluationComplete = candidateSourceComplete;
  const enabledAdapters = input.adapters.filter((adapter) =>
    adapter.discovery !== undefined &&
    (!adapter.requiresProtocolEdgesFlag || input.protocolEdgesEnabled)
  );
  const incompleteIssues = new Map<string, string[]>(
    enabledAdapters.map((adapter) => [adapter.id, []]),
  );
  const sourceIncompleteIssues = new Map<string, string[]>();
  const markFamilyIncomplete = (adapterId: string, reason: string): void => {
    const issues = incompleteIssues.get(adapterId);
    if (issues && !issues.includes(reason)) issues.push(reason);
  };
  const markFamilySourceIncomplete = (
    adapterId: string,
    sourceId: RouteCandidateSourceKind,
    reason: string,
  ): void => {
    const key = `${adapterId}\u001f${sourceId}`;
    const issues = sourceIncompleteIssues.get(key) ?? [];
    if (!issues.includes(reason)) issues.push(reason);
    sourceIncompleteIssues.set(key, issues);
  };
  const familyGuard = new ProtocolDiscoveryFamilyGuard(
    {
      ...mergeProtocolDiscoveryFamilyGuardOptions(
        input.familyGuardOptions,
        passControl,
      ),
      countsTowardCircuit: isRetryableProtocolDiscoveryFailure,
    },
  );

  for (const error of input.sourceErrors ?? []) {
    events.push({
      event: "protocol_discovery",
      adapterId: error.adapterId ?? "protocol-scanner",
      target: error.target,
      selectors: [],
      sources: ["shared-scanner"],
      verdict: "rejected",
      stage: "candidate",
      reason: error.reason,
      wouldAdmitEdges: 0,
    });
    if (error.retryable) {
      for (const familyId of new Set(error.impactedFamilyIds)) {
        markFamilySourceIncomplete(
          familyId,
          error.sourceKind,
          error.reason,
        );
      }
    }
  }
  if (
    !candidateSourceComplete &&
    !(input.sourceErrors ?? []).some((error) => error.retryable)
  ) {
    for (const adapter of enabledAdapters) {
      markFamilyIncomplete(adapter.id, "candidate source reported incomplete");
    }
  }

  const familyResults = await mapLimitDeterministic(
    input.adapters,
    PROTOCOL_DISCOVERY_FAMILY_CONCURRENCY,
    async (adapter) => {
      const familyEvents: ProtocolDiscoveryEvent[] = [];
      const familyWouldAdmit: VerifiedProtocolAdmission[] = [];
      const familyEvaluatedInstanceKeys = new Set<string>();
      const familyIncompleteIssues: string[] = [];
      let familyEvaluationComplete = true;
      const markIncomplete = (reason: string): void => {
        familyEvaluationComplete = false;
        if (!familyIncompleteIssues.includes(reason)) {
          familyIncompleteIssues.push(reason);
        }
      };
      const result = () => ({
        adapterId: adapter.id,
        events: familyEvents,
        wouldAdmit: familyWouldAdmit,
        evaluatedInstanceKeys: familyEvaluatedInstanceKeys,
        incompleteIssues: familyIncompleteIssues,
        evaluationComplete: familyEvaluationComplete,
      });
      const discovery = adapter.discovery;
      if (!discovery) return result();

      if (adapter.requiresProtocolEdgesFlag && !input.protocolEdgesEnabled) {
        familyEvents.push(
          eventFor(
            adapter.id,
            null,
            "rejected",
            "feature_flag",
            "protocol_edges_disabled",
            0,
          ),
        );
        return result();
      }

      const rawCandidates: ProtocolCandidate[] = (input.includeRetained ?? true)
        ? input.context.retainedInstances
          .filter((instance) => instance.ownerAdapterId === undefined
            ? adapter.poolAdapters.includes(instance.pool.adapter)
            : instance.ownerAdapterId === adapter.id)
          .map(candidateFromRetained)
        : [];
      rawCandidates.push(...(input.candidatesByAdapter?.get(adapter.id) ?? []));

      const grouped = new Map<string, CandidateAggregate>();
      const quarantinedKeys = new Set<string>();
      for (const rawCandidate of rawCandidates) {
        let candidate: ProtocolCandidate;
        try {
          candidate = normalizeCandidate(adapter, rawCandidate);
        } catch (error) {
          familyEvents.push(
            eventFor(
              adapter.id,
              rawCandidate,
              "rejected",
              "candidate",
              safeError(error),
              0,
            ),
          );
          continue;
        }
        const key = protocolInstanceKey(adapter.id, candidate.pool);
        if (quarantinedKeys.has(key)) continue;
        const current = grouped.get(key);
        try {
          if (
            current &&
            poolShapeKey(current.candidate.pool) !==
              poolShapeKey(candidate.pool) &&
            current.sources.every((source) => source === "retained-instance") &&
            candidate.source !== "retained-instance"
          ) {
            // Current chain-derived metadata supersedes the prior snapshot.
            grouped.set(key, aggregateCandidate(candidate));
          } else {
            grouped.set(
              key,
              current
                ? mergeCandidate(current, candidate)
                : aggregateCandidate(candidate),
            );
          }
        } catch (error) {
          grouped.delete(key);
          quarantinedKeys.add(key);
          familyEvaluatedInstanceKeys.add(key);
          familyEvents.push(
            eventFor(
              adapter.id,
              candidate,
              "rejected",
              "candidate",
              safeError(error),
              0,
            ),
          );
        }
      }

      // Candidate order remains serial within one family; sibling families run
      // in parallel and merge below in registration order.
      for (const [key, aggregate] of grouped) {
        const candidate = aggregate.candidate;
        let attestedPool: AttestedPoolEntry<PoolEntry> | null;
        try {
          attestedPool = await familyGuard.run(
            adapter.id,
            "identity",
            (control) =>
              input.attestIdentity(
                adapter,
                candidate,
                withProtocolDiscoveryFamilyContext(input.context, control),
              ),
          );
        } catch (error) {
          throwIfProtocolDiscoveryParentStopped(passControl);
          if (isRetryableProtocolDiscoveryFailure(error)) {
            markIncomplete(safeError(error));
          } else {
            familyEvaluatedInstanceKeys.add(key);
          }
          familyEvents.push(
            eventFor(
              adapter.id,
              aggregate,
              "rejected",
              "identity",
              safeError(error),
              0,
            ),
          );
          continue;
        }
        if (!attestedPool) {
          familyEvaluatedInstanceKeys.add(key);
          familyEvents.push(
            eventFor(
              adapter.id,
              aggregate,
              "rejected",
              "identity",
              "identity_not_attested",
              0,
            ),
          );
          continue;
        }

        let instance: AttestedProtocolInstance;
        try {
          instance = normalizeAttestedInstance(
            adapter,
            aggregate,
            attestedPool,
          );
        } catch (error) {
          familyEvaluatedInstanceKeys.add(key);
          familyEvents.push(
            eventFor(
              adapter.id,
              aggregate,
              "rejected",
              "identity",
              safeError(error),
              0,
            ),
          );
          continue;
        }

        let edges: readonly TokenEdge[];
        try {
          edges = await familyGuard.run(
            adapter.id,
            "probe",
            async (control) => {
              const familyContext = withProtocolDiscoveryFamilyContext(
                input.context,
                control,
              );
              const verified = bindRouteInstanceIdentity(
                adapter,
                instance.pool,
                await discovery.probeCandidate(instance, familyContext),
              );
              assertVerifiedEdges(adapter, instance, verified);
              return verified;
            },
          );
        } catch (error) {
          throwIfProtocolDiscoveryParentStopped(passControl);
          if (isRetryableProtocolDiscoveryFailure(error)) {
            markIncomplete(safeError(error));
          } else {
            familyEvaluatedInstanceKeys.add(key);
          }
          familyEvents.push(
            eventFor(
              adapter.id,
              aggregate,
              "rejected",
              "probe",
              safeError(error),
              0,
            ),
          );
          continue;
        }

        familyEvaluatedInstanceKeys.add(key);
        familyWouldAdmit.push({
          adapterId: adapter.id,
          instance,
          edges: [...edges],
          claims: deriveVerifiedRouteClaims(
            adapter.id,
            instance,
            edges,
            input.context.chainId,
            adapter.discoveryIdentityAuthority ??
              failMissingDiscoveryAuthority(adapter.id),
          ),
        });
        familyEvents.push(
          eventFor(
            adapter.id,
            aggregate,
            "would_admit",
            "probe",
            null,
            edges.length,
          ),
        );
      }
      return result();
    },
  );
  throwIfProtocolDiscoveryParentStopped(passControl);
  for (const family of familyResults) {
    events.push(...family.events);
    wouldAdmit.push(...family.wouldAdmit);
    for (const key of family.evaluatedInstanceKeys) {
      evaluatedInstanceKeys.add(key);
    }
    if (!family.evaluationComplete) evaluationComplete = false;
    for (const reason of family.incompleteIssues) {
      markFamilyIncomplete(family.adapterId, reason);
    }
  }

  // Post-probe GLOBAL route arbitration over VerifiedRouteClaims. Every
  // claimant verified its own candidate first, so this decision is
  // evidence-backed. Same semantic route + same execution fingerprint =
  // equivalent claims that deduplicate at edge merge; same semantic route +
  // DIFFERENT execution fingerprints means at least one adapter admitted a
  // contract it should not have: retain a sole re-attested incumbent and
  // quarantine challengers, or isolate every claimant when no incumbent is
  // unique. Different token pairs on one target are distinct semantic routes.
  const arbitration = arbitrateRouteClaims(wouldAdmit, events);
  const familySourceCoverage = Object.freeze(enabledAdapters
    .flatMap((adapter): ProtocolDiscoveryFamilySourceCoverage[] =>
      [...new Set(adapter.discovery!.candidateSources)].map((sourceId) => {
        const issues = Object.freeze([
          ...(incompleteIssues.get(adapter.id) ?? []),
          ...(sourceIncompleteIssues.get(
            `${adapter.id}\u001f${sourceId}`,
          ) ?? []),
        ]);
        return Object.freeze({
          familyId: adapter.id,
          sourceId,
          complete: issues.length === 0,
          issues,
        });
      })
    )
    .sort((a, b) =>
      a.familyId.localeCompare(b.familyId) ||
      a.sourceId.localeCompare(b.sourceId)
    ));

  return {
    events,
    wouldAdmit: arbitration,
    evaluatedInstanceKeys,
    familySourceCoverage,
    evaluationComplete,
    sourceComplete:
      candidateSourceComplete &&
      evaluationComplete &&
      familySourceCoverage.every((coverage) => coverage.complete),
  };
}

function arbitrateRouteClaims(
  wouldAdmit: readonly VerifiedProtocolAdmission[],
  events: ProtocolDiscoveryEvent[],
): VerifiedProtocolAdmission[] {
  interface RouteClaimant {
    readonly admissionIndex: number;
    readonly claim: VerifiedRouteClaim;
  }
  const claimsByRoute = new Map<string, RouteClaimant[]>();
  wouldAdmit.forEach((admission, admissionIndex) => {
    for (const claim of admission.claims) {
      const claimants = claimsByRoute.get(claim.semanticRouteKey) ?? [];
      claimants.push({ admissionIndex, claim });
      claimsByRoute.set(claim.semanticRouteKey, claimants);
    }
  });

  const quarantinedRouteKeysByAdmission = new Map<number, Set<string>>();
  const quarantine = (admissionIndex: number, routeKey: string): void => {
    const routes = quarantinedRouteKeysByAdmission.get(admissionIndex) ?? new Set<string>();
    routes.add(routeKey);
    quarantinedRouteKeysByAdmission.set(admissionIndex, routes);
  };
  for (const [routeKey, claimants] of claimsByRoute) {
    const claimantAdapterIds = unique(
      claimants.map((item) => wouldAdmit[item.admissionIndex].adapterId),
    );
    if (claimantAdapterIds.length < 2) continue;
    const target = claimants[0].claim.edge.target;
    const fingerprints = unique(claimants.map((item) => item.claim.executionFingerprint));
    if (fingerprints.length === 1) {
      // Equivalent claims: the route is admitted once (identical edge identity
      // deduplicates at merge). The primary owner is chosen by EXPLICIT
      // authority credential rank, then incumbency; a full tie is co-owned.
      // Registration order and lexical order never decide.
      const rankedClaimants = claimants.map((item) => ({
        adapterId: wouldAdmit[item.admissionIndex].adapterId,
        rank: item.claim.authorityStrength,
        incumbent: wouldAdmit[item.admissionIndex].instance.sources.includes("retained-instance"),
      }));
      const maxRank = Math.max(...rankedClaimants.map((item) => item.rank));
      const topRanked = rankedClaimants.filter((item) => item.rank === maxRank);
      const incumbents = topRanked.filter((item) => item.incumbent);
      const primary = topRanked.length === 1
        ? topRanked[0].adapterId
        : incumbents.length === 1
          ? incumbents[0].adapterId
          : null;
      events.push({
        event: "protocol_discovery",
        adapterId: primary ?? "co-owned",
        target,
        selectors: [],
        sources: ["route-arbitration"],
        verdict: "would_admit",
        stage: "arbitration",
        reason: `equivalent_route_claims claimants=${[...claimantAdapterIds].sort().join(",")}`,
        wouldAdmitEdges: 1,
      });
      continue;
    }
    // A newly verified claim can never displace the sole active owner. Preserve
    // that re-attested incumbent and quarantine only challengers. With no
    // unique incumbent, fail closed for every claimant.
    const incumbentAdmissionIndexes = unique(
      claimants
        .filter((item) =>
          wouldAdmit[item.admissionIndex].instance.sources.includes("retained-instance")
        )
        .map((item) => item.admissionIndex),
    );
    const protectedIncumbent = incumbentAdmissionIndexes.length === 1
      ? incumbentAdmissionIndexes[0]
      : null;
    if (protectedIncumbent !== null) {
      const incumbent = wouldAdmit[protectedIncumbent];
      events.push({
        event: "protocol_discovery",
        adapterId: incumbent.adapterId,
        target,
        selectors: [],
        sources: ["route-arbitration"],
        verdict: "would_admit",
        stage: "arbitration",
        reason: `incumbent_route_preserved challengers=${
          claimantAdapterIds
            .filter((adapterId) => adapterId !== incumbent.adapterId)
            .sort()
            .join(",")
        }`,
        wouldAdmitEdges: 1,
      });
    }
    const rejectedAdapterIds = new Set<string>();
    for (const claimant of claimants) {
      if (claimant.admissionIndex === protectedIncumbent) continue;
      quarantine(claimant.admissionIndex, routeKey);
      rejectedAdapterIds.add(
        wouldAdmit[claimant.admissionIndex].adapterId,
      );
    }
    for (const adapterId of rejectedAdapterIds) {
      events.push({
        event: "protocol_discovery",
        adapterId,
        target,
        selectors: [],
        sources: ["route-arbitration"],
        verdict: "rejected",
        stage: "arbitration",
        reason: `non_equivalent_execution_fingerprints claimants=${
          [...claimantAdapterIds].sort().join(",")
        }`,
        wouldAdmitEdges: 0,
      });
    }
  }
  if (quarantinedRouteKeysByAdmission.size === 0) return [...wouldAdmit];

  const arbitrated: VerifiedProtocolAdmission[] = [];
  for (const [admissionIndex, admission] of wouldAdmit.entries()) {
    const quarantinedRouteKeys = quarantinedRouteKeysByAdmission.get(admissionIndex);
    if (!quarantinedRouteKeys) {
      arbitrated.push(admission);
      continue;
    }
    const keptClaims = admission.claims.filter(
      (claim) => !quarantinedRouteKeys.has(claim.semanticRouteKey),
    );
    if (keptClaims.length === admission.claims.length) {
      arbitrated.push(admission);
      continue;
    }
    // A quarantined route strips only the challenged admission's edge. An
    // admission left with zero verified routes is dropped; a protected
    // incumbent never enters this branch.
    if (keptClaims.length === 0) continue;
    const keptEdgeKeys = new Set(keptClaims.map((claim) => protocolEdgeKey(claim.edge)));
    arbitrated.push({
      ...admission,
      edges: admission.edges.filter((edge) => keptEdgeKeys.has(protocolEdgeKey(edge))),
      claims: keptClaims,
    });
  }
  return arbitrated;
}

/** Compatibility name retained for the explicit Slice-B shadow gate. */
export const runProtocolDiscoveryShadow = runProtocolDiscovery;

export interface ProtocolDiscoveryOwnership {
  readonly version: number;
  readonly admissions: ReadonlyMap<string, VerifiedProtocolAdmission>;
}

export const EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP: ProtocolDiscoveryOwnership = Object.freeze({
  version: 0,
  admissions: new Map(),
});

export function replaceProtocolDiscoveryOwnership(
  current: ProtocolDiscoveryOwnership,
  result: ProtocolDiscoveryResult,
): ProtocolDiscoveryOwnership {
  const admissions = new Map(current.admissions);
  for (const key of result.evaluatedInstanceKeys) admissions.delete(key);
  for (const admission of result.wouldAdmit) {
    admissions.set(protocolInstanceKey(admission.adapterId, admission.instance.pool), admission);
  }
  return {
    version: result.evaluatedInstanceKeys.size > 0 ? current.version + 1 : current.version,
    admissions,
  };
}

export interface ProtocolDiscoveryProjection {
  readonly baseOwnershipVersion: number;
  readonly ownership: ProtocolDiscoveryOwnership;
  readonly strategyViews: StrategyViews;
  readonly backrunGraph: TokenEdge[];
  readonly blockscanGraph?: TokenEdge[];
  readonly tokenIndex: Map<string, Set<string>>;
  readonly poolAddressMap: Map<string, string>;
  readonly flashTokens: string[];
  readonly knownPoolKeys: Set<string>;
  readonly knownPoolAddresses: Set<string>;
  /**
   * Verified claims suppressed because an already-built incumbent edge owns
   * the same semantic route with the same execution fingerprint. Incumbency
   * is route-scoped, never an address-wide admission credential.
   */
  readonly staticSuppressed: readonly VerifiedProtocolAdmission[];
  /**
   * Non-equivalent claims for an incumbent semantic route. Both the incumbent
   * edge and challenger claim are quarantined for this projection.
   */
  readonly staticConflicted: readonly VerifiedProtocolAdmission[];
}

/**
 * Re-attestation can refresh ownership evidence without changing any routing
 * consumer. Keep that evidence update, but do not rebuild graphs or reconnect
 * the public-mempool subscription for a routing no-op.
 */
export function protocolDiscoveryProjectionChangesRouting(
  current: {
    readonly strategyViews: StrategyViews;
    readonly backrunGraph: TokenEdge[];
    readonly blockscanGraph?: TokenEdge[];
  },
  projection: ProtocolDiscoveryProjection,
): boolean {
  if (
    current.strategyViews.versions.strategy_view_version !==
      projection.strategyViews.versions.strategy_view_version
  ) return true;
  if (hashTokenGraph(current.backrunGraph) !== hashTokenGraph(projection.backrunGraph)) return true;
  if (current.blockscanGraph === undefined || projection.blockscanGraph === undefined) {
    return current.blockscanGraph !== projection.blockscanGraph;
  }
  return hashTokenGraph(current.blockscanGraph) !== hashTokenGraph(projection.blockscanGraph);
}

/**
 * Remove only previously discovery-owned pools/edges, add the new verified
 * snapshot, and rebuild every derived projection off to the side. The caller
 * commits the returned objects without an await between mutations.
 */
export function prepareProtocolDiscoveryProjection(input: {
  currentOwnership: ProtocolDiscoveryOwnership;
  result: ProtocolDiscoveryResult;
  currentBackrunPools: readonly PoolEntry[];
  currentBackrunGraph: readonly TokenEdge[];
  currentBlockscanGraph?: readonly TokenEdge[];
  currentKnownPoolKeys?: ReadonlySet<string>;
  buildStrategyViews: (pools: PoolEntry[]) => StrategyViews;
}): ProtocolDiscoveryProjection {
  const previousEdgeKeys = new Set(
    [...input.currentOwnership.admissions.values()].flatMap(
      (item) => item.edges.map(protocolEdgeKey),
    ),
  );
  // Incumbent graph edges were already re-attested by buildEdges at this
  // source. They enter arbitration as route claims. The target address alone
  // is never an identity/admission credential: another verified semantic route
  // at the same singleton may coexist.
  const incumbentEdges = input.currentBackrunGraph.filter(
    (edge) => !previousEdgeKeys.has(protocolEdgeKey(edge)),
  );
  const quarantinedIncumbentEdgeKeys = new Set<string>();
  const staticSuppressed: VerifiedProtocolAdmission[] = [];
  const staticConflicted: VerifiedProtocolAdmission[] = [];
  const projectedAdmissions: VerifiedProtocolAdmission[] = [];
  for (const admission of input.result.wouldAdmit) {
    const keptClaims: VerifiedRouteClaim[] = [];
    const equivalentClaims: VerifiedRouteClaim[] = [];
    const conflictedClaims: VerifiedRouteClaim[] = [];
    for (const claim of admission.claims) {
      const incumbents = incumbentEdges.filter((edge) =>
        sameSemanticRoute(edge, claim.edge)
      );
      if (incumbents.length === 0) {
        keptClaims.push(claim);
        continue;
      }
      if (
        incumbents.every(
          (edge) => executionFingerprint(edge) === claim.executionFingerprint,
        )
      ) {
        equivalentClaims.push(claim);
        continue;
      }
      conflictedClaims.push(claim);
      for (const edge of incumbents) {
        quarantinedIncumbentEdgeKeys.add(protocolEdgeKey(edge));
      }
    }
    const sliceAdmission = (
      claims: readonly VerifiedRouteClaim[],
    ): VerifiedProtocolAdmission => {
      const edgeKeys = new Set(claims.map((claim) => protocolEdgeKey(claim.edge)));
      return {
        ...admission,
        claims: [...claims],
        edges: admission.edges.filter((edge) => edgeKeys.has(protocolEdgeKey(edge))),
      };
    };
    if (equivalentClaims.length > 0) {
      staticSuppressed.push(sliceAdmission(equivalentClaims));
    }
    if (conflictedClaims.length > 0) {
      staticConflicted.push(sliceAdmission(conflictedClaims));
    }
    if (keptClaims.length > 0) {
      projectedAdmissions.push(sliceAdmission(keptClaims));
    }
  }
  const effectiveResult: ProtocolDiscoveryResult = {
    ...input.result,
    wouldAdmit: projectedAdmissions,
  };
  const ownership = replaceProtocolDiscoveryOwnership(input.currentOwnership, effectiveResult);
  const priorDiscoveryPools = input.currentBackrunPools.filter(
    (pool) => pool.discoveryOwnerAdapterId !== undefined,
  );
  const basePools = input.currentBackrunPools.filter(
    (pool) => pool.discoveryOwnerAdapterId === undefined,
  );
  const baseGraph = input.currentBackrunGraph.filter((edge) =>
    !previousEdgeKeys.has(protocolEdgeKey(edge)) &&
    !quarantinedIncumbentEdgeKeys.has(protocolEdgeKey(edge))
  );
  const baseBlockscanGraph = input.currentBlockscanGraph?.filter(
    (edge) =>
      !previousEdgeKeys.has(protocolEdgeKey(edge)) &&
      !quarantinedIncumbentEdgeKeys.has(protocolEdgeKey(edge)),
  );
  const admissions = [...ownership.admissions.values()];
  const projectedAdmissionPools = admissions.map(projectVerifiedProtocolPool);
  const backrunPools = mergePoolProjectionRows(
    [...basePools],
    projectedAdmissionPools,
  );
  const strategyViews = input.buildStrategyViews(backrunPools);
  const backrunGraph = mergeEdges(baseGraph, admissions.flatMap((item) => [...item.edges]));
  const blockscanKeys = new Set(
    strategyViews.blockscan.map(poolProjectionRowKey),
  );
  const blockscanAdditions = admissions.flatMap((item, index) =>
    blockscanKeys.has(poolProjectionRowKey(projectedAdmissionPools[index]))
      ? [...item.edges]
      : []
  );
  const blockscanGraph = baseBlockscanGraph === undefined
    ? undefined
    : mergeEdges(baseBlockscanGraph, blockscanAdditions);
  const tokenIndex = buildTokenIndex(backrunGraph);
  const poolAddressMap = new Map<string, string>();
  for (const pool of strategyViews.backrun) {
    poolAddressMap.set(pool.address.toLowerCase(), pool.adapter);
  }
  const basePoolKeys = new Set(basePools.map(poolProjectionRowKey));
  const knownPoolKeys = new Set(
    input.currentKnownPoolKeys ?? basePoolKeys,
  );
  for (const pool of priorDiscoveryPools) {
    const key = poolProjectionRowKey(pool);
    if (!basePoolKeys.has(key)) knownPoolKeys.delete(key);
    const legacyPhysicalKey = poolRegistryKey(pool);
    if (!basePoolKeys.has(legacyPhysicalKey)) {
      knownPoolKeys.delete(legacyPhysicalKey);
    }
  }
  for (const key of basePoolKeys) knownPoolKeys.add(key);
  for (const pool of projectedAdmissionPools) {
    knownPoolKeys.add(poolProjectionRowKey(pool));
  }
  return {
    baseOwnershipVersion: input.currentOwnership.version,
    ownership,
    strategyViews,
    backrunGraph,
    blockscanGraph,
    tokenIndex,
    poolAddressMap,
    flashTokens: [...tokenIndex.keys()],
    knownPoolKeys,
    knownPoolAddresses: new Set(strategyViews.backrun.map((pool) => pool.address.toLowerCase())),
    staticSuppressed,
    staticConflicted,
  };
}

/**
 * Revoke a set of discovery families without treating unrelated dynamic
 * ownership as part of the failure. A canonical observed-history anchor
 * change must remove affected routes before another graph is published, while
 * static routes and healthy discovery families remain projected.
 */
export function prepareProtocolDiscoveryFamilyInvalidation(input: {
  currentOwnership: ProtocolDiscoveryOwnership;
  invalidatedAdapterIds: ReadonlySet<string>;
  currentBackrunPools: readonly PoolEntry[];
  currentBackrunGraph: readonly TokenEdge[];
  currentBlockscanGraph?: readonly TokenEdge[];
  currentKnownPoolKeys?: ReadonlySet<string>;
  buildStrategyViews: (pools: PoolEntry[]) => StrategyViews;
}): {
  readonly result: ProtocolDiscoveryResult;
  readonly projection: ProtocolDiscoveryProjection;
} {
  const evaluatedInstanceKeys = new Set(
    [...input.currentOwnership.admissions]
      .filter(([, admission]) =>
        input.invalidatedAdapterIds.has(admission.adapterId)
      )
      .map(([instanceKey]) => instanceKey),
  );
  const result: ProtocolDiscoveryResult = {
    events: [],
    wouldAdmit: [],
    evaluatedInstanceKeys,
    familySourceCoverage: [],
    // Invalidation is a fail-closed lifecycle operation, not evidence that a
    // replacement source scan completed.
    evaluationComplete: false,
    sourceComplete: false,
  };
  return {
    result,
    projection: prepareProtocolDiscoveryProjection({
      currentOwnership: input.currentOwnership,
      result,
      currentBackrunPools: input.currentBackrunPools,
      currentBackrunGraph: input.currentBackrunGraph,
      currentBlockscanGraph: input.currentBlockscanGraph,
      currentKnownPoolKeys: input.currentKnownPoolKeys,
      buildStrategyViews: input.buildStrategyViews,
    }),
  };
}

function sameSemanticRoute(a: TokenEdge, b: TokenEdge): boolean {
  return edgeInstanceKey(a) === edgeInstanceKey(b) &&
    a.target.toLowerCase() === b.target.toLowerCase() &&
    a.tokenIn.toLowerCase() === b.tokenIn.toLowerCase() &&
    a.tokenOut.toLowerCase() === b.tokenOut.toLowerCase() &&
    a.slotKind === b.slotKind &&
    (a.protocolAction ?? "") === (b.protocolAction ?? "");
}

export function protocolInstanceKey(
  adapterId: string,
  pool:
    | string
    | Pick<PoolEntry, "address" | "logicalInstanceId" | "routeBinding">,
): string {
  const address = typeof pool === "string" ? pool : pool.address;
  const logicalInstanceId = typeof pool === "string" ? undefined : pool.logicalInstanceId;
  const routeBindingHash = typeof pool === "string"
    ? null
    : validatedRouteImmutableBindingHash(pool.routeBinding);
  const base = `${adapterId}|${ethers.getAddress(address).toLowerCase()}`;
  const logical = logicalInstanceId === undefined ? base : `${base}|${logicalInstanceId}`;
  return routeBindingHash === null
    ? logical
    : `${logical}|route-binding:${routeBindingHash}`;
}

/** Address-level prefix of an instance key (adapterId|address). */
export function protocolInstanceAddressKey(instanceKey: string): string {
  return instanceKey.split("|").slice(0, 2).join("|");
}

function edgeToVerifiedRouteSpec(edge: TokenEdge): import("./planner/token-graph.js").VerifiedRouteSpec {
  return {
    edgeAdapterId: edge.adapterId,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    slotKind: edge.slotKind,
    ...(edge.protocolAction === undefined ? {} : { protocolAction: edge.protocolAction }),
    ...(edge.poolToken0 === undefined ? {} : { poolToken0: edge.poolToken0 }),
    ...(edge.poolToken1 === undefined ? {} : { poolToken1: edge.poolToken1 }),
  };
}

export function protocolEdgeKey(edge: TokenEdge): string {
  return [
    edgeInstanceKey(edge),
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.protocolAction ?? "",
    edgeExecutionVariantKey(edge),
  ].join("|");
}

interface CandidateAggregate {
  readonly candidate: ProtocolCandidate;
  readonly sources: readonly string[];
  readonly selectors: readonly string[];
  readonly evidence: readonly unknown[];
}

const MAX_PROTOCOL_EVIDENCE_PER_INSTANCE = 64;

function candidateFromRetained(instance: AttestedProtocolInstance): ProtocolCandidate {
  return {
    pool: { ...instance.pool },
    source: "retained-instance",
    ...(instance.selectors[0] === undefined ? {} : { selector: instance.selectors[0] }),
    evidence: instance.evidence,
  };
}

function aggregateCandidate(candidate: ProtocolCandidate): CandidateAggregate {
  return {
    candidate,
    sources: [candidate.source],
    selectors: candidate.selector === undefined ? [] : [candidate.selector],
    evidence: uniqueProtocolEvidence(candidate.evidence ?? []),
  };
}

function mergeCandidate(current: CandidateAggregate, candidate: ProtocolCandidate): CandidateAggregate {
  if (poolShapeKey(current.candidate.pool) !== poolShapeKey(candidate.pool)) {
    throw new Error("candidate sources disagree on instance metadata");
  }
  return {
    candidate: current.candidate,
    sources: unique([...current.sources, candidate.source]),
    selectors: unique([
      ...current.selectors,
      ...(candidate.selector === undefined ? [] : [candidate.selector]),
    ]),
    evidence: uniqueProtocolEvidence([...current.evidence, ...(candidate.evidence ?? [])]),
  };
}

function uniqueProtocolEvidence(values: readonly unknown[]): unknown[] {
  const byWitness = new Map<string, unknown>();
  for (const value of values) {
    const key = stableEvidenceKey(value);
    // Reinsert duplicate witnesses so the retained order always prefers the
    // freshest observation when the bounded evidence window is full.
    byWitness.delete(key);
    byWitness.set(key, value);
  }
  return [...byWitness.values()].slice(-MAX_PROTOCOL_EVIDENCE_PER_INSTANCE);
}

function stableEvidenceKey(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value === null || typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableEvidenceKey).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableEvidenceKey(record[key])}`
  ).join(",")}}`;
}

function poolShapeKey(pool: PoolEntry): string {
  const routeBindingHash =
    validatedRouteImmutableBindingHash(pool.routeBinding);
  return JSON.stringify({
    address: pool.address.toLowerCase(),
    adapter: pool.adapter,
    logicalInstanceId: pool.logicalInstanceId,
    routeBindingHash,
    token0: pool.token0?.toLowerCase(),
    token1: pool.token1?.toLowerCase(),
    fixedTokenIn: pool.fixedTokenIn?.toLowerCase(),
    fixedTokenOut: pool.fixedTokenOut?.toLowerCase(),
    fixedSlotKind: pool.fixedSlotKind,
    fixedProtocolAction: pool.fixedProtocolAction,
    nonStandardRedeem: pool.nonStandardRedeem,
    redeemTokenOut: pool.redeemTokenOut?.toLowerCase(),
  });
}

function normalizeCandidate(
  adapter: RouteLegAdapter,
  candidate: ProtocolCandidate,
): ProtocolCandidate {
  const address = ethers.getAddress(candidate.pool.address);
  if (!adapter.poolAdapters.includes(candidate.pool.adapter)) {
    throw new Error(`foreign pool adapter ${candidate.pool.adapter}`);
  }
  const source = candidate.source.trim();
  if (!source) throw new Error("candidate source is required");
  const selector = candidate.selector?.toLowerCase();
  if (selector !== undefined && !/^0x[0-9a-f]{8}$/.test(selector)) {
    throw new Error("candidate selector must be four bytes");
  }
  return {
    pool: { ...candidate.pool, address },
    source,
    ...(selector === undefined ? {} : { selector }),
    evidence: [...(candidate.evidence ?? [])],
  };
}

function normalizeAttestedInstance(
  adapter: RouteLegAdapter,
  aggregate: CandidateAggregate,
  pool: AttestedPoolEntry<PoolEntry>,
): AttestedProtocolInstance {
  const address = ethers.getAddress(pool.address);
  if (address.toLowerCase() !== aggregate.candidate.pool.address.toLowerCase()) {
    throw new Error("identity attester changed candidate target");
  }
  if (!pool.identitySource) throw new Error("identity attester omitted identity credential");
  if (!adapter.poolAdapters.includes(pool.adapter)) {
    throw new Error(`identity attester returned foreign pool adapter ${pool.adapter}`);
  }
  return {
    pool: { ...pool, address },
    sources: aggregate.sources,
    selectors: aggregate.selectors,
    evidence: aggregate.evidence,
    ownerAdapterId: adapter.id,
  };
}

function assertVerifiedEdges(
  adapter: RouteLegAdapter,
  instance: AttestedProtocolInstance,
  edges: readonly TokenEdge[],
): void {
  if (edges.length === 0) throw new Error("probe produced zero verified edges");
  const target = instance.pool.address.toLowerCase();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (ethers.getAddress(edge.target).toLowerCase() !== target) {
      throw new Error("probe edge target differs from attested instance");
    }
    ethers.getAddress(edge.tokenIn);
    ethers.getAddress(edge.tokenOut);
    if (!adapter.edgeAdapterIds.includes(edge.adapterId)) {
      throw new Error(`probe emitted undeclared edge adapter ${edge.adapterId}`);
    }
    const taxonomyAllowed = adapter.allowedTaxonomy.some((allowed) =>
      allowed.slotKind === edge.slotKind && allowed.protocolAction === edge.protocolAction
    );
    if (!taxonomyAllowed) throw new Error("probe emitted disallowed edge taxonomy");
    const taxonomy = deriveEdgeTaxonomy(edge.slotKind, edge.protocolAction);
    if (
      taxonomy.edgeKind !== edge.edgeKind ||
      taxonomy.leavesStandingPosition !== edge.leavesStandingPosition
    ) {
      throw new Error("probe emitted inconsistent edge taxonomy");
    }
    const key = protocolEdgeKey(edge);
    if (seen.has(key)) throw new Error("probe emitted duplicate verified edge");
    seen.add(key);
  }
}

function eventFor(
  adapterId: string,
  candidate: ProtocolCandidate | CandidateAggregate | null,
  verdict: ProtocolDiscoveryEvent["verdict"],
  stage: ProtocolDiscoveryStage,
  reason: string | null,
  wouldAdmitEdges: number,
): ProtocolDiscoveryEvent {
  const aggregate: CandidateAggregate | null = candidate && "candidate" in candidate
    ? candidate as CandidateAggregate
    : null;
  const raw: ProtocolCandidate | null = aggregate?.candidate ?? candidate as ProtocolCandidate | null;
  return {
    event: "protocol_discovery",
    adapterId,
    target: raw?.pool.address ?? null,
    selectors: aggregate?.selectors ?? (raw?.selector === undefined ? [] : [raw.selector]),
    sources: aggregate?.sources ?? (raw?.source === undefined ? [] : [raw.source]),
    verdict,
    stage,
    reason,
    wouldAdmitEdges,
  };
}

function mergeEdges(current: readonly TokenEdge[], additions: readonly TokenEdge[]): TokenEdge[] {
  const merged = [...current];
  const seen = new Set(current.map(protocolEdgeKey));
  for (const edge of additions) {
    const key = protocolEdgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(edge);
  }
  return merged;
}

async function mapLimitDeterministic<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await work(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function safeError(value: unknown): string {
  const message = (value instanceof Error ? value.message : String(value))
    .replace(/https?:\/\/\S+/g, "<redacted-url>");
  return message.slice(0, 240) || "unknown_error";
}

function failMissingDiscoveryAuthority(adapterId: string): never {
  throw new Error(
    `protocol discovery adapter ${adapterId} omitted typed identity authority`,
  );
}

class RetryableProtocolDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableProtocolDiscoveryError";
  }
}

function isRetryableProtocolDiscoveryFailure(value: unknown): boolean {
  // Explicit identity-retryable marker: a strict attestation rejection
  // classified as transient (resource-limited/timeout) is retryable
  // discovery work regardless of the underlying error chain codes.
  const chain = protocolDiscoveryErrorChain(value);
  if (chain.some((item) => item instanceof RetryableProtocolDiscoveryError)) return true;
  if (chain.some(isDeterministicProtocolRpcFailure)) return false;
  const retryableCodes = new Set([
    "NETWORK_ERROR",
    "SERVER_ERROR",
    "TIMEOUT",
    "ABORTED",
    "ABORT_ERR",
    "FAMILY_CIRCUIT_OPEN",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "EPIPE",
  ]);
  for (const item of chain) {
    if (item instanceof RetryableProtocolDiscoveryError) return true;
    const code = item && typeof item === "object" && "code" in item
      ? String((item as { code?: unknown }).code).toUpperCase()
      : "";
    if (
      retryableCodes.has(code) ||
      code.startsWith("ECONN") ||
      code.startsWith("UND_ERR_")
    ) return true;
    const message = item instanceof Error ? item.message : String(item);
    if (
      /abort(?:ed)?|timed?\s*out|rate.?limit|too many requests|fetch failed|network|socket|connection (?:closed|reset|refused)|temporar(?:y|ily) unavailable|\b(?:429|502|503|504)\b/i
        .test(message)
    ) return true;
  }
  return false;
}

function mergeProtocolDiscoveryReadControls(
  parent: ProtocolDiscoveryReadControl | undefined,
  operation: ProtocolDiscoveryReadControl | undefined,
): ProtocolDiscoveryReadControl {
  const deadlines = [parent?.deadlineAtMs, operation?.deadlineAtMs]
    .filter((value): value is number => value !== undefined);
  const deadlineAtMs = deadlines.length > 0 ? Math.min(...deadlines) : undefined;
  const signals = [...new Set(
    [parent?.signal, operation?.signal]
      .filter((value): value is AbortSignal => value !== undefined),
  )];
  const signal = signals.length === 0
    ? undefined
    : signals.length === 1
      ? signals[0]
      : AbortSignal.any(signals);
  const run = composeProtocolDiscoveryReadRunners(
    parent?.run,
    operation?.run,
  );
  return {
    ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    ...(signal === undefined ? {} : { signal }),
    ...(run === undefined ? {} : { run }),
  };
}

function mergeProtocolDiscoveryFamilyGuardOptions(
  options: ProtocolDiscoveryFamilyGuardOptions | undefined,
  control: ProtocolDiscoveryReadControl | undefined,
): ProtocolDiscoveryFamilyGuardOptions {
  const merged = mergeProtocolDiscoveryReadControls(
    {
      ...(options?.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: options.deadlineAtMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.run === undefined ? {} : { run: options.run }),
    },
    control,
  );
  return {
    ...options,
    ...merged,
  };
}

function protocolDiscoveryReadControlFromFamilyOptions(
  options: ProtocolDiscoveryFamilyGuardOptions | undefined,
): ProtocolDiscoveryReadControl {
  return {
    ...(options?.deadlineAtMs === undefined
      ? {}
      : { deadlineAtMs: options.deadlineAtMs }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.run === undefined ? {} : { run: options.run }),
  };
}

function composeProtocolDiscoveryReadRunners(
  first: ProtocolDiscoveryReadControl["run"],
  second: ProtocolDiscoveryReadControl["run"],
): ProtocolDiscoveryReadControl["run"] {
  if (!first) return second;
  if (!second || first === second) return first;
  return async <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    first((firstSignal) =>
      second((secondSignal) =>
        work(
          firstSignal === secondSignal
            ? firstSignal
            : AbortSignal.any([firstSignal, secondSignal]),
        )
      )
    );
}

function throwIfProtocolDiscoveryParentStopped(
  control: ProtocolDiscoveryReadControl | undefined,
): void {
  if (control?.signal?.aborted) {
    throw control.signal.reason ?? Object.assign(
      new Error("protocol discovery parent signal aborted"),
      { code: "ABORTED" },
    );
  }
  if (
    control?.deadlineAtMs !== undefined &&
    Date.now() >= control.deadlineAtMs
  ) {
    throw Object.assign(
      new Error("protocol discovery parent deadline exceeded"),
      { code: "TIMEOUT" },
    );
  }
}

function isDeterministicProtocolRpcFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const code = String(record.code ?? "").toUpperCase();
  if (code === "CALL_EXCEPTION" || Number(record.code) === 3) return true;
  const message = value instanceof Error ? value.message : String(record.message ?? "");
  return /execution reverted|call exception/i.test(message) && record.data !== undefined;
}

function protocolDiscoveryErrorChain(error: unknown): unknown[] {
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
