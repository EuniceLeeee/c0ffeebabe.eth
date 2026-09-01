import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  assertExactKeys,
  assertNonEmptyString,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  WorkScheduler,
  createQualifiedExecutorRegistry,
  hashQualifiedExecutorRegistryEntry,
  type QualifiedExecutorAuthorityCapability,
  type QualifiedExecutorAuthorityIssuer,
  type QualifiedExecutorAuthorityOpenInput,
  type QualifiedExecutorAuthorityProvenanceV1,
  type QualifiedExecutorRegistryEntryV1,
  type QualifiedExecutorWorkerBindingV1,
} from "../../../scheduler/src/index.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../../scheduler/src/internal/authority-owner.ts";
import {
  issueQualifiedSharedSchedulerRuntimePort,
  type QualifiedSharedSchedulerRuntimePortV1,
} from "../../../scheduler/src/internal/shared-runtime-owner.ts";
import { issueRuntimeReleaseHttpFamilyPhysicalExecutionPortV1 } from "./http-family-physical-owner.ts";
import type { QualifiedPhysicalExecutionPortV1 } from "../../../work-plane/src/index.ts";
import { createNodeRevmWorkerChannel } from "../../../../runtime/revm-workers/src/node-worker-factory.ts";
import {
  issueRevmWorkerAuthorityIssuer,
  type RevmWorkerDeploymentStateV1,
} from "../../../../runtime/revm-workers/src/internal/authority.ts";
import type {
  RevmWorkerAuthorityIssuer,
  RevmWorkerFactory,
  RevmWorkerQualification,
} from "../../../../runtime/revm-workers/src/lifecycle.ts";
import type {
  RevmWorkerAuthorityBindingV1,
  RevmWorkerRuntimeLeaseV1,
} from "../../../../runtime/revm-workers/src/protocol.ts";
import {
  decodeRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";

export interface RuntimeInfrastructureInputV1 {
  readonly runtimeAuthority: RuntimeAuthorityDescriptorV1;
  readonly processEpoch: string;
  readonly rpcEndpoint: string;
  readonly rpcTimeoutMs: number;
  readonly revmWorkerExecutablePath: string;
}

export interface RuntimeInfrastructureV1 {
  readonly scheduler: Readonly<{
    readonly issuer: QualifiedExecutorAuthorityIssuer;
    readonly capability: QualifiedExecutorAuthorityCapability;
    readonly runtime: QualifiedSharedSchedulerRuntimePortV1;
    readonly physicalExecution: QualifiedPhysicalExecutionPortV1<readonly unknown[]>;
  }>;
  readonly revm: Readonly<{
    readonly deployment: RevmWorkerDeploymentStateV1;
    readonly authority: RevmWorkerAuthorityIssuer;
  }>;
  readonly executorQualification: Readonly<{
    readonly executorKind: string;
    readonly engineBuildFingerprint: Hash;
    readonly executableFingerprint: Hash;
    readonly qualifiedExecutorRegistryRoot: Hash;
    readonly selectedExecutorLeafHash: Hash;
    readonly releaseRoleManifestRoot: Hash;
    readonly schemaFingerprint: Hash;
  }>;
}

function sameWorker(
  value: QualifiedExecutorWorkerBindingV1,
  selected: QualifiedExecutorRegistryEntryV1,
): boolean {
  return value.executorKind === selected.executorKind
    && value.engineBuildFingerprint === selected.engineBuildFingerprint
    && value.executableFingerprint === selected.executableFingerprint
    && value.closureFingerprint === selected.closureFingerprint
    && value.protocolFingerprint === selected.protocolFingerprint
    && value.schemaFingerprint === selected.schemaFingerprint
    && value.releaseRoleManifestRoot === selected.releaseRoleManifestRoot
    && value.candidateCommit === selected.candidateCommit;
}

function qualifiedScheduler(input: {
  readonly registryRoot: Hash;
  readonly authorityRoot: Hash;
  readonly selected: QualifiedExecutorRegistryEntryV1;
  readonly processEpoch: string;
}): Readonly<{
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
  readonly runtime: QualifiedSharedSchedulerRuntimePortV1;
}> {
  let revoked = false;
  let sequence = 0n;
  const capabilities = new WeakMap<object, QualifiedExecutorAuthorityProvenanceV1>();
  const issue = (worker: QualifiedExecutorWorkerBindingV1): QualifiedExecutorAuthorityCapability => {
    if (revoked) throw new TypeError("runtime scheduler authority is revoked");
    if (!sameWorker(worker, input.selected)) throw new TypeError("scheduler worker executable facts do not match runtime");
    sequence += 1n;
    const capability = Object.freeze(Object.create(null));
    capabilities.set(capability, Object.freeze({
      authorityRoot: input.authorityRoot,
      workerEpoch: worker.workerEpoch,
      executorSession: hashDomain("aloha/runtime/executor-session/v1", {
        authorityRoot: input.authorityRoot,
        processEpoch: input.processEpoch,
        workerEpoch: worker.workerEpoch,
        sequence: sequence.toString(),
      }),
      version: 1,
    }));
    return capability;
  };
  const read = (value: QualifiedExecutorAuthorityCapability): QualifiedExecutorAuthorityProvenanceV1 => {
    if (revoked) throw new TypeError("runtime scheduler authority is revoked");
    const provenance = value !== null && typeof value === "object" ? capabilities.get(value) : undefined;
    if (provenance === undefined) throw new TypeError("runtime scheduler capability was not issued");
    return provenance;
  };
  const issuerImplementation: QualifiedExecutorAuthorityIssuer = Object.freeze({
    registryRoot: input.registryRoot,
    authorityRoot: input.authorityRoot,
    open: ({ worker }: QualifiedExecutorAuthorityOpenInput) => issue(worker),
    rotate: (value: QualifiedExecutorAuthorityOpenInput | QualifiedExecutorAuthorityCapability) => {
      if (value !== null && typeof value === "object" && "worker" in value) {
        return issue(value.worker);
      }
      throw new TypeError("runtime scheduler rotation requires explicit worker facts");
    },
    revoke: (value?: QualifiedExecutorAuthorityCapability) => {
      if (value !== undefined) read(value);
      revoked = true;
    },
    assert: read,
    provenance: read,
  });
  const issuer = issueQualifiedExecutorAuthorityIssuer(issuerImplementation);
  const capability = issuer.open({
    worker: Object.freeze({ ...input.selected, workerEpoch: input.processEpoch }),
  });
  const runtime = issueQualifiedSharedSchedulerRuntimePort({
    scheduler: new WorkScheduler(),
    issuer,
    capability,
  });
  return Object.freeze({ issuer, capability, runtime });
}

function workerFactory(
  command: string,
  qualification: RevmWorkerQualification,
): RevmWorkerFactory {
  return Object.freeze({
    async spawn(epoch: string) {
      const child = spawn(command, [
        "--worker-epoch", epoch,
        "--engine-build-fingerprint", qualification.engineBuildFingerprint,
        "--executable-fingerprint", qualification.executableFingerprint,
      ], {
        env: Object.freeze({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      return createNodeRevmWorkerChannel(child);
    },
  });
}

/** Build the one runtime scheduler/worker infrastructure from observed bytes.
 * It never loads a signer, approval, release binding, or caller-provided
 * qualification verdict. */
export function issueRuntimeInfrastructureV1(
  raw: RuntimeInfrastructureInputV1,
): RuntimeInfrastructureV1 {
  assertExactKeys(raw, [
    "runtimeAuthority", "processEpoch", "rpcEndpoint", "rpcTimeoutMs",
    "revmWorkerExecutablePath",
  ]);
  const descriptor = decodeRuntimeAuthorityDescriptorV1(raw.runtimeAuthority);
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(descriptor);
  const processEpoch = assertNonEmptyString(raw.processEpoch, "runtimeInfrastructure.processEpoch");
  const rpcEndpoint = assertNonEmptyString(raw.rpcEndpoint, "runtimeInfrastructure.rpcEndpoint");
  if (!Number.isSafeInteger(raw.rpcTimeoutMs) || raw.rpcTimeoutMs < 1 || raw.rpcTimeoutMs > 60_000) {
    throw new TypeError("runtime infrastructure RPC timeout is invalid");
  }
  const realPath = realpathSync(assertNonEmptyString(
    raw.revmWorkerExecutablePath,
    "runtimeInfrastructure.revmWorkerExecutablePath",
  ));
  const stat = statSync(realPath);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new TypeError("runtime REVM worker is not an executable file");
  }
  const executableFingerprint = sha256Hex(new Uint8Array(readFileSync(realPath)));
  const engineBuildFingerprint = hashDomain("aloha/runtime/revm-engine-build/v1", {
    executableFingerprint,
    wireVersion: "1",
  });
  const selected: QualifiedExecutorRegistryEntryV1 = Object.freeze({
    executorKind: "revm",
    engineBuildFingerprint,
    executableFingerprint,
    closureFingerprint: hashDomain("aloha/runtime/revm-closure/v1", {
      runtimeAuthority,
      executableFingerprint,
    }),
    protocolFingerprint: hashDomain("aloha/runtime/revm-protocol/v1", { wireVersion: "1" }),
    schemaFingerprint: hashDomain("aloha/runtime/revm-schema/v1", {
      request: "simulate",
      response: "returned|reverted|error",
    }),
    releaseRoleManifestRoot: hashDomain("aloha/runtime/runtime-manifest/v1", runtimeAuthority),
    candidateCommit: descriptor.implementationCommit,
  });
  const registry = createQualifiedExecutorRegistry(selected);
  const selectedExecutorLeafHash = hashQualifiedExecutorRegistryEntry(selected);
  const executorAuthorityRoot = hashDomain("aloha/runtime/executor-authority/v1", {
    runtimeAuthority,
    qualifiedExecutorRegistryRoot: registry.registryRoot,
    selectedExecutorLeafHash,
  });
  const scheduler = qualifiedScheduler({
    registryRoot: registry.registryRoot,
    authorityRoot: executorAuthorityRoot,
    selected,
    processEpoch,
  });
  const physicalExecution = issueRuntimeReleaseHttpFamilyPhysicalExecutionPortV1({
    issuer: scheduler.issuer,
    capability: scheduler.capability,
    schedulerRuntime: scheduler.runtime,
    endpoint: rpcEndpoint,
    timeoutMs: raw.rpcTimeoutMs,
  });
  const qualification = Object.freeze({ engineBuildFingerprint, executableFingerprint });
  const deployment: RevmWorkerDeploymentStateV1 = Object.freeze({
    factory: workerFactory(realPath, qualification),
    qualification,
    selectedExecutor: selected,
    selectedExecutorLeafHash,
    qualifiedExecutorRegistryRoot: registry.registryRoot,
  });
  let workerSequence = 0n;
  const workerBindings = new Map<string, RevmWorkerAuthorityBindingV1>();
  const authority = issueRevmWorkerAuthorityIssuer(Object.freeze({
    issue(): RevmWorkerAuthorityBindingV1 {
      workerSequence += 1n;
      const workerEpoch = `${processEpoch}/${workerSequence.toString()}`;
      const executorSessionHash = hashDomain("aloha/runtime/revm-worker-session/v1", {
        executorAuthorityRoot,
        workerEpoch,
      });
      const runtime: RevmWorkerRuntimeLeaseV1 = Object.freeze({
        runtimeAuthority,
        executorAuthorityRoot,
        qualifiedExecutorRegistryRoot: registry.registryRoot,
        selectedExecutorLeafHash,
        executorKind: selected.executorKind,
        engineBuildFingerprint,
        executableFingerprint,
        closureFingerprint: selected.closureFingerprint,
        protocolFingerprint: selected.protocolFingerprint,
        schemaFingerprint: selected.schemaFingerprint,
        workerEpoch,
        executorSessionHash,
      });
      const binding: RevmWorkerAuthorityBindingV1 = Object.freeze({
        runtime,
        authorityRoot: executorAuthorityRoot,
        workerEpoch,
        executorSessionHash,
      });
      workerBindings.set(workerEpoch, binding);
      return binding;
    },
    assertCurrent(binding: RevmWorkerAuthorityBindingV1): void {
      const current = workerBindings.get(binding.workerEpoch);
      if (current !== binding) throw new TypeError("runtime REVM worker authority is stale or foreign");
    },
  }));
  return Object.freeze({
    scheduler: Object.freeze({ ...scheduler, physicalExecution }),
    revm: Object.freeze({ deployment, authority }),
    executorQualification: Object.freeze({
      executorKind: selected.executorKind,
      engineBuildFingerprint,
      executableFingerprint,
      qualifiedExecutorRegistryRoot: registry.registryRoot,
      selectedExecutorLeafHash,
      releaseRoleManifestRoot: selected.releaseRoleManifestRoot,
      schemaFingerprint: selected.schemaFingerprint,
    }),
  });
}
