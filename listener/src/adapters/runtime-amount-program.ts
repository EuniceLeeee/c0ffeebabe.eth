import { ethers } from "ethers";
import { addressToBytes, concatBytes, uint24ToBytes, uint256ToBytes } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";
import { assertExecutionRounding } from "../shared/executor/amount-rounding.js";

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
  math(op: "add" | "sub" | "mul" | "div" | "shr" | "and" | "neg" | "eq" | "min", dst: number, a: number, b = a): this {
    return this.push(new Uint8Array([2, ["add", "sub", "mul", "div", "shr", "and", "neg", "eq", "min"].indexOf(op), reg(dst), reg(a), reg(b)]));
  }
  equal(a: number, b: number): this { return this.push(new Uint8Array([3, reg(a), reg(b)])); }
  /** Explicit new-runtime encoding of an ordinary CALL, with no value,
   * register patches or callback frame. The default call() ABI is unchanged. */
  directCall(target: string, data: string | Uint8Array): this {
    const bytes = ethers.getBytes(data);
    return this.push(new Uint8Array([10]), addressToBytes(target), uint24ToBytes(bytes.length), bytes);
  }
  /** Check a returned unsigned word, or the magnitude of a negative signed
   * word, without loading constants and temporary registers into the VM. */
  returnedFloor(offset: number, minimum: bigint, negative = false): this {
    if (minimum < 0n || minimum > ethers.MaxUint256) throw new Error("runtime return floor uint256");
    return this.push(new Uint8Array([11, negative ? 1 : 0]), uint24ToBytes(offset), uint256ToBytes(minimum));
  }
  load(dst: number, offset: number): this { return this.push(new Uint8Array([6, reg(dst)]), uint24ToBytes(offset)); }
  /** Current executor native balance, without an external RPC or helper call. */
  nativeBalance(dst: number): this {
    return this.push(new Uint8Array([5, reg(dst)]));
  }
  calldata(dst: number, offset: number): this {
    return this.push(new Uint8Array([7, reg(dst)]), uint24ToBytes(offset));
  }
  /** Error context only: no external reads, balances or state changes. Child
   * programs inherit it; callback programs carry their own authenticated tag. */
  diagnosticHop(index: number, flowHash: string): this {
    if (!Number.isInteger(index) || index < 0 || index >= 6 || !ethers.isHexString(flowHash, 32) || flowHash === ethers.ZeroHash) {
      throw new Error("runtime diagnostic context");
    }
    return this.push(new Uint8Array([9, index]), ethers.getBytes(flowHash));
  }
  allowance(token: string, spender: string, amountReg = 0, grant = ethers.MaxUint256): this {
    return this.push(new Uint8Array([4]), addressToBytes(token), addressToBytes(spender),
      new Uint8Array([reg(amountReg)]), uint256ToBytes(grant));
  }
  call(target: string, data: string | Uint8Array, input: {
    static?: boolean; valueReg?: number; patches?: readonly { offset: number; reg: number }[];
    callback?: { incomingOffset: number; outgoingOffset: number };
    /** Accept only a reverted call with this exact byte length. No value or
     * callback is permitted; the Family validates the returned ABI bytes. */
    revertBytes?: number;
  } = {}): this {
    const bytes = ethers.getBytes(data), patches = input.patches ?? [];
    if (patches.length > 255 || patches.some(p => !Number.isSafeInteger(p.offset) || p.offset < 4 || p.offset + 32 > bytes.length)) {
      throw new Error("runtime call patch bounds");
    }
    if (input.static && (input.valueReg !== undefined || input.callback)) throw new Error("runtime static call configuration");
    if (input.revertBytes !== undefined && (!Number.isSafeInteger(input.revertBytes) ||
        input.revertBytes < 0 || input.revertBytes > 65536 || input.static ||
        input.valueReg !== undefined || input.callback)) throw new Error("runtime reverted call configuration");
    return this.push(new Uint8Array([1]), addressToBytes(target),
      new Uint8Array([input.revertBytes !== undefined ? 2 : input.static ? 1 : 0, input.valueReg === undefined ? 255 : reg(input.valueReg)]),
      uint24ToBytes(input.callback?.incomingOffset ?? 0), uint24ToBytes(input.callback?.outgoingOffset ?? 0),
      new Uint8Array([patches.length]),
      ...(input.revertBytes === undefined ? [] : [uint24ToBytes(input.revertBytes)]),
      ...patches.map(p => concatBytes(uint24ToBytes(p.offset), new Uint8Array([reg(p.reg)]))),
      uint24ToBytes(bytes.length), bytes);
  }
  bytes(): Uint8Array {
    const result = concatBytes(...this.parts);
    if (result.length <= 1 || result.length > 65536) throw new Error("runtime program size");
    return result;
  }
  /** Invocation-local registers; only r0 is returned. Quote programs are
   * transitively read-only, enforced by the VM rather than an emitter label. */
  run(program: string | Uint8Array, inputReg = 0, outputReg = 0, readOnly = false): this {
    const bytes = ethers.getBytes(program);
    if (bytes.length < 2 || bytes.length > 65536 || bytes[0] !== 1) throw new Error("runtime subprogram shape");
    return this.push(new Uint8Array([8, reg(inputReg), reg(outputReg), readOnly ? 1 : 0]),
      uint24ToBytes(bytes.length), bytes);
  }
}
function reg(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n >= 16) throw new Error("runtime register bounds");
  return n;
}
/** Prepend metadata inside the caller's existing child frame. Do not allocate
 * a second register frame merely to set a hop tag. At the instruction bound,
 * preserve the original scoped form instead of making a valid program fail. */
