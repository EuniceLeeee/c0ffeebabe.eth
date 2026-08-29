import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

/** Generic dispatch/port identity. Generated owner composition is deliberately
 * excluded so adding an unrelated owner does not change this digest. */
export const SIX_STEP_VALUATION_ORACLE_GENERIC_CORE_DIGEST = hashDomain(
  "aloha/six-step/valuation-oracle-generic-core/v1",
  {
    input: ["profitAsset", "descriptor", "fact", "generationId", "source"],
    dispatch: "exact-owner-ref-generated-bom",
    result: "boolean-no-producer-verdict",
  },
);

export interface SixStepValuationOracleInputV1 {
  readonly profitAsset: Readonly<Record<string, unknown>>;
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly fact: Readonly<Record<string, unknown>>;
  readonly generationId: unknown;
  readonly source: unknown;
}

export interface SixStepValuationOracleV1 {
  readonly ownerRef: Hash;
  readonly implementationHash: Hash;
  readonly factSchemaRef: Hash;
  readonly programDescriptorDigest: Hash;
  evaluate(input: SixStepValuationOracleInputV1): boolean;
}
