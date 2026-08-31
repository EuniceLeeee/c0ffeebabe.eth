import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentAddressedObserverSinkV1 } from "../../../acceptance/collectors/src/content-addressed-sink.ts";
import { createResolverPolicy } from "../../../specs/artifact-resolution/src/index.ts";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { readProductionSixStepArtifactMaterialV1 } from "../../evidence-emitter/src/index.ts";
import { issueStartupSixStepRouteParentCapabilityV1 } from "../../startup-runtime/src/internal/six-step-route-parent-owner.ts";
import {
  issueRuntimeReleaseSixStepProductionV1,
  readRuntimeReleaseSixStepTailEmissionPortV1,
} from "../src/internal/six-step-production-owner.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-six-step-production", value);

test("production Stage 3-6 inherits the first Stage 2 instance key, not the route owner ref", async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-six-step-production-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sink = new ContentAddressedObserverSinkV1({
    directory: join(directory, "observer"),
    storeIdentityHash: h("observer-store"),
    resolverPolicy: createResolverPolicy({
      schemaVersion: 1,
      kind: "aloha.artifact-resolver-policy",
      allowedLocatorKind: "content-object",
      digestAlgorithm: "sha256",
      maxByteLength: "33554432",
      requireExactLengthMediaAndSchema: true,
      minimumRemainingStoreEpochs: "0",
      failureOutcome: "invalid",
    }),
    lease: {
      validFromStoreEpoch: "1",
      validThroughStoreEpoch: "1",
      issuerId: "aloha.test.runtime-release-six-step-production",
      issuerQualificationId: h("issuer-qualification"),
      qualificationRegistryRoot: h("qualification-registry"),
    },
  });
  const strategyRuntime = Object.freeze(Object.create(null)) as object;
  const production = issueRuntimeReleaseSixStepProductionV1({
    strategyRuntime,
    process: {
      systemId: "aloha-test-runtime-release",
      commitSha: "a".repeat(40),
      executableHash: h("executable"),
      deploymentManifestHash: h("deployment-manifest"),
      serviceIdentityHash: h("service-identity"),
      pid: "7",
      processStartTicks: "11",
      bootIdHash: h("boot"),
    },
    emitterCodeHash: h("emitter"),
    directory: join(directory, "evidence"),
    sink,
    strategyCatalogRoot: h("strategy-catalog"),
    definitionCatalogRoot: h("definition-catalog"),
    releaseProvenanceHash: h("release-provenance"),
    generationRefreshPolicyHash: h("refresh-policy"),
    capabilities: [],
    semanticConfigDigest: h("semantic-config"),
    resourceMetricsHash: h("resource-metrics"),
  });
  const instanceKey = "stage-2-instance-key";
  const ownerRef = h("different-route-owner-ref");
  assert.notEqual(ownerRef, instanceKey);
  const cutoff = Object.freeze({
    chainId: "1",
    number: "100",
    hash: h("block"),
    stateRoot: h("state-root"),
  });
  const candidate = Object.freeze({
    familyId: "fixture-family",
    familyDefinitionHash: h("family-definition"),
    familyCandidateKey: h("family-candidate"),
  });
  const publication = Object.freeze({
    instanceKey,
    familyDefinitionHash: candidate.familyDefinitionHash,
    instancePublicationHash: h("instance-publication"),
  });
  const outcome = Object.freeze({
    kind: "verified",
    runCandidateKey: h("run-candidate"),
    familyCandidateKey: candidate.familyCandidateKey,
    instanceKey,
    publication,
    identityProof: Object.freeze({ sequence: "10", identityOrigin: Object.freeze({ kind: "fresh" }) }),
  });
  const sourceCoverage = Object.freeze({ cutoff, entries: [], sourceCoverageRoot: h("source-coverage") });
  const stage1 = await production.checkpoint.emitVerifiedOutcome({
    runId: "builder-run",
    cutoff,
    candidatePartitionRoot: h("candidate-partition"),
    candidate,
    outcome,
    sourceCoverage,
  } as never);
  const ready = Object.freeze({
    generationId: "ready-generation",
    generationRefreshPolicyHash: h("refresh-policy"),
    cutoff,
    definitionCatalogRoot: h("definition-catalog"),
    sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
    instanceCatalogRoot: h("instance-catalog"),
    graphRoot: h("graph"),
    promotionRevision: "1",
    promotedAtMonotonicNs: "20",
  });
  const edgeId = h("edge");
  const stage2 = await production.checkpoint.emitReadyEdge({
    parent: stage1,
    ready,
    candidate,
    outcome,
    publication,
    edge: Object.freeze({ edgeId }),
    sourceCoverage,
  } as never);
  const binding = Object.freeze({
    generationId: ready.generationId,
    readyRecordHash: h("ready-record"),
    generationRefreshPolicyHash: ready.generationRefreshPolicyHash,
    cutoff,
    definitionCatalogRoot: ready.definitionCatalogRoot,
    instanceCatalogRoot: ready.instanceCatalogRoot,
    graphRoot: ready.graphRoot,
    releaseProvenanceHash: h("release-provenance"),
    candidatePartitionProofStorageHash: h("candidate-partition-proof-storage"),
    nominationClosureRoot: h("nomination-closure"),
    nominationClosureStorageHash: h("nomination-closure-storage"),
  });
  const lease = Object.freeze({
    binding,
    edges: [],
    assertActive() {},
    async resolveRouteHandle() { throw new TypeError("unused fixture route handle"); },
  });
  const routeParents = issueStartupSixStepRouteParentCapabilityV1({
    lease,
    binding,
    readOwned: orderedEdgeIds => {
      assert.deepEqual(orderedEdgeIds, [edgeId]);
      return Object.freeze({ stage1: Object.freeze([stage1]), stage2: Object.freeze([stage2]) });
    },
  });
  const tail = readRuntimeReleaseSixStepTailEmissionPortV1(strategyRuntime, routeParents);
  const issuedHandle = Object.freeze({ opaque: Object.freeze(Object.create(null)) });
  const route = Object.freeze({
    routeHash: h("route"),
    routeBindingHash: h("route-binding"),
    legs: Object.freeze([Object.freeze({ edgeId, ownerRef, issuedHandle })]),
  });
  const pipeline = Object.freeze({
    lease,
    routeCandidateId: h("route-candidate"),
    orderedEdgeIds: Object.freeze([edgeId]),
    strategy: Object.freeze({}),
    objective: Object.freeze({ objectiveRef: h("objective"), payload: Object.freeze({}) }),
    currentSource: Object.freeze({
      sessionId: h("producer-session"),
      source: cutoff,
      assertCurrent() {},
    }),
    correlationId: h("correlation"),
    deadlineAtMs: 1,
    callerId: "test",
  });
  const timing = Object.freeze({ startedMonotonicNs: "30", finishedMonotonicNs: "31" });
  const stage3 = await tail.emitPlanner({
    pipeline,
    route,
    coarse: Object.freeze({ kind: "rankable" }),
    planned: Object.freeze({ kind: "planned" }),
    timing,
  } as never);
  const stage4 = await tail.emitExact({
    parent: stage3,
    pipeline,
    route,
    exact: Object.freeze({ kind: "verified" }),
    timing,
  } as never);
  const program = Object.freeze({ kind: "execution-program", programHash: h("program") });
  const stage5 = await tail.emitExecutionProgram({
    parent: stage4,
    pipeline,
    route,
    program,
    ownerEvidence: Object.freeze({
      facts: Object.freeze({ callerMode: "direct", preCalls: [], observationPairs: [], actionOwners: [] }),
    }),
    timing,
  } as never);
  const stage6 = await tail.emitFinalSimulation({
    parent: stage5,
    pipeline,
    route,
    program,
    simulation: Object.freeze({ kind: "final-simulation-passed" }),
    ownerEvidence: Object.freeze({ facts: Object.freeze({ receipt: "verified" }) }),
    economicSafety: Object.freeze({
      economic: Object.freeze({ result: "positive" }),
      safety: Object.freeze({ result: "safe" }),
    }),
    timing,
  } as never);
  const tailMaterials = [stage3, stage4, stage5, stage6].map(readProductionSixStepArtifactMaterialV1);
  assert.deepEqual(tailMaterials.map(material => material.event.stage.ordinal), [3, 4, 5, 6]);
  assert.deepEqual(tailMaterials.map(material => material.event.instanceKey), [instanceKey, instanceKey, instanceKey, instanceKey]);
  assert.equal(tailMaterials[0]!.event.parentEventIds[0], readProductionSixStepArtifactMaterialV1(stage2).event.eventId);
  for (let index = 1; index < tailMaterials.length; index += 1) {
    assert.deepEqual(tailMaterials[index]!.event.parentEventIds, [tailMaterials[index - 1]!.event.eventId]);
  }

  await assert.rejects(
    tail.emitExact({
      parent: { ...stage3 } as never,
      pipeline,
      route,
      exact: Object.freeze({ kind: "verified" }),
      timing,
    } as never),
    /not issued/,
  );
  const emptyParents = issueStartupSixStepRouteParentCapabilityV1({
    lease,
    binding,
    readOwned: () => Object.freeze({ stage1: Object.freeze([]), stage2: Object.freeze([]) }),
  });
  await assert.rejects(
    readRuntimeReleaseSixStepTailEmissionPortV1(strategyRuntime, emptyParents).emitPlanner({
      pipeline,
      route,
      coarse: Object.freeze({ kind: "rankable" }),
      planned: Object.freeze({ kind: "planned" }),
      timing,
    } as never),
    /route parent denominator is incomplete/,
  );
  await assert.rejects(
    readRuntimeReleaseSixStepTailEmissionPortV1(strategyRuntime, { ...routeParents }).emitPlanner({
      pipeline,
      route,
      coarse: Object.freeze({ kind: "rankable" }),
      planned: Object.freeze({ kind: "planned" }),
      timing,
    } as never),
    /route parent capability was not owner-issued/,
  );
});
