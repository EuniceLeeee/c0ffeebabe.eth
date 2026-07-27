import { createHash } from "node:crypto";
import type { TokenEdge } from "../planner/token-graph.js";
import type {
  BlockScanBackrunStateInvalidation,
  BlockScanBackrunStateSeed,
} from "../solver/pool-state-cache.js";
import type { RouteVenueMid } from "./mid-readers.js";
import {
  edgeExecutionVariantKey,
  edgeInstanceKey,
} from "./route-instance-identity.js";

export type BlockScanPricingLane = "swap" | "protocol";
export type StateReadTransport = "multicall-safe" | "rpc-batch";

export interface BlockSource {
  readonly number: number;
  readonly hash: string;
  readonly generation: number;
}

export interface ChainLog {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly removed?: boolean;
}

/**
 * Family-owned declaration of the complete log surface that can mutate its
 * pricing state. Empty addresses means "all emitters"; the family classifier
 * must still ignore emitters it does not own.
 */
export interface MutationQueryDescriptor {
  readonly addresses: readonly string[];
  readonly topics: readonly (string | readonly string[] | null)[];
  readonly fingerprint: string;
}

export interface CanonicalMutationRange {
  readonly fromExclusive: BlockSource;
  readonly through: BlockSource;
  readonly events: readonly ChainLog[];
  readonly complete: true;
  readonly queryDescriptorFingerprint: string;
  readonly canonicalPathFingerprint: string;
  readonly rangeFingerprint: string;
}

export interface PublishedFamilyStateValue {
  readonly familyId: string;
  readonly snapshotFingerprint: string;
  deriveMids(edges: readonly TokenEdge[]): ReadonlyMap<string, RouteVenueMid>;
  /**
   * Optional terminal edge classification derived only from the successfully
   * decoded, source-pinned snapshot. These graph edges remain admitted but do
   * not require a mid for this generation. Unknown read/quote failures must
   * never be reported through this path.
   */
  behaviorProvenUnavailableEdges?(
    edges: readonly TokenEdge[],
  ): ReadonlyMap<string, string>;
  /**
   * Optional family-owned projection into the existing backrun cache. The
   * coordinator still owns source provenance and invokes this only for a
   * fully published state key.
   */
  projectBackrunState?(source: BlockSource): BlockScanBackrunStateSeed;
}

export interface PublishedStateKey {
  readonly familyId: string;
  /** Family-local state key, before the coordinator's family namespace. */
  readonly stateKey: string;
  readonly source: BlockSource;
  /**
   * Opaque family-owned value. The concrete Snapshot type remains captured by
   * the registration closure and never crosses the shared kernel as unknown.
   */
  readonly snapshot: PublishedFamilyStateValue;
  readonly requiredReadKeys: readonly string[];
  readonly freshnessByReadKey: ReadonlyMap<string, StateFreshnessProof>;
  readonly refreshMode:
    | "carry-forward"
    | "classified-direct"
    | "unproven-direct";
  readonly backrunInvalidations: readonly BlockScanBackrunStateInvalidation[];
}

export interface FamilyMutationClassification {
  readonly mutationRangeFingerprint: string;
  readonly classifierFingerprint: string;
  readonly changedReadKeysByStateKey: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  /**
   * Optional precise invalidations for slow-changing backrun sub-state that
   * is not required to derive the coarse mid. The state key must also appear
   * in changedReadKeysByStateKey.
   */
  readonly backrunInvalidationsByStateKey?: ReadonlyMap<
    string,
    readonly BlockScanBackrunStateInvalidation[]
  >;
}

export interface IncrementalStateCapability<Schema> {
  /**
   * For a schema-compatible state key, local StateRead IDs are part of the
   * incremental proof contract and must remain stable across generations.
   * The coordinator can then partition proven carry-forward keys before
   * constructing current-N descriptors.
   */
  mutationQueryDescriptor(input: {
    readonly schema: Schema;
    readonly edges: readonly TokenEdge[];
  }): MutationQueryDescriptor;

  /**
   * Synchronous, pure family classifier. The coordinator owns range
   * acquisition/canonical proof; the family owns event semantics.
   */
  classifyMutations(input: {
    readonly schema: Schema;
    readonly edges: readonly TokenEdge[];
    readonly range: CanonicalMutationRange;
  }): FamilyMutationClassification;
}

