import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { runBuilderStatsCli } from "../../builder-stats.js";
import { buildSignedBackrunTx, submitBundle, submitMevShareBundle, submitStandaloneBundle } from "../../submitter.js";
import { classifyTitanSubmissionReceipt, observedBuilderRequest, queryTitanBundleStats, redactBuilderText, type BuilderEvidence } from "../../shared/builder-observations.js";
import { emitSubmissionEvidence, initEvents } from "../events.js";

// All transaction/auth signing, provider and HTTP calls below are mock-only.
const TX = "0x" + "ab".repeat(32), BUNDLE = "0x" + "cd".repeat(32);
const WALLET = "0x" + "11".repeat(20), EXECUTOR = "0x" + "22".repeat(20);
const SIGNED = "0x" + "f0".repeat(120), VICTIM = "0x" + "e0".repeat(120);
const AUTH = "mock-auth";
const request = { builder: "test", purpose: "submission" as const, method: "eth_sendBundle",
  url: "https://builder.invalid", body: "{}", txHash: TX, targetBlock: 100, submissionId: "test-id" };
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, run: () => void | Promise<void>): void => { tests.push([name, run]); };
const response = (body: string, status = 200): Response => ({ ok: status < 300, status, text: async () => body } as Response);
const mockFetch = (body: string, status = 200): typeof fetch => async () => response(body, status);
const collect = (): { rows: BuilderEvidence[]; evidence: (row: BuilderEvidence) => void } => {
  const rows: BuilderEvidence[] = [];
  return { rows, evidence: row => { rows.push(row); } };
};
function fakeSubmit(balance = ethers.parseEther("1")) {
  const state = { signs: 0, auths: 0, reads: 0, unsigned: null as ethers.TransactionLike | null };
  const wallet = { address: WALLET, getNonce: async () => 7,
    signTransaction: async (tx: ethers.TransactionLike) => { state.signs++; state.unsigned = tx; return SIGNED; },
    signMessage: async () => { state.auths++; return AUTH; },
  } as unknown as ethers.Wallet;
  const provider = { getBalance: async () => { state.reads++; return balance; } } as unknown as ethers.JsonRpcProvider;
  return { state, params: { calldataHex: "0x12345678", gasUsed: 100_000, wallet, provider,
    botvmAddress: EXECUTOR, targetBlock: 100, maxBaseFeePerGas: 1_000_000_000n, bribeWei: 260_000_000_000_000n } };
}

test("complete redacted response retains public identifiers and original digest", async () => {
  const { rows, evidence } = collect();
  const body = JSON.stringify({ result: { bundleHash: BUNDLE, txHash: TX, address: WALLET,
    detail: "e".repeat(12_000), signature: AUTH, txs: [SIGNED],
    nested: { authorization: "Bearer secret-token", url: "https://credential.invalid/key" } } });
  const result = await observedBuilderRequest({ ...request, evidence, secrets: [SIGNED], fetch: mockFetch(body) });
  assert.equal(result.status, 200);
  assert.deepEqual(rows.map(row => row.phase), ["started", "sending", "completed"]);
  const done = rows[2];
  assert.equal(done.response_truncated, false);
  assert.equal(done.response_bytes, Buffer.byteLength(body));
  assert.equal(done.response_sha256, createHash("sha256").update(body).digest("hex"));
  assert.ok(String(done.response_body).includes("e".repeat(12_000)));
  for (const publicValue of [TX, BUNDLE, WALLET]) assert.ok(String(done.response_body).includes(publicValue));
  for (const secret of [SIGNED, AUTH, "secret-token", "credential.invalid"]) assert.ok(!JSON.stringify(rows).includes(secret));
  assert.ok(rows.every(row => row.request_id === result.requestId && row.tx_hash === TX && row.submission_id === "test-id"));
  assert.ok(Number(done.headers_received_at_ms) >= Number(done.fetch_started_at_ms));
  assert.ok(Number(done.completed_at_ms) >= Number(done.headers_received_at_ms));
  assert.ok(Number(done.elapsed_ms) >= 0);
  assert.ok(!("received_at_ms" in done) && !("rank" in done));
});

