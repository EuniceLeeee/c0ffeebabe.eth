import { Interface } from "ethers";
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
    if (!ADDRESS.test(executor) || !ADDRESS.test(owner) || owner.toLowerCase() === ZERO_ADDRESS ||
        executor.toLowerCase() === owner.toLowerCase()) {
      throw new Error("invalid final simulation caller");
    }
  }

  async simulate(plan: ResolvedPlan, context: Context): Promise<SimulationResult> {
    const { source, header, signal, deadlineAtMs } = context;
    const blockOverrides = targetContext(source, header);
    if (!Number.isSafeInteger(deadlineAtMs) || !signal || !ADDRESS.test(plan.profitToken)) {
      throw new Error("invalid final simulation control or profit token");
    }
    const pinnedBlock = { blockHash: source.hash, requireCanonical: true };
    const profitToken = plan.profitToken;
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
    const request = async (id: number, method: string, params: unknown[]): Promise<unknown> => {
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
      const script = compilePlan(plan.root, this.executor);
      const calldata = buildExecuteCalldata(script);
      const scriptHex = bytesToHex(script);
      // Old getTokenBalance used eth_call without `from`: zero-address observer,
      // zero gas price. Its writes must never enter the main transaction's state.
      const observer = { from: ZERO_ADDRESS, to: profitToken,
        data: ERC20.encodeFunctionData("balanceOf", [this.executor]), gasPrice: "0x0" };
      const pre = balance(await request(1, "eth_call", [
        { ...observer, gas: blockOverrides.gasLimit }, pinnedBlock,
      ]));
      const observerGas = quantity(blockOverrides.gasLimit) - TX_GAS;
      const raw = await request(2, "eth_simulateV1", [{
        blockStateCalls: [{
          blockOverrides,
          stateOverrides: { [this.owner]: { balance: hex(OWNER_GAS_BALANCE) } },
          calls: [
            { from: this.owner, to: this.executor, data: calldata, value: "0x0",
              gas: hex(TX_GAS), gasPrice: blockOverrides.baseFeePerGas },
            { ...observer, gas: hex(observerGas) },
          ],
        }],
        validation: false, traceTransfers: false, returnFullTransactions: false,
      }, pinnedBlock]);
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
      !Number.isSafeInteger(source.number + 1) || !HASH.test(source.hash) ||
      !Number.isSafeInteger(source.generation) || source.generation < 0 ||
      source.number !== header.number || !HASH.test(header.hash) ||
      source.hash.toLowerCase() !== header.hash.toLowerCase() || !HASH.test(header.parentHash) ||
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
