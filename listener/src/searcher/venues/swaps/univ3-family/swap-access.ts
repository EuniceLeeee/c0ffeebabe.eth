import { ethers } from "ethers";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import type { UniV3Descriptor } from "./types.js";

export interface UniV3SwapAccess {
  readonly kind: "is-swapper" | "no-is-swapper-getter" | "unsupported";
  readonly codeHash: string;
}

export const UNIV3_SWAPPER_INTERFACE = new ethers.Interface([
  "function isSwapper(address) view returns (bool)",
]);
const SWAPPER_SELECTOR = Number(UNIV3_SWAPPER_INTERFACE.getFunction("isSwapper")!.selector);

interface Instruction {
  readonly pc: number;
  readonly next: number;
  readonly op: number;
  readonly data: string;
}

/** A deliberately narrow Solidity 0.7 dispatcher/getter recognizer, not a decompiler. */
export function classifyUniV3SwapAccess(code: string): UniV3SwapAccess {
  if (!ethers.isHexString(code, true)) throw new Error("univ3 invalid runtime bytecode");
  const codeHash = ethers.keccak256(code);
  const result = (kind: UniV3SwapAccess["kind"]): UniV3SwapAccess =>
    Object.freeze({ kind, codeHash });
  const bytes = ethers.getBytes(code);
  if (bytes.length === 0 || bytes.length > 24_576) return result("unsupported");
  const instructions = new Map<number, Instruction>();
  for (let pc = 0; pc < bytes.length;) {
    const op = bytes[pc]!;
    const next = pc + 1 + (op >= 0x60 && op <= 0x7f ? op - 0x5f : 0);
    // Unreachable compiler metadata may end in a truncated PUSH. It cannot
    // supply an instruction or jump destination to any recognized path.
    if (next > bytes.length) break;
    if (op === 0xf4 || op === 0xf2) return result("unsupported"); // delegate/callcode proxy
    instructions.set(pc, { pc, next, op, data: ethers.hexlify(bytes.slice(pc + 1, next)).slice(2) });
    pc = next;
  }
  const match = (pc: number, shape: string): readonly Instruction[] | null => {
    const matched: Instruction[] = [];
    for (const token of shape.split(" ")) {
      const [opcode, data] = token.split(":");
      const instruction = instructions.get(pc);
      if (instruction === undefined || instruction.op !== Number.parseInt(opcode!, 16) ||
          (data !== undefined && instruction.data !== data)) return null;
      matched.push(instruction);
      pc = instruction.next;
    }
    return matched;
  };
  const destination = (instruction: Instruction) => Number.parseInt(instruction.data, 16);
  const prologue = match(0,
    "60:80 60:40 52 34 80 15 61 57 60:00 80 fd 5b 50 60:04 36 10 61 57 60:00 35 60:e0 1c");
  if (prologue === null || destination(prologue[6]!) !== prologue[11]!.pc) return result("unsupported");
  const fallback = destination(prologue[16]!);
  const fallbackCode = match(fallback, "5b 60:00 80 fd");
  const start = prologue[prologue.length - 1]!.next;
  if (fallbackCode === null || fallback <= start) return result("unsupported");
  const firstFunction = fallbackCode[fallbackCode.length - 1]!.next;
  const selectors = new Map<number, number>();
  const visited = new Set<number>();
  const mark = (sequence: readonly Instruction[]) => {
    for (const instruction of sequence) {
      if (visited.has(instruction.pc)) throw new Error("overlapping dispatcher");
      visited.add(instruction.pc);
    }
  };
  // Solidity's DUP1/PUSH4/GT tests pivot > selector. Check both intervals,
  // including default paths, so dead or contradictory selector entries fail closed.
  const walk = (entry: number, low: number, high: number, depth: number): void => {
    if (depth > 32 || low > high) throw new Error("invalid dispatcher tree");
    let pc = entry;
    while (pc !== fallback) {
      if (pc < start || pc >= fallback || visited.size > 2048) throw new Error("invalid dispatcher target");
      const instruction = instructions.get(pc);
      if (instruction?.op === 0x5b) {
        mark([instruction]);
        pc = instruction.next;
        continue;
      }
      const defaultJump = match(pc, "61 56");
      if (defaultJump !== null) {
        if (destination(defaultJump[0]!) !== fallback) throw new Error("non-reverting fallback");
        mark(defaultJump);
        return;
      }
      const comparison = match(pc, "80 63 14 61 57") ?? match(pc, "80 63 11 61 57");
      if (comparison === null) throw new Error("unknown dispatcher");
      mark(comparison);
      const pivot = destination(comparison[1]!);
      const target = destination(comparison[3]!);
      if (instructions.get(target)?.op !== 0x5b || pivot < low || pivot > high) {
        throw new Error("unreachable selector or invalid jump");
      }
      if (comparison[2]!.op === 0x14) {
        if (target < firstFunction || selectors.has(pivot)) throw new Error("ambiguous selector");
        selectors.set(pivot, target);
      } else {
        walk(target, low, pivot - 1, depth + 1);
        low = pivot;
      }
      pc = comparison[comparison.length - 1]!.next;
    }
  };
  try {
    walk(start, 0, 0xffff_ffff, 0);
    if (selectors.size === 0 || [...instructions.values()].some(instruction =>
      instruction.pc >= start && instruction.pc < fallback && !visited.has(instruction.pc))) {
      return result("unsupported");
    }
  } catch {
    return result("unsupported");
  }
  const getter = selectors.get(SWAPPER_SELECTOR);
  // This proves selector absence only in the recognized dispatcher. It does
  // not prove that swap has no other execution restrictions.
  if (getter === undefined) return result("no-is-swapper-getter");
  const wrapper = match(getter, "5b 61 60:04 80 36 03 60:20 81 10 15 61 57 60:00 80 fd");
  if (wrapper === null) return result("unsupported");
  const argumentPc = destination(wrapper[10]!);
  const argument = match(argumentPc, "5b 50 35 60:01 60:01 60:a0 1b 03 16 61 56");
  if (argument === null || argumentPc !== wrapper[wrapper.length - 1]!.next ||
      destination(wrapper[1]!) !== argument[argument.length - 1]!.next) return result("unsupported");
  const returned = match(destination(wrapper[1]!), "5b 60:40 80 51 91 15 15 82 52 51 90 81 90 03 60:20 01 90 f3");
  // Complete leaf: keccak256(abi.encode(addressArgument, uint256(0))),
  // SLOAD, low-byte mask, return to the verified bool encoder. No caller,
  // external dependency, write, or unexamined branch exists on this path.
  const body = match(destination(argument[9]!), "5b 60:00 60:20 81 90 52 90 81 52 60:40 90 20 54 60:ff 16 81 56");
  return result(returned !== null && body !== null ? "is-swapper" : "unsupported");
}

