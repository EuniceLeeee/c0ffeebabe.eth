import assert from "node:assert/strict";
import {
  JsonRpcBlockScanStateReadBackend,
} from "../blockscan-state-read-backend.js";
import type {
  BlockSource,
  StateRead,
  StateReadResult,
} from "../venues/blockscan-state-capability.js";
import {
  createMutationQueryDescriptor,
} from "../venues/blockscan-state-capability.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "../blockscan-multicall.js";

const sourceBlock = 100;
const sourceGeneration = 7;
const sourceBlockHash = `0x${"11".repeat(32)}`;
const otherBlockHash = `0x${"22".repeat(32)}`;
const revertBytes = `0x${"ab".repeat(32)}`;
const targetAddress = "0x0000000000000000000000000000000000000001";
const callerAddress = "0x0000000000000000000000000000000000000002";

await testEip1898StartupProbe();
await testPricingBatchUsesCoordinatorCanonicalFence();
await testPricingBatchCanonicalFailure();
await testPricingBatchAbort();
await testPinnedBatch();
await testLocalDefaultAvoidsMulticall();
await testMixedTransports();
await testMulticallSubcallFailure();
await testMulticallOuterFailureFallsBackPerChunk();
await testMulticallFallbackFailureIsChunkLocal();
await testPreReadHashMismatch();
await testPostReadHashMismatch();
await testAbort();
await testDeadline();
await testMulticallAbortAndDeadline();
await testStrictRevertData();
await testGlobalConcurrencyAcrossPinnedReads();
await testBatchFailureCancelsAndDrainsWorkers();
await testMutationProofBypassesSaturatedStateSlots();
await testMutationProofParentAbort();
await testCanonicalMutationRange();
await testMutationRangeRejectsReorgAndRemovedLog();

console.log("blockscan-state-read-backend PASS");

async function testEip1898StartupProbe(): Promise<void> {
  const calls: RpcRequest[][] = [];
  const backend = backendWith(async (body) => {
    calls.push(body);
    return body.map((request) =>
      request.method === "eth_getBlockByNumber"
        ? success(request.id, { hash: sourceBlockHash })
        : success(request.id, "0x")
    );
  });
  await backend.probeEip1898(
    {
      number: sourceBlock,
      hash: sourceBlockHash,
      generation: sourceGeneration,
    },
    new AbortController().signal,
  );
  assert.deepEqual(
    calls.map((batch) => batch[0]?.method),
    ["eth_getBlockByNumber", "eth_call", "eth_getBlockByNumber"],
  );
  assert.deepEqual(calls[1]?.[0]?.params[1], {
    blockHash: sourceBlockHash,
    requireCanonical: true,
  });

  const unsupported = backendWith(async (body) => body.map(
    (request) => request.method === "eth_call"
      ? failure(request.id, "invalid argument 1: EIP-1898 unsupported")
      : success(request.id, { hash: sourceBlockHash }),
  ));
  await assert.rejects(
    () => unsupported.probeEip1898(
      {
        number: sourceBlock,
        hash: sourceBlockHash,
        generation: sourceGeneration,
      },
      new AbortController().signal,
    ),
    /EIP-1898 startup probe failed/,
  );
  console.log("[state-read-backend] EIP-1898 startup probe: PASS");
}

async function testPricingBatchUsesCoordinatorCanonicalFence(): Promise<void> {
  const calls: RpcRequest[][] = [];
  const backend = backendWith(async (body) => {
    calls.push(body);
    return body.map((request) =>
      success(request.id, `0x${request.params[0].data.slice(2).padEnd(64, "0")}`)
    );
  }, 2);
  const reads = [1, 2, 3, 4, 5].map((value) => read(
    `pricing-${value}`,
    `0x${value.toString(16).padStart(2, "0")}`,
  ));
  const results = await backend.readBatch("swap", reads, control());

  assert.equal(calls.length, 3, "pricing uses only three bounded eth_call batches");
  assert.deepEqual(
    calls.map((batch) => batch.map((request) => request.method)),
    [
      ["eth_call", "eth_call"],
      ["eth_call", "eth_call"],
      ["eth_call"],
    ],
    "pricing must not spend shared RPC slots on per-batch header reads",
  );
  for (const request of calls.flat()) {
    assert.deepEqual(request.params.at(-1), {
      blockHash: sourceBlockHash,
      requireCanonical: true,
    });
  }
  assert(results.every((result) =>
    result.ok &&
    result.provenance.kind === "eip1898" &&
    result.provenance.requireCanonical
  ));
  console.log("[state-read-backend] pricing delegates one canonical CAS: PASS");
}

async function testPricingBatchCanonicalFailure(): Promise<void> {
  const backend = backendWith(async (body) => body.map((request) =>
    failure(request.id, "header not found or not canonical")
  ));
  const results = await backend.readBatch(
    "protocol",
    [read("pricing-reorg", "0x01")],
    control(),
  );
  assertFailure(results[0], "rpc", /not canonical/);
  console.log("[state-read-backend] EIP-1898 pricing reorg fails closed: PASS");
}