export type StateReadProvenance =
  | {
      readonly kind: "eip1898";
      readonly source: BlockSource;
      readonly requireCanonical: true;
    }
  | {
      readonly kind: "immutable-fork";
      readonly source: BlockSource;
      readonly forkId: string;
    };

export type StateFreshnessProof =
  | {
      readonly kind: "direct-read";
      readonly source: BlockSource;
      readonly provenance: StateReadProvenance;
    }
  | {
      readonly kind: "carry-forward";
      readonly source: BlockSource;
      readonly previousSource: BlockSource;
      readonly mutationRangeFingerprint: string;
      readonly completeThroughBlock: number;
      readonly completeThroughHash: string;
    };

export type StateKeyCoverage =
  | { readonly status: "resolved" }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "unresolved"; readonly reason: string };

export interface VerifiedGraphSourceCoverage {
  readonly familyId: string;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly completeThroughBlock: number;
  readonly completeThroughHash: string;
}

export interface VerifiedGraphCompletenessIssue {
  /** Missing source ownership is globally fatal; ordinary source gaps are family-local. */
  readonly familyId?: string;
  readonly sourceId?: string;
  readonly message: string;
}

/**
 * Immutable, source-pinned graph input for one block-scan generation.
 * Use createVerifiedGraphView rather than constructing this shape directly.
 */
export interface VerifiedGraphView {
  readonly id: string;
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly completenessWatermark: number;
  readonly perSourceCoverage: readonly VerifiedGraphSourceCoverage[];
  readonly orderedEdgeHash: string;
  readonly metadataHash: string;
  readonly ownershipHash: string;
  readonly edges: readonly TokenEdge[];
}

export interface CreateVerifiedGraphViewInput {
  readonly id: string;
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly completenessWatermark: number;
  readonly perSourceCoverage: readonly VerifiedGraphSourceCoverage[];
  readonly edges: readonly TokenEdge[];
  /** Production supplies the unique registry owner; fixtures may use adapterId. */
  readonly familyIdForEdge?: (edge: TokenEdge) => string;
}

export type CanonicalEdgeId = string & {
  readonly __canonicalEdgeId: unique symbol;
};

export interface StateRead {
  /**
   * Adapter-local read identity; unique within one state key. This is the
   * canonical `readKey` from the architecture contract. The historical `id`
   * spelling remains during the typed-family migration so mature family
   * readers do not need a semantic rewrite.
   */
  readonly id: string;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly to: string;
  readonly data: string;
  readonly from?: string;
  readonly transport: StateReadTransport;
  /** Contract intentionally returns a quote as revert bytes (for example Fluid). */
  readonly acceptRevertData?: boolean;
}

export type StateReadFailureKind =
  | "rpc"
  | "deadline"
  | "aborted"
  | "resource-limited";

export interface StateReadSuccess {
  readonly id: string;
  readonly ok: true;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  /** Trusted transport evidence; family decoders cannot manufacture it. */
  readonly provenance: StateReadProvenance;
  readonly data: string;
}

export interface StateReadFailure {
  readonly id: string;
  readonly ok: false;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly kind: StateReadFailureKind;
  readonly error: string;
}

export type StateReadResult = StateReadSuccess | StateReadFailure;

