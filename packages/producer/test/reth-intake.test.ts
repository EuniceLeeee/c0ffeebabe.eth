import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  createRethProducerIngressPortV1,
  readIssuedProducerBackrunIntakeV1,
} from "../src/index.ts";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hash;
const head = Object.freeze({ chainId: "1", number: "100", hash: hash("1"), parentHash: hash("3"), stateRoot: hash("2") });

async function withPendingServer(
  transactions: readonly unknown[],
  run: (endpoint: string) => Promise<void>,
  pendingPatch: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { readonly id: number };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        result: { number: "0x65", parentHash: head.hash, transactions, ...pendingPatch },
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("pending test server did not bind");
  try { await run(`http://127.0.0.1:${address.port}/`); }
  finally { server.close(); await once(server, "close"); }
}

const transaction = (digit: string) => ({
  hash: hash(digit),
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  nonce: "0x1",
  input: "0x1234",
});

function config(endpoint: string) {
  return {
    profile: "reth-json-rpc-v1" as const,
    endpoint,
    pending: "public-pending-v1" as const,
    blockscan: {
      objective: { objectiveRef: hash("3"), payload: { kind: "test" } },
      callerId: "reth-intake-test",
      deadlineMs: 5_000,
      admission: { topK: 1, boundedUnrankedBudget: 0 },
    },
  };
}

test("Reth ingress derives blockscan identity and binds backrun to real pending evidence", async () => {
  await withPendingServer([transaction("4")], async endpoint => {
    const port = createRethProducerIngressPortV1(config(endpoint));
    const observed = await port.observe({ head, signal: new AbortController().signal });
    assert.notEqual(observed, null);
    const blockscan = observed!.blockscanInput as { readonly trigger: unknown };
    const backrun = readIssuedProducerBackrunIntakeV1(observed!.backrunInput);
    assert.equal("sourceCoverageRoot" in observed!, false);
    assert.equal("candidateIds" in observed!, false);
    assert.equal(backrun.kind, "pending-transaction");
    if (backrun.kind !== "pending-transaction") throw new Error("expected pending transaction");
    assert.equal(backrun.txHash, hash("4"));
    assert.equal(backrun.pendingEvidenceHash, hashDomain("aloha/public-pending-transaction-evidence/v2", {
      head,
      snapshotHash: backrun.snapshot.snapshotHash,
      transaction: { ...transaction("4"), nonce: "1" },
    }));
    assert.notEqual(blockscan.trigger, backrun.trigger);
  });
});

test("Reth ingress fails closed when a pending snapshot contains more than one transaction", async () => {
  assert.throws(() => createRethProducerIngressPortV1(new Proxy(config("http://reth.test"), {})), /plain object|Proxy/);
  assert.throws(() => createRethProducerIngressPortV1({ ...config("http://reth.test"), fetch: globalThis.fetch } as never), /unknown field|fetch/);
  await withPendingServer([transaction("5"), transaction("4")], async endpoint => {
    const port = createRethProducerIngressPortV1(config(endpoint));
    const observed = await port.observe({ head, signal: new AbortController().signal });
    const backrun = readIssuedProducerBackrunIntakeV1(observed!.backrunInput);
    assert.equal(backrun.kind, "unavailable");
    if (backrun.kind !== "unavailable") throw new Error("expected unavailable pending set");
    assert.equal(backrun.reasonCode, "pending-set-not-single");
    assert.deepEqual(backrun.snapshot?.orderedTransactionHashes, [hash("5"), hash("4")]);
  });
  await withPendingServer([transaction("4"), transaction("4")], async endpoint => {
    const port = createRethProducerIngressPortV1(config(endpoint));
    await assert.rejects(port.observe({ head, signal: new AbortController().signal }), /not unique/);
  });
});

test("only an exact observed empty pending snapshot issues absence evidence", async () => {
  await withPendingServer([], async endpoint => {
    const port = createRethProducerIngressPortV1(config(endpoint));
    const observed = await port.observe({ head, signal: new AbortController().signal });
    const backrun = readIssuedProducerBackrunIntakeV1(observed!.backrunInput);
    assert.equal(backrun.kind, "observed-empty");
    if (backrun.kind !== "observed-empty") throw new Error("expected observed-empty pending set");
    assert.equal(backrun.snapshot.transactionCount, "0");
    assert.equal(backrun.absenceEvidenceHash, hashDomain("aloha/public-pending-absence-evidence/v1", {
      head,
      snapshotHash: backrun.snapshot.snapshotHash,
    }));
  });
});

test("disabled pending observation is explicit unavailable evidence, never absence", async () => {
  const port = createRethProducerIngressPortV1({ ...config("http://127.0.0.1:1/"), pending: "disabled" });
  const observed = await port.observe({ head, signal: new AbortController().signal });
  const backrun = readIssuedProducerBackrunIntakeV1(observed!.backrunInput);
  assert.equal(backrun.kind, "unavailable");
  if (backrun.kind !== "unavailable") throw new Error("expected unavailable pending observation");
  assert.equal(backrun.reasonCode, "pending-observation-disabled");
  assert.equal(backrun.snapshot, null);
});

test("Reth ingress rejects pending evidence that is not the exact child of the submitted head", async () => {
  await withPendingServer([transaction("4")], async endpoint => {
    const port = createRethProducerIngressPortV1(config(endpoint));
    await assert.rejects(
      port.observe({ head, signal: new AbortController().signal }),
      /parent does not match/,
    );
  }, { parentHash: hash("9") });
  await withPendingServer([transaction("4")], async endpoint => {
    const port = createRethProducerIngressPortV1(config(endpoint));
    await assert.rejects(
      port.observe({ head, signal: new AbortController().signal }),
      /exact successor/,
    );
  }, { number: "0x66" });
});
