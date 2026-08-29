import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  type CanonicalJson,
} from "../../../canonical-codec/src/index.ts";
import {
  readIssuedCoarseRouteBindingV1,
  readQualifiedCoarseProjectionReceiptV1,
  type IssuedCoarseRouteBindingV1,
  type QualifiedCoarseProjectionV1,
  type QualifiedCoarseProjectionReceiptV1,
} from "../../../coarse-economics/src/index.ts";
import type {
  RouteCoarseAttemptEvidenceAuthorityV1,
  RouteCoarseAttemptEvidenceV1,
} from "../route-pipeline.ts";
import { registerRouteCoarseAttemptEvidenceAuthorityV1 } from "./coarse-attempt-evidence-state.ts";

export interface RouteCoarseAttemptEvidenceOwnerV1 {
  readonly authority: RouteCoarseAttemptEvidenceAuthorityV1;
  start(binding: IssuedCoarseRouteBindingV1): void;
  observe(
    binding: IssuedCoarseRouteBindingV1,
    projection: QualifiedCoarseProjectionV1,
    familyObservation: CanonicalJson,
  ): void;
}

/** Owner-only process-local recorder. The search coordinator can read an
 * exact binding once. The generic receipt is derived from its opaque
 * capability; the canonical Family observation is the exact value just read
 * through generated composition's paired opaque producer/result port. Only
 * search-runtime-core may import this constructor in production. */
export function createRouteCoarseAttemptEvidenceOwnerV1(): RouteCoarseAttemptEvidenceOwnerV1 {
  const attempts = new WeakMap<object, {
    readonly routeBinding: RouteCoarseAttemptEvidenceV1["routeBinding"];
    readonly attempts: Array<{
      readonly receipt: QualifiedCoarseProjectionReceiptV1;
      readonly familyObservation: CanonicalJson;
    }>;
  }>();
  const consumed = new WeakSet<object>();
  const authority = Object.freeze(Object.create(null)) as RouteCoarseAttemptEvidenceAuthorityV1;
  registerRouteCoarseAttemptEvidenceAuthorityV1(authority, binding => {
    if (consumed.has(binding)) throw new TypeError("coarse attempt evidence was already consumed");
    const attempt = attempts.get(binding);
    if (attempt === undefined) throw new TypeError("coarse attempt evidence was not issued");
    consumed.add(binding);
    attempts.delete(binding);
    return deepFreeze({
      routeBinding: attempt.routeBinding,
      attempts: deepFreeze([...attempt.attempts]),
    });
  });
  return Object.freeze({
    authority,
    start(binding: IssuedCoarseRouteBindingV1): void {
      if (consumed.has(binding)) throw new TypeError("coarse attempt evidence binding was already consumed");
      if (attempts.has(binding)) throw new TypeError("coarse attempt evidence binding was already started");
      attempts.set(binding, {
        routeBinding: readIssuedCoarseRouteBindingV1(binding),
        attempts: [],
      });
    },
    observe(
      binding: IssuedCoarseRouteBindingV1,
      projection: QualifiedCoarseProjectionV1,
      familyObservation: CanonicalJson,
    ): void {
      if (consumed.has(binding)) throw new TypeError("coarse attempt evidence binding was already consumed");
      const attempt = attempts.get(binding);
      if (attempt === undefined) throw new TypeError("coarse attempt evidence binding was not started");
      attempt.attempts.push(deepFreeze({
        receipt: readQualifiedCoarseProjectionReceiptV1(projection),
        familyObservation: decodeCanonicalJson(encodeCanonicalJson(familyObservation)),
      }));
    },
  });
}
