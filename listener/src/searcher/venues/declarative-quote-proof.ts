import { FunctionFragment, Interface, getAddress, type ParamType } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "./adapter-request-program.js";
import { assertSource } from "./protocols/standard-family/common.js";

export type DeclarativeQuoteSource = "view" | "effect-simulation";
export interface DeclarativeQuoteProof {
  readonly step: string;
  readonly requestId: string;
  readonly signature?: string;
  readonly amountPath?: readonly number[];
  readonly outputPath?: readonly number[];
  readonly completion?: "returned" | "reverted-as-declared";
}

function record(raw: unknown): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype)
    throw new Error("chain quote proof must be a plain definition");
  for (const field of Object.values(Object.getOwnPropertyDescriptors(raw))) {
    if (!("value" in field)) throw new Error("chain quote proof accessors are unsupported");
  }
}
function amountType(parameters: readonly ParamType[], path: unknown): void {
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
  if (!parameter || !/^uint([0-9]+)?$/.test(parameter.type)) throw new Error("chain quote proof ABI path must identify an unsigned amount");
}

/** A declaration identifies evidence; it never manufactures source provenance. */
export function validateDeclarativeQuoteProof(raw: unknown, sourceKind: DeclarativeQuoteSource): asserts raw is DeclarativeQuoteProof {
  record(raw);
  if (sourceKind !== "view" && sourceKind !== "effect-simulation") throw new Error("unsupported chain quote proof source");
  const allowed = sourceKind === "view"
    ? ["step", "requestId", "signature", "amountPath", "outputPath", "completion"] : ["step", "requestId"];
  if (Reflect.ownKeys(raw).some(key => typeof key !== "string" || !allowed.includes(key))) throw new Error("unknown chain quote proof field");
  if (typeof raw.step !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(raw.step) ||
    typeof raw.requestId !== "string" || !raw.requestId || raw.requestId.trim() !== raw.requestId)
    throw new Error("chain quote proof requires a step and request id");
  if (sourceKind === "view") {
    if (typeof raw.signature !== "string" || !raw.signature) throw new Error("chain quote proof requires an ABI signature");
    const fragment = FunctionFragment.from(raw.signature);
    amountType(fragment.inputs, raw.amountPath);
    amountType(fragment.outputs, raw.outputPath);
    if (raw.completion !== undefined && raw.completion !== "returned" && raw.completion !== "reverted-as-declared")
      throw new Error("unsupported chain quote proof completion");
  }
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
}): void {
  const { proof, sourceKind, request, result, source, amountIn, amountOut } = input;
  validateDeclarativeQuoteProof(proof, sourceKind);
  canonicalSource(source); canonicalSource(result.source); assertSource(result.source, source);
  if (typeof amountIn !== "bigint" || amountIn <= 0n || typeof amountOut !== "bigint" || amountOut <= 0n)
    throw new Error("chain quote proof requires positive input and output");
  if (request.id !== proof.requestId || result.id !== proof.requestId || !result.ok)
    throw new Error("chain quote proof lacks the declared successful request");
  if (!result.provenance?.kind || !result.provenance.fingerprint) throw new Error("chain quote proof lacks transport provenance");
  if (sourceKind === "view") {
    if (request.kind !== "eth-call" || result.completion !== (proof.completion ?? "returned") ||
      (result.completion === "reverted-as-declared" && request.completion !== "return-or-revert-data"))
      throw new Error("chain quote proof transport or completion mismatch");
    const fragment = FunctionFragment.from(proof.signature!);
    const abi = new Interface([fragment]);
    const arguments_ = abi.decodeFunctionData(fragment, request.data);
    const outputs = abi.decodeFunctionResult(fragment, result.data);
    if (abi.encodeFunctionData(fragment, arguments_).toLowerCase() !== request.data.toLowerCase() ||
      abi.encodeFunctionResult(fragment, outputs).toLowerCase() !== result.data.toLowerCase())
      throw new Error("chain quote proof requires canonical ABI encoding");
    if (atPath(arguments_, proof.amountPath!) !== amountIn || atPath(outputs, proof.outputPath!) !== amountOut)
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
