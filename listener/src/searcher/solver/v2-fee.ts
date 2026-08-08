import { findV2LineageByFactory } from "../venues/v2-lineage.js";
export { quoteV2ExactInput } from "./v2-constant-product-math.js";

export const DEFAULT_V2_FEE_BPS = 30n;

/**
 * Prefer an attested factory fee and otherwise use the standard V2 quote
 * assumption. Pool identity is proved separately; fee confidence must not
 * decide whether an identified V2 instance can enter the graph. Final
 * simulation remains the execution gate for a default-priced instance.
 */
export function v2FeeBpsForFactory(factory: string | undefined): bigint | null {
  if (!factory) return null;
  return findV2LineageByFactory(factory)?.measuredFeeRule?.feeBps ??
    DEFAULT_V2_FEE_BPS;
}
