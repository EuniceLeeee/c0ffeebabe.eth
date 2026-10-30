import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";
import { ZeroAddress, getAddress, toBeHex } from "ethers";

/**
 * Fluid Vault T1 debt ceiling as a pure integer model. This is the exact
 * arithmetic of the hand-authored borrow-math.ts (ticks, fee, rounding and
 * liquidity-capacity bounds); JSON selects the request amount and the operate
 * simulation still proves the actual receipt. No transport, ABI, storage or
 * protocol lookup belongs here.
 */
const Q96 = 1n << 96n;
const E26 = 10n ** 26n;
const MAX = (1n << 256n) - 1n;
const MIN_RATIO = 37075072n;
const MAX_RATIO = 169307877264527972847801929085841449095838922544595n;
const TICK_FACTORS = [
  4626198540796508716348404308345255985n, 21508599537851153911767490449162n,
  46377364670549310883002866649n, 2153540449365864845468344760n,
  464062544207767844008185025n, 215421109505955298802281577n,
  146772309890508740607270615n, 121149622323187099817270416n,
  110067989135437147685980801n, 104913292358707887270979600n,
  102427189924701091191840928n, 101206318935480056907421313n,
  100601351350506250000000000n, 100300225000000000000000000n,
  100150000000000000000000000n,
] as const;

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX) throw new Error(`fluid-credit math ${label} is not uint256`);
  return value;
}

function tickAtRatio(ratio: bigint): number {
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) throw new Error("fluid-credit math ratio outside tick range");
  const negative = ratio < Q96;
  let factor = negative ? Q96 * E26 / ratio : ratio * E26 / Q96;
  let tick = 0;
  for (let i = 0; i < TICK_FACTORS.length; i++) {
    if (factor >= TICK_FACTORS[i]) {
      tick |= 1 << (14 - i);
      factor = factor * E26 / TICK_FACTORS[i];
    }
  }
  return negative ? ~tick : tick;
}

interface BorrowState {
  readonly oracleRate: bigint;
  readonly collateralFactorBps: bigint;
  readonly borrowFeeBps: bigint;
  readonly supplyExchangePrice: bigint;
  readonly borrowExchangePrice: bigint;
}

function assertState(state: BorrowState): void {
  if (state.oracleRate < 10n ** 9n || state.oracleRate > 10n ** 54n ||
      state.collateralFactorBps <= 0n || state.collateralFactorBps > 10_000n ||
      state.borrowFeeBps < 0n || state.borrowFeeBps > 1023n ||
      state.supplyExchangePrice <= 0n || state.borrowExchangePrice <= 0n) {
    throw new Error("fluid-credit math invalid current borrow parameters");
  }
}

function borrowCeiling(amountIn: bigint, state: BorrowState, debtBps: bigint): bigint {
  assertState(state);
  if (amountIn < 10_000n || amountIn > (1n << 127n) - 1n || debtBps <= 0n || debtBps > 10_000n) {
    throw new Error("fluid-credit math invalid collateral amount or ceiling fraction");
  }
  const collateralRaw = amountIn * 10n ** 12n / state.supplyExchangePrice;
  if (collateralRaw === 0n || collateralRaw >= 1n << 128n) throw new Error("fluid-credit math collateral outside position bounds");
  const rawOracle = state.oracleRate * state.supplyExchangePrice / state.borrowExchangePrice;
  const cappedOracle = rawOracle > 10n ** 45n ? 10n ** 45n : rawOracle;
  const cfTick = tickAtRatio(cappedOracle * state.collateralFactorBps / 10_000n * Q96 / 10n ** 27n);
  let low = 0n;
  let high = amountIn * state.oracleRate * state.collateralFactorBps /
    (10n ** 27n * (10_000n + state.borrowFeeBps));
  if (high > (1n << 127n) - 1n) high = (1n << 127n) - 1n;
  const withinCf = (amount: bigint): boolean => {
    const principal = amount * 10n ** 12n / state.borrowExchangePrice + 1n;
    const debtRaw = principal + principal * state.borrowFeeBps / 10_000n;
    if (debtRaw >= 1n << 128n) return false;
    const adjustedDebt = debtRaw * 1_000_000_001n / 1_000_000_000n + 1n;
    const ratio = adjustedDebt * Q96 / collateralRaw;
    return ratio < MIN_RATIO || (ratio <= MAX_RATIO && tickAtRatio(ratio) + 1 <= cfTick);
  };
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (withinCf(mid)) low = mid; else high = mid - 1n;
  }
  return low * debtBps / 10_000n;
}

/** Largest integer debt request admitted by the T1 CF/tick/fee arithmetic.
 * Capacity, permissions and token behavior remain proven by the operate
 * simulation; this model only selects the request amount. */
