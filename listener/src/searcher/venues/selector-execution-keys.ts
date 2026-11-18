import { FunctionFragment, Interface, ParamType, getAddress } from "ethers";
import { familyId, instanceKey, routeKey, type FamilyId, type InstanceKey, type RouteKey } from "./adapter-family-identifiers.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";

/** Lossless, JSON-compatible ABI values. Ordinary strings retain their bytes. */
export type SelectorAbiValue = string | boolean | readonly SelectorAbiValue[];
export interface SelectorFamilyIdentity {
  readonly familyId: FamilyId;
  readonly selector: string;
  /** Canonical call signature. Argument names, outputs and mutability do not
   * change calldata identity; the full declaration still owns its content hash. */
  readonly signature: string;
  readonly abiFingerprint: string;
}
export interface SelectorImmutableParameter {
  readonly path: readonly number[];
  readonly type: string;
  readonly value: SelectorAbiValue;
}
export interface SelectorExecutionResourceScope {
  readonly chainId: number;
  readonly target: string;
  /** These are typed/canonicalized by their producer. Do not infer that an
   * opaque string starting with 0x has bytes semantics. */
  readonly poolId?: string;
  readonly poolNamespace?: string;
}
export interface SelectorExecutionInstanceScope extends SelectorExecutionResourceScope {
  readonly familyId: FamilyId | string;
  readonly immutableParameters?: readonly SelectorImmutableParameter[];
}
export interface SelectorExecutionAsset {
  readonly address: string;
  readonly id?: string;
}
export interface SelectorExecutionRouteScope {
  readonly tokenIn: SelectorExecutionAsset;
  readonly tokenOut: SelectorExecutionAsset;
  readonly direction?: string;
}

function fail(reason: string): never { throw new Error(`selector execution identity: ${reason}`); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function address(value: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) fail("invalid address");
  try { return getAddress(value).toLowerCase(); } catch { return fail("invalid address"); }
}
function opaque(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\u0000-\u001f]/.test(value))
    fail(`invalid ${field}`);
  return value;
}
function path(value: readonly number[]): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(index => !Number.isSafeInteger(index) || index < 0))
    fail("invalid immutable ABI path");
  return Object.freeze([...value]);
}
function integer(value: unknown, type: string): string {
  if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value)) &&
      (typeof value !== "string" || !/^(?:-?(?:0|[1-9][0-9]*)|0x[0-9a-f]+)$/i.test(value))) fail(`lossless ${type} required`);
  const match = /^(u?int)([0-9]*)$/.exec(type);
  if (!match) fail("invalid integer ABI type");
  const bits = BigInt(match[2] || 256), signed = match[1] === "int";
  const n = BigInt(value as string | number | bigint);
  const lower = signed ? -(1n << (bits - 1n)) : 0n, upper = 1n << (signed ? bits - 1n : bits);
  if (n < lower || n >= upper) fail(`${type} out of range`);
  return n.toString();
}

export function selectorFamilyIdentity(signature: string, selector?: string): SelectorFamilyIdentity {
  const fn = FunctionFragment.from(signature);
  const canonical = fn.format("sighash"), expected = fn.selector.toLowerCase();
  if (selector !== undefined && (typeof selector !== "string" || !/^0x[0-9a-f]{8}$/i.test(selector) || selector.toLowerCase() !== expected))
    fail("selector differs from ABI");
  const abiFingerprint = hashCanonical(canonical);
  return freeze({ familyId: familyId(`execution:${expected}:abi-${abiFingerprint}`),
    selector: expected, signature: canonical, abiFingerprint });
}

