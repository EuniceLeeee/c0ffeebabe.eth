import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRethSearcherRuntimeSourceV1 } from "../src/internal/reth-source.ts";
import {
  consumeFullGraphCoarseSweepInvocationCapabilityV1,
  issueFullGraphCoarseSweepInvocationCapabilityV1,
} from "../../../packages/full-graph-coarse-sweep/src/internal/invocation-owner.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;

test("Reth head source emits each canonical head once, polls with a bound, and aborts", async () => {
  let current = { number: "0x64", hash: hash("1"), stateRoot: hash("2") };
  let blockReads = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { readonly id: number; readonly method: string };
      const result = parsed.method === "eth_chainId"
        ? "0x1"
        : (() => {
          blockReads += 1;
          return { ...current, parentHash: hash("0") };
        })();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Reth test server did not bind");
  const directory = mkdtempSync(join(tmpdir(), "aloha-reth-runtime-source-"));
  const source = createRethSearcherRuntimeSourceV1({
    canonical: {
      profile: "reth-json-rpc-v1",
      endpoint: `http://127.0.0.1:${address.port}/`,
      chainId: "1",
      journalPath: join(directory, "canonical.sqlite"),
      headPollIntervalMs: 5,
    },
    ingress: {
      profile: "reth-json-rpc-v1",
      endpoint: `http://127.0.0.1:${address.port}/`,
      pending: "disabled",
      blockscan: {
        objective: { kind: "test-objective" },
        callerId: "reth-source-test",
        deadlineMs: 1_000,
        admission: { topK: 1, boundedUnrankedBudget: 0 },
      },
    },
  });
  try {
    const first = await source.headSource.next(new AbortController().signal);
    assert.equal(first?.hash, hash("1"));

    let secondSettled = false;
    const second = source.headSource.next(new AbortController().signal).finally(() => { secondSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(secondSettled, false, "an unchanged head must not be re-emitted");
    assert.equal(blockReads < 20, true, "head polling must not become a tight loop");

    current = { number: "0x65", hash: hash("3"), stateRoot: hash("4") };
    assert.equal((await second)?.hash, hash("3"));

    const controller = new AbortController();
    const stopped = source.headSource.next(controller.signal);
    setTimeout(() => controller.abort("test-stop"), 10);
    assert.equal(await stopped, null);
  } finally {
    source.close();
    server.close();
    await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Reth source owns one physical transport per session and rejects cross-session logical scope use", async () => {
  const current = Object.freeze({
    chainId: "1",
    number: "100",
    hash: hash("5"),
    parentHash: hash("4"),
    stateRoot: hash("6"),
  });
  let physicalCalls = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { readonly id: string; readonly method: string };
      const result = parsed.method === "eth_chainId"
        ? "0x1"
        : parsed.method === "eth_getBlockByNumber"
          ? { number: "0x64", hash: current.hash, parentHash: current.parentHash, stateRoot: current.stateRoot }
          : (() => {
            physicalCalls += 1;
            return "0xBEEF";
          })();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Reth test server did not bind");
  const directory = mkdtempSync(join(tmpdir(), "aloha-reth-current-source-scope-"));
  const runtimeSource = createRethSearcherRuntimeSourceV1({
    canonical: {
      profile: "reth-json-rpc-v1",
      endpoint: `http://127.0.0.1:${address.port}/`,
      chainId: "1",
      journalPath: join(directory, "canonical.sqlite"),
    },
    ingress: {
      profile: "reth-json-rpc-v1",
      endpoint: `http://127.0.0.1:${address.port}/`,
      pending: "disabled",
      blockscan: {
        objective: { kind: "test-objective" },
        callerId: "reth-source-scope-test",
        deadlineMs: 1_000,
        admission: { topK: 1, boundedUnrankedBudget: 0 },
      },
    },
  });
  const requestSource = Object.freeze({
    chainId: current.chainId,
    number: current.number,
    hash: current.hash,
    stateRoot: current.stateRoot,
  });
  const request = Object.freeze({
    kind: "family-search.current-source-read" as const,
    requestId: hash("7"),
    source: requestSource,
    target: "0x1111111111111111111111111111111111111111",
    data: "0x1234",
    responseEncoding: "hex" as const,
  });
  const binding = Object.freeze({
    generationId: "current-source-scope-generation",
    readyRecordHash: hash("b"),
    generationRefreshPolicyHash: hash("c"),
    cutoff: requestSource,
    definitionCatalogRoot: hash("d"),
    instanceCatalogRoot: hash("e"),
    graphRoot: hash("f"),
    releaseProvenanceHash: hash("1"),
    candidatePartitionProofStorageHash: hash("2"),
    nominationClosureRoot: hash("3"),
    nominationClosureStorageHash: hash("4"),
  });
  const lease = Object.freeze({ binding, assertActive() {} });
  const sessionA = await runtimeSource.canonical.openHeadSession(
    await runtimeSource.canonical.observeCurrentHead(),
    lease,
  );
  const sessionB = await runtimeSource.canonical.openHeadSession(
    await runtimeSource.canonical.observeCurrentHead(),
    lease,
  );
  try {
    assert.throws(
      () => runtimeSource.issueCurrentSourceReadScope(
        Object.freeze({ ...sessionA.currentSourceCapability }) as never,
        { lane: "blockscan", correlationId: hash("7") },
      ),
      /not canonical-source issued/,
    );
    const blockscan = runtimeSource.issueCurrentSourceReadScope(sessionA.currentSourceCapability, { lane: "blockscan", correlationId: hash("8") });
    const backrun = runtimeSource.issueCurrentSourceReadScope(sessionA.currentSourceCapability, { lane: "backrun", correlationId: hash("9") });
    await Promise.all([
      blockscan.read({ request }),
      backrun.read({ request: { ...request, requestId: hash("a") } }),
    ]);
    assert.equal(physicalCalls, 1);
    const clone = Object.freeze({ ...blockscan });
    assert.throws(
      () => runtimeSource.closeCurrentSourceReadScope(sessionA.currentSourceCapability, clone),
      /not issued by this transport/,
    );
    assert.throws(
      () => runtimeSource.closeCurrentSourceReadScope(sessionB.currentSourceCapability, blockscan),
      /not issued by this transport/,
    );
    const blockscanFacts = runtimeSource.closeCurrentSourceReadScope(sessionA.currentSourceCapability, blockscan);
    const backrunFacts = runtimeSource.closeCurrentSourceReadScope(sessionA.currentSourceCapability, backrun);
    assert.equal(blockscanFacts.logicalReads, 1);
    assert.equal(backrunFacts.logicalReads, 1);
    assert.equal(
      blockscanFacts.inFlightJoins + backrunFacts.inFlightJoins
        + blockscanFacts.settledHits + backrunFacts.settledHits,
      1,
    );
    assert.throws(
      () => runtimeSource.closeCurrentSourceReadScope(sessionA.currentSourceCapability, blockscan),
      /already closed/,
    );
    const physicalFacts = await runtimeSource.closeCurrentSourceReadHead(sessionA.currentSourceCapability);
    assert.deepEqual(physicalFacts.source, requestSource);
    assert.equal(Object.prototype.hasOwnProperty.call(physicalFacts.source, "parentHash"), false);
    assert.equal(physicalFacts.physicalBuilds, 1);
    assert.equal(physicalFacts.settledEntries, 1);
    await assert.rejects(runtimeSource.closeCurrentSourceReadHead(sessionA.currentSourceCapability), /already closed/);
    const sweepSourceRead = runtimeSource.issueFullGraphCoarseSweepSourceRead(sessionA.currentSourceCapability);
    const crossSessionSourceRead = runtimeSource.issueFullGraphCoarseSweepSourceRead(sessionB.currentSourceCapability);
    const crossGraphLease = Object.freeze({
      ...sessionA.lease,
      binding: Object.freeze({ ...sessionA.lease.binding, graphRoot: hash("cross-graph") }),
    });
    assert.throws(
      () => issueFullGraphCoarseSweepInvocationCapabilityV1({
        session: Object.freeze({ ...sessionA, lease: crossGraphLease, graphView: crossGraphLease }) as never,
        sourceRead: sweepSourceRead,
        amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
      }),
      /session\/source\/Graph binding mismatch/,
    );
    const crossReadyLease = Object.freeze({
      ...sessionA.lease,
      binding: Object.freeze({ ...sessionA.lease.binding, readyRecordHash: hash("cross-ready") }),
    });
    assert.throws(
      () => issueFullGraphCoarseSweepInvocationCapabilityV1({
        session: Object.freeze({ ...sessionA, lease: crossReadyLease, graphView: crossReadyLease }) as never,
        sourceRead: sweepSourceRead,
        amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
      }),
      /session\/source\/Graph binding mismatch/,
    );
    assert.throws(
      () => issueFullGraphCoarseSweepInvocationCapabilityV1({
        session: sessionA as never,
        sourceRead: crossSessionSourceRead,
        amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
      }),
      /session\/source\/Graph binding mismatch/,
    );
    const sweepInvocation = issueFullGraphCoarseSweepInvocationCapabilityV1({
      session: sessionA as never,
      sourceRead: sweepSourceRead,
      amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
    });
    const sweepState = consumeFullGraphCoarseSweepInvocationCapabilityV1(sweepInvocation);
    assert.deepEqual(await sweepState.sourceRead.read({ request: { ...request, requestId: hash("c") } }), {
      kind: "returned",
      requestId: hash("c"),
      source: requestSource,
      dataHex: "0xBEEF",
    });
    assert.equal(physicalCalls, 2, "acceptance sweep must use a physical transport outside normal F5 lane facts");
    assert.throws(
      () => consumeFullGraphCoarseSweepInvocationCapabilityV1({ ...sweepInvocation }),
      /invalid|not issued/,
    );
    assert.throws(
      () => issueFullGraphCoarseSweepInvocationCapabilityV1({
        session: sessionA as never,
        sourceRead: {} as never,
        amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
      }),
      /already issued/,
    );
    assert.throws(
      () => issueFullGraphCoarseSweepInvocationCapabilityV1({
        session: sessionB as never,
        sourceRead: crossSessionSourceRead,
        amountSeed: { amountIn: "0", recipient: "acceptance-recipient" },
      }),
      /amountIn must be positive/,
    );
    assert.doesNotThrow(() => consumeFullGraphCoarseSweepInvocationCapabilityV1(
      issueFullGraphCoarseSweepInvocationCapabilityV1({
        session: sessionB as never,
        sourceRead: crossSessionSourceRead,
        amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
      }),
    ));
  } finally {
    await sessionA.close();
    await sessionB.close();
    runtimeSource.close();
    server.close();
    await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});
