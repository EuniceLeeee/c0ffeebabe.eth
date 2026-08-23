import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  createRuntimeReleaseBindingV1, hashQualifiedExecutorRegistryEntry, hashQualifiedExecutorRegistryRoot,
  runtimeReleaseBindingProvenanceHash, runtimeReleaseBindingSigningBytes, type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import { verifyAndIssueRuntimeReleaseAuthorityV1 } from "../src/index.ts";
import {
  assertRuntimeReleasePrivatePortsCurrent,
  composeRuntimeReleasePrivatePorts,
} from "../src/internal/bootstrap.ts";
import { issueDeploymentAttestationProofPort } from "../src/internal/attestation-proof-owner.ts";
import { issueCandidatePartitionProofIssuerPort } from "../../../specs/candidate-partition-authority/src/internal/issuer-owner.ts";
import type { CandidatePartitionProofIssuerPortV1 } from "../../../specs/candidate-partition-authority/src/index.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../scheduler/src/internal/authority-owner.ts";
import { issueRuntimeReleaseCandidatePartitionProofIssuer } from "../src/internal/candidate-partition-proof-owner.ts";
import { issueRuntimeReleaseQualifiedExecutorAuthorityIssuer } from "../src/internal/scheduler-authority-owner.ts";
import {
  issueRuntimeReleaseExecutorLeaseV1,
  issueRuntimeReleaseRevmWorkerAuthorityIssuer,
} from "../src/internal/revm-worker-owner.ts";
import type { RevmWorkerAuthorityBindingV1 } from "../../../runtime/revm-workers/src/protocol.ts";
import type { QualifiedExecutorAuthorityCapability, QualifiedExecutorAuthorityIssuer } from "../../scheduler/src/index.ts";

const h = (value: string): Hash => hashDomain("test/runtime-authority", value);
const executor = { executorKind: "revm", engineBuildFingerprint: h("engine"), executableFingerprint: h("exe"), closureFingerprint: h("closure"), protocolFingerprint: h("protocol"), schemaFingerprint: h("schema"), releaseRoleManifestRoot: h("manifest"), candidateCommit: "3".repeat(40) };
const payload: RuntimeReleaseBindingPayloadV1 = {
  schemaVersion: 1, kind: "aloha.runtime-release-binding", acceptanceCertificate: { certificateId: h("cert"), payloadHash: h("cert-payload"), verdict: "pass" },
  releaseAuthorityApprovalId: h("approval"), releaseAuthorityApprovalPayloadHash: h("approval-payload"), authorityPinDigest: h("pin"),
  externalTrustAnchorRoot: h("anchor"), externalIssuerKeySetRoot: h("keys"), qualificationRegistryApprovalId: h("registry-approval"),
  qualificationRegistryRoot: h("registry"), qualificationEpoch: "1", qualificationAudienceHash: h("audience"),
  predicateCompositionRootDigest: h("composition"), gateCoreRuntimeClosureDigest: h("runtime"), gateCoreImplementationClosureDigest: h("core"),
  qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([executor]), selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(executor), selectedExecutor: executor,
  releaseRoleManifestRoot: executor.releaseRoleManifestRoot, candidateReleaseCommit: executor.candidateCommit, workerEpoch: "epoch-1", executorSessionHash: h("session"),
  frameworkAuthorityRoot: h("framework"), executorAuthorityRoot: h("executor-authority"), releaseAuthorityRoot: h("release-authority"),
  attestationProofIssuerKeyId: h("proof"), candidatePartitionProofIssuerKeyId: h("partition-proof"),
};
function rawKey(value: ReturnType<typeof generateKeyPairSync>["publicKey"]): `0x${string}` { const der = value.export({ format: "der", type: "spki" }); return `0x${der.subarray(-32).toString("hex")}`; }
function issued() {
  const keys = generateKeyPairSync("ed25519"); const signerKeyId = h("signer");
  const signatureHex = `0x${sign(null, Buffer.from(runtimeReleaseBindingSigningBytes(payload, signerKeyId)), keys.privateKey).toString("hex")}`;
  const binding = createRuntimeReleaseBindingV1(payload, signerKeyId, signatureHex);
  return { authority: verifyAndIssueRuntimeReleaseAuthorityV1(binding, { signerKeyId, publicKeyHex: rawKey(keys.publicKey) }), binding, keys, signerKeyId };
}
test("verified runtime release authority is opaque, resolver-owned, and revocable", () => {
  const value = issued(); assert.deepEqual(Reflect.ownKeys(value.authority.capability), []);
  assert.deepEqual(value.authority.resolver.resolve(value.authority.capability), value.binding);
  assert.throws(() => value.authority.resolver.resolve({ ...value.authority.capability }), /not issued/);
  value.authority.revoke(); assert.throws(() => value.authority.resolver.resolve(value.authority.capability), /revoked/);
});
test("wrong deployment pin and self-consistent unknown signature cannot issue authority", () => {
  const value = issued(); const other = generateKeyPairSync("ed25519");
  assert.throws(() => verifyAndIssueRuntimeReleaseAuthorityV1(value.binding, { signerKeyId: value.signerKeyId, publicKeyHex: rawKey(other.publicKey) }), /signature invalid/);
  assert.throws(() => verifyAndIssueRuntimeReleaseAuthorityV1(value.binding, { signerKeyId: h("other"), publicKeyHex: rawKey(value.keys.publicKey) }), /pin mismatch/);
});

