import { ethers } from "ethers";

export interface DeclarativeBytecodeGetter {
  readonly version: 1;
  readonly compilerProfile: "solidity-0.7-address-bool-mapping";
  /** Exact uint256 slot, kept as decimal text in lossless Family JSON. */
  readonly storageSlot: string;
  readonly selector?: string;
  readonly signature?: string;
}
export interface DeclarativeBytecodeGetterResult {
  readonly kind: "getter" | "absent" | "unsupported";
  readonly codeHash: string;
}
function parseDefinition(raw: unknown): { selector: number; storageSlot: bigint } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype)
    throw new Error("bytecode getter requires a plain definition");
  const d = raw as DeclarativeBytecodeGetter;
  if (Reflect.ownKeys(d).some(key => typeof key !== "string" ||
      !["version", "compilerProfile", "storageSlot", "selector", "signature"].includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(d)).some(field => !("value" in field)))
    throw new Error("unknown bytecode getter definition field");
  if (d.version !== 1 || d.compilerProfile !== "solidity-0.7-address-bool-mapping" ||
      typeof d.storageSlot !== "string" || !/^(0|[1-9][0-9]*)$/.test(d.storageSlot) || d.storageSlot.length > 78)
    throw new Error("unsupported bytecode getter profile or slot");
  const storageSlot = BigInt(d.storageSlot);
  if (storageSlot > ethers.MaxUint256) throw new Error("bytecode getter slot exceeds uint256");
  if (Object.hasOwn(d, "selector") === Object.hasOwn(d, "signature"))
    throw new Error("bytecode getter requires exactly one selector or signature");
  let selector: string;
  if (Object.hasOwn(d, "signature")) {
    if (typeof d.signature !== "string") throw new Error("invalid bytecode getter signature");
    const fn = ethers.FunctionFragment.from(d.signature);
    if (fn.inputs.length !== 1 || fn.inputs[0]!.type !== "address" || fn.outputs.length !== 1 ||
        fn.outputs[0]!.type !== "bool" || fn.stateMutability !== "view")
      throw new Error("bytecode getter signature must be an address to bool view");
    selector = fn.selector;
  } else {
    if (typeof d.selector !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(d.selector))
      throw new Error("invalid bytecode getter selector");
    selector = d.selector;
  }
  return { selector: Number(selector), storageSlot };
}
export function validateDeclarativeBytecodeGetter(raw: unknown): asserts raw is DeclarativeBytecodeGetter {
  parseDefinition(raw);
}

interface Instruction {
  readonly pc: number;
  readonly next: number;
  readonly op: number;
  readonly data: string;
}

/** A deliberately narrow Solidity 0.7 dispatcher/getter recognizer, not a decompiler. */
export function classifyDeclarativeBytecodeGetter(code: string, raw: unknown): DeclarativeBytecodeGetterResult {
  const definition = parseDefinition(raw);
  if (!ethers.isHexString(code, true)) throw new Error("invalid runtime bytecode");
  const codeHash = ethers.keccak256(code);
  const result = (kind: DeclarativeBytecodeGetterResult["kind"]): DeclarativeBytecodeGetterResult =>
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
  const getter = selectors.get(definition.selector);
  // This proves selector absence only in the recognized dispatcher. It does
  // not prove that swap has no other execution restrictions.
  if (getter === undefined) return result("absent");
  const wrapper = match(getter, "5b 61 60:04 80 36 03 60:20 81 10 15 61 57 60:00 80 fd");
  if (wrapper === null) return result("unsupported");
  const argumentPc = destination(wrapper[10]!);
  const argument = match(argumentPc, "5b 50 35 60:01 60:01 60:a0 1b 03 16 61 56");
  if (argument === null || argumentPc !== wrapper[wrapper.length - 1]!.next ||
      destination(wrapper[1]!) !== argument[argument.length - 1]!.next) return result("unsupported");
  const returned = match(destination(wrapper[1]!), "5b 60:40 80 51 91 15 15 82 52 51 90 81 90 03 60:20 01 90 f3");
  // Complete leaf: keccak256(abi.encode(addressArgument, declaredSlot)),
  // SLOAD, low-byte mask, return to the verified bool encoder. No caller,
  // external dependency, write, or unexamined branch exists on this path.
  const bodyStart = instructions.get(destination(argument[9]!));
  const slot = bodyStart?.op === 0x5b ? instructions.get(bodyStart.next) : undefined;
  const slotMatches = slot !== undefined && slot.op >= 0x60 && slot.op <= 0x7f &&
    BigInt(`0x${slot.data}`) === definition.storageSlot;
  const body = slotMatches ? match(slot!.next, "60:20 81 90 52 90 81 52 60:40 90 20 54 60:ff 16 81 56") : null;
  return result(returned !== null && body !== null ? "getter" : "unsupported");
}
