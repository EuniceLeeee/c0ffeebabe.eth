import assert from "node:assert/strict";
import { ethers } from "ethers";

export interface RuntimeCall {
  target: string; data: string; template: string; static: boolean; value: bigint;
  incoming: number; outgoing: number; patches: { offset: number; reg: number }[];
}
export interface RuntimeAllowance { token: string; spender: string; minimum: bigint; grant: bigint }
/** Independent bytecode interpreter for Family ABI/maths contracts, NOT EVM or
 * admission evidence. The actual VM is covered by BotVMRuntimeAmount.t.sol. */
export function inspectRuntime(program: string, amount: bigint, input: {
  call?: (call: RuntimeCall) => string;
  allowance?: (grant: RuntimeAllowance) => void;
  nativeBalance?: () => bigint;
  calldata?: string;
} = {}) {
  const bytes = ethers.getBytes(program), r = Array<bigint>(16).fill(0n), calls: RuntimeCall[] = [], allowances: RuntimeAllowance[] = [];
  r[0] = amount;
  let ip = 0, returned: Uint8Array = new Uint8Array(), count = 0;
  const take = (n: number) => { assert(ip + n <= bytes.length, "instruction bounds"); const a = bytes.slice(ip, ip + n); ip += n; return a; };
  const uint = (n: number) => BigInt(ethers.hexlify(take(n)));
  const byte = () => Number(uint(1));
  const reg = () => { const x = byte(); assert(x < 16); return x; };
  const set = (n: number, value: bigint) => {
    assert(n > 0, "Family may not overwrite actual input r0");
    assert(value >= 0n && value <= ethers.MaxUint256, "checked uint256 math"); r[n] = value;
  };
  assert.equal(byte(), 1);
  while (ip < bytes.length) {
    assert(++count <= 128);
    switch (byte()) {
      case 0: { const d = reg(); set(d, uint(32)); break; }
      case 1: {
        const target = ethers.getAddress(ethers.hexlify(take(20))), mode = byte(), vr = byte();
        const incoming = Number(uint(3)), outgoing = Number(uint(3)), n = byte();
        const patches = Array.from({ length: n }, () => ({ offset: Number(uint(3)), reg: reg() }));
        const data = take(Number(uint(3))), template = ethers.hexlify(data);
        for (const patch of patches) {
          assert(patch.offset >= 4 && patch.offset + 32 <= data.length);
          data.set(ethers.getBytes(ethers.toBeHex(r[patch.reg], 32)), patch.offset);
        }
        const call = { target, data: ethers.hexlify(data), template, static: mode === 1,
          value: vr === 255 ? 0n : r[vr], incoming, outgoing, patches };
        calls.push(call); returned = ethers.getBytes(input.call?.(call) ?? "0x");
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
        else assert.fail("math opcode");
        break;
      }
      case 3: assert.equal(r[reg()], r[reg()], "runtime amount mismatch"); break;
      case 4: {
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
      default: assert.fail("opcode");
    }
  }
  assert.equal(r[0], amount);
  return { calls, allowances, registers: r };
}
