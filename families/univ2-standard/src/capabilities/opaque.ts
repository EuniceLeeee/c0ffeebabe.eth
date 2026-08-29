import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  type CanonicalJson,
} from "../../../../packages/canonical-codec/src/index.ts";

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(value: string, path: string): Uint8Array {
  if (!HEX_RE.test(value)) throw new TypeError(`${path} must be even-length hex bytes`);
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

/** Family-owned wire helper: central receives only schema-tagged opaque bytes. */
export function encodeUniV2OpaqueCanonical(value: unknown): string {
  return bytesToHex(new TextEncoder().encode(encodeCanonicalJson(value)));
}

export function decodeUniV2OpaqueCanonical(value: unknown, path = "univ2.opaqueBytes"): CanonicalJson {
  if (typeof value !== "string") throw new TypeError(`${path} must be hex bytes`);
  const bytes = hexToBytes(value, path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`${path} is not UTF-8`, { cause: error });
  }
  const decoded = decodeCanonicalJson(text);
  if (bytesToHex(new TextEncoder().encode(encodeCanonicalJson(decoded))) !== value.toLowerCase()) {
    throw new TypeError(`${path} is not canonical`);
  }
  return decoded;
}
