import { univ4Pricing } from "../univ4-family/pricing.js";
import { deepGuardCopy } from "./guard-copy.js";

/**
 * Slot0/liquidity math and precision reads are hook-agnostic. A deep copy
 * gives the Family guard a distinct mutable object graph (nested objects
 * included) while the implementation functions stay shared; the standard
 * univ4 Family object stays untouched.
 */
export const univ4FeeHookPricing = deepGuardCopy(univ4Pricing);
