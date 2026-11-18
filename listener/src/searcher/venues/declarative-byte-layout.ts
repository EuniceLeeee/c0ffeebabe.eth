import { AbiCoder, concat, getBytes, hexlify, toBeHex } from "ethers";

const MAX_BYTES = 65_535;
export interface PackedByteSlices {
  readonly prefixBits: number;
  readonly offsetBits: number;
  readonly prefix: string | number | bigint;
  readonly slices: readonly string[];
}
export type CallbackPayloadLayout =
  | { readonly kind: "abi-bytes" }
  | { readonly kind: "packed-slices"; readonly prefixBits: number; readonly offsetBits: number;
      readonly prefix: string | number | bigint; readonly slices: readonly (string | { readonly payload: "abi-bytes" })[] };

function shape(raw: unknown, fields: readonly string[]): asserts raw is Record<string, any> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== fields.length ||
      fields.some(field => !Object.hasOwn(raw, field))) throw new Error("invalid declared byte layout");
}
function widths(prefixBits: unknown, offsetBits: unknown, length: unknown): void {
  if (!Number.isSafeInteger(prefixBits) || (prefixBits as number) < 8 || (prefixBits as number) > 64 || (prefixBits as number) % 8 ||
      ![8, 16, 32].includes(offsetBits as number) || !Number.isSafeInteger(length) || (length as number) < 1 ||
      (length as number) > 32 || (prefixBits as number) + (offsetBits as number) * (length as number) > 256)
    throw new Error("packed byte layout width/count bounds");
}
function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > 2 + MAX_BYTES * 2 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
    throw new Error("packed byte slice must be bounded complete hex bytes");
  const result = getBytes(value);
  if (result.length > MAX_BYTES) throw new Error("declared byte payload bounds");
  return result;
}

/** Cumulative slice ends occupy successive low-to-high fields. The common
 * encoder owns every offset and bounds check; JSON supplies only actual data. */
export function encodePackedByteSlices(input: PackedByteSlices): string {
  widths(input.prefixBits, input.offsetBits, input.slices?.length);
  if (typeof input.prefix === "number" && !Number.isSafeInteger(input.prefix)) throw new Error("unsafe byte prefix");
  let header: bigint;
  try { header = BigInt(input.prefix); } catch { throw new Error("invalid byte prefix"); }
  if (header < 0n || header >= 1n << BigInt(input.prefixBits)) throw new Error("byte prefix width overflow");
  let end = 0;
  const slices = input.slices.map((slice, index) => {
    const value = bytes(slice); end += value.length;
    if (end > MAX_BYTES || BigInt(end) >= 1n << BigInt(input.offsetBits)) throw new Error("packed slice offset overflow");
    header |= BigInt(end) << BigInt(input.prefixBits + input.offsetBits * index);
    return value;
  });
  const width = (input.prefixBits + input.offsetBits * input.slices.length) / 8;
  if (end + width > MAX_BYTES) throw new Error("declared byte payload bounds");
  return concat([toBeHex(header, width), ...slices]);
}

/** Shape validation can precede expression resolution. Concrete hex, lengths
 * and prefix bounds are checked by the encoder before issuing a runtime leg. */
export function validateCallbackPayloadLayout(raw: unknown): asserts raw is CallbackPayloadLayout {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object") throw new Error("invalid callback byte layout");
  if ((raw as any).kind === "abi-bytes") { shape(raw, ["kind"]); return; }
  shape(raw, ["kind", "prefixBits", "offsetBits", "prefix", "slices"]);
  if (raw.kind !== "packed-slices" || !Array.isArray(raw.slices)) throw new Error("invalid callback byte layout kind");
  widths(raw.prefixBits, raw.offsetBits, raw.slices.length);
  let payloads = 0;
  for (const slice of raw.slices) {
    if (slice && typeof slice === "object" && Object.hasOwn(slice, "payload")) {
      shape(slice, ["payload"]);
      if (slice.payload !== "abi-bytes") throw new Error("callback slice must carry an ABI bytes length");
      payloads++;
    } else if (typeof slice !== "string" && (!slice || typeof slice !== "object" || !Object.hasOwn(slice, "op")))
      throw new Error("invalid callback byte slice");
  }
  if (payloads !== 1) throw new Error("callback layout requires exactly one compiler-owned payload");
}

export function encodeCallbackPayload(layout: CallbackPayloadLayout | undefined, payload: Uint8Array | string): {
  readonly data: string; readonly payloadOffset: number;
} {
  const script = typeof payload === "string" ? bytes(payload) : payload;
  if (!(script instanceof Uint8Array) || script.length === 0 || script.length > MAX_BYTES) throw new Error("callback payload bounds");
  if (layout === undefined) return { data: hexlify(script), payloadOffset: 0 };
  validateCallbackPayloadLayout(layout);
  const wrapped = AbiCoder.defaultAbiCoder().encode(["bytes"], [script]);
  if (bytes(wrapped).length > MAX_BYTES) throw new Error("callback wrapper bounds");
  if (layout.kind === "abi-bytes") return { data: wrapped, payloadOffset: 64 };
  const headerBytes = (layout.prefixBits + layout.offsetBits * layout.slices.length) / 8;
  let offset = headerBytes, payloadOffset = -1;
  const slices = layout.slices.map(slice => {
    if (typeof slice === "object") {
      if (!Object.hasOwn(slice, "payload")) throw new Error("callback byte expression was not resolved");
      payloadOffset = offset + 64; offset += getBytes(wrapped).length; return wrapped;
    }
    offset += bytes(slice).length; return slice;
  });
  const data = encodePackedByteSlices({ ...layout, slices });
  if (payloadOffset < 32 || payloadOffset + script.length > getBytes(data).length) throw new Error("callback layout payload range");
  return { data, payloadOffset };
}
