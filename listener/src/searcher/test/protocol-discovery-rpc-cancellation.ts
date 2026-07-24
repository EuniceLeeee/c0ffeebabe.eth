import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { ethers } from "ethers";
import {
  assertProtocolDiscoveryObservationProviderAligned,
  createPinnedProtocolDiscoveryContext,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
} from "../protocol-instance-discovery.js";
import {
  ProtocolDiscoveryFamilyGuard,
  withProtocolDiscoveryFamilyContext,
} from "../protocol-discovery-family-guard.js";
import { prepareActiveProtocolDiscoveryPass } from "../protocol-discovery-runtime.js";
import { buildStrategyViews } from "../strategy-views.js";
import { IdentityResolverRegistry } from "../venues/identity.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import type { ProtocolDiscoveryReadControl } from "../venues/route-leg-adapter.js";

const HANG_DATA = "0x12345678";
const REVERT_DATA = "0xdeadbeef";
const TX_HASH = `0x${"ab".repeat(32)}`;
const RATE_LIMIT_TX_HASH = `0x${"cd".repeat(32)}`;
const NETWORK_RETRY_TX_HASH = `0x${"ef".repeat(32)}`;
const DEADLINE_TX_HASH = `0x${"12".repeat(32)}`;
const BUDGET_RETRY_TX_HASH = `0x${"34".repeat(32)}`;
const PRUNED_TRACE_TX_HASH = `0x${"35".repeat(32)}`;
const SECOND_PRUNED_TRACE_TX_HASH = `0x${"37".repeat(32)}`;
const NON_PRUNED_TRACE_ERROR_TX_HASH = `0x${"36".repeat(32)}`;
const HEADER_HASH = `0x${"56".repeat(32)}`;
const MISMATCHED_HEADER_HASH = `0x${"78".repeat(32)}`;
let activeResponses = 0;
let peakActiveResponses = 0;
let abortedResponses = 0;
let rateLimitedReceiptAttempts = 0;
let networkReceiptAttempts = 0;
let deadlineReceiptAttempts = 0;
let budgetRetryReceiptAttempts = 0;
let revertAttempts = 0;
const primaryMethods: string[] = [];
const observedHistoryMethods: string[] = [];
let observedHistoryBlockHash = HEADER_HASH;
let activeObservedHistoryTraces = 0;
let peakObservedHistoryTraces = 0;

const rawLog = {
  address: "0x0000000000000000000000000000000000000001",
  topics: [`0x${"12".repeat(32)}`],
  data: "0x",
  transactionHash: TX_HASH,
  blockNumber: "0x1",
};

