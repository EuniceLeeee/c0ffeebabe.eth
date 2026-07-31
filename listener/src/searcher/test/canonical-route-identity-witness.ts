import { ethers } from "ethers";

/**
 * A deliberately small expression language for deriving one logical route
 * identity from ABI-decoded trace calls.  It is data-only: trusted references
 * may select bounded scalar fields and hash a bounded static ABI tuple, but
 * may not provide callbacks or protocol code.
 */
export const CANONICAL_ROUTE_IDENTITY_WITNESS_SCHEMA_VERSION = 1 as const;

export type RouteIdentityScalarType =
  | "address"
  | "bool"
  | "bytes32"
  | "uint256"
  | "int256";

export interface RouteIdentityCallField {
  readonly op: "call-field";
  readonly callId: string;
  /**
   * Numeric ABI field path.  The first element selects a function argument;
   * later elements descend into fixed/nested tuples.
   */
  readonly path: readonly number[];
  readonly type: RouteIdentityScalarType;
}

export interface RouteIdentityAbiDecodeBytesField {
  readonly op: "abi-decode-bytes-field";
  readonly callId: string;
  readonly path: readonly number[];
  readonly types: readonly RouteIdentityScalarType[];
  readonly index: number;
  readonly type: RouteIdentityScalarType;
}

export type RouteIdentityScalarExpression =
  | RouteIdentityCallField
  | RouteIdentityAbiDecodeBytesField;

export interface RouteIdentityAbiKeccak {
  readonly op: "keccak256-abi";
  readonly types: readonly RouteIdentityScalarType[];
  readonly values: readonly RouteIdentityScalarExpression[];
}

export interface RouteIdentityBoolDirection {
  readonly value: RouteIdentityCallField & { readonly type: "bool" };
  readonly trueMeans: "token1-to-token0" | "token0-to-token1";
}

export interface RouteIdentityOrderedTokenPairDirection {
  readonly mode: "ordered-token-pair";
  readonly tokenIn: RouteIdentityCallField & { readonly type: "address" };
  readonly tokenOut: RouteIdentityCallField & { readonly type: "address" };
}

export interface CanonicalRouteIdentityWitness {
  readonly schemaVersion:
    typeof CANONICAL_ROUTE_IDENTITY_WITNESS_SCHEMA_VERSION;
  readonly token0:
    RouteIdentityScalarExpression & { readonly type: "address" };
  readonly token1:
    RouteIdentityScalarExpression & { readonly type: "address" };
  readonly direction:
    | RouteIdentityBoolDirection
    | RouteIdentityOrderedTokenPairDirection;
  readonly poolId?:
    | RouteIdentityScalarExpression
    | RouteIdentityAbiKeccak;
  /**
   * Graph aliases are explicit trusted data.  The common use is the canonical
   * native-currency zero address projected as wrapped native in the graph.
   */
  readonly addressAliases?: readonly {
    readonly raw: string;
    readonly graph: string;
  }[];
}

export interface CanonicalRouteIdentity {
  readonly schemaVersion:
    typeof CANONICAL_ROUTE_IDENTITY_WITNESS_SCHEMA_VERSION;
  readonly rawToken0: string;
  readonly rawToken1: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly token1IsInput: boolean;
  readonly poolId: string | null;
}

export interface CanonicalRouteIdentityEdge {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly poolId?: string;
}

export interface CanonicalRouteIdentityDecodedCall {
  readonly args: readonly unknown[];
  readonly inputTypes: readonly ethers.ParamType[];
}

const MAX_PATH_DEPTH = 8;
const MAX_PATH_INDEX = 31;
const MAX_HASH_FIELDS = 8;
const MAX_ADDRESS_ALIASES = 4;
const CALL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCALAR_TYPES = new Set<RouteIdentityScalarType>([
  "address",
  "bool",
  "bytes32",
  "uint256",
  "int256",
]);