test("different builders retain independent ordering and request IDs", async () => {
  const { rows, evidence } = collect();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const slow = observedBuilderRequest({ ...request, builder: "slow", evidence,
    fetch: async () => { await pending; return response("{}"); } });
  await observedBuilderRequest({ ...request, builder: "fast", evidence, fetch: mockFetch("{}") });
  assert.deepEqual(rows.filter(row => row.phase === "completed").map(row => row.builder), ["fast"]);
  release(); await slow;
  assert.deepEqual(rows.filter(row => row.phase === "completed").map(row => row.builder), ["fast", "slow"]);
  assert.equal(new Set(rows.map(row => row.request_id)).size, 2);
});

test("transport and body failures preserve stage and sanitized error only", async () => {
  for (const stage of ["authentication", "pre_send_guard", "awaiting_headers", "reading_body"]) {
    const { rows, evidence } = collect();
    const failure = (): never => { throw new Error(`broken ${SIGNED} https://secret.invalid/key`); };
    await assert.rejects(observedBuilderRequest({ ...request, evidence, secrets: [SIGNED],
      headers: stage === "authentication" ? async () => failure() : undefined,
      beforeSend: stage === "pre_send_guard" ? failure : undefined,
      fetch: async () => {
        if (stage === "awaiting_headers") failure();
        return { ok: true, status: 200, text: async () => failure() } as unknown as Response;
      },
    }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(SIGNED) && !error.message.includes("secret.invalid"));
      assert.equal(error.cause, undefined);
      return true;
    });
    const failed = rows.at(-1)!;
    assert.equal(failed.phase, "failed"); assert.equal(failed.failure_stage, stage);
    assert.equal(failed.http_status, stage === "reading_body" ? 200 : null);
    assert.ok(!JSON.stringify(rows).includes(SIGNED));
  }
});

test("actual timeout signal reports awaiting headers versus response-body timeout", async () => {
  // Keep the isolated test process alive while AbortSignal's unref'ed timer fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const inBody of [false, true]) {
      const { rows, evidence } = collect();
      const timedFetch: typeof fetch = async (_url, init) => {
        const wait = () => new Promise<never>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        });
        if (!inBody) return wait();
        return { ok: true, status: 200, text: wait } as unknown as Response;
      };
      await assert.rejects(observedBuilderRequest({ ...request, evidence, timeoutMs: 10, fetch: timedFetch }));
      assert.equal(rows.at(-1)!.failure_stage, inBody ? "reading_body" : "awaiting_headers");
      assert.equal(rows.at(-1)!.error_name, "TimeoutError");
    }
  } finally { clearInterval(keepAlive); }
});

test("native fetch disconnect cause is retained without credentials or socket internals", async () => {
  const { rows, evidence } = collect();
  const cause = Object.assign(new Error(`socket closed https://secret.invalid ${SIGNED}`), {
    code: "UND_ERR_SOCKET", socket: { authorization: AUTH },
  });
  await assert.rejects(observedBuilderRequest({ ...request, evidence, secrets: [SIGNED],
    fetch: async () => { throw new TypeError("fetch failed", { cause }); },
  }), /fetch failed/);
  assert.equal(rows.at(-1)!.transport_cause_code, "UND_ERR_SOCKET");
  assert.match(String(rows.at(-1)!.transport_cause_message), /socket closed/);
  for (const secret of [SIGNED, AUTH, "secret.invalid"]) assert.ok(!JSON.stringify(rows).includes(secret));
});

test("guard failure after recording send intention does not claim fetch actually began", async () => {
  const { rows, evidence } = collect();
  let guards = 0, sends = 0;
  await assert.rejects(observedBuilderRequest({ ...request, evidence,
    beforeSend: () => { if (++guards === 2) throw new Error("bounded-live:inactive"); },
    fetch: async () => { sends++; return response("{}"); },
  }), /bounded-live:inactive/);
  assert.equal(sends, 0);
  assert.equal(rows.at(-1)!.failure_stage, "pre_send_guard");
  assert.equal(rows.at(-1)!.fetch_started_at_ms, null);
});

