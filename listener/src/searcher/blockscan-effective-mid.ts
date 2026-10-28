import assert from "node:assert/strict";
import { gasReferenceInput } from "./blockscan-amount-reference.js";
import type { StrictProductionRuntimeSession } from "./strict-production-runtime-session.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { blockScanEdgeKey, type VerifiedGraphView } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import type { ResolvedBlockScanQuote } from "./detector/blockscan-scanner-core.js";
import { deltaMap, scannerConsumesEdge } from "./blockscan-pricing-delta.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { observeAdapterRequests } from "./adapter-request-observation.js";
import type { EffectiveEthColumns } from "./blockscan-eth-view.js";

export type EffectivePricingInput = Pick<BlockScanStateSnapshot,
  "sourceBlock" | "sourceBlockHash" | "generation" | "pricingStateKeyByEdgeKey"> & {
  readonly graph: { readonly edges: BlockScanStateSnapshot["graph"]["edges"] };
  /** Structural compatibility only; neither field participates in sampling. */
  readonly mids: ReadonlyMap<string, { mid: number; feeBps: number }>;
  readonly coverage: { readonly resolvedEdgeKeys: readonly string[] };
};
/** Single global default P (0.002 WETH); a positive spread floor and available gas select G instead.
 * Exact reuses the resulting row amount and hands that same input to Solver. */
export const DEFAULT_EFFECTIVE_WETH_INPUT = 2_000_000_000_000_000n;
/** Maximum successful forward quotes used to derive an input amount. */
export const MAX_EFFECTIVE_INPUT_PATH_HOPS = 4;

export interface EffectiveMidRow {
  readonly edgeId: string;
  readonly instanceKey: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint | null;
  readonly amountOut: bigint | null;
  /** Output raw units / input raw units. Fee already included in amountOut. */
  readonly effectiveMid: number | null;
  readonly status: "quoted" | "missing-valuation" | "unsupported" |
    "quote-failed" | "no-output" | "cancelled" | "disabled-for-run";
  /** Original chain observation, not a current-block Exact handle. */
  readonly quotedAt?: CanonicalSource;
  /** Legacy serialized flag; current carry is derived from quotedAt + snapshot.source. */
  readonly carried?: true;
  /** A failed quote observed at least one fenced EVM revert; not a claim that
   * the revert was its sole cause. Successful revert-encoded quotes omit it. */
  readonly failureEvidence?: "evm-revert-observed";
  /** Derived enumeration columns on this same immutable effective row. */
  readonly eth?: EffectiveEthColumns;
  /** Compatibility quote index points here; no separately owned price row. */
  readonly enumeration?: ResolvedBlockScanQuote;
}

export interface EffectiveMidProgress {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly generation: number;
  readonly phase: "preparing" | "quoting" | "completed" | "interrupted";
  readonly totalDirections: number;
  readonly processedDirections: number;
  readonly pendingDirections: number;
  readonly cancelledDirections: number;
  readonly successfulDirections: number;
  readonly failedWithRevertEvidence: number;
  readonly otherQuoteFailures: number;
  readonly reusedDirections: number;
  readonly quoteCallsStarted: number;
  readonly quoteCallsSettled: number;
  /** Layer visits, not the number of rows retained in the complete table. */
  readonly frontierDirections: number;
  readonly inFlight: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly elapsedMs: number;
  readonly observedAtMs: number;
}

export interface EffectiveMidSnapshot {
  readonly source: CanonicalSource;
  readonly reference: "gas" | "default" | "fixed";
  /** Reference for newly quoted rows. Carried rows retain their original amounts. */
  readonly referenceWethInput: bigint;
  readonly rows: ReadonlyMap<string, EffectiveMidRow>;
  readonly complete: boolean;
  readonly wallMs: number;
}

export interface EffectiveAmountReference {
  readonly amountIn: bigint;
  /** Successful forward quotes from WETH, retaining their original observations.
   * With cascading off, the path may originate at an older WETH notional. */
  readonly path: readonly EffectiveMidRow[];
}

// Process-local policy identity and dependencies. Serialized legacy snapshots
// cannot prove that their inputs were derived without raw mids, so cannot carry.
const amountReferenceState = new WeakMap<EffectiveMidSnapshot, {
  readonly weth: string;
  readonly references: ReadonlyMap<string, EffectiveAmountReference>;
}>();
const rowAmountReferences = new WeakMap<EffectiveMidRow, EffectiveAmountReference>();

// Native changes belong to the effective producer, not to a second table scan.
// Weak previous ownership avoids retaining every historical publication.
interface EffectiveNativeChanges {
  readonly previous: WeakRef<EffectiveMidSnapshot>;
  readonly edges: readonly TokenEdge[];
  readonly updates: readonly (readonly [string, EffectiveMidRow])[];
  readonly removals: readonly string[];
}
const nativeChanges = new WeakMap<EffectiveMidSnapshot, EffectiveNativeChanges>();
const ownedRows = new WeakSet<ReadonlyMap<string, EffectiveMidRow>>();
function ownRows(rows: ReadonlyMap<string, EffectiveMidRow>, exclusive = false): ReadonlyMap<string, EffectiveMidRow> {
  if (ownedRows.has(rows)) return rows;
  // Native Maps remain compatible with history structuredClone. Only this
  // module's private copy is guarded; never change a caller/restore-owned Map.
  const copy = exclusive ? rows as Map<string, EffectiveMidRow> : new Map(rows);
  const reject = () => { throw new Error("effective rows are readonly"); };
  Object.defineProperties(copy, {
    set: { value: reject }, delete: { value: reject }, clear: { value: reject },
  });
  Object.freeze(copy); ownedRows.add(copy);
  return copy;
}

