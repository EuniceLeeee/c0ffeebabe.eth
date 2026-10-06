import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { getBytes, Interface, keccak256, toUtf8Bytes } from "ethers";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { bytesToHex } from "../../shared/compiler/encoder.js";
import { buildExecuteCalldata, type BotVmRuntimeCode } from "../../shared/executor/botvm-executor.js";
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
// Code-only eth_simulateV1 state override: never deployed or sent on chain.
// Neither synthetic infrastructure address may alias a participant.
// Both observations have the same msg.sender (OBSERVER) and tx.origin (sender).
// The sender's transaction nonce advances, but never the owner's/executor's.
const OBSERVER = `0x${keccak256(toUtf8Bytes("mev.static-balance-observer.v3")).slice(-40)}`;
const OBSERVER_SENDER = `0x${keccak256(toUtf8Bytes("mev.static-balance-observer.sender.v3")).slice(-40)}`;
const BALANCE_TAG = keccak256(toUtf8Bytes("mev.static-balance-observer.result.v3"));
const MIN_OBSERVER_GAS = 30_000n;

/** STATICCALL balanceOf(executor), require success and exactly 32 bytes, then
 * RETURN(tag || balance). Failure always reverts empty; token revert bytes are
 * never forwarded. No SSTORE, transfer, deployment or retained logs are possible.
 * The code-only overlay preserves this synthetic account's balance/storage and
 * avoids creation probes' different pre/post balanceOf callers. */
function observerCode(profitToken: string, executor: string): string {
  const prefix = `6370a0823160e01b60005273${executor.slice(2)}600452` +
    `602060206024600073${profitToken.slice(2)}5afa3d60201416`;
  const successOffset = prefix.length / 2 + 8;
  return `0x${prefix}60${successOffset.toString(16).padStart(2, "0")}5760006000fd` +
    `5b7f${BALANCE_TAG.slice(2)}60005260406000f3`;
}

type Context = {
  source: CanonicalSource;
  header: BlockScanObservedHeader;
  signal: AbortSignal;
  deadlineAtMs: number;
};

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** Versioned, endpoint-free snapshot. Source identity retains CanonicalSource's
 * safe integers; all source-header quantities are canonical decimal strings.
 * Schema 3 measures pre/post in N+1, excluding passive N→N+1 yield. Schemas
 * 1/2 retain their original N pre-balance and exact two-request wire replay.
 */
export type EthSimulateV1ExecutionInput = DeepReadonly<ReturnType<typeof prepareExecutionInput> |
  ReturnType<typeof prepareLegacyExecutionInput>>;
export type EthSimulateV1SimulationResult = SimulationResult & {
  readonly counterfactualExecutorCode?: { readonly address: string; readonly keccak256: string };
};

/** Pure preparation from an already compiled script: no quote, compilation, I/O
 * or deadline dependency. Every nested object is owned by the frozen snapshot. */
export function buildEthSimulateV1ExecutionInput(input: {
  source: CanonicalSource; header: BlockScanObservedHeader; executor: string;
  owner: string; profitToken: string; scriptHex: string;
  executorRuntimeCode?: BotVmRuntimeCode;
}) {
  return freezeInput(prepareExecutionInput(input));
}

type PreparationInput = {
  source: CanonicalSource; header: BlockScanObservedHeader; executor: string;
  owner: string; profitToken: string; scriptHex: string;
  executorRuntimeCode?: BotVmRuntimeCode;
};

