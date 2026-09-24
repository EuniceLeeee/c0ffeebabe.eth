import { addressToBytes, concatBytes, uint24ToBytes, uint256ToBytes } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

// Version 1: a bounded, exact-quoted amount dispatch. Records are not executable
// opcodes by themselves; only the enclosing FLOW opcode interprets them.
const descriptor = (adapterId: string) => ({ adapterId, lineage: "erc20-infra" as const,
  edgeKind: null, action: "guard" as const, canSendValue: false,
  leavesStandingPositionDefault: false });
const action = (id: string, encode: ActionAdapter["encode"]): ActionAdapter => ({
  id, isWrapper: true, field2Offset: null, descriptor: descriptor(id), encode,
  matchTrace: () => false,
});
function requireChildren(node: ResolvedPlanNode, id: string, max: number): void {
  if (!node.children.length || node.children.length > max ||
      node.children.some(child => child.adapterId !== id)) throw new Error("invalid amount-flow records");
}

export const actualAmountCaseAdapter = action("actual-amount-case", (node, _executor, inner) => {
  const quote = node.params.quotedAmountOut;
  if (node.amount <= 0n || typeof quote !== "bigint" || quote <= 1n || !inner.length) {
    throw new Error("invalid amount-flow exact case");
  }
  return concatBytes(uint256ToBytes(node.amount), uint256ToBytes(quote),
    uint24ToBytes(inner.length), inner);
});

export const actualAmountStepAdapter = action("actual-amount-step", (node, _executor, inner) => {
  // One-byte count. Symmetric +/-1 branching needs at most 3**5 = 243
  // separately quoted inputs on the sixth hop (before amount deduplication).
  requireChildren(node, "actual-amount-case", 255);
  if (node.tokenIn.toLowerCase() === node.tokenOut.toLowerCase() ||
      new Set(node.children.map(child => child.amount)).size !== node.children.length) {
    throw new Error("invalid amount-flow token or duplicate input");
  }
  // Family encoders usually differ only in amount words. Store one base script
  // and lossless byte patches, without understanding any protocol ABI. Full
  // records remain available when the encoding shape/length actually changes.
  const u24 = (at: number) => inner[at]! * 65536 + inner[at + 1]! * 256 + inner[at + 2]!;
  const records: Uint8Array[] = [];
  let at = 0;
  let base: Uint8Array | undefined;
  for (const _case of node.children) {
    if (at + 67 > inner.length) throw new Error("truncated amount-flow case");
    const size = u24(at + 64), end = at + 67 + size;
    if (!size || end > inner.length) throw new Error("invalid amount-flow case size");
    const script = inner.slice(at + 67, end);
    base ??= script;
    const patches: Uint8Array[] = [];
    if (base.length === script.length) for (let i = 0; i < script.length;) {
      if (base[i] === script[i]) { i++; continue; }
      const start = i++;
      while (i < script.length && i - start < 255 && base[i] !== script[i]) i++;
      patches.push(concatBytes(uint24ToBytes(start), new Uint8Array([i - start]), script.slice(start, i)));
    }
    const patch = concatBytes(...patches);
    const compact = base.length === script.length && patch.length < script.length;
    const body = compact ? patch : script;
    records.push(concatBytes(inner.slice(at, at + 64), new Uint8Array([compact ? 1 : 0]),
      uint24ToBytes(body.length), body));
    at = end;
  }
  if (at !== inner.length) throw new Error("trailing amount-flow records");
  const section = concatBytes(uint24ToBytes(base!.length), base!, ...records);
  return concatBytes(addressToBytes(node.tokenIn), addressToBytes(node.tokenOut),
    new Uint8Array([node.children.length]), uint24ToBytes(section.length), section);
});

export const actualAmountFlowAdapter = action("actual-amount-flow", (node, _executor, inner) => {
  requireChildren(node, "actual-amount-step", 6);
  if (node.amount <= 0n || node.params.toleranceRawUnits !== 1n ||
      node.children[0]!.children.length !== 1 || node.children[0]!.children[0]!.amount !== node.amount ||
      node.children[0]!.tokenIn.toLowerCase() !== node.tokenIn.toLowerCase() ||
      node.children.at(-1)!.tokenOut.toLowerCase() !== node.tokenIn.toLowerCase()) {
    throw new Error("invalid amount-flow root");
  }
  for (let i = 1; i < node.children.length; i++) {
    if (node.children[i - 1]!.tokenOut.toLowerCase() !== node.children[i]!.tokenIn.toLowerCase()) {
      throw new Error("disconnected amount-flow");
    }
  }
  const payload = concatBytes(uint256ToBytes(node.amount), new Uint8Array([1, node.children.length]), inner);
  return concatBytes(new Uint8Array([0x09]), uint24ToBytes(payload.length), payload);
});