/** Only a producer-owned consecutive delta over the same immutable graph may
 * skip full validation. Serialized/foreign/mutable inputs take the full path. */
export function effectiveNativeChangesSince(pricing: EffectiveEnumerationPricing,
  previous: EffectiveMidSnapshot): EffectiveNativeChanges | undefined {
  const snapshot = pricing.effectiveMids;
  if (!snapshot) return undefined;
  assertEffectiveEnumerationSource(pricing);
  const changes = nativeChanges.get(snapshot);
  return changes?.previous.deref() === previous && changes.edges === pricing.graph.edges &&
    graphEdgeIndexes.has(changes.edges) && ownedRows.has(previous.rows) && ownedRows.has(snapshot.rows)
    ? changes : undefined;
}

// Ready publications retain the same immutable edge array across source blocks.
// Never cache a mutable fixture/input or any source-bound pricing-state mapping.
const graphEdgeIndexes = new WeakMap<readonly TokenEdge[], ReadonlyMap<string, TokenEdge>>();
function graphEdgeIndex(edges: readonly TokenEdge[]): ReadonlyMap<string, TokenEdge> {
  const cached = graphEdgeIndexes.get(edges);
  if (cached) return cached;
  const index = new Map(edges.map(edge => [blockScanEdgeKey(edge), edge]));
  if (Object.isFrozen(edges) && edges.every(edge => Object.isFrozen(edge) && edge.canonicalEdgeId &&
      (edge.routeBinding === undefined || Object.isFrozen(edge.routeBinding)))) graphEdgeIndexes.set(edges, index);
  return index;
}

export function effectiveAmountReferences(snapshot: EffectiveMidSnapshot):
ReadonlyMap<string, EffectiveAmountReference> | undefined {
  return amountReferenceState.get(snapshot)?.references;
}

/** A carried row keeps the path that actually supplied its recorded amountIn. */
export function effectiveRowAmountReference(row: EffectiveMidRow): EffectiveAmountReference | undefined {
  return rowAmountReferences.get(row);
}

/** Data-only historical checkpoint. No session, request result or Exact authority
 * crosses the process boundary. Original paths must survive carried samples. */
export interface EffectiveMidReplayState {
  readonly version: 1;
  readonly weth: string;
  readonly references: readonly EffectiveAmountReference[];
  readonly byToken: readonly (readonly [string, number])[];
  readonly byRow: readonly (readonly [string, number])[];
}

export function exportEffectiveMidReplayState(snapshot: EffectiveMidSnapshot): EffectiveMidReplayState {
  const state = amountReferenceState.get(snapshot);
  assert(snapshot.complete && state, "complete forward-quote lineage required for benchmark baseline");
  const references: EffectiveAmountReference[] = [], ids = new Map<EffectiveAmountReference, number>();
  const id = (reference: EffectiveAmountReference) => {
    let value = ids.get(reference);
    if (value === undefined) { value = references.length; ids.set(reference, value); references.push(reference); }
    return value;
  };
  return { version: 1, weth: state.weth, references,
    byToken: [...state.references].map(([token, reference]) => [token, id(reference)] as const),
    byRow: [...snapshot.rows].flatMap(([key, row]) => {
      const reference = rowAmountReferences.get(row);
      return reference ? [[key, id(reference)] as const] : [];
    }) };
}

export interface EffectiveMidReplayDelta {
  readonly source: CanonicalSource;
  readonly reference: EffectiveMidSnapshot["reference"];
  readonly referenceWethInput: bigint;
  readonly wallMs: number;
  readonly updates: readonly (readonly [string, EffectiveMidRow, EffectiveAmountReference | null])[];
  readonly removals: readonly string[];
  readonly tokenUpdates: readonly (readonly [string, EffectiveAmountReference])[];
  readonly tokenRemovals: readonly string[];
}

/** Persistence consumes the producer's native edits, never a full row diff.
 * Token lineage is small and distinct from the price table; only changed
 * references are emitted. No derived ETH/index columns cross the boundary. */
export function exportEffectiveMidReplayDelta(snapshot: EffectiveMidSnapshot,
  previous: EffectiveMidSnapshot): EffectiveMidReplayDelta {
  const changes = nativeChanges.get(snapshot);
  const current = amountReferenceState.get(snapshot), prior = amountReferenceState.get(previous);
  assert(snapshot.complete && changes?.previous.deref() === previous && current && prior && current.weth === prior.weth,
    "continuation requires consecutive native effective publications");
  const same = (a: EffectiveAmountReference, b: EffectiveAmountReference | undefined) => a === b ||
    b !== undefined && a.amountIn === b.amountIn && a.path.length === b.path.length && a.path.every((row, i) => {
      const old = b.path[i]!;
      return row === old || row.edgeId === old.edgeId && row.instanceKey === old.instanceKey &&
        row.tokenIn === old.tokenIn && row.tokenOut === old.tokenOut && row.amountIn === old.amountIn &&
        row.amountOut === old.amountOut && row.status === old.status && row.effectiveMid === old.effectiveMid &&
        row.quotedAt?.number === old.quotedAt?.number && row.quotedAt?.hash === old.quotedAt?.hash &&
        row.quotedAt?.generation === old.quotedAt?.generation;
    });
  return { source: snapshot.source, reference: snapshot.reference, referenceWethInput: snapshot.referenceWethInput,
    wallMs: snapshot.wallMs, removals: changes.removals,
    updates: changes.updates.map(([id, row]) => [id, row, rowAmountReferences.get(row) ?? null] as const),
    tokenUpdates: [...current.references].filter(([token, ref]) => !same(ref, prior.references.get(token))),
    tokenRemovals: [...prior.references.keys()].filter(token => !current.references.has(token)) };
}