async function testPricingBatchAbort(): Promise<void> {
  let fetches = 0;
  const backend = backendWith(async (body, signal) => {
    fetches++;
    assert(body.every((request) => request.method === "eth_call"));
    if (!signal) throw new Error("pricing batch missing AbortSignal");
    return await rejectWhenAborted(signal);
  });
  const controller = new AbortController();
  const pending = backend.readBatch(
    "swap",
    [read("pricing-abort", "0x01")],
    control({ signal: controller.signal }),
  );
  setTimeout(
    () => controller.abort(new Error("pricing generation superseded")),
    10,
  );
  const results = await pending;
  assert.equal(fetches, 1, "pricing abort reaches the in-flight eth_call directly");
  assertFailure(results[0], "aborted", /generation superseded/);
  console.log("[state-read-backend] pricing abort propagation: PASS");
}

async function testPinnedBatch(): Promise<void> {
  const calls: RpcRequest[][] = [];
  const backend = backendWith(async (body) => {
    calls.push(body);
    return body.map((request) => request.method === "eth_getBlockByNumber"
      ? success(request.id, { hash: sourceBlockHash })
      : success(request.id, `0x${request.params[0].data.slice(2).padEnd(64, "0")}`));
  }, 2);
  const reads = [1, 2, 3, 4, 5].map((value) => read(
    `read-${value}`,
    `0x${value.toString(16).padStart(2, "0")}`,
  ));
  const results = await backend.readPinned(reads, control());

  assert.equal(calls.length, 5, "pin-before + three bounded batches + pin-after");
  assert.deepEqual(
    calls.map((batch) => batch.map((request) => request.method)),
    [
      ["eth_getBlockByNumber"],
      ["eth_call", "eth_call"],
      ["eth_call", "eth_call"],
      ["eth_call"],
      ["eth_getBlockByNumber"],
    ],
  );
  for (const request of calls.flat()) {
    if (request.method === "eth_call") {
      assert.deepEqual(request.params.at(-1), {
        blockHash: sourceBlockHash,
        requireCanonical: true,
      }, "all calls use EIP-1898 canonical hash pinning");
    } else {
      assert.equal(request.params.at(-1), false);
    }
  }
  assert.deepEqual(results.map((result) => result.id), reads.map((item) => item.id));
  assert(results.every((result) => result.ok), "all batched reads resolve");
  console.log("[state-read-backend] current-N pin + bounded batch: PASS");
}

async function testLocalDefaultAvoidsMulticall(): Promise<void> {
  const calls: RpcRequest[][] = [];
  const backend = backendWith(async (body) => {
    calls.push(body);
    return body.map((request) =>
      request.method === "eth_getBlockByNumber"
        ? success(request.id, { hash: sourceBlockHash })
        : success(request.id, request.params[0].data)
    );
  }, 2);
  const results = await backend.readPinned([
    read("safe-a", "0x11", { transport: "multicall-safe" }),
    read("safe-b", "0x12", { transport: "multicall-safe" }),
    read("safe-c", "0x13", { transport: "multicall-safe" }),
  ], control());

  const readRequests = calls.slice(1, -1).flat();
  assert.equal(readRequests.length, 3);
  assert(readRequests.every((request) =>
    request.method === "eth_call" &&
    String(request.params[0].to).toLowerCase() ===
      targetAddress.toLowerCase()
  ), "local default must not execute Multicall3");
  assert.deepEqual(
    calls.map((batch) => batch.length),
    [1, 2, 1, 1],
    "pin-before + bounded direct RPC batches + pin-after",
  );
  assert(results.every((result) => result.ok));
  console.log("[state-read-backend] local multicall-safe reads use RPC batch: PASS");
}

