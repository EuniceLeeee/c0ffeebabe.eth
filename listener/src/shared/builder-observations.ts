import { createHash, randomUUID } from "node:crypto";

export type BuilderEvidence = {
  readonly type: "submission_fee_parameters" | "submission_transaction" |
    "builder_request" | "builder_stats_snapshot" |
    "submission_head_observed" | "submission_clock_snapshot";
  readonly [key: string]: unknown;
};
export type BuilderEvidenceSink = (event: BuilderEvidence) => void;

export type SubmissionReceipt = {
  accepted: boolean;
  receiptStatus: "rpc_acknowledged" | "rpc_rejected" | "unconfirmed";
  bundleHash?: string;
  error?: string;
};

/** Titan's RPC acknowledgement proves neither simulation nor candidate-block inclusion. */
export function classifyTitanSubmissionReceipt(input: {
  ok: boolean; status: number; redactedBody: string;
}, expectedId: number | string): SubmissionReceipt {
  const unconfirmed = (reason: string): SubmissionReceipt => ({
    accepted: false, receiptStatus: "unconfirmed", error: reason,
  });
  let parsed: unknown;
  try { parsed = JSON.parse(input.redactedBody); }
  catch { return unconfirmed("malformed_response"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unconfirmed("malformed_response");
  const rpc = parsed as Record<string, unknown>;
  if (rpc.id !== expectedId) return unconfirmed("response_id_mismatch");
  // Titan's documented success example omits jsonrpc; reject a conflicting version, not its absence.
  if (rpc.jsonrpc !== undefined && rpc.jsonrpc !== "2.0") return unconfirmed("invalid_rpc_version");
  if (rpc.error != null) {
    if (rpc.result != null || typeof rpc.error !== "object" || Array.isArray(rpc.error)) {
      return unconfirmed("invalid_rpc_error");
    }
    const error = rpc.error as Record<string, unknown>;
    if (!Number.isSafeInteger(error.code) || typeof error.message !== "string" || !error.message) {
      return unconfirmed("invalid_rpc_error");
    }
    return { accepted: false, receiptStatus: "rpc_rejected", error: error.message };
  }
  if (!input.ok) return unconfirmed(`http_error:${input.status}`);
  const result = rpc.result;
  const hash = result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>).bundleHash : undefined;
  if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash)) return unconfirmed("missing_or_invalid_bundle_hash");
  return { accepted: true, receiptStatus: "rpc_acknowledged", bundleHash: hash };
}

class BuilderResponseTooLargeError extends Error {
  override name = "BuilderResponseTooLargeError";
  constructor(readonly observedBytes: number, readonly limitBytes: number) {
    super("builder response exceeded observation byte limit");
  }
}

async function readResponseBody(response: Response, limit?: number): Promise<string> {
  if (limit === undefined) return response.text(); // Submission receipts retain existing behavior.
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new BuilderResponseTooLargeError(Buffer.byteLength(text), limit);
    return text;
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return Buffer.concat(chunks).toString("utf8");
      bytes += item.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new BuilderResponseTooLargeError(bytes, limit);
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
}

