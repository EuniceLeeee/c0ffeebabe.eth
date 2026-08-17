import { UniverseRebuildCheckpointStore } from "./universe-rebuild-checkpoint.js";
import { UniverseRunIncomplete, rebuildUniverse } from "./universe-rebuild-runner.js";
import type { UniverseRebuildDependencies } from "./universe-rebuild-runner.js";

/**
 * Audit §5/§8: standalone durable universe rebuild. Runs the full
 * rebuildUniverse flow at the frozen canonical head with the production
 * wiring, committing verifiedMemos / run outcomes continuously and the
 * ready generation (Graph + catalog + coverage + cutoff) with the final
 * CAS. The searcher startup consumes the ready generation and starts the
 * producer only after it; a run with retryable outcomes stays durable and
 * incomplete (exit code 2) until probed.
 *
 *   npm run searcher:universe-rebuild-startup -- \
 *     --checkpoint <path> [--rpc-url <url>] [--lookback-blocks <N>] \
 *     [--run-id <id>]
 */

interface Args {
  readonly checkpoint: string;
  readonly rpcUrl?: string;
  readonly lookbackBlocks: number;
  readonly runId: string;
}

function parseArgs(argv: readonly string[]): Args {
  let checkpoint = "";
  let rpcUrl: string | undefined;
  let lookbackBlocks = 14_400;
  let runId = "startup-rebuild";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("missing value for " + arg);
      i += 1;
      return value;
    };
    if (arg === "--checkpoint") checkpoint = next();
    else if (arg === "--rpc-url") rpcUrl = next();
    else if (arg === "--lookback-blocks") lookbackBlocks = Number(next());
    else if (arg === "--run-id") runId = next();
  }
  if (checkpoint.trim().length === 0) {
    throw new Error(
      "usage: searcher:universe-rebuild-startup --checkpoint <path> " +
        "[--rpc-url <url>] [--lookback-blocks <N>] [--run-id <id>]",
    );
  }
  if (!Number.isSafeInteger(lookbackBlocks) || lookbackBlocks <= 0) {
    throw new Error("--lookback-blocks must be a positive integer");
  }
  return { checkpoint, rpcUrl, lookbackBlocks, runId };
}

async function loadWiring(args: Args): Promise<UniverseRebuildDependencies> {
  const override = process.env.SEARCHER_UNIVERSE_REBUILD_WIRING_PATH;
  if (override !== undefined && override.trim().length > 0) {
    const loaded = await import(override) as {
      createRebuildWiring(): UniverseRebuildDependencies;
    };
    return loaded.createRebuildWiring();
  }
  const production = await import("./universe-rebuild-production.js") as {
    createRebuildWiring(input?: { readonly rpcUrl?: string }):
      UniverseRebuildDependencies;
  };
  return production.createRebuildWiring(
    args.rpcUrl === undefined ? undefined : { rpcUrl: args.rpcUrl },
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new UniverseRebuildCheckpointStore({ path: args.checkpoint });
  const wiring = await loadWiring(args);
  try {
    const ready = await rebuildUniverse({
      ...wiring,
      store,
      runId: args.runId,
      lookbackBlocks: args.lookbackBlocks,
      log: (message) => console.log("[universe-rebuild] " + message),
    });
    console.log(
      "[universe-rebuild] READY generation=" + ready.generation +
        " cutoff=" + ready.cutoff.number +
        " instances=" + ready.activeInstanceKeys.length +
        " graphHash=" + ready.graphHash.slice(0, 16),
    );
    console.log("[universe-rebuild] DONE");
  } catch (error) {
    if (error instanceof UniverseRunIncomplete) {
      console.error(
        "[universe-rebuild] INCOMPLETE run=" + error.runId +
          " retryable=" + error.retryableCount +
          " (durable; use searcher:universe-rebuild-probe)",
      );
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(
    "universe-rebuild-startup FAIL: " +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