export function parseCanonicalRouteIdentityWitness(
  raw: unknown,
  field: string,
): CanonicalRouteIdentityWitness {
  const value = plainRecord(raw, field);
  exactKeys(
    value,
    [
      "schemaVersion",
      "token0",
      "token1",
      "direction",
      "poolId",
      "addressAliases",
    ],
    ["schemaVersion", "token0", "token1", "direction"],
    field,
  );
  if (
    value.schemaVersion !==
      CANONICAL_ROUTE_IDENTITY_WITNESS_SCHEMA_VERSION
  ) {
    throw new Error(`${field}.schemaVersion is unsupported`);
  }
  const token0 = parseScalarExpression(
    value.token0,
    `${field}.token0`,
    "address",
  ) as CanonicalRouteIdentityWitness["token0"];
  const token1 = parseScalarExpression(
    value.token1,
    `${field}.token1`,
    "address",
  ) as CanonicalRouteIdentityWitness["token1"];
  const directionRaw = plainRecord(
    value.direction,
    `${field}.direction`,
  );
  const direction = parseDirection(
    directionRaw,
    `${field}.direction`,
  );
  const poolId = value.poolId === undefined
    ? undefined
    : parseDerivedValue(value.poolId, `${field}.poolId`);
  if (
    poolId !== undefined &&
    (
      poolId.op !== "keccak256-abi" &&
      poolId.type !== "bytes32"
    )
  ) {
    throw new Error(`${field}.poolId must resolve to bytes32`);
  }
  const aliasesRaw = value.addressAliases ?? [];
  if (
    !Array.isArray(aliasesRaw) ||
    aliasesRaw.length > MAX_ADDRESS_ALIASES
  ) {
    throw new Error(
      `${field}.addressAliases must contain at most ` +
        `${MAX_ADDRESS_ALIASES} entries`,
    );
  }
  const seenRaw = new Set<string>();
  const addressAliases = aliasesRaw.map((entry, index) => {
    const alias = plainRecord(
      entry,
      `${field}.addressAliases[${index}]`,
    );
    exactKeys(
      alias,
      ["raw", "graph"],
      ["raw", "graph"],
      `${field}.addressAliases[${index}]`,
    );
    const rawAddress = canonicalAddress(
      alias.raw,
      `${field}.addressAliases[${index}].raw`,
    );
    const graphAddress = canonicalAddress(
      alias.graph,
      `${field}.addressAliases[${index}].graph`,
    );
    if (seenRaw.has(rawAddress)) {
      throw new Error(`${field}.addressAliases repeats ${rawAddress}`);
    }
    seenRaw.add(rawAddress);
    return Object.freeze({ raw: rawAddress, graph: graphAddress });
  });
  return Object.freeze({
    schemaVersion: CANONICAL_ROUTE_IDENTITY_WITNESS_SCHEMA_VERSION,
    token0,
    token1,
    direction,
    ...(poolId === undefined ? {} : { poolId }),
    ...(addressAliases.length === 0
      ? {}
      : { addressAliases: Object.freeze(addressAliases) }),
  });
}

export function referencedRouteIdentityCallIds(
  witness: CanonicalRouteIdentityWitness,
): readonly string[] {
  const expressions: Array<
    RouteIdentityScalarExpression | RouteIdentityAbiKeccak
  > = [
    witness.token0,
    witness.token1,
    ...(
      "mode" in witness.direction
        ? [witness.direction.tokenIn, witness.direction.tokenOut]
        : [witness.direction.value]
    ),
    ...(witness.poolId === undefined
      ? []
      : [witness.poolId]),
  ];
  return Object.freeze(
    [...new Set(expressions.flatMap(expressionCallIds))].sort(),
  );
}

