import { UniverseRebuildCheckpointStore } from "./universe-rebuild-checkpoint.js";
import { probeOneFailure } from "./universe-rebuild-runner.js";

/**
 * Audit §6: single-pool repair entry for the durable universe rebuild.
 *
 *   npm run searcher:universe-rebuild-probe -- \
 *     --checkpoint <path> --run-id <runId> --family-candidate-key <key>
 *   npm run searcher:universe-rebuild-probe -- \
 *     --checkpoint <path> --run-id <runId> --failure-code rpc --limit 20
 *
 * Retries exactly the target retryable key(s) at the run's original fixed
 * cutoff, using the saved candidateSnapshot + evidenceRef; never rescans
 * the window and never touches the other candidates. The attestation
 * wiring is supplied by the caller hook (production integration wires the
 * strict family lifecycle; tests wire mocks).
 */

export interface UniverseRebuildProbeWiring {
  readonly attestFamilyInstanceOnce: Parameters<typeof probeOneFailure>[0][
    "attestFamilyInstanceOnce"
  ];
  readonly sealDurableVerifiedMemo: Parameters<typeof probeOneFailure>[0][
    "sealDurableVerifiedMemo"
  ];
  readonly assertCanonicalHead: Parameters<typeof probeOneFailure>[0][
    "assertCanonicalHead"
  ];
  readonly decodeCandidateSnapshot: (snapshot: unknown) => unknown;
}

interface ProbeArgs {
  readonly checkpoint: string;
  readonly runId: string;
  readonly familyCandidateKey?: string;
  readonly failureCode?: string;
  readonly limit: number;
}

function parseArgs(argv: readonly string[]): ProbeArgs {
  let checkpoint = "";
  let runId = "";
  let familyCandidateKey: string | undefined;
  let failureCode: string | undefined;
  let limit = 20;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("missing value for " + arg);
      }
      i += 1;
      return value;
    };
    if (arg === "--checkpoint") checkpoint = next();
    else if (arg === "--run-id") runId = next();
    else if (arg === "--family-candidate-key") familyCandidateKey = next();
    else if (arg === "--failure-code") failureCode = next();
    else if (arg === "--limit") limit = Number(next());
  }
  if (checkpoint.trim().length === 0 || runId.trim().length === 0) {
    throw new Error(
      "usage: searcher:universe-rebuild-probe --checkpoint <path> " +
        "--run-id <runId> --family-candidate-key <key> | " +
        "--failure-code <code> [--limit N]",
    );
  }
  if (
    (familyCandidateKey === undefined) === (failureCode === undefined)
  ) {
    throw new Error(
      "provide exactly one of --family-candidate-key or --failure-code",
    );
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("--limit must be 1..500");
  }
  return { checkpoint, runId, familyCandidateKey, failureCode, limit };
}

/**
 * Resolve the probe wiring. The attestation half is production-integrated
 * through the strict family lifecycle; this hook is the extension point
 * the node wiring fills (and tests fill with mocks).
 */
export function resolveProbeWiring(
  wiring: UniverseRebuildProbeWiring,
): UniverseRebuildProbeWiring {
  return wiring;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const wiring = resolveProbeWiring(await loadWiringFromEnv());
  const store = new UniverseRebuildCheckpointStore({ path: args.checkpoint });
  const checkpoint = await store.load();
  if (checkpoint === null) {
    throw new Error("no universe rebuild checkpoint at " + args.checkpoint);
  }
  const run = checkpoint.inProgressRun;
  if (run === null || run.runId !== args.runId) {
    throw new Error("no in-progress run " + args.runId);
  }
  const targets = Object.values(run.outcomesByCandidateKey).filter(
    (outcome) => outcome.status === "retryable",
  ).filter((outcome) =>
    args.familyCandidateKey !== undefined
      ? outcome.familyCandidateKey === args.familyCandidateKey
      : outcome.failureCode === args.failureCode
  ).slice(0, args.limit);
  if (targets.length === 0) {
    console.log(
      "universe-rebuild-probe: no matching retryable outcome" +
        (args.familyCandidateKey !== undefined
          ? " for " + args.familyCandidateKey
          : " with failure-code " + args.failureCode),
    );
    return;
  }
  // Concurrent probes are safe: each write is a CAS guarded by the target's
  // attemptCount and the store's file lock, so distinct keys never clobber
  // each other. Bounded workers keep the RPC load on the local node sane.
  const concurrency = Math.max(
    1,
    Math.min(8, Number(process.env.SEARCHER_PROBE_CONCURRENCY ?? "4")),
  );
  let nextTarget = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextTarget++;
      if (index >= targets.length) return;
      const target = targets[index];
      const next = await probeOneFailure({
        store,
        runId: args.runId,
        familyCandidateKey: target.familyCandidateKey,
        attestFamilyInstanceOnce: wiring.attestFamilyInstanceOnce,
        sealDurableVerifiedMemo: wiring.sealDurableVerifiedMemo,
        assertCanonicalHead: wiring.assertCanonicalHead,
        decodeCandidateSnapshot: wiring.decodeCandidateSnapshot,
      });
      console.log(
        "universe-rebuild-probe " + target.familyCandidateKey + " -> " +
          next.status +
          (next.status === "retryable"
            ? " attempt=" + next.attemptCount + " reason=" + next.reasonCode
            : next.status === "verified"
              ? " memo=" + next.memoFingerprint
              : " reason=" + next.reasonCode),
      );
    }
  }));
}

/**
 * Production wiring hook: the node integration (strict family lifecycle +
 * canonical memo seal + canonical head check) is registered here. The
 * separate production wiring module supplies the implementations; the CLI
 * itself stays dependency-free so it can also run against test fixtures.
 */
async function loadWiringFromEnv(): Promise<UniverseRebuildProbeWiring> {
  // SEARCHER_UNIVERSE_REBUILD_WIRING_PATH overrides the wiring module for
  // tests and fixtures; the default is the production wiring (strict family
  // lifecycle), imported lazily so non-production invocations never pull
  // the runtime stack.
  const override = process.env.SEARCHER_UNIVERSE_REBUILD_WIRING_PATH;
  if (override !== undefined && override.trim().length > 0) {
    const loaded = await import(override) as {
      createProbeWiring(): UniverseRebuildProbeWiring;
    };
    return loaded.createProbeWiring();
  }
  const production = await import("./universe-rebuild-production.js") as {
    createProbeWiring(): UniverseRebuildProbeWiring;
  };
  return production.createProbeWiring();
}

main().catch((error) => {
  console.error(
    "universe-rebuild-probe FAIL: " +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
