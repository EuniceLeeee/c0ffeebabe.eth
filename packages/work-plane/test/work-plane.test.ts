import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkScheduler,
  createQualifiedExecutorRegistry,
} from "../../scheduler/src/index.ts";
import {
  createTestQualifiedExecutorAuthorityIssuer,
  testReleaseApprovalPort,
} from "../../scheduler/test/fixtures/qualified-release.ts";
import { issueQualifiedSharedSchedulerRuntimePort } from "../../scheduler/src/internal/shared-runtime-owner.ts";
import { hashDomain } from "../../canonical-codec/src/index.ts";
import * as publicWorkPlane from "../src/index.ts";
import {
  WorkPlane,
  type CapabilityWorkIntentV1,
} from "../src/index.ts";
import {
  createSchedulerOwnedFamilyExecutionPort,
  issueQualifiedPhysicalExecutionPort,
} from "../src/internal/family-execution-port.ts";
import { issueTestWorkPlaneCallerCapability } from "./fixtures/caller-authority.ts";

const source = { chainId: "1", number: "100", hash: "hash", stateRoot: "state" } as const;
const programInput = { amount: 1 } as const;
const unusedRawEvidence = Object.freeze({
  read(): Uint8Array { throw new TypeError("unused raw evidence"); },
});
const intent: CapabilityWorkIntentV1 = {
  intentId: "intent-1",
  ownerRef: "opaque-owner",
  capabilityRef: "opaque-capability",
  workClassRef: "opaque-class",
  phase: "opaque-phase",
  source,
  generationLeaseRef: { ref: "lease-1", source, generation: "generation-1" },
  frozenProgramRef: { ref: "program-1", schemaHash: "schema-1", programHash: "program-hash", programInputHash: hashDomain("aloha/work-plane-program-input/v1", programInput), issuerRef: "issuer-1" },
  programInputRef: "input-1",
  consumerDeadline: performance.now() + 1_000,
  programInput,
};

test("public work-plane entrypoint exposes no caller authority issuer", () => {
  assert.equal("createCallerAuthority" in publicWorkPlane, false);
  assert.equal("issueWorkPlaneCallerCapability" in publicWorkPlane, false);
});

test("work plane consumes an owner-issued caller capability, schedules, fences and seals receipt", async () => {
  const scheduler = new WorkScheduler();
  const caller = issueTestWorkPlaneCallerCapability({ scheduler, intent });
  const seen: string[] = [];
  const plane = new WorkPlane({
    scheduler,
    resolveWorkClass: (value) => ({ phase: value.phase, lane: "startup-RPC-fast", resource: "rpc", quotaKey: "opaque-quota" }),
    decodeIntent: () => undefined,
    assertMembership: ({ ownerRef, capabilityRef, workClassRef }) => {
      seen.push(`${ownerRef}:${capabilityRef}:${workClassRef}`);
    },
    fence: { assertCurrent: ({ source: current }) => assert.deepEqual(current, source) },
    execute: async ({ intent: received, permit }) => {
      permit.assertWork(String(received.intentId));
      assert.equal(received.programInputRef, "input-1");
      return { raw: true };
    },
    interpret: ({ result }) => result.raw,
  });
  const outcome = await plane.execute({ intent, caller });
  assert.equal(outcome.kind, "resolved");
  if (outcome.kind === "resolved") {
    assert.equal(outcome.fact, true);
    assert.match(outcome.receipt.callerId, /^0x[0-9a-f]{64}$/);
    assert.match(outcome.receipt.authorityTokenHash, /^0x[0-9a-f]{64}$/);
    assert.equal(outcome.receipt.permitId !== null, true);
    assert.equal(outcome.receipt.failureCode, null);
  }
  assert.deepEqual(seen, ["opaque-owner:opaque-capability:opaque-class"]);
});

