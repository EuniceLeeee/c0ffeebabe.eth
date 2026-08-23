import { univ4Discovery } from "../univ4-family/discovery.js";
import { deepGuardCopy } from "./guard-copy.js";

/**
 * The fee-hook Family shares the manager nomination surface (same
 * Initialize/Swap events regardless of hook). Deep copy for a distinct
 * Family-guarded object graph; the standard univ4 Family object stays
 * untouched.
 */
export const univ4FeeHookDiscovery = deepGuardCopy(univ4Discovery);
