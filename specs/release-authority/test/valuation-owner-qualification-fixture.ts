import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  sealEconomicValuationOwnerQualificationCertificateSetV1,
  sealEconomicValuationOwnerQualificationCertificateV1,
} from "../../economic-valuation-owner/src/index.ts";

/** Wire-test material only. Production release tests that open the generated
 * registry must instead build certificates from its exact proposal entries. */
export function testEconomicValuationOwnerQualificationSetV1(scope: string) {
  const h = (field: string): Hash => hashDomain("test/economic-valuation-owner-qualification/v1", { scope, field });
  return sealEconomicValuationOwnerQualificationCertificateSetV1([
    sealEconomicValuationOwnerQualificationCertificateV1({
      schemaVersion: 1,
      kind: "aloha.economic-valuation-owner-qualification-certificate",
      ownerRef: h("owner"),
      proposedOwnerLeafDigest: h("proposal-leaf"),
      implementationHash: h("implementation"),
      factSchemaRef: h("fact-schema"),
      implementationClosureRoot: h("implementation-closure"),
      qualificationSpecDigest: h("qualification-spec"),
      qualificationSpecClosureRoot: h("qualification-spec-closure"),
      criticalMutationCorpusRoot: h("critical-mutation-corpus"),
      criticalMutationCorpusClosureRoot: h("critical-mutation-corpus-closure"),
      independentOracleCaseRoot: h("independent-oracle-cases"),
      independentOracleClosureRoot: h("independent-oracle-closure"),
      executedPositiveCaseRoot: h("executed-positive-cases"),
      executedNegativeCaseRoot: h("executed-negative-cases"),
      executedInvalidCaseRoot: h("executed-invalid-cases"),
      verifierImplementationDigest: h("acceptance-verifier-implementation"),
      qualificationAuthorityApprovalId: h("qualification-authority-approval"),
      qualificationAuthorityApprovalPayloadHash: h("qualification-authority-approval-payload"),
    }),
  ]);
}
