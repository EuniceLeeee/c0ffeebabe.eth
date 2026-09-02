import { spawn, type ChildProcess } from "node:child_process";
import {
  Agent as HttpAgent,
  request as requestHttp,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import {
  Agent as HttpsAgent,
  request as requestHttps,
} from "node:https";
import { createServer as createNetServer } from "node:net";
import { ethers, type JsonRpcError, type JsonRpcPayload } from "ethers";

// Anvil forks mainnet, so its chainId is always 1. Pinning a static network
// stops ethers from running its background "detect network" retry loop, which
// otherwise spams "JsonRpcProvider failed to detect network" once per second
// whenever the anvil endpoint is down — e.g. in revm mode, where the fork is
// never started. Calls still fail per-request when anvil is genuinely absent.
function makeAnvilProvider(anvilUrl: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(anvilUrl, ethers.Network.from(1), {
    staticNetwork: ethers.Network.from(1),
  });
}

export interface StateBackend {
  forkAt(blockNumber: number, control?: StateCallControl): Promise<void>;
  forkAfterTx(txHash: string): Promise<void>;
  prepareVictimPostState(params: VictimStateParams): Promise<VictimStateResult>;
  applyRawTx(rawTx: string): Promise<string>;
  queueHistoricalRawTransactions(
    blockNumber: number,
    transactions: Array<{ rawTx: string; expectedHash: string }>,
  ): Promise<string[]>;
  snapshot(): Promise<string>;
  revert(snapshotId: string): Promise<void>;
  call(
    req: { to: string; data: string; from?: string },
    control?: StateCallControl,
  ): Promise<string>;
  /**
   * Execute one caller-funded token conversion without mutating the fork and
   * report only independently observed balance/supply/native deltas.
   *
   * Families without a view quoter use this capability instead of guessing a
   * rate. Absence means the lane must fail closed.
   */
  simulateTokenToNativeDelta?(
    req: TokenToNativeDeltaRequest,
    control?: StateCallControl,
  ): Promise<TokenToNativeDeltaResult>;
  send(req: { from: string; to: string; data: string; gas?: string }): Promise<string>;
  getGasUsed(txHash: string): Promise<bigint>;
  getTokenBalance(token: string, account: string): Promise<bigint>;
}

export interface TokenToNativeDeltaRequest {
  readonly token: string;
  readonly caller: string;
  readonly amountIn: bigint;
  readonly callData: string;
}

export interface TokenToNativeDeltaResult {
  readonly tokenInSpent: bigint;
  readonly totalSupplyBurned: bigint;
  readonly nativeOut: bigint;
}

export interface StateCallControl {
  /** Absolute wall-clock deadline. A past deadline must not start an RPC. */
  deadlineAtMs?: number;
  /** Cancels the underlying transport, rather than only rejecting a wrapper promise. */
  signal?: AbortSignal;
}

export class StateCallAbortedError extends Error {
  readonly code = "STATE_CALL_ABORTED";

  constructor(
    message: string,
    readonly kind: "deadline" | "signal" | "timeout",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StateCallAbortedError";
  }
}

/**
 * Structured proof that a submitted local-fork transaction was mined with a
 * failing status. Consumers must inspect these fields, never parse `message`.
 */
export class TransactionRevertedError extends Error {
  readonly code = "TRANSACTION_REVERTED";
  readonly kind = "revert";

  constructor(
    readonly transactionHash: string,
    readonly detail?: string,
  ) {
    super(
      `transaction reverted: ${transactionHash}${
        detail ? ` ${detail}` : ""
      }`,
    );
    this.name = "TransactionRevertedError";
  }
}

export function isStateCallAbortedError(error: unknown): error is StateCallAbortedError {
  return error instanceof StateCallAbortedError || (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "STATE_CALL_ABORTED"
  );
}

/**
 * A view that injects the same absolute deadline/signal into every nested
 * adapter call without changing every protocol helper signature.
 */
export function withStateCallControl(
  state: StateBackend,
  control: StateCallControl,
): StateBackend {
  const call = state.call.bind(state);
  const simulateTokenToNativeDelta =
    state.simulateTokenToNativeDelta?.bind(state);
  return Object.assign(Object.create(state) as StateBackend, {
    call: (
      req: { to: string; data: string; from?: string },
      nested?: StateCallControl,
    ) => call(req, {
      deadlineAtMs: earliestDeadline(control.deadlineAtMs, nested?.deadlineAtMs),
      signal: combineAbortSignals(control.signal, nested?.signal),
    }),
    ...(simulateTokenToNativeDelta === undefined
      ? {}
      : {
          simulateTokenToNativeDelta: (
            req: TokenToNativeDeltaRequest,
            nested?: StateCallControl,
          ) => simulateTokenToNativeDelta(req, {
            deadlineAtMs: earliestDeadline(
              control.deadlineAtMs,
              nested?.deadlineAtMs,
            ),
            signal: combineAbortSignals(control.signal, nested?.signal),
          }),
        }),
  });
}

export interface VictimStateParams {
  txHash: string;
  rawTx: string;
  blockNumber: number;
  transactionIndex: number;
  previousTxHash?: string;
  from: string;
  nonce: number;
  preferSequentialPrefix?: boolean;
}

export interface VictimStateResult {
  mode: "tx-hash-anchor-pre" | "tx-hash-anchor-post" | "sequential-prefix";
  appliedTxHash: string;
  nonceBefore: number;
  nonceAfter: number;
  replayedPrefixCount: number;
}

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const SYNTHETIC_NATIVE_TRANSFER_EMITTER =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const tokenBalanceSlotMemo = new Map<string, string>();
const LOCAL_FORK_GAS_BALANCE_FLOOR = 10_000n * 10n ** 18n;

export class AnvilStateBackend implements StateBackend {
  provider: ethers.JsonRpcProvider;
  private proc: ChildProcess | null = null;
  private stopBarrier: Promise<void> = Promise.resolve();
  /** Serializes reset/spawn ownership so a cancelled generation cannot race
   * a successor for the same process and loopback port. */
  private forkBarrier: Promise<void> = Promise.resolve();
  /** Fork-reuse state (see refreshFork / resetToBaseline / ensureFreshFork). */
  private baselineSnapshot: string | null = null;
  private forkedBlock = 0;

  constructor(
    private readonly rpcUrl: string,
    readonly anvilUrl = "http://127.0.0.1:8555",
    private readonly port = 8555,
  ) {
    this.provider = makeAnvilProvider(anvilUrl);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    await this.stopBarrier;
    await assertLoopbackPortAvailable(this.port);
    this.resetProvider();
    let stderrTail = "";
    const proc = spawn("anvil", [
      "--fork-url", this.rpcUrl,
      "--accounts", "0",
      "--port", String(this.port),
      "--silent",
      "--no-mining",
      "--order", "fifo",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4_096);
    });
    this.proc = proc;
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
    });

    try {
      await waitForOwnedAnvil(
        this.provider,
        proc,
        30,
        400,
        "anvil readiness",
      );
    } catch (error) {
      if (this.proc === proc) await this.stopAndWait();
      const detail = redactSpawnDiagnostic(stderrTail.trim());
      throw new Error(
        (error instanceof Error ? error.message : String(error)) +
          (detail.length === 0 ? "" : `; anvil stderr=${detail}`),
        { cause: error },
      );
    }
  }

  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    const exited = waitForChildExit(proc);
    this.stopBarrier = Promise.all([this.stopBarrier, exited]).then(() => undefined);
    proc.kill();
    this.provider.destroy();
    this.baselineSnapshot = null;
    this.forkedBlock = 0;
  }

  /**
   * Kill the current fork and wait until the OS has reaped it. Callers that
   * intend to reuse this backend/port must await this barrier; `stop()` alone
   * remains the synchronous process-shutdown convenience used at exit.
   */
  async stopAndWait(): Promise<void> {
    this.stop();
    await this.stopBarrier;
  }

  forkAt(
    blockNumber: number,
    control: StateCallControl = {},
  ): Promise<void> {
    const operation = this.forkBarrier.then(() =>
      this.forkAtExclusive(blockNumber, control)
    );
    this.forkBarrier = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async forkAtExclusive(
    blockNumber: number,
    control: StateCallControl,
  ): Promise<void> {
    const controller = new AbortController();
    const abortFromCaller = (): void =>
      controller.abort(control.signal?.reason);
    const stopOnAbort = (): void => this.stop();
    control.signal?.addEventListener("abort", abortFromCaller, { once: true });
    controller.signal.addEventListener("abort", stopOnAbort, { once: true });
    const deadlineRemaining = control.deadlineAtMs === undefined
      ? null
      : control.deadlineAtMs - Date.now();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const abortForDeadline = (): void =>
      controller.abort(new StateCallAbortedError(
        `anvil fork block ${blockNumber} aborted: absolute deadline reached`,
        "deadline",
      ));
    if (deadlineRemaining !== null && deadlineRemaining <= 0) {
      abortForDeadline();
    } else if (deadlineRemaining !== null) {
      deadlineTimer = setTimeout(abortForDeadline, deadlineRemaining);
    }
    if (control.signal?.aborted) abortFromCaller();
    try {
      throwIfForkAborted(controller.signal, blockNumber);
      if (this.proc) {
        try {
          const proc = this.proc;
          await awaitAbortableForkOperation(
            withTimeout(
              this.provider.send("anvil_reset", [{
                forking: { jsonRpcUrl: this.rpcUrl, blockNumber },
              }]),
              60_000,
              `anvil_reset block ${blockNumber}`,
            ),
            controller.signal,
            blockNumber,
          );
          throwIfForkAborted(controller.signal, blockNumber);
          await waitForOwnedAnvil(
            this.provider,
            proc,
            3,
            50,
            `anvil reset block ${blockNumber} readiness`,
            blockNumber,
          );
          throwIfForkAborted(controller.signal, blockNumber);
          return;
        } catch (error) {
          // anvil_reset failed — fall through to kill/spawn only while this
          // serialized generation still owns the operation.
          await this.stopAndWait();
          throwIfForkAborted(controller.signal, blockNumber, error);
          await waitForForkRetry(controller.signal, blockNumber);
        }
      }

      throwIfForkAborted(controller.signal, blockNumber);
      await this.spawnForkAt(blockNumber, controller.signal);
      throwIfForkAborted(controller.signal, blockNumber);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      control.signal?.removeEventListener("abort", abortFromCaller);
      controller.signal.removeEventListener("abort", stopOnAbort);
    }
  }

  /*
   * Keep restartForkAt outside the hot forkAt ownership queue: victim replay
   * calls it only from an already exclusive StateBackend workflow.
   */
  private async restartForkAt(blockNumber: number): Promise<void> {
    await this.stopAndWait();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.spawnForkAt(blockNumber);
  }

  private async spawnForkAt(
    blockNumber: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfForkAborted(signal, blockNumber);
    await this.stopBarrier;
    throwIfForkAborted(signal, blockNumber);
    await assertLoopbackPortAvailable(this.port);
    throwIfForkAborted(signal, blockNumber);
    this.resetProvider();
    const proc = spawn("anvil", [
      "--fork-url", this.rpcUrl,
      "--fork-block-number", String(blockNumber),
      "--accounts", "0",
      "--port", String(this.port),
      "--silent",
      "--no-mining",
      "--order", "fifo",
    ], { stdio: "ignore" });
    this.proc = proc;
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
    });

    try {
      throwIfForkAborted(signal, blockNumber);
      await waitForOwnedAnvil(
        this.provider,
        proc,
        60,
        500,
        `anvil block ${blockNumber} readiness`,
        blockNumber,
      );
      throwIfForkAborted(signal, blockNumber);
    } catch (error) {
      if (this.proc === proc) await this.stopAndWait();
      throw error;
    }
  }

  /**
   * Fork to state immediately after `txHash`. Foundry/Anvil's
   * --fork-transaction-hash anchors the fork at the cumulative state including
   * that transaction, so callers must pass the previous tx when they need a
   * later tx's pre-state.
   */
  async forkAfterTx(txHash: string): Promise<void> {
    await this.stopAndWait();
    await new Promise((resolve) => setTimeout(resolve, 250)); // let port release

    await assertLoopbackPortAvailable(this.port);
    this.resetProvider();
    const proc = spawn("anvil", [
      "--fork-url", this.rpcUrl,
      "--fork-transaction-hash", txHash,
      "--accounts", "0",
      "--port", String(this.port),
      "--silent",
      "--no-mining",
      "--order", "fifo",
    ], { stdio: "ignore" });
    this.proc = proc;
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
    });

    try {
      await waitForOwnedAnvil(
        this.provider,
        proc,
        60,
        500,
        `anvil tx-hash ${txHash} readiness`,
      );
    } catch (error) {
      if (this.proc === proc) await this.stopAndWait();
      throw error;
    }
  }

  private resetProvider(): void {
    this.provider = makeAnvilProvider(this.anvilUrl);
  }

  async prepareVictimPostState(params: VictimStateParams): Promise<VictimStateResult> {
    const txIndex = params.transactionIndex;
    if (txIndex < 0) throw new Error(`invalid transactionIndex ${txIndex}`);
    if (txIndex === 0 || params.preferSequentialPrefix) {
      return this.prepareVictimPostStateByPrefix(params);
    }

    await this.forkAfterTx(params.txHash);

    const from = ethers.getAddress(params.from);
    const anchorNonce = await getTransactionCount(this.provider, from, "victim anchor");
    if (anchorNonce === params.nonce + 1) {
      return {
        mode: "tx-hash-anchor-post",
        appliedTxHash: params.txHash,
        nonceBefore: params.nonce,
        nonceAfter: anchorNonce,
        replayedPrefixCount: txIndex,
      };
    }
    if (anchorNonce !== params.nonce) {
      if (txIndex > 0) {
        return this.prepareVictimPostStateByPrefix(params);
      }
      throw new Error(
        `victim tx-hash anchor nonce mismatch: ${from} nonce=${anchorNonce}, ` +
          `expected ${params.nonce} or ${params.nonce + 1}`,
      );
    }

    const appliedTxHash = await this.applyRawTx(params.rawTx);
    if (appliedTxHash.toLowerCase() !== params.txHash.toLowerCase()) {
      throw new Error(`victim apply hash mismatch: ${appliedTxHash} != ${params.txHash}`);
    }

    const nonceAfter = await getTransactionCount(this.provider, from, "victim post");
    if (nonceAfter !== params.nonce + 1) {
      throw new Error(
        `victim post-state nonce mismatch: ${from} nonce=${nonceAfter}, expected ${params.nonce + 1}`,
      );
    }

    return {
      mode: "tx-hash-anchor-pre",
      appliedTxHash: params.txHash,
      nonceBefore: anchorNonce,
      nonceAfter,
      replayedPrefixCount: txIndex,
    };
  }

  private async prepareVictimPostStateByPrefix(
    params: VictimStateParams,
  ): Promise<VictimStateResult> {
    const txIndex = params.transactionIndex;
    const rawTxs = await this.queueHistoricalBlockPrefix(params.blockNumber, txIndex, {
      index: txIndex,
      rawTx: params.rawTx,
      expectedHash: params.txHash,
    });
    await this.mineQueuedHistoricalBlock(rawTxs, "victim-prefix-block");

    const appliedTxHash = rawTxs[rawTxs.length - 1];
    if (appliedTxHash.toLowerCase() !== params.txHash.toLowerCase()) {
      throw new Error(`victim apply hash mismatch: ${appliedTxHash} != ${params.txHash}`);
    }

    const from = ethers.getAddress(params.from);
    const nonceAfter = await getTransactionCount(this.provider, from, "prefix victim post");
    if (nonceAfter !== params.nonce + 1) {
      throw new Error(
        `victim post-state nonce mismatch: ${from} nonce=${nonceAfter}, expected ${params.nonce + 1}`,
      );
    }
    return {
      mode: "sequential-prefix",
      appliedTxHash,
      nonceBefore: params.nonce,
      nonceAfter,
      replayedPrefixCount: txIndex,
    };
  }

  /**
   * Fork the parent and queue the real historical FIFO prefix without mining it.
   * No account balance or nonce is rewritten: a transaction that was valid in
   * the historical block must be accepted from the historical parent state.
   * `throughIndex=-1` prepares an empty prefix at the exact block context.
   */
  async queueHistoricalBlockPrefix(
    blockNumber: number,
    throughIndex: number,
    override?: { index: number; rawTx: string; expectedHash: string },
  ): Promise<string[]> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
      throw new Error(`invalid historical block ${blockNumber}`);
    }
    if (!Number.isSafeInteger(throughIndex) || throughIndex < -1) {
      throw new Error(`invalid historical prefix index ${throughIndex}`);
    }
    await this.restartForkAt(blockNumber - 1);

    const archive = new ethers.JsonRpcProvider(this.rpcUrl);
    try {
      const block = await withTimeout(
        archive.send("eth_getBlockByNumber", ["0x" + blockNumber.toString(16), true]),
        60_000,
        `eth_getBlockByNumber ${blockNumber}`,
      );
      const txs = Array.isArray(block?.transactions) ? block.transactions : [];
      if (throughIndex >= txs.length) {
        throw new Error(`block ${blockNumber} missing tx index ${throughIndex}`);
      }
      await setNextBlockContext(this.provider, block);

      const rawTxs: string[] = [];
      for (let i = 0; i <= throughIndex; i++) {
        const expectedHash = txHashAt(txs, i);
        const raw = override?.index === i
          ? override.rawTx
          : await rawTxByHash(archive, expectedHash);
        const requiredHash = override?.index === i ? override.expectedHash : expectedHash;
        if (requiredHash.toLowerCase() !== expectedHash.toLowerCase()) {
          throw new Error(`historical override hash mismatch at index ${i}`);
        }
        rawTxs.push(await sendRawTxNoMine(this.provider, raw, expectedHash));
      }
      return rawTxs;
    } finally {
      archive.destroy();
    }
  }

  /**
   * Fork the historical parent and queue only the supplied raw transactions
   * under that block's timestamp/basefee. This is intentionally fail-closed:
   * sender balances and nonces are never rewritten, so a trigger that depends
   * on omitted prefix state cannot masquerade as an isolated causal trigger.
   */
  async queueHistoricalRawTransactions(
    blockNumber: number,
    transactions: Array<{ rawTx: string; expectedHash: string }>,
  ): Promise<string[]> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
      throw new Error(`invalid historical block ${blockNumber}`);
    }
    await this.restartForkAt(blockNumber - 1);

    const archive = new ethers.JsonRpcProvider(this.rpcUrl);
    try {
      const block = await withTimeout(
        archive.send("eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false]),
        60_000,
        `eth_getBlockByNumber ${blockNumber}`,
      );
      await setNextBlockContext(this.provider, block);
      const hashes: string[] = [];
      for (const transaction of transactions) {
        hashes.push(await sendRawTxNoMine(
          this.provider,
          transaction.rawTx,
          transaction.expectedHash,
        ));
      }
      return hashes;
    } finally {
      archive.destroy();
    }
  }

  async mineQueuedHistoricalBlock(txHashes: string[], label = "historical-block"): Promise<void> {
    await mineOne(this.provider, label, 180_000);
    for (let i = 0; i < txHashes.length; i++) {
      const receipt = await getReceipt(this.provider, txHashes[i], `${label} receipt ${i}`);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`${label} tx failed at index ${i}: ${txHashes[i]}`);
      }
    }
  }

  async applyRawTx(rawTx: string): Promise<string> {
    const hash = await withTimeout(
      this.provider.send("eth_sendRawTransaction", [rawTx]),
      45_000,
      "eth_sendRawTransaction victim",
    );
    await mineOne(this.provider, "victim", 120_000);
    const receipt = await getReceipt(this.provider, hash, "victim receipt");
    if (!receipt || receipt.status !== 1) {
      throw new Error(`victim apply failed: ${hash}`);
    }
    return hash;
  }

  async snapshot(): Promise<string> {
    return this.provider.send("evm_snapshot", []);
  }

  async revert(snapshotId: string): Promise<void> {
    await this.provider.send("evm_revert", [snapshotId]);
  }

  /**
   * Fork-reuse: (re-)fork at `blockNumber` and record a baseline snapshot.
   * This is the expensive (~seconds) anvil_reset — call it rarely (startup +
   * periodic refresh + when a specific block is required), NOT per hint.
   */
  async refreshFork(blockNumber: number): Promise<void> {
    await this.forkAt(blockNumber);
    this.baselineSnapshot = await this.snapshot();
    this.forkedBlock = blockNumber;
  }

  /**
   * Fork-reuse: cheaply (~ms) reset to the baseline instead of re-forking.
   * anvil's evm_revert consumes the snapshot, so we immediately re-snapshot to
   * keep the baseline valid for the next hint. Requires refreshFork() first.
   */
  async resetToBaseline(): Promise<void> {
    if (this.baselineSnapshot === null) {
      throw new Error("resetToBaseline: no baseline — call refreshFork() first");
    }
    await this.revert(this.baselineSnapshot);
    this.baselineSnapshot = await this.snapshot();
  }

  /**
   * Per-hint fork management: reset to baseline (~ms) while the fork is still
   * fresh, otherwise re-fork (~seconds) to pull recent state. Returns which.
   */
  async ensureFreshFork(latestBlock: number, refreshBlocks: number): Promise<"reset" | "refresh"> {
    if (this.baselineSnapshot === null || latestBlock - this.forkedBlock >= refreshBlocks) {
      await this.refreshFork(latestBlock);
      return "refresh";
    }
    await this.resetToBaseline();
    return "reset";
  }

  hasBaseline(): boolean {
    return this.baselineSnapshot !== null;
  }

  async call(
    req: { to: string; data: string; from?: string },
    control?: StateCallControl,
  ): Promise<string> {
    // Keep the existing ethers batching path for unbounded warm/solver reads.
    // Deadline-bound refinement calls use a dedicated request because ethers
    // does not expose a per-call AbortSignal and cancelling its wrapper leaves
    // the underlying HTTP request alive.
    if (control?.deadlineAtMs === undefined && control?.signal === undefined) {
      return withTimeout(this.provider.call(req), 30_000, `eth_call ${req.to}`);
    }
    return this.callWithControl(req, control);
  }

  private async callWithControl(
    req: { to: string; data: string; from?: string },
    control: StateCallControl,
  ): Promise<string> {
    const now = Date.now();
    const transportDeadlineAtMs = now + 30_000;
    const deadlineAtMs = earliestDeadline(transportDeadlineAtMs, control.deadlineAtMs)!;
    const abortKind: StateCallAbortedError["kind"] =
      control.deadlineAtMs !== undefined && control.deadlineAtMs <= transportDeadlineAtMs
        ? "deadline"
        : "timeout";
    if (control.signal?.aborted) {
      throw stateCallAbort(req.to, "signal", control.signal.reason);
    }
    if (deadlineAtMs <= now) {
      throw stateCallAbort(req.to, abortKind);
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(control.signal?.reason);
    control.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(
      () => controller.abort(stateCallAbort(req.to, abortKind)),
      Math.max(1, deadlineAtMs - now),
    );

    try {
      const payload: JsonRpcPayload = {
        id: 1,
        jsonrpc: "2.0",
        method: "eth_call",
        params: [this.provider.getRpcTransaction(req), "latest"],
      };
      const response = await postJsonRpc(
        this.anvilUrl,
        payload,
        controller.signal,
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(
          `eth_call ${req.to} HTTP ${response.statusCode} ${response.statusMessage}`,
        );
      }
      const body = response.body as Partial<JsonRpcError> & { result?: unknown };
      if (body.error) {
        throw this.provider.getRpcError(payload, body as JsonRpcError);
      }
      if (typeof body.result !== "string") {
        throw new Error(`eth_call ${req.to} returned a non-string result`);
      }
      return body.result;
    } catch (error) {
      if (controller.signal.aborted) {
        const kind = control.signal?.aborted ? "signal" : abortKind;
        throw stateCallAbort(req.to, kind, controller.signal.reason ?? error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async simulateTokenToNativeDelta(
    req: TokenToNativeDeltaRequest,
    control: StateCallControl = {},
  ): Promise<TokenToNativeDeltaResult> {
    if (req.amountIn <= 0n) {
      return { tokenInSpent: 0n, totalSupplyBurned: 0n, nativeOut: 0n };
    }
    const token = ethers.getAddress(req.token);
    const caller = ethers.getAddress(req.caller);
    if (!ethers.isHexString(req.callData)) {
      throw new Error("token-to-native simulation requires hex calldata");
    }
    const code = await this.callWithRpcControl(
      "eth_getCode",
      [token, "latest"],
      token,
      control,
    );
    if (typeof code !== "string" || code === "0x") {
      throw new Error(`token-to-native simulation target ${token} has no code`);
    }
    const codeHash = ethers.keccak256(code);
    const slot = await this.resolveTokenBalanceSlot(
      token,
      caller,
      codeHash,
      req.amountIn,
      control,
    );
    if (slot === null) {
      throw new Error(
        `token-to-native simulation cannot prove balance storage for ${token}`,
      );
    }

    const balanceData = ERC20.encodeFunctionData("balanceOf", [caller]);
    const supplyData = ERC20.encodeFunctionData("totalSupply");
    const raw = await this.callWithRpcControl(
      "eth_simulateV1",
      [{
        blockStateCalls: [{
          stateOverrides: {
            [token]: {
              stateDiff: {
                [slot]: ethers.toBeHex(req.amountIn, 32),
              },
            },
          },
          calls: [
            { from: caller, to: token, data: balanceData },
            { from: caller, to: token, data: supplyData },
            { from: caller, to: token, data: req.callData },
            { from: caller, to: token, data: balanceData },
            { from: caller, to: token, data: supplyData },
          ],
        }],
        validation: false,
        traceTransfers: true,
      }, "latest"],
      token,
      control,
    );
    const calls = simulationCalls(raw);
    if (calls.length !== 5 || calls.some((call) => call.status !== 1)) {
      throw new Error(`token-to-native simulation failed for ${token}`);
    }
    const balanceBefore = decodeUintCall(calls[0].returnData, "balance before");
    const supplyBefore = decodeUintCall(calls[1].returnData, "supply before");
    const balanceAfter = decodeUintCall(calls[3].returnData, "balance after");
    const supplyAfter = decodeUintCall(calls[4].returnData, "supply after");
    if (balanceAfter > balanceBefore || supplyAfter > supplyBefore) {
      throw new Error("token-to-native simulation observed increasing input state");
    }
    return {
      tokenInSpent: balanceBefore - balanceAfter,
      totalSupplyBurned: supplyBefore - supplyAfter,
      nativeOut: nativeTransfersToCaller(calls[2].logs, token, caller),
    };
  }

  private async resolveTokenBalanceSlot(
    token: string,
    caller: string,
    codeHash: string,
    probeValue: bigint,
    control: StateCallControl,
  ): Promise<string | null> {
    const memoKey = `${token.toLowerCase()}|${caller.toLowerCase()}|${codeHash}`;
    const memoized = tokenBalanceSlotMemo.get(memoKey);
    if (
      memoized !== undefined &&
      await this.verifyTokenBalanceSlot(
        token,
        caller,
        memoized,
        probeValue,
        control,
      )
    ) {
      return memoized;
    }
    tokenBalanceSlotMemo.delete(memoKey);

    const balanceData = ERC20.encodeFunctionData("balanceOf", [caller]);
    const candidates = new Set<string>();
    try {
      const raw = await this.callWithRpcControl(
        "eth_createAccessList",
        [{ from: caller, to: token, data: balanceData }, "latest"],
        token,
        control,
      ) as { accessList?: unknown };
      const accessList = Array.isArray(raw?.accessList) ? raw.accessList : [];
      for (const entry of accessList) {
        const item = entry as { address?: unknown; storageKeys?: unknown };
        if (
          typeof item.address !== "string" ||
          item.address.toLowerCase() !== token.toLowerCase() ||
          !Array.isArray(item.storageKeys)
        ) continue;
        for (const key of item.storageKeys) {
          if (typeof key === "string" && ethers.isHexString(key, 32)) {
            candidates.add(key.toLowerCase());
          }
        }
      }
    } catch {
      // A node may not implement eth_createAccessList. The verified bounded
      // Solidity/Vyper layout scan below remains fail closed.
    }
    const abi = ethers.AbiCoder.defaultAbiCoder();
    for (let slot = 0; slot < 32; slot++) {
      candidates.add(ethers.keccak256(
        abi.encode(["address", "uint256"], [caller, BigInt(slot)]),
      ));
      candidates.add(ethers.keccak256(
        abi.encode(["uint256", "address"], [BigInt(slot), caller]),
      ));
    }
    for (const candidate of [...candidates].slice(0, 128)) {
      if (
        await this.verifyTokenBalanceSlot(
          token,
          caller,
          candidate,
          probeValue,
          control,
        )
      ) {
        tokenBalanceSlotMemo.set(memoKey, candidate);
        return candidate;
      }
    }
    return null;
  }

  private async verifyTokenBalanceSlot(
    token: string,
    caller: string,
    slot: string,
    probeValue: bigint,
    control: StateCallControl,
  ): Promise<boolean> {
    const raw = await this.callWithRpcControl(
      "eth_simulateV1",
      [{
        blockStateCalls: [{
          stateOverrides: {
            [token]: { stateDiff: { [slot]: ethers.toBeHex(probeValue, 32) } },
          },
          calls: [{
            from: caller,
            to: token,
            data: ERC20.encodeFunctionData("balanceOf", [caller]),
          }],
        }],
        validation: false,
        traceTransfers: false,
      }, "latest"],
      token,
      control,
    );
    const [call] = simulationCalls(raw);
    if (!call || call.status !== 1) return false;
    try {
      return decodeUintCall(call.returnData, "balance slot") === probeValue;
    } catch {
      return false;
    }
  }

  private async callWithRpcControl(
    method: string,
    params: readonly unknown[],
    target: string,
    control: StateCallControl,
  ): Promise<unknown> {
    const now = Date.now();
    const transportDeadlineAtMs = now + 30_000;
    const deadlineAtMs = earliestDeadline(
      transportDeadlineAtMs,
      control.deadlineAtMs,
    )!;
    if (control.signal?.aborted) {
      throw stateCallAbort(target, "signal", control.signal.reason);
    }
    if (deadlineAtMs <= now) throw stateCallAbort(target, "deadline");
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(control.signal?.reason);
    control.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(
      () => controller.abort(stateCallAbort(target, "timeout")),
      Math.max(1, deadlineAtMs - now),
    );
    const payload: JsonRpcPayload = {
      id: 1,
      jsonrpc: "2.0",
      method,
      params: [...params],
    };
    try {
      const response = await postJsonRpc(this.anvilUrl, payload, controller.signal);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${method} HTTP ${response.statusCode}`);
      }
      const body = response.body as Partial<JsonRpcError> & { result?: unknown };
      if (body.error) throw this.provider.getRpcError(payload, body as JsonRpcError);
      return body.result;
    } catch (error) {
      if (controller.signal.aborted) {
        const kind = control.signal?.aborted ? "signal" : "timeout";
        throw stateCallAbort(target, kind, controller.signal.reason ?? error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async send(req: { from: string; to: string; data: string; gas?: string }): Promise<string> {
    const from = await prepareUnlockedSender(this.provider, req.from);
    const hash = await withTimeout(
      this.provider.send("eth_sendTransaction", [{ ...req, from }]),
      45_000,
      `eth_sendTransaction ${req.to}`,
    );
    await mineOne(this.provider, "send", 120_000);
    const receipt = await getReceipt(this.provider, hash, "send receipt");
    if (!receipt || receipt.status !== 1) {
      const detail = await traceRevert(this.provider, hash);
      throw new TransactionRevertedError(hash, detail || undefined);
    }
    return hash;
  }

  async getGasUsed(txHash: string): Promise<bigint> {
    const receipt = await getReceipt(this.provider, txHash, "gas used receipt");
    return receipt?.gasUsed ?? 0n;
  }

  async getTokenBalance(token: string, account: string): Promise<bigint> {
    const data = ERC20.encodeFunctionData("balanceOf", [account]);
    const result = await this.call({ to: token, data });
    return BigInt(result);
  }
}

function redactSpawnDiagnostic(value: string): string {
  return value
    .replace(/(?:https?|wss?):\/\/[^\s"'`]+/gi, "<redacted-url>")
    .replace(/[\r\n]+/g, " | ")
    .slice(-2_000);
}

async function traceRevert(provider: ethers.JsonRpcProvider, txHash: string): Promise<string> {
  try {
    const trace = await withTimeout(
      provider.send("debug_traceTransaction", [txHash, { tracer: "callTracer" }]),
      30_000,
      `debug_traceTransaction ${txHash}`,
    );
    const failed = findFailedCall(trace);
    if (!failed) return "";
    const to = typeof failed.to === "string" ? failed.to : "unknown";
    const input = typeof failed.input === "string" ? failed.input.slice(0, 10) : "0x";
    const err = typeof failed.error === "string" ? failed.error : "call failed";
    return `[failed to=${to} selector=${input} error=${err}]`;
  } catch {
    return "";
  }
}

function findFailedCall(node: any): any | null {
  if (!node || typeof node !== "object") return null;
  const calls = Array.isArray(node.calls) ? node.calls : [];
  for (const child of calls) {
    const found = findFailedCall(child);
    if (found) return found;
  }
  if (node.error) return node;
  return null;
}

function txHashAt(txs: any[], index: number): string {
  const tx = txs[index];
  const hash = typeof tx === "string" ? tx : tx?.hash;
  if (typeof hash !== "string" || !hash.startsWith("0x")) {
    throw new Error(`missing tx hash at block index ${index}`);
  }
  return hash;
}

async function rawTxByHash(
  provider: ethers.JsonRpcProvider,
  txHash: string,
): Promise<string> {
  const raw = await withTimeout(
    provider.send("eth_getRawTransactionByHash", [txHash]),
    45_000,
    `eth_getRawTransactionByHash ${txHash}`,
  );
  if (typeof raw !== "string" || !raw.startsWith("0x")) {
    const tx = await withTimeout(
      provider.getTransaction(txHash),
      45_000,
      `getTransaction ${txHash}`,
    );
    if (!tx) throw new Error(`missing raw tx for ${txHash}`);
    return ethers.Transaction.from({
      type: tx.type,
      to: tx.to,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      data: tx.data,
      value: tx.value,
      chainId: tx.chainId,
      accessList: tx.accessList,
      signature: tx.signature,
    }).serialized;
  }
  return raw;
}

async function sendRawTxNoMine(
  provider: ethers.JsonRpcProvider,
  rawTx: string,
  expectedHash: string,
): Promise<string> {
  const hash = await withTimeout(
    provider.send("eth_sendRawTransaction", [rawTx]),
    45_000,
    `eth_sendRawTransaction ${expectedHash}`,
  );
  if (typeof hash !== "string" || hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`raw tx hash mismatch: sent=${hash} expected=${expectedHash}`);
  }
  return hash;
}

async function prepareUnlockedSender(
  provider: ethers.JsonRpcProvider,
  account: string,
): Promise<string> {
  const from = await ensureAccountGasFloor(provider, account);
  await provider.send("anvil_impersonateAccount", [from]);
  return from;
}

async function ensureAccountGasFloor(
  provider: ethers.JsonRpcProvider,
  account: string,
): Promise<string> {
  const from = ethers.getAddress(account);
  const balance = await withTimeout(
    provider.getBalance(from, "latest"),
    30_000,
    `getBalance ${from}`,
  );
  if (balance < LOCAL_FORK_GAS_BALANCE_FLOOR) {
    await provider.send("anvil_setBalance", [
      from,
      "0x" + LOCAL_FORK_GAS_BALANCE_FLOOR.toString(16),
    ]);
  }
  return from;
}

async function setNextBlockContext(provider: ethers.JsonRpcProvider, block: any): Promise<void> {
  if (typeof block?.timestamp === "string") {
    await provider.send("evm_setNextBlockTimestamp", [Number(BigInt(block.timestamp))]);
  }
  if (typeof block?.baseFeePerGas === "string") {
    try {
      await provider.send("anvil_setNextBlockBaseFeePerGas", [block.baseFeePerGas]);
    } catch {
      // Older anvil builds may not support this. The raw tx gas cap will fail
      // loudly if basefee mismatch matters for the fixture.
    }
  }
}

async function mineOne(provider: ethers.JsonRpcProvider, label: string, timeoutMs: number): Promise<void> {
  try {
    await withTimeout(provider.send("anvil_mine", ["0x1"]), timeoutMs, `anvil_mine ${label}`);
  } catch {
    await withTimeout(provider.send("evm_mine", []), timeoutMs, `evm_mine ${label}`);
  }
}

function getTransactionCount(
  provider: ethers.JsonRpcProvider,
  address: string,
  label: string,
): Promise<number> {
  return withTimeout(
    provider.getTransactionCount(address, "latest"),
    45_000,
    `getTransactionCount ${label}`,
  );
}

function getReceipt(
  provider: ethers.JsonRpcProvider,
  txHash: string,
  label: string,
): Promise<ethers.TransactionReceipt | null> {
  return withTimeout(
    provider.getTransactionReceipt(txHash),
    45_000,
    `getTransactionReceipt ${label}`,
  );
}

function waitForChildExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let forceTimer: NodeJS.Timeout;
    let releaseTimer: NodeJS.Timeout;
    const settled = (): void => {
      clearTimeout(forceTimer);
      clearTimeout(releaseTimer);
      proc.removeListener("exit", settled);
      proc.removeListener("error", settled);
      resolve();
    };
    forceTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, 2_000);
    releaseTimer = setTimeout(settled, 5_000);
    forceTimer.unref();
    releaseTimer.unref();
    proc.once("exit", settled);
    proc.once("error", settled);
  });
}

