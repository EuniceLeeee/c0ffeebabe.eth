import { getAddress, keccak256, toUtf8Bytes } from "ethers";

/** A historical observation is a candidate source, never identity/Ready authority.
 * The collector owns call-frame/log attribution; the issuer must still bind an
 * admitted identity and independently execute every candidate before using it. */
export interface ObservedCallSample {
  readonly target: string;
  readonly calldata: string;
  readonly sender: string;
  readonly recipient: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly source: {
    readonly chainId: number;
    readonly number: number;
    readonly hash: string;
    readonly transactionHash: string;
    readonly traceAddress: readonly number[];
  };
  readonly payment: { readonly kind: "approval"; readonly spender: string } | { readonly kind: "prepaid" };
}

/** Offsets are absolute calldata BYTE offsets: the first ABI word starts at 4.
 * Unpatched bytes are preserved, including any historical minimum/deadline.
 * No output amount, ABI, identity, or admission is inferred from this template. */
export interface ObservedCallTemplate {
  readonly version: 1;
  readonly kind: "observed-call-template";
  readonly sample: ObservedCallSample;
  readonly selector: string;
  readonly calldataTemplate: string;
  readonly amountInOffset: number;
  readonly executorOffsets: readonly number[];
  readonly templateHash: string;
}

export type ObservedCallSynthesisResult =
  | { readonly status: "candidates"; readonly templates: readonly ObservedCallTemplate[] }
  | { readonly status: "unsupported"; readonly reason: string };

export const OBSERVED_CALL_MAX_WORDS = 32;
export const OBSERVED_CALL_MAX_CANDIDATES = 16;
/** Without an ABI, keep input positive under both uint256 and int256 decoding.
 * This is a bound on candidate inputs, not evidence of either Solidity type. */
export const OBSERVED_CALL_MAX_AMOUNT = (1n << 255n) - 1n;
const MAX_UINT = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export class ObservedCallTemplateError extends Error {
  constructor(readonly reason: string) { super(`observed call template: ${reason}`); this.name = "ObservedCallTemplateError"; }
}
function reject(reason: string): never { throw new ObservedCallTemplateError(reason); }

