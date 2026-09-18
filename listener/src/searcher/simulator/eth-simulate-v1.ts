import { isDeepStrictEqual } from "node:util";
import { getBytes, Interface } from "ethers";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { bytesToHex } from "../../shared/compiler/encoder.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { postJsonRpc, StateCallAbortedError } from "../../shared/state/state-backend.js";
import type { BlockScanObservedHeader } from "../blockscan-observed-header.js";
import { nextBlockBaseFee } from "../ev-evaluator.js";
import { isRpcThrottleError } from "../rpc-throttle-guard.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { SimulationResult } from "./botvm-simulator.js";

const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TX_GAS = 0x1000000n; // Same original transaction limit as BotVMSimulator.
const OWNER_GAS_BALANCE = 10_000n * 10n ** 18n;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const hex = (value: bigint | number): string => `0x${value.toString(16)}`;

type Context = {
  source: CanonicalSource;
  header: BlockScanObservedHeader;
  signal: AbortSignal;
  deadlineAtMs: number;
};

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** Versioned, endpoint-free snapshot. Source identity retains CanonicalSource's
 * safe integers; all source-header quantities are canonical decimal strings.
 * The two parameter tuples are the exact wire payloads, not RPC method names.
 */
export type EthSimulateV1ExecutionInput = DeepReadonly<ReturnType<typeof prepareExecutionInput>>;

/** Pure preparation from an already compiled script: no quote, compilation, I/O
 * or deadline dependency. Every nested object is owned by the frozen snapshot. */
export function buildEthSimulateV1ExecutionInput(input: {
  source: CanonicalSource; header: BlockScanObservedHeader; executor: string;
  owner: string; profitToken: string; scriptHex: string;
}): EthSimulateV1ExecutionInput {
  return freezeInput(prepareExecutionInput(input));
}

function prepareExecutionInput({ source, header, executor, owner, profitToken, scriptHex }: {
  source: CanonicalSource; header: BlockScanObservedHeader; executor: string;
  owner: string; profitToken: string; scriptHex: string;
}) {
  const blockOverrides = targetContext(source, header);
  validateCaller(executor, owner);
  if (typeof profitToken !== "string" || !ADDRESS.test(profitToken) ||
      typeof scriptHex !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(scriptHex)) {
    throw new Error("invalid final simulation profit token or script");
  }
  const calldata = buildExecuteCalldata(getBytes(scriptHex));
  const pinnedBlock = { blockHash: source.hash, requireCanonical: true as const };
  // The zero-address observation cannot spend owner funds or change main state.
  const observer = { from: ZERO_ADDRESS, to: profitToken,
    data: ERC20.encodeFunctionData("balanceOf", [executor]), gasPrice: "0x0" };
  return {
    schemaVersion: 1 as const,
    source: { number: source.number, hash: source.hash, generation: source.generation },
    sourceHeader: { number: String(header.number), hash: header.hash, parentHash: header.parentHash,
      timestamp: String(header.timestamp), baseFeePerGas: header.baseFeePerGas!.toString(),
      gasUsed: header.gasUsed.toString(), gasLimit: header.gasLimit.toString() },
    executor, owner, profitToken, scriptHex, calldata,
    preBalanceParams: [{ ...observer, gas: blockOverrides.gasLimit }, pinnedBlock] as const,
    simulateParams: [{
      blockStateCalls: [{ blockOverrides,
        stateOverrides: { [owner]: { balance: hex(OWNER_GAS_BALANCE) } },
        calls: [
          { from: owner, to: executor, data: calldata, value: "0x0",
            gas: hex(TX_GAS), gasPrice: blockOverrides.baseFeePerGas },
          { ...observer, gas: hex(header.gasLimit - TX_GAS) },
        ] as const,
      }] as const,
      validation: false as const, traceTransfers: false as const, returnFullTransactions: false as const,
    }, pinnedBlock] as const,
  };
}