async function testMixedTransports(): Promise<void> {
  const calls: RpcRequest[][] = [];
  const multiData = new Map([
    ["0x11", "0xaa"],
    ["0x12", "0xbb"],
    ["0x13", "0xcc"],
  ]);
  const backend = backendWith(async (body) => {
    calls.push(body);
    return body.map((request) => {
      if (request.method === "eth_getBlockByNumber") {
        return success(request.id, { hash: sourceBlockHash });
      }
      const tx = request.params[0] as { to: string; data: string; from?: string };
      if (tx.to.toLowerCase() === BLOCKSCAN_MULTICALL3.toLowerCase()) {
        const decoded = blockScanMulticallIface.decodeFunctionData(
          "aggregate3",
          tx.data,
        )[0] as readonly {
          readonly target: string;
          readonly allowFailure: boolean;
          readonly callData: string;
        }[];
        assert(decoded.length <= 2, "multicall chunk respects maxBatchSize");
        assert(decoded.every((item) => item.allowFailure), "subcalls must fail independently");
        assert(decoded.every((item) =>
          item.target.toLowerCase() === targetAddress.toLowerCase()
        ));
        return success(
          request.id,
          blockScanMulticallIface.encodeFunctionResult("aggregate3", [
            decoded.map((item) => ({
              success: true,
              returnData: multiData.get(item.callData) ?? "0x",
            })),
          ]),
        );
      }
      assert.deepEqual(request.params[1], {
        blockHash: sourceBlockHash,
        requireCanonical: true,
      }, "direct read is pinned to source N hash");
      return success(request.id, tx.data === "0x21" ? "0xdd" : "0xee");
    });
  }, 2, "aggregate3");
  const reads = [
    read("multi-a", "0x11", { transport: "multicall-safe" }),
    read("rpc-a", "0x21", { from: callerAddress }),
    read("multi-b", "0x12", { transport: "multicall-safe" }),
    read("rpc-b", "0x22"),
    read("multi-c", "0x13", { transport: "multicall-safe" }),
  ];
  const results = await backend.readPinned(reads, control());

  assert.deepEqual(
    calls.map((batch) => batch.length),
    [1, 1, 1, 2, 1],
    "pin-before + two multicall chunks + one direct batch + pin-after",
  );
  const readRequests = calls.slice(1, -1).flat();
  const multicalls = readRequests.filter((request) =>
    String(request.params[0].to).toLowerCase() === BLOCKSCAN_MULTICALL3.toLowerCase()
  );
  const direct = readRequests.filter((request) =>
    String(request.params[0].to).toLowerCase() !== BLOCKSCAN_MULTICALL3.toLowerCase()
  );
  assert.equal(multicalls.length, 2);
  assert.equal(direct.length, 2);
  assert.equal(direct[0].params[0].from, callerAddress, "rpc-batch preserves from");
  assert(direct.every((request) =>
    JSON.stringify(request.params[1]) === JSON.stringify({
      blockHash: sourceBlockHash,
      requireCanonical: true,
    })
  ));
  assert(multicalls.every((request) =>
    JSON.stringify(request.params[1]) === JSON.stringify({
      blockHash: sourceBlockHash,
      requireCanonical: true,
    })
  ));
  assert.deepEqual(
    results.map((result) => result.id),
    reads.map((item) => item.id),
    "transport grouping restores original descriptor order",
  );
  assert.deepEqual(
    results.map((result) => result.ok ? result.data : result.error),
    ["0xaa", "0xdd", "0xbb", "0xee", "0xcc"],
  );
  console.log("[state-read-backend] mixed Multicall3/direct transports: PASS");
}

async function testMulticallSubcallFailure(): Promise<void> {
  let multicallSubcalls: readonly { readonly callData: string }[] = [];
  const backend = backendWith(async (body) => body.map((request) => {
    if (request.method === "eth_getBlockByNumber") {
      return success(request.id, { hash: sourceBlockHash });
    }
    const tx = request.params[0] as { to: string; data: string };
    assert.equal(tx.to.toLowerCase(), BLOCKSCAN_MULTICALL3.toLowerCase());
    multicallSubcalls = blockScanMulticallIface.decodeFunctionData(
      "aggregate3",
      tx.data,
    )[0] as readonly { readonly callData: string }[];
    return success(
      request.id,
      blockScanMulticallIface.encodeFunctionResult("aggregate3", [[
        { success: true, returnData: "0x01" },
        { success: false, returnData: revertBytes },
        { success: true, returnData: "0x03" },
      ]]),
    );
  }), 500, "aggregate3");
  const results = await backend.readPinned([
    read("multi-ok-a", "0x01", { transport: "multicall-safe" }),
    read("multi-failed", "0x02", { transport: "multicall-safe" }),
    read("multi-ok-b", "0x03", { transport: "multicall-safe" }),
    read("unsafe-revert", "0x04", {
      transport: "multicall-safe",
      acceptRevertData: true,
    }),
  ], control());

  assert.deepEqual(
    multicallSubcalls.map((item) => item.callData),
    ["0x01", "0x02", "0x03"],
    "acceptRevertData read never enters Multicall3",
  );
  assert(results[0].ok && results[0].data === "0x01");
  assertFailure(results[1], "rpc", /Multicall3 subcall failed/);
  assert(results[2].ok && results[2].data === "0x03");
  assertFailure(results[3], "rpc", /cannot accept revert data/);
  console.log("[state-read-backend] exact subcall failure + revert exclusion: PASS");
}

