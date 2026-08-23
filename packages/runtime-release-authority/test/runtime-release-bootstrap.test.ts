import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  createCanonicalSource,
  SQLiteCanonicalJournalStore,
} from "../../canonical-source/src/index.ts";
import {
  type AttestationCompositionBindingV1,
  type AttestationProgramPort,
  type InstanceLifecycleSingleFlightPort,
  type RejectionTransportExecutorV1,
} from "../../attestation/src/index.ts";
import {
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../../attestation/src/internal/composition.ts";
import {
  attestationProofPortForReleaseApproval,
  releaseApproval,
  runtimeAuthorityForReleaseApproval,
} from "../../attestation/test/authority-fixture.ts";
import { createCandidatePartitionProofIssuerFixture } from "../../checkpoint/test/candidate-partition-authority-fixture.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";
import { createReadyPromotionAuthority } from "../../ready-generation/src/index.ts";
import {
  createQualifiedExecutorRegistry,
  type QualifiedExecutorRegistryEntryV1,
} from "../../scheduler/src/index.ts";
import { createTestQualifiedExecutorAuthorityIssuer, testReleaseApprovalPort } from "../../scheduler/test/fixtures/qualified-release.ts";
import { QUALIFIED_EXECUTOR_AUTHORITY } from "../../scheduler/src/generated/qualified-executor-authority.ts";
import type { RuntimeReleaseBindingV1 } from "../../../specs/release-authority/src/index.ts";
import {
  buildRuntimeReleaseComposition,
  type RuntimeReleaseCompositionInputV1,
} from "../src/index.ts";
import { issueRevmWorkerDeploymentPort } from "../../../runtime/revm-workers/src/internal/authority.ts";
import { issueRuntimeReleaseRevmWorkerDeploymentPort } from "../src/internal/revm-worker-owner.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-bootstrap", value);
const selectedExecutor: QualifiedExecutorRegistryEntryV1 = Object.freeze({
  executorKind: "test-executor",
  engineBuildFingerprint: hashDomain("test/executor-engine", "v2"),
  executableFingerprint: hashDomain("test/executor-executable", "v2"),
  closureFingerprint: hashDomain("test/executor-closure", "v2"),
  protocolFingerprint: hashDomain("test/executor-protocol", "v2"),
  schemaFingerprint: hashDomain("test/executor-schema", "v2"),
  releaseRoleManifestRoot: hashDomain("test/release-role-manifest", "v2"),
  candidateCommit: "a".repeat(40),
});
const registry = createQualifiedExecutorRegistry(selectedExecutor);
const executorAuthorityRoot = hashDomain("aloha/qualified-executor-authority/v1", {
  registryRoot: registry.registryRoot,
  releaseBinding: {
    registryRoot: registry.registryRoot,
    releaseRoleManifestRoot: selectedExecutor.releaseRoleManifestRoot,
    candidateCommit: selectedExecutor.candidateCommit,
  },
});
const cutoff = Object.freeze({ chainId: "1", number: "10", hash: h("cutoff"), stateRoot: h("state") });
const policy = Object.freeze({
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "20",
  maxServingAgeBlocks: "50",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
});

interface BootstrapFixture {
  readonly authority: ReturnType<typeof runtimeAuthorityForReleaseApproval>;
  readonly binding: RuntimeReleaseBindingV1;
  readonly input: RuntimeReleaseCompositionInputV1<ReadyService, BootstrapFact>;
  readonly close: () => void;
}

interface ReadyService { readonly current: () => Hash; }
interface BootstrapFact { readonly ok: true; readonly authorityRoot: Hash; readonly executionSessionHash: Hash; }