export function restoreEffectiveMidReplayState(snapshot: EffectiveMidSnapshot,
  state: EffectiveMidReplayState, edges: readonly TokenEdge[], weth: string): void {
  assert(snapshot.complete && state.version === 1 && state.weth === weth.toLowerCase(), "incompatible effective baseline");
  const graph = graphEdgeIndex(edges);
  const references = state.references.map(reference => {
    assert(typeof reference.amountIn === "bigint" && reference.amountIn > 0n &&
      Array.isArray(reference.path) && reference.path.length <= MAX_EFFECTIVE_INPUT_PATH_HOPS, "invalid amount lineage");
    let token = state.weth, output: bigint | undefined;
    const visited = new Set([token]);
    for (const step of reference.path) {
      const edge = graph.get(step.edgeId);
      assert(edge && !edge.leavesStandingPosition && step.status === "quoted" &&
        step.instanceKey === edgeInstanceKey(edge) && step.tokenIn === token &&
        step.tokenIn === edge.tokenIn.toLowerCase() && step.tokenOut === edge.tokenOut.toLowerCase() &&
        typeof step.amountIn === "bigint" && step.amountIn > 0n &&
        typeof step.amountOut === "bigint" && step.amountOut > 0n &&
        (output === undefined || step.amountIn === output) && step.quotedAt &&
        step.quotedAt.number <= snapshot.source.number && step.quotedAt.generation <= snapshot.source.generation &&
        (step.quotedAt.number !== snapshot.source.number || step.quotedAt.hash.toLowerCase() === snapshot.source.hash.toLowerCase()),
      "invalid historical forward-quote path");
      assert(!visited.has(step.tokenOut), "cyclic historical forward-quote path");
      token = step.tokenOut; visited.add(token); output = step.amountOut;
    }
    assert(output === undefined || output === reference.amountIn, "lineage output differs from input amount");
    return { reference: Object.freeze({ ...reference, path: Object.freeze(reference.path.map(row => Object.freeze({ ...row }))) }), token };
  });
  const tokens = new Map<string, EffectiveAmountReference>();
  for (const [token, id] of state.byToken) {
    assert(Number.isSafeInteger(id) && references[id]?.token === token && !tokens.has(token), "invalid token lineage index");
    tokens.set(token, references[id]!.reference);
  }
  assert(tokens.get(state.weth)?.amountIn === snapshot.referenceWethInput, "WETH baseline amount changed");
  const rows = new Map<EffectiveMidRow, EffectiveAmountReference>();
  for (const [key, id] of state.byRow) {
    const row = snapshot.rows.get(key), reference = references[id];
    assert(row && !rows.has(row) && Number.isSafeInteger(id) && reference &&
      reference.token === row.tokenIn && reference.reference.amountIn === row.amountIn, "invalid row lineage index");
    rows.set(row, reference.reference);
  }
  for (const [key, row] of snapshot.rows) {
    const edge = graph.get(row.edgeId);
    assert(edge && key === row.edgeId && row.instanceKey === edgeInstanceKey(edge) && row.tokenIn === edge.tokenIn.toLowerCase() &&
      row.tokenOut === edge.tokenOut.toLowerCase() &&
      ["quoted", "missing-valuation", "unsupported", "quote-failed", "no-output", "disabled-for-run"].includes(row.status),
    "baseline row differs from Ready");
    assert(row.amountIn === null || rows.has(row), "baseline omitted amount lineage");
    if (row.status === "quoted") {
      assert(typeof row.amountIn === "bigint" && row.amountIn > 0n && typeof row.amountOut === "bigint" && row.amountOut > 0n &&
        row.effectiveMid !== null && Number.isFinite(row.effectiveMid) && row.effectiveMid > 0 && row.quotedAt &&
        row.quotedAt.number <= snapshot.source.number && row.quotedAt.generation <= snapshot.source.generation &&
        (row.quotedAt.number !== snapshot.source.number || row.quotedAt.hash.toLowerCase() === snapshot.source.hash.toLowerCase()),
      "invalid historical quote observation");
    } else assert((row.status === "no-output" ? row.amountOut === 0n : row.amountOut === null) &&
      row.effectiveMid === null, "unavailable row cannot supply a quote");
  }
  // Serialization drops frozen descriptors, including on unquoted carried rows.
  // Restore their producer invariant only after the entire input has validated;
  // this does not issue a native delta or bypass source/graph/ownership checks.
  for (const row of snapshot.rows.values()) {
    if (row.quotedAt) Object.freeze(row.quotedAt);
    Object.freeze(row);
  }
  for (const [row, reference] of rows) rowAmountReferences.set(row, reference);
  amountReferenceState.set(snapshot, { weth: state.weth, references: tokens });
}

export function resolveEffectiveAmountCascade(raw?: string): boolean {
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error("SEARCHER_BLOCKSCAN_EFFECTIVE_AMOUNT_CASCADE_ENABLED must be 0 or 1");
}

export function effectiveMidRowCarried(snapshot: EffectiveMidSnapshot, row: EffectiveMidRow): boolean {
  const at = row.quotedAt;
  return at === undefined ? row.carried === true : at.number !== snapshot.source.number ||
    at.hash.toLowerCase() !== snapshot.source.hash.toLowerCase() || at.generation !== snapshot.source.generation;
}

/** Consumer-only projection of current effective amounts and graph identity.
 * Raw mids provide neither amount sizing nor enumeration fallback. */
