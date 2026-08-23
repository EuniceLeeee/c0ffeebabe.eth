import assert from "node:assert/strict";
import test from "node:test";
import {
  RevmSimulationClient,
  RevmSimulationError,
  createFailClosedRevmClient,
  assertDispatchRequestShape,
  decodeWorkerLine,
  encodeWorkerLine,
  hashFrozenProgram,
  hashProgramInput,
  hashEffectsWire,
  hashExecutionReceipt,
  type RevmWorkerResultV1,
  type RevmWorkerSimulateRequestV1,
} from "../src/index.ts";
import { RevmWorkerController, RevmWorkerPool } from "../src/lifecycle.ts";
import { authorityFor, createTestRevmAuthorityIssuer } from "./qualified-authority.ts";

const program = {
  format: "frozen-program-v1" as const,
  schemaHash: "schema-hash",
  bytes: "0xreal-program-bytes",
};
const programHash = hashFrozenProgram({ ...program, programHash: "placeholder" });
const qualification = { engineBuildFingerprint: "revm-build-1", executableFingerprint: "revm-executable-1" } as const;
const request: RevmWorkerSimulateRequestV1 = {
  wireVersion: 1,
  kind: "request",
  op: "simulate",
  requestId: "request-1",
  workerEpoch: "epoch-1",
  ownerRef: "opaque-owner",
  generationId: "generation-1",
  attemptId: "attempt-1",
  authority: authorityFor("epoch-1"),
  source: { chainId: "1", number: "300", hash: "hash", stateRoot: "state" },
  caller: {
    address: "caller",
    mode: "impersonated-call-frame",
    observedSender: "observed-sender",
    verifiedActors: { evidence: "verified-actor" },
  },
  observeAccounts: ["account-a", "account-b"],
  program: { ...program, programHash },
  input: { amount: "1", route: "opaque-route" },
  inputHash: hashProgramInput({ amount: "1", route: "opaque-route" }),
  deadlineAtMs: performance.now() + 1_000,
};
const { workerEpoch: _workerEpoch, authority: _authority, ...dispatchRequest } = request;
const simulationRequest = {
  requestId: request.requestId,
  ownerRef: request.ownerRef,
  generationId: request.generationId,
  attemptId: request.attemptId,
  source: request.source,
  caller: request.caller,
  observeAccounts: request.observeAccounts,
  program: request.program,
  input: request.input,
  deadlineAtMs: request.deadlineAtMs,
};

function freshDispatch(overrides: Record<string, unknown> = {}) {
  return {
    ...dispatchRequest,
    requestId: `dispatch-${Math.random()}`,
    deadlineAtMs: performance.now() + 1_000,
    ...overrides,
  };
}

function responseFor(bound: RevmWorkerSimulateRequestV1): RevmWorkerResultV1 {
  const effects = {
    format: "revm-effects-v1" as const,
    bytes: "0xeffects",
    observedAccounts: bound.observeAccounts,
    effectsHash: hashEffectsWire({ format: "revm-effects-v1", bytes: "0xeffects", observedAccounts: bound.observeAccounts }),
  };
  const response: RevmWorkerResultV1 = {
    wireVersion: 1,
    kind: "response",
    op: "simulate",
    requestId: bound.requestId,
    workerEpoch: bound.workerEpoch,
    ownerRef: bound.ownerRef,
    generationId: bound.generationId,
    attemptId: bound.attemptId,
    authority: bound.authority,
    inputHash: bound.inputHash,
    deadlineAtMs: bound.deadlineAtMs,
    engine: "revm",
    engineBuildFingerprint: qualification.engineBuildFingerprint,
    source: bound.source,
    caller: bound.caller,
    observeAccounts: bound.observeAccounts,
    programHash: bound.program.programHash,
    status: "returned",
    output: "0xoutput",
    effects,
    executionReceiptHash: "placeholder",
  };
  return { ...response, executionReceiptHash: hashExecutionReceipt(response) };
}

