import type { SearcherEvent } from "../events.js";

const DEFAULT_WATCH_BLOCKS = 3;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

interface InclusionProvider {
  getBlockNumber(): Promise<number>;
  getTransactionReceipt(txHash: string): Promise<InclusionReceipt | null>;
}

interface InclusionReceipt {
  blockNumber: number;
  status: number | null;
  gasUsed?: { toString(): string };
  gasPrice?: { toString(): string } | null;
}

type InclusionEvent = Extract<
  SearcherEvent,
  { type: "bundle_included" | "bundle_not_included" }
>;

export interface InclusionTrackerOpts {
  provider: InclusionProvider;
  backrunTxHash: string;
  opportunityId: string;
  targetBlock: number;
  watchBlocks?: number;
  emit: (event: InclusionEvent) => void;
  pollIntervalMs?: number;
}

export function trackInclusion(opts: InclusionTrackerOpts): void {
  try {
    void pollInclusion(opts).catch(() => {
      // Observation must never affect the submit path.
    });
  } catch {
    // Keep the public contract fail-open even if setup changes later.
  }
}

async function pollInclusion(opts: InclusionTrackerOpts): Promise<void> {
  try {
    const watchBlocks = normalizeWatchBlocks(opts.watchBlocks);
    const pollIntervalMs = normalizePollIntervalMs(opts.pollIntervalMs);
    const finalBlock = opts.targetBlock + watchBlocks;
    let lastCheckedBlock = opts.targetBlock - 1;

    for (;;) {
      let currentBlock: number;
      try {
        currentBlock = await opts.provider.getBlockNumber();
      } catch {
        await sleep(pollIntervalMs);
        continue;
      }

      if (currentBlock >= opts.targetBlock && currentBlock > lastCheckedBlock) {
        lastCheckedBlock = Math.min(currentBlock, finalBlock);
        let receipt: InclusionReceipt | null = null;
        try {
          receipt = await opts.provider.getTransactionReceipt(opts.backrunTxHash);
        } catch {
          receipt = null;
        }

        if (
          receipt &&
          receipt.blockNumber >= opts.targetBlock &&
          receipt.blockNumber <= finalBlock
        ) {
          opts.emit({
            type: "bundle_included",
            opportunity_id: opts.opportunityId,
            tx_hash: opts.backrunTxHash,
            target_block: opts.targetBlock,
            mined_block: receipt.blockNumber,
            status: receipt.status === 1 ? "success" : "revert",
            gas_used: receipt.gasUsed?.toString(),
            effective_gas_price: receipt.gasPrice?.toString(),
          });
          return;
        }
      }

      if (currentBlock >= finalBlock) {
        opts.emit({
          type: "bundle_not_included",
          opportunity_id: opts.opportunityId,
          tx_hash: opts.backrunTxHash,
          target_block: opts.targetBlock,
          blocks_waited: watchBlocks,
        });
        return;
      }

      await sleep(pollIntervalMs);
    }
  } catch {
    // Fire-and-forget instrumentation: never throw into callers.
  }
}

function normalizeWatchBlocks(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_WATCH_BLOCKS;
  return Math.floor(value);
}

function normalizePollIntervalMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.floor(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
