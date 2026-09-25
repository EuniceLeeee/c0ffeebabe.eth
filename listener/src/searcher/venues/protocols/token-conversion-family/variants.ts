import { Interface, getAddress, keccak256, TypedDataEncoder, zeroPadValue } from "ethers";

export const ABI = new Interface([
  "function BTB_TOKEN() view returns(address)", "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)",
  "function approve(address,uint256) returns(bool)",
  "function mint(uint256) returns(uint256)", "function redeem(uint256) returns(uint256)",
  "function previewTransfer(uint256) pure returns(uint256 netAmount,uint256 taxAmount)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Minted(address indexed user,uint256 btbAmount,uint256 btbbAmount)",
  "event Redeemed(address indexed user,uint256 btbbAmount,uint256 btbAmount)",
]);
export const MAX_UINT = (1n << 256n) - 1n;
export function positiveAmount(amount: bigint): void {
  if (typeof amount !== "bigint" || amount <= 0n || amount > MAX_UINT) throw new Error("conversion amount outside positive uint256");
}
export function nonzero(address: string): string {
  const value = getAddress(address);
  if (BigInt(value) === 0n) throw new Error("conversion zero address");
  return value;
}

// A behavior sample cannot establish a transitive dependency closure. Accept
// only legacy asset runtimes whose instructions read local storage/call input
// and cannot call elsewhere, inspect other accounts, use block/gas/origin state,
// create code, or self-destruct. PUSH operands are data, not instructions.
// This is deliberately conservative: unreachable code/metadata is scanned too;
// an unproven asset remains retryable, never silently assumed to be plain ERC20.
// It proves refresh closure, NOT ERC20 semantics; the amount/effect probes and
// mandatory final execution verification are still required.
export function proveLocalAssetRuntime(code: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error("asset dependency closure unproven");
  const bytes = code.slice(2).match(/../g)!.map(byte => parseInt(byte, 16));
  for (let pc = 0; pc < bytes.length; pc++) {
    const op = bytes[pc]!;
    if (op >= 0x60 && op <= 0x7f) {
      pc += op - 0x5f;
      if (pc >= bytes.length) throw new Error("asset truncated PUSH: dependency closure unproven");
      continue;
    }
    const local = op === 0x00 || (op >= 0x01 && op <= 0x0b) || (op >= 0x10 && op <= 0x1d) ||
      op === 0x20 || op === 0x30 || (op >= 0x33 && op <= 0x39) || op === 0x3d || op === 0x3e ||
      (op >= 0x50 && op <= 0x59) || op === 0x5b || op === 0x5e || op === 0x5f ||
      (op >= 0x80 && op <= 0x9f) || (op >= 0xa0 && op <= 0xa4) || [0xf3, 0xfd, 0xfe].includes(op);
    if (!local) throw new Error(`asset dependency closure unproven at opcode 0x${op.toString(16)}`);
  }
  return keccak256(code);
}

// Audited BTBBear Solidity 0.8.30 runtime template (8612 bytes), including its
// metadata. Only constructor immutable PUSH32 operands are normalized. Every
// normalized operand is first checked against its independently derived value;
// opcodes, constants, fee arithmetic and all remaining bytes must match exactly.
// This admits matching deployments, not an instance-address allowlist. The
// EIP712 cache is Ethereum chain 1; other chain variants are not claimed.
const TEMPLATE_HASH = "0xfc654b0b765d1f2031061e105e4d055a1462bd7ad3431a6adce20397ee41cfe6";
const ASSET_OPERANDS = [837, 2621, 3170, 3892, 4108] as const;
export function proveBearRuntime(code: string, target: string, asset: string): string {
  target = nonzero(target); asset = nonzero(asset);
  if (target === asset || !/^0x[0-9a-fA-F]{17224}$/.test(code)) throw new Error("unsupported conversion runtime");
  let normalized = code.toLowerCase();
  const operands: readonly (readonly [number, string])[] = [
    ...ASSET_OPERANDS.map(offset => [offset, zeroPadValue(asset, 32)] as const),
    [4694, zeroPadValue(target, 32)],
    [4778, TypedDataEncoder.hashDomain({ name: "BTB Bear", version: "1", chainId: 1, verifyingContract: target })],
  ];
  for (const [offset, expected] of operands) {
    const start = 2 + offset * 2;
    if (normalized.slice(start - 2, start) !== "7f" || normalized.slice(start, start + 64) !== expected.slice(2).toLowerCase()) {
      throw new Error("conversion immutable binding mismatch");
    }
    normalized = normalized.slice(0, start) + "0".repeat(64) + normalized.slice(start + 64);
  }
  if (keccak256(normalized) !== TEMPLATE_HASH) throw new Error("unsupported conversion runtime template");
  return keccak256(code);
}

// Separate transfer semantics; mint and redeem use _mint/_burn and never call
// the taxed public transfer override. This value is NOT the mint receipt.
export function bearTransferReceipt(amount: bigint): { net: bigint; tax: bigint } {
  positiveAmount(amount);
  if (amount > MAX_UINT / 100n) throw new Error("BTBB transfer tax multiplication overflow");
  const tax = amount * 100n / 10000n;
  return { net: amount - tax, tax };
}
