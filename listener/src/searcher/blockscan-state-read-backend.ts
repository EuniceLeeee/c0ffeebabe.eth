import type {
  BlockScanStateReadBackend,
  CanonicalAddressTouchRange,
} from "./blockscan-state-coordinator.js";
import type {
  RethTransportLane,
  RethTransportScheduler,
} from "./reth-transport-scheduler.js";
import type {
  BlockSource,
  BlockScanPricingLane,
  CanonicalMutationRange,
  ChainLog,
  MutationQueryDescriptor,
  StateRead,
  StateReadFailure,
  StateReadFailureKind,
  StateReadResult,
} from "./venues/blockscan-state-capability.js";
import { ethers } from "ethers";
import {
  deterministicHash,
  mutationQueryDescriptorFingerprint,
} from "./venues/blockscan-state-capability.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "./blockscan-multicall.js";
import { LiveRethReadPriority } from "./live-reth-read-priority.js";
import { decodeRlp, keccak256 } from "ethers";

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly error: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface JsonRpcBlockScanStateReadBackendOptions {
  readonly maxBatchSize?: number;
  readonly maxConcurrentBatches?: number;
  readonly maxConcurrentMutationProofs?: number;
  /**
   * Local reth is faster with parallel JSON-RPC eth_call batches than with an
   * on-chain Multicall3 aggregate. Remote providers may opt into aggregate3
   * when network round trips dominate.
   */
  readonly multicallMode?: "rpc-batch" | "aggregate3";
  /**
   * Local reth can return only the canonical RLP header. This preserves the
   * exact number/hash/parent proof while avoiding the transaction-hash payload
   * included by eth_getBlockByNumber(..., false).
   */
  readonly mutationHeaderMode?:
    | "eth-block"
    | "debug-raw-header-with-fallback";
  readonly fetchImpl?: typeof fetch;
  /**
   * Logical wall-clock bound for one HTTP request including body parsing.
   * Timing out stops the consumer from waiting, but local/shared transport
   * permits remain owned until fetch and the response body physically settle.
   * Releasing capacity while an uncooperative request is still running would
   * silently exceed the configured physical concurrency.
   */
  readonly hardRequestTimeoutMs?: number;
  readonly onMutationProofTelemetry?: (
    telemetry: MutationProofTransportTelemetry,
  ) => void;
  /**
   * Protect only canonical mutation transport. Bulk family state reads must
   * not exclude discovery from the local node for a complete generation.
   */
  readonly mutationReadPriority?: Pick<LiveRethReadPriority, "runCritical">;
  readonly now?: () => number;
  /**
   * Shared reth transport permit scheduler. One permit covers one HTTP
   * batch; producer lanes may use full capacity while exact/discovery share
   * the residual after the producer reserve.
   */
  readonly transportScheduler?: Pick<RethTransportScheduler, "run">;
  /** Lane for ordinary readPinned/readBatch traffic. */
  readonly transportLane?: RethTransportLane;
}

export type MutationProofTransportPhase =
  | "descriptor-validation"
  | "header-read"
  | "header-validation"
  | "log-read"
  | "log-validation"
  | "final-cas";

export type MutationProofFailureKind =
  | "deadline"
  | "aborted"
  | "rpc"
  | "validation"
  | "unknown";

export interface MutationProofPhaseTelemetry {
  readonly queueWaitMs: number;
  readonly wallMs: number;
  readonly rpcRequests: number;
  readonly rpcItems: number;
  readonly responseBytes: number;
  readonly shared?: boolean;
  readonly transport?:
    | "eth-block"
    | "debug-raw-header"
    | "debug-raw-header+eth-block-fallback";
}

export interface MutationProofTransportTelemetry {
  readonly descriptorFingerprint: string;
  readonly fromBlock: number;
  readonly throughBlock: number;
  readonly status: "complete" | "failed";
  readonly failurePhase?: MutationProofTransportPhase;
  readonly failureKind?: MutationProofFailureKind;
  readonly wallMs: number;
  readonly validationMs: number;
  readonly phases: Readonly<{
    readonly headers: MutationProofPhaseTelemetry;
    readonly logs: MutationProofPhaseTelemetry;
    readonly finalCas: MutationProofPhaseTelemetry;
  }>;
}

export class MutationRangeReadError extends Error {
  constructor(
    readonly phase: MutationProofTransportPhase,
    readonly kind: MutationProofFailureKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MutationRangeReadError";
  }
}

interface IndexedStateRead {
  readonly index: number;
  readonly read: StateRead;
}

interface PinnedReadControl {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly sourceGeneration: number;
}

interface CanonicalMutationHeader {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly gasUsed?: bigint;
}

interface CanonicalHeaderProof {
  readonly headers: readonly CanonicalMutationHeader[];
  readonly canonicalPathFingerprint: string;
  readonly telemetry: MutationProofPhaseTelemetry;
  readonly validationMs: number;
}

interface PendingMutationTransportBatch {
  readonly key: string;
  readonly fromExclusive: BlockSource;
  readonly through: BlockSource;
  readonly deadlineAtMs: number;
  readonly sharedSignal: AbortSignal;
  readonly descriptors: Map<string, MutationQueryDescriptor>;
  readonly completion: Promise<ReadonlyMap<string, CanonicalMutationRange>>;
  readonly resolve: (
    ranges: ReadonlyMap<string, CanonicalMutationRange>,
  ) => void;
  readonly reject: (reason?: unknown) => void;
  started: boolean;
}

export interface CanonicalBlockActivity {
  readonly fromExclusive: BlockSource;
  readonly through: BlockSource;
  /** Canonical number/hash path, including both range endpoints. */
  readonly canonicalBlocks?: readonly {
    readonly number: number;
    readonly hash: string;
  }[];
  readonly events: readonly ChainLog[];
  readonly touchedAddresses: readonly string[];
  readonly transactionCount: number;
  readonly canonicalPathFingerprint: string;
  readonly rangeFingerprint: string;
}

/**
 * Current-block read backend for the family state coordinator.
 *
 * Every read uses one explicit block tag. Local reth defaults to parallel
 * JSON-RPC batches for every read; remote providers may explicitly aggregate
 * caller-independent reads through Multicall3 when network round trips
 * dominate. No request is routed through Anvil: recent canonical state belongs
 * on the node endpoint, while Anvil remains reserved for mutating exact/final
 * simulation.
 */
