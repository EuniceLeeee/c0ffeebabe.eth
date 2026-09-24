import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { getBytes, id, Interface, keccak256 } from "ethers";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { bytesToHex } from "../../shared/compiler/encoder.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { postJsonRpc, StateCallAbortedError } from "../../shared/state/state-backend.js";
import { readBlockScanObservedHeader, type BlockScanObservedHeader } from "../blockscan-observed-header.js";
import { RevmSimClient, type DaemonResponse, type ExecutorRuntimeCode, type RevmRequestControl, type StrictSimulateRequest } from "../revm-sim-client.js";
import { isRpcThrottleError } from "../rpc-throttle-guard.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { SimulationResult } from "./botvm-simulator.js";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = `0x${"0".repeat(40)}`;
const GAS = 0x1000000;
const GAS_BALANCE = (10_000n * 10n ** 18n).toString();
const TRANSFER = id("Transfer(address,address,uint256)").toLowerCase();
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)"]);
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
type Context = { source: CanonicalSource; header: BlockScanObservedHeader; signal: AbortSignal; deadlineAtMs: number };
export type SourceBlockFunding = { asset: string; target: string; liquidityHolder: string; amount: string };
type SnapshotArgs = {
  source: CanonicalSource; header: BlockScanObservedHeader; stateRoot: string; chainId: number;
  executor: string; owner: string; profitToken: string; tokens: readonly string[];
  funding: SourceBlockFunding; scriptHex: string;
  executorRuntimeCode?: ExecutorRuntimeCode;
};
type ReadonlyDeep<T> = T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
export type SourceBlockExecutionInput = ReadonlyDeep<ReturnType<typeof prepare>>;

