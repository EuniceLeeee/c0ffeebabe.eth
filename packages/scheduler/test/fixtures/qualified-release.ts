import { randomUUID } from "node:crypto";
import { assertExactKeys, hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import {
  assertQualifiedExecutorRegistry,
  type QualifiedExecutorAuthorityCapability,
  type QualifiedExecutorAuthorityIssuer,
  type QualifiedExecutorAuthorityOpenInput,
  type QualifiedExecutorAuthorityProvenanceV1,
  type QualifiedExecutorRegistryV1,
  type QualifiedExecutorWorkerBindingV1,
} from "../../src/index.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../src/internal/authority-owner.ts";

export class ExecutorAuthorityError extends Error {
  readonly code: "registry-invalid" | "revoked" | "stale" | "unknown-capability";

  constructor(code: ExecutorAuthorityError["code"], message: string) {
    super(message);
    this.name = "ExecutorAuthorityError";
    this.code = code;
  }
}

interface QualifiedExecutorReleaseApprovalPort {
  readonly current: () => unknown;
  readonly verify: (input: {
    readonly registry: QualifiedExecutorRegistryV1;
    readonly approval: unknown;
  }) => QualifiedExecutorReleaseBindingV1;
}

interface QualifiedExecutorReleaseBindingV1 {
  readonly registryRoot: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly candidateCommit: string;
}

interface AuthorityLeaseState extends QualifiedExecutorAuthorityProvenanceV1 {
  active: boolean;
}

const authorityLeaseState = new WeakMap<object, AuthorityLeaseState>();

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function authorityRootForRegistry(
  registry: QualifiedExecutorRegistryV1,
  releaseBinding: QualifiedExecutorReleaseBindingV1,
): Hash {
  return hashDomain("aloha/qualified-executor-authority/v1", {
    registryRoot: registry.registryRoot,
    releaseBinding: {
      registryRoot: releaseBinding.registryRoot,
      releaseRoleManifestRoot: releaseBinding.releaseRoleManifestRoot,
      candidateCommit: releaseBinding.candidateCommit,
    },
  });
}

function workerBinding(input: QualifiedExecutorAuthorityOpenInput): QualifiedExecutorWorkerBindingV1 {
  assertExactKeys(input, ["worker"]);
  assertExactKeys(input.worker, [
    "workerEpoch", "executorKind", "engineBuildFingerprint", "executableFingerprint",
    "closureFingerprint", "protocolFingerprint", "schemaFingerprint",
    "releaseRoleManifestRoot", "candidateCommit",
  ]);
  const worker = {
    workerEpoch: nonEmptyString(input.worker.workerEpoch, "worker.workerEpoch"),
    executorKind: nonEmptyString(input.worker.executorKind, "worker.executorKind"),
    engineBuildFingerprint: nonEmptyString(input.worker.engineBuildFingerprint, "worker.engineBuildFingerprint"),
    executableFingerprint: nonEmptyString(input.worker.executableFingerprint, "worker.executableFingerprint"),
    closureFingerprint: nonEmptyString(input.worker.closureFingerprint, "worker.closureFingerprint"),
    protocolFingerprint: nonEmptyString(input.worker.protocolFingerprint, "worker.protocolFingerprint"),
    schemaFingerprint: nonEmptyString(input.worker.schemaFingerprint, "worker.schemaFingerprint"),
    releaseRoleManifestRoot: nonEmptyString(input.worker.releaseRoleManifestRoot, "worker.releaseRoleManifestRoot"),
    candidateCommit: nonEmptyString(input.worker.candidateCommit, "worker.candidateCommit"),
  };
  if (!/^0x[0-9a-f]{64}$/.test(worker.engineBuildFingerprint)
    || !/^0x[0-9a-f]{64}$/.test(worker.executableFingerprint)
    || !/^0x[0-9a-f]{64}$/.test(worker.closureFingerprint)
    || !/^0x[0-9a-f]{64}$/.test(worker.protocolFingerprint)
    || !/^0x[0-9a-f]{64}$/.test(worker.schemaFingerprint)
    || !/^0x[0-9a-f]{64}$/.test(worker.releaseRoleManifestRoot)
    || !/^[0-9a-f]{40}$/.test(worker.candidateCommit)) {
    throw new TypeError("qualified worker binding contains a non-canonical fingerprint or commit");
  }
  return Object.freeze(worker) as QualifiedExecutorWorkerBindingV1;
}

/**
 * Test-only issuer mint.  This is deliberately kept under test/fixtures: the
 * candidate production closure contains no release-registration or issuer
 * constructor path.  A real release composition supplies an already-created
 * issuer through its generated runtime port.
 */
export function createTestQualifiedExecutorAuthorityIssuer(
  registry: QualifiedExecutorRegistryV1,
  approvalPort: QualifiedExecutorReleaseApprovalPort,
  initial?: Readonly<{ workerEpoch: string; executorSessionHash: Hash }>,
): QualifiedExecutorAuthorityIssuer {
  let releaseBinding: QualifiedExecutorReleaseBindingV1;
  try {
    assertQualifiedExecutorRegistry(registry);
    if (!approvalPort || typeof approvalPort !== "object"
      || typeof approvalPort.current !== "function"
      || typeof approvalPort.verify !== "function") {
      throw new TypeError("current signed release approval port is required");
    }
    const approval = approvalPort.current();
    releaseBinding = approvalPort.verify({ registry, approval });
    assertExactKeys(releaseBinding, ["registryRoot", "releaseRoleManifestRoot", "candidateCommit"]);
    if (!/^0x[0-9a-f]{64}$/.test(releaseBinding.registryRoot)
      || !/^0x[0-9a-f]{64}$/.test(releaseBinding.releaseRoleManifestRoot)
      || !/^[0-9a-f]{40}$/.test(releaseBinding.candidateCommit)
      || releaseBinding.registryRoot !== registry.registryRoot
      || !registry.entries.some((entry) => entry.releaseRoleManifestRoot === releaseBinding.releaseRoleManifestRoot
        && entry.candidateCommit === releaseBinding.candidateCommit)) {
      throw new TypeError("current signed release approval does not bind the qualified registry");
    }
  } catch (error) {
    throw new ExecutorAuthorityError("registry-invalid", error instanceof Error ? error.message : String(error));
  }

  const registryRoot = registry.registryRoot;
  const authorityRoot = authorityRootForRegistry(registry, releaseBinding!);
  let version = 0;
  let revoked = false;
  let currentEpoch: string | undefined;
  let initialIssued = false;
  const leases = new Set<AuthorityLeaseState>();

  const qualifiedWorkerEpoch = (worker: QualifiedExecutorWorkerBindingV1): string => {
    const entry = registry.entries.find((candidate) => candidate.executorKind === worker.executorKind
      && candidate.engineBuildFingerprint === worker.engineBuildFingerprint
      && candidate.executableFingerprint === worker.executableFingerprint
      && candidate.closureFingerprint === worker.closureFingerprint
      && candidate.protocolFingerprint === worker.protocolFingerprint
      && candidate.schemaFingerprint === worker.schemaFingerprint
      && candidate.releaseRoleManifestRoot === worker.releaseRoleManifestRoot
      && candidate.candidateCommit === worker.candidateCommit);
    if (!entry) throw new ExecutorAuthorityError("registry-invalid", "qualified worker does not match a release-bound registry entry");
    return worker.workerEpoch;
  };

  const issue = (workerEpoch: string): QualifiedExecutorAuthorityCapability => {
    if (revoked) throw new ExecutorAuthorityError("revoked", "qualified executor authority has been revoked");
    if (version === 0) version = 1;
    const executorSession = initial !== undefined && !initialIssued && workerEpoch === initial.workerEpoch
      ? initial.executorSessionHash
      : hashDomain("aloha/qualified-executor-session/v1", {
        authorityRoot,
        workerEpoch,
        version,
        nonce: randomUUID(),
      });
    initialIssued = true;
    const state: AuthorityLeaseState = { authorityRoot, workerEpoch, executorSession, version, active: true };
    const capability = Object.freeze(Object.create(null)) as QualifiedExecutorAuthorityCapability;
    authorityLeaseState.set(capability, state);
    leases.add(state);
    currentEpoch = workerEpoch;
    return capability;
  };

  const assertCapability = (capability: QualifiedExecutorAuthorityCapability): AuthorityLeaseState => {
    if (capability === null || (typeof capability !== "object" && typeof capability !== "function")) {
      throw new ExecutorAuthorityError("unknown-capability", "authority capability is not an object");
    }
    const state = authorityLeaseState.get(capability);
    if (!state || !leases.has(state)) throw new ExecutorAuthorityError("unknown-capability", "authority capability is not issued by this issuer");
    if (revoked || !state.active) throw new ExecutorAuthorityError("revoked", "qualified executor authority is revoked");
    if (state.version !== version) throw new ExecutorAuthorityError("stale", "qualified executor authority capability is stale");
    return state;
  };

  const provenance = (capability: QualifiedExecutorAuthorityCapability): QualifiedExecutorAuthorityProvenanceV1 => {
    const state = assertCapability(capability);
    return Object.freeze({
      authorityRoot: state.authorityRoot,
      workerEpoch: state.workerEpoch,
      executorSession: state.executorSession,
      version: state.version,
    });
  };

  return issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot,
    authorityRoot,
    open: (input: QualifiedExecutorAuthorityOpenInput) => issue(qualifiedWorkerEpoch(workerBinding(input))),
    rotate: (input: QualifiedExecutorAuthorityOpenInput | QualifiedExecutorAuthorityCapability) => {
      if (authorityLeaseState.has(input as object)) {
        currentEpoch = assertCapability(input as QualifiedExecutorAuthorityCapability).workerEpoch;
      } else {
        currentEpoch = qualifiedWorkerEpoch(workerBinding(input as QualifiedExecutorAuthorityOpenInput));
      }
      version += 1;
      return issue(currentEpoch);
    },
    revoke: (capability?: QualifiedExecutorAuthorityCapability) => {
      if (capability !== undefined) assertCapability(capability);
      revoked = true;
      for (const lease of leases) lease.active = false;
    },
    assert: provenance,
    provenance,
  }));
}

