import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeTerminalPhaseInvalidFactV1,
  readFinalDurableWindowBindingV1,
  type FinalDurableWindowDraftV1,
} from "../src/index.ts";
import {
  createTerminalPhaseHeadObservationV1,
  createTerminalPhaseInvalidFactV1,
  issueFinalDurableWindowCapabilityV1,
} from "../src/internal/owner.ts";
import type { Hash } from "../../canonical-codec/src/index.ts";

const h = (digit: string) => `0x${digit.repeat(64)}` as Hash;
const append = (suffix: string) => Object.freeze({
  namespace: `evidence/${suffix}`,
  sequence: "100",
  eventId: h("4"),
  contentSha256: h("5"),
  byteLength: "10",
  offsetStart: "20",
  offsetEnd: "30",
});

const draft: FinalDurableWindowDraftV1 = Object.freeze({
  release: Object.freeze({ bindingId: h("1"), releaseProvenanceHash: h("2"), candidateReleaseCommit: "a".repeat(40) }),
  runtimeAnchor: Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1" as const,
    manifestHash: h("3"), manifestArtifactSha256: h("4"), bindingId: h("1"), releaseProvenanceHash: h("2"),
    candidateReleaseCommit: "a".repeat(40), runtimeArtifactRoot: h("5"), implementationClosureDigest: h("6"),
    entrypointSha256: h("7"), nodeExecutableSha256: h("8"), bundleModulePath: "/opt/aloha/release.mjs",
    bundleModuleSha256: h("9"), serviceName: "aloha-searcher", systemdUnit: "aloha-searcher.service",
    bootId: "boot", invocationId: "invocation", logDevice: "8", logInode: "9", pid: "42",
    processStartTicks: "7", dryRun: true as const,
  }),
  serving: Object.freeze({ generationId: "generation", graphRoot: h("a"), readyRecordHash: h("b"), sourceCoverageRoot: h("c") }),
  windowId: h("d"), targetCount: "100", ordinal: "100",
  head: Object.freeze({ chainId: "1", number: "1000", hash: h("e"), parentHash: h("f"), stateRoot: h("1") }),
  revision: "0", terminalId: h("2"), terminalBindingRoot: h("3"), performanceFactStatus: "complete",
  performanceAppend: append("performance"), producerTerminalAppend: append("terminal"),
});

test("durable replay issues one opaque exact final-window binding", () => {
  const capability = issueFinalDurableWindowCapabilityV1(draft);
  const binding = readFinalDurableWindowBindingV1(capability);
  assert.equal(binding.kind, "aloha.final-durable-window-binding-v1");
  assert.equal(binding.targetCount, "100");
  assert.equal(binding.runtimeAnchor.invocationId, "invocation");
  assert.throws(() => readFinalDurableWindowBindingV1({ ...capability }), /not owner-issued/);
});

test("issuer rejects a changed denominator or append interval", () => {
  assert.throws(
    () => issueFinalDurableWindowCapabilityV1({ ...draft, ordinal: "99" } as never),
    /100-head performance denominator/,
  );
  assert.throws(
    () => issueFinalDurableWindowCapabilityV1({
      ...draft,
      performanceAppend: { ...draft.performanceAppend, offsetEnd: "31" },
    }),
    /byte interval mismatch/,
  );
});

test("terminal-phase invalid facts are neutral, exact, and reason-bound", () => {
  const observed = createTerminalPhaseHeadObservationV1({
    head: draft.head,
    journalEpoch: "3",
    canonicalJournalRoot: h("6"),
    observedMonotonicNs: "700",
  });
  const moved = createTerminalPhaseInvalidFactV1({
    finalDurableWindowId: readFinalDurableWindowBindingV1(issueFinalDurableWindowCapabilityV1(draft)).finalDurableWindowId,
    reasonCode: "terminal-phase-current-source-moved",
    observed,
    recordedMonotonicNs: "701",
  });
  assert.deepEqual(decodeTerminalPhaseInvalidFactV1(structuredClone(moved)), moved);
  assert.throws(
    () => decodeTerminalPhaseInvalidFactV1({ ...moved, factId: h("9") }),
    /factId mismatch/,
  );
  assert.throws(
    () => createTerminalPhaseInvalidFactV1({
      finalDurableWindowId: moved.finalDurableWindowId,
      reasonCode: "terminal-phase-process-anchor-changed",
      observed,
      recordedMonotonicNs: "702",
    }),
    /observed does not match reasonCode/,
  );
});
