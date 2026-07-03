import { trackInclusion } from "../execution/inclusion-tracker.js";
import type { SearcherEvent } from "../events.js";

type InclusionEvent = Extract<
  SearcherEvent,
  { type: "bundle_included" | "bundle_not_included" }
>;

const TX_HASH = "0x" + "12".repeat(32);
const OPPORTUNITY_ID = "0x" + "34".repeat(32);

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventCount(events: InclusionEvent[]): number {
  return events.length;
}

class FakeProvider {
  private currentBlock: number;

  constructor(
    startBlock: number,
    private readonly receipt:
      | {
          blockNumber: number;
          status: number | null;
          gasUsed?: { toString(): string };
          gasPrice?: { toString(): string };
        }
      | null,
    private readonly rejectReceipts = false,
  ) {
    this.currentBlock = startBlock;
  }

  async getBlockNumber(): Promise<number> {
    this.currentBlock += 1;
    return this.currentBlock;
  }

  async getTransactionReceipt(_txHash: string): Promise<typeof this.receipt> {
    if (this.rejectReceipts) throw new Error("receipt rpc failed");
    if (this.receipt && this.currentBlock >= this.receipt.blockNumber) return this.receipt;
    return null;
  }
}

async function waitForEvent(events: InclusionEvent[]): Promise<InclusionEvent> {
  for (let i = 0; i < 100; i++) {
    if (events[0]) return events[0];
    await sleep(1);
  }
  throw new Error("timed out waiting for inclusion event");
}

async function testIncluded(): Promise<void> {
  const targetBlock = 100;
  const events: InclusionEvent[] = [];
  const provider = new FakeProvider(targetBlock - 1, {
    blockNumber: targetBlock + 1,
    status: 1,
    gasUsed: 12345n,
    gasPrice: 67890n,
  });

  trackInclusion({
    provider,
    backrunTxHash: TX_HASH,
    opportunityId: OPPORTUNITY_ID,
    targetBlock,
    watchBlocks: 3,
    pollIntervalMs: 1,
    emit: (event) => events.push(event),
  });

  assert(eventCount(events) === 0, "trackInclusion should return before emitting");
  const event = await waitForEvent(events);
  await sleep(5);

  assert(eventCount(events) === 1, `expected exactly one event, got ${eventCount(events)}`);
  assert(event.type === "bundle_included", `expected bundle_included, got ${event.type}`);
  assert(event.opportunity_id === OPPORTUNITY_ID, "included opportunity_id mismatch");
  assert(event.tx_hash === TX_HASH, "included tx_hash mismatch");
  assert(event.target_block === targetBlock, "included target_block mismatch");
  assert(event.mined_block === targetBlock + 1, "included mined_block mismatch");
  assert(event.status === "success", `included status mismatch: ${event.status}`);
  assert(event.gas_used === "12345", `included gas_used mismatch: ${event.gas_used}`);
  assert(
    event.effective_gas_price === "67890",
    `included effective_gas_price mismatch: ${event.effective_gas_price}`,
  );
  console.log("[inclusion-tracker] included receipt emits bundle_included: PASS");
}

async function testNotIncluded(): Promise<void> {
  const targetBlock = 200;
  const watchBlocks = 2;
  const events: InclusionEvent[] = [];
  const provider = new FakeProvider(targetBlock - 1, null);

  trackInclusion({
    provider,
    backrunTxHash: TX_HASH,
    opportunityId: OPPORTUNITY_ID,
    targetBlock,
    watchBlocks,
    pollIntervalMs: 1,
    emit: (event) => events.push(event),
  });

  const event = await waitForEvent(events);
  await sleep(5);

  assert(eventCount(events) === 1, `expected exactly one event, got ${eventCount(events)}`);
  assert(event.type === "bundle_not_included", `expected bundle_not_included, got ${event.type}`);
  assert(event.opportunity_id === OPPORTUNITY_ID, "not_included opportunity_id mismatch");
  assert(event.tx_hash === TX_HASH, "not_included tx_hash mismatch");
  assert(event.target_block === targetBlock, "not_included target_block mismatch");
  assert(event.blocks_waited === watchBlocks, "not_included blocks_waited mismatch");
  console.log("[inclusion-tracker] missing receipt emits bundle_not_included: PASS");
}

async function testReceiptRejectDoesNotThrow(): Promise<void> {
  const targetBlock = 300;
  const events: InclusionEvent[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const provider = new FakeProvider(targetBlock - 1, null, true);

    trackInclusion({
      provider,
      backrunTxHash: TX_HASH,
      opportunityId: OPPORTUNITY_ID,
      targetBlock,
      watchBlocks: 1,
      pollIntervalMs: 1,
      emit: (event) => events.push(event),
    });

    const event = await waitForEvent(events);
    await sleep(5);

    assert(eventCount(events) === 1, `expected exactly one event, got ${eventCount(events)}`);
    assert(event.type === "bundle_not_included", `expected bundle_not_included, got ${event.type}`);
    assert(unhandled.length === 0, `expected no unhandled rejections, got ${unhandled.length}`);
    console.log("[inclusion-tracker] receipt rejection stays fail-open: PASS");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

async function main(): Promise<void> {
  await testIncluded();
  await testNotIncluded();
  await testReceiptRejectDoesNotThrow();
  console.log("inclusion-tracker PASS (3/3)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