export type EffectiveEnumerationPricing = Pick<BlockScanStateSnapshot,
  "sourceBlock" | "sourceBlockHash" | "generation" | "effectiveMids"> & {
  readonly graph: { readonly edges: readonly TokenEdge[] };
  readonly mids?: EffectivePricingInput["mids"];
};
const projectedRows = new WeakMap<EffectiveMidRow, { edge: TokenEdge; quote: ResolvedBlockScanQuote }>();

/** Add derived columns without changing observed amounts, lineage or an older
 * publication. The returned map is the effective table, not an ETH row table. */
export function withEffectiveRowColumns(snapshot: EffectiveMidSnapshot,
  columns: ReadonlyMap<string, EffectiveEthColumns | undefined>): EffectiveMidSnapshot {
  const updates: (readonly [string, EffectiveMidRow])[] = [];
  for (const [id, eth] of columns) {
    const row = snapshot.rows.get(id);
    if (!row) continue;
    const enumeration = row.status === "quoted" ? projectedRows.get(row)?.quote : undefined;
    if (row.eth === eth && row.enumeration === enumeration) continue;
    const { eth: _old, enumeration: _projection, ...amounts } = row;
    // Derived indexes are process-local. History workers/old baseline files
    // retain the native amount format and must not clone graph/ETH indexes on
    // every publication. Direct row access still owns the only derived copy.
    const next: EffectiveMidRow = Object.freeze(Object.defineProperties(amounts, {
      ...(eth === undefined ? {} : { eth: { value: eth, enumerable: false } }),
      ...(enumeration === undefined ? {} : { enumeration: { value: enumeration, enumerable: false } }),
    }));
    const reference = rowAmountReferences.get(row);
    if (reference) rowAmountReferences.set(next, reference);
    const projected = projectedRows.get(row);
    if (projected) projectedRows.set(next, projected);
    updates.push([id, next]);
  }
  if (updates.length === 0) return snapshot;
  const next = Object.freeze({ ...snapshot, rows: ownRows(deltaMap(snapshot.rows, updates, []), true) });
  const references = amountReferenceState.get(snapshot);
  if (references) amountReferenceState.set(next, references);
  const changes = nativeChanges.get(snapshot);
  if (changes) nativeChanges.set(next, changes);
  return next;
}
export function effectiveEnumerationMids(pricing: EffectiveEnumerationPricing): ReadonlyMap<string, ResolvedBlockScanQuote> {
  const mids = new Map<string, ResolvedBlockScanQuote>();
  visitEffectiveEnumerationQuotes(pricing, (key, quote) => mids.set(key, quote));
  return mids;
}

/** The publication consumer can organize its derived columns during the same
 * validation pass. A visitor must keep its draft private until this returns:
 * a later invalid row still rejects the entire publication. */
export function visitEffectiveEnumerationQuotes(pricing: EffectiveEnumerationPricing,
  visit: (key: string, quote: ResolvedBlockScanQuote) => void): void {
  const effective = assertEffectiveEnumerationSource(pricing);
  const edges = graphEdgeIndex(pricing.graph.edges);
  for (const [key, row] of effective.rows) {
    const quote = enumerationQuote(edges, key, row);
    if (quote) visit(key, quote);
  }
}

function assertEffectiveEnumerationSource(pricing: EffectiveEnumerationPricing): EffectiveMidSnapshot {
  const effective = pricing.effectiveMids;
  if (effective === undefined) throw new Error("enumeration effective pricing missing");
  if (!effective.complete || effective.source.number !== pricing.sourceBlock ||
      effective.source.hash.toLowerCase() !== pricing.sourceBlockHash.toLowerCase() ||
      effective.source.generation !== pricing.generation) {
    throw new Error("enumeration effective pricing incomplete or mismatched source");
  }
  return effective;
}

/** Same validation for a full initial table and for each native changed row. */
export function effectiveEnumerationQuote(pricing: EffectiveEnumerationPricing, key: string,
  row: EffectiveMidRow): ResolvedBlockScanQuote | undefined {
  return enumerationQuote(graphEdgeIndex(pricing.graph.edges), key, row);
}
function enumerationQuote(edges: ReadonlyMap<string, TokenEdge>, key: string,
  row: EffectiveMidRow): ResolvedBlockScanQuote | undefined {
  if (row.status !== "quoted") return undefined;
  const edge = edges.get(key);
  const instance = edge && edgeInstanceKey(edge);
  if (!edge || row.edgeId !== key || row.instanceKey !== instance ||
      row.tokenIn.toLowerCase() !== edge.tokenIn.toLowerCase() ||
      row.tokenOut.toLowerCase() !== edge.tokenOut.toLowerCase() || row.effectiveMid === null ||
      !Number.isFinite(row.effectiveMid) || row.effectiveMid <= 0 ||
      typeof row.amountIn !== "bigint" || typeof row.amountOut !== "bigint" || row.amountIn <= 0n || row.amountOut <= 0n) {
    throw new Error("invalid effective enumeration row");
  }
  const cached = projectedRows.get(row);
  if (cached && cached.edge === edge && cached.quote.pool === instance &&
      cached.quote.mid === row.effectiveMid && cached.quote.quoteAmountIn === row.amountIn &&
      cached.quote.quoteAmountOut === row.amountOut) {
    return cached.quote;
  }
  const quote: ResolvedBlockScanQuote = Object.freeze({ kind: "external-swap", pool: instance!, edges: Object.freeze([edge]),
    mid: row.effectiveMid, feeBps: 0, depthProxy: 0,
    quoteAmountIn: row.amountIn, quoteAmountOut: row.amountOut });
  // Reuse allocation, not validation/authority: all source, identity and
  // amount checks still run, including for mutable diagnostic inputs.
  projectedRows.set(row, { edge, quote });
  return quote;
}

