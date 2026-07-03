export interface VictimSourceTrackerConfig {
  enabled: boolean;
  minStreak: number;
  windowBlocks: number;
  ringSize: number;
}

export interface VictimSourceOutcome {
  block: number;
  landed: boolean;
}

export class VictimSourceTracker {
  private readonly outcomes = new Map<string, VictimSourceOutcome[]>();
  private readonly enabled: boolean;
  private readonly minStreak: number;
  private readonly windowBlocks: number;
  private readonly ringSize: number;

  constructor(cfg: VictimSourceTrackerConfig) {
    this.enabled = cfg.enabled;
    this.minStreak = Math.max(1, cfg.minStreak);
    this.windowBlocks = Math.max(0, cfg.windowBlocks);
    this.ringSize = Math.max(1, cfg.ringSize || 8);
  }

  record(sender: string, block: number, landed: boolean): void {
    const key = sender.toLowerCase();
    const ring = this.outcomes.get(key) ?? [];
    ring.push({ block, landed });
    while (ring.length > this.ringSize) ring.shift();
    this.outcomes.set(key, ring);
  }

  shouldSkip(sender: string, block: number): boolean {
    if (!this.enabled) return false;
    const ring = this.outcomes.get(sender.toLowerCase());
    if (!ring) return false;

    const minBlock = block - this.windowBlocks;
    const inWindow = ring.filter((outcome) => outcome.block >= minBlock);
    if (inWindow.length < this.minStreak) return false;

    const recent = inWindow.slice(-this.minStreak);
    return recent.every((outcome) => !outcome.landed);
  }

  size(): number {
    return this.outcomes.size;
  }

  get(sender: string): VictimSourceOutcome[] {
    return [...(this.outcomes.get(sender.toLowerCase()) ?? [])];
  }
}