function maxBorrowRequest(amountIn: bigint, state: BorrowState, debtBps: bigint): bigint {
  const requested = borrowCeiling(amountIn, state, debtBps);
  const collateralRaw = amountIn * 10n ** 12n / state.supplyExchangePrice;
  const principal = requested * 10n ** 12n / state.borrowExchangePrice + 1n;
  const debtRaw = principal + principal * state.borrowFeeBps / 10_000n;
  const netDebtRaw = debtRaw * 1_000_000_001n / 1_000_000_000n + 1n;
  if (requested < 10_000n || netDebtRaw < 10_000n) throw new Error("fluid-credit math below minimum borrow amount");
  tickAtRatio(netDebtRaw * Q96 / collateralRaw);
  return requested;
}

/** Decode the vault's packed risk-config word (the same word the vault stores
 * and updateExchangePrices consumes). JSON cannot express the bit extraction,
 * so this pure integer transform exposes the fields the risk condition uses.
 * It performs no transport, storage or protocol lookup. */
const CONFIG_STATE_ID = "fluid-credit:config-state";
export const fluidCreditConfigStateMathModel: DeclarativeMathModel = Object.freeze({
  id: CONFIG_STATE_ID, version: 1,
  validateInput(value: MathValue): void {
    if (!Array.isArray(value) || value.length !== 1) throw new Error("fluid-credit config state requires one packed word");
    uint(value[0], "config[0]");
  },
  evaluate(value: MathValue): MathValue {
    const [packed] = value as readonly bigint[];
    const oracle = getAddress(toBeHex(packed! >> 96n, 20));
    const collateralFactorBps = ((packed! >> 32n) & 1023n) * 10n;
    const borrowFeeBps = (packed! >> 82n) & 1023n;
    if (oracle === ZeroAddress || collateralFactorBps <= 0n || collateralFactorBps > 10_000n || borrowFeeBps > 1023n)
      throw new Error("fluid-credit config state invalid oracle/collateral factor");
    return { oracle, collateralFactorBps, borrowFeeBps };
  },
  validateOutput(value: MathValue): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fluid-credit config state output");
    const output = value as { readonly oracle?: unknown; readonly collateralFactorBps?: unknown; readonly borrowFeeBps?: unknown };
    if (typeof output.oracle !== "string" || output.oracle === ZeroAddress ||
        typeof output.collateralFactorBps !== "bigint" || output.collateralFactorBps <= 0n || output.collateralFactorBps > 10_000n ||
        typeof output.borrowFeeBps !== "bigint" || output.borrowFeeBps > 1023n)
      throw new Error("fluid-credit config state output is invalid");
  },
});

function state(values: readonly MathValue[]): BorrowState {
  if (!Array.isArray(values) || values.length !== 3) throw new Error("fluid-credit math state requires three values");
  const [oracleRate, collateralFactorBps, borrowFeeBps] = values.map((value, index) => uint(value, `state[${index}]`));
  return { oracleRate: oracleRate!, collateralFactorBps: collateralFactorBps!, borrowFeeBps: borrowFeeBps!,
    supplyExchangePrice: 0n, borrowExchangePrice: 0n };
}

export const fluidCreditMathModels: readonly DeclarativeMathModel[] = Object.freeze([
  {
    id: "fluid-credit:max-borrow-request", version: 1,
    validateInput(value) {
      if (!Array.isArray(value) || value.length !== 7) throw new Error("fluid-credit max-borrow requires seven integers");
      const [amountIn, oracleRate, collateralFactorBps, borrowFeeBps, supplyExchangePrice, borrowExchangePrice, debtBps] =
        value.map((item, index) => uint(item, `input[${index}]`));
      if (amountIn! < 10_000n || amountIn! > (1n << 127n) - 1n) throw new Error("fluid-credit math collateral amount outside int128");
      assertState({ oracleRate: oracleRate!, collateralFactorBps: collateralFactorBps!, borrowFeeBps: borrowFeeBps!,
        supplyExchangePrice: supplyExchangePrice!, borrowExchangePrice: borrowExchangePrice! });
      if (debtBps! <= 0n || debtBps! > 10_000n) throw new Error("fluid-credit math invalid ceiling fraction");
    },
    evaluate(value) {
      const [amountIn, oracleRate, collateralFactorBps, borrowFeeBps, supplyExchangePrice, borrowExchangePrice, debtBps] =
        value as readonly bigint[];
      return maxBorrowRequest(amountIn!, { oracleRate: oracleRate!, collateralFactorBps: collateralFactorBps!,
        borrowFeeBps: borrowFeeBps!, supplyExchangePrice: supplyExchangePrice!, borrowExchangePrice: borrowExchangePrice! }, debtBps!);
    },
    validateOutput(value) {
      const output = uint(value, "output");
      if (output < 10_000n) throw new Error("fluid-credit math output below minimum debt");
    },
  },
  fluidCreditConfigStateMathModel,
]);
