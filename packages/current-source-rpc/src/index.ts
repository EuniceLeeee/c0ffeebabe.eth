import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeJson,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  SharedWorkCache,
  consumerLease,
  type SemanticWorkKey,
} from "../../shared-work/src/index.ts";
import {
  familySearchSource,
  sameFamilySearchSource,
  type FamilySearchCurrentSourceV1,
  type FamilySearchSourceReadPortV1,
  type FamilySearchSourceReadRequestV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchSourceV1,
} from "../../family-sdk/search-runtime/index.ts";

/** Physical failure classes produced by the current-source RPC boundary. */
export type CurrentSourceRpcReasonCode =
  | "source-stale"
  | "abort"
  | "deadline"
  | "transport"
  | "rpc"
  | "unavailable"
  | "malformed-response";

export interface CurrentSourceRpcReadTransportOptions {
  /** HTTP(S) JSON-RPC endpoint. */
  readonly endpoint: string | URL;
  /** Source session which owns the read's current-source fence. */
  readonly currentSource: FamilySearchCurrentSourceV1;
  /** Maximum time spent in the physical HTTP request. */
  readonly timeoutMs?: number;
  /** Optional HTTP headers; Content-Type and Accept have safe defaults. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable HTTP implementation only; callers cannot inject evaluation. */
  readonly fetch?: typeof globalThis.fetch;
}

interface ReadInput {
  readonly request: FamilySearchSourceReadRequestV1;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
}

interface RpcSuccessResponse {
  readonly kind: "returned";
  readonly dataHex: string;
}

interface RpcErrorResponse {
  readonly kind: "rpc";
  readonly errorCode: number;
  readonly dataHex: string | null;
}

type DecodedRpcResponse = RpcSuccessResponse | RpcErrorResponse;

type PhysicalRpcOutcome =
  | { readonly kind: "returned"; readonly dataHex: string }
  | { readonly kind: "reverted"; readonly errorCode: number; readonly dataHex: string; readonly dataEncoding: `abi-${string}` }
  | { readonly kind: "unavailable"; readonly reasonCode: CurrentSourceRpcReasonCode };

export interface CurrentSourceRpcFactStats {
  readonly logicalReads: number;
  readonly physicalBuilds: number;
  readonly settledHits: number;
  readonly inFlightJoins: number;
  readonly buildFailures: number;
  readonly invalidResults: number;
  readonly consumerAborts: number;
  readonly consumerDeadlines: number;
  readonly physicalAborts: number;
  readonly settledEntries: number;
  readonly inFlightEntries: number;
  readonly consumers: number;
}

export type CurrentSourceRpcLaneV1 = "blockscan" | "backrun";

export interface CurrentSourceRpcLogicalScopeBindingV1 {
  readonly lane: CurrentSourceRpcLaneV1;
  readonly correlationId: Hash;
}

export interface CurrentSourceRpcLogicalFactStatsV1 {
  readonly logicalReads: number;
  readonly settledHits: number;
  readonly inFlightJoins: number;
  readonly consumerAborts: number;
  readonly consumerDeadlines: number;
}

export interface CurrentSourceRpcLogicalScopeFactsV1 extends CurrentSourceRpcLogicalFactStatsV1 {
  readonly kind: "aloha.current-source-rpc.logical-scope-facts-v1";
  readonly lane: CurrentSourceRpcLaneV1;
  readonly correlationId: Hash;
  readonly source: FamilySearchSourceV1;
}

