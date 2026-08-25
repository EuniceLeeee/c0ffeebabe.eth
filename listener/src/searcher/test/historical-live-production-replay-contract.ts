import type { StartupCheckpointEnvelope } from
  "../universe-rebuild-checkpoint.js";
import {
  loadPoolUniverseCoverageMetadata,
  type PoolUniverseCoverageMetadata,
} from "../pool-universe.js";

export const HISTORICAL_LIVE_PRODUCTION_ENTRY =
  "src/searcher/main.ts" as const;

const HOST_ENVIRONMENT = new Set([
  "FOUNDRY_DISABLE_NIGHTLY_WARNING",
  "PATH",
  "TZ",
]);

const TARGET_CONTROL_ENVIRONMENT_PREFIXES = Object.freeze([
  "SEARCHER_",
  "BLIND_",
  "AB_",
  "HUNT_",
  "POOL_UNIVERSE_",
]);

const REPLAY_OWNED_SEARCHER_ENVIRONMENT = new Set([
  "SEARCHER_BLIND_INSTALL_FORK_BOTVM",
  "SEARCHER_BLIND_PREPARE_BUDGET_MS",
  "SEARCHER_BLIND_RAW_AUDIT",
  "SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH",
  "SEARCHER_BLOCKSCAN_SUBMIT",
  "SEARCHER_DISCOVERY_TO_BLOCK",
  "SEARCHER_DRY_RUN",
  "SEARCHER_EAGER_STATE_BACKEND",
  "SEARCHER_ENABLE_BACKRUN",
  "SEARCHER_ENABLE_BLOCK_SCAN",
  "SEARCHER_ENABLE_MEMPOOL",
  "SEARCHER_ENABLE_MEV_SHARE",
  "SEARCHER_EVENTS_PATH",
  "SEARCHER_FORCE_INCLUDE_POOLIDS_PATH",
  "SEARCHER_LIVE_FIXTURE_DIR",
  "SEARCHER_LIVE_RPC_URL",
  "SEARCHER_LIVE_WS_URL",
  "SEARCHER_PINNED_WARM_POOLS",
  "SEARCHER_POOL_UNIVERSE_FORCE_INCLUDE",
  "SEARCHER_POOL_UNIVERSE_PATH",
  "SEARCHER_RECORD_LIVE_FIXTURES",
  "SEARCHER_RUNTIME_COMMIT",
  "SEARCHER_TEST_DISABLE_DOTENV",
  "SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH",
  "SEARCHER_UNIVERSE_REBUILD_RUN_ID",
]);

/** Reject selection hints before constructing or spawning production. */
export function assertTargetBlindReplayEnvironment(
  env: NodeJS.ProcessEnv,
): void {
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const normalizedName = name.toUpperCase();
    if (!TARGET_CONTROL_ENVIRONMENT_PREFIXES.some((prefix) =>
      normalizedName.startsWith(prefix)
    )) continue;
    if (
      /^AB_EXPECTED_/.test(normalizedName) ||
      /^HUNT_/.test(normalizedName) ||
      /(?:EXPECTED|TARGET|WINNER|SEARCH_CENTER)/.test(normalizedName)
    ) {
      throw new Error(
        `historical live replay rejects target-specific environment ${name}`,
      );
    }
  }
}

/**
 * Preserve production semantic SEARCHER_/MEV_LIVE_ configuration while the
 * replay owns only transport, historical anchors, dry-run posture and output
 * paths. No BLIND_/prefix control is forwarded to the production process.
 */
export function forwardedProductionEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  assertTargetBlindReplayEnvironment(env);
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => {
      if (value === undefined) return false;
      if (HOST_ENVIRONMENT.has(name)) return true;
      if (
        !name.startsWith("SEARCHER_") &&
        !name.startsWith("MEV_LIVE_")
      ) return false;
      return !REPLAY_OWNED_SEARCHER_ENVIRONMENT.has(name);
    }),
  );
}

export interface HistoricalCheckpointEvidence {
  readonly checkpointFingerprint: string;
  readonly revision: number;
  readonly readyGeneration: number;
  readonly readyCutoff: number;
  readonly verifiedMemos: number;
  readonly retryableAttempts: number;
}

/** A supplied durable universe may never contain authority newer than base. */
export function historicalCheckpointEvidence(
  checkpoint: StartupCheckpointEnvelope,
  baseNumber: number,
): HistoricalCheckpointEvidence {
  if (checkpoint.inProgressRun !== null) {
    throw new Error("historical checkpoint has an in-progress run");
  }
  const ready = checkpoint.readyGeneration;
  if (ready === null) {
    throw new Error("historical checkpoint has no ready generation");
  }
  const cutoffs: Array<[string, number]> = [
    ["ready.cutoff", ready.cutoff.number],
    ["ready.universeRange.toBlock", ready.universeRange.toBlock],
    ["ready.observedThrough", ready.observedThrough.number],
    ["ready.appliedThrough", ready.appliedThrough.number],
    ...ready.sourceCoverage.map((entry, index): [string, number] => [
      `ready.sourceCoverage[${index}]`,
      entry.completeThroughBlock,
    ]),
    ...Object.values(checkpoint.verifiedMemos).map(
      (memo): [string, number] => [
        `verifiedMemo[${memo.familyCandidateKey}].proofSource`,
        memo.validity.proofSource.number,
      ],
    ),
    ...Object.entries(checkpoint.retryableAttemptsByCandidateKey).flatMap(
      ([key, entry]): Array<[string, number]> => [
        [`retryable[${key}].cutoff`, entry.cutoff.number],
        ...(entry.evidenceRef === undefined
          ? []
          : [[
              `retryable[${key}].evidenceRef`,
              entry.evidenceRef.blockNumber,
            ] as [string, number]]),
      ],
    ),
  ];
  for (const [label, cutoff] of cutoffs) {
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > baseNumber) {
      throw new Error(
        `historical checkpoint look-ahead ${label}=${cutoff} base=${baseNumber}`,
      );
    }
  }
  return Object.freeze({
    checkpointFingerprint: checkpoint.checkpointFingerprint,
    revision: checkpoint.revision,
    readyGeneration: ready.generation,
    readyCutoff: ready.cutoff.number,
    verifiedMemos: Object.keys(checkpoint.verifiedMemos).length,
    retryableAttempts: Object.keys(
      checkpoint.retryableAttemptsByCandidateKey,
    ).length,
  });
}

/** A file-backed seed must be independently manifested at or before base. */
export function historicalPoolUniverseEvidence(
  path: string,
  baseNumber: number,
): PoolUniverseCoverageMetadata {
  const metadata = loadPoolUniverseCoverageMetadata(path);
  if (
    metadata.toBlock === null ||
    metadata.toBlock > baseNumber ||
    !metadata.manifestVerified ||
    metadata.source === null ||
    metadata.source.number > baseNumber
  ) {
    throw new Error(
      "historical pool universe must have a verified manifest with " +
        `toBlock <= base (${metadata.toBlock ?? "missing"} > ${baseNumber})`,
    );
  }
  return metadata;
}