async function testMulticallOuterFailureFallsBackPerChunk(): Promise<void> {
  const calls: RpcRequest[][] = [];
  let active = 0;
  const backend = new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    maxBatchSize: 2,
    maxConcurrentBatches: 1,
    multicallMode: "aggregate3",
    fetchImpl: (async (_url, init) => {
      active++;
      try {
        const body = JSON.parse(String(init?.body)) as RpcRequest[];
        calls.push(body);
        if (body[0]?.method === "eth_getBlockByNumber") {
          return fakeResponse(
            body.map((request) =>
              success(request.id, { hash: sourceBlockHash })
            ),
          );
        }
        const tx = body[0]?.params[0] as { to: string; data: string };
        if (tx.to.toLowerCase() === BLOCKSCAN_MULTICALL3.toLowerCase()) {
          const decoded = blockScanMulticallIface.decodeFunctionData(
            "aggregate3",
            tx.data,
          )[0] as readonly { readonly callData: string }[];
          if (decoded[0]?.callData === "0x11") {
            return fakeResponse([
              failure(body[0].id, "aggregate execution failed"),
            ]);
          }
          return fakeResponse([
            success(
              body[0].id,
              blockScanMulticallIface.encodeFunctionResult("aggregate3", [
                decoded.map((item) => ({
                  success: true,
                  returnData: `0x${item.callData.slice(2).repeat(2)}`,
                })),
              ]),
            ),
          ]);
        }
        return fakeResponse(
          body.map((request) =>
            success(request.id, `0x${String(request.params[0].data).slice(2).repeat(2)}`)
          ),
        );
      } finally {
        active--;
      }
    }) as typeof fetch,
  });
  const reads = [
    read("fallback-a", "0x11", { transport: "multicall-safe" }),
    read("fallback-b", "0x12", { transport: "multicall-safe" }),
    read("aggregate-a", "0x21", { transport: "multicall-safe" }),
    read("aggregate-b", "0x22", { transport: "multicall-safe" }),
  ];
  const results = await backend.readPinned(reads, control());
  assert.deepEqual(
    results.map((result) => result.id),
    reads.map((item) => item.id),
    "fallback must preserve exact result identity and order",
  );
  assert.deepEqual(
    results.map((result) => result.ok ? result.data : result.error),
    ["0x1111", "0x1212", "0x2121", "0x2222"],
  );
  assert.equal(
    calls.filter((batch) =>
      batch[0]?.method === "eth_call" &&
      String(batch[0].params[0].to).toLowerCase() ===
        BLOCKSCAN_MULTICALL3.toLowerCase()
    ).length,
    2,
    "only the failed aggregate chunk is retried",
  );
  const fallback = calls.find((batch) =>
    batch.length === 2 &&
    batch.every((request) =>
      request.method === "eth_call" &&
      String(request.params[0].to).toLowerCase() ===
        targetAddress.toLowerCase()
    )
  );
  assert(fallback, "failed aggregate chunk must use direct RPC fallback");
  assert(fallback.every((request) =>
    JSON.stringify(request.params[1]) === JSON.stringify({
      blockHash: sourceBlockHash,
      requireCanonical: true,
    })
  ), "fallback calls must retain the exact EIP-1898 source hash");
  assert.equal(active, 0, "successful fallback must leave no orphan transport");
  console.log("[state-read-backend] aggregate outer failure pinned fallback: PASS");
}

async function testMulticallFallbackFailureIsChunkLocal(): Promise<void> {
  const started: string[] = [];
  let active = 0;
  const backend = new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    maxBatchSize: 2,
    maxConcurrentBatches: 1,
    multicallMode: "aggregate3",
    fetchImpl: (async (_url, init) => {
      active++;
      try {
        const body = JSON.parse(String(init?.body)) as RpcRequest[];
        if (body[0]?.method === "eth_getBlockByNumber") {
          return fakeResponse(
            body.map((request) =>
              success(request.id, { hash: sourceBlockHash })
            ),
          );
        }
        const tx = body[0]?.params[0] as { to: string; data: string };
        if (tx.to.toLowerCase() !== BLOCKSCAN_MULTICALL3.toLowerCase()) {
          started.push("fallback-failed");
          throw new Error("fallback HTTP failed");
        }
        const decoded = blockScanMulticallIface.decodeFunctionData(
          "aggregate3",
          tx.data,
        )[0] as readonly { readonly callData: string }[];
        const first = decoded[0]?.callData ?? "";
        started.push(first);
        if (first === "0x31") {
          throw new Error("aggregate HTTP failed");
        }
        return fakeResponse([
          success(
            body[0].id,
            blockScanMulticallIface.encodeFunctionResult("aggregate3", [
              decoded.map((item) => ({
                success: true,
                returnData: `0x${item.callData.slice(2).repeat(2)}`,
              })),
            ]),
          ),
        ]);
      } finally {
        active--;
      }
    }) as typeof fetch,
  });
  const reads = [
    read("failed-a", "0x31", { transport: "multicall-safe" }),
    read("failed-b", "0x32", { transport: "multicall-safe" }),
    read("healthy-a", "0x41", { transport: "multicall-safe" }),
    read("healthy-b", "0x42", { transport: "multicall-safe" }),
  ];
  const results = await backend.readPinned(reads, control());
  assert.deepEqual(
    results.map((result) => result.id),
    reads.map((item) => item.id),
  );
  assertFailure(
    results[0],
    "rpc",
    /aggregate HTTP failed.*fallback HTTP failed/,
  );
  assertFailure(
    results[1],
    "rpc",
    /aggregate HTTP failed.*fallback HTTP failed/,
  );
  assert(results[2].ok && results[2].data === "0x4141");
  assert(results[3].ok && results[3].data === "0x4242");
  assert.deepEqual(
    started,
    ["0x31", "fallback-failed", "0x41"],
    "fallback failure must not cancel the next independent chunk",
  );
  assert.equal(active, 0, "chunk-local failure must leave no orphan transport");
  console.log("[state-read-backend] fallback failure remains chunk-local: PASS");
}

