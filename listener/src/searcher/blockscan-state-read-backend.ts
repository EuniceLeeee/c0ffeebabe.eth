import type {
  BlockScanStateReadBackend,
  CanonicalAddressTouchRange,
} from "./blockscan-state-coordinator.js";
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
  readonly onMutationProofTelemetry?: (
    telemetry: MutationProofTransportTelemetry,
  ) => void;
  readonly now?: () => number;
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
  private readonly fetchImpl: typeof fetch;
  private readonly onMutationProofTelemetry:
    | ((telemetry: MutationProofTransportTelemetry) => void)
    | undefined;
  private readonly now: () => number;
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
    this.onMutationProofTelemetry = options.onMutationProofTelemetry;
    this.now = options.now ?? (() => performance.now());
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
    return this.readAtPinnedHash(reads, control, false);
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
    const distance = through.number - fromExclusive.number;
    if (
      distance <= 0 ||
      distance > 8 ||
      through.generation <= fromExclusive.generation
    ) {
      throw new Error(
        "address-touch proof requires 1..8 forward canonical blocks",
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
      const blockNumbers = Array.from(
        { length: distance },
        (_value, index) => fromExclusive.number + index + 1,
      );
      const blockIds = blockNumbers.map(() => this.nextId++);
      const blockResponses = await this.postWithSlots(
        this.addressTouchSlots,
        blockIds.map((id, index) => ({
            jsonrpc: "2.0",
            id,
            method: "eth_getBlockByNumber",
            params: [toBlockTag(blockNumbers[index]), false],
        })),
        controller.signal,
      );
      const blocks = parseAddressTouchBlocks(
        blockResponses,
        blockIds,
        blockNumbers,
        fromExclusive,
        through,
      );
      const traceIds = blocks.map(() => this.nextId++);
      const traceResponses = await this.postWithSlots(
        this.addressTouchSlots,
        traceIds.map((id, index) => ({
            jsonrpc: "2.0",
            id,
            method: "trace_block",
            params: [toBlockTag(blocks[index].number)],
        })),
        controller.signal,
      );
      const touched = new Set<string>();
      let transactionCount = 0;
      for (let index = 0; index < blocks.length; index++) {
        const traces = requiredRpcResult(
          traceResponses,
          traceIds[index],
          `trace block ${blocks[index].number}`,
        );
        for (const address of parseAddressTouchTraces(
          traces,
          blocks[index],
        )) {
          touched.add(address);
        }
        transactionCount += blocks[index].transactionHashes.length;
      }
      const touchedAddresses = Object.freeze([...touched].sort());
      await this.verifyCanonicalSourceWithSlotsMeasured(
        through,
        controller.signal,
        this.addressTouchSlots,
      );
      return Object.freeze({
        fromExclusive,
        through,
        touchedAddresses,
        transactionCount,
        complete: true as const,
        rangeFingerprint: deterministicHash({
          fromExclusive,
          through,
          blocks,
          touchedAddresses,
        }),
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
        await this.verifyCanonicalSource(sourceFrom(control), controller.signal);
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
        await this.verifyCanonicalSource(sourceFrom(control), controller.signal);
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
  ): Promise<void> {
    return this.verifyCanonicalSourceWithSlots(source, signal, this.rpcSlots);
  }

  private async verifyCanonicalSourceWithSlots(
    source: BlockSource,
    signal: AbortSignal,
    slots: AbortableSemaphore,
  ): Promise<void> {
    const id = this.nextId++;
    const response = await this.postWithSlots(slots, [{
      jsonrpc: "2.0",
      id,
      method: "eth_getBlockByNumber",
      params: [toBlockTag(source.number), false],
    }], signal);
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
   * that eth_call accepts EIP-1898. Execute one harmless no-code call with the
   * exact canonical-hash object and fail startup if the node rejects it.
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
          to: "0x0000000000000000000000000000000000000000",
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
      const created = control.sharedSignal
        ? this.enqueueSharedMutationTransport(
            descriptor,
            fromExclusive,
            through,
            {
              deadlineAtMs: control.deadlineAtMs,
              signal: ownerSignal,
            },
          )
        : this.computeCanonicalMutationRange(
            descriptor,
            fromExclusive,
            through,
            {
              deadlineAtMs: control.deadlineAtMs,
              signal: ownerSignal,
            },
          );
      session = created.finally(() => {
        if (this.mutationRangeSessions.get(sessionKey) === session) {
          this.mutationRangeSessions.delete(sessionKey);
        }
      });
      this.mutationRangeSessions.set(sessionKey, session);
    }
    return await awaitWithSignal(session, control.signal);
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
      batch.resolve(await this.computeCanonicalMutationRanges(
        [...batch.descriptors.values()],
        batch.fromExclusive,
        batch.through,
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

      phase = "log-read";
      const logId = this.nextId++;
      const logFilter = {
        fromBlock: toBlockTag(fromExclusive.number + 1),
        toBlock: toBlockTag(through.number),
        ...(transportDescriptor.addresses.length === 0
          ? {}
          : {
              address: transportDescriptor.addresses.length === 1
                ? transportDescriptor.addresses[0]
                : transportDescriptor.addresses,
            }),
        topics: transportDescriptor.topics,
      };
      const logRead = await this.postWithSlotsMeasured(
        this.mutationDescriptorSlots,
        [{
        jsonrpc: "2.0",
        id: logId,
        method: "eth_getLogs",
        params: [logFilter],
        }],
        controller.signal,
      );
      logTelemetry = logRead.telemetry;
      const logResponses = logRead.responses;
      phase = "log-validation";
      const logValidationStartedAtMs = this.now();
      const logResponse = logResponses.find((candidate) => candidate.id === logId);
      if (!logResponse || "error" in logResponse) {
        throw new Error(
          `cannot read complete mutation logs: ${
            logResponse && "error" in logResponse
              ? logResponse.error.message ?? logResponse.error.code ?? "RPC error"
              : "missing RPC response"
          }`,
        );
      }
      if (!Array.isArray(logResponse.result)) {
        throw new Error("eth_getLogs returned a non-array result");
      }
      const headerByNumber = new Map(
        headers.map((header) => [header.number, header]),
      );
      const events = (logResponse.result as readonly unknown[])
        .map((value, index) =>
          parseChainLog(value, index, fromExclusive, through, headerByNumber)
        )
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
    return this.readEthBlockHeaderBatch(blockNumbers, signal, slots);
  }

  private async readEthBlockHeaderBatch(
    blockNumbers: readonly number[],
    signal: AbortSignal,
    slots: AbortableSemaphore,
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
  ): Promise<MutationProofPhaseTelemetry> {
    if (this.mutationHeaderMode === "debug-raw-header-with-fallback") {
      const measured = await this.readCanonicalHeaderBatch(
        source.number,
        source.number,
        signal,
        slots,
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
    }], signal);
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

  private async postWithSlots(
    slots: AbortableSemaphore,
    body: readonly object[],
    signal: AbortSignal,
  ): Promise<readonly JsonRpcResponse[]> {
    return slots.run(signal, async () => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        throw new Error(`JSON-RPC HTTP ${response.status} ${response.statusText}`);
      }
      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new Error("JSON-RPC batch returned non-array");
      return value as readonly JsonRpcResponse[];
    });
  }

  private async postWithSlotsMeasured(
    slots: AbortableSemaphore,
    body: readonly object[],
    signal: AbortSignal,
  ): Promise<{
    readonly responses: readonly JsonRpcResponse[];
    readonly telemetry: MutationProofPhaseTelemetry;
  }> {
    const startedAtMs = this.now();
    let queueWaitMs = 0;
    const responses = await slots.run(signal, async (waitMs) => {
      queueWaitMs = waitMs;
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        throw new Error(`JSON-RPC HTTP ${response.status} ${response.statusText}`);
      }
      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new Error("JSON-RPC batch returned non-array");
      return value as readonly JsonRpcResponse[];
    }, this.now);
    return Object.freeze({
      responses,
      telemetry: Object.freeze({
        queueWaitMs,
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

function parseAddressTouchBlocks(
  responses: readonly JsonRpcResponse[],
  ids: readonly number[],
  blockNumbers: readonly number[],
  fromExclusive: BlockSource,
  through: BlockSource,
): readonly {
  readonly number: number;
  readonly hash: string;
  readonly transactionHashes: readonly string[];
}[] {
  let expectedParentHash = fromExclusive.hash.toLowerCase();
  const blocks = ids.map((id, index) => {
    const value = requiredRpcResult(
      responses,
      id,
      `block ${blockNumbers[index]}`,
    );
    if (!value || typeof value !== "object") {
      throw new Error(`address-touch block ${blockNumbers[index]} is invalid`);
    }
    const block = value as Record<string, unknown>;
    const number = parseRpcQuantity(
      block.number,
      `address-touch block ${blockNumbers[index]} number`,
    );
    const hash = parseHash(
      block.hash,
      `address-touch block ${blockNumbers[index]} hash`,
    );
    if (
      number !== blockNumbers[index] ||
      parseHash(
        block.parentHash,
        `address-touch block ${blockNumbers[index]} parentHash`,
      ) !== expectedParentHash
    ) {
      throw new Error("address-touch blocks are not one canonical chain");
    }
    if (!Array.isArray(block.transactions)) {
      throw new Error(
        `address-touch block ${blockNumbers[index]} transactions is invalid`,
      );
    }
    expectedParentHash = hash;
    return Object.freeze({
      number,
      hash,
      transactionHashes: Object.freeze(block.transactions.map(
        (transactionHash, transactionIndex) => parseHash(
          transactionHash,
          `address-touch block ${number} transaction ${transactionIndex}`,
        ),
      )),
    });
  });
  if (blocks.at(-1)?.hash !== through.hash.toLowerCase()) {
    throw new Error("address-touch through block is not canonical");
  }
  return Object.freeze(blocks);
}

function parseAddressTouchTraces(
  value: unknown,
  block: {
    readonly number: number;
    readonly hash: string;
    readonly transactionHashes: readonly string[];
  },
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("address-touch trace is not an array");
  }
  const touched = new Set<string>();
  const rootByTransaction = new Map<number, string>();
  const pathsByTransaction = new Map<number, Set<string>>();
  const subtracesByTransaction = new Map<number, Map<string, number>>();
  const childCountsByTransaction = new Map<number, Map<string, number>>();
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!item || typeof item !== "object") {
      throw new Error(`address-touch trace ${index} is not an object`);
    }
    const record = item as Record<string, unknown>;
    const blockNumber = parseRpcIndex(
      record.blockNumber,
      `address-touch trace ${index} blockNumber`,
    );
    const blockHash = parseHash(
      record.blockHash,
      `address-touch trace ${index} blockHash`,
    );
    if (blockNumber !== block.number || blockHash !== block.hash) {
      throw new Error(`address-touch trace ${index} is outside the proven block`);
    }
    const transactionIndex = parseRpcIndex(
      record.transactionPosition,
      `address-touch trace ${index} transactionPosition`,
    );
    const expectedHash = block.transactionHashes[transactionIndex];
    if (
      expectedHash === undefined ||
      parseHash(
        record.transactionHash,
        `address-touch trace ${index} transactionHash`,
      ) !== expectedHash
    ) {
      throw new Error(`address-touch trace ${index} transaction order mismatch`);
    }
    if (!Array.isArray(record.traceAddress)) {
      throw new Error(`address-touch trace ${index} traceAddress is invalid`);
    }
    const traceAddress = record.traceAddress.map((part, partIndex) =>
      parseTraceAddressPart(
        part,
        `address-touch trace ${index} path ${partIndex}`,
      )
    );
    const path = traceAddress.join("/");
    const transactionPaths = pathsByTransaction.get(transactionIndex) ?? new Set();
    if (transactionPaths.has(path)) {
      throw new Error(`address-touch trace ${index} duplicates call path ${path}`);
    }
    transactionPaths.add(path);
    pathsByTransaction.set(transactionIndex, transactionPaths);
    if (traceAddress.length > 0) {
      const separator = path.lastIndexOf("/");
      const parentPath = separator < 0 ? "" : path.slice(0, separator);
      const childCounts = childCountsByTransaction.get(transactionIndex) ??
        new Map<string, number>();
      childCounts.set(parentPath, (childCounts.get(parentPath) ?? 0) + 1);
      childCountsByTransaction.set(transactionIndex, childCounts);
    }
    const subtraces = parseRpcIndex(
      record.subtraces,
      `address-touch trace ${index} subtraces`,
    );
    const transactionSubtraces = subtracesByTransaction.get(transactionIndex) ??
      new Map<string, number>();
    transactionSubtraces.set(path, subtraces);
    subtracesByTransaction.set(transactionIndex, transactionSubtraces);
    if (traceAddress.length === 0) {
      if (rootByTransaction.has(transactionIndex)) {
        throw new Error(
          `address-touch transaction ${transactionIndex} has duplicate roots`,
        );
      }
      rootByTransaction.set(transactionIndex, expectedHash);
    }
    collectFlatTraceAddresses(record, touched, index);
  }
  if (rootByTransaction.size !== block.transactionHashes.length) {
    throw new Error("address-touch trace does not cover every block transaction");
  }
  for (let transactionIndex = 0;
    transactionIndex < block.transactionHashes.length;
    transactionIndex++
  ) {
    if (!rootByTransaction.has(transactionIndex)) {
      throw new Error(
        `address-touch trace lacks transaction ${transactionIndex} root`,
      );
    }
    const paths = pathsByTransaction.get(transactionIndex);
    const subtraces = subtracesByTransaction.get(transactionIndex);
    const childCounts = childCountsByTransaction.get(transactionIndex) ??
      new Map<string, number>();
    if (!paths || !subtraces) {
      throw new Error(
        `address-touch trace lacks transaction ${transactionIndex} paths`,
      );
    }
    for (const path of paths) {
      if (path === "") continue;
      const separator = path.lastIndexOf("/");
      const parentPath = separator < 0 ? "" : path.slice(0, separator);
      if (!paths.has(parentPath)) {
        throw new Error(
          `address-touch transaction ${transactionIndex} path ${path} lacks parent`,
        );
      }
    }
    for (const [path, expectedChildren] of subtraces) {
      const actualChildren = childCounts.get(path) ?? 0;
      if (actualChildren !== expectedChildren) {
        throw new Error(
          `address-touch transaction ${transactionIndex} path ${path} ` +
            `expected ${expectedChildren} direct children, got ${actualChildren}`,
        );
      }
    }
  }
  return Object.freeze([...touched].sort());
}

function collectFlatTraceAddresses(
  record: Readonly<Record<string, unknown>>,
  touched: Set<string>,
  traceIndex: number,
): void {
  if (!record.action || typeof record.action !== "object") {
    throw new Error(`address-touch trace ${traceIndex} action is invalid`);
  }
  const action = record.action as Record<string, unknown>;
  const type = String(record.type ?? "").toLowerCase();
  if (type === "call") {
    touched.add(parseAddress(
      action.from,
      `address-touch trace ${traceIndex} call from`,
    ));
    touched.add(parseAddress(
      action.to,
      `address-touch trace ${traceIndex} call to`,
    ));
    return;
  }
  if (type === "create") {
    touched.add(parseAddress(
      action.from,
      `address-touch trace ${traceIndex} create from`,
    ));
    if (record.result && typeof record.result === "object") {
      const result = record.result as Record<string, unknown>;
      if (result.address !== undefined) {
        touched.add(parseAddress(
          result.address,
          `address-touch trace ${traceIndex} created address`,
        ));
      }
    }
    return;
  }
  if (type === "suicide" || type === "selfdestruct") {
    touched.add(parseAddress(
      action.address,
      `address-touch trace ${traceIndex} selfdestruct address`,
    ));
    touched.add(parseAddress(
      action.refundAddress,
      `address-touch trace ${traceIndex} selfdestruct refund`,
    ));
    return;
  }
  throw new Error(`address-touch trace ${traceIndex} has unsupported type ${type}`);
}

function parseTraceAddressPart(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative integer`);
  }
  return value;
}

function parseRpcIndex(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} is outside the safe integer range`);
    }
    return value;
  }
  return parseRpcQuantity(value, label);
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
    });
  }));
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
