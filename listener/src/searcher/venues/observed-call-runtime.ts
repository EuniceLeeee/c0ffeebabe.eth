import { getAddress, Interface, MaxUint256, ZeroAddress } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeAmountLeg } from "../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "./adapter-request-program.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import { assertDeclarativeExecutionSource } from "./declarative-execution.js";
import { decodeDeclarativeExecutionSimulationReceipt } from "./declarative-simulation.js";
import { bindObservedCallTemplate, OBSERVED_CALL_MAX_AMOUNT, validateObservedCallTemplate, type ObservedCallTemplate } from "./observed-call-template.js";
import { runtimeExecutor, runtimeLeg } from "./runtime-execution.js";

const TOKEN = new Interface([
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)",
]);
const MAX_PROTECTED_TOKENS = 8;
type SimulationRequest = Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }>;

export interface ObservedCallRuntimeInput {
  readonly template: ObservedCallTemplate;
  readonly executor: string;
  /** Current invocation source, independently issued by the caller. The sample
   * source remains provenance and is never relabelled as a current-state quote. */
  readonly source: CanonicalSource;
  readonly actionAdapterId: string;
  readonly protectedTokens?: readonly string[];
  readonly minimumAmountOut?: bigint;
  /** Optional constraint inherited from the owning declaration: this returned
   * word must equal the independently measured fresh output. */
  readonly outputWordOffset?: number;
  /** Production bindings carry the successfully probed input envelope. A
   * runtime amount is checked by the VM even when selected by an earlier hop. */
  readonly amountBounds?: { readonly minimum: bigint; readonly maximum: bigint };
}

function uint(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value <= 0n || value > MaxUint256)
    throw new Error(`observed call ${label} must be a positive uint256`);
}
function scope(input: ObservedCallRuntimeInput) {
  validateObservedCallTemplate(input.template);
  assertDeclarativeExecutionSource(input.source);
  if (typeof input.actionAdapterId !== "string" || !input.actionAdapterId.trim() || input.actionAdapterId.trim() !== input.actionAdapterId)
    throw new Error("observed call requires an owned action adapter id");
  const { sample } = input.template;
  const tokenIn = getAddress(sample.tokenIn), tokenOut = getAddress(sample.tokenOut), target = getAddress(sample.target);
  const actor = runtimeExecutor(input.executor, target, tokenIn, tokenOut,
    ...(sample.payment.kind === "approval" ? [sample.payment.spender] : []));
  const minimum = input.minimumAmountOut ?? 1n;
  uint(minimum, "minimum output");
  const amountMinimum = input.amountBounds?.minimum ?? 1n;
  const amountMaximum = input.amountBounds?.maximum ?? OBSERVED_CALL_MAX_AMOUNT;
  uint(amountMinimum, "minimum input"); uint(amountMaximum, "maximum input");
  if (amountMinimum > amountMaximum || amountMaximum > OBSERVED_CALL_MAX_AMOUNT)
    throw new Error("observed call input envelope is invalid");
  if (input.protectedTokens !== undefined && !Array.isArray(input.protectedTokens))
    throw new Error("observed call protected tokens must be a list");
  if (input.outputWordOffset !== undefined && (!Number.isSafeInteger(input.outputWordOffset) ||
      input.outputWordOffset < 0 || input.outputWordOffset % 32 !== 0 || input.outputWordOffset > 65504))
    throw new Error("observed call output word offset is invalid");
  const protectedTokens = [...new Set((input.protectedTokens ?? []).map(token => getAddress(token)))].filter(token => token !== tokenIn && token !== tokenOut).sort();
  if (protectedTokens.length > MAX_PROTECTED_TOKENS || protectedTokens.some(token => token === ZeroAddress || token === actor))
    throw new Error("observed call protected token scope is unsupported");
  return { actor, target, tokenIn, tokenOut, protectedTokens, minimum, amountMinimum, amountMaximum };
}

/** Compile a candidate through the existing protocol-neutral VM. This does not
 * confer identity, Ready or source authority. Its caller must bind the template
 * to its own verified Family/instance and revalidate code at the current source.
 *
 * Only the input word varies at execution time. Recipient words are rebound to
 * the actual configured executor; every other original calldata byte remains
 * unchanged. Output is measured from fresh balances, never historical amounts.
 */
