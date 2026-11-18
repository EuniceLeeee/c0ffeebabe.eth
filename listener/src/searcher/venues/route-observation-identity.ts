import type { TokenEdge } from "../planner/token-graph.js";

/** Execution calldata continues to use edge.target. Receipt and activity
 * matching use the declaration's bound observation resource instead. */
export function edgeObservationTarget(edge: TokenEdge): string {
  return (edge.observationTarget ?? edge.target).toLowerCase();
}

export function edgeObservationPoolId(edge: TokenEdge): string | undefined {
  return edge.observationPoolId ?? edge.poolId?.toLowerCase();
}

/** Native IDs were normalized by their ABI type at binding. Opaque strings
 * retain case; older unsigned byte IDs retain their existing comparison. */
export function edgeObservationPoolIdEquals(edge: TokenEdge, value: string | undefined): boolean {
  const expected = edgeObservationPoolId(edge);
  if (value === undefined || expected === undefined) return value === expected;
  return edge.observationPoolId === undefined ? expected === value.toLowerCase() : expected === value;
}

export function edgeMatchesObservationIdentity(edge: TokenEdge, identity: string): boolean {
  return edgeObservationTarget(edge) === identity.toLowerCase() || edgeObservationPoolIdEquals(edge, identity);
}

export function edgeObservationIdentity(edge: TokenEdge): string {
  return edgeObservationPoolId(edge) ?? edgeObservationTarget(edge);
}
