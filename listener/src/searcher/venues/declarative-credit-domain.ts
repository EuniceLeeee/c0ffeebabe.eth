import { FunctionFragment, Interface, MaxUint256, ZeroAddress, getAddress, type ParamType } from "ethers";
import type { CompiledInstanceDescriptor, CreditDomainSemantics, CreditRiskProgramInput, FamilyRouteDescriptor } from "./adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "./adapter-request-program.js";
import { compileDeclarativeReadFlow, validateDeclarativeReadFlow, type DeclarativeReadFlow, type ReadFlowInput, type ReadFlowValues } from "./declarative-read-flow.js";
import { validateDeclarativeStatements, validateDeclarativeValue } from "./declarative-values.js";
import { assertDeclarativeExecutionSource } from "./declarative-execution.js";
import { assertSource } from "./protocols/standard-family/common.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import { immutableDeclarativeData } from "./declarative-immutable.js";

type Data = Record<string, any>;
type Input = CreditRiskProgramInput<CompiledInstanceDescriptor, FamilyRouteDescriptor>;
type Path = readonly number[];
// Match adapter-credit-runtime's current issuer budget: one initial read plus
// four dependent rounds. This is a shared-runtime limit, not a protocol's
// prescribed call sequence; the JSON still owns all steps within that budget.
const CREDIT_ISSUER_MAX_READ_STEPS = 5;
interface Proof {
  readonly profile: "new-position-return-and-effects-v1";
  readonly step: string;
  readonly requestId: string;
  readonly signature: string;
  readonly target: unknown;
  readonly call: { readonly position: Path; readonly collateral: Path; readonly debt: Path; readonly recipient: Path };
  readonly returns: { readonly position: Path; readonly collateral: Path; readonly debt: Path };
}
export interface DeclarativeCreditDomain {
  readonly version: 1;
  readonly activeBehaviorProof: "required";
  readonly position: { readonly lifecycle: "standing-position"; readonly finalSafety: "position-and-repayment-required"; readonly key: unknown };
  readonly risk: {
    readonly debtBpsCandidates: readonly string[];
    readonly blocksPrefixInversion: true;
    readonly inputChecks?: readonly unknown[];
    readonly evidence: DeclarativeReadFlow;
    readonly proof: Proof;
    readonly quote: { readonly checks: readonly unknown[]; readonly result: unknown };
  };
}
export interface DeclarativeCreditContext {
  assertInvocation(input: { descriptor: CompiledInstanceDescriptor; route: FamilyRouteDescriptor }): void;
  environment(input: Data): Data;
  materializeRequests?(requests: readonly Data[], environment: Data): readonly AdapterRequest[];
}
interface RiskEvidence {
  readonly kind: "declarative-credit-risk-v1";
  readonly source: Input["source"];
  readonly executor: string;
  readonly transactionOrigin?: string;
  readonly runtimeEvidence: Input["runtimeEvidence"];
  readonly descriptorHash: string;
  readonly routeHash: string;
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly result: unknown;
  readonly observations: readonly AdapterRequestResult[];
}
function shape(value: any, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("invalid Credit declaration shape");
}
function parameter(parameters: readonly ParamType[], path: unknown, kind: "amount" | "position" | "address"): void {
  if (!Array.isArray(path) || !path.length || path.length > 16 || path.some(i => !Number.isSafeInteger(i) || i < 0))
    throw new Error("Credit proof requires bounded ABI paths");
  let item: ParamType | undefined = parameters[path[0]];
  for (const index of path.slice(1)) {
    if (item?.baseType === "tuple") item = item.components?.[index];
    else if (item?.baseType === "array" && (item.arrayLength === -1 || index < item.arrayLength!)) item = item.arrayChildren ?? undefined;
    else item = undefined;
  }
  if (!item || (kind === "address" ? item.type !== "address" : kind === "position" ? !/^uint(?:[0-9]+)?$/.test(item.type) : !/^u?int(?:[0-9]+)?$/.test(item.type)))
    throw new Error("Credit proof ABI field type mismatch");
}
function valueAt(values: unknown, path: Path): unknown {
  let value = values;
  for (const index of path) {
    if (!Array.isArray(value) || index >= value.length) throw new Error("Credit proof ABI value missing");
    value = value[index];
  }
  return value;
}
export function validateDeclarativeCreditDomain(raw: unknown): asserts raw is DeclarativeCreditDomain {
  validateDeclarativeValue(raw);
  const d = raw as DeclarativeCreditDomain;
  shape(d, ["version", "activeBehaviorProof", "position", "risk"]);
  shape(d.position, ["lifecycle", "finalSafety", "key"]);
  shape(d.risk, ["debtBpsCandidates", "blocksPrefixInversion", "evidence", "proof", "quote"], ["inputChecks"]);
  if (d.version !== 1 || d.activeBehaviorProof !== "required" || d.position.lifecycle !== "standing-position" ||
      d.position.finalSafety !== "position-and-repayment-required" || d.risk.blocksPrefixInversion !== true)
    throw new Error("Credit lifecycle and final safety are mandatory");
  const candidates = d.risk.debtBpsCandidates;
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 10000 ||
      candidates.some(n => typeof n !== "string" || !/^[1-9][0-9]{0,4}$/.test(n) || BigInt(n) > 10000n) ||
      candidates.some((n, index) => index > 0 && BigInt(n) <= BigInt(candidates[index - 1]!)))
    throw new Error("Credit debt candidates must be strictly increasing positive basis points");
  validateDeclarativeReadFlow(d.risk.evidence);
  if (d.risk.evidence.steps.length > CREDIT_ISSUER_MAX_READ_STEPS)
    throw new Error("Credit evidence exceeds the current issuer read-round budget");
  const p = d.risk.proof;
  shape(p, ["profile", "step", "requestId", "signature", "target", "call", "returns"]);
  shape(p.call, ["position", "collateral", "debt", "recipient"]); shape(p.returns, ["position", "collateral", "debt"]);
  if (p.profile !== "new-position-return-and-effects-v1" || typeof p.requestId !== "string" || !p.requestId.trim() ||
      typeof p.signature !== "string" || !d.risk.evidence.steps.some(step => step.id === p.step)) throw new Error("unsupported Credit proof profile or step");
  const fn = FunctionFragment.from(p.signature);
  parameter(fn.inputs, p.call.position, "position"); parameter(fn.inputs, p.call.collateral, "amount");
  parameter(fn.inputs, p.call.debt, "amount"); parameter(fn.inputs, p.call.recipient, "address");
  parameter(fn.outputs, p.returns.position, "position"); parameter(fn.outputs, p.returns.collateral, "amount"); parameter(fn.outputs, p.returns.debt, "amount");
  for (const paths of [Object.values(p.call), Object.values(p.returns)])
    if (new Set(paths.map(path => JSON.stringify(path))).size !== paths.length) throw new Error("Credit proof fields must be distinct");
  shape(d.risk.quote, ["checks", "result"]);
  validateDeclarativeStatements(d.risk.inputChecks ?? []); validateDeclarativeStatements(d.risk.quote.checks);
  if (!d.risk.quote.checks.length) throw new Error("Credit quote must declare its risk-model checks");
}

