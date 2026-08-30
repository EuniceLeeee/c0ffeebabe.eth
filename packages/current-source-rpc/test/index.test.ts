import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  assertIssuedCurrentSourceRpcLogicalScopeFactsV1,
  assertIssuedCurrentSourceRpcPhysicalFactsV1,
  currentSourceRpcLogicalScopeFactsRoot,
  CurrentSourceRpcReadTransport,
  type CurrentSourceRpcPhysicalFactsV1,
  type CurrentSourceRpcReasonCode,
} from "../src/index.ts";

const hash = (value: string): Hash => hashDomain("test/current-source-rpc", value);
type TestSource = {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
};
const source: TestSource = Object.freeze({
  chainId: "1",
  number: "100",
  hash: hash("block"),
  stateRoot: hash("state"),
});
const request = Object.freeze({
  kind: "family-search.current-source-read" as const,
  requestId: hash("request"),
  source,
  target: "0x1111111111111111111111111111111111111111",
  data: "0xdeadBEEF",
  responseEncoding: "hex",
});
const declaredRevertData = Object.freeze({
  kind: "declared-revert-data" as const,
  dataEncoding: "abi-test-custom-error" as const,
  selector: "0xb3bfda99" as const,
  byteLength: 36,
});
const declaredRequest = Object.freeze({ ...request, requestId: hash("declared-request"), declaredRevertData });
const declaredPayload = `0xb3bfda99${"0".repeat(63)}1`;

type Handler = (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void | Promise<void>;

async function withServer(handler: Handler, run: (endpoint: string) => Promise<void>): Promise<void> {
  const server = createServer((incoming, outgoing) => {
    void handler(incoming, outgoing);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind a port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function bodyOf(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => resolve(body));
    incoming.on("error", reject);
  });
}

function session(input: {
  readonly assertCurrent?: () => void | Promise<void>;
  readonly source?: TestSource;
}) {
  return {
    source: input.source ?? source,
    assertCurrent: input.assertCurrent ?? (() => undefined),
  };
}

function reason(result: Awaited<ReturnType<CurrentSourceRpcReadTransport["read"]>>): CurrentSourceRpcReasonCode | null {
  return result.kind === "unavailable" ? result.reasonCode as CurrentSourceRpcReasonCode : null;
}

test("rejects synthetic object response encodings before any physical RPC", async () => {
  const transport = new CurrentSourceRpcReadTransport({
    endpoint: "http://127.0.0.1:1",
    currentSource: session({}),
  });
  await assert.rejects(
    transport.read({
      request: { ...request, responseEncoding: "canonical-json" } as never,
    }),
    /must describe raw hex or ABI return bytes/,
  );
  assert.equal(transport.stats().physicalBuilds, 0);
});

test("emits an exact EIP-1898 eth_call and preserves returned bytes", async () => {
  let assertCount = 0;
  await withServer(async (incoming, outgoing) => {
    assert.equal(incoming.method, "POST");
    assert.equal(incoming.headers["content-type"], "application/json");
    const raw = await bodyOf(incoming);
    const payload = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(payload, {
      jsonrpc: "2.0",
      id: request.requestId,
      method: "eth_call",
      params: [
        { to: request.target, data: request.data },
        { blockHash: source.hash, requireCanonical: true },
      ],
    });
    assert.equal(JSON.stringify(payload), raw);
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0xAAbb" }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({
      endpoint,
      currentSource: session({ assertCurrent: () => { assertCount += 1; } }),
    });
    const result = await transport.read({ request });
    assert.deepEqual(result, { kind: "returned", requestId: request.requestId, source, dataHex: "0xAAbb" });
    assert.equal(assertCount, 2);
  });
});

test("a stale source before the request is unavailable and no HTTP call is made", async () => {
  let calls = 0;
  await withServer(async (_incoming, outgoing) => {
    calls += 1;
    outgoing.writeHead(200);
    outgoing.end();
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({
      endpoint,
      currentSource: session({ assertCurrent: () => { throw new Error("reorg"); } }),
    });
    const result = await transport.read({ request });
    assert.equal(reason(result), "source-stale");
    assert.equal(calls, 0);
  });
});

