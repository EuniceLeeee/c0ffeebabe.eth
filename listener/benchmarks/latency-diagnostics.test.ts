import assert from "node:assert/strict";
import test from "node:test";
import { parseLatencyDiagnostic, withoutProductionConsole } from "./live-stage.js";

test("latency capture admits only existing production diagnostic records", () => {
  const row = parseLatencyDiagnostic('[searcher/quote-batch-dispatch] {"batchId":"1:2","calls":[{"target":"0x123","selector":"0xabcd"}]}', {});
  assert.deepEqual(row, { event: "quote-batch-dispatch", data: { batchId: "1:2", calls: [{ target: "0x123", selector: "0xabcd" }] } });
  assert.deepEqual(parseLatencyDiagnostic("[strict-exec] lane=producer-bulk rethCalls=3 simCalls=0 wallMs=221 queueWaitMs=7 family=curve-plain", {}), {
    event: "strict-exec", data: { lane: "producer-bulk", rethCalls: 3, simCalls: 0, wallMs: 221, queueWaitMs: 7, family: "curve-plain" },
  });
  for (const line of ["provider failed", '[searcher/unrelated] {"wallMs":1}', '[searcher/quote-batch-timing] {broken}', '[searcher/quote-batch-timing] []', "[strict-exec] unstructured secret"]) {
    assert.equal(parseLatencyDiagnostic(line, {}), null);
  }
});

test("retained fields are allowlisted, and redact remote URLs and configured secret fragments", () => {
  const secret = "syntheticCredential123";
  const rpc = `https://private.example/v2/${secret}`;
  const row = parseLatencyDiagnostic(`[searcher/quote-batch-timing] ${JSON.stringify({ error: "arbitrary-private-text", scopeLabel: `failed ${rpc} token=${secret}`, sourceBlock: 123,
    http: { requestBytes: 42, payload: "arbitrary-private-text" }, privateField: "arbitrary-private-text" })}`, { MAINNET_RPC_URL: rpc });
  assert(row);
  assert(!JSON.stringify(row).includes(secret));
  assert(!JSON.stringify(row).includes("private.example"));
  assert(!JSON.stringify(row).includes("arbitrary-private-text"));
  assert(JSON.stringify(row).includes("redacted"));
});

test("logical request attribution and cumulative wire statistics remain distinguishable", () => {
  assert.deepEqual(parseLatencyDiagnostic('[strict-eth-call-timing] {"phase":"completed","familyId":"curve-underlying","requestId":"current-token-decimals","subjectKey":"opaque","calldataSha256":"hash","wallMs":32}', {}), {
    event: "strict-eth-call-timing", data: { wallMs: 32, phase: "completed", familyId: "curve-underlying", requestId: "current-token-decimals", subjectKey: "opaque", calldataSha256: "hash" },
  });
  assert.deepEqual(parseLatencyDiagnostic('[searcher/blockscan-source-n-call-stats-final] {"totalCalls":10,"memoHits":3,"batchedItems":7,"timeoutRetries":0,"error":"discard"}', {}), {
    event: "blockscan-source-n-call-stats-final", data: { timeoutRetries: 0, totalCalls: 10, memoHits: 3, batchedItems: 7 },
  });
});

test("direct permit queue waits retain finite nonnegative sub-millisecond precision", () => {
  const line = (value: string) => `[strict-exec] lane=exact rethCalls=1 simCalls=0 wallMs=221 queueWaitMs=${value} family=curve-plain`;
  for (const value of ["0", "7.125", "0.00001", "1.2e-7"]) {
    assert.equal((parseLatencyDiagnostic(line(value), {})?.data as { queueWaitMs: number }).queueWaitMs, Number(value));
  }
  for (const value of ["NaN", "Infinity", "-1", "1e309"]) assert.equal(parseLatencyDiagnostic(line(value), {}), null);
});

test("opt-in observation is silent, cannot alter work, and always restores console", async () => {
  const original = console.log;
  const observed: string[] = [];
  let leaked = 0;
  console.log = () => { leaked++; };
  const intercepted = console.log;
  try {
    const result = await withoutProductionConsole(async () => {
      console.log("one");
      console.log({ toString() { throw new Error("must not stringify"); } });
      console.log("multiple", "arguments");
      return 7;
    }, line => { observed.push(line); throw new Error("observer failure"); });
    assert.equal(result, 7);
    assert.deepEqual(observed, ["one"]);
    assert.equal(leaked, 0);
    assert.equal(console.log, intercepted);
    await assert.rejects(withoutProductionConsole(async () => { throw new Error("work failure"); }, () => {}), /work failure/);
    assert.equal(console.log, intercepted);
  } finally { console.log = original; }
});
