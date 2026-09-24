import { getAddress, keccak256, TypedDataEncoder, zeroPadValue } from "ethers";

// Same audited, immutable runtime template as token-conversion's identity proof.
// This matches deployments by complete code, never by token/factory address.
const TEMPLATE_HASH = "0xfc654b0b765d1f2031061e105e4d055a1462bd7ad3431a6adce20397ee41cfe6";
const ASSET_OPERANDS = [837, 2621, 3170, 3892, 4108] as const;

export function matchesBearTransferRuntime(code: string, token: string): boolean {
  if (!/^0x[0-9a-fA-F]{17224}$/.test(code)) return false;
  token = getAddress(token);
  const assetWord = code.slice(2 + ASSET_OPERANDS[0] * 2, 2 + (ASSET_OPERANDS[0] + 32) * 2);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(assetWord)) return false;
  const asset = getAddress(`0x${assetWord.slice(24)}`);
  if (BigInt(asset) === 0n || asset === token) return false;
  let normalized = code.toLowerCase();
  const operands = [
    ...ASSET_OPERANDS.map(offset => [offset, zeroPadValue(asset, 32)] as const),
    [4694, zeroPadValue(token, 32)] as const,
    [4778, TypedDataEncoder.hashDomain({ name: "BTB Bear", version: "1", chainId: 1, verifyingContract: token })] as const,
  ];
  for (const [offset, expected] of operands) {
    const start = 2 + offset * 2;
    if (normalized.slice(start - 2, start) !== "7f" || normalized.slice(start, start + 64) !== expected.slice(2).toLowerCase()) return false;
    normalized = normalized.slice(0, start) + "0".repeat(64) + normalized.slice(start + 64);
  }
  return keccak256(normalized) === TEMPLATE_HASH;
}
