import { VictimSourceTracker } from "../detector/victim-source-quality.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const S = "0x295fc34f1742c4e8bd1bfeb3711be567919fa72d";
const OTHER = "0x1111111111111111111111111111111111111111";

function tracker(enabled = true): VictimSourceTracker {
  return new VictimSourceTracker({
    enabled,
    minStreak: 3,
    windowBlocks: 200,
    ringSize: 8,
  });
}

function main(): void {
  // R15 provenance: sender S produced repeat-reverting followed victims around blocks 25453305..25453357.
  const baseline = tracker();
  baseline.record(S, 25453305, false);
  baseline.record(S, 25453309, false);
  assert(!baseline.shouldSkip(S, 25453376), "baseline: two reverts should not meet the streak");

  const streak = tracker();
  streak.record(S, 25453305, false);
  streak.record(S, 25453309, false);
  streak.record(S, 25453357, false);
  assert(streak.shouldSkip(S, 25453376), "streak: three in-window reverts should skip");

  const recovery = tracker();
  recovery.record(S, 25453305, false);
  recovery.record(S, 25453309, false);
  recovery.record(S, 25453357, false);
  recovery.record(S, 25453374, true);
  assert(!recovery.shouldSkip(S, 25453376), "recovery: latest in-window success should re-admit");

  const stale = tracker();
  stale.record(S, 25453000, false);
  stale.record(S, 25453005, false);
  stale.record(S, 25453010, false);
  assert(!stale.shouldSkip(S, 25453376), "stale: old reverts outside the window should not skip");

  const disabled = tracker(false);
  disabled.record(S, 25453305, false);
  disabled.record(S, 25453309, false);
  disabled.record(S, 25453357, false);
  assert(!disabled.shouldSkip(S, 25453376), "disabled: filter disabled should never skip");

  const independent = tracker();
  independent.record(S, 25453305, false);
  independent.record(S, 25453309, false);
  independent.record(S, 25453357, false);
  assert(!independent.shouldSkip(OTHER, 25453376), "independent: senders must be isolated");

  console.log("[victim-source-filter] PASS streak_skip=true recovery=true window=true disabled=true independent=true");
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[victim-source-filter] FAIL ${msg}`);
  process.exit(1);
}
