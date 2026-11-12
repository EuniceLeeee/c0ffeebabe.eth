import { loadBotVmRuntimeCode } from "../shared/executor/botvm-executor.js";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReadyActivityArchive } from "./ready-activity-archive.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos, canonicalJson, canonicalJsonFingerprint } from "./universe-rebuild-checkpoint.js";
import type { ReadyFamilyPartition, ReadyUniverseGeneration } from "./universe-rebuild-checkpoint.js";
import { rebuildUniverse } from "./universe-rebuild-runner.js";
import { createRebuildWiring, familyDefinitionHash } from "./universe-rebuild-production.js";
import { resolveStrictReadyRuntime } from "./strict-ready-runtime.js";

/** One authoritative checkpoint and one complete-input review path.
 * Configuration/credentials use the normal process environment; no signing.
 * build: --checkpoint PATH --archive DIR --from-block N --to-block N [--families FILE] [--candidates FILE]
 * update: --checkpoint PATH --archive DIR [--families FILE] [--candidates FILE]
 *         [--force-update | --force-retryable | --revalidate-proofs HASH]
 * Families is the complete desired array of installed Family IDs; omission uses
 * the currently enabled catalog. Candidates is the complete desired array of
 * durable snapshots. Without it, retain the previous pool plus current discovery.
 * Force flags select work inside that same review; they never create a second
 * checkpoint or supplemental-Family execution path.
 */
