import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EffectiveMidHistoryReplay } from "./blockscan-effective-mid-history.js";
import { effectiveEnumerationMids, type EffectiveMidRow, type EffectiveMidSnapshot, type EffectivePricingInput } from "./blockscan-effective-mid.js";
import { scannerConsumesEdge } from "./blockscan-pricing-delta.js";
import { blockScanRouteId } from "./blockscan-route-identity.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { resolveStrictReadyRuntime } from "./strict-ready-runtime.js";
import { StrictReadyGraphViewCoordinator } from "./strict-ready-graph-view.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export type HistoricalEffectivePricing = EffectivePricingInput & { readonly effectiveMids: EffectiveMidSnapshot };
const verifiedHistoricalPrices = new WeakSet<HistoricalEffectivePricing>();
/** Historical data only: never a persisted execution/Funding authority. */
export function assertHistoricalEffectivePricing(pricing: HistoricalEffectivePricing,
  source: { number: number; hash: string }, edges: readonly TokenEdge[]): void {
  assert(verifiedHistoricalPrices.has(pricing), "historical prices must come from verified live-mids input");
  assert(pricing.sourceBlock === source.number && pricing.sourceBlockHash.toLowerCase() === source.hash.toLowerCase(),
    "historical effective source differs from execution source");
  assert.deepEqual(pricing.graph.edges.map(blockScanEdgeKey).sort(), edges.map(blockScanEdgeKey).sort(),
    "historical effective graph differs from Ready graph");
}
const amount = (value: unknown): bigint | null => {
  assert(value === null || (typeof value === "string" && /^\d+$/.test(value)), "invalid historical raw amount");
  return value === null ? null : BigInt(value as string);
};

export function historicalLiveConfig(bytes: string): Record<string, string> {
  const config = JSON.parse(bytes);
  assert(config !== null && typeof config === "object" && !Array.isArray(config) &&
    Object.values(config).every(value => typeof value === "string"), "invalid historical production config");
  return config;
}

/** Post-experiment P failures are not prior live knowledge. Keep this explicit
 * input separate from the cutoff-bound historical cache-hit evidence below. */
export function historicalExperimentReverts(path: string, expected: { source: { number: number; hash: string; generation: number } }) {
  const bytes = readFileSync(path), table = JSON.parse(bytes.toString());
  assert(table.schemaVersion === 1 && table.scope === "this-historical-experiment-only" && table.notHistoricalPriorKnowledge === true);
  // The table pins the chain header; the production events below additionally
  // pin the pricing generation. Headers do not contain a generation field.
  assert(table.source.number === expected.source.number && table.source.hash === expected.source.hash,
    "experiment rejection source mismatch");
  assert(Array.isArray(table.routes));
  const ids = new Set<string>();
  for (const row of table.routes) {
    assert(hash(row.evidence?.sha256) && typeof row.evidence.path === "string");
    const evidence = readFileSync(row.evidence.path);
    assert.equal(sha256(evidence), row.evidence.sha256, "experiment rejection evidence changed");
    const record = JSON.parse(evidence.toString(), (_key, value) => value?.$type === "bigint" ? BigInt(value.value) : value);
    const event = record.event;
    assert(record.source.number === expected.source.number && record.source.hash === expected.source.hash &&
      record.source.generation === expected.source.generation && event.type === "p_revert_recorded");
    assert(typeof event.p === "bigint" && event.p > 0n && String(event.p) === row.p &&
      positiveInteger(event.pTrials) && event.pTrials === row.pTrials, "experiment requires confirmed P trials");
    assert(event.routeId === row.routeId && blockScanRouteId(event.edges) === row.routeId && !ids.has(row.routeId));
    ids.add(row.routeId);
  }
  return { ids, provenance: { path, sha256: sha256(bytes), routes: ids.size,
    scope: "post-experiment only; not historical prior knowledge" } };
}

/** Data-only historical projection. Mids logs do not persist funding/read
 * authority. Downstream continuation must issue new strict execution/Funding
 * authority at the canonical source; this is never an atomic runtime. */
