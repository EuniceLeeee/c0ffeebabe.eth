import { hashCanonical, type CanonicalValue } from "./venues/canonical-value.js";
import { selectorFamilyIdentity, type SelectorAbiValue, type SelectorImmutableParameter } from "./venues/selector-execution-keys.js";
import type { ReadySelectorCensusCall, ReadySelectorCensusTransaction } from "./ready-selector-census.js";

export interface ReadySelectorEdgeObservation {
  readonly format: "ready-selector-edge/v1";
  readonly status: "unverified";
  readonly completeness: "complete" | "incomplete";
  readonly familyId: string | null;
  readonly selector: string | null;
  readonly signature: string | null;
  readonly programKey: string | null;
  readonly scope: Readonly<{ chainId: number | null; target: string | null; poolId?: string; poolNamespace?: string;
    tokenIn?: string; tokenOut?: string; tokenInId?: string; tokenOutId?: string }>;
  readonly immutableParameters: readonly SelectorImmutableParameter[] | null;
  readonly flowAttribution: "address-correlation-only";
  readonly arguments: readonly SelectorAbiValue[] | null;
  readonly calldata: string | null;
  readonly value: string | null;
  readonly transactionHash: string | null;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  readonly callId: string;
  readonly executionStatus: ReadySelectorCensusCall["executionStatus"];
  readonly issues: readonly string[];
}

