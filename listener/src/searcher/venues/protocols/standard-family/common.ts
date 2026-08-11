import { ethers } from "ethers";
import {
  makeProtocolAdapter,
  PROTOCOL_LEG_DESCRIPTORS,
} from "../../../../adapters/protocol-legs.js";
import type { TokenEdge } from "../../../planner/token-graph.js";
import type {
  FamilyRouteDescriptor,
  FamilyOwnedActionAdapter,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CallerRef,
  CanonicalSource,
} from "../../adapter-request-program.js";
import type { RouteVenueMid } from "../../mid-readers.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import type { CanonicalValue } from "../../canonical-value.js";

export const MAX_UINT256 = (1n << 256n) - 1n;

export function bindProtocolLegAction(
  adapterId: string,
  descriptor: FamilyOwnedActionAdapter["descriptor"],
): FamilyOwnedActionAdapter {
  const leg = PROTOCOL_LEG_DESCRIPTORS.find((entry) => entry.id === adapterId);
  if (leg === undefined) {
    throw new Error(`protocol leg descriptor not found for ${adapterId}`);
  }
  return bindFamilyOwnedAction({
    action: makeProtocolAdapter(leg),
    descriptor,
  });
}

export interface ProtocolQuotePoint {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export interface ProtocolPricingSnapshot {
  readonly source: CanonicalSource;
  readonly quotes: Readonly<Record<string, ProtocolQuotePoint>>;
}

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

export function protocolMid(input: {
  readonly route: FamilyRouteDescriptor;
  readonly adapterId: string;
  readonly target: string;
  readonly quote: ProtocolQuotePoint;
}): RouteVenueMid {
  if (input.quote.amountIn <= 0n || input.quote.amountOut <= 0n) {
    throw new Error("protocol mid requires a positive quote point");
  }
  const mid = Number(input.quote.amountOut) / Number(input.quote.amountIn);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`protocol quote produced invalid mid ${mid}`);
  }
  const reserveA = input.quote.amountIn * 10_000n;
  const reserveB = input.quote.amountOut * 10_000n;
  const depthProxy = Number(reserveA < reserveB ? reserveA : reserveB);
  if (!Number.isFinite(depthProxy) || depthProxy <= 0) {
    throw new Error("protocol quote produced an invalid depth proxy");
  }
  const edge: TokenEdge = Object.freeze({
    adapterId: input.adapterId,
    instanceKey: input.route.instanceKey,
    target: canonicalAddress(input.target),
    tokenIn: canonicalAddress(input.route.tokenIn),
    tokenOut: canonicalAddress(input.route.tokenOut),
    slotKind: input.route.taxonomy.slotKind,
    ...(input.route.taxonomy.slotKind === "protocol" &&
        input.route.taxonomy.protocolAction !== undefined
      ? { protocolAction: input.route.taxonomy.protocolAction }
      : {}),
    edgeKind: "protocol" as const,
    leavesStandingPosition: false,
  });
  return Object.freeze({
    kind: "protocol" as const,
    pool: canonicalAddress(input.target),
    edges: Object.freeze([edge]) as unknown as TokenEdge[],
    mid,
    feeBps: 0,
    reserveA,
    reserveB,
    depthProxy,
  });
}

export function assertRouteBound(input: {
  readonly descriptorInstanceKey: string;
  readonly descriptorTarget: string;
  readonly route: FamilyRouteDescriptor & { readonly target: string };
  readonly bindingFingerprint: string;
}): void {
  if (
    input.route.instanceKey !== input.descriptorInstanceKey ||
    !sameAddress(input.route.target, input.descriptorTarget) ||
    input.route.bindingRef.fingerprint !== input.bindingFingerprint
  ) {
    throw new Error("protocol route is not bound to its instance descriptor");
  }
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

export function quoteResultMap(
  results: readonly AdapterRequestResult[],
  points: readonly {
    readonly routeKey: string;
    readonly requestId: string;
    readonly amountIn: bigint;
    readonly decodeAmountOut: (data: string) => bigint;
  }[],
): ProtocolPricingSnapshot {
  const successful = points.map((point) => returnedResult(results, point.requestId));
  const source = assertSameSource(successful);
  const quotes: Record<string, ProtocolQuotePoint> = {};
  for (const point of points) {
    const amountOut = point.decodeAmountOut(
      returnedResult(results, point.requestId).data,
    );
    if (amountOut <= 0n) {
      throw new Error(`protocol current quote ${point.routeKey} returned ${amountOut}`);
    }
    quotes[point.routeKey] = Object.freeze({
      amountIn: point.amountIn,
      amountOut,
    });
  }
  return Object.freeze({ source, quotes });
}