export function readHistoricalLiveMids(manifestPath: string, readyBytes: Buffer, block: number,
  catalog: ConstructorParameters<typeof StrictReadyGraphViewCoordinator>[0]["catalog"]) {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.schema, "at-block-live-mids/v1", "invalid live mids manifest");
  assert.equal(manifest.readySha256, sha256(readyBytes), "historical Ready hash mismatch");
  assert(typeof manifest.path === "string" && hash(manifest.sha256), "invalid live mids artifact reference");
  const path = resolve(dirname(manifestPath), manifest.path), bytes = readFileSync(path);
  assert.equal(sha256(bytes), manifest.sha256, "historical mids hash mismatch");
  assert(typeof manifest.configPath === "string" && hash(manifest.configSha256), "historical production config reference missing");
  const configPath = resolve(dirname(manifestPath), manifest.configPath), configBytes = readFileSync(configPath);
  assert.equal(sha256(configBytes), manifest.configSha256, "historical production config hash mismatch");
  const config = historicalLiveConfig(configBytes.toString());
  assert(typeof manifest.restorationProofPath === "string" && hash(manifest.restorationProofSha256),
    "historical restoration evidence reference missing");
  const restorationPath = resolve(dirname(manifestPath), manifest.restorationProofPath), restorationBytes = readFileSync(restorationPath);
  assert.equal(sha256(restorationBytes), manifest.restorationProofSha256, "historical restoration evidence hash mismatch");
  const restoration = JSON.parse(restorationBytes.toString());
  const saved = JSON.parse(bytes.toString());
  assert.equal(saved.schema, "frozen-live-mid-restoration/v1", "unsupported live mids restoration");
  assert.equal(saved.sourceBlock, block, "saved live mids source differs from --block");
  assert(typeof saved.sourceBlockHash === "string" && /^0x[a-f0-9]{64}$/i.test(saved.sourceBlockHash), "invalid historical source hash");
  assert(positiveInteger(saved.generation) && typeof saved.runId === "string" && saved.runId.length > 0,
    "invalid historical generation or run identity");
  assert(saved.baselineSeen === true && typeof saved.graphFingerprint === "string" && saved.graphFingerprint.length > 0,
    "historical mids lack baseline/graph provenance");
  assert(Array.isArray(restoration.snapshots) && restoration.snapshots.some((row: any) =>
    row.sourceBlock === block && row.generation === saved.generation && row.effectiveRows === saved.effective?.rows?.length),
  "historical restoration evidence does not describe this table");
  const { graph, ready } = resolveStrictReadyRuntime(JSON.parse(readyBytes.toString()).readyGeneration);
  const source = { number: block, hash: saved.sourceBlockHash, generation: saved.generation };
  const view = new StrictReadyGraphViewCoordinator({ catalog, ready, edges: graph }).build({
    id: "historical-coarse-data", topologyKey: `strict-ready:${ready.generation}:${ready.graphHash}`,
    generation: source.generation, sourceBlock: block, sourceBlockHash: source.hash, edges: graph });
  const fingerprint = [view.orderedEdgeHash, view.metadataHash, view.ownershipHash,
    String(view.scannerEdgeCount), view.scannerEdgeKeyHash].join("\u001f");
  assert.equal(fingerprint, saved.graphFingerprint, "historical Ready/publication graph fingerprint mismatch");
  const restored = new EffectiveMidHistoryReplay().apply(saved.effective, source)!;
  assert(restored && restored.complete === true, "historical effective table is incomplete");
  assert(["gas", "default", "fixed"].includes(restored.reference as string), "invalid historical effective reference");
  const referenceWethInput = amount(restored.reference_weth_input);
  assert(referenceWethInput !== null && referenceWethInput > 0n, "invalid historical effective reference amount");
  const graphKeys = new Set(graph.map(blockScanEdgeKey));
  const rows = new Map<string, EffectiveMidRow>();
  for (const [key, row] of restored.rows as [string, Record<string, any>][]) {
    assert(graphKeys.has(key), "historical effective row is absent from Ready");
    assert(["quoted", "missing-valuation", "unsupported", "quote-failed", "no-output", "cancelled", "disabled-for-run"].includes(row.status),
      "unknown historical effective status");
    if (row.quoted_at !== undefined) {
      assert(positiveInteger(row.quoted_at.number) && row.quoted_at.number <= block &&
        positiveInteger(row.quoted_at.generation) && row.quoted_at.generation <= saved.generation,
      "historical row has a future quote source");
      if (row.quoted_at.number === block) assert.equal(row.quoted_at.hash.toLowerCase(), source.hash.toLowerCase(),
        "historical row source hash mismatch");
    }
    rows.set(key, { edgeId: row.edge_id, instanceKey: row.instance_key, tokenIn: row.token_in, tokenOut: row.token_out,
      amountIn: amount(row.amount_in), amountOut: amount(row.amount_out), effectiveMid: row.effective_mid, status: row.status,
      ...(row.quoted_at === undefined ? {} : { quotedAt: row.quoted_at }), ...(row.carried ? { carried: true as const } : {}) });
  }
  const effectiveMids: EffectiveMidSnapshot = { source, reference: restored.reference as EffectiveMidSnapshot["reference"],
    referenceWethInput, complete: true, wallMs: Number(restored.wall_ms), rows };
  // This helper consumes only these public fields. The cast does not create a
  // runtime session or claim that the omitted atomic authority was persisted.
  const mids = effectiveEnumerationMids({ sourceBlock: block, sourceBlockHash: source.hash, generation: source.generation,
    graph: { edges: graph }, effectiveMids });
  const pricing: HistoricalEffectivePricing = Object.freeze({ sourceBlock: block, sourceBlockHash: source.hash,
    generation: source.generation, graph: { edges: graph }, effectiveMids, mids,
    coverage: { resolvedEdgeKeys: Object.freeze([...mids.keys()]) } });
  verifiedHistoricalPrices.add(pricing);
  return { runId: saved.runId as string, source, graph, config, pricing,
    edges: graph.filter(edge => !scannerConsumesEdge(edge) || mids.has(blockScanEdgeKey(edge))), mids,
    provenance: { manifestPath: resolve(manifestPath), manifestSha256: sha256(manifestBytes), path, sha256: sha256(bytes),
      readySha256: sha256(readyBytes), readyGeneration: ready.generation, readyCutoff: ready.cutoff,
      configPath, configSha256: manifest.configSha256,
      restorationEvidence: { path: restorationPath, sha256: manifest.restorationProofSha256,
        validation: "upstream reader evidence hash; original delta stream is not rerun by this CLI" },
      graphFingerprint: saved.graphFingerprint, effectiveRows: rows.size, quotedDirections: mids.size,
      graphEdges: graph.length, historyLine: saved.historyLine, authority: "coarse-data-only" } };
}

