import assert from "node:assert/strict";
import test from "node:test";
import type { Hash } from "../../canonical-codec/src/index.ts";
import { RevmWorkerPool } from "../../../runtime/revm-workers/src/lifecycle.ts";
import {
  captureRevmWorkerResourceObservation,
  issueRevmWorkerResourceObservationPort,
  readRevmWorkerResourceObservation,
} from "../../../runtime/revm-workers/src/internal/resource-observation.ts";
import { createTestRevmAuthorityIssuer } from "../../../runtime/revm-workers/test/qualified-authority.ts";
import {
  abortProcessResourceObservationClaim,
  claimProcessResourceObservation,
  commitProcessResourceObservationClaim,
  ProcessResourceObserver,
  ProcessResourceObservationSamplePendingError,
  readClaimedProcessResourceObservation,
  readProcessResourceObservation,
  validateProcessResourceObservationValue,
} from "../src/index.ts";
import { createProcessResourceScopeOwner } from "../src/internal/scope-owner.ts";

const qualification = { engineBuildFingerprint: "revm-build-resource", executableFingerprint: "revm-executable-resource" } as const;
const idleFactory = { spawn: async () => { throw new Error("resource contract test must not spawn a worker"); } };

function hash(character: string): Hash {
  return `0x${character.repeat(64)}` as Hash;
}

function pool(): RevmWorkerPool {
  return new RevmWorkerPool({
    factory: idleFactory,
    authority: createTestRevmAuthorityIssuer(),
    qualification,
    maxWorkers: 1,
  });
}

function scopeOwner(seed = "1") {
  return createProcessResourceScopeOwner({
    processLogAnchorHash: hash(seed),
    windowId: hash(seed === "1" ? "2" : "3"),
    generationId: `generation-${seed}`,
  });
}

async function waitForEventLoopSample(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 8));
}

test("a physical sample pending seal preserves the exact active handle for retry", async () => {
  const owner = scopeOwner("d");
  const firstScope = owner.issueHeadScope({ admissionId: hash("e"), ordinal: "1" });
  const secondScope = owner.issueHeadScope({ admissionId: hash("f"), ordinal: "2" });
  const observer = new ProcessResourceObserver({
    scopeReaderPort: owner.scopeReaderPort,
    workerResourcePort: issueRevmWorkerResourceObservationPort(pool()),
  });
  const reader = observer.issueReaderPort();
  const handle = observer.open(firstScope);

  assert.throws(
    () => observer.seal(handle, firstScope),
    error => error instanceof ProcessResourceObservationSamplePendingError,
  );
  assert.throws(() => observer.open(secondScope), /overlaps an active sample/);

  await waitForEventLoopSample();
  const capability = observer.seal(handle, firstScope);
  const fact = readProcessResourceObservation(reader, capability);
  assert.equal(BigInt(fact.eventLoopObservationCount) > 0n, true);
  assert.equal(fact.sampleSequence, "0");
});

test("real process and bound worker-pool facts seal into one exact consumable capability", async () => {
  const owner = scopeOwner();
  const headScope = owner.issueHeadScope({ admissionId: hash("4"), ordinal: "1" });
  const workerPort = issueRevmWorkerResourceObservationPort(pool());
  const observer = new ProcessResourceObserver({ scopeReaderPort: owner.scopeReaderPort, workerResourcePort: workerPort });
  const reader = observer.issueReaderPort();
  const handle = observer.open(headScope);
  await waitForEventLoopSample();
  const capability = observer.seal(handle, headScope);
  const fact = readProcessResourceObservation(reader, capability);

  assert.equal(fact.scope.processLogAnchorHash, hash("1"));
  assert.equal(fact.scope.admissionId, hash("4"));
  assert.equal(fact.scope.ordinal, "1");
  assert.equal(fact.sampleSequence, "0");
  assert.equal(fact.workerRestart.workerCount, "0");
  assert.equal(fact.workerRestart.restarted, "0");
  assert.equal(fact.workerRestart.orphanedWorkers, "0");
  assert.equal(BigInt(fact.eventLoopObservationCount) > 0n, true);
  assert.equal(BigInt(fact.sealedMonotonicNs) > BigInt(fact.openedMonotonicNs), true);
  assert.equal(BigInt(fact.cpuMemoryEventLoop.cpuUtilizationBasisPoints) <= 10_000n, true);
  assert.equal(BigInt(fact.cpuMemoryEventLoop.rssBytes) > 0n, true);
  assert.deepEqual(validateProcessResourceObservationValue(structuredClone(fact)), fact);
  assert.throws(
    () => validateProcessResourceObservationValue({ ...structuredClone(fact), elapsedUs: "0" }),
    /elapsed time mismatch|identity mismatch/,
  );
  assert.throws(() => readProcessResourceObservation(reader, capability), /already consumed/);
});

