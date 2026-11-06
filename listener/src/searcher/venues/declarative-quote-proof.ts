import { ErrorFragment, FunctionFragment, Interface, getAddress, type ParamType } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "./adapter-request-program.js";
import { assertSource } from "./protocols/standard-family/common.js";
import { verifiedMulticallItem } from "./declarative-multicall-proof.js";
import { validateDeclarativeValue } from "./declarative-values.js";

export type DeclarativeQuoteSource = "view" | "effect-simulation";
export interface DeclarativeQuoteProof {
  readonly version?: 2;
  readonly step: string;
  readonly requestId: string;
  readonly signature?: string;
  readonly amountPath?: readonly number[];
  readonly outputPath?: readonly number[];
  readonly completion?: "returned" | "reverted-as-declared";
  readonly requestBinding?: { readonly target: unknown; readonly caller: unknown };
  readonly errorSignature?: string;
  readonly multicall?: { readonly index: unknown; readonly target: unknown; readonly calldata: unknown };
  readonly outputWord?: { readonly offset: number; readonly width: number; readonly signed: boolean; readonly negate?: boolean };
  readonly inputBinding?: { readonly value: unknown; readonly checks: readonly unknown[] };
  /** An ABI view may return a gross transfer. The declaration binds the input asset,
   * source-derived headroom and a proven proportional output deduction. */
  readonly receiptBinding?: {
    readonly inputAssetPath: readonly number[];
    readonly feeNumerator: unknown;
    readonly feeDenominator: unknown;
    readonly maximumInput: unknown;
    readonly unavailableOnRevertOrEmpty: boolean;
  };
}
export interface DeclarativeQuoteEvaluation {
  readonly evaluate?: (value: unknown, environment: Record<string, unknown>) => unknown;
  /** Must be reconstructed by the source-bound read flow, never supplied as quote evidence. */
  readonly environment?: Readonly<Record<string, unknown>>;
}

function record(raw: unknown): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype)
    throw new Error("chain quote proof must be a plain definition");
  for (const field of Object.values(Object.getOwnPropertyDescriptors(raw))) {
    if (!("value" in field)) throw new Error("chain quote proof accessors are unsupported");
  }
}
function amountType(parameters: readonly ParamType[], path: unknown, pattern = /^uint([0-9]+)?$/): void {
  if (!Array.isArray(path) || !path.length || path.some(index => !Number.isSafeInteger(index) || index < 0))
    throw new Error("chain quote proof requires integer ABI paths");
  let parameter: ParamType | undefined = parameters[path[0]];
  for (const index of path.slice(1)) {
    if (!parameter) break;
    if (parameter.baseType === "tuple") parameter = parameter.components?.[index];
    else if (parameter.baseType === "array" && (parameter.arrayLength === -1 || index < parameter.arrayLength!))
      parameter = parameter.arrayChildren ?? undefined;
    else parameter = undefined;
  }
  if (!parameter || !pattern.test(parameter.type)) throw new Error("chain quote proof ABI path must identify an unsigned amount or declared word");
}

