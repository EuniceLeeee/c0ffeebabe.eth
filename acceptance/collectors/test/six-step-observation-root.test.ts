import assert from "node:assert/strict";
import test from "node:test";
import {
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  productionSixStepNonObservedRootV1,
  productionSixStepObservedRootV1,
  type ProductionSixStepNonObservedPayloadV1,
} from "../src/internal/six-step-observation-root.ts";

const h = (value: string): Hash => hashDomain("test/six-step-observation-root/v1", value);

function payload(stageArtifactSetRoot = h("stage-set"), contentSha256 = h("content")) {
  return Object.freeze({
    kind: "aloha.production-six-step-observation-v1" as const,
    status: "observed" as const,
    runtimeBindingId: h("runtime"),
    stageArtifacts: Object.freeze([Object.freeze({
      artifactSetRoot: stageArtifactSetRoot,
      eventArtifact: Object.freeze({ bytes: Uint8Array.of(1, 2, 3) }),
    })]),
    observedArtifacts: Object.freeze([Object.freeze({
      role: "runtime-release-terminal-binding",
      artifact: Object.freeze({
        ref: Object.freeze({ artifactRefId: h("artifact-ref") }),
        contentSha256,
        claim: Object.freeze({ claimId: h("claim") }),
        lease: Object.freeze({ receiptId: h("lease") }),
      }),
    })]),
  });
}

test("observed Six-Step root binds content-addressed identities without canonicalizing raw bytes", () => {
  const base = productionSixStepObservedRootV1(payload());
  assert.match(base, /^0x[0-9a-f]{64}$/);
  assert.notEqual(productionSixStepObservedRootV1(payload(h("changed-stage-set"))), base);
  assert.notEqual(productionSixStepObservedRootV1(payload(h("stage-set"), h("changed-content"))), base);
  assert.throws(
    () => productionSixStepObservedRootV1(payload("not-a-hash" as Hash)),
    /artifactSetRoot/,
  );
});

function nonObservedPayload(status: "missing" | "invalid"): ProductionSixStepNonObservedPayloadV1 {
  return Object.freeze({
    kind: status === "missing"
      ? "aloha.production-six-step-observation-missing-v1" as const
      : "aloha.production-six-step-observation-invalid-v1" as const,
    status,
    reason: status === "missing" ? "terminal-binding-missing" : "terminal-capability-invalid",
    finalDurableWindowId: h("final-window"),
    windowSelectionRoot: h("selection"),
    selectionPolicyDigest: h("selection-policy"),
    eligibleSuccessCount: "1",
    eligibleSuccessRoot: h("eligible-success"),
    selectedIndex: "0",
    selectedProducerTerminalId: h("producer-terminal"),
    observedArtifacts: Object.freeze([] as const),
  });
}

test("non-observed Six-Step root exactly binds missing and invalid payloads", () => {
  for (const status of ["missing", "invalid"] as const) {
    const value = nonObservedPayload(status);
    assert.equal(
      productionSixStepNonObservedRootV1(value),
      hashDomain("aloha/production-six-step-observation/v1", value as unknown as CanonicalJson),
    );
  }
  assert.notEqual(
    productionSixStepNonObservedRootV1(nonObservedPayload("missing")),
    productionSixStepNonObservedRootV1(nonObservedPayload("invalid")),
  );
});

test("non-observed Six-Step root changes for every reason and selection mutation", () => {
  const base = nonObservedPayload("missing");
  const root = productionSixStepNonObservedRootV1(base);
  const mutations: readonly ProductionSixStepNonObservedPayloadV1[] = [
    { ...base, reason: "joined-process-evidence-missing" },
    { ...base, finalDurableWindowId: h("changed-final-window") },
    { ...base, windowSelectionRoot: h("changed-selection") },
    { ...base, selectionPolicyDigest: h("changed-policy") },
    { ...base, eligibleSuccessCount: "2" },
    { ...base, eligibleSuccessRoot: h("changed-success") },
    { ...base, selectedIndex: null },
    { ...base, selectedProducerTerminalId: h("changed-terminal") },
  ];
  for (const mutation of mutations) assert.notEqual(productionSixStepNonObservedRootV1(mutation), root);
});

test("non-observed Six-Step root rejects invalid fields and observationRoot smuggling", () => {
  const base = nonObservedPayload("invalid");
  assert.throws(() => productionSixStepNonObservedRootV1({ ...base, selectedIndex: "1" as "0" }));
  assert.throws(() => productionSixStepNonObservedRootV1({ ...base, windowSelectionRoot: "not-a-hash" as Hash }));
  assert.throws(() => productionSixStepNonObservedRootV1({ ...base, reason: "terminal-binding-missing" }));
  assert.throws(() => productionSixStepNonObservedRootV1({
    ...base,
    observationRoot: h("caller-root"),
  } as ProductionSixStepNonObservedPayloadV1));
});