/** Public hashes/addresses survive; credentials, signatures and execution bytes do not. */
export function redactBuilderText(text: string, secrets: readonly string[] = []): string {
  const scrub = (value: string): string => {
    for (const secret of secrets) {
      if (secret.length > 0) value = value.split(secret).join("[redacted]");
    }
    return value
      .replace(/https?:\/\/[^\s"'<>\\]+/gi, "[redacted-url]")
      .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
      .replace(/(["']?\b(?:private[_-]?key|api[_-]?key|secret|password|authorization|signature|x-flashbots-signature|access[_-]?token|raw[_-]?tx|signed[_-]?(?:tx|transaction)|calldata)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
        "$1[redacted]")
      .replace(/0x[0-9a-f]{65,}/gi, "[redacted-bytes]");
  };
  const sensitiveKey = /^(?:private[_-]?key|api[_-]?key|secret|password|authorization|signature|x-flashbots-signature|access[_-]?token|raw[_-]?tx|signed[_-]?(?:tx|transaction)|txs|calldata)$/i;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [scrub(key), sensitiveKey.test(key) ? "[redacted]" : walk(item)]),
    );
    return value;
  };
  try { return JSON.stringify(walk(JSON.parse(text))); }
  catch { return scrub(text); }
}

/** Observes an existing request; never retries, signs, polls or changes its payload. */
export async function observedBuilderRequest(input: {
  readonly builder: string;
  /** Static, credential-free endpoint label, never a raw URL. */
  readonly endpointId?: string;
  readonly purpose: "submission" | "stats_query";
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly txHash: string;
  readonly targetBlock?: number;
  readonly bundleHash?: string;
  readonly submissionId?: string;
  readonly headers?: () => Promise<Record<string, string>>;
  readonly beforeSend?: () => void;
  readonly evidence?: BuilderEvidenceSink;
  readonly secrets?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxResponseBytes?: number;
}): Promise<{ ok: boolean; status: number; redactedBody: string; requestId: string }> {
  const requestId = randomUUID();
  const started = performance.now();
  const base = {
    type: "builder_request" as const, request_id: requestId,
    submission_id: input.submissionId ?? null,
    purpose: input.purpose, builder: input.builder, method: input.method,
    endpoint_id: input.endpointId ?? input.builder,
    tx_hash: input.txHash, target_block: input.targetBlock ?? null,
    bundle_hash: input.bundleHash ?? null, request_started_at_ms: Date.now(),
    request_started_at_monotonic_ms: started, monotonic_time_origin_ms: performance.timeOrigin,
  };
  input.evidence?.({ ...base, phase: "started" });
  let stage = "authentication", sentAt: number | null = null;
  let headersAt: number | null = null, httpStatus: number | null = null;
  let sentMonotonic: number | null = null, headersMonotonic: number | null = null;
  const secrets = [...input.secrets ?? []];
  let result: { ok: boolean; status: number; rawBody: string };
  try {
    const headers = await input.headers?.() ?? { "Content-Type": "application/json" };
    for (const [key, value] of Object.entries(headers)) {
      if (/authorization|signature|api.?key|token/i.test(key)) {
        secrets.push(value);
        // A relay may echo the credential without the address/scheme prefix.
        if (/signature/i.test(key)) secrets.push(value.split(":").at(-1)!);
        if (/^Bearer\s+/i.test(value)) secrets.push(value.replace(/^Bearer\s+/i, ""));
      }
    }
    stage = "pre_send_guard";
    input.beforeSend?.();
    input.evidence?.({ ...base, phase: "sending", send_prepared_at_ms: Date.now() });
    // A failed evidence write must not be converted into an HTTP success.
    input.beforeSend?.();
    stage = "awaiting_headers";
    input.signal?.throwIfAborted();
    sentAt = Date.now();
    sentMonotonic = performance.now();
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 5_000);
    const res = await (input.fetch ?? globalThis.fetch)(input.url, {
      method: "POST", headers, body: input.body,
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    });
    headersAt = Date.now(); httpStatus = res.status;
    headersMonotonic = performance.now();
    stage = "reading_body";
    const rawBody = await readResponseBody(res, input.maxResponseBytes);
    result = { ok: res.ok, status: res.status, rawBody };
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const causeCode = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? redactBuilderText(cause.code, secrets) : null;
    const safeError = new Error(redactBuilderText(error instanceof Error ? error.message : String(error), secrets));
    safeError.name = redactBuilderText(error instanceof Error ? error.name : "Error", secrets);
    input.evidence?.({
      ...base, phase: "failed", failure_stage: stage,
      fetch_started_at_ms: sentAt, headers_received_at_ms: headersAt,
      fetch_started_at_monotonic_ms: sentMonotonic, headers_received_at_monotonic_ms: headersMonotonic,
      completed_at_ms: Date.now(), elapsed_ms: performance.now() - started,
      http_status: httpStatus,
      error_name: safeError.name, error: safeError.message,
      transport_cause_code: causeCode,
      transport_cause_message: cause instanceof Error ? redactBuilderText(cause.message, secrets) : null,
      ...(error instanceof BuilderResponseTooLargeError ? {
        response_truncated: true, response_bytes_observed: error.observedBytes, response_limit_bytes: error.limitBytes,
      } : {}),
    });
    // No original error/cause: upstream logs must not regain raw credentials.
    throw safeError;
  }
  const completedAt = Date.now(), elapsedMs = performance.now() - started;
  const redactedBody = redactBuilderText(result.rawBody, secrets);
  input.evidence?.({
    ...base, phase: "completed", fetch_started_at_ms: sentAt,
    headers_received_at_ms: headersAt, completed_at_ms: completedAt,
    fetch_started_at_monotonic_ms: sentMonotonic, headers_received_at_monotonic_ms: headersMonotonic,
    elapsed_ms: elapsedMs, http_status: result.status,
    http_ok: result.ok, response_body: redactedBody,
    response_bytes: Buffer.byteLength(result.rawBody), response_truncated: false,
    response_sha256: createHash("sha256").update(result.rawBody).digest("hex"),
  });
  return { ok: result.ok, status: result.status, redactedBody, requestId };
}

/** Read-only: the verified Titan stats API needs neither a key nor a signature. */
export async function queryTitanBundleStats(input: {
  readonly txHash: string;
  readonly bundleHash: string;
  readonly evidence: BuilderEvidenceSink;
  readonly fetch?: typeof fetch;
  readonly targetBlock?: number;
  readonly submissionId?: string;
  readonly signal?: AbortSignal;
}): Promise<{ ok: boolean; requestId: string }> {
  if (![input.txHash, input.bundleHash].every(value => /^0x[0-9a-f]{64}$/i.test(value))) {
    throw new Error("stats query requires transaction and bundle hashes");
  }
  // https://docs.titanbuilder.xyz/bundle-tracing
  const response = await observedBuilderRequest({
    builder: "titan", purpose: "stats_query", method: "titan_getBundleStats",
    url: "https://stats.titanbuilder.xyz", txHash: input.txHash,
    bundleHash: input.bundleHash, evidence: input.evidence, fetch: input.fetch,
    targetBlock: input.targetBlock, submissionId: input.submissionId, signal: input.signal,
    maxResponseBytes: 1_048_576,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "titan_getBundleStats",
      params: [{ bundleHash: input.bundleHash }] }),
  });
  let rpc: { result?: unknown; error?: unknown } | null = null;
  try {
    const parsed: unknown = JSON.parse(response.redactedBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rpc = parsed;
  } catch { /* Retain malformed responses too. */ }
  const outcome = !response.ok ? "http_error" : !rpc ? "malformed_response" :
    rpc.error != null ? "rpc_error" : rpc.result == null ? "no_result" : "result";
  input.evidence({
    type: "builder_stats_snapshot", builder: "titan", request_id: response.requestId,
    tx_hash: input.txHash, bundle_hash: input.bundleHash, observed_at_ms: Date.now(),
    target_block: input.targetBlock ?? null, submission_id: input.submissionId ?? null,
    http_status: response.status, http_ok: response.ok, query_outcome: outcome,
    result: rpc?.result ?? null, rpc_error: rpc?.error ?? null,
    response_body: response.redactedBody,
    // This timestamp is OUR observation, never a claimed builder receipt time or ranking.
    response_truncated: false,
  });
  return { ok: outcome === "result", requestId: response.requestId };
}
