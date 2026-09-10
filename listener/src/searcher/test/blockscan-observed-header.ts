import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { inspect } from "node:util";
import { parseBlockScanObservedHeader, readBlockScanObservedHeader } from "../blockscan-observed-header.js";
import { StateCallAbortedError, type StateCallControl } from "../../shared/state/state-backend.js";
import { isRpcThrottleError } from "../rpc-throttle-guard.js";

const hash = (c: string) => "0x" + c.repeat(64);
const addr = (c: string) => "0x" + c.repeat(40);
const tx = { blockHash: hash("a"), blockNumber: "0x123", from: addr("a"), to: addr("b"),
  nonce: "0x1", gas: "0x5208", gasPrice: "0x1", value: "0x0", input: "0x", v: "0x1b", r: "0x1", s: "0x2" };
const raw = { number: "0x123", hash: hash("a"), parentHash: hash("b"), timestamp: "0x" + (1767747672).toString(16),
  miner: addr("c"), transactions: [{ ...tx, hash: hash("1"), type: "0x2", transactionIndex: "0x0",
    chainId: "0x1", accessList: [], maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" },
    { ...tx, hash: hash("2"), type: "0x0", transactionIndex: "0x1" }],
  withdrawals: [{ address: addr("d"), index: "0x0", validatorIndex: "0x0", amount: "0x1" }],
  withdrawalsRoot: hash("3"), parentBeaconBlockRoot: hash("4"), requestsHash: hash("5"),
  blobGasUsed: "0x0", excessBlobGas: "0x0",
  difficulty: "0x0", nonce: "0x0000000000000000", uncles: [],
  sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
  logsBloom: "0x" + "00".repeat(256), extraData: "0x",
  mixHash: hash("6"), stateRoot: hash("7"), transactionsRoot: hash("8"), receiptsRoot: hash("9"),
  gasUsed: "0x1000", gasLimit: "0x2000", baseFeePerGas: "0x400" };
const header = parseBlockScanObservedHeader(raw, 0x123, 1n);
const transportRaw = structuredClone(raw);
assert.equal(header.number, 0x123);
assert.equal(header.timestamp, 1767747672);
assert.equal(header.baseFeePerGas, 1024n);
assert.deepEqual(header.transactionHashes, raw.transactions.map(tx => tx.hash));
assert(header.passiveTouchedAddresses?.includes(addr("c")));
assert(header.passiveTouchedAddresses?.includes(addr("d")));
assert(Object.isFrozen(header) && Object.isFrozen(header.transactionHashes) && Object.isFrozen(header.passiveTouchedAddresses));
for (const bad of [null, [], { ...raw, number: "0x124" }, { ...raw, hash: null },
  { ...raw, parentHash: "0xb" }, { ...raw, transactions: [hash("1"), hash("1")] },
  { ...raw, transactions: [{ hash: "bad" }] },
  { ...raw, timestamp: "0x10000000000000000" }, { ...raw, gasUsed: "0x001" }]) {
  assert.throws(() => parseBlockScanObservedHeader(bad, 0x123, 1n));
}
for (const noProof of [{ ...raw, transactions: [hash("1")] },
  { ...raw, transactions: [{ hash: hash("1"), type: "0x4", authorizationList: [] }] },
  { ...raw, withdrawals: undefined }, { ...raw, withdrawals: [null] }, { ...raw, miner: "bad" }]) {
  assert.equal(parseBlockScanObservedHeader(noProof, 0x123, 1n).passiveTouchedAddresses, undefined);
}
assert.equal(parseBlockScanObservedHeader(raw, 0x123, 2n).passiveTouchedAddresses, undefined);
const addressCount = header.passiveTouchedAddresses!.length;
raw.transactions.push({ ...raw.transactions[0]!, hash: hash("3"), transactionIndex: "0x2" });
raw.withdrawals.push({ address: addr("e"), index: "0x1", validatorIndex: "0x1", amount: "0x1" });
assert.equal(header.transactionHashes.length, 2);
assert.equal(header.passiveTouchedAddresses!.length, addressCount);

// Exercise the production raw HTTP path: no ethers provider or external RPC.
const secret = "fixture-credential-must-not-escape";
const success = { jsonrpc: "2.0", id: 1, result: transportRaw };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let reply: (response: ServerResponse) => void = response => response.end(JSON.stringify(success));
const requests: unknown[] = [];
let activeResponses = 0, interruptedResponses = 0;
const server = createServer((request, response) => {
  activeResponses++;
  response.once("close", () => {
    activeResponses--;
    if (!response.writableFinished) interruptedResponses++;
  });
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    reply(response);
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const rpcUrl = `http://fixture:${secret}@127.0.0.1:${address.port}/${secret}?key=${secret}`;
const read = (control?: StateCallControl) => readBlockScanObservedHeader(rpcUrl, 1n, 0x123, control);
const assertSanitized = (error: unknown): void => {
  assert(error instanceof Error);
  for (const text of [String(error), error.stack, JSON.stringify(error), inspect(error, { depth: 10 })]) {
    assert(!text?.includes(secret), "must not expose URL, body, status text, abort reason or cause");
    assert(!text?.includes(rpcUrl));
  }
  assert.equal(error.cause, undefined);
};
const waitUntil = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    assert(Date.now() < deadline, "local header transport failed to settle/close");
    await delay(5);
  }
};
try {
  const caller = new AbortController();
  assert.deepEqual(await read({ signal: caller.signal, deadlineAtMs: Date.now() + 5_000 }), header);
  assert.deepEqual(requests, [{ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x123", true] }]);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  caller.abort(new Error(secret)); // Successful completed work is detached.
  assert.deepEqual(await read(), header); // Optional controls preserve the read contract.

  const rpcFailure = (code: number, message = secret, data?: string) => ({
    jsonrpc: "2.0", id: 1, error: { code, message, ...(data === undefined ? {} : { data }) },
  });
  const failures = [
    { status: 429, body: JSON.stringify(rpcFailure(-32000)), throttle: true },
    { status: 429, body: `plain text ${secret}`, throttle: true },
    { status: 429, body: JSON.stringify(rpcFailure(3, "execution reverted", "0xdead")), throttle: true },
    { status: 200, body: JSON.stringify(rpcFailure(429)), throttle: true, code: 429 },
    { status: 200, body: JSON.stringify(rpcFailure(-32005, `rate limit ${secret}`)), throttle: true, code: -32005 },
    { status: 500, body: `<html>${secret}</html>`, throttle: false },
    { status: 200, body: `invalid JSON ${secret}`, throttle: false },
    { status: 200, body: JSON.stringify(rpcFailure(3, `rate limit ${secret}`, "0xdead")), throttle: false, code: 3 },
    { status: 200, body: JSON.stringify(rpcFailure(-32000, `rate limit ${secret}`, "0xdead")), throttle: false, code: -32000 },
    { status: 200, body: JSON.stringify(rpcFailure(-32000, `arbitrary bare 429 ${secret}`)), throttle: false, code: -32000 },
    { status: 200, body: JSON.stringify({ ...success, id: 2 }), throttle: false },
    { status: 200, body: JSON.stringify({ ...success, jsonrpc: "1.0" }), throttle: false },
    { status: 200, body: JSON.stringify({ ...success, error: { code: 3, message: secret } }), throttle: false },
    { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1 }), throttle: false },
    { status: 200, body: JSON.stringify({ ...success, result: null }), throttle: false },
    { status: 200, body: JSON.stringify({ ...success, result: { ...transportRaw, hash: secret } }), throttle: false },
    { status: 200, body: JSON.stringify(rpcFailure("429" as unknown as number)), throttle: false },
  ];
  for (const fixture of failures) {
    const before: number = requests.length;
    reply = response => {
      response.writeHead(fixture.status, secret, { "retry-after": "0" });
      response.end(fixture.body);
    };
    const control = new AbortController();
    await assert.rejects(read({ signal: control.signal, deadlineAtMs: Date.now() + 1_000 }), error => {
      assertSanitized(error);
      assert.equal(isRpcThrottleError(error), fixture.throttle);
      if (fixture.throttle) assert.match(String(error), /HTTP 429/);
      if (fixture.status !== 200) assert.equal((error as { statusCode?: number }).statusCode, fixture.status);
      if (fixture.code !== undefined) assert.equal((error as { code?: number }).code, fixture.code);
      if (fixture.body.startsWith("invalid JSON")) assert(error instanceof SyntaxError);
      return true;
    });
    assert.equal(requests.length, before + 1, "first failure surfaces without retry");
    assert.equal(getEventListeners(control.signal, "abort").length, 0);
  }
  const afterFailures = requests.length;
  await delay(1_100);
  assert.equal(requests.length, afterFailures, "no delayed provider retry remains after failure");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error(secret));
  for (const control of [{ signal: alreadyAborted.signal }, { deadlineAtMs: Date.now() - 1 }]) {
    await assert.rejects(read(control), error => {
      assertSanitized(error);
      assert(error instanceof StateCallAbortedError);
      return true;
    });
  }
  await assert.rejects(read({ deadlineAtMs: NaN }), /invalid source header deadline/);
  await assert.rejects(readBlockScanObservedHeader(rpcUrl, 1n, -1), /invalid source header number/);
  await assert.rejects(readBlockScanObservedHeader(`http://[${secret}]`, 1n, 0x123), error => {
    assertSanitized(error); return true;
  });
  assert.equal(requests.length, afterFailures, "invalid/closed inputs do not dispatch");

  // A promise-only timeout would leave these held/partial responses open.
  // Each cancelled request must close physically before any attempted late result.
  for (const kind of ["signal", "deadline"] as const) {
    for (const partialBody of [false, true]) {
      let held: ServerResponse | undefined;
      reply = response => {
        held = response;
        if (partialBody) { response.writeHead(200); response.write('{"jsonrpc":"2.0",'); }
      };
      const before: number = requests.length, beforeInterrupted = interruptedResponses;
      const control = new AbortController();
      let published = false;
      const pending = read({ signal: control.signal, deadlineAtMs: Date.now() + (kind === "deadline" ? 100 : 1_000) })
        .then(result => { published = true; return result; });
      const rejected = assert.rejects(pending, error => {
        assertSanitized(error);
        assert(error instanceof StateCallAbortedError && error.kind === kind);
        assert.equal(isRpcThrottleError(error), false);
        return true;
      });
      await waitUntil(() => held !== undefined);
      if (kind === "signal") control.abort(new Error(`rate limit ${secret}`));
      await rejected;
      await waitUntil(() => activeResponses === 0 && interruptedResponses === beforeInterrupted + 1);
      assert(held!.destroyed, "client cancellation must destroy the held connection");
      held!.end(JSON.stringify(success));
      await delay(10);
      assert.equal(published, false, "late success cannot publish an observed header");
      assert.equal(requests.length, before + 1, "cancellation cannot dispatch a fallback or retry");
      assert.equal(getEventListeners(control.signal, "abort").length, 0);
      reply = response => response.end(JSON.stringify(success));
      assert.deepEqual(await read({ deadlineAtMs: Date.now() + 1_000 }), header, "fresh successor still works");
    }
  }
  reply = response => response.destroy(new Error(secret));
  await assert.rejects(read(), error => { assertSanitized(error); assert.match(String(error), /transport failed/); return true; });
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log("blockscan observed header tests passed (parser + local raw HTTP throttle/cancellation controls)");
