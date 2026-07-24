import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { ethers } from "ethers";
import {
  indexFactoryPools,
  scanActivePoolsDetailed,
} from "../active-pool-discovery.js";
import { buildTokenGraphWithResults } from "../planner/token-graph.js";
import { createPinnedDexReadBackend } from "../runtime-pool-refresh.js";

const UNIV2_SWAP_TOPIC = ethers.id(
  "Swap(address,uint256,uint256,uint256,uint256,address)",
);
const TEST_POOL = ethers.getAddress("0x0000000000000000000000000000000000001234");

interface RpcRequest {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: readonly unknown[];
}

interface RpcFixture {
  readonly url: string;
  readonly methods: string[];
  waitForMethod(method: string): Promise<void>;
  waitForAbortedResponse(method: string): Promise<void>;
  close(): Promise<void>;
}

async function main(): Promise<void> {
  await testFactoryParentAbortClosesTransport();
  await testActivePoolDeadlineClosesTransport();
  await testIdentityParentAbortClosesTransport();
  await testPinnedCallParentAbortClosesTransport();
  await testPinnedGetCodeDeadlineClosesTransport();
  await testGraphControlAbortsPinnedTransport();
  console.log("[dex-discovery-rpc-cancellation] PASS 6/6");
}

async function testFactoryParentAbortClosesTransport(): Promise<void> {
  const fixture = await createRpcFixture((request) =>
    request.method === "eth_getLogs" ? "pending" : "empty");
  const provider = new ethers.JsonRpcProvider(fixture.url);
  const controller = new AbortController();
  const pending = indexFactoryPools(provider, 0, 100, {
    strict: true,
    control: { signal: controller.signal },
  });
  await fixture.waitForMethod("eth_getLogs");
  controller.abort(new Error("test factory abort"));
  await assert.rejects(pending, /test factory abort/);
  await fixture.waitForAbortedResponse("eth_getLogs");
  assert.deepEqual(
    fixture.methods,
    ["eth_getLogs"],
    "an aborted strict factory read must not split/retry after cancellation",
  );
  await provider.destroy();
  await fixture.close();
}

async function testActivePoolDeadlineClosesTransport(): Promise<void> {
  const fixture = await createRpcFixture((request) =>
    request.method === "eth_getLogs" ? "pending" : "empty");
  const provider = new ethers.JsonRpcProvider(fixture.url);
  const pending = scanActivePoolsDetailed(provider, 0, 100, 100, {
    strict: true,
    identityBlockTag: 100,
    control: { deadlineAtMs: Date.now() + 100 },
  });
  await fixture.waitForMethod("eth_getLogs");
  await assert.rejects(pending, /deadline/i);
  await fixture.waitForAbortedResponse("eth_getLogs");
  assert.equal(
    fixture.methods.filter((method) => method === "eth_getLogs").length,
    1,
    "an expired active-pool deadline must not start more HTTP requests",
  );
  await provider.destroy();
  await fixture.close();
}

async function testIdentityParentAbortClosesTransport(): Promise<void> {
  const fixture = await createRpcFixture((request) => {
    if (request.method === "eth_call") return "pending";
    if (request.method !== "eth_getLogs") return "empty";
    const filter = request.params[0] as {
      readonly topics?: readonly unknown[];
    };
    return containsTopic(filter.topics, UNIV2_SWAP_TOPIC)
      ? [{
          address: TEST_POOL,
          topics: [UNIV2_SWAP_TOPIC],
          data: "0x",
          blockNumber: "0x64",
        }]
      : [];
  });
  const provider = new ethers.JsonRpcProvider(fixture.url);
  const controller = new AbortController();
  let budgetedReads = 0;
  const pending = scanActivePoolsDetailed(provider, 0, 100, 100, {
    strict: true,
    identityBlockTag: 100,
    identityBackend: {
      call: () => new Promise<string>(() => {
        throw new Error("controlled scan must not use an uncancellable identity backend");
      }),
    },
    control: {
      signal: controller.signal,
      run: async (work) => {
        budgetedReads++;
        return work(controller.signal);
      },
    },
  });
  await fixture.waitForMethod("eth_call");
  controller.abort(new Error("test identity abort"));
  await assert.rejects(pending, /test identity abort/);
  await fixture.waitForAbortedResponse("eth_call");
  assert.equal(
    budgetedReads,
    fixture.methods.length,
    "every active-pool HTTP request must enter the dedicated read budget",
  );
  await provider.destroy();
  await fixture.close();
}

