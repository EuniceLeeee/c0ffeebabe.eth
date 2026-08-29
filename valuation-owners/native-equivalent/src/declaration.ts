import type { EconomicValuationOwnerDeclarationV1 } from "../../../specs/economic-valuation-owner/src/index.ts";
import {
  NATIVE_EQUIVALENT_VALUATION_FACT_SCHEMA_REF_V1,
  NATIVE_EQUIVALENT_VALUATION_OWNER_IMPLEMENTATION_HASH_V1,
  NATIVE_EQUIVALENT_VALUATION_OWNER_REF_V1,
} from "./runtime.ts";
import {
  NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASE_ROOT_V1,
  NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_ROOT_V1,
  NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_DIGEST_V1,
} from "./qualification.ts";

/** Generator input only. Generated runtime imports runtime.ts directly and
 * embeds these qualification roots as static data; it never imports this
 * declaration or qualification.ts. */
export const NATIVE_EQUIVALENT_VALUATION_OWNER_DECLARATION_V1: EconomicValuationOwnerDeclarationV1 = Object.freeze({
  ownerRef: NATIVE_EQUIVALENT_VALUATION_OWNER_REF_V1,
  modulePath: "valuation-owners/native-equivalent/src/runtime.ts",
  exportName: "createNativeEquivalentValuationOwnerV1",
  implementationHash: NATIVE_EQUIVALENT_VALUATION_OWNER_IMPLEMENTATION_HASH_V1,
  factSchemaRef: NATIVE_EQUIVALENT_VALUATION_FACT_SCHEMA_REF_V1,
  sourceReadCapabilityRefs: Object.freeze([]),
  qualificationModulePath: "valuation-owners/native-equivalent/src/qualification.ts",
  qualificationSpecExportName: "NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_V1",
  criticalMutationCorpusExportName: "NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_V1",
  independentOracleCasesExportName: "NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASES_V1",
  qualificationSpecDigest: NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_DIGEST_V1,
  criticalMutationCorpusRoot: NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_ROOT_V1,
  independentOracleCaseRoot: NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASE_ROOT_V1,
});