test("short auth echoes and malformed secret-bearing bodies never escape", async () => {
  const { rows, evidence } = collect();
  const res = await observedBuilderRequest({ ...request, evidence,
    headers: async () => ({ "X-Flashbots-Signature": `${WALLET}:${AUTH}` }),
    fetch: mockFetch(`broken ${AUTH} ${WALLET}:${AUTH} {"privateKey":"${"a".repeat(64)}",`),
  });
  assert.ok(!res.redactedBody.includes(AUTH));
  assert.ok(!res.redactedBody.includes("a".repeat(64)));
  assert.ok(!JSON.stringify(rows).includes(AUTH));
  await assert.rejects(observedBuilderRequest({ ...request,
    headers: async () => ({ "X-Flashbots-Signature": `${WALLET}:${AUTH}` }),
    fetch: async () => { throw new Error(AUTH); },
  }), { message: "[redacted]" });
  assert.equal(redactBuilderText(TX), TX);
});

test("evidence failure before sending prevents any fetch", async () => {
  for (const phase of ["started", "sending"]) {
    let sends = 0;
    await assert.rejects(observedBuilderRequest({ ...request,
      evidence: row => { if (row.phase === phase) throw new Error("disk-full"); },
      fetch: async () => { sends++; return response("{}"); },
    }), /disk-full/);
    assert.equal(sends, 0);
  }
});

test("failed receipt persistence cannot become a successful request", async () => {
  let sends = 0;
  await assert.rejects(observedBuilderRequest({ ...request,
    evidence: row => { if (row.phase === "completed") throw new Error("disk-full"); },
    fetch: async () => { sends++; return response("{}"); },
  }), /disk-full/);
  assert.equal(sends, 1); // Already-sent requests cannot be recalled.
});

test("final fee snapshot precedes mock signing and exactly matches unsigned fees", async () => {
  for (const balance of [ethers.parseEther("1"), 760_000_000_000_000n]) {
    const { state, params } = fakeSubmit(balance), { rows, evidence } = collect();
    const result = await buildSignedBackrunTx({ ...params, evidence: row => {
      if (row.type === "submission_fee_parameters") assert.equal(state.signs, 0);
      evidence(row);
    } });
    assert.equal(state.signs, 1); assert.equal(state.reads, 1);
    const fee = rows[0], tx = rows[1];
    assert.equal(fee.type, "submission_fee_parameters");
    assert.equal(fee.nonce, 7); assert.equal(fee.gas_limit, "130000");
    assert.equal(fee.max_priority_fee_per_gas, String(state.unsigned!.maxPriorityFeePerGas));
    assert.equal(fee.max_fee_per_gas, String(state.unsigned!.maxFeePerGas));
    assert.equal(fee.requested_bribe_budget_wei, String(params.bribeWei));
    assert.equal(fee.applied_bribe_budget_wei, balance === ethers.parseEther("1") ? "260000000000000" : "130000000000000");
    assert.equal(fee.wallet_limited, balance !== ethers.parseEther("1"));
    assert.equal(fee.calldata_hash, ethers.keccak256(params.calldataHex));
    assert.equal(tx.tx_hash, ethers.keccak256(SIGNED));
    assert.equal(fee.submission_id, tx.submission_id);
    assert.equal(result.submissionId, fee.submission_id);
    assert.ok(!JSON.stringify(rows).includes(SIGNED));
  }
});

test("missing or failed fee evidence prevents mock signing and submission", async () => {
  const { state, params } = fakeSubmit();
  initEvents("");
  await assert.rejects(submitStandaloneBundle({ ...params, evidence: emitSubmissionEvidence }), /requires SEARCHER_EVENTS_PATH/);
  assert.equal(state.signs, 0); assert.equal(state.auths, 0);
  await assert.rejects(submitStandaloneBundle({ ...params, evidence: () => { throw new Error("disk-full"); } }), /disk-full/);
  assert.equal(state.signs, 0);
});

test("transaction linkage failure prevents all builder requests after mock sign", async () => {
  const { state, params } = fakeSubmit();
  let sends = 0;
  globalThis.fetch = async () => { sends++; return response("{}"); };
  await assert.rejects(submitStandaloneBundle({ ...params, evidence: row => {
    if (row.type === "submission_transaction") throw new Error("disk-full");
  } }), /disk-full/);
  assert.equal(state.signs, 1); assert.equal(state.auths, 0); assert.equal(sends, 0);
});

