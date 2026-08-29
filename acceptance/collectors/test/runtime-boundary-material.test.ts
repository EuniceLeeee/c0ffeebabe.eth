import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { readPredicateDomainMaterialCapabilityV1 } from "../../gate-core/src/internal/predicate-domain-material-state.ts";
import { RUNTIME_RESTART_MATERIAL_PROVIDER } from "../src/material-providers/runtime-boundaries.ts";
import {
  issueReleaseOwnedObserverStoreV1,
  readReleaseOwnedObserverStoreV1,
  type ReleaseOwnedObserverStoreCapabilityV1,
} from "../src/internal/release-owned-observer-store.ts";
import {
  issueProductionRuntimeRestartMaterialObserverOwnerPortV1,
  productionRuntimeBoundaryMaterialEvidenceRootV1,
} from "../src/internal/runtime-boundary-material-owner.ts";
import { issueProductionPredicateMaterialSourceV1 } from "../src/production-predicate-material-source.ts";
import { observeProductionClosureRawFactsV1 } from "../src/production-closure-observer.ts";
import {
  issueProductionClosureMaterialObserverPortsV1,
} from "../src/production-runtime-boundary-observers.ts";

const h = (value: string): Hash => hashDomain("test/runtime-boundary-material/v1", value);
const releaseBinding = Object.freeze({
  candidateReleaseCommit: "1".repeat(40),
  runtimeBindingId: h("binding"),
  releaseProvenanceHash: h("provenance"),
});

function store(directory: string): ReleaseOwnedObserverStoreCapabilityV1 {
  return issueReleaseOwnedObserverStoreV1({
    directory,
    observedStoreEpoch: "1",
    authority: {
      bindingId: h("binding"),
      releaseAuthorityApprovalId: h("release-approval"),
      qualificationRegistryRoot: h("registry"),
      predicateCompositionRootDigest: h("composition"),
      releaseRoleManifestRoot: h("role-manifest"),
      candidateReleaseCommit: "1".repeat(40),
    },
  });
}

function sourceInput(observerStore: ReleaseOwnedObserverStoreCapabilityV1, databasePath: string | null) {
  return {
    observerStore,
    artifactLineageStageOne: null,
    performanceObserver: null,
    durableTerminalDiscovery: null,
    terminalSelectionObserver: null,
    runtimeRestartObserver: databasePath === null ? null : issueProductionRuntimeRestartMaterialObserverOwnerPortV1(
      releaseBinding,
      async () => Object.freeze({
        status: "missing" as const,
        reasons: Object.freeze(["durable-production-evidence-database-missing"]),
        evidenceRoot: h(databasePath),
      }),
    ),
    sourceRepositoryClosureObserver: null,
    legacyAuthorityClosureObserver: null,
  };
}