test("forged, cloned, cross-intent and cross-scheduler caller capabilities fail closed before execution", async () => {
  const scheduler = new WorkScheduler();
  let executions = 0;
  const plane = new WorkPlane({
    scheduler,
    resolveWorkClass: (value) => ({ phase: value.phase, lane: "startup-RPC-fast", resource: "rpc" }),
    decodeIntent: () => undefined,
    assertMembership: () => undefined,
    fence: { assertCurrent: () => undefined },
    execute: async () => { executions += 1; return "should-not-run"; },
    interpret: ({ result }) => result,
  });
  const genuine = issueTestWorkPlaneCallerCapability({ scheduler, intent });
  const otherIntent = Object.freeze({ ...intent, intentId: "intent-other" });
  const cases: readonly unknown[] = [
    { callerId: "forged", authorityToken: "forged" },
    Object.freeze({ ...genuine }),
    new Proxy(genuine, {}),
    issueTestWorkPlaneCallerCapability({ scheduler, intent: otherIntent }),
    issueTestWorkPlaneCallerCapability({ scheduler: new WorkScheduler(), intent }),
  ];
  for (const caller of cases) {
    const outcome = await plane.execute({ intent, caller: caller as never });
    assert.equal(outcome.kind, "unresolved");
    if (outcome.kind === "unresolved") {
      assert.equal(outcome.failure.stage, "authority");
      assert.equal(outcome.failure.code, "caller-mismatch");
      assert.equal(outcome.failure.retryClass, "invalid-program");
      assert.equal(outcome.receipt.callerId, "invalid");
    }
  }
  assert.equal(executions, 0);
});

test("program input is canonicalized, deeply frozen, and hash-bound", async () => {
  const mutableInput = { nested: { amount: 7 } };
  const frozenIntent: CapabilityWorkIntentV1 = {
    ...intent,
    intentId: "intent-freeze",
    programInput: mutableInput,
    frozenProgramRef: {
      ...intent.frozenProgramRef,
      programInputHash: hashDomain("aloha/work-plane-program-input/v1", mutableInput),
    },
  };
  let seenInput!: CapabilityWorkIntentV1["programInput"];
  const scheduler = new WorkScheduler();
  const caller = issueTestWorkPlaneCallerCapability({ scheduler, intent: frozenIntent });
  const plane = new WorkPlane({
    scheduler,
    resolveWorkClass: (value) => ({ phase: value.phase, lane: "startup-RPC-fast", resource: "rpc" }),
    decodeIntent: () => undefined,
    assertMembership: ({ programIssuerRef }) => assert.equal(programIssuerRef, "issuer-1"),
    fence: { assertCurrent: () => undefined },
    execute: async ({ intent: value }) => { seenInput = value.programInput; return true; },
    interpret: ({ result }) => result,
  });
  const outcome = await plane.execute({ intent: frozenIntent, caller });
  assert.equal(outcome.kind, "resolved");
  assert.equal(Object.isFrozen(seenInput), true);
  assert.equal(Object.isFrozen((seenInput as { nested: object }).nested), true);
  assert.throws(() => ((seenInput as { nested: { amount: number } }).nested.amount = 8));
  mutableInput.nested.amount = 99;
  assert.equal((seenInput as { nested: { amount: number } }).nested.amount, 7);
});

test("program input hash mutation is an invalid program before execution", async () => {
  const scheduler = new WorkScheduler();
  const plane = new WorkPlane({
    scheduler,
    resolveWorkClass: (value) => ({ phase: value.phase, lane: "startup-RPC-fast", resource: "rpc" }),
    decodeIntent: () => undefined,
    assertMembership: () => undefined,
    fence: { assertCurrent: () => undefined },
    execute: async () => { throw new Error("must not execute"); },
    interpret: ({ result }) => result,
  });
  const outcome = await plane.execute({ intent: { ...intent, intentId: "intent-bad-input", frozenProgramRef: { ...intent.frozenProgramRef, programInputHash: "0xbad" } }, caller: undefined as never });
  assert.equal(outcome.kind, "unresolved");
  if (outcome.kind === "unresolved") assert.equal(outcome.failure.code, "invalid-intent");
});

test("unknown intent fields and malformed caller input fail closed with a terminal receipt", async () => {
  const plane = new WorkPlane({
    scheduler: new WorkScheduler(),
    resolveWorkClass: (value) => ({ phase: value.phase, lane: "startup-RPC-fast", resource: "rpc" }),
    decodeIntent: () => undefined,
    assertMembership: () => undefined,
    fence: { assertCurrent: () => undefined },
    execute: async () => { throw new Error("must not execute"); },
    interpret: ({ result }) => result,
  });
  const outcome = await plane.execute({ intent: { ...intent, intentId: "intent-extra", extra: true } as never, caller: undefined as never });
  assert.equal(outcome.kind, "unresolved");
  if (outcome.kind === "unresolved") {
    assert.equal(outcome.failure.code, "invalid-intent");
    assert.equal(outcome.receipt.outcome, "unresolved");
    assert.equal(outcome.receipt.callerId, "invalid");
  }
});