/** A constrained new-position proof, not generic debt strategy support. JSON
 * owns every read, dependency round, ABI path and risk calculation. The common
 * layer binds actual returned position/debt values and debit/receipt effects;
 * final position closure and repayment remain the central mandatory gate. */
export function compileDeclarativeCreditDomain(raw: unknown, values: ReadFlowValues, context: DeclarativeCreditContext) {
  validateDeclarativeCreditDomain(raw);
  const d = immutableDeclarativeData(JSON.parse(JSON.stringify(raw)) as DeclarativeCreditDomain, "trial");
  const flow = compileDeclarativeReadFlow(d.risk.evidence, values, context.materializeRequests);
  const debtBpsCandidates = Object.freeze(d.risk.debtBpsCandidates.map(BigInt));
  const fn = FunctionFragment.from(d.risk.proof.signature), abi = new Interface([fn]);
  const same = (a: string, b: string) => getAddress(a) === getAddress(b);
  function environment(input: Input): ReadFlowInput {
    context.assertInvocation(input); assertDeclarativeExecutionSource(input.source);
    const executor = getAddress(input.executor);
    if (executor === ZeroAddress || same(input.route.tokenIn, input.route.tokenOut) ||
        [input.route.tokenIn, input.route.tokenOut].some(token => same(executor, token)) ||
        typeof input.collateralAmount !== "bigint" || input.collateralAmount <= 0n || input.collateralAmount > MaxUint256 ||
        !debtBpsCandidates.includes(input.debtBps)) throw new Error("Credit risk invocation is invalid");
    if (input.transactionOrigin !== undefined && getAddress(input.transactionOrigin) === ZeroAddress) throw new Error("Credit origin is invalid");
    const env = context.environment({ ...input, executor });
    assertSource(env.source, input.source);
    values.run(d.risk.inputChecks ?? [], env);
    return env as ReadFlowInput;
  }
  function reconstruct(input: Input, observations: readonly AdapterRequestResult[]) {
    const env = environment(input);
    if (!Array.isArray(observations) || new Set(observations.map(row => row.id)).size !== observations.length)
      throw new Error("Credit evidence has duplicate results");
    const seen = new Set<string>();
    const take = (requests: readonly AdapterRequest[]) => {
      for (const request of requests) {
        if (seen.has(request.id)) throw new Error("Credit flow reused a request id");
        seen.add(request.id);
      }
      const ids = new Set(requests.map(request => request.id));
      return observations.filter(row => ids.has(row.id));
    };
    const initialResults = take(flow.program.buildRequests(env));
    const dependentEvidence: unknown[] = [];
    for (;;) {
      const bound = flow.program.buildDependentProgram!({ programInput: env, initialResults, priorEvidence: dependentEvidence, completedRound: dependentEvidence.length });
      if (!bound) break;
      dependentEvidence.push(bound.decode(take(bound.requests)));
    }
    if (seen.size !== observations.length || observations.some(row => !seen.has(row.id))) throw new Error("Credit evidence has unrelated or missing results");
    const result = flow.program.decode({ programInput: env, initialResults, dependentEvidence });
    const proof = flow.requestEvidence(env, initialResults, dependentEvidence, d.risk.proof.step, d.risk.proof.requestId);
    const complete = flow.completedEnvironment(env, initialResults, dependentEvidence);
    return { result, proof, complete };
  }
  function verifyProof(input: Input, reconstructed: ReturnType<typeof reconstruct>): bigint {
    const { request, result } = reconstructed.proof, spec = d.risk.proof;
    const target = values.evaluate(spec.target, reconstructed.complete);
    if ((request.kind !== "effect-delta-simulation" && request.kind !== "state-override-simulation") ||
        request.call.caller.kind !== "executor" || request.overrideIntent.caller.kind !== "executor" ||
        !same(request.call.to, target) || !request.observe.includes("return-data") || !request.observe.includes("token-delta") ||
        !result.ok || result.completion !== "returned" || !result.provenance?.kind || !result.provenance.fingerprint)
      throw new Error("Credit requires a successful issuer-bound position simulation");
    assertDeclarativeExecutionSource(result.source); assertSource(result.source, input.source);
    const funding = request.overrideIntent.tokenBalances;
    if (request.overrideIntent.nativeBalanceWei !== undefined || funding?.length !== 1 ||
        !same(funding[0]!.token, input.route.tokenIn) || funding[0]!.amount !== input.collateralAmount)
      throw new Error("Credit proof funding must match the issued collateral input");
    if (input.transactionOrigin === undefined
      ? request.call.executionMode !== undefined && request.call.executionMode !== "top-level"
      : request.call.executionMode !== "impersonated-call-frame")
      throw new Error("Credit proof execution mode does not match caller authority");
    const args = abi.decodeFunctionData(fn, request.call.data), returned = abi.decodeFunctionResult(fn, result.data);
    if (abi.encodeFunctionData(fn, args).toLowerCase() !== request.call.data.toLowerCase() ||
        abi.encodeFunctionResult(fn, returned).toLowerCase() !== result.data.toLowerCase()) throw new Error("Credit proof requires canonical ABI encoding");
    const debt = valueAt(args, spec.call.debt), position = valueAt(returned, spec.returns.position);
    if (valueAt(args, spec.call.position) !== 0n || valueAt(args, spec.call.collateral) !== input.collateralAmount ||
        typeof debt !== "bigint" || debt <= 0n || debt > MaxUint256 || typeof position !== "bigint" || position <= 0n ||
        !same(valueAt(args, spec.call.recipient) as string, input.executor) ||
        valueAt(returned, spec.returns.collateral) !== input.collateralAmount || valueAt(returned, spec.returns.debt) !== debt)
      throw new Error("Credit return does not prove the requested new position, collateral and debt");
    for (const [token, expected] of [[input.route.tokenIn, -input.collateralAmount], [input.route.tokenOut, debt]] as const) {
      if (!request.observeTokenBalances?.some(row => same(row.token, token) && typeof row.account !== "string" && row.account.kind === "executor"))
        throw new Error("Credit effects need symbolic executor observations");
      const rows = result.effects?.tokenDeltas?.filter(row => same(row.token, token) && same(row.account, input.executor));
      if (rows?.length !== 1 || rows[0]!.delta !== expected) throw new Error("Credit collateral debit or debt receipt mismatch");
    }
    return debt;
  }
  function quote(input: { descriptor: CompiledInstanceDescriptor; route: FamilyRouteDescriptor; collateralAmount: bigint; debtBps: bigint; evidence?: RiskEvidence }) {
    context.assertInvocation(input);
    const e = input.evidence;
    if (!e || e.kind !== "declarative-credit-risk-v1" || e.descriptorHash !== hashCanonical(input.descriptor as unknown as CanonicalValue) ||
        e.routeHash !== hashCanonical(input.route as unknown as CanonicalValue) || e.collateralAmount !== input.collateralAmount || e.debtBps !== input.debtBps)
      throw new Error("Credit risk evidence binding mismatch");
    const invocation: Input = { ...input, source: e.source, executor: e.executor, runtimeEvidence: e.runtimeEvidence,
      ...(e.transactionOrigin === undefined ? {} : { transactionOrigin: e.transactionOrigin }) };
    const decoded = reconstruct(invocation, e.observations), debt = verifyProof(invocation, decoded);
    if (hashCanonical(decoded.result as unknown as CanonicalValue) !== hashCanonical(e.result as unknown as CanonicalValue)) throw new Error("Credit evidence result was replaced");
    const env = { ...decoded.complete, evidence: decoded.result, proofDebt: debt };
    values.run(d.risk.quote.checks, env);
    const output = values.evaluate(d.risk.quote.result, env);
    if (typeof output !== "bigint" || output !== debt) throw new Error("Credit quote must equal actual debt receipt");
    return output;
  }
  const definition: CreditDomainSemantics<CompiledInstanceDescriptor, FamilyRouteDescriptor, RiskEvidence> = {
    activeBehaviorProof: "required",
    position: { lifecycle: "standing-position", finalSafety: "position-and-repayment-required", positionKey(input) {
      context.assertInvocation(input);
      const key = values.evaluate(d.position.key, context.environment(input));
      if (typeof key !== "string" || !key.trim()) throw new Error("Credit position key is empty");
      return key;
    } },
    risk: { debtBpsCandidates, blocksPrefixInversion: true, evidence: {
      requirements: input => flow.program.requirements(environment(input)),
      buildRequests: input => flow.program.buildRequests(environment(input)),
      buildDependentProgram(input) {
        const bound = flow.program.buildDependentProgram!({ ...input, programInput: environment(input.programInput) });
        if (!bound) return null;
        return { requirements: bound.requirements, requests: bound.requests, decode(results) {
          bound.decode(results);
          // Credit's issuer checks object identity against trustedResults. The
          // generic read flow may clone validation data; retain original refs.
          return Object.freeze({ stepId: flow.stepIds[input.completedRound + 1], results: Object.freeze([...results]) });
        } };
      },
      decode({ programInput: input, results }) {
        const decoded = reconstruct(input, results); verifyProof(input, decoded);
        const evidence: RiskEvidence = immutableDeclarativeData({ kind: "declarative-credit-risk-v1", source: input.source,
          executor: getAddress(input.executor), ...(input.transactionOrigin === undefined ? {} : { transactionOrigin: getAddress(input.transactionOrigin) }),
          runtimeEvidence: input.runtimeEvidence, descriptorHash: hashCanonical(input.descriptor as unknown as CanonicalValue), routeHash: hashCanonical(input.route as unknown as CanonicalValue),
          collateralAmount: input.collateralAmount, debtBps: input.debtBps, result: decoded.result, observations: results }, "trial");
        quote({ ...input, evidence });
        return evidence;
      },
    }, quoteOutputByDebtBps: quote },
  };
  return Object.freeze({ definition, verifyExecutionEvidence(input: Data, evidence: unknown): boolean {
    const e = evidence as RiskEvidence | undefined;
    if (!e || e.kind !== "declarative-credit-risk-v1") return false;
    if (!same(input.executor, e.executor) || input.amountIn !== e.collateralAmount ||
        (input.transactionOrigin === undefined ? e.transactionOrigin !== undefined : e.transactionOrigin === undefined || !same(input.transactionOrigin, e.transactionOrigin)))
      throw new Error("Credit execution actor or collateral mismatch");
    if (input.source !== undefined) assertSource(e.source, input.source);
    const amount = quote({ descriptor: input.descriptor, route: input.route, collateralAmount: input.amountIn, debtBps: e.debtBps, evidence: e });
    if (amount !== input.quotedAmountOut) throw new Error("Credit execution debt amount mismatch");
    return true;
  } });
}
