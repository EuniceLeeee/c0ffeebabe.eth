import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createPendingEvidenceSession } from "../pending-evidence-session.js";
import { PendingEvidenceTaskScheduler } from "../pending-evidence-admission-queue.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import type {
  PendingTransactionEvidenceInput,
  SwapAdapter,
} from "../venues/route-leg-adapter.js";
import { univ2StandardAdapter } from "../venues/swaps/univ2-standard.js";
import { univ3StandardAdapter } from "../venues/swaps/univ3-standard.js";

const familyA = {
  ...univ2StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: () => true,
    observe: () => ({ canonicalPayload: "0xaa" }),
  },
} satisfies SwapAdapter;
const familyB = {
  ...univ3StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: () => true,
    observe: () => ({ canonicalPayload: "0xbb" }),
  },
} satisfies SwapAdapter;
const projection = new AdapterFamilyRegistry([
  familyA,
  familyB,
]).pendingTransactionEvidence();

const observerScheduler = new PendingEvidenceTaskScheduler(1, 1);
const readScheduler = new PendingEvidenceTaskScheduler(1, 1);
let releaseRunningFamilyA!: () => void;
const runningFamilyA = observerScheduler.run(
  "unknown",
  () => new Promise<void>((resolve) => {
    releaseRunningFamilyA = resolve;
  }),
  "univ2-standard",
);
const queuedFamilyA = observerScheduler.run(
  "unknown",
  async () => {},
  "univ2-standard",
);

let headReads = 0;
const failures: string[] = [];
const head = Object.freeze({
  number: 123,
  hash: `0x${"11".repeat(32)}`,
});
const session = createPendingEvidenceSession(
  {
    hash: `0x${"22".repeat(32)}`,
    to: "0x0000000000000000000000000000000000000001",
    data: "0x1234",
  },
  {} as ethers.JsonRpcProvider,
  projection,
  observerScheduler,
  readScheduler,
  async () => {
    headReads += 1;
    return head;
  },
  100,
  1,
  (familyId, code) => failures.push(`${familyId}:${code}`),
);

const resolved = session.resolve(
  ["univ2-standard", "univ3-standard"],
  "unknown",
);
await turn();
await turn();
releaseRunningFamilyA();

const evidence = await resolved;
await Promise.all([runningFamilyA, queuedFamilyA]);

assert.deepEqual(
  evidence.map((item) => item.familyId),
  ["univ3-standard"],
  "one full family scheduler lane must not reject a healthy sibling family",
);
assert.deepEqual(
  failures,
  ["univ2-standard:unknown_queue_full"],
  "scheduler rejection must stay attributed to only the saturated family",
);
assert.equal(
  headReads,
  1,
  "all family observations in one session must share one frozen head",
);
assert(
  Object.isFrozen(evidence) && Object.isFrozen(evidence[0]),
  "scheduler isolation must preserve immutable evidence",
);

// The rejected family remains memoized as a rejected observation for this
// transaction; retrying resolve must not issue a second head read or silently
// consume the now-free scheduler lane.
const retried = await session.resolve(
  ["univ2-standard", "univ3-standard"],
  "unknown",
);
assert.deepEqual(
  retried.map((item) => item.familyId),
  ["univ3-standard"],
  "one transaction session must keep a stable per-family outcome",
);
assert.equal(headReads, 1, "a session retry must retain its original head");

console.log("pending-evidence-session PASS");

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Compile-time guard: the production session input remains a family-neutral
// pending-transaction shape rather than a protocol-specific fixture.
const _familyNeutralInput: PendingTransactionEvidenceInput = {
  hash: `0x${"33".repeat(32)}`,
  to: null,
  data: "0x",
};
void _familyNeutralInput;
