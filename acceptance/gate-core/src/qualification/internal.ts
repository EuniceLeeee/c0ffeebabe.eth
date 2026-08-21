import {
  evaluateGateCoreRuntime,
  type GateCoreAuthorityPinV1,
  type GateCoreInputV1,
  type GateCoreResultV1,
} from "../index.ts";
import type { PredicateCompositionPortV1 } from "../predicate-composition.ts";

/**
 * Qualification/test-only evaluator.  This relative module is deliberately
 * absent from package.json `exports` and is never imported by the generated
 * release runtime.
 * It may accept a trusted fixture authority and composition so the contract
 * corpus can exercise the generic core without making either caller input or
 * a test fixture production authority.
 */
export function evaluateGateCoreForQualification(
  authorityPin: GateCoreAuthorityPinV1,
  untrustedInput: unknown,
  composition: PredicateCompositionPortV1,
  nowUnixNs: string,
): GateCoreResultV1 {
  return evaluateGateCoreRuntime(authorityPin, untrustedInput, composition, nowUnixNs);
}

export type {
  GateCoreAuthorityPinV1,
  GateCoreInputV1,
  GateCoreResultV1,
} from "../index.ts";
