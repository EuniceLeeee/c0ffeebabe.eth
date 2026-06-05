import { ethers } from "ethers";
import type { FilterMatch, PendingTx } from "./types.js";

// DOLA/wstUSR Curve pool — coin[0]=DOLA, coin[1]=wstUSR
const CURVE_DOLA_WSTUSR = "0x64273624eb57c5cA961d366CBF3968e760Bf0452";

// Selectors for Curve exchange functions
// exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)
const EXCHANGE_SELECTOR = "0x3df02124";
// exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)
const EXCHANGE_RECEIVER_SELECTOR = "0xddc1f59d";
// exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)
const EXCHANGE_RECEIVED_SELECTOR = "0x7e3db030";
// exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)
const EXCHANGE_RECEIVED_RECEIVER_SELECTOR = "0xafb43012";

const EXCHANGE_SELECTORS = new Set([
  EXCHANGE_SELECTOR,
  EXCHANGE_RECEIVER_SELECTOR,
  EXCHANGE_RECEIVED_SELECTOR,
  EXCHANGE_RECEIVED_RECEIVER_SELECTOR,
]);

const exchangeAbi = [
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
];

const iface = new ethers.Interface(exchangeAbi);

/**
 * Check if a pending transaction is a wstUSR→DOLA swap on the target pool.
 * This is the "depeg direction" — someone selling wstUSR for DOLA, which
 * creates the opportunity for our backrun.
 *
 * coin[0] = DOLA, coin[1] = wstUSR
 * wstUSR→DOLA = i=1, j=0 (selling wstUSR)
 */
export function matchTargetSwap(
  tx: PendingTx,
  minSwapSize: bigint
): FilterMatch | null {
  // Must target the DOLA/wstUSR pool
  if (!tx.to || tx.to.toLowerCase() !== CURVE_DOLA_WSTUSR.toLowerCase()) {
    return null;
  }

  // Must have enough calldata for a selector + params
  if (!tx.data || tx.data.length < 10) {
    return null;
  }

  const selector = tx.data.slice(0, 10).toLowerCase();
  if (!EXCHANGE_SELECTORS.has(selector)) {
    return null;
  }

  try {
    const decoded = iface.parseTransaction({ data: tx.data });
    if (!decoded) return null;

    const i = BigInt(decoded.args[0]);
    const j = BigInt(decoded.args[1]);
    const dx = BigInt(decoded.args[2]);

    // wstUSR→DOLA: i=1 (wstUSR), j=0 (DOLA)
    if (i === 1n && j === 0n && dx >= minSwapSize) {
      return {
        txHash: tx.hash,
        pool: CURVE_DOLA_WSTUSR,
        direction: "wstUSR_to_DOLA",
        amount: dx,
      };
    }

    return null;
  } catch {
    // Decoding failed — not a matching tx
    return null;
  }
}

/**
 * Decode a raw transaction to get its fields.
 * Used when we receive full pending tx data from the node.
 */
export function decodePendingTx(
  hash: string,
  rawTx: ethers.TransactionResponse
): PendingTx {
  return {
    hash,
    from: rawTx.from,
    to: rawTx.to,
    data: rawTx.data,
    value: rawTx.value.toString(),
    gasPrice: rawTx.gasPrice?.toString(),
    maxFeePerGas: rawTx.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: rawTx.maxPriorityFeePerGas?.toString(),
  };
}
