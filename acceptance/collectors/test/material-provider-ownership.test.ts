import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  issuePredicateDomainMaterialCapabilityV1,
} from "../../gate-core/src/internal/predicate-domain-material-issuer.ts";
import {
  readPredicateDomainMaterialCapabilityV1,
} from "../../gate-core/src/internal/predicate-domain-material-state.ts";
import {
  issueProductionPerformanceMaterialObserverOwnerPortV1,
  observeProductionPerformanceMaterialV1,
  readObservedProductionPerformanceDeploymentMaterialV1,
} from "../src/internal/performance-material-observer-owner.ts";

const h = (value: string): Hash => hashDomain("test/material-provider-ownership/v1", value);

test("predicate material issuer rejects a producer callback without executing it", () => {
  let called = false;
  assert.throws(() => issuePredicateDomainMaterialCapabilityV1({
    status: "available",
    predicateId: "aloha.performance.facts",
    candidateReleaseCommit: "1".repeat(40),
    artifactRefs: [],
    artifactClaims: [],
    resolverPolicies: [],
    retentionLeases: [],
    predicateFacts: (() => { called = true; return []; }) as never,
  }), /facts must be an array/);
  assert.equal(called, false);
});

test("predicate material issuer snapshots list containers before capability publication", () => {
  const originalFact = Object.freeze({ ordinal: "0" });
  const facts: unknown[] = [originalFact];
  const refs: never[] = [];
  const capability = issuePredicateDomainMaterialCapabilityV1({
    status: "available",
    predicateId: "aloha.performance.facts",
    candidateReleaseCommit: "1".repeat(40),
    artifactRefs: refs,
    artifactClaims: [],
    resolverPolicies: [],
    retentionLeases: [],
    predicateFacts: facts,
  });
  facts[0] = Object.freeze({ ordinal: "forged" });
  facts.push(Object.freeze({ ordinal: "1" }));
  refs.push(undefined as never);
  const stored = readPredicateDomainMaterialCapabilityV1(capability);
  assert.equal(stored.status, "available");
  if (stored.status !== "available") throw new TypeError("available material expected");
  assert.deepEqual(stored.predicateFacts, [originalFact]);
  assert.deepEqual(stored.artifactRefs, []);
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.predicateFacts));
  assert.ok(Object.isFrozen(stored.artifactRefs));
});

test("pre-release performance observer is release-bound, typed missing/unqualified, and single-read", () => {
  const releaseBinding = Object.freeze({
    candidateReleaseCommit: "1".repeat(40),
    runtimeBindingId: h("binding"),
    releaseProvenanceHash: h("provenance"),
  });
  assert.equal(issueProductionPerformanceMaterialObserverOwnerPortV1.length, 1);
  const port = issueProductionPerformanceMaterialObserverOwnerPortV1(releaseBinding);
  assert.deepEqual(observeProductionPerformanceMaterialV1(port), {
    status: "missing",
    qualification: "unqualified",
    reasons: ["post-freeze-qualified-performance-observation-missing"],
  });
  assert.throws(() => observeProductionPerformanceMaterialV1(port), /single-read/);
  assert.throws(
    () => readObservedProductionPerformanceDeploymentMaterialV1(port),
    /unqualified; complete deployment material is unavailable/,
  );
});

test("pre-release performance observer rejects structural clones and owns no deployment-material escape", () => {
  const port = issueProductionPerformanceMaterialObserverOwnerPortV1(Object.freeze({
    candidateReleaseCommit: "2".repeat(40),
    runtimeBindingId: h("clone-binding"),
    releaseProvenanceHash: h("clone-provenance"),
  }));
  const clone = Object.freeze({ ...port });
  assert.throws(() => observeProductionPerformanceMaterialV1(clone), /not owner-issued/);
  assert.throws(() => readObservedProductionPerformanceDeploymentMaterialV1(clone), /not owner-issued/);
});