function releaseProjection(binding: ReturnType<typeof issued>["binding"]) {
  return Object.freeze({
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    releaseAuthorityRoot: binding.releaseAuthorityRoot,
    candidatePartitionProofIssuerKeyId: binding.candidatePartitionProofIssuerKeyId,
  });
}

test("candidate-partition consumer receives only a release projection and is fenced on rotation/revoke", () => {
  const value = issued();
  const projection = releaseProjection(value.binding);
  const implementation = issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: () => projection,
    issue: () => { throw new Error("test issuer not called"); },
    verify: () => { throw new Error("test verifier not called"); },
  }) as unknown as CandidatePartitionProofIssuerPortV1);
  const consumer = issueRuntimeReleaseCandidatePartitionProofIssuer(value.authority, implementation);
  assert.deepEqual(consumer.currentRelease(), projection);
  assert.deepEqual(Reflect.ownKeys(consumer.currentRelease()), ["releaseProvenanceHash", "releaseAuthorityRoot", "candidatePartitionProofIssuerKeyId"]);
  assert.throws(() => issueRuntimeReleaseCandidatePartitionProofIssuer(value.authority, { ...implementation }), /not release-issued/);
  value.authority.rotate(value.binding);
  assert.throws(() => consumer.currentRelease(), /stale|rotation/);
  const next = issued();
  const nextConsumer = issueRuntimeReleaseCandidatePartitionProofIssuer(next.authority, issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: () => releaseProjection(next.binding),
    issue: () => { throw new Error("test issuer not called"); },
    verify: () => { throw new Error("test verifier not called"); },
  }) as unknown as CandidatePartitionProofIssuerPortV1));
  next.authority.revoke();
  assert.throws(() => nextConsumer.currentRelease(), /revoked/);
});