test("abort and deadline abort the physical HTTP request with distinct reasons", async () => {
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  await withServer(async (incoming) => {
    started();
    await new Promise<void>((resolve) => incoming.on("aborted", () => resolve()));
  }, async (endpoint) => {
    const controller = new AbortController();
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}), timeoutMs: 500 });
    const pending = transport.read({ request, signal: controller.signal });
    await requestStarted;
    controller.abort("test abort");
    assert.equal(reason(await pending), "abort");
  });

  let deadlineStarted!: () => void;
  const deadlineRequestStarted = new Promise<void>((resolve) => { deadlineStarted = resolve; });
  await withServer(async () => {
    deadlineStarted();
    await new Promise<void>(() => undefined);
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}), timeoutMs: 10 });
    const pending = transport.read({ request });
    await deadlineRequestStarted;
    assert.equal(reason(await pending), "deadline");
  });
});

test("JSON-RPC error and malformed response never become hand-written success", async () => {
  await withServer(async (_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({
      jsonrpc: "2.0",
      id: request.requestId,
      error: { code: -32000, message: "execution reverted" },
    }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    assert.equal(reason(await transport.read({ request })), "rpc");
  });

  await withServer(async (_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0x01", extra: true }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    assert.equal(reason(await transport.read({ request })), "malformed-response");
  });
});

test("only an explicitly declared exact custom-error payload becomes a reverted transport fact", async () => {
  await withServer(async (_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({
      jsonrpc: "2.0",
      id: declaredRequest.requestId,
      error: { code: 3, message: "opaque provider text", data: declaredPayload },
    }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    assert.deepEqual(await transport.read({ request: declaredRequest }), {
      kind: "reverted",
      reasonCode: "declared-revert-data",
      requestId: declaredRequest.requestId,
      source,
      rpcErrorCode: 3,
      dataEncoding: declaredRevertData.dataEncoding,
      dataHex: declaredPayload,
    });
  });

  await withServer(async (_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, error: { code: 3, message: "execution reverted", data: declaredPayload } }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    assert.equal(reason(await transport.read({ request })), "rpc");
  });
});

test("declared revert data rejects malformed code, nested data, wrong selector and wrong length", async () => {
  const cases = [
    { error: { code: "3", message: "execution reverted", data: declaredPayload }, reason: "malformed-response" },
    { error: { code: 3, message: "execution reverted", data: { data: declaredPayload } }, reason: "malformed-response" },
    { error: { code: 3, message: "execution reverted", data: `0xdeadbeef${"0".repeat(64)}` }, reason: "rpc" },
    { error: { code: 3, message: "execution reverted", data: "0xb3bfda99" }, reason: "rpc" },
  ] as const;
  for (const item of cases) {
    await withServer(async (_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: declaredRequest.requestId, error: item.error }));
    }, async (endpoint) => {
      const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
      assert.equal(reason(await transport.read({ request: declaredRequest })), item.reason);
    });
  }
});

test("declared revert outcome remains behind the post-read current-source fence", async () => {
  let assertions = 0;
  const current = session({ assertCurrent: () => { assertions += 1; if (assertions === 2) throw new Error("reorg"); } });
  await withServer(async (_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: declaredRequest.requestId, error: { code: -32000, message: "execution reverted", data: declaredPayload } }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: current });
    assert.equal(reason(await transport.read({ request: declaredRequest })), "source-stale");
    assert.equal(assertions, 2);
  });
});

test("declared completion is part of the WorkKey and cannot leak into an ordinary Family read", async () => {
  let calls = 0;
  await withServer(async (_incoming, outgoing) => {
    calls += 1;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: declaredRequest.requestId, error: { code: 3, message: "execution reverted", data: declaredPayload } }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    assert.equal((await transport.read({ request: declaredRequest })).kind, "reverted");
    const ordinary = Object.freeze({ ...request, requestId: declaredRequest.requestId });
    assert.equal(reason(await transport.read({ request: ordinary })), "rpc");
    assert.equal(calls, 2);
  });
});

test("source mutation after the physical response fails closed", async () => {
  const changed = Object.freeze({ ...source, number: "101" });
  let assertCount = 0;
  const current = {
    source,
    assertCurrent() {
      assertCount += 1;
      if (assertCount === 2) (current as { source: typeof source }).source = changed;
    },
  };
  await withServer(async (_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0x01" }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: current });
    const result = await transport.read({ request });
    assert.equal(reason(result), "source-stale");
    assert.equal(assertCount, 2);
  });
});