test("every existing submit mode keeps payload, fees, builder fan-out and receipt pairing", async () => {
  for (const mode of ["standalone", "victim", "hash-only"]) {
    const { params, state } = fakeSubmit(), { rows, evidence } = collect();
    const calls: Array<{ url: string; body: Record<string, any> }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      return response(JSON.stringify({ id: 1, result: { bundleHash: BUNDLE } }));
    };
    const result = mode === "standalone" ? await submitStandaloneBundle({ ...params, evidence }) :
      mode === "victim" ? await submitBundle({ ...params, evidence, victimRawTx: VICTIM }) :
      [await submitMevShareBundle({ ...params, evidence, victimHash: TX })];
    assert.equal(calls.length, mode === "hash-only" ? 1 : 5);
    assert.equal(state.signs, 1); assert.equal(state.reads, 1); assert.equal(state.auths, 1);
    assert.ok(result.every(row => row.accepted && row.bundleHash === BUNDLE));
    const completed = rows.filter(row => row.type === "builder_request" && row.phase === "completed");
    assert.equal(completed.length, calls.length);
    assert.equal(new Set(completed.map(row => row.request_id)).size, calls.length);
    assert.ok(completed.every(row => row.tx_hash === ethers.keccak256(SIGNED) && row.submission_id === rows[0].submission_id));
    if (mode !== "hash-only") {
      assert.equal(calls.find(call => call.url.includes("titanbuilder.xyz"))?.url, "https://us.rpc.titanbuilder.xyz");
      assert.equal(result.find(row => row.builder === "titan")?.receiptStatus, "rpc_acknowledged");
      assert.equal(completed.find(row => row.builder === "titan")?.endpoint_id, "titan-us");
    }
    for (const call of calls) {
      const payload = call.body.params[0];
      if (mode === "hash-only") {
        assert.equal(call.body.method, "mev_sendBundle");
        assert.deepEqual(payload.body, [{ hash: TX }, { tx: SIGNED, canRevert: false }]);
        assert.deepEqual(payload.inclusion, { block: "0x64", maxBlock: "0x64" });
      } else {
        assert.equal(call.body.method, "eth_sendBundle");
        assert.deepEqual(payload, { txs: mode === "victim" ? [VICTIM, SIGNED] : [SIGNED], blockNumber: "0x64" });
      }
    }
    assert.ok(!JSON.stringify(rows).includes(SIGNED) && !JSON.stringify(rows).includes(VICTIM));
  }
});

test("Titan accepts only a matching RPC acknowledgement with a valid bundle hash", () => {
  const classify = (body: unknown, status = 200) => classifyTitanSubmissionReceipt({
    ok: status >= 200 && status < 300, status, redactedBody: JSON.stringify(body),
  }, 1);
  for (const body of [
    { result: { bundleHash: BUNDLE }, error: null, id: 1 },
    { jsonrpc: "2.0", result: { bundleHash: BUNDLE }, id: 1 },
  ]) assert.deepEqual(classify(body), { accepted: true, receiptStatus: "rpc_acknowledged", bundleHash: BUNDLE });
  for (const body of [null, [], true, {}, { id: 1 }, { id: 1, result: null },
    { id: 2, result: { bundleHash: BUNDLE } }, { id: "1", result: { bundleHash: BUNDLE } },
    { id: 1, jsonrpc: "1.0", result: { bundleHash: BUNDLE } },
    { id: 1, result: { bundleHash: "0x1234" } }, { id: 1, result: { bundleHash: 123 } },
    { id: 1, result: BUNDLE }, { id: 1, result: [BUNDLE] },
    { id: 1, result: { bundleHash: BUNDLE }, error: { message: "conflicting result" } },
    { id: 1, error: "bad request" }, { id: 1, error: {} },
    { id: 1, error: { message: "missing code" } },
    { id: 1, error: { code: "-32602", message: "string code" } },
    { id: 1, error: { code: -32602.5, message: "fractional code" } },
  ]) {
    const result = classify(body);
    assert.equal(result.accepted, false, JSON.stringify(body));
    assert.equal(result.receiptStatus, "unconfirmed", JSON.stringify(body));
    assert.equal(result.bundleHash, undefined);
  }
  assert.equal(classifyTitanSubmissionReceipt({ ok: true, status: 200, redactedBody: "not-json" }, 1).receiptStatus, "unconfirmed");
  assert.equal(classify({ id: 1, result: { bundleHash: BUNDLE } }, 502).receiptStatus, "unconfirmed");
  assert.deepEqual(classify({ id: 1, error: { code: -32602, message: "invalid block number" } }),
    { accepted: false, receiptStatus: "rpc_rejected", error: "invalid block number" });
});

