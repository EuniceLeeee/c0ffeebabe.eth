import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { GateCoreAuthorityPinV1, GateCoreInputV1 } from "../index.ts";
import type { PredicateCompositionBindingV1 } from "../predicate-composition.ts";
import type {
  CommonEnvelopeAuthorityPortV1,
  PredicateDomainMaterialV1,
  PredicateMaterialUnavailableCodeV1,
} from "../material-provider.ts";

export type CommonEnvelopeAssemblyStateV1 =
  | Readonly<{
      readonly status: "available";
      readonly authority: GateCoreAuthorityPinV1;
      readonly input: GateCoreInputV1;
      readonly nowUnixNs: string;
    }>
  | Readonly<{
      readonly status: "missing" | "invalid";
      readonly code: PredicateMaterialUnavailableCodeV1;
      readonly evidenceRoot: Hash;
    }>;

export type CommonEnvelopeAssemblerV1 = (
  binding: PredicateCompositionBindingV1,
  material: PredicateDomainMaterialV1,
) => Promise<CommonEnvelopeAssemblyStateV1>;

const commonEnvelopeAuthorities = new WeakMap<object, CommonEnvelopeAssemblerV1>();

/** Internal release-owner issuer.  It is deliberately not re-exported by the
 * GateCore package or collectors public barrel. */
export function registerCommonEnvelopeAuthorityPortV1(
  assemble: CommonEnvelopeAssemblerV1,
): CommonEnvelopeAuthorityPortV1 {
  if (typeof assemble !== "function") throw new TypeError("common envelope assembler implementation is required");
  const port = Object.freeze(Object.create(null)) as object;
  commonEnvelopeAuthorities.set(port, assemble);
  return port;
}

export function assertCommonEnvelopeAuthorityPortV1(
  value: unknown,
): asserts value is CommonEnvelopeAuthorityPortV1 {
  if (value === null || typeof value !== "object" || !commonEnvelopeAuthorities.has(value)) {
    throw new TypeError("common envelope authority port was not release-owner-issued");
  }
}

export function invokeCommonEnvelopeAuthorityPortV1(
  port: CommonEnvelopeAuthorityPortV1,
  binding: PredicateCompositionBindingV1,
  material: PredicateDomainMaterialV1,
): Promise<CommonEnvelopeAssemblyStateV1> {
  assertCommonEnvelopeAuthorityPortV1(port);
  return commonEnvelopeAuthorities.get(port)!(binding, material);
}
