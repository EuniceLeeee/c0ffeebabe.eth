import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenAllowanceHint, TokenBalanceHint } from "../revm-sim-client.js";

export interface TokenStorageLayout {
  balanceSlot?: number;
  allowanceSlot?: number;
}

export const COMMON_ERC20_MAPPING_SLOTS = [0, 1, 2, 3, 4, 5, 9, 51] as const;

const KNOWN_TOKEN_STORAGE = new Map<string, TokenStorageLayout>([
  // WETH9: mapping(address => uint256) balanceOf at slot 3, allowance at slot 4.
  [ADDR.WETH.toLowerCase(), { balanceSlot: 3, allowanceSlot: 4 }],
]);

export function knownTokenStorageLayout(token: string): TokenStorageLayout | null {
  return KNOWN_TOKEN_STORAGE.get(token.toLowerCase()) ?? null;
}

export function tokenBalanceHint(token: string, account: string): TokenBalanceHint {
  const layout = knownTokenStorageLayout(token);
  return {
    token: ethers.getAddress(token),
    account: ethers.getAddress(account),
    balanceSlot: layout?.balanceSlot,
  };
}

export function tokenAllowanceHint(token: string, owner: string, spender: string): TokenAllowanceHint {
  const layout = knownTokenStorageLayout(token);
  return {
    token: ethers.getAddress(token),
    owner: ethers.getAddress(owner),
    spender: ethers.getAddress(spender),
    allowanceSlot: layout?.allowanceSlot,
  };
}

export function balanceStorageKey(account: string, slotIndex: number): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [ethers.getAddress(account), slotIndex],
    ),
  );
}

export function allowanceStorageKey(owner: string, spender: string, slotIndex: number): string {
  const ownerMap = balanceStorageKey(owner, slotIndex);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [ethers.getAddress(spender), ownerMap],
    ),
  );
}

/** Reads needed to probe a token's balanceOf mapping slot. */
export interface Erc20SlotProbe {
  /** On-chain balanceOf(holder) for the token. */
  balanceOf(token: string, holder: string): Promise<bigint>;
  /** Raw storage word at `slotKey` of the token contract. */
  getStorage(token: string, slotKey: string): Promise<bigint>;
}

// Slot layout is immutable per token, so a probe result is cached globally.
const probedBalanceSlots = new Map<string, number>();

/**
 * Resolve a token's ERC20 `balanceOf` mapping slot index: registry hit first,
 * then a cached probe, then probe COMMON_ERC20_MAPPING_SLOTS by matching the
 * on-chain balanceOf(holder) against keccak(holder, idx) storage. Returns null
 * when no candidate slot matches (non-standard/rebasing token, or zero balance
 * that can't disambiguate) — the caller must then fall back to the cold overlay.
 */
export async function resolveErc20BalanceSlot(
  token: string,
  holder: string,
  probe: Erc20SlotProbe,
): Promise<number | null> {
  const known = knownTokenStorageLayout(token)?.balanceSlot;
  if (known !== undefined) return known;
  const key = token.toLowerCase();
  const cached = probedBalanceSlots.get(key);
  if (cached !== undefined) return cached;

  const balance = await probe.balanceOf(token, holder);
  if (balance <= 0n) return null;
  for (const idx of COMMON_ERC20_MAPPING_SLOTS) {
    const stored = await probe.getStorage(token, balanceStorageKey(holder, idx));
    if (stored === balance) {
      probedBalanceSlots.set(key, idx);
      return idx;
    }
  }
  return null;
}