/** Saved primary fields must rebuild every payload exactly, including all keys.
 * Returns a new frozen canonical snapshot, never caller-owned RPC parameters.
 * This checks consistency/policy, not authenticity of the original recording.
 */
export function validateEthSimulateV1ExecutionInput(value: unknown): EthSimulateV1ExecutionInput {
  try {
    const saved = record(value), source = record(saved?.source), header = record(saved?.sourceHeader);
    if (!saved || saved.schemaVersion !== 1 || !source || !header ||
        typeof source.number !== "number" || typeof source.hash !== "string" ||
        typeof source.generation !== "number" || typeof header.hash !== "string" ||
        typeof header.parentHash !== "string" || typeof saved.executor !== "string" ||
        typeof saved.owner !== "string" || typeof saved.profitToken !== "string" ||
        typeof saved.scriptHex !== "string") throw new Error();
    const decimal = (field: unknown): bigint => {
      if (typeof field !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(field)) throw new Error();
      return BigInt(field);
    };
    const canonical = buildEthSimulateV1ExecutionInput({
      source: { number: source.number, hash: source.hash, generation: source.generation },
      header: { number: Number(decimal(header.number)), hash: header.hash, parentHash: header.parentHash,
        timestamp: Number(decimal(header.timestamp)), baseFeePerGas: decimal(header.baseFeePerGas),
        gasUsed: decimal(header.gasUsed), gasLimit: decimal(header.gasLimit), transactionHashes: [] },
      executor: saved.executor, owner: saved.owner, profitToken: saved.profitToken, scriptHex: saved.scriptHex,
    });
    if (!isDeepStrictEqual(value, canonical)) throw new Error();
    return canonical;
  } catch {
    // Never echo untrusted saved data (or a decoder's unsanitized cause).
    throw new Error("invalid final simulation execution input");
  }
}