async function testPreReadHashMismatch(): Promise<void> {
  let ethCalls = 0;
  const backend = backendWith(async (body) => body.map((request) => {
    if (request.method === "eth_call") {
      ethCalls++;
      return success(request.id, "0x01");
    }
    return success(request.id, { hash: otherBlockHash });
  }));
  const results = await backend.readPinned([read("pre-mismatch", "0x01")], control());
  assert.equal(ethCalls, 0, "wrong pre-read canonical hash blocks every eth_call");
  assertFailure(results[0], "rpc", /source block hash mismatch/);
  console.log("[state-read-backend] pre-read hash pin: PASS");
}

async function testPostReadHashMismatch(): Promise<void> {
  let pins = 0;
  let ethCalls = 0;
  const backend = backendWith(async (body) => body.map((request) => {
    if (request.method === "eth_call") {
      ethCalls++;
      return success(request.id, "0x01");
    }
    pins++;
    return success(request.id, {
      hash: pins === 1 ? sourceBlockHash : otherBlockHash,
    });
  }));
  const results = await backend.readPinned(
    [read("post-mismatch-a", "0x01"), read("post-mismatch-b", "0x02")],
    control(),
  );
  assert.equal(ethCalls, 2, "reads occur after the valid pre-pin");
  assert.equal(pins, 2, "canonical hash is checked again after reads");
  assertFailure(results[0], "rpc", /source block hash mismatch/);
  assertFailure(results[1], "rpc", /source block hash mismatch/);
  console.log("[state-read-backend] post-read hash pin: PASS");
}

async function testAbort(): Promise<void> {
  let fetches = 0;
  const preAbortedBackend = backendWith(async () => {
    fetches++;
    throw new Error("pre-aborted read must not start fetch");
  });
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled generation"));
  const results = await preAbortedBackend.readPinned(
    [read("aborted", "0x01")],
    control({ signal: controller.signal }),
  );
  assert.equal(fetches, 0);
  assertFailure(results[0], "aborted", /caller cancelled generation/);

  const inFlightController = new AbortController();
  const inFlightBackend = new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    fetchImpl: (async (_url, init) => {
      fetches++;
      if (!init?.signal) throw new Error("abort fetch missing AbortSignal");
      await rejectWhenAborted(init.signal);
      throw new Error("unreachable");
    }) as typeof fetch,
  });
  const pending = inFlightBackend.readPinned(
    [read("in-flight-abort", "0x01")],
    control({ signal: inFlightController.signal }),
  );
  setTimeout(
    () => inFlightController.abort(new Error("superseded generation")),
    10,
  );
  const inFlightResults = await pending;
  assert.equal(fetches, 1, "in-flight abort reaches one pending pin request");
  assertFailure(inFlightResults[0], "aborted", /superseded generation/);
  console.log("[state-read-backend] pre-flight + in-flight caller abort: PASS");
}

async function testDeadline(): Promise<void> {
  let fetches = 0;
  const backend = new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    fetchImpl: (async (_url, init) => {
      fetches++;
      const signal = init?.signal;
      if (!signal) throw new Error("deadline fetch missing AbortSignal");
      await rejectWhenAborted(signal);
      throw new Error("unreachable");
    }) as typeof fetch,
  });
  const started = Date.now();
  const results = await backend.readPinned(
    [read("deadline", "0x01")],
    control({ deadlineAtMs: started + 25 }),
  );
  assert.equal(fetches, 1, "deadline starts exactly one pin request");
  assert(Date.now() - started < 500, "deadline aborts the in-flight transport");
  assertFailure(results[0], "deadline", /deadline/);
  console.log("[state-read-backend] absolute deadline: PASS");
}

async function testMulticallAbortAndDeadline(): Promise<void> {
  const run = async (
    label: string,
    abort: (controller: AbortController) => void,
    deadlineAtMs: number,
    expectedKind: "aborted" | "deadline",
  ): Promise<void> => {
    let fetches = 0;
    const backend = backendWith(async (body, signal) => {
      fetches++;
      if (body[0].method === "eth_getBlockByNumber") {
        return [success(body[0].id, { hash: sourceBlockHash })];
      }
      assert.equal(
        String(body[0].params[0].to).toLowerCase(),
        BLOCKSCAN_MULTICALL3.toLowerCase(),
        `${label} must block inside the aggregate3 transport`,
      );
      if (!signal) throw new Error(`${label} multicall missing AbortSignal`);
      return await rejectWhenAborted(signal);
    }, 500, "aggregate3");
    const controller = new AbortController();
    const pending = backend.readPinned(
      [read(label, "0x01", { transport: "multicall-safe" })],
      control({ signal: controller.signal, deadlineAtMs }),
    );
    abort(controller);
    const results = await pending;
    assert.equal(fetches, 2, `${label} performs pin then one aggregate3 request`);
    assertFailure(results[0], expectedKind);
  };

  await run(
    "multicall-abort",
    (controller) => setTimeout(
      () => controller.abort(new Error("multicall generation superseded")),
      10,
    ),
    Date.now() + 10_000,
    "aborted",
  );
  const deadlineStarted = Date.now();
  await run(
    "multicall-deadline",
    () => {},
    deadlineStarted + 25,
    "deadline",
  );
  assert(Date.now() - deadlineStarted < 500, "deadline cancels aggregate3 transport");
  console.log("[state-read-backend] Multicall3 abort + deadline propagation: PASS");
}