/** A declaration identifies evidence; it never manufactures source provenance. */
export function validateDeclarativeQuoteProof(raw: unknown, sourceKind: DeclarativeQuoteSource): asserts raw is DeclarativeQuoteProof {
  record(raw);
  if (sourceKind !== "view" && sourceKind !== "effect-simulation") throw new Error("unsupported chain quote proof source");
  const extended = raw.version === 2;
  const allowed = sourceKind === "view"
    ? ["step", "requestId", "signature", "amountPath", "outputPath", "completion",
      ...(extended ? ["version", "multicall", "requestBinding", "errorSignature", "outputWord", "inputBinding", "receiptBinding"] : [])] : ["step", "requestId"];
  if (Reflect.ownKeys(raw).some(key => typeof key !== "string" || !allowed.includes(key))) throw new Error("unknown chain quote proof field");
  if (typeof raw.step !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(raw.step) ||
    typeof raw.requestId !== "string" || !raw.requestId || raw.requestId.trim() !== raw.requestId)
    throw new Error("chain quote proof requires a step and request id");
  if (sourceKind === "view") {
    if (typeof raw.signature !== "string" || !raw.signature) throw new Error("chain quote proof requires an ABI signature");
    const fragment = FunctionFragment.from(raw.signature);
    if (extended) {
      if (raw.multicall !== undefined) {
        record(raw.multicall);
        if (Object.keys(raw.multicall).length !== 3 || !["index", "target", "calldata"].every(key => Object.hasOwn(raw.multicall as object, key)) ||
            (raw.completion !== undefined && raw.completion !== "returned") || raw.errorSignature)
          throw new Error("invalid aggregate quote proof");
        validateDeclarativeValue(raw.multicall);
      }
      record(raw.requestBinding);
      if (Object.keys(raw.requestBinding).length !== 2 || !Object.hasOwn(raw.requestBinding, "target") || !Object.hasOwn(raw.requestBinding, "caller"))
        throw new Error("extended quote requires target and caller binding");
      validateDeclarativeValue(raw.requestBinding);
    }
    amountType(fragment.inputs, raw.amountPath, extended && raw.inputBinding ? /^u?int([0-9]+)?$/ : /^uint([0-9]+)?$/);
    let outputs = fragment.outputs;
    if (raw.errorSignature !== undefined) {
      if (typeof raw.errorSignature !== "string" || raw.completion !== "reverted-as-declared")
        throw new Error("custom-error quote requires an explicit error signature and reverted completion");
      outputs = ErrorFragment.from(raw.errorSignature).inputs;
    }
    amountType(outputs, raw.outputPath, raw.outputWord ? /^bytes32$/ : /^uint([0-9]+)?$/);
    if (raw.outputWord !== undefined) {
      record(raw.outputWord);
      const word = raw.outputWord;
      if (Object.keys(word).some(key => !["offset", "width", "signed", "negate"].includes(key)) ||
          !Number.isSafeInteger(word.offset) || !Number.isSafeInteger(word.width) ||
          Number(word.offset) < 0 || Number(word.width) < 1 || Number(word.offset) + Number(word.width) > 256 ||
          typeof word.signed !== "boolean" || word.negate !== undefined && typeof word.negate !== "boolean")
        throw new Error("invalid packed quote word bounds");
    }
    if (raw.inputBinding !== undefined) {
      record(raw.inputBinding);
      const binding = raw.inputBinding;
      if (Object.keys(binding).some(key => !["value", "checks"].includes(key)) || !Object.hasOwn(binding, "value") ||
          !Array.isArray(binding.checks) || binding.checks.length < 1 || binding.checks.length > 32)
        throw new Error("derived quote input requires value and bounded checks");
      validateDeclarativeValue(binding);
      const refersToInput = (value: unknown): boolean => value === "$quote.amountIn" ||
        !!value && typeof value === "object" && Object.values(value).some(refersToInput);
      if (!refersToInput(binding.value)) throw new Error("derived quote input must explicitly bind the original amountIn");
    }
    if (raw.receiptBinding !== undefined) {
      record(raw.receiptBinding);
      const binding = raw.receiptBinding;
      const keys = ["inputAssetPath", "feeNumerator", "feeDenominator", "maximumInput", "unavailableOnRevertOrEmpty"];
      if (keys.some(key => !Object.hasOwn(binding, key)) || Object.keys(binding).length !== keys.length ||
          typeof binding.unavailableOnRevertOrEmpty !== "boolean" || raw.errorSignature || raw.outputWord ||
          raw.completion === "reverted-as-declared" || raw.multicall !== undefined)
        throw new Error("invalid view receipt binding");
      amountType(fragment.inputs, binding.inputAssetPath, /^address$/);
      const fromReads = (v: unknown): boolean => typeof v === "string" && v.startsWith("$steps.") ||
        !!v && typeof v === "object" && Object.values(v).some(fromReads);
      if (!fromReads(binding.maximumInput)) throw new Error("view receipt capacity must use source-bound reads");
      validateDeclarativeValue(binding);
    }
    if (raw.completion !== undefined && raw.completion !== "returned" && raw.completion !== "reverted-as-declared")
      throw new Error("unsupported chain quote proof completion");
  }
}

function evaluate(value: unknown, input: DeclarativeQuoteEvaluation, amountIn: bigint): unknown {
  if (!input.evaluate) throw new Error("quote declaration requires the common value evaluator");
  return input.evaluate(value, { ...input.environment, quote: Object.freeze({ amountIn }) });
}
function callerKey(value: unknown): string {
  record(value);
  if (!["none", "executor", "transaction-origin", "observed-sender", "verified-actor"].includes(String(value.kind)) ||
      Object.keys(value).some(key => !["kind", ...(value.kind === "verified-actor" ? ["evidenceId"] : [])].includes(key)) ||
      value.kind === "verified-actor" && (typeof value.evidenceId !== "string" || !value.evidenceId.trim()))
    throw new Error("invalid quote request caller binding");
  return `${value.kind}:${value.evidenceId ?? ""}`;
}