export interface CurrentSourceRpcPhysicalFactsV1 {
  readonly kind: "aloha.current-source-rpc.physical-facts-v1";
  readonly source: FamilySearchSourceV1;
  readonly openedMonotonicNs: string;
  readonly closedMonotonicNs: string;
  readonly elapsedUs: string;
  /** Exact owner-issued logical facts sealed into logicalScopeFactsRoot. */
  readonly logicalScopeFacts: readonly CurrentSourceRpcLogicalScopeFactsV1[];
  /** Exact ordered blockscan/backrun logical facts sealed by this transport. */
  readonly logicalScopeFactsRoot: Hash;
  readonly physicalBuilds: number;
  readonly buildFailures: number;
  readonly invalidResults: number;
  readonly physicalAborts: number;
  readonly settledEntries: number;
  readonly inFlightEntries: 0;
  readonly consumers: 0;
}

/** Owner-issued logical read port. Structural clones are not capabilities. */
export interface CurrentSourceRpcLogicalReadScopeV1 extends FamilySearchSourceReadPortV1 {}

interface LogicalScopeState {
  readonly binding: CurrentSourceRpcLogicalScopeBindingV1;
  readonly stats: {
    logicalReads: number;
    settledHits: number;
    inFlightJoins: number;
    consumerAborts: number;
    consumerDeadlines: number;
  };
  activeReads: number;
  closed: boolean;
  facts: CurrentSourceRpcLogicalScopeFactsV1 | null;
}

const logicalFactsIssued = new WeakSet<object>();
const physicalFactsIssued = new WeakSet<object>();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const DEFAULT_TIMEOUT_MS = 5_000;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertHexAddress(value: unknown, path: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new TypeError(`${path} must be a 20-byte hex address`);
  }
  return value;
}

function assertHexBytes(value: unknown, path: string): string {
  if (typeof value !== "string" || !HEX_BYTES_RE.test(value)) {
    throw new TypeError(`${path} must be even-length hex bytes`);
  }
  return value;
}

function assertSignal(value: unknown, path: string): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    value === null
    || typeof value !== "object"
    || typeof (value as { readonly aborted?: unknown }).aborted !== "boolean"
    || typeof (value as { readonly addEventListener?: unknown }).addEventListener !== "function"
  ) {
    throw new TypeError(`${path} must be an AbortSignal`);
  }
  return value as AbortSignal;
}

function readInput(value: unknown): ReadInput {
  if (value === null || typeof value !== "object") {
    throw new TypeError("current-source RPC read input is required");
  }
  const input = value as Record<string, unknown>;
  const fields = ["request"];
  if (hasOwn(input, "signal")) fields.push("signal");
  if (hasOwn(input, "deadlineAtMs")) fields.push("deadlineAtMs");
  assertExactKeys(input, fields, "read");
  if (hasOwn(input, "signal") && input.signal === undefined) {
    throw new TypeError("read.signal must be omitted rather than undefined");
  }
  return Object.freeze({
    request: readRequest(input.request),
    ...(hasOwn(input, "signal") ? { signal: assertSignal(input.signal, "read.signal") } : {}),
    ...(hasOwn(input, "deadlineAtMs")
      ? {
        deadlineAtMs: typeof input.deadlineAtMs === "number" && Number.isFinite(input.deadlineAtMs)
          ? input.deadlineAtMs
          : (() => { throw new TypeError("read.deadlineAtMs must be finite"); })(),
      }
      : {}),
  });
}