function frozen<T>(value: T): ReadonlyDeep<T> {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value as ReadonlyDeep<T>;
}
function address(value: string): string { assert(ADDRESS.test(value), "invalid source-block address"); return value.toLowerCase(); }
function runtimeCode(value: ExecutorRuntimeCode | undefined): ExecutorRuntimeCode | undefined {
  if (value === undefined) return undefined;
  assert(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2 && Object.keys(value).every(k => ["code", "keccak256"].includes(k)));
  assert(typeof value.code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value.code));
  assert(typeof value.keccak256 === "string" && HASH.test(value.keccak256)
    && keccak256(value.code) === value.keccak256.toLowerCase(), "executor runtime code hash mismatch");
  return { code: value.code.toLowerCase(), keccak256: value.keccak256.toLowerCase() };
}
function prepare(input: SnapshotArgs) {
  const { source: s, header: h } = input;
  assert(Number.isSafeInteger(s.number) && s.number >= 0 && Number.isSafeInteger(s.generation) && s.generation >= 0);
  assert(HASH.test(s.hash) && h.number === s.number && h.hash.toLowerCase() === s.hash.toLowerCase());
  assert(HASH.test(h.parentHash) && HASH.test(input.stateRoot) && input.chainId === 1, "source-block requires a mainnet source anchor");
  assert(Number.isSafeInteger(h.timestamp) && h.timestamp >= 0 && typeof h.baseFeePerGas === "bigint" && h.baseFeePerGas >= 0n);
  assert(h.gasLimit >= BigInt(GAS) && h.gasUsed >= 0n && h.gasUsed <= h.gasLimit);
  const executor = address(input.executor), owner = address(input.owner), profitToken = address(input.profitToken);
  const executorRuntimeCode = runtimeCode(input.executorRuntimeCode);
  assert(owner !== ZERO && executor !== ZERO && owner !== executor && profitToken !== ZERO);
  const tokens = [...new Set(input.tokens.map(address).filter(t => t !== ZERO))].sort();
  assert(tokens.includes(profitToken));
  const funding = { asset: address(input.funding.asset), target: address(input.funding.target),
    liquidityHolder: address(input.funding.liquidityHolder), amount: input.funding.amount };
  assert(/^[1-9][0-9]*$/.test(funding.amount) && BigInt(funding.amount) < 1n << 256n);
  assert(tokens.includes(funding.asset) && funding.asset === profitToken);
  assert(![ZERO, owner, executor].includes(funding.target) && ![ZERO, owner, executor].includes(funding.liquidityHolder));
  assert(/^0x(?:[0-9a-fA-F]{2})*$/.test(input.scriptHex));
  const scriptHex = input.scriptHex.toLowerCase(), calldata = buildExecuteCalldata(getBytes(scriptHex));
  const digest = (bytes: string) => createHash("sha256").update(getBytes(bytes)).digest("hex");
  const source = { number: s.number, hash: s.hash.toLowerCase(), generation: s.generation };
  const sourceHeader = { number: h.number, hash: h.hash.toLowerCase(), parentHash: h.parentHash.toLowerCase(),
    timestamp: h.timestamp, baseFeePerGas: h.baseFeePerGas.toString(), gasUsed: h.gasUsed.toString(), gasLimit: h.gasLimit.toString() };
  const pin = { blockHash: source.hash, requireCanonical: true as const };
  const transaction = { from: owner, to: executor, data: calldata, value: "0x0", gas: hex(GAS), gasPrice: hex(h.baseFeePerGas) };
  return { schemaVersion: 1 as const, executionMode: "source-block" as const, backend: "source-pinned-revm+debug_traceCall" as const,
    source, sourceHeader, stateRoot: input.stateRoot.toLowerCase(), chainId: input.chainId,
    executor, owner, profitToken, tokens, funding, scriptHex, calldata,
    ...(executorRuntimeCode ? { executorRuntimeCode } : {}),
    scriptSha256: digest(scriptHex), calldataSha256: digest(calldata),
    traceParams: [transaction, pin, { tracer: "callTracer", timeout: "30s",
      stateOverrides: executorRuntimeCode ? { [executor]: { code: executorRuntimeCode.code } }
        : { [owner]: { balance: hex(BigInt(GAS_BALANCE)) } } }] as const };
}
export function buildSourceBlockExecutionInput(input: SnapshotArgs): SourceBlockExecutionInput { return frozen(prepare(input)); }
export function validateSourceBlockExecutionInput(value: unknown): SourceBlockExecutionInput {
  try {
    const v = value as SourceBlockExecutionInput, h = v.sourceHeader;
    const canonical = buildSourceBlockExecutionInput({ ...v, header: { ...h,
      baseFeePerGas: BigInt(h.baseFeePerGas), gasUsed: BigInt(h.gasUsed), gasLimit: BigInt(h.gasLimit), transactionHashes: [] } });
    assert(isDeepStrictEqual(value, canonical)); return canonical;
  } catch { throw new Error("invalid source-block execution input"); }
}

/** Historical opt-in only. Independent S5 sandbox, never the Solver's journal.
 * REVM executes source.env and independently probes balances on the committed
 * journal. callTracer executes the SAME top-level calldata at the SAME hash to
 * measure charged transaction gas (strict REVM exposes unrefunded budget gas).
 * Neither call has a block override, token deal or tx prefix. An explicit,
 * hash-bound counterfactual executor code override is shared by both engines.
 */
export class SourceBlockSimulator {
  readonly concurrency = 1;
  constructor(private readonly options: {
    rpcUrl: string; executor: string; owner: string; chainId: number; stateRoot: string; executablePath: string;
    fundingForPlan: (plan: ResolvedPlan) => SourceBlockFunding;
    executorRuntimeCode?: ExecutorRuntimeCode;
    onResult?: (input: SourceBlockExecutionInput, result: SourceBlockSimulationResult) => void;
  }) {
    this.options = Object.freeze({ ...options,
      ...(options.executorRuntimeCode !== undefined ? { executorRuntimeCode: frozen(runtimeCode(options.executorRuntimeCode)!) } : {}) });
    assert(options.chainId === 1 && HASH.test(options.stateRoot));
    assert(typeof options.executablePath === "string" && isAbsolute(options.executablePath) && existsSync(options.executablePath),
      "source-block requires an explicit existing REVM binary");
    address(options.owner); address(options.executor);
  }

