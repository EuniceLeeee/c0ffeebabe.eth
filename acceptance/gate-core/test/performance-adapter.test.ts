import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  createReadOnlyArtifactRef,
} from "../../../specs/core-envelope/src/index.ts";
import {
  DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
  createCandidateSet,
  createPerformanceFactEnvelope,
  createPerformanceWindowCommitment,
  encodePerformanceEvent,
  encodePerformanceFactBundle,
  encodeProductionPerformanceProfile,
  PERFORMANCE_EVENT_SCHEMA_MANIFEST,
  PERFORMANCE_FACT_BUNDLE_SCHEMA_MANIFEST,
  PERFORMANCE_PROFILE_SCHEMA_MANIFEST,
  type PerformanceEventV1,
  type PerformanceFactBundleV1,
  type PerformanceWindowCommitmentV1,
} from "../../../specs/performance/src/index.ts";
import {
  createPerformanceCoverageReceipt,
  PerformanceWindowCollectorV1,
  type PerformanceAppendPortV1,
} from "../../../packages/performance-collector/src/index.ts";
import { issuePerformanceHeadTerminalEvidenceForTest } from "../../../packages/performance-collector/test/authority-fixture.ts";
import {
  evaluatePerformancePredicate,
} from "../../performance-facts/src/predicate.ts";
import {
  runPerformanceMutationRegistry,
} from "../../performance-facts/src/mutations.ts";
import {
  PERFORMANCE_PREDICATE_EVALUATOR,
} from "../src/predicates/performance.ts";
import type { PredicateRuntimeFactsV1 } from "../src/predicate-composition.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;

function schemaRef() {
  return {
    id: PERFORMANCE_FACT_BUNDLE_SCHEMA_MANIFEST.id,
    version: PERFORMANCE_FACT_BUNDLE_SCHEMA_MANIFEST.version,
    schemaHash: PERFORMANCE_FACT_BUNDLE_SCHEMA_MANIFEST.schemaHash,
  } as const;
}

function commitment(): PerformanceWindowCommitmentV1 {
  return createPerformanceWindowCommitment({
    windowStartAnchor: { chainId: "1", number: "100", hash: h("1"), parentHash: h("2"), stateRoot: h("3") },
    eligibilityRuleHash: h("4"),
    performanceProfileHash: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE.profileHash,
    targetCount: "100",
    processLogAnchor: { commitSha: "a".repeat(40), executableHash: h("5"), pid: "42", processStartTicks: "7", bootIdHash: h("6"), logSystemId: "system", logBootIdHash: h("6"), logDevice: "8", logInode: "9" },
    releaseBindingId: h("7"), releaseProvenanceHash: h("8"), runtimeAnchorHash: h("9"), providerRoot: h("9"), hardwareProfileRoot: h("a"), commitContextBindingId: h("b"), commitAppendRecordId: h("c"), committedMonotonicNs: "0",
  });
}

