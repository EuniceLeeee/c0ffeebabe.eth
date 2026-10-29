import { getAddress, getBytes, MaxUint256 } from "ethers";
import { runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { assertSubscriptCalldata, buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { executionNativeSides } from "../execution-asset-boundary.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, EffectObservationKind, RequestRequirements } from "./adapter-request-program.js";
import { RequiredAdapterRequestError } from "./adapter-request-failure.js";
import { assertDeclarativeExecutionSource, buildDeclarativeRuntimeLeg,
  type DeclarativeConversionExecution, type DeclarativeExecutionOptions, type DeclarationValues } from "./declarative-execution.js";
import { assertModuleData } from "./declarative-modules.js";
import { verifyDeclarativeQuoteProof } from "./declarative-quote-proof.js";
import { runtimeExecutor } from "./runtime-execution.js";
import { assertSource } from "./protocols/standard-family/common.js";

type Data = Record<string, any>;
type SimulationRequest = Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }>;
export interface DeclarativeExecutionSimulation {
  readonly kind: "declarative-execution-simulation";
  readonly id: string;
  readonly amountIn: unknown;
  /** Extra executor token inventories which the receipt must prove unchanged. */
  readonly protectedTokens?: unknown;
  readonly observe?: readonly EffectObservationKind[];
  readonly required?: boolean;
}
const BASE_EFFECTS = ["return-data", "revert-data", "token-delta", "native-delta"] as const;
const EFFECTS = new Set<EffectObservationKind>([...BASE_EFFECTS, "logs"]);
function positive(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MaxUint256) throw new Error("execution simulation requires positive uint256 input");
}
export function validateDeclarativeExecutionSimulation(value: unknown): asserts value is DeclarativeExecutionSimulation {
  assertModuleData(value);
  const d = value as DeclarativeExecutionSimulation;
  if (!d || Array.isArray(d) || typeof d !== "object" ||
    Object.keys(d).some(key => !["kind", "id", "amountIn", "protectedTokens", "observe", "required"].includes(key)) ||
    d.kind !== "declarative-execution-simulation" || typeof d.id !== "string" || !d.id || d.id.trim() !== d.id ||
    !Object.hasOwn(d, "amountIn") || d.required !== undefined && typeof d.required !== "boolean" ||
    d.observe !== undefined && (!Array.isArray(d.observe) || d.observe.some(kind => !EFFECTS.has(kind)) || new Set(d.observe).size !== d.observe.length))
    throw new Error("invalid declarative execution simulation");
}
export function declarativeExecutionSimulationRequirements(declaration: DeclarativeExecutionSimulation): RequestRequirements {
  validateDeclarativeExecutionSimulation(declaration);
  return Object.freeze({ transports: Object.freeze(["effect-delta-simulation" as const]), caller: "executor" as const,
    effects: Object.freeze([...new Set<EffectObservationKind>([...BASE_EFFECTS, ...(declaration.observe ?? [])])]) });
}

/** The caller binds the invocation and its execution declaration. JSON cannot
 * supply VM bytes, a substitute caller, arbitrary funding, or setup pre-calls.
 * The existing transport still authenticates the executor and its runtime code. */
export function buildDeclarativeExecutionSimulation(
  declaration: DeclarativeExecutionSimulation,
  input: Data,
  values: DeclarationValues,
  execution: DeclarativeConversionExecution,
  options: DeclarativeExecutionOptions = {},
): SimulationRequest {
  const requirements = declarativeExecutionSimulationRequirements(declaration);
  const amountIn = values.evaluate(declaration.amountIn, input); positive(amountIn);
  const tokenIn = getAddress(input.route.tokenIn), tokenOut = getAddress(input.route.tokenOut);
  if (tokenIn === tokenOut) throw new Error("execution simulation requires distinct assets");
  const actor = runtimeExecutor(input.executor, tokenIn, tokenOut);
  if (input.settlement !== undefined || input.recipient !== undefined && getAddress(input.recipient) !== actor)
    throw new Error("execution simulation requires default executor receipt");
  const protectedTokens = declaration.protectedTokens === undefined ? [] : values.evaluate(declaration.protectedTokens, input);
  if (!Array.isArray(protectedTokens) || protectedTokens.some(token => typeof token !== "string"))
    throw new Error("execution simulation protected tokens must be addresses");
  const tokens = [...new Set([tokenIn, tokenOut, ...protectedTokens.map(getAddress)])];
  const leg = buildDeclarativeRuntimeLeg(execution, input, values, options);
  if (!leg) throw new Error("execution simulation has no runtime program");
  const caller = Object.freeze({ kind: "executor" as const });
  const native = executionNativeSides(input.route);
  return Object.freeze({ id: declaration.id, kind: "effect-delta-simulation",
    ...(declaration.required === undefined ? {} : { required: declaration.required }),
    call: Object.freeze({ caller, executionMode: "executor-program", to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(getBytes(leg.program), amountIn)) }),
    overrideIntent: Object.freeze({ caller, tokenBalances: Object.freeze([Object.freeze({ token: tokenIn, amount: amountIn })]) }),
    observeTokenBalances: Object.freeze(tokens.map(token => Object.freeze({ token, account: caller }))),
    observe: requirements.effects!,
    ...(native ? { executionAssetBoundary: Object.freeze({ tokenIn, tokenOut, amountIn, minimum: 1n,
      executionAssets: Object.freeze({ ...input.route.executionAssets }) }) } : {}),
  });
}