test("real restart reader is accepted and preserves the absent durable database as owner-material-missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-runtime-boundary-material-"));
  try {
    const source = issueProductionPredicateMaterialSourceV1(sourceInput(store(directory), join(directory, "not-created.sqlite")));
    const state = readPredicateDomainMaterialCapabilityV1(await RUNTIME_RESTART_MATERIAL_PROVIDER.provide(source));
    assert.equal(state.status, "missing");
    assert.equal(state.code, "owner-material-missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing restart observer remains owner-port-missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-runtime-boundary-port-missing-"));
  try {
    const source = issueProductionPredicateMaterialSourceV1(sourceInput(store(directory), null));
    const state = readPredicateDomainMaterialCapabilityV1(await RUNTIME_RESTART_MATERIAL_PROVIDER.provide(source));
    assert.equal(state.status, "missing");
    assert.equal(state.code, "owner-port-missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed owner observation is converted to typed owner-material-invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-runtime-boundary-malformed-"));
  try {
    const source = issueProductionPredicateMaterialSourceV1({
      ...sourceInput(store(directory), null),
      runtimeRestartObserver: issueProductionRuntimeRestartMaterialObserverOwnerPortV1(releaseBinding, async () => ({
        status: "missing",
        reasons: ["evidence-not-yet-produced", 1],
        evidenceRoot: h("malformed-observation"),
      } as never)),
    });
    const state = readPredicateDomainMaterialCapabilityV1(await RUNTIME_RESTART_MATERIAL_PROVIDER.provide(source));
    assert.equal(state.status, "invalid");
    assert.equal(state.code, "owner-material-invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("available restart material requires an exact root over commit, artifact bytes, and facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-runtime-boundary-available-"));
  try {
    const observerStore = store(directory);
    const contentSink = readReleaseOwnedObserverStoreV1(observerStore).sink;
    const artifact = await contentSink.write({
      bytes: encodeCanonicalBytes({ kind: "aloha.test.runtime-restart-raw", value: "observed" }),
      mediaType: "application/json",
      schema: Object.freeze({ id: "aloha.test.runtime-restart-raw", version: "1.0.0", schemaHash: h("runtime-restart-schema") }),
    });
    const predicateId = "aloha.runtime-restart.facts";
    const candidateReleaseCommit = "1".repeat(40);
    const predicateFacts = Object.freeze([{ kind: "aloha.test.runtime-restart-fact", value: "observed" }]);
    const evidenceRoot = productionRuntimeBoundaryMaterialEvidenceRootV1({
      predicateId,
      candidateReleaseCommit,
      artifacts: [artifact],
      predicateFacts,
    });
    const validSource = issueProductionPredicateMaterialSourceV1({
      ...sourceInput(observerStore, null),
      runtimeRestartObserver: issueProductionRuntimeRestartMaterialObserverOwnerPortV1(releaseBinding, async () => Object.freeze({
        status: "available" as const,
        candidateReleaseCommit,
        artifacts: Object.freeze([artifact]),
        predicateFacts,
        evidenceRoot,
      })),
    });
    const valid = readPredicateDomainMaterialCapabilityV1(await RUNTIME_RESTART_MATERIAL_PROVIDER.provide(validSource));
    assert.equal(valid.status, "available");

    const splicedSource = issueProductionPredicateMaterialSourceV1({
      ...sourceInput(observerStore, null),
      runtimeRestartObserver: issueProductionRuntimeRestartMaterialObserverOwnerPortV1(releaseBinding, async () => Object.freeze({
        status: "available" as const,
        candidateReleaseCommit,
        artifacts: Object.freeze([artifact]),
        predicateFacts: Object.freeze([{ kind: "aloha.test.runtime-restart-fact", value: "spliced" }]),
        evidenceRoot,
      })),
    });
    const spliced = readPredicateDomainMaterialCapabilityV1(await RUNTIME_RESTART_MATERIAL_PROVIDER.provide(splicedSource));
    assert.equal(spliced.status, "invalid");
    assert.equal(spliced.code, "owner-material-invalid");

    const changedBytes = Uint8Array.from(artifact.bytes);
    changedBytes[0] = changedBytes[0]! ^ 1;
    const changedBytesSource = issueProductionPredicateMaterialSourceV1({
      ...sourceInput(observerStore, null),
      runtimeRestartObserver: issueProductionRuntimeRestartMaterialObserverOwnerPortV1(releaseBinding, async () => Object.freeze({
        status: "available" as const,
        candidateReleaseCommit,
        artifacts: Object.freeze([{ ...artifact, bytes: changedBytes }]),
        predicateFacts,
        evidenceRoot,
      })),
    });
    const changed = readPredicateDomainMaterialCapabilityV1(await RUNTIME_RESTART_MATERIAL_PROVIDER.provide(changedBytesSource));
    assert.equal(changed.status, "invalid");
    assert.equal(changed.code, "owner-material-invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloned or structural restart observers cannot enter the production material source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-runtime-boundary-clone-"));
  try {
    const input = sourceInput(store(directory), null);
    assert.throws(() => issueProductionPredicateMaterialSourceV1({
      ...input,
      runtimeRestartObserver: Object.freeze({ observe() { return null; } }),
    }), /not owner-issued/);
    assert.throws(() => issueProductionPredicateMaterialSourceV1({
      ...input,
      sourceRepositoryClosureObserver: Object.freeze({ observe() { return null; } }),
    }), /not owner-issued/);
    assert.throws(() => issueProductionPredicateMaterialSourceV1({
      ...input,
      legacyAuthorityClosureObserver: Object.freeze({ observe() { return null; } }),
    }), /not owner-issued/);
    assert.throws(() => issueProductionPredicateMaterialSourceV1({
      ...input,
      predicateFacts: [],
    } as never), /unknown field|non-exact fields/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closure ports reject structural receipt and raw DTO inputs before observer callbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-production-closure-contract-"));
  try {
    const observerStore = store(directory);
    assert.throws(() => issueProductionClosureMaterialObserverPortsV1({
      preReleaseAdvisoryMaterial: Object.freeze({}),
      qualifiedReleaseRunner: Object.freeze({}),
      observerStore,
    }), /not staging-owner-issued/);
    assert.throws(() => issueProductionClosureMaterialObserverPortsV1({
      preReleaseAdvisoryMaterial: Object.freeze({}),
      qualifiedReleaseRunner: Object.freeze({}),
      observerStore,
      repositoryRoot: directory,
    } as never), /non-exact fields/);
    // Pairing a structural runner with a real owner-sealed receipt belongs to
    // the B-host integration flow that owns issuance of that receipt.
    const rawLocatorAttempt = await observeProductionClosureRawFactsV1({
      repositoryRoot: directory,
      databasePath: join(directory, "runtime.sqlite"),
      deploymentManifestPath: join(directory, "manifest.json"),
      qualifiedReleaseRunner: Object.freeze({}),
      sink: readReleaseOwnedObserverStoreV1(observerStore).sink,
    } as never);
    assert.equal(rawLocatorAttempt.status, "invalid");
    if (rawLocatorAttempt.status === "invalid") assert.deepEqual(rawLocatorAttempt.reasons, ["production closure raw observer input has non-exact fields"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closure observer has an explicit fail-closed mutation fence for every receipt-derived denominator", () => {
  const source = readFileSync(new URL("../src/production-closure-observer.ts", import.meta.url), "utf8");
  const input = source.slice(source.indexOf("export interface ProductionClosureRawObserverInputV1"), source.indexOf("class MissingObservation"));
  assert.match(input, /preReleaseAdvisoryMaterial: PreReleaseAdvisoryMaterialCapabilityV1/);
  assert.match(input, /qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1/);
  assert.match(input, /observerStore: ReleaseOwnedObserverStoreCapabilityV1/);
  assert.doesNotMatch(input, /repositoryRoot|databasePath|manifestPath|deploymentManifestPath|sink:/);
  assert.match(source, /preReleaseAuthorizationClaimPayloadV1\(authorization\)/);
  assert.match(source, /preReleaseAuthorizationClaimIdV1\(authorization\)/);
  assert.match(source, /preRelease\.locators\.observerStoreDirectory !== authorization\.observerStoreDirectory/);
  assert.match(source, /receipt\.observerStoreDirectory !== preRelease\.locators\.observerStoreDirectory/);
  assert.match(source, /claim\.observerStoreDirectory !== preRelease\.locators\.observerStoreDirectory/);
  assert.match(source, /manifest\.observerStoreDirectory !== preRelease\.locators\.observerStoreDirectory/);
  assert.match(source, /PRE_RELEASE_SYSTEMD_UNIT_V1/);
  assert.match(source, /!sameBytes\(systemdUnitBytes, canonicalSystemdUnitBytes\)/);
  assert.match(source, /systemd unit bytes are not the canonical hardened unit/);

  const expectedArtifacts = [
    "aloha-searcher-pre-release.service", "candidate-proof-verifier-binding.json", "deployment-bundle.mjs",
    "deployment-composition.mjs", "deployment-source.json", "executor-state.json", "performance-profile.json",
    "qualified-release-runner-input.json", "release-authority-approval.json",
    "release-intent.json", "runtime-policy.json", "runtime-boundary-projection.json", "runtime-release-binding.json", "runtime-release-signer-pin.json",
    "searcher-pre-release.env", "staging-manifest.json", "pre-release-owner.mjs",
  ];
  for (const name of expectedArtifacts) assert.match(source, new RegExp(JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const fence of [
    "staging artifact denominator was spliced",
    "artifact bytes do not exact-join receipt",
    "staging manifest artifact paths or hashes were spliced",
    "process receipt anchor does not join observed process/host facts",
    "runtime SQLite identity does not exact-join receipt",
    "runtime SQLite integrity check failed",
    "log window identity or range does not exact-join receipt",
    "log bytes do not exact-join receipt",
    "runner, approval, runtime binding, and Boundary closure were spliced",
  ]) assert.match(source, new RegExp(fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /aloha\.searcher-deployment-manifest|producerVerdict|producerFallback/);
});