export function withRuntimeHopContext(index: number, flowHash: string, program: string | Uint8Array): Uint8Array {
  const tag = new RuntimeAmountProgram().diagnosticHop(index, flowHash);
  const bytes = ethers.getBytes(program);
  const scoped = () => tag.run(bytes).bytes();
  if (bytes.length < 2 || bytes.length > 65536 || bytes[0] !== 1) return scoped();
  const u24 = (at: number) => bytes[at]! * 65536 + bytes[at + 1]! * 256 + bytes[at + 2]!;
  const fixed: Record<number, number> = { 0: 34, 2: 5, 3: 3, 4: 74, 5: 2, 6: 5, 7: 5, 9: 34, 11: 37 };
  let count = 0, cursor = 1;
  while (cursor < bytes.length) {
    if (++count >= 128) return scoped();
    const opcode = bytes[cursor]!;
    let size = fixed[opcode];
    if (opcode === 1) {
      if (cursor + 30 > bytes.length) return scoped();
      const mode = bytes[cursor + 21]!;
      if (mode > 2) return scoped();
      const sizeAt = cursor + 30 + (mode === 2 ? 3 : 0) + bytes[cursor + 29]! * 4;
      if (sizeAt + 3 > bytes.length) return scoped();
      size = sizeAt + 3 + u24(sizeAt) - cursor;
    } else if (opcode === 10) {
      if (cursor + 24 > bytes.length) return scoped();
      size = 24 + u24(cursor + 21);
    } else if (opcode === 8) {
      if (cursor + 7 > bytes.length) return scoped();
      size = 7 + u24(cursor + 4);
    }
    if (size === undefined || cursor + size > bytes.length) return scoped();
    cursor += size;
  }
  const prefix = tag.bytes();
  if (prefix.length + bytes.length - 1 > 65536) return scoped();
  return concatBytes(prefix, bytes.slice(1));
}
export function runtimeProgramScript(program: Uint8Array, amount = 0n): Uint8Array {
  return concatBytes(new Uint8Array([0x0e]), uint256ToBytes(amount), uint24ToBytes(program.length), program);
}
/** Explicit compiler backend for the call-only subset. Unsupported dynamic
 * operations reject here instead of silently fixing their runtime amounts. */
export function runtimeCallSequenceScript(program: Uint8Array): Uint8Array {
  if (program.length < 2 || program[0] !== 1) throw new Error("runtime call sequence shape");
  const u24 = (p: number) => program[p]! * 65536 + program[p + 1]! * 256 + program[p + 2]!;
  const chunks: Uint8Array[] = [new Uint8Array([2])];
  let p = 1, count = 0;
  while (p < program.length) {
    if (++count > 128) throw new Error("runtime call sequence limit");
    const op = program[p]!;
    let size = op === 9 ? 34 : op === 11 ? 37 : 0;
    if (op === 10) {
      if (p + 24 > program.length) throw new Error("runtime call sequence bounds");
      size = 24 + u24(p + 21);
    } else if (op === 1) {
      if (p + 33 > program.length || program[p + 21] !== 0 || program[p + 22] !== 255 || program[p + 29] !== 0
        || u24(p + 23) < 32 || u24(p + 26) < 32) throw new Error("runtime call sequence options");
      size = 33 + u24(p + 30);
    }
    if (!size || p + size > program.length) throw new Error("runtime call sequence unsupported operation");
    chunks.push(op === 1
      ? concatBytes(new Uint8Array([12]), program.slice(p + 1, p + 21), program.slice(p + 23, p + 29), program.slice(p + 30, p + size))
      : program.slice(p, p + size));
    p += size;
  }
  const compiled = concatBytes(...chunks);
  if (compiled.length > 65536) throw new Error("runtime call sequence size");
  // Version 2 cannot read r0. Do not transmit an unused 32-byte initial
  // amount or a second copy of the enclosing call's length.
  return concatBytes(new Uint8Array([0x0f]), compiled);
}
/** The quoted-construction path can execute the same Family runtime program
 * with its fixed trial input. This is data, not a second execution policy. */
