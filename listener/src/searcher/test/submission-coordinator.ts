import {
  SubmissionCoordinator,
  type SlotDecision,
  type SubmissionCandidate,
} from "../execution/submission-coordinator.js";
import type { StrategyKind } from "../strategy-taxonomy.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function candidate(
  opportunityId: string,
  strategy: StrategyKind,
  targetBlock: number,
  netEvWei: bigint,
): SubmissionCandidate {
  return {
    strategy,
    opportunityId,
    targetBlock,
    netEvWei,
    deadlineAtMs: 1_000_000 + targetBlock,
  };
}

function assertAdmit(decision: SlotDecision, label: string): asserts decision is { admit: true; replaces?: SubmissionCandidate } {
  assert(decision.admit, `${label}: expected admit`);
}

function assertReject(
  decision: SlotDecision,
  label: string,
  reason: "submission_arbitration_lost" | "blockscan_preempted_by_backrun",
): asserts decision is { admit: false; reason: typeof reason; holder: SubmissionCandidate } {
  assert(!decision.admit, `${label}: expected reject`);
  assert(decision.reason === reason, `${label}: expected reason ${reason}, got ${decision.reason}`);
}

const tests: Array<{ name: string; run: () => void }> = [];

function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

test("empty slot admits backrun and block-scan", () => {
  const coordinator = new SubmissionCoordinator();
  assertAdmit(coordinator.offer(candidate("br", "backrun", 100, 1n)), "empty backrun");
  assertAdmit(coordinator.offer(candidate("bs", "block-scan", 101, 1n)), "empty block-scan");
});

test("backrun holder plus backrun candidate admits and replaces", () => {
  const coordinator = new SubmissionCoordinator();
  const holder = candidate("br-a", "backrun", 100, 1n);
  const next = candidate("br-b", "backrun", 100, -1n);
  assertAdmit(coordinator.offer(holder), "initial holder");
  const decision = coordinator.offer(next);
  assertAdmit(decision, "backrun replaces backrun");
  assert(decision.replaces === holder, "backrun replaces backrun: holder identity");
});

test("backrun holder plus block-scan candidate rejects by default", () => {
  const coordinator = new SubmissionCoordinator();
  const holder = candidate("br", "backrun", 100, 1n);
  assertAdmit(coordinator.offer(holder), "initial holder");
  const decision = coordinator.offer(candidate("bs", "block-scan", 100, 1_000_000n));
  assertReject(decision, "default block-scan preempt", "blockscan_preempted_by_backrun");
  assert(decision.holder === holder, "default block-scan preempt: holder identity");
});

test("block-scan holder plus backrun candidate admits and replaces", () => {
  const coordinator = new SubmissionCoordinator();
  const holder = candidate("bs", "block-scan", 100, 10_000n);
  const next = candidate("br", "backrun", 100, 0n);
  assertAdmit(coordinator.offer(holder), "initial holder");
  const decision = coordinator.offer(next);
  assertAdmit(decision, "backrun replaces block-scan");
  assert(decision.replaces === holder, "backrun replaces block-scan: holder identity");
});

test("block-scan holder plus block-scan candidate compares net EV", () => {
  const coordinator = new SubmissionCoordinator();
  const holder = candidate("bs-a", "block-scan", 100, 100n);
  const higher = candidate("bs-b", "block-scan", 100, 101n);
  const equal = candidate("bs-c", "block-scan", 100, 101n);
  const lower = candidate("bs-d", "block-scan", 100, 100n);
  assertAdmit(coordinator.offer(holder), "initial holder");
  const higherDecision = coordinator.offer(higher);
  assertAdmit(higherDecision, "higher block-scan");
  assert(higherDecision.replaces === holder, "higher block-scan: holder identity");
  const equalDecision = coordinator.offer(equal);
  assertReject(equalDecision, "equal block-scan", "submission_arbitration_lost");
  assert(equalDecision.holder === higher, "equal block-scan: holder identity");
  const lowerDecision = coordinator.offer(lower);
  assertReject(lowerDecision, "lower block-scan", "submission_arbitration_lost");
  assert(lowerDecision.holder === higher, "lower block-scan: holder identity");
});

test("positive margin allows block-scan only above threshold", () => {
  const coordinator = new SubmissionCoordinator({ blockscanPreemptMarginBps: 5000 });
  const holder = candidate("br", "backrun", 100, 100n);
  assertAdmit(coordinator.offer(holder), "initial holder");
  const belowDecision = coordinator.offer(candidate("bs-below", "block-scan", 100, 150n));
  assertReject(belowDecision, "below margin", "blockscan_preempted_by_backrun");
  assert(belowDecision.holder === holder, "below margin: holder identity");
  const aboveDecision = coordinator.offer(candidate("bs-above", "block-scan", 100, 151n));
  assertAdmit(aboveDecision, "above margin");
  assert(aboveDecision.replaces === holder, "above margin: holder identity");
});

test("different target blocks are independent and onBlock prunes <=", () => {
  const coordinator = new SubmissionCoordinator();
  const block100 = candidate("br-100", "backrun", 100, 1n);
  const block101 = candidate("br-101", "backrun", 101, 1n);
  const block102 = candidate("br-102", "backrun", 102, 1n);
  assertAdmit(coordinator.offer(block100), "block 100");
  assertAdmit(coordinator.offer(block101), "block 101");
  assertAdmit(coordinator.offer(block102), "block 102");
  const replace101BeforePrune = coordinator.offer(candidate("br-101-next", "backrun", 101, 2n));
  assertAdmit(replace101BeforePrune, "replace 101 before prune");
  assert(replace101BeforePrune.replaces === block101, "replace 101 before prune: holder identity");

  coordinator.onBlock(101);
  const new100 = coordinator.offer(candidate("br-100-new", "backrun", 100, 3n));
  const new101 = coordinator.offer(candidate("br-101-new", "backrun", 101, 3n));
  const new102 = coordinator.offer(candidate("br-102-new", "backrun", 102, 3n));
  assertAdmit(new100, "block 100 after prune");
  assert(!new100.replaces, "block 100 after prune: no holder");
  assertAdmit(new101, "block 101 after prune");
  assert(!new101.replaces, "block 101 after prune: no holder");
  assertAdmit(new102, "block 102 after prune");
  assert(new102.replaces === block102, "block 102 after prune: preserved holder");
});

test("backrun-only sequence always admits across arbitrary target blocks", () => {
  const coordinator = new SubmissionCoordinator();
  const targetBlocks = [100, 100, 101, 99, 103, 101, 103, 105, 100, 104];
  for (let i = 0; i < targetBlocks.length; i++) {
    const decision = coordinator.offer(candidate(`br-${i}`, "backrun", targetBlocks[i], BigInt(i - 3)));
    assertAdmit(decision, `backrun offer ${i}`);
  }
});

let passed = 0;
for (const { name, run } of tests) {
  try {
    run();
    passed++;
    console.log(`[submission-coordinator] ${name}: PASS`);
  } catch (err) {
    console.error(`[submission-coordinator] ${name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

console.log(`submission-coordinator PASS (${passed}/${tests.length})`);
