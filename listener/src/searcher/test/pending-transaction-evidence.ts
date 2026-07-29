import { ethers } from "ethers";
import {
  PendingEvidenceAdmissionQueue,
  PendingEvidenceHeadSnapshot,
  PendingEvidenceTaskScheduler,
} from "../pending-evidence-admission-queue.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import type {
  PendingTransactionEvidenceInput,
  SwapAdapter,
} from "../venues/route-leg-adapter.js";
import { univ2StandardAdapter } from "../venues/swaps/univ2-standard.js";
import { univ3StandardAdapter } from "../venues/swaps/univ3-standard.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const txHash = (byte: string): string => `0x${byte.repeat(64)}`;
const head = Object.freeze({
  number: 123,
  hash: txHash("1"),
});
const input = (
  hash: string,
  data = "0x1234",
): PendingTransactionEvidenceInput => ({
  hash,
  to: "0x0000000000000000000000000000000000000001",
  data,
});

let transportCalls = 0;
const transport = Object.freeze({
  head,
  async call(
    _read: { readonly to: string; readonly data: string },
    control: { readonly signal: AbortSignal },
  ) {
    transportCalls += 1;
    assert(!control.signal.aborted, "transport call must receive a live signal");
    return "0x";
  },
});

const calls: string[] = [];
const failingAdapter = {
  ...univ2StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: () => true,
    observe(tx: PendingTransactionEvidenceInput) {
      calls.push(`failing:${tx.hash}`);
      assert(Object.isFrozen(tx), "observer input must be immutable");
      throw new Error(`transaction-specific-${tx.hash}`);
    },
  },
} satisfies SwapAdapter;
const healthyAdapter = {
  ...univ3StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: (tx: PendingTransactionEvidenceInput) => tx.data === "0x1234",
    async observe(
      tx: PendingTransactionEvidenceInput,
      context: {
        readonly head: { readonly hash: string };
        call(read: { to: string; data: string }): Promise<string>;
      },
    ) {
      calls.push(`healthy:${tx.to}:${tx.data}`);
      assert(Object.isFrozen(tx), "observer input must be immutable");
      assert(Object.isFrozen(context), "observer context must be immutable");
      assert(Object.isFrozen(context.head), "observer head must be immutable");
      await context.call({ to: tx.to!, data: "0x" });
      return { canonicalPayload: "0x1234" };
    },
  },
} satisfies SwapAdapter;

const registry = new AdapterFamilyRegistry([failingAdapter, healthyAdapter]);
const evidence = registry.pendingTransactionEvidence();
assert(Object.isFrozen(evidence), "evidence projection must be immutable");
assert(Object.isFrozen(evidence.familyIds), "family ids must be immutable");
assert(
  evidence.candidateFamilyIds(input(txHash("a"))).join(",") ===
    "univ2-standard,univ3-standard",
  "pure prefilter must select matching families in registry order",
);

const result = await evidence.observe(
  input(txHash("a")),
  transport,
  { timeoutMs: 100, maxReadsPerFamily: 2 },
);
assert(
  calls.join(",") ===
    `failing:${txHash("a")},healthy:0x0000000000000000000000000000000000000001:0x1234`,
  "one observer failure must not stop a healthy family",
);
assert(
  result.successfulFamilyIds.join(",") === "univ3-standard",
  "dispatch must report successful observers",
);
assert(
  result.matched && result.evidence.length === 1,
  "healthy evidence must promote the transaction",
);
const match = result.evidence[0];
assert(match.familyId === "univ3-standard", "registry must bind family id");
assert(match.txHash === txHash("a"), "registry must bind normalized tx hash");
assert(
  match.headBlockNumber === head.number && match.headHash === head.hash,
  "registry must bind one frozen canonical head",
);
assert(
  match.payloadHash === ethers.keccak256("0x1234"),
  "registry must hash canonical payload",
);
assert(
  Object.isFrozen(result) &&
    Object.isFrozen(result.evidence) &&
    Object.isFrozen(match) &&
    Object.isFrozen(result.failures),
  "dispatch evidence must be deeply immutable",
);
assert(
  result.failures.length === 1 &&
    result.failures[0].familyId === "univ2-standard" &&
    result.failures[0].code === "observer_error",
  "raw family errors must collapse to a stable bounded code",
);

const nonMatch = await evidence.observe(
  input(txHash("b"), "0x"),
  transport,
  { timeoutMs: 100, maxReadsPerFamily: 2 },
);
assert(
  !nonMatch.matched &&
    nonMatch.evidence.length === 0 &&
    nonMatch.attemptedFamilyIds.join(",") === "univ2-standard,univ3-standard",
  "false prefilter/observer results must remain ordinary non-matches",
);

const empty = new AdapterFamilyRegistry([
  univ2StandardAdapter,
]).pendingTransactionEvidence();
transportCalls = 0;
assert(
  empty.candidateFamilyIds(input(txHash("c"))).length === 0,
  "families without the optional capability must not nominate transactions",
);
const emptyResult = await empty.observe(input(txHash("c")), transport);
assert(
  empty.familyIds.length === 0 &&
    emptyResult.attemptedFamilyIds.length === 0 &&
    emptyResult.evidence.length === 0 &&
    transportCalls === 0,
  "zero observers must perform zero transport calls",
);