test("same semantic read joins one physical call, keeps both fences, then settles", async () => {
  let calls = 0;
  let release!: () => void;
  const responseReady = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let fenceChecks = 0;
  await withServer(async (_incoming, outgoing) => {
    calls += 1;
    started();
    await responseReady;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0xBEEF" }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({
      endpoint,
      currentSource: session({ assertCurrent: () => { fenceChecks += 1; } }),
    });
    const first = transport.read({ request });
    const second = transport.read({ request: { ...request } });
    await requestStarted;
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), [
      { kind: "returned", requestId: request.requestId, source, dataHex: "0xBEEF" },
      { kind: "returned", requestId: request.requestId, source, dataHex: "0xBEEF" },
    ]);
    // Two logical reads each perform a pre- and post-current-source fence.
    assert.equal(fenceChecks, 4);
    assert.deepEqual(transport.stats(), {
      logicalReads: 2,
      physicalBuilds: 1,
      settledHits: 0,
      inFlightJoins: 1,
      buildFailures: 0,
      invalidResults: 0,
      consumerAborts: 0,
      consumerDeadlines: 0,
      physicalAborts: 0,
      settledEntries: 1,
      inFlightEntries: 0,
      consumers: 0,
    });

    const settled = await transport.read({ request });
    assert.equal(settled.kind, "returned");
    assert.equal(calls, 1);
    assert.deepEqual(transport.stats(), {
      logicalReads: 3,
      physicalBuilds: 1,
      settledHits: 1,
      inFlightJoins: 1,
      buildFailures: 0,
      invalidResults: 0,
      consumerAborts: 0,
      consumerDeadlines: 0,
      physicalAborts: 0,
      settledEntries: 1,
      inFlightEntries: 0,
      consumers: 0,
    });
  });
});

test("one consumer abort does not cancel a joined consumer and both run post fences", async () => {
  let calls = 0;
  let release!: () => void;
  const responseReady = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let fenceChecks = 0;
  await withServer(async (_incoming, outgoing) => {
    calls += 1;
    started();
    await responseReady;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0xCAFE" }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({
      endpoint,
      currentSource: session({ assertCurrent: () => { fenceChecks += 1; } }),
    });
    const aborted = new AbortController();
    const first = transport.read({ request, signal: aborted.signal });
    const second = transport.read({ request: { ...request } });
    await requestStarted;
    aborted.abort("logical-cancel");
    const firstResult = await first;
    assert.equal(reason(firstResult), "abort");
    assert.equal(calls, 1);
    release();
    const secondResult = await second;
    assert.equal(secondResult.kind, "returned");
    assert.equal(fenceChecks, 4);
    assert.deepEqual(transport.stats(), {
      logicalReads: 2,
      physicalBuilds: 1,
      settledHits: 0,
      inFlightJoins: 1,
      buildFailures: 0,
      invalidResults: 0,
      consumerAborts: 1,
      consumerDeadlines: 0,
      physicalAborts: 0,
      settledEntries: 1,
      inFlightEntries: 0,
      consumers: 0,
    });
  });
});

test("one consumer deadline does not cancel a joined consumer", async () => {
  let calls = 0;
  let release!: () => void;
  const responseReady = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let fenceChecks = 0;
  await withServer(async (_incoming, outgoing) => {
    calls += 1;
    started();
    await responseReady;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0xD00D" }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({ assertCurrent: () => { fenceChecks += 1; } }) });
    const deadlineAtMs = performance.now() + 500;
    const first = transport.read({ request, deadlineAtMs });
    const second = transport.read({ request: { ...request } });
    await requestStarted;
    assert.equal(transport.stats().inFlightJoins, 1, "both logical consumers must be admitted before the deadline is observed");
    assert.equal(transport.stats().consumers, 2);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadlineAtMs - performance.now()) + 20));
    assert.equal(reason(await first), "deadline");
    assert.equal(calls, 1);
    release();
    assert.equal((await second).kind, "returned");
    assert.equal(fenceChecks, 4);
    assert.deepEqual(transport.stats(), {
      logicalReads: 2,
      physicalBuilds: 1,
      settledHits: 0,
      inFlightJoins: 1,
      buildFailures: 0,
      invalidResults: 0,
      consumerAborts: 0,
      consumerDeadlines: 1,
      physicalAborts: 0,
      settledEntries: 1,
      inFlightEntries: 0,
      consumers: 0,
    });
  });
});