export interface JsonRpcHttpResponse {
  statusCode: number;
  statusMessage: string;
  body: unknown;
  /** True when Node reused an existing keep-alive socket for this request. */
  reusedSocket: boolean;
}

/*
 * Reuse transport sockets across source-pinned JSON-RPC batches. Agents still
 * keep separate pools per origin, while the caller-owned AbortSignal destroys
 * an interrupted request/socket so it cannot return to the free pool.
 * Request concurrency remains owned by the existing schedulers.
 */
const JSON_RPC_HTTP_AGENT = new HttpAgent({ keepAlive: true });
const JSON_RPC_HTTPS_AGENT = new HttpsAgent({ keepAlive: true });

/**
 * Send one JSON-RPC request on a transport whose socket we own. Node's fetch
 * may reject an aborted Promise while retaining/draining the underlying
 * keep-alive request. Refinement deadlines require the RPC itself to stop, so
 * explicitly destroy both request and response when the signal fires.
 */
export function postJsonRpc(
  endpoint: string,
  payload: JsonRpcPayload,
  signal: AbortSignal,
): Promise<JsonRpcHttpResponse> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  const url = new URL(endpoint);
  const requestFn = url.protocol === "https:"
    ? requestHttps
    : url.protocol === "http:"
      ? requestHttp
      : null;
  const agent = url.protocol === "https:"
    ? JSON_RPC_HTTPS_AGENT
    : JSON_RPC_HTTP_AGENT;
  if (requestFn === null) {
    return Promise.reject(new Error(`unsupported JSON-RPC protocol ${url.protocol}`));
  }
  const encoded = Buffer.from(JSON.stringify(payload));

  return new Promise<JsonRpcHttpResponse>((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | null = null;
    let request: ClientRequest;

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      const reason = abortReason(signal);
      response?.destroy(reason);
      request.destroy(reason);
      rejectOnce(reason);
    };

    request = requestFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(encoded.length),
        connection: "keep-alive",
      },
      agent,
    }, (incoming) => {
      response = incoming;
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("aborted", () => rejectOnce(abortReason(signal)));
      incoming.once("error", rejectOnce);
      incoming.once("end", () => {
        if (settled) return;
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = JSON.parse(raw) as unknown;
          settled = true;
          cleanup();
          resolve({
            statusCode: incoming.statusCode ?? 0,
            statusMessage: incoming.statusMessage ?? "",
            body,
            reusedSocket: request.reusedSocket,
          });
        } catch (error) {
          rejectOnce(error);
        }
      });
    });
    request.once("error", rejectOnce);
    signal.addEventListener("abort", onAbort, { once: true });
    request.end(encoded);
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("JSON-RPC request aborted", { cause: signal.reason });
}