async function testStrictRevertData(): Promise<void> {
  const backend = backendWith(async (body) => body.map((request) => {
    if (request.method === "eth_getBlockByNumber") {
      return success(request.id, { hash: sourceBlockHash });
    }
    const data = request.params[0].data;
    if (data === "0x01" || data === "0x02") {
      return failure(request.id, "execution reverted", revertBytes);
    }
    if (data === "0x03") {
      return failure(request.id, "ordinary RPC failure");
    }
    if (data === "0x04") {
      return failure(request.id, "nested data is not raw bytes", { data: revertBytes });
    }
    return failure(request.id, "odd-length data is malformed", "0xabc");
  }));
  const results = await backend.readPinned([
    read("accepted", "0x01", true),
    read("not-opted-in", "0x02", false),
    read("ordinary-error", "0x03", true),
    read("nested-error-data", "0x04", true),
    read("malformed-error-data", "0x05", true),
  ], control());

  assert.deepEqual(results[0], {
    id: "accepted",
    ok: true,
    sourceBlock,
    sourceBlockHash,
    provenance: {
      kind: "eip1898",
      source: {
        number: sourceBlock,
        hash: sourceBlockHash,
        generation: sourceGeneration,
      },
      requireCanonical: true,
    },
    data: revertBytes,
  });
  for (const result of results.slice(1)) {
    assertFailure(result, "rpc");
  }
  console.log("[state-read-backend] strict opt-in revert bytes + ordinary fail-closed: PASS");
}

async function testGlobalConcurrencyAcrossPinnedReads(): Promise<void> {
  let active = 0;
  let maxActive = 0;
  const backend = new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    maxBatchSize: 1,
    maxConcurrentBatches: 2,
    fetchImpl: (async (_url, init) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const body = JSON.parse(String(init?.body)) as RpcRequest[];
        return fakeResponse(body.map((request) =>
          request.method === "eth_getBlockByNumber"
            ? success(request.id, { hash: sourceBlockHash })
            : success(request.id, "0x01")
        ));
      } finally {
        active--;
      }
    }) as typeof fetch,
  });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      backend.readPinned(
        [read(`global-${index}`, `0x${(index + 1).toString(16).padStart(2, "0")}`)],
        control(),
      )
    ),
  );
  assert(results.flat().every((result) => result.ok));
  assert.equal(
    maxActive,
    2,
    "all concurrent pricing/funding-style readPinned calls share one absolute RPC cap",
  );
  console.log("[state-read-backend] shared global RPC semaphore: PASS");
}

async function testBatchFailureCancelsAndDrainsWorkers(): Promise<void> {
  let active = 0;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  const startedData: string[] = [];
  let inFlightSignal: AbortSignal | undefined;
  const backend = new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    maxBatchSize: 1,
    maxConcurrentBatches: 2,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest[];
      const data = String(body[0]?.params[0]?.data);
      startedData.push(data);
      active++;
      try {
        if (data === "0x01") {
          await secondStarted;
          throw new Error("first chunk exploded");
        }
        if (data === "0x02") {
          const signal = init?.signal;
          if (!signal) throw new Error("in-flight chunk missing AbortSignal");
          inFlightSignal = signal;
          markSecondStarted();
          await rejectWhenAborted(signal);
        }
        throw new Error(`unexpected later chunk ${data}`);
      } finally {
        active--;
      }
    }) as typeof fetch,
  });
  const results = await backend.readBatch(
    "swap",
    [
      read("fail-first", "0x01"),
      read("cancel-in-flight", "0x02"),
      read("must-not-start-1", "0x03"),
      read("must-not-start-2", "0x04"),
    ],
    control(),
  );
  assert.deepEqual(
    startedData.sort(),
    ["0x01", "0x02"],
    "the first chunk error must stop workers from claiming later chunks",
  );
  assert.equal(
    inFlightSignal?.aborted,
    true,
    "the first chunk error must cancel already-started sibling transport",
  );
  assert.equal(
    active,
    0,
    "readBatch must not return before every started worker settles",
  );
  for (const result of results) {
    assertFailure(result, "rpc", /first chunk exploded/);
  }
  console.log("[state-read-backend] first-error cancellation + drain: PASS");
}