const server = createServer((request, response) => {
  activeResponses++;
  peakActiveResponses = Math.max(peakActiveResponses, activeResponses);
  trackResponse(response);
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: number;
      method: string;
      params: Array<{ data?: string }>;
    };
    primaryMethods.push(parsed.method);
    if (parsed.method === "eth_getBlockByNumber") {
      respond(response, {
        jsonrpc: "2.0",
        id: parsed.id,
        result: { number: "0x1", hash: HEADER_HASH },
      });
      return;
    }
    if (parsed.method === "eth_getLogs") {
      respond(response, { jsonrpc: "2.0", id: parsed.id, result: [rawLog] });
      return;
    }
    if (parsed.method === "eth_getTransactionReceipt") {
      if (
        parsed.params[0] === BUDGET_RETRY_TX_HASH &&
        budgetRetryReceiptAttempts++ === 0
      ) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      if (parsed.params[0] === DEADLINE_TX_HASH) {
        deadlineReceiptAttempts++;
        setTimeout(() => response.destroy(), 60).unref();
        return;
      }
      if (parsed.params[0] === NETWORK_RETRY_TX_HASH && networkReceiptAttempts++ === 0) {
        response.destroy();
        return;
      }
      if (parsed.params[0] === RATE_LIMIT_TX_HASH && rateLimitedReceiptAttempts++ < 2) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      respond(response, {
        jsonrpc: "2.0",
        id: parsed.id,
        result: { status: "0x1", logs: [rawLog] },
      });
      return;
    }
    if (
      parsed.method === "debug_traceTransaction" &&
      (
        parsed.params[0] === PRUNED_TRACE_TX_HASH ||
        parsed.params[0] === SECOND_PRUNED_TRACE_TX_HASH
      )
    ) {
      respond(response, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: {
          code: -32000,
          message: "state at block #1 is pruned",
        },
      });
      return;
    }
    if (
      parsed.method === "debug_traceTransaction" &&
      parsed.params[0] === NON_PRUNED_TRACE_ERROR_TX_HASH
    ) {
      respond(response, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: {
          code: -32000,
          message: "trace unavailable for fixture",
        },
      });
      return;
    }
    if (parsed.params[0]?.data === REVERT_DATA) {
      revertAttempts++;
      respond(response, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: 3, message: "execution reverted: network 429", data: REVERT_DATA },
      });
      return;
    }
    const timer = setTimeout(() => {
      if (!response.destroyed) {
        respond(response, { jsonrpc: "2.0", id: parsed.id, result: "0x" });
      }
    }, 250);
    timer.unref();
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const observedHistoryServer = createServer((request, response) => {
  activeResponses++;
  peakActiveResponses = Math.max(peakActiveResponses, activeResponses);
  trackResponse(response);
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: number;
      method: string;
    };
    observedHistoryMethods.push(parsed.method);
    const result = parsed.method === "eth_getBlockByNumber"
      ? { number: "0x1", hash: observedHistoryBlockHash }
      : parsed.method === "eth_getLogs"
        ? [rawLog]
        : parsed.method === "eth_getTransactionReceipt"
          ? { status: "0x1", logs: [rawLog] }
          : parsed.method === "debug_traceTransaction"
            ? { type: "CALL", calls: [] }
            : "0x";
    if (parsed.method === "debug_traceTransaction") {
      activeObservedHistoryTraces++;
      peakObservedHistoryTraces = Math.max(
        peakObservedHistoryTraces,
        activeObservedHistoryTraces,
      );
      setTimeout(() => {
        activeObservedHistoryTraces--;
        respond(response, { jsonrpc: "2.0", id: parsed.id, result });
      }, 20).unref();
      return;
    }
    respond(response, { jsonrpc: "2.0", id: parsed.id, result });
  });
});
await new Promise<void>((resolve) =>
  observedHistoryServer.listen(0, "127.0.0.1", resolve)
);
const observedHistoryAddress = observedHistoryServer.address();
assert(observedHistoryAddress && typeof observedHistoryAddress === "object");
const network = ethers.Network.from(1);
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${address.port}`, network, {
  staticNetwork: network,
});
const observedHistoryProvider = new ethers.JsonRpcProvider(
  `http://127.0.0.1:${observedHistoryAddress.port}`,
  network,
  { staticNetwork: network },
);
const context = createPinnedProtocolDiscoveryContext({
  provider,
  blockNumber: 1,
  fromBlock: 1,
  rpcTimeoutMs: 60,
  graphTokens: [],
});
const retryContext = createPinnedProtocolDiscoveryContext({
  provider,
  blockNumber: 1,
  fromBlock: 1,
  rpcTimeoutMs: 1_500,
  graphTokens: [],
});
const deadlineContext = createPinnedProtocolDiscoveryContext({
  provider,
  blockNumber: 1,
  fromBlock: 1,
  rpcTimeoutMs: 80,
  graphTokens: [],
});