function observed(input: { request: AdapterRequest; result: AdapterRequestResult; source: CanonicalSource }):
  asserts input is { request: SimulationRequest; result: Extract<AdapterRequestResult, { ok: true }>; source: CanonicalSource } {
  const { request, result, source } = input;
  assertDeclarativeExecutionSource(source); assertDeclarativeExecutionSource(result.source); assertSource(result.source, source);
  if (!result.ok) throw new RequiredAdapterRequestError(result);
  if ((request.kind !== "effect-delta-simulation" && request.kind !== "state-override-simulation") || request.id !== result.id ||
    request.call.caller.kind !== "executor" || request.overrideIntent.caller.kind !== "executor" ||
    result.completion !== "returned" || !result.provenance?.kind || !result.provenance.fingerprint)
    throw new Error("execution simulation lacks observed executor receipt");
}

/** Extract an identity probe's actor from the issuer-owned observed debit,
 * paired with its original symbolic-executor request. This does not itself
 * grant authority; the next executor-program request is rechecked centrally. */
export function executorFromObservedSimulation(input: {
  readonly request: AdapterRequest; readonly result: AdapterRequestResult; readonly source: CanonicalSource;
  readonly tokenIn: string; readonly amountIn: bigint;
}): string {
  observed(input); positive(input.amountIn);
  const token = getAddress(input.tokenIn);
  if (!input.request.observe.includes("token-delta") || !input.request.observeTokenBalances?.some(row =>
    getAddress(row.token) === token && typeof row.account !== "string" && row.account.kind === "executor"))
    throw new Error("executor actor requires a symbolic input observation");
  const rows = input.result.effects?.tokenDeltas?.filter(row => getAddress(row.token) === token);
  if (!rows || rows.length !== 1 || rows[0]!.delta !== -input.amountIn) throw new Error("executor actor requires a unique observed input debit");
  return runtimeExecutor(rows[0]!.account, token);
}

/** Reuse the same chain-quote debit/receipt proof. Program receipts additionally
 * require empty execSubscript return data and conservation of every observed
 * extra token and native balance. Protocol events remain ordinary JSON checks. */
export function decodeDeclarativeExecutionSimulationReceipt(input: {
  readonly request: AdapterRequest; readonly result: AdapterRequestResult; readonly source: CanonicalSource;
  readonly executor: string; readonly tokenIn: string; readonly tokenOut: string; readonly amountIn: bigint;
}): bigint {
  observed(input); positive(input.amountIn);
  const { request, result } = input;
  const tokenIn = getAddress(input.tokenIn), tokenOut = getAddress(input.tokenOut);
  const actor = runtimeExecutor(input.executor, tokenIn, tokenOut);
  if (tokenIn === tokenOut || request.call.executionMode !== "executor-program" || getAddress(request.call.to) !== actor ||
    request.preCalls?.length || result.data !== "0x" || !request.observe.includes("native-delta"))
    throw new Error("invalid executor-program receipt");
  assertSubscriptCalldata(request.call.data);
  const funding = request.overrideIntent.tokenBalances;
  if (request.overrideIntent.nativeBalanceWei !== undefined || funding?.length !== 1 ||
    getAddress(funding[0]!.token) !== tokenIn || funding[0]!.amount !== input.amountIn)
    throw new Error("executor-program simulation funding mismatch");
  const observations = request.observeTokenBalances;
  if (!observations || observations.some(row => typeof row.account === "string" || row.account.kind !== "executor"))
    throw new Error("executor-program receipt requires symbolic observations");
  const tokens = observations.map(row => getAddress(row.token));
  if (new Set(tokens).size !== tokens.length || !tokens.includes(tokenIn) || !tokens.includes(tokenOut))
    throw new Error("executor-program receipt observation scope mismatch");
  const deltas = result.effects?.tokenDeltas;
  if (!deltas || deltas.length !== tokens.length || deltas.some(row => !tokens.includes(getAddress(row.token)) || getAddress(row.account) !== actor) ||
    new Set(deltas.map(row => getAddress(row.token))).size !== deltas.length)
    throw new Error("executor-program receipt token scope mismatch");
  const amountOut = deltas.find(row => getAddress(row.token) === tokenOut)!.delta; positive(amountOut);
  verifyDeclarativeQuoteProof({ ...input, amountOut, sourceKind: "effect-simulation",
    proof: { step: "execution", requestId: request.id } });
  for (const row of deltas) if (![tokenIn, tokenOut].includes(getAddress(row.token)) && row.delta !== 0n)
    throw new Error("executor-program receipt changed protected inventory");
  const native = result.effects?.nativeDeltas;
  if (!native || native.length !== 1 || getAddress(native[0]!.account) !== actor || native[0]!.delta !== 0n)
    throw new Error("executor-program receipt changed native inventory");
  return amountOut;
}
