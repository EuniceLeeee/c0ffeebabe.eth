import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, mkdir, rename, lstat, unlink, copyFile } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync, createReadStream } from "node:fs";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize, deserialize } from "node:v8";
import { historicalBaselineData } from "./blockscan-historical-benchmark.js";
import type { HistoricalPricingBaseline, StrictCurrentRuntimeCoordinator } from "./strict-current-runtime-coordinator.js";
import type { BlockScanAmountReference } from "./blockscan-amount-reference.js";
import type { StartupContinuationState, StartupExecutionPreflight } from "./blockscan-startup-execution-preflight.js";
import type { SimRejectContinuation, BlockScanSimRejectCache } from "./blockscan-sim-reject-cache.js";
import { exportEffectiveMidReplayDelta, type EffectiveMidReplayDelta,
  type EffectiveAmountReference, type EffectiveMidSnapshot } from "./blockscan-effective-mid.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";

export interface LivePricingContinuation {
  readonly version: 1;
  readonly identity: string;
  readonly pricing: HistoricalPricingBaseline;
  readonly amounts: ReturnType<BlockScanAmountReference["exportHistoricalBaseline"]>;
  readonly startup: StartupContinuationState;
  readonly simRejects: SimRejectContinuation;
}
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export interface LiveContinuationDelta {
  readonly version: 2;
  readonly previous: EffectiveMidSnapshot["source"];
  readonly source: EffectiveMidSnapshot["source"];
  readonly effective: EffectiveMidReplayDelta | null;
  readonly disabled: readonly string[];
  readonly amounts: ReturnType<BlockScanAmountReference["takeContinuationDelta"]>;
  readonly startup: ReturnType<StartupExecutionPreflight["takeContinuationDelta"]>;
  readonly simRejects: ReturnType<BlockScanSimRejectCache["takeContinuationDelta"]>;
}

interface JournalPointer {
  version: 2;
  identity: string;
  baseline: { file: string; digest: string; identity: string;
    historical?: { file: string; digest: string } };
  head: { file: string; digest: string; sequence: number } | null;
}
const sameSource = (a: EffectiveMidSnapshot["source"], b: EffectiveMidSnapshot["source"]) =>
  a.number === b.number && a.hash === b.hash && a.generation === b.generation;

export function liveContinuationEnabled(value?: string): boolean {
  assert(value === undefined || value === "0" || value === "1",
    "SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED must be 0 or 1");
  return value === "1";
}

/** Header observers also update the amount-reference module. Restore its
 * data first, then verify both anchors before installing any pricing state. */
export async function validateLiveContinuationAnchors(
  data: LivePricingContinuation, amounts: BlockScanAmountReference,
  observeHeader: (number: number) => Promise<{ readonly hash: string }>,
): Promise<void> {
  amounts.restoreHistoricalBaseline(data.amounts);
  amounts.takeContinuationDelta(); // Start recording post-baseline anchor observations.
  for (const at of [data.pricing.pricing, data.pricing.raw]) {
    const header = await observeHeader(at.sourceBlock);
    assert(header.hash.toLowerCase() === at.sourceBlockHash.toLowerCase(),
      "live continuation anchor reorged; use fresh-prices explicitly");
  }
}

/** Semantic producers, not consumer ranking/solver code. A pricing, Family,
 * compiler or simulation edit invalidates old data; unrelated CLI/telemetry
 * changes need not force another bootstrap. No stored execution authority. */
export function liveContinuationIdentity(context: unknown,
  root = fileURLToPath(new URL("../", import.meta.url))): string {
  return sha(JSON.stringify([1, context, liveContinuationFiles(root)]));
}