export function resolveCanonicalRouteIdentity(
  witness: CanonicalRouteIdentityWitness,
  decodedCalls: ReadonlyMap<string, CanonicalRouteIdentityDecodedCall>,
): CanonicalRouteIdentity {
  const rawToken0 = resolveScalarExpression(
    witness.token0,
    decodedCalls,
  ) as string;
  const rawToken1 = resolveScalarExpression(
    witness.token1,
    decodedCalls,
  ) as string;
  if (rawToken0 === rawToken1) {
    throw new Error("route identity token0/token1 must be distinct");
  }
  const aliases = new Map(
    (witness.addressAliases ?? []).map((entry) => [
      entry.raw,
      entry.graph,
    ]),
  );
  const graphToken0 = aliases.get(rawToken0) ?? rawToken0;
  const graphToken1 = aliases.get(rawToken1) ?? rawToken1;
  if (graphToken0 === graphToken1) {
    throw new Error(
      "route identity token0/token1 aliases must remain distinct",
    );
  }
  const token1IsInput = resolveToken1IsInput(
    witness.direction,
    decodedCalls,
    aliases,
    graphToken0,
    graphToken1,
  );
  const rawTokenIn = token1IsInput ? rawToken1 : rawToken0;
  const rawTokenOut = token1IsInput ? rawToken0 : rawToken1;
  const tokenIn = aliases.get(rawTokenIn) ?? rawTokenIn;
  const tokenOut = aliases.get(rawTokenOut) ?? rawTokenOut;
  const poolId = witness.poolId === undefined
    ? null
    : resolveDerivedValue(witness.poolId, decodedCalls);
  if (poolId !== null && typeof poolId !== "string") {
    throw new Error("route identity poolId did not resolve to bytes32");
  }
  return Object.freeze({
    schemaVersion: CANONICAL_ROUTE_IDENTITY_WITNESS_SCHEMA_VERSION,
    rawToken0,
    rawToken1,
    tokenIn,
    tokenOut,
    token1IsInput,
    poolId,
  });
}

function parseDirection(
  raw: Record<string, unknown>,
  field: string,
): CanonicalRouteIdentityWitness["direction"] {
  if (raw.mode === "ordered-token-pair") {
    exactKeys(
      raw,
      ["mode", "tokenIn", "tokenOut"],
      ["mode", "tokenIn", "tokenOut"],
      field,
    );
    return Object.freeze({
      mode: "ordered-token-pair",
      tokenIn: parseCallField(
        raw.tokenIn,
        `${field}.tokenIn`,
        "address",
      ) as RouteIdentityOrderedTokenPairDirection["tokenIn"],
      tokenOut: parseCallField(
        raw.tokenOut,
        `${field}.tokenOut`,
        "address",
      ) as RouteIdentityOrderedTokenPairDirection["tokenOut"],
    });
  }
  exactKeys(
    raw,
    ["value", "trueMeans"],
    ["value", "trueMeans"],
    field,
  );
  const value = parseCallField(
    raw.value,
    `${field}.value`,
    "bool",
  ) as RouteIdentityBoolDirection["value"];
  if (
    raw.trueMeans !== "token1-to-token0" &&
    raw.trueMeans !== "token0-to-token1"
  ) {
    throw new Error(`${field}.trueMeans is invalid`);
  }
  return Object.freeze({
    value,
    trueMeans: raw.trueMeans,
  });
}

function resolveToken1IsInput(
  direction:
    | RouteIdentityBoolDirection
    | RouteIdentityOrderedTokenPairDirection,
  decodedCalls: ReadonlyMap<string, CanonicalRouteIdentityDecodedCall>,
  aliases: ReadonlyMap<string, string>,
  graphToken0: string,
  graphToken1: string,
): boolean {
  if (!("mode" in direction)) {
    const rawDirection = resolveCallField(
      direction.value,
      decodedCalls,
    );
    if (typeof rawDirection !== "boolean") {
      throw new Error("route identity direction did not resolve to bool");
    }
    return direction.trueMeans === "token1-to-token0"
      ? rawDirection
      : !rawDirection;
  }
  const rawTokenIn = resolveCallField(
    direction.tokenIn,
    decodedCalls,
  );
  const rawTokenOut = resolveCallField(
    direction.tokenOut,
    decodedCalls,
  );
  if (typeof rawTokenIn !== "string" || typeof rawTokenOut !== "string") {
    throw new Error(
      "route identity ordered token pair did not resolve to addresses",
    );
  }
  const tokenIn = aliases.get(rawTokenIn) ?? rawTokenIn;
  const tokenOut = aliases.get(rawTokenOut) ?? rawTokenOut;
  if (tokenIn === graphToken0 && tokenOut === graphToken1) {
    return false;
  }
  if (tokenIn === graphToken1 && tokenOut === graphToken0) {
    return true;
  }
  throw new Error(
    "route identity ordered token pair does not match token0/token1",
  );
}