export function encodeRuntimeAmountNode(node: ResolvedPlanNode, innerScript: Uint8Array): Uint8Array | null {
  const program = node.params.runtimeAmountProgram;
  if (program === undefined) return null;
  if (typeof program !== "string" || !ethers.isHexString(program, true) ||
      !program.startsWith("0x01") || program.length <= 4 || program.length > 2 + 65536 * 2 ||
      node.amount <= 0n || node.amount > ethers.MaxUint256 || node.children.length || innerScript.length) {
    throw new Error("runtime program node shape");
  }
  return runtimeProgramScript(ethers.getBytes(program), node.amount);
}

const TRANSFER = new ethers.Interface(["function transfer(address to,uint256 amount)"]);
const BALANCE = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
/** The outer Family patches the callback's opening balance floor from a read
 * made BEFORE it releases output. Existing inventory cannot fund the prefix. */
export function runtimeDeferredPayment(input: {
  tokenOut: string; executor: string; paymentAmount: bigint; paymentProgram: string; debtOffset?: number;
  paymentInput?: "debt";
}): { script: Uint8Array; floorOffset: number; limitOffset: number } {
  const p = new RuntimeAmountProgram().constant(5, 0n)
    .call(input.tokenOut, BALANCE.encodeFunctionData("balanceOf", [input.executor]), { static: true }).load(6, 0)
    .math("sub", 7, 6, 5);
  if (input.debtOffset === undefined) p.constant(2, 0n).math("add", 1, 0, 2);
  else p.calldata(1, input.debtOffset);
  runtimePayment(p, 1, 2);
  p.constant(3, input.paymentAmount).run(input.paymentProgram, input.paymentInput === "debt" ? 1 : 3, 4).equal(4, 1);
  return { script: runtimeProgramScript(p.bytes()), floorOffset: 36 + 3, limitOffset: 1 };
}
export function runtimeDeferredOpeningFloor(p: RuntimeAmountProgram, tokenOut: string, executor: string, paymentAmount: bigint): void {
  p.call(tokenOut, BALANCE.encodeFunctionData("balanceOf", [executor]), { static: true }).load(13, 0)
    .constant(14, paymentAmount).math("add", 13, 13, 14);
}
/** Bind a protocol-decoded unsigned debt to this invocation's input cap once.
 * All payment forms and optional settlement-credit verification use that same
 * debt register. ABI decoding and protocol-specific sync/wrap steps stay owned
 * by the emitter; no additional chain reads or calls are introduced here. */
export function runtimePayment(program: RuntimeAmountProgram, debtReg: number, checkReg: number) {
  if (debtReg === 0 || checkReg === 0 || debtReg === checkReg) throw new Error("runtime payment registers");
  program.math("sub", checkReg, 0, debtReg);
  return {
    transfer(token: string, recipient: string): void {
      program.call(token, TRANSFER.encodeFunctionData("transfer", [recipient, 0n]), {
        patches: [{ offset: 36, reg: debtReg }],
      });
    },
    callValue(target: string, data: string): void {
      program.call(target, data, { valueReg: debtReg });
    },
    verifySettled(resultReg: number): void {
      if (resultReg === 0 || resultReg === debtReg) throw new Error("runtime settlement register");
      program.load(resultReg, 0).equal(resultReg, debtReg);
    },
  };
}
/** Generic bounded callback settlement. The owner declares the debt word's ABI
 * offset; the VM authenticates the callback scope and enforces this trial's cap.
 * r0 is patched by the enclosing call with the current working amount. */
