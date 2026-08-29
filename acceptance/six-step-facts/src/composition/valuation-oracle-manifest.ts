import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE } from "../valuation-oracles/native-equivalent.ts";
import { NATIVE_EQUIVALENT_SIX_STEP_REFERENCE_VALUATION_ORACLE } from "../reference-valuation-oracles/native-equivalent.ts";

const nativeEquivalentBase = Object.freeze({
  ownerRef: NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE.ownerRef,
  ownerImplementationHash: NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE.implementationHash,
  factSchemaRef: NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE.factSchemaRef,
  predicateOracleProgramDescriptorDigest: NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE.programDescriptorDigest,
  referenceOracleProgramDescriptorDigest: NATIVE_EQUIVALENT_SIX_STEP_REFERENCE_VALUATION_ORACLE.programDescriptorDigest,
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
