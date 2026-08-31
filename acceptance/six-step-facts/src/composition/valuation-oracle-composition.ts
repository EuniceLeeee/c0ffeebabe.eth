import { NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE } from "../valuation-oracles/native-equivalent.ts";
import type { SixStepValuationOracleV1 } from "../valuation-oracle.ts";
import { SIX_STEP_PREDICATE_VALUATION_ORACLE_MANIFEST_ENTRIES } from "./predicate-valuation-oracle-manifest.ts";

const ORACLES: readonly SixStepValuationOracleV1[] = Object.freeze([
  NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE,
]);

export function resolveSixStepValuationOracle(ownerRef: unknown): SixStepValuationOracleV1 | null {
  if (typeof ownerRef !== "string") return null;
  const oracle = ORACLES.find(value => value.ownerRef === ownerRef) ?? null;
  const manifest = SIX_STEP_PREDICATE_VALUATION_ORACLE_MANIFEST_ENTRIES.find(value => value.ownerRef === ownerRef) ?? null;
  if (oracle === null || manifest === null
    || oracle.implementationHash !== manifest.ownerImplementationHash
    || oracle.factSchemaRef !== manifest.factSchemaRef
    || oracle.programDescriptorDigest !== manifest.predicateOracleProgramDescriptorDigest) return null;
  return oracle;
}
