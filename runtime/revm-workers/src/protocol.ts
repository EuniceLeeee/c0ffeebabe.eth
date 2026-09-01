import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../packages/runtime-authority/src/index.ts";
import {
  normalizeEffectTransportDeclaration,
  type EffectTransportDeclarationV1,
} from "../../../packages/execution-program/src/index.ts";

export const REVM_WIRE_VERSION = 1 as const;
export type RevmCallerMode = "top-level" | "impersonated-call-frame";

/**
 * The worker wire carries the current runtime binding as an opaque identity
 * fact. It is deliberately a complete, schema-owned binding
 * rather than a family name or an engine/executable pair.  The process-local
 * authority stamps it; a worker is never allowed to invent these fields.
 */
export interface RevmWorkerRuntimeLeaseV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly executorAuthorityRoot: Hash;
  readonly qualifiedExecutorRegistryRoot: Hash;
  readonly selectedExecutorLeafHash: Hash;
  readonly executorKind: string;
  readonly engineBuildFingerprint: Hash;
  readonly executableFingerprint: Hash;
  readonly closureFingerprint: Hash;
  readonly protocolFingerprint: Hash;
  readonly schemaFingerprint: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

export interface RevmWorkerAuthorityBindingV1 {
  /** Exact runtime and executable facts for this worker. */
  readonly runtime: RevmWorkerRuntimeLeaseV1;
  readonly authorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

export interface RevmSourceAnchor {
  readonly chainId: string;
  readonly number: string;
  readonly hash: string;
  readonly stateRoot: string;
}

export interface RevmCallerBinding {
  readonly address: string;
  readonly mode: RevmCallerMode;
  readonly observedSender: string;
  readonly verifiedActors: Readonly<Record<string, string>>;
}

export interface FrozenProgramWire {
  readonly format: "frozen-program-v1";
  readonly schemaHash: Hash | string;
  readonly programHash: Hash | string;
  /** Canonical encoded program bytes; the worker, not this package, interprets EVM semantics. */
  readonly bytes: string;
  /** Optional owner-declared effect transport capability, bound by programHash. */
  readonly effectTransport?: EffectTransportDeclarationV1;
}

export interface RevmWorkerSimulateRequestV1 {
  readonly wireVersion: typeof REVM_WIRE_VERSION;
  readonly kind: "request";
  readonly op: "simulate";
  readonly requestId: string;
  readonly workerEpoch: string;
  readonly ownerRef: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly authority: RevmWorkerAuthorityBindingV1;
  readonly source: RevmSourceAnchor;
  readonly caller: RevmCallerBinding;
  readonly observeAccounts: readonly string[];
  readonly program: FrozenProgramWire;
  readonly input: CanonicalJson;
  readonly inputHash: Hash | string;
  readonly deadlineAtMs: number;
}

/**
 * Queue-side request before a qualified worker has been selected. A caller
 * cannot name or guess a worker epoch; the pool binds that authority only
 * after it owns a ready, qualified controller.
 */
export type RevmWorkerDispatchRequestV1 = Omit<
  RevmWorkerSimulateRequestV1,
  "workerEpoch" | "authority"
>;

export interface RevmWorkerDispatchedExecutionV1 {
  readonly request: RevmWorkerSimulateRequestV1;
  readonly response: RevmWorkerResponseV1;
}

export interface RevmExecutionEffectsWire {
  /** Worker-produced canonical effect bytes; no central protocol decoding occurs here. */
  readonly format: "revm-effects-v1";
  readonly bytes: string;
  readonly observedAccounts: readonly string[];
  readonly effectsHash: Hash | string;
}

export interface RevmWorkerResultV1 {
  readonly wireVersion: typeof REVM_WIRE_VERSION;
  readonly kind: "response";
  readonly op: "simulate";
  readonly requestId: string;
  readonly workerEpoch: string;
  readonly ownerRef: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly authority: RevmWorkerAuthorityBindingV1;
  readonly inputHash: Hash | string;
  readonly deadlineAtMs: number;
  readonly engine: "revm";
  readonly engineBuildFingerprint: string;
  readonly source: RevmSourceAnchor;
  readonly caller: RevmCallerBinding;
  readonly observeAccounts: readonly string[];
  readonly programHash: Hash | string;
  readonly status: "returned" | "reverted";
  readonly output: string;
  readonly effects: RevmExecutionEffectsWire;
  /** Worker echo of the exact declaration carried by the frozen program. */
  readonly effectTransport?: EffectTransportDeclarationV1;
  readonly executionReceiptHash: Hash | string;
}

export type RevmWorkerFailureCode =
  | "invalid-request"
  | "invalid-response"
  | "worker-error"
  | "timeout"
  | "retired"
  | "source-stale"
  | "engine-unqualified";

export interface RevmWorkerErrorV1 {
  readonly wireVersion: typeof REVM_WIRE_VERSION;
  readonly kind: "error";
  readonly op: "simulate";
  readonly requestId: string;
  readonly workerEpoch: string;
  readonly ownerRef: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly authority: RevmWorkerAuthorityBindingV1;
  readonly inputHash: Hash | string;
  readonly deadlineAtMs: number;
  readonly code: RevmWorkerFailureCode;
  readonly message: string;
  readonly effectTransport?: EffectTransportDeclarationV1;
}

export type RevmWorkerResponseV1 = RevmWorkerResultV1 | RevmWorkerErrorV1;
export interface RevmWorkerHelloV1 {
  readonly wireVersion: typeof REVM_WIRE_VERSION;
  readonly kind: "hello";
  readonly op: "hello";
  readonly workerEpoch: string;
  readonly engine: "revm";
  readonly engineBuildFingerprint: string;
  readonly executableFingerprint: string;
}

export type RevmWorkerMessageV1 = RevmWorkerSimulateRequestV1 | RevmWorkerResponseV1 | RevmWorkerHelloV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertDataEnvelope(value: Record<string, unknown>): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("REVM wire envelope symbols are not allowed");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`REVM wire field ${key} must be an enumerable data property`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function parseSource(value: unknown): RevmSourceAnchor {
  if (!isRecord(value)) throw new TypeError("source must be an object");
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"]);
  return Object.freeze({
    chainId: requireString(value.chainId, "source.chainId"),
    number: requireString(value.number, "source.number"),
    hash: requireString(value.hash, "source.hash"),
    stateRoot: requireString(value.stateRoot, "source.stateRoot"),
  });
}

function parseAuthority(value: unknown): RevmWorkerAuthorityBindingV1 {
  if (!isRecord(value)) throw new TypeError("authority must be an object");
  assertExactKeys(value, ["runtime", "authorityRoot", "workerEpoch", "executorSessionHash"]);
  const raw = value.runtime;
  if (!isRecord(raw)) throw new TypeError("authority.runtime must be an object");
  assertExactKeys(raw, [
    "runtimeAuthority", "executorAuthorityRoot", "qualifiedExecutorRegistryRoot",
    "selectedExecutorLeafHash", "executorKind", "engineBuildFingerprint",
    "executableFingerprint", "closureFingerprint", "protocolFingerprint",
    "schemaFingerprint", "workerEpoch", "executorSessionHash",
  ]);
  const runtime: RevmWorkerRuntimeLeaseV1 = Object.freeze({
    runtimeAuthority: decodeRuntimeAuthorityProjectionV1(raw.runtimeAuthority),
    executorAuthorityRoot: assertHash(raw.executorAuthorityRoot, "authority.runtime.executorAuthorityRoot"),
    qualifiedExecutorRegistryRoot: assertHash(raw.qualifiedExecutorRegistryRoot, "authority.runtime.qualifiedExecutorRegistryRoot"),
    selectedExecutorLeafHash: assertHash(raw.selectedExecutorLeafHash, "authority.runtime.selectedExecutorLeafHash"),
    executorKind: assertNonEmptyString(raw.executorKind, "authority.runtime.executorKind"),
    engineBuildFingerprint: assertHash(raw.engineBuildFingerprint, "authority.runtime.engineBuildFingerprint"),
    executableFingerprint: assertHash(raw.executableFingerprint, "authority.runtime.executableFingerprint"),
    closureFingerprint: assertHash(raw.closureFingerprint, "authority.runtime.closureFingerprint"),
    protocolFingerprint: assertHash(raw.protocolFingerprint, "authority.runtime.protocolFingerprint"),
    schemaFingerprint: assertHash(raw.schemaFingerprint, "authority.runtime.schemaFingerprint"),
    workerEpoch: assertNonEmptyString(raw.workerEpoch, "authority.runtime.workerEpoch"),
    executorSessionHash: assertHash(raw.executorSessionHash, "authority.runtime.executorSessionHash"),
  });
  const authorityRoot = assertHash(value.authorityRoot, "authority.authorityRoot");
  const workerEpoch = assertNonEmptyString(value.workerEpoch, "authority.workerEpoch");
  const executorSessionHash = assertHash(value.executorSessionHash, "authority.executorSessionHash");
  if (runtime.workerEpoch !== workerEpoch) throw new TypeError("authority worker epoch does not match runtime lease");
  if (runtime.executorSessionHash !== executorSessionHash) throw new TypeError("authority executor session does not match runtime lease");
  if (runtime.executorAuthorityRoot !== authorityRoot) throw new TypeError("authority root does not match runtime lease");
  return Object.freeze({ runtime, authorityRoot, workerEpoch, executorSessionHash });
}

export function assertAuthorityBinding(value: RevmWorkerAuthorityBindingV1): void {
  parseAuthority(value);
}

export function hashAuthorityBinding(value: RevmWorkerAuthorityBindingV1): Hash {
  const parsed = parseAuthority(value);
  return hashDomain("aloha/revm-worker-authority-binding/v1", parsed);
}

function parseCaller(value: unknown): RevmCallerBinding {
  if (!isRecord(value)) throw new TypeError("caller must be an object");
  assertExactKeys(value, ["address", "mode", "observedSender", "verifiedActors"]);
  const mode = value.mode;
  if (mode !== "top-level" && mode !== "impersonated-call-frame") throw new TypeError("caller.mode is unsupported");
  const result: RevmCallerBinding = {
    address: requireString(value.address, "caller.address"),
    mode,
    observedSender: requireString(value.observedSender, "caller.observedSender"),
    verifiedActors: parseStringMap(value.verifiedActors, "caller.verifiedActors"),
  };
  if (mode === "top-level" && result.observedSender !== result.address) throw new TypeError("top-level caller observedSender must equal address");
  if (mode === "impersonated-call-frame" && Object.keys(result.verifiedActors).length === 0) throw new TypeError("impersonated caller requires verified actors");
  return Object.freeze(result);
}

function parseStringMap(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = requireString(item, `${field}.${key}`);
    Object.defineProperty(result, key, { value: parsed, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(result);
}

function parseProgram(value: unknown): FrozenProgramWire {
  if (!isRecord(value) || value.format !== "frozen-program-v1") throw new TypeError("program format is unsupported");
  const keys = ["format", "schemaHash", "programHash", "bytes"];
  if (Object.prototype.hasOwnProperty.call(value, "effectTransport")) keys.push("effectTransport");
  assertExactKeys(value, keys);
  const effectTransport = Object.prototype.hasOwnProperty.call(value, "effectTransport")
    ? normalizeEffectTransportDeclaration(value.effectTransport, "program.effectTransport")
    : undefined;
  return Object.freeze({
    format: "frozen-program-v1",
    schemaHash: requireString(value.schemaHash, "program.schemaHash"),
    programHash: requireString(value.programHash, "program.programHash"),
    bytes: requireString(value.bytes, "program.bytes"),
    ...(effectTransport === undefined ? {} : { effectTransport }),
  });
}

function parseRequest(value: Record<string, unknown>): RevmWorkerSimulateRequestV1 {
  if (value.wireVersion !== REVM_WIRE_VERSION || value.kind !== "request" || value.op !== "simulate") throw new TypeError("unsupported REVM request envelope");
  if (Object.prototype.hasOwnProperty.call(value, "disable_eip3607") || Object.prototype.hasOwnProperty.call(value, "disableEip3607")) {
    throw new TypeError("global EIP-3607 disable is not a valid REVM request");
  }
  assertExactKeys(value, ["wireVersion", "kind", "op", "requestId", "workerEpoch", "ownerRef", "generationId", "attemptId", "authority", "source", "caller", "observeAccounts", "program", "input", "inputHash", "deadlineAtMs"]);
  if (value.input === undefined) throw new TypeError("input is required");
  // Validate the opaque program input as canonical wire data without
  // interpreting its owner-defined semantics.
  encodeCanonicalJson(value.input);
  const request: RevmWorkerSimulateRequestV1 = {
    wireVersion: REVM_WIRE_VERSION,
    kind: "request",
    op: "simulate",
    requestId: requireString(value.requestId, "requestId"),
    workerEpoch: requireString(value.workerEpoch, "workerEpoch"),
    ownerRef: requireString(value.ownerRef, "ownerRef"),
    generationId: requireString(value.generationId, "generationId"),
    attemptId: requireString(value.attemptId, "attemptId"),
    authority: parseAuthority(value.authority),
    source: parseSource(value.source),
    caller: parseCaller(value.caller),
    observeAccounts: parseStringArray(value.observeAccounts, "observeAccounts"),
    program: parseProgram(value.program),
    input: value.input as CanonicalJson,
    inputHash: requireString(value.inputHash, "inputHash"),
    deadlineAtMs: numberField(value.deadlineAtMs, "deadlineAtMs"),
  };
  if (request.inputHash !== hashProgramInput(request.input)) throw new TypeError("inputHash does not bind input");
  if (request.program.programHash !== hashFrozenProgram(request.program)) throw new TypeError("programHash does not bind frozen program bytes");
  if (request.workerEpoch !== request.authority.workerEpoch) throw new TypeError("request worker epoch does not match authority");
  return Object.freeze(request);
}

function parseDispatchRequest(value: unknown): RevmWorkerDispatchRequestV1 {
  if (!isRecord(value)) throw new TypeError("REVM dispatch request must be an object");
  assertDataEnvelope(value);
  assertExactKeys(value, ["wireVersion", "kind", "op", "requestId", "ownerRef", "generationId", "attemptId", "source", "caller", "observeAccounts", "program", "input", "inputHash", "deadlineAtMs"]);
  if (value.wireVersion !== REVM_WIRE_VERSION || value.kind !== "request" || value.op !== "simulate") throw new TypeError("unsupported REVM dispatch envelope");
  if (value.input === undefined) throw new TypeError("input is required");
  encodeCanonicalJson(value.input);
  const input = value.input as CanonicalJson;
  const program = parseProgram(value.program);
  const parsed: RevmWorkerDispatchRequestV1 = {
    wireVersion: REVM_WIRE_VERSION,
    kind: "request",
    op: "simulate",
    requestId: requireString(value.requestId, "requestId"),
    ownerRef: requireString(value.ownerRef, "ownerRef"),
    generationId: requireString(value.generationId, "generationId"),
    attemptId: requireString(value.attemptId, "attemptId"),
    source: parseSource(value.source),
    caller: parseCaller(value.caller),
    observeAccounts: parseStringArray(value.observeAccounts, "observeAccounts"),
    program,
    input,
    inputHash: requireString(value.inputHash, "inputHash"),
    deadlineAtMs: numberField(value.deadlineAtMs, "deadlineAtMs"),
  };
  if (parsed.inputHash !== hashProgramInput(parsed.input)) throw new TypeError("inputHash does not bind input");
  if (parsed.program.programHash !== hashFrozenProgram(parsed.program)) throw new TypeError("programHash does not bind frozen program bytes");
  return Object.freeze(parsed);
}

function parseEffects(value: unknown): RevmExecutionEffectsWire {
  if (!isRecord(value) || value.format !== "revm-effects-v1") throw new TypeError("effects format is unsupported");
  assertExactKeys(value, ["format", "bytes", "observedAccounts", "effectsHash"]);
  const bytes = requireString(value.bytes, "effects.bytes");
  const observedAccounts = parseStringArray(value.observedAccounts, "effects.observedAccounts");
  const effectsHash = requireString(value.effectsHash, "effects.effectsHash");
  const expectedHash = hashEffectsWire({ format: "revm-effects-v1", bytes, observedAccounts });
  if (effectsHash !== expectedHash) throw new TypeError("effectsHash does not bind effects bytes");
  return Object.freeze({ format: "revm-effects-v1", bytes, observedAccounts, effectsHash });
}

function parseResponse(value: Record<string, unknown>): RevmWorkerResponseV1 {
  if (value.wireVersion !== REVM_WIRE_VERSION || (value.kind !== "response" && value.kind !== "error") || value.op !== "simulate") throw new TypeError("unsupported REVM response envelope");
  const requestId = requireString(value.requestId, "requestId");
  const workerEpoch = requireString(value.workerEpoch, "workerEpoch");
  if (value.kind === "error") {
    const keys = ["wireVersion", "kind", "op", "requestId", "workerEpoch", "ownerRef", "generationId", "attemptId", "authority", "inputHash", "deadlineAtMs", "code", "message"];
    if (Object.prototype.hasOwnProperty.call(value, "effectTransport")) keys.push("effectTransport");
    assertExactKeys(value, keys);
    const code = value.code;
    const validCodes: readonly RevmWorkerFailureCode[] = ["invalid-request", "invalid-response", "worker-error", "timeout", "retired", "source-stale", "engine-unqualified"];
    if (typeof code !== "string" || !validCodes.includes(code as RevmWorkerFailureCode)) throw new TypeError("error.code is unsupported");
    const authority = parseAuthority(value.authority);
    if (authority.workerEpoch !== workerEpoch) throw new TypeError("error worker epoch does not match authority");
    const effectTransport = Object.prototype.hasOwnProperty.call(value, "effectTransport")
      ? normalizeEffectTransportDeclaration(value.effectTransport, "error.effectTransport")
      : undefined;
    return Object.freeze({ wireVersion: REVM_WIRE_VERSION, kind: "error", op: "simulate", requestId, workerEpoch, ownerRef: requireString(value.ownerRef, "ownerRef"), generationId: requireString(value.generationId, "generationId"), attemptId: requireString(value.attemptId, "attemptId"), authority, inputHash: requireString(value.inputHash, "inputHash"), deadlineAtMs: numberField(value.deadlineAtMs, "deadlineAtMs"), code: code as RevmWorkerFailureCode, message: requireString(value.message, "message"), ...(effectTransport === undefined ? {} : { effectTransport }) });
  }
  const keys = ["wireVersion", "kind", "op", "requestId", "workerEpoch", "ownerRef", "generationId", "attemptId", "authority", "inputHash", "deadlineAtMs", "engine", "engineBuildFingerprint", "source", "caller", "observeAccounts", "programHash", "status", "output", "effects", "executionReceiptHash"];
  if (Object.prototype.hasOwnProperty.call(value, "effectTransport")) keys.push("effectTransport");
  assertExactKeys(value, keys);
  if (value.engine !== "revm") throw new TypeError("worker response is not qualified REVM output");
  const status = value.status;
  if (status !== "returned" && status !== "reverted") throw new TypeError("response.status is unsupported");
  const observeAccounts = parseStringArray(value.observeAccounts, "observeAccounts");
  const effects = parseEffects(value.effects);
  if (effects.observedAccounts.length !== observeAccounts.length || effects.observedAccounts.some((account, index) => account !== observeAccounts[index])) throw new TypeError("effects observation scope does not match response scope");
  const authority = parseAuthority(value.authority);
  if (authority.workerEpoch !== workerEpoch) throw new TypeError("response worker epoch does not match authority");
  const effectTransport = Object.prototype.hasOwnProperty.call(value, "effectTransport")
    ? normalizeEffectTransportDeclaration(value.effectTransport, "response.effectTransport")
    : undefined;
  return Object.freeze({
    wireVersion: REVM_WIRE_VERSION,
    kind: "response",
    op: "simulate",
    requestId,
    workerEpoch,
    ownerRef: requireString(value.ownerRef, "ownerRef"),
    generationId: requireString(value.generationId, "generationId"),
    attemptId: requireString(value.attemptId, "attemptId"),
    authority,
    inputHash: requireString(value.inputHash, "inputHash"),
    deadlineAtMs: numberField(value.deadlineAtMs, "deadlineAtMs"),
    engine: "revm",
    engineBuildFingerprint: requireString(value.engineBuildFingerprint, "engineBuildFingerprint"),
    source: parseSource(value.source),
    caller: parseCaller(value.caller),
    observeAccounts,
    programHash: requireString(value.programHash, "programHash"),
    status,
    output: requireString(value.output, "output"),
    effects,
    ...(effectTransport === undefined ? {} : { effectTransport }),
    executionReceiptHash: requireString(value.executionReceiptHash, "executionReceiptHash"),
  });
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const result = value.map((item, index) => requireString(item, `${field}[${index}]`));
  const sorted = [...result].sort();
  if (result.some((item, index) => item !== sorted[index]) || new Set(result).size !== result.length) throw new TypeError(`${field} must be sorted and unique`);
  return Object.freeze(result);
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
  return value;
}

export function decodeWorkerMessage(value: unknown): RevmWorkerMessageV1 {
  if (!isRecord(value)) throw new TypeError("REVM wire message must be an object");
  assertDataEnvelope(value);
  if (value.kind === "request") return parseRequest(value);
  if (value.kind === "hello") return parseHello(value);
  return parseResponse(value);
}

function parseHello(value: Record<string, unknown>): RevmWorkerHelloV1 {
  assertExactKeys(value, ["wireVersion", "kind", "op", "workerEpoch", "engine", "engineBuildFingerprint", "executableFingerprint"]);
  if (value.wireVersion !== REVM_WIRE_VERSION || value.kind !== "hello" || value.op !== "hello" || value.engine !== "revm") throw new TypeError("unsupported REVM hello envelope");
  return Object.freeze({
    wireVersion: REVM_WIRE_VERSION,
    kind: "hello",
    op: "hello",
    workerEpoch: requireString(value.workerEpoch, "workerEpoch"),
    engine: "revm",
    engineBuildFingerprint: requireString(value.engineBuildFingerprint, "engineBuildFingerprint"),
    executableFingerprint: requireString(value.executableFingerprint, "executableFingerprint"),
  });
}

export function encodeWorkerMessage(message: RevmWorkerMessageV1): string {
  const decoded = decodeWorkerMessage(message);
  if (decoded.kind === "request") assertRequestShape(decoded);
  return encodeCanonicalJson(decoded);
}

export function encodeWorkerLine(message: RevmWorkerMessageV1): string {
  return `${encodeWorkerMessage(message)}\n`;
}

export function decodeWorkerLine(line: string): RevmWorkerMessageV1 {
  if (!line.endsWith("\n") && line.length === 0) throw new TypeError("empty REVM wire line");
  const text = line.endsWith("\n") ? line.slice(0, -1) : line;
  return decodeWorkerMessage(decodeCanonicalJson(text));
}

export function hashFrozenProgram(program: FrozenProgramWire): Hash {
  const body = {
    format: program.format,
    schemaHash: program.schemaHash,
    bytes: program.bytes,
    ...(program.effectTransport === undefined ? {} : { effectTransport: normalizeEffectTransportDeclaration(program.effectTransport) }),
  };
  return hashDomain("aloha/frozen-program-wire/v1", body);
}

export function hashInput(input: CanonicalJson): Hash {
  return hashProgramInput(input);
}

export function hashProgramInput(input: CanonicalJson): Hash {
  return hashDomain("aloha/revm-program-input/v1", input);
}

export function hashEffectsWire(effects: Pick<RevmExecutionEffectsWire, "format" | "bytes" | "observedAccounts">): Hash {
  return hashDomain("aloha/revm-effects-wire/v1", { format: effects.format, bytes: effects.bytes, observedAccounts: effects.observedAccounts });
}

export function hashExecutionReceipt(response: RevmWorkerResultV1): Hash {
  return hashDomain("aloha/revm-execution-receipt/v1", {
    requestId: response.requestId,
    workerEpoch: response.workerEpoch,
    ownerRef: response.ownerRef,
    generationId: response.generationId,
    attemptId: response.attemptId,
    authority: response.authority,
    inputHash: response.inputHash,
    deadlineAtMs: response.deadlineAtMs,
    source: response.source,
    caller: response.caller,
    observeAccounts: response.observeAccounts,
    programHash: response.programHash,
    status: response.status,
    output: response.output,
    effects: response.effects,
    ...(response.effectTransport === undefined ? {} : { effectTransport: normalizeEffectTransportDeclaration(response.effectTransport) }),
  });
}

export function assertRequestShape(request: RevmWorkerSimulateRequestV1): void {
  parseRequest(request as unknown as Record<string, unknown>);
  const expectedProgramHash = hashFrozenProgram(request.program);
  if (request.program.programHash !== expectedProgramHash) throw new TypeError("programHash does not bind frozen program bytes");
}

export function assertDispatchRequestShape(
  request: RevmWorkerDispatchRequestV1,
): void {
  parseDispatchRequest(request);
}

export function bindQualifiedWorkerEpoch(
  request: RevmWorkerDispatchRequestV1,
  workerEpoch: string,
  authority: RevmWorkerAuthorityBindingV1,
): RevmWorkerSimulateRequestV1 {
  const dispatch = parseDispatchRequest(request);
  return parseRequest({ ...dispatch, workerEpoch: requireString(workerEpoch, "workerEpoch"), authority });
}