async function testMutationProofBypassesSaturatedStateSlots(): Promise<void> {
  const previousHash = `0x${"10".repeat(32)}`;
  const descriptor = createMutationQueryDescriptor({
    topics: [[`0x${"aa".repeat(32)}`]],
  });
  let markNormalStarted!: () => void;
  const normalStarted = new Promise<void>((resolve) => {
    markNormalStarted = resolve;
  });
  let releaseNormal!: () => void;
  const normalRelease = new Promise<void>((resolve) => {
    releaseNormal = resolve;
  });
  let normalInFlight = false;
  let proofRequestsWhileNormalInFlight = 0;
  const backend = new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    maxBatchSize: 1,
    maxConcurrentBatches: 1,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest[];
      if (body.every((request) => request.method === "eth_call")) {
        normalInFlight = true;
        markNormalStarted();
        try {
          await normalRelease;
          return fakeResponse(body.map((request) => success(request.id, "0x01")));
        } finally {
          normalInFlight = false;
        }
      }
      if (normalInFlight) proofRequestsWhileNormalInFlight++;
      return fakeResponse(body.map((request) => {
        if (request.method === "eth_getLogs") {
          return success(request.id, []);
        }
        assert.equal(request.method, "eth_getBlockByNumber");
        const number = Number(BigInt(request.params[0]));
        return success(request.id, {
          number: request.params[0],
          hash: number === sourceBlock - 1 ? previousHash : sourceBlockHash,
          parentHash: number === sourceBlock
            ? previousHash
            : `0x${"09".repeat(32)}`,
        });
      }));
    }) as typeof fetch,
  });
  const normal = backend.readBatch(
    "swap",
    [read("saturated-normal-slot", "0x01")],
    control(),
  );
  await normalStarted;

  const range = await backend.readCanonicalMutationRange(
    descriptor,
    {
      number: sourceBlock - 1,
      hash: previousHash,
      generation: sourceGeneration - 1,
    },
    {
      number: sourceBlock,
      hash: sourceBlockHash,
      generation: sourceGeneration,
    },
    {
      deadlineAtMs: Date.now() + 250,
      signal: new AbortController().signal,
    },
  ).finally(releaseNormal);
  const normalResults = await normal;
  assert.equal(range.complete, true);
  assert.equal(range.events.length, 0);
  assert.equal(
    proofRequestsWhileNormalInFlight,
    3,
    "headers, logs and final canonical CAS must bypass the saturated bulk FIFO",
  );
  assert(normalResults.every((result) => result.ok));
  console.log("[state-read-backend] mutation proof reserved RPC slot: PASS");
}

async function testMutationProofParentAbort(): Promise<void> {
  const previousHash = `0x${"10".repeat(32)}`;
  const descriptor = createMutationQueryDescriptor({
    topics: [[`0x${"aa".repeat(32)}`]],
  });
  let markProofStarted!: () => void;
  const proofStarted = new Promise<void>((resolve) => {
    markProofStarted = resolve;
  });
  const observed: { proofSignal?: AbortSignal } = {};
  const backend = new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest[];
      assert(body.every((request) =>
        request.method === "eth_getBlockByNumber"
      ));
      const proofSignal = init?.signal;
      if (!proofSignal) throw new Error("mutation proof missing AbortSignal");
      observed.proofSignal = proofSignal;
      markProofStarted();
      await rejectWhenAborted(proofSignal);
      throw new Error("unreachable");
    }) as typeof fetch,
  });
  const parent = new AbortController();
  const pending = backend.readCanonicalMutationRange(
    descriptor,
    {
      number: sourceBlock - 1,
      hash: previousHash,
      generation: sourceGeneration - 1,
    },
    {
      number: sourceBlock,
      hash: sourceBlockHash,
      generation: sourceGeneration,
    },
    {
      deadlineAtMs: Date.now() + 10_000,
      signal: parent.signal,
    },
  );
  await proofStarted;
  parent.abort(new Error("mutation proof parent cancelled"));
  await assert.rejects(() => pending, /mutation proof parent cancelled/);
  assert.equal(observed.proofSignal?.aborted, true);
  console.log("[state-read-backend] mutation proof parent abort: PASS");
}

async function testCanonicalMutationRange(): Promise<void> {
  const previousHash = `0x${"10".repeat(32)}`;
  const descriptor = createMutationQueryDescriptor({
    topics: [[`0x${"aa".repeat(32)}`]],
  });
  const calls: RpcRequest[][] = [];
  const backend = backendWith(async (body) => {
    calls.push(body);
    return body.map((request) => {
      if (request.method === "eth_getBlockByNumber") {
        const number = Number(BigInt(request.params[0]));
        return success(request.id, {
          number: request.params[0],
          hash: number === sourceBlock - 1 ? previousHash : sourceBlockHash,
          parentHash: number === sourceBlock
            ? previousHash
            : `0x${"09".repeat(32)}`,
        });
      }
      assert.equal(request.method, "eth_getLogs");
      assert.deepEqual(request.params[0], {
        fromBlock: "0x64",
        toBlock: "0x64",
        topics: descriptor.topics,
      });
      return success(request.id, [{
        blockNumber: "0x64",
        blockHash: sourceBlockHash,
        transactionIndex: "0x2",
        logIndex: "0x3",
        address: targetAddress,
        topics: [`0x${"aa".repeat(32)}`],
        data: "0x1234",
        removed: false,
      }]);
    });
  });
  const previous: BlockSource = {
    number: sourceBlock - 1,
    hash: previousHash,
    generation: sourceGeneration - 1,
  };
  const through: BlockSource = {
    number: sourceBlock,
    hash: sourceBlockHash,
    generation: sourceGeneration,
  };
  const range = await backend.readCanonicalMutationRange(
    descriptor,
    previous,
    through,
    {
      deadlineAtMs: Date.now() + 10_000,
      signal: new AbortController().signal,
    },
  );
  assert.equal(range.complete, true);
  assert.equal(range.events.length, 1);
  assert.equal(range.events[0].transactionIndex, 2);
  assert.equal(range.events[0].logIndex, 3);
  assert.equal(range.fromExclusive.hash, previousHash);
  assert.equal(range.through.hash, sourceBlockHash);
  assert.match(range.canonicalPathFingerprint, /^[0-9a-f]{64}$/);
  assert.match(range.rangeFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    calls.map((batch) => batch.map((request) => request.method)),
    [
      ["eth_getBlockByNumber", "eth_getBlockByNumber"],
      ["eth_getLogs"],
      ["eth_getBlockByNumber"],
    ],
  );
  console.log("[state-read-backend] canonical mutation range proof: PASS");
}