export class JsonRpcBlockScanStateReadBackend
  implements BlockScanStateReadBackend
{
  private readonly maxBatchSize: number;
  private readonly maxConcurrentBatches: number;
  private readonly multicallMode: "rpc-batch" | "aggregate3";
  private readonly mutationHeaderMode:
    | "eth-block"
    | "debug-raw-header-with-fallback";
  private readonly rpcSlots: AbortableSemaphore;
  /**
   * Mutation proofs are the prerequisite for carrying unchanged state into the
   * current generation. Keep bounded transport slots outside the bulk
   * current/static/funding FIFO so a full state-read queue cannot force every
   * incremental family back to a full current-N refresh. Header proofs use
   * their own slot and remain reusable for the exact content-addressed range.
   * Descriptors sharing one generation/range are widened into one log read,
   * then filtered back to their exact family predicates in memory, with one
   * final canonical CAS for the whole transport batch. Different ranges keep
   * bounded independent slots.
   */
  private readonly mutationHeaderSlots: AbortableSemaphore;
  private readonly mutationDescriptorSlots: AbortableSemaphore;
  private readonly mutationFinalCasSlots: AbortableSemaphore;
  private readonly addressTouchSlots: AbortableSemaphore;
  /**
   * State families start concurrently. Keep their retry-safe pinned reads in
   * one local background lane so a canonical mutation proof can preempt and
   * drain bulk state transport before reading headers/logs/final CAS. The
   * separate process-wide priority still keeps discovery behind the whole
   * blockscan generation.
   */
  private readonly stateTransportPriority = new LiveRethReadPriority();
  private readonly fetchImpl: typeof fetch;
  private readonly onMutationProofTelemetry:
    | ((telemetry: MutationProofTransportTelemetry) => void)
    | undefined;
  private readonly mutationReadPriority:
    | Pick<LiveRethReadPriority, "runCritical">
    | undefined;
  private readonly hardRequestTimeoutMs: number;
  private readonly now: () => number;
  private readonly transportScheduler:
    | Pick<RethTransportScheduler, "run">
    | undefined;
  private readonly transportLane: RethTransportLane;
  private readonly mutationRangeSessions = new Map<
    string,
    Promise<CanonicalMutationRange>
  >();
  private readonly pendingMutationTransportBatches = new Map<
    string,
    PendingMutationTransportBatch
  >();
  private readonly canonicalHeaderSessions = new Map<
    string,
    Promise<CanonicalHeaderProof>
  >();
  private canonicalHeaderSessionScope: string | null = null;
  private readonly canonicalActivitySessions = new Map<
    string,
    Promise<CanonicalBlockActivity>
  >();
  private canonicalActivitySessionScope: string | null = null;
  private nextId = 1;

  constructor(
    private readonly rpcUrl: string,
    options: JsonRpcBlockScanStateReadBackendOptions = {},
  ) {
    const maxBatchSize = options.maxBatchSize ?? 500;
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize <= 0) {
      throw new Error(`invalid block-scan state RPC batch size ${maxBatchSize}`);
    }
    this.maxBatchSize = maxBatchSize;
    const maxConcurrentBatches = options.maxConcurrentBatches ?? 4;
    if (
      !Number.isSafeInteger(maxConcurrentBatches) ||
      maxConcurrentBatches <= 0
    ) {
      throw new Error(
        `invalid block-scan state RPC batch concurrency ${maxConcurrentBatches}`,
      );
    }
    this.maxConcurrentBatches = maxConcurrentBatches;
    this.multicallMode = options.multicallMode ?? "rpc-batch";
    this.mutationHeaderMode = options.mutationHeaderMode ?? "eth-block";
    this.rpcSlots = new AbortableSemaphore(maxConcurrentBatches);
    const maxConcurrentMutationProofs =
      options.maxConcurrentMutationProofs ?? 1;
    if (
      !Number.isSafeInteger(maxConcurrentMutationProofs) ||
      maxConcurrentMutationProofs <= 0
    ) {
      throw new Error(
        `invalid mutation proof concurrency ${maxConcurrentMutationProofs}`,
      );
    }
    this.mutationHeaderSlots = new AbortableSemaphore(1);
    this.mutationDescriptorSlots = new AbortableSemaphore(
      maxConcurrentMutationProofs,
    );
    this.mutationFinalCasSlots = new AbortableSemaphore(1);
    this.addressTouchSlots = new AbortableSemaphore(1);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.hardRequestTimeoutMs = Math.max(
      1_000,
      options.hardRequestTimeoutMs ?? 45_000,
    );
    this.onMutationProofTelemetry = options.onMutationProofTelemetry;
    this.mutationReadPriority = options.mutationReadPriority;
    this.now = options.now ?? (() => performance.now());
    this.transportScheduler = options.transportScheduler;
    this.transportLane = options.transportLane ?? "producer-bulk";
  }

  async readBatch(
    _lane: BlockScanPricingLane,
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<readonly StateReadResult[]> {
    /*
     * Pricing publication owns the generation-wide canonical CAS. Every call
     * below is still pinned with EIP-1898 blockHash + requireCanonical; repeating
     * number->hash header reads around every family batch only serializes the
     * shared RPC queue without strengthening the final publication boundary.
     */
    try {
      return await this.stateTransportPriority.runBackground(
        (signal) => this.readAtPinnedHash(
          reads,
          { ...control, signal },
          false,
        ),
        control.signal,
      );
    } catch (error) {
      // Preserve the StateReadBackend contract: caller cancellation is a
      // per-read failure, not a transport exception. Local priority
      // preemption is handled internally by runBackground() and retries only
      // after the canonical mutation proof releases its foreground lease.
      const kind = failureKind(error, control);
      const message = formatError(error);
      return Object.freeze(reads.map((read): StateReadFailure => Object.freeze({
        id: read.id,
        ok: false,
        sourceBlock: control.sourceBlock,
        sourceBlockHash: control.sourceBlockHash,
        kind,
        error: message,
      })));
    }
  }

  async readPinned(
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<readonly StateReadResult[]> {
    /*
     * Standalone consumers such as funding do not own the pricing
     * coordinator's publish-time CAS, so preserve their pre/post canonical
     * fence exactly.
     */
    return this.readAtPinnedHash(reads, control, true);
  }

  async readCanonicalAddressTouches(
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<CanonicalAddressTouchRange> {
    /*
     * Address-touch completeness is a prerequisite for deciding which
     * protocol states may be carried. Give it the same transport priority as
     * canonical swap-mutation proofs: otherwise bulk current-state reads can
     * saturate reth first, the touch proof times out, and the protocol lane
     * pays both the failed proof and the full fallback scan.
     */
    const activity = await awaitWithSignal(
      this.readSharedCanonicalActivity(fromExclusive, through, control),
      control.signal,
    );
    return Object.freeze({
      fromExclusive: activity.fromExclusive,
      through: activity.through,
      touchedAddresses: activity.touchedAddresses,
      transactionCount: activity.transactionCount,
      complete: true as const,
      rangeFingerprint: activity.rangeFingerprint,
    });
  }

  /**
   * Unified canonical block activity for one forward range: receipts, all
   * logs, touched addresses and the canonical range fingerprint. One call
   * feeds the global dirty/carry partition for both lanes (the same sessioned
   * reader the address-touch proof uses); no per-family topic scan is needed.
   */
  async readCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
      /**
       * Max forward distance for one activity read. Defaults to 8 (the
       * address-touch bound); the unified refresh plan passes the
       * coordinator's incremental range window so a lagging producer can
       * still prove a multi-block gap and carry instead of degrading to a
       * full-graph direct read (which could never catch up).
       */
      readonly maxRangeBlocks?: number;
    },
  ): Promise<CanonicalBlockActivity> {
    return await awaitWithSignal(
      this.readSharedCanonicalActivity(fromExclusive, through, control),
      control.signal,
    );
  }

  private readSharedCanonicalActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
      readonly maxRangeBlocks?: number;
    },
  ): Promise<CanonicalBlockActivity> {
    const scope = canonicalActivitySessionScope(through);
    if (this.canonicalActivitySessionScope !== scope) {
      this.canonicalActivitySessions.clear();
      this.canonicalActivitySessionScope = scope;
    }
    const key = canonicalHeaderSessionKey(fromExclusive, through);
    let session = this.canonicalActivitySessions.get(key);
    if (!session) {
      const created = this.runMutationCritical(
        (signal) =>
          this.computeCanonicalBlockActivity(fromExclusive, through, {
            deadlineAtMs: control.deadlineAtMs,
            signal,
            maxRangeBlocks: control.maxRangeBlocks,
          }),
        control,
      );
      session = created.catch((error) => {
        if (this.canonicalActivitySessions.get(key) === session) {
          this.canonicalActivitySessions.delete(key);
        }
        throw error;
      });
      this.canonicalActivitySessions.set(key, session);
    }
    return session;
  }

  private canonicalActivitySession(
    fromExclusive: BlockSource,
    through: BlockSource,
  ): Promise<CanonicalBlockActivity> | undefined {
    if (
      this.canonicalActivitySessionScope !==
        canonicalActivitySessionScope(through)
    ) {
      return undefined;
    }
    return this.canonicalActivitySessions.get(
      canonicalHeaderSessionKey(fromExclusive, through),
    );
  }

  private async computeCanonicalBlockActivity(
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
      readonly maxRangeBlocks?: number;
    },
  ): Promise<CanonicalBlockActivity> {
    const startedAtMs = Date.now();
    const distance = through.number - fromExclusive.number;
    const maxRangeBlocks = Math.max(1, control.maxRangeBlocks ?? 8);
    if (
      distance <= 0 ||
      distance > maxRangeBlocks ||
      through.generation <= fromExclusive.generation
    ) {
      throw new Error(
        `address-touch proof requires 1..${maxRangeBlocks} forward canonical blocks`,
      );
    }
    const controller = new AbortController();
    const detach = linkAbort(control.signal, controller);
    const remainingMs = control.deadlineAtMs - Date.now();
    const timer = setTimeout(
      () => controller.abort(new Error("address-touch proof deadline reached")),
      Math.max(0, remainingMs),
    );
    try {
      if (remainingMs <= 0) {
        controller.abort(new Error("address-touch proof deadline reached"));
      }
      const headerStartedAtMs = Date.now();
      const headerProof = await this.readSharedCanonicalHeaders(
        fromExclusive,
        through,
        {
          deadlineAtMs: control.deadlineAtMs,
          signal: controller.signal,
        },
      );
      const headerMs = Math.max(0, Date.now() - headerStartedAtMs);
      const receiptHeaders = headerProof.headers.slice(1);
      const receiptIds = receiptHeaders.map(() => this.nextId++);
      const receiptsRpcStartedAtMs = Date.now();
      const receiptResponses = await this.postWithSlots(
        this.addressTouchSlots,
        receiptIds.map((id, index) => ({
          jsonrpc: "2.0",
          id,
          method: "eth_getBlockReceipts",
          // Reth accepts an exact block hash here. This keeps an empty receipt
          // set bound to the header proof instead of relying on a number-range
          // query that could race a short reorg.
          params: [receiptHeaders[index].hash],
        })),
        controller.signal,
        "producer-critical",
      );
      const receiptsRpcMs = Math.max(
        0,
        Date.now() - receiptsRpcStartedAtMs,
      );
      const parseStartedAtMs = Date.now();
      const receipts = parseCanonicalBlockReceipts(
        receiptResponses,
        receiptIds,
        receiptHeaders,
        fromExclusive,
        through,
      );
      const headerByNumber = new Map(
        receiptHeaders.map((header) => [header.number, header]),
      );
      let rawLogIndex = 0;
      const logs = receipts.flatMap((blockReceipts) =>
        blockReceipts.receipts.flatMap((receipt) =>
          receipt.logs.map((value) => {
            const log = parseChainLog(
              value,
              rawLogIndex++,
              fromExclusive,
              through,
              headerByNumber,
            );
            if (
              log.blockNumber !== blockReceipts.number ||
              log.blockHash !== blockReceipts.hash
            ) {
              throw new Error(
                `block receipt returned log outside ` +
                  `${blockReceipts.number}/${blockReceipts.hash}`,
              );
            }
            if (
              log.transactionIndex !== receipt.transactionIndex ||
              parseHash(
                (value as Record<string, unknown>).transactionHash,
                `block receipt log ${rawLogIndex - 1} transactionHash`,
              ) !== receipt.transactionHash
            ) {
              throw new Error(
                "block receipt log does not match its transaction",
              );
            }
            return log;
          })
        )
      ).sort((left, right) =>
        left.blockNumber - right.blockNumber ||
        left.transactionIndex - right.transactionIndex ||
        left.logIndex - right.logIndex
      );
      for (let index = 1; index < logs.length; index++) {
        const previous = logs[index - 1];
        const current = logs[index];
        if (
          previous.blockNumber === current.blockNumber &&
          previous.transactionIndex === current.transactionIndex &&
          previous.logIndex === current.logIndex
        ) {
          throw new Error("address-touch activity logs contain a duplicate");
        }
      }
      const touched = new Set(
        receipts.flatMap((block) =>
          block.receipts.flatMap((receipt) =>
            receipt.directTarget === null ? [] : [receipt.directTarget]
          )
        ),
      );
      for (const log of logs) touched.add(log.address);
      const touchedAddresses = Object.freeze([...touched].sort());
      const transactionCount = receipts.reduce(
        (sum, block) => sum + block.receipts.length,
        0,
      );
      const parseMs = Math.max(0, Date.now() - parseStartedAtMs);
      const verifyStartedAtMs = Date.now();
      await this.verifyCanonicalSourceWithSlotsMeasured(
        through,
        controller.signal,
        this.addressTouchSlots,
      );
      const verifyMs = Math.max(0, Date.now() - verifyStartedAtMs);
      const fingerprintStartedAtMs = Date.now();
      const rangeFingerprint = deterministicHash({
        fromExclusive,
        through,
        receipts,
        logs,
        touchedAddresses,
      });
      const fingerprintMs = Math.max(
        0,
        Date.now() - fingerprintStartedAtMs,
      );
      const totalMs = Math.max(0, Date.now() - startedAtMs);
      console.log(
        `[searcher/blockscan-activity] ${JSON.stringify({
          throughBlock: through.number,
          generation: through.generation,
          rangeBlocks: distance,
          maxRangeBlocks,
          headerMs: Math.round(headerMs),
          receiptsRpcMs: Math.round(receiptsRpcMs),
          parseMs: Math.round(parseMs),
          verifyMs: Math.round(verifyMs),
          fingerprintMs: Math.round(fingerprintMs),
          totalMs: Math.round(totalMs),
          receiptCount: receipts.reduce(
            (sum, block) => sum + block.receipts.length,
            0,
          ),
          logCount: logs.length,
          touchedCount: touchedAddresses.length,
          transactionCount,
        })}`,
      );
      return Object.freeze({
        fromExclusive,
        through,
        canonicalBlocks: Object.freeze(
          headerProof.headers.map((header) => Object.freeze({
            number: header.number,
            hash: header.hash,
          })),
        ),
        events: Object.freeze(logs),
        touchedAddresses,
        transactionCount,
        canonicalPathFingerprint: headerProof.canonicalPathFingerprint,
        rangeFingerprint,
      });
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  private async readAtPinnedHash(
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
    selfFenceCanonicality: boolean,
  ): Promise<readonly StateReadResult[]> {
    if (reads.length === 0) return Object.freeze([]);
    const controller = new AbortController();
    const detach = linkAbort(control.signal, controller);
    const remainingMs = control.deadlineAtMs - Date.now();
    const timer = setTimeout(
      () => controller.abort(new Error("block-scan state read deadline reached")),
      Math.max(0, remainingMs),
    );
    try {
      if (remainingMs <= 0) controller.abort(new Error("deadline reached"));
      assertPinnedReadSet(reads, control);
      if (selfFenceCanonicality) {
        await this.verifyCanonicalSource(
          sourceFrom(control),
          controller.signal,
          this.transportLane,
        );
      }
      const results: Array<StateReadResult | undefined> =
        Array.from({ length: reads.length });
      const multicallReads: IndexedStateRead[] = [];
      const rpcReads: IndexedStateRead[] = [];
      for (let index = 0; index < reads.length; index++) {
        const read = reads[index];
        if (
          read.transport !== "multicall-safe" ||
          this.multicallMode === "rpc-batch"
        ) {
          rpcReads.push({ index, read });
          continue;
        }
        const unsupported = invalidMulticallRead(read, control);
        if (unsupported) {
          results[index] = unsupported;
          continue;
        }
        multicallReads.push({ index, read });
      }
      const tasks: Array<() => Promise<void>> = [];
      for (let offset = 0; offset < multicallReads.length; offset += this.maxBatchSize) {
        const chunk = multicallReads.slice(offset, offset + this.maxBatchSize);
        tasks.push(async () => {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("state read aborted");
          }
          const chunkResults = await this.readMulticallChunkWithPinnedFallback(
            chunk.map((item) => item.read),
            control,
            controller.signal,
          );
          for (let index = 0; index < chunk.length; index++) {
            results[chunk[index].index] = chunkResults[index];
          }
        });
      }
      for (let offset = 0; offset < rpcReads.length; offset += this.maxBatchSize) {
        const chunk = rpcReads.slice(offset, offset + this.maxBatchSize);
        tasks.push(async () => {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("state read aborted");
          }
          const chunkResults = await this.readRpcChunk(
            chunk.map((item) => item.read),
            control,
            controller.signal,
          );
          for (let index = 0; index < chunk.length; index++) {
            results[chunk[index].index] = chunkResults[index];
          }
        });
      }
      await runWithConcurrency(
        tasks,
        this.maxConcurrentBatches,
        (error) => {
          if (!controller.signal.aborted) controller.abort(error);
        },
      );
      if (selfFenceCanonicality) {
        await this.verifyCanonicalSource(
          sourceFrom(control),
          controller.signal,
          this.transportLane,
        );
      }
      if (results.some((result) => result === undefined)) {
        throw new Error("block-scan state backend omitted a read result");
      }
      return Object.freeze(results as StateReadResult[]);
    } catch (error) {
      const kind = failureKind(error, control);
      const message = formatError(error);
      return Object.freeze(reads.map((read): StateReadFailure => Object.freeze({
        id: read.id,
        ok: false,
        sourceBlock: control.sourceBlock,
        sourceBlockHash: control.sourceBlockHash,
        kind,
        error: message,
      })));
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  /**
   * Publish-time CAS hook shared with the coordinator. EIP-1898 proves where
   * each call executed; this second check proves the requested hash is still
   * canonical when a staged family result is about to publish.
   */
  async verifyCanonicalSource(
    source: BlockSource,
    signal: AbortSignal,
    lane: RethTransportLane = "producer-critical",
  ): Promise<void> {
    return this.verifyCanonicalSourceWithSlots(
      source,
      signal,
      this.rpcSlots,
      lane,
    );
  }

  private async verifyCanonicalSourceWithSlots(
    source: BlockSource,
    signal: AbortSignal,
    slots: AbortableSemaphore,
    lane: RethTransportLane = "producer-critical",
  ): Promise<void> {
    const id = this.nextId++;
    const response = await this.postWithSlots(slots, [{
      jsonrpc: "2.0",
      id,
      method: "eth_getBlockByNumber",
      params: [toBlockTag(source.number), false],
    }], signal, lane);
    const item = response[0];
    if (!item || "error" in item) {
      throw new Error(
        `cannot verify source block: ${item && "error" in item
          ? item.error.message ?? item.error.code ?? "RPC error"
          : "missing RPC response"}`,
      );
    }
    const block = item.result as { readonly hash?: unknown } | null;
    const hash = typeof block?.hash === "string" ? block.hash.toLowerCase() : null;
    if (hash !== source.hash.toLowerCase()) {
      throw new Error(
        `source block hash mismatch: expected ${source.hash}, got ${hash ?? "null"}`,
      );
    }
  }

  /**
   * Startup capability probe. A number/hash comparison alone does not prove
   * that eth_call accepts EIP-1898. Execute one harmless, stateless Identity
   * precompile call with the exact canonical-hash object and fail startup if
   * the node rejects it. A zero/no-code account would force a lazy historical
   * fork to fetch arbitrary account state merely to run this capability probe.
   */
  async probeEip1898(
    source: BlockSource,
    signal: AbortSignal,
  ): Promise<void> {
    await this.verifyCanonicalSource(source, signal);
    const id = this.nextId++;
    const responses = await this.post([{
      jsonrpc: "2.0",
      id,
      method: "eth_call",
      params: [
        {
          to: "0x0000000000000000000000000000000000000004",
          data: "0x",
        },
        eip1898BlockSpecifier(source.hash),
      ],
    }], signal);
    const response = responses.find((item) => item.id === id);
    if (!response) {
      throw new Error("EIP-1898 startup probe returned no response");
    }
    if ("error" in response) {
      throw new Error(
        `EIP-1898 startup probe failed: ` +
          `${response.error.message ??
            response.error.code ??
            "RPC error"}`,
      );
    }
    if (typeof response.result !== "string") {
      throw new Error(
        "EIP-1898 startup probe returned non-string eth_call data",
      );
    }
    await this.verifyCanonicalSource(source, signal);
  }

  async readCanonicalMutationRange(
    descriptor: MutationQueryDescriptor,
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
      readonly sharedSignal?: AbortSignal;
    },
  ): Promise<CanonicalMutationRange> {
    if (control.signal.aborted) {
      throw control.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (
      descriptor.fingerprint !==
      mutationQueryDescriptorFingerprint(descriptor)
    ) {
      throw new MutationRangeReadError(
        "descriptor-validation",
        "validation",
        "mutation descriptor fingerprint mismatch",
      );
    }
    const sessionKey = mutationRangeSessionKey(
      descriptor,
      fromExclusive,
      through,
    );
    let session = this.mutationRangeSessions.get(sessionKey);
    if (!session) {
      const ownerSignal = control.sharedSignal ?? control.signal;
      const activitySession = this.canonicalActivitySession(
        fromExclusive,
        through,
      );
      const fallback = () =>
        control.sharedSignal
          ? this.enqueueSharedMutationTransport(
              descriptor,
              fromExclusive,
              through,
              {
                deadlineAtMs: control.deadlineAtMs,
                signal: ownerSignal,
              },
            )
          : this.runMutationCritical(
              (signal) =>
                this.computeCanonicalMutationRange(
                  descriptor,
                  fromExclusive,
                  through,
                  {
                    deadlineAtMs: control.deadlineAtMs,
                    signal,
                  },
                ),
              {
                deadlineAtMs: control.deadlineAtMs,
                signal: ownerSignal,
              },
            );
      const created = activitySession
        ? this.readMutationRangeFromActivityOrFallback(
            activitySession,
            descriptor,
            fromExclusive,
            through,
            ownerSignal,
            fallback,
          )
        : fallback();
      session = created.finally(() => {
        if (this.mutationRangeSessions.get(sessionKey) === session) {
          this.mutationRangeSessions.delete(sessionKey);
        }
      });
      this.mutationRangeSessions.set(sessionKey, session);
    }
    return await awaitWithSignal(session, control.signal);
  }

  private async readMutationRangeFromActivityOrFallback(
    session: Promise<CanonicalBlockActivity>,
    descriptor: MutationQueryDescriptor,
    fromExclusive: BlockSource,
    through: BlockSource,
    signal: AbortSignal,
    fallback: () => Promise<CanonicalMutationRange>,
  ): Promise<CanonicalMutationRange> {
    const startedAtMs = this.now();
    let activity: CanonicalBlockActivity;
    try {
      activity = await awaitWithSignal(session, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return await fallback();
    }
    const validationStartedAtMs = this.now();
    const matchingEvents = Object.freeze(activity.events.filter((event) =>
      mutationLogMatchesDescriptor(event, descriptor)
    ));
    const range: CanonicalMutationRange = Object.freeze({
      fromExclusive,
      through,
      events: matchingEvents,
      complete: true as const,
      queryDescriptorFingerprint: descriptor.fingerprint,
      canonicalPathFingerprint: activity.canonicalPathFingerprint,
      rangeFingerprint: deterministicHash({
        fromExclusive,
        through,
        queryDescriptorFingerprint: descriptor.fingerprint,
        canonicalPathFingerprint: activity.canonicalPathFingerprint,
        events: matchingEvents,
      }),
    });
    const validationMs = Math.max(0, this.now() - validationStartedAtMs);
    try {
      this.onMutationProofTelemetry?.(Object.freeze({
        descriptorFingerprint: descriptor.fingerprint,
        fromBlock: fromExclusive.number,
        throughBlock: through.number,
        status: "complete" as const,
        wallMs: Math.max(0, this.now() - startedAtMs),
        validationMs,
        phases: Object.freeze({
          headers: sharedActivityPhase(),
          logs: sharedActivityPhase(),
          finalCas: sharedActivityPhase(),
        }),
      }));
    } catch {
      // Observability must never change proof transport behavior.
    }
    return range;
  }

  private enqueueSharedMutationTransport(
    descriptor: MutationQueryDescriptor,
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<CanonicalMutationRange> {
    const key = canonicalHeaderSessionKey(fromExclusive, through);
    let batch = this.pendingMutationTransportBatches.get(key);
    if (
      !batch ||
      batch.started ||
      batch.deadlineAtMs !== control.deadlineAtMs ||
      batch.sharedSignal !== control.signal
    ) {
      let resolve!: PendingMutationTransportBatch["resolve"];
      let reject!: PendingMutationTransportBatch["reject"];
      const completion = new Promise<
        ReadonlyMap<string, CanonicalMutationRange>
      >((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      batch = {
        key,
        fromExclusive,
        through,
        deadlineAtMs: control.deadlineAtMs,
        sharedSignal: control.signal,
        descriptors: new Map(),
        completion,
        resolve,
        reject,
        started: false,
      };
      this.pendingMutationTransportBatches.set(key, batch);
      queueMicrotask(() => {
        void this.flushSharedMutationTransport(batch!);
      });
    }
    batch.descriptors.set(descriptor.fingerprint, descriptor);
    return batch.completion.then((ranges) => {
      const range = ranges.get(descriptor.fingerprint);
      if (!range) {
        throw new Error(
          `shared mutation transport omitted ${descriptor.fingerprint}`,
        );
      }
      return range;
    });
  }

  private async flushSharedMutationTransport(
    batch: PendingMutationTransportBatch,
  ): Promise<void> {
    batch.started = true;
    try {
      batch.resolve(await this.runMutationCritical(
        (signal) =>
          this.computeCanonicalMutationRanges(
            [...batch.descriptors.values()],
            batch.fromExclusive,
            batch.through,
            {
              deadlineAtMs: batch.deadlineAtMs,
              signal,
            },
          ),
        {
          deadlineAtMs: batch.deadlineAtMs,
          signal: batch.sharedSignal,
        },
      ));
    } catch (error) {
      batch.reject(error);
    } finally {
      if (this.pendingMutationTransportBatches.get(batch.key) === batch) {
        this.pendingMutationTransportBatches.delete(batch.key);
      }
    }
  }

  private async runMutationCritical<T>(
    work: (signal: AbortSignal) => Promise<T>,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<T> {
    if (control.signal.aborted) {
      throw control.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const remainingMs = control.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error("mutation priority deadline reached");
    }
    const controller = new AbortController();
    const detach = linkAbort(control.signal, controller);
    const timer = setTimeout(
      () => controller.abort(new Error("mutation priority deadline reached")),
      remainingMs,
    );
    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason ??
          new DOMException("Aborted", "AbortError");
      }
      return await this.stateTransportPriority.runForeground(() =>
        this.mutationReadPriority?.runCritical(
          () => work(controller.signal),
          controller.signal,
        ) ?? work(controller.signal)
      );
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  private async computeCanonicalMutationRange(
    descriptor: MutationQueryDescriptor,
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<CanonicalMutationRange> {
    const ranges = await this.computeCanonicalMutationRanges(
      [descriptor],
      fromExclusive,
      through,
      control,
    );
    const range = ranges.get(descriptor.fingerprint);
    if (!range) {
      throw new Error(`mutation range omitted ${descriptor.fingerprint}`);
    }
    return range;
  }

  private async computeCanonicalMutationRanges(
    descriptors: readonly MutationQueryDescriptor[],
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<ReadonlyMap<string, CanonicalMutationRange>> {
    if (descriptors.length === 0) {
      throw new Error("mutation transport batch is empty");
    }
    const startedAtMs = this.now();
    let phase: MutationProofTransportPhase = "descriptor-validation";
    let validationMs = 0;
    let headerTelemetry = emptyMutationProofPhaseTelemetry();
    let logTelemetry = emptyMutationProofPhaseTelemetry();
    let finalCasTelemetry = emptyMutationProofPhaseTelemetry();
    if (
      fromExclusive.number >= through.number ||
      fromExclusive.generation >= through.generation
    ) {
      throw new Error(
        `non-forward mutation range ${fromExclusive.number}/${fromExclusive.generation}` +
          ` -> ${through.number}/${through.generation}`,
      );
    }
    for (const descriptor of descriptors) {
      if (
        descriptor.fingerprint !==
        mutationQueryDescriptorFingerprint(descriptor)
      ) {
        throw new Error("mutation descriptor fingerprint mismatch");
      }
    }
    const transportDescriptor = mergeMutationQueryDescriptors(descriptors);
    const controller = new AbortController();
    const detach = linkAbort(control.signal, controller);
    const remainingMs = control.deadlineAtMs - Date.now();
    const timer = setTimeout(
      () => controller.abort(new Error("mutation range deadline reached")),
      Math.max(0, remainingMs),
    );
    let completed = false;
    let failure:
      | {
          readonly phase: MutationProofTransportPhase;
          readonly kind: MutationProofFailureKind;
        }
      | undefined;
    try {
      if (remainingMs <= 0) {
        controller.abort(new Error("mutation range deadline reached"));
      }
      phase = "header-read";
      const headerProof = await this.readSharedCanonicalHeaders(
        fromExclusive,
        through,
        {
          deadlineAtMs: control.deadlineAtMs,
          signal: controller.signal,
        },
      );
      const headers = headerProof.headers;
      headerTelemetry = headerProof.telemetry;
      validationMs += headerProof.validationMs;

      /*
       * A block-number log range can race a short reorg: an empty result from
       * the old chain has no log blockHash to compare with headers from the
       * replacement chain. Prove the header path first, then bind every log
       * query to that exact path with EIP-234 blockHash filters. The calls are
       * still one JSON-RPC batch, so correctness does not add one round trip
       * per block.
       */
      phase = "log-read";
      const logHeaders = headers.slice(1);
      const logIds = logHeaders.map(() => this.nextId++);
      const logRead = await this.postWithSlotsMeasured(
        this.mutationDescriptorSlots,
        logIds.map((id, index) => ({
          jsonrpc: "2.0",
          id,
          method: "eth_getLogs",
          params: [{
            blockHash: logHeaders[index].hash,
            ...(transportDescriptor.addresses.length === 0
              ? {}
              : {
                  address: transportDescriptor.addresses.length === 1
                    ? transportDescriptor.addresses[0]
                    : transportDescriptor.addresses,
                }),
            topics: transportDescriptor.topics,
          }],
        })),
        controller.signal,
      );
      logTelemetry = logRead.telemetry;
      const logResponses = logRead.responses;
      phase = "log-validation";
      const logValidationStartedAtMs = this.now();
      const expectedLogIds = new Set(logIds);
      const seenLogIds = new Set<number>();
      for (const response of logResponses) {
        if (!expectedLogIds.has(response.id)) {
          throw new Error(
            `eth_getLogs returned unexpected RPC response id ${response.id}`,
          );
        }
        if (seenLogIds.has(response.id)) {
          throw new Error(
            `eth_getLogs returned duplicate RPC response id ${response.id}`,
          );
        }
        seenLogIds.add(response.id);
      }
      if (seenLogIds.size !== expectedLogIds.size) {
        throw new Error("eth_getLogs omitted an RPC response id");
      }
      const headerByNumber = new Map(
        headers.map((header) => [header.number, header]),
      );
      let rawLogIndex = 0;
      const events = logIds
        .flatMap((id, headerIndex) => {
          const logResponse = logResponses.find((candidate) =>
            candidate.id === id
          );
          if (!logResponse || "error" in logResponse) {
            throw new Error(
              `cannot read complete mutation logs for block ${
                logHeaders[headerIndex].number
              }: ${
                logResponse && "error" in logResponse
                  ? logResponse.error.message ??
                    logResponse.error.code ??
                    "RPC error"
                  : "missing RPC response"
              }`,
            );
          }
          if (!Array.isArray(logResponse.result)) {
            throw new Error("eth_getLogs returned a non-array result");
          }
          const expectedHeader = logHeaders[headerIndex];
          return (logResponse.result as readonly unknown[]).map((value) => {
            const event = parseChainLog(
              value,
              rawLogIndex++,
              fromExclusive,
              through,
              headerByNumber,
            );
            if (
              event.blockNumber !== expectedHeader.number ||
              event.blockHash !== expectedHeader.hash
            ) {
              throw new Error(
                `EIP-234 mutation log response crossed block ${
                  expectedHeader.number
                }`,
              );
            }
            return event;
          });
        })
        .sort((a, b) =>
          a.blockNumber - b.blockNumber ||
          a.transactionIndex - b.transactionIndex ||
          a.logIndex - b.logIndex
        );
      for (let index = 1; index < events.length; index++) {
        const previous = events[index - 1];
        const current = events[index];
        if (
          previous.blockNumber === current.blockNumber &&
          previous.transactionIndex === current.transactionIndex &&
          previous.logIndex === current.logIndex
        ) {
          throw new Error("eth_getLogs returned duplicate canonical log identity");
        }
      }
      validationMs += Math.max(0, this.now() - logValidationStartedAtMs);
      phase = "final-cas";
      finalCasTelemetry = await this.verifyCanonicalSourceWithSlotsMeasured(
        through,
        controller.signal,
        this.mutationFinalCasSlots,
      );
      const canonicalPathFingerprint = headerProof.canonicalPathFingerprint;
      const ranges = new Map<string, CanonicalMutationRange>();
      for (const descriptor of descriptors) {
        const matchingEvents = Object.freeze(events.filter((event) =>
          mutationLogMatchesDescriptor(event, descriptor)
        ));
        const rangeFingerprint = deterministicHash({
          fromExclusive,
          through,
          queryDescriptorFingerprint: descriptor.fingerprint,
          canonicalPathFingerprint,
          events: matchingEvents,
        });
        ranges.set(descriptor.fingerprint, Object.freeze({
          fromExclusive,
          through,
          events: matchingEvents,
          complete: true as const,
          queryDescriptorFingerprint: descriptor.fingerprint,
          canonicalPathFingerprint,
          rangeFingerprint,
        }));
      }
      completed = true;
      return ranges;
    } catch (error) {
      if (error instanceof MutationRangeReadError) {
        failure = { phase: error.phase, kind: error.kind };
        throw error;
      }
      const classified = classifyMutationProofFailure(
        error,
        controller.signal,
        phase,
      );
      failure = { phase, kind: classified };
      throw new MutationRangeReadError(
        phase,
        classified,
        formatError(error),
        error,
      );
    } finally {
      clearTimeout(timer);
      detach();
      const wallMs = Math.max(0, this.now() - startedAtMs);
      for (let index = 0; index < descriptors.length; index++) {
        const descriptor = descriptors[index];
        const shared = index > 0;
        const telemetry = Object.freeze({
          descriptorFingerprint: descriptor.fingerprint,
          fromBlock: fromExclusive.number,
          throughBlock: through.number,
          status: completed ? "complete" as const : "failed" as const,
          ...(failure === undefined
            ? {}
            : {
                failurePhase: failure.phase,
                failureKind: failure.kind,
              }),
          wallMs,
          validationMs: shared ? 0 : validationMs,
          phases: Object.freeze({
            headers: sharedMutationPhase(headerTelemetry, shared),
            logs: sharedMutationPhase(logTelemetry, shared),
            finalCas: sharedMutationPhase(finalCasTelemetry, shared),
          }),
        });
        try {
          this.onMutationProofTelemetry?.(telemetry);
        } catch {
          // Observability must never change proof transport behavior.
        }
      }
    }
  }

  private async readSharedCanonicalHeaders(
    fromExclusive: BlockSource,
    through: BlockSource,
    control: {
      readonly deadlineAtMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<CanonicalHeaderProof> {
    const scope = [
      through.number,
      through.hash.toLowerCase(),
      through.generation,
    ].join("\u001f");
    if (this.canonicalHeaderSessionScope !== scope) {
      this.canonicalHeaderSessions.clear();
      this.canonicalHeaderSessionScope = scope;
    }
    const key = canonicalHeaderSessionKey(fromExclusive, through);
    let session = this.canonicalHeaderSessions.get(key);
    let shared = true;
    if (!session) {
      shared = false;
      const created = this.readCanonicalHeaders(
        fromExclusive,
        through,
        control.signal,
      );
      session = created.catch((error) => {
        if (this.canonicalHeaderSessions.get(key) === session) {
          this.canonicalHeaderSessions.delete(key);
        }
        throw error;
      });
      this.canonicalHeaderSessions.set(key, session);
    }
    const sharedWaitStartedAtMs = this.now();
    const proof = await awaitWithSignal(session, control.signal);
    if (!shared) return proof;
    return Object.freeze({
      ...proof,
      telemetry: Object.freeze({
        ...emptyMutationProofPhaseTelemetry(),
        wallMs: Math.max(0, this.now() - sharedWaitStartedAtMs),
        shared: true,
        ...(proof.telemetry.transport === undefined
          ? {}
          : { transport: proof.telemetry.transport }),
      }),
      validationMs: 0,
    });
  }

  private async readCanonicalHeaders(
    fromExclusive: BlockSource,
    through: BlockSource,
    signal: AbortSignal,
  ): Promise<CanonicalHeaderProof> {
    let phase: MutationProofTransportPhase = "header-read";
    try {
      const headerRead = await this.readCanonicalHeaderBatch(
        fromExclusive.number,
        through.number,
        signal,
      );
      phase = "header-validation";
      const validationStartedAtMs = this.now();
      const headers = headerRead.items.map((item, index) => {
        if (item.number !== fromExclusive.number + index) {
          throw new Error(
            `mutation header number mismatch ${item.number} != ${
              fromExclusive.number + index
            }`,
          );
        }
        return item;
      });
      if (headers[0]?.hash !== fromExclusive.hash.toLowerCase()) {
        throw new Error(
          "mutation range previous source is no longer canonical",
        );
      }
      if (headers.at(-1)?.hash !== through.hash.toLowerCase()) {
        throw new Error(
          "mutation range through source is no longer canonical",
        );
      }
      for (let index = 1; index < headers.length; index++) {
        if (headers[index].parentHash !== headers[index - 1].hash) {
          throw new Error(
            `mutation range canonical path discontinuity at ${
              headers[index].number
            }`,
          );
        }
      }
      return Object.freeze({
        headers: Object.freeze(headers),
        canonicalPathFingerprint: deterministicHash(headers),
        telemetry: headerRead.telemetry,
        validationMs: Math.max(0, this.now() - validationStartedAtMs),
      });
    } catch (error) {
      if (error instanceof MutationRangeReadError) throw error;
      throw new MutationRangeReadError(
        phase,
        classifyMutationProofFailure(error, signal, phase),
        formatError(error),
        error,
      );
    }
  }

  private async readCanonicalHeaderBatch(
    fromBlock: number,
    throughBlock: number,
    signal: AbortSignal,
    slots: AbortableSemaphore = this.mutationHeaderSlots,
    lane: RethTransportLane = "producer-critical",
  ): Promise<{
    readonly items: readonly CanonicalMutationHeader[];
    readonly telemetry: MutationProofPhaseTelemetry;
  }> {
    const blockNumbers = Array.from(
      { length: throughBlock - fromBlock + 1 },
      (_value, index) => fromBlock + index,
    );
    if (this.mutationHeaderMode === "debug-raw-header-with-fallback") {
      const rawIds = blockNumbers.map(() => this.nextId++);
      const rawRead = await this.postWithSlotsMeasured(
        slots,
        rawIds.map((id, index) => ({
          jsonrpc: "2.0",
          id,
          method: "debug_getRawHeader",
          params: [toBlockTag(blockNumbers[index])],
        })),
        signal,
        lane,
      );
      const rawUnavailable =
        rawRead.responses.length === rawIds.length &&
        rawRead.responses.every(
          (response) =>
            "error" in response && isRawHeaderMethodUnavailable(response),
        );
      if (!rawUnavailable) {
        return Object.freeze({
          items: parseRawHeaderResponses(
            rawRead.responses,
            rawIds,
            blockNumbers,
          ),
          telemetry: Object.freeze({
            ...rawRead.telemetry,
            transport: "debug-raw-header" as const,
          }),
        });
      }
      const fallback = await this.readEthBlockHeaderBatch(
        blockNumbers,
        signal,
        slots,
        lane,
      );
      return Object.freeze({
        items: fallback.items,
        telemetry: combineMutationProofPhaseTelemetry(
          rawRead.telemetry,
          fallback.telemetry,
          "debug-raw-header+eth-block-fallback",
        ),
      });
    }
    return this.readEthBlockHeaderBatch(blockNumbers, signal, slots, lane);
  }

  private async readEthBlockHeaderBatch(
    blockNumbers: readonly number[],
    signal: AbortSignal,
    slots: AbortableSemaphore,
    lane: RethTransportLane = "producer-critical",
  ): Promise<{
    readonly items: readonly CanonicalMutationHeader[];
    readonly telemetry: MutationProofPhaseTelemetry;
  }> {
    const ids = blockNumbers.map(() => this.nextId++);
    const measured = await this.postWithSlotsMeasured(
      slots,
      ids.map((id, index) => ({
        jsonrpc: "2.0",
        id,
        method: "eth_getBlockByNumber",
        params: [toBlockTag(blockNumbers[index]), false],
      })),
      signal,
      lane,
    );
    return Object.freeze({
      items: parseEthBlockHeaderResponses(
        measured.responses,
        ids,
        blockNumbers,
      ),
      telemetry: Object.freeze({
        ...measured.telemetry,
        transport: "eth-block" as const,
      }),
    });
  }

  private async verifyCanonicalSourceWithSlotsMeasured(
    source: BlockSource,
    signal: AbortSignal,
    slots: AbortableSemaphore,
    lane: RethTransportLane = "producer-critical",
  ): Promise<MutationProofPhaseTelemetry> {
    if (this.mutationHeaderMode === "debug-raw-header-with-fallback") {
      const measured = await this.readCanonicalHeaderBatch(
        source.number,
        source.number,
        signal,
        slots,
        lane,
      );
      const item = measured.items[0];
      if (
        item?.number !== source.number ||
        item.hash !== source.hash.toLowerCase()
      ) {
        throw new Error(
          `source block hash mismatch: expected ${source.hash}, got ${
            item?.hash ?? "null"
          }`,
        );
      }
      return measured.telemetry;
    }
    const id = this.nextId++;
    const measured = await this.postWithSlotsMeasured(slots, [{
      jsonrpc: "2.0",
      id,
      method: "eth_getBlockByNumber",
      params: [toBlockTag(source.number), false],
    }], signal, lane);
    const response = measured.responses[0];
    if (!response || "error" in response) {
      throw new Error(
        `cannot verify source block: ${
          response && "error" in response
            ? response.error.message ?? response.error.code ?? "RPC error"
            : "missing RPC response"
        }`,
      );
    }
    const block = response.result as { readonly hash?: unknown } | null;
    const hash = typeof block?.hash === "string"
      ? block.hash.toLowerCase()
      : null;
    if (hash !== source.hash.toLowerCase()) {
      throw new Error(
        `source block hash mismatch: expected ${source.hash}, got ${hash ?? "null"}`,
      );
    }
    return Object.freeze({
      ...measured.telemetry,
      transport: "eth-block" as const,
    });
  }

  private async readMulticallChunk(
    reads: readonly StateRead[],
    control: PinnedReadControl,
    signal: AbortSignal,
  ): Promise<readonly StateReadResult[]> {
    const id = this.nextId++;
    const response = await this.post([{
      jsonrpc: "2.0",
      id,
      method: "eth_call",
      params: [
        {
          to: BLOCKSCAN_MULTICALL3,
          data: blockScanMulticallIface.encodeFunctionData("aggregate3", [
            reads.map((read) => ({
              target: read.to,
              allowFailure: true,
              callData: read.data,
            })),
          ]),
        },
        eip1898BlockSpecifier(control.sourceBlockHash),
      ],
    }], signal);
    const item = response.find((candidate) => candidate.id === id);
    if (!item) throw new Error("missing Multicall3 JSON-RPC response");
    if ("error" in item) {
      throw new Error(
        item.error.message ?? `Multicall3 JSON-RPC error ${item.error.code ?? "unknown"}`,
      );
    }
    if (typeof item.result !== "string") {
      throw new Error("Multicall3 eth_call returned a non-string result");
    }
    const decoded = blockScanMulticallIface.decodeFunctionResult(
      "aggregate3",
      item.result,
    )[0] as readonly { readonly success: boolean; readonly returnData: string }[];
    if (decoded.length !== reads.length) {
      throw new Error(
        `Multicall3 returned ${decoded.length}/${reads.length} subcall results`,
      );
    }
    return Object.freeze(reads.map((read, index): StateReadResult => {
      const result = decoded[index];
      if (!result?.success) {
        return readFailure(
          read,
          control,
          "rpc",
          "Multicall3 subcall failed",
        );
      }
      return readSuccess(read, control, String(result.returnData));
    }));
  }

  private async readMulticallChunkWithPinnedFallback(
    reads: readonly StateRead[],
    control: PinnedReadControl & { readonly deadlineAtMs: number },
    signal: AbortSignal,
  ): Promise<readonly StateReadResult[]> {
    try {
      return await this.readMulticallChunk(reads, control, signal);
    } catch (aggregateError) {
      if (signal.aborted || Date.now() >= control.deadlineAtMs) {
        throw aggregateError;
      }
      try {
        /*
         * Graph assets are untrusted contracts. One aggregate3 outer failure
         * must not erase every other successfully pinned chunk in the family.
         * Retry only this chunk as independent EIP-1898 eth_call requests.
         */
        return await this.readRpcChunk(reads, control, signal);
      } catch (fallbackError) {
        if (signal.aborted || Date.now() >= control.deadlineAtMs) {
          throw fallbackError;
        }
        const message =
          `Multicall3 chunk failed (${formatError(aggregateError)}); ` +
          `source-pinned RPC fallback failed (${formatError(fallbackError)})`;
        return Object.freeze(
          reads.map((read) =>
            readFailure(read, control, "rpc", message)
          ),
        );
      }
    }
  }

  private async readRpcChunk(
    reads: readonly StateRead[],
    control: PinnedReadControl,
    signal: AbortSignal,
  ): Promise<readonly StateReadResult[]> {
    const idToRead = new Map<number, StateRead>();
    const body = reads.map((read) => {
      const id = this.nextId++;
      idToRead.set(id, read);
      return stateReadRpcPayload(read, id, control.sourceBlockHash);
    });
    const responses = await this.post(body, signal);
    const byId = new Map(responses.map((response) => [response.id, response]));
    return Object.freeze([...idToRead.entries()].map(([id, read]): StateReadResult => {
      const response = byId.get(id);
      if (!response) {
        return readFailure(
          read,
          control,
          "rpc",
          "missing JSON-RPC batch response",
        );
      }
      if ("error" in response) {
        const revertData = read.acceptRevertData
          ? strictJsonRpcRevertData(response.error.data)
          : null;
        if (revertData !== null) {
          return readSuccess(read, control, revertData);
        }
        return readFailure(
          read,
          control,
          "rpc",
          response.error.message ??
            `JSON-RPC error ${response.error.code ?? "unknown"}`,
        );
      }
      const data = stateReadResultData(read, response.result);
      if (data === null) {
        return readFailure(
          read,
          control,
          "rpc",
          `${read.transport} returned an invalid result`,
        );
      }
      return readSuccess(read, control, data);
    }));
  }

  private async post(
    body: readonly object[],
    signal: AbortSignal,
  ): Promise<readonly JsonRpcResponse[]> {
    return this.postWithSlots(this.rpcSlots, body, signal);
  }

  /**
   * Bound the consumer wait for one HTTP request (fetch + body parse). This
   * never aborts or settles the underlying physical lifetime. Callers must
   * therefore run the physical promise inside the transport leases and race
   * only the separately returned logical promise.
   */
  private withHardRequestTimeout<T>(
    promise: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        reject(
          new Error(
            `reth RPC hard request timeout after ` +
              `${this.hardRequestTimeoutMs}ms`,
          ),
        );
      }, this.hardRequestTimeoutMs);
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private async postWithSlots(
    slots: AbortableSemaphore,
    body: readonly object[],
    signal: AbortSignal,
    lane: RethTransportLane = this.transportLane,
  ): Promise<readonly JsonRpcResponse[]> {
    let physicalStarted = false;
    let settleLogical!: (value: readonly JsonRpcResponse[]) => void;
    let rejectLogical!: (reason?: unknown) => void;
    const logical = new Promise<readonly JsonRpcResponse[]>((resolve, reject) => {
      settleLogical = resolve;
      rejectLogical = reject;
    });
    const physicalLifetime = slots.run(signal, async () => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const send = async (): Promise<readonly JsonRpcResponse[]> => {
        physicalStarted = true;
        const physical = (async (): Promise<readonly JsonRpcResponse[]> => {
          const response = await this.fetchImpl(this.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          });
          if (!response.ok) {
            throw new Error(
              `JSON-RPC HTTP ${response.status} ${response.statusText}`,
            );
          }
          const value: unknown = await response.json();
          if (!Array.isArray(value)) {
            throw new Error("JSON-RPC batch returned non-array");
          }
          return value as readonly JsonRpcResponse[];
        })();
        this.withHardRequestTimeout(physical, signal).then(
          settleLogical,
          rejectLogical,
        );
        return physical;
      };
      return this.transportScheduler
        ? this.transportScheduler.run(lane, signal, () => send())
        : send();
    });
    void physicalLifetime.catch((error) => {
      if (!physicalStarted) rejectLogical(error);
    });
    return logical;
  }

  private async postWithSlotsMeasured(
    slots: AbortableSemaphore,
    body: readonly object[],
    signal: AbortSignal,
    lane: RethTransportLane = "producer-critical",
  ): Promise<{
    readonly responses: readonly JsonRpcResponse[];
    readonly telemetry: MutationProofPhaseTelemetry;
  }> {
    const startedAtMs = this.now();
    let localQueueWaitMs = 0;
    let sharedQueueWaitMs = 0;
    let physicalStarted = false;
    let settleLogical!: (value: readonly JsonRpcResponse[]) => void;
    let rejectLogical!: (reason?: unknown) => void;
    const logical = new Promise<readonly JsonRpcResponse[]>((resolve, reject) => {
      settleLogical = resolve;
      rejectLogical = reject;
    });
    const physicalLifetime = slots.run(signal, async (waitMs) => {
      localQueueWaitMs = waitMs;
      const send = async (): Promise<readonly JsonRpcResponse[]> => {
        if (signal.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        physicalStarted = true;
        const physical = (async (): Promise<readonly JsonRpcResponse[]> => {
          const response = await this.fetchImpl(this.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          });
          if (!response.ok) {
            throw new Error(
              `JSON-RPC HTTP ${response.status} ${response.statusText}`,
            );
          }
          const value: unknown = await response.json();
          if (!Array.isArray(value)) {
            throw new Error("JSON-RPC batch returned non-array");
          }
          return value as readonly JsonRpcResponse[];
        })();
        this.withHardRequestTimeout(physical, signal).then(
          settleLogical,
          rejectLogical,
        );
        return physical;
      };
      return this.transportScheduler
        ? this.transportScheduler.run(
            lane,
            signal,
            async ({ queueWaitMs }) => {
              sharedQueueWaitMs = queueWaitMs;
              return send();
            },
          )
        : send();
    }, this.now);
    void physicalLifetime.catch((error) => {
      if (!physicalStarted) rejectLogical(error);
    });
    const responses = await logical;
    return Object.freeze({
      responses,
      telemetry: Object.freeze({
        queueWaitMs: localQueueWaitMs + sharedQueueWaitMs,
        wallMs: Math.max(0, this.now() - startedAtMs),
        rpcRequests: 1,
        rpcItems: body.length,
        responseBytes: JSON.stringify(responses).length,
      }),
    });
  }
}

interface SemaphoreWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onAbort: () => void;
}

/** One FIFO, abort-aware cap shared by every RPC path on this backend. */
class AbortableSemaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(private readonly capacity: number) {}

  async run<T>(
    signal: AbortSignal,
    task: (waitMs: number) => Promise<T>,
    now: () => number = () => performance.now(),
  ): Promise<T> {
    const queuedAtMs = now();
    const release = await this.acquire(signal);
    try {
      return await task(Math.max(0, now() - queuedAtMs));
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const waiter: SemaphoreWaiter = { signal, resolve, reject, onAbort };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (;;) {
        const waiter = this.waiters.shift();
        if (!waiter) {
          this.active--;
          return;
        }
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal.aborted) {
          waiter.reject(
            waiter.signal.reason ?? new DOMException("Aborted", "AbortError"),
          );
          continue;
        }
        waiter.resolve(this.releaseOnce());
        return;
      }
    };
  }
}

function emptyMutationProofPhaseTelemetry(): MutationProofPhaseTelemetry {
  return Object.freeze({
    queueWaitMs: 0,
    wallMs: 0,
    rpcRequests: 0,
    rpcItems: 0,
    responseBytes: 0,
  });
}

function mutationRangeSessionKey(
  descriptor: MutationQueryDescriptor,
  fromExclusive: BlockSource,
  through: BlockSource,
): string {
  return `${canonicalHeaderSessionKey(fromExclusive, through)}\u001f${
    descriptor.fingerprint
  }`;
}

function mergeMutationQueryDescriptors(
  descriptors: readonly MutationQueryDescriptor[],
): Pick<MutationQueryDescriptor, "addresses" | "topics"> {
  if (descriptors.length === 1) {
    return Object.freeze({
      addresses: descriptors[0].addresses,
      topics: descriptors[0].topics,
    });
  }
  const addresses = descriptors.some((descriptor) =>
    descriptor.addresses.length === 0
  )
    ? []
    : [...new Set(descriptors.flatMap((descriptor) =>
        descriptor.addresses.map((address) => address.toLowerCase())
      ))].sort();
  const topicCount = Math.min(
    ...descriptors.map((descriptor) => descriptor.topics.length),
  );
  const topics: Array<string | readonly string[] | null> = [];
  for (let index = 0; index < topicCount; index++) {
    const constraints = descriptors.map((descriptor) =>
      descriptor.topics[index]
    );
    // A wildcard ends the safely shareable prefix. Omitting the remaining
    // positions broadens the transport query; exact predicates are restored
    // by mutationLogMatchesDescriptor below.
    if (constraints.some((constraint) => constraint === null)) break;
    const values = [...new Set(constraints.flatMap((constraint) =>
      typeof constraint === "string" ? [constraint] : constraint ?? []
    ))].sort();
    topics.push(values.length === 1 ? values[0] : Object.freeze(values));
  }
  return Object.freeze({
    addresses: Object.freeze(addresses),
    topics: Object.freeze(topics),
  });
}

function mutationLogMatchesDescriptor(
  event: ChainLog,
  descriptor: MutationQueryDescriptor,
): boolean {
  if (
    descriptor.addresses.length > 0 &&
    !descriptor.addresses.includes(event.address.toLowerCase())
  ) {
    return false;
  }
  return descriptor.topics.every((constraint, index) => {
    if (constraint === null) return true;
    const topic = event.topics[index]?.toLowerCase();
    if (!topic) return false;
    return typeof constraint === "string"
      ? topic === constraint.toLowerCase()
      : constraint.some((candidate) =>
          topic === candidate.toLowerCase()
        );
  });
}

function sharedMutationPhase(
  phase: MutationProofPhaseTelemetry,
  shared: boolean,
): MutationProofPhaseTelemetry {
  if (!shared) return phase;
  return Object.freeze({
    ...phase,
    queueWaitMs: 0,
    rpcRequests: 0,
    rpcItems: 0,
    responseBytes: 0,
    shared: true,
  });
}

function sharedActivityPhase(): MutationProofPhaseTelemetry {
  return Object.freeze({
    ...emptyMutationProofPhaseTelemetry(),
    shared: true,
  });
}

function canonicalActivitySessionScope(through: BlockSource): string {
  return [
    through.number,
    through.hash.toLowerCase(),
    through.generation,
  ].join("\u001f");
}

function canonicalHeaderSessionKey(
  fromExclusive: BlockSource,
  through: BlockSource,
): string {
  return [
    fromExclusive.number,
    fromExclusive.hash.toLowerCase(),
    fromExclusive.generation,
    through.number,
    through.hash.toLowerCase(),
    through.generation,
  ].join("\u001f");
}

async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  let remove = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    remove();
  }
}

function classifyMutationProofFailure(
  error: unknown,
  signal: AbortSignal,
  phase: MutationProofTransportPhase,
): MutationProofFailureKind {
  const reason = signal.aborted ? signal.reason : error;
  const message = formatError(reason).toLowerCase();
  if (message.includes("deadline") || message.includes("timed out")) {
    return "deadline";
  }
  if (
    signal.aborted ||
    (reason instanceof DOMException && reason.name === "AbortError") ||
    message.includes("aborted") ||
    message.includes("cancelled") ||
    message.includes("superseded")
  ) {
    return "aborted";
  }
  if (
    phase === "descriptor-validation" ||
    phase === "header-validation" ||
    phase === "log-validation"
  ) {
    return "validation";
  }
  if (
    message.includes("rpc") ||
    message.includes("http") ||
    message.includes("json") ||
    message.includes("fetch") ||
    message.includes("logs") ||
    message.includes("block")
  ) {
    return "rpc";
  }
  return "unknown";
}

function assertPinnedReadSet(
  reads: readonly StateRead[],
  control: PinnedReadControl,
): void {
  const expectedHash = control.sourceBlockHash.toLowerCase();
  for (const read of reads) {
    if (
      read.sourceBlock !== control.sourceBlock ||
      read.sourceBlockHash.toLowerCase() !== expectedHash
    ) {
      throw new Error(
        `state read ${read.id} pin mismatch: expected ` +
          `${control.sourceBlock}/${control.sourceBlockHash}, got ` +
          `${read.sourceBlock}/${read.sourceBlockHash}`,
      );
    }
  }
}

function invalidMulticallRead(
  read: StateRead,
  control: PinnedReadControl,
): StateReadFailure | null {
  if (read.from !== undefined) {
    return readFailure(
      read,
      control,
      "rpc",
      "multicall-safe read cannot set from; use rpc-batch",
    );
  }
  if (read.acceptRevertData === true) {
    return readFailure(
      read,
      control,
      "rpc",
      "multicall-safe read cannot accept revert data; use rpc-batch",
    );
  }
  return null;
}

function stateReadRpcPayload(
  read: StateRead,
  id: number,
  sourceBlockHash: string,
): {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
} {
  const block = eip1898BlockSpecifier(sourceBlockHash);
  const tx = {
    to: read.to,
    data: read.data,
    ...(read.from ? { from: read.from } : {}),
  };
  if (read.transport === "eth-create-access-list") {
    if (read.simulation !== undefined) {
      throw new Error(`access-list read ${read.id} cannot carry simulation`);
    }
    return {
      jsonrpc: "2.0",
      id,
      method: "eth_createAccessList",
      params: [tx, block],
    };
  }
  if (read.transport === "eth-simulate-v1") {
    if (!read.simulation || read.simulation.calls.length === 0) {
      throw new Error(`simulation read ${read.id} lacks calls`);
    }
    return {
      jsonrpc: "2.0",
      id,
      method: "eth_simulateV1",
      params: [{
        blockStateCalls: [{
          ...(read.simulation.stateOverrides === undefined
            ? {}
            : { stateOverrides: read.simulation.stateOverrides }),
          calls: read.simulation.calls,
        }],
        validation: false,
        traceTransfers: read.simulation.traceTransfers,
      }, block],
    };
  }
  if (read.simulation !== undefined) {
    throw new Error(`ordinary state read ${read.id} cannot carry simulation`);
  }
  return {
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [tx, block],
  };
}

function stateReadResultData(
  read: StateRead,
  result: unknown,
): string | null {
  if (
    read.transport === "eth-create-access-list" ||
    read.transport === "eth-simulate-v1"
  ) {
    if (result === undefined) return null;
    try {
      return ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(result)));
    } catch {
      return null;
    }
  }
  return typeof result === "string" ? result : null;
}