function decodeView(proof: DeclarativeQuoteProof, request: AdapterRequest, result: AdapterRequestResult) {
  if (request.kind !== "eth-call" || !result.ok) throw new Error("chain quote proof requires a successful call result");
  const fragment = FunctionFragment.from(proof.signature!), abi = new Interface([fragment]);
  const arguments_ = abi.decodeFunctionData(fragment, request.data);
  if (abi.encodeFunctionData(fragment, arguments_).toLowerCase() !== request.data.toLowerCase())
    throw new Error("chain quote proof requires canonical ABI encoding");
  let outputs: readonly unknown[], canonical: string;
  if (proof.errorSignature) {
    const error = ErrorFragment.from(proof.errorSignature), errorAbi = new Interface([error]);
    outputs = errorAbi.decodeErrorResult(error, result.data);
    canonical = errorAbi.encodeErrorResult(error, outputs);
  } else {
    outputs = abi.decodeFunctionResult(fragment, result.data);
    canonical = abi.encodeFunctionResult(fragment, outputs);
  }
  if (canonical.toLowerCase() !== result.data.toLowerCase()) throw new Error("chain quote proof requires canonical ABI encoding");
  const callAmount = atPath(arguments_, proof.amountPath!);
  let output = atPath(outputs, proof.outputPath!);
  if (proof.outputWord) {
    if (typeof output !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(output)) throw new Error("quote output must be a bytes32 word");
    const { offset, width, signed, negate } = proof.outputWord;
    const modulus = 1n << BigInt(width);
    let value = (BigInt(output) >> BigInt(offset)) & (modulus - 1n);
    if (signed && value >= modulus / 2n) value -= modulus;
    output = negate ? -value : value;
  }
  if (typeof callAmount !== "bigint" || typeof output !== "bigint") throw new Error("chain quote proof decoded amount is invalid");
  return { callAmount, output };
}

function atPath(values: unknown, path: readonly number[]): unknown {
  let selected: unknown = values;
  for (const index of path) {
    if (!Array.isArray(selected) || index >= selected.length) throw new Error("chain quote proof ABI value is missing");
    selected = selected[index];
  }
  return selected;
}
function canonicalSource(source: CanonicalSource): void {
  if (!source || !Number.isSafeInteger(source.number) || source.number < 0 || !Number.isSafeInteger(source.generation) ||
    source.generation < 0 || !/^0x[0-9a-fA-F]{64}$/.test(source.hash)) throw new Error("chain quote proof requires canonical source");
}

/** Called only with declaration/result pairs reconstructed by the read flow.
 * The production issuer remains responsible for transport attestation. */
