import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { keccak256, toUtf8Bytes } from "ethers";
import { createRevmStrictSimulationTransport } from "../revm-strict-simulation-transport.js";
import { RevmFatalError, RevmStrictError, type DaemonResponse, type RevmFatalReason,
  type RevmRequestControl, type StrictSimulateRequest } from "../revm-sim-client.js";
import type { RevmStrictSourceLease } from "../revm-strict-source-owner.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

const address = (n: string) => `0x${n.repeat(40)}`;
const hash = (n: string) => `0x${n.repeat(64)}`;
const EXECUTOR = address("a"), ORIGIN = address("b"), TOKEN = address("c");
const SOURCE = Object.freeze({ number: 25_700_444, hash: hash("1"), generation: 44 });
const NEXT = Object.freeze({ number: 25_700_445, hash: hash("4"), generation: 45 });
const STATE_ROOT = hash("2"), SLOT = hash("0");
const SOURCES = new Map<number, CanonicalSource>([SOURCE, NEXT].map(source => [source.number, source]));
const observerTag = keccak256(toUtf8Bytes("mev.static-balance-observer.result.v3"));

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function header(source: CanonicalSource) {
  return { number: `0x${source.number.toString(16)}`, hash: source.hash, parentHash: hash("3"),
    timestamp: "0x6b49d200", gasLimit: "0x3938700", gasUsed: "0x0",
    baseFeePerGas: "0x3b9aca00", transactions: [] };
}

function preparedResponse(request: StrictSimulateRequest): DaemonResponse {
  return { ok: true, latencyMs: 0,
    sourceAttestation: { kind: "node-attested", chainId: 1, blockNumber: request.blockNumber,
      blockHash: request.sourcePin!.blockHash, stateRoot: STATE_ROOT, parentHash: hash("3") },
    strict: { outcome: { kind: "InputPrepared", stateOverrides: {
      [TOKEN]: { stateDiff: { [SLOT]: request.sourcePin!.blockHash } },
    } }, executionGasUsed: "0", tokenDeltas: [], nativeDeltas: [], totalSupplyDeltas: [], logs: [] } };
}

/** The fake lease obeys the same individual signal/deadline contract as a client. */
function controlled<T>(pending: Promise<T>, control?: RevmRequestControl): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer !== undefined) clearTimeout(timer); control?.signal?.removeEventListener("abort", aborted); };
    const done = (callback: () => void) => { cleanup(); callback(); };
    const aborted = () => done(() => reject(new Error("revm-sim request aborted")));
    if (control?.signal?.aborted) { aborted(); return; }
    control?.signal?.addEventListener("abort", aborted, { once: true });
    if (control?.deadlineAtMs !== undefined) {
      timer = setTimeout(() => done(() => reject(new Error("revm-sim request deadline timed out"))),
        Math.max(0, control.deadlineAtMs - Date.now()));
    }
    void pending.then(value => done(() => resolve(value)), error => done(() => reject(error)));
  });
}