test("malformed and JSON-RPC failure results are not settled-cache hits", async () => {
  let calls = 0;
  await withServer(async (_incoming, outgoing) => {
    calls += 1;
    outgoing.writeHead(200, { "content-type": "application/json" });
    if (calls === 1) {
      outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0x01", extra: true }));
      return;
    }
    if (calls === 2) {
      outgoing.end(JSON.stringify({
        jsonrpc: "2.0",
        id: request.requestId,
        error: { code: -32000, message: "temporary execution failure" },
      }));
      return;
    }
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0x02" }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    assert.equal(reason(await transport.read({ request })), "malformed-response");
    assert.equal(reason(await transport.read({ request })), "rpc");
    const recovered = await transport.read({ request });
    assert.deepEqual(recovered, { kind: "returned", requestId: request.requestId, source, dataHex: "0x02" });
    assert.equal(calls, 3);
    assert.deepEqual(transport.stats(), {
      logicalReads: 3,
      physicalBuilds: 3,
      settledHits: 0,
      inFlightJoins: 0,
      buildFailures: 0,
      invalidResults: 2,
      consumerAborts: 0,
      consumerDeadlines: 0,
      physicalAborts: 0,
      settledEntries: 1,
      inFlightEntries: 0,
      consumers: 0,
    });
  });
});

test("logical correlation IDs join identical physical reads while semantic dimensions stay isolated", async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  const firstResponseReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstRequestStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
  await withServer(async (incoming, outgoing) => {
    calls += 1;
    const raw = await bodyOf(incoming);
    const payload = JSON.parse(raw) as { readonly id: Hash };
    if (calls === 1) {
      firstStarted();
      await firstResponseReady;
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: `0x${calls.toString(16).padStart(2, "0")}` }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    const samePhysicalRequest = { ...request, requestId: hash("request-2") };
    const first = transport.read({ request });
    const second = transport.read({ request: samePhysicalRequest });
    await firstRequestStarted;
    assert.equal(calls, 1);
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), [
      { kind: "returned", requestId: request.requestId, source, dataHex: "0x01" },
      { kind: "returned", requestId: samePhysicalRequest.requestId, source, dataHex: "0x01" },
    ]);

    const variants = [
      { ...request, target: "0x2222222222222222222222222222222222222222" },
      { ...request, data: "0xcafebabe" },
      { ...request, responseEncoding: "abi-bytes" },
    ] as const;
    const results = [];
    for (const variant of variants) results.push(await transport.read({ request: variant }));
    assert.equal(results.every((value) => value.kind === "returned"), true);
    assert.equal(calls, variants.length + 1);
    assert.deepEqual(transport.stats(), {
      logicalReads: variants.length + 2,
      physicalBuilds: variants.length + 1,
      settledHits: 0,
      inFlightJoins: 1,
      buildFailures: 0,
      invalidResults: 0,
      consumerAborts: 0,
      consumerDeadlines: 0,
      physicalAborts: 0,
      settledEntries: variants.length + 1,
      inFlightEntries: 0,
      consumers: 0,
    });
  });
});