export function verifyDeclarativeQuoteProof(input: {
  readonly proof: DeclarativeQuoteProof;
  readonly sourceKind: DeclarativeQuoteSource;
  readonly request: AdapterRequest;
  readonly result: AdapterRequestResult;
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly executor: string;
} & DeclarativeQuoteEvaluation): void {
  const { proof, sourceKind, request, result, source, amountIn, amountOut } = input;
  validateDeclarativeQuoteProof(proof, sourceKind);
  canonicalSource(source); canonicalSource(result.source); assertSource(result.source, source);
  if (typeof amountIn !== "bigint" || amountIn <= 0n || typeof amountOut !== "bigint" || amountOut < 0n ||
      (amountOut === 0n && (sourceKind !== "view" || !proof.receiptBinding)))
    throw new Error("chain quote proof requires positive input and output");
  if (request.id !== proof.requestId || result.id !== proof.requestId || !result.ok)
    throw new Error("chain quote proof lacks the declared successful request");
  if (!result.provenance?.kind || !result.provenance.fingerprint) throw new Error("chain quote proof lacks transport provenance");
  if (sourceKind === "view") {
    const unavailable = proof.receiptBinding?.unavailableOnRevertOrEmpty === true &&
      request.kind === "eth-call" && request.completion === "return-or-revert-data" &&
      (result.completion === "reverted-as-declared" && /^0x(?:[a-fA-F0-9]{2})*$/.test(result.data) ||
       result.completion === "returned" && result.data === "0x");
    if (request.kind !== "eth-call" || (!unavailable && result.completion !== (proof.completion ?? "returned")) ||
      (result.completion === "reverted-as-declared" && request.completion !== "return-or-revert-data"))
      throw new Error("chain quote proof transport or completion mismatch");
    if (proof.requestBinding) {
      const target = evaluate(proof.requestBinding.target, input, amountIn);
      if (typeof target !== "string" || getAddress(target) !== getAddress(request.to) ||
          callerKey(evaluate(proof.requestBinding.caller, input, amountIn)) !== callerKey(request.caller ?? { kind: "none" }))
        throw new Error("chain quote proof target or caller mismatch");
    }
    const inner = proof.multicall && verifiedMulticallItem({
      outerTarget: request.to, calldata: request.data, returndata: result.data,
      index: evaluate(proof.multicall.index, input, amountIn), target: evaluate(proof.multicall.target, input, amountIn),
      expectedCalldata: evaluate(proof.multicall.calldata, input, amountIn),
    });
    let capacity: bigint | undefined;
    let feeNumerator = 0n, feeDenominator = 1n;
    let unavailableCallAmount: bigint | undefined;
    if (proof.receiptBinding) {
      const binding = proof.receiptBinding;
      const fn = FunctionFragment.from(proof.signature!), abi = new Interface([fn]);
      const args = abi.decodeFunctionData(fn, request.data);
      const token = atPath(args, binding.inputAssetPath);
      if (abi.encodeFunctionData(fn, args).toLowerCase() !== request.data.toLowerCase() ||
          typeof token !== "string" || getAddress(token) !== getAddress(input.tokenIn))
        throw new Error("view receipt input asset or canonical calldata differs");
      const uint = (value: unknown): bigint => {
        const n = evaluate(value, input, amountIn);
        if (typeof n !== "bigint" || n < 0n || n >= 1n << 256n)
          throw new Error("invalid source-bound view receipt amount");
        return n;
      };
      capacity = uint(binding.maximumInput);
      feeNumerator = uint(binding.feeNumerator);
      feeDenominator = uint(binding.feeDenominator);
      if (feeDenominator === 0n || feeNumerator >= feeDenominator)
        throw new Error("invalid view receipt deduction");
      if (unavailable) {
        const n = atPath(args, proof.amountPath!);
        if (typeof n !== "bigint" || n < 0n) throw new Error("invalid unavailable view input");
        unavailableCallAmount = n;
      }
    }
    // A pinned revert/empty reply proves only unavailability, never a positive receipt.
    const decoded = unavailableCallAmount === undefined ? (inner ? decodeView(proof, { ...request, data: inner.calldata }, { ...result, data: inner.returndata })
      : decodeView(proof, request, result))
      : { callAmount: unavailableCallAmount, output: 0n };
    let expectedInput = amountIn;
    if (proof.inputBinding) {
      for (const check of proof.inputBinding.checks)
        if (evaluate(check, input, amountIn) !== true) throw new Error("derived quote input check failed");
      const transformed = evaluate(proof.inputBinding.value, input, amountIn);
      if (typeof transformed !== "bigint") throw new Error("derived quote input is not an integer");
      expectedInput = transformed;
    }
    let receipt = decoded.output;
    if (capacity !== undefined) {
      const product = decoded.output * feeNumerator;
      if (decoded.output < 0n || product >= 1n << 256n) throw new Error("view receipt deduction overflow");
      receipt = expectedInput > capacity ? 0n : decoded.output - product / feeDenominator;
    }
    if (decoded.callAmount !== expectedInput || receipt !== amountOut)
      throw new Error("chain quote proof input or output amount mismatch");
    return;
  }
  if ((request.kind !== "effect-delta-simulation" && request.kind !== "state-override-simulation") ||
    result.completion !== "returned" || !request.observe.includes("token-delta"))
    throw new Error("chain quote proof requires returned token effect simulation");
  const tokenIn = getAddress(input.tokenIn), tokenOut = getAddress(input.tokenOut), account = getAddress(input.executor);
  if (tokenIn === tokenOut) throw new Error("chain quote proof requires distinct input and output assets");
  const delta = (token: string) => {
    const rows = (result.effects?.tokenDeltas ?? []).filter(row => getAddress(row.token) === token && getAddress(row.account) === account);
    if (rows.length !== 1 || typeof rows[0]!.delta !== "bigint") throw new Error("chain quote proof requires unique observed token deltas");
    return rows[0]!.delta;
  };
  if (delta(tokenIn) !== -amountIn || delta(tokenOut) !== amountOut)
    throw new Error("chain quote proof input debit or output receipt mismatch");
}

