import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { SIX_STEP_PREDICATE_VALUATION_ORACLE_MANIFEST_ENTRIES } from "./predicate-valuation-oracle-manifest.ts";
import { SIX_STEP_REFERENCE_VALUATION_ORACLE_MANIFEST_ENTRIES } from "./reference-valuation-oracle-manifest.ts";

const nativeEquivalentPredicate = SIX_STEP_PREDICATE_VALUATION_ORACLE_MANIFEST_ENTRIES[0]!;
const nativeEquivalentReference = SIX_STEP_REFERENCE_VALUATION_ORACLE_MANIFEST_ENTRIES[0]!;
if (nativeEquivalentPredicate.ownerRef !== nativeEquivalentReference.ownerRef) {
  throw new TypeError("Six-Step valuation oracle qualification manifest owner mismatch");
}
const nativeEquivalentBase = Object.freeze({
  ...nativeEquivalentPredicate,
  referenceOracleProgramDescriptorDigest: nativeEquivalentReference.referenceOracleProgramDescriptorDigest,
});

export const SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES = Object.freeze([
  Object.freeze({
    ...nativeEquivalentBase,
    qualificationLeafDigest: hashDomain("aloha/six-step/valuation-oracle-qualification-leaf/v1", nativeEquivalentBase),
  }),
]);

export const SIX_STEP_VALUATION_ORACLE_COMPOSITION_ROOT: Hash = hashDomain(
  "aloha/six-step/valuation-oracle-composition/v1",
  SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES.map(entry => entry.qualificationLeafDigest),
);