test("scheduler consumer binds registry, selected worker, session, and rejects foreign capabilities", () => {
  const value = issued();
  const worker = {
    workerEpoch: value.binding.workerEpoch,
    ...value.binding.selectedExecutor,
  };
  const capability = Object.freeze(Object.create(null));
  const implementation = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: value.binding.qualifiedExecutorRegistryRoot,
    authorityRoot: value.binding.executorAuthorityRoot,
    open: ({ worker: supplied }: { readonly worker: typeof worker }) => {
      const { workerEpoch: _suppliedEpoch, ...suppliedExecutor } = supplied;
      const { workerEpoch: _expectedEpoch, ...expectedExecutor } = worker;
      if (JSON.stringify(suppliedExecutor) !== JSON.stringify(expectedExecutor) || supplied.workerEpoch.length === 0) {
        throw new Error("worker mismatch");
      }
      return capability;
    },
    rotate: () => capability,
    revoke: () => undefined,
    assert: (supplied: object) => {
      if (supplied !== capability) throw new Error("unknown capability");
      return { authorityRoot: value.binding.executorAuthorityRoot, workerEpoch: value.binding.workerEpoch, executorSession: value.binding.executorSessionHash, version: 1 };
    },
    provenance: (supplied: object) => {
      if (supplied !== capability) throw new Error("unknown capability");
      return { authorityRoot: value.binding.executorAuthorityRoot, workerEpoch: value.binding.workerEpoch, executorSession: value.binding.executorSessionHash, version: 1 };
    },
  }));
  const consumer = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(value.authority, implementation);
  assert.deepEqual(consumer.provenance(capability), {
    authorityRoot: value.binding.executorAuthorityRoot,
    workerEpoch: value.binding.workerEpoch,
    executorSession: value.binding.executorSessionHash,
    version: 1,
  });
  assert.throws(() => consumer.provenance({ ...capability }), /unknown|not issued/);
  assert.throws(() => consumer.open({ worker: { ...worker, executableFingerprint: h("foreign-executable") } }), /selected runtime executor/);
  value.authority.rotate(value.binding);
  assert.throws(() => consumer.provenance(capability), /stale|rotation/);
});

function schedulerImplementation(value: ReturnType<typeof issued>) {
  const capability = Object.freeze(Object.create(null));
  const worker = { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor };
  const implementation = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: value.binding.qualifiedExecutorRegistryRoot,
    authorityRoot: value.binding.executorAuthorityRoot,
    open: () => capability,
    rotate: () => capability,
    revoke: () => undefined,
    assert: (supplied: object) => {
      if (supplied !== capability) throw new Error("unknown capability");
      return { authorityRoot: value.binding.executorAuthorityRoot, workerEpoch: worker.workerEpoch, executorSession: value.binding.executorSessionHash, version: 1 };
    },
    provenance: (supplied: object) => {
      if (supplied !== capability) throw new Error("unknown capability");
      return { authorityRoot: value.binding.executorAuthorityRoot, workerEpoch: worker.workerEpoch, executorSession: value.binding.executorSessionHash, version: 1 };
    },
  }));
  return implementation;
}

/** Test-only external Scheduler issuer: the runtime owner remains the real authority under test. */
function revmSchedulerImplementation(value: ReturnType<typeof issued>) {
  const worker = { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor };
  let sequence = 0;
  const states = new WeakMap<object, { readonly workerEpoch: string; readonly executorSession: Hash }>();
  const issue = (workerEpoch = worker.workerEpoch): QualifiedExecutorAuthorityCapability => {
    const capability = Object.freeze(Object.create(null)) as QualifiedExecutorAuthorityCapability;
    sequence += 1;
    states.set(capability, {
      workerEpoch,
      executorSession: h(`revm-worker-session:${sequence}`),
    });
    return capability;
  };
  const provenance = (capability: QualifiedExecutorAuthorityCapability) => {
    const state = states.get(capability);
    if (!state) throw new Error("unknown scheduler capability");
    return {
      authorityRoot: value.binding.executorAuthorityRoot,
      workerEpoch: state.workerEpoch,
      executorSession: state.executorSession,
      version: 1,
    };
  };
  return issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: value.binding.qualifiedExecutorRegistryRoot,
    authorityRoot: value.binding.executorAuthorityRoot,
    open: ({ worker: supplied }: { readonly worker: typeof worker }) => {
      const { workerEpoch: _suppliedEpoch, ...suppliedExecutor } = supplied;
      const { workerEpoch: _expectedEpoch, ...expectedExecutor } = worker;
      if (JSON.stringify(suppliedExecutor) !== JSON.stringify(expectedExecutor) || supplied.workerEpoch.length === 0) {
        throw new Error("worker mismatch");
      }
      return issue(supplied.workerEpoch);
    },
    rotate: (input: Parameters<QualifiedExecutorAuthorityIssuer["rotate"]>[0]) => issue(
      typeof input === "object" && input !== null && "worker" in input ? input.worker.workerEpoch : undefined,
    ),
    revoke: () => undefined,
    assert: provenance,
    provenance,
  }));
}

