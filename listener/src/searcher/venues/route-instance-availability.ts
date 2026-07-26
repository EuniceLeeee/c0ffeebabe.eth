/**
 * A family-owned, source-stable statement that one discovered instance does
 * not belong in that family's executable graph.
 *
 * This is not an RPC/probe failure: graph publication may remember the
 * instance as classified and must not retry it every block. Families should
 * use this only when immutable identity metadata proves the exclusion.
 */
export class RouteInstanceNotApplicableError extends Error {
  readonly code = "route-instance-not-applicable" as const;

  constructor(reason: string) {
    super(reason);
    this.name = "RouteInstanceNotApplicableError";
  }
}

export function isRouteInstanceNotApplicableError(
  value: unknown,
): value is RouteInstanceNotApplicableError {
  return value instanceof RouteInstanceNotApplicableError;
}
