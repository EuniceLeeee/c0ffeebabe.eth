import { runBlockScanMidBatch } from "../detector/blockscan-mid-batch.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function testBoundedConcurrencyAndStableOrder(): Promise<void> {
  let active = 0;
  let peak = 0;
  const input = Array.from({ length: 12 }, (_, index) => index);
  const batch = await runBlockScanMidBatch(
    input,
    4,
    Date.now() + 2_000,
    async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, (12 - value) % 4));
      active--;
      return value * 2;
    },
  );

  assert(!batch.deadlineHit, "complete batch should not hit its deadline");
  assert(batch.started === input.length, "complete batch should start every input");
  assert(peak === 4, `peak concurrency should be 4, got ${peak}`);
  assert(
    batch.results.join(",") === input.map((value) => value * 2).join(","),
    "results should retain input order rather than completion order",
  );
}

async function testDeadlineStopsNewReads(): Promise<void> {
  let reads = 0;
  const batch = await runBlockScanMidBatch(
    [1, 2, 3],
    2,
    Date.now() - 1,
    async (value) => {
      reads++;
      return value;
    },
  );

  assert(batch.deadlineHit, "expired batch should report its deadline");
  assert(batch.started === 0, "expired batch should not start new reads");
  assert(reads === 0, "expired batch should not invoke the reader");
}

async function testDeadlineAfterPrerequisiteStopsQuote(): Promise<void> {
  let quotes = 0;
  const deadlineAtMs = Date.now() + 5;
  const batch = await runBlockScanMidBatch(
    [1],
    1,
    deadlineAtMs,
    async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (Date.now() >= deadlineAtMs) return "skipped";
      quotes++;
      return "quoted";
    },
  );

  assert(batch.deadlineHit, "prerequisite crossing the deadline should fail the batch closed");
  assert(quotes === 0, "quote should not start after its prerequisite crosses the deadline");
}

await testBoundedConcurrencyAndStableOrder();
console.log("[blockscan-mid-batch] bounded concurrency and stable order: PASS");
await testDeadlineStopsNewReads();
console.log("[blockscan-mid-batch] deadline stops new reads: PASS");
await testDeadlineAfterPrerequisiteStopsQuote();
console.log("[blockscan-mid-batch] post-prerequisite deadline stops quote: PASS");
console.log("blockscan-mid-batch PASS (3/3)");