function prepareExecutionInput(input: PreparationInput) {
  const legacy = prepareLegacyExecutionInput(input);
  const { preBalanceParams: _pre, schemaVersion: _version, simulateParams, ...primary } = legacy;
  if ([input.owner, input.executor, input.profitToken].some(address =>
    [OBSERVER, OBSERVER_SENDER].includes(address.toLowerCase()))) {
    throw new Error("invalid final simulation observer collision");
  }
  const remainingGas = input.header.gasLimit - TX_GAS;
  // Also respect the transaction gas ceiling when the block is much larger.
  const half = remainingGas / 2n;
  const preGas = half < TX_GAS ? half : TX_GAS;
  const rest = remainingGas - preGas;
  const postGas = rest < TX_GAS ? rest : TX_GAS;
  if (preGas < MIN_OBSERVER_GAS || postGas < MIN_OBSERVER_GAS) {
    throw new Error("insufficient final simulation observer gas");
  }
  const block = simulateParams[0].blockStateCalls[0];
  const observer = { from: OBSERVER_SENDER, to: OBSERVER, data: "0x", value: "0x0", gasPrice: "0x0" };
  return { ...primary, schemaVersion: 3 as const,
    simulateParams: [{ ...simulateParams[0], blockStateCalls: [{ ...block,
      stateOverrides: { ...block.stateOverrides,
        [OBSERVER]: { code: observerCode(input.profitToken, input.executor) } },
      calls: [{ ...observer, gas: hex(preGas) }, block.calls[0], { ...observer, gas: hex(postGas) }] as const,
    }] as const }, simulateParams[1]] as const };
}

