import { Interface, ZeroAddress, getBytes, hexlify, type ParamType } from "ethers";

/** Public declaration names cannot address common compiler snapshots. Internal
 * capture allocation deliberately does not use this public-input validator. */
export function assertPublicRuntimeCaptureName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || name.startsWith("frame") ||
      ["__proto__", "constructor", "prototype", "amountIn"].includes(name))
    throw new Error("reserved or invalid public runtime capture name");
}

export type RuntimeCallReference = { readonly runtime: string };
function reference(value: unknown): value is RuntimeCallReference {
  return value !== null && typeof value === "object" && Object.hasOwn(value, "runtime");
}
function isDynamic(type: ParamType): boolean {
  if (type.baseType === "array") return type.arrayLength === -1 || isDynamic(type.arrayChildren!);
  if (type.baseType === "tuple") return type.components!.some(isDynamic);
  return type.type === "bytes" || type.type === "string";
}
function staticSize(type: ParamType): number {
  if (isDynamic(type)) return 32;
  if (type.baseType === "array") return type.arrayLength! * staticSize(type.arrayChildren!);
  if (type.baseType === "tuple") return type.components!.reduce((n, child) => n + staticSize(child), 0);
  return 32;
}
function tupleValues(type: ParamType, value: any): readonly any[] {
  if (Array.isArray(value)) {
    if (value.length !== type.components!.length) throw new Error("declared tuple arity");
    return value;
  }
  if (!value || typeof value !== "object" || type.components!.some(c => !c.name || !Object.hasOwn(value, c.name)) ||
      Object.keys(value).length !== type.components!.length) throw new Error("declared tuple fields");
  return type.components!.map(c => value[c.name]);
}
function scalar(type: ParamType): boolean {
  // Full-width signed leaves carry the already checked runtime word. Narrow
  // signed/unsigned types remain forbidden: patching them needs explicit ABI
  // range/sign-extension checks, not truncation.
  return type.type === "uint256" || type.type === "int256" || type.type === "bytes32";
}

/** ABI layout is derived from the ABI encoder's canonical head/tail offsets.
 * Array lengths and dynamic bytes are known when compiling; only fixed-size
 * scalar leaves may be replaced at transaction time. Never patch offset words. */
export function encodeDeclarativeCall(
  signature: string,
  args: readonly unknown[],
): { readonly data: string; readonly patches: readonly { offset: number; reference: string; signed?: true }[] } {
  const abi = new Interface([signature]);
  const functions = abi.fragments.filter(f => f.type === "function");
  if (functions.length !== 1) throw new Error("declared call requires one function");
  const fn = abi.getFunction(functions[0]!.format("sighash"))!;
  if (!Array.isArray(args) || args.length !== fn.inputs.length) throw new Error("declared call arguments");
  function placeholder(type: ParamType, value: any): any {
    if (reference(value)) {
      if (Object.keys(value).length !== 1 || typeof value.runtime !== "string" || !scalar(type))
        throw new Error("runtime ABI references require uint256 or bytes32 leaves (full-width int256 also supported)");
      if (type.type === "address") return ZeroAddress;
      if (type.type === "bool") return false;
      if (type.type.startsWith("bytes")) return `0x${"00".repeat(Number(type.type.slice(5)))}`;
      return 0n;
    }
    if (type.baseType === "array") {
      if (!Array.isArray(value) || type.arrayLength !== -1 && value.length !== type.arrayLength)
        throw new Error("declared array length");
      return value.map(v => placeholder(type.arrayChildren!, v));
    }
    if (type.baseType === "tuple") return tupleValues(type, value).map((v, i) => placeholder(type.components![i]!, v));
    return value;
  }
  const data = abi.encodeFunctionData(fn, args.map((v, i) => placeholder(fn.inputs[i]!, v)));
  const bytes = getBytes(data), patches: { offset: number; reference: string; signed?: true }[] = [];
  function offset(at: number): number {
    if (at < 4 || at + 32 > bytes.length) throw new Error("declared ABI offset bounds");
    const result = BigInt(hexlify(bytes.slice(at, at + 32)));
    if (result > BigInt(bytes.length)) throw new Error("declared ABI offset exceeds calldata");
    return Number(result);
  }
  function fields(types: readonly ParamType[], values: readonly any[], base: number): void {
    let cursor = base;
    types.forEach((type, i) => {
      walk(type, values[i], isDynamic(type) ? base + offset(cursor) : cursor);
      cursor += staticSize(type);
    });
  }
  function walk(type: ParamType, value: any, at: number): void {
    if (reference(value)) {
      if (at < 4 || at + 32 > bytes.length) throw new Error("declared ABI patch bounds");
      patches.push({ offset: at, reference: value.runtime, ...(type.type === "int256" ? { signed: true as const } : {}) }); return;
    }
    if (type.baseType === "tuple") fields(type.components!, tupleValues(type, value), at);
    else if (type.baseType === "array") {
      const base = type.arrayLength === -1 ? at + 32 : at;
      if (type.arrayLength === -1 && offset(at) !== value.length) throw new Error("declared ABI array length mismatch");
      fields(value.map(() => type.arrayChildren!), value, base);
    }
  }
  fields(fn.inputs, args, 4);
  if (new Set(patches.map(p => p.offset)).size !== patches.length) throw new Error("duplicate ABI patch offset");
  return Object.freeze({ data, patches: Object.freeze(patches.map(p => Object.freeze(p))) });
}
