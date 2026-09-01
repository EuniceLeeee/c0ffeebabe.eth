import assert from "node:assert/strict";
import test from "node:test";
import { hashCanonicalPartition, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  candidateEvidenceRoot,
  candidatePartitionRoot,
  candidateSubjectHash,
  familyCandidateKey,
  type CandidateRecordV1,
} from "../../../packages/discovery/src/index.ts";
import {
  decodePersistedNominationClosureV1,
  decodeNominationClosureV1,
  encodePersistedNominationClosureV1,
  nominationClaimRoot,
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
} from "../src/index.ts";

const h = (label: string): Hash => hashDomain("test/nomination-authority/v1", label);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });

function candidate(label: string, sourcePlanRef: Hash): CandidateRecordV1 {
  const familyDefinitionHash = h("family-definition");
  const instanceNominationKey = `instance:${label}`;
  const familyKey = familyCandidateKey(familyDefinitionHash, instanceNominationKey);
  const evidence = Object.freeze([{
    kind: "source-plan" as const,
    version: 1 as const,
    ownerRef: h("owner"),
    sourcePlanRef,
    evidenceRef: h(`evidence:${label}`),
    rawLocatorHash: h(`raw:${label}`),
  }]);
  return Object.freeze({
    kind: "aloha.candidate-record" as const,
    version: "2" as const,
    familyId: "family.alpha",
    familyDefinitionHash,
    instanceNominationKey,
    familyCandidateKey: familyKey,
    candidateSubjectHash: candidateSubjectHash(familyDefinitionHash, instanceNominationKey),
    candidateEvidenceRoot: candidateEvidenceRoot(evidence),
    evidence,
  });
}

function build() {
  const sourcePlanIdentity = h("plan-identity");
  const sourcePlanRef = h("source-plan");
  const candidates = [candidate("A", sourcePlanRef), candidate("B", sourcePlanRef)];
  const claims = candidates.map(value => ({
    sourcePlanIdentity,
    familyCandidateKey: value.familyCandidateKey,
    instanceNominationKey: value.instanceNominationKey,
    evidenceRefHash: nominationEvidenceRefHash(value.evidence[0]!),
  }));
  const receipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: "family.alpha",
    familyDefinitionHash: h("family-definition"),
    sourcePlanIdentity,
    sourcePlanLeafDigest: h("plan-leaf"),
    nominationProgramRoot: h("nomination-program"),
    nominationProgramProposalLeafDigest: h("nomination-program-proposal"),
    qualificationRoot: h("qualification"),
    denominator: {
      kind: "complete-source-result",
      persistedExecutionRoot: h("persisted-execution"),
      resultPartitionRoot: h("result-partition"),
    },
    claims,
  });
  const root = candidatePartitionRoot(candidates);
  return { candidates, receipt, closure: sealNominationClosureV1({
    cutoff,
    recentObservationRoot: h("recent"),
    sourceExecutionSetRoot: h("execution-set"),
    sourceCoverageRoot: h("coverage"),
    sourcePlanIdentities: [sourcePlanIdentity],
    receipts: [receipt],
    candidates,
    candidatePartitionRoot: root,
  }) };
}

test("A+B receipt closes exactly over the durable candidate partition", () => {
  const { closure, candidates } = build();
  assert.equal(closure.candidateCount, "2");
  assert.deepEqual(closure.families[0]!.familyCandidateKeys, candidates.map(value => value.familyCandidateKey).sort());
  assert.deepEqual(decodeNominationClosureV1(structuredClone(closure)), closure);
});

