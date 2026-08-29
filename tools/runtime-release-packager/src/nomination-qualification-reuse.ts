import { createPublicKey, verify as verifySignature } from "node:crypto";
import { deepFreeze, encodeCanonicalBytes, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  catalogImpactFamilyProposalOwnershipRootV1,
  verifyCatalogImpactReceiptV1,
  type CatalogImpactSnapshotV1,
} from "../../catalog-generator/src/index.ts";
import {
  readCurrentCatalogImpactAnalysisCapabilityV1,
} from "../../catalog-generator/src/internal/current-impact-analysis-state.ts";
import {
  decodeNominationQualificationDeploymentFactV1,
  decodeRuntimeReleaseSignerPinV1,
  nominationQualificationDeploymentFactSigningBytes,
  type NominationQualificationDeploymentFactV1,
  type RuntimeReleaseBindingV1,
  type RuntimeReleaseNominationQualificationEntryV1,
  type RuntimeReleaseSignerPinV1,
} from "../../../specs/release-authority/src/index.ts";
import { verifyRuntimeReleaseBindingSignatureV1 } from "./internal/runtime-binding-verifier.ts";
import {
  readNominationQualificationReuseOwnerCompositionV1,
  type NominationQualificationReuseOwnerCompositionV1,
} from "./internal/nomination-qualification-reuse-owner-state.ts";

export type { NominationQualificationReuseOwnerCompositionV1 } from "./internal/nomination-qualification-reuse-owner-state.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ReusedFamilyNominationQualificationV1 {
  readonly familyId: string;
  readonly artifactId: string;
  readonly nominationProposalLeafDigests: readonly Hash[];
  readonly nominationQualificationEntries: readonly RuntimeReleaseNominationQualificationEntryV1[];
}

export interface FamilyNominationRequalificationDenominatorV1 {
  readonly familyId: string;
  readonly artifactId: string;
  readonly nominationProposalLeafDigests: readonly Hash[];
  readonly reason: "catalog-impact-affected";
}

export interface NominationQualificationPreSignReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.nomination-qualification-pre-sign-report";
  readonly advisoryOnly: true;
  readonly priorDeploymentFactId: Hash;
  readonly priorRuntimeBindingId: Hash;
  readonly priorSnapshotRoot: Hash;
  readonly currentSnapshotRoot: Hash;
  readonly currentFamilyProposalOwnershipRoot: Hash;
  readonly currentSemanticLedgerHash: Hash;
  readonly currentSemanticOutputRoot: Hash;
  readonly currentBoundaryVerificationReceiptRoot: Hash;
  readonly reusedFamilies: readonly ReusedFamilyNominationQualificationV1[];
  readonly requalificationDenominator: readonly FamilyNominationRequalificationDenominatorV1[];
  readonly reportRoot: Hash;
}

export interface NominationQualificationPostSignReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.nomination-qualification-post-sign-report";
  readonly advisoryOnly: true;
  readonly preSignReportRoot: Hash;
  readonly currentDeploymentFactId: Hash;
  readonly currentRuntimeBindingId: Hash;
  readonly currentSnapshotRoot: Hash;
  readonly verifiedQualificationEntryCount: number;
  readonly reportRoot: Hash;
}

export interface VerifyNominationQualificationPostSignInputV1 {
  readonly currentRuntimeBinding: RuntimeReleaseBindingV1;
  readonly currentDeploymentFact: NominationQualificationDeploymentFactV1;
}

export interface NominationQualificationReuseConsumerV1 {
  readonly analyzePreSign: () => NominationQualificationPreSignReportV1;
  readonly verifyPostSign: (input: VerifyNominationQualificationPostSignInputV1) => NominationQualificationPostSignReportV1;
}