function record(value: unknown, fields: readonly string[], label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    reject(`invalid-${label}`);
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(properties, key)) ||
      Object.entries(properties).some(([key, property]) => !fields.includes(key) || !("value" in property)))
    reject(`invalid-${label}-fields`);
  return value as Record<string, any>;
}
function address(value: unknown, label: string): string {
  if (typeof value !== "string") reject(`invalid-${label}`);
  let result: string;
  try { result = getAddress(value).toLowerCase(); } catch { return reject(`invalid-${label}`); }
  if (result === ZERO_ADDRESS) reject(`zero-${label}`);
  return result;
}
function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) reject(`invalid-${label}`);
  return value.toLowerCase();
}
function rawAmount(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) > MAX_UINT)
    reject(`invalid-${label}`);
  return value;
}
function dataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) reject(`invalid-${label}`);
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, index) => properties[index]).some(property => !property || !("value" in property)))
    reject(`invalid-${label}`);
  return value;
}
function sampleValue(value: unknown): ObservedCallSample {
  const s = record(value, ["target", "calldata", "sender", "recipient", "tokenIn", "tokenOut", "amountIn", "amountOut", "source", "payment"], "sample");
  const source = record(s.source, ["chainId", "number", "hash", "transactionHash", "traceAddress"], "source");
  if (!Array.isArray(source.traceAddress) || source.traceAddress.length > 32) reject("invalid-source-position");
  const traceAddress = dataArray(source.traceAddress, "source-position");
  if (!Number.isSafeInteger(source.chainId) || source.chainId <= 0 || !Number.isSafeInteger(source.number) || source.number < 0 ||
      traceAddress.some(part => !Number.isSafeInteger(part) || (part as number) < 0))
    reject("invalid-source-position");
  const target = address(s.target, "target"), sender = address(s.sender, "sender"), recipient = address(s.recipient, "recipient");
  const tokenIn = address(s.tokenIn, "token-in"), tokenOut = address(s.tokenOut, "token-out");
  if (tokenIn === tokenOut) reject("same-input-output-token");
  if ([target, tokenIn, tokenOut].some(protectedAddress => protectedAddress === sender || protectedAddress === recipient))
    reject("actor-overlaps-target-or-asset");
  const amountIn = rawAmount(s.amountIn, "amount-in"), amountOut = rawAmount(s.amountOut, "amount-out");
  if (BigInt(amountIn) > OBSERVED_CALL_MAX_AMOUNT) reject("input-outside-positive-signed-range");
  if (typeof s.calldata !== "string" || !/^0x[0-9a-fA-F]+$/.test(s.calldata) || s.calldata.length % 2 !== 0)
    reject("invalid-calldata");
  const calldata = s.calldata.toLowerCase();
  const bytes = (calldata.length - 2) / 2, words = (bytes - 4) / 32;
  if (!Number.isInteger(words) || words < 1) reject("packed-or-empty-calldata");
  if (words > OBSERVED_CALL_MAX_WORDS) reject("calldata-word-budget-exceeded");
  if (!s.payment || typeof s.payment !== "object") reject("invalid-payment");
  const paymentKind = Object.getOwnPropertyDescriptor(s.payment, "kind");
  if (!paymentKind || !("value" in paymentKind)) reject("invalid-payment-fields");
  let payment: ObservedCallSample["payment"];
  if (s.payment.kind === "approval") {
    const p = record(s.payment, ["kind", "spender"], "payment");
    payment = Object.freeze({ kind: "approval", spender: address(p.spender, "spender") });
  } else if (s.payment.kind === "prepaid") {
    record(s.payment, ["kind"], "payment");
    payment = Object.freeze({ kind: "prepaid" });
  } else reject("unsupported-payment");
  return Object.freeze({ target, calldata, sender, recipient, tokenIn, tokenOut, amountIn, amountOut,
    source: Object.freeze({ chainId: source.chainId, number: source.number, hash: hash(source.hash, "block-hash"),
      transactionHash: hash(source.transactionHash, "transaction-hash"), traceAddress: Object.freeze([...(traceAddress as readonly number[])]) }), payment });
}
function words(calldata: string): readonly { offset: number; value: string }[] {
  const result: { offset: number; value: string }[] = [];
  for (let offset = 4; 2 + offset * 2 < calldata.length; offset += 32)
    result.push({ offset, value: calldata.slice(2 + offset * 2, 2 + (offset + 32) * 2) });
  return result;
}
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => value.slice(2).padStart(64, "0");

function candidateLayout(sample: ObservedCallSample) {
  const fields = words(sample.calldata), bytes = fields.length * 32;
  // A forward, aligned in-payload offset resembles an ABI dynamic head. Reject
  // it conservatively rather than accidentally replacing an offset or length.
  // Opaque bytes alone cannot prove a static ABI, absence of signatures, or
  // permissionless behavior. Passing this filter still yields ONLY candidates.
  if (fields.some((field, index) => {
    const value = BigInt(`0x${field.value}`);
    return value % 32n === 0n && value > BigInt(index * 32) && value < BigInt(bytes);
  })) reject("dynamic-head-shaped-calldata");
  const actorWords = new Set([addressWord(sample.sender), addressWord(sample.recipient)]);
  const executorOffsets = fields.filter(field => actorWords.has(field.value)).map(field => field.offset);
  if (sample.recipient !== sample.sender && !fields.some(field => field.value === addressWord(sample.recipient)))
    reject("recipient-not-bound-in-call");
  const amountInOffsets = fields.filter(field => field.value === word(BigInt(sample.amountIn))).map(field => field.offset);
  if (!amountInOffsets.length) reject("input-word-not-found");
  if (amountInOffsets.some(offset => executorOffsets.includes(offset))) reject("amount-actor-word-overlap");
  return { amountInOffsets, executorOffsets };
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function fingerprint(value: Omit<ObservedCallTemplate, "templateHash">): string {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value))));
}
function makeTemplate(sample: ObservedCallSample, amountInOffset: number, executorOffsets: readonly number[]): ObservedCallTemplate {
  const body = Object.freeze({ version: 1 as const, kind: "observed-call-template" as const, sample,
    selector: sample.calldata.slice(0, 10), calldataTemplate: sample.calldata, amountInOffset,
    executorOffsets: Object.freeze([...executorOffsets]) });
  return Object.freeze({ ...body, templateHash: fingerprint(body) });
}