export function liveContinuationFiles(root = fileURLToPath(new URL("../", import.meta.url))): [string, string][] {
  const files: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (["test", "tests", "fixtures"].includes(entry.name) || /\.test\./.test(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /\.(ts|js|json)$/.test(entry.name)) files.push(child);
    }
  };
  for (const dir of ["adapters", "shared", "searcher/venues", "searcher/simulator"]) walk(join(root, dir));
  for (const name of ["compiler.ts", "encoder.ts", "types.ts"]) files.push(join(root, name));
  for (const name of ["main", "blockscan-runtime-loop", "pinned-reth-quote-backend",
    "blockscan-observed-header", "strict-ready-graph-view",
    "blockscan-effective-mid", "blockscan-amount-reference", "strict-current-runtime-coordinator",
    "strict-production-runtime-session", "strict-central-adapter-runtime", "adapter-family-exact-quote-cache",
    "blockscan-startup-execution-preflight", "blockscan-startup-node-simulation", "blockscan-live-continuation",
    "blockscan-touched-state", "blockscan-sim-reject-cache", "execution-asset-boundary",
    "exact-prefix-plan"]) files.push(join(root, "searcher", name + ".ts"));
  // Absent in the sealed v1 producer. Its original identity is still computed
  // exactly, while new consumers bind the new shared wiring as well.
  for (const name of ["blockscan-activity-transport", "blockscan-startup-filter"]) {
    const path = join(root, "searcher", name + ".ts");
    if (existsSync(path)) files.push(path);
  }
  return files.sort().map(path => [relative(root, path), sha(readFileSync(path))]);
}

/** Explicit, reviewed migration only: old evidence keeps its producer identity.
 * All semantic producer files are compared, not just a caller-provided subset.
 * Family/compiler changes are rejected. Simulator diagnosis-only changes need
 * the same exact inventory comparison and independent compatibility review. */
export function compatibleLiveContinuationIdentity(context: unknown, manifestPath: string,
  root = fileURLToPath(new URL("../", import.meta.url))): string {
  const proof = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(proof.schema === "reviewed-live-continuation-v1" && proof.review?.verdict === "compatible" &&
    isAbsolute(proof.producerSourceRoot), "invalid continuation compatibility manifest");
  const producer = liveContinuationFiles(proof.producerSourceRoot), consumer = liveContinuationFiles(root);
  assert(sha(JSON.stringify(producer)) === proof.producerFilesSha256 &&
    sha(JSON.stringify(consumer)) === proof.consumerFilesSha256, "continuation code changed after review");
  const before = new Map(producer), after = new Map(consumer);
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().filter(file => before.get(file) !== after.get(file))
    .map(file => ({ file, beforeSha256: before.get(file) ?? null, afterSha256: after.get(file) ?? null }));
  const eligible = new Set(["main", "blockscan-runtime-loop", "blockscan-live-continuation",
    "blockscan-effective-mid", "blockscan-amount-reference", "strict-current-runtime-coordinator",
    "blockscan-startup-execution-preflight", "blockscan-sim-reject-cache", "blockscan-activity-transport",
    "blockscan-startup-filter"].map(name => `searcher/${name}.ts`));
  eligible.add("searcher/simulator/eth-simulate-v1.ts");
  eligible.add("searcher/simulator/direct-revert-hop.ts");
  assert(changes.length && changes.every(change => eligible.has(change.file) && change.afterSha256 !== null),
    "continuation migration changed execution semantics or an unreviewed file");
  assert.deepEqual(changes, proof.changes, "continuation changes differ from reviewed manifest");
  const reviewBytes = readFileSync(resolve(dirname(manifestPath), proof.review.evidencePath));
  assert(sha(reviewBytes) === proof.review.evidenceSha256,
    "continuation migration evidence changed");
  if (proof.producerSpreadBps !== undefined) {
    const current = context as { fixedWethInput?: unknown; spreadBps?: unknown };
    const review = JSON.parse(reviewBytes.toString("utf8"));
    // An enumeration threshold cannot change a fixed input amount. Gas-derived
    // reference amounts are NOT eligible for this context-only migration.
    assert(typeof current.fixedWethInput === "string" && /^[1-9][0-9]*$/.test(current.fixedWethInput) &&
      Number.isFinite(current.spreadBps) && Number(current.spreadBps) >= 0 &&
      Number.isFinite(proof.producerSpreadBps) && proof.producerSpreadBps >= 0 &&
      review.producerSpreadBps === proof.producerSpreadBps && review.consumerSpreadBps === current.spreadBps &&
      review.fixedWethInput === current.fixedWethInput, "unreviewed or non-fixed continuation threshold change");
    return liveContinuationIdentity({ ...current, spreadBps: proof.producerSpreadBps }, proof.producerSourceRoot);
  }
  return liveContinuationIdentity(context, proof.producerSourceRoot);
}

/** One immutable baseline, then hash-chained, atomic delta commits. There is
 * deliberately no periodic full-table write or full-table fallback. */