export interface StateOperationControl {
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export interface CompileStaticSchemaInput extends StateOperationControl {
  readonly edges: readonly TokenEdge[];
}

export interface BuildCurrentBlockReadsInput<Schema> {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly schema: Schema;
  readonly edges: readonly TokenEdge[];
}

export interface BuildStaticSchemaReadsInput<Schema> {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly schema: Schema;
  readonly edges: readonly TokenEdge[];
}

export interface BuildDependentBlockReadsInput<Schema>
  extends BuildCurrentBlockReadsInput<Schema> {
  /**
   * Zero-based round that has just completed. Results are adapter-local and
   * include every prior round in deterministic execution order.
   */
  readonly completedRound: number;
  readonly priorResults: readonly StateReadResult[];
}

/**
 * Families describe state semantics only. Scheduling, retries, deadlines,
 * batching and publication remain coordinator-owned.
 */
export interface BlockScanStateCapability<Schema = unknown, Snapshot = unknown> {
  stateKey(edge: TokenEdge): string;
  compileStaticSchema(input: CompileStaticSchemaInput): Schema | Promise<Schema>;
  /**
   * Optional incremental schema compiler. The previous schema is supplied
   * only from a generation that crossed the coordinator's canonical CAS and
   * publication fence. Families may reuse strong positive identity metadata,
   * while new/changed instances still produce source-pinned static reads.
   */
  extendStaticSchema?(
    previousSchema: Schema,
    input: CompileStaticSchemaInput,
  ): Schema | Promise<Schema>;
  /**
   * Optional graph-fingerprint-scoped metadata reads (for example decimals).
   * These run only on schema cache miss and are still pinned by the trusted
   * transport. Both methods must be supplied together.
   */
  buildStaticSchemaReads?(
    input: BuildStaticSchemaReadsInput<Schema>,
  ): readonly StateRead[];
  hydrateStaticSchema?(
    schema: Schema,
    results: readonly StateReadResult[],
  ): Schema;
  buildCurrentBlockReads(
    input: BuildCurrentBlockReadsInput<Schema>,
  ): readonly StateRead[];
  /**
   * Optional bounded dependency expansion for contracts whose quote calldata
   * depends on a current-block read (for example token decimals). Returning an
   * empty array closes the state key. The coordinator owns every round and
   * batches equal descriptors globally; families must not perform I/O here.
   */
  buildDependentBlockReads?(
    input: BuildDependentBlockReadsInput<Schema>,
  ): readonly StateRead[];
  decodeState(
    schema: Schema,
    results: readonly StateReadResult[],
  ): Snapshot;
  deriveMids(
    snapshot: Snapshot,
    edges: readonly TokenEdge[],
  ): ReadonlyMap<string, RouteVenueMid>;
  /**
   * Returns canonical edge keys that current-N state proves cannot execute,
   * with a non-empty reason for each edge. This is a terminal availability
   * result, not an error fallback: RPC failures, quote reverts and ambiguous
   * state remain unresolved.
   */
  behaviorProvenUnavailableEdges?(
    snapshot: Snapshot,
    edges: readonly TokenEdge[],
  ): ReadonlyMap<string, string>;
  projectBackrunState?(
    snapshot: Snapshot,
    source: BlockSource,
  ): BlockScanBackrunStateSeed;
  dependencies(edges: readonly TokenEdge[]): readonly string[];
  /**
   * Opt-in only after family conformance proves this query/classifier covers
   * every pricing-state mutation. Absence always means direct current-N reads.
   */
  readonly incremental?: IncrementalStateCapability<Schema>;
}

export interface PublishedFamilyState {
  readonly familyId: string;
  readonly source: BlockSource;
  readonly snapshot: PublishedFamilyStateValue;
  readonly coverageByReadKey: ReadonlyMap<
    string,
    ReadonlyMap<string, StateKeyCoverage>
  >;
  readonly freshnessByReadKey: ReadonlyMap<
    string,
    ReadonlyMap<string, StateFreshnessProof>
  >;
}

export interface CompiledIncrementalStateFamily {
  mutationQueryDescriptor(edges: readonly TokenEdge[]): MutationQueryDescriptor;
  classifyMutations(input: {
    readonly edges: readonly TokenEdge[];
    readonly range: CanonicalMutationRange;
  }): FamilyMutationClassification;
}

export interface CompiledBlockScanStateFamily {
  readonly familyId: string;
  readonly lane: BlockScanPricingLane;
  readonly edgeFingerprint: string;
  buildCurrentBlockReads(input: {
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly edges: readonly TokenEdge[];
  }): readonly StateRead[];
  buildDependentBlockReads?(input: {
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly edges: readonly TokenEdge[];
    readonly completedRound: number;
    readonly priorResults: readonly StateReadResult[];
  }): readonly StateRead[];
  decodeState(results: readonly StateReadResult[]): PublishedFamilyStateValue;
  readonly incremental?: CompiledIncrementalStateFamily;
  /**
   * Recompile a changed graph from this already-published schema. The
   * coordinator never exposes an uncommitted generation through this hook.
   */
  recompile?(
    input: RegisteredBlockScanStateFamilyCompileInput,
  ): Promise<CompiledBlockScanStateFamily>;
}

export interface RegisteredBlockScanStateFamilyCompileInput
  extends CompileStaticSchemaInput {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readStatic(reads: readonly StateRead[]): Promise<readonly StateReadResult[]>;
}

export interface RegisteredBlockScanStateFamily {
  readonly familyId: string;
  readonly lane: BlockScanPricingLane;
  stateKey(edge: TokenEdge): string;
  ownsEdge(edge: TokenEdge): boolean;
  compile(
    input: RegisteredBlockScanStateFamilyCompileInput,
  ): Promise<CompiledBlockScanStateFamily>;
}

/**
 * Generic registration closure. Schema and Snapshot are concrete inside the
 * family, while the coordinator receives only executable typed operations and
 * an opaque state value capable of deriving its own mids.
 */
export function registerBlockScanStateFamily<Schema, Snapshot>(input: {
  readonly familyId: string;
  readonly lane: BlockScanPricingLane;
  readonly capability: BlockScanStateCapability<Schema, Snapshot>;
  ownsEdge(edge: TokenEdge): boolean;
}): RegisteredBlockScanStateFamily {
  const { familyId, lane, capability } = input;
  const compile = async (
    compileInput: RegisteredBlockScanStateFamilyCompileInput,
    previousSchema?: Schema,
  ): Promise<CompiledBlockScanStateFamily> => {
    if (compileInput.signal.aborted) {
      throw compileInput.signal.reason;
    }
    if (Date.now() >= compileInput.deadlineAtMs) {
      throw new Error(`family ${familyId} static schema deadline expired`);
    }
    const baseSchema = await resolveCapabilityValue(
      previousSchema !== undefined && capability.extendStaticSchema
        ? capability.extendStaticSchema(previousSchema, compileInput)
        : capability.compileStaticSchema(compileInput),
    );
    const hasStaticReads = capability.buildStaticSchemaReads !== undefined;
    if (hasStaticReads !== (capability.hydrateStaticSchema !== undefined)) {
      throw new Error(
        `family ${familyId} must pair static reads with schema hydration`,
      );
    }
    let schema: Schema = baseSchema as Schema;
    if (capability.buildStaticSchemaReads && capability.hydrateStaticSchema) {
      const reads = capability.buildStaticSchemaReads({
        sourceBlock: compileInput.sourceBlock,
        sourceBlockHash: compileInput.sourceBlockHash,
        schema: baseSchema,
        edges: compileInput.edges,
      });
      if (isThenable(reads)) {
        throw new Error("buildStaticSchemaReads must return synchronously");
      }
      const results = reads.length === 0
        ? Object.freeze([]) as readonly StateReadResult[]
        : await compileInput.readStatic(Object.freeze([...reads]));
      schema = capability.hydrateStaticSchema(baseSchema, results);
      if (isThenable(schema)) {
        throw new Error("hydrateStaticSchema must return synchronously");
      }
    }
    const edgeFingerprint = stateSchemaFingerprint(compileInput.edges);
    const compiled: CompiledBlockScanStateFamily = {
      familyId,
      lane,
      edgeFingerprint,
      buildCurrentBlockReads(readInput) {
        return capability.buildCurrentBlockReads({
          ...readInput,
          schema,
        });
      },
      ...(capability.buildDependentBlockReads
        ? {
            buildDependentBlockReads(readInput: {
              readonly sourceBlock: number;
              readonly sourceBlockHash: string;
              readonly edges: readonly TokenEdge[];
              readonly completedRound: number;
              readonly priorResults: readonly StateReadResult[];
            }) {
              return capability.buildDependentBlockReads!({
                ...readInput,
                schema,
              });
            },
          }
        : {}),
      decodeState(results) {
        const snapshot = capability.decodeState(schema, results);
        if (isThenable(snapshot)) {
          throw new Error("decodeState must return synchronously");
        }
        return Object.freeze({
          familyId,
          snapshotFingerprint: deterministicHash(snapshot),
          deriveMids(edges: readonly TokenEdge[]) {
            const mids = capability.deriveMids(snapshot, edges);
            if (isThenable(mids)) {
              throw new Error("deriveMids must return synchronously");
            }
            return mids;
          },
          ...(capability.behaviorProvenUnavailableEdges
            ? {
                behaviorProvenUnavailableEdges(
                  edges: readonly TokenEdge[],
                ) {
                  const unavailable =
                    capability.behaviorProvenUnavailableEdges!(
                      snapshot,
                      edges,
                    );
                  if (isThenable(unavailable)) {
                    throw new Error(
                      "behaviorProvenUnavailableEdges must return synchronously",
                    );
                  }
                  return unavailable;
                },
              }
            : {}),
          ...(capability.projectBackrunState
            ? {
                projectBackrunState(source: BlockSource) {
                  const seed = capability.projectBackrunState!(
                    snapshot,
                    source,
                  );
                  if (isThenable(seed)) {
                    throw new Error(
                      "projectBackrunState must return synchronously",
                    );
                  }
                  return seed;
                },
              }
            : {}),
        });
      },
      ...(capability.incremental
        ? {
            incremental: Object.freeze({
              mutationQueryDescriptor(edges: readonly TokenEdge[]) {
                return capability.incremental!.mutationQueryDescriptor({
                  schema,
                  edges,
                });
              },
              classifyMutations(classifyInput: {
                readonly edges: readonly TokenEdge[];
                readonly range: CanonicalMutationRange;
              }) {
                return capability.incremental!.classifyMutations({
                  schema,
                  edges: classifyInput.edges,
                  range: classifyInput.range,
                });
              },
            }),
          }
        : {}),
      ...(capability.extendStaticSchema
        ? {
            recompile(nextInput: RegisteredBlockScanStateFamilyCompileInput) {
              return compile(nextInput, schema);
            },
          }
        : {}),
    };
    return Object.freeze(compiled);
  };
  return Object.freeze({
    familyId,
    lane,
    stateKey: (edge: TokenEdge) => capability.stateKey(edge),
    ownsEdge: (edge: TokenEdge) => input.ownsEdge(edge),
    compile,
  });
}

export interface DeriveMidsPurityHarness {
  /**
   * Installs the harness's declared poison providers/singletons for the
   * duration of run and restores them afterwards. An attempted call through
   * one of those entrypoints must increment ioCalls and throw.
   */
  withPoisonedIo<T>(run: () => T): T;
  ioCalls(): number;
}

export interface DeriveMidsPurityResult {
  readonly outputHash: string;
  readonly edgeKeys: readonly string[];
}

/**
 * Default conformance harness for family tests. It poisons the listed common
 * global network/scheduling entrypoints while deriveMids executes, so the test
 * is not a self-reported zero counter. It is not a proof against native code or
 * a previously captured singleton; families with injected dependencies must
 * wrap this harness and poison those bindings too.
 */
export function createAmbientIoPoisonHarness(): DeriveMidsPurityHarness {
  let attempts = 0;
  const keys = Object.freeze([
    "fetch",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
  ]);
  return Object.freeze({
    withPoisonedIo<T>(run: () => T): T {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const originals = new Map<string, PropertyDescriptor>();
      try {
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(root, key);
          if (!descriptor || (!descriptor.configurable && !descriptor.writable)) {
            continue;
          }
          originals.set(key, descriptor);
          Object.defineProperty(root, key, {
            ...descriptor,
            value: (..._args: readonly unknown[]) => {
              attempts++;
              throw new Error(`deriveMids attempted ambient I/O via ${key}`);
            },
          });
        }
        return run();
      } finally {
        for (const [key, descriptor] of originals) {
          Object.defineProperty(root, key, descriptor);
        }
      }
    },
    ioCalls: () => attempts,
  });
}