/** Only explicit, already-observed cache hits qualify. A trial's revert, RPC
 * error, or later-block rejection is not evidence of a prior route rejection. */
export function historicalRejectedRoutes(bytes: string, expected: { runId: string; source: { number: number; hash: string; generation: number } }) {
  const saved = JSON.parse(bytes);
  assert.equal(saved.schema, "at-block-rejected-routes/v1", "invalid historical reject manifest");
  assert.equal(saved.coverage, "observed-only", "historical cache completeness is not proven by these logs");
  assert.equal(saved.runId, expected.runId, "historical reject run mismatch");
  assert.equal(saved.sourceBlock, expected.source.number, "historical reject block mismatch");
  assert.equal(saved.sourceBlockHash?.toLowerCase(), expected.source.hash.toLowerCase(), "historical reject source hash mismatch");
  assert.equal(saved.generation, expected.source.generation, "historical reject generation mismatch");
  assert(positiveInteger(saved.cutoff?.emittedAtMs) && positiveInteger(saved.evidence?.prefixBytes) &&
    hash(saved.evidence?.prefixSha256) && Array.isArray(saved.routes), "historical reject evidence or cutoff missing");
  const proof = saved.cutoff.proof;
  assert(typeof proof?.rawLine === "string" && hash(proof.lineSha256) && sha256(proof.rawLine) === proof.lineSha256,
    "historical enumeration cutoff proof hash mismatch");
  const cutoffEvent = JSON.parse(proof.rawLine);
  assert(cutoffEvent.type === "block_scan_result" && cutoffEvent.run_id === expected.runId &&
    cutoffEvent.source_block === expected.source.number && cutoffEvent.state_block === expected.source.number &&
    cutoffEvent.pass_mode === "periodic" && cutoffEvent.pricing_mode === "source_n" &&
    cutoffEvent.coarse_source_block === null && cutoffEvent.coarse_source_block_hash === null &&
    cutoffEvent.exact_source_block_hash?.toLowerCase() === expected.source.hash.toLowerCase() &&
    cutoffEvent.stages?.enumeration?.started_at_ms === saved.cutoff.emittedAtMs &&
    saved.cutoff.timeField === "stages.enumeration.started_at_ms", "historical enumeration cutoff source mismatch");
  const ids = new Set<string>();
  for (const row of saved.routes) {
    assert(typeof row.rawLine === "string" && hash(row.lineSha256) && sha256(row.rawLine) === row.lineSha256,
      "historical reject event hash mismatch");
    const event = JSON.parse(row.rawLine);
    assert(event.type === "pipeline_dropped" && event.reason === "sim_revert_seen_this_live" &&
      (event.stage === "planner_solver" || event.stage === "enumeration") && event.run_id === expected.runId,
    "not a historical route cache-hit event");
    assert(typeof event.route_id === "string" && /^0x[a-f0-9]{64}$/.test(event.route_id) &&
      event.route_id === row.routeId && !ids.has(event.route_id), "invalid or duplicate rejected route identity");
    assert(positiveInteger(row.line) && Number.isSafeInteger(row.byteOffset) && row.byteOffset >= 0 &&
      row.byteOffset < saved.evidence.prefixBytes, "invalid historical reject event location");
    assert(positiveInteger(event.emitted_at_ms) && event.emitted_at_ms < saved.cutoff.emittedAtMs &&
      positiveInteger(event.source_block) && event.source_block < expected.source.number,
    "historical reject event is not before the tested enumeration");
    assert.equal(row.observedAtMs, event.emitted_at_ms);
    assert.equal(row.sourceBlock, event.source_block);
    ids.add(event.route_id);
  }
  return { ids, provenance: { ...saved, routes: undefined, routeCount: ids.size, sha256: sha256(bytes) },
    async verifyEvidence(): Promise<void> {
      assert(typeof saved.evidence.path === "string", "historical reject source file missing");
      assert(proof.path === undefined || proof.path === saved.evidence.path, "historical cutoff proof must use original event source offsets");
      const fd = openSync(saved.evidence.path, "r");
      try {
        const size = fstatSync(fd).size;
        assert(size >= saved.evidence.prefixBytes, "historical reject source is truncated");
        for (const row of [...saved.routes, proof]) {
          const expectedBytes = Buffer.from(row.rawLine);
          assert(Number.isSafeInteger(row.byteOffset) && row.byteOffset >= 0 && row.byteOffset + expectedBytes.length <= size,
            "historical reject proof offset outside source");
          if (row !== proof) assert(row.byteOffset + expectedBytes.length <= saved.evidence.prefixBytes,
            "historical reject event exceeds the prior prefix");
          const actual = Buffer.alloc(expectedBytes.length);
          assert(readSync(fd, actual, 0, actual.length, row.byteOffset) === actual.length && actual.equals(expectedBytes),
            "historical reject proof differs from original source bytes");
        }
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(saved.evidence.path,
          { fd, autoClose: false, start: 0, end: saved.evidence.prefixBytes - 1 })) digest.update(chunk);
        assert.equal(digest.digest("hex"), saved.evidence.prefixSha256, "historical reject source prefix hash mismatch");
      } finally { closeSync(fd); }
    } };
}

/** After ordinary funded-start dedup/ranking, before candidate caps. Rejecting
 * the representative cannot silently select another rotation of the same cycle.
 * Neither individual edges nor other routes sharing those edges are blocked. */
export function historicalRankedRouteEligibility(rejectedIds: ReadonlySet<string>) {
  const matched = new Set<string>();
  return {
    matched,
    rankedRouteEligible: (edges: readonly TokenEdge[]) => {
      const id = blockScanRouteId(edges);
      if (!rejectedIds.has(id)) return true;
      matched.add(id);
      return false;
    },
  };
}
