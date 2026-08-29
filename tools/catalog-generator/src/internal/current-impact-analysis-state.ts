import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type {
  CatalogImpactReceiptV1,
  CatalogImpactSnapshotV1,
} from "../impact-receipt.ts";

declare const currentCatalogImpactAnalysisBrand: unique symbol;

export interface CurrentCatalogImpactAnalysisCapabilityV1 {
  readonly [currentCatalogImpactAnalysisBrand]: true;
}

export interface CurrentCatalogImpactAnalysisStateV1 {
  readonly priorSnapshot: CatalogImpactSnapshotV1;
  readonly currentSnapshot: CatalogImpactSnapshotV1;
  readonly impactReceipt: CatalogImpactReceiptV1;
  readonly semanticLedgerHash: Hash;
  readonly semanticOutputRoot: Hash;
  readonly proposedCapabilitySetRoot: Hash;
  readonly verificationReceiptRoot: Hash;
}

const states = new WeakMap<object, CurrentCatalogImpactAnalysisStateV1>();

/** Process-local registry. Production registration is restricted to the exact
 * catalog owner edge; tests reach it only through their fixture issuer. */
export function registerCurrentCatalogImpactAnalysisCapabilityV1(
  state: CurrentCatalogImpactAnalysisStateV1,
): CurrentCatalogImpactAnalysisCapabilityV1 {
  const capability = Object.freeze({});
  states.set(capability, Object.freeze(state));
  return capability as CurrentCatalogImpactAnalysisCapabilityV1;
}

export function readCurrentCatalogImpactAnalysisCapabilityV1(
  capability: CurrentCatalogImpactAnalysisCapabilityV1,
): CurrentCatalogImpactAnalysisStateV1 {
  const state = states.get(capability as object);
  if (state === undefined) throw new TypeError("current catalog impact analysis capability is not Boundary-issued");
  return state;
}