test("raw DTOs and structural clones never acquire scope, handle, or evidence authority", async () => {
  const owner = scopeOwner();
  const firstScope = owner.issueHeadScope({ admissionId: hash("5"), ordinal: "1" });
  const secondScope = owner.issueHeadScope({ admissionId: hash("6"), ordinal: "2" });
  const observer = new ProcessResourceObserver({
    scopeReaderPort: owner.scopeReaderPort,
    workerResourcePort: issueRevmWorkerResourceObservationPort(pool()),
  });
  const reader = observer.issueReaderPort();
  const handle = observer.open(firstScope);
  assert.throws(() => observer.open(secondScope), /overlaps/);
  assert.throws(() => observer.seal(handle, secondScope), /scope changed/);
  assert.throws(() => observer.seal({ ...handle } as never, firstScope), /belongs to another observer/);
  await waitForEventLoopSample();
  const capability = observer.seal(handle, firstScope);
  const fact = readProcessResourceObservation(reader, capability);
  assert.throws(() => observer.open({ ...firstScope } as never), /not owner-issued/);
  assert.throws(() => readProcessResourceObservation(reader, { ...fact } as never), /not owner-issued/);
  assert.throws(() => readProcessResourceObservation({ ...reader } as never, capability), /not owner-issued/);
});

test("cross-owner scopes and cross-observer evidence fail closed", async () => {
  const ownerA = scopeOwner("7");
  const ownerB = scopeOwner("8");
  const scopeA = ownerA.issueHeadScope({ admissionId: hash("9"), ordinal: "1" });
  const scopeB = ownerB.issueHeadScope({ admissionId: hash("a"), ordinal: "1" });
  const observerA = new ProcessResourceObserver({ scopeReaderPort: ownerA.scopeReaderPort, workerResourcePort: issueRevmWorkerResourceObservationPort(pool()) });
  const observerB = new ProcessResourceObserver({ scopeReaderPort: ownerB.scopeReaderPort, workerResourcePort: issueRevmWorkerResourceObservationPort(pool()) });
  const readerA = observerA.issueReaderPort();
  const readerB = observerB.issueReaderPort();
  assert.throws(() => observerA.open(scopeB), /another owner/);
  const handle = observerA.open(scopeA);
  await waitForEventLoopSample();
  const capability = observerA.seal(handle, scopeA);
  assert.throws(() => readProcessResourceObservation(readerB, capability), /another observer/);
  const fact = readProcessResourceObservation(readerA, capability);
  assert.equal(fact.scope.generationId, "generation-7");
});

test("resource observation claim aborts for retry and commits exactly once", async () => {
  const owner = scopeOwner("b");
  const scope = owner.issueHeadScope({ admissionId: hash("c"), ordinal: "1" });
  const observer = new ProcessResourceObserver({ scopeReaderPort: owner.scopeReaderPort, workerResourcePort: issueRevmWorkerResourceObservationPort(pool()) });
  const reader = observer.issueReaderPort();
  const handle = observer.open(scope);
  await waitForEventLoopSample();
  const capability = observer.seal(handle, scope);

  const firstClaim = claimProcessResourceObservation(reader, capability);
  const firstFact = readClaimedProcessResourceObservation(reader, firstClaim);
  assert.throws(() => claimProcessResourceObservation(reader, capability), /already claimed/);
  abortProcessResourceObservationClaim(reader, firstClaim);
  assert.throws(() => readClaimedProcessResourceObservation(reader, firstClaim), /not active|aborted/);

  const retryClaim = claimProcessResourceObservation(reader, capability);
  assert.equal(readClaimedProcessResourceObservation(reader, retryClaim), firstFact);
  commitProcessResourceObservationClaim(reader, retryClaim);
  assert.throws(() => claimProcessResourceObservation(reader, capability), /already consumed/);
  assert.throws(() => commitProcessResourceObservationClaim(reader, retryClaim), /already consumed|not active/);
});

test("worker resource port rejects raw, cloned, and cross-pool capabilities", () => {
  const portA = issueRevmWorkerResourceObservationPort(pool());
  const portB = issueRevmWorkerResourceObservationPort(pool());
  const capabilityA = captureRevmWorkerResourceObservation(portA);
  assert.throws(() => readRevmWorkerResourceObservation(portB, capabilityA), /another pool/);
  const fact = readRevmWorkerResourceObservation(portA, capabilityA);
  assert.equal(fact.workerCount, "0");
  assert.throws(() => readRevmWorkerResourceObservation(portA, capabilityA), /already consumed/);
  assert.throws(() => readRevmWorkerResourceObservation({ ...portA }, captureRevmWorkerResourceObservation(portB)), /not owner-issued/);
  assert.throws(() => readRevmWorkerResourceObservation(portA, { ...fact } as never), /not owner-issued/);
  assert.throws(() => issueRevmWorkerResourceObservationPort({ snapshot: () => ({}) } as never), /real worker pool/);
});
