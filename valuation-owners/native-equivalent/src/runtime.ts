import {
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";
import type { EconomicValuationOwnerRuntimeBindingV1 } from "../../../specs/economic-valuation-owner/src/index.ts";

const MAINNET_WRAPPED_NATIVE_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const MAINNET_WRAPPED_NATIVE_ASSET = erc20AssetReferenceV1("1", MAINNET_WRAPPED_NATIVE_ADDRESS);
export const NATIVE_EQUIVALENT_SUPPORTED_ASSET_REFS_V1 = Object.freeze([MAINNET_WRAPPED_NATIVE_ASSET.assetRef]);

export const NATIVE_EQUIVALENT_VALUATION_OWNER_REF_V1: Hash = hashDomain(
  "aloha/economic-safety/valuation-owner-ref/v1",
  {
    modulePath: "valuation-owners/native-equivalent/src/runtime.ts",
    exportName: "createNativeEquivalentValuationOwnerV1",
  },
);

export const NATIVE_EQUIVALENT_VALUATION_OWNER_IMPLEMENTATION_HASH_V1: Hash = hashDomain(
  "aloha/economic-safety/valuation-owner-implementation/v1",
  {
    ownerRef: NATIVE_EQUIVALENT_VALUATION_OWNER_REF_V1,
    assetRef: MAINNET_WRAPPED_NATIVE_ASSET.assetRef,
    semantics: "same-source-mainnet-wrapped-native-one-to-one-v1",
  },
);

export const NATIVE_EQUIVALENT_VALUATION_FACT_SCHEMA_REF_V1: Hash = hashDomain(
  "aloha/economic-valuation-fact-schema/v1",
  {
    kind: "aloha.economic-valuation-fact-v1",
    semantics: "release-registry-qualified-current-source-owner-fact-v1",
  },
);

export interface NativeEquivalentValuationQualificationBindingV1 {
  readonly supportedAssetRefs: readonly Hash[];
  readonly implementationClosureRoot: Hash;
  readonly qualificationLeafDigest: Hash;
  readonly valuationOwnerRegistryRoot: Hash;
  readonly qualifiedValuationOwnerSetRoot: Hash;
}

/** Runtime-only factory. Qualification corpus/oracle modules are intentionally
 * absent from this dependency closure. Generated release composition supplies
 * exact compiler-derived roots; callers cannot choose an asset or price. */
export function createNativeEquivalentValuationOwnerV1(
  qualification: NativeEquivalentValuationQualificationBindingV1,
): EconomicValuationOwnerRuntimeBindingV1 {
  if (qualification.supportedAssetRefs.length !== 1
    || qualification.supportedAssetRefs[0] !== NATIVE_EQUIVALENT_SUPPORTED_ASSET_REFS_V1[0]) {
    throw new TypeError("native-equivalent generated asset coverage does not match the plugin declaration");
  }
  return Object.freeze({
    ownerRef: NATIVE_EQUIVALENT_VALUATION_OWNER_REF_V1,
    supportedAssetRefs: NATIVE_EQUIVALENT_SUPPORTED_ASSET_REFS_V1,
    implementationHash: NATIVE_EQUIVALENT_VALUATION_OWNER_IMPLEMENTATION_HASH_V1,
    factSchemaRef: NATIVE_EQUIVALENT_VALUATION_FACT_SCHEMA_REF_V1,
    implementationClosureRoot: qualification.implementationClosureRoot,
    qualificationLeafDigest: qualification.qualificationLeafDigest,
    valuationOwnerRegistryRoot: qualification.valuationOwnerRegistryRoot,
    qualifiedValuationOwnerSetRoot: qualification.qualifiedValuationOwnerSetRoot,
    async observeCurrentSource(
      input: Parameters<EconomicValuationOwnerRuntimeBindingV1["observeCurrentSource"]>[0],
    ) {
      if (encodeCanonicalJson(input.asset as unknown as CanonicalJson)
        !== encodeCanonicalJson(MAINNET_WRAPPED_NATIVE_ASSET as unknown as CanonicalJson)) {
        throw new TypeError("native-equivalent valuation owner does not support the selected asset");
      }
      const currentSourceObservationRoot = hashDomain(
        "aloha/economic-valuation-current-source-observation/no-read/v1",
        {
          generationId: input.generationId,
          source: input.source,
          assetRef: input.asset.assetRef,
          reason: "mainnet-wrapped-native-is-native-numeraire",
        },
      );
      const body = Object.freeze({
        kind: "aloha.economic-valuation-fact-v1" as const,
        ownerRef: NATIVE_EQUIVALENT_VALUATION_OWNER_REF_V1,
        generationId: input.generationId,
        source: input.source,
        assetRef: input.asset.assetRef,
        numerator: "1",
        denominator: "1",
        ownerImplementationHash: NATIVE_EQUIVALENT_VALUATION_OWNER_IMPLEMENTATION_HASH_V1,
        valuationOwnerRegistryRoot: qualification.valuationOwnerRegistryRoot,
        qualifiedValuationOwnerSetRoot: qualification.qualifiedValuationOwnerSetRoot,
        qualificationLeafDigest: qualification.qualificationLeafDigest,
        currentSourceObservationRoot,
      });
      return Object.freeze({ ...body, factRoot: hashDomain("aloha/economic-valuation-fact/v1", body) });
    },
  });
}