export function createVerifiedGraphView(
  input: CreateVerifiedGraphViewInput,
): VerifiedGraphView {
  if (!input.id) throw new Error("verified graph id is required");
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error(`invalid graph generation ${input.generation}`);
  }
  if (!Number.isSafeInteger(input.sourceBlock) || input.sourceBlock < 0) {
    throw new Error(`invalid graph source block ${input.sourceBlock}`);
  }
  if (
    !Number.isSafeInteger(input.completenessWatermark) ||
    input.completenessWatermark < 0
  ) {
    throw new Error(`invalid graph completeness watermark ${input.completenessWatermark}`);
  }
  const sourceBlockHash = normalizeBlockHash(input.sourceBlockHash);
  const edges = Object.freeze(input.edges.map((edge) => freezeEdge({
    ...edge,
    canonicalEdgeId: canonicalEdgeId(
      input.familyIdForEdge?.(edge) ?? edge.adapterId,
      edge,
    ),
  })));
  const perSourceCoverage = Object.freeze(
    [...input.perSourceCoverage]
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      .map((coverage) => {
        if (!coverage.familyId || !coverage.sourceId || !coverage.sourceFingerprint) {
          throw new Error(
            "verified graph source coverage requires family, id and fingerprint",
          );
        }
        if (
          !Number.isSafeInteger(coverage.completeThroughBlock) ||
          coverage.completeThroughBlock < 0
        ) {
          throw new Error(
            `invalid coverage block ${coverage.completeThroughBlock} for ${coverage.sourceId}`,
          );
        }
        return Object.freeze({
          familyId: coverage.familyId,
          sourceId: coverage.sourceId,
          sourceFingerprint: coverage.sourceFingerprint,
          completeThroughBlock: coverage.completeThroughBlock,
          completeThroughHash: normalizeBlockHash(coverage.completeThroughHash),
        });
      }),
  );
  const minimumCoverage = Math.min(
    ...perSourceCoverage.map((coverage) => coverage.completeThroughBlock),
  );
  if (
    perSourceCoverage.length > 0 &&
    input.completenessWatermark !== minimumCoverage
  ) {
    throw new Error(
      `graph completeness watermark ${input.completenessWatermark} does not equal ` +
        `minimum source coverage ${minimumCoverage}`,
    );
  }
  const edgeRecords = edges.map(canonicalEdgeRecord);
  return Object.freeze({
    id: input.id,
    generation: input.generation,
    sourceBlock: input.sourceBlock,
    sourceBlockHash,
    completenessWatermark: input.completenessWatermark,
    perSourceCoverage,
    orderedEdgeHash: deterministicHash(edgeRecords),
    metadataHash: deterministicHash(edgeRecords.map(({ identity: _identity, ...rest }) => rest)),
    ownershipHash: deterministicHash(
      edgeRecords.map((edge) => ({ identity: edge.identity, adapterId: edge.adapterId })),
    ),
    edges,
  });
}