async function fixture(): Promise<BootstrapFixture> {
  const approval = releaseApproval(h("framework"), executorAuthorityRoot, "epoch-1", h("executor-session"));
  const authority = runtimeAuthorityForReleaseApproval(approval);
  const binding = authority.resolver.resolve(authority.capability);
  const schedulerIssuer = createTestQualifiedExecutorAuthorityIssuer(
    registry,
    testReleaseApprovalPort(registry, selectedExecutor.releaseRoleManifestRoot, selectedExecutor.candidateCommit),
    { workerEpoch: binding.workerEpoch, executorSessionHash: binding.executorSessionHash },
  );
  const schedulerCapability = schedulerIssuer.open({ worker: { workerEpoch: binding.workerEpoch, ...selectedExecutor } });
  const deploymentPort = issueRuntimeReleaseRevmWorkerDeploymentPort(
    authority,
    issueRevmWorkerDeploymentPort({
      factory: {
        async spawn() { throw new Error("bootstrap contract does not spawn a worker"); },
      },
      qualification: {
        engineBuildFingerprint: binding.selectedExecutor.engineBuildFingerprint,
        executableFingerprint: binding.selectedExecutor.executableFingerprint,
      },
      selectedExecutor,
      selectedExecutorLeafHash: binding.selectedExecutorLeafHash,
      qualifiedExecutorRegistryRoot: binding.qualifiedExecutorRegistryRoot,
    }),
  );
  const directory = mkdtempSync(join(tmpdir(), "aloha-runtime-release-bootstrap-"));
  const journal = new SQLiteCanonicalJournalStore(join(directory, "canonical-journal.sqlite"));
  const canonical = createCanonicalSource({
    async getLatestHeader() { return cutoff; },
    async getHeader() { return { kind: "found" as const, header: cutoff }; },
  }, { journalStore: journal });
  await canonical.freezeView();
  const durable = createSqliteDurableStore(join(directory, "checkpoint.sqlite"));
  const promotionAuthority = createReadyPromotionAuthority(
    () => ({ definitionCatalogRoot: h("definitions"), policy }),
    authority.readyGeneration,
  );
  const programs: AttestationProgramPort = {
    async attestIdentity() { throw new Error("bootstrap contract does not execute identity"); },
    async materializeAndProject() { throw new Error("bootstrap contract does not materialize"); },
  };
  const lifecycle: InstanceLifecycleSingleFlightPort = {
    async getOrBuild() { throw new Error("bootstrap contract does not build instances"); },
  };
  const input = {
    authority,
    attestation: {
      proofPort: attestationProofPortForReleaseApproval(approval),
      build(composition: AttestationCompositionBindingV1) {
        const frameworkRuntime = createFrameworkFailureRuntime(composition, { classify() { return null; } });
        const rejectionIssuer = createRejectionExecutorAuthorityIssuer(composition);
        const executor: RejectionTransportExecutorV1 = {
          async execute() { return { transport: [], effects: [] }; },
        };
        return {
          frameworkRuntime,
          rejectionRuntime: createRejectionFactRuntime(rejectionIssuer.issue(executor)),
          programs,
          instanceLifecycle: lifecycle,
        };
      },
    },
    candidatePartitionProofIssuer: createCandidatePartitionProofIssuerFixture(binding),
    checkpoint: { durable, canonical, probeCaller: {}, promotionAuthority },
    scheduler: {
      issuer: schedulerIssuer,
      capability: schedulerCapability,
      async execute({ provenance, executionSessionHash }) {
        return { ok: true as const, authorityRoot: provenance.authorityRoot, executionSessionHash };
      },
    },
    revm: {
      deploymentPort,
    },
    ready: {
      build(release) {
        return { current: () => release.currentProvenanceHash() };
      },
    },
  } satisfies RuntimeReleaseCompositionInputV1<ReadyService, BootstrapFact>;
  return {
    authority,
    binding,
    input,
    close() {
      durable.close();
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("generated scheduler authority remains fail-closed until deployment composition", () => {
  assert.equal(QUALIFIED_EXECUTOR_AUTHORITY, null);
});

test("bootstrap composes real release-bound owners and returns no authority surface", async () => {
  const value = await fixture();
  try {
    const services = buildRuntimeReleaseComposition(value.input);
    assert.equal(services.release.releaseAuthorityRoot, value.binding.releaseAuthorityRoot);
    assert.equal(services.ready.current(), services.release.releaseProvenanceHash);
    assert.deepEqual(Object.keys(services).sort(), ["attestation", "checkpoint", "familyExecution", "ready", "release", "revmPool"]);
    for (const key of ["authority", "resolver", "issuer", "signer", "rotate", "revoke", "capability"]) {
      assert.equal(key in services, false, `composition leaked ${key}`);
    }
    assert.equal("validationAuthority" in services.attestation, false);
    assert.equal("issuer" in services.familyExecution, false);
    assert.equal("authority" in services.revmPool, false);
  } finally {
    value.close();
  }
});

test("bootstrap rejects cloned or foreign proof/scheduler issuers before constructing checkpoint", async () => {
  const cloned = await fixture();
  try {
    const proofClone = { ...cloned.input.candidatePartitionProofIssuer };
    assert.throws(
      () => buildRuntimeReleaseComposition({ ...cloned.input, candidatePartitionProofIssuer: proofClone }),
      /not release-issued/,
    );
  } finally {
    cloned.close();
  }

  const foreign = await fixture();
  try {
    const scheduler = foreign.input.scheduler;
    const foreignIssuer = createTestQualifiedExecutorAuthorityIssuer(
      registry,
      testReleaseApprovalPort(registry, selectedExecutor.releaseRoleManifestRoot, selectedExecutor.candidateCommit),
    );
    const foreignCapability = foreignIssuer.open({ worker: { workerEpoch: foreign.binding.workerEpoch, ...selectedExecutor } });
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...foreign.input,
        scheduler: { ...scheduler, capability: foreignCapability },
      }),
      /unknown-capability|not issued|stale|revoked/,
    );
  } finally {
    foreign.close();
  }
});