/** Equal numbers create separate candidates; never silently choose the first.
 * The caller must actively probe all of them and require a unique validated
 * result. Exceeding the budget returns unsupported instead of truncating it. */
export function synthesizeObservedCallTemplates(sample: ObservedCallSample,
  options: { readonly maxCandidates?: number } = {}): ObservedCallSynthesisResult {
  try {
    const maximum = options.maxCandidates ?? OBSERVED_CALL_MAX_CANDIDATES;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > OBSERVED_CALL_MAX_CANDIDATES) reject("invalid-candidate-budget");
    const normalized = sampleValue(sample), layout = candidateLayout(normalized);
    if (layout.amountInOffsets.length > maximum) reject("candidate-budget-exceeded");
    return Object.freeze({ status: "candidates", templates: Object.freeze(layout.amountInOffsets.map(offset =>
      makeTemplate(normalized, offset, layout.executorOffsets))) });
  } catch (error) {
    if (!(error instanceof ObservedCallTemplateError)) throw error;
    return Object.freeze({ status: "unsupported", reason: error.reason });
  }
}

/** Validates persisted data and the allowed patch scope, not on-chain authority.
 * The digest binds provenance and fields; it is not a signature or proof. */
export function validateObservedCallTemplate(value: unknown): asserts value is ObservedCallTemplate {
  const t = record(value, ["version", "kind", "sample", "selector", "calldataTemplate", "amountInOffset", "executorOffsets", "templateHash"], "template");
  if (t.version !== 1 || t.kind !== "observed-call-template") reject("unsupported-template-version");
  const sample = sampleValue(t.sample), layout = candidateLayout(sample);
  if (JSON.stringify(canonical(sample)) !== JSON.stringify(canonical(t.sample))) reject("noncanonical-sample");
  if (!Array.isArray(t.executorOffsets) || t.executorOffsets.length !== layout.executorOffsets.length) reject("invalid-template-patches");
  const executorOffsets = dataArray(t.executorOffsets, "template-patches");
  if (!layout.amountInOffsets.includes(t.amountInOffset) ||
      executorOffsets.some((offset, index) => offset !== layout.executorOffsets[index]))
    reject("invalid-template-patches");
  if (layout.amountInOffsets.length > OBSERVED_CALL_MAX_CANDIDATES) reject("candidate-budget-exceeded");
  const expected = makeTemplate(sample, t.amountInOffset, layout.executorOffsets);
  if (t.selector !== expected.selector || t.calldataTemplate !== expected.calldataTemplate || t.templateHash !== expected.templateHash)
    reject("template-fingerprint-mismatch");
}

export function observedCallTemplatePatches(template: ObservedCallTemplate): readonly {
  readonly offset: number; readonly reference: "amountIn" | "executor";
}[] {
  validateObservedCallTemplate(template);
  return Object.freeze([{ offset: template.amountInOffset, reference: "amountIn" as const },
    ...template.executorOffsets.map(offset => ({ offset, reference: "executor" as const }))]
    .sort((a, b) => a.offset - b.offset).map(patch => Object.freeze(patch)));
}

/** Bind only observed input/actor words. Historical amountOut is never an
 * expected result, a price, or a replacement amount. Read the new actual
 * executor balance delta after simulation to obtain the quote. */
export function bindObservedCallTemplate(template: ObservedCallTemplate,
  input: { readonly amountIn: bigint; readonly executor: string }): string {
  validateObservedCallTemplate(template);
  if (typeof input.amountIn !== "bigint" || input.amountIn <= 0n || input.amountIn > OBSERVED_CALL_MAX_AMOUNT)
    reject("invalid-runtime-input");
  const executor = address(input.executor, "executor"), sample = template.sample;
  if ([sample.target, sample.tokenIn, sample.tokenOut,
    ...(sample.payment.kind === "approval" ? [sample.payment.spender] : [])].includes(executor))
    reject("executor-overlaps-target-asset-or-spender");
  let data = template.calldataTemplate;
  for (const patch of observedCallTemplatePatches(template)) {
    const start = 2 + patch.offset * 2;
    data = data.slice(0, start) + (patch.reference === "amountIn" ? word(input.amountIn) : addressWord(executor)) + data.slice(start + 64);
  }
  return data;
}