export function normalizeSelectorAbiParameter(type: string | ParamType, value: unknown): SelectorAbiValue {
  const parameter = typeof type === "string" ? ParamType.from(type) : type;
  if (parameter.baseType === "array" || parameter.baseType === "tuple") {
    if (!Array.isArray(value)) fail(`${parameter.type} requires an array`);
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail("sparse ABI array");
    if (parameter.baseType === "tuple") {
      const components = parameter.components!;
      if (value.length !== components.length) fail("ABI tuple length differs");
      return Object.freeze(components.map((component, index) => normalizeSelectorAbiParameter(component, value[index])));
    }
    if (parameter.arrayLength !== -1 && value.length !== parameter.arrayLength) fail("fixed ABI array length differs");
    return Object.freeze(value.map(item => normalizeSelectorAbiParameter(parameter.arrayChildren!, item)));
  }
  if (/^u?int[0-9]*$/.test(parameter.type)) return integer(value, parameter.type);
  if (parameter.type === "address") return address(value as string);
  if (parameter.type === "bool") {
    if (typeof value !== "boolean") fail("ABI bool required");
    return value;
  }
  if (parameter.type === "string") {
    if (typeof value !== "string") fail("ABI string required");
    return value;
  }
  if (/^bytes(?:[0-9]+)?$/.test(parameter.type)) {
    if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) fail("ABI hex bytes required");
    if (parameter.type !== "bytes" && value.length !== 2 + 2 * Number(parameter.type.slice(5))) fail("fixed ABI bytes length differs");
    return value.toLowerCase();
  }
  return fail(`unsupported ABI type ${parameter.type}`);
}

export function normalizeSelectorAbiArguments(signature: string, arguments_: readonly unknown[]): readonly SelectorAbiValue[] {
  const fn = FunctionFragment.from(signature);
  if (!Array.isArray(arguments_) || arguments_.length !== fn.inputs.length) fail("ABI argument count differs");
  for (let i = 0; i < arguments_.length; i++) if (!Object.hasOwn(arguments_, i)) fail("sparse ABI arguments");
  return Object.freeze(fn.inputs.map((parameter, index) => normalizeSelectorAbiParameter(parameter, arguments_[index])));
}

/** Canonical round-trip rejects truncated, aliased and trailing calldata. */
export function decodeSelectorAbiArguments(signature: string, calldata: string): readonly SelectorAbiValue[] {
  const identity = selectorFamilyIdentity(signature), fn = FunctionFragment.from(signature), abi = new Interface([fn]);
  if (typeof calldata !== "string" || !/^0x(?:[0-9a-f]{2}){4,}$/i.test(calldata) ||
      calldata.slice(0, 10).toLowerCase() !== identity.selector) fail("calldata selector differs");
  const decoded = abi.decodeFunctionData(fn, calldata);
  if (abi.encodeFunctionData(fn, decoded).toLowerCase() !== calldata.toLowerCase()) fail("noncanonical ABI calldata");
  return normalizeSelectorAbiArguments(signature, decoded);
}

export function selectorAbiParameterAt(signature: string, arguments_: readonly unknown[], parameterPath: readonly number[]):
  Readonly<{ type: string; value: SelectorAbiValue }> {
  const indices = path(parameterPath), fn = FunctionFragment.from(signature), args = normalizeSelectorAbiArguments(signature, arguments_);
  let parameter: ParamType | undefined = fn.inputs[indices[0]!], value: SelectorAbiValue | undefined = args[indices[0]!];
  if (!parameter || value === undefined) fail("ABI resource path unavailable");
  for (const index of indices.slice(1)) {
    if (!Array.isArray(value) || index >= value.length) fail("ABI resource path unavailable");
    parameter = parameter.baseType === "tuple" ? parameter.components![index]
      : parameter.baseType === "array" ? parameter.arrayChildren! : undefined;
    value = value[index];
    if (!parameter || value === undefined) fail("ABI resource path unavailable");
  }
  return freeze({ type: parameter.format("sighash"), value });
}

