import { UniverseRebuildCheckpointStore } from "./universe-rebuild-checkpoint.js";

/**
 * Audit §6: read-only/repair entry points for the durable universe rebuild.
 *
 *   npm run searcher:universe-rebuild-status -- --checkpoint <path> [--json]
 *
 * Prints the envelope: revision, verified memo count, the in-progress run
 * (fixed cutoff, candidate set, outcome breakdown by status) and the ready
 * generation. --json emits the raw envelope for machine consumption.
 */

interface StatusArgs {
  readonly checkpoint: string;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): StatusArgs {
  let checkpoint = "";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--checkpoint") {
      checkpoint = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--json") {
      json = true;
    }
  }
  if (checkpoint.trim().length === 0) {
    throw new Error(
      "usage: searcher:universe-rebuild-status --checkpoint <path> [--json]",
    );
  }
  return { checkpoint, json };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new UniverseRebuildCheckpointStore({ path: args.checkpoint });
  const envelope = await store.load();
  if (envelope === null) {
    if (args.json) {
      console.log(JSON.stringify({ status: "absent", checkpoint: args.checkpoint }));
    } else {
      console.log(
        "universe rebuild status: absent (" + args.checkpoint + ")",
      );
    }
    return;
  }
  if (args.json) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  const run = envelope.inProgressRun;
  const outcomes = run === null
    ? []
    : Object.values(run.outcomesByCandidateKey);
  const breakdown = new Map<string, number>();
  for (const outcome of outcomes) {
    breakdown.set(outcome.status, (breakdown.get(outcome.status) ?? 0) + 1);
  }
  const ready = envelope.readyGeneration;
  console.log("universe rebuild status: revision=" + envelope.revision);
  console.log(
    "  verifiedMemos=" + Object.keys(envelope.verifiedMemos).length,
  );
  if (run === null) {
    console.log("  inProgressRun: none");
  } else {
    console.log(
      "  inProgressRun: " + run.runId +
        " cutoff=" + run.cutoff.number +
        " candidates=" + run.candidateCount +
        " observedThrough=" + run.observedThrough.number,
    );
    console.log(
      "  outcomes: " +
        [...breakdown.entries()]
          .map(([status, count]) => status + "=" + count)
          .join(" ") +
        (outcomes.length === 0 ? " (none yet)" : ""),
    );
    const retryable = outcomes.filter((item) => item.status === "retryable");
    if (retryable.length > 0) {
      console.log(
        "  retryable (probe candidates): " +
          retryable.map((item) => item.familyCandidateKey).join(", "),
      );
    }
  }
  if (ready === null) {
    console.log("  readyGeneration: none (no complete rebuild yet)");
  } else {
    console.log(
      "  readyGeneration: " + ready.generation +
        " cutoff=" + ready.cutoff.number +
        " activeInstances=" + ready.activeInstanceKeys.length +
        " graphHash=" + ready.graphHash.slice(0, 16) + "...",
    );
  }
}

main().catch((error) => {
  console.error(
    "universe-rebuild-status FAIL: " +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