export class LivePricingContinuationStore {
  private pointer: JournalPointer | null = null;
  private source: EffectiveMidSnapshot["source"] | null = null;
  constructor(private readonly directory: string, readonly identity: string,
    private readonly compatibleIdentity?: string) {
    assert(isAbsolute(directory) && /^[a-f0-9]{64}$/.test(identity), "invalid live continuation location");
  }
  private async privatePath(path: string, directory: boolean) {
    const stat = await lstat(path);
    assert(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
      (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()),
    "live continuation must be private, owned and not a symlink");
  }
  private file(name: string): string {
    assert(/^[a-zA-Z0-9.-]+$/.test(name), "invalid continuation file name");
    return join(this.directory, name);
  }
  private async exists(name: string): Promise<boolean> {
    try { await this.privatePath(this.file(name), false); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private async atomic(name: string, payload: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.privatePath(this.directory, true);
    const temporary = this.file("pending-" + randomUUID() + ".tmp");
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        // No Buffer.concat of a baseline-sized buffer.
        await handle.writeFile(Buffer.from(sha(payload) + "\n"));
        await handle.writeFile(payload); await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, this.file(name));
      const dir = await open(this.directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  private async decode(name: string, expected?: string): Promise<{ value: any; digest: string }> {
    await this.privatePath(this.file(name), false);
    const bytes = await readFile(this.file(name));
    const digest = bytes.subarray(0, 64).toString();
    assert(bytes.length > 65 && bytes[64] === 10 && sha(bytes.subarray(65)) === digest &&
      (expected === undefined || digest === expected), "live continuation checksum mismatch");
    return { value: deserialize(bytes.subarray(65)), digest };
  }
  private async commit(pointer: JournalPointer | null): Promise<void> {
    await this.atomic("current.bin", serialize({ version: 2, pointer }));
    this.pointer = pointer;
  }
  async read(): Promise<LivePricingContinuation | null> {
    try { await this.privatePath(this.directory, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    let pointer: JournalPointer | null;
    let legacy: LivePricingContinuation | undefined;
    if (await this.exists("current.bin")) {
      const current = (await this.decode("current.bin")).value;
      assert(current.version === 2, "invalid continuation pointer version");
      pointer = current.pointer;
      if (!pointer) return null; // Explicit fresh round, even if an old v1 file remains.
      assert(pointer.version === 2 && pointer.identity === this.identity, "live continuation is incompatible");
    } else {
      if (!await this.exists("latest.bin")) return null;
      const old = await this.decode("latest.bin");
      legacy = old.value;
      pointer = { version: 2, identity: this.identity,
        baseline: { file: "latest.bin", digest: old.digest, identity: old.value.identity }, head: null };
    }
    let data: LivePricingContinuation;
    if (pointer.baseline.historical) {
      const seed = (await this.decode(pointer.baseline.file, pointer.baseline.digest)).value;
      const historical = pointer.baseline.historical;
      await this.privatePath(this.file(historical.file), false);
      const bytes = await readFile(this.file(historical.file));
      assert(sha(bytes) === historical.digest, "historical continuation baseline checksum mismatch");
      const baseline = deserialize(bytes);
      assert(baseline.version === 1 && seed.version === 1, "historical continuation baseline version mismatch");
      data = { ...seed, pricing: baseline.pricing };
    } else data = legacy ?? (await this.decode(pointer.baseline.file, pointer.baseline.digest)).value;
    assert(data.version === 1 && data.identity === pointer.baseline.identity &&
      (data.identity === this.identity || data.identity === this.compatibleIdentity),
      "live continuation is incompatible; use fresh-prices explicitly");
    assert(data.pricing.pricing.effectiveMids?.complete && data.startup.version === 1 && data.simRejects?.version === 1,
      "live continuation is incomplete");
    // Walk only committed records. Uncommitted/partial side files are ignored;
    // any missing/corrupt committed record is an error, never a skipped block.
    const chain: NonNullable<JournalPointer["head"]>[] = [];
    let head = pointer.head;
    while (head) {
      assert(Number.isSafeInteger(head.sequence) && head.sequence > 0, "invalid continuation sequence");
      const record = (await this.decode(head.file, head.digest)).value;
      assert(record.version === 2 && record.identity === this.identity && record.sequence === head.sequence &&
        record.baseline === sha(JSON.stringify(pointer.baseline)) &&
        (record.previous === null ? head.sequence === 1 : record.previous.sequence === head.sequence - 1),
      "broken continuation chain");
      chain.push(head); head = record.previous;
    }
    const replay = new ContinuationReplay(data);
    for (const record of chain.reverse()) replay.apply((await this.decode(record.file, record.digest)).value.delta);
    const restored = replay.finish();
    this.pointer = pointer; this.source = restored.pricing.pricing.effectiveMids!.source;
    return restored;
  }
  /** Explicit new logical round: retire the old pointer before any warmup.
   * A failed fresh startup must not resume an older round on the next launch. */
  async beginFreshRound(): Promise<string | null> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.privatePath(this.directory, true);
    const previous = await this.exists("current.bin") ? "current.bin" : await this.exists("latest.bin") ? "latest.bin" : null;
    const archived = previous ? this.file("previous-" + randomUUID() + ".bin") : null;
    if (previous && archived) await copyFile(this.file(previous), archived);
    // Atomic tombstone prevents resuming any older round after a failed startup.
    await this.commit(null); this.source = null;
    return archived;
  }
  /** Initial baseline ONLY. Repeated calls fail instead of copying the table. */
  async write(data: LivePricingContinuation): Promise<void> {
    assert(this.pointer === null && data.version === 1 && data.identity === this.identity && data.pricing.pricing.effectiveMids?.complete,
      "only complete compatible pricing can be checkpointed");
    if (await this.exists("current.bin")) assert((await this.decode("current.bin")).value.pointer === null,
      "full baseline already exists; append native deltas instead");
    else assert(!await this.exists("latest.bin"), "existing baseline must be restored, not overwritten");
    const payload = serialize(historicalBaselineData(data));
    const file = "baseline-" + randomUUID() + ".bin";
    await this.atomic(file, payload);
    await this.commit({ version: 2, identity: this.identity,
      baseline: { file, digest: sha(payload), identity: data.identity }, head: null });
    this.source = data.pricing.pricing.effectiveMids!.source;
  }
  /** Existing historical CLI baseline: copy already serialized bytes using the
   * filesystem, without exporting/duplicating the live price table. The small
   * envelope carries current auxiliary state and the exact original checksum. */
  async seedHistorical(file: string, digest: string, state: Omit<LivePricingContinuation, "pricing">,
    source: EffectiveMidSnapshot["source"]): Promise<void> {
    assert(this.pointer === null && state.identity === this.identity && /^[a-f0-9]{64}$/.test(digest), "invalid historical seed");
    if (await this.exists("current.bin")) assert((await this.decode("current.bin")).value.pointer === null, "baseline already exists");
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.privatePath(this.directory, true);
    const name = "historical-" + randomUUID() + ".bin";
    await copyFile(file, this.file(name));
    await this.privatePath(this.file(name), false);
    const hasher = createHash("sha256");
    for await (const bytes of createReadStream(this.file(name))) hasher.update(bytes);
    assert(hasher.digest("hex") === digest, "historical seed changed while copying");
    const handle = await open(this.file(name), "r");
    try { await handle.sync(); } finally { await handle.close(); }
    const envelope = serialize(state), seed = "seed-" + randomUUID() + ".bin";
    await this.atomic(seed, envelope);
    await this.commit({ version: 2, identity: this.identity, head: null,
      baseline: { file: seed, digest: sha(envelope), identity: this.identity, historical: { file: name, digest } } });
    this.source = source;
  }
  async append(delta: LiveContinuationDelta): Promise<number> {
    assert(this.pointer && this.source && delta.version === 2 && sameSource(delta.previous, this.source),
      "continuation delta does not follow committed source");
    assert(delta.source.number >= this.source.number && delta.source.generation >= this.source.generation &&
      (delta.source.number !== this.source.number || delta.source.hash === this.source.hash) &&
      (delta.effective ? sameSource(delta.effective.source, delta.source) : sameSource(delta.source, this.source)),
    "continuation source changed without a valid pricing delta");
    const pointer = this.pointer;
    const sequence = (pointer.head?.sequence ?? 0) + 1;
    const payload = serialize(historicalBaselineData({ version: 2, identity: this.identity, sequence,
      baseline: sha(JSON.stringify(pointer.baseline)), previous: pointer.head, delta }));
    const digest = sha(payload), file = `delta-${sequence}-${digest}.bin`;
    await this.atomic(file, payload);
    await this.commit({ ...pointer, head: { file, digest, sequence } });
    this.source = delta.source;
    return payload.length;
  }
}

/** Startup-only reconstruction. Mutates exclusively decoded data; never clones
 * a full row map per delta and never supplies persisted execution authority. */
class ContinuationReplay {
  private effective: EffectiveMidSnapshot;
  private readonly rows;
  private readonly byToken: Map<string, EffectiveAmountReference>;
  private readonly byRow: Map<string, EffectiveAmountReference>;
  private readonly disabled;
  private readonly startup;
  private readonly routes;
  private readonly pools;
  private readonly headers;
  private readonly samples;
  constructor(private readonly base: LivePricingContinuation) {
    this.effective = base.pricing.pricing.effectiveMids!;
    this.rows = this.effective.rows as Map<string, import("./blockscan-effective-mid.js").EffectiveMidRow>;
    const lineage = base.pricing.lineage;
    this.byToken = new Map(lineage.byToken.map(([key, id]) => [key, lineage.references[id]!]));
    this.byRow = new Map(lineage.byRow.map(([key, id]) => [key, lineage.references[id]!]));
    this.disabled = new Set(base.pricing.disabledInstances);
    this.startup = new Map(base.startup.rows);
    this.routes = new Set(base.simRejects.routes); this.pools = new Set(base.simRejects.pools);
    this.headers = new Map(base.amounts.headers.map(h => [h.number, h]));
    this.samples = new Map(base.amounts.samples.map(s => [s.source.number, s]));
  }
  apply(delta: LiveContinuationDelta): void {
    assert(delta.version === 2 && sameSource(delta.previous, this.effective.source) &&
      delta.source.number >= delta.previous.number && delta.source.generation >= delta.previous.generation &&
      (delta.source.number !== delta.previous.number || delta.source.hash === delta.previous.hash), "invalid continuation source chain");
    if (delta.effective) {
      const edit = delta.effective;
      assert(sameSource(edit.source, delta.source), "effective delta source mismatch");
      for (const key of edit.removals) { this.rows.delete(key); this.byRow.delete(key); }
      for (const [key, row, reference] of edit.updates) {
        assert(key === row.edgeId, "invalid continuation row identity");
        this.rows.set(key, row);
        if (reference) this.byRow.set(key, reference); else this.byRow.delete(key);
      }
      for (const key of edit.tokenRemovals) this.byToken.delete(key);
      for (const [key, ref] of edit.tokenUpdates) this.byToken.set(key, ref);
      this.effective = { source: edit.source, reference: edit.reference, referenceWethInput: edit.referenceWethInput,
        wallMs: edit.wallMs, complete: true, rows: this.rows };
    } else assert(sameSource(delta.source, delta.previous), "missing effective delta");
    for (const id of delta.disabled) this.disabled.add(id);
    if (delta.startup.reset) this.startup.clear();
    for (const [id, row] of delta.startup.rows) this.startup.set(id, row);
    if (delta.simRejects.reset) { this.routes.clear(); this.pools.clear(); }
    for (const id of delta.simRejects.routes) this.routes.add(id);
    for (const id of delta.simRejects.pools) this.pools.add(id);
    if (delta.amounts.reset) { this.headers.clear(); this.samples.clear(); }
    for (const id of delta.amounts.removedHeaders) this.headers.delete(id);
    for (const id of delta.amounts.removedSamples) this.samples.delete(id);
    for (const row of delta.amounts.headers) { this.headers.delete(row.number); this.headers.set(row.number, row); }
    for (const row of delta.amounts.samples) { this.samples.delete(row.source.number); this.samples.set(row.source.number, row); }
  }
  finish(): LivePricingContinuation {
    const references: EffectiveAmountReference[] = [], ids = new Map<EffectiveAmountReference, number>();
    const id = (ref: EffectiveAmountReference) => {
      let found = ids.get(ref);
      if (found === undefined) { found = references.length; ids.set(ref, found); references.push(ref); }
      return found;
    };
    const at = this.effective.source, previous = this.base.pricing.pricing;
    return { ...this.base, pricing: { ...this.base.pricing,
      pricing: { ...previous, sourceBlock: at.number, sourceBlockHash: at.hash, generation: at.generation,
        graph: { ...previous.graph, sourceBlock: at.number, sourceBlockHash: at.hash, generation: at.generation },
        effectiveMids: this.effective },
      lineage: { version: 1, weth: this.base.pricing.lineage.weth, references,
        byToken: [...this.byToken].map(([key, ref]) => [key, id(ref)]),
        byRow: [...this.byRow].map(([key, ref]) => [key, id(ref)]) }, disabledInstances: [...this.disabled] },
      startup: { version: 1, rows: [...this.startup] },
      simRejects: { version: 1, routes: [...this.routes], pools: [...this.pools] },
      amounts: { version: 1, headers: [...this.headers.values()], samples: [...this.samples.values()] } };
  }
}

/** Shared live/CLI lifecycle adapter. Native publication edits and auxiliary
 * writes are captured synchronously; bounded serial I/O retains no full-table
 * snapshots after the one-time baseline. Failure is visible and stops saving,
 * never falls back to a full export or skips a record. */
export class LivePricingContinuationWriter {
  private previous: BlockScanStateSnapshot | null = null;
  private raw: BlockScanStateSnapshot | null = null;
  private pending = Promise.resolve();
  private queued = 0;
  private failure: unknown;
  constructor(private readonly input: {
    store: LivePricingContinuationStore; coordinator: StrictCurrentRuntimeCoordinator;
    amounts: BlockScanAmountReference; startup: Pick<StartupExecutionPreflight, "exportContinuation" | "takeContinuationDelta">;
    simRejects: BlockScanSimRejectCache; restored?: boolean;
    onEvent: (event: Record<string, unknown>) => void;
  }) {
    if (input.restored) {
      const current = input.coordinator.continuationPricing();
      this.previous = current.pricing; this.raw = current.raw;
      assert(this.previous?.effectiveMids?.complete && this.raw, "restored journal requires installed pricing");
      input.amounts.startContinuationTracking();
    }
  }
  capture(): void {
    if (this.failure) return;
    try {
      const start = performance.now();
      const { raw, pricing } = this.input.coordinator.continuationPricing();
      if (!raw || !pricing?.effectiveMids?.complete) return;
      assert(this.raw === null || this.raw === raw, "continuation raw basis changed; journal stopped");
      // Keep at most a few small edits in flight. A slow/broken disk cannot
      // retain an unbounded chain of full pricing publications in memory.
      assert(this.queued < 8, "continuation storage backlog; journal stopped");
      const amounts = this.input.amounts.takeContinuationDelta();
      const startup = this.input.startup.takeContinuationDelta();
      const simRejects = this.input.simRejects.takeContinuationDelta();
      const disabled = this.input.coordinator.takeContinuationDisabled();
      let write: () => Promise<unknown>, kind: string;
      if (!this.previous) {
        const baseline: LivePricingContinuation = { version: 1, identity: this.input.store.identity,
          pricing: this.input.coordinator.exportHistoricalBaseline(), amounts: this.input.amounts.exportHistoricalBaseline(),
          startup: this.input.startup.exportContinuation(), simRejects: this.input.simRejects.exportContinuation() };
        write = () => this.input.store.write(baseline); kind = "baseline";
      } else {
        const effective = pricing === this.previous ? null : exportEffectiveMidReplayDelta(pricing.effectiveMids, this.previous.effectiveMids!);
        if (!effective && !disabled.length && !startup.reset && !startup.rows.length && !simRejects.reset &&
          !simRejects.routes.length && !simRejects.pools.length && !amounts.reset && !amounts.headers.length &&
          !amounts.samples.length && !amounts.removedHeaders.length && !amounts.removedSamples.length) return;
        const delta: LiveContinuationDelta = { version: 2, previous: this.previous.effectiveMids!.source,
          source: pricing.effectiveMids.source, effective, disabled, amounts, startup, simRejects };
        write = () => this.input.store.append(delta); kind = "delta";
      }
      this.raw = raw; this.previous = pricing;
      const sourceBlock = pricing.sourceBlock, captureMs = performance.now() - start;
      this.queued++;
      this.pending = this.pending.then(async () => {
        if (this.failure) return;
        const start = performance.now();
        const bytes = await write();
        this.input.onEvent({ phase: "saved", kind, sourceBlock, captureMs, wallMs: performance.now() - start,
          ...(typeof bytes === "number" ? { bytes } : {}) });
      }).catch(error => this.fail(error)).finally(() => { this.queued--; });
    } catch (error) { this.fail(error); }
  }
  private fail(error: unknown) {
    if (this.failure) return;
    this.failure = error;
    this.input.amounts.stopContinuationTracking();
    this.input.onEvent({ phase: "save-failed", previousCompleteCommitRetained: true,
      reason: String(error).replace(/https?:\/\/[^\s"'`]+/g, "[REDACTED_RPC]") });
  }
  async flush(): Promise<void> { await this.pending; if (this.failure) throw this.failure; }
}