function readSuccess(
  read: StateRead,
  control: PinnedReadControl,
  data: string,
): StateReadResult {
  return Object.freeze({
    id: read.id,
    ok: true,
    sourceBlock: control.sourceBlock,
    sourceBlockHash: control.sourceBlockHash,
    provenance: Object.freeze({
      kind: "eip1898" as const,
      source: sourceFrom(control),
      requireCanonical: true as const,
    }),
    data,
  });
}

function readFailure(
  read: StateRead,
  control: PinnedReadControl,
  kind: StateReadFailureKind,
  error: string,
): StateReadFailure {
  return Object.freeze({
    id: read.id,
    ok: false,
    sourceBlock: control.sourceBlock,
    sourceBlockHash: control.sourceBlockHash,
    kind,
    error,
  });
}

/**
 * Raw JSON-RPC permits arbitrary error.data values. Quote-by-revert is only
 * safe when the node placed canonical byte-aligned hex directly in that
 * field. Never scrape messages or recursively search nested objects: doing so
 * could turn an unrelated RPC failure into a successful quote.
 */
function strictJsonRpcRevertData(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? value : null;
}

function toBlockTag(blockNumber: number): string {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`invalid source block ${blockNumber}`);
  }
  return `0x${blockNumber.toString(16)}`;
}

