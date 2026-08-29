import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  economicValuationOwnerCriticalMutationCorpusRootV1,
  economicValuationOwnerIndependentOracleCaseRootV1,
  economicValuationOwnerQualificationSpecDigestV1,
} from "../../../specs/economic-valuation-owner/src/index.ts";

/** Qualification-only corpus. Production runtime and generated runtime BOM
 * must never import this module. */
export const NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_V1 = Object.freeze([
  "foreign-asset",
  "foreign-chain",
  "source-splice",
  "generation-splice",
  "owner-ref-splice",
  "implementation-splice",
  "registry-root-splice",
  "qualification-leaf-splice",
  "observation-root-splice",
] as const);

export const NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASES_V1 = Object.freeze([
  Object.freeze({ chainId: "1", asset: "mainnet-weth", numerator: "1", denominator: "1", verdict: "valid" }),
  Object.freeze({ chainId: "1", asset: "arbitrary-erc20", verdict: "invalid" }),
  Object.freeze({ chainId: "10", asset: "weth-address-clone", verdict: "invalid" }),
] as const);

export const NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_V1 = Object.freeze({
  semantics: "same-source-mainnet-wrapped-native-one-to-one-v1",
  currentSourceObservation: "no-read-source-identity-binding-v1",
});

export const NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_DIGEST_V1: Hash =
  economicValuationOwnerQualificationSpecDigestV1(NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_V1);

export const NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_ROOT_V1: Hash =
  economicValuationOwnerCriticalMutationCorpusRootV1(NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_V1);

export const NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASE_ROOT_V1: Hash =
  economicValuationOwnerIndependentOracleCaseRootV1(NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASES_V1);