// A bound use of the existing quote entry, not a second Family/central API.
// The caller supplies executor/evidence through its source-bound session closure.
type ExactCall = StrictProductionRuntimeSession["issueExact"];
type RouteExactResult = Extract<Awaited<ReturnType<ExactCall>>, { readonly amountIn: bigint }>;
type EffectiveMidQuote = (
  input: Pick<Parameters<ExactCall>[0],
    "edge" | "amountIn" | "control">,
) => Promise<Pick<RouteExactResult, "source" | "amountIn" | "amountOut">>;

/** One effective build only. A selected instance may bind several directions;
 * keep those source-bound sessions for later layers instead of reissuing them.
 * This is not cross-source quote caching or the Solver's ordered-prefix session. */
export function createEffectiveQuoteSessions(
  prepare: (requiredEdgeIds: ReadonlySet<string>) => Promise<StrictProductionRuntimeSession>,
) {
  const byEdge = new Map<string, StrictProductionRuntimeSession>();
  return {
    async prepareQuote(requiredEdgeIds: ReadonlySet<string>): Promise<void> {
      const missing = new Set([...requiredEdgeIds].filter(id => !byEdge.has(id)));
      if (missing.size === 0) return;
      const session = await prepare(missing);
      for (const edge of session.edges) byEdge.set(blockScanEdgeKey(edge), session);
    },
    sessionFor(edge: TokenEdge): StrictProductionRuntimeSession {
      const session = byEdge.get(blockScanEdgeKey(edge));
      if (!session) throw new Error("effective quote session was not prepared");
      return session;
    },
  };
}

/** Forward effective sampling: shortest successful WETH paths first, then the
 * greatest output at that depth. Depth-four tokens still quote their outgoing
 * edges, but those outputs cannot seed a fifth-hop sampling reference. */