function eip1898BlockSpecifier(blockHash: string): {
  readonly blockHash: string;
  readonly requireCanonical: true;
} {
  if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new Error(`invalid source block hash ${blockHash}`);
  }
  return Object.freeze({
    blockHash: blockHash.toLowerCase(),
    requireCanonical: true as const,
  });
}

function sourceFrom(control: PinnedReadControl): BlockSource {
  if (
    !Number.isSafeInteger(control.sourceGeneration) ||
    control.sourceGeneration < 0
  ) {
    throw new Error(`invalid source generation ${control.sourceGeneration}`);
  }
  return Object.freeze({
    number: control.sourceBlock,
    hash: control.sourceBlockHash.toLowerCase(),
    generation: control.sourceGeneration,
  });
}

function requiredRpcResult(
  responses: readonly JsonRpcResponse[],
  id: number,
  label: string,
): unknown {
  const response = responses.find((candidate) => candidate.id === id);
  if (!response) throw new Error(`address-touch ${label} response is missing`);
  if ("error" in response) {
    throw new Error(
      `address-touch ${label} RPC failed: ` +
        `${response.error.message ?? response.error.code ?? "unknown"}`,
    );
  }
  return response.result;
}

function parseCanonicalBlockReceipts(
  responses: readonly JsonRpcResponse[],
  ids: readonly number[],
  headers: readonly CanonicalMutationHeader[],
  fromExclusive: BlockSource,
  through: BlockSource,
): readonly {
  readonly number: number;
  readonly hash: string;
  readonly receipts: readonly {
    readonly transactionHash: string;
    readonly transactionIndex: number;
    readonly directTarget: string | null;
    readonly cumulativeGasUsed: bigint;
    readonly logs: readonly unknown[];
  }[];
}[] {
  const blocks = ids.map((id, index) => {
    const header = headers[index];
    if (!header) throw new Error(`missing receipt header ${index}`);
    const value = requiredRpcResult(
      responses,
      id,
      `block receipts ${header.number}`,
    );
    if (!Array.isArray(value)) {
      throw new Error(`block receipts ${header.number} are not an array`);
    }
    const seenTransactionHashes = new Set<string>();
    const seenTransactionIndexes = new Set<number>();
    let previousCumulativeGasUsed = -1n;
    const receipts = value.map((receipt, receiptIndex) => {
      if (!receipt || typeof receipt !== "object") {
        throw new Error(
          `block receipt ${header.number}/${receiptIndex} is invalid`,
        );
      }
      const record = receipt as Record<string, unknown>;
      const blockNumber = parseRpcQuantity(
        record.blockNumber,
        `block receipt ${header.number}/${receiptIndex} blockNumber`,
      );
      const blockHash = parseHash(
        record.blockHash,
        `block receipt ${header.number}/${receiptIndex} blockHash`,
      );
      const transactionIndex = parseRpcQuantity(
        record.transactionIndex,
        `block receipt ${header.number}/${receiptIndex} transactionIndex`,
      );
      const transactionHash = parseHash(
        record.transactionHash,
        `block receipt ${header.number}/${receiptIndex} transactionHash`,
      );
      const cumulativeGasUsed = parseRpcBigQuantity(
        record.cumulativeGasUsed,
        `block receipt ${header.number}/${receiptIndex} cumulativeGasUsed`,
      );
      if (
        blockNumber !== header.number ||
        blockHash !== header.hash ||
        transactionIndex !== receiptIndex
      ) {
        throw new Error(
          `block receipt ${header.number}/${receiptIndex} is outside ` +
            "the proven block or out of order",
        );
      }
      if (
        seenTransactionHashes.has(transactionHash) ||
        seenTransactionIndexes.has(transactionIndex)
      ) {
        throw new Error(`block receipts ${header.number} contain a duplicate`);
      }
      seenTransactionHashes.add(transactionHash);
      seenTransactionIndexes.add(transactionIndex);
      if (cumulativeGasUsed <= previousCumulativeGasUsed) {
        throw new Error(
          `block receipts ${header.number} cumulative gas is not increasing`,
        );
      }
      previousCumulativeGasUsed = cumulativeGasUsed;
      if (!Array.isArray(record.logs)) {
        throw new Error(
          `block receipt ${header.number}/${receiptIndex} logs are invalid`,
        );
      }
      const directTarget = record.to === null || record.to === undefined
        ? null
        : parseAddress(
            record.to,
            `block receipt ${header.number}/${receiptIndex} to`,
          );
      return Object.freeze({
        transactionHash,
        transactionIndex,
        directTarget,
        cumulativeGasUsed,
        logs: Object.freeze([...record.logs]),
      });
    });
    if (header.gasUsed === undefined) {
      throw new Error(`canonical header ${header.number} omitted gasUsed`);
    }
    const receiptGasUsed = receipts.at(-1)?.cumulativeGasUsed ?? 0n;
    if (receiptGasUsed !== header.gasUsed) {
      throw new Error(
        `block receipts ${header.number} are incomplete: cumulative gas ` +
          `${receiptGasUsed} != header gasUsed ${header.gasUsed}`,
      );
    }
    return Object.freeze({
      number: header.number,
      hash: header.hash,
      receipts: Object.freeze(receipts),
    });
  });
  if (
    blocks[0]?.number !== fromExclusive.number + 1 ||
    blocks.at(-1)?.number !== through.number ||
    blocks.at(-1)?.hash !== through.hash.toLowerCase()
  ) {
    throw new Error("block receipts do not match the canonical activity range");
  }
  return Object.freeze(blocks);
}