export function assertCanonicalRouteIdentityMatchesEdge(
  identity: CanonicalRouteIdentity,
  edge: CanonicalRouteIdentityEdge,
  label: string,
): void {
  const tokenIn = canonicalAddress(edge.tokenIn, `${label}.tokenIn`);
  const tokenOut = canonicalAddress(edge.tokenOut, `${label}.tokenOut`);
  const poolId = edge.poolId === undefined
    ? null
    : canonicalBytes32(edge.poolId, `${label}.poolId`);
  if (
    identity.tokenIn !== tokenIn ||
    identity.tokenOut !== tokenOut ||
    identity.poolId !== poolId
  ) {
    throw new Error(
      `${label} canonical route identity differs from the frozen edge`,
    );
  }
}

export function assertCanonicalRouteIdentitiesEqual(
  target: CanonicalRouteIdentity,
  execution: CanonicalRouteIdentity,
  label: string,
): void {
  if (
    target.rawToken0 !== execution.rawToken0 ||
    target.rawToken1 !== execution.rawToken1 ||
    target.tokenIn !== execution.tokenIn ||
    target.tokenOut !== execution.tokenOut ||
    target.token1IsInput !== execution.token1IsInput ||
    target.poolId !== execution.poolId
  ) {
    throw new Error(
      `${label} target and execution witnesses prove different route identities`,
    );
  }
}

function parseDerivedValue(
  raw: unknown,
  field: string,
):
  | RouteIdentityScalarExpression
  | RouteIdentityAbiKeccak {
  const value = plainRecord(raw, field);
  if (value.op !== "keccak256-abi") {
    return parseScalarExpression(value, field);
  }
  exactKeys(
    value,
    ["op", "types", "values"],
    ["op", "types", "values"],
    field,
  );
  if (
    !Array.isArray(value.types) ||
    value.types.length === 0 ||
    value.types.length > MAX_HASH_FIELDS ||
    value.types.some((entry) => !SCALAR_TYPES.has(
      entry as RouteIdentityScalarType,
    ))
  ) {
    throw new Error(
      `${field}.types must contain 1..${MAX_HASH_FIELDS} static scalars`,
    );
  }
  if (
    !Array.isArray(value.values) ||
    value.values.length !== value.types.length
  ) {
    throw new Error(`${field}.values must match types`);
  }
  const types = value.types as RouteIdentityScalarType[];
  const values = value.values.map((entry, index) =>
    parseScalarExpression(
      entry,
      `${field}.values[${index}]`,
      types[index],
    )
  );
  return Object.freeze({
    op: "keccak256-abi",
    types: Object.freeze([...types]),
    values: Object.freeze(values),
  });
}

function parseScalarExpression(
  raw: unknown,
  field: string,
  expectedType?: RouteIdentityScalarType,
): RouteIdentityScalarExpression {
  const value = plainRecord(raw, field);
  if (value.op === "call-field") {
    return parseCallField(value, field, expectedType);
  }
  if (value.op === "abi-decode-bytes-field") {
    return parseAbiDecodeBytesField(value, field, expectedType);
  }
  throw new Error(`${field}.op is invalid`);
}

function parseCallField(
  raw: unknown,
  field: string,
  expectedType?: RouteIdentityScalarType,
): RouteIdentityCallField {
  const value = plainRecord(raw, field);
  exactKeys(
    value,
    ["op", "callId", "path", "type"],
    ["op", "callId", "path", "type"],
    field,
  );
  if (value.op !== "call-field") {
    throw new Error(`${field}.op must be call-field`);
  }
  if (typeof value.callId !== "string" || !CALL_ID.test(value.callId)) {
    throw new Error(`${field}.callId is invalid`);
  }
  if (
    !Array.isArray(value.path) ||
    value.path.length === 0 ||
    value.path.length > MAX_PATH_DEPTH ||
    value.path.some((entry) =>
      !Number.isSafeInteger(entry) ||
      Number(entry) < 0 ||
      Number(entry) > MAX_PATH_INDEX
    )
  ) {
    throw new Error(
      `${field}.path must contain 1..${MAX_PATH_DEPTH} indexes ` +
        `within 0..${MAX_PATH_INDEX}`,
    );
  }
  if (
    !SCALAR_TYPES.has(value.type as RouteIdentityScalarType) ||
    (expectedType !== undefined && value.type !== expectedType)
  ) {
    throw new Error(
      `${field}.type must be ${expectedType ?? "a supported scalar"}`,
    );
  }
  return Object.freeze({
    op: "call-field",
    callId: value.callId,
    path: parsePath(value.path, field),
    type: value.type as RouteIdentityScalarType,
  });
}