try {
  await assertProtocolDiscoveryObservationProviderAligned({
    provider,
    observedHistoryProvider,
    blockNumber: 1,
    rpcTimeoutMs: 1_500,
  });
  const splitContext = createPinnedProtocolDiscoveryContext({
    provider,
    observedHistoryProvider,
    blockNumber: 1,
    fromBlock: 1,
    rpcTimeoutMs: 1_500,
    graphTokens: [],
  });
  const primaryStart = primaryMethods.length;
  const observedHistoryStart = observedHistoryMethods.length;
  await Promise.all([
    splitContext.backend.call({
      to: "0x0000000000000000000000000000000000000001",
      data: "0xabcdef03",
    }),
    splitContext.backend.getCode(
      "0x0000000000000000000000000000000000000001",
    ),
    splitContext.backend.getStorageAt(
      "0x0000000000000000000000000000000000000001",
      0n,
    ),
  ]);
  await splitContext.backend.getLogs({ topics: [], fromBlock: 1, toBlock: 1 });
  await splitContext.backend.getTransactionReceipt(TX_HASH);
  await Promise.all([
    splitContext.backend.traceTransaction(PRUNED_TRACE_TX_HASH),
    splitContext.backend.traceTransaction(SECOND_PRUNED_TRACE_TX_HASH),
  ]);
  assert.deepEqual(
    new Set(primaryMethods.slice(primaryStart)),
    new Set([
      "eth_call",
      "eth_getCode",
      "eth_getStorageAt",
      "eth_getLogs",
      "eth_getTransactionReceipt",
      "debug_traceTransaction",
      "eth_getBlockByNumber",
    ]),
    "current-state and locally available evidence must stay on the primary provider",
  );
  assert.deepEqual(
    new Set(observedHistoryMethods.slice(observedHistoryStart)),
    new Set([
      "eth_getBlockByNumber",
      "debug_traceTransaction",
    ]),
    "the history provider must receive only alignment and the pruned trace fallback",
  );
  assert.equal(
    peakObservedHistoryTraces,
    1,
    "pruned archive traces must be serialized without slowing local traces",
  );
  const historyCallsBeforeNonPrunedError = observedHistoryMethods.length;
  await assert.rejects(
    splitContext.backend.traceTransaction(NON_PRUNED_TRACE_ERROR_TX_HASH),
    /trace unavailable for fixture/,
  );
  assert.equal(
    observedHistoryMethods.length,
    historyCallsBeforeNonPrunedError,
    "non-pruning trace failures must not fall through to the archive provider",
  );
  observedHistoryBlockHash = MISMATCHED_HEADER_HASH;
  await assert.rejects(
    assertProtocolDiscoveryObservationProviderAligned({
      provider,
      observedHistoryProvider,
      blockNumber: 1,
      rpcTimeoutMs: 1_500,
    }),
    /observed-history provider is not aligned at block 1/,
  );
  observedHistoryBlockHash = HEADER_HASH;

  const startedAt = Date.now();
  await assert.rejects(
    context.backend.call({
      to: "0x0000000000000000000000000000000000000001",
      data: HANG_DATA,
    }),
    /protocol discovery eth_call timed out after 60ms/,
  );
  assert(Date.now() - startedAt < 500, "timeout must not wait for the late response");
  await waitUntil(() => abortedResponses === 1 && activeResponses === 0, 500);

  const parent = new AbortController();
  const familyDeadlineAtMs = Date.now() + 35;
  let familyBudgetEntries = 0;
  const familyGuard = new ProtocolDiscoveryFamilyGuard({
    timeoutMs: 200,
    failureThreshold: 1,
    deadlineAtMs: familyDeadlineAtMs,
    signal: parent.signal,
    run: async (work) => {
      familyBudgetEntries++;
      return work(parent.signal);
    },
  });
  let childSignal: AbortSignal | undefined;
  let childDeadlineAtMs: number | undefined;
  const familyStartedAt = Date.now();
  await assert.rejects(
    familyGuard.run("fixture-family", "address-matcher", async (control) => {
      childSignal = control.signal;
      childDeadlineAtMs = control.deadlineAtMs;
      return withProtocolDiscoveryFamilyContext(retryContext, control)
        .backend.call({
          to: "0x0000000000000000000000000000000000000001",
          data: HANG_DATA,
        });
    }),
    /protocol discovery family callback fixture-family\/address-matcher timed out/,
  );
  assert(
    Date.now() - familyStartedAt < 250,
    "the absolute family deadline must abort the underlying fetch",
  );
  assert.equal(
    childDeadlineAtMs,
    familyDeadlineAtMs,
    "the family callback must receive the caller's tighter absolute deadline",
  );
  assert.equal(childSignal?.aborted, true, "the timed-out child signal must abort");
  assert.equal(
    familyBudgetEntries,
    1,
    "family-context provider reads must preserve the shared budget wrapper",
  );
  assert.equal(
    parent.signal.aborted,
    false,
    "a family-local timeout must never abort its parent signal",
  );
  await waitUntil(() => abortedResponses === 2 && activeResponses === 0, 500);

  const cancellingParent = new AbortController();
  const cancellingGuard = new ProtocolDiscoveryFamilyGuard({
    timeoutMs: 500,
    deadlineAtMs: Date.now() + 1_000,
    signal: cancellingParent.signal,
  });
  let cancelledChildSignal: AbortSignal | undefined;
  const parentCancelledCall = cancellingGuard.run(
    "fixture-family-parent-cancel",
    "probe",
    async (control) => {
      cancelledChildSignal = control.signal;
      return withProtocolDiscoveryFamilyContext(retryContext, control)
        .backend.call({
          to: "0x0000000000000000000000000000000000000001",
          data: HANG_DATA,
        });
    },
  );
  await waitUntil(() => activeResponses === 1, 250);
  cancellingParent.abort(new Error("fixture requested pass cancellation"));
  await assert.rejects(
    parentCancelledCall,
    /protocol discovery parent signal aborted/,
  );
  assert(
    cancellingParent.signal.aborted && cancelledChildSignal?.aborted,
    "parent cancellation must abort the child callback and its RPC transport",
  );
  await waitUntil(() => abortedResponses === 3 && activeResponses === 0, 500);

  const contextParent = new AbortController();
  const parentBoundContext = createPinnedProtocolDiscoveryContext({
    provider,
    blockNumber: 1,
    fromBlock: 1,
    rpcTimeoutMs: 5_000,
    graphTokens: [],
    control: {
      deadlineAtMs: Date.now() + 5_000,
      signal: contextParent.signal,
    },
  });
  const operationParent = new AbortController();
  const beforeOperationAbort = abortedResponses;
  const operationCancelledCall = parentBoundContext.backend.call({
    to: "0x0000000000000000000000000000000000000001",
    data: HANG_DATA,
  }, {
    deadlineAtMs: Date.now() + 4_000,
    signal: operationParent.signal,
  });
  await waitUntil(() => activeResponses === 1, 250);
  operationParent.abort(new Error("fixture operation cancelled"));
  await assert.rejects(operationCancelledCall, /fixture operation cancelled/);
  assert.equal(
    contextParent.signal.aborted,
    false,
    "an operation cancellation must not abort the context parent",
  );
  await waitUntil(
    () => abortedResponses === beforeOperationAbort + 1 && activeResponses === 0,
    500,
  );

  const beforeContextAbort = abortedResponses;
  const contextCancelledCall = parentBoundContext.backend.call({
    to: "0x0000000000000000000000000000000000000001",
    data: HANG_DATA,
  });
  await waitUntil(() => activeResponses === 1, 250);
  contextParent.abort(new Error("fixture context parent cancelled"));
  await assert.rejects(contextCancelledCall, /fixture context parent cancelled/);
  await waitUntil(
    () => abortedResponses === beforeContextAbort + 1 && activeResponses === 0,
    500,
  );

  const runtimeParent = new AbortController();
  const runtimeAbortCount = abortedResponses;
  const runtimePass = prepareActiveProtocolDiscoveryPass({
    provider,
    adapters: [erc4626Adapter],
    identityRegistry: new IdentityResolverRegistry([], () => true),
    protocolEdgesEnabled: true,
    currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
    currentBackrunPools: [],
    currentBackrunGraph: [],
    currentBlockscanGraph: [],
    buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
      blockscanMaxPools: 100,
      poolUniverseGeneratedAt: "runtime-cancellation-fixture",
    }),
    blockNumber: 1,
    fromBlock: 1,
    graphTokens: [],
    candidateAddresses: [
      "0x0000000000000000000000000000000000000001",
    ],
    shadow: true,
    control: {
      deadlineAtMs: Date.now() + 5_000,
      signal: runtimeParent.signal,
    },
  });
  await waitUntil(() => activeResponses > 0, 250);
  runtimeParent.abort(new Error("fixture runtime pass cancelled"));
  await assert.rejects(runtimePass, /fixture runtime pass cancelled/);
  await waitUntil(
    () => abortedResponses > runtimeAbortCount && activeResponses === 0,
    500,
  );

  const budgetController = new AbortController();
  let budgetEntries = 0;
  let budgetActive = 0;
  let budgetPeak = 0;
  let budgetTail = Promise.resolve();
  const budgetRun: NonNullable<ProtocolDiscoveryReadControl["run"]> =
    async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const previous = budgetTail;
      let release!: () => void;
      budgetTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      budgetEntries++;
      budgetActive++;
      budgetPeak = Math.max(budgetPeak, budgetActive);
      try {
        return await work(budgetController.signal);
      } finally {
        budgetActive--;
        release();
      }
    };
  const budgetContext = createPinnedProtocolDiscoveryContext({
    provider,
    blockNumber: 1,
    fromBlock: 1,
    rpcTimeoutMs: 1_500,
    graphTokens: [],
    control: {
      deadlineAtMs: Date.now() + 5_000,
      signal: budgetController.signal,
      run: budgetRun,
    },
  });
  peakActiveResponses = 0;
  await Promise.all([
    budgetContext.backend.call({
      to: "0x0000000000000000000000000000000000000001",
      data: "0xabcdef01",
    }),
    budgetContext.backend.call({
      to: "0x0000000000000000000000000000000000000001",
      data: "0xabcdef02",
    }),
  ]);
  assert.equal(budgetEntries, 2, "each HTTP request must enter the read budget");
  assert.equal(budgetPeak, 1, "the fixture budget must serialize provider reads");
  assert.equal(
    peakActiveResponses,
    1,
    "actual HTTP concurrency must obey the read budget, not only callback concurrency",
  );

  const retryBudgetStart = budgetEntries;
  const budgetRetriedReceipt =
    await budgetContext.backend.getTransactionReceipt(BUDGET_RETRY_TX_HASH);
  assert.equal(budgetRetriedReceipt?.status, 1);
  assert.equal(budgetRetryReceiptAttempts, 2);
  assert.equal(
    budgetEntries - retryBudgetStart,
    2,
    "every HTTP retry attempt must re-enter the read budget",
  );

  let operationBudgetEntries = 0;
  const operationBudgetController = new AbortController();
  const parentBudgetStart = budgetEntries;
  await budgetContext.backend.getLogs(
    { topics: [], fromBlock: 1, toBlock: 1 },
    {
      run: async (work) => {
        operationBudgetEntries++;
        return work(operationBudgetController.signal);
      },
    },
  );
  assert.equal(
    budgetEntries - parentBudgetStart,
    1,
    "the context budget must survive operation-control merging",
  );
  assert.equal(
    operationBudgetEntries,
    1,
    "distinct context and operation budgets must compose around one attempt",
  );

  await assert.rejects(
    context.backend.call({
      to: "0x0000000000000000000000000000000000000001",
      data: REVERT_DATA,
    }),
    (error: unknown) => {
      const value = error as { data?: unknown; info?: { error?: { data?: unknown } } };
      return value.data === REVERT_DATA || value.info?.error?.data === REVERT_DATA;
    },
    "cancellable discovery transport must preserve JSON-RPC revert data",
  );
  assert.equal(revertAttempts, 1, "deterministic JSON-RPC revert must not be retried by message text");

  const logs = await context.backend.getLogs({ topics: [], fromBlock: 1, toBlock: 1 });
  assert.equal(logs[0]?.blockNumber, 1, "raw log block quantity must normalize to a number");
  const receipt = await context.backend.getTransactionReceipt(TX_HASH);
  assert.equal(receipt?.status, 1, "raw receipt status quantity must normalize to a number");
  assert.equal(receipt?.logs[0]?.blockNumber, 1, "receipt logs must use the same normalization");
  const retriedReceipt = await retryContext.backend.getTransactionReceipt(RATE_LIMIT_TX_HASH);
  assert.equal(retriedReceipt?.status, 1, "HTTP 429 must retry to the successful receipt response");
  assert.equal(rateLimitedReceiptAttempts, 3, "HTTP 429 retry count must stay bounded");
  const networkRetriedReceipt = await retryContext.backend.getTransactionReceipt(NETWORK_RETRY_TX_HASH);
  assert.equal(networkRetriedReceipt?.status, 1, "nested fetch failure must retry successfully");
  assert.equal(networkReceiptAttempts, 2, "network retry count must stay bounded");

  const deadlineStartedAt = Date.now();
  await assert.rejects(
    deadlineContext.backend.getTransactionReceipt(DEADLINE_TX_HASH),
    /protocol discovery eth_getTransactionReceipt timed out after 80ms/,
  );
  assert(Date.now() - deadlineStartedAt < 250, "transport retries must share one absolute deadline");
  assert.equal(deadlineReceiptAttempts, 1, "retry backoff must not overrun the absolute deadline");
} finally {
  observedHistoryProvider.destroy();
  provider.destroy();
  observedHistoryServer.closeAllConnections();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    observedHistoryServer.close((error) => error ? reject(error) : resolve());
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

console.log("protocol-discovery-rpc-cancellation PASS");

function trackResponse(response: ServerResponse): void {
  let finished = false;
  response.once("finish", () => { finished = true; });
  response.once("close", () => {
    activeResponses--;
    if (!finished) abortedResponses++;
  });
}

function respond(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadlineAtMs = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadlineAtMs) {
      throw new Error(
        `transport did not close: active=${activeResponses} aborted=${abortedResponses}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