test("Family receives only a stamped read-only fact view from the scheduler-owned port", async () => {
  const registry = createQualifiedExecutorRegistry({
    executorKind: "revm",
    engineBuildFingerprint: "0x1111111111111111111111111111111111111111111111111111111111111111",
    executableFingerprint: "0x2222222222222222222222222222222222222222222222222222222222222222",
    closureFingerprint: "0x3333333333333333333333333333333333333333333333333333333333333333",
    protocolFingerprint: "0x4444444444444444444444444444444444444444444444444444444444444444",
    schemaFingerprint: "0x5555555555555555555555555555555555555555555555555555555555555555",
    releaseRoleManifestRoot: "0x6666666666666666666666666666666666666666666666666666666666666666",
    candidateCommit: "0123456789abcdef0123456789abcdef01234567",
  });
  const entry = registry.entries[0]!;
  const issuer = createTestQualifiedExecutorAuthorityIssuer(registry, testReleaseApprovalPort(registry, entry.releaseRoleManifestRoot, entry.candidateCommit));
  const capability = issuer.open({ worker: { ...entry, workerEpoch: "epoch-family" } as never });
  const schedulerRuntime = issueQualifiedSharedSchedulerRuntimePort({ scheduler: new WorkScheduler(), issuer, capability });
  const fakeIssuers: readonly unknown[] = [
    { ...issuer },
    new Proxy(issuer, {}),
    JSON.parse(JSON.stringify({ registryRoot: issuer.registryRoot, authorityRoot: issuer.authorityRoot })),
    {
      registryRoot: issuer.registryRoot,
      authorityRoot: issuer.authorityRoot,
      open: issuer.open,
      rotate: issuer.rotate,
      revoke: issuer.revoke,
      assert: issuer.assert,
      provenance: issuer.provenance,
    },
  ];
  for (const fakeIssuer of fakeIssuers) {
    assert.throws(
      () => issueQualifiedPhysicalExecutionPort({
        issuer: fakeIssuer as never,
        capability,
        schedulerRuntime,
        execute: async () => ({ nested: { value: 7 } }),
      }),
      /not release-issued/,
    );
  }
  const secondIssuer = createTestQualifiedExecutorAuthorityIssuer(registry, testReleaseApprovalPort(registry, entry.releaseRoleManifestRoot, entry.candidateCommit));
  const secondCapability = secondIssuer.open({ worker: { ...entry, workerEpoch: "epoch-other" } as never });
  const secondSchedulerRuntime = issueQualifiedSharedSchedulerRuntimePort({ scheduler: new WorkScheduler(), issuer: secondIssuer, capability: secondCapability });
  const crossPhysicalPort = issueQualifiedPhysicalExecutionPort({
    issuer: secondIssuer,
    capability: secondCapability,
    schedulerRuntime: secondSchedulerRuntime,
    execute: async () => ({ nested: { value: 7 } }),
  });
  assert.throws(() => createSchedulerOwnedFamilyExecutionPort({
    issuer,
    capability,
    physicalExecution: crossPhysicalPort,
  }), /not bound to this qualified executor/);
  const physicalExecution = issueQualifiedPhysicalExecutionPort({
    issuer,
    capability,
    schedulerRuntime,
    execute: async ({ intent: received }) => {
      assert.equal(received.source.hash, source.hash);
      return { nested: { value: 7 } };
    },
  });
  const port = createSchedulerOwnedFamilyExecutionPort({
    issuer,
    capability,
    physicalExecution,
  });
  assert.equal("scheduler" in port, false);
  assert.equal("issuer" in port, false);
  const result = await port.executeFrozenProgram({ intent, rawEvidence: unusedRawEvidence, attemptId: "attempt-family" });
  assert.equal(result.authorityRoot, issuer.authorityRoot);
  assert.equal(result.workerEpoch, "epoch-family");
  assert.equal(result.executorSession.startsWith("0x"), true);
  assert.equal(result.executionSessionHash.startsWith("0x"), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.fact), true);
  assert.equal(Object.isFrozen((result.fact as { nested: object }).nested), true);
  const second = await port.executeFrozenProgram({ intent, rawEvidence: unusedRawEvidence, attemptId: "attempt-family" });
  assert.notEqual(second.executionSessionHash, result.executionSessionHash);
  issuer.rotate({ worker: { ...entry, workerEpoch: "epoch-next" } as never });
  await assert.rejects(port.executeFrozenProgram({ intent, rawEvidence: unusedRawEvidence, attemptId: "attempt-family" }), /stale|revoked/);
  issuer.revoke();
  await assert.rejects(port.executeFrozenProgram({ intent, rawEvidence: unusedRawEvidence, attemptId: "attempt-family" }), /revoked/);
});
