import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes } from "ethers";
import { gasReferenceInput } from "./blockscan-amount-reference.js";
import type { StrictProductionRuntimeSession } from "./strict-production-runtime-session.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { blockScanEdgeKey, type VerifiedGraphView } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey, explicitStateResourceKeys } from "./venues/route-instance-identity.js";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import type { ResolvedBlockScanQuote } from "./detector/blockscan-scanner-core.js";
import { deltaMap, scannerConsumesEdge } from "./blockscan-pricing-delta.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { observeAdapterRequests } from "./adapter-request-observation.js";
import { startupFailedFundingEdge } from "./startup-prefix-failure.js";
import type { EffectiveEthColumns } from "./blockscan-eth-view.js";
import { DEFAULT_EFFECTIVE_INPUT_PATH_HOPS, effectiveInputPathHops,
  resolveEffectiveInputPathHops } from "./effective-input-path-policy.js";
export { effectiveInputPathHops, resolveEffectiveInputPathHops } from "./effective-input-path-policy.js";

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
export const MAX_EFFECTIVE_INPUT_PATH_HOPS = DEFAULT_EFFECTIVE_INPUT_PATH_HOPS;

export interface EffectiveMidRow {
  readonly edgeId: string;
  readonly instanceKey: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint | null;
  readonly amountOut: bigint | null;
  /** The input budget remains amountIn, as in Exact. A simulation also records
   * its actual debit, which may be smaller when the program returns change. */
  readonly amountSpent?: bigint;
  readonly pricingMethod?: "startup-simulation" | "exact";
  /** The same funded transaction that supplied these amounts. The binding
   * commits to this row and its existing amount lineage, without a second copy
   * of all receipts. A pricing-method label alone grants no execution status. */
  readonly executionVerification?: EffectiveExecutionVerification;
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

export interface EffectiveExecutionVerification {
  readonly kind: "startup-simulation";
  /** Private encoding that produced the receipt; never a graph or price key. */
  readonly variantId?: string;
  readonly targetBlock: number;
  readonly scriptHash: string;
  readonly receiptHash: string;
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
  /** Omitted only by legacy snapshots, whose input-path policy was four. */
  readonly maxInputPathHops?: number;
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
  readonly source: CanonicalSource;
  readonly weth: string;
  readonly references: ReadonlyMap<string, EffectiveAmountReference>;
  /** Original authenticated samples admitted by this producer's existing
   * complete-activity/untouched carry path. The row's quotedAt never changes. */
  readonly verifiedExecutions: ReadonlySet<string>;
}>();
const rowAmountReferences = new WeakMap<EffectiveMidRow, EffectiveAmountReference>();
/** An original funded sample for ranking only. Not an EffectiveMidRow or an
 * execution capability; never serialized, fed into WETH prefixes or admitted to verifiedExecutions. */
export interface EffectiveHistoricalRankingHint {
  readonly kind:"historical-ranking-only"; readonly edgeId:string; readonly instanceKey:string;
  readonly tokenIn:string; readonly tokenOut:string; readonly amountIn:bigint; readonly amountOut:bigint;
  readonly effectiveMid:number; readonly quotedAt:CanonicalSource; readonly receiptHash:string; readonly variantId:string;
}
type RankingCause="prefixOnly"|"executionSubscriptionOnly"|"both"|"poolUnchanged";
interface RankingEntry { readonly hint:EffectiveHistoricalRankingHint; readonly prefix:readonly string[]; readonly edge:TokenEdge; readonly cause:RankingCause }
interface RankingState { readonly edges:readonly TokenEdge[]; readonly byId:ReadonlyMap<string,RankingEntry>;
  /** One anchored SQL native read only. Never registered in the generic locally issued receipt set. */
  readonly restoredPoolOrigins?:ReadonlyMap<string,EffectiveMidRow>;
  /** Last authenticated samples used ONLY to request an entire prefix at another source. Never current lineage. */
  readonly requestedOrigins?:ReadonlyMap<string,EffectiveMidRow> }
const rankingState=new WeakMap<EffectiveMidSnapshot,RankingState>();
const issuedRankingReceipts=new WeakSet<EffectiveExecutionVerification>();
// The general replay reader can record what it validated, but cannot enable SQL pool pricing.
const anchoredReplayGraphs=new WeakMap<EffectiveMidSnapshot,readonly TokenEdge[]>();
const restoredReplayPoolOrigins=new WeakMap<EffectiveMidSnapshot,ReadonlyMap<string,EffectiveMidRow>>();
export function effectiveHistoricalRankingHint(snapshot:EffectiveMidSnapshot,edge:TokenEdge):EffectiveHistoricalRankingHint|undefined {
  const entry=rankingState.get(snapshot)?.byId.get(blockScanEdgeKey(edge));
  return entry?.edge===edge ? entry.hint : undefined;
}

// Native changes belong to the effective producer, not to a second table scan.
// Weak previous ownership avoids retaining every historical publication.
interface EffectiveNativeChanges {
  readonly previous: WeakRef<EffectiveMidSnapshot>;
  readonly edges: readonly TokenEdge[];
  readonly updates: readonly (readonly [string, EffectiveMidRow])[];
  readonly removals: readonly string[];
  readonly dirtyUnfunded?: readonly string[];
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

/** Is this exact published row backed by its producer's verified SIM? A fresh
 * startup cannot use a deserialized proof in place of a local simulation. */
export function effectiveOwnsLocalExecutionReceipt(snapshot:EffectiveMidSnapshot,row:EffectiveMidRow):boolean {
  const proof=row.executionVerification;
  return !!proof&&snapshot.rows.get(row.edgeId)===row&&amountReferenceState.get(snapshot)?.verifiedExecutions.has(proof.receiptHash)===true&&
    issuedRankingReceipts.has(proof);
}

const executionReceiptFields = (row: EffectiveMidRow) => [row.edgeId, row.instanceKey,
  row.tokenIn, row.tokenOut, row.amountIn, row.amountSpent, row.amountOut,
  row.quotedAt && [row.quotedAt.number, row.quotedAt.hash.toLowerCase(), row.quotedAt.generation]];

/** A data binding issued by the existing authenticated startup receipt path.
 * This digest is not an independent EVM authenticator. Replay still requires
 * its original source, graph and complete amount lineage. */
export function effectiveExecutionReceiptHash(row: EffectiveMidRow, reference: EffectiveAmountReference,
  maxInputPathHops: number, targetBlock: number, scriptHash: string, variantId = row.executionVerification?.variantId): string {
  return keccak256(toUtf8Bytes(JSON.stringify({ kind: "startup-simulation", targetBlock, scriptHash,
    ...(variantId === undefined ? {} : {variantId}),
    ...(reference.path.some(step=>step.executionVerification?.variantId!==undefined)
      ? {prefixVariants:reference.path.map(step=>step.executionVerification?.variantId??null)} : {}),
    maxInputPathHops, row: executionReceiptFields(row), path: reference.path.map(executionReceiptFields) },
  (_, value) => typeof value === "bigint" ? value.toString() : value)));
}

/** Positive execution evidence belongs to the current price publication: a
 * fresh SIM or an original SIM carried through the producer's verified activity
 * boundary. Moving a table to another source cannot manufacture that authority. */
export function effectiveRowExecutionVerified(snapshot: Pick<EffectiveMidSnapshot, "source" | "maxInputPathHops">,
  row: EffectiveMidRow, edge: TokenEdge,
  reference: EffectiveAmountReference | undefined = rowAmountReferences.get(row)): boolean {
  const { source } = snapshot, policy = effectiveInputPathHops(snapshot.maxInputPathHops);
  const authority = amountReferenceState.get(snapshot as EffectiveMidSnapshot);
  if (authority && (authority.source.number !== source.number || authority.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
      authority.source.generation !== source.generation)) return false;
  const observed = row.quotedAt;
  const evidence = row.executionVerification;
  if (!reference || reference.amountIn !== row.amountIn || reference.path.length > policy ||
      row.edgeId !== blockScanEdgeKey(edge) || row.instanceKey !== edgeInstanceKey(edge) ||
      row.tokenIn !== edge.tokenIn.toLowerCase() || row.tokenOut !== edge.tokenOut.toLowerCase() ||
      !observed || typeof observed.hash !== "string" || observed.number > source.number || observed.generation > source.generation ||
      (observed.number === source.number && observed.hash.toLowerCase() !== source.hash.toLowerCase()) ||
      !evidence || evidence.kind !== "startup-simulation" || evidence.targetBlock !== observed.number + 1 ||
      !/^0x[0-9a-f]{64}$/i.test(evidence.scriptHash)) return false;
  if ((observed.number !== source.number || observed.generation !== source.generation ||
       observed.hash.toLowerCase() !== source.hash.toLowerCase()) &&
      !authority?.verifiedExecutions.has(evidence.receiptHash)) return false;
  const steps = [...reference.path, row];
  for (const [i, step] of steps.entries()) {
    const proof = step.executionVerification, at = step.quotedAt;
    if (step.status !== "quoted" || step.pricingMethod !== "startup-simulation" ||
        !at || at.number !== observed.number || typeof at.hash !== "string" || at.hash.toLowerCase() !== observed.hash.toLowerCase() ||
        at.generation !== observed.generation || typeof step.amountIn !== "bigint" || step.amountIn <= 0n ||
        typeof step.amountOut !== "bigint" || step.amountOut <= 0n || typeof step.amountSpent !== "bigint" ||
        step.amountSpent < 0n || step.amountSpent > step.amountIn ||
        step.effectiveMid !== Number(step.amountOut) / Number(step.amountIn) ||
        (i > 0 && (step.tokenIn !== steps[i - 1]!.tokenOut || step.amountIn !== steps[i - 1]!.amountOut)) ||
        !proof || proof.kind !== "startup-simulation" || proof.targetBlock !== evidence.targetBlock ||
        proof.scriptHash !== evidence.scriptHash || proof.receiptHash !== effectiveExecutionReceiptHash(step,
          { amountIn: step.amountIn, path: reference.path.slice(0, i) }, policy, proof.targetBlock, proof.scriptHash)) return false;
  }
  return true;
}

function freezeExecutionVerification(row: EffectiveMidRow): void {
  if (row.executionVerification) Object.freeze(row.executionVerification);
  if (row.quotedAt) Object.freeze(row.quotedAt);
}

/** Data-only historical checkpoint. No session, request result or Exact authority
 * crosses the process boundary. Original paths must survive carried samples. */
export interface EffectiveMidReplayState {
  readonly version: 1;
  /** Binds persisted lineage/carry authorization to its publication envelope. */
  readonly source?: CanonicalSource;
  readonly weth: string;
  readonly maxInputPathHops?: number;
  readonly references: readonly EffectiveAmountReference[];
  readonly byToken: readonly (readonly [string, number])[];
  readonly byRow: readonly (readonly [string, number])[];
  readonly poolOrigins?: readonly (readonly [string, EffectiveMidRow, number])[];
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
  const ranking = rankingState.get(snapshot);
  const originsSource = ranking?.requestedOrigins ?? ranking?.restoredPoolOrigins;
  const poolOrigins = originsSource
    ? [...originsSource].flatMap(([key, originRow]) => {
        if (snapshot.rows.get(key)?.status !== "missing-valuation" || originRow.status !== "quoted") return [];
        const ref = rowAmountReferences.get(originRow);
        return ref ? [[key, originRow, id(ref)] as const] : [];
      })
    : [];
  return { version: 1, source: state.source, weth: state.weth, maxInputPathHops: effectiveInputPathHops(snapshot.maxInputPathHops), references,
    byToken: [...state.references].map(([token, reference]) => [token, id(reference)] as const),
    byRow: [...snapshot.rows].flatMap(([key, row]) => {
      const reference = rowAmountReferences.get(row);
      return reference ? [[key, id(reference)] as const] : [];
    }),
    ...(poolOrigins.length ? { poolOrigins } : {}) };
}

export interface EffectiveMidReplayDelta {
  readonly source: CanonicalSource;
  readonly maxInputPathHops?: number;
  readonly reference: EffectiveMidSnapshot["reference"];
  readonly referenceWethInput: bigint;
  readonly wallMs: number;
  readonly updates: readonly (readonly [string, EffectiveMidRow, EffectiveAmountReference | null])[];
  readonly removals: readonly string[];
  readonly tokenUpdates: readonly (readonly [string, EffectiveAmountReference])[];
  readonly tokenRemovals: readonly string[];
  readonly dirtyUnfunded?: readonly string[];
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
        row.amountOut === old.amountOut && row.amountSpent === old.amountSpent && row.pricingMethod === old.pricingMethod &&
        row.executionVerification?.kind === old.executionVerification?.kind &&
        row.executionVerification?.targetBlock === old.executionVerification?.targetBlock &&
        row.executionVerification?.scriptHash === old.executionVerification?.scriptHash &&
        row.executionVerification?.receiptHash === old.executionVerification?.receiptHash &&
        row.status === old.status && row.effectiveMid === old.effectiveMid &&
        row.quotedAt?.number === old.quotedAt?.number && row.quotedAt?.hash === old.quotedAt?.hash &&
        row.quotedAt?.generation === old.quotedAt?.generation;
    });
  return { source: snapshot.source, maxInputPathHops: effectiveInputPathHops(snapshot.maxInputPathHops),
    reference: snapshot.reference, referenceWethInput: snapshot.referenceWethInput,
    wallMs: snapshot.wallMs, removals: changes.removals,
    updates: changes.updates.map(([id, row]) => [id, row, rowAmountReferences.get(row) ?? null] as const),
    tokenUpdates: [...current.references].filter(([token, ref]) => !same(ref, prior.references.get(token))),
    tokenRemovals: [...prior.references.keys()].filter(token => !current.references.has(token)),
    ...(changes.dirtyUnfunded?.length ? { dirtyUnfunded: changes.dirtyUnfunded } : {}) };
}