async function fixture(hooks: {
  header?: (source: CanonicalSource, callIndex: number) => Promise<unknown>;
  funding?: (request: StrictSimulateRequest, control: RevmRequestControl | undefined, callIndex: number) => Promise<DaemonResponse>;
  onFatal?: (reason: RevmFatalReason) => void;
} = {}) {
  const headers: number[] = [], funding: StrictSimulateRequest[] = [], controls: (RevmRequestControl | undefined)[] = [];
  const simulations: { sourceHash: string; funding: unknown }[] = [], fatals: RevmFatalReason[] = [];
  const serverErrors: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { void (async () => {
      const wire = JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown;
      if (wire.method === "eth_getBlockByNumber") {
        const number = Number(BigInt(wire.params[0])), source = SOURCES.get(number);
        assert(source);
        headers.push(number);
        try { result = hooks.header ? await hooks.header(source, headers.length) : header(source); }
        catch { response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id,
          error: { code: -32001, message: "private-key must never escape" } })); return; }
      } else {
        assert.equal(wire.method, "eth_simulateV1");
        const block = wire.params[0].blockStateCalls[0], sourceHash = wire.params[1].blockHash;
        assert.equal(wire.params[1].requireCanonical, true);
        assert.equal(block.stateOverrides[TOKEN].stateDiff[SLOT], sourceHash, "funding must come from this exact source");
        simulations.push({ sourceHash, funding: block.stateOverrides[TOKEN] });
        result = [{ number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
          baseFeePerGas: block.blockOverrides.baseFeePerGas, gasLimit: block.blockOverrides.gasLimit,
          parentHash: sourceHash, calls: [
            { status: "0x1", gasUsed: "0x100", returnData: observerTag + hash("1").slice(2) },
            { status: "0x1", gasUsed: "0x100", returnData: "0x1234" },
          ] }];
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
    })().catch(error => { serverErrors.push(error); response.destroy(); }); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address(); assert(bound && typeof bound === "object");
  const leases = new Map<number, RevmStrictSourceLease>();
  for (const source of SOURCES.values()) leases.set(source.number, {
    source, sourcePin: { chainId: 1, blockHash: source.hash, stateRoot: STATE_ROOT },
    async strictSimulate(request, control) {
      funding.push(request); controls.push(control);
      assert.equal(request.inputStateOnly, true);
      assert.equal(request.sourcePin!.blockHash, source.hash);
      return hooks.funding ? hooks.funding(request, control, funding.length) : preparedResponse(request);
    },
    async closeAndDrain() { assert.fail("a quote must not retire a source lease"); },
  });
  const transport = createRevmStrictSimulationTransport({ rpcUrl: `http://127.0.0.1:${bound.port}`,
    executionGasLimit: 1_000_000,
    leaseFor: async source => { const lease = leases.get(source.number); assert(lease); return lease; },
    onFatal: reason => { fatals.push(reason); hooks.onFatal?.(reason); },
  });
  return { transport, headers, funding, controls, simulations, fatals, leases,
    invoke(source: CanonicalSource = SOURCE, control?: RevmRequestControl, scriptHex = "0x01") {
      return transport.simulateStandalone!({ source, callerAuthority: { executor: EXECUTOR, transactionOrigin: ORIGIN },
        scriptHex, inputToken: TOKEN, inputAmount: 100n,
        control: control ?? { signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000 } });
    },
    async close() {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      assert.deepEqual(serverErrors, []);
    },
  };
}

test("standalone overlaps source header with funding and retains fulfilled-value reuse", { timeout: 5000 }, async () => {
  const headerSeen = deferred(), headerReady = deferred(), fundingReady = deferred();
  const f = await fixture({
    header: async source => { headerSeen.resolve(); await headerReady.promise; return header(source); },
    funding: async request => { await fundingReady.promise; return preparedResponse(request); },
  });
  const first = f.invoke();
  try {
    await headerSeen.promise;
    assert.equal(f.funding.length, 1, "funding must start while the observed header is still blocked");
    assert.equal(f.simulations.length, 0);
    headerReady.resolve(); await nextTurn();
    assert.equal(f.simulations.length, 0, "final execution must wait for both preparations");
    fundingReady.resolve();
    assert.equal((await first).kind, "success");
    const next = await f.invoke(SOURCE, undefined, "0x02");
    assert.equal(next.kind, "success"); assert.equal(next.reusedInputFunding, true);
    assert.equal(f.headers.length, 1); assert.equal(f.funding.length, 1); assert.equal(f.simulations.length, 2);
  } finally { headerReady.resolve(); fundingReady.resolve(); await first.catch(() => {}); await f.close(); }
});

test("header failure joins funding before rejecting and leaves failed preparation retryable", { timeout: 5000 }, async () => {
  const headerSeen = deferred(), fundingReady = deferred();
  let fundingSettled = false, returned = false;
  const f = await fixture({
    header: async (source, index) => { headerSeen.resolve(); if (index === 1) throw new Error("remote secret"); return header(source); },
    funding: async request => { await fundingReady.promise; fundingSettled = true; return preparedResponse(request); },
  });
  const first = f.invoke().finally(() => { returned = true; });
  const rejected = assert.rejects(first, (error: unknown) => {
    assert(error instanceof Error); assert.equal(error.message, "source header RPC error code -32001");
    assert.equal(fundingSettled, true); return true;
  });
  try {
    await headerSeen.promise; await nextTurn();
    assert.equal(f.funding.length, 1); assert.equal(returned, false);
    fundingReady.resolve(); await rejected;
    assert.equal(f.simulations.length, 0);
    assert.equal((await f.invoke()).kind, "success");
    assert.equal(f.funding.length, 2, "failed combined preparation cannot become a funding cache hit");
    assert.equal(f.headers.length, 2);
  } finally { fundingReady.resolve(); await rejected; await f.close(); }
});