function candidateImplementation(value: ReturnType<typeof issued>) {
  const projection = releaseProjection(value.binding);
  return issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: () => projection,
    issue: () => { throw new Error("not exercised"); },
    verify: () => { throw new Error("not exercised"); },
  }) as unknown as CandidatePartitionProofIssuerPortV1);
}

const deploymentProofPort = () => issueDeploymentAttestationProofPort(Object.freeze({
  issueIdentity: (input: unknown) => input,
  verifyIdentity: (input: unknown) => input,
  issueOutcome: (input: unknown) => input,
  verifyOutcome: (input: unknown) => input,
}));

test("one private composition joins exact branded ports and exposes no generic authority", () => {
  const value = issued();
  const scheduler = schedulerImplementation(value);
  const schedulerCapability = scheduler.open({ worker: { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor } });
  const candidate = candidateImplementation(value);
  const proof = deploymentProofPort();
  const ports = composeRuntimeReleasePrivatePorts({
    authority: value.authority,
    attestationProofPort: proof,
    candidatePartitionProofIssuer: candidate,
    schedulerIssuer: scheduler,
    schedulerCapability,
  });
  assertRuntimeReleasePrivatePortsCurrent(ports);
  assert.deepEqual(Reflect.ownKeys(ports), ["attestationComposition", "candidatePartitionProofIssuer", "schedulerIssuer", "readyBinding"]);
  assert.equal("authority" in ports, false);
  assert.equal("resolver" in ports, false);
  assert.equal("signer" in ports, false);

  assert.throws(() => composeRuntimeReleasePrivatePorts({
    authority: value.authority,
    attestationProofPort: { ...proof },
    candidatePartitionProofIssuer: candidate,
    schedulerIssuer: scheduler,
    schedulerCapability,
  }), /deployment-issued/);
  assert.throws(() => composeRuntimeReleasePrivatePorts({
    authority: value.authority,
    attestationProofPort: proof,
    candidatePartitionProofIssuer: { ...candidate },
    schedulerIssuer: scheduler,
    schedulerCapability,
  }), /release-issued/);
  assert.throws(() => composeRuntimeReleasePrivatePorts({
    authority: value.authority,
    attestationProofPort: proof,
    candidatePartitionProofIssuer: candidate,
    schedulerIssuer: { ...scheduler },
    schedulerCapability,
  }), /not (?:release-)?issued/);

  value.authority.rotate(value.binding);
  assert.throws(() => assertRuntimeReleasePrivatePortsCurrent(ports), /stale|rotation/);
});

test("private composition is fail-closed after release revoke", () => {
  const value = issued();
  const scheduler = schedulerImplementation(value);
  const ports = composeRuntimeReleasePrivatePorts({
    authority: value.authority,
    attestationProofPort: deploymentProofPort(),
    candidatePartitionProofIssuer: candidateImplementation(value),
    schedulerIssuer: scheduler,
    schedulerCapability: scheduler.open({ worker: { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor } }),
  });
  value.authority.revoke();
  assert.throws(() => assertRuntimeReleasePrivatePortsCurrent(ports), /revoked/);
});

test("scheduler composition rejects a legal capability with a different epoch or session", () => {
  const value = issued();
  const scheduler = revmSchedulerImplementation(value);
  const worker = { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor };
  const initial = scheduler.open({ worker });
  // The capability is genuinely branded and the implementation is release
  // rooted, but its session is not the session signed into this release.
  assert.throws(
    () => composeRuntimeReleasePrivatePorts({
      authority: value.authority,
      attestationProofPort: deploymentProofPort(),
      candidatePartitionProofIssuer: candidateImplementation(value),
      schedulerIssuer: scheduler,
      schedulerCapability: initial,
    }),
    /initial capability|signed runtime release|worker\/session/,
  );
});