interface FamilyProposalFactV1 {
  readonly familyId: string;
  readonly artifactId: string;
  readonly proposalLeafDigests: readonly Hash[];
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

function familyProposalFacts(snapshot: CatalogImpactSnapshotV1, label: string): ReadonlyMap<string, FamilyProposalFactV1> {
  const byFamily = new Map<string, FamilyProposalFactV1>();
  const proposalOwner = new Map<Hash, string>();
  for (const artifact of snapshot.artifacts) {
    if (artifact.artifactKind !== "family") continue;
    const familyId = artifact.familyId!;
    if (artifact.nominationProposalLeafDigests.length === 0) throw new TypeError(`${label} Family proposal mapping is empty: ${familyId}`);
    for (const proposalLeafDigest of artifact.nominationProposalLeafDigests) {
      const owner = proposalOwner.get(proposalLeafDigest);
      if (owner !== undefined && owner !== familyId) throw new TypeError(`${label} proposal is mapped across Families: ${owner},${familyId}`);
      proposalOwner.set(proposalLeafDigest, familyId);
    }
    byFamily.set(familyId, Object.freeze({ familyId, artifactId: artifact.artifactId, proposalLeafDigests: artifact.nominationProposalLeafDigests }));
  }
  return byFamily;
}

function qualificationEntries(
  binding: RuntimeReleaseBindingV1,
  families: ReadonlyMap<string, FamilyProposalFactV1>,
  label: string,
): ReadonlyMap<Hash, RuntimeReleaseNominationQualificationEntryV1> {
  const entries = new Map(binding.nominationQualificationSet.entries.map(entry => [entry.proposalLeafDigest, entry] as const));
  const snapshotProposals = [...families.values()].flatMap(value => value.proposalLeafDigests).sort();
  if (!sameCanonical(snapshotProposals, [...entries.keys()].sort())) throw new TypeError(`${label} signed proposal set does not equal the catalog Family partition`);
  return entries;
}

function verifyDeploymentFactSignature(
  value: NominationQualificationDeploymentFactV1,
  pinValue: RuntimeReleaseSignerPinV1,
): NominationQualificationDeploymentFactV1 {
  const fact = decodeNominationQualificationDeploymentFactV1(value);
  const pin = decodeRuntimeReleaseSignerPinV1(pinValue);
  if (fact.signerKeyId !== pin.signerKeyId) throw new TypeError("nomination deployment fact signer pin mismatch");
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]), format: "der", type: "spki",
  });
  if (!verifySignature(null, Buffer.from(nominationQualificationDeploymentFactSigningBytes(fact)), publicKey, Buffer.from(fact.signatureHex.slice(2), "hex"))) {
    throw new TypeError("nomination deployment fact signature invalid");
  }
  return fact;
}

function assertDeploymentFactJoinsBinding(fact: NominationQualificationDeploymentFactV1, binding: RuntimeReleaseBindingV1): void {
  if (
    fact.runtimeBindingId !== binding.bindingId
    || fact.runtimeBindingPayloadHash !== binding.payloadHash
    || fact.candidateReleaseCommit !== binding.candidateReleaseCommit
    || fact.catalogProposedCapabilitySetRoot !== binding.qualifiedCapabilityRefsRoot
    || fact.nominationProgramSetRoot !== binding.nominationProgramSetRoot
    || fact.nominationQualificationSetRoot !== binding.nominationQualificationSetRoot
  ) throw new TypeError("nomination deployment fact does not join the signed runtime binding");
}

function assertDeploymentFactJoinsCatalog(
  fact: NominationQualificationDeploymentFactV1,
  snapshot: CatalogImpactSnapshotV1,
  semanticLedgerHash?: Hash,
  semanticOutputRoot?: Hash,
  verificationReceiptRoot?: Hash,
  proposedCapabilitySetRoot?: Hash,
): void {
  if (
    fact.catalogImpactSnapshotRoot !== snapshot.snapshotRoot
    || fact.catalogFamilyProposalOwnershipRoot !== catalogImpactFamilyProposalOwnershipRootV1(snapshot)
    || (semanticLedgerHash !== undefined && fact.catalogSemanticLedgerHash !== semanticLedgerHash)
    || (semanticOutputRoot !== undefined && fact.catalogSemanticOutputRoot !== semanticOutputRoot)
    || (verificationReceiptRoot !== undefined && fact.catalogBoundaryVerificationReceiptRoot !== verificationReceiptRoot)
    || (proposedCapabilitySetRoot !== undefined && fact.catalogProposedCapabilitySetRoot !== proposedCapabilitySetRoot)
  ) throw new TypeError("nomination deployment fact does not join the owner-observed catalog");
}

