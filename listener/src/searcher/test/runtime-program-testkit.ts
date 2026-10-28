import assert from "node:assert/strict";
import { ethers } from "ethers";

export interface RuntimeCall {
  target: string; data: string; template: string; static: boolean; value: bigint;
  revertBytes?: number;
  incoming: number; outgoing: number; patches: { offset: number; reg: number }[];
}
export interface RuntimeAllowance { token: string; spender: string; minimum: bigint; grant: bigint }
/** Independent bytecode interpreter for Family ABI/maths contracts, NOT EVM or
 * admission evidence. The actual VM is covered by BotVMRuntimeAmount.t.sol. */
export function inspectRuntime(program: string, amount: bigint, input: {
  call?: (call: RuntimeCall) => string;
  revertedCall?: (call: RuntimeCall) => { success: boolean; data: string };
  allowance?: (grant: RuntimeAllowance) => void;
  nativeBalance?: () => bigint;
  calldata?: string;
} = {}, mode: { output?: boolean; readOnly?: boolean; depth?: number } = {}): { registers: bigint[]; calls: RuntimeCall[]; allowances: RuntimeAllowance[] } {
  const depth = mode.depth ?? 0; assert(depth <= 8, "runtime nesting limit");
  const bytes = ethers.getBytes(program), r = Array<bigint>(16).fill(0n), calls: RuntimeCall[] = [], allowances: RuntimeAllowance[] = [];
  r[0] = amount;
  let ip = 0, returned: Uint8Array = new Uint8Array(), count = 0;
  const take = (n: number) => { assert(ip + n <= bytes.length, "instruction bounds"); const a = bytes.slice(ip, ip + n); ip += n; return a; };
  const uint = (n: number) => BigInt(ethers.hexlify(take(n)));
  const byte = () => Number(uint(1));
  const reg = () => { const x = byte(); assert(x < 16); return x; };
  const set = (n: number, value: bigint) => {
    assert(n > 0 || mode.output === true, "Family may not overwrite actual input r0");
    assert(value >= 0n && value <= ethers.MaxUint256, "checked uint256 math"); r[n] = value;
  };
  assert.equal(byte(), 1);
  while (ip < bytes.length) {
    assert(++count <= 128);
    switch (byte()) {
      case 0: { const d = reg(); set(d, uint(32)); break; }
      case 1: {
        const target = ethers.getAddress(ethers.hexlify(take(20))), callMode = byte(), vr = byte();
        assert(callMode <= 2 && (vr === 255 || vr < 16));
        assert(!mode.readOnly || callMode === 1 || callMode === 2, "runtime readonly call");
        const incoming = Number(uint(3)), outgoing = Number(uint(3)), n = byte();
        const revertBytes = callMode === 2 ? Number(uint(3)) : undefined;
        assert(callMode === 0 || vr === 255 && incoming === 0, "runtime static config");
        assert(revertBytes === undefined || outgoing === 0 && revertBytes <= 65536, "runtime reverted call config");
        const patches = Array.from({ length: n }, () => ({ offset: Number(uint(3)), reg: reg() }));
        const data = take(Number(uint(3))), template = ethers.hexlify(data);
        for (const patch of patches) {
          assert(patch.offset >= 4 && patch.offset + 32 <= data.length);
          data.set(ethers.getBytes(ethers.toBeHex(r[patch.reg], 32)), patch.offset);
        }
        const call = { target, data: ethers.hexlify(data), template, static: callMode === 1,
          value: vr === 255 ? 0n : r[vr], incoming, outgoing, patches,
          ...(revertBytes === undefined ? {} : { revertBytes }) };
        calls.push(call);
        if (revertBytes === undefined) returned = ethers.getBytes(input.call?.(call) ?? "0x");
        else {
          assert(input.revertedCall, "reverted call fixture required");
          const result = input.revertedCall(call); returned = ethers.getBytes(result.data);
          assert(!result.success && returned.length === revertBytes, "runtime expected revert");
        }
        break;
      }
      case 2: {
        const op = byte(), d = reg(), a = r[reg()], b = r[reg()];
        if (op === 0) set(d, a + b);
        else if (op === 1) set(d, a - b);
        else if (op === 2) set(d, a * b);
        else if (op === 3) set(d, a / b);
        else if (op === 4) { assert(b < 256n); set(d, a >> b); }
        else if (op === 5) set(d, a & b);
        else if (op === 6) { assert(a < (1n << 255n)); set(d, BigInt.asUintN(256, -a)); }
        else if (op === 7) set(d, a === b ? 1n : 0n);
        else if (op === 8) set(d, a < b ? a : b);
        else assert.fail("math opcode");
        break;
      }
      case 3: assert.equal(r[reg()], r[reg()], "runtime amount mismatch"); break;
      case 4: {
        assert(!mode.readOnly, "runtime readonly allowance");
        const token = ethers.getAddress(ethers.hexlify(take(20))), spender = ethers.getAddress(ethers.hexlify(take(20)));
        const grant = { token, spender, minimum: r[reg()], grant: uint(32) };
        allowances.push(grant); input.allowance?.(grant); break;
      }
      case 5: { const d = reg(); assert(input.nativeBalance, "native balance fixture required"); set(d, input.nativeBalance()); break; }
      case 6: case 7: {
        const op = bytes[ip - 1], d = reg(), offset = Number(uint(3));
        const data = op === 6 ? returned : ethers.getBytes(input.calldata ?? "0x");
        assert(offset + 32 <= data.length, "word bounds");
        set(d, BigInt(ethers.hexlify(data.slice(offset, offset + 32)))); break;
      }
      case 8: {
        const from = reg(), to = reg(), readOnly = byte(); assert(readOnly <= 1);
        const child = ethers.hexlify(take(Number(uint(3))));
        const result = inspectRuntime(child, r[from], input, { output: true, readOnly: !!mode.readOnly || readOnly === 1, depth: depth + 1 });
        set(to, result.registers[0]); calls.push(...result.calls); allowances.push(...result.allowances); break;
      }
      default: assert.fail("opcode");
    }
  }
  if (!mode.output) assert.equal(r[0], amount);
  return { calls, allowances, registers: r };
}
