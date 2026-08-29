/**
 * Narrow cross-boundary contract for the pre-release workflow and fact
 * collectors. Issuers/importers remain internal; structural clones cannot
 * be read because the capability is retained in the internal owner WeakMap.
 */
export {
  type PreReleaseProcessImportReceiptV1,
  type PreReleaseAdvisoryMaterialCapabilityV1,
  type PreReleaseAdvisoryMaterialProjectionV1,
} from "./pre-release-staging-contract.ts";
export { readPreReleaseAdvisoryMaterialCapabilityV1 } from "./internal/pre-release-runtime-receipt-state.ts";
