import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, sha256Hex, type Hash } from "../../canonical-codec/src/index.ts";
import {
  candidatePartitionRoot,
  familyCandidateKey,
  mergeAndDedupeNominations,
  recentObservationRange,
  sealSourceCoverage,
  sourcePlanEvidenceRoot,
  sourcePlanDiscoveryRoot,
  sourcePlanExecutionRoot,
  decodeSourcePlanDiscoveryResult,
  validateSourceCoverageCertificate,
  type CandidateNominationV1,
  type CanonicalCutoffV1,
  type SourcePlanExecutionV1,
  type SourcePlanEvidenceReceiptV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/discovery", value);
const cutoff: CanonicalCutoffV1 = {
  chainId: "1",
  number: "100",
  hash: h("block"),
  stateRoot: h("state"),
};

const nomination = (tx: string, logIndex: string): CandidateNominationV1 => ({
  kind: "aloha.candidate-nomination",
  version: "2",
  familyId: "family-a",
  familyDefinitionHash: h("definition"),
  instanceNominationKey: "target:0xabc",
  evidence: {
    kind: "recent-log",
    version: 1,
    ownerRef: null,
    sourcePlanRef: null,
    blockNumber: "100",
    blockHash: cutoff.hash,
    txHash: h(tx),
    logIndex,
    address: "0xabc",
    topic: h("topic"),
    rawLocatorHash: h(`${tx}:${logIndex}`),
  },
});

test("recent observation is exactly 50 blocks and rejects an unavailable early window", () => {
  assert.deepEqual(recentObservationRange("49"), { from: "0", to: "49" });
  assert.deepEqual(recentObservationRange("100"), { from: "51", to: "100" });
  assert.throws(() => recentObservationRange("48"), /recent-observation-window-unavailable/);
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
      { ...nomination("tx-b", "2"), familyId: "family-b" },
    ]),
    /candidate-key-collision/,
  );
});

test("v1 nomination and record wires are rejected", () => {
  const current = nomination("tx-a", "1");
  assert.throws(
    () => mergeAndDedupeNominations([{ ...current, version: "1" } as unknown as CandidateNominationV1]),
    /version/,
  );
  const record = mergeAndDedupeNominations([current])[0]!;
  assert.throws(
    () => candidatePartitionRoot([{ ...record, version: "1" } as unknown as typeof record]),
    /version/,
  );
});

test("a new plugin field cannot be silently dropped by candidate freeze", () => {
  const mutated = { ...nomination("tx-a", "1"), observeAccounts: ["0xabc"] };
  assert.throws(
    () => mergeAndDedupeNominations([mutated as unknown as CandidateNominationV1]),
    /unknown field/,
  );
});

test("candidate and coverage decoders reject accessors, proxies, and malformed hashes", () => {
  const accessor = { ...nomination("tx-a", "1") } as Record<string, unknown>;
  let getterCalled = false;
  Object.defineProperty(accessor, "familyId", {
    enumerable: true,
    configurable: true,
    get: () => {
      getterCalled = true;
      throw new Error("accessor was invoked");
    },
  });
  assert.throws(() => mergeAndDedupeNominations([accessor as unknown as CandidateNominationV1]), /accessor/);
  assert.equal(getterCalled, false);
  assert.throws(
    () => mergeAndDedupeNominations([new Proxy(nomination("tx-a", "1"), { get: () => { throw new Error("proxy trap"); } })]),
    /Proxy/,
  );
  const malformed = execution("complete-snapshot", "100", "100", null);
  assert.throws(
    () => sealSourceCoverage(cutoff, [{ ...malformed.plan, ownerRef: "0x" }], [malformed]),
    /hash/,
  );
});

const execution = (
  completeness: SourcePlanExecutionV1["plan"]["completeness"],
  from: string,
  through: string,
  previousAppliedThrough: string | null,
  historyStartBlock: string | null = completeness === "contiguous-history" ? "0" : null,
): SourcePlanExecutionV1 => {
  const plan = {
    ownerRef: h(`owner:${completeness}`),
    sourcePlanRef: h(`plan:${completeness}`),
    familyDefinitionHash: h("definition"),
    completeness,
    historyStartBlock,
  } as const;
  const rawLocatorHash = sha256Hex(new TextEncoder().encode(`raw:${completeness}`));
  const sourceEvidenceRefs = [{
    kind: "source-plan" as const,
    version: 1 as const,
    ownerRef: plan.ownerRef,
    sourcePlanRef: plan.sourcePlanRef,
    evidenceRef: h(`evidence:${completeness}`),
    rawLocatorHash,
  }];
  const sourceEvidenceRoot = sourcePlanEvidenceRoot({
    plan,
    cutoff,
    refs: sourceEvidenceRefs,
    rawLocatorHashes: [rawLocatorHash],
  });
  const base = {
    kind: "source-plan-execution" as const,
    version: 1 as const,
    plan,
    cutoff,
    outcome: completeness === "nomination-only" ? "positive-only" as const : "complete" as const,
    from,
    through,
    previousAppliedThrough,
    resultPartitionRoot: h(`partition:${completeness}`),
    opaqueResult: { kind: "test-source-result", completeness },
    sourceEvidenceRefs,
    rawLocatorHashes: [rawLocatorHash],
    sourceEvidenceRoot,
  };
  return { ...base, executionRoot: sourcePlanExecutionRoot(base) };
};

