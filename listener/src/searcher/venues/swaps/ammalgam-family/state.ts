import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import {
  ASSET_COUNT,
  BORROW_X,
  BORROW_Y,
  DEPOSIT_X,
  DEPOSIT_Y,
  PAIR,
  TOKEN,
  call,
  read,
  sourceOf,
  tokenCall,
} from "./codec.js";
import type { Descriptor, State } from "./types.js";

export const STATE_IDS = ["reserves", "references", "assets", "balance-x", "balance-y"] as const;

/** Complete pair state the swap model consumes at one source block. */
export function stateRequests(descriptor: Pick<Descriptor, "pair" | "tokenX" | "tokenY">): readonly AdapterRequest[] {
  return [
    call("reserves", descriptor.pair, "getReserves"),
    call("references", descriptor.pair, "referenceReserves"),
    call("assets", descriptor.pair, "totalAssetsAndShares", [false]),
    tokenCall("balance-x", descriptor.tokenX, "balanceOf", [descriptor.pair]),
    tokenCall("balance-y", descriptor.tokenY, "balanceOf", [descriptor.pair]),
  ];
}

export function decodeState(
  descriptor: Pick<Descriptor, "pair" | "tokenX" | "tokenY">,
  results: readonly AdapterRequestResult[],
  expected?: CanonicalSource,
): State {
  const source = sourceOf(results, expected);
  if (results.length !== STATE_IDS.length) throw new Error("ammalgam state read set is incomplete");
  const reserves = read(results, "reserves", PAIR, "getReserves");
  const references = read(results, "references", PAIR, "referenceReserves");
  const assets = read(results, "assets", PAIR, "totalAssetsAndShares");
  const balanceX = read(results, "balance-x", TOKEN, "balanceOf")[0] as bigint;
  const balanceY = read(results, "balance-y", TOKEN, "balanceOf")[0] as bigint;
  const allAssets = assets[0] as readonly bigint[];
  if (allAssets.length !== ASSET_COUNT) throw new Error("ammalgam asset vector length");
  return {
    source,
    reserves: [reserves[0] as bigint, reserves[1] as bigint],
    references: [references[0] as bigint, references[1] as bigint],
    assets: [
      allAssets[0], allAssets[1], allAssets[2], allAssets[3], allAssets[4], allAssets[5],
    ],
    balances: [balanceX, balanceY],
    lastUpdateTimestamp: reserves[2] as bigint,
  };
}

/** Ammalgam `getNetBalances(0,0)`: token.balanceOf(pair) + BORROW - DEPOSIT. */
export function netBalances(state: State): readonly [bigint, bigint] {
  const [balanceX, balanceY] = state.balances;
  return [
    balanceX + state.assets[BORROW_X] - state.assets[DEPOSIT_X],
    balanceY + state.assets[BORROW_Y] - state.assets[DEPOSIT_Y],
  ];
}

/** Ammalgam `missingAssets()`: max(borrow,deposit) - deposit. */
export function missingAssets(state: State): readonly [bigint, bigint] {
  const [depositX, depositY, borrowX, borrowY] =
    [state.assets[DEPOSIT_X], state.assets[DEPOSIT_Y], state.assets[BORROW_X], state.assets[BORROW_Y]];
  return [
    (borrowX > depositX ? borrowX : depositX) - depositX,
    (borrowY > depositY ? borrowY : depositY) - depositY,
  ];
}

/**
 * Reasons the state cannot be quoted with this model. `null` means quotable.
 *
 * The family models the pair's own `swap` assumption `netBalance == reserve`
 * (its `calculateAmountIn` correctness depends on it) and the non-depleted
 * branch of the K check. Everything else is refused rather than approximated.
 */
export function quotable(state: State): string | null {
  const [reserveX, reserveY] = state.reserves;
  if (reserveX <= 0n || reserveY <= 0n) return "ammalgam-pair-zero-reserves";
  const [netX, netY] = netBalances(state);
  if (netX !== reserveX || netY !== reserveY) return "ammalgam-pair-net-balance-mismatch";
  const [missingX, missingY] = missingAssets(state);
  const [referenceX, referenceY] = state.references;
  if (referenceX <= 0n || referenceY <= 0n) return "ammalgam-pair-zero-reference-reserve";
  const depleted = (reserve: bigint, missing: bigint) => reserve * 19n < missing * 20n;
  if (depleted(reserveX, missingX) || depleted(reserveY, missingY)) return "ammalgam-pair-depleted-reserve";
  return null;
}