export function restoreEffectiveMidReplayState(snapshot: EffectiveMidSnapshot,
  state: EffectiveMidReplayState, edges: readonly TokenEdge[], weth: string): void {
  // Replay never confers locally observed ranking provenance, even when a
  // caller passes the same object rather than a structured clone.
  rankingState.delete(snapshot);
  anchoredReplayGraphs.delete(snapshot);
  restoredReplayPoolOrigins.delete(snapshot);
  assert(snapshot.complete && state.version === 1 && state.weth === weth.toLowerCase(), "incompatible effective baseline");
  const maxInputPathHops = effectiveInputPathHops(snapshot.maxInputPathHops);
  assert(effectiveInputPathHops(state.maxInputPathHops) === maxInputPathHops, "effective input-path policy changed");
  const anchored = state.source?.number === snapshot.source.number && state.source.hash.toLowerCase() === snapshot.source.hash.toLowerCase() &&
    state.source.generation === snapshot.source.generation;
  assert(state.source === undefined || anchored, "effective replay source anchor changed");
  const verifiedExecutions = new Set<string>();
  const verifyOriginalExecution = (row: EffectiveMidRow, edge: TokenEdge, reference: EffectiveAmountReference) => {
    if (!row.quotedAt || (!anchored && (row.quotedAt.number !== snapshot.source.number ||
        row.quotedAt.hash.toLowerCase() !== snapshot.source.hash.toLowerCase() || row.quotedAt.generation !== snapshot.source.generation))) return false;
    if (!effectiveRowExecutionVerified({ source: row.quotedAt, maxInputPathHops }, row, edge, reference)) return false;
    for (const step of [...reference.path, row]) verifiedExecutions.add(step.executionVerification!.receiptHash);
    return true;
  };
  const graph = graphEdgeIndex(edges);
  const references = state.references.map(reference => {
    assert(typeof reference.amountIn === "bigint" && reference.amountIn > 0n &&
      Array.isArray(reference.path) && reference.path.length <= maxInputPathHops, "invalid amount lineage");
    let token = state.weth, output: bigint | undefined;
    const visited = new Set([token]);
    for (const [i, step] of reference.path.entries()) {
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
      assert(edge.executionVerification !== "startup-simulation" || verifyOriginalExecution(
        step, edge, { amountIn: step.amountIn, path: reference.path.slice(0, i) }),
      "historical forward-quote path lacks current execution verification");
      assert(!visited.has(step.tokenOut), "cyclic historical forward-quote path");
      token = step.tokenOut; visited.add(token); output = step.amountOut;
    }
    assert(output === undefined || output === reference.amountIn, "lineage output differs from input amount");
    return { reference: Object.freeze({ ...reference, path: Object.freeze(reference.path.map(row => {
      freezeExecutionVerification(row);
      return Object.freeze({ ...row });
    })) }), token };
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
      const verified = rows.has(row) && verifyOriginalExecution(row, edge, rows.get(row)!);
      assert(edge.executionVerification !== "startup-simulation" || verified,
        "historical quote lacks current execution verification");
    } else assert((row.status === "no-output" ? row.amountOut === 0n : row.amountOut === null) &&
      row.effectiveMid === null, "unavailable row cannot supply a quote");
  }
  // Serialization drops frozen descriptors, including on unquoted carried rows.
  // Restore their producer invariant only after the entire input has validated;
  // this does not issue a native delta or bypass source/graph/ownership checks.
  for (const row of snapshot.rows.values()) {
    freezeExecutionVerification(row);
    Object.freeze(row);
  }
  for (const [row, reference] of rows) rowAmountReferences.set(row, reference);
  const replayOrigins = new Map<string, EffectiveMidRow>();
  for (const [key, rawOrigin, id] of state.poolOrigins ?? []) {
    const edge = graph.get(key), currentRow = snapshot.rows.get(key), reference = references[id];
    assert(edge && currentRow?.status === "missing-valuation" && !replayOrigins.has(key) &&
      rawOrigin.edgeId === key && rawOrigin.instanceKey === edgeInstanceKey(edge) &&
      rawOrigin.tokenIn === edge.tokenIn.toLowerCase() && rawOrigin.tokenOut === edge.tokenOut.toLowerCase() &&
      rawOrigin.status === "quoted" && Number.isSafeInteger(id) && reference &&
      reference.token === rawOrigin.tokenIn && reference.reference.amountIn === rawOrigin.amountIn &&
      typeof rawOrigin.amountIn === "bigint" && rawOrigin.amountIn > 0n &&
      typeof rawOrigin.amountOut === "bigint" && rawOrigin.amountOut > 0n &&
      rawOrigin.effectiveMid !== null && Number.isFinite(rawOrigin.effectiveMid) && rawOrigin.effectiveMid > 0 &&
      rawOrigin.quotedAt && rawOrigin.quotedAt.number <= snapshot.source.number &&
      rawOrigin.quotedAt.generation <= snapshot.source.generation &&
      (rawOrigin.quotedAt.number !== snapshot.source.number || rawOrigin.quotedAt.hash.toLowerCase() === snapshot.source.hash.toLowerCase()),
    "invalid historical pool origin");
    const verified = verifyOriginalExecution(rawOrigin, edge, reference.reference);
    assert(edge.executionVerification !== "startup-simulation" || verified,
      "historical pool origin lacks current execution verification");
    freezeExecutionVerification(rawOrigin);
    Object.freeze(rawOrigin);
    rowAmountReferences.set(rawOrigin, reference.reference);
    replayOrigins.set(key, rawOrigin);
  }
  amountReferenceState.set(snapshot, { source: Object.freeze({ ...snapshot.source }), weth: state.weth, references: tokens, verifiedExecutions });
  if(anchored){
    anchoredReplayGraphs.set(snapshot,edges);
    if(replayOrigins.size>0)restoredReplayPoolOrigins.set(snapshot,replayOrigins);
  }
}