let invalidError = "";
try {
  new AdapterFamilyRegistry([{
    ...univ2StandardAdapter,
    pendingTransactionEvidence: { observe: () => null },
  } as unknown as SwapAdapter]);
} catch (error) {
  invalidError = error instanceof Error ? error.message : String(error);
}
assert(
  invalidError.includes("requires mightMatch + observe"),
  `invalid observer must fail registry construction, got: ${invalidError}`,
);

const invalidResult = await new AdapterFamilyRegistry([{
  ...univ2StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: () => true,
    observe: () => ({ canonicalPayload: "not-hex" }),
  },
} satisfies SwapAdapter]).pendingTransactionEvidence().observe(
  input(txHash("d")),
  transport,
);
assert(
  invalidResult.failures[0]?.code === "invalid_result",
  "invalid family payload must be isolated",
);

let hungSignal: AbortSignal | undefined;
const hung = {
  ...univ2StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: () => true,
    observe(
      _tx: PendingTransactionEvidenceInput,
      context: { readonly signal: AbortSignal },
    ) {
      hungSignal = context.signal;
      return new Promise<null>(() => {});
    },
  },
} satisfies SwapAdapter;
const fast = {
  ...univ3StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: () => true,
    observe: () => ({ canonicalPayload: "0xab" }),
  },
} satisfies SwapAdapter;
const startedAt = Date.now();
const bounded = await new AdapterFamilyRegistry([
  hung,
  fast,
]).pendingTransactionEvidence().observe(
  input(txHash("e")),
  transport,
  { timeoutMs: 25, maxReadsPerFamily: 1 },
);
assert(Date.now() - startedAt < 250, "hung observer must settle at its deadline");
assert(hungSignal?.aborted, "hung observer must receive cancellation");
assert(
  bounded.evidence[0]?.familyId === "univ3-standard" &&
    bounded.failures[0]?.code === "deadline",
  "healthy sibling must survive a hung observer",
);

const overBudget = {
  ...univ2StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: () => true,
    async observe(
      _tx: PendingTransactionEvidenceInput,
      context: { call(read: { to: string; data: string }): Promise<string> },
    ) {
      await context.call({
        to: "0x0000000000000000000000000000000000000001",
        data: "0x",
      });
      await context.call({
        to: "0x0000000000000000000000000000000000000001",
        data: "0x",
      });
      return { canonicalPayload: "0xab" };
    },
  },
} satisfies SwapAdapter;
const budgeted = await new AdapterFamilyRegistry([
  overBudget,
]).pendingTransactionEvidence().observe(
  input(txHash("f")),
  transport,
  { timeoutMs: 100, maxReadsPerFamily: 1 },
);
assert(
  budgeted.failures[0]?.code === "read_budget",
  "family reads must be capped independently",
);

const subjectOnly = await registry.pendingTransactionEvidence().observe(
  input(txHash("0")),
  transport,
  {
    familyIds: ["univ3-standard"],
    timeoutMs: 100,
    maxReadsPerFamily: 2,
  },
);
assert(
  subjectOnly.attemptedFamilyIds.join(",") === "univ3-standard" &&
    subjectOnly.failures.length === 0,
  "replay must be able to dispatch only its subject family",
);

const concurrentRegistry = new AdapterFamilyRegistry([{
  ...univ2StandardAdapter,
  pendingTransactionEvidence: {
    mightMatch: () => true,
    observe: (tx: PendingTransactionEvidenceInput) => ({
      canonicalPayload: tx.hash.slice(0, 4),
    }),
  },
} satisfies SwapAdapter]).pendingTransactionEvidence();
const [left, right] = await Promise.all([
  concurrentRegistry.observe(input(txHash("2")), transport),
  concurrentRegistry.observe(input(txHash("3")), transport),
]);
assert(
  left.evidence[0].txHash === txHash("2") &&
    right.evidence[0].txHash === txHash("3") &&
    left.evidence[0].payloadHash !== right.evidence[0].payloadHash,
  "concurrent transaction evidence must never cross-contaminate",
);

