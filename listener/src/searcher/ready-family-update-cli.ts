import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReadyActivityArchive } from "./ready-activity-archive.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos, canonicalJson } from "./universe-rebuild-checkpoint.js";
import type { ReadyFamilyPartition } from "./universe-rebuild-checkpoint.js";
import { rebuildUniverse, updateReadyFamilies } from "./universe-rebuild-runner.js";
import { createRebuildWiring, familyDefinitionHash } from "./universe-rebuild-production.js";
import { resolveStrictReadyRuntime } from "./strict-ready-runtime.js";

/** One authoritative checkpoint. Scratch supplements are never live inputs.
 * Configuration/credentials use the normal process environment; no signing.
 * build: --checkpoint PATH --archive DIR --from-block N --to-block N
 * update: --checkpoint PATH --archive DIR (Family activation is the normal config)
 */
export async function runReadyFamilyMaintenance(argv: readonly string[]): Promise<void> {
  const mode = argv[0];
  if (mode !== "build" && mode !== "update") throw new Error("expected build or update");
  const options = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!["--checkpoint", "--archive", "--from-block", "--to-block", "--concurrency"].includes(key) ||
      value === undefined || options.has(key)) throw new Error("invalid Ready maintenance option");
    options.set(key, value);
  }
  if (!options.has("--checkpoint") || !options.has("--archive")) throw new Error("checkpoint and archive paths required");
  const checkpointPath = resolve(options.get("--checkpoint")!);
  const archiveDirectory = resolve(options.get("--archive")!);
  await withReadyMaintenanceLease(checkpointPath, () => runMaintenance(mode, options, checkpointPath, archiveDirectory));
}

/** Serialize long-running CLI operations, independently of the short checkpoint
 * CAS lock. Never steal another writer's lease on a timeout. A crash leaves an
 * explicit owner record for operator inspection; no partial Ready is promoted. */
export async function withReadyMaintenanceLease<T>(checkpointPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(checkpointPath), { recursive: true, mode: 0o700 });
  const path = checkpointPath + ".maintenance.lock";
  const lease = await open(path, "wx", 0o600);
  try {
    await lease.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    await lease.sync();
    return await operation();
  } finally { await lease.close(); await unlink(path); }
}