// Private reconstruction only: no production mode/configuration switch.
function prepareLegacyExecutionInput({ source, header, executor, owner, profitToken, scriptHex, executorRuntimeCode: codeInput }: PreparationInput) {
  const blockOverrides = targetContext(source, header);
  validateCaller(executor, owner);
  if (typeof profitToken !== "string" || !ADDRESS.test(profitToken) ||
      typeof scriptHex !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(scriptHex)) {
    throw new Error("invalid final simulation profit token or script");
  }
  const calldata = buildExecuteCalldata(getBytes(scriptHex));
  const pinnedBlock = { blockHash: source.hash, requireCanonical: true as const };
  // Preserve historical direct-call wire semantics exactly (not STATICCALL).
  const observer = { from: ZERO_ADDRESS, to: profitToken,
    data: ERC20.encodeFunctionData("balanceOf", [executor]), gasPrice: "0x0" };
  const executorRuntimeCode = validateExecutorRuntimeCode(codeInput);
  const executorOverride = executorRuntimeCode === undefined
    ? undefined : { [executor]: { code: executorRuntimeCode.code } };
  const stateOverrides = { [owner]: { balance: hex(OWNER_GAS_BALANCE) }, ...executorOverride };
  return {
    schemaVersion: executorRuntimeCode === undefined ? 1 as const : 2 as const,
    source: { number: source.number, hash: source.hash, generation: source.generation },
    sourceHeader: { number: String(header.number), hash: header.hash, parentHash: header.parentHash,
      timestamp: String(header.timestamp), baseFeePerGas: header.baseFeePerGas!.toString(),
      gasUsed: header.gasUsed.toString(), gasLimit: header.gasLimit.toString() },
    executor, owner, profitToken, scriptHex, calldata,
    ...(executorRuntimeCode === undefined ? {} : { executorRuntimeCode }),
    preBalanceParams: executorOverride === undefined
      ? [{ ...observer, gas: blockOverrides.gasLimit }, pinnedBlock] as const
      : [{ ...observer, gas: blockOverrides.gasLimit }, pinnedBlock, stateOverrides] as const,
    simulateParams: [{
      blockStateCalls: [{ blockOverrides,
        stateOverrides,
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
    if (!saved || ![1, 2, 3].includes(saved.schemaVersion as number) || !source || !header ||
        typeof source.number !== "number" || typeof source.hash !== "string" ||
        typeof source.generation !== "number" || typeof header.hash !== "string" ||
        typeof header.parentHash !== "string" || typeof saved.executor !== "string" ||
        typeof saved.owner !== "string" || typeof saved.profitToken !== "string" ||
        typeof saved.scriptHex !== "string") throw new Error();
    const decimal = (field: unknown): bigint => {
      if (typeof field !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(field)) throw new Error();
      return BigInt(field);
    };
    const canonical = freezeInput((saved.schemaVersion === 3 ? prepareExecutionInput : prepareLegacyExecutionInput)({
      source: { number: source.number, hash: source.hash, generation: source.generation },
      header: { number: Number(decimal(header.number)), hash: header.hash, parentHash: header.parentHash,
        timestamp: Number(decimal(header.timestamp)), baseFeePerGas: decimal(header.baseFeePerGas),
        gasUsed: decimal(header.gasUsed), gasLimit: decimal(header.gasLimit), transactionHashes: [] },
      executor: saved.executor, owner: saved.owner, profitToken: saved.profitToken, scriptHex: saved.scriptHex,
      ...(saved.executorRuntimeCode === undefined ? {} : {
        executorRuntimeCode: validateExecutorRuntimeCode(saved.executorRuntimeCode),
      }),
    }));
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

function validateExecutorRuntimeCode(value: unknown): BotVmRuntimeCode | undefined {
  if (value === undefined) return undefined;
  const code = record(value);
  if (!code || Object.keys(code).length !== 2 ||
      !Object.keys(code).every(key => key === "code" || key === "keccak256") ||
      typeof code.code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code.code) ||
      typeof code.keccak256 !== "string" || !HASH.test(code.keccak256) ||
      keccak256(code.code) !== code.keccak256.toLowerCase()) {
    throw new Error("invalid final simulation executor code");
  }
  return Object.freeze({ code: code.code.toLowerCase(), keccak256: code.keccak256.toLowerCase() });
}

/** Stateless final simulation; the existing scheduler owns generation fencing.
 * Owner gas balance is exactly 10,000 ETH. Optional dry-run executor bytes are
 * fixed at startup; no token/balance/storage/nonce state is overridden for them.
 * Target policy: N+1, timestamp+12, parent gas limit, exact next EIP-1559 fee,
 * zero priority fee. Other target header fields retain endpoint semantics.
 */
export class EthSimulateV1Simulator {
  private readonly revertDiagnosticsPath = process.env.SEARCHER_SIM_REVERT_DIAGNOSTICS_PATH;
  private recordedReverts = 0;
  private readonly executorRuntimeCode: BotVmRuntimeCode | undefined;
  constructor(
    private readonly rpcUrl: string,
    readonly executor: string,
    readonly owner: string,
    executorRuntimeCode?: BotVmRuntimeCode,
  ) {
    validateCaller(executor, owner);
    this.executorRuntimeCode = validateExecutorRuntimeCode(executorRuntimeCode);
  }

  /** Opt-in bounded evidence only: exact endpoint-free input and public hex
   * revert bytes. No extra RPC, provider messages, or change to the verdict. */
  private recordRevert(input: EthSimulateV1ExecutionInput, call: Record<string, unknown>): void {
    if (!this.revertDiagnosticsPath || this.recordedReverts >= 64) return;
    this.recordedReverts++;
    const hexEvidence = (value: unknown) => typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)
      ? { data: value.slice(0, 8194), truncated: value.length > 8194 } : null;
    try {
      appendFileSync(this.revertDiagnosticsPath, JSON.stringify({
        schemaVersion: 1, type: "eth_simulateV1_revert", recordedAt: new Date().toISOString(),
        executionInput: input,
        failure: { code: 3, gasUsed: quantity(call.gasUsed).toString(),
          returnData: hexEvidence(call.returnData), errorData: hexEvidence(record(call.error)?.data) },
      }) + "\n", { mode: 0o600 });
    } catch {
      // Diagnostic I/O must not turn an economic revert into a runtime fault.
      this.recordedReverts = 64;
      console.error("[searcher/sim-revert-diagnostic] write failed; recording disabled");
    }
  }

  async simulate(plan: ResolvedPlan, context: Context): Promise<EthSimulateV1SimulationResult> {
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
      owner: this.owner, profitToken, scriptHex,
      ...(this.executorRuntimeCode === undefined ? {} : { executorRuntimeCode: this.executorRuntimeCode }) });
    return this.simulateExecutionInput(input, { signal, deadlineAtMs });
  }

  /** Read-only diagnostic replay. Production still owns the latest-head gate. */
  async simulateExecutionInput(input: EthSimulateV1ExecutionInput,
    control: { signal: AbortSignal; deadlineAtMs: number }): Promise<EthSimulateV1SimulationResult> {
    const saved = validateEthSimulateV1ExecutionInput(input);
    if (saved.executor.toLowerCase() !== this.executor.toLowerCase() ||
        saved.owner.toLowerCase() !== this.owner.toLowerCase()) {
      throw new Error("final simulation execution input caller mismatch");
    }
    if (!isDeepStrictEqual(saved.executorRuntimeCode, this.executorRuntimeCode)) {
      throw new Error("final simulation execution input executor code mismatch");
    }
    const { signal, deadlineAtMs } = control;
    if (!Number.isSafeInteger(deadlineAtMs) || !signal) {
      throw new Error("invalid final simulation control or profit token");
    }
    const { profitToken, calldata, scriptHex, simulateParams } = saved;
    const codeEvidence = saved.executorRuntimeCode === undefined ? {} : {
      counterfactualExecutorCode: { address: this.executor.toLowerCase(), keccak256: saved.executorRuntimeCode.keccak256 },
    };
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
      const legacyPre = saved.schemaVersion === 3 ? undefined
        : balance(await request(1, "eth_call", saved.preBalanceParams));
      const raw = await request(saved.schemaVersion === 3 ? 1 : 2, "eth_simulateV1", simulateParams);
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
      if (!Array.isArray(block.calls) || block.calls.length !== (saved.schemaVersion === 3 ? 3 : 2)) {
        throw new Error("invalid final simulation call count");
      }
      const calls = simulateParams[0].blockStateCalls[0].calls;
      const main = parseCall(block.calls[saved.schemaVersion === 3 ? 1 : 0], TX_GAS);
      const pre = saved.schemaVersion === 3
        ? observedBalance(parseCall(block.calls[0], quantity(calls[0].gas))) : legacyPre!;
      const postIndex = saved.schemaVersion === 3 ? 2 : 1;
      const post = parseCall(block.calls[postIndex], quantity(calls[postIndex]!.gas));
      const postBalance = saved.schemaVersion === 3 ? observedBalance(post) : (() => {
        if (post.status !== "0x1") throw rpcFailure(post.error);
        return balance(post.returnData);
      })();
      assertOpen();
      if (main.status === "0x0") {
        // Only the explicit execution-reverted RPC code is a confirmed revert.
        // Unknown VM/validation/provider failures remain thrown, never cached as
        // route reverts. Remote error text and data are deliberately discarded.
        const error = record(main.error);
        if (error?.code !== 3) throw rpcFailure(main.error);
        this.recordRevert(saved, main);
        const cause = Object.assign(new Error("final simulation transaction reverted"), {
          kind: "revert", code: "TRANSACTION_REVERTED",
        });
        return { ...codeEvidence, success: false, profitToken, grossProfit: 0n, gasUsed: 0n, netProfit: 0n,
          calldata, scriptHex, revertReason: cause.message,
          failure: { kind: "revert", code: "TRANSACTION_REVERTED", cause } };
      }
      const grossProfit = postBalance - pre;
      return { ...codeEvidence, success: grossProfit > 0n, profitToken, grossProfit,
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

function observedBalance(call: Record<string, unknown>): bigint {
  if (call.status !== "0x1") throw rpcFailure(call.error);
  const data = call.returnData;
  if (typeof data !== "string" ||
      data.length !== 130 || data.slice(0, 66).toLowerCase() !== BALANCE_TAG) {
    throw new Error("invalid final simulation static balance observation");
  }
  return balance(`0x${data.slice(66)}`);
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
