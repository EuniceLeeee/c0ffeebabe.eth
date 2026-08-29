import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";
import { currentCatalogInput, readCurrentCatalogInput } from "./current-release.ts";
import { generateCatalogWithImpact, verifyCatalogLedger } from "./index.ts";
import { verifyCurrentCatalogGeneration } from "./verification-owner.ts";
import {
  registerCurrentCatalogImpactAnalysisCapabilityV1,
  type CurrentCatalogImpactAnalysisCapabilityV1,
  type CurrentCatalogImpactAnalysisStateV1,
} from "./internal/current-impact-analysis-state.ts";

const PRODUCTION_REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export interface CurrentCatalogImpactObservationIdentityV1 {
  readonly semanticLedgerHash: Hash;
  readonly semanticOutputRoot: Hash;
  readonly proposedCapabilitySetRoot: Hash;
  readonly impactSnapshotRoot: Hash;
  readonly impactReceiptRoot: Hash;
}

export function assertCurrentCatalogImpactObservationExactV1(
  verified: CurrentCatalogImpactObservationIdentityV1,
  regenerated: CurrentCatalogImpactObservationIdentityV1,
): void {
  if (
    verified.semanticLedgerHash !== regenerated.semanticLedgerHash
    || verified.semanticOutputRoot !== regenerated.semanticOutputRoot
    || verified.proposedCapabilitySetRoot !== regenerated.proposedCapabilitySetRoot
    || verified.impactSnapshotRoot !== regenerated.impactSnapshotRoot
    || verified.impactReceiptRoot !== regenerated.impactReceiptRoot
  ) throw new TypeError("current catalog impact owner is unavailable: verified regeneration changed before owner issuance");
}

/**
 * Production Boundary owner. No caller path, snapshot, receipt, pin or verdict
 * is accepted. Failure to reproduce the exact current catalog leaves reuse
 * analysis unavailable.
 */
export function observeCurrentCatalogImpactAnalysisV1(): CurrentCatalogImpactAnalysisCapabilityV1 {
  const verification = verifyCurrentCatalogGeneration(PRODUCTION_REPOSITORY_ROOT);
  const persisted = readCurrentCatalogInput(PRODUCTION_REPOSITORY_ROOT);
  const artifacts = generateCatalogWithImpact(currentCatalogInput(PRODUCTION_REPOSITORY_ROOT), persisted.priorCatalogImpact);
  const errors = verifyCatalogLedger(PRODUCTION_REPOSITORY_ROOT, artifacts);
  if (errors.length !== 0) throw new TypeError(`current catalog impact owner is unavailable: ${errors.join(",")}`);
  const proposedCapabilitySetRoot = artifacts.familyCatalog.proposedCapabilitySetRoot;
  if (artifacts.strategyCatalog.proposedCapabilitySetRoot !== proposedCapabilitySetRoot) {
    throw new TypeError("current catalog impact owner is unavailable: generated capability roots diverged");
  }
  assertCurrentCatalogImpactObservationExactV1({
    semanticLedgerHash: verification.semanticLedgerHash,
    semanticOutputRoot: verification.semanticOutputRoot,
    proposedCapabilitySetRoot: verification.observedProposedCapabilitySetRoot,
    impactSnapshotRoot: verification.impactSnapshotRoot,
    impactReceiptRoot: verification.impactReceiptRoot,
  }, {
    semanticLedgerHash: artifacts.ledger.ledgerHash,
    semanticOutputRoot: artifacts.outputRoot,
    proposedCapabilitySetRoot,
    impactSnapshotRoot: artifacts.impactSnapshot.snapshotRoot,
    impactReceiptRoot: artifacts.impactReceipt.receiptRoot,
  });
  return registerCurrentCatalogImpactAnalysisCapabilityV1({
    priorSnapshot: persisted.priorCatalogImpact.snapshot,
    currentSnapshot: artifacts.impactSnapshot,
    impactReceipt: artifacts.impactReceipt,
    semanticLedgerHash: artifacts.ledger.ledgerHash,
    semanticOutputRoot: artifacts.outputRoot,
    proposedCapabilitySetRoot,
    verificationReceiptRoot: verification.receiptRoot,
  });
}

export {
  type CurrentCatalogImpactAnalysisCapabilityV1,
  type CurrentCatalogImpactAnalysisStateV1,
};
