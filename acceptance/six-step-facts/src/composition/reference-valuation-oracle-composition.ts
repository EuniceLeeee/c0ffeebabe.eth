import { NATIVE_EQUIVALENT_SIX_STEP_REFERENCE_VALUATION_ORACLE } from "../reference-valuation-oracles/native-equivalent.ts";
import type { SixStepReferenceValuationOracleV1 } from "../reference-valuation-oracle.ts";
import { SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES } from "./valuation-oracle-manifest.ts";

const ORACLES: readonly SixStepReferenceValuationOracleV1[] = Object.freeze([
  NATIVE_EQUIVALENT_SIX_STEP_REFERENCE_VALUATION_ORACLE,
]);

export function resolveSixStepReferenceValuationOracle(ownerRef: unknown): SixStepReferenceValuationOracleV1 | null {
  if (typeof ownerRef !== "string") return null;
  const oracle = ORACLES.find(value => value.ownerRef === ownerRef) ?? null;
  const manifest = SIX_STEP_VALUATION_ORACLE_MANIFEST_ENTRIES.find(value => value.ownerRef === ownerRef) ?? null;
  if (oracle === null || manifest === null
    || oracle.programDescriptorDigest !== manifest.referenceOracleProgramDescriptorDigest) return null;
  return oracle;
}