function readRequest(value: unknown): FamilySearchSourceReadRequestV1 {
  const input = value as Record<string, unknown>;
  const fields = ["kind", "requestId", "source", "target", "data", "responseEncoding"];
  if (value !== null && typeof value === "object" && hasOwn(input, "declaredRevertData")) fields.push("declaredRevertData");
  assertExactKeys(value, fields, "read.request");
  const request = value as Record<string, unknown>;
  if (request.kind !== "family-search.current-source-read") {
    throw new TypeError("read.request.kind mismatch");
  }
  const responseEncoding = assertNonEmptyString(request.responseEncoding, "read.request.responseEncoding");
  if (responseEncoding !== "hex" && !/^abi-[a-z0-9][a-z0-9+._:-]*$/.test(responseEncoding)) {
    throw new TypeError("read.request.responseEncoding must describe raw hex or ABI return bytes");
  }
  let declaredRevertData: FamilySearchSourceReadRequestV1["declaredRevertData"];
  if (hasOwn(request, "declaredRevertData")) {
    assertExactKeys(request.declaredRevertData, ["kind", "dataEncoding", "selector", "byteLength"], "read.request.declaredRevertData");
    const declaration = request.declaredRevertData as Record<string, unknown>;
    if (declaration.kind !== "declared-revert-data") throw new TypeError("read.request.declaredRevertData.kind mismatch");
    const dataEncoding = assertNonEmptyString(declaration.dataEncoding, "read.request.declaredRevertData.dataEncoding");
    if (!/^abi-[a-z0-9][a-z0-9+._:-]*$/.test(dataEncoding)) throw new TypeError("read.request.declaredRevertData.dataEncoding must describe ABI revert bytes");
    const selector = assertHexBytes(declaration.selector, "read.request.declaredRevertData.selector");
    if (selector.length !== 10) throw new TypeError("read.request.declaredRevertData.selector must be four bytes");
    if (typeof declaration.byteLength !== "number" || !Number.isSafeInteger(declaration.byteLength) || declaration.byteLength < 4) throw new TypeError("read.request.declaredRevertData.byteLength must be a positive safe integer");
    declaredRevertData = Object.freeze({ kind: "declared-revert-data", dataEncoding: dataEncoding as `abi-${string}`, selector: selector.toLowerCase() as `0x${string}`, byteLength: declaration.byteLength });
  }
  return deepFreeze({
    kind: "family-search.current-source-read" as const,
    requestId: assertHash(request.requestId, "read.request.requestId"),
    source: familySearchSource(request.source, "read.request.source"),
    target: assertHexAddress(request.target, "read.request.target"),
    data: assertHexBytes(request.data, "read.request.data"),
    responseEncoding: responseEncoding as FamilySearchSourceReadRequestV1["responseEncoding"],
    ...(declaredRevertData === undefined ? {} : { declaredRevertData }),
  });
}