function parseChainLog(
  value: unknown,
  index: number,
  fromExclusive: BlockSource,
  through: BlockSource,
  headerByNumber: ReadonlyMap<
    number,
    { readonly hash: string }
  >,
): ChainLog {
  if (!value || typeof value !== "object") {
    throw new Error(`mutation log ${index} is not an object`);
  }
  const record = value as Record<string, unknown>;
  const blockNumber = parseRpcQuantity(
    record.blockNumber,
    `mutation log ${index} blockNumber`,
  );
  if (
    blockNumber <= fromExclusive.number ||
    blockNumber > through.number
  ) {
    throw new Error(`mutation log ${index} is outside the proven range`);
  }
  const blockHash = parseHash(record.blockHash, `mutation log ${index} blockHash`);
  if (headerByNumber.get(blockNumber)?.hash !== blockHash) {
    throw new Error(`mutation log ${index} block hash is not on canonical path`);
  }
  if (record.removed === true) {
    throw new Error(`mutation log ${index} is marked removed`);
  }
  if (!Array.isArray(record.topics)) {
    throw new Error(`mutation log ${index} topics is not an array`);
  }
  const topics = Object.freeze(record.topics.map((topic, topicIndex) =>
    parseHash(topic, `mutation log ${index} topic ${topicIndex}`)
  ));
  const address = parseAddress(record.address, `mutation log ${index} address`);
  const data = parseHexBytes(record.data, `mutation log ${index} data`);
  return Object.freeze({
    blockNumber,
    blockHash,
    transactionIndex: parseRpcQuantity(
      record.transactionIndex,
      `mutation log ${index} transactionIndex`,
    ),
    logIndex: parseRpcQuantity(
      record.logIndex,
      `mutation log ${index} logIndex`,
    ),
    address,
    topics,
    data,
    removed: false,
  });
}

