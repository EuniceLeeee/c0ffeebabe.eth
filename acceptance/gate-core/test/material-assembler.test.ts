import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { createResolverPolicy } from "../../../specs/artifact-resolution/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "../../collectors/src/content-addressed-sink.ts";
import { issueProductionPredicateMaterialSourcePortV1 } from "../../collectors/src/internal/predicate-material-source-issuer.ts";
import { issueCommonEnvelopeAuthorityPortV1 } from "../src/internal/common-envelope-authority-issuer.ts";
import {
  issuePredicateDomainMaterialCapabilityV1,
  readIssuedPredicateDomainMaterialCapabilityV1,
} from "../src/internal/predicate-domain-material-issuer.ts";
import { readAssembledReleaseAcceptanceResultsV1 } from "../src/internal/assembled-acceptance-owner.ts";
import {
  assembleReleasePredicateInvocationsV1,
  evaluateAssembledReleaseInvocationsV1,
} from "../src/release-material-assembler.ts";
import { RELEASE_PREDICATE_BINDINGS } from "../src/generated/predicate-composition.ts";

const h = (value: string): Hash => hashDomain("test/release-material-assembler/v1", value);

test("generic assembler traverses all generated providers and preserves typed missing material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-release-material-"));
  try {
    const sink = new ContentAddressedObserverSinkV1({
      directory,
      storeIdentityHash: h("store"),
      resolverPolicy: createResolverPolicy({
        schemaVersion: 1,
        kind: "aloha.artifact-resolver-policy",
        allowedLocatorKind: "content-object",
        digestAlgorithm: "sha256",
        maxByteLength: "1000000",
        requireExactLengthMediaAndSchema: true,
        minimumRemainingStoreEpochs: "0",
        failureOutcome: "invalid",
      }),
      lease: {
        validFromStoreEpoch: "1",
        validThroughStoreEpoch: "2",
        issuerId: "test-store",
        issuerQualificationId: h("store-qualification"),
        qualificationRegistryRoot: h("registry"),
      },
    });
    const source = issueProductionPredicateMaterialSourcePortV1({
      sink,
      readArtifactLineageStageOne: null,
      readArtifactLineageStageTwoAuthority: null,
      readArtifactLineageStageTwoGit: null,
      readFullFamilyObservation: null,
      observePerformance: null,
      readDurableTerminalDiscovery: null,
      observeTerminalSelection: null,
      readRuntimeRestartBoundary: null,
      readSourceRepositoryClosureBoundary: null,
      readLegacyAuthorityClosureBoundary: null,
    });
    let authorityCalls = 0;
    const authority = issueCommonEnvelopeAuthorityPortV1(async () => {
      authorityCalls += 1;
      throw new TypeError("authority must not run without provider material");
    });
    const capability = await assembleReleasePredicateInvocationsV1(authority, source, RELEASE_PREDICATE_BINDINGS);
    const results = evaluateAssembledReleaseInvocationsV1(capability);
    assert.equal(results.length, 8);
    assert.deepEqual(results.map(result => result.predicateId), RELEASE_PREDICATE_BINDINGS.map(binding => binding.predicateId));
    assert.ok(results.every(result => result.status === "missing" && result.unavailableCode === "owner-port-missing"));
    assert.equal(authorityCalls, 0);
    assert.throws(() => readAssembledReleaseAcceptanceResultsV1(capability), /incomplete or was not evaluated/);
    assert.throws(() => evaluateAssembledReleaseInvocationsV1(Object.freeze({})), /not release-assembler-issued/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("performance unqualified missing flows through its material provider into the assembled GateCore denominator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-release-performance-unqualified-missing-"));
  try {
    const sink = new ContentAddressedObserverSinkV1({
      directory,
      storeIdentityHash: h("performance-missing-store"),
      resolverPolicy: createResolverPolicy({
        schemaVersion: 1,
        kind: "aloha.artifact-resolver-policy",
        allowedLocatorKind: "content-object",
        digestAlgorithm: "sha256",
        maxByteLength: "1000000",
        requireExactLengthMediaAndSchema: true,
        minimumRemainingStoreEpochs: "0",
        failureOutcome: "invalid",
      }),
      lease: {
        validFromStoreEpoch: "1",
        validThroughStoreEpoch: "2",
        issuerId: "test-store",
        issuerQualificationId: h("performance-missing-store-qualification"),
        qualificationRegistryRoot: h("performance-missing-registry"),
      },
    });
    const source = issueProductionPredicateMaterialSourcePortV1({
      sink,
      readArtifactLineageStageOne: null,
      readArtifactLineageStageTwoAuthority: null,
      readArtifactLineageStageTwoGit: null,
      readFullFamilyObservation: null,
      observePerformance: () => Object.freeze({
        status: "missing" as const,
        qualification: "unqualified" as const,
        reasons: Object.freeze(["post-freeze-qualified-performance-observation-missing"]),
      }),
      readDurableTerminalDiscovery: null,
      observeTerminalSelection: null,
      readRuntimeRestartBoundary: null,
      readSourceRepositoryClosureBoundary: null,
      readLegacyAuthorityClosureBoundary: null,
    });
    const binding = RELEASE_PREDICATE_BINDINGS.find(value => value.predicateId === "aloha.performance.facts");
    assert.ok(binding);
    let authorityCalls = 0;
    const authority = issueCommonEnvelopeAuthorityPortV1(async () => {
      authorityCalls += 1;
      throw new TypeError("missing performance owner material must not reach CommonEnvelope authority");
    });
    const capability = await assembleReleasePredicateInvocationsV1(authority, source, [binding]);
    assert.deepEqual(evaluateAssembledReleaseInvocationsV1(capability), [Object.freeze({
      predicateId: "aloha.performance.facts",
      status: "missing",
      unavailableCode: "owner-material-missing",
      verdict: null,
      certificateId: null,
    })]);
    assert.equal(authorityCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generic assembler fails closed on a forged reader and a cross-predicate issued capability", async () => {
  const binding = RELEASE_PREDICATE_BINDINGS.find(value => value.predicateId === "aloha.performance.facts");
  assert.ok(binding);
  const authority = issueCommonEnvelopeAuthorityPortV1(async () => {
    throw new TypeError("invalid provider material must not reach CommonEnvelope authority");
  });
  const source = Object.freeze({});
  const throwingReaderBinding = Object.freeze({
    ...binding,
    materialProvider: Object.freeze({
      predicateId: binding.predicateId,
      providerContractVersion: binding.materialProvider.providerContractVersion,
      providerContractDigest: binding.materialProviderContractDigest,
      async provide() { return Object.freeze({}); },
      read() { throw new TypeError("forged reader"); },
    }),
  });
  const forged = await assembleReleasePredicateInvocationsV1(authority, source, [throwingReaderBinding]);
  assert.deepEqual(evaluateAssembledReleaseInvocationsV1(forged), [Object.freeze({
    predicateId: binding.predicateId,
    status: "invalid",
    unavailableCode: "owner-material-invalid",
    verdict: null,
    certificateId: null,
  })]);

  const wrongPredicateBinding = Object.freeze({
    ...binding,
    materialProvider: Object.freeze({
      predicateId: binding.predicateId,
      providerContractVersion: binding.materialProvider.providerContractVersion,
      providerContractDigest: binding.materialProviderContractDigest,
      async provide() {
        return issuePredicateDomainMaterialCapabilityV1(Object.freeze({
          status: "missing" as const,
          predicateId: "aloha.not-performance.facts",
          code: "owner-material-missing" as const,
          evidenceRoot: h("wrong-predicate"),
        }));
      },
      read: readIssuedPredicateDomainMaterialCapabilityV1,
    }),
  });
  const crossPredicate = await assembleReleasePredicateInvocationsV1(authority, source, [wrongPredicateBinding]);
  assert.equal(evaluateAssembledReleaseInvocationsV1(crossPredicate)[0]?.status, "invalid");
});
