import { ethers } from "ethers";

/** Match an executed CALL to a Family-emitted runtime program. Dynamic register
 * patches are wildcards; all other calldata bytes and the call target must
 * match. This stays protocol-neutral and does not decode selectors. */
export function runtimeProgramMatchesCall(program: string, call: {
  readonly type?: string;
  readonly to?: string;
  readonly input?: string;
}): boolean {
  try {
    if (!ethers.isHexString(program, true)) return false;
    const bytes = ethers.getBytes(program), payload = ethers.getBytes(call.input ?? "0x");
    if (bytes[0] !== 1 || bytes.length > 65536) return false;
    let ip = 1, matched = false, count = 0;
    const u24 = (offset: number): number => {
      if (offset + 3 > bytes.length) throw new Error("runtime trace program bounds");
      return bytes[offset]! * 65536 + bytes[offset + 1]! * 256 + bytes[offset + 2]!;
    };
    while (ip < bytes.length) {
      if (++count > 128) return false;
      const op = bytes[ip++]!;
      if (op === 1) {
        if (ip + 29 > bytes.length) return false;
        const target = ethers.hexlify(bytes.slice(ip, ip + 20));
        const mode = bytes[ip + 20]!;
        const patches = bytes[ip + 28]!;
        ip += 29;
        const patchOffsets = Array.from({ length: patches }, (_, i) => u24(ip + i * 4));
        ip += patches * 4;
        const size = u24(ip);
        ip += 3;
        if (ip + size > bytes.length || patchOffsets.some(offset => offset < 4 || offset + 32 > size)) return false;
        if (mode === 0 && call.type === "CALL" && call.to?.toLowerCase() === target.toLowerCase() && payload.length === size) {
          const patched = new Set(patchOffsets.flatMap(offset => Array.from({ length: 32 }, (_, j) => offset + j)));
          if (payload.every((byte, j) => patched.has(j) || byte === bytes[ip + j])) matched = true;
        }
        ip += size;
        continue;
      }
      const operandSize: Record<number, number> = { 0: 33, 2: 4, 3: 2, 4: 73, 5: 1, 6: 4, 7: 4 };
      const size = operandSize[op];
      if (size === undefined || ip + size > bytes.length) return false;
      ip += size;
    }
    return matched;
  } catch {
    return false;
  }
}