test("Titan malformed receipts and network failures stay unconfirmed without retry or polling", async () => {
  const { params } = fakeSubmit(), { rows, evidence } = collect();
  for (const body of ["{}", "not-json", JSON.stringify({ id: 9, result: { bundleHash: BUNDLE } })]) {
    let sends = 0;
    globalThis.fetch = async () => { sends++; return response(body); };
    const results = await submitStandaloneBundle({ ...params, evidence });
    const titan = results.find(row => row.builder === "titan")!;
    assert.equal(sends, 5);
    assert.equal(titan.accepted, false);
    assert.equal(titan.receiptStatus, "unconfirmed");
    assert.ok(rows.some(row => row.builder === "titan" && row.phase === "completed" && row.response_body === body));
  }
  let sends = 0;
  globalThis.fetch = async () => { sends++; throw new Error("transport unavailable"); };
  const results = await submitStandaloneBundle({ ...params, evidence });
  assert.equal(sends, 5);
  assert.ok(results.every(row => !row.accepted));
  assert.equal(results.find(row => row.builder === "titan")?.receiptStatus, "unconfirmed");
  assert.ok(results.filter(row => row.builder !== "titan").every(row => row.receiptStatus === undefined));
});

test("legacy rejection logs/results are redacted but full errors survive in events", async () => {
  const { params } = fakeSubmit(), { rows, evidence } = collect();
  const longError = "detail-".repeat(1000);
  const outputs: string[] = [], savedLog = console.log;
  console.log = (...args) => { outputs.push(args.join(" ")); };
  try {
    globalThis.fetch = mockFetch(JSON.stringify({ error: { message: `${longError} ${AUTH} ${SIGNED}` } }), 429);
    const results = await submitStandaloneBundle({ ...params, evidence });
    assert.ok(results.every(row => !row.accepted));
    assert.ok(rows.filter(row => row.phase === "completed").every(row => String(row.response_body).includes(longError)));
    for (const text of [JSON.stringify(rows), JSON.stringify(results), outputs.join("\n")]) {
      assert.ok(!text.includes(SIGNED));
      // Only Flashbots sends this auth value; its echoed copy must be scrubbed.
    }
    assert.ok(!String(results.find(row => row.builder === "flashbots")!.error).includes(AUTH));
    globalThis.fetch = async () => { throw new Error(`unreachable https://secret.invalid ${SIGNED}`); };
    const failed = await submitStandaloneBundle({ ...params, evidence });
    assert.ok(failed.every(row => !row.accepted && !row.error?.includes(SIGNED) && !row.error?.includes("secret.invalid")));
  } finally { console.log = savedLog; }
});

test("Titan snapshots retain observed status/payment/error with no invented ranking", async () => {
  for (const status of ["Received", "SimulationPass", "IncludedInBlock", "Submitted"]) {
    const { rows, evidence } = collect();
    let calls = 0;
    const result = { status, builderPayment: "16845000000000", builderPaymentWhenIncluded: null, error: "observed-only" };
    const queried = await queryTitanBundleStats({ txHash: TX, bundleHash: BUNDLE, evidence,
      fetch: async (url, init) => {
        calls++;
        assert.equal(url, "https://stats.titanbuilder.xyz");
        assert.deepEqual(init!.headers, { "Content-Type": "application/json" });
        assert.deepEqual(JSON.parse(String(init!.body)), { jsonrpc: "2.0", id: 1, method: "titan_getBundleStats", params: [{ bundleHash: BUNDLE }] });
        return response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      },
    });
    assert.equal(calls, 1); assert.equal(queried.ok, true);
    const snapshot = rows.at(-1)!;
    assert.equal(snapshot.type, "builder_stats_snapshot");
    assert.deepEqual(snapshot.result, result);
    assert.equal(snapshot.tx_hash, TX); assert.equal(snapshot.bundle_hash, BUNDLE);
    assert.equal(snapshot.request_id, queried.requestId);
    assert.equal(snapshot.query_outcome, "result");
    assert.equal(typeof snapshot.observed_at_ms, "number");
    assert.ok(!("rank" in snapshot) && !("received_at_ms" in snapshot) && !("chain_included" in snapshot));
  }
});

