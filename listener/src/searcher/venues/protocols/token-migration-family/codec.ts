import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { assertSameSource, returnedResult } from "../standard-family/common.js";

export const ABI = new ethers.Interface([
  "function BIT_TOKEN_ADDRESS() view returns(address)",
  "function MNT_TOKEN_ADDRESS() view returns(address)",
  "function TOKEN_CONVERSION_NUMERATOR() view returns(uint256)",
  "function TOKEN_CONVERSION_DENOMINATOR() view returns(uint256)",
  "function halted() view returns(bool)",
  "function migrateBIT(uint256 amount)",
  "function migrateAllBIT()",
  "function tokenMigrationAmountToReceive(uint256 amount) view returns(uint256)",
  "event TokensMigrated(address indexed to,uint256 amountOfBitSwapped,uint256 amountOfMntReceived)",
]);
export const ERC20 = new ethers.Interface([
  "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);
export const MAX = (1n << 256n) - 1n;
export const nonzero = (value: string): string => {
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) throw new Error("migration zero address");
  return address;
};
export function word(data: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) throw new Error("migration noncanonical word");
  return BigInt(data);
}
export function addressWord(data: string): string {
  if (word(data) >> 160n !== 0n) throw new Error("migration noncanonical address");
  return nonzero(`0x${data.slice(-40)}`);
}
export function resultSet(results: readonly AdapterRequestResult[], ids: readonly string[]) {
  if (results.length !== ids.length || new Set(results.map(r => r.id)).size !== ids.length) {
    throw new Error("migration missing or duplicate results");
  }
  return assertSameSource(ids.map(id => returnedResult(results, id)));
}
export function calculate(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (typeof amount !== "bigint" || amount < 0n || amount > MAX || numerator <= 0n ||
      denominator <= 0n || numerator > MAX || denominator > MAX || amount * numerator > MAX) {
    throw new Error("migration uint256 arithmetic bounds");
  }
  return amount * numerator / denominator;
}

// Solidity 0.8.13 optimizer=200 deployed MantleTokenMigrator runtime, from
// verified source at 0x5c30d7494da55e23f62130c642c22af1814ef65d (provenance only).
// Offsets are PUSH32 operand starts, independently checked against the creation
// code's immutable patch table. Only constructor immutables are masked; opcode,
// control flow and metadata bytes must match. Unknown compiler variants fail closed.
export const IMMUTABLES = Object.freeze({
  tokenIn: Object.freeze([342, 1116, 1437, 1613, 2560]),
  tokenOut: Object.freeze([574, 1175, 1674, 2613]),
  numerator: Object.freeze([423, 2307]),
  denominator: Object.freeze([813, 2271]),
});
export const RUNTIME_LENGTH = 3277;
export const NORMALIZED_RUNTIME_HASH = "0x9a1b19d064a32ecbaa78d7cc01738d864d8cacd06c320a675a6e921abd557d50";
export interface MigrationBinding {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
}
export function verifyRuntime(code: string, binding: MigrationBinding): boolean {
  const bytes = ethers.getBytes(code);
  if (bytes.length !== RUNTIME_LENGTH) return false;
  const values = { tokenIn: BigInt(nonzero(binding.tokenIn)), tokenOut: BigInt(nonzero(binding.tokenOut)),
    numerator: binding.numerator, denominator: binding.denominator };
  for (const key of Object.keys(IMMUTABLES) as (keyof typeof IMMUTABLES)[]) {
    for (const offset of IMMUTABLES[key]) {
      if (bytes[offset - 1] !== 0x7f || BigInt(ethers.hexlify(bytes.slice(offset, offset + 32))) !== values[key]) return false;
      bytes.fill(0, offset, offset + 32);
    }
  }
  return ethers.keccak256(bytes) === NORMALIZED_RUNTIME_HASH;
}