/** SQL native-store caller only, AFTER its exact read/anchor/producer checks and strict
 * coordinator graph/index verification, BEFORE projecting columns. Does not add execution
 * authority, modify native rows, reconstruct discarded hints, or alter ordinary replay. */
export function bindVerifiedSqlNativePoolRestore(snapshot:EffectiveMidSnapshot,edges:readonly TokenEdge[],source:CanonicalSource,
  ownsPaidVariant:(edge:TokenEdge,variantId:string)=>boolean):number {
  const state=amountReferenceState.get(snapshot),index=graphEdgeIndex(edges);
  assert(snapshot.complete&&state&&anchoredReplayGraphs.get(snapshot)===edges&&graphEdgeIndexes.has(edges)&&
    snapshot.source.number===source.number&&snapshot.source.hash.toLowerCase()===source.hash.toLowerCase()&&snapshot.source.generation===source.generation&&
    state.source.number===source.number&&state.source.hash.toLowerCase()===source.hash.toLowerCase()&&state.source.generation===source.generation&&
    snapshot.rows.size===index.size&&[...snapshot.rows.keys()].every(id=>index.has(id)),"SQL pool restore requires the exact anchored native replay/immutable graph");
  const replayOrigins=restoredReplayPoolOrigins.get(snapshot);
  const origins=new Map<string,EffectiveMidRow>();
  for(const[id,rawRow]of snapshot.rows){
    const row=rawRow.status==="quoted"?rawRow:replayOrigins?.get(id);
    if(!row||row.status!=="quoted")continue;
    const edge=index.get(id)!,ref=rowAmountReferences.get(row),proof=row.executionVerification;
    if(edge.leavesStandingPosition||edge.executionVerification!=="startup-simulation"||!Object.isFrozen(row)||!proof?.variantId||
      !ref||!state.verifiedExecutions.has(proof.receiptHash)||!effectiveRowExecutionVerified(snapshot,row,edge,ref))continue;
    if(![...ref.path,row].every(step=>{const bound=index.get(step.edgeId),variant=step.executionVerification?.variantId;
      return !!bound&&!bound.leavesStandingPosition&&bound.executionVerification==="startup-simulation"&&step.instanceKey===edgeInstanceKey(bound)&&
        step.tokenIn===bound.tokenIn.toLowerCase()&&step.tokenOut===bound.tokenOut.toLowerCase()&&!!variant&&ownsPaidVariant(bound,variant);} ))continue;
    origins.set(id,row);
  }
  rankingState.set(snapshot,{edges,byId:new Map(),restoredPoolOrigins:origins});
  anchoredReplayGraphs.delete(snapshot); // this successful native-restore promotion is one-shot
  restoredReplayPoolOrigins.delete(snapshot);
  return origins.size;
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
  const ranking=rankingState.get(snapshot);
  if(ranking)rankingState.set(next,ranking);
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
    const quote = enumerationQuote(edges, key, row, effective);
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
  return enumerationQuote(graphEdgeIndex(pricing.graph.edges), key, row, assertEffectiveEnumerationSource(pricing));
}
function enumerationQuote(edges: ReadonlyMap<string, TokenEdge>, key: string,
  row: EffectiveMidRow, snapshot: EffectiveMidSnapshot): ResolvedBlockScanQuote | undefined {
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
  if (edge.executionVerification === "startup-simulation" && !effectiveRowExecutionVerified(snapshot, row, edge)) return undefined;
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
export type EffectiveMidQuoteRequest = Pick<Parameters<ExactCall>[0],
  "edge" | "amountIn" | "control"> & {
  readonly source: CanonicalSource;
  readonly reference: EffectiveAmountReference;
  readonly maxInputPathHops: number;
};
export type EffectiveMidQuoteResult = Pick<RouteExactResult, "source" | "amountIn" | "amountOut"> & {
  /** The same simulated prefix can refresh historical quantities. Its route
   * topology and native seed must remain those requested by this build. */
  readonly inputReference?: EffectiveAmountReference;
  readonly amountSpent?: bigint;
  readonly pricingMethod?: "startup-simulation" | "exact";
  readonly executionVerification?: EffectiveExecutionVerification;
};
export type EffectiveMidQuote = (input: EffectiveMidQuoteRequest) => Promise<EffectiveMidQuoteResult>;

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

const cachedGraphWorkSpecs = new WeakMap<readonly TokenEdge[], {
  readonly scannerOnlyKeys: readonly string[];
  readonly scannerOnlyPresent: ReadonlySet<string>;
  readonly edgeMeta: readonly {
    readonly edgeId: string;
    readonly edge: TokenEdge;
    readonly instanceKey: string;
    readonly tokenIn: string;
    readonly tokenOut: string;
  }[];
}>();

function getGraphWorkSpec(graphEdges: readonly TokenEdge[], edges: ReadonlyMap<string, TokenEdge>) {
  let cached = cachedGraphWorkSpecs.get(graphEdges);
  if (cached) return cached;
  const scannerOnlyKeys: string[] = [];
  const edgeMeta: {
    readonly edgeId: string;
    readonly edge: TokenEdge;
    readonly instanceKey: string;
    readonly tokenIn: string;
    readonly tokenOut: string;
  }[] = [];
  for (const [key, edge] of edges) {
    if (!scannerConsumesEdge(edge)) continue;
    scannerOnlyKeys.push(key);
    edgeMeta.push({
      edgeId: key,
      edge,
      instanceKey: edgeInstanceKey(edge),
      tokenIn: edge.tokenIn.toLowerCase(),
      tokenOut: edge.tokenOut.toLowerCase(),
    });
  }
  const built = {
    scannerOnlyKeys,
    scannerOnlyPresent: new Set(scannerOnlyKeys),
    edgeMeta,
  };
  if (graphEdgeIndexes.has(graphEdges)) cachedGraphWorkSpecs.set(graphEdges, built);
  return built;
}

/** Forward effective sampling: shortest successful WETH paths first, then the
 * greatest output at that depth. Tokens at the configured maximum depth still
 * quote outgoing edges; those outputs cannot seed another input reference. */
export async function buildEffectiveMids(input: {
  /** Verified pricing-state identity; raw mids are deliberately not consumed. */
  readonly pricing: EffectivePricingInput;
  readonly quoteGraph?: VerifiedGraphView;
  readonly weth: string;
  /** Shared with startup input preparation; omitted uses the one process setting. */
  readonly maxInputPathHops?: number;
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
   * prepared. Simulation samples consume their explicit funding lineage. */
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
  /** Issued by the caller only for complete forward canonical activity and
   * on-touch reusable receipts with independently clean target dependencies. */
  readonly historicalRankingPolicy?: {
    readonly isCleanOnTouchReceipt:(edge:TokenEdge,stateKey:string,variantId:string)=>boolean;
  };
  readonly poolPriceRefreshPlan?: {readonly shouldRefresh:(edge:TokenEdge,priorVerifiedVariantId?:string)=>boolean};
  readonly reorgCommonAncestorNumber?: number;
  /** Quote these exact public directions using the ordinary funded execution
   * path even when otherwise reusable. Does not touch their pool or siblings. */
  readonly requireFreshEdgeIds?:ReadonlySet<string>;
  /** A complete, forward-only activity union, before the coordinator adds static each-block
   * policies. For logical routes only, a verified funded receipt may identify an on-touch
   * private encoding despite another encoding adding the same public key every block. */
  readonly forcedRefresh?: {
    readonly actualTouched: ReadonlySet<string>;
    readonly isOnTouchVariant: (edge: TokenEdge, stateKey: string, variantId: string) => boolean;
  };
  /** Bounded periodic telemetry. Observer errors cannot change quote results. */
  readonly onProgress?: (progress: EffectiveMidProgress) => void;
}): Promise<EffectiveMidSnapshot> {
  const started = Date.now();
  // Wall intervals only: a quote wave includes I/O, JS processing and any GC.
  // Keep this outside the snapshot/replay contract and never trace per row.
  const diagnostic = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS === "1" ? {
    startedAt: performance.now(), setupMs: 0, progressCallbackMs: 0, assemblyMs: 0,
    prefixTouchedRejections: new Set<number>(),
    waves: [] as { depth: number; directions: number; fresh: number;
      planningMs: number; sessionPrepareMs: number; quoteWorkMs: number; propagationMs: number }[],
  } : undefined;
  const { pricing, control } = input;
  const maxInputPathHops = effectiveInputPathHops(input.maxInputPathHops ?? resolveEffectiveInputPathHops());
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
  const rawGraphEdges = (input.quoteGraph ?? pricing.graph).edges;
  const edges = graphEdgeIndex(rawGraphEdges);
  // A simple token path cannot use more distinct steps than the graph has
  // edges. This allocation bound follows topology, not another funding policy.
  const samplingDepthLimit = Math.min(maxInputPathHops, edges.size);
  const stateKeyFor = (edgeId: string, edge: (typeof pricing.graph.edges)[number]) =>
    (pricing.pricingStateKeyByEdgeKey?.get(edgeId) ?? edgeInstanceKey(edge)).toLowerCase();
  // Membership comes from the verified graph, never the availability of a raw
  // mid. In particular, a successful Exact can recover an unpriced direction.
  const cachedSpec = getGraphWorkSpec(rawGraphEdges, edges);
  let hasExtraStateKeyEdges = false;
  if (pricing.pricingStateKeyByEdgeKey && pricing.pricingStateKeyByEdgeKey.size > cachedSpec.scannerOnlyKeys.length) {
    for (const k of pricing.pricingStateKeyByEdgeKey.keys()) {
      if (!cachedSpec.scannerOnlyPresent.has(k) && edges.has(k)) { hasExtraStateKeyEdges = true; break; }
    }
  } else if (pricing.pricingStateKeyByEdgeKey) {
    for (const k of pricing.pricingStateKeyByEdgeKey.keys()) {
      if (!cachedSpec.scannerOnlyPresent.has(k) && edges.has(k)) { hasExtraStateKeyEdges = true; break; }
    }
  }
  const keys = hasExtraStateKeyEdges
    ? [...edges].filter(([key, edge]) => scannerConsumesEdge(edge) || pricing.pricingStateKeyByEdgeKey?.has(key)).map(([key]) => key)
    : cachedSpec.scannerOnlyKeys;
  const presentKeysSet = hasExtraStateKeyEdges ? new Set(keys) : cachedSpec.scannerOnlyPresent;
  const work = hasExtraStateKeyEdges
    ? keys.map(edgeId => {
        const edge = edges.get(edgeId)!;
        return { edgeId, edge, instanceKey: edgeInstanceKey(edge),
          tokenIn: edge.tokenIn.toLowerCase(), tokenOut: edge.tokenOut.toLowerCase(),
          amountIn: null as bigint | null, reference: undefined as EffectiveAmountReference | undefined };
      })
    : cachedSpec.edgeMeta.map(m => ({
        edgeId: m.edgeId, edge: m.edge, instanceKey: m.instanceKey,
        tokenIn: m.tokenIn, tokenOut: m.tokenOut,
        amountIn: null as bigint | null, reference: undefined as EffectiveAmountReference | undefined,
      }));
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
    const reportStartedAt = diagnostic ? performance.now() : 0;
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
    finally { if (diagnostic) diagnostic.progressCallbackMs += Math.max(0, performance.now() - reportStartedAt); }
  };
  const closed = () => control.signal?.aborted === true ||
    (control.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs);
  const writeRow = (index: number, result: Pick<EffectiveMidRow,
    "status" | "amountOut" | "effectiveMid" | "quotedAt" | "carried" | "failureEvidence" | "amountSpent" | "pricingMethod" |
    "executionVerification">) => {
    const { edgeId, instanceKey, tokenIn, tokenOut, amountIn } = work[index]!;
    storeRow(index, Object.freeze({ edgeId, instanceKey, tokenIn, tokenOut, amountIn, ...result }));
    const reference = work[index]!.reference;
    if (reference) rowAmountReferences.set(rows[index]!, reference);
  };
  const unavailable = (index: number, status: EffectiveMidRow["status"]) =>
    writeRow(index, { status, amountOut: null, effectiveMid: null });
  const failed = (index: number, error: unknown, revertedResults: number) => {
    const status = closed() ? "cancelled" :
      (error as { code?: unknown })?.code === "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" ? "unsupported" : "quote-failed";
    writeRow(index, { status, amountOut: null, effectiveMid: null,
      ...(status === "quote-failed" && (revertedResults > 0 || (error as { code?: unknown })?.code === "STARTUP_EXECUTION_REVERT")
        ? { failureEvidence: "evm-revert-observed" as const } : {}) });
  };
  const accept = (index: number, result: Awaited<ReturnType<EffectiveMidQuote>>) => {
    if (closed()) { unavailable(index, "cancelled"); return; }
    const item = work[index]!;
    if (result.inputReference !== undefined) {
      const prior = item.reference, actual = result.inputReference;
      if (!prior || result.pricingMethod !== "startup-simulation" ||
          actual.path.length !== prior.path.length || actual.path.length > maxInputPathHops ||
          typeof actual.amountIn !== "bigint" || actual.amountIn <= 0n) {
        throw new Error("simulation changed the requested input lineage");
      }
      let token = weth, amount = prior.path[0]?.amountIn ?? prior.amountIn;
      const path = actual.path.map((row, i) => {
        const requested = prior.path[i]!, edge = edges.get(row.edgeId);
        if (!edge || row.edgeId !== requested.edgeId || row.instanceKey !== edgeInstanceKey(edge) ||
            row.instanceKey !== requested.instanceKey || row.tokenIn !== token ||
            row.tokenIn !== edge.tokenIn.toLowerCase() || row.tokenOut !== edge.tokenOut.toLowerCase() ||
            row.status !== "quoted" || row.amountIn !== amount ||
            typeof row.amountOut !== "bigint" || row.amountOut <= 0n ||
            row.quotedAt?.number !== source.number || row.quotedAt.hash.toLowerCase() !== source.hash ||
            row.quotedAt.generation !== source.generation || input.disabledEdgeIds?.has(row.edgeId) ||
            row.amountSpent !== undefined && (row.amountSpent < 0n || row.amountSpent > row.amountIn)) {
          throw new Error("simulation input lineage does not match the requested route/source");
        }
        const rate = Number(row.amountOut) / Number(row.amountIn);
        if (!Number.isFinite(rate) || rate <= 0 || row.effectiveMid !== rate) {
          throw new Error("simulation input lineage has an invalid rate");
        }
        if (edge.executionVerification === "startup-simulation" && !effectiveRowExecutionVerified({ source, maxInputPathHops },
          row, edge, { amountIn: row.amountIn, path: actual.path.slice(0, i) })) {
          throw new Error("simulation input lineage lacks current execution verification");
        }
        token = row.tokenOut; amount = row.amountOut;
        return Object.freeze({ ...row, quotedAt: source });
      });
      if (token !== item.edge.tokenIn.toLowerCase() || actual.amountIn !== amount || result.amountIn !== amount) {
        throw new Error("simulation target budget differs from the prefix output");
      }
      item.reference = Object.freeze({ amountIn: actual.amountIn, path: Object.freeze(path) });
      item.amountIn = actual.amountIn;
    }
    const { amountIn } = item;
    if (amountIn === null || result.source.number !== source.number || result.source.hash.toLowerCase() !== source.hash ||
        result.source.generation !== source.generation || result.amountIn !== amountIn) {
      throw new Error("effective quote changed source or amount");
    }
    const amountOut = result.amountOut;
    const rate = Number(amountOut) / Number(amountIn);
    if (amountOut < 0n || !Number.isFinite(rate) || (amountOut > 0n && rate <= 0) ||
        result.amountSpent !== undefined && (typeof result.amountSpent !== "bigint" ||
          result.amountSpent < 0n || result.amountSpent > amountIn)) {
      throw new Error("invalid quote output");
    }
    const status = amountOut > 0n ? "quoted" : "no-output";
    if (status === "quoted" && item.edge.executionVerification === "startup-simulation" &&
        !effectiveRowExecutionVerified({ source, maxInputPathHops }, {
          edgeId: item.edgeId, instanceKey: edgeInstanceKey(item.edge), tokenIn: item.edge.tokenIn.toLowerCase(),
          tokenOut: item.edge.tokenOut.toLowerCase(), amountIn, amountOut, amountSpent: result.amountSpent,
          effectiveMid: rate, status, quotedAt: source, pricingMethod: result.pricingMethod,
          executionVerification: result.executionVerification,
        }, item.edge, item.reference)) {
      throw new Error("effective quote lacks current execution verification");
    }
    if (closed()) { unavailable(index, "cancelled"); return; }
    writeRow(index, { status, amountOut, effectiveMid: amountOut > 0n ? rate : null,
      ...(result.amountSpent === undefined ? {} : { amountSpent: result.amountSpent }),
      ...(result.pricingMethod === undefined ? {} : { pricingMethod: result.pricingMethod }),
      ...(result.executionVerification === undefined ? {} : { executionVerification: Object.freeze({ ...result.executionVerification }) }),
      ...(status === "quoted" ? { quotedAt: source } : {}) });
    if(status==="quoted"&&item.edge.executionVerification==="startup-simulation"&&result.executionVerification?.variantId)
      issuedRankingReceipts.add(rows[index]!.executionVerification!);
  };

  // Classify carry before any quote can yield. Only snapshots built with this
  // policy in this process may carry; deserialized raw-mid-era amounts cannot.
  const previous = input.previous;
  const previousState = previous && amountReferenceState.get(previous);
  const canReuse = previous !== undefined && previousState?.weth === weth && input.touchedStateKeys !== undefined &&
    effectiveInputPathHops(previous.maxInputPathHops) === maxInputPathHops &&
    ((input.fixedWethInput === undefined && previous.reference !== "fixed") ||
      (previous.reference === "fixed" && previous.referenceWethInput === input.fixedWethInput)) &&
    ((source.number > previous.source.number && source.generation > previous.source.generation) ||
      (source.number === previous.source.number && source.generation >= previous.source.generation &&
        source.hash === previous.source.hash.toLowerCase()));
  const reusable = new Map<number, EffectiveMidRow>();
  const graphEdges=(input.quoteGraph??pricing.graph).edges;
  const oldRanking=previous&&rankingState.get(previous);
  const rankingPolicy=canReuse && previous?.complete && source.number>previous.source.number &&
    !input.cascadeAmountChanges && oldRanking?.edges===graphEdges && graphEdgeIndexes.has(graphEdges)
    ? input.historicalRankingPolicy:undefined;
  const poolPlan=canReuse && previous.complete && source.number>previous.source.number && !input.cascadeAmountChanges &&
    oldRanking?.edges===graphEdges && graphEdgeIndexes.has(graphEdges) ? input.poolPriceRefreshPlan : undefined;
  let requestedOrigins: Map<string, EffectiveMidRow> | undefined = poolPlan && oldRanking?.requestedOrigins
    ? (oldRanking.requestedOrigins as Map<string, EffectiveMidRow>)
    : (poolPlan ? new Map<string, EffectiveMidRow>() : undefined);
  let requestedOriginsCloned = !oldRanking?.requestedOrigins;
  const poolClean=new Set<number>(),poolDirty=new Set<number>();let poolDispatches=0;
  const rankingCandidates=new Map<number,RankingEntry>();
  const forcedRefresh = canReuse && previous?.complete && source.number > previous.source.number
    ? input.forcedRefresh : undefined;
  // Eligibility only: the owning caller must still pass the normal previous-source
  // receipt verification for the target AND each embedded step, including script/amount
  // lineage. A prefix's variant can differ from the separately published row for that edge.
  const stateRejectsReceipt = (key: string, row: EffectiveMidRow, edge: TokenEdge) => {
    if (!input.touchedStateKeys!.has(key)) return false;
    const rule = forcedRefresh, variant = row.executionVerification?.variantId;
    return !rule || rule.actualTouched.has(key) || edge.executionVerification !== "startup-simulation" ||
      row.status !== "quoted" || row.pricingMethod !== "startup-simulation" || !variant ||
      !rule.isOnTouchVariant(edge, key, variant);
  };
  const referenceCanCarry = (reference: EffectiveAmountReference | undefined, requireExecution: boolean, diagnosticIndex?: number) => {
    if (!reference) return !requireExecution;
    const required = requireExecution || reference.path.some(row => edges.get(row.edgeId)?.executionVerification === "startup-simulation");
    return reference.path.every((row, i) => {
      const bound = edges.get(row.edgeId);
      if (!bound || (forcedRefresh && input.disabledEdgeIds?.has(row.edgeId))) return false;
      if (!required) return true;
      if (!previous) return false;
      if (stateRejectsReceipt(stateKeyFor(row.edgeId, bound), row, bound)) {
        if (diagnostic && diagnosticIndex !== undefined) diagnostic.prefixTouchedRejections.add(diagnosticIndex);
        return false;
      }
      return effectiveRowExecutionVerified(previous, row, bound, { amountIn: row.amountIn!, path: reference.path.slice(0, i) });
    });
  };
  const enabled = (index: number) => {
    const { edgeId, edge } = work[index]!;
    return !input.disabledEdgeIds?.has(edgeId) &&
      (!edge.leavesStandingPosition || pricing.pricingStateKeyByEdgeKey?.has(edgeId));
  };
  const reuseEmptyTombstone = (
    index: number,
    prior: EffectiveMidRow | undefined,
    item: (typeof work)[number],
    status: "disabled-for-run" | "missing-valuation" | "unsupported",
  ): boolean => {
    if (
      prior?.status === status && Object.isFrozen(prior) &&
      prior.edgeId === item.edgeId && prior.instanceKey === item.instanceKey &&
      prior.tokenIn === item.tokenIn && prior.tokenOut === item.tokenOut &&
      prior.amountIn === null && prior.amountOut === null && prior.effectiveMid === null &&
      prior.quotedAt === undefined && prior.carried === undefined && prior.failureEvidence === undefined &&
      prior.eth === undefined && prior.enumeration === undefined && !rowAmountReferences.has(prior)
    ) {
      storeRow(index, prior);
      return true;
    }
    return false;
  };
  const previousRowsMap = canReuse ? previous.rows : undefined;
  const hasDisabledEdges = (input.disabledEdgeIds?.size ?? 0) > 0;
  const hasRequireFreshEdges = (input.requireFreshEdgeIds?.size ?? 0) > 0;
  for (let index = 0; index < work.length; index++) {
    const item = work[index]!;
    const { edgeId, edge } = item;
    if (hasDisabledEdges && input.disabledEdgeIds!.has(edgeId)) {
      // The current run's exclusion is authoritative even when the pool is
      // touched. Reuse only the identical empty tombstone, never an old quote
      // or amount lineage; otherwise unchanged exclusions become native edits.
      const prior = previousRowsMap?.get(edgeId);
      if (!reuseEmptyTombstone(index, prior, item, "disabled-for-run")) {
        unavailable(index, "disabled-for-run");
      }
    } else if (edge.leavesStandingPosition && !pricing.pricingStateKeyByEdgeKey?.has(edgeId)) {
      const prior = previousRowsMap?.get(edgeId);
      if (!reuseEmptyTombstone(index, prior, item, "unsupported")) {
        unavailable(index, "unsupported");
      }
    }
    else if (closed()) unavailable(index, "cancelled");
    else {
      const prior = previousRowsMap?.get(edgeId);
      if(poolPlan&&previous&&edge.executionVerification==="startup-simulation"&&!edge.leavesStandingPosition){
        const old=oldRanking!.byId.get(edgeId);
        const sourceRow=prior?.status==="quoted"?prior:oldRanking!.restoredPoolOrigins?.get(edgeId);
        const proof=sourceRow?.executionVerification;
        const verified=sourceRow?.status==="quoted" && proof?.variantId && sourceRow.quotedAt && typeof sourceRow.amountIn==="bigint" &&
          typeof sourceRow.amountOut==="bigint"&&sourceRow.effectiveMid!==null&&(issuedRankingReceipts.has(proof)||
            oldRanking!.restoredPoolOrigins?.get(edgeId)?.executionVerification===proof)&&
          previousState!.verifiedExecutions.has(proof.receiptHash)&&rowAmountReferences.has(sourceRow);
        const fromOrphanedBranch = input.reorgCommonAncestorNumber !== undefined &&
          sourceRow?.quotedAt !== undefined &&
          sourceRow.quotedAt.number > input.reorgCommonAncestorNumber;
        if(verified && !fromOrphanedBranch && requestedOrigins!.get(edgeId) !== sourceRow) {
          if (!requestedOriginsCloned) {
            requestedOrigins = new Map(oldRanking?.requestedOrigins);
            requestedOriginsCloned = true;
          }
          requestedOrigins!.set(edgeId, sourceRow);
        }
        const existing=old?.edge===edge?old:undefined;
        if((hasRequireFreshEdges && input.requireFreshEdgeIds!.has(edgeId))||poolPlan.shouldRefresh(edge,verified?proof!.variantId:existing?.hint.variantId))poolDirty.add(index);
        else {
          poolClean.add(index);
          if(existing)rankingCandidates.set(index,existing);
          else if(verified)rankingCandidates.set(index,{edge,cause:"poolUnchanged",
            prefix:Object.freeze(rowAmountReferences.get(sourceRow!)!.path.map(s=>s.edgeId)),hint:Object.freeze({
              kind:"historical-ranking-only",edgeId,instanceKey:sourceRow!.instanceKey,tokenIn:sourceRow!.tokenIn,tokenOut:sourceRow!.tokenOut,
              amountIn:sourceRow!.amountIn!,amountOut:sourceRow!.amountOut!,effectiveMid:sourceRow!.effectiveMid!,quotedAt:sourceRow!.quotedAt!,
              receiptHash:proof!.receiptHash,variantId:proof!.variantId!})});
          if (!reuseEmptyTombstone(index, prior, item, "missing-valuation")) {
            unavailable(index,"missing-valuation");
          }
        }
        continue;
      }
      if (hasRequireFreshEdges && input.requireFreshEdgeIds!.has(edgeId)) continue; // normal forward funding; never reuse a price/ranking hint
      const stateKey = stateKeyFor(edgeId, edge);
      if (prior && (prior.status === "quoted" || (previous!.complete && prior.status !== "cancelled")) && prior.edgeId === edgeId &&
          prior.instanceKey === item.instanceKey &&
          prior.tokenIn === item.tokenIn && prior.tokenOut === item.tokenOut &&
          !stateRejectsReceipt(stateKey, prior, edge) && referenceCanCarry(rowAmountReferences.get(prior), edge.executionVerification === "startup-simulation", index) &&
          (edge.executionVerification !== "startup-simulation" ||
            effectiveRowExecutionVerified(previous!, prior, edge))) {
        reusable.set(index, prior);
        if (!input.cascadeAmountChanges) storeRow(index, prior, true);
      } else if(rankingPolicy && previous && edge.executionVerification==="startup-simulation" && !edge.leavesStandingPosition){
        const old=oldRanking!.byId.get(edgeId);
        if(old && old.edge===edge && old.prefix.every(id=>!input.disabledEdgeIds?.has(id)) &&
          rankingPolicy.isCleanOnTouchReceipt(edge,stateKey,old.hint.variantId)){
          rankingCandidates.set(index,old);
        } else if(!old && prior?.status==="quoted" && prior.quotedAt && prior.executionVerification?.variantId &&
          issuedRankingReceipts.has(prior.executionVerification) && typeof prior.amountIn==="bigint" && typeof prior.amountOut==="bigint" &&
          prior.effectiveMid!==null && effectiveRowExecutionVerified(previous,prior,edge) &&
          rankingPolicy.isCleanOnTouchReceipt(edge,stateKey,prior.executionVerification.variantId)){
          // A dirty upstream reference or a broad execution subscription rejects
          // CURRENT execution authority. The separate positive market policy
          // may admit the original sample only to ranking, never to current carry.
          const prefix=rowAmountReferences.get(prior)?.path;
          if(prefix && prefix.every(s=>edges.has(s.edgeId)&&!input.disabledEdgeIds?.has(s.edgeId))){
            const dirtyPrefix=prefix.some(s=>stateRejectsReceipt(stateKeyFor(s.edgeId,edges.get(s.edgeId)!),s,edges.get(s.edgeId)!));
            const dirtyExecutionSubscription=stateRejectsReceipt(stateKey,prior,edge);
            if(!dirtyPrefix&&!dirtyExecutionSubscription)continue;
            const hint:EffectiveHistoricalRankingHint=Object.freeze({kind:"historical-ranking-only",edgeId,
              instanceKey:prior.instanceKey,tokenIn:prior.tokenIn,tokenOut:prior.tokenOut,
              amountIn:prior.amountIn,amountOut:prior.amountOut,effectiveMid:prior.effectiveMid,
              quotedAt:Object.freeze({...prior.quotedAt}),receiptHash:prior.executionVerification.receiptHash,
              variantId:prior.executionVerification.variantId});
            rankingCandidates.set(index,{edge,hint,prefix:Object.freeze(prefix.map(s=>s.edgeId)),
              cause:dirtyPrefix?(dirtyExecutionSubscription?"both":"prefixOnly"):"executionSubscriptionOnly"});
          }
        }
      }
    }
  }

  const edgeExplicitResCache = new WeakMap<TokenEdge, readonly string[] | null>();
  const edgeExplicitRes = (e: TokenEdge): readonly string[] | null => {
    let r = edgeExplicitResCache.get(e);
    if (r !== undefined) return r;
    r = explicitStateResourceKeys(e) ?? null;
    edgeExplicitResCache.set(e, r);
    return r;
  };
  const referenceSharesExplicitResource = (ref: EffectiveAmountReference | undefined, targetEdge: TokenEdge): boolean => {
    if (!ref || ref.path.length === 0) return false;
    const targetRes = edgeExplicitRes(targetEdge);
    if (!targetRes || targetRes.length === 0) return false;
    for (let i = 0; i < ref.path.length; i++) {
      const stepEdge = edges.get(ref.path[i]!.edgeId);
      if (!stepEdge) continue;
      const stepRes = edgeExplicitRes(stepEdge);
      if (!stepRes) continue;
      for (let j = 0; j < stepRes.length; j++) {
        if (targetRes.includes(stepRes[j]!)) return true;
      }
    }
    return false;
  };
  const references = new Map<string, EffectiveAmountReference>([[weth,
    Object.freeze({ amountIn: referenceWethInput, path: Object.freeze([]) })]]);
  const pending = Array.from({ length: samplingDepthLimit + 1 }, () => new Map<string, EffectiveAmountReference>());
  // Only #1 (physical resource disjointness) and #3 (defer self-colliding pool to next hop via
  // another intermediate token; never switch to a runner-up pool on the same hop).
  const deferredRef = new Map<string, EffectiveAmountReference>();
  const pendingDeferred = Array.from({ length: samplingDepthLimit + 1 }, () => new Map<string, EffectiveAmountReference>());
  const deferredSelfResource = new Map<string, number[]>();
  const betterReference = (a: EffectiveAmountReference, b: EffectiveAmountReference): boolean =>
    a.amountIn > b.amountIn || (a.amountIn === b.amountIn &&
      a.path.map(row => row.edgeId).join("\n") < b.path.map(row => row.edgeId).join("\n"));
  const offer = (token: string, reference: EffectiveAmountReference) => {
    if (reference.path.length === 0 || reference.path.length > samplingDepthLimit) return;
    if (!references.has(token)) {
      const candidates = pending[reference.path.length]!;
      const prior = candidates.get(token);
      // Equal outputs use the complete edge path, independent of graph ordering
      // and asynchronous quote completion.
      if (!prior || betterReference(reference, prior)) {
        candidates.set(token, reference);
      }
      return;
    }
    const waiting = deferredSelfResource.get(token);
    const primary = references.get(token)!;
    if (waiting && waiting.length > 0 && reference.path.length > primary.path.length) {
      if (waiting.some(idx => !referenceSharesExplicitResource(reference, work[idx]!.edge))) {
        const candidates = pendingDeferred[reference.path.length]!;
        const prior = candidates.get(token);
        if (!prior || betterReference(reference, prior)) {
          candidates.set(token, reference);
        }
      }
    }
  };
  const offerOutput = (row: EffectiveMidRow, reference: EffectiveAmountReference) => {
    if (row.status !== "quoted" || edges.get(row.edgeId)!.leavesStandingPosition ||
        reference.path.length >= maxInputPathHops || row.tokenOut === weth ||
        row.tokenOut === row.tokenIn || reference.path.some(step => step.tokenIn === row.tokenOut)) return;
    offer(row.tokenOut, Object.freeze({ amountIn: row.amountOut!,
      path: Object.freeze([...reference.path, row]) }));
  };
  const seededClean = new Set<number>(poolClean);
  // Limit bridge work to the intersection of two bounded frontiers: reachable
  // from WETH and able to fund an actually dirty target input. Keeping only
  // yesterday's winning path would starve the target if that route is disabled
  // or its current quote fails. The existing forward pass still chooses the
  // shortest successful depth and the best *current* output at that depth.
  const bridges=new Set<string>();
  if(!poolPlan && rankingCandidates.size && samplingDepthLimit>0){
    const demanded=new Set<string>();
    for(const [i,w] of work.entries()){
      const t=w.edge.tokenIn.toLowerCase();
      if(t!==weth&&enabled(i)&&!reusable.has(i)&&!rankingCandidates.has(i)&&(input.requireFreshEdgeIds?.has(w.edgeId)||input.touchedStateKeys!.has(stateKeyFor(w.edgeId,w.edge))))
        demanded.add(t);
    }
    if(demanded.size){
      const forward=new Map<string,Set<string>>(),back=new Map<string,Set<string>>(),neighbors=new Map<string,Set<string>>();
      const link=(map:Map<string,Set<string>>,a:string,b:string)=>{
        const list=map.get(a);if(list)list.add(b);else map.set(a,new Set([b]));
      };
      for(const [i,{edge}] of work.entries()){
        if(!enabled(i)||edge.leavesStandingPosition)continue;
        const a=edge.tokenIn.toLowerCase(),b=edge.tokenOut.toLowerCase();if(a===b||b===weth)continue;
        link(forward,a,b);link(back,b,a);link(neighbors,a,b);link(neighbors,b,a);
      }
      // A dangling non-terminal token can only take a round trip through
      // the same neighbor. The funded forward sampler forbids such cycles.
      const removed=new Set<string>(),leaves=[...neighbors].filter(([,n])=>n.size<2).map(([t])=>t);
      for(const t of leaves){
        if(t===weth||demanded.has(t)||removed.has(t))continue;
        removed.add(t);
        for(const neighbor of neighbors.get(t)??[]){
          const n=neighbors.get(neighbor)!;n.delete(t);if(n.size<2)leaves.push(neighbor);
        }
      }
      function depths(start:Set<string>,adj:Map<string,Set<string>>,stop?:string){
        const distance=new Map<string,number>();
        let layer=start;for(let d=0;layer.size&&d<samplingDepthLimit;d++){
          const next=new Set<string>();
          for(const t of layer){if(distance.has(t))continue;distance.set(t,d);
            if(t===stop||d+1>=samplingDepthLimit)continue;
            for(const neighbor of adj.get(t)??[])if(!removed.has(neighbor)&&!distance.has(neighbor))next.add(neighbor);
          }layer=next;
        }return distance;
      }
      const soleDemand=demanded.size===1?demanded.values().next().value:undefined;
      const fromWeth=depths(new Set([weth]),forward,soleDemand),toDemand=depths(demanded,back,weth);
      for(const r of rankingCandidates.values()){
        const t=r.hint.tokenIn,o=r.hint.tokenOut;
        if(t!==o&&o!==weth&&t!==soleDemand&&!removed.has(t)&&!removed.has(o)&&
          (fromWeth.get(t)??Infinity)+1+(toDemand.get(o)??Infinity)<=samplingDepthLimit)
          bridges.add(r.hint.edgeId);
      }
    }
  }
  const rankOnly=new Map<string,RankingEntry>();
  for(const [i,entry] of rankingCandidates){
    if(bridges.has(entry.hint.edgeId))continue;
    if(!poolClean.has(i)){
      const prior = previousRowsMap?.get(entry.hint.edgeId);
      if (!reuseEmptyTombstone(i, prior, work[i]!, "missing-valuation")) {
        unavailable(i,"missing-valuation");
      }
    }
    seededClean.add(i);rankOnly.set(entry.hint.edgeId,entry);
  }
  // Proposals do not enter `references`, `pending`, or verifiedExecutions. Only the normal
  // current-source funded prefix+target simulation can turn them into an observed amount.
  const proposals=new Map<string,EffectiveAmountReference>(),proposedAt:number[][]=Array.from({length:samplingDepthLimit+1},()=>[]);
  const paidChoices=new Map<string,Map<string,EffectiveAmountReference>>();
  // Same target/source and same WETH seed, ordered edges and private encodings produce the
  // same replay. A shared downstream pool reached through another prefix is NOT the same trial.
  const planKey=(r:EffectiveAmountReference,hops=r.path.length)=>{
    let out = String(r.path[0]?.amountIn ?? r.amountIn);
    const limit = Math.min(hops, r.path.length);
    for (let i = 0; i < limit; i++) {
      const s = r.path[i]!;
      out += "\u001f" + s.edgeId + "\u001e" + (s.executionVerification?.variantId ?? "");
    }
    return out;
  };
  if(poolPlan&&poolDirty.size){
    const wanted=new Set([...poolDirty].map(i=>work[i]!.edge.tokenIn.toLowerCase()));
    const hasSimpleTokens=(path:readonly EffectiveMidRow[]):boolean=>{
      for(let i=0;i<path.length;i++){
        const t=path[i]!.tokenOut;
        if(t===weth)return false;
        for(let j=0;j<i;j++)if(path[j]!.tokenOut===t)return false;
      }
      return true;
    };
    const propose=(token:string,ref:EffectiveAmountReference)=>{
      if(token===weth||!wanted.has(token)||!ref.path.length||ref.path.length>samplingDepthLimit||
        ref.path[0]!.tokenIn!==weth||ref.path[0]!.amountIn!==referenceWethInput||ref.path[ref.path.length-1]!.tokenOut!==token||
        ref.path.some(s=>!edges.has(s.edgeId)||input.disabledEdgeIds?.has(s.edgeId)||edges.get(s.edgeId)!.leavesStandingPosition)||
        !hasSimpleTokens(ref.path))return;
      const prior=proposals.get(token);
      if(!prior||ref.path.length<prior.path.length||(ref.path.length===prior.path.length&&ref.amountIn>prior.amountIn))proposals.set(token,ref);
      const choices=paidChoices.get(token)??new Map<string,EffectiveAmountReference>();paidChoices.set(token,choices);
      const key=planKey(ref),same=choices.get(key);if(!same||ref.amountIn>same.amountIn)choices.set(key,ref);
    };
    if(!oldRanking?.restoredPoolOrigins)for(const [t,ref]of previousState!.references)propose(t,ref);
    for(const r of requestedOrigins!.values()){
      const ref=rowAmountReferences.get(r)!;
      if(wanted.has(r.tokenIn))propose(r.tokenIn,ref);
      if(wanted.has(r.tokenOut)&&r.amountOut!==null&&ref.path.length<samplingDepthLimit)
        propose(r.tokenOut,{amountIn:r.amountOut,path:[...ref.path,r]});
    }
    for(const i of poolDirty){
      const token=work[i]!.tokenIn;
      let p=proposals.get(token);
      if(p&&referenceSharesExplicitResource(p,work[i]!.edge)){
        const minLen = p.path.length + 1;
        p=[...(paidChoices.get(token)?.values()??[])]
          .filter(r=>r.path.length>=minLen && !referenceSharesExplicitResource(r,work[i]!.edge))
          .sort((a,b)=>a.path.length-b.path.length||(b.amountIn>a.amountIn?1:b.amountIn<a.amountIn?-1:0))[0];
      }
      if(p)proposedAt[p.path.length]!.push(i);
    }
  }
  if (!input.cascadeAmountChanges) {
    // With cascading off, clean tuples remain historical samples. Their
    // ORIGINAL lineage can seed quantities even if an upstream pool changed;
    // never attach a new prefix to an old, differently sized output. All such
    // candidates are seeded before layers run, so their actual path depth,
    // rather than the current frontier depth, determines shortest-path rank.
    for (const [index, row] of reusable) {
      const reference = rowAmountReferences.get(row);
      if (!reference || referenceSharesExplicitResource(reference, work[index]!.edge) || !reference.path.every(step => {
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

  if (diagnostic) diagnostic.setupMs = Math.max(0, performance.now() - diagnostic.startedAt);
  report();
  const progressTimer = input.onProgress ? setInterval(report, 5000) : undefined;
  progressTimer?.unref();
  try {
  for (let depth = 0; depth <= samplingDepthLimit; depth++) {
    const planningStartedAt = diagnostic ? performance.now() : 0;
    let layer: number[] = depth === 0 ? [...(workByToken.get(weth) ?? [])] : [];
    for (const [token, reference] of pending[depth]!) {
      if (!references.has(token)) {
        references.set(token, reference);
        for (const index of workByToken.get(token) ?? []) layer.push(index);
      }
    }
    for (const [token, crossRef] of pendingDeferred[depth]!) {
      deferredRef.set(token, crossRef);
      const waiting = deferredSelfResource.get(token);
      if (waiting && waiting.length > 0) {
        const stillWaiting: number[] = [];
        for (const idx of waiting) {
          if (!referenceSharesExplicitResource(crossRef, work[idx]!.edge)) {
            layer.push(idx);
          } else {
            stillWaiting.push(idx);
          }
        }
        if (stillWaiting.length > 0) deferredSelfResource.set(token, stillWaiting);
        else deferredSelfResource.delete(token);
      }
    }
    if(poolPlan)layer=[...new Set([...layer,...proposedAt[depth]!])].filter(i=>!rows[i]);
    // Preserve graph order within a layer, including preparation/dispatch order.
    layer.sort((a, b) => a - b);
    const activeLayer: number[] = [];
    const fresh: number[] = [];
    for (const index of layer) {
      const item = work[index]!;
      const token = item.tokenIn;
      let reference: EffectiveAmountReference | undefined = references.get(token) ?? proposals.get(token);
      if (!reference || referenceSharesExplicitResource(reference, item.edge)) {
        const baseLen = reference ? reference.path.length : 0;
        const crossHop = deferredRef.get(token);
        const validCrossHop = crossHop && crossHop.path.length > baseLen && !referenceSharesExplicitResource(crossHop, item.edge)
          ? crossHop
          : (poolPlan
            ? [...(paidChoices.get(token)?.values() ?? [])]
                .filter(r => r.path.length > baseLen && !referenceSharesExplicitResource(r, item.edge))
                .sort((a, b) => a.path.length - b.path.length || (b.amountIn > a.amountIn ? 1 : b.amountIn < a.amountIn ? -1 : 0))[0]
            : undefined);
        if (validCrossHop) {
          reference = validCrossHop;
        } else {
          if (!poolPlan && depth < samplingDepthLimit) {
            const waiting = deferredSelfResource.get(token);
            if (waiting) waiting.push(index); else deferredSelfResource.set(token, [index]);
          } else {
            frontierDirections++;
            unavailable(index, "missing-valuation");
          }
          continue;
        }
      }
      frontierDirections++;
      activeLayer.push(index);
      const bridge = bridges.has(item.edgeId) ? rankingCandidates.get(index) : undefined;
      if (bridge && !closed()) {
        // Only a market-clean ranking sample reserved for funding can use this.
        // The existing offer()/offerOutput() would discard its paid output,
        // even if settlement succeeded. All references at this depth are final;
        // pending references at the NEXT depth still compete on actual output.
        const out = item.edge.tokenOut.toLowerCase();
        if (references.has(out) || reference.path.length >= samplingDepthLimit ||
            reference.path.some(step => step.tokenIn === out)) {
          rankOnly.set(item.edgeId, bridge);
          unavailable(index, "missing-valuation");
          continue; // No current amount, lineage or receipt on a ranking-only row.
        }
      }
      item.reference = reference;
      item.amountIn = item.reference.amountIn;
      const prior = reusable.get(index);
      if (prior && prior.amountIn !== null && !referenceSharesExplicitResource(rowAmountReferences.get(prior), item.edge) &&
          (!input.cascadeAmountChanges || prior.amountIn === item.amountIn)) storeRow(index, prior, true);
      else if (closed()) unavailable(index, "cancelled");
      else fresh.push(index);
    }
    const wave = diagnostic ? { depth, directions: activeLayer.length, fresh: fresh.length,
      planningMs: Math.max(0, performance.now() - planningStartedAt),
      sessionPrepareMs: 0, quoteWorkMs: 0, propagationMs: 0 } : undefined;
    if (wave) diagnostic!.waves.push(wave);
    // Structural reachability is not a quote demand: failed upstream samples
    // and clean carried rows need no new authority. Batch only this frontier;
    // successful outputs below will determine the next one, without capping it.
    if (input.prepareQuote && fresh.length > 0 && !closed()) {
      phase = "preparing";
      report();
      const prepareStartedAt = wave ? performance.now() : 0;
      const prepareReportMs = diagnostic?.progressCallbackMs ?? 0;
      try { await input.prepareQuote(new Set(fresh.map(index => work[index]!.edgeId))); }
      finally { if (wave) wave.sessionPrepareMs = Math.max(0, performance.now() - prepareStartedAt -
        (diagnostic!.progressCallbackMs - prepareReportMs)); }
    }
    if (phase !== "quoting") {
      phase = "quoting";
      report();
    }
    const quoteStartedAt = wave ? performance.now() : 0;
    const quoteReportMs = diagnostic?.progressCallbackMs ?? 0;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = fresh[next++];
        if (index === undefined) return;
        if (closed()) { unavailable(index, "cancelled"); continue; }
        const item=work[index]!,focused=!!poolPlan&&poolDirty.has(index);
        if(focused)poolDispatches++;
        let alternatives:EffectiveAmountReference[]|undefined,blocked:Set<string>|undefined;
        for(;;){
          const request:EffectiveMidQuoteRequest={edge:item.edge,amountIn:item.amountIn!,reference:item.reference!,control,source,maxInputPathHops};
          const observation={revertedResults:0};quoteCallsStarted++;
          try {
            const result=await observeAdapterRequests(observation,()=>input.quote(request));
            if(focused&&request.reference.path.length&&!result.inputReference)throw new Error("pool refresh lacks current-source prefix receipts");
            accept(index,result);break;
          } catch(error){
            const id=focused&&!closed()&&startupFailedFundingEdge(error,request);
            const hop=id?request.reference.path.findIndex(step=>step.edgeId===id):-1;
            if(hop<0){failed(index,error,observation.revertedResults);break;}
            (blocked??=new Set()).add(planKey(request.reference,hop+1));
            alternatives??=[...(paidChoices.get(item.edge.tokenIn.toLowerCase())?.values()??[])]
              .filter(r=>!referenceSharesExplicitResource(r,item.edge))
              .sort((a,b)=>b.path.length-a.path.length||(a.amountIn>b.amountIn?1:a.amountIn<b.amountIn?-1:0));
            let alt:EffectiveAmountReference|undefined;
            while(alternatives.length&&!closed()){
              const candidate=alternatives.pop()!;
              if(!candidate.path.some((_,i)=>blocked!.has(planKey(candidate,i+1)))){alt=candidate;break;}
            }
            if(!alt){ // The target never ran; do not persist a paid-looking budget or trigger a target failure exclusion.
              item.reference=undefined;item.amountIn=null;unavailable(index,closed()?"cancelled":"missing-valuation");break;
            }
            item.reference=alt;item.amountIn=alt.amountIn;
          } finally {
            quoteCallsSettled++;
            if(Date.now()-lastProgressAt>=5000)report();
          }
          if(closed()){unavailable(index,"cancelled");break;}
        }
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(input.concurrency, fresh.length) }, worker)); }
    finally { if (wave) wave.quoteWorkMs = Math.max(0, performance.now() - quoteStartedAt -
      (diagnostic!.progressCallbackMs - quoteReportMs)); }
    const propagationStartedAt = wave ? performance.now() : 0;
    for (const index of activeLayer) {
      const row = rows[index]!;
      const reference = input.cascadeAmountChanges ? work[index]!.reference : rowAmountReferences.get(row);
      if (reference) offerOutput(row, reference);
    }
    if (wave) wave.propagationMs = Math.max(0, performance.now() - propagationStartedAt);
  }
  const assemblyStartedAt = diagnostic ? performance.now() : 0;
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
  const removals = canReuse && oldRanking?.edges === graphEdges && previousRows.size === keys.length
    ? []
    : [...previousRows.keys()].filter(key => !presentKeysSet.has(key));
  const snapshot: EffectiveMidSnapshot = Object.freeze({ source, maxInputPathHops,
    reference: input.fixedWethInput !== undefined ? "fixed" : gasCostWei === null ? "default" : "gas",
    referenceWethInput, rows: ownRows(deltaMap(previousRows, updates, removals),
      updates.length > 0 || removals.length > 0 || !canReuse),
    complete: !closed() && rows.every(row => row.status !== "cancelled"), wallMs: Date.now() - started });
  const verifiedExecutions = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const reference = rowAmountReferences.get(row), edge = work[index]!.edge;
    const verified = effectiveRowExecutionVerified({ source, maxInputPathHops }, row, edge, reference) ||
      reusedIndices.has(index) && previous !== undefined && referenceCanCarry(reference, true) &&
        effectiveRowExecutionVerified(previous, row, edge, reference);
    if (verified) for (const step of [...reference!.path, row]) verifiedExecutions.add(step.executionVerification!.receiptHash);
  }
  amountReferenceState.set(snapshot, { source, weth, references, verifiedExecutions });
  const dirtyUnfunded = canReuse && immutableRows && poolPlan
    ? [...poolDirty].filter(i => rows[i]?.status === "missing-valuation").map(i => work[i]!.edgeId)
    : [];
  if (dirtyUnfunded.length && requestedOrigins) {
    if (!requestedOriginsCloned) {
      requestedOrigins = new Map(requestedOrigins);
      requestedOriginsCloned = true;
    }
    for (const key of dirtyUnfunded) requestedOrigins.delete(key);
  }
  if(snapshot.complete && graphEdgeIndexes.has(graphEdges))rankingState.set(snapshot,{edges:graphEdges,byId:rankOnly,
    ...(requestedOrigins?{requestedOrigins}:{})});
  if (canReuse && immutableRows) {
    nativeChanges.set(snapshot, Object.freeze({
      previous: new WeakRef(previous), edges: (input.quoteGraph ?? pricing.graph).edges,
      updates: Object.freeze(updates), removals: Object.freeze(removals),
      ...(dirtyUnfunded.length ? { dirtyUnfunded: Object.freeze(dirtyUnfunded) } : {}),
    }));
  }
  phase = snapshot.complete ? "completed" : "interrupted";
  if (diagnostic) diagnostic.assemblyMs = Math.max(0, performance.now() - assemblyStartedAt);
  return snapshot;
  } finally {
    clearInterval(progressTimer);
    if (phase !== "completed") phase = "interrupted";
    report();
    if (diagnostic) {
      try {
        const wallMs = Math.max(0, performance.now() - diagnostic.startedAt);
        const measuredMs = diagnostic.setupMs + diagnostic.progressCallbackMs + diagnostic.assemblyMs +
          diagnostic.waves.reduce((sum, wave) => sum + wave.planningMs + wave.sessionPrepareMs +
            wave.quoteWorkMs + wave.propagationMs, 0);
        // Partition previous *quoted* rows, not raw activity addresses, all Graph directions,
        // or this block's successful quotes. Keep diagnostics out of publication/replay and
        // use the actual eligibility/winner decisions without rerunning receipt verification.
        const carry = { priorQuoted: 0, carried: 0, ownStateTouched: 0, prefixOnlyTouched: 0,
          failedVerification: 0, noCompatibleBase: 0, disabled: 0, cancelled: 0, interrupted: 0,
          graphOrIdentityChanged: 0, unsupported: 0, cascadeAmountChanged: 0, eligibleNotUsed: 0 };
        if (previous) {
          const positions = new Map(work.map(({ edgeId }, i) => [edgeId, i] as const));
          for (const [key, prior] of previous.rows) {
            if (prior.status !== "quoted") continue;
            carry.priorQuoted++;
            const i = positions.get(key);
            if (i === undefined) { carry.graphOrIdentityChanged++; continue; }
            const item = work[i]!, edge = item.edge;
            if (rows[i]?.status === "disabled-for-run") carry.disabled++;
            else if (rows[i]?.status === "cancelled") carry.cancelled++;
            else if (!rows[i]) carry.interrupted++;
            else if (edge.leavesStandingPosition && !pricing.pricingStateKeyByEdgeKey?.has(key)) carry.unsupported++;
            else if (!canReuse) carry.noCompatibleBase++;
            else if (reusedIndices.has(i)) carry.carried++;
            else if (reusable.has(i)) {
              if (input.cascadeAmountChanges && item.amountIn !== null && prior.amountIn !== item.amountIn) carry.cascadeAmountChanged++;
              else carry.eligibleNotUsed++;
            } else if (prior.edgeId !== key || prior.instanceKey !== edgeInstanceKey(edge) ||
                prior.tokenIn !== edge.tokenIn.toLowerCase() || prior.tokenOut !== edge.tokenOut.toLowerCase()) carry.graphOrIdentityChanged++;
            // The coordinator includes Family each-block keys in the supplied state set.
            // Own takes precedence over prefix when both were touched.
            else if (stateRejectsReceipt(stateKeyFor(key, edge), prior, edge)) carry.ownStateTouched++;
            else if (diagnostic.prefixTouchedRejections.has(i)) carry.prefixOnlyTouched++;
            else carry.failedVerification++;
          }
        }
        const rankCauses={prefixOnly:0,executionSubscriptionOnly:0,both:0,poolUnchanged:0,retainedHistorical:0};
        for(const [id,r] of rankOnly){
          if(oldRanking?.byId.get(id)===r)rankCauses.retainedHistorical++;
          else rankCauses[r.cause]++;
        }
        console.log(`[searcher/effective-phase-timing] ${JSON.stringify({
          sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
          status: phase, timingModel: "nonoverlapping-wall-includes-io-cpu-gc",
          ...(poolPlan?{poolRefresh:{eligible:poolDirty.size,dispatched:poolDispatches,
            unfunded:[...poolDirty].filter(i=>rows[i]?.status==="missing-valuation").length}}:{}),
          wallMs, setupMs: diagnostic.setupMs, progressCallbackMs: diagnostic.progressCallbackMs,
          assemblyMs: diagnostic.assemblyMs, unattributedMs: Math.max(0, wallMs - measuredMs),
          waves: diagnostic.waves, carry,
          historicalRanking:{only:rankOnly.size,...rankCauses,protectedBridges:rankingCandidates.size-rankOnly.size},
        })}`);
      } catch { /* Diagnostic output must not alter an effective-price result. */ }
    }
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