async function runMaintenance(mode: "build" | "update", options: Map<string, string>, checkpointPath: string, archiveDirectory: string): Promise<void> {
  const rpcUrl = process.env.MAINNET_RPC_URL;
  const executor = process.env.BOTVM_ADDRESS, transactionOrigin = process.env.BOTVM_OWNER;
  if (!rpcUrl || !executor || !transactionOrigin) throw new Error("configured RPC and execution identity required");
  const concurrency = Number(options.get("--concurrency") ?? 24);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 1024) throw new Error("invalid attestation concurrency");
  const common = { rpcUrl, executionIdentity: { executor, transactionOrigin } };
  const store = new UniverseRebuildCheckpointStore({ path: checkpointPath });
  const incumbent = await store.load();
  const discovery = createRebuildWiring(common);
  const log = (message: string) => console.log("[ready-maintenance] " + message);
  let source;
  let range;
  if (mode === "build") {
    const fromBlock = Number(options.get("--from-block")), toBlock = Number(options.get("--to-block"));
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 ||
      toBlock < fromBlock || toBlock - fromBlock >= 14_400) throw new Error("explicit bounded baseline range required");
    if (incumbent?.readyGeneration && incumbent.inProgressRun === null) throw new Error("baseline already complete; use update");
    range = { fromBlock, toBlock };
    source = await discovery.freezeCanonicalHead(toBlock);
    if (incumbent?.inProgressRun && (canonicalJson(incumbent.inProgressRun.cutoff) !== canonicalJson(source) ||
      incumbent.inProgressRun.fromBlock !== fromBlock)) throw new Error("baseline resume source mismatch");
  } else {
    if (options.has("--from-block") || options.has("--to-block")) throw new Error("update cannot move the Ready source");
    if (!incumbent) throw new Error("update requires a completed baseline");
    activeReadyMemos(incumbent);
    if (!incumbent.readyGeneration!.familyPartitions) throw new Error("legacy Ready requires a new partitioned baseline");
    range = incumbent.readyGeneration!.universeRange;
    source = incumbent.readyGeneration!.cutoff;
  }
  const archive = new ReadyActivityArchive({ directory: archiveDirectory, chainId: 1,
    ...range, cutoffHash: source.hash });
  const verifyArchivedInputs = async () => {
    const method = await archive.readTrace({ blockNumber: source.number, method: "trace_block" }) !== null
      ? "trace_block" : "debug_traceBlockByNumber";
    log("verifying complete compressed inputs before resuming admission");
    return archive.assertComplete({ method });
  };
  const wiring = createRebuildWiring({ ...common, activityArchive: archive });
  if (mode === "build") {
    // In-progress admission means the source scan is already sealed. Recheck
    // durable inputs before reusing it; fresh scans verify before sealing.
    if (incumbent?.inProgressRun) await verifyArchivedInputs();
    const ready = await rebuildUniverse({ ...wiring, store,
      runId: incumbent?.inProgressRun?.runId ?? `archived-baseline-${source.number}-${source.hash.slice(2, 14)}`,
      observationRange: range, attestationConcurrency: concurrency, log });
    resolveStrictReadyRuntime(ready);
    log(JSON.stringify({ status: "baseline-ready", generation: ready.generation, range,
      activeInstances: ready.activeInstanceKeys.length, archiveComplete: true, broadcast: false }));
    return;
  }
  const base = incumbent!;
  const partitions = base.readyGeneration!.familyPartitions!;
  const enabledIds = [...new Set(wiring.requiredSourceCoverageKeys().map(key => key.slice(0, key.indexOf("|"))))].sort();
  const needed = enabledIds.filter(id => readyFamilyNeedsSupplement({ partition: partitions[id],
    discoveryDefinitionHash: wiring.familyDiscoveryDefinitionHash!(id), familyDefinitionHash: familyDefinitionHash(id),
    isVerifiedMemoCurrent: key => wiring.isReadyMemoDefinitionCurrent!(base.verifiedMemos[key]!) === true }));
  const supplements = [];
  if (needed.length > 0) {
    const identity = createHash("sha256").update(canonicalJson({ parent: base.checkpointFingerprint,
      definitions: needed.map(id => [id, familyDefinitionHash(id)]) })).digest("hex");
    const stagingDir = resolve(dirname(checkpointPath), ".ready-family-updates", identity);
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const manifest = canonicalJson({ schema: "ready-family-supplement/v1", identity,
      parentCheckpointFingerprint: base.checkpointFingerprint, parentRevision: base.revision,
      range, source, familyIds: needed, sourcePlan: createRebuildWiring({ ...common, familyIds: needed }).expectedSourcePlanFingerprints(),
      definitions: needed.map(id => [id, familyDefinitionHash(id)]) });
    await assertReadyStageManifest(resolve(stagingDir, "parent.json"), manifest);
    const stagePath = resolve(stagingDir, "checkpoint.json");
    try { await copyFile(checkpointPath, stagePath, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if ((await store.load())?.checkpointFingerprint !== base.checkpointFingerprint) throw new Error("Ready changed while preparing scoped update");
    const scoped = createRebuildWiring({ ...common, familyIds: needed, activityArchive: archive });
    const stageStore = new UniverseRebuildCheckpointStore({ path: stagePath });
    const stage = await stageStore.load();
    if (!stage) throw new Error("scoped checkpoint absent");
    if (stage.inProgressRun) await verifyArchivedInputs();
    const familyUpdateScope = { parentCheckpointFingerprint: base.checkpointFingerprint, familyIds: needed };
    const completed = stage.checkpointFingerprint !== base.checkpointFingerprint && stage.inProgressRun === null &&
      canonicalJson(stage.readyGeneration?.familyUpdateScope ?? null) === canonicalJson(familyUpdateScope);
    // A copied base or the deterministic same-run resume is the only input.
    if (stage.checkpointFingerprint !== base.checkpointFingerprint &&
      stage.inProgressRun?.runId !== `family-update-${identity}` &&
      !completed) {
      throw new Error("scoped checkpoint lineage mismatch");
    }
    if (completed) activeReadyMemos(stage);
    const ready = completed ? stage.readyGeneration! : await rebuildUniverse({ ...scoped, store: stageStore, runId: `family-update-${identity}`,
      familyUpdateScope, observationRange: range, attestationConcurrency: concurrency, log });
    resolveStrictReadyRuntime(ready);
    supplements.push({ familyIds: needed, checkpoint: (await stageStore.load())! });
  }
  const ready = await updateReadyFamilies({ ...wiring, store, expectedRevision: base.revision, supplements, log });
  resolveStrictReadyRuntime(ready);
  log(JSON.stringify({ status: "updated-ready", generation: ready.generation,
    supplementalFamilies: needed, activeInstances: ready.activeInstanceKeys.length, broadcast: false }));
}

export async function assertReadyStageManifest(path: string, manifest: string): Promise<void> {
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (handle) {
    try { await handle.writeFile(manifest); await handle.sync(); } finally { await handle.close(); }
  }
  if (await readFile(path, "utf8") !== manifest) throw new Error("scoped checkpoint parent manifest mismatch");
}

export function readyFamilyNeedsSupplement(input: {
  partition: ReadyFamilyPartition | undefined;
  discoveryDefinitionHash: string;
  familyDefinitionHash: string;
  isVerifiedMemoCurrent: (candidateKey: string) => boolean;
}): boolean {
  const partition = input.partition;
  if (!partition || partition.discoveryDefinitionHash !== input.discoveryDefinitionHash) return true;
  return Object.values(partition.outcomesByCandidateKey).some(outcome =>
    (outcome.status === "verified" && !input.isVerifiedMemoCurrent(outcome.familyCandidateKey)) ||
    (outcome.status === "terminal-rejected" && outcome.familyDefinitionHash !== input.familyDefinitionHash));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReadyFamilyMaintenance(process.argv.slice(2)).then(() => process.exit(0)).catch(error => {
    let message = String(error?.message ?? "Ready maintenance failed");
    if (process.env.MAINNET_RPC_URL) message = message.replaceAll(process.env.MAINNET_RPC_URL, "[RPC_REDACTED]");
    console.error(message.replace(/(?:https?|wss?):\/\/[^\s"<>]+/g, "[URL_REDACTED]"));
    process.exit(1);
  });
}