test("bootstrap accepts only an owner-issued deployment port with an exact signed selected-executor join", async () => {
  const value = await fixture();
  try {
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        revm: {
          factory: { async spawn() { throw new Error("must not spawn"); } },
          qualification: {
            engineBuildFingerprint: value.binding.selectedExecutor.engineBuildFingerprint,
            executableFingerprint: value.binding.selectedExecutor.executableFingerprint,
          },
        },
      } as never),
      /deployment port|owner-issued|not issued/,
    );
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        revm: { deploymentPort: { ...value.input.revm.deploymentPort } },
      }),
      /deployment port|owner-issued|not issued/,
    );

    const executorFields = [
      "executorKind",
      "engineBuildFingerprint",
      "executableFingerprint",
      "closureFingerprint",
      "protocolFingerprint",
      "schemaFingerprint",
      "releaseRoleManifestRoot",
      "candidateCommit",
    ] as const;
    for (const field of executorFields) {
      const altered = {
        ...selectedExecutor,
        [field]: field === "executorKind" ? "other-executor" : field === "candidateCommit" ? "b".repeat(40) : h(`altered-${field}`),
      } as QualifiedExecutorRegistryEntryV1;
      const rawPort = issueRevmWorkerDeploymentPort({
        factory: { async spawn() { throw new Error("must not spawn"); } },
        qualification: {
          engineBuildFingerprint: altered.engineBuildFingerprint,
          executableFingerprint: altered.executableFingerprint,
        },
        selectedExecutor: altered,
        selectedExecutorLeafHash: h(`altered-leaf-${field}`),
        qualifiedExecutorRegistryRoot: value.binding.qualifiedExecutorRegistryRoot,
      });
      assert.throws(
        () => issueRuntimeReleaseRevmWorkerDeploymentPort(value.authority, rawPort),
        /signed selected executor/,
        `selected executor field ${field} was not bound`,
      );
    }

    const alteredQualification = issueRevmWorkerDeploymentPort({
      factory: { async spawn() { throw new Error("must not spawn"); } },
      qualification: {
        engineBuildFingerprint: h("altered-qualification-engine"),
        executableFingerprint: value.binding.selectedExecutor.executableFingerprint,
      },
      selectedExecutor,
      selectedExecutorLeafHash: value.binding.selectedExecutorLeafHash,
      qualifiedExecutorRegistryRoot: value.binding.qualifiedExecutorRegistryRoot,
    });
    assert.throws(
      () => issueRuntimeReleaseRevmWorkerDeploymentPort(value.authority, alteredQualification),
      /signed selected executor/,
    );

    const alteredRegistryRoot = issueRevmWorkerDeploymentPort({
      factory: { async spawn() { throw new Error("must not spawn"); } },
      qualification: {
        engineBuildFingerprint: selectedExecutor.engineBuildFingerprint,
        executableFingerprint: selectedExecutor.executableFingerprint,
      },
      selectedExecutor,
      selectedExecutorLeafHash: value.binding.selectedExecutorLeafHash,
      qualifiedExecutorRegistryRoot: h("altered-registry-root"),
    });
    assert.throws(
      () => issueRuntimeReleaseRevmWorkerDeploymentPort(value.authority, alteredRegistryRoot),
      /signed selected executor/,
    );
  } finally {
    value.close();
  }
});

test("every public service call fails closed after runtime rotation and revoke", async () => {
  const value = await fixture();
  try {
    const services = buildRuntimeReleaseComposition(value.input);
    assert.equal(services.ready.current(), services.release.releaseProvenanceHash);
    value.authority.rotate(value.binding);
    assert.throws(() => services.ready.current(), /stale|rotation/);
    assert.throws(() => services.attestation.openRunSession({ candidatePartition: {} as never }), /stale|rotation/);
    assert.throws(() => services.checkpoint.loadAndValidateRoot(), /stale|rotation/);
    await assert.rejects(services.familyExecution.executeFrozenProgram({} as never), /stale|rotation/);

    value.authority.revoke();
    assert.throws(() => services.ready.current(), /revoked/);
    assert.throws(() => services.attestation.openRunSession({ candidatePartition: {} as never }), /revoked/);
    assert.throws(() => services.checkpoint.loadAndValidateRoot(), /revoked/);
    await assert.rejects(services.familyExecution.executeFrozenProgram({} as never), /revoked/);
  } finally {
    value.close();
  }
});