async function testMutationRangeRejectsReorgAndRemovedLog(): Promise<void> {
  const previousHash = `0x${"10".repeat(32)}`;
  const descriptor = createMutationQueryDescriptor({
    topics: [[`0x${"aa".repeat(32)}`]],
  });
  const previous: BlockSource = {
    number: sourceBlock - 1,
    hash: previousHash,
    generation: sourceGeneration - 1,
  };
  const through: BlockSource = {
    number: sourceBlock,
    hash: sourceBlockHash,
    generation: sourceGeneration,
  };
  const reorg = backendWith(async (body) => body.map((request) => {
    assert.equal(request.method, "eth_getBlockByNumber");
    const number = Number(BigInt(request.params[0]));
    return success(request.id, {
      number: request.params[0],
      hash: number === sourceBlock - 1 ? otherBlockHash : sourceBlockHash,
      parentHash: number === sourceBlock ? otherBlockHash : `0x${"09".repeat(32)}`,
    });
  }));
  await assert.rejects(
    () => reorg.readCanonicalMutationRange(descriptor, previous, through, {
      deadlineAtMs: Date.now() + 10_000,
      signal: new AbortController().signal,
    }),
    /previous source is no longer canonical/,
  );

  const removed = backendWith(async (body) => body.map((request) => {
    if (request.method === "eth_getBlockByNumber") {
      const number = Number(BigInt(request.params[0]));
      return success(request.id, {
        number: request.params[0],
        hash: number === sourceBlock - 1 ? previousHash : sourceBlockHash,
        parentHash: number === sourceBlock
          ? previousHash
          : `0x${"09".repeat(32)}`,
      });
    }
    return success(request.id, [{
      blockNumber: "0x64",
      blockHash: sourceBlockHash,
      transactionIndex: "0x0",
      logIndex: "0x0",
      address: targetAddress,
      topics: [`0x${"aa".repeat(32)}`],
      data: "0x",
      removed: true,
    }]);
  }));
  await assert.rejects(
    () => removed.readCanonicalMutationRange(descriptor, previous, through, {
      deadlineAtMs: Date.now() + 10_000,
      signal: new AbortController().signal,
    }),
    /marked removed/,
  );
  console.log("[state-read-backend] mutation reorg/removed fail closed: PASS");
}

function backendWith(
  responder: (body: RpcRequest[], signal: AbortSignal | null) => Promise<unknown[]>,
  maxBatchSize = 500,
  multicallMode: "rpc-batch" | "aggregate3" = "rpc-batch",
): JsonRpcBlockScanStateReadBackend {
  return new JsonRpcBlockScanStateReadBackend("http://unit.test", {
    maxBatchSize,
    multicallMode,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as RpcRequest[];
      const payload = await responder(body, init?.signal ?? null);
      return fakeResponse(payload);
    }) as typeof fetch,
  });
}

function fakeResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  } as Response;
}

function read(
  id: string,
  data: string,
  options: {
    readonly transport?: StateRead["transport"];
    readonly from?: string;
    readonly acceptRevertData?: boolean;
  } | boolean = {},
): StateRead {
  const normalized = typeof options === "boolean"
    ? { acceptRevertData: options }
    : options;
  return {
    id,
    sourceBlock,
    sourceBlockHash,
    to: targetAddress,
    data,
    transport: normalized.transport ?? "rpc-batch",
    ...(normalized.from === undefined ? {} : { from: normalized.from }),
    ...(normalized.acceptRevertData === undefined
      ? {}
      : { acceptRevertData: normalized.acceptRevertData }),
  };
}

function control(overrides: {
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
} = {}): {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly sourceGeneration: number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
} {
  return {
    sourceBlock,
    sourceBlockHash,
    sourceGeneration,
    deadlineAtMs: overrides.deadlineAtMs ?? Date.now() + 10_000,
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function assertFailure(
  result: StateReadResult | undefined,
  kind: "rpc" | "deadline" | "aborted",
  message?: RegExp,
): void {
  assert(result && !result.ok, `expected ${kind} failure`);
  assert.equal(result.kind, kind);
  if (message) assert.match(result.error, message);
}

function success(id: number, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: number, message: string, data?: unknown): object {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

async function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: "eth_call" | "eth_getBlockByNumber" | "eth_getLogs";
  readonly params: readonly any[];
}
