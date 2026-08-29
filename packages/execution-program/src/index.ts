import {
  assertExactKeys,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";

/**
 * Protocol-neutral effect transport declaration.  This is an optional
 * execution capability: a Family that has no effect scope omits it entirely.
 * The framework only preserves and binds the declaration; it never interprets
 * a Family's token semantics or invents an observation scope.
 */
export type EffectExecutionModeV1 = "top-level" | "impersonated-call-frame";
export type EffectAddressV1 = `0x${string}`;
export type EffectAccountRefV1 = EffectAddressV1 | { readonly kind: "observed-sender" };

export interface EffectCallerBindingV1 {
  readonly ref: EffectAccountRefV1;
  readonly executionMode: EffectExecutionModeV1;
}

export interface EffectPreCallV1 {
  readonly caller: EffectCallerBindingV1;
  readonly to: EffectAddressV1;
  readonly data: EffectAddressV1 | `0x${string}`;
}

export interface EffectObservationPairV1 {
  readonly token: EffectAddressV1;
  readonly account: EffectAccountRefV1;
}

export interface EffectTransportDeclarationV1 {
  readonly caller: EffectCallerBindingV1;
  /** Ordered setup calls; order is semantic and is never sorted by the core. */
  readonly preCalls: readonly EffectPreCallV1[];
  /** Ordered token/account observations; duplicates are forbidden. */
  readonly observeTokenBalances: readonly EffectObservationPairV1[];
  readonly observeLogs: boolean;
}

const EFFECT_MODES: readonly EffectExecutionModeV1[] = ["top-level", "impersonated-call-frame"];

function effectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function effectAddress(value: unknown, path: string): EffectAddressV1 {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be a 20-byte address`);
  return value.toLowerCase() as EffectAddressV1;
}

function effectBytes(value: unknown, path: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError(`${path} must be even-length hex bytes`);
  return value.toLowerCase() as `0x${string}`;
}

function effectAccount(value: unknown, path: string): EffectAccountRefV1 {
  if (typeof value === "string") return effectAddress(value, path);
  const record = effectRecord(value, path);
  assertExactKeys(record, ["kind"], path);
  if (record.kind !== "observed-sender") throw new TypeError(`${path}.kind is unsupported`);
  return Object.freeze({ kind: "observed-sender" as const });
}

function effectCaller(value: unknown, path: string): EffectCallerBindingV1 {
  const record = effectRecord(value, path);
  assertExactKeys(record, ["ref", "executionMode"], path);
  if (!EFFECT_MODES.includes(record.executionMode as EffectExecutionModeV1)) throw new TypeError(`${path}.executionMode is unsupported`);
  return Object.freeze({
    ref: effectAccount(record.ref, `${path}.ref`),
    executionMode: record.executionMode as EffectExecutionModeV1,
  });
}

function effectPreCall(value: unknown, path: string): EffectPreCallV1 {
  const record = effectRecord(value, path);
  assertExactKeys(record, ["caller", "to", "data"], path);
  return Object.freeze({
    caller: effectCaller(record.caller, `${path}.caller`),
    to: effectAddress(record.to, `${path}.to`),
    data: effectBytes(record.data, `${path}.data`),
  });
}

function effectObservation(value: unknown, path: string): EffectObservationPairV1 {
  const record = effectRecord(value, path);
  assertExactKeys(record, ["token", "account"], path);
  return Object.freeze({
    token: effectAddress(record.token, `${path}.token`),
    account: effectAccount(record.account, `${path}.account`),
  });
}

/** Decode and normalize the owner declaration at every transport seam. */
export function normalizeEffectTransportDeclaration(value: unknown, path = "effectTransport"): EffectTransportDeclarationV1 {
  const record = effectRecord(value, path);
  assertExactKeys(record, ["caller", "preCalls", "observeTokenBalances", "observeLogs"], path);
  if (!Array.isArray(record.preCalls)) throw new TypeError(`${path}.preCalls must be an array`);
  if (!Array.isArray(record.observeTokenBalances)) throw new TypeError(`${path}.observeTokenBalances must be an array`);
  if (typeof record.observeLogs !== "boolean") throw new TypeError(`${path}.observeLogs must be boolean`);
  const preCalls = record.preCalls.map((item, index) => effectPreCall(item, `${path}.preCalls[${index}]`));
  const observations = record.observeTokenBalances.map((item, index) => effectObservation(item, `${path}.observeTokenBalances[${index}]`));
  const seen = new Set<string>();
  for (const pair of observations) {
    const key = `${pair.token}\u0000${typeof pair.account === "string" ? pair.account : "observed-sender"}`;
    if (seen.has(key)) throw new TypeError(`${path}.observeTokenBalances contains duplicate token/account pair`);
    seen.add(key);
  }
  return deepFreeze({
    caller: effectCaller(record.caller, `${path}.caller`),
    preCalls: Object.freeze(preCalls),
    observeTokenBalances: Object.freeze(observations),
    observeLogs: record.observeLogs,
  });
}

export function hashEffectTransportDeclaration(value: EffectTransportDeclarationV1): Hash {
  return hashDomain("aloha/effect-transport-declaration/v1", normalizeEffectTransportDeclaration(value));
}

export function sameEffectTransportDeclaration(left: EffectTransportDeclarationV1 | undefined, right: EffectTransportDeclarationV1 | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return hashEffectTransportDeclaration(left) === hashEffectTransportDeclaration(right);
}

/**
 * Protocol-neutral packed CALL program used by the generated Aloha executor.
 * Family owners produce these bytes; central composition only validates the
 * generic framing and preserves instruction order.
 */

export const ALOHA_EXECUTOR_EXECUTE_SELECTOR = "0x09c5eabe" as const;
export const PACKED_CALL_VERSION_V1 = 1 as const;
export const PACKED_CALL_OPCODE_V1 = 1 as const;

export interface PackedCallInstructionV1 {
  readonly target: `0x${string}`;
  /** Canonical unsigned decimal uint256 value. */
  readonly value: string;
  readonly calldata: `0x${string}`;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function bytesHex(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || (!allowEmpty && value.length === 2)) {
    throw new TypeError(`${path} must be even-length hex bytes`);
  }
  return value.toLowerCase();
}

function address(value: unknown, path: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be a 20-byte address`);
  return value.toLowerCase() as `0x${string}`;
}

