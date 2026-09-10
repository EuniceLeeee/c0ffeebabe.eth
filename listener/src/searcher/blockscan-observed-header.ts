import type { CanonicalHeader } from "./canonical-header-journal.js";
import { ethereumBlockActivityCoverage } from "../shared/state/ethereum-block-activity.js";

export interface BlockScanObservedHeader extends CanonicalHeader {
  readonly timestamp: number;
  readonly baseFeePerGas: bigint | null;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  readonly transactionHashes: readonly string[];
  /** Non-transaction balance changes cannot silently look like clean accounts. */
  readonly passiveTouchedAddresses?: readonly string[];
}

/** Normalize the existing header RPC without discarding its transaction list or
 * withdrawal recipients. The provider remains the canonical observation source. */
export function parseBlockScanObservedHeader(value: unknown, expectedNumber: number, chainId: bigint): BlockScanObservedHeader {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("missing source header");
  const block = value as Record<string, unknown>;
  const quantity = (value: unknown): bigint => {
    if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
      throw new Error("invalid source header quantity");
    }
    return BigInt(value);
  };
  const hash = (value: unknown): string => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("invalid source header hash");
    return value.toLowerCase();
  };
  const number = Number(quantity(block.number)), timestamp = Number(quantity(block.timestamp));
  if (!Number.isSafeInteger(number) || number !== expectedNumber || !Number.isSafeInteger(timestamp)) {
    throw new Error("source header height or timestamp mismatch");
  }
  if (!Array.isArray(block.transactions)) {
    throw new Error("source header lacks full activity anchors");
  }
  const transactionHashes = block.transactions.map(tx => hash(
    tx !== null && typeof tx === "object" && !Array.isArray(tx) ? tx.hash : tx));
  if (new Set(transactionHashes).size !== transactionHashes.length) throw new Error("duplicate source transaction");
  // No strong coverage means fresh amount quotes; it need not stop raw pricing.
  const coverage = ethereumBlockActivityCoverage(chainId, block);
  return Object.freeze({ number, hash: hash(block.hash), parentHash: hash(block.parentHash), timestamp,
    baseFeePerGas: block.baseFeePerGas == null ? null : quantity(block.baseFeePerGas),
    gasUsed: quantity(block.gasUsed), gasLimit: quantity(block.gasLimit),
    transactionHashes: Object.freeze(transactionHashes),
    ...(coverage === null ? {} : { passiveTouchedAddresses: coverage.passiveTouchedAddresses }),
  });
}