/** Ordered conversions retain each source-bound input/output relation. A v2
 * choice selects one complete proof before any observations are requested. */
type QuoteSequence = DeclarativeQuoteProof | { readonly steps: readonly DeclarativeQuoteProof[] };
export type DeclarativeQuoteChain = QuoteSequence | {
  readonly version: 2;
  readonly choices: readonly { readonly when: unknown; readonly proof: QuoteSequence }[];
};
function sequence(raw: unknown, kind: DeclarativeQuoteSource): readonly DeclarativeQuoteProof[] {
  record(raw);
  if (!Object.hasOwn(raw, "steps")) {
    validateDeclarativeQuoteProof(raw, kind);
    return [raw];
  }
  if (kind !== "view" || Object.keys(raw).length !== 1 || !Array.isArray(raw.steps) ||
      raw.steps.length < 2 || raw.steps.length > 128) throw new Error("invalid ordered chain quote proof");
  const seen = new Set<string>();
  for (const step of raw.steps) {
    validateDeclarativeQuoteProof(step, kind);
    const key = `${step.step}:${step.requestId}`;
    if (seen.has(key)) throw new Error("duplicate chain quote proof request");
    seen.add(key);
  }
  if (raw.steps.slice(0, -1).some(step => step.receiptBinding !== undefined))
    throw new Error("a receipt-bound quote may only be the final quote step");
  return raw.steps;
}
/** Compile-time groups allow each alternative to be checked in flow order. */
export function quoteProofGroups(raw: unknown, kind: DeclarativeQuoteSource): readonly (readonly DeclarativeQuoteProof[])[] {
  record(raw);
  if (!Object.hasOwn(raw, "choices")) return [sequence(raw, kind)];
  if (Object.keys(raw).some(key => !["version", "choices"].includes(key)) || raw.version !== 2 ||
      !Array.isArray(raw.choices) || !raw.choices.length || raw.choices.length > 128)
    throw new Error("invalid quote proof choices");
  const groups = raw.choices.map(choice => {
    record(choice);
    if (Object.keys(choice).length !== 2 || !Object.hasOwn(choice, "when") || !Object.hasOwn(choice, "proof"))
      throw new Error("quote proof choice requires condition and proof");
    validateDeclarativeValue(choice.when);
    return sequence(choice.proof, kind);
  });
  if (groups.reduce((count, group) => count + group.length, 0) > 128) throw new Error("quote proof choice budget exceeded");
  return groups;
}
export function quoteProofSteps(raw: unknown, kind: DeclarativeQuoteSource): readonly DeclarativeQuoteProof[] {
  return quoteProofGroups(raw, kind).flat();
}
export function verifyDeclarativeQuoteChain(input: Omit<Parameters<typeof verifyDeclarativeQuoteProof>[0], "proof" | "request" | "result"> & {
  readonly proof: unknown;
  readonly observation: (proof: DeclarativeQuoteProof) => { request: AdapterRequest; result: AdapterRequestResult };
}): void {
  const groups = quoteProofGroups(input.proof, input.sourceKind);
  let steps = groups[0]!;
  const declaration = input.proof as DeclarativeQuoteChain;
  if ("choices" in declaration) {
    const selected = declaration.choices.map(choice => {
      const decision = evaluate(choice.when, input, input.amountIn);
      if (typeof decision !== "boolean") throw new Error("quote proof choice must return a boolean");
      return decision;
    }).flatMap((matches, index) => matches ? [index] : []);
    if (selected.length !== 1) throw new Error("quote proof must select exactly one alternative");
    steps = groups[selected[0]!]!;
  }
  let amount = input.amountIn;
  for (let index = 0; index < steps.length; index++) {
    const proof = steps[index]!, observed = input.observation(proof);
    let output = input.amountOut;
    if (index < steps.length - 1) {
      if (!observed.result.ok) throw new Error("chain quote proof lacks successful intermediate result");
      output = decodeView(proof, observed.request, observed.result).output;
    }
    verifyDeclarativeQuoteProof({ ...input, proof, ...observed, amountIn: amount, amountOut: output });
    amount = output;
  }
}