export async function buildEffectiveMids(input: {
  /** Verified pricing-state identity; raw mids are deliberately not consumed. */
  readonly pricing: EffectivePricingInput;
  readonly quoteGraph?: VerifiedGraphView;
  readonly weth: string;
  readonly gasCostWei: bigint | null;
  /** Explicit diagnostic notional. Omitted by live callers. */
  readonly fixedWethInput?: bigint;
  readonly enumerationSpreadBps: number;
  /** Requote clean rows only when their forward input quantity changes.
   * Off preserves each clean row's original amount pair and input lineage. */
  readonly cascadeAmountChanges?: boolean;
  readonly quote: EffectiveMidQuote;
  /** Called once per nonempty fresh layer, after its input amounts are known.
   * All quotes from the previous layer have settled before new bindings are
   * prepared. Effective samples never share an Exact prefix. */
  readonly prepareQuote?: (requiredEdgeIds: ReadonlySet<string>) => Promise<void>;
  readonly control: AdapterWorkControl;
  readonly concurrency: number;
  readonly previous?: EffectiveMidSnapshot;
  /** Run-local policy exclusions, not Ready/admission rejections. Apply before
   * carry and quote preparation, including each-block and full refreshes. */
  readonly disabledEdgeIds?: ReadonlySet<string>;
  /** The complete pricing-state touched set. Undefined is
   * bootstrap/full refresh, not an empty block. Pricing references only: no
   * per-method reuse declaration. Amount-change invalidation is opt-in above. */
  readonly touchedStateKeys?: ReadonlySet<string>;
  /** Bounded periodic telemetry. Observer errors cannot change quote results. */
  readonly onProgress?: (progress: EffectiveMidProgress) => void;
}): Promise<EffectiveMidSnapshot> {
  const started = Date.now();
  const { pricing, control } = input;
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 ||
      !Number.isFinite(input.enumerationSpreadBps) || input.enumerationSpreadBps < 0) {
    throw new Error("invalid effective-mid work or spread policy");
  }
  if (input.gasCostWei !== null && input.gasCostWei <= 0n) throw new Error("invalid gas cost");
  if (input.fixedWethInput !== undefined && input.fixedWethInput <= 0n) throw new Error("invalid fixed effective input");
  const target = input.quoteGraph ?? pricing;
  const source = Object.freeze({
    number: target.sourceBlock, hash: target.sourceBlockHash.toLowerCase(), generation: target.generation,
  });
  // A strictly-positive opportunity filter may have a zero threshold. There
  // is no finite gas-cover notional at 0%; use the same global fallback P,
  // without changing the enumeration threshold or pretending this covers gas.
  const gasCostWei = input.fixedWethInput !== undefined || input.enumerationSpreadBps === 0 ? null : input.gasCostWei;
  const defaultInput = input.fixedWethInput ?? DEFAULT_EFFECTIVE_WETH_INPUT;
  const referenceWethInput = gasCostWei === null ? defaultInput :
    gasReferenceInput(gasCostWei, { num: 1n, den: 1n }, input.enumerationSpreadBps)!;
  const weth = input.weth.toLowerCase();
  const edges = graphEdgeIndex((input.quoteGraph ?? pricing.graph).edges);
  const stateKeyFor = (edgeId: string, edge: (typeof pricing.graph.edges)[number]) =>
    (pricing.pricingStateKeyByEdgeKey?.get(edgeId) ?? edgeInstanceKey(edge)).toLowerCase();
  // Membership comes from the verified graph, never the availability of a raw
  // mid. In particular, a successful Exact can recover an unpriced direction.
  const keys = [...edges].filter(([key, edge]) => scannerConsumesEdge(edge) ||
    pricing.pricingStateKeyByEdgeKey?.has(key)).map(([key]) => key);
  const work = keys.map(edgeId => {
    const edge = edges.get(edgeId)!;
    return { edgeId, edge, amountIn: null as bigint | null,
      reference: undefined as EffectiveAmountReference | undefined };
  });
  const rows = new Array<EffectiveMidRow>(work.length);
  const byStatus: Record<string, number> = {};
  const reusedIndices = new Set<number>();
  let settledDirections = 0, failedWithRevertEvidence = 0;
  let quoteCallsStarted = 0, quoteCallsSettled = 0;
  let frontierDirections = 0;
  let lastProgressAt = Date.now();
  let phase: EffectiveMidProgress["phase"] = "preparing";
  const storeRow = (index: number, row: EffectiveMidRow, reused = false) => {
    const prior = rows[index];
    if (prior) {
      byStatus[prior.status] = byStatus[prior.status]! - 1;
      if (prior.failureEvidence === "evm-revert-observed") failedWithRevertEvidence--;
    } else settledDirections++;
    rows[index] = row;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.failureEvidence === "evm-revert-observed") failedWithRevertEvidence++;
    if (reused) reusedIndices.add(index); else reusedIndices.delete(index);
  };
  const report = () => {
    if (!input.onProgress) return;
    const now = Date.now(), cancelled = byStatus.cancelled ?? 0;
    lastProgressAt = now;
    try { input.onProgress(Object.freeze({
      sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation, phase,
      totalDirections: work.length, processedDirections: settledDirections - cancelled,
      pendingDirections: work.length - settledDirections, cancelledDirections: cancelled,
      successfulDirections: byStatus.quoted ?? 0, failedWithRevertEvidence,
      otherQuoteFailures: (byStatus["quote-failed"] ?? 0) - failedWithRevertEvidence,
      reusedDirections: reusedIndices.size, quoteCallsStarted, quoteCallsSettled, frontierDirections,
      inFlight: quoteCallsStarted - quoteCallsSettled, byStatus: Object.freeze({ ...byStatus }),
      elapsedMs: Math.max(0, now - started), observedAtMs: now,
    })); } catch { /* Telemetry has no effect on pricing. */ }
  };
  const closed = () => control.signal?.aborted === true ||
    (control.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs);
  const writeRow = (index: number, result: Pick<EffectiveMidRow,
    "status" | "amountOut" | "effectiveMid" | "quotedAt" | "carried" | "failureEvidence">) => {
    const { edgeId, edge, amountIn } = work[index]!;
    storeRow(index, Object.freeze({ edgeId, instanceKey: edgeInstanceKey(edge),
      tokenIn: edge.tokenIn.toLowerCase(), tokenOut: edge.tokenOut.toLowerCase(), amountIn, ...result }));
    const reference = work[index]!.reference;
    if (reference) rowAmountReferences.set(rows[index]!, reference);
  };
  const unavailable = (index: number, status: EffectiveMidRow["status"]) =>
    writeRow(index, { status, amountOut: null, effectiveMid: null });
  const failed = (index: number, error: unknown, revertedResults: number) => {
    const status = closed() ? "cancelled" :
      (error as { code?: unknown })?.code === "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" ? "unsupported" : "quote-failed";
    writeRow(index, { status, amountOut: null, effectiveMid: null,
      ...(status === "quote-failed" && revertedResults > 0
        ? { failureEvidence: "evm-revert-observed" as const } : {}) });
  };
  const accept = (index: number, result: Awaited<ReturnType<EffectiveMidQuote>>) => {
    if (closed()) { unavailable(index, "cancelled"); return; }
    const { amountIn } = work[index]!;
    if (amountIn === null || result.source.number !== source.number || result.source.hash.toLowerCase() !== source.hash ||
        result.source.generation !== source.generation || result.amountIn !== amountIn) {
      throw new Error("effective quote changed source or amount");
    }
    const amountOut = result.amountOut;
    const rate = Number(amountOut) / Number(amountIn);
    if (amountOut < 0n || !Number.isFinite(rate) || (amountOut > 0n && rate <= 0)) {
      throw new Error("invalid quote output");
    }
    const status = amountOut > 0n ? "quoted" : "no-output";
    if (closed()) { unavailable(index, "cancelled"); return; }
    writeRow(index, { status, amountOut, effectiveMid: amountOut > 0n ? rate : null,
      ...(status === "quoted" ? { quotedAt: source } : {}) });
  };

  // Classify carry before any quote can yield. Only snapshots built with this
  // policy in this process may carry; deserialized raw-mid-era amounts cannot.
  const previous = input.previous;
  const previousState = previous && amountReferenceState.get(previous);
  const canReuse = previous !== undefined && previousState?.weth === weth && input.touchedStateKeys !== undefined &&
    ((input.fixedWethInput === undefined && previous.reference !== "fixed") ||
      (previous.reference === "fixed" && previous.referenceWethInput === input.fixedWethInput)) &&
    ((source.number > previous.source.number && source.generation > previous.source.generation) ||
      (source.number === previous.source.number && source.generation >= previous.source.generation &&
        source.hash === previous.source.hash.toLowerCase()));
  const reusable = new Map<number, EffectiveMidRow>();
  const enabled = (index: number) => {
    const { edgeId, edge } = work[index]!;
    return !input.disabledEdgeIds?.has(edgeId) &&
      (!edge.leavesStandingPosition || pricing.pricingStateKeyByEdgeKey?.has(edgeId));
  };
  for (const [index, { edgeId, edge }] of work.entries()) {
    if (input.disabledEdgeIds?.has(edgeId)) {
      // The current run's exclusion is authoritative even when the pool is
      // touched. Reuse only the identical empty tombstone, never an old quote
      // or amount lineage; otherwise unchanged exclusions become native edits.
      const prior = canReuse ? previous.rows.get(edgeId) : undefined;
      if (prior?.status === "disabled-for-run" && Object.isFrozen(prior) &&
          prior.edgeId === edgeId && prior.instanceKey === edgeInstanceKey(edge) &&
          prior.tokenIn === edge.tokenIn.toLowerCase() && prior.tokenOut === edge.tokenOut.toLowerCase() &&
          prior.amountIn === null && prior.amountOut === null && prior.effectiveMid === null &&
          prior.quotedAt === undefined && prior.carried === undefined && prior.failureEvidence === undefined &&
          prior.eth === undefined && prior.enumeration === undefined && !rowAmountReferences.has(prior)) {
        storeRow(index, prior);
      } else unavailable(index, "disabled-for-run");
    } else if (edge.leavesStandingPosition && !pricing.pricingStateKeyByEdgeKey?.has(edgeId)) {
      unavailable(index, "unsupported");
    }
    else if (closed()) unavailable(index, "cancelled");
    else {
      const prior = canReuse ? previous.rows.get(edgeId) : undefined;
      const stateKey = stateKeyFor(edgeId, edge);
      if (prior && (prior.status === "quoted" || (previous!.complete && prior.status !== "cancelled")) && prior.edgeId === edgeId &&
          prior.instanceKey === edgeInstanceKey(edge) &&
          prior.tokenIn === edge.tokenIn.toLowerCase() && prior.tokenOut === edge.tokenOut.toLowerCase() &&
          !input.touchedStateKeys!.has(stateKey)) {
        reusable.set(index, prior);
        if (!input.cascadeAmountChanges) storeRow(index, prior, true);
      }
    }
  }

  const references = new Map<string, EffectiveAmountReference>([[weth,
    Object.freeze({ amountIn: referenceWethInput, path: Object.freeze([]) })]]);
  const pending = Array.from({ length: MAX_EFFECTIVE_INPUT_PATH_HOPS + 1 }, () => new Map<string, EffectiveAmountReference>());
  const offer = (token: string, reference: EffectiveAmountReference) => {
    if (references.has(token) || reference.path.length === 0 || reference.path.length > MAX_EFFECTIVE_INPUT_PATH_HOPS) return;
    const candidates = pending[reference.path.length]!;
    const prior = candidates.get(token);
    // Equal outputs use the complete edge path, independent of graph ordering
    // and asynchronous quote completion.
    if (!prior || reference.amountIn > prior.amountIn || (reference.amountIn === prior.amountIn &&
        reference.path.map(row => row.edgeId).join("\n") < prior.path.map(row => row.edgeId).join("\n"))) {
      candidates.set(token, reference);
    }
  };
  const offerOutput = (row: EffectiveMidRow, reference: EffectiveAmountReference) => {
    if (row.status !== "quoted" || edges.get(row.edgeId)!.leavesStandingPosition ||
        reference.path.length >= MAX_EFFECTIVE_INPUT_PATH_HOPS || row.tokenOut === weth ||
        row.tokenOut === row.tokenIn || reference.path.some(step => step.tokenIn === row.tokenOut)) return;
    offer(row.tokenOut, Object.freeze({ amountIn: row.amountOut!,
      path: Object.freeze([...reference.path, row]) }));
  };
  const seededClean = new Set<number>();
  if (!input.cascadeAmountChanges) {
    // With cascading off, clean tuples remain historical samples. Their
    // ORIGINAL lineage can seed quantities even if an upstream pool changed;
    // never attach a new prefix to an old, differently sized output. All such
    // candidates are seeded before layers run, so their actual path depth,
    // rather than the current frontier depth, determines shortest-path rank.
    for (const [index, row] of reusable) {
      const reference = rowAmountReferences.get(row);
      if (!reference || !reference.path.every(step => {
        const edge = edges.get(step.edgeId);
        return edge && !edge.leavesStandingPosition && !input.disabledEdgeIds?.has(step.edgeId) &&
          step.instanceKey === edgeInstanceKey(edge) &&
          step.tokenIn === edge.tokenIn.toLowerCase() && step.tokenOut === edge.tokenOut.toLowerCase();
      })) continue;
      offer(work[index]!.edge.tokenIn.toLowerCase(), reference);
      offerOutput(row, reference);
      // Its original input/output candidates are already seeded. Visiting this
      // row in a layer would only store the identical row and offer them again.
      if (row.amountIn !== null) seededClean.add(index);
    }
  }

  // Quote frontiers are indexed by input token, not repeated full-table scans.
  // Null-input clean rows stay here: a newly successful upstream quote may make
  // them reachable, even when their own state key was untouched.
  const workByToken = new Map<string, number[]>();
  for (let index = 0; index < work.length; index++) {
    if (seededClean.has(index) || !enabled(index)) continue;
    const token = work[index]!.edge.tokenIn.toLowerCase();
    const indices = workByToken.get(token);
    if (indices) indices.push(index); else workByToken.set(token, [index]);
  }

  report();
  const progressTimer = input.onProgress ? setInterval(report, 5000) : undefined;
  progressTimer?.unref();
  try {
  for (let depth = 0; depth <= MAX_EFFECTIVE_INPUT_PATH_HOPS; depth++) {
    const layer: number[] = depth === 0 ? [...(workByToken.get(weth) ?? [])] : [];
    for (const [token, reference] of pending[depth]!) {
      if (!references.has(token)) {
        references.set(token, reference);
        for (const index of workByToken.get(token) ?? []) layer.push(index);
      }
    }
    // Preserve graph order within a layer, including preparation/dispatch order.
    layer.sort((a, b) => a - b);
    frontierDirections += layer.length;
    const fresh: number[] = [];
    for (const index of layer) {
      const item = work[index]!;
      item.reference = references.get(item.edge.tokenIn.toLowerCase())!;
      item.amountIn = item.reference.amountIn;
      const prior = reusable.get(index);
      if (prior && prior.amountIn !== null &&
          (!input.cascadeAmountChanges || prior.amountIn === item.amountIn)) storeRow(index, prior, true);
      else if (closed()) unavailable(index, "cancelled");
      else fresh.push(index);
    }
    // Structural reachability is not a quote demand: failed upstream samples
    // and clean carried rows need no new authority. Batch only this frontier;
    // successful outputs below will determine the next one, without capping it.
    if (input.prepareQuote && fresh.length > 0 && !closed()) {
      phase = "preparing";
      report();
      await input.prepareQuote(new Set(fresh.map(index => work[index]!.edgeId)));
    }
    if (phase !== "quoting") {
      phase = "quoting";
      report();
    }
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = fresh[next++];
        if (index === undefined) return;
        if (closed()) { unavailable(index, "cancelled"); continue; }
        const { edge, amountIn } = work[index]!;
        const observation = { revertedResults: 0 };
        quoteCallsStarted++;
        try {
          accept(index, await observeAdapterRequests(observation,
            () => input.quote({ edge, amountIn: amountIn!, control })));
        } catch (error) { failed(index, error, observation.revertedResults); }
        finally {
          quoteCallsSettled++;
          // Resolved/cached quotes can keep the microtask queue busy, so a
          // timer alone cannot report progress while these workers advance.
          if (Date.now() - lastProgressAt >= 5000) report();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(input.concurrency, fresh.length) }, worker));
    for (const index of layer) {
      const row = rows[index]!;
      const reference = input.cascadeAmountChanges ? work[index]!.reference : rowAmountReferences.get(row);
      if (reference) offerOutput(row, reference);
    }
  }
  for (let index = 0; index < work.length; index++) {
    if (rows[index] === undefined) unavailable(index, closed() ? "cancelled" : "missing-valuation");
  }
  const previousRows = canReuse ? previous.rows : new Map<string, EffectiveMidRow>();
  let immutableRows = true;
  const updates = rows.filter(row => {
    immutableRows &&= Object.isFrozen(row);
    return previousRows.get(row.edgeId) !== row;
  })
    .map(row => Object.freeze([row.edgeId, row] as const));
  const present = new Set(keys);
  const removals = [...previousRows.keys()].filter(key => !present.has(key));
  const snapshot: EffectiveMidSnapshot = Object.freeze({ source,
    reference: input.fixedWethInput !== undefined ? "fixed" : gasCostWei === null ? "default" : "gas",
    referenceWethInput, rows: ownRows(deltaMap(previousRows, updates, removals),
      updates.length > 0 || removals.length > 0 || !canReuse),
    complete: !closed() && rows.every(row => row.status !== "cancelled"), wallMs: Date.now() - started });
  amountReferenceState.set(snapshot, { weth, references });
  if (canReuse && immutableRows) nativeChanges.set(snapshot, Object.freeze({
    previous: new WeakRef(previous), edges: (input.quoteGraph ?? pricing.graph).edges,
    updates: Object.freeze(updates), removals: Object.freeze(removals),
  }));
  phase = snapshot.complete ? "completed" : "interrupted";
  return snapshot;
  } finally {
    clearInterval(progressTimer);
    if (phase !== "completed") phase = "interrupted";
    report();
  }
}