export function verifiedGraphCompletenessIssues(
  graph: VerifiedGraphView,
): readonly string[] {
  return verifiedGraphCompletenessIssueDetails(graph).map((issue) => issue.message);
}

/**
 * Source-owned graph completeness. A gap in one registered family must not
 * turn a healthy sibling's positive route into a global failure, while the
 * owner tag still prevents an incomplete family from contributing routes or a
 * "complete/no opportunity" conclusion.
 */
export function verifiedGraphCompletenessIssueDetails(
  graph: VerifiedGraphView,
): readonly VerifiedGraphCompletenessIssue[] {
  const issues: VerifiedGraphCompletenessIssue[] = [];
  if (graph.perSourceCoverage.length === 0) {
    issues.push({ message: "verified graph has no source coverage proofs" });
  }
  for (const coverage of graph.perSourceCoverage) {
    if (coverage.completeThroughBlock < graph.sourceBlock) {
      issues.push({
        familyId: coverage.familyId,
        sourceId: coverage.sourceId,
        message:
          `family ${coverage.familyId} source ${coverage.sourceId} ` +
          `complete through ${coverage.completeThroughBlock}`,
      });
      continue;
    }
    if (
      coverage.completeThroughBlock === graph.sourceBlock &&
      coverage.completeThroughHash !== graph.sourceBlockHash
    ) {
      issues.push({
        familyId: coverage.familyId,
        sourceId: coverage.sourceId,
        message:
          `family ${coverage.familyId} source ${coverage.sourceId} block hash mismatch`,
      });
    }
  }
  return Object.freeze(issues);
}