function fakeFactory(transform: (response: RevmWorkerResultV1) => RevmWorkerResultV1 = (value) => value) {
  return {
    spawn: async (epoch: string) => {
      const lineListeners = new Set<(line: string) => void>();
      const exitListeners = new Set<(code: number | null) => void>();
      const emit = (line: string): void => { for (const listener of lineListeners) listener(line); };
      setTimeout(() => emit(encodeWorkerLine({ wireVersion: 1, kind: "hello", op: "hello", workerEpoch: epoch, engine: "revm", ...qualification })), 0);
      return {
        send: async (line: string) => {
          const decoded = decodeWorkerLine(line);
          if (decoded.kind !== "request") throw new Error("fake worker expected request");
          emit(encodeWorkerLine(transform(responseFor(decoded))));
        },
        onLine: (listener: (line: string) => void) => { lineListeners.add(listener); return () => lineListeners.delete(listener); },
        onExit: (listener: (code: number | null) => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
        kill: async () => { for (const listener of exitListeners) listener(0); },
        waitForExit: async () => true,
      };
    },
  };
}

test("wire round-trip preserves caller mode, verified actors, and every observed account", () => {
  const decoded = decodeWorkerLine(encodeWorkerLine(request));
  assert.equal(decoded.kind, "request");
  if (decoded.kind === "request") {
    assert.equal(decoded.caller.mode, "impersonated-call-frame");
    assert.deepEqual(decoded.caller.verifiedActors, { evidence: "verified-actor" });
    assert.deepEqual(decoded.observeAccounts, ["account-a", "account-b"]);
    assert.equal(decoded.source.number, "300");
    assert.equal(decoded.program.programHash, request.program.programHash);
  }
});

test("global EIP-3607 disable is rejected instead of changing caller semantics", () => {
  const hostile = { ...request, disable_eip3607: true } as unknown as RevmWorkerSimulateRequestV1;
  assert.throws(() => decodeWorkerLine(encodeWorkerLine(hostile)), /EIP-3607/);
});

test("client fails closed without a qualified worker; it never returns fixture simulation", async () => {
  const client = createFailClosedRevmClient();
  await assert.rejects(
    client.simulate(simulationRequest),
    (error: unknown) => error instanceof RevmSimulationError && error.code === "worker-unavailable",
  );
  assert.equal(client.snapshot(), null);
});

test("an invalid caller-selected epoch is rejected before worker availability", async () => {
  const client = createFailClosedRevmClient();
  await assert.rejects(
    client.simulate({ ...simulationRequest, workerEpoch: "caller-picked" } as never),
    (error: unknown) => error instanceof RevmSimulationError && error.code === "program-mismatch",
  );
});

test("a caller cannot inject a worker epoch before qualified dispatch", () => {
  assert.throws(
    () => assertDispatchRequestShape({ ...dispatchRequest, workerEpoch: "caller-picked" } as never),
    /workerEpoch/,
  );
});

test("pool rejects a structural authority issuer instead of accepting a self-consistent clone", () => {
  assert.throws(
    () => new RevmWorkerPool({
      factory: fakeFactory(),
      authority: { issue: () => authorityFor("forged"), assertCurrent: () => undefined } as never,
      qualification,
      maxWorkers: 1,
    }),
    /not release-issued/,
  );
});

test("qualified pool dispatch binds one controller epoch to both request and response", async () => {
  const pool = new RevmWorkerPool({ factory: fakeFactory(), authority: createTestRevmAuthorityIssuer(), qualification, maxWorkers: 1, timeoutMs: 50 });
  const execution = await pool.submit(freshDispatch({ requestId: "pool-success" }));
  assert.equal(execution.request.workerEpoch, "epoch-1");
  assert.equal(execution.response.workerEpoch, execution.request.workerEpoch);
  assert.equal(execution.request.requestId, execution.response.requestId);
  await pool.retireAll();
});

test("rotation while a response is in flight rejects it before settlement and retires the worker", async () => {
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let current = true;
  let killed = 0;
  let delayedResponse: string | null = null;
  const authority = authorityFor("epoch-rotation-in-flight");
  const channel = {
    send: async (line: string) => {
      const decoded = decodeWorkerLine(line);
      if (decoded.kind !== "request") throw new Error("fake worker expected request");
      delayedResponse = encodeWorkerLine(responseFor(decoded));
    },
    onLine: (listener: (line: string) => void) => { lineListeners.add(listener); return () => lineListeners.delete(listener); },
    onExit: (listener: (code: number | null) => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    kill: async () => { killed += 1; for (const listener of exitListeners) listener(0); },
    waitForExit: async () => true,
  };
  const controller = new RevmWorkerController({
    epoch: "epoch-rotation-in-flight",
    channel,
    qualification,
    authority,
    assertAuthorityCurrent: () => {
      if (!current) throw new Error("runtime release rotated");
    },
    timeoutMs: 50,
  });
  for (const listener of lineListeners) listener(encodeWorkerLine({ wireVersion: 1, kind: "hello", op: "hello", workerEpoch: "epoch-rotation-in-flight", engine: "revm", ...qualification }));
  const pending = controller.submit({ ...request, workerEpoch: "epoch-rotation-in-flight", authority, requestId: "rotation-in-flight" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.notEqual(delayedResponse, null);
  current = false;
  for (const listener of lineListeners) listener(delayedResponse!);
  await assert.rejects(pending, /retired|unqualified|rotation/);
  assert.equal(controller.state, "dead");
  assert.equal(controller.snapshot().pending, 0);
  assert.equal(killed >= 1, true);
});

test("response epoch, source, caller, and program mutations fail closed", async () => {
  const cases: readonly [(response: RevmWorkerResultV1) => RevmWorkerResultV1, RegExp][] = [
    [(response) => ({ ...response, workerEpoch: "caller-epoch" }), /timeout|retired/],
    [(response) => ({ ...response, source: { ...response.source, hash: "wrong-source" } }), /source does not match/],
    [(response) => ({ ...response, caller: { ...response.caller, observedSender: "wrong-sender" } }), /caller binding/],
    [(response) => ({ ...response, programHash: "wrong-program" }), /program hash/],
  ];
  for (const [transform, message] of cases) {
    const pool = new RevmWorkerPool({ factory: fakeFactory(transform), authority: createTestRevmAuthorityIssuer(), qualification, maxWorkers: 1, timeoutMs: 8 });
    const client = new RevmSimulationClient({ pool });
    await assert.rejects(client.simulate({ ...simulationRequest, requestId: `mutation-${Math.random()}`, deadlineAtMs: performance.now() + 100 }), message);
    await pool.retireAll();
  }
});

test("timed out worker is retired and cannot be reused before kill/reap", async () => {
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let killed = 0;
  const channel = {
    send: async () => undefined,
    onLine: (listener: (line: string) => void) => { lineListeners.add(listener); return () => lineListeners.delete(listener); },
    onExit: (listener: (code: number | null) => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    kill: async () => { killed += 1; for (const listener of exitListeners) listener(0); },
    waitForExit: async () => true,
  };
  const timeoutAuthority = authorityFor("epoch-timeout");
  const controller = new RevmWorkerController({ epoch: "epoch-timeout", channel, qualification, authority: timeoutAuthority, assertAuthorityCurrent: () => undefined, timeoutMs: 5 });
  const hello = encodeWorkerLine({ wireVersion: 1, kind: "hello", op: "hello", workerEpoch: "epoch-timeout", engine: "revm", ...qualification });
  for (const listener of lineListeners) listener(hello);
  await assert.rejects(controller.submit({ ...request, workerEpoch: "epoch-timeout", authority: timeoutAuthority }), /retired|timed out/);
  assert.equal(controller.state, "dead");
  assert.equal(killed >= 1, true);
  assert.equal(controller.snapshot().pending, 0);
});

test("REVM response schema binds effect observation scope and rejects unknown fields", () => {
  const effects = {
    format: "revm-effects-v1" as const,
    bytes: "0xeffects",
    observedAccounts: ["account-a", "account-b"],
    effectsHash: hashEffectsWire({ format: "revm-effects-v1", bytes: "0xeffects", observedAccounts: ["account-a", "account-b"] }),
  };
  const response: RevmWorkerResultV1 = {
    wireVersion: 1,
    kind: "response",
    op: "simulate",
    requestId: request.requestId,
    workerEpoch: request.workerEpoch,
    ownerRef: request.ownerRef,
    generationId: request.generationId,
    attemptId: request.attemptId,
    authority: request.authority,
    inputHash: request.inputHash,
    deadlineAtMs: request.deadlineAtMs,
    engine: "revm",
    engineBuildFingerprint: qualification.engineBuildFingerprint,
    source: request.source,
    caller: request.caller,
    observeAccounts: request.observeAccounts,
    programHash: request.program.programHash,
    status: "returned",
    output: "0xoutput",
    effects,
    executionReceiptHash: "placeholder",
  };
  assert.equal(decodeWorkerLine(encodeWorkerLine(response)).kind, "response");
  assert.throws(() => decodeWorkerLine(encodeWorkerLine({ ...response, effects: { ...effects, observedAccounts: ["account-a"] } })), /effectsHash|observation scope/);
  assert.throws(() => decodeWorkerLine(encodeWorkerLine({ ...response, extra: true } as never)), /unknown field/);
  assert.equal(hashExecutionReceipt(response).startsWith("0x"), true);
});

test("request program hash mutation is rejected before a worker can receive it", () => {
  assert.throws(() => decodeWorkerLine(encodeWorkerLine({ ...request, program: { ...request.program, programHash: "0xwrong" } } as never)), /programHash/);
});

test("worker cannot become ready without a matching qualified executable hello", async () => {
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  const channel = {
    send: async () => undefined,
    onLine: (listener: (line: string) => void) => { lineListeners.add(listener); return () => lineListeners.delete(listener); },
    onExit: (listener: (code: number | null) => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    kill: async () => { for (const listener of exitListeners) listener(0); },
    waitForExit: async () => true,
  };
  const controller = new RevmWorkerController({ epoch: "epoch-unqualified", channel, qualification, authority: authorityFor("epoch-unqualified"), assertAuthorityCurrent: () => undefined, readyTimeoutMs: 50 });
  for (const listener of lineListeners) listener(encodeWorkerLine({ wireVersion: 1, kind: "hello", op: "hello", workerEpoch: "epoch-unqualified", engine: "revm", engineBuildFingerprint: "wrong-build", executableFingerprint: qualification.executableFingerprint }));
  await assert.rejects(controller.waitUntilReady(), /retired|qualified/);
  assert.equal(controller.state, "dead");
});

test("queued deadlines and dead workers close without orphan queue state", async () => {
  const channels = new Set<{ emit: (line: string) => void }>();
  const factory = {
    spawn: async (epoch: string) => {
      const lineListeners = new Set<(line: string) => void>();
      const exitListeners = new Set<(code: number | null) => void>();
      const wrapper = { emit: (line: string) => { for (const listener of lineListeners) listener(line); } };
      channels.add(wrapper);
      setTimeout(() => wrapper.emit(encodeWorkerLine({ wireVersion: 1, kind: "hello", op: "hello", workerEpoch: epoch, engine: "revm", ...qualification })), 0);
      return {
        send: async () => undefined,
        onLine: (listener: (line: string) => void) => { lineListeners.add(listener); return () => lineListeners.delete(listener); },
        onExit: (listener: (code: number | null) => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
        kill: async () => { for (const listener of exitListeners) listener(0); },
        waitForExit: async () => true,
      };
    },
  };
  const pool = new RevmWorkerPool({ factory, authority: createTestRevmAuthorityIssuer(), qualification, maxWorkers: 1, queueCap: 2, timeoutMs: 8 });
  const first = pool.submit({ ...dispatchRequest, requestId: "pool-first", deadlineAtMs: performance.now() + 100 });
  const second = pool.submit({ ...dispatchRequest, requestId: "pool-second", deadlineAtMs: performance.now() + 3 });
  await assert.rejects(second, (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "deadline");
  await assert.rejects(first);
  await pool.retireAll();
  assert.equal(pool.snapshot().queued, 0);
  assert.equal(pool.snapshot().workers.length, 0);
});