/** Best two-venue indication at each row's recorded reference amount. Carried
 * rows may use older notionals; this is not a matched-quantity loop or sim/EV. */
export function effectiveMidPairStatistics(snapshot: EffectiveMidSnapshot, thresholdBps = 100): {
  directions: number; quoted: number; byStatus: Record<string, number>;
  comparablePairs: number; pairsAboveThreshold: number; thresholdBps: number;
} {
  if (!Number.isSafeInteger(thresholdBps) || thresholdBps < 0) throw new Error("invalid pair threshold");
  const pairs = new Map<string, [EffectiveMidRow[], EffectiveMidRow[]]>();
  const byStatus: Record<string, number> = {};
  for (const row of snapshot.rows.values()) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.status !== "quoted" || row.tokenIn === row.tokenOut) continue;
    const forward = row.tokenIn < row.tokenOut;
    const key = forward ? row.tokenIn + "|" + row.tokenOut : row.tokenOut + "|" + row.tokenIn;
    const sides = pairs.get(key) ?? [[], []];
    sides[forward ? 0 : 1].push(row);
    pairs.set(key, sides);
  }
  let comparablePairs = 0, pairsAboveThreshold = 0;
  for (const sides of pairs.values()) {
    const best = sides.map(side => {
      side.sort((a, b) => {
        const d = a.amountOut! * b.amountIn! - b.amountOut! * a.amountIn!;
        return d > 0n ? -1 : d < 0n ? 1 : 0;
      });
      const seen = new Set<string>();
      return side.filter(row => {
        if (seen.has(row.instanceKey)) return false;
        seen.add(row.instanceKey);
        return true;
      }).slice(0, 2);
    });
    let comparable = false, above = false;
    for (const a of best[0]!) for (const b of best[1]!) {
      if (a.instanceKey === b.instanceKey) continue;
      comparable = true;
      if (a.amountOut! * b.amountOut! * 10_000n >
          a.amountIn! * b.amountIn! * BigInt(10_000 + thresholdBps)) above = true;
    }
    if (comparable) comparablePairs++;
    if (above) pairsAboveThreshold++;
  }
  return { directions: snapshot.rows.size, quoted: byStatus.quoted ?? 0, byStatus,
    comparablePairs, pairsAboveThreshold, thresholdBps };
}
