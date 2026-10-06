import { ethers } from "ethers";
import { addressToBytes, concatBytes, uint24ToBytes, uint256ToBytes } from "../encoder.js";
import type { ActionAdapter } from "../types.js";

/** Bounded protocol-neutral register program. r0 is the current leg's input.
 * Family modules own calldata, arithmetic and callback layout. No quote results
 * or amount-dependent off-chain reads are inputs to this format. */
export class RuntimeAmountProgram {
  private readonly parts: Uint8Array[] = [new Uint8Array([1])];
  private count = 0;
  private push(...parts: Uint8Array[]): this {
    if (++this.count > 128) throw new Error("runtime program instruction limit");
    this.parts.push(...parts); return this;
  }
  constant(dst: number, value: bigint): this {
    if (value < 0n || value > ethers.MaxUint256) throw new Error("runtime constant uint256");
    return this.push(new Uint8Array([0, reg(dst)]), uint256ToBytes(value));
  }
  math(op: "add" | "sub" | "mul" | "div" | "shr" | "and" | "neg", dst: number, a: number, b = a): this {
    return this.push(new Uint8Array([2, ["add", "sub", "mul", "div", "shr", "and", "neg"].indexOf(op), reg(dst), reg(a), reg(b)]));
  }
  equal(a: number, b: number): this { return this.push(new Uint8Array([3, reg(a), reg(b)])); }
  load(dst: number, offset: number): this { return this.push(new Uint8Array([6, reg(dst)]), uint24ToBytes(offset)); }
  allowance(token: string, spender: string, amountReg = 0, grant = ethers.MaxUint256): this {
    return this.push(new Uint8Array([4]), addressToBytes(token), addressToBytes(spender),
      new Uint8Array([reg(amountReg)]), uint256ToBytes(grant));
  }
  call(target: string, data: string | Uint8Array, input: {
    static?: boolean; valueReg?: number; patches?: readonly { offset: number; reg: number }[];
    callback?: { incomingOffset: number; outgoingOffset: number };
  } = {}): this {
    const bytes = ethers.getBytes(data), patches = input.patches ?? [];
    if (patches.length > 255 || patches.some(p => !Number.isSafeInteger(p.offset) || p.offset < 4 || p.offset + 32 > bytes.length)) {
      throw new Error("runtime call patch bounds");
    }
    if (input.static && (input.valueReg !== undefined || input.callback)) throw new Error("runtime static call configuration");
    return this.push(new Uint8Array([1]), addressToBytes(target),
      new Uint8Array([input.static ? 1 : 0, input.valueReg === undefined ? 255 : reg(input.valueReg)]),
      uint24ToBytes(input.callback?.incomingOffset ?? 0), uint24ToBytes(input.callback?.outgoingOffset ?? 0),
      new Uint8Array([patches.length]),
      ...patches.map(p => concatBytes(uint24ToBytes(p.offset), new Uint8Array([reg(p.reg)]))),
      uint24ToBytes(bytes.length), bytes);
  }
  bytes(): Uint8Array {
    const result = concatBytes(...this.parts);
    if (result.length <= 1 || result.length > 65536) throw new Error("runtime program size");
    return result;
  }
}
function reg(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n >= 16) throw new Error("runtime register bounds");
  return n;
}
export function runtimeProgramScript(program: Uint8Array, amount = 0n): Uint8Array {
  return concatBytes(new Uint8Array([0x0e]), uint256ToBytes(amount), uint24ToBytes(program.length), program);
}
export interface RuntimeAmountLeg {
  readonly actionAdapterId: string;
  readonly program: string;
}
export const runtimeAmountFlowAdapter: ActionAdapter = {
  id: "runtime-amount-flow", isWrapper: false, field2Offset: null,
  descriptor: { adapterId: "runtime-amount-flow", lineage: "erc20-infra", edgeKind: null,
    action: "guard", canSendValue: false, leavesStandingPositionDefault: false },
  matchTrace: () => false,
  encode(node) {
    if (typeof node.params.legs !== "string" || node.children.length || node.amount <= 0n) throw new Error("runtime flow shape");
    const legs = JSON.parse(node.params.legs) as { tokenIn: string; tokenOut: string; program: string }[];
    if (!Array.isArray(legs) || !legs.length || legs.length > 6) throw new Error("runtime flow length");
    let token = node.tokenIn.toLowerCase();
    const minimumReturn = node.params.minimumReturn;
    if (typeof minimumReturn !== "bigint" || minimumReturn < node.amount || minimumReturn > ethers.MaxUint256) {
      throw new Error("runtime flow return constraint");
    }
    const records = legs.map((leg, index) => {
      if (leg.tokenIn.toLowerCase() !== token || leg.tokenOut.toLowerCase() === token) throw new Error("runtime flow continuity");
      token = leg.tokenOut.toLowerCase();
      const bytes = ethers.getBytes(leg.program);
      if (!bytes.length || bytes.length > 65536) throw new Error("runtime flow program bounds");
      return concatBytes(addressToBytes(leg.tokenIn), addressToBytes(leg.tokenOut),
        uint256ToBytes(index === legs.length - 1 ? minimumReturn : 1n), uint24ToBytes(bytes.length), bytes);
    });
    if (token !== node.tokenIn.toLowerCase() || token !== node.tokenOut.toLowerCase()) throw new Error("runtime flow not closed");
    const data = concatBytes(uint256ToBytes(node.amount), new Uint8Array([legs.length]), ...records);
    return concatBytes(new Uint8Array([0x0c]), uint24ToBytes(data.length), data);
  },
};