function uint(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${path} must be a canonical unsigned decimal integer`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= (1n << 256n)) throw new RangeError(`${path} is outside uint256`);
  return parsed.toString(10);
}

function uintHex(value: bigint, width: number, path: string): string {
  if (value < 0n || value >= (1n << BigInt(width * 4))) throw new RangeError(`${path} is outside packed width`);
  return value.toString(16).padStart(width, "0");
}

function instruction(value: unknown, path: string): PackedCallInstructionV1 {
  const item = record(value, path);
  const keys = Object.keys(item).sort();
  if (keys.length !== 3 || keys[0] !== "calldata" || keys[1] !== "target" || keys[2] !== "value") throw new TypeError(`${path} has non-exact keys`);
  return Object.freeze({
    target: address(item.target, `${path}.target`),
    value: uint(item.value, `${path}.value`),
    calldata: bytesHex(item.calldata, `${path}.calldata`) as `0x${string}`,
  });
}

function normalizedInstructions(value: readonly PackedCallInstructionV1[], path: string): readonly PackedCallInstructionV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 0xffff) throw new TypeError(`${path} must contain 1..65535 CALL instructions`);
  return Object.freeze(value.map((item, index) => instruction(item, `${path}[${index}]`)));
}

export function encodePackedCallProgram(value: readonly PackedCallInstructionV1[]): `0x${string}` {
  const instructions = normalizedInstructions(value, "packedCallProgram");
  let encoded = `01${uintHex(BigInt(instructions.length), 4, "packedCallProgram.count")}`;
  for (const [index, item] of instructions.entries()) {
    const calldata = item.calldata.slice(2);
    encoded += `01${item.target.slice(2)}${uintHex(BigInt(item.value), 64, `packedCallProgram[${index}].value`)}${uintHex(BigInt(calldata.length / 2), 8, `packedCallProgram[${index}].calldata.length`)}${calldata}`;
  }
  return `0x${encoded}`;
}

export function decodePackedCallProgram(value: unknown, path = "packedCallProgram"): readonly PackedCallInstructionV1[] {
  const bytes = bytesHex(value, path, false);
  const body = bytes.slice(2);
  if (body.length < 6 || body.slice(0, 2) !== "01") throw new TypeError(`${path} version mismatch`);
  const count = Number.parseInt(body.slice(2, 6), 16);
  if (!Number.isSafeInteger(count) || count === 0) throw new TypeError(`${path} instruction count invalid`);
  let offset = 6;
  const result: PackedCallInstructionV1[] = [];
  for (let index = 0; index < count; index += 1) {
    if (body.length - offset < 114) throw new TypeError(`${path}[${index}] header truncated`);
    if (body.slice(offset, offset + 2) !== "01") throw new TypeError(`${path}[${index}] opcode mismatch`);
    const target = address(`0x${body.slice(offset + 2, offset + 42)}`, `${path}[${index}].target`);
    const valueWord = BigInt(`0x${body.slice(offset + 42, offset + 106)}`);
    const calldataLength = Number.parseInt(body.slice(offset + 106, offset + 114), 16);
    const dataStart = offset + 114;
    const dataEnd = dataStart + calldataLength * 2;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > body.length) throw new TypeError(`${path}[${index}] calldata length mismatch`);
    result.push(Object.freeze({ target, value: valueWord.toString(10), calldata: `0x${body.slice(dataStart, dataEnd)}` }));
    offset = dataEnd;
  }
  if (offset !== body.length) throw new TypeError(`${path} trailing bytes`);
  return Object.freeze(result);
}

/** Concatenate already owner-issued generic CALL scripts without inspecting Family semantics. */
export function composePackedCallPrograms(values: readonly string[]): `0x${string}` {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("packedCallPrograms must be non-empty");
  const instructions = values.flatMap((value, index) => decodePackedCallProgram(value, `packedCallPrograms[${index}]`));
  return encodePackedCallProgram(instructions);
}

export function encodeExecutorExecuteCalldata(packedProgram: string): `0x${string}` {
  const canonicalProgram = encodePackedCallProgram(decodePackedCallProgram(packedProgram));
  const body = canonicalProgram.slice(2);
  const length = body.length / 2;
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
  return `0x${ALOHA_EXECUTOR_EXECUTE_SELECTOR.slice(2)}${uintHex(32n, 64, "execute.offset")}${uintHex(BigInt(length), 64, "execute.length")}${padded}`;
}

export function decodeExecutorExecuteCalldata(value: unknown): `0x${string}` {
  const bytes = bytesHex(value, "executeCalldata", false);
  const body = bytes.slice(2);
  if (body.length < 8 + 64 + 64 || body.slice(0, 8) !== ALOHA_EXECUTOR_EXECUTE_SELECTOR.slice(2)) throw new TypeError("execute calldata selector or length mismatch");
  const offset = BigInt(`0x${body.slice(8, 72)}`);
  if (offset !== 32n) throw new TypeError("execute calldata offset mismatch");
  const length = BigInt(`0x${body.slice(72, 136)}`);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("execute calldata length exceeds safe range");
  const dataStart = 136;
  const dataEnd = dataStart + Number(length) * 2;
  const paddedEnd = dataStart + Math.ceil(Number(length) / 32) * 64;
  if (dataEnd > body.length || paddedEnd !== body.length || !/^0*$/.test(body.slice(dataEnd))) throw new TypeError("execute calldata padding or length mismatch");
  const packedProgram = `0x${body.slice(dataStart, dataEnd)}` as `0x${string}`;
  decodePackedCallProgram(packedProgram);
  return packedProgram;
}