function comparePaths(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
export function selectorImmutableParameters(signature: string, arguments_: readonly unknown[],
  paths: readonly (readonly number[])[] = []): readonly SelectorImmutableParameter[] {
  const normalized = [...new Map(paths.map(item => { const p = path(item); return [JSON.stringify(p), p] as const; })).values()].sort(comparePaths);
  return freeze(normalized.map(p => ({ path: p, ...selectorAbiParameterAt(signature, arguments_, p) })));
}

export function normalizeSelectorExecutionResource(scope: SelectorExecutionResourceScope): SelectorExecutionResourceScope {
  if (!scope || !Number.isSafeInteger(scope.chainId) || scope.chainId < 1) fail("invalid chain id");
  const target = address(scope.target);
  if (/^0x0{40}$/.test(target)) fail("zero execution target");
  if (scope.poolNamespace !== undefined && scope.poolId === undefined) fail("pool namespace without pool id");
  if (scope.poolId !== undefined && typeof scope.poolId !== "string") fail("invalid pool id");
  return freeze({ chainId: scope.chainId, target,
    ...(scope.poolId === undefined ? {} : { poolId: scope.poolId,
      poolNamespace: opaque(scope.poolNamespace ?? "opaque", "pool namespace") }) });
}
export function normalizeSelectorExecutionAsset(asset: SelectorExecutionAsset): SelectorExecutionAsset {
  if (!asset || typeof asset !== "object") fail("invalid asset");
  return freeze({ address: address(asset.address), ...(asset.id === undefined ? {} : { id: integer(asset.id, "uint256") }) });
}

export function selectorExecutionResourceKey(scope: SelectorExecutionResourceScope): string {
  return `execution-resource:${hashCanonical(normalizeSelectorExecutionResource(scope) as unknown as CanonicalValue)}`;
}
export function selectorExecutionInstanceKey(scope: SelectorExecutionInstanceScope): InstanceKey {
  const resource = normalizeSelectorExecutionResource(scope);
  if (typeof scope.familyId !== "string" || !/^execution:0x[0-9a-f]{8}:abi-[0-9a-f]{64}$/.test(scope.familyId))
    fail("instance requires a selector ABI family");
  const parameters = (scope.immutableParameters ?? []).map(item => ({ path: path(item.path),
    type: ParamType.from(item.type).format("sighash"), value: normalizeSelectorAbiParameter(item.type, item.value) })).sort((a,b) => comparePaths(a.path,b.path));
  if (new Set(parameters.map(item => JSON.stringify(item.path))).size !== parameters.length) fail("duplicate immutable ABI path");
  return instanceKey(`execution-instance:${hashCanonical({ family: scope.familyId, resource: resource as unknown as CanonicalValue,
    parameters: parameters as unknown as CanonicalValue })}`);
}
export function selectorExecutionRouteKey(instance: InstanceKey | string, scope: SelectorExecutionRouteScope): RouteKey {
  if (typeof instance !== "string" || !/^execution-instance:[0-9a-f]{64}$/.test(instance)) fail("route requires a selector execution instance");
  return routeKey(`execution-route:${hashCanonical({ instance, tokenIn: normalizeSelectorExecutionAsset(scope.tokenIn) as unknown as CanonicalValue,
    tokenOut: normalizeSelectorExecutionAsset(scope.tokenOut) as unknown as CanonicalValue,
    ...(scope.direction === undefined ? {} : { direction: opaque(scope.direction, "route direction") }) })}`);
}
export function selectorAssetOfferKey(instance: InstanceKey | string, asset: SelectorExecutionAsset): string {
  if (typeof instance !== "string" || !/^execution-instance:[0-9a-f]{64}$/.test(instance)) fail("offer requires a selector execution instance");
  return `execution-offer:${hashCanonical({ instance, asset: normalizeSelectorExecutionAsset(asset) as unknown as CanonicalValue })}`;
}
/** Shared capacity/holding resource, independent of entry selector/provider. */
export function selectorAssetResourceKey(scope: SelectorExecutionResourceScope, asset: SelectorExecutionAsset): string {
  return `execution-asset-resource:${hashCanonical({ resource: normalizeSelectorExecutionResource(scope) as unknown as CanonicalValue,
    asset: normalizeSelectorExecutionAsset(asset) as unknown as CanonicalValue })}`;
}
