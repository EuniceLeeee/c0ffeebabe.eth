/**
 * TypeScript port of src/BotVMEncoder.sol.
 * 9 opcodes + byte helpers. Route-agnostic.
 *
 * Verification: for identical inputs, output must be byte-for-byte
 * identical to the Solidity BotVMEncoder.
 */

// ─── Byte Helpers ──────────────────────────────────────────────

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** Convert hex string (with or without 0x) to Uint8Array */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`odd hex length: ${h.length}`);
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Convert Uint8Array to 0x-prefixed hex string */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Encode uint24 (3 bytes, big-endian) */
export function uint24ToBytes(n: number): Uint8Array {
  if (n < 0 || n > 0xffffff) throw new Error(`uint24 overflow: ${n}`);
  return new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

/** Encode uint96 (12 bytes, big-endian) */
export function uint96ToBytes(n: bigint): Uint8Array {
  if (n < 0n || n > (1n << 96n) - 1n) throw new Error(`uint96 overflow`);
  const bytes = new Uint8Array(12);
  let val = n;
  for (let i = 11; i >= 0; i--) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

/** Encode uint256 (32 bytes, big-endian) */
export function uint256ToBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error(`uint256 negative: ${n}`);
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

/** Encode address (20 bytes) from hex string */
export function addressToBytes(addr: string): Uint8Array {
  const bytes = hexToBytes(addr);
  if (bytes.length !== 20) throw new Error(`address must be 20 bytes, got ${bytes.length}`);
  return bytes;
}

// ─── Opcode Encoders ───────────────────────────────────────────

/** Opcode 0x00: CALL (no value) — [0x00][addr:20][payload_len:3][payload:N] */
export function encodeCall(target: string, payload: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0x00]),
    addressToBytes(target),
    uint24ToBytes(payload.length),
    payload,
  );
}

/** Opcode 0x01: CALL with value — [0x01][addr:20][value:12][payload_len:3][payload:N] */
export function encodeCallValue(
  target: string,
  value: bigint,
  payload: Uint8Array,
): Uint8Array {
  return concatBytes(
    new Uint8Array([0x01]),
    addressToBytes(target),
    uint96ToBytes(value),
    uint24ToBytes(payload.length),
    payload,
  );
}

/** Opcode 0x02: SET_FIELD2 — [0x02][field2:3] */
export function encodeSetField2(offset: number): Uint8Array {
  return concatBytes(new Uint8Array([0x02]), uint24ToBytes(offset));
}

/** Opcode 0x03: RETURN — [0x03][data_len:3][data:N] */
export function encodeReturn(data: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0x03]),
    uint24ToBytes(data.length),
    data,
  );
}

/** Opcode 0x04: WETH_UNWRAP */
export function encodeWethUnwrap(): Uint8Array {
  return new Uint8Array([0x04]);
}

/** Opcode 0x05: CLEAR_STATE */
export function encodeClearState(): Uint8Array {
  return new Uint8Array([0x05]);
}

/** Opcode 0x06: SET_FIELD3 — [0x06][field3:3] */
export function encodeSetField3(offset: number): Uint8Array {
  return concatBytes(new Uint8Array([0x06]), uint24ToBytes(offset));
}

/** Opcode 0x07: CLEAR_FIELD1 */
export function encodeClearField1(): Uint8Array {
  return new Uint8Array([0x07]);
}

/** Opcode 0x08: ASSERT_BALANCE_GTE — [0x08][token:20][threshold:32] */
export function encodeAssertBalanceGte(
  token: string,
  threshold: bigint,
): Uint8Array {
  return concatBytes(
    new Uint8Array([0x08]),
    addressToBytes(token),
    uint256ToBytes(threshold),
  );
}