const queue = new PendingEvidenceAdmissionQueue<string>(4, 2, 2);
const familyA = left.evidence[0];
const familyB = Object.freeze({
  ...right.evidence[0],
  familyId: "univ3-standard" as const,
});
assert(
  queue.beginUnknownAttempt(familyA.familyId, familyA.headHash) &&
    queue.beginUnknownAttempt(familyA.familyId, familyA.headHash) &&
    !queue.beginUnknownAttempt(familyA.familyId, familyA.headHash),
  "one family must have a bounded number of concurrent observations",
);
assert(
  queue.beginUnknownAttempt(familyB.familyId, familyB.headHash),
  "one family must not consume a sibling's admission budget",
);
assert(
  !queue.finishUnknownAttempt(
    familyA.familyId,
    familyA.headHash,
    false,
  ) &&
    !queue.finishUnknownAttempt(
      familyA.familyId,
      familyA.headHash,
      false,
    ) &&
    queue.beginUnknownAttempt(familyA.familyId, familyA.headHash),
  "null/error observations must release their attempt tokens",
);
assert(
  queue.finishUnknownAttempt(familyA.familyId, familyA.headHash, true) &&
    queue.beginUnknownAttempt(familyA.familyId, familyA.headHash) &&
    queue.finishUnknownAttempt(familyA.familyId, familyA.headHash, true) &&
    !queue.beginUnknownAttempt(familyA.familyId, familyA.headHash),
  "only matched transactions that actually enter the queue consume admission",
);
queue.finishUnknownAttempt(familyB.familyId, familyB.headHash, false);
assert(
  !queue.finishUnknownAttempt(familyB.familyId, familyB.headHash, true),
  "an admission cannot commit without an outstanding attempt token",
);
queue.enqueueEvidence("univ2-standard", "a1");
queue.enqueueEvidence("univ2-standard", "a2");
queue.enqueueEvidence("univ2-standard", "a3");
queue.enqueueEvidence("univ3-standard", "b1");
queue.enqueueCanonical("canonical");
assert(queue.dequeue() === "canonical", "canonical queue must drain first");
const fair = [queue.dequeue(), queue.dequeue(), queue.dequeue()];
assert(
  fair.includes("b1") && !fair.includes("a1"),
  "family queues must be independent, bounded, and round-robin drained",
);

const scheduler = new PendingEvidenceTaskScheduler(1, 2);
let releaseUnknown!: () => void;
const schedulerOrder: string[] = [];
const runningUnknown = scheduler.run("unknown", async () => {
  schedulerOrder.push("unknown-running");
  await new Promise<void>((resolve) => {
    releaseUnknown = resolve;
  });
  schedulerOrder.push("unknown-finished");
});
const queuedUnknown = scheduler.run("unknown", async () => {
  schedulerOrder.push("unknown-queued");
});
const canonical = scheduler.run("canonical", async () => {
  schedulerOrder.push("canonical");
});
releaseUnknown();
await Promise.all([runningUnknown, queuedUnknown, canonical]);
assert(
  schedulerOrder.join(",") ===
    "unknown-running,unknown-finished,canonical,unknown-queued",
  "canonical evidence work must overtake queued false-positive observers",
);

const boundedScheduler = new PendingEvidenceTaskScheduler(1, 1);
let releaseBounded!: () => void;
const boundedRunning = boundedScheduler.run("unknown", () =>
  new Promise<void>((resolve) => {
    releaseBounded = resolve;
  })
);
const boundedQueued = boundedScheduler.run("unknown", async () => {});
let siblingRan = false;
const boundedSibling = boundedScheduler.run("unknown", async () => {
  siblingRan = true;
}, "family-b");
let overflow = "";
try {
  await boundedScheduler.run("unknown", async () => {});
} catch (error) {
  overflow = error instanceof Error ? error.message : String(error);
}
assert(
  overflow === "unknown evidence task queue full",
  "false-positive observer backlog must be bounded independently",
);
releaseBounded();
await Promise.all([boundedRunning, boundedQueued, boundedSibling]);
assert(
  siblingRan,
  "a full unknown lane must not reject a sibling family lane",
);

const fairScheduler = new PendingEvidenceTaskScheduler(1, 4);
let releaseFair!: () => void;
const fairOrder: string[] = [];
const fairRunning = fairScheduler.run("unknown", () =>
  new Promise<void>((resolve) => {
    releaseFair = resolve;
  }), "family-a"
);
const fairA1 = fairScheduler.run("unknown", async () => {
  fairOrder.push("a1");
}, "family-a");
const fairA2 = fairScheduler.run("unknown", async () => {
  fairOrder.push("a2");
}, "family-a");
const fairB = fairScheduler.run("unknown", async () => {
  fairOrder.push("b");
}, "family-b");
releaseFair();
await Promise.all([fairRunning, fairA1, fairA2, fairB]);
assert(
  fairOrder.join(",") === "a1,b,a2",
  "unknown evidence workers must drain family lanes round-robin",
);

const sharedHead = new PendingEvidenceHeadSnapshot();
let headLoads = 0;
let resolveInitialHead!: (
  value: { readonly number: number; readonly hash: string },
) => void;
const firstHead = sharedHead.current(() => {
  headLoads += 1;
  return new Promise((resolve) => {
    resolveInitialHead = resolve;
  });
});
const concurrentHead = sharedHead.current(async () => {
  headLoads += 1;
  return head;
});
const newerHead = Object.freeze({
  number: head.number + 1,
  hash: txHash("9"),
});
sharedHead.update(newerHead);
resolveInitialHead(head);
const [resolvedFirstHead, resolvedConcurrentHead] = await Promise.all([
  firstHead,
  concurrentHead,
]);
assert(
  resolvedFirstHead.number === newerHead.number &&
    resolvedFirstHead.hash === newerHead.hash &&
    resolvedConcurrentHead.number === newerHead.number &&
    resolvedConcurrentHead.hash === newerHead.hash &&
    headLoads === 1,
  "all pending transactions must share one head read and newHeads must win its race",
);

console.log("pending-transaction-evidence PASS");