test("late funding fatal wins over an earlier ordinary header failure", { timeout: 5000 }, async () => {
  const headerSeen = deferred(), fundingReady = deferred();
  const f = await fixture({
    header: async () => { headerSeen.resolve(); throw new Error("private-key"); },
    funding: async request => { await fundingReady.promise; const result = preparedResponse(request);
      result.sourceAttestation = { ...result.sourceAttestation!, blockHash: hash("f") }; return result; },
  });
  const first = f.invoke();
  const rejected = assert.rejects(first, (error: unknown) => {
    assert(error instanceof RevmFatalError); assert.equal(error.fatal.kind, "source-fault"); return true;
  });
  try {
    await headerSeen.promise; fundingReady.resolve(); await rejected;
    assert.equal(f.simulations.length, 0); assert.deepEqual(f.fatals, [{ kind: "source-fault" }]);
    await assert.rejects(f.invoke(), RevmFatalError);
  } finally { fundingReady.resolve(); await rejected; await f.close(); }
});

test("funding failure remains redacted, waits for the header and does not poison later work", { timeout: 5000 }, async () => {
  const headerSeen = deferred(), headerReady = deferred();
  let returned = false;
  const f = await fixture({
    header: async source => { headerSeen.resolve(); await headerReady.promise; return header(source); },
    funding: async (request, _control, index) => {
      if (index === 1) throw Object.assign(new Error("private-key remote failure"), { code: "CALL_EXCEPTION", data: "secret" });
      return preparedResponse(request);
    },
  });
  const first = f.invoke().finally(() => { returned = true; });
  const rejected = assert.rejects(first, (error: unknown) => {
    assert(error instanceof RevmStrictError); assert.equal(error.message, "strict simulation transport failed");
    assert.equal((error as Error & { code?: string }).code, undefined); return true;
  });
  try {
    await headerSeen.promise; await nextTurn(); assert.equal(returned, false);
    headerReady.resolve(); await rejected;
    assert.equal(f.simulations.length, 0);
    assert.equal((await f.invoke()).kind, "success"); assert.equal(f.funding.length, 2);
    assert.equal(f.headers.length, 1, "a successful source header remains reusable");
  } finally { headerReady.resolve(); await rejected; await f.close(); }
});

for (const cancellation of ["signal", "deadline"] as const) {
  test(`concurrent standalone requests retain independent ${cancellation} controls`, { timeout: 5000 }, async () => {
    const headersSeen = deferred(), headerReady = deferred(), fundingReady = deferred();
    const f = await fixture({
      header: async (source, index) => { if (index === 2) headersSeen.resolve(); await headerReady.promise; return header(source); },
      funding: async (request, control) => { await controlled(fundingReady.promise, control); return preparedResponse(request); },
    });
    const firstController = new AbortController(), otherController = new AbortController();
    const firstControl = { signal: firstController.signal, deadlineAtMs: Date.now() + (cancellation === "deadline" ? 250 : 5000) };
    const otherControl = { signal: otherController.signal, deadlineAtMs: Date.now() + 5000 };
    const first = f.invoke(SOURCE, firstControl), other = f.invoke(SOURCE, otherControl);
    const rejected = assert.rejects(first, (error: unknown) => {
      assert(error instanceof RevmStrictError);
      assert.equal(error.message, cancellation === "signal" ? "strict simulation cancelled" : "strict simulation deadline reached");
      return true;
    });
    try {
      await headersSeen.promise;
      assert.equal(f.funding.length, 2, "pending work must not share the first caller's control");
      assert.equal(f.controls[0]!.signal, firstControl.signal); assert.equal(f.controls[0]!.deadlineAtMs, firstControl.deadlineAtMs);
      assert.equal(f.controls[1]!.signal, otherControl.signal); assert.equal(f.controls[1]!.deadlineAtMs, otherControl.deadlineAtMs);
      if (cancellation === "signal") firstController.abort(new Error("private-key must stay private"));
      await rejected; assert.equal(otherController.signal.aborted, false);
      headerReady.resolve(); fundingReady.resolve();
      assert.equal((await other).kind, "success");
      assert.equal((await f.invoke()).reusedInputFunding, true); assert.equal(f.funding.length, 2);
      assert.deepEqual(f.fatals, []);
    } finally { firstController.abort(); otherController.abort(); headerReady.resolve(); fundingReady.resolve();
      await Promise.allSettled([first, other]); await rejected; await f.close(); }
  });
}