async function testPinnedCallParentAbortClosesTransport(): Promise<void> {
  const fixture = await createRpcFixture((request) =>
    request.method === "eth_call" ? "pending" : "empty");
  const provider = new ethers.JsonRpcProvider(fixture.url);
  const controller = new AbortController();
  const pinned = createPinnedDexReadBackend(provider, 100, {
    signal: controller.signal,
  });
  const pending = pinned.call({ to: TEST_POOL, data: "0x12345678" });
  await fixture.waitForMethod("eth_call");
  controller.abort(new Error("test pinned call abort"));
  await assert.rejects(pending, /test pinned call abort/);
  await fixture.waitForAbortedResponse("eth_call");
  await provider.destroy();
  await fixture.close();
}

async function testPinnedGetCodeDeadlineClosesTransport(): Promise<void> {
  const fixture = await createRpcFixture((request) =>
    request.method === "eth_getCode" ? "pending" : "empty");
  const provider = new ethers.JsonRpcProvider(fixture.url);
  const pinned = createPinnedDexReadBackend(provider, 100);
  const pending = pinned.getCode(TEST_POOL, {
    deadlineAtMs: Date.now() + 100,
  });
  await fixture.waitForMethod("eth_getCode");
  await assert.rejects(pending, /deadline/i);
  await fixture.waitForAbortedResponse("eth_getCode");
  await provider.destroy();
  await fixture.close();
}

async function testGraphControlAbortsPinnedTransport(): Promise<void> {
  const fixture = await createRpcFixture((request) =>
    request.method === "eth_call" ? "pending" : "empty");
  const provider = new ethers.JsonRpcProvider(fixture.url);
  const controller = new AbortController();
  let budgetedReads = 0;
  const pinned = createPinnedDexReadBackend(provider, 100, {
    run: async (work) => {
      budgetedReads++;
      return work(controller.signal);
    },
  });
  const pending = buildTokenGraphWithResults(
    pinned,
    [{
      address: TEST_POOL,
      adapter: "univ2",
      token0: ethers.getAddress("0x0000000000000000000000000000000000001235"),
      token1: ethers.getAddress("0x0000000000000000000000000000000000001236"),
      factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    }],
    {
      quiet: true,
      deadlineAtMs: Date.now() + 5_000,
      familyTimeoutMs: 5_000,
      signal: controller.signal,
    },
  );
  await fixture.waitForMethod("eth_call");
  controller.abort(new Error("test graph abort"));
  const result = await pending;
  assert.equal(result.successful.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(
    result.failed[0].reason,
    /test graph abort|token-graph aborted|route family univ2-standard aborted/,
  );
  await fixture.waitForAbortedResponse("eth_call");
  assert.equal(
    budgetedReads,
    1,
    "graph projection RPC must enter the pinned backend read budget",
  );
  await provider.destroy();
  await fixture.close();
}

function containsTopic(
  value: readonly unknown[] | undefined,
  topic: string,
): boolean {
  return (value ?? []).some((item) =>
    typeof item === "string"
      ? item.toLowerCase() === topic.toLowerCase()
      : Array.isArray(item)
        ? containsTopic(item, topic)
        : false);
}

async function createRpcFixture(
  respond: (
    request: RpcRequest,
  ) => "pending" | "empty" | readonly Record<string, unknown>[],
): Promise<RpcFixture> {
  const methods: string[] = [];
  const seen = new Map<string, Array<() => void>>();
  const aborted = new Map<string, Array<() => void>>();
  const seenMethods = new Set<string>();
  const abortedMethods = new Set<string>();
  const server = createServer(async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const body = await readBody(req);
    const request = JSON.parse(body) as RpcRequest;
    methods.push(request.method);
    seenMethods.add(request.method);
    resolveWaiters(seen, request.method);
    const result = respond(request);
    if (result === "pending") {
      res.once("close", () => {
        if (res.writableEnded) return;
        abortedMethods.add(request.method);
        resolveWaiters(aborted, request.method);
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: request.id,
      jsonrpc: "2.0",
      result: result === "empty" ? [] : result,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test RPC server did not expose a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    methods,
    waitForMethod: (method) =>
      waitForFlag(seenMethods, seen, method, "request"),
    waitForAbortedResponse: (method) =>
      waitForFlag(abortedMethods, aborted, method, "transport abort"),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function waitForFlag(
  flags: ReadonlySet<string>,
  waiters: Map<string, Array<() => void>>,
  method: string,
  label: string,
): Promise<void> {
  if (flags.has(method)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${method} ${label}`));
    }, 2_000);
    const callbacks = waiters.get(method) ?? [];
    callbacks.push(() => {
      clearTimeout(timer);
      resolve();
    });
    waiters.set(method, callbacks);
  });
}

function resolveWaiters(
  waiters: Map<string, Array<() => void>>,
  method: string,
): void {
  const callbacks = waiters.get(method) ?? [];
  waiters.delete(method);
  for (const callback of callbacks) callback();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
