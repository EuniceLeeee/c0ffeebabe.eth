import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CallerRef, CanonicalSource } from "./adapter-request-program.js";
import type { CanonicalValue } from "./canonical-value.js";

/** Source and execution-effect assertions shared by selector declarations.
 * These primitives do not import any protocol adapter, identity or registry. */
export function effectsProjection(
  effects: Extract<AdapterRequestResult, { readonly ok: true }>["effects"],
): CanonicalValue {
  return {
    tokenDeltas: (effects?.tokenDeltas ?? []).map((item) => ({
      token: lowerAddress(item.token),
      account: lowerAddress(item.account),
      delta: item.delta,
    })),
    nativeDeltas: (effects?.nativeDeltas ?? []).map((item) => ({
      account: lowerAddress(item.account),
      delta: item.delta,
    })),
    totalSupplyDeltas: (effects?.totalSupplyDeltas ?? []).map((item) => ({
      token: lowerAddress(item.token),
      delta: item.delta,
    })),
    logs: (effects?.logs ?? []).map((item) => ({
      address: lowerAddress(item.address),
      topics: [...item.topics],
      data: item.data,
    })),
    traceRef: effects?.traceRef ?? null,
  };
}

export function canonicalAddress(value: string): string {
  return ethers.getAddress(value);
}

export function lowerAddress(value: string): string {
  return canonicalAddress(value).toLowerCase();
}

export function sameAddress(left: string, right: string): boolean {
  return lowerAddress(left) === lowerAddress(right);
}

export function callRequest(
  id: string,
  to: string,
  data: string,
  caller?: CallerRef,
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: canonicalAddress(to),
    data,
    ...(caller === undefined ? {} : { caller }),
    completion: "return-data" as const,
  });
}

export function codeRequest(id: string, address: string): AdapterRequest {
  return Object.freeze({
    id,
    kind: "get-code" as const,
    address: canonicalAddress(address),
  });
}

export function successfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) {
    throw new Error(`standard protocol request result ${id} is missing`);
  }
  if (!result.ok) {
    throw new Error(`standard protocol request ${id} is unresolved: ${result.failure}`);
  }
  return result;
}

export function returnedResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = successfulResult(results, id);
  if (result.completion !== "returned") {
    throw new Error(`standard protocol request ${id} did not return`);
  }
  return result;
}

export function assertSameSource(
  results: readonly Extract<AdapterRequestResult, { readonly ok: true }>[],
): CanonicalSource {
  const source = results[0]?.source;
  if (source === undefined) {
    throw new Error("standard protocol evidence result set is empty");
  }
  for (const result of results.slice(1)) assertSource(result.source, source);
  return source;
}

export function assertSource(
  actual: CanonicalSource,
  expected: CanonicalSource,
): void {
  if (
    actual.number !== expected.number ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    actual.generation !== expected.generation
  ) {
    throw new Error("standard protocol result came from a foreign source");
  }
}

export function requireRuntimeCode(
  results: readonly AdapterRequestResult[],
  id: string,
): string {
  const code = returnedResult(results, id).data;
  if (code === "0x") throw new Error("protocol candidate has no runtime code");
  return code;
}

export function decodeAddress(
  iface: ethers.Interface,
  functionName: string,
  results: readonly AdapterRequestResult[],
  id: string,
): string {
  return canonicalAddress(String(
    iface.decodeFunctionResult(functionName, returnedResult(results, id).data)[0],
  ));
}

export function decodeUint(
  iface: ethers.Interface,
  functionName: string,
  results: readonly AdapterRequestResult[],
  id: string,
): bigint {
  return BigInt(
    iface.decodeFunctionResult(functionName, returnedResult(results, id).data)[0],
  );
}

export function decodeDecimals(
  iface: ethers.Interface,
  results: readonly AdapterRequestResult[],
  id: string,
): bigint {
  const decimals = decodeUint(iface, "decimals", results, id);
  if (decimals > 77n) {
    throw new Error(`protocol token decimals ${decimals} exceeds uint256 scale`);
  }
  return 10n ** decimals;
}

export function tokenDeltaAtLeast(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly token: string;
  readonly account: string;
  readonly direction: "increase" | "decrease";
  readonly amount: bigint;
}): boolean {
  const expectedSign = input.direction === "increase" ? 1n : -1n;
  return (input.result.effects?.tokenDeltas ?? []).some((delta) =>
    sameAddress(delta.token, input.token) &&
    sameAddress(delta.account, input.account) &&
    delta.delta * expectedSign >= input.amount
  );
}

export function totalSupplyDeltaAtLeast(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly token: string;
  readonly direction: "increase" | "decrease";
  readonly amount: bigint;
}): boolean {
  const expectedSign = input.direction === "increase" ? 1n : -1n;
  return (input.result.effects?.totalSupplyDeltas ?? []).some((delta) =>
    sameAddress(delta.token, input.token) &&
    delta.delta * expectedSign >= input.amount
  );
}