test("global unique nominations collapse one candidate across plan receipts while preserving all evidence", () => {
  const familyDefinitionHash = h("family-definition");
  const instanceNominationKey = "instance:shared";
  const familyKey = familyCandidateKey(familyDefinitionHash, instanceNominationKey);
  const planA = h("plan:A");
  const planB = h("plan:B");
  const evidence = [planA, planB].map((sourcePlanRef, index) => ({
    kind: "source-plan" as const,
    version: 1 as const,
    ownerRef: h("owner"),
    sourcePlanRef,
    evidenceRef: h(`shared-evidence:${index}`),
    rawLocatorHash: h(`shared-raw:${index}`),
  }));
  const shared: CandidateRecordV1 = Object.freeze({
    kind: "aloha.candidate-record",
    version: "2",
    familyId: "family.alpha",
    familyDefinitionHash,
    instanceNominationKey,
    familyCandidateKey: familyKey,
    candidateSubjectHash: candidateSubjectHash(familyDefinitionHash, instanceNominationKey),
    candidateEvidenceRoot: candidateEvidenceRoot(evidence),
    evidence,
  });
  const identities = [h("plan-identity:A"), h("plan-identity:B")];
  const receipts = identities.map((sourcePlanIdentity, index) => sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: "family.alpha",
    familyDefinitionHash,
    sourcePlanIdentity,
    sourcePlanLeafDigest: h(`plan-leaf:${index}`),
    nominationProgramRoot: h(`nomination-program:${index}`),
    nominationProgramProposalLeafDigest: h(`nomination-program-proposal:${index}`),
    qualificationRoot: h(`qualification:${index}`),
    denominator: {
      kind: "complete-source-result",
      persistedExecutionRoot: h(`persisted-execution:${index}`),
      resultPartitionRoot: h(`result-partition:${index}`),
    },
    claims: [{
      sourcePlanIdentity,
      familyCandidateKey: familyKey,
      instanceNominationKey,
      evidenceRefHash: nominationEvidenceRefHash(evidence[index]!),
    }],
  }));
  const closure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot: h("recent"),
    sourceExecutionSetRoot: h("execution-set"),
    sourceCoverageRoot: h("coverage"),
    sourcePlanIdentities: identities,
    receipts,
    candidates: [shared],
    candidatePartitionRoot: candidatePartitionRoot([shared]),
  });
  assert.equal(closure.uniqueNominationCount, "1");
  assert.equal(closure.families[0]!.candidateCount, "1");
});

test("receipt set retains a zero-candidate Family and exactly equals the plan denominator", () => {
  const { receipt, candidates } = build();
  const emptyPlanIdentity = h("empty-plan-identity");
  const emptyReceipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: "family.zero",
    familyDefinitionHash: h("zero-definition"),
    sourcePlanIdentity: emptyPlanIdentity,
    sourcePlanLeafDigest: h("zero-plan-leaf"),
    nominationProgramRoot: h("zero-program"),
    nominationProgramProposalLeafDigest: h("zero-program-proposal"),
    qualificationRoot: h("zero-qualification"),
    denominator: {
      kind: "complete-source-result",
      persistedExecutionRoot: h("zero-execution"),
      resultPartitionRoot: h("zero-results"),
    },
    claims: [],
  });
  const identities = [receipt.sourcePlanIdentity, emptyPlanIdentity];
  const closure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot: h("recent"),
    sourceExecutionSetRoot: h("execution-set"),
    sourceCoverageRoot: h("coverage"),
    sourcePlanIdentities: identities,
    receipts: [receipt, emptyReceipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  });
  assert.equal(closure.families.find(value => value.familyId === "family.zero")?.candidateCount, "0");
  assert.throws(() => sealNominationClosureV1({
    cutoff,
    recentObservationRoot: h("recent"),
    sourceExecutionSetRoot: h("execution-set"),
    sourceCoverageRoot: h("coverage"),
    sourcePlanIdentities: [receipt.sourcePlanIdentity],
    receipts: [receipt, emptyReceipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  }), /exactly cover/);
  assert.throws(() => sealNominationClosureV1({
    cutoff,
    recentObservationRoot: h("recent"),
    sourceExecutionSetRoot: h("execution-set"),
    sourceCoverageRoot: h("coverage"),
    sourcePlanIdentities: [...identities, h("undeclared-plan")],
    receipts: [receipt, emptyReceipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  }), /exactly cover/);
});

test("missing candidate cannot be hidden by recomputing ordinary closure roots", () => {
  const { receipt, candidates } = build();
  assert.throws(() => sealNominationClosureV1({
    cutoff,
    recentObservationRoot: h("recent"),
    sourceExecutionSetRoot: h("execution-set"),
    sourceCoverageRoot: h("coverage"),
    sourcePlanIdentities: [receipt.sourcePlanIdentity],
    receipts: [receipt],
    candidates: candidates.slice(0, 1),
    candidatePartitionRoot: candidatePartitionRoot(candidates.slice(0, 1)),
  }), /claim candidate binding mismatch/);
});

