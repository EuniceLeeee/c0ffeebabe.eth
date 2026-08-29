import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

export interface SixStepReferenceValuationOracleInputV1 {
  readonly profitAsset: Readonly<Record<string, unknown>>;
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly fact: Readonly<Record<string, unknown>>;
  readonly generationId: unknown;
  readonly source: unknown;
}

export interface SixStepReferenceValuationOracleV1 {
  readonly ownerRef: Hash;
  readonly programDescriptorDigest: Hash;
  evaluate(input: SixStepReferenceValuationOracleInputV1): boolean;
}