const resealExecution = (
  value: SourcePlanExecutionV1,
  patch: Partial<Omit<SourcePlanExecutionV1, "executionRoot">>,
): SourcePlanExecutionV1 => {
  const next = { ...value, ...patch } as Omit<SourcePlanExecutionV1, "executionRoot">;
  return { ...next, executionRoot: sourcePlanExecutionRoot(next) };
};

const sourceEvidenceReceipt = (value: SourcePlanExecutionV1): SourcePlanEvidenceReceiptV1 => ({
  kind: "source-plan-evidence",
  version: 1,
  plan: value.plan,
  cutoff: value.cutoff,
  refs: value.sourceEvidenceRefs,
  rawLocatorHashes: value.rawLocatorHashes,
  evidenceRoot: value.sourceEvidenceRoot,
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

test("the first contiguous-history execution must begin at the declared history start", () => {
  const anchored = execution("contiguous-history", "0", "100", null, "0");
  const certificate = sealSourceCoverage(cutoff, [anchored.plan], [anchored]);
  assert.equal(certificate.entries[0]?.historyStartBlock, "0");
  assert.equal(certificate.entries[0]?.previousAppliedThrough, null);
  assert.equal(certificate.entries[0]?.contributesOmissionAuthority, true);
  assert.throws(
    () => sealSourceCoverage(
      cutoff,
      [execution("contiguous-history", "0", "100", null, "0").plan],
      [execution("contiguous-history", "1", "100", null, "0")],
    ),
    /history-start-gap/,
  );
});

test("an execution cannot rewrite its declared history authority", () => {
  const declared = execution("contiguous-history", "0", "100", null, "0");
  const rewritten = execution("contiguous-history", "1", "100", null, "1");
  assert.throws(
    () => sealSourceCoverage(cutoff, [declared.plan], [rewritten]),
    /undeclared-source-partition/,
  );
});

test("a later contiguous-history execution must bind the prior cursor", () => {
  const later = execution("contiguous-history", "91", "100", "90", "0");
  const certificate = sealSourceCoverage(cutoff, [later.plan], [later]);
  validateSourceCoverageCertificate(certificate, [later.plan]);
  assert.throws(
    () => sealSourceCoverage(
      cutoff,
      [execution("contiguous-history", "91", "100", "89", "0").plan],
      [execution("contiguous-history", "91", "100", "89", "0")],
    ),
    /history-cursor-gap/,
  );
  const forgedEntry = { ...certificate.entries[0]!, previousAppliedThrough: null };
  const forgedRoot = hashDomain("aloha/source-coverage/v1", {
    cutoff: certificate.cutoff,
    entries: [forgedEntry],
  });
  assert.throws(
    () => validateSourceCoverageCertificate(
      { ...certificate, entries: [forgedEntry], sourceCoverageRoot: forgedRoot },
      [later.plan],
    ),
    /history-start-gap/,
  );
});

test("cursor gaps and transport failures never advance coverage", () => {
  assert.throws(
    () => sealSourceCoverage(cutoff, [execution("contiguous-history", "92", "100", "90").plan], [execution("contiguous-history", "92", "100", "90")]),
    /history-cursor-gap/,
  );
  assert.throws(
    () => sealSourceCoverage(cutoff, [execution("complete-snapshot", "100", "100", null).plan], [resealExecution(
      execution("complete-snapshot", "100", "100", null),
      { outcome: "retryable" },
    )]),
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

test("persisted coverage entries have one canonical order", () => {
  const snapshot = execution("complete-snapshot", "100", "100", null);
  const point = execution("point-lookup", "100", "100", null);
  const certificate = sealSourceCoverage(cutoff, [snapshot.plan, point.plan], [snapshot, point]);
  assert.throws(
    () => validateSourceCoverageCertificate(
      { ...certificate, entries: [...certificate.entries].reverse() },
      [snapshot.plan, point.plan],
    ),
    /coverage-entry-order-mismatch/,
  );
});

test("source coverage rejects non-array entries, bad ranges, and forged completeness semantics", () => {
  const value = execution("complete-snapshot", "100", "100", null);
  const certificate = sealSourceCoverage(cutoff, [value.plan], [value]);
  assert.throws(
    () => validateSourceCoverageCertificate({ ...certificate, entries: { 0: certificate.entries[0] } } as unknown as typeof certificate, [value.plan]),
    /array/,
  );
  const forgedEntry = {
    ...certificate.entries[0]!,
    from: "0",
  };
  const forgedRoot = hashDomain("aloha/source-coverage/v1", {
    cutoff: certificate.cutoff,
    entries: [forgedEntry],
  });
  assert.throws(
    () => validateSourceCoverageCertificate(
      { ...certificate, entries: [forgedEntry], sourceCoverageRoot: forgedRoot },
      [value.plan],
    ),
    /lineage-mismatch/,
  );
  const outside = execution("point-lookup", "101", "102", null);
  assert.throws(
    () => sealSourceCoverage(cutoff, [outside.plan], [outside]),
    /source-range-outside-cutoff/,
  );
  const multiBlockPoint = execution("point-lookup", "99", "100", null);
  assert.throws(
    () => sealSourceCoverage(cutoff, [multiBlockPoint.plan], [multiBlockPoint]),
    /point-lookup-incomplete/,
  );
});

test("source-plan evidence and opaque result are bound into execution and discovery roots", () => {
  const value = execution("complete-snapshot", "100", "100", null);
  const receipt = sourceEvidenceReceipt(value);
  const rawBytes = new TextEncoder().encode("raw:complete-snapshot");
  const raw = {
    kind: "raw-evidence-locator" as const,
    version: 1 as const,
    rawLocatorHash: value.rawLocatorHashes[0]!,
    bytes: rawBytes,
  };
  const discoveryRoot = sourcePlanDiscoveryRoot({ executions: [value], evidence: [receipt], rawEvidenceLocators: [raw] });
  const discovered = decodeSourcePlanDiscoveryResult({
    kind: "source-plan-discovery",
    version: 1,
    executions: [value],
    evidence: [receipt],
    rawEvidenceLocators: [raw],
    discoveryRoot,
  });
  assert.equal(discovered.discoveryRoot, discoveryRoot);
  assert.throws(
    () => sourcePlanEvidenceRoot({
      plan: value.plan,
      cutoff: value.cutoff,
      refs: value.sourceEvidenceRefs,
      rawLocatorHashes: [value.rawLocatorHashes[0]!, value.rawLocatorHashes[0]!],
    }),
    /locators contain duplicates/,
  );
  assert.throws(
    () => decodeSourcePlanDiscoveryResult({
      ...discovered,
      executions: [{ ...value, opaqueResult: { kind: "tampered" } }],
      discoveryRoot,
    }),
    /executionRoot mismatch/,
  );
  assert.throws(
    () => decodeSourcePlanDiscoveryResult({
      ...discovered,
      evidence: [{ ...receipt, refs: [] }],
      discoveryRoot,
    }),
    /evidenceRoot mismatch|evidence\/execution mismatch/,
  );
  assert.throws(
    () => decodeSourcePlanDiscoveryResult({
      ...discovered,
      rawEvidenceLocators: [],
      discoveryRoot,
    }),
    /does not exactly match|discoveryRoot mismatch/,
  );
  assert.throws(
    () => decodeSourcePlanDiscoveryResult({
      ...discovered,
      rawEvidenceLocators: [{ ...raw, bytes: new TextEncoder().encode("changed") }],
      discoveryRoot,
    }),
    /hash mismatch/,
  );
});

test("recomputed roots cannot move an execution across its declared plan or cutoff", () => {
  const original = execution("complete-snapshot", "100", "100", null);
  const alteredPlan = { ...original.plan, sourcePlanRef: h("other-plan") };
  const alteredRefs = original.sourceEvidenceRefs.map(ref => ({ ...ref, sourcePlanRef: alteredPlan.sourcePlanRef }));
  const altered = resealExecution(original, {
    plan: alteredPlan,
    sourceEvidenceRefs: alteredRefs,
    sourceEvidenceRoot: sourcePlanEvidenceRoot({
      plan: alteredPlan,
      cutoff: original.cutoff,
      refs: alteredRefs,
      rawLocatorHashes: original.rawLocatorHashes,
    }),
  });
  assert.throws(
    () => sealSourceCoverage(cutoff, [original.plan], [altered]),
    /undeclared-source-partition/,
  );
  const alteredCutoff = { ...cutoff, hash: h("other-cutoff") };
  const cutoffAltered = resealExecution(original, {
    cutoff: alteredCutoff,
    sourceEvidenceRoot: sourcePlanEvidenceRoot({
      plan: original.plan,
      cutoff: alteredCutoff,
      refs: original.sourceEvidenceRefs,
      rawLocatorHashes: original.rawLocatorHashes,
    }),
  });
  assert.throws(
    () => sealSourceCoverage(cutoff, [original.plan], [cutoffAltered]),
    /coverage-cutoff-mismatch/,
  );
});

test("candidate dedupe keeps recent-log and source-plan evidence instead of collapsing by candidate key", () => {
  const source = execution("complete-snapshot", "100", "100", null);
  const records = mergeAndDedupeNominations([
    nomination("tx-a", "1"),
    {
      kind: "aloha.candidate-nomination",
      version: "2",
      familyId: "family-a",
      familyDefinitionHash: h("definition"),
      instanceNominationKey: "target:0xabc",
      evidence: source.sourceEvidenceRefs[0]!,
    },
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual(new Set(records[0]!.evidence.map(item => item.kind)), new Set(["recent-log", "source-plan"]));
});
