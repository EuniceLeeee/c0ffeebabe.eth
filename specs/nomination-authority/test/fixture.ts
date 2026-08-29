import { sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { candidatePartitionRoot, type CanonicalCutoffV1 } from "../../../packages/discovery/src/index.ts";
import {
  encodeNominationClosureV1,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
} from "../src/index.ts";

export function sealEmptyNominationClosureFixture(input: {
  readonly cutoff: CanonicalCutoffV1;
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanIdentity: Hash;
  readonly sourcePlanLeafDigest: Hash;
  readonly nominationProgramRoot: Hash;
  readonly nominationProgramProposalLeafDigest: Hash;
  readonly qualificationRoot: Hash;
  readonly recentObservationRoot: Hash;
  readonly sourceExecutionSetRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly persistedExecutionRoot: Hash;
  readonly resultPartitionRoot: Hash;
}) {
  const receipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff: input.cutoff,
    familyId: input.familyId,
    familyDefinitionHash: input.familyDefinitionHash,
    sourcePlanIdentity: input.sourcePlanIdentity,
    sourcePlanLeafDigest: input.sourcePlanLeafDigest,
    nominationProgramRoot: input.nominationProgramRoot,
    nominationProgramProposalLeafDigest: input.nominationProgramProposalLeafDigest,
    qualificationRoot: input.qualificationRoot,
    denominator: {
      kind: "complete-source-result",
      persistedExecutionRoot: input.persistedExecutionRoot,
      resultPartitionRoot: input.resultPartitionRoot,
    },
    claims: [],
  });
  const closure = sealNominationClosureV1({
    cutoff: input.cutoff,
    recentObservationRoot: input.recentObservationRoot,
    sourceExecutionSetRoot: input.sourceExecutionSetRoot,
    sourceCoverageRoot: input.sourceCoverageRoot,
    sourcePlanIdentities: [input.sourcePlanIdentity],
    receipts: [receipt],
    candidates: [],
    candidatePartitionRoot: candidatePartitionRoot([]),
  });
  return Object.freeze({
    closure,
    storageHash: sha256Hex(encodeNominationClosureV1(closure)),
  });
}