async function assertLoopbackPortAvailable(port: number): Promise<void> {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`invalid anvil port ${port}`);
  }
  const server = createNetServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error);
      server.once("error", onError);
      server.listen(
        { host: "127.0.0.1", port, exclusive: true },
        () => {
          server.removeListener("error", onError);
          resolveListen();
        },
      );
    });
  } catch (error) {
    throw new Error(
      `anvil port ${port} is already owned by another process`,
      { cause: error },
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }
}

async function waitForOwnedAnvil(
  provider: ethers.JsonRpcProvider,
  proc: ChildProcess,
  attempts: number,
  retryMs: number,
  label: string,
  expectedBlock?: number,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`${label}: spawned process exited before readiness`);
    }
    try {
      await withTimeout(provider.send("eth_chainId", []), 2_000, label);
      const clientVersion = await withTimeout(
        provider.send("web3_clientVersion", []),
        2_000,
        `${label} client ownership`,
      );
      if (
        typeof clientVersion !== "string" ||
        !clientVersion.toLowerCase().includes("anvil")
      ) {
        throw new Error(`${label}: endpoint is not the spawned Anvil`);
      }
      if (expectedBlock !== undefined) {
        const blockNumber = await withTimeout(
          provider.send("eth_blockNumber", []),
          2_000,
          `${label} block anchor`,
        );
        if (
          typeof blockNumber !== "string" ||
          Number(BigInt(blockNumber)) !== expectedBlock
        ) {
          throw new Error(
            `${label}: endpoint block ${String(blockNumber)} != ${expectedBlock}`,
          );
        }
      }
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`${label}: spawned process does not own the endpoint`);
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts`,
    lastError === null ? undefined : { cause: lastError },
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Reject the reset owner as soon as its generation is cancelled, even when
 * the JSON-RPC promise itself ignores process teardown. The original promise
 * remains observed by the handlers below, so a late rejection cannot become
 * unhandled; more importantly, only the serialized owner decides whether a
 * reset failure may fall back to spawning a replacement process.
 */
function awaitAbortableForkOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  blockNumber: number,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(forkAbortError(signal, blockNumber));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(forkAbortError(signal, blockNumber));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function throwIfForkAborted(
  signal: AbortSignal | undefined,
  blockNumber: number,
  cause?: unknown,
): void {
  if (!signal?.aborted) return;
  throw forkAbortError(signal, blockNumber, cause);
}

function forkAbortError(
  signal: AbortSignal,
  blockNumber: number,
  cause?: unknown,
): StateCallAbortedError {
  if (signal.reason instanceof StateCallAbortedError) {
    return signal.reason;
  }
  return new StateCallAbortedError(
    `anvil fork block ${blockNumber} aborted: caller signal aborted`,
    "signal",
    signal.reason === undefined && cause === undefined
      ? undefined
      : { cause: signal.reason ?? cause },
  );
}

function waitForForkRetry(
  signal: AbortSignal,
  blockNumber: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 250);
  });
  return awaitAbortableForkOperation(
    delay.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    signal,
    blockNumber,
  );
}

function earliestDeadline(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function combineAbortSignals(
  parent: AbortSignal | undefined,
  nested: AbortSignal | undefined,
): AbortSignal | undefined {
  if (parent === undefined) return nested;
  if (nested === undefined || nested === parent) return parent;
  return AbortSignal.any([parent, nested]);
}

interface SimulatedCallEvidence {
  readonly status: number;
  readonly returnData: string;
  readonly logs: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  }[];
}

export function simulationCalls(value: unknown): readonly SimulatedCallEvidence[] {
  const block = Array.isArray(value) ? value[0] as { calls?: unknown } : null;
  const calls = block && Array.isArray(block.calls) ? block.calls : [];
  return calls.map((entry): SimulatedCallEvidence => {
    const call = entry as {
      status?: unknown;
      returnData?: unknown;
      logs?: unknown;
    };
    let status = 0;
    try {
      status = Number(BigInt(String(call.status ?? "0x0")));
    } catch {
      status = 0;
    }
    const logs = Array.isArray(call.logs)
      ? call.logs.flatMap((entry) => {
          const log = entry as {
            address?: unknown;
            topics?: unknown;
            data?: unknown;
          };
          if (
            typeof log.address !== "string" ||
            !Array.isArray(log.topics) ||
            typeof log.data !== "string"
          ) return [];
          return [{
            address: log.address,
            topics: log.topics.filter(
              (topic): topic is string => typeof topic === "string",
            ),
            data: log.data,
          }];
        })
      : [];
    return {
      status,
      returnData:
        typeof call.returnData === "string" ? call.returnData : "0x",
      logs,
    };
  });
}

export function decodeUintCall(data: string, label: string): bigint {
  if (!ethers.isHexString(data) || ethers.dataLength(data) < 32) {
    throw new Error(`token-to-native ${label} returned invalid data`);
  }
  return BigInt(data);
}

export function nativeTransfersToCaller(
  logs: readonly SimulatedCallEvidence["logs"][number][],
  token: string,
  caller: string,
): bigint {
  let total = 0n;
  for (const log of logs) {
    if (
      log.address.toLowerCase() !== SYNTHETIC_NATIVE_TRANSFER_EMITTER ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
      topicAddress(log.topics[1]) !== token.toLowerCase() ||
      topicAddress(log.topics[2]) !== caller.toLowerCase()
    ) continue;
    total += BigInt(log.data);
  }
  return total;
}

function topicAddress(topic: string | undefined): string {
  if (!topic || !ethers.isHexString(topic, 32)) return "";
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function stateCallAbort(
  target: string,
  kind: StateCallAbortedError["kind"],
  cause?: unknown,
): StateCallAbortedError {
  const reason = kind === "deadline"
    ? "absolute deadline reached"
    : kind === "timeout"
      ? "30-second transport timeout reached"
      : "caller signal aborted";
  return new StateCallAbortedError(
    `eth_call ${target} aborted: ${reason}`,
    kind,
    cause === undefined ? undefined : { cause },
  );
}
