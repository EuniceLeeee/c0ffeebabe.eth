import { getAddress, Interface, ZeroAddress } from "ethers";
import { buildDeclarativeExecutionProgram, type DeclarationValues, type DeclarativeConversionExecution } from "./declarative-execution.js";

export interface ObservedExecutionOwnerConstraints {
  readonly protectedTokens: readonly string[];
  readonly outputWordOffset?: number;
}

function unsupported(reason: string): never {
  throw new Error(`observed execution owner unsupported: ${reason}`);
}
function same(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && getAddress(a) === getAddress(b);
}
function runtime(value: any, name?: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && typeof value.runtime === "string" && (name === undefined || value.runtime === name);
}
function boundedEmpty(value: unknown, label: string): void {
  if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) unsupported(label);
}

/** A learned selector may replace only the direct call of an owner whose full
 * execution contract can be enforced by the common observed-call compiler.
 * This is an eligibility check, not an alternative Family or Ready issuer.
 * Unsupported preflights, callbacks, arithmetic and asset effects fail closed.
 */
export function assertObservedExecutionOwner(
  spec: DeclarativeConversionExecution,
  input: Record<string, any>,
  values: DeclarationValues,
): ObservedExecutionOwnerConstraints {
  if (!spec || (spec.version !== 1 && spec.version !== 2)) unsupported("execution version");
  if (input.settlement !== undefined || input.settlementRequested === true) unsupported("nondefault settlement");
  if (spec.settlement?.settleOutput !== undefined) unsupported("debt settlement");
  boundedEmpty(spec.preflight, "preflight calls");
  if (spec.version === 2 && (spec.deferred !== undefined || spec.framedSettlement !== undefined || spec.quoteOutput !== undefined))
    unsupported("deferred, framed or quoted execution");

  // Match executionContext: an exact quote must not become a runtime amount.
  const context: Record<string, any> = {};
  for (const key of Object.keys(input)) {
    if (["amountIn", "quotedAmountOut", "exactEvidence"].includes(key)) continue;
    const property = Object.getOwnPropertyDescriptor(input, key)!;
    if (!("value" in property)) unsupported("context accessor");
    context[key] = property.value;
  }
  const recipient = context.recipient ?? context.executor;
  if (!same(recipient, context.executor)) unsupported("external recipient");
  const minAmountOut = context.minAmountOut ?? 1n;
  const env = { ...context, recipient, minAmountOut, directSettlement: false,
    externalRecipient: false, fundedSettlement: true, deferredSettlement: false };
  const resolve = (value: any) => values.evaluate(value, env);
  let rawCall: any, rawApproval: any;
  if (spec.version === 1) { rawCall = spec.call; rawApproval = spec.approval; }
  else {
    if (!Array.isArray(spec.steps) || spec.steps.length !== 1) unsupported("requires one direct call");
    const step = spec.steps[0];
    if (!step || typeof step !== "object" || Array.isArray(step) || step.op !== undefined || step.frame !== undefined ||
        step.math !== undefined || step.static === true || step.call === undefined) unsupported("requires one direct call");
    if (step.when !== undefined && resolve(step.when) !== true) unsupported("inactive direct call");
    boundedEmpty(step.effects, "per-step asset effects");
    rawCall = step.call; rawApproval = step.approval;
  }
  const call = resolve(rawCall);
  if (!call || typeof call !== "object" || !same(call.target, context.route?.target)) unsupported("call target binding");
  boundedEmpty(call.checks, "call result checks");
  if (call.when !== undefined || call.value !== undefined && call.value !== 0n && call.value !== 0 && call.value !== "0")
    unsupported("conditional or native-value call");

  const approval = rawApproval === undefined ? undefined : resolve(rawApproval);
  if (approval && (approval.when === undefined || approval.when)) {
    if (!same(approval.token, context.route?.tokenIn) || !same(approval.spender, context.route?.target) ||
        !["ensure", "exact-clear"].includes(approval.mode) || approval.requireBool !== undefined && approval.requireBool !== false ||
        approval.amount !== undefined && !runtime(approval.amount, "amountIn")) unsupported("approval contract");
  }

  // A narrower ABI input would have had its own range guard in the original
  // program. It cannot silently disappear when replacing that program.
  const abi = new Interface([call.signature]);
  const fn = abi.getFunction(abi.fragments[0]!.format("sighash"));
  if (!fn || !Array.isArray(call.args) || fn.inputs.length !== call.args.length) unsupported("direct call shape");
  if (!fn.inputs.every(param => /^(uint[0-9]*|int[0-9]*|address|bool|bytes[0-9]+)$/.test(param.type)))
    unsupported("non-scalar owner ABI");
  for (const [index, arg] of call.args.entries()) {
    if (runtime(arg) && (!runtime(arg, "amountIn") || !["uint256", "int256"].includes(fn.inputs[index]!.type)))
      unsupported("runtime ABI amount constraint");
  }

  if (!Array.isArray(spec.effects) || spec.effects.length > 64 || spec.effects.some(effect => effect?.op !== undefined))
    unsupported("projected asset effects");
  const effects = spec.effects.map(raw => ({ raw, effect: resolve(raw) })).filter(({ effect }) => {
    if (!effect || typeof effect !== "object" || Array.isArray(effect)) unsupported("asset effect shape");
    if (effect.when !== undefined && typeof effect.when !== "boolean") unsupported("asset effect condition");
    return effect.when !== false;
  });
  const debits = effects.filter(({ effect }) => effect.kind === "debit");
  const credits = effects.filter(({ effect }) => effect.kind === "credit");
  if (debits.length !== 1 || credits.length !== 1) unsupported("requires one debit and one credit");
  const debit = debits[0]!.effect, credit = credits[0]!.effect;
  if (!same(debit.token, context.route?.tokenIn) || !same(debit.account, context.executor) || !runtime(debit.equals, "amountIn") ||
      debit.minimum !== undefined || debit.maximum !== undefined || debit.asset === "native") unsupported("full input debit");
  if (!same(credit.token, context.route?.tokenOut) || !same(credit.account, context.executor) || credit.asset === "native" ||
      credit.maximum !== undefined || credit.minimum !== undefined && credits[0]!.raw.minimum !== "$minAmountOut")
    unsupported("fresh output bounds");

  let outputWordOffset: number | undefined;
  const saves = Object.entries(call.save ?? {});
  if (credit.equals !== undefined) {
    if (!runtime(credit.equals) || saves.length !== 1 || saves[0]![0] !== credit.equals.runtime ||
        !Number.isSafeInteger(saves[0]![1]) || (saves[0]![1] as number) < 0) unsupported("output equality is not one returned word");
    outputWordOffset = (saves[0]![1] as number) * 32;
    if (outputWordOffset > 65504) unsupported("output word bound");
  } else if (saves.length) unsupported("unpreserved return-word capture");

  const protectedTokens = new Set<string>();
  for (const { effect } of effects) {
    if (effect.kind === "debit" || effect.kind === "credit") continue;
    if (effect.kind === "unchanged-native") {
      if (effect.account !== undefined && !same(effect.account, context.executor)) unsupported("foreign native balance");
      continue;
    }
    if (effect.kind !== "unchanged-token" || !same(effect.account, context.executor) || effect.asset === "native" ||
        effect.equals !== undefined || effect.minimum !== undefined || effect.maximum !== undefined)
      unsupported("additional asset effect");
    const token = getAddress(effect.token);
    if (token === ZeroAddress || same(token, context.executor) || same(token, context.route.tokenIn) || same(token, context.route.tokenOut))
      unsupported("conflicting unchanged-token effect");
    protectedTokens.add(token);
  }
  if (protectedTokens.size > 8) unsupported("protected-token bound");

  // Reuse the original compiler's context checks, protected-address exclusions,
  // source requirements and full declaration validation. No call is executed.
  buildDeclarativeExecutionProgram(spec, context, values);
  return Object.freeze({ protectedTokens: Object.freeze([...protectedTokens].sort()),
    ...(outputWordOffset === undefined ? {} : { outputWordOffset }) });
}