export function runtimeCallbackPayment(token: string, recipient: string, debtOffset: number): {
  script: Uint8Array; limitOffset: number;
} {
  const program = new RuntimeAmountProgram().calldata(1, debtOffset);
  runtimePayment(program, 1, 2).transfer(token, recipient);
  return { script: runtimeProgramScript(program.bytes()), limitOffset: 1 };
}
export interface RuntimeAmountLeg {
  readonly actionAdapterId: string;
  readonly program: string;
  /** Positive actual debit bounded by the budget; retained input stays protected. */
  readonly inputMode?: "maximum";
  /** Optional, Family-owned settlement facts. These do not grant admission. */
  readonly settlement?: RuntimeSettlementCapabilities;
  readonly settlementRequest?: RuntimeSettlementRequest;
}
export interface RuntimeSettlementCapabilities {
  readonly quoteOutput?: true;
  readonly directOutput?: true;
  /** Can pay a bounded, fixed input and deliver the callback's actual debt
   * directly to its recipient. The receiving venue enforces credited payment. */
  readonly settleOutput?: true;
  /** Recipient of this leg's deferred input, not necessarily the pool address. */
  readonly deferredInput?: string;
  /** Accepts paymentInput=debt; absence retains measured-prefix settlement. */
  readonly deferredDebtInput?: true;
}
export type RuntimeSettlementRequest =
  | { readonly kind: "quote-output"; readonly recipient?: string }
  | { readonly kind: "direct-output"; readonly recipient: string }
  | { readonly kind: "settle-output"; readonly recipient: string; readonly amountIn: bigint }
  | { readonly kind: "deferred-input"; readonly paymentProgram: string; readonly paymentAmount: bigint;
      readonly paymentInput?: "debt" };

/** This route witness excludes its own diagnostic tags. The simulator also
 * checks the complete compiled execution input before trusting an envelope. */
export function runtimeSettlementFlowHash(amount: bigint, minimumReturn: bigint,
  legs: readonly { tokenIn: string; tokenOut: string; program: string }[]): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "tuple(address tokenIn,address tokenOut,bytes program)[]"],
    [amount, minimumReturn, legs],
  ));
}
export const runtimeAmountFlowAdapter: ActionAdapter = {
  id: "runtime-amount-flow", isWrapper: false, field2Offset: null,
  descriptor: { adapterId: "runtime-amount-flow", lineage: "erc20-infra", edgeKind: null,
    action: "guard", canSendValue: false, leavesStandingPositionDefault: false },
  matchTrace: () => false,
  encode(node) {
    if (typeof node.params.legs !== "string" || node.children.length || node.amount <= 0n) throw new Error("runtime flow shape");
    const tolerance = node.params.quoteToleranceRawUnits ?? 0n;
    if (typeof tolerance !== "bigint") throw new Error("runtime flow tolerance type");
    assertExecutionRounding(tolerance);
    const legs = JSON.parse(node.params.legs) as { tokenIn: string; tokenOut: string; program: string; inputMode?: "maximum" }[];
    if (!Array.isArray(legs) || !legs.length || legs.length > 6) throw new Error("runtime flow length");
    let token = node.tokenIn.toLowerCase();
    const minimumReturn = node.params.minimumReturn;
    if (typeof minimumReturn !== "bigint" || minimumReturn < node.amount || minimumReturn > ethers.MaxUint256) {
      throw new Error("runtime flow return constraint");
    }
    let maximumInputMask = 0;
    const records = legs.map((leg, index) => {
      if (leg.inputMode !== undefined && leg.inputMode !== "maximum") throw new Error("runtime input mode");
      if (leg.inputMode === "maximum") maximumInputMask |= 1 << index;
      if (leg.tokenIn.toLowerCase() !== token || leg.tokenOut.toLowerCase() === token) throw new Error("runtime flow continuity");
      token = leg.tokenOut.toLowerCase();
      const bytes = ethers.getBytes(leg.program);
      if (!bytes.length || bytes.length > 65536) throw new Error("runtime flow program bounds");
      return concatBytes(addressToBytes(leg.tokenIn), addressToBytes(leg.tokenOut),
        uint256ToBytes(index === legs.length - 1 ? minimumReturn : 1n), uint24ToBytes(bytes.length), bytes);
    });
    if (token !== node.tokenIn.toLowerCase() || token !== node.tokenOut.toLowerCase()) throw new Error("runtime flow not closed");
    if (node.params.settlementProgram !== undefined) {
      if (typeof node.params.settlementProgram !== "string") throw new Error("runtime settlement program shape");
      const program = ethers.getBytes(node.params.settlementProgram);
      if (program.length < 2 || program.length > 65536 || program[0] !== 1 ||
          maximumInputMask !== 0 && maximumInputMask !== 1 << (legs.length - 1)) throw new Error("runtime settlement program bounds");
      if (node.params.settlementEncoding !== undefined) {
        if (node.params.settlementEncoding !== "call-sequence-v2") throw new Error("runtime settlement encoding");
        return runtimeCallSequenceScript(program);
      }
      return runtimeProgramScript(program, node.amount);
    }
    const data = concatBytes(uint256ToBytes(node.amount),
      new Uint8Array([legs.length | (Number(tolerance) << 7) | (maximumInputMask ? 0x40 : 0)]),
      maximumInputMask ? new Uint8Array([maximumInputMask]) : new Uint8Array(), ...records);
    return concatBytes(new Uint8Array([0x0c]), uint24ToBytes(data.length), data);
  },
};