export async function runReadyFamilyMaintenance(argv: readonly string[]): Promise<void> {
  const mode = argv[0];
  if (mode !== "build" && mode !== "update") throw new Error("expected build or update");
  const options = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--force-update" || key === "--force-retryable") {
      if (options.has(key)) throw new Error("invalid Ready maintenance option");
      options.set(key, "true");
      continue;
    }
    const value = argv[++i];
    if (!["--checkpoint", "--archive", "--from-block", "--to-block", "--concurrency", "--families", "--candidates", "--expect-update", "--revalidate-proofs"].includes(key) ||
      value === undefined || value.startsWith("--") || options.has(key)) throw new Error("invalid Ready maintenance option");
    options.set(key, value);
  }
  if (options.has("--expect-update") && (mode !== "update" || options.get("--expect-update") !== "family-set")) {
    throw new Error("--expect-update family-set requires update mode");
  }
  const proofRuntimeHash = options.get("--revalidate-proofs");
  if (proofRuntimeHash !== undefined && (mode !== "update" || !/^0x[0-9a-f]{64}$/.test(proofRuntimeHash) || options.has("--expect-update"))) {
    throw new Error("--revalidate-proofs requires update and a lower-case executor runtime hash");
  }
  if (options.has("--force-update") && (mode !== "update" || options.has("--expect-update") || proofRuntimeHash !== undefined)) {
    throw new Error("--force-update requires update mode and cannot be combined with --expect-update or --revalidate-proofs");
  }
  if (options.has("--force-retryable") && (mode !== "update" || options.has("--force-update") ||
      options.has("--expect-update") || proofRuntimeHash !== undefined)) {
    throw new Error("--force-retryable requires update mode and cannot be combined with --force-update, --expect-update or --revalidate-proofs");
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
  const proofRuntimeHash = options.get("--revalidate-proofs");
  const forceUpdate = options.has("--force-update");
  const forceStatuses = options.has("--force-retryable") ? ["retryable"] as const : undefined;
  if (proofRuntimeHash && loadBotVmRuntimeCode(transactionOrigin).keccak256 !== proofRuntimeHash) {
    throw new Error("Ready proof runtime differs from the installed executor artifact");
  }
  const familiesFile = options.get("--families");
  const familyIds = familiesFile === undefined ? undefined :
    parseReadyFamilyIds(JSON.parse(await readFile(resolve(familiesFile), "utf8")));
  const common = { rpcUrl, executionIdentity: { executor, transactionOrigin },
    ...(familyIds === undefined ? {} : { familyIds }) };
  const store = new UniverseRebuildCheckpointStore({ path: checkpointPath });
  const incumbent = await store.load();
  const discovery = createRebuildWiring(common);
  const enabledIds = familyIds ?? [...new Set(discovery.requiredSourceCoverageKeys().map(key => key.slice(0, key.indexOf("|"))))].sort();
  const selectedFile = options.get("--candidates");
  const candidateFile = selectedFile === undefined ? null : await readFile(resolve(selectedFile));
  const candidateFileFingerprint = candidateFile === null ? undefined : createHash("sha256").update(candidateFile).digest("hex");
  const explicit: unknown = candidateFile ? JSON.parse(candidateFile.toString("utf8")) : null;
  if (candidateFile && !Array.isArray(explicit)) throw new Error("expected an array of durable Family candidate snapshots");
  const snapshots = Array.isArray(explicit) ? explicit : [];
  const decode = (s: unknown) => discovery.decodeCandidateSnapshot!(s) as Readonly<Record<string, unknown>>;
  const startupCandidates = snapshots.map(decode);
  const keys = candidateFile ? new Set(startupCandidates.map(discovery.familyCandidateKey)) : undefined;
  if (keys && keys.size !== startupCandidates.length) throw new Error("duplicate candidate in explicit Ready scope");
  const selected = new Map<string, Record<string, unknown>>();
  if (candidateFile) for (const [index, candidate] of startupCandidates.entries()) {
    const id = discovery.candidateFamilyId(candidate);
    if (!enabledIds.includes(id)) throw new Error("candidate selection contains a disabled Family: " + id);
    let rows = selected.get(id);
    if (!rows) { rows = {}; selected.set(id, rows); }
    rows[discovery.familyCandidateKey(candidate)] = snapshots[index];
  }
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
    if (incumbent?.inProgressRun && incumbent.inProgressRun.currentInputFingerprint !== candidateFileFingerprint) {
      throw new Error("baseline resume input mismatch");
    }
  } else {
    if (options.has("--from-block") || options.has("--to-block")) throw new Error("update cannot move the Ready source");
    if (!incumbent) throw new Error("update requires a completed baseline");
    if (!incumbent.inProgressRun) activeReadyMemos(incumbent);
    else if (!incumbent.inProgressRun.reviewInputFingerprint) throw new Error("another Ready operation is in progress");
    if (!incumbent.readyGeneration!.familyPartitions) throw new Error("legacy Ready requires a new partitioned baseline");
    range = incumbent.readyGeneration!.universeRange;
    source = incumbent.readyGeneration!.cutoff;
  }
  const archive = new ReadyActivityArchive({ directory: archiveDirectory, chainId: 1,
    ...range, cutoffHash: source.hash });
  const verifyArchivedInputs = async () => {
    const pending = incumbent?.inProgressRun;
    // An explicitly empty sealed scope has no raw inputs to archive. The
    // runner still checks its complete input, source and resume bindings.
    if (discovery.requiredSourceCoverageKeys().length === 0 && pending?.candidateCount === 0 &&
        pending.sourceReceipts.length === 0) return;
    const method = await archive.readTrace({ blockNumber: source.number, method: "trace_block" }) !== null
      ? "trace_block" : "debug_traceBlockByNumber";
    log("verifying complete compressed inputs before resuming admission");
    return archive.assertComplete({ method });
  };
  const wiring = createRebuildWiring({ ...common, activityArchive: archive, readyThrottle: discovery.readyThrottle,
    ...(candidateFile === null ? {} : { startupCandidates }) });
  if (mode === "build") {
    // In-progress admission means the source scan is already sealed. Recheck
    // durable inputs before reusing it; fresh scans verify before sealing.
    if (incumbent?.inProgressRun) await verifyArchivedInputs();
    const ready = await rebuildUniverse({ ...wiring, store,
      runId: incumbent?.inProgressRun?.runId ?? `archived-baseline-${source.number}-${source.hash.slice(2, 14)}` +
        (candidateFileFingerprint === undefined ? "" : "-candidates-" + candidateFileFingerprint),
      ...(candidateFileFingerprint === undefined ? {} : { currentInputFingerprint: candidateFileFingerprint, currentCandidateKeys: keys }),
      observationRange: range, attestationConcurrency: concurrency, log });
    resolveStrictReadyRuntime(ready);
    log(JSON.stringify({ status: "baseline-ready", generation: ready.generation, range,
      activeInstances: ready.activeInstanceKeys.length, archiveComplete: true, broadcast: false }));
    return;
  }
  const base = incumbent!;
  const partitions = base.readyGeneration!.familyPartitions!;
  if (options.has("--expect-update")) {
    // Compatibility assertion only: it does not choose a separate update path,
    // and it never rechecks every verified memo in an unchanged partition.
    const changed = enabledIds.filter(id => !partitions[id] ||
      partitions[id]!.familyDefinitionHash !== familyDefinitionHash(id) ||
      partitions[id]!.discoveryDefinitionHash !== wiring.familyDiscoveryDefinitionHash!(id));
    if (!isFamilySetOnlyReadyUpdate(partitions, enabledIds, changed, candidateFile ? selected : undefined)) {
      throw new Error("requested Family-set update also changes rules or retained candidates; full review not started");
    }
  }
  const reviewedWiring = createRebuildWiring({ ...common, activityArchive: archive,
    readyThrottle: wiring.readyThrottle, startupCandidates: candidateFile ? startupCandidates :
      enabledIds.flatMap(id => Object.values(partitions[id]?.candidatesByKey ?? {}).map(decode)) });
  const inputFingerprint = readyMaintenanceReviewFingerprint({
    parent: base.readyGeneration!, range, source,
    definitions: enabledIds.map(id => [id, familyDefinitionHash(id)] as const),
    executionIdentity: common.executionIdentity, sourcePlans: reviewedWiring.expectedSourcePlanFingerprints(),
    selection: candidateFileFingerprint ?? "previous-and-discovered",
    ...(proofRuntimeHash && { proofRuntimeHash }), ...(forceUpdate && { forceUpdate }),
    ...(forceStatuses && { forceStatuses }),
  });
  if (base.inProgressRun) {
    if (base.inProgressRun.reviewInputFingerprint !== inputFingerprint) throw new Error("cannot resume Ready review with changed inputs");
    await verifyArchivedInputs();
  }
  log(JSON.stringify({ phase: "update-plan", familyCount: enabledIds.length,
    forceStatuses: forceStatuses ?? (forceUpdate ? ["terminal-rejected", "retryable"] : []),
    revalidateProofs: !!proofRuntimeHash, throttle: wiring.readyThrottle?.snapshot() }));
  const ready = await rebuildUniverse({ ...reviewedWiring, store, runId: "ready-review-" + inputFingerprint,
    previousReadyReview: { inputFingerprint, candidateKeys: keys,
      ...(proofRuntimeHash && { revalidateParentProofs: true }),
      ...(forceUpdate && { retryNegativeOutcomes: true }), ...(forceStatuses && { forceStatuses }) },
    resumeCompletedOutcomes: !!base.inProgressRun,
    observationRange: range, attestationConcurrency: concurrency, log });
  resolveStrictReadyRuntime(ready);
  log(JSON.stringify({ status: "reviewed-ready", generation: ready.generation,
    accounting: ready.candidateAccounting, activeInstances: ready.activeInstanceKeys.length, broadcast: false }));
}