test("duplicate raw claims and unrerooted claim mutations fail closed", () => {
  const { receipt, closure } = build();
  const duplicate = { ...receipt, claims: [receipt.claims[0], receipt.claims[0]] };
  assert.throws(() => decodeNominationClosureV1({ ...closure, receipts: [duplicate] }), /duplicates|mismatch|canonical order/);
  const second = receipt.claims[1]!;
  const forgedBase = {
    ...second,
    evidenceRefHash: receipt.claims[0]!.evidenceRefHash,
  };
  const forged = { ...forgedBase, claimRoot: nominationClaimRoot(forgedBase) };
  assert.throws(() => decodeNominationClosureV1({
    ...closure,
    receipts: [{ ...receipt, claims: [receipt.claims[0], forged].sort((a, b) => a.claimRoot.localeCompare(b.claimRoot)) }],
  }), /mismatch|two candidate keys/);
});

test("one exact source chunk may nominate multiple candidates", () => {
  const sourcePlanIdentity = h("shared-chunk-plan");
  const sourcePlanRef = h("shared-chunk-source");
  const first = candidate("shared:A", sourcePlanRef);
  const sharedEvidence = first.evidence[0]!;
  const secondBase = candidate("shared:B", sourcePlanRef);
  const second: CandidateRecordV1 = Object.freeze({
    ...secondBase,
    evidence: Object.freeze([sharedEvidence]),
    candidateEvidenceRoot: candidateEvidenceRoot([sharedEvidence]),
  });
  const candidates = [first, second];
  const receipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: "family.alpha",
    familyDefinitionHash: h("family-definition"),
    sourcePlanIdentity,
    sourcePlanLeafDigest: h("shared-chunk-leaf"),
    nominationProgramRoot: h("shared-chunk-program"),
    nominationProgramProposalLeafDigest: h("shared-chunk-proposal"),
    qualificationRoot: h("shared-chunk-qualification"),
    denominator: {
      kind: "rolling-observation",
      persistedExecutionRoot: h("shared-chunk-execution"),
      resultPartitionRoot: h("shared-chunk-results"),
    },
    claims: candidates.map(value => ({
      sourcePlanIdentity,
      familyCandidateKey: value.familyCandidateKey,
      instanceNominationKey: value.instanceNominationKey,
      evidenceRefHash: nominationEvidenceRefHash(sharedEvidence),
    })),
  });
  const closure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot: h("shared-chunk-recent"),
    sourceExecutionSetRoot: h("shared-chunk-execution-set"),
    sourceCoverageRoot: h("shared-chunk-coverage"),
    sourcePlanIdentities: [sourcePlanIdentity],
    receipts: [receipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  });
  assert.equal(closure.candidateCount, "2");
  assert.equal(closure.rawClaimCount, "2");
});

test("accessors and proxies are rejected by exact codecs", () => {
  const { closure } = build();
  const accessor = { ...closure } as Record<string, unknown>;
  Object.defineProperty(accessor, "root", { enumerable: true, get: () => closure.root });
  assert.throws(() => decodeNominationClosureV1(accessor), /accessor|data property/);
  assert.throws(() => decodeNominationClosureV1(new Proxy(closure, {})), /Proxy|proxy/);
});

test("nomination-only recent receipts never grant omission authority", async () => {
  const { nominationPlanGrantsOmissionAuthority } = await import("../src/index.ts");
  const sourcePlanIdentity = h("recent-plan");
  const evidence = h("recent-evidence");
  const receipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: "family.recent",
    familyDefinitionHash: h("recent-definition"),
    sourcePlanIdentity,
    sourcePlanLeafDigest: h("recent-leaf"),
    nominationProgramRoot: h("recent-program"),
    nominationProgramProposalLeafDigest: h("recent-program-proposal"),
    qualificationRoot: h("recent-qualification"),
    denominator: {
      kind: "recent-observation",
      recentObservationRoot: h("recent-root"),
      relevantEvidenceRefHashes: [evidence],
      relevantEvidenceRoot: hashCanonicalPartition("aloha/relevant-nomination-evidence/v1", [evidence]),
      relevantEvidenceCount: "1",
    },
    claims: [],
  });
  assert.equal(nominationPlanGrantsOmissionAuthority(receipt), false);
});