  captureInput(plan: ResolvedPlan, context: Pick<Context, "source" | "header">, scriptHex?: string): SourceBlockExecutionInput {
    const tokens: string[] = [];
    const visit = (node: ResolvedPlan["root"]) => { tokens.push(node.tokenIn, node.tokenOut); node.children.forEach(visit); };
    visit(plan.root);
    return buildSourceBlockExecutionInput({ ...context, ...this.options, profitToken: plan.profitToken,
      funding: this.options.fundingForPlan(plan), tokens,
      scriptHex: scriptHex ?? bytesToHex(compilePlan(plan.root, this.options.executor)) });
  }
  async simulate(plan: ResolvedPlan, context: Context): Promise<SourceBlockSimulationResult> {
    return this.simulateExecutionInput(this.captureInput(plan, context), context);
  }
  async simulateExecutionInput(value: SourceBlockExecutionInput, control: { signal: AbortSignal; deadlineAtMs: number }): Promise<SourceBlockSimulationResult> {
    const input = validateSourceBlockExecutionInput(value);
    assert(input.executor === this.options.executor.toLowerCase() && input.owner === this.options.owner.toLowerCase());
    assert(input.chainId === this.options.chainId && input.stateRoot === this.options.stateRoot.toLowerCase());
    assert(isDeepStrictEqual(input.executorRuntimeCode, this.options.executorRuntimeCode), "source-block executor code configuration mismatch");
    assert(Number.isSafeInteger(control.deadlineAtMs));
    const controller = new AbortController();
    const cancel = () => controller.abort(new StateCallAbortedError("source-block simulation cancelled", "signal"));
    const check = () => {
      if (control.signal.aborted) cancel();
      if (Date.now() >= control.deadlineAtMs) controller.abort(new StateCallAbortedError("source-block simulation deadline", "deadline"));
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    check();
    const timer = setTimeout(() => controller.abort(new StateCallAbortedError("source-block simulation deadline", "deadline")),
      Math.min(control.deadlineAtMs - Date.now(), 2_147_483_647));
    control.signal.addEventListener("abort", cancel, { once: true });
    const work: RevmRequestControl = { signal: controller.signal, deadlineAtMs: control.deadlineAtMs };
    const client = new RevmSimClient({ executablePath: this.options.executablePath, timeoutMs: 120_000 });
    const verifyHeader = async () => {
      const h = await readBlockScanObservedHeader(this.options.rpcUrl, BigInt(input.chainId), input.source.number, work);
      const actual = { number: h.number, hash: h.hash, parentHash: h.parentHash, timestamp: h.timestamp,
        baseFeePerGas: h.baseFeePerGas?.toString(), gasUsed: h.gasUsed.toString(), gasLimit: h.gasLimit.toString() };
      assert(isDeepStrictEqual(actual, input.sourceHeader), "source-block header changed"); check();
    };
    try {
      await verifyHeader();
      const req = sourceBlockRevmRequest(input, this.options.rpcUrl);
      const response = await client.strictSimulate(req, work);
      check();
      const trace = await this.rpc("debug_traceCall", input.traceParams, controller.signal);
      // A matching return value is not an effects proof. Materialize only the
      // trace's real write-set over the same B state, then independently call
      // balanceOf. No inferred token storage slots or quote-derived balances.
      const balanceDeltas = response.success ? await sourceBlockTraceDeltas(input,
        (method, params) => this.rpc(method, params, controller.signal)) : undefined;
      await verifyHeader();
      const result = sourceBlockResult(input, response, trace, balanceDeltas);
      check(); this.options.onResult?.(input, result); return result;
    } finally {
      clearTimeout(timer); control.signal.removeEventListener("abort", cancel);
      await client.closeAndDrain();
    }
  }
  private async rpc(method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown> {
    let response;
    try { response = await postJsonRpc(this.options.rpcUrl, { jsonrpc: "2.0", id: 1,
      method, params }, signal); }
    catch { if (signal.aborted) throw signal.reason; throw new Error("source-block trace transport failed"); }
    const body = response.body as { jsonrpc?: string; id?: number; result?: unknown; error?: { code?: number } } | null;
    if (response.statusCode === 429 || isRpcThrottleError(body?.error)) throw Object.assign(new Error("source-block trace RPC throttle"), { statusCode: 429 });
    if (response.statusCode < 200 || response.statusCode >= 300 || body?.jsonrpc !== "2.0" || body.id !== 1 ||
        !Object.hasOwn(body, "result") || Object.hasOwn(body, "error")) throw new Error("source-block trace unavailable");
    return body.result;
  }
}

export function sourceBlockRevmRequest(input: SourceBlockExecutionInput, rpcUrl: string): StrictSimulateRequest {
  return { rpcUrl, blockNumber: input.source.number, sourcePin: { chainId: input.chainId, blockHash: input.source.hash, stateRoot: input.stateRoot },
    from: input.owner, to: input.executor, data: input.calldata, callerMode: "top-level", gasLimit: GAS,
    // Counterfactual code is code-only, including the observable caller state.
    // Insufficient real gas funding must fail; never top up the owner here.
    ...(input.executorRuntimeCode ? {} : { nativeBalanceWei: GAS_BALANCE }),
    preCalls: [], tokenDeals: [], observeLogs: true,
    ...(input.executorRuntimeCode ? { executorRuntimeCode: { ...input.executorRuntimeCode } } : {}),
    observeTokenBalances: [...input.tokens.flatMap(token => [input.executor, input.owner].map(account => ({ token, account }))),
      { token: input.funding.asset, account: input.funding.liquidityHolder }],
    observeNativeBalances: [input.executor], observeTotalSupply: [] };
}
export interface SourceBlockSimulationResult extends SimulationResult {
  sourceBlockEvidence: {
    executionMode: "source-block"; source: CanonicalSource; stateRoot: string; baseFeePerGas: string;
    backend: SourceBlockExecutionInput["backend"]; repaymentVerified: boolean; conservationVerified: boolean;
    effects: NonNullable<DaemonResponse["strict"]>;
    traceBalanceDeltas?: readonly string[];
    counterfactualExecutorCode?: { address: string; keccak256: string };
  };
}
/** Pure evidence reconciliation; never reads quoteProfit as measured profit. */
export function sourceBlockResult(input: SourceBlockExecutionInput, response: DaemonResponse, rawTrace: unknown,
  traceBalanceDeltas?: readonly string[]): SourceBlockSimulationResult {
  const a = response.sourceAttestation, s = response.strict;
  assert(response.ok && a?.kind === "node-attested" && a.chainId === input.chainId && a.blockNumber === input.source.number &&
    a.blockHash.toLowerCase() === input.source.hash && a.stateRoot.toLowerCase() === input.stateRoot &&
    a.parentHash.toLowerCase() === input.sourceHeader.parentHash, "source-block attestation mismatch");
  assert(s && s.outcome.phase === "main" && response.success === (s.outcome.kind === "Success"));
  const counterfactualExecutorCode = input.executorRuntimeCode
    ? { address: input.executor, keccak256: input.executorRuntimeCode.keccak256 } : undefined;
  assert(isDeepStrictEqual(s.counterfactualExecutorCode, counterfactualExecutorCode), "source-block executor code evidence mismatch");
  const t = rawTrace as { type?: string; from?: string; to?: string; input?: string; output?: string; gasUsed?: string; error?: string };
  assert(t && t.type === "CALL" && t.from?.toLowerCase() === input.owner && t.to?.toLowerCase() === input.executor &&
    t.input?.toLowerCase() === input.calldata.toLowerCase(), "source-block trace input mismatch");
  const evidence: SourceBlockSimulationResult["sourceBlockEvidence"] = { executionMode: "source-block", source: input.source,
    stateRoot: input.stateRoot, baseFeePerGas: input.sourceHeader.baseFeePerGas, backend: input.backend,
    repaymentVerified: false, conservationVerified: false, effects: s,
    ...(counterfactualExecutorCode ? { counterfactualExecutorCode } : {}) };
  const base = { profitToken: input.profitToken, calldata: input.calldata, scriptHex: input.scriptHex, sourceBlockEvidence: evidence };
  if (s.outcome.kind !== "Success") {
    assert(s.outcome.kind === "Revert" && t.error === "execution reverted" && t.output === s.outcome.output,
      "source-block execution failed without a matching EVM revert");
    const cause = Object.assign(new Error("source-block final transaction reverted"), { code: "TRANSACTION_REVERTED", kind: "revert" });
    return { ...base, success: false, grossProfit: 0n, netProfit: 0n, gasUsed: 0n,
      revertReason: cause.message, failure: { cause, kind: "revert", code: cause.code } };
  }
  assert(t.error === undefined && (t.output ?? "0x") === s.outcome.output, "source-block executions disagree");
  assert(typeof t.gasUsed === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(t.gasUsed));
  const gasUsed = BigInt(t.gasUsed);
  assert(gasUsed > 0n && gasUsed <= BigInt(s.executionGasUsed) && BigInt(s.executionGasUsed) <= BigInt(GAS));
  const request = sourceBlockRevmRequest(input, "unused");
  assert(s.tokenDeltas.length === request.observeTokenBalances!.length && s.nativeDeltas.length === 1);
  const deltas = s.tokenDeltas.map((d, i) => {
    const p = request.observeTokenBalances![i]!;
    assert(d.token.toLowerCase() === p.token && d.account.toLowerCase() === p.account && /^(0|-?[1-9][0-9]*)$/.test(d.delta));
    return BigInt(d.delta);
  });
  assert(traceBalanceDeltas && isDeepStrictEqual(traceBalanceDeltas, [...deltas.map(String), s.nativeDeltas[0]!.delta]),
    "source-block independent execution effects disagree");
  evidence.traceBalanceDeltas = [...traceBalanceDeltas];
  let grossProfit = 0n;
  input.tokens.forEach((token, i) => {
    assert(deltas[2 * i]! >= 0n && deltas[2 * i + 1] === 0n, "source-block inventory consumed");
    if (token === input.profitToken) grossProfit = deltas[2 * i]!;
  });
  const native = s.nativeDeltas[0]!;
  assert(native.account.toLowerCase() === input.executor && BigInt(native.delta) === 0n && BigInt(native.after) === BigInt(native.before), "source-block native inventory changed");
  assert(deltas.at(-1)! >= 0n, "source-block lender principal not restored");
  let borrowed = 0n, repaid = 0n;
  for (const log of s.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER || log.topics.length !== 3) continue;
    const from = `0x${log.topics[1]!.slice(-40)}`.toLowerCase(), to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
    if ([from, to].some(a => a === input.executor || a === input.owner)) {
      assert(input.tokens.includes(log.address.toLowerCase()), "source-block unobserved token movement");
    }
    if (log.address.toLowerCase() !== input.funding.asset) continue;
    assert(HASH.test(log.data));
    if (from === input.funding.liquidityHolder && to === input.executor) borrowed += BigInt(log.data);
    if (from === input.executor && to === input.funding.liquidityHolder) repaid += BigInt(log.data);
  }
  assert(borrowed === BigInt(input.funding.amount) && repaid >= borrowed, "source-block borrow/repayment witness missing");
  evidence.repaymentVerified = true; evidence.conservationVerified = true;
  // Execution success and economic acceptance are separate. The production
  // final-profit/EV gates still reject a successfully executed zero-profit plan.
  return { ...base, success: true, grossProfit, netProfit: grossProfit, gasUsed };
}

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
type AccountDiff = { balance?: string; nonce?: number; code?: string; storage?: Record<string, string> };
/** Convert geth prestateTracer diffMode into a post-state observation overlay.
 * pre-only storage keys are deletions, NOT unchanged slots. Deleted accounts
 * fail closed because eth_call overrides cannot universally represent deletion.
 */
export function sourceBlockPostState(value: unknown): Record<string, { balance?: string; nonce?: string; code?: string; stateDiff?: Record<string, string> }> {
  const d = value as { pre: Record<string, AccountDiff>; post: Record<string, AccountDiff> };
  assert(d && d.pre && d.post && !Array.isArray(d.pre) && !Array.isArray(d.post), "missing trace post-state");
  const result: ReturnType<typeof sourceBlockPostState> = {};
  for (const account of new Set([...Object.keys(d.pre), ...Object.keys(d.post)])) {
    const a = address(account), pre = d.pre[account], post = d.post[account];
    assert(post, "source-block trace deleted an account; unsupported observation overlay");
    const row: ReturnType<typeof sourceBlockPostState>[string] = {};
    if (post.balance !== undefined) { assert(/^0x[0-9a-fA-F]+$/.test(post.balance)); row.balance = hex(BigInt(post.balance)); }
    if (post.nonce !== undefined) { assert(Number.isSafeInteger(post.nonce) && post.nonce >= 0); row.nonce = hex(post.nonce); }
    if (post.code !== undefined) { assert(/^0x(?:[0-9a-fA-F]{2})*$/.test(post.code)); row.code = post.code; }
    const slots = new Set([...Object.keys(pre?.storage ?? {}), ...Object.keys(post.storage ?? {})]);
    if (slots.size) {
      row.stateDiff = {};
      for (const key of slots) {
        const word = post.storage?.[key] ?? `0x${"0".repeat(64)}`;
        assert(HASH.test(key) && HASH.test(word)); row.stateDiff[key.toLowerCase()] = word;
      }
    }
    assert(!Object.hasOwn(result, a), "duplicate normalized trace account"); result[a] = row;
  }
  return result;
}

export async function sourceBlockTraceDeltas(input: SourceBlockExecutionInput, rpc: Rpc): Promise<string[]> {
  const [tx, pin, config] = input.traceParams;
  const diff = await rpc("debug_traceCall", [tx, pin, { ...config, tracer: "prestateTracer", tracerConfig: { diffMode: true } }]);
  const post = sourceBlockPostState(diff);
  // The diff omits unchanged overridden code. Both observation baselines must
  // retain it; actual post-execution writes take precedence over the baseline.
  const beforeCode = input.executorRuntimeCode ? { [input.executor]: { code: input.executorRuntimeCode.code } } : undefined;
  if (beforeCode) post[input.executor] = { ...beforeCode[input.executor], ...post[input.executor] };
  const result: string[] = [];
  const balance = (v: unknown): bigint => { assert(typeof v === "string" && HASH.test(v), "invalid independent balance observation"); return BigInt(v); };
  for (const pair of sourceBlockRevmRequest(input, "unused").observeTokenBalances!) {
    const call = { from: ZERO, to: pair.token, data: ERC20.encodeFunctionData("balanceOf", [pair.account]), gas: hex(GAS), gasPrice: tx.gasPrice };
    const before = balance(await rpc("eth_call", beforeCode ? [call, pin, beforeCode] : [call, pin]));
    const after = balance(await rpc("eth_call", [call, pin, post]));
    result.push((after - before).toString());
  }
  const before = await rpc("eth_getBalance", [input.executor, pin]);
  assert(typeof before === "string" && /^0x[0-9a-fA-F]+$/.test(before));
  result.push((BigInt(post[input.executor]?.balance ?? before) - BigInt(before)).toString());
  return result;
}
