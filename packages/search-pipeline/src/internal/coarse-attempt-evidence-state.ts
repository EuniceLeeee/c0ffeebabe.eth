import type {
  RouteCoarseAttemptEvidenceAuthorityV1,
  RouteCoarseAttemptEvidenceV1,
} from "../route-pipeline.ts";
import type { IssuedCoarseRouteBindingV1 } from "../../../coarse-economics/src/index.ts";

export type RouteCoarseAttemptEvidenceReaderV1 = (
  binding: IssuedCoarseRouteBindingV1,
) => RouteCoarseAttemptEvidenceV1;

const readers = new WeakMap<object, RouteCoarseAttemptEvidenceReaderV1>();

export function registerRouteCoarseAttemptEvidenceAuthorityV1(
  authority: RouteCoarseAttemptEvidenceAuthorityV1,
  reader: RouteCoarseAttemptEvidenceReaderV1,
): void {
  if (readers.has(authority)) throw new TypeError("coarse attempt evidence authority already registered");
  readers.set(authority, reader);
}

export function routeCoarseAttemptEvidenceReaderV1(
  authority: RouteCoarseAttemptEvidenceAuthorityV1,
): RouteCoarseAttemptEvidenceReaderV1 | undefined {
  return readers.get(authority);
}
