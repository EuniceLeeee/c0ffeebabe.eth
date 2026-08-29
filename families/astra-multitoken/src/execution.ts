import {
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { ASTRA_CHANGE_SELECTOR, ASTRA_EFFECT_OBLIGATIONS } from "./manifest.ts";
import type { Address, AstraExactV1, AstraRouteV1 } from "./types.ts";

export interface AstraEffectSimulationProgramV1 {
  readonly caller: { readonly ref: { readonly kind: "observed-sender" }; readonly executionMode: "impersonated-call-frame" };
  readonly to: Address;
  readonly data: string;
  readonly preCalls: readonly { readonly caller: { readonly ref: { readonly kind: "observed-sender" }; readonly executionMode: "impersonated-call-frame" }; readonly to: Address; readonly data: string }[];
  readonly observeTokenBalances: readonly { readonly token: Address; readonly account: { readonly kind: "observed-sender" } | Address }[];
  readonly observeLogs: true;
  readonly obligations: readonly string[];
}

type AstraObservedSenderRefV1 = { readonly kind: "observed-sender" };
type AstraEffectAccountV1 = AstraObservedSenderRefV1 | Address;

function word(value: bigint): string { return value.toString(16).padStart(64, "0"); }
function address(value: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("Astra address is invalid");
  return `0x${value.slice(2).toLowerCase()}` as Address;
}
function addressWord(value: string): string {
  return address(value).slice(2).padStart(64, "0");
}

function literal<T extends string | boolean>(expected: T, value: unknown, path: string): T {
  if (value !== expected) throw new TypeError(`${path} must equal ${String(expected)}`);
  return expected;
}

function decodeObservedSender(value: unknown, path: string): AstraObservedSenderRefV1 {
  return decodeExactObject(value, {
    kind: (field, fieldPath) => literal("observed-sender", field, fieldPath),
  }, path);
}

function decodeAccount(value: unknown, path: string): AstraEffectAccountV1 {
  if (typeof value === "string") return address(value);
  return decodeObservedSender(value, path);
}

function decodeCaller(value: unknown, path: string) {
  return decodeExactObject(value, {
    ref: (field, fieldPath) => decodeObservedSender(field, fieldPath),
    executionMode: (field, fieldPath) => literal("impersonated-call-frame", field, fieldPath),
  }, path);
}

function decodePreCall(value: unknown, path: string) {
  return decodeExactObject(value, {
    caller: (field, fieldPath) => decodeCaller(field, fieldPath),
    to: (field, fieldPath) => address(field as string),
    data: (field, fieldPath) => assertNonEmptyString(field, fieldPath),
  }, path);
}

function decodeObservation(value: unknown, path: string) {
  return decodeExactObject(value, {
    token: (field, fieldPath) => address(field as string),
    account: (field, fieldPath) => decodeAccount(field, fieldPath),
  }, path);
}

/**
 * The generic REVM wire is intentionally not trusted to preserve a Family's
 * effect scope.  This validator is the Astra-owned exact boundary: it checks
 * the complete caller mode, approval pre-call, four token/account observations,
 * target calldata and log obligation before an exact result can be accepted.
 */
export function validateAstraEffectSimulationProgram(
  value: unknown,
  input: { readonly route: AstraRouteV1; readonly amountIn: bigint; readonly minAmountOut: bigint },
): AstraEffectSimulationProgramV1 {
  const decoded = decodeExactObject(value, {
    caller: (field, path) => decodeCaller(field, path),
    to: (field, path) => address(field as string),
    data: (field, path) => assertNonEmptyString(field, path),
    preCalls: (field, path) => fieldArray(field, decodePreCall, path),
    observeTokenBalances: (field, path) => fieldArray(field, decodeObservation, path),
    observeLogs: (field, path) => literal(true, field, path),
    obligations: (field, path) => fieldArray(field, (item, itemPath) => assertNonEmptyString(item, itemPath), path),
  });
  const expected = buildAstraEffectSimulation(input);
  if (encodeCanonicalJson(decoded) !== encodeCanonicalJson(expected)) {
    throw new TypeError("Astra effect simulation declaration mismatch");
  }
  return deepFreeze(decoded as AstraEffectSimulationProgramV1);
}

export function buildAstraEffectSimulation(input: { readonly route: AstraRouteV1; readonly amountIn: bigint; readonly minAmountOut: bigint }): AstraEffectSimulationProgramV1 {
  if (input.amountIn <= 0n || input.minAmountOut < 0n) throw new RangeError("Astra simulation amounts are invalid");
  const target = address(input.route.target);
  const tokenIn = address(input.route.tokenIn);
  const tokenOut = address(input.route.tokenOut);
  if (tokenIn === tokenOut) throw new TypeError("Astra route tokens must differ");
  const data = `${ASTRA_CHANGE_SELECTOR}${addressWord(tokenIn)}${addressWord(tokenOut)}${word(input.amountIn)}${word(input.minAmountOut)}`;
  const approve = `0x095ea7b3${addressWord(target)}${word(input.amountIn)}`;
  return Object.freeze({
    caller: Object.freeze({ ref: Object.freeze({ kind: "observed-sender" as const }), executionMode: "impersonated-call-frame" as const }),
    to: target,
    data,
    preCalls: Object.freeze([Object.freeze({ caller: Object.freeze({ ref: Object.freeze({ kind: "observed-sender" as const }), executionMode: "impersonated-call-frame" as const }), to: tokenIn, data: approve })]),
    observeTokenBalances: Object.freeze([
      Object.freeze({ token: tokenIn, account: Object.freeze({ kind: "observed-sender" as const }) }),
      Object.freeze({ token: tokenIn, account: target }),
      Object.freeze({ token: tokenOut, account: Object.freeze({ kind: "observed-sender" as const }) }),
      Object.freeze({ token: tokenOut, account: target }),
    ]),
    observeLogs: true,
    obligations: ASTRA_EFFECT_OBLIGATIONS,
  });
}

export function compileAstraExecution(input: { readonly route: AstraRouteV1; readonly exact: AstraExactV1; readonly amountIn: bigint; readonly minAmountOut: bigint }): { readonly program: AstraEffectSimulationProgramV1; readonly programHash: Hash } {
  const program = buildAstraEffectSimulation({ route: input.route, amountIn: input.amountIn, minAmountOut: input.minAmountOut });
  validateAstraEffectSimulationProgram(program, { route: input.route, amountIn: input.amountIn, minAmountOut: input.minAmountOut });
  return Object.freeze({ program, programHash: hashDomain("aloha/astra-multitoken/execution-program/v1", { program, exactQuoteHash: input.exact.quoteHash, effectHash: input.exact.effectHash }) });
}