test("owner-issued lane scopes isolate logical facts while one physical seal is completion-order invariant", async () => {
  await withServer(async (incoming, outgoing) => {
    const raw = await bodyOf(incoming);
    const payload = JSON.parse(raw) as { readonly id: Hash };
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0xBEEF" }));
  }, async (endpoint) => {
    async function run(closeBackrunFirst: boolean) {
      const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
      const blockscan = transport.issueLogicalReadScope({ lane: "blockscan", correlationId: hash("blockscan-correlation") });
      const backrun = transport.issueLogicalReadScope({ lane: "backrun", correlationId: hash("backrun-correlation") });
      const backrunRequest = { ...request, requestId: hash("backrun-logical-request") };
      const outcomes = await Promise.all([
        blockscan.read({ request }),
        backrun.read({ request: backrunRequest }),
      ]);
      assert.equal(outcomes.every(outcome => outcome.kind === "returned"), true);
      assert.equal((await backrun.read({ request: { ...request, requestId: hash("backrun-settled-request") } })).kind, "returned");
      const first = closeBackrunFirst ? backrun : blockscan;
      const second = closeBackrunFirst ? blockscan : backrun;
      const firstFacts = transport.closeLogicalReadScope(first);
      const secondFacts = transport.closeLogicalReadScope(second);
      const blockscanFacts = firstFacts.lane === "blockscan" ? firstFacts : secondFacts;
      const backrunFacts = firstFacts.lane === "backrun" ? firstFacts : secondFacts;
      const physicalFacts = await transport.closePhysicalFacts();
      assertIssuedCurrentSourceRpcLogicalScopeFactsV1(blockscanFacts);
      assertIssuedCurrentSourceRpcLogicalScopeFactsV1(backrunFacts);
      assertIssuedCurrentSourceRpcPhysicalFactsV1(physicalFacts);
      return { blockscanFacts, backrunFacts, physicalFacts };
    }

    const forward = await run(false);
    const reverse = await run(true);
    const stripPhysicalTiming = (facts: CurrentSourceRpcPhysicalFactsV1) => {
      const { openedMonotonicNs, closedMonotonicNs, elapsedUs, ...stableFacts } = facts;
      assert.ok(BigInt(closedMonotonicNs) >= BigInt(openedMonotonicNs));
      assert.equal(elapsedUs, ((BigInt(closedMonotonicNs) - BigInt(openedMonotonicNs)) / 1_000n).toString());
      return stableFacts;
    };
    assert.deepEqual(reverse.blockscanFacts, forward.blockscanFacts);
    assert.deepEqual(reverse.backrunFacts, forward.backrunFacts);
    assert.deepEqual(stripPhysicalTiming(reverse.physicalFacts), stripPhysicalTiming(forward.physicalFacts));
    assert.deepEqual(forward.blockscanFacts, {
      kind: "aloha.current-source-rpc.logical-scope-facts-v1",
      lane: "blockscan",
      correlationId: hash("blockscan-correlation"),
      source,
      logicalReads: 1,
      settledHits: 0,
      inFlightJoins: 0,
      consumerAborts: 0,
      consumerDeadlines: 0,
    });
    assert.deepEqual(forward.backrunFacts, {
      kind: "aloha.current-source-rpc.logical-scope-facts-v1",
      lane: "backrun",
      correlationId: hash("backrun-correlation"),
      source,
      logicalReads: 2,
      settledHits: 1,
      inFlightJoins: 1,
      consumerAborts: 0,
      consumerDeadlines: 0,
    });
    const physicalFacts = stripPhysicalTiming(forward.physicalFacts);
    assert.deepEqual(physicalFacts, {
      kind: "aloha.current-source-rpc.physical-facts-v1",
      source,
      logicalScopeFacts: [forward.blockscanFacts, forward.backrunFacts],
      logicalScopeFactsRoot: currentSourceRpcLogicalScopeFactsRoot([forward.blockscanFacts, forward.backrunFacts]),
      physicalBuilds: 1,
      buildFailures: 0,
      invalidResults: 0,
      physicalAborts: 0,
      settledEntries: 1,
      inFlightEntries: 0,
      consumers: 0,
    });
  });
});

test("one lane abort detaches only that logical scope while the sibling completes shared physical work", async () => {
  let calls = 0;
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  await withServer(async (_incoming, outgoing) => {
    calls += 1;
    started();
    await responseReady;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: "0xCAFE" }));
  }, async endpoint => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    const blockscan = transport.issueLogicalReadScope({ lane: "blockscan", correlationId: hash("abort-blockscan") });
    const backrun = transport.issueLogicalReadScope({ lane: "backrun", correlationId: hash("surviving-backrun") });
    const controller = new AbortController();
    const blockscanRead = blockscan.read({ request, signal: controller.signal });
    const backrunRead = backrun.read({ request: { ...request, requestId: hash("surviving-backrun-read") } });
    await requestStarted;
    controller.abort("blockscan-only");
    assert.equal(reason(await blockscanRead), "abort");
    release();
    assert.equal((await backrunRead).kind, "returned");
    assert.equal(calls, 1);
    const blockscanFacts = transport.closeLogicalReadScope(blockscan);
    const backrunFacts = transport.closeLogicalReadScope(backrun);
    assert.equal(blockscanFacts.consumerAborts, 1);
    assert.equal(blockscanFacts.logicalReads, 1);
    assert.equal(backrunFacts.consumerAborts, 0);
    assert.equal(backrunFacts.logicalReads, 1);
    assert.equal(blockscanFacts.inFlightJoins + backrunFacts.inFlightJoins, 1);
    const physicalFacts = await transport.closePhysicalFacts();
    assert.equal(physicalFacts.physicalBuilds, 1);
    assert.equal(physicalFacts.physicalAborts, 0);
    assert.equal(physicalFacts.settledEntries, 1);
  });
});