/**
 * Exact route identity used by coverage maps. It deliberately includes
 * singleton-pool discriminators and Curve indices, not just target address.
 */
export function blockScanEdgeKey(edge: TokenEdge): string {
  if (edge.canonicalEdgeId) return edge.canonicalEdgeId;
  return [
    edgeInstanceKey(edge),
    normalizeAddressLike(edge.target),
    normalizeAddressLike(edge.tokenIn),
    normalizeAddressLike(edge.tokenOut),
    edge.slotKind,
    edge.protocolAction ?? "",
    edgeExecutionVariantKey(edge),
  ].join("\u001f");
}

export function stateSchemaFingerprint(edges: readonly TokenEdge[]): string {
  return deterministicHash(
    [...edges]
      .map((edge) => ({
        edgeKey: blockScanEdgeKey(edge),
        poolToken0: edge.poolToken0?.toLowerCase() ?? null,
        poolToken1: edge.poolToken1?.toLowerCase() ?? null,
        v2FeeBps: edge.v2FeeBps?.toString() ?? null,
        v3Fee: edge.v3Fee ?? null,
        v3TickSpacing: edge.v3TickSpacing ?? null,
        factory: edge.factory?.toLowerCase() ?? null,
        curveI: edge.curveI ?? null,
        curveJ: edge.curveJ ?? null,
        poolId: edge.poolId?.toLowerCase() ?? null,
        v4PoolKey: edge.v4PoolKey ?? null,
      }))
      .sort((a, b) => a.edgeKey.localeCompare(b.edgeKey)),
  );
}