function freezeInput<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeInput(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function validateCaller(executor: string, owner: string): void {
  if (typeof executor !== "string" || typeof owner !== "string" ||
      !ADDRESS.test(executor) || !ADDRESS.test(owner) || owner.toLowerCase() === ZERO_ADDRESS ||
      executor.toLowerCase() === owner.toLowerCase()) {
    throw new Error("invalid final simulation caller");
  }
}

/** Stateless final simulation; the existing scheduler owns generation fencing.
 * Only the owner's native gas balance is overridden (exactly 10,000 ETH, unlike
 * Anvil's minimum floor). No token/code/storage/nonce overrides are installed.
 * Target policy: N+1, timestamp+12, parent gas limit, exact next EIP-1559 fee,
 * zero priority fee. Other target header fields retain endpoint semantics.
 */
export class EthSimulateV1Simulator {
  constructor(
    private readonly rpcUrl: string,
    readonly executor: string,
    readonly owner: string,
  ) {
    validateCaller(executor, owner);
  }

  async simulate(plan: ResolvedPlan, context: Context): Promise<SimulationResult> {
    const { source, header, signal, deadlineAtMs } = context;
    targetContext(source, header);
    if (!Number.isSafeInteger(deadlineAtMs) || !signal || !ADDRESS.test(plan.profitToken)) {
      throw new Error("invalid final simulation control or profit token");
    }
    const profitToken = plan.profitToken;
    // Keep the original pre-compilation cancellation boundary. Synchronous
    // compilation needs no timer/listener; replay checks the deadline again.
    if (signal.aborted) throw new StateCallAbortedError("final simulation signal aborted", "signal");
    if (Date.now() >= deadlineAtMs) throw new StateCallAbortedError("final simulation deadline aborted", "deadline");
    const scriptHex = bytesToHex(compilePlan(plan.root, this.executor));
    const input = buildEthSimulateV1ExecutionInput({ source, header, executor: this.executor,
      owner: this.owner, profitToken, scriptHex });
    return this.simulateExecutionInput(input, { signal, deadlineAtMs });
  }

  /** Read-only diagnostic replay. Production still owns the latest-head gate. */
  async simulateExecutionInput(input: EthSimulateV1ExecutionInput,
    control: { signal: AbortSignal; deadlineAtMs: number }): Promise<SimulationResult> {
    const saved = validateEthSimulateV1ExecutionInput(input);
    if (saved.executor.toLowerCase() !== this.executor.toLowerCase() ||
        saved.owner.toLowerCase() !== this.owner.toLowerCase()) {
      throw new Error("final simulation execution input caller mismatch");
    }
    const { signal, deadlineAtMs } = control;
    if (!Number.isSafeInteger(deadlineAtMs) || !signal) {
      throw new Error("invalid final simulation control or profit token");
    }
    const { profitToken, calldata, scriptHex, preBalanceParams, simulateParams } = saved;
    const blockOverrides = simulateParams[0].blockStateCalls[0].blockOverrides;
    const pinnedBlock = simulateParams[1];
    const controller = new AbortController();
    const cancel = (kind: "signal" | "deadline"): void => {
      if (!controller.signal.aborted) {
        controller.abort(new StateCallAbortedError(`final simulation ${kind} aborted`, kind));
      }
    };
    const onAbort = (): void => cancel("signal");
    const assertOpen = (): void => {
      if (signal.aborted) cancel("signal");
      if (Date.now() >= deadlineAtMs) cancel("deadline");
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = (): void => {
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) { cancel("deadline"); return; }
      timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    };
    const request = async (id: number, method: "eth_call" | "eth_simulateV1", params: readonly unknown[]): Promise<unknown> => {
      assertOpen();
      let response;
      try {
        response = await postJsonRpc(this.rpcUrl, { jsonrpc: "2.0", id, method, params }, controller.signal);
      } catch (error) {
        assertOpen();
        if (error instanceof SyntaxError) throw new SyntaxError("final simulation response contained invalid JSON");
        throw new Error("final simulation transport failed");
      }
      assertOpen();
      const body = record(response.body);
      const validEnvelope = body?.jsonrpc === "2.0" && body.id === id;
      const error = validEnvelope ? record(body.error) : null;
      const code = error && Number.isSafeInteger(error.code) ? error.code as number : undefined;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Object.assign(new Error(`final simulation HTTP ${response.statusCode}`), {
          // Keep a revert-shaped RPC code from masking HTTP throttling in policy.
          statusCode: response.statusCode, ...(code === undefined ? {} : { rpcCode: code }),
        });
      }
      if (!validEnvelope || !body || Object.hasOwn(body, "error") === Object.hasOwn(body, "result")) {
        throw new Error("invalid final simulation JSON-RPC envelope");
      }
      if (Object.hasOwn(body, "error")) throw rpcFailure(body.error);
      return body.result;
    };
    try {
      assertOpen();
      signal.addEventListener("abort", onAbort, { once: true });
      armDeadline();
      const pre = balance(await request(1, "eth_call", preBalanceParams));
      const observerGas = quantity(blockOverrides.gasLimit) - TX_GAS;
      const raw = await request(2, "eth_simulateV1", simulateParams);
      if (!Array.isArray(raw) || raw.length !== 1) throw new Error("invalid final simulation block count");
      const block = record(raw[0]);
      if (!block || typeof block.parentHash !== "string" || !HASH.test(block.parentHash) ||
          block.parentHash.toLowerCase() !== pinnedBlock.blockHash.toLowerCase() ||
          quantity(block.number) !== quantity(blockOverrides.number) ||
          quantity(block.timestamp) !== quantity(blockOverrides.time) ||
          quantity(block.gasLimit) !== quantity(blockOverrides.gasLimit) ||
          quantity(block.baseFeePerGas) !== quantity(blockOverrides.baseFeePerGas)) {
        throw new Error("final simulation source or target header mismatch");
      }
      if (!Array.isArray(block.calls) || block.calls.length !== 2) {
        throw new Error("invalid final simulation call count");
      }
      const main = parseCall(block.calls[0], TX_GAS);
      const post = parseCall(block.calls[1], observerGas);
      if (post.status !== "0x1") throw rpcFailure(post.error);
      const postBalance = balance(post.returnData);
      assertOpen();
      if (main.status === "0x0") {
        // Only the explicit execution-reverted RPC code is a confirmed revert.
        // Unknown VM/validation/provider failures remain thrown, never cached as
        // route reverts. Remote error text and data are deliberately discarded.
        const error = record(main.error);
        if (error?.code !== 3) throw rpcFailure(main.error);
        const cause = Object.assign(new Error("final simulation transaction reverted"), {
          kind: "revert", code: "TRANSACTION_REVERTED",
        });
        return { success: false, profitToken, grossProfit: 0n, gasUsed: 0n, netProfit: 0n,
          calldata, scriptHex, revertReason: cause.message,
          failure: { kind: "revert", code: "TRANSACTION_REVERTED", cause } };
      }
      const grossProfit = postBalance - pre;
      return { success: grossProfit > 0n, profitToken, grossProfit,
        gasUsed: grossProfit > 0n ? quantity(main.gasUsed) : 0n,
        netProfit: grossProfit, calldata, scriptHex };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function targetContext(source: CanonicalSource, header: BlockScanObservedHeader) {
  if (!source || !header || !Number.isSafeInteger(source.number) || source.number < 0 ||
      !Number.isSafeInteger(source.number + 1) || typeof source.hash !== "string" || !HASH.test(source.hash) ||
      !Number.isSafeInteger(source.generation) || source.generation < 0 ||
      source.number !== header.number || typeof header.hash !== "string" || !HASH.test(header.hash) ||
      source.hash.toLowerCase() !== header.hash.toLowerCase() ||
      typeof header.parentHash !== "string" || !HASH.test(header.parentHash) ||
      !Number.isSafeInteger(header.timestamp) || header.timestamp < 0 ||
      !Number.isSafeInteger(header.timestamp + 12) || typeof header.baseFeePerGas !== "bigint" ||
      header.baseFeePerGas <= 0n || typeof header.gasLimit !== "bigint" || header.gasLimit <= TX_GAS ||
      typeof header.gasUsed !== "bigint" || header.gasUsed < 0n || header.gasUsed > header.gasLimit) {
    throw new Error("invalid final simulation source header");
  }
  const baseFee = nextBlockBaseFee(header);
  if (baseFee === null || baseFee <= 0n) throw new Error("final simulation next base fee unavailable");
  return { number: hex(source.number + 1), time: hex(header.timestamp + 12),
    gasLimit: hex(header.gasLimit), baseFeePerGas: hex(baseFee) };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) {
    throw new Error("invalid final simulation quantity");
  }
  return BigInt(value);
}

function balance(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("invalid final simulation balance result");
  }
  return BigInt(value);
}

function rpcFailure(value: unknown): Error {
  const error = record(value);
  if (!error || !Number.isSafeInteger(error.code) || typeof error.message !== "string") {
    return new Error("invalid final simulation RPC error");
  }
  return Object.assign(new Error(isRpcThrottleError(error)
    ? `final simulation HTTP 429 RPC throttle code ${error.code}`
    : `final simulation RPC error code ${error.code}`), { code: error.code });
}

function parseCall(value: unknown, gasLimit: bigint): Record<string, unknown> {
  const call = record(value);
  if (!call || (call.status !== "0x0" && call.status !== "0x1") ||
      typeof call.returnData !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.returnData) ||
      quantity(call.gasUsed) <= 0n || quantity(call.gasUsed) > gasLimit) {
    throw new Error("invalid final simulation call result");
  }
  const error = record(call.error);
  if (call.status === "0x1" ? Object.hasOwn(call, "error") :
      !error || !Number.isSafeInteger(error.code) || typeof error.message !== "string") {
    throw new Error("inconsistent final simulation call status");
  }
  return call;
}