interface SwapAccessInput {
  readonly descriptor: UniV3Descriptor;
  readonly executor: string;
  readonly source: CanonicalSource;
}

export function uniV3SwapAccessRequest(input: SwapAccessInput): Extract<AdapterRequest, { kind: "eth-call" }> | null {
  const access = input.descriptor.swapAccess;
  if (access?.kind === "no-is-swapper-getter") return null;
  if (access?.kind !== "is-swapper") throw new Error("univ3 unsupported swap access capability");
  const { number, hash, generation } = input.source;
  if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(generation) || generation < 0 ||
      !ethers.isHexString(hash, 32)) throw new Error("univ3 invalid swap access source");
  const pool = ethers.getAddress(input.descriptor.pool);
  const executor = ethers.getAddress(input.executor);
  return Object.freeze({
    id: `univ3-swap-access:${pool.toLowerCase()}:${executor.toLowerCase()}:${number}:${hash.toLowerCase()}:${generation}`,
    kind: "eth-call" as const,
    to: pool,
    data: UNIV3_SWAPPER_INTERFACE.encodeFunctionData("isSwapper", [executor]),
    completion: "return-data" as const,
  });
}

export function assertUniV3SwapAccess(input: SwapAccessInput, results: readonly AdapterRequestResult[]): void {
  const request = uniV3SwapAccessRequest(input);
  if (request === null) return;
  const matching = results.filter(result => result.id === request.id);
  if (matching.length !== 1) throw new Error("univ3 missing or duplicate swap access result");
  const result = matching[0]!;
  if (result.source.number !== input.source.number || result.source.generation !== input.source.generation ||
      result.source.hash.toLowerCase() !== input.source.hash.toLowerCase()) {
    throw new Error("univ3 swap access result came from a foreign source");
  }
  if (!result.ok) throw new Error(`univ3 swap access request failed: ${result.failure}`);
  if (result.completion !== "returned" || !/^0x0{63}[01]$/i.test(result.data)) {
    throw new Error("univ3 malformed swap access result");
  }
  if (BigInt(result.data) === 0n) throw new Error("univ3 executor is not an allowed swapper");
}