export function canonicalEdgeId(
  familyId: string,
  edge: TokenEdge,
): CanonicalEdgeId {
  if (!familyId || familyId.includes("\u001f")) {
    throw new Error("canonical edge identity requires a separator-safe family owner");
  }
  const executionVariantKey = blockScanExecutionVariantKey(edge);
  return [
    familyId,
    edgeInstanceKey(edge),
    normalizeAddressLike(edge.target),
    `${normalizeAddressLike(edge.tokenIn)}>${normalizeAddressLike(edge.tokenOut)}`,
    executionVariantKey,
  ].join("\u001f") as CanonicalEdgeId;
}

export function blockScanExecutionVariantKey(edge: TokenEdge): string {
  return edgeExecutionVariantKey(edge);
}

export function blockScanStateKey(familyId: string, stateKey: string): string {
  if (!familyId) throw new Error("state family id is required");
  if (!stateKey) throw new Error(`empty state key for family ${familyId}`);
  return `${familyId}\u001f${stateKey}`;
}

export function exactSetHash(values: Iterable<string>): string {
  return deterministicHash([...new Set(values)].sort());
}

export function createMutationQueryDescriptor(input: {
  readonly addresses?: readonly string[];
  readonly topics: readonly (string | readonly string[] | null)[];
}): MutationQueryDescriptor {
  const addresses = Object.freeze(
    [...new Set((input.addresses ?? []).map(normalizeAddressLike))].sort(),
  );
  const topics = Object.freeze(input.topics.map((topic) => {
    if (topic === null) return null;
    if (typeof topic === "string") return normalizeTopic(topic);
    return Object.freeze([...new Set(topic.map(normalizeTopic))].sort());
  }));
  return Object.freeze({
    addresses,
    topics,
    fingerprint: mutationQueryDescriptorFingerprint({ addresses, topics }),
  });
}

export function mutationQueryDescriptorFingerprint(
  descriptor: Pick<MutationQueryDescriptor, "addresses" | "topics">,
): string {
  return deterministicHash({
    addresses: [...descriptor.addresses].map(normalizeAddressLike).sort(),
    topics: descriptor.topics.map((topic) =>
      topic === null
        ? null
        : typeof topic === "string"
          ? normalizeTopic(topic)
          : [...topic].map(normalizeTopic).sort()
    ),
  });
}

/**
 * Conformance hook used by active-family tests. The hook poisons any ambient
 * backend owned by the family, asserts synchronous return, runs twice, and
 * hashes the exact outputs to prove deterministic snapshot-only derivation.
 */