function unavailable(
  request: FamilySearchSourceReadRequestV1,
  reasonCode: CurrentSourceRpcReasonCode,
): FamilySearchSourceReadResultV1 {
  return Object.freeze({
    kind: "unavailable" as const,
    requestId: request.requestId,
    source: request.source,
    reasonCode,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function transportReason(
  error: unknown,
  signal: AbortSignal | undefined,
  timedOut: boolean,
): CurrentSourceRpcReasonCode {
  if (timedOut) return "deadline";
  if (signal?.aborted || isAbortError(error)) return "abort";
  return "transport";
}

function decodeRpcResponse(body: string, requestId: Hash): DecodedRpcResponse | null {
  let value: unknown;
  try {
    value = decodeJson(body);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (response.jsonrpc !== "2.0" || response.id !== requestId) return null;

  if (hasOwn(response, "result")) {
    try {
      assertExactKeys(response, ["jsonrpc", "id", "result"], "rpc.response");
    } catch {
      return null;
    }
    if (typeof response.result !== "string" || !HEX_BYTES_RE.test(response.result)) return null;
    // Preserve the provider's bytes exactly. No ABI/protocol decoder belongs here.
    return { kind: "returned", dataHex: response.result };
  }

  if (hasOwn(response, "error")) {
    let error: Record<string, unknown>;
    try {
      assertExactKeys(response, ["jsonrpc", "id", "error"], "rpc.response");
      if (response.error === null || typeof response.error !== "object" || Array.isArray(response.error)) return null;
      error = response.error as Record<string, unknown>;
      assertExactKeys(error, hasOwn(error, "data") ? ["code", "message", "data"] : ["code", "message"], "rpc.response.error");
      if (typeof error.code !== "number" || !Number.isSafeInteger(error.code) || typeof error.message !== "string") return null;
    } catch {
      return null;
    }
    const dataHex = hasOwn(error, "data") && typeof error.data === "string" && HEX_BYTES_RE.test(error.data)
      ? error.data
      : null;
    if (hasOwn(error, "data") && dataHex === null) return null;
    return { kind: "rpc", errorCode: error.code, dataHex };
  }

  return null;
}

function endpointUrl(value: string | URL): string {
  let endpoint: URL;
  try {
    endpoint = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new TypeError("current-source RPC endpoint must be a URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("current-source RPC endpoint must use HTTP(S)");
  }
  return endpoint.href;
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError("timeoutMs must be positive");
  return timeout;
}

function currentSourceSnapshot(currentSource: FamilySearchCurrentSourceV1): FamilySearchSourceV1 {
  if (!currentSource || typeof currentSource !== "object" || typeof currentSource.assertCurrent !== "function") {
    throw new TypeError("currentSource with assertCurrent is required");
  }
  return familySearchSource(currentSource.source, "currentSource.source");
}

function logicalScopeBinding(value: unknown): CurrentSourceRpcLogicalScopeBindingV1 {
  assertExactKeys(value, ["lane", "correlationId"], "currentSourceRpc.logicalScope");
  const binding = value as Record<string, unknown>;
  if (binding.lane !== "blockscan" && binding.lane !== "backrun") {
    throw new TypeError("currentSourceRpc.logicalScope.lane is invalid");
  }
  const correlationId = assertHash(binding.correlationId, "currentSourceRpc.logicalScope.correlationId");
  if (correlationId === `0x${"0".repeat(64)}`) {
    throw new TypeError("currentSourceRpc.logicalScope.correlationId must be non-zero");
  }
  return Object.freeze({ lane: binding.lane, correlationId });
}

export function assertIssuedCurrentSourceRpcLogicalScopeFactsV1(
  value: unknown,
): asserts value is CurrentSourceRpcLogicalScopeFactsV1 {
  if (value === null || typeof value !== "object" || !logicalFactsIssued.has(value)) {
    throw new TypeError("current-source RPC logical scope facts are not owner-issued");
  }
}

export function assertIssuedCurrentSourceRpcPhysicalFactsV1(
  value: unknown,
): asserts value is CurrentSourceRpcPhysicalFactsV1 {
  if (value === null || typeof value !== "object" || !physicalFactsIssued.has(value)) {
    throw new TypeError("current-source RPC physical facts are not owner-issued");
  }
}

/**
 * Join root for the two logical lanes owned by one physical transport.  The
 * input objects must be the original owner-issued facts; structural copies do
 * not acquire authority merely by reproducing their fields.
 */
export function currentSourceRpcLogicalScopeFactsRoot(
  values: readonly CurrentSourceRpcLogicalScopeFactsV1[],
): Hash {
  if (!Array.isArray(values) || values.length !== 2) {
    throw new TypeError("current-source RPC logical facts require exactly two lanes");
  }
  const ordered = [...values].sort((left, right) => left.lane === right.lane ? 0 : left.lane === "blockscan" ? -1 : 1);
  for (const value of ordered) assertIssuedCurrentSourceRpcLogicalScopeFactsV1(value);
  if (ordered[0]?.lane !== "blockscan" || ordered[1]?.lane !== "backrun") {
    throw new TypeError("current-source RPC logical facts require blockscan and backrun lanes");
  }
  if (!sameFamilySearchSource(ordered[0].source, ordered[1].source)) {
    throw new TypeError("current-source RPC logical facts source mismatch");
  }
  if (ordered[0].correlationId === ordered[1].correlationId) {
    throw new TypeError("current-source RPC logical facts correlation collision");
  }
  return hashDomain("aloha/current-source-rpc/logical-scope-facts-root/v1", ordered);
}

/**
 * A real HTTP JSON-RPC read port for `FamilySearchSourceReadPortV1`.
 *
 * This class owns only physical request lifecycle and source freshness. It
 * does not decode a Family response, decide admission, or evaluate a route.
 */
export class CurrentSourceRpcReadTransport implements FamilySearchSourceReadPortV1 {
  private readonly endpoint: string;
  private readonly currentSource: FamilySearchCurrentSourceV1;
  private readonly boundSource: FamilySearchSourceV1;
  private readonly timeoutMs: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sharedWork: SharedWorkCache<SemanticWorkKey, PhysicalRpcOutcome>;
  private readonly openedMonotonicNs: bigint;
  private readonly logicalScopes = new WeakMap<object, LogicalScopeState>();
  private readonly scopesByLane = new Map<CurrentSourceRpcLaneV1, LogicalScopeState>();
  private readonly activePhysical = new Set<Promise<PhysicalRpcOutcome>>();
  private logicalReads = 0;
  private physicalFactsClosing = false;
  private physicalFactsClosed = false;

  constructor(options: CurrentSourceRpcReadTransportOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("current-source RPC options are required");
    this.endpoint = endpointUrl(options.endpoint);
    this.currentSource = options.currentSource;
    this.boundSource = currentSourceSnapshot(options.currentSource);
    this.timeoutMs = positiveTimeout(options.timeoutMs);
    if (options.headers !== undefined) {
      if (options.headers === null || typeof options.headers !== "object") throw new TypeError("headers must be an object");
      this.headers = Object.freeze({ ...options.headers });
      for (const [key, value] of Object.entries(this.headers)) {
        if (typeof value !== "string") throw new TypeError(`headers.${key} must be a string`);
      }
    } else {
      this.headers = Object.freeze({});
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") throw new TypeError("global fetch is required");
    this.sharedWork = new SharedWorkCache<SemanticWorkKey, PhysicalRpcOutcome>({
      validity: (value) => value.kind === "returned" || value.kind === "reverted",
    });
    this.openedMonotonicNs = process.hrtime.bigint();
  }

  issueLogicalReadScope(
    bindingValue: CurrentSourceRpcLogicalScopeBindingV1,
  ): CurrentSourceRpcLogicalReadScopeV1 {
    if (this.physicalFactsClosing || this.physicalFactsClosed) {
      throw new TypeError("current-source RPC physical facts are already closing");
    }
    const binding = logicalScopeBinding(bindingValue);
    if (this.scopesByLane.has(binding.lane)) {
      throw new TypeError(`current-source RPC ${binding.lane} logical scope is already issued`);
    }
    for (const state of this.scopesByLane.values()) {
      if (state.binding.correlationId === binding.correlationId) {
        throw new TypeError("current-source RPC logical scope correlation is already issued");
      }
    }
    const state: LogicalScopeState = {
      binding,
      stats: {
        logicalReads: 0,
        settledHits: 0,
        inFlightJoins: 0,
        consumerAborts: 0,
        consumerDeadlines: 0,
      },
      activeReads: 0,
      closed: false,
      facts: null,
    };
    const owner = this;
    const scope = Object.freeze({
      read(
        this: CurrentSourceRpcLogicalReadScopeV1,
        input: ReadInput,
      ): Promise<FamilySearchSourceReadResultV1> {
        return owner.readLogical(this, input);
      },
    });
    this.logicalScopes.set(scope, state);
    this.scopesByLane.set(binding.lane, state);
    return scope;
  }

  closeLogicalReadScope(
    scope: CurrentSourceRpcLogicalReadScopeV1,
  ): CurrentSourceRpcLogicalScopeFactsV1 {
    const state = this.scopeState(scope);
    if (state.closed) throw new TypeError("current-source RPC logical scope is already closed");
    if (state.activeReads !== 0) throw new TypeError("current-source RPC logical scope has active reads");
    state.closed = true;
    const facts = Object.freeze({
      kind: "aloha.current-source-rpc.logical-scope-facts-v1" as const,
      lane: state.binding.lane,
      correlationId: state.binding.correlationId,
      source: this.boundSource,
      ...state.stats,
    });
    logicalFactsIssued.add(facts);
    state.facts = facts;
    return facts;
  }

  async closePhysicalFacts(): Promise<CurrentSourceRpcPhysicalFactsV1> {
    if (this.physicalFactsClosing || this.physicalFactsClosed) {
      throw new TypeError("current-source RPC physical facts are already closed");
    }
    if (this.scopesByLane.size !== 2 || !this.scopesByLane.has("blockscan") || !this.scopesByLane.has("backrun")) {
      throw new TypeError("current-source RPC physical facts require both logical lanes");
    }
    if ([...this.scopesByLane.values()].some(state => !state.closed)) {
      throw new TypeError("current-source RPC physical facts require closed logical scopes");
    }
    const logicalFacts = (["blockscan", "backrun"] as const).map(lane => {
      const facts = this.scopesByLane.get(lane)?.facts;
      if (facts === null || facts === undefined) throw new TypeError("current-source RPC logical facts are missing");
      return facts;
    });
    const logicalScopeFactsRoot = currentSourceRpcLogicalScopeFactsRoot(logicalFacts);
    this.physicalFactsClosing = true;
    while (this.activePhysical.size > 0) {
      await Promise.allSettled([...this.activePhysical]);
    }
    await Promise.resolve();
    const snapshot = this.sharedWork.snapshot();
    if (snapshot.inFlightEntries !== 0 || snapshot.consumers !== 0) {
      this.physicalFactsClosing = false;
      throw new TypeError("current-source RPC physical work has not settled");
    }
    const closedMonotonicNs = process.hrtime.bigint();
    if (closedMonotonicNs < this.openedMonotonicNs) throw new TypeError("current-source RPC monotonic clock regressed");
    const facts = Object.freeze({
      kind: "aloha.current-source-rpc.physical-facts-v1" as const,
      source: this.boundSource,
      openedMonotonicNs: this.openedMonotonicNs.toString(),
      closedMonotonicNs: closedMonotonicNs.toString(),
      elapsedUs: ((closedMonotonicNs - this.openedMonotonicNs) / 1_000n).toString(),
      logicalScopeFacts: Object.freeze(logicalFacts),
      logicalScopeFactsRoot,
      physicalBuilds: snapshot.stats.physicalBuilds,
      buildFailures: snapshot.stats.buildFailures,
      invalidResults: snapshot.stats.invalidResults,
      physicalAborts: snapshot.stats.physicalAborts,
      settledEntries: snapshot.settledEntries,
      inFlightEntries: 0 as const,
      consumers: 0 as const,
    });
    this.physicalFactsClosed = true;
    physicalFactsIssued.add(facts);
    return facts;
  }

  async read(inputValue: {
    readonly request: FamilySearchSourceReadRequestV1;
    readonly signal?: AbortSignal;
    readonly deadlineAtMs?: number;
  }): Promise<FamilySearchSourceReadResultV1> {
    return this.readOwned(inputValue, null);
  }

  private async readLogical(
    scope: CurrentSourceRpcLogicalReadScopeV1,
    inputValue: ReadInput,
  ): Promise<FamilySearchSourceReadResultV1> {
    const state = this.scopeState(scope);
    if (state.closed) throw new TypeError("current-source RPC logical scope is closed");
    state.activeReads += 1;
    try {
      return await this.readOwned(inputValue, state);
    } finally {
      state.activeReads -= 1;
    }
  }

  private async readOwned(
    inputValue: ReadInput,
    logical: LogicalScopeState | null,
  ): Promise<FamilySearchSourceReadResultV1> {
    if (this.physicalFactsClosing || this.physicalFactsClosed) {
      throw new TypeError("current-source RPC physical facts are closed");
    }
    if (logical?.closed) throw new TypeError("current-source RPC logical scope is closed");
    const input = readInput(inputValue);
    const request = input.request;
    this.logicalReads += 1;
    if (logical !== null) logical.stats.logicalReads += 1;

    const before = await this.assertCurrent(request);
    if (before !== null) return unavailable(request, before);
    if (input.signal?.aborted) {
      if (logical !== null) logical.stats.consumerAborts += 1;
      return unavailable(request, "abort");
    }

    const key: SemanticWorkKey = {
      ownerRef: "current-source-rpc",
      provider: {
        provider: "http-json-rpc",
        backendEpoch: this.endpoint,
      },
      source: request.source,
      capabilityFingerprint: "eth_call/eip-1898",
      target: request.target,
      request: {
        calldata: request.data,
        responseEncoding: request.responseEncoding,
        declaredRevertData: request.declaredRevertData === undefined
          ? null
          : {
            kind: request.declaredRevertData.kind,
            dataEncoding: request.declaredRevertData.dataEncoding,
            selector: request.declaredRevertData.selector,
            byteLength: request.declaredRevertData.byteLength,
          },
      },
    };
    let physical: PhysicalRpcOutcome | null = null;
    let readFailure: CurrentSourceRpcReasonCode | null = null;
    try {
      const beforeAdmission = this.sharedWork.snapshot().stats;
      const pending = this.sharedWork.getOrBuild(
        key,
        consumerLease(request.requestId, {
          signal: input.signal,
          deadlineAtMs: input.deadlineAtMs,
        }),
        (signal) => this.trackPhysical(this.executePhysical(request, signal)),
      );
      const afterAdmission = this.sharedWork.snapshot().stats;
      if (logical !== null) {
        if (afterAdmission.settledHits === beforeAdmission.settledHits + 1) logical.stats.settledHits += 1;
        if (afterAdmission.inFlightJoins === beforeAdmission.inFlightJoins + 1) logical.stats.inFlightJoins += 1;
      }
      physical = await pending;
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const code = (error as { readonly code?: unknown }).code;
        if (code === "abort" || code === "deadline") {
          readFailure = code;
          if (logical !== null) {
            if (code === "abort") logical.stats.consumerAborts += 1;
            else logical.stats.consumerDeadlines += 1;
          }
        }
      }
      if (readFailure === null) readFailure = "transport";
    }

    // Every logical read gets its own post-read fence, including a consumer
    // abort/deadline and a failed physical request.  A shared physical result
    // must never skip the caller's source freshness check.
    const after = await this.assertCurrent(request);
    if (after !== null) return unavailable(request, after);
    if (readFailure !== null || physical === null) {
      return unavailable(request, readFailure ?? "transport");
    }
    if (physical.kind === "unavailable") return unavailable(request, physical.reasonCode);
    if (physical.kind === "reverted") {
      return Object.freeze({
        kind: "reverted" as const,
        reasonCode: "declared-revert-data" as const,
        requestId: request.requestId,
        source: request.source,
        rpcErrorCode: physical.errorCode,
        dataEncoding: physical.dataEncoding,
        dataHex: physical.dataHex,
      });
    }
    return Object.freeze({
      kind: "returned" as const,
      requestId: request.requestId,
      source: request.source,
      dataHex: physical.dataHex,
    });
  }

  /** Read-only logical/physical facts for diagnostics and acceptance. */
  stats(): CurrentSourceRpcFactStats {
    const snapshot = this.sharedWork.snapshot();
    return Object.freeze({
      logicalReads: this.logicalReads,
      physicalBuilds: snapshot.stats.physicalBuilds,
      settledHits: snapshot.stats.settledHits,
      inFlightJoins: snapshot.stats.inFlightJoins,
      buildFailures: snapshot.stats.buildFailures,
      invalidResults: snapshot.stats.invalidResults,
      consumerAborts: snapshot.stats.consumerAborts,
      consumerDeadlines: snapshot.stats.consumerDeadlines,
      physicalAborts: snapshot.stats.physicalAborts,
      settledEntries: snapshot.settledEntries,
      inFlightEntries: snapshot.inFlightEntries,
      consumers: snapshot.consumers,
    });
  }

  private scopeState(scope: unknown): LogicalScopeState {
    if (scope === null || typeof scope !== "object") {
      throw new TypeError("current-source RPC logical scope is not owner-issued");
    }
    const state = this.logicalScopes.get(scope);
    if (state === undefined) {
      throw new TypeError("current-source RPC logical scope is not issued by this transport");
    }
    return state;
  }

  private trackPhysical(pending: Promise<PhysicalRpcOutcome>): Promise<PhysicalRpcOutcome> {
    this.activePhysical.add(pending);
    void pending.then(
      () => { this.activePhysical.delete(pending); },
      () => { this.activePhysical.delete(pending); },
    );
    return pending;
  }

  private async executePhysical(
    request: FamilySearchSourceReadRequestV1,
    signal: AbortSignal,
  ): Promise<PhysicalRpcOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      if (!controller.signal.aborted) controller.abort(new DOMException("deadline elapsed", "TimeoutError"));
    }, this.timeoutMs);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: request.requestId,
      method: "eth_call",
      params: [
        { to: request.target, data: request.data },
        { blockHash: request.source.hash, requireCanonical: true },
      ],
    });
    let response: Response | null = null;
    let responseBody: string | null = null;
    let failure: CurrentSourceRpcReasonCode | null = null;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...this.headers,
        },
        body,
        signal: controller.signal,
      });
      try {
        responseBody = await response.text();
      } catch (error) {
        failure = transportReason(error, signal, timedOut);
      }
    } catch (error) {
      failure = transportReason(error, signal, timedOut);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    if (failure !== null) return Object.freeze({ kind: "unavailable", reasonCode: failure });
    if (signal.aborted) return Object.freeze({ kind: "unavailable", reasonCode: timedOut ? "deadline" : "abort" });
    if (timedOut) return Object.freeze({ kind: "unavailable", reasonCode: "deadline" });
    if (response === null || responseBody === null) return Object.freeze({ kind: "unavailable", reasonCode: "transport" });
    if (!response.ok) return Object.freeze({ kind: "unavailable", reasonCode: "unavailable" });
    const decoded = decodeRpcResponse(responseBody, request.requestId);
    if (decoded === null) return Object.freeze({ kind: "unavailable", reasonCode: "malformed-response" });
    if (decoded.kind === "rpc") {
      const declaration = request.declaredRevertData;
      if (declaration !== undefined
        && decoded.dataHex !== null
        && (decoded.dataHex.length - 2) / 2 === declaration.byteLength
        && decoded.dataHex.slice(0, 10).toLowerCase() === declaration.selector) {
        return Object.freeze({
          kind: "reverted",
          errorCode: decoded.errorCode,
          dataHex: decoded.dataHex,
          dataEncoding: declaration.dataEncoding,
        });
      }
      return Object.freeze({ kind: "unavailable", reasonCode: "rpc" });
    }
    return Object.freeze({ kind: "returned", dataHex: decoded.dataHex });
  }

  private async assertCurrent(request: FamilySearchSourceReadRequestV1): Promise<CurrentSourceRpcReasonCode | null> {
    try {
      await this.currentSource.assertCurrent();
      const current = familySearchSource(this.currentSource.source, "currentSource.source");
      if (!sameFamilySearchSource(current, this.boundSource) || !sameFamilySearchSource(current, request.source)) return "source-stale";
      return null;
    } catch {
      return "source-stale";
    }
  }
}

export function createCurrentSourceRpcReadPort(
  options: CurrentSourceRpcReadTransportOptions,
): FamilySearchSourceReadPortV1 {
  return new CurrentSourceRpcReadTransport(options);
}