/** Complete desired membership, not an add/remove command. Catalog validation
 * remains in createRebuildWiring; an empty array means no enabled Families. */
export function parseReadyFamilyIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id || id.trim() !== id)) {
    throw new Error("expected an array of Family IDs");
  }
  if (new Set(value).size !== value.length) throw new Error("duplicate Family ID in Ready family table");
  return Object.freeze([...(value as string[])].sort());
}

/** Keep the legacy review identity for existing options. A status-targeted
 * force adds its selection to that identity, so it cannot silently change on
 * crash resume. Progress and the shrinking pending list are never inputs. */
export function readyMaintenanceReviewFingerprint(input: {
  readonly parent: Pick<ReadyUniverseGeneration, "generation" | "universeHash" | "catalogHash">;
  readonly range: { readonly fromBlock: number; readonly toBlock: number };
  readonly source: ReadyUniverseGeneration["cutoff"];
  readonly definitions: readonly (readonly [string, string])[];
  readonly executionIdentity: { readonly executor: string; readonly transactionOrigin: string };
  readonly sourcePlans: { readonly startup: string; readonly activity: string };
  readonly selection: string;
  readonly proofRuntimeHash?: string;
  readonly forceUpdate?: boolean;
  readonly forceStatuses?: readonly ("verified" | "terminal-rejected" | "retryable")[];
}): string {
  return createHash("sha256").update(canonicalJson({ version: 1,
    parent: [input.parent.generation, input.parent.universeHash, input.parent.catalogHash],
    range: input.range, source: input.source, definitions: [...input.definitions].sort(([a], [b]) => a.localeCompare(b)),
    ...(input.proofRuntimeHash && { proofRuntimeHash: input.proofRuntimeHash }),
    ...(input.forceUpdate && { forceUpdate: true }),
    ...(input.forceStatuses?.length && { forceStatuses: [...new Set(input.forceStatuses)].sort() }),
    executionIdentity: input.executionIdentity, sourcePlans: input.sourcePlans, selection: input.selection,
  })).digest("hex");
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

export function isFamilySetOnlyReadyUpdate(
  partitions: Readonly<Record<string, ReadyFamilyPartition>>, enabledIds: readonly string[],
  needed: readonly string[], selection?: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): boolean {
  const now = new Set(enabledIds);
  const changed = enabledIds.some(id => !partitions[id]?.enabled) ||
    Object.entries(partitions).some(([id, p]) => p.enabled && !now.has(id));
  if (!changed || needed.some(id => partitions[id]?.enabled)) return false;
  // An explicit list may simply spell out the activation change. Compare the
  // full durable nominations of survivors, including identity/evidence fields.
  return !selection || enabledIds.every(id => !partitions[id] ||
    canonicalJsonFingerprint(selection.get(id) ?? {}, "universe-candidate-partition-v1:") === partitions[id]!.candidateSetHash);
}

export function readyFamilyNeedsSupplement(input: {
  partition: ReadyFamilyPartition | undefined;
  discoveryDefinitionHash: string;
  familyDefinitionHash: string;
  isVerifiedMemoCurrent: (candidateKey: string) => boolean;
}): boolean {
  const partition = input.partition;
  const sealedDefinition = partition?.familyDefinitionHash;
  if (sealedDefinition !== undefined && sealedDefinition !== input.familyDefinitionHash) return true;
  if (!partition || partition.discoveryDefinitionHash !== input.discoveryDefinitionHash) return true;
  return Object.values(partition.outcomesByCandidateKey).some(outcome =>
    (outcome.status === "verified" && !input.isVerifiedMemoCurrent(outcome.familyCandidateKey)) ||
    (outcome.status === "terminal-rejected" && outcome.familyDefinitionHash !== input.familyDefinitionHash &&
      !(outcome.reasonCode === "duplicate-instance" && sealedDefinition === input.familyDefinitionHash)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReadyFamilyMaintenance(process.argv.slice(2)).then(() => process.exit(0)).catch(error => {
    let message = String(error?.message ?? "Ready maintenance failed");
    if (process.env.MAINNET_RPC_URL) message = message.replaceAll(process.env.MAINNET_RPC_URL, "[RPC_REDACTED]");
    console.error(message.replace(/(?:https?|wss?):\/\/[^\s"<>]+/g, "[URL_REDACTED]"));
    process.exit(1);
  });
}