test("late work for an earlier source cannot overwrite the current source's fulfilled caches", { timeout: 5000 }, async () => {
  const oldHeaderSeen = deferred(), oldHeaderReady = deferred(), oldFundingReady = deferred();
  const f = await fixture({
    header: async source => { if (source.number === SOURCE.number) { oldHeaderSeen.resolve(); await oldHeaderReady.promise; } return header(source); },
    funding: async request => { if (request.blockNumber === SOURCE.number) await oldFundingReady.promise; return preparedResponse(request); },
  });
  const old = f.invoke();
  try {
    await oldHeaderSeen.promise;
    assert.equal((await f.invoke(NEXT)).kind, "success");
    oldHeaderReady.resolve(); oldFundingReady.resolve(); assert.equal((await old).kind, "success");
    const current = await f.invoke(NEXT, undefined, "0x03");
    assert.equal(current.kind, "success"); assert.equal(current.reusedInputFunding, true);
    assert.deepEqual(f.headers, [SOURCE.number, NEXT.number]);
    assert.deepEqual(f.funding.map(request => request.blockNumber), [SOURCE.number, NEXT.number]);
    assert.deepEqual(f.simulations.map(call => call.sourceHash), [NEXT.hash, SOURCE.hash, NEXT.hash]);
    assert.deepEqual(f.fatals, []);
  } finally { oldHeaderReady.resolve(); oldFundingReady.resolve(); await old.catch(() => {}); await f.close(); }
});

test("wrong observed source hash rejects execution and drains already-started input preparation", { timeout: 5000 }, async () => {
  const fatalSeen = deferred(), fundingReady = deferred();
  let returned = false;
  const f = await fixture({
    header: async source => ({ ...header(source), hash: hash("f") }),
    funding: async request => { await fundingReady.promise; return preparedResponse(request); },
    onFatal: () => fatalSeen.resolve(),
  });
  const first = f.invoke().finally(() => { returned = true; });
  const rejected = assert.rejects(first, RevmFatalError);
  try {
    await fatalSeen.promise; await nextTurn(); assert.equal(f.funding.length, 1); assert.equal(returned, false);
    fundingReady.resolve(); await rejected;
    assert.equal(f.simulations.length, 0); assert.deepEqual(f.fatals, [{ kind: "source-fault" }]);
  } finally { fundingReady.resolve(); await rejected; await f.close(); }
});

test("source pin is rechecked before standalone execution after parallel preparation", { timeout: 5000 }, async () => {
  const headerSeen = deferred(), fundingReady = deferred();
  const f = await fixture({
    header: async source => { headerSeen.resolve(); return header(source); },
    funding: async request => { await fundingReady.promise; return preparedResponse(request); },
  });
  const first = f.invoke();
  const rejected = assert.rejects(first, RevmFatalError);
  try {
    await headerSeen.promise;
    (f.leases.get(SOURCE.number)!.sourcePin as { stateRoot: string }).stateRoot = hash("f");
    fundingReady.resolve(); await rejected; assert.equal(f.simulations.length, 0);
    assert.deepEqual(f.fatals, [{ kind: "source-fault" }]);
  } finally { fundingReady.resolve(); await rejected; await f.close(); }
});