/** Test-only external qualification fixture. */
export function testReleaseApprovalPort(
  registry: QualifiedExecutorRegistryV1,
  releaseRoleManifestRoot: string,
  candidateCommit: string,
): QualifiedExecutorReleaseApprovalPort {
  const approval = Object.freeze({
    kind: "test.signed-release-authority-approval",
    registryRoot: registry.registryRoot,
    releaseRoleManifestRoot,
    candidateCommit,
    signature: "test-fixture-signature",
  });
  return Object.freeze({
    current: () => approval,
    verify: ({ registry: supplied, approval: suppliedApproval }: {
      readonly registry: QualifiedExecutorRegistryV1;
      readonly approval: unknown;
    }): QualifiedExecutorReleaseBindingV1 => {
      if (supplied !== registry || suppliedApproval !== approval) throw new TypeError("test release approval is not current for this registry");
      assertExactKeys(approval, ["kind", "registryRoot", "releaseRoleManifestRoot", "candidateCommit", "signature"]);
      if (approval.registryRoot !== supplied.registryRoot
        || approval.releaseRoleManifestRoot !== releaseRoleManifestRoot
        || approval.candidateCommit !== candidateCommit) {
        throw new TypeError("test release approval binding mismatch");
      }
      return Object.freeze({
        registryRoot: approval.registryRoot as Hash,
        releaseRoleManifestRoot: approval.releaseRoleManifestRoot as Hash,
        candidateCommit: approval.candidateCommit,
      });
    },
  });
}
