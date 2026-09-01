import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { nativeAssetReferenceV1 } from "../../asset-ref/src/index.ts";
import type {
  EconomicSafetyEvidenceAuthorityExpectationV1,
  EconomicSafetyFinalizationInputV1,
} from "../../economics-safety/src/index.ts";
import { issueEconomicSafetyFinalizationServiceV1 } from "../../economics-safety/src/internal/owner.ts";
import { ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1 } from "../../../specs/economic-safety-profile/src/index.ts";
import {
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeReleaseProvenanceHashV1,
} from "../../runtime-authority/src/index.ts";

export function createContractEconomicSafetyService(
  releaseProvenanceHash: RuntimeReleaseProvenanceHashV1,
  hash: (value: string) => Hash,
  authority?: EconomicSafetyEvidenceAuthorityExpectationV1,
) {
  if (authority !== undefined && authority.releaseProvenanceHash !== releaseProvenanceHash) {
    throw new TypeError("test economic-safety authority release mismatch");
  }
  return issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: authority?.authorityRoot ?? hash("economic-safety-authority"),
    implementationHash: authority?.implementationHash ?? hash("economic-safety-implementation"),
    runtimeAuthority: authority?.runtimeAuthority ?? projectRuntimeAuthorityDescriptorV1(
      createUnsignedDryRunRuntimeAuthorityDescriptorV1({
        authorityClass: "dry-run",
        runtimeBindingId: hashDomain("aloha/search-pipeline/test-economic-safety-runtime-binding/v1", {
          mode: "dry-run",
        }),
        implementationCommit: "a".repeat(40),
      }),
    ),
    releaseProvenanceHash,
    evaluator: Object.freeze({
      async evaluate(input: EconomicSafetyFinalizationInputV1) {
        const profitAsset = nativeAssetReferenceV1(input.source.chainId);
        const selectedRequiredClaims = Object.freeze(input.declaredObligations.map(declaration => Object.freeze({
          claimSchemaRef: hash("obligation-schema"),
          ownerRef: declaration.ownerRef,
          qualificationLeafDigest: hash(`obligation-qualification:${declaration.ownerRef}`),
          revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
        })).sort((left, right) => `${left.ownerRef}\u0000${left.claimSchemaRef}`.localeCompare(`${right.ownerRef}\u0000${right.claimSchemaRef}`)));
        const valuationFactBody = Object.freeze({
          kind: "aloha.economic-valuation-fact-v1" as const,
          ownerRef: hash("valuation-owner"),
          generationId: input.generationId,
          source: input.source,
          assetRef: profitAsset.assetRef,
          numerator: "1" as const,
          denominator: "1" as const,
          ownerImplementationHash: hash("valuation-owner-implementation"),
          valuationOwnerRegistryRoot: hash("valuation-owner-registry"),
          qualifiedValuationOwnerSetRoot: hash("qualified-valuation-owner-set"),
          qualificationLeafDigest: hash("valuation-owner-leaf"),
          currentSourceObservationRoot: hash("valuation-current-source-observation"),
        });
        const valuationFact = Object.freeze({
          ...valuationFactBody,
          factRoot: hashDomain("aloha/economic-valuation-fact/v1", valuationFactBody),
        });
        return Object.freeze({
          economic: Object.freeze({
            kind: "aloha.economic-receipt-v1" as const,
            gasUsed: "100",
            nextBlockBaseFeePerGas: "10",
            priorityFeePerGas: "2",
            effectiveGasPrice: "12",
            gasCostNative: "1200",
            profitAsset,
            grossProfitAmount: "5000",
            valuationNumerator: "1",
            valuationDenominator: "1",
            valuationFactRoot: valuationFact.factRoot,
            valuationFact,
            grossProfitNative: "5000",
            bidCostNative: "300",
            netProfitNative: "3500",
            minNetProfitNative: "1000",
            verdict: "positive-net-ev" as const,
          }),
          safety: Object.freeze({
            kind: "aloha.final-safety-receipt-v1" as const,
            obligationRoot: input.obligationRoot,
            obligationReceipts: Object.freeze(input.declaredObligations.map(declaration => Object.freeze({
              schemaRef: hash("obligation-schema"),
              ownerRef: declaration.ownerRef,
              qualificationLeafDigest: hash(`obligation-qualification:${declaration.ownerRef}`),
              verifierHash: hash("obligation-verifier"),
              subjectRoot: declaration.obligationRef,
              proofRoot: hashDomain("aloha/search-pipeline/test-obligation-proof/v1", declaration),
              outcome: "satisfied" as const,
            }))),
            safetyProfileRef: hash("safety-profile"),
            safetyProfileRoot: hash("safety-profile-root"),
            selectedRequiredClaims,
            requiredClaimSetRoot: hashDomain("aloha/economic-safety-selected-required-claim-set/v1", selectedRequiredClaims),
            revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
            revmObservationRoot: hash("revm-observation"),
            assetConservationProofRoot: hash("asset-conservation"),
            assetConservation: "satisfied" as const,
            verdict: "safe" as const,
          }),
        });
      },
    }),
  });
}