function parseAbiDecodeBytesField(
  value: Record<string, unknown>,
  field: string,
  expectedType?: RouteIdentityScalarType,
): RouteIdentityAbiDecodeBytesField {
  exactKeys(
    value,
    ["op", "callId", "path", "types", "index", "type"],
    ["op", "callId", "path", "types", "index", "type"],
    field,
  );
  if (typeof value.callId !== "string" || !CALL_ID.test(value.callId)) {
    throw new Error(`${field}.callId is invalid`);
  }
  if (
    !Array.isArray(value.types) ||
    value.types.length === 0 ||
    value.types.length > MAX_HASH_FIELDS ||
    value.types.some((entry) =>
      !SCALAR_TYPES.has(entry as RouteIdentityScalarType)
    )
  ) {
    throw new Error(
      `${field}.types must contain 1..${MAX_HASH_FIELDS} static scalars`,
    );
  }
  if (
    !Number.isSafeInteger(value.index) ||
    Number(value.index) < 0 ||
    Number(value.index) >= value.types.length
  ) {
    throw new Error(`${field}.index is outside decoded fields`);
  }
  const index = Number(value.index);
  const selectedType = value.types[index];
  if (
    !SCALAR_TYPES.has(value.type as RouteIdentityScalarType) ||
    value.type !== selectedType ||
    (expectedType !== undefined && value.type !== expectedType)
  ) {
    throw new Error(
      `${field}.type must match types[index]` +
        (expectedType === undefined ? "" : ` and ${expectedType}`),
    );
  }
  return Object.freeze({
    op: "abi-decode-bytes-field",
    callId: value.callId,
    path: parsePath(value.path, field),
    types: Object.freeze([
      ...(value.types as RouteIdentityScalarType[]),
    ]),
    index,
    type: value.type as RouteIdentityScalarType,
  });
}

function parsePath(
  raw: unknown,
  field: string,
): readonly number[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_PATH_DEPTH ||
    raw.some((entry) =>
      !Number.isSafeInteger(entry) ||
      Number(entry) < 0 ||
      Number(entry) > MAX_PATH_INDEX
    )
  ) {
    throw new Error(
      `${field}.path must contain 1..${MAX_PATH_DEPTH} indexes ` +
        `within 0..${MAX_PATH_INDEX}`,
    );
  }
  return Object.freeze(raw.map(Number));
}

function expressionCallIds(
  expression: RouteIdentityScalarExpression | RouteIdentityAbiKeccak,
): readonly string[] {
  if (expression.op === "keccak256-abi") {
    return expression.values.flatMap(expressionCallIds);
  }
  return [expression.callId];
}

function resolveDerivedValue(
  expression: RouteIdentityScalarExpression | RouteIdentityAbiKeccak,
  decodedCalls: ReadonlyMap<string, CanonicalRouteIdentityDecodedCall>,
): string | boolean | bigint {
  if (expression.op !== "keccak256-abi") {
    return resolveScalarExpression(expression, decodedCalls);
  }
  const values = expression.values.map((entry) =>
    resolveScalarExpression(entry, decodedCalls)
  );
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      expression.types,
      values,
    ),
  ).toLowerCase();
}

