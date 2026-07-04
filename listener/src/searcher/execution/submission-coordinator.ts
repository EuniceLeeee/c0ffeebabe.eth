import type { StrategyKind } from "../strategy-taxonomy.js";

export interface SubmissionCandidate {
  strategy: StrategyKind;
  opportunityId: string;
  targetBlock: number;
  netEvWei: bigint;
  deadlineAtMs?: number;
}

export type SlotDecision =
  | { admit: true; replaces?: SubmissionCandidate }
  | {
      admit: false;
      reason: "submission_arbitration_lost" | "blockscan_preempted_by_backrun";
      holder: SubmissionCandidate;
    };

function absBps(x: bigint, bps: number): bigint {
  return ((x < 0n ? -x : x) * BigInt(bps)) / 10000n;
}

export class SubmissionCoordinator {
  private readonly slots = new Map<number, SubmissionCandidate>();
  private readonly blockscanPreemptMarginBps: number;

  constructor(policy?: { blockscanPreemptMarginBps?: number }) {
    this.blockscanPreemptMarginBps = policy?.blockscanPreemptMarginBps ?? 0;
  }

  offer(c: SubmissionCandidate): SlotDecision {
    const holder = this.slots.get(c.targetBlock);
    if (!holder) {
      this.slots.set(c.targetBlock, c);
      return { admit: true };
    }

    if (holder.strategy === "backrun" && c.strategy === "backrun") {
      this.slots.set(c.targetBlock, c);
      return { admit: true, replaces: holder };
    }

    if (holder.strategy === "backrun" && c.strategy === "block-scan") {
      const marginBps = this.blockscanPreemptMarginBps;
      if (marginBps > 0 && c.netEvWei > holder.netEvWei + absBps(holder.netEvWei, marginBps)) {
        this.slots.set(c.targetBlock, c);
        return { admit: true, replaces: holder };
      }
      return {
        admit: false,
        reason: "blockscan_preempted_by_backrun",
        holder,
      };
    }

    if (holder.strategy === "block-scan" && c.strategy === "backrun") {
      this.slots.set(c.targetBlock, c);
      return { admit: true, replaces: holder };
    }

    if (c.netEvWei > holder.netEvWei) {
      this.slots.set(c.targetBlock, c);
      return { admit: true, replaces: holder };
    }

    return {
      admit: false,
      reason: "submission_arbitration_lost",
      holder,
    };
  }

  onBlock(latest: number): void {
    for (const targetBlock of this.slots.keys()) {
      if (targetBlock <= latest) this.slots.delete(targetBlock);
    }
  }
}