test("logical scopes reject clones, double close, cross-transport close, and forged facts", async () => {
  await withServer(async (incoming, outgoing) => {
    const raw = await bodyOf(incoming);
    const payload = JSON.parse(raw) as { readonly id: Hash };
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x01" }));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    const other = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}) });
    const blockscan = transport.issueLogicalReadScope({ lane: "blockscan", correlationId: hash("scope-blockscan") });
    const backrun = transport.issueLogicalReadScope({ lane: "backrun", correlationId: hash("scope-backrun") });
    const clone = Object.freeze({ ...blockscan });
    await assert.rejects(async () => clone.read({ request }), /not issued by this transport/);
    assert.throws(() => transport.closeLogicalReadScope(clone), /not issued by this transport/);
    assert.throws(() => other.closeLogicalReadScope(blockscan), /not issued by this transport/);
    await blockscan.read({ request });
    const blockscanFacts = transport.closeLogicalReadScope(blockscan);
    await assert.rejects(transport.closePhysicalFacts(), /require closed logical scopes/);
    assert.throws(() => transport.closeLogicalReadScope(blockscan), /already closed/);
    assert.throws(() => assertIssuedCurrentSourceRpcLogicalScopeFactsV1({ ...blockscanFacts }), /not owner-issued/);
    transport.closeLogicalReadScope(backrun);
    const physicalFacts = await transport.closePhysicalFacts();
    await assert.rejects(transport.closePhysicalFacts(), /already closed/);
    assert.throws(() => assertIssuedCurrentSourceRpcPhysicalFactsV1({ ...physicalFacts }), /not owner-issued/);
  });
});

test("failed and aborted physical work never enters the settled cache", async () => {
  let calls = 0;
  let abortedStarted!: () => void;
  const abortedRequestStarted = new Promise<void>(resolve => { abortedStarted = resolve; });
  await withServer(async (incoming, outgoing) => {
    calls += 1;
    const raw = await bodyOf(incoming);
    const payload = JSON.parse(raw) as { readonly id: Hash };
    if (calls === 1) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x01", extra: true }));
      return;
    }
    abortedStarted();
    await new Promise<void>(resolve => incoming.on("aborted", resolve));
  }, async (endpoint) => {
    const transport = new CurrentSourceRpcReadTransport({ endpoint, currentSource: session({}), timeoutMs: 1_000 });
    const blockscan = transport.issueLogicalReadScope({ lane: "blockscan", correlationId: hash("failed-blockscan") });
    const backrun = transport.issueLogicalReadScope({ lane: "backrun", correlationId: hash("aborted-backrun") });
    assert.equal(reason(await blockscan.read({ request })), "malformed-response");
    const controller = new AbortController();
    const aborted = backrun.read({ request: { ...request, requestId: hash("aborted-request") }, signal: controller.signal });
    await abortedRequestStarted;
    assert.throws(() => transport.closeLogicalReadScope(backrun), /has active reads/);
    controller.abort("logical abort");
    assert.equal(reason(await aborted), "abort");
    assert.equal(reason(await backrun.read({
      request: { ...request, requestId: hash("expired-request") },
      deadlineAtMs: performance.now() - 1,
    })), "deadline");
    const blockscanFacts = transport.closeLogicalReadScope(blockscan);
    const backrunFacts = transport.closeLogicalReadScope(backrun);
    assert.equal(blockscanFacts.logicalReads, 1);
    assert.equal(backrunFacts.logicalReads, 2);
    assert.equal(backrunFacts.consumerAborts, 1);
    assert.equal(backrunFacts.consumerDeadlines, 1);
    const physicalFacts = await transport.closePhysicalFacts();
    assert.equal(physicalFacts.physicalBuilds, 2);
    assert.equal(physicalFacts.invalidResults, 2);
    assert.equal(physicalFacts.physicalAborts, 1);
    assert.equal(physicalFacts.settledEntries, 0);
  });
});