test("observed Six-Step root exactly matches the terminal-phase recomputation payload", () => {
  const observedPayload = Object.freeze({
    kind: "aloha.production-six-step-observation-v1" as const,
    status: "observed" as const,
    runtimeBindingId: h("runtime"),
    candidateReleaseCommit: h("candidate-release"),
    releaseProvenanceHash: h("release-provenance"),
    finalDurableWindowId: h("final-durable-window"),
    windowSelectionRoot: h("window-selection"),
    selectionPolicyDigest: h("selection-policy"),
    eligibleSuccessCount: "1",
    eligibleSuccessRoot: h("eligible-success"),
    selectedIndex: "0" as const,
    selectedProducerTerminalId: h("producer-terminal"),
    terminalBindingRoot: h("terminal-binding"),
    joinedProcessEvidenceRoot: h("process-evidence"),
    durableAppendRecordId: h("durable-append"),
    producerTerminalDurableAppendRecordId: h("producer-terminal-durable-append"),
    traceRoot: h("trace"),
    stage12Root: h("stage-12"),
    sixStepLineageRoot: h("six-step-lineage"),
    runtimeAnchorRoot: h("runtime-anchor"),
    runtimeFactsRoot: h("runtime-facts"),
    programHash: h("program"),
    finalSimulationReceiptHash: h("final-simulation-receipt"),
    observedArtifacts: Object.freeze([
      Object.freeze({
        role: "runtime-release-terminal-binding" as const,
        artifact: Object.freeze({
          ref: Object.freeze({ artifactRefId: h("terminal-artifact-ref") }),
          contentSha256: h("terminal-content"),
          claim: Object.freeze({ claimId: h("terminal-claim") }),
          lease: Object.freeze({ receiptId: h("terminal-lease") }),
        }),
      }),
      Object.freeze({
        role: "joined-process-evidence" as const,
        artifact: Object.freeze({
          ref: Object.freeze({ artifactRefId: h("process-artifact-ref") }),
          contentSha256: h("process-content"),
          claim: Object.freeze({ claimId: h("process-claim") }),
          lease: Object.freeze({ receiptId: h("process-lease") }),
        }),
      }),
    ]),
    stageArtifacts: Object.freeze([
      Object.freeze({ artifactSetRoot: h("stage-set-1"), eventArtifact: Uint8Array.of(1) }),
      Object.freeze({ artifactSetRoot: h("stage-set-2"), eventArtifact: Uint8Array.of(2) }),
      Object.freeze({ artifactSetRoot: h("stage-set-3"), eventArtifact: Uint8Array.of(3) }),
      Object.freeze({ artifactSetRoot: h("stage-set-4"), eventArtifact: Uint8Array.of(4) }),
      Object.freeze({ artifactSetRoot: h("stage-set-5"), eventArtifact: Uint8Array.of(5) }),
      Object.freeze({ artifactSetRoot: h("stage-set-6"), eventArtifact: Uint8Array.of(6) }),
    ]),
  });
  const expectedPayload = Object.freeze({
    kind: "aloha.production-six-step-observation-v1",
    status: "observed",
    runtimeBindingId: h("runtime"),
    candidateReleaseCommit: h("candidate-release"),
    releaseProvenanceHash: h("release-provenance"),
    finalDurableWindowId: h("final-durable-window"),
    windowSelectionRoot: h("window-selection"),
    selectionPolicyDigest: h("selection-policy"),
    eligibleSuccessCount: "1",
    eligibleSuccessRoot: h("eligible-success"),
    selectedIndex: "0",
    selectedProducerTerminalId: h("producer-terminal"),
    terminalBindingRoot: h("terminal-binding"),
    joinedProcessEvidenceRoot: h("process-evidence"),
    durableAppendRecordId: h("durable-append"),
    producerTerminalDurableAppendRecordId: h("producer-terminal-durable-append"),
    traceRoot: h("trace"),
    stage12Root: h("stage-12"),
    sixStepLineageRoot: h("six-step-lineage"),
    runtimeAnchorRoot: h("runtime-anchor"),
    runtimeFactsRoot: h("runtime-facts"),
    programHash: h("program"),
    finalSimulationReceiptHash: h("final-simulation-receipt"),
    observedArtifacts: Object.freeze([
      Object.freeze({
        role: "runtime-release-terminal-binding",
        artifactRefId: h("terminal-artifact-ref"),
        contentSha256: h("terminal-content"),
        claimId: h("terminal-claim"),
        leaseReceiptId: h("terminal-lease"),
      }),
      Object.freeze({
        role: "joined-process-evidence",
        artifactRefId: h("process-artifact-ref"),
        contentSha256: h("process-content"),
        claimId: h("process-claim"),
        leaseReceiptId: h("process-lease"),
      }),
    ]),
    stageArtifactSetRoots: Object.freeze([
      h("stage-set-1"),
      h("stage-set-2"),
      h("stage-set-3"),
      h("stage-set-4"),
      h("stage-set-5"),
      h("stage-set-6"),
    ]),
  }) satisfies CanonicalJson;

  assert.equal(
    productionSixStepObservedRootV1(observedPayload),
    hashDomain("aloha/production-six-step-observation/v1", expectedPayload),
  );
});