function parseEthBlockHeaderResponses(
  responses: readonly JsonRpcResponse[],
  ids: readonly number[],
  blockNumbers: readonly number[],
): readonly CanonicalMutationHeader[] {
  return Object.freeze(ids.map((id, index) => {
    const response = responses.find((candidate) => candidate.id === id);
    if (!response || "error" in response) {
      throw new Error(
        `cannot prove canonical mutation block ${blockNumbers[index]}`,
      );
    }
    const result = response.result as {
      readonly number?: unknown;
      readonly hash?: unknown;
      readonly parentHash?: unknown;
      readonly gasUsed?: unknown;
    } | null;
    const number = parseRpcQuantity(
      result?.number,
      `mutation header ${blockNumbers[index]} number`,
    );
    return Object.freeze({
      number,
      hash: parseHash(result?.hash, `mutation header ${number} hash`),
      parentHash: parseHash(
        result?.parentHash,
        `mutation header ${number} parentHash`,
      ),
      ...(result?.gasUsed === undefined
        ? {}
        : {
            gasUsed: parseRpcBigQuantity(
              result.gasUsed,
              `mutation header ${number} gasUsed`,
            ),
          }),
    });
  }));
}

function parseRawHeaderResponses(
  responses: readonly JsonRpcResponse[],
  ids: readonly number[],
  blockNumbers: readonly number[],
): readonly CanonicalMutationHeader[] {
  return Object.freeze(ids.map((id, index) => {
    const response = responses.find((candidate) => candidate.id === id);
    if (!response || "error" in response) {
      throw new Error(
        `cannot prove canonical raw mutation block ${blockNumbers[index]}`,
      );
    }
    const raw = parseHexBytes(
      response.result,
      `mutation raw header ${blockNumbers[index]}`,
    );
    const decoded = decodeRlp(raw);
    if (!Array.isArray(decoded) || decoded.length < 9) {
      throw new Error(
        `mutation raw header ${blockNumbers[index]} is not an Ethereum header`,
      );
    }
    return Object.freeze({
      number: parseRlpQuantity(
        decoded[8],
        `mutation raw header ${blockNumbers[index]} number`,
      ),
      hash: keccak256(raw).toLowerCase(),
      parentHash: parseHash(
        decoded[0],
        `mutation raw header ${blockNumbers[index]} parentHash`,
      ),
      ...(decoded.length <= 10
        ? {}
        : {
            gasUsed: parseRlpBigQuantity(
              decoded[10],
              `mutation raw header ${blockNumbers[index]} gasUsed`,
            ),
          }),
    });
  }));
}

function parseRpcBigQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`${label} is not a canonical RPC quantity`);
  }
  return BigInt(value);
}

function parseRlpBigQuantity(value: unknown, label: string): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)
  ) {
    throw new Error(`${label} is not an RLP byte quantity`);
  }
  return value === "0x" ? 0n : BigInt(value);
}

function parseRlpQuantity(value: unknown, label: string): number {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)
  ) {
    throw new Error(`${label} is not an RLP byte quantity`);
  }
  const parsed = value === "0x" ? 0 : Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return parsed;
}

function isRawHeaderMethodUnavailable(response: JsonRpcFailure): boolean {
  return (
    response.error.code === -32601 ||
    /method (?:not found|unsupported)|unsupported method/i.test(
      response.error.message ?? "",
    )
  );
}

function combineMutationProofPhaseTelemetry(
  first: MutationProofPhaseTelemetry,
  second: MutationProofPhaseTelemetry,
  transport: NonNullable<MutationProofPhaseTelemetry["transport"]>,
): MutationProofPhaseTelemetry {
  return Object.freeze({
    queueWaitMs: first.queueWaitMs + second.queueWaitMs,
    wallMs: first.wallMs + second.wallMs,
    rpcRequests: first.rpcRequests + second.rpcRequests,
    rpcItems: first.rpcItems + second.rpcItems,
    responseBytes: first.responseBytes + second.responseBytes,
    transport,
  });
}

function parseRpcQuantity(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} is not a JSON-RPC quantity`);
  }
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return parsed;
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} is not a 32-byte hash`);
  }
  return value.toLowerCase();
}

function parseAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} is not an address`);
  }
  return value.toLowerCase();
}

function parseHexBytes(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} is not byte-aligned hex`);
  }
  return value.toLowerCase();
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  const abort = (): void => child.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function failureKind(
  error: unknown,
  control: { readonly deadlineAtMs: number; readonly signal: AbortSignal },
): StateReadFailureKind {
  if (Date.now() >= control.deadlineAtMs) return "deadline";
  if (control.signal.aborted) return "aborted";
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return "rpc";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWithConcurrency(
  tasks: readonly (() => Promise<void>)[],
  concurrency: number,
  onFirstError: (error: unknown) => void,
): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (failures.length === 0) {
        const index = next++;
        if (index >= tasks.length) return;
        try {
          await tasks[index]();
        } catch (error) {
          if (failures.length === 0) {
            failures.push(error);
            onFirstError(error);
          }
          return;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failures.length > 0) throw failures[0];
}