test("stats HTTP, RPC, malformed, empty and transport failures are not reported as success", async () => {
  for (const [body, status, outcome] of [
    ['{"error":{"message":"rate-limited"}}', 429, "http_error"],
    ['{"error":{"message":"unknown"}}', 200, "rpc_error"],
    ["not-json", 200, "malformed_response"], ["null", 200, "malformed_response"],
    ['{"result":null}', 200, "no_result"],
  ] as const) {
    const { rows, evidence } = collect();
    const result = await queryTitanBundleStats({ txHash: TX, bundleHash: BUNDLE, evidence, fetch: mockFetch(body, status) });
    assert.equal(result.ok, false); assert.equal(rows.at(-1)!.query_outcome, outcome);
    assert.ok(String(rows.at(-1)!.response_body).length > 0);
  }
  const { rows, evidence } = collect();
  await assert.rejects(queryTitanBundleStats({ txHash: TX, bundleHash: BUNDLE, evidence,
    fetch: async () => { throw new Error("disconnected"); },
  }), /disconnected/);
  assert.equal(rows.at(-1)!.phase, "failed");
  assert.ok(!rows.some(row => row.type === "builder_stats_snapshot"));
});

test("same event file/envelope is reused and write failures are explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "submission-evidence-"));
  try {
    const path = join(dir, "events.jsonl"), context = initEvents(path);
    emitSubmissionEvidence({ type: "submission_transaction", tx_hash: TX });
    const row = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(row.run_id, context.runId); assert.equal(row.schema_version, 1);
    assert.equal(row.tx_hash, TX); assert.equal(typeof row.emitted_at_ms, "number");
    initEvents(dir);
    assert.throws(() => emitSubmissionEvidence({ type: "submission_transaction" }), /submission evidence write failed/);
  } finally { initEvents(""); rmSync(dir, { recursive: true, force: true }); }
});

test("offline CLI writes a private snapshot, never overwrites or queries on invalid args", async () => {
  const dir = mkdtempSync(join(tmpdir(), "builder-stats-cli-"));
  try {
    const out = join(dir, "snapshot.jsonl");
    const args = ["--tx-hash", TX, "--bundle-hash", BUNDLE, "--out", out];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return response('{"result":{"status":"Submitted"}}'); };
    assert.equal(await runBuilderStatsCli(args, fetchImpl), true);
    assert.equal(calls, 1); assert.equal(statSync(out).mode & 0o777, 0o600);
    const saved = readFileSync(out, "utf8");
    assert.equal(saved.trim().split("\n").length, 4);
    await assert.rejects(runBuilderStatsCli(args, fetchImpl), /EEXIST/);
    assert.equal(readFileSync(out, "utf8"), saved); assert.equal(calls, 1);
    const link = join(dir, "link.jsonl"); symlinkSync(out, link);
    await assert.rejects(runBuilderStatsCli([...args.slice(0, -1), link], fetchImpl), /EEXIST/);
    for (const badArgs of [[], ["--broadcast"], [...args, "--out", out], ["--tx-hash", "bad", ...args.slice(2)]]) {
      await assert.rejects(runBuilderStatsCli(badArgs, fetchImpl));
    }
    assert.equal(calls, 1);
    const failedOut = join(dir, "failed.jsonl");
    assert.equal(await runBuilderStatsCli([...args.slice(0, -1), failedOut], mockFetch('{"error":{"message":"expired"}}')), false);
    assert.ok(readFileSync(failedOut, "utf8").includes('"query_outcome":"rpc_error"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const savedFetch = globalThis.fetch, savedPath = process.env.SEARCHER_LIVE_SESSION_PATH;
delete process.env.SEARCHER_LIVE_SESSION_PATH;
let passed = 0;
try {
  for (const [name, run] of tests) {
    await run(); passed++;
    console.log(`[submission-evidence] ${name}: PASS`);
  }
  console.log(`submission-evidence: ${passed}/${tests.length} offline checks passed`);
} finally {
  globalThis.fetch = savedFetch;
  if (savedPath === undefined) delete process.env.SEARCHER_LIVE_SESSION_PATH;
  else process.env.SEARCHER_LIVE_SESSION_PATH = savedPath;
}