test("REVM owner issues exact release leases with fresh worker sessions and rejects foreign/cloned inputs", () => {
  const value = issued();
  const implementation = revmSchedulerImplementation(value);
  const scheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(value.authority, implementation);
  const worker = { workerEpoch: value.binding.workerEpoch, ...value.binding.selectedExecutor };
  const capabilityA = scheduler.open({ worker });
  const leaseA = issueRuntimeReleaseExecutorLeaseV1(value.authority, scheduler, capabilityA);
  const owner = issueRuntimeReleaseRevmWorkerAuthorityIssuer(value.authority, scheduler);
  const bindingA = owner.issue();
  const bindingB = owner.issue();

  assert.equal(bindingA.authorityRoot, value.binding.executorAuthorityRoot);
  assert.ok(bindingA.workerEpoch.startsWith(`${value.binding.workerEpoch}/`));
  assert.ok(bindingB.workerEpoch.startsWith(`${value.binding.workerEpoch}/`));
  assert.notEqual(bindingA.workerEpoch, bindingB.workerEpoch);
  assert.equal(bindingA.release.bindingId, value.binding.bindingId);
  assert.equal(bindingA.release.releaseProvenanceHash, runtimeReleaseBindingProvenanceHash(value.binding));
  assert.notEqual(bindingA.executorSessionHash, bindingB.executorSessionHash);
  assert.equal(leaseA.workerEpoch, value.binding.workerEpoch);
  assert.notEqual(leaseA.executorSessionHash, bindingA.executorSessionHash);
  owner.assertCurrent(bindingA);
  owner.assertCurrent(bindingB);

  assert.throws(
    () => issueRuntimeReleaseRevmWorkerAuthorityIssuer(value.authority, { ...scheduler }),
    /not release-issued/,
  );
  assert.throws(
    () => issueRuntimeReleaseExecutorLeaseV1(value.authority, scheduler, { ...capabilityA }),
    /unknown|not issued|stale|revoked/,
  );
  assert.throws(
    () => issueRuntimeReleaseExecutorLeaseV1(value.authority, scheduler, Object.freeze(Object.create(null))),
    /unknown|not issued|stale|revoked/,
  );
  assert.throws(
    () => owner.assertCurrent({ ...bindingA, workerEpoch: "foreign-epoch" } as RevmWorkerAuthorityBindingV1),
    /stale|issued|mismatch/,
  );
});

test("REVM owner rejects a scheduler from another release and fences replacement after rotation/revoke", () => {
  const value = issued();
  const foreign = issued();
  const foreignScheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(
    foreign.authority,
    revmSchedulerImplementation(foreign),
  );
  assert.throws(
    () => issueRuntimeReleaseRevmWorkerAuthorityIssuer(value.authority, foreignScheduler),
    /runtime release|match|bound/,
  );

  const scheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(value.authority, revmSchedulerImplementation(value));
  const owner = issueRuntimeReleaseRevmWorkerAuthorityIssuer(value.authority, scheduler);
  const binding = owner.issue();
  value.authority.rotate(value.binding);
  assert.throws(() => owner.issue(), /stale|rotation/);
  assert.throws(() => owner.assertCurrent(binding), /stale|rotation/);

  const revoked = issued();
  const revokedScheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(revoked.authority, revmSchedulerImplementation(revoked));
  const revokedOwner = issueRuntimeReleaseRevmWorkerAuthorityIssuer(revoked.authority, revokedScheduler);
  const revokedBinding = revokedOwner.issue();
  revoked.authority.revoke();
  assert.throws(() => revokedOwner.issue(), /revoked/);
  assert.throws(() => revokedOwner.assertCurrent(revokedBinding), /revoked/);
});
