import type {
  BlockScanStateReadBackend,
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
import {
  deterministicHash,
  mutationQueryDescriptorFingerprint,
} from "./venues/blockscan-state-capability.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "./blockscan-multicall.js";

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
  /**
   * Local reth is faster with parallel JSON-RPC eth_call batches than with an
   * on-chain Multicall3 aggregate. Remote providers may opt into aggregate3
   * when network round trips dominate.
   */
  readonly multicallMode?: "rpc-batch" | "aggregate3";
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
  private readonly rpcSlots: AbortableSemaphore;
  /**
   * Mutation proofs are the prerequisite for carrying unchanged state into the
   * current generation. Keep one bounded transport slot outside the bulk
   * current/static/funding FIFO so a full state-read queue cannot force every
   * incremental family back to a full current-N refresh.
   */
  private readonly mutationProofSlots: AbortableSemaphore;
  private readonly fetchImpl: typeof fetch;
  private readonly onMutationProofTelemetry:
    | ((telemetry: MutationProofTransportTelemetry) => void)
    | undefined;
  private readonly now: () => number;
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
    this.rpcSlots = new AbortableSemaphore(maxConcurrentBatches);
    this.mutationProofSlots = new AbortableSemaphore(1);
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
          read.transport === "rpc-batch" ||
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
    },
  ): Promise<CanonicalMutationRange> {
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
    if (
      descriptor.fingerprint !==
      mutationQueryDescriptorFingerprint(descriptor)
    ) {
      throw new Error("mutation descriptor fingerprint mismatch");
    }
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
      const headerRequests: object[] = [];
      const headerIds: number[] = [];
      for (
        let blockNumber = fromExclusive.number;
        blockNumber <= through.number;
        blockNumber++
      ) {
        const id = this.nextId++;
        headerIds.push(id);
        headerRequests.push({
          jsonrpc: "2.0",
          id,
          method: "eth_getBlockByNumber",
          params: [toBlockTag(blockNumber), false],
        });
      }
      const headerRead = await this.postWithSlotsMeasured(
        this.mutationProofSlots,
        headerRequests,
        controller.signal,
      );
      headerTelemetry = headerRead.telemetry;
      const headerResponses = headerRead.responses;
      phase = "header-validation";
      const headerValidationStartedAtMs = this.now();
      const headers = headerIds.map((id, index) => {
        const response = headerResponses.find((candidate) => candidate.id === id);
        if (!response || "error" in response) {
          throw new Error(
            `cannot prove canonical mutation block ${fromExclusive.number + index}`,
          );
        }
        const result = response.result as {
          readonly number?: unknown;
          readonly hash?: unknown;
          readonly parentHash?: unknown;
        } | null;
        const number = parseRpcQuantity(
          result?.number,
          `mutation header ${fromExclusive.number + index} number`,
        );
        const hash = parseHash(
          result?.hash,
          `mutation header ${number} hash`,
        );
        const parentHash = parseHash(
          result?.parentHash,
          `mutation header ${number} parentHash`,
        );
        if (number !== fromExclusive.number + index) {
          throw new Error(
            `mutation header number mismatch ${number} != ${fromExclusive.number + index}`,
          );
        }
        return Object.freeze({ number, hash, parentHash });
      });
      if (headers[0]?.hash !== fromExclusive.hash.toLowerCase()) {
        throw new Error("mutation range previous source is no longer canonical");
      }
      if (headers.at(-1)?.hash !== through.hash.toLowerCase()) {
        throw new Error("mutation range through source is no longer canonical");
      }
      for (let index = 1; index < headers.length; index++) {
        if (headers[index].parentHash !== headers[index - 1].hash) {
          throw new Error(
            `mutation range canonical path discontinuity at ${headers[index].number}`,
          );
        }
      }
      validationMs += Math.max(0, this.now() - headerValidationStartedAtMs);

      phase = "log-read";
      const logId = this.nextId++;
      const logFilter = {
        fromBlock: toBlockTag(fromExclusive.number + 1),
        toBlock: toBlockTag(through.number),
        ...(descriptor.addresses.length === 0
          ? {}
          : {
              address: descriptor.addresses.length === 1
                ? descriptor.addresses[0]
                : descriptor.addresses,
            }),
        topics: descriptor.topics,
      };
      const logRead = await this.postWithSlotsMeasured(this.mutationProofSlots, [{
        jsonrpc: "2.0",
        id: logId,
        method: "eth_getLogs",
        params: [logFilter],
      }], controller.signal);
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
        this.mutationProofSlots,
      );
      const canonicalPathFingerprint = deterministicHash(headers);
      const rangeFingerprint = deterministicHash({
        fromExclusive,
        through,
        queryDescriptorFingerprint: descriptor.fingerprint,
        canonicalPathFingerprint,
        events,
      });
      const range = Object.freeze({
        fromExclusive,
        through,
        events: Object.freeze(events),
        complete: true as const,
        queryDescriptorFingerprint: descriptor.fingerprint,
        canonicalPathFingerprint,
        rangeFingerprint,
      });
      completed = true;
      return range;
    } catch (error) {
      const classified = classifyMutationProofFailure(
        error,
        controller.signal,
        phase,
      );
      failure = { phase, kind: classified };
      if (error instanceof MutationRangeReadError) throw error;
      throw new MutationRangeReadError(
        phase,
        classified,
        formatError(error),
        error,
      );
    } finally {
      clearTimeout(timer);
      detach();
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
        wallMs: Math.max(0, this.now() - startedAtMs),
        validationMs,
        phases: Object.freeze({
          headers: headerTelemetry,
          logs: logTelemetry,
          finalCas: finalCasTelemetry,
        }),
      });
      try {
        this.onMutationProofTelemetry?.(telemetry);
      } catch {
        // Observability must never change proof transport behavior.
      }
    }
  }

  private async verifyCanonicalSourceWithSlotsMeasured(
    source: BlockSource,
    signal: AbortSignal,
    slots: AbortableSemaphore,
  ): Promise<MutationProofPhaseTelemetry> {
    const id = this.nextId++;
    const measured = await this.postWithSlotsMeasured(slots, [{
      jsonrpc: "2.0",
      id,
      method: "eth_getBlockByNumber",
      params: [toBlockTag(source.number), false],
    }], signal);
    const item = measured.responses[0];
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
    return measured.telemetry;
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
      return {
        jsonrpc: "2.0" as const,
        id,
        method: "eth_call",
        params: [
          {
            to: read.to,
            data: read.data,
            ...(read.from ? { from: read.from } : {}),
          },
          eip1898BlockSpecifier(control.sourceBlockHash),
        ],
      };
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
      if (typeof response.result !== "string") {
        return readFailure(
          read,
          control,
          "rpc",
          "eth_call returned a non-string result",
        );
      }
      return readSuccess(read, control, response.result);
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
