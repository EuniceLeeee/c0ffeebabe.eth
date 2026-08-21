import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  candidatePartitionRoot,
  familyCandidateKey,
  mergeAndDedupeNominations,
  recentObservationRange,
  sealSourceCoverage,
  validateSourceCoverageCertificate,
  type CandidateNominationV1,
  type CanonicalCutoffV1,
  type SourcePlanExecutionV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/discovery", value);
const cutoff: CanonicalCutoffV1 = {
  chainId: "1",
  number: "100",
  hash: h("block"),
  stateRoot: h("state"),
};

const nomination = (tx: string, logIndex: string): CandidateNominationV1 => ({
  familyId: "family-a",
  familyDefinitionHash: h("definition"),
  instanceNominationKey: "target:0xabc",
  candidateSnapshotHash: h("snapshot"),
  evidence: {
    blockNumber: "100",
    blockHash: cutoff.hash,
    txHash: h(tx),
    logIndex,
    address: "0xabc",
    topic: h("topic"),
    rawLocatorHash: h(`${tx}:${logIndex}`),
  },
});

test("recent observation is exactly 50 blocks and clamps only at genesis", () => {
  assert.deepEqual(recentObservationRange("100"), { from: "51", to: "100" });
  assert.deepEqual(recentObservationRange("12"), { from: "0", to: "12" });
});

test("candidate dedupe preserves every distinct evidence identity", () => {
  const records = mergeAndDedupeNominations([
    nomination("tx-a", "1"),
    nomination("tx-b", "2"),
    nomination("tx-a", "1"),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.evidence.length, 2);
  assert.equal(
    records[0]?.familyCandidateKey,
    familyCandidateKey(h("definition"), "target:0xabc"),
  );
  assert.equal(candidatePartitionRoot(records), candidatePartitionRoot([...records]));
});

test("same opaque candidate key with different payload fails closed", () => {
  assert.throws(
    () => mergeAndDedupeNominations([
      nomination("tx-a", "1"),
      { ...nomination("tx-b", "2"), candidateSnapshotHash: h("changed") },
    ]),
    /candidate-key-collision/,
  );
});

test("a new plugin field cannot be silently dropped by candidate freeze", () => {
  const mutated = { ...nomination("tx-a", "1"), observeAccounts: ["0xabc"] };
  assert.throws(
    () => mergeAndDedupeNominations([mutated as unknown as CandidateNominationV1]),
    /unknown or missing fields/,
  );
});

const execution = (
  completeness: SourcePlanExecutionV1["plan"]["completeness"],
  from: string,
  through: string,
  previousAppliedThrough: string | null,
): SourcePlanExecutionV1 => ({
  plan: {
    ownerRef: h(`owner:${completeness}`),
    sourcePlanRef: h(`plan:${completeness}`),
    familyDefinitionHash: h("definition"),
    completeness,
  },
  cutoff,
  outcome: completeness === "nomination-only" ? "positive-only" : "complete",
  from,
  through,
  previousAppliedThrough,
  resultPartitionRoot: h(`partition:${completeness}`),
});

test("only complete snapshot/history advance omission authority", () => {
  const certificate = sealSourceCoverage(cutoff, [
    execution("complete-snapshot", "100", "100", null).plan,
    execution("contiguous-history", "91", "100", "90").plan,
    execution("point-lookup", "100", "100", null).plan,
    execution("nomination-only", "51", "100", null).plan,
  ], [
    execution("complete-snapshot", "100", "100", null),
    execution("contiguous-history", "91", "100", "90"),
    execution("point-lookup", "100", "100", null),
    execution("nomination-only", "51", "100", null),
  ]);
  assert.deepEqual(Object.fromEntries(
    certificate.entries.map(entry => [entry.completeness, entry.contributesOmissionAuthority]),
  ), {
    "complete-snapshot": true,
    "contiguous-history": true,
    "point-lookup": false,
    "nomination-only": false,
  });
});

test("cursor gaps and transport failures never advance coverage", () => {
  assert.throws(
    () => sealSourceCoverage(cutoff, [execution("contiguous-history", "92", "100", "90").plan], [execution("contiguous-history", "92", "100", "90")]),
    /history-cursor-gap/,
  );
  assert.throws(
    () => sealSourceCoverage(cutoff, [execution("complete-snapshot", "100", "100", null).plan], [{
      ...execution("complete-snapshot", "100", "100", null),
      outcome: "retryable",
    }]),
    /source-retryable/,
  );
});

test("omitting a declared SourcePlan is never accepted as complete coverage", () => {
  const first = execution("complete-snapshot", "100", "100", null);
  const second = execution("point-lookup", "100", "100", null);
  assert.throws(
    () => sealSourceCoverage(cutoff, [first.plan, second.plan], [first]),
    /missing-source-partition/,
  );
});

test("persisted candidate keys and evidence order are revalidated on resume", () => {
  const record = mergeAndDedupeNominations([nomination("tx-a", "1"), nomination("tx-b", "2")])[0]!;
  assert.throws(
    () => candidatePartitionRoot([{ ...record, familyCandidateKey: h("forged") }]),
    /lineage-mismatch/,
  );
  assert.throws(
    () => candidatePartitionRoot([{ ...record, evidence: [...record.evidence].reverse() }]),
    /canonical-order/,
  );
});

test("persisted coverage root and declared-plan partition are revalidated at promotion", () => {
  const value = execution("complete-snapshot", "100", "100", null);
  const certificate = sealSourceCoverage(cutoff, [value.plan], [value]);
  validateSourceCoverageCertificate(certificate, [value.plan]);
  assert.throws(
    () => validateSourceCoverageCertificate({ ...certificate, sourceCoverageRoot: h("forged") }, [value.plan]),
    /root-mismatch/,
  );
});