export function buildObservedCallRuntimeProgram(input: ObservedCallRuntimeInput): RuntimeAmountProgram {
  const { actor, target, tokenIn, tokenOut, protectedTokens, minimum, amountMinimum, amountMaximum } = scope(input);
  const p = new RuntimeAmountProgram();
  // r0 input; r1/r2 opening input/output; r3 native; r4/r5 scratch;
  // r6 bounds/optional returned output; r7 zero; r8..r15 protected balances.
  // The subtraction is an actual VM guard: zero input cannot reach the CALL.
  p.constant(6, amountMinimum).math("sub", 4, 0, 6)
    .constant(6, amountMaximum).math("sub", 4, 6, 0).constant(7, 0n);
  const balance = (token: string, register: number) => {
    p.call(token, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(register, 0);
  };
  balance(tokenIn, 1); balance(tokenOut, 2); p.nativeBalance(3);
  protectedTokens.forEach((token, index) => balance(token, 8 + index));

  const { payment } = input.template.sample;
  const allowance = (expected: number) => {
    if (payment.kind !== "approval") throw new Error("observed call payment mismatch");
    p.call(tokenIn, TOKEN.encodeFunctionData("allowance", [actor, payment.spender]), { static: true }).load(4, 0).equal(4, expected);
  };
  const clear = () => {
    if (payment.kind !== "approval") throw new Error("observed call payment mismatch");
    p.call(tokenIn, TOKEN.encodeFunctionData("approve", [payment.spender, 0n]));
    allowance(7);
  };
  if (payment.kind === "approval") {
    clear();
    p.call(tokenIn, TOKEN.encodeFunctionData("approve", [payment.spender, 0n]), { patches: [{ offset: 36, reg: 0 }] });
    allowance(0);
  } else {
    p.call(tokenIn, TOKEN.encodeFunctionData("transfer", [target, 0n]), { patches: [{ offset: 36, reg: 0 }] });
  }

  // 1 is a placeholder only: r0 is patched by the VM before the external call.
  const data = bindObservedCallTemplate(input.template, { amountIn: 1n, executor: actor });
  p.call(target, data, { patches: [{ offset: input.template.amountInOffset, reg: 0 }] });
  // LOAD checks returndata bounds. Capture before allowance cleanup overwrites
  // the VM's last return bytes; a missing word cannot default to zero.
  if (input.outputWordOffset !== undefined) p.load(6, input.outputWordOffset);
  if (payment.kind === "approval") clear();

  balance(tokenIn, 4);
  p.math("sub", 5, 1, 4).equal(5, 0);
  p.nativeBalance(4).equal(4, 3);
  protectedTokens.forEach((token, index) => { balance(token, 4); p.equal(4, 8 + index); });
  balance(tokenOut, 4);
  p.math("sub", 0, 4, 2);
  if (input.outputWordOffset !== undefined) p.equal(0, 6);
  p.constant(6, minimum).math("sub", 5, 0, 6);
  return p;
}

export function buildObservedCallRuntimeLeg(input: ObservedCallRuntimeInput): RuntimeAmountLeg {
  return Object.freeze({ ...runtimeLeg(input.actionAdapterId, buildObservedCallRuntimeProgram(input)), settlement: Object.freeze({}) });
}

export interface ObservedCallSimulationInput extends Omit<ObservedCallRuntimeInput, "actionAdapterId"> {
  readonly amountIn: bigint;
  readonly id?: string;
  readonly observeLogs?: boolean;
}

/** Standard symbolic-executor request. The central source transport owns input
 * funding, RPC, caller provenance and executor bytecode. No raw code/storage
 * override or impersonated historical actor can be supplied by a template. */
export function buildObservedCallSimulation(input: ObservedCallSimulationInput): SimulationRequest {
  uint(input.amountIn, "input");
  if (input.amountIn > OBSERVED_CALL_MAX_AMOUNT) throw new Error("observed call input exceeds the positive signed range");
  const runtimeInput = { ...input, actionAdapterId: "observed-call-candidate" };
  const { actor, tokenIn, tokenOut, protectedTokens, amountMinimum, amountMaximum } = scope(runtimeInput);
  if (input.amountIn < amountMinimum || input.amountIn > amountMaximum)
    throw new Error("observed call input is outside the probed envelope");
  const id = input.id ?? `observed-call:${input.template.templateHash}`;
  if (!id.trim() || id.trim() !== id) throw new Error("observed call simulation id is invalid");
  const caller = Object.freeze({ kind: "executor" as const });
  const program = buildObservedCallRuntimeProgram(runtimeInput).bytes();
  return Object.freeze({
    id, required: true, kind: "effect-delta-simulation",
    call: Object.freeze({ caller, executionMode: "executor-program" as const, to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(program, input.amountIn)) }),
    overrideIntent: Object.freeze({ caller, tokenBalances: Object.freeze([Object.freeze({ token: tokenIn, amount: input.amountIn })]) }),
    observeTokenBalances: Object.freeze([tokenIn, tokenOut, ...protectedTokens].map(token => Object.freeze({ token, account: caller }))),
    observe: Object.freeze(["return-data", "revert-data", "token-delta", "native-delta", ...(input.observeLogs ? ["logs" as const] : [])] as const),
  });
}

/** Regenerate the exact request before accepting its observed effects. A valid
 * receipt for different calldata, protected inventory or an amount is unusable.
 * Return only the independently observed output; the template's sample output
 * is intentionally never read by this path. */
export function decodeObservedCallSimulationReceipt(input: ObservedCallSimulationInput & {
  readonly request: AdapterRequest;
  readonly result: AdapterRequestResult;
}): bigint {
  const expected = buildObservedCallSimulation({ ...input, id: input.request.id });
  if (hashCanonical(expected as unknown as CanonicalValue) !== hashCanonical(input.request as unknown as CanonicalValue))
    throw new Error("observed call simulation request binding mismatch");
  const amountOut = decodeDeclarativeExecutionSimulationReceipt({ request: input.request, result: input.result,
    source: input.source, executor: input.executor, tokenIn: input.template.sample.tokenIn,
    tokenOut: input.template.sample.tokenOut, amountIn: input.amountIn });
  if (amountOut < (input.minimumAmountOut ?? 1n)) throw new Error("observed call output below minimum");
  return amountOut;
}