test("3k nomination facts use bounded linked chunks without truncating the materialized closure", () => {
  const sourcePlanIdentity = h("large-plan-identity");
  const sourcePlanRef = h("large-source-plan");
  const candidates = Array.from({ length: 3_000 }, (_, index) => candidate(`large:${index}`, sourcePlanRef));
  const receipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: "family.alpha",
    familyDefinitionHash: h("family-definition"),
    sourcePlanIdentity,
    sourcePlanLeafDigest: h("large-plan-leaf"),
    nominationProgramRoot: h("large-nomination-program"),
    nominationProgramProposalLeafDigest: h("large-nomination-program-proposal"),
    qualificationRoot: h("large-qualification"),
    denominator: {
      kind: "complete-source-result",
      persistedExecutionRoot: h("large-persisted-execution"),
      resultPartitionRoot: h("large-result-partition"),
    },
    claims: candidates.map(value => ({
      sourcePlanIdentity,
      familyCandidateKey: value.familyCandidateKey,
      instanceNominationKey: value.instanceNominationKey,
      evidenceRefHash: nominationEvidenceRefHash(value.evidence[0]!),
    })),
  });
  const closure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot: h("large-recent"),
    sourceExecutionSetRoot: h("large-execution-set"),
    sourceCoverageRoot: h("large-coverage"),
    sourcePlanIdentities: [sourcePlanIdentity],
    receipts: [receipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  });
  const encoded = encodePersistedNominationClosureV1(closure);
  const chunks = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  const reopened = decodePersistedNominationClosureV1(encoded.manifestBytes, ref => {
    const bytes = chunks.get(ref.contentSha256);
    if (!bytes) throw new Error("missing test claim chunk");
    return bytes;
  });
  assert.equal(encoded.manifestBytes.byteLength < 500_000, true);
  assert.equal(encoded.chunks.length > 1, true);
  assert.equal(reopened.rawClaimCount, "3000");
  assert.equal(reopened.candidateCount, "3000");
  assert.equal(reopened.root, closure.root);
});

test("3k recent evidence denominator hashes are chunked out of the closure manifest", () => {
  const sourcePlanIdentity = h("large-recent-plan");
  const relevantEvidenceRefHashes = Array.from(
    { length: 3_000 },
    (_, index) => h(`large-recent-evidence:${index}`),
  ).sort();
  const receipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: "family.recent",
    familyDefinitionHash: h("large-recent-family"),
    sourcePlanIdentity,
    sourcePlanLeafDigest: h("large-recent-leaf"),
    nominationProgramRoot: h("large-recent-program"),
    nominationProgramProposalLeafDigest: h("large-recent-proposal"),
    qualificationRoot: h("large-recent-qualification"),
    denominator: {
      kind: "recent-observation",
      recentObservationRoot: h("large-recent-observation"),
      relevantEvidenceRefHashes,
      relevantEvidenceRoot: hashCanonicalPartition(
        "aloha/relevant-nomination-evidence/v1",
        relevantEvidenceRefHashes,
      ),
      relevantEvidenceCount: String(relevantEvidenceRefHashes.length),
    },
    claims: [],
  });
  const closure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot: receipt.denominator.kind === "recent-observation"
      ? receipt.denominator.recentObservationRoot
      : h("unreachable"),
    sourceExecutionSetRoot: h("large-recent-execution-set"),
    sourceCoverageRoot: h("large-recent-coverage"),
    sourcePlanIdentities: [sourcePlanIdentity],
    receipts: [receipt],
    candidates: [],
    candidatePartitionRoot: candidatePartitionRoot([]),
  });
  const encoded = encodePersistedNominationClosureV1(closure);
  const chunks = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  const reopened = decodePersistedNominationClosureV1(encoded.manifestBytes, ref => chunks.get(ref.contentSha256)!);
  assert.equal(encoded.manifestBytes.byteLength < 500_000, true);
  assert.equal(encoded.chunks.length > 1, true);
  assert.equal(reopened.receipts[0]!.denominator.kind, "recent-observation");
  assert.equal((reopened.receipts[0]!.denominator as { readonly relevantEvidenceRefHashes: readonly Hash[] }).relevantEvidenceRefHashes.length, 3_000);
});