function resolveScalarExpression(
  expression: RouteIdentityScalarExpression,
  decodedCalls: ReadonlyMap<string, CanonicalRouteIdentityDecodedCall>,
): string | boolean | bigint {
  if (expression.op === "call-field") {
    return resolveCallField(expression, decodedCalls);
  }
  const sourceCall = decodedCalls.get(expression.callId);
  if (
    sourceCall === undefined ||
    inputParamTypeAtPath(sourceCall.inputTypes, expression.path)?.type !==
      "bytes"
  ) {
    throw new Error(
      "route identity ABI decode source must be an ABI bytes field",
    );
  }
  const encoded = resolveRawCallPath(
    expression.callId,
    expression.path,
    decodedCalls,
  );
  if (
    typeof encoded !== "string" ||
    !ethers.isHexString(encoded) ||
    ethers.dataLength(encoded) !== expression.types.length * 32
  ) {
    throw new Error(
      "route identity ABI bytes field must be exact static tuple length",
    );
  }
  let decoded: ethers.Result;
  try {
    decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      expression.types,
      encoded,
    );
  } catch (error) {
    throw new Error("route identity ABI bytes field failed to decode", {
      cause: error,
    });
  }
  return normalizeScalar(
    decoded[expression.index],
    expression.type,
  );
}

function resolveCallField(
  field: RouteIdentityCallField,
  decodedCalls: ReadonlyMap<string, CanonicalRouteIdentityDecodedCall>,
): string | boolean | bigint {
  return normalizeScalar(
    resolveRawCallPath(field.callId, field.path, decodedCalls),
    field.type,
  );
}

function resolveRawCallPath(
  callId: string,
  path: readonly number[],
  decodedCalls: ReadonlyMap<string, CanonicalRouteIdentityDecodedCall>,
): unknown {
  const decodedCall = decodedCalls.get(callId);
  if (decodedCall === undefined) {
    throw new Error(
      `route identity references unmatched call ${callId}`,
    );
  }
  let current: unknown = decodedCall.args;
  for (const index of path) {
    if (!Array.isArray(current) || index >= current.length) {
      throw new Error(
        `route identity field ${callId}[${path.join(".")}] ` +
          "is absent",
      );
    }
    current = current[index];
  }
  return current;
}

function inputParamTypeAtPath(
  inputTypes: readonly ethers.ParamType[],
  path: readonly number[],
): ethers.ParamType | null {
  let current: ethers.ParamType | null = inputTypes[path[0]] ?? null;
  for (let offset = 1; current !== null && offset < path.length; offset++) {
    const index = path[offset];
    if (current.baseType === "tuple") {
      current = current.components?.[index] ?? null;
      continue;
    }
    if (current.baseType === "array") {
      current = current.arrayChildren;
      continue;
    }
    return null;
  }
  return current;
}

function normalizeScalar(
  value: unknown,
  type: RouteIdentityScalarType,
): string | boolean | bigint {
  if (type === "address") {
    return canonicalAddress(value, "route identity address");
  }
  if (type === "bytes32") {
    return canonicalBytes32(value, "route identity bytes32");
  }
  if (type === "bool") {
    if (typeof value !== "boolean") {
      throw new Error("route identity bool has the wrong type");
    }
    return value;
  }
  if (typeof value !== "bigint") {
    throw new Error(`route identity ${type} has the wrong type`);
  }
  if (
    type === "uint256" &&
    (value < 0n || value >= (1n << 256n))
  ) {
    throw new Error("route identity uint256 is out of range");
  }
  if (
    type === "int256" &&
    (value < -(1n << 255n) || value >= (1n << 255n))
  ) {
    throw new Error("route identity int256 is out of range");
  }
  return value;
}

function canonicalAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`${field} must be an address`);
  }
  return ethers.getAddress(value).toLowerCase();
}

function canonicalBytes32(value: unknown, field: string): string {
  if (typeof value !== "string" || !ethers.isHexString(value, 32)) {
    throw new Error(`${field} must be bytes32`);
  }
  return value.toLowerCase();
}

function plainRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): void {
  const keys = Object.keys(value);
  const allowedSet = new Set(allowed);
  const missing = required.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !allowedSet.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${field} keys are invalid ` +
        `(missing=${missing.join(",") || "none"} ` +
        `unknown=${unknown.join(",") || "none"})`,
    );
  }
}