export interface ReadySelectorEdgeNomination {
  readonly familyId: string;
  readonly signature: string;
  readonly candidate: unknown;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const hash = (value: unknown): string => hashCanonical(value as CanonicalValue);

/** A data projection before Ready admission. No Graph publication, identity
 * check, simulation, descriptor read or cross-product of transfers occurs. */
export function readySelectorEdgesFromCensus(census: ReadySelectorCensusTransaction,
  nominations: readonly ReadySelectorEdgeNomination[] = []): readonly ReadySelectorEdgeObservation[] {
  const result: ReadySelectorEdgeObservation[] = [];
  for (const call of census.calls) {
    const flows = census.tokenFlows.filter(flow => /^[1-9][0-9]*$/.test(flow.amount));
    const incoming = flows.filter(flow => flow.from === call.sender && (flow.to === call.target || flow.token === call.target));
    const outgoing = flows.filter(flow => flow.to === call.sender && (flow.from === call.target || flow.token === call.target));
    const uniqueAsset = (items: typeof flows) => new Set(items.map(flow => JSON.stringify([flow.token, flow.tokenId ?? null]))).size === 1 ? items[0] : undefined;
    const tokenIn = uniqueAsset(incoming), tokenOut = uniqueAsset(outgoing);
    const matches = nominations.filter(row => {
      const candidate = row.candidate as { callId?: unknown; census?: ReadySelectorCensusTransaction } | null;
      return candidate?.callId === call.id && candidate.census?.transactionHash === census.transactionHash &&
        candidate.census?.blockHash === census.blockHash;
    });
    for (const nomination of matches.length ? matches : [null]) {
      const candidate = nomination?.candidate as { scope?: ReadySelectorEdgeObservation["scope"];
        immutableParameters?: readonly SelectorImmutableParameter[]; arguments?: readonly SelectorAbiValue[];
        programKey?: string } | undefined;
      const identity = nomination ? selectorFamilyIdentity(nomination.signature, call.selector ?? undefined) : null;
      if (nomination && identity?.familyId !== nomination.familyId)
        throw new Error("selector edge nomination ABI/family differs");
      const scope: ReadySelectorEdgeObservation["scope"] = candidate?.scope
        ? { ...candidate.scope }
        : { chainId: census.chainId, target: call.target,
          ...(call.poolId === undefined ? {} : { poolId: call.poolId }),
          ...(call.poolNamespace === undefined ? {} : { poolNamespace: call.poolNamespace }),
          ...(tokenIn === undefined ? {} : { tokenIn: tokenIn.token, ...(tokenIn.tokenId === undefined ? {} : { tokenInId: tokenIn.tokenId }) }),
          ...(tokenOut === undefined ? {} : { tokenOut: tokenOut.token, ...(tokenOut.tokenId === undefined ? {} : { tokenOutId: tokenOut.tokenId }) }) };
      if (scope.chainId !== census.chainId || scope.target !== call.target)
        throw new Error("selector edge nomination scope differs from its source call");
      const issues: string[] = [];
      if (!nomination) issues.push("no-selector-nomination");
      if (!call.selector) issues.push("selector-unavailable");
      if (!identity) issues.push("abi-unavailable");
      if (!candidate?.programKey || candidate.programKey === "observed") issues.push("execution-program-unbound");
      if (!scope.tokenIn) issues.push("token-in-unbound");
      if (!scope.tokenOut) issues.push("token-out-unbound");
      if (call.executionStatus !== "success" || census.receiptStatus !== 1) issues.push("source-call-not-successful");
      result.push(freeze({ format: "ready-selector-edge/v1", status: "unverified",
        completeness: issues.length ? "incomplete" : "complete",
        familyId: nomination?.familyId ?? null, selector: call.selector,
        signature: identity?.signature ?? null, programKey: candidate?.programKey ?? null,
        scope, flowAttribution: "address-correlation-only", immutableParameters: candidate?.immutableParameters === undefined ? null
          : JSON.parse(JSON.stringify(candidate.immutableParameters)),
        arguments: candidate?.arguments === undefined ? null : JSON.parse(JSON.stringify(candidate.arguments)),
        calldata: call.calldata, value: call.value,
        transactionHash: census.transactionHash, blockNumber: census.blockNumber, blockHash: census.blockHash,
        callId: call.id, executionStatus: call.executionStatus, issues: issues.sort() }));
    }
  }
  return Object.freeze(result);
}

/** Fully bound direction/resource projections dedupe independently of source
 * transaction and amount. Missing ABI/roles keep every source call so an
 * unknown parameter can never be incorrectly treated as a mutable amount. */
export function readySelectorEdgeKey(edge: ReadySelectorEdgeObservation): string {
  return `selector-edge:${hash({ selector: edge.selector, signature: edge.signature,
    familyId: edge.familyId, scope: edge.scope, immutableParameters: edge.immutableParameters,
    programKey: edge.programKey,
    ...(edge.completeness === "complete" ? {} : { unresolved: {
      transactionHash: edge.transactionHash, blockHash: edge.blockHash, callId: edge.callId,
      calldata: edge.calldata, value: edge.value } }) })}`;
}

export function readySelectorEdgeFingerprint(edge: ReadySelectorEdgeObservation): string {
  return hash(edge);
}

export function assertReadySelectorEdgeObservation(value: unknown): asserts value is ReadySelectorEdgeObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selector edge must be an observation");
  const edge = value as ReadySelectorEdgeObservation;
  if (edge.format !== "ready-selector-edge/v1" || edge.status !== "unverified" ||
      edge.flowAttribution !== "address-correlation-only" ||
      !["complete", "incomplete"].includes(edge.completeness) || !edge.scope ||
      typeof edge.callId !== "string" || !edge.callId || !Array.isArray(edge.issues) ||
      edge.issues.some(issue => typeof issue !== "string" || !issue) ||
      !["success", "reverted", "unknown"].includes(edge.executionStatus))
    throw new Error("selector edge cannot grant execution authority");
  const nullableHex = (item: unknown, length: number) => item === null ||
    typeof item === "string" && new RegExp(`^0x[0-9a-f]{${length}}$`).test(item);
  if (!nullableHex(edge.selector, 8) || !nullableHex(edge.scope.target, 40) ||
      !nullableHex(edge.transactionHash, 64) || !nullableHex(edge.blockHash, 64) ||
      edge.scope.chainId !== null && (!Number.isSafeInteger(edge.scope.chainId) || edge.scope.chainId < 1) ||
      edge.blockNumber !== null && (!Number.isSafeInteger(edge.blockNumber) || edge.blockNumber < 0))
    throw new Error("selector edge source or scope is malformed");
  for (const address of [edge.scope.tokenIn, edge.scope.tokenOut])
    if (address !== undefined && !nullableHex(address, 40)) throw new Error("selector edge asset address is malformed");
  for (const id of [edge.scope.tokenInId, edge.scope.tokenOutId])
    if (id !== undefined && (typeof id !== "string" || !/^(0|[1-9][0-9]*)$/.test(id)))
      throw new Error("selector edge asset id is malformed");
  if (edge.signature !== null) {
    const identity = selectorFamilyIdentity(edge.signature, edge.selector ?? undefined);
    if (identity.familyId !== edge.familyId || identity.signature !== edge.signature)
      throw new Error("selector edge ABI identity differs");
  } else if (edge.familyId !== null) throw new Error("selector edge family requires an ABI");
  if (edge.completeness === "complete" && (edge.issues.length || !edge.selector || !edge.signature ||
      !edge.programKey || edge.programKey === "observed" || !edge.scope.tokenIn || !edge.scope.tokenOut || edge.immutableParameters === null ||
      edge.arguments === null || edge.executionStatus !== "success"))
    throw new Error("selector edge is missing a required direction/resource binding");
  // Canonical encoding rejects undefined, symbols, holes and non-JSON values.
  readySelectorEdgeFingerprint(edge);
}
