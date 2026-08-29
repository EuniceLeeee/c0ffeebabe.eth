import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { readGeneratedEconomicValuationOwnerProposalRegistryV1 } from "../../../generated/valuation-owner-registry/index.ts";
import {
  sealEconomicValuationOwnerQualificationCertificateSetV1,
  sealEconomicValuationOwnerQualificationCertificateV1,
} from "../../economic-valuation-owner/src/index.ts";

/** Runtime-composition test material derived from the real generated proposal
 * registry. It never supplies or replaces catalog compiler facts. */
export function generatedEconomicValuationOwnerQualificationSetFixtureV1(scope: string) {
  const registry = readGeneratedEconomicValuationOwnerProposalRegistryV1();
  const certificates = registry.entries.map(proposal => {
    const h = (field: string) => hashDomain("test/generated-economic-valuation-owner-qualification/v1", {
      scope,
      ownerRef: proposal.ownerRef,
      field,
    });
    return sealEconomicValuationOwnerQualificationCertificateV1({
      schemaVersion: 1,
      kind: "aloha.economic-valuation-owner-qualification-certificate",
      ownerRef: proposal.ownerRef,
      proposedOwnerLeafDigest: proposal.qualificationLeafDigest,
      implementationHash: proposal.implementationHash,
      factSchemaRef: proposal.factSchemaRef,
      implementationClosureRoot: proposal.implementationClosureRoot,
      qualificationSpecDigest: proposal.qualificationSpecDigest,
      qualificationSpecClosureRoot: proposal.qualificationSpecClosureRoot,
      criticalMutationCorpusRoot: proposal.criticalMutationCorpusRoot,
      criticalMutationCorpusClosureRoot: proposal.criticalMutationCorpusClosureRoot,
      independentOracleCaseRoot: proposal.independentOracleCaseRoot,
      independentOracleClosureRoot: proposal.independentOracleClosureRoot,
      executedPositiveCaseRoot: h("executed-positive-cases"),
      executedNegativeCaseRoot: h("executed-negative-cases"),
      executedInvalidCaseRoot: h("executed-invalid-cases"),
      verifierImplementationDigest: h("acceptance-verifier-implementation"),
      qualificationAuthorityApprovalId: h("qualification-authority-approval"),
      qualificationAuthorityApprovalPayloadHash: h("qualification-authority-approval-payload"),
    });
  });
  const set = sealEconomicValuationOwnerQualificationCertificateSetV1(certificates);
  return Object.freeze({ registry, certificates: set.certificates, root: set.root });
}