export function assertPureSynchronousDeriveMids<Schema, Snapshot>(input: {
  readonly capability: BlockScanStateCapability<Schema, Snapshot>;
  readonly snapshot: Snapshot;
  readonly edges: readonly TokenEdge[];
  readonly harness: DeriveMidsPurityHarness;
}): DeriveMidsPurityResult {
  const before = input.harness.ioCalls();
  const derive = (): ReadonlyMap<string, RouteVenueMid> => {
    const output = input.capability.deriveMids(input.snapshot, input.edges);
    if (isThenable(output)) {
      throw new Error("deriveMids must return synchronously");
    }
    if (!(output instanceof Map) && typeof output?.entries !== "function") {
      throw new Error("deriveMids must return a ReadonlyMap");
    }
    return output;
  };
  const first = input.harness.withPoisonedIo(derive);
  const second = input.harness.withPoisonedIo(derive);
  const after = input.harness.ioCalls();
  if (after !== before) {
    throw new Error(`deriveMids attempted ${after - before} I/O operation(s)`);
  }
  const firstHash = hashMidMap(first);
  const secondHash = hashMidMap(second);
  if (firstHash !== secondHash) {
    throw new Error("deriveMids is not deterministic for an identical snapshot");
  }
  return Object.freeze({
    outputHash: firstHash,
    edgeKeys: Object.freeze([...first.keys()].sort()),
  });
}

export function deterministicHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function hashMidMap(mids: ReadonlyMap<string, RouteVenueMid>): string {
  return deterministicHash(
    [...mids.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, mid]) => [key, mid]),
  );
}

function canonicalEdgeRecord(edge: TokenEdge): Record<string, unknown> {
  return {
    identity: blockScanEdgeKey(edge),
    instanceKey: edgeInstanceKey(edge),
    executionVariantKey: edgeExecutionVariantKey(edge),
    adapterId: edge.adapterId,
    target: normalizeAddressLike(edge.target),
    tokenIn: normalizeAddressLike(edge.tokenIn),
    tokenOut: normalizeAddressLike(edge.tokenOut),
    slotKind: edge.slotKind,
    protocolAction: edge.protocolAction ?? null,
    edgeKind: edge.edgeKind,
    leavesStandingPosition: edge.leavesStandingPosition,
    curveI: edge.curveI ?? null,
    curveJ: edge.curveJ ?? null,
    poolToken0: edge.poolToken0 ? normalizeAddressLike(edge.poolToken0) : null,
    poolToken1: edge.poolToken1 ? normalizeAddressLike(edge.poolToken1) : null,
    v2FeeBps: edge.v2FeeBps?.toString() ?? null,
    v3Fee: edge.v3Fee ?? null,
    v3TickSpacing: edge.v3TickSpacing ?? null,
    factory: edge.factory ? normalizeAddressLike(edge.factory) : null,
    poolId: edge.poolId ? normalizeAddressLike(edge.poolId) : null,
    v4PoolKey: edge.v4PoolKey
      ? {
          currency0: normalizeAddressLike(edge.v4PoolKey.currency0),
          currency1: normalizeAddressLike(edge.v4PoolKey.currency1),
          fee: edge.v4PoolKey.fee,
          tickSpacing: edge.v4PoolKey.tickSpacing,
          hooks: normalizeAddressLike(edge.v4PoolKey.hooks),
        }
      : null,
    nativeCurrency0: edge.nativeCurrency0 ?? false,
    nativeCurrency1: edge.nativeCurrency1 ?? false,
  };
}

function freezeEdge(edge: TokenEdge): TokenEdge {
  return Object.freeze({
    ...edge,
    v4PoolKey: edge.v4PoolKey ? Object.freeze({ ...edge.v4PoolKey }) : undefined,
  });
}

function normalizeAddressLike(value: string): string {
  return value.toLowerCase();
}

function normalizeBlockHash(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`invalid block hash ${value}`);
  }
  return normalized;
}

function normalizeTopic(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`invalid event topic ${value}`);
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(stableValue);
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [String(key), stableValue(item)])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function",
  );
}

function resolveCapabilityValue<T>(value: T | Promise<T>): Promise<T> {
  return Promise.resolve(value) as Promise<T>;
}