class MemoryAppend implements PerformanceAppendPortV1 {
  #offset = 0n;
  async appendFsyncMonotonic(request: Parameters<PerformanceAppendPortV1["appendFsyncMonotonic"]>[0]) {
    const start = this.#offset;
    this.#offset += BigInt(request.bytes.length);
    return { sequence: request.sequence, eventId: request.eventId, contentSha256: sha256Hex(request.bytes), byteLength: request.bytes.length.toString(), offsetStart: start.toString(), offsetEnd: this.#offset.toString(), fsynced: true as const };
  }
}

interface CollectedPerformanceV1 {
  readonly bundle: PerformanceFactBundleV1;
  readonly events: readonly PerformanceEventV1[];
}

async function buildBundle(unhealthy = false): Promise<CollectedPerformanceV1> {
  const collector = await PerformanceWindowCollectorV1.open({
    commitment: commitment(),
    profile: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
    append: new MemoryAppend(),
    clock: (() => { let now = 1_000_000n; return () => { now += 1_000_000n; return now; }; })(),
  });
  let previousHash = h("d");
  for (let index = 0; index < 100; index += 1) {
    const currentHash = h(((index % 9) + 1).toString());
    const anchor = await collector.acceptCanonicalHead({
      canonicalHead: { chainId: "1", number: (101 + index).toString(), hash: currentHash, parentHash: previousHash, stateRoot: h("e") },
    });
    const candidateSet = createCandidateSet({ windowId: collector.commitment.windowId, ordinal: (index + 1).toString(), candidateIds: index === 0 ? [h("1")] : [] });
    const coverage = createPerformanceCoverageReceipt({ windowId: collector.commitment.windowId, ordinal: anchor.ordinal, canonicalHead: anchor.canonicalHead, sourceCoverageRoot: h("f") });
    const secondGeneration = index >= 20;
    const head = await collector.bindEligibleHeadFacts(anchor, {
      coverage,
      candidateSet,
      serving: {
        generationId: secondGeneration ? "generation-2" : "generation-1",
        graphRoot: secondGeneration ? h("8") : h("7"),
        readyRecordHash: secondGeneration ? h("9") : h("8"),
        generationSourceCoverageRoot: secondGeneration ? h("c") : h("b"),
      },
    });
    previousHash = currentHash;
    await collector.sealTerminal(head.headRecordId, issuePerformanceHeadTerminalEvidenceForTest({
      windowId: collector.commitment.windowId,
      headRecordId: head.headRecordId,
      candidateSetRoot: candidateSet.candidateSetRoot,
      correlationRoot: h("4"),
      outcome: unhealthy && index === 50 ? "timeout" : index === 0 ? "complete-candidates-terminal" : "complete-no-candidate",
      candidatePathDurationUs: index === 0 ? "500" : null,
      sourceCoarseDurationUs: "100", coarseDurationUs: "90", plannerExactProgramDurationUs: index === 0 ? "200" : "0", finalSimulationQueueWaitUs: index === 0 ? "10" : "0", finalSimulationServiceUs: index === 0 ? "100" : "0", overheadDurationUs: "10",
      candidateTerminals: index === 0 ? [{ candidateId: h("1"), outcome: "verified", timingUs: "500", evidenceRoot: h("2"), sixStepCompletion: { mode: "dry-run", evidenceRoot: h("5") } }] : [],
      workReceiptRoot: h("3"),
      queueTelemetry: [{ lane: "producer-critical", resource: "rpc", current: "0", max: "4", oldestAgeUs: "0", accepted: "1", rejected: "0", cancelled: "0" }],
      permitAccounting: [{ ownerRef: "producer", lane: "producer-critical", resource: "rpc", issued: "1", released: "1", active: "0" }],
      resourceSamples: [{ resource: "rpc", current: "0", capacity: "8", max: "8" }],
      cpuMemoryEventLoop: { cpuUtilizationBasisPoints: "100", rssBytes: "1000", eventLoopLagUs: "1" },
      workerRestart: { workerCount: "4", restarted: "0", orphanedWorkers: "0" },
    }));
  }
  const snapshot = collector.snapshot();
  const bundle = snapshot.bundle;
  assert.ok(bundle !== null);
  return { bundle, events: snapshot.rawEvents };
}

function runtimeFor(collected: CollectedPerformanceV1, options: { readonly observation?: boolean; readonly mirrorSplice?: CollectedPerformanceV1 } = {}): PredicateRuntimeFactsV1 {
  const rawFacts: readonly { readonly factType: "profile" | "event"; readonly sequence: string | null; readonly bytes: Uint8Array; readonly schema: ReturnType<typeof schemaRef> }[] = [
    { factType: "profile", sequence: null, bytes: encodeProductionPerformanceProfile(collected.bundle.profile), schema: { id: PERFORMANCE_PROFILE_SCHEMA_MANIFEST.id, version: PERFORMANCE_PROFILE_SCHEMA_MANIFEST.version, schemaHash: PERFORMANCE_PROFILE_SCHEMA_MANIFEST.schemaHash } },
    ...collected.events.map((event) => ({ factType: "event" as const, sequence: event.sequence, bytes: encodePerformanceEvent(event), schema: { id: PERFORMANCE_EVENT_SCHEMA_MANIFEST.id, version: PERFORMANCE_EVENT_SCHEMA_MANIFEST.version, schemaHash: PERFORMANCE_EVENT_SCHEMA_MANIFEST.schemaHash } })),
  ];
  const refs = [];
  const claims = [];
  const policies = [];
  const leases = [];
  const envelopes = [];
  const observationId = h("e");
  const claimIds = [];
  const policy = createResolverPolicy({ schemaVersion: 1, kind: "aloha.artifact-resolver-policy", allowedLocatorKind: "content-object", digestAlgorithm: "sha256", maxByteLength: "1048576", requireExactLengthMediaAndSchema: true, minimumRemainingStoreEpochs: "0", failureOutcome: "invalid" });
  policies.push(policy);
  for (const [index, raw] of rawFacts.entries()) {
    const bytes = raw.bytes;
    const mirroredBytes = raw.factType === "event" && options.mirrorSplice?.events[index - 1] !== undefined ? encodePerformanceEvent(options.mirrorSplice.events[index - 1]!) : bytes;
    const contentSha256 = sha256Hex(bytes);
    const storeIdentityHash = h("1");
    const lease = createRetentionLeaseReceipt({ storeIdentityHash, objectKey: contentSha256, contentSha256, validFromStoreEpoch: "1", validThroughStoreEpoch: "10", issuerId: "performance-test-issuer", issuerQualificationId: h("2"), qualificationRegistryRoot: h("3") });
    const ref = createReadOnlyArtifactRef({ locator: { kind: "content-object", storeIdentityHash, objectKey: contentSha256 }, immutableMirrorLocator: { kind: "content-object", storeIdentityHash, objectKey: contentSha256 }, contentSha256, byteLength: bytes.length.toString(), mediaType: "application/json", schema: raw.schema, resolverPolicyHash: policy.policyHash, retentionLeaseReceiptId: lease.receiptId });
    const mirror = createObservedImmutableMirror({ storeIdentityHash, objectKey: contentSha256, bytes: encodeArtifactBytes(mirroredBytes), mediaType: "application/json", schema: raw.schema });
    const claim = createArtifactResolutionClaim({ artifactRefId: ref.artifactRefId, resolverPolicyHash: policy.policyHash, observedMirror: mirror, outcome: "content-observed" });
    refs.push(ref); claims.push(claim); leases.push(lease); claimIds.push(claim.claimId);
    envelopes.push(createPerformanceFactEnvelope({ factType: raw.factType, sequence: raw.sequence, artifactRefId: ref.artifactRefId, claimId: claim.claimId, observationId, contentSha256, byteLength: bytes.length.toString() }));
  }
  return {
    facts: envelopes,
    refs,
    claims,
    policies,
    leases,
    observations: options.observation === false ? [] : [{ observationId, rawArtifactRefs: refs, observedClaimIds: claimIds }],
  };
}

function evaluate(runtime: PredicateRuntimeFactsV1): { readonly verdict: string; readonly reasons: readonly { readonly code: string; readonly path: string }[] } {
  const reasons: { code: string; path: string }[] = [];
  const verdict = PERFORMANCE_PREDICATE_EVALUATOR.evaluateLive(runtime, { add: (code, path) => reasons.push({ code, path }) });
  return { verdict, reasons };
}

test("performance adapter requires a content-addressed envelope and normalized joins", async () => {
  const collected = await buildBundle();
  const runtime = runtimeFor(collected);
  assert.equal(evaluate(runtime).verdict, "pass");
  const rawBundle = evaluate({ ...runtime, facts: [collected.bundle] });
  assert.equal(rawBundle.verdict, "invalid");
  assert.ok(rawBundle.reasons.some((reason) => reason.code === "schema-invalid"));
  assert.equal(evaluate({ ...runtime, facts: [runtime.facts[0]!, runtime.facts[2]!, runtime.facts[1]!, ...runtime.facts.slice(3)] }).verdict, "invalid");
  assert.equal(evaluate({ ...runtime, claims: [] }).verdict, "invalid");
  assert.equal(evaluate(runtimeFor(collected, { observation: false })).verdict, "invalid");
  const withoutGenerationSegments = Object.freeze({
    bundle: collected.bundle,
    events: collected.events.filter(event => event.eventType !== "generation-segment"),
  });
  const missingSegments = evaluate(runtimeFor(withoutGenerationSegments));
  assert.equal(missingSegments.verdict, "invalid");
  assert.ok(missingSegments.reasons.some(reason => reason.code === "predicate-observation-mismatch"));
});

test("performance adapter rejects mirror splices while the pure predicate rejects order and denominator mutations", async () => {
  const collected = await buildBundle();
  const altered = await buildBundle(true);
  const spliced = evaluate(runtimeFor(collected, { mirrorSplice: altered }));
  assert.equal(spliced.verdict, "invalid");
  assert.ok(spliced.reasons.some((reason) => reason.code === "artifact-content-mismatch"));
  const reordered = { ...collected.bundle, heads: [collected.bundle.heads[1]!, collected.bundle.heads[0]!, ...collected.bundle.heads.slice(2)] };
  assert.equal(evaluatePerformancePredicate(reordered).verdict, "invalid");
  const denominator = { ...collected.bundle, heads: collected.bundle.heads.slice(0, 99) };
  assert.equal(evaluatePerformancePredicate(denominator).verdict, "invalid");
  const mutationResults = runPerformanceMutationRegistry(collected.bundle);
  for (const mutation of mutationResults) {
    const result = evaluatePerformancePredicate(mutation.output as PerformanceFactBundleV1);
    if (mutation.id === "no-op-mutator") assert.equal(result.verdict, "pass");
    else assert.notEqual(result.verdict, "pass", mutation.id);
  }
  assert.equal(evaluatePerformancePredicate(altered.bundle).verdict, "fail");
});