/** Two-phase advisory consumer. analyzePreSign accepts no caller facts. */
export function createNominationQualificationReuseConsumerV1(
  composition: NominationQualificationReuseOwnerCompositionV1,
): NominationQualificationReuseConsumerV1 {
  const input = readNominationQualificationReuseOwnerCompositionV1(composition);
  const currentState = readCurrentCatalogImpactAnalysisCapabilityV1(input.currentCatalogImpact);
  const receipt = verifyCatalogImpactReceiptV1({
    receipt: currentState.impactReceipt,
    pinnedBeforeSnapshotRoot: currentState.priorSnapshot.snapshotRoot,
    before: currentState.priorSnapshot,
    after: currentState.currentSnapshot,
  });
  const priorRuntimeSignerPin = decodeRuntimeReleaseSignerPinV1(input.priorRuntimeSignerPin);
  const currentRuntimeSignerPin = decodeRuntimeReleaseSignerPinV1(input.currentRuntimeSignerPin);
  const priorDeploymentFactSignerPin = decodeRuntimeReleaseSignerPinV1(input.priorDeploymentFactSignerPin);
  const currentDeploymentFactSignerPin = decodeRuntimeReleaseSignerPinV1(input.currentDeploymentFactSignerPin);
  const priorBinding = verifyRuntimeReleaseBindingSignatureV1(input.priorRuntimeBinding, priorRuntimeSignerPin);
  const priorFact = verifyDeploymentFactSignature(input.priorDeploymentFact, priorDeploymentFactSignerPin);
  assertDeploymentFactJoinsBinding(priorFact, priorBinding);
  assertDeploymentFactJoinsCatalog(priorFact, currentState.priorSnapshot);
  const priorFamilies = familyProposalFacts(currentState.priorSnapshot, "prior");
  const currentFamilies = familyProposalFacts(currentState.currentSnapshot, "current");
  const priorEntries = qualificationEntries(priorBinding, priorFamilies, "prior");
  const affected = new Set(receipt.affectedArtifactIds);
  const reusedFamilies: ReusedFamilyNominationQualificationV1[] = [];
  const requalificationDenominator: FamilyNominationRequalificationDenominatorV1[] = [];

  for (const current of [...currentFamilies.values()].sort((left, right) => left.familyId.localeCompare(right.familyId))) {
    const prior = priorFamilies.get(current.familyId);
    if (affected.has(current.artifactId) || prior === undefined || !sameCanonical(prior.proposalLeafDigests, current.proposalLeafDigests)) {
      requalificationDenominator.push(Object.freeze({
        familyId: current.familyId, artifactId: current.artifactId,
        nominationProposalLeafDigests: current.proposalLeafDigests, reason: "catalog-impact-affected" as const,
      }));
      continue;
    }
    reusedFamilies.push(Object.freeze({
      familyId: current.familyId, artifactId: current.artifactId,
      nominationProposalLeafDigests: current.proposalLeafDigests,
      nominationQualificationEntries: Object.freeze(current.proposalLeafDigests.map(proposal => priorEntries.get(proposal)!)),
    }));
  }

  const preSignBase = deepFreeze({
    schemaVersion: 1 as const, kind: "aloha.nomination-qualification-pre-sign-report" as const, advisoryOnly: true as const,
    priorDeploymentFactId: priorFact.deploymentFactId, priorRuntimeBindingId: priorBinding.bindingId,
    priorSnapshotRoot: currentState.priorSnapshot.snapshotRoot, currentSnapshotRoot: currentState.currentSnapshot.snapshotRoot,
    currentFamilyProposalOwnershipRoot: catalogImpactFamilyProposalOwnershipRootV1(currentState.currentSnapshot),
    currentSemanticLedgerHash: currentState.semanticLedgerHash, currentSemanticOutputRoot: currentState.semanticOutputRoot,
    currentBoundaryVerificationReceiptRoot: currentState.verificationReceiptRoot,
    reusedFamilies: Object.freeze(reusedFamilies), requalificationDenominator: Object.freeze(requalificationDenominator),
  });
  const preSignReport = deepFreeze({ ...preSignBase, reportRoot: hashDomain("aloha/nomination-qualification-pre-sign-report/v1", preSignBase) });

  return Object.freeze({
    analyzePreSign(): NominationQualificationPreSignReportV1 { return preSignReport; },
    verifyPostSign(value: VerifyNominationQualificationPostSignInputV1): NominationQualificationPostSignReportV1 {
      const currentBinding = verifyRuntimeReleaseBindingSignatureV1(value.currentRuntimeBinding, currentRuntimeSignerPin);
      const currentFact = verifyDeploymentFactSignature(value.currentDeploymentFact, currentDeploymentFactSignerPin);
      assertDeploymentFactJoinsBinding(currentFact, currentBinding);
      assertDeploymentFactJoinsCatalog(
        currentFact,
        currentState.currentSnapshot,
        currentState.semanticLedgerHash,
        currentState.semanticOutputRoot,
        currentState.verificationReceiptRoot,
        currentState.proposedCapabilitySetRoot,
      );
      const currentEntries = qualificationEntries(currentBinding, currentFamilies, "current");
      for (const reused of preSignReport.reusedFamilies) for (const expected of reused.nominationQualificationEntries) {
        const actual = currentEntries.get(expected.proposalLeafDigest);
        if (actual === undefined || !sameCanonical(actual, expected)) throw new TypeError("post-sign reused qualification entry changed");
      }
      const postBase = deepFreeze({
        schemaVersion: 1 as const, kind: "aloha.nomination-qualification-post-sign-report" as const, advisoryOnly: true as const,
        preSignReportRoot: preSignReport.reportRoot, currentDeploymentFactId: currentFact.deploymentFactId,
        currentRuntimeBindingId: currentBinding.bindingId, currentSnapshotRoot: currentState.currentSnapshot.snapshotRoot,
        verifiedQualificationEntryCount: currentEntries.size,
      });
      return deepFreeze({ ...postBase, reportRoot: hashDomain("aloha/nomination-qualification-post-sign-report/v1", postBase) });
    },
  });
}
