import {
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type { SixStepValuationOracleInputV1, SixStepValuationOracleV1 } from "../valuation-oracle.ts";

const identity = Object.freeze({
  chainId: "1",
  kind: "erc20",
  address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
});
const assetRef = hashDomain("aloha/asset-ref/v1", identity);
const ownerRef = hashDomain("aloha/economic-safety/valuation-owner-ref/v1", {
  modulePath: "valuation-owners/native-equivalent/src/runtime.ts",
  exportName: "createNativeEquivalentValuationOwnerV1",
});
const implementationHash = hashDomain("aloha/economic-safety/valuation-owner-implementation/v1", {
  ownerRef,
  assetRef,
  semantics: "same-source-mainnet-wrapped-native-one-to-one-v1",
});
const factSchemaRef = hashDomain("aloha/economic-valuation-fact-schema/v1", {
  kind: "aloha.economic-valuation-fact-v1",
  semantics: "release-registry-qualified-current-source-owner-fact-v1",
});
export const NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE_PROGRAM_DIGEST = hashDomain(
  "aloha/six-step/valuation-oracle-program/v1",
  {
    ownerRef,
    semantics: "mainnet-weth-native-numeraire-one-to-one",
    currentSourceObservation: "no-read-exact-source-binding",
    implementation: "predicate-adapter-v1",
  },
);

const same = (left: unknown, right: unknown): boolean => encodeCanonicalJson(left) === encodeCanonicalJson(right);

export const NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE: SixStepValuationOracleV1 = Object.freeze({
  ownerRef: ownerRef as Hash,
  implementationHash: implementationHash as Hash,
  factSchemaRef: factSchemaRef as Hash,
  programDescriptorDigest: NATIVE_EQUIVALENT_SIX_STEP_VALUATION_ORACLE_PROGRAM_DIGEST,
  evaluate(input: SixStepValuationOracleInputV1) {
    const expectedObservationRoot = hashDomain("aloha/economic-valuation-current-source-observation/no-read/v1", {
      generationId: input.generationId,
      source: input.source,
      assetRef,
      reason: "mainnet-wrapped-native-is-native-numeraire",
    });
    return input.profitAsset.assetRef === assetRef
      && same(input.profitAsset.identity, identity)
      && input.descriptor.ownerRef === ownerRef
      && input.descriptor.implementationHash === implementationHash
      && input.descriptor.factSchemaRef === factSchemaRef
      && input.fact.ownerRef === ownerRef
      && input.fact.ownerImplementationHash === implementationHash
      && input.fact.assetRef === assetRef
      && input.fact.numerator === "1"
      && input.fact.denominator === "1"
      && input.fact.currentSourceObservationRoot === expectedObservationRoot;
  },
});
