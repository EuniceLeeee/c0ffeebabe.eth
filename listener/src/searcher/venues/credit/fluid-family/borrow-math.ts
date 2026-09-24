/** Fluid Vault T1 uses debt/collateral ticks, not Uniswap sqrt-price ticks.
 * Integer operations follow contracts/libraries/tickMath.sol and VaultT1
 * operate/_addDebtToTickWrite in Instadapp/fluid-contracts-public.
 * This only selects a request amount; the actual operate must still succeed.
 */
const Q96 = 1n << 96n;
const E26 = 10n ** 26n;
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

export interface FluidBorrowState {
  /** Raw debt units per raw collateral unit, scaled by 1e27. */
  readonly oracleRate: bigint;
  readonly collateralFactorBps: bigint;
  readonly borrowFeeBps: bigint;
  readonly supplyExchangePrice: bigint;
  readonly borrowExchangePrice: bigint;
}

export function fluidTickAtRatio(ratio: bigint): number {
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) throw new Error("fluid-credit ratio outside tick range");
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

export function assertFluidBorrowState(state: FluidBorrowState): void {
  if (state.oracleRate < 10n ** 9n || state.oracleRate > 10n ** 54n ||
      state.collateralFactorBps <= 0n || state.collateralFactorBps > 10_000n ||
      state.borrowFeeBps < 0n || state.borrowFeeBps > 1023n ||
      state.supplyExchangePrice <= 0n || state.borrowExchangePrice <= 0n) {
    throw new Error("fluid-credit invalid current borrow parameters");
  }
}

/** Largest integer request admitted by the T1 CF/tick/fee arithmetic.
 * Capacity, permissions and token behavior are subsequently proven by operate.
 * debtBps, when supplied, is a fraction of this ceiling (10000 = maximum),
 * never an assumed USD parity between the collateral and debt tokens.
 */
export function fluidMaxBorrowRequest(amountIn: bigint, state: FluidBorrowState, debtBps = 10_000n): bigint {
  const requested = borrowCeiling(amountIn, state, debtBps);
  const collateralRaw = amountIn * 10n ** 12n / state.supplyExchangePrice;
  const principal = requested * 10n ** 12n / state.borrowExchangePrice + 1n;
  const debtRaw = principal + principal * state.borrowFeeBps / 10_000n;
  const netDebtRaw = debtRaw * 1_000_000_001n / 1_000_000_000n + 1n;
  if (requested < 10_000n || netDebtRaw < 10_000n) throw new Error("fluid-credit below minimum borrow amount");
  fluidTickAtRatio(netDebtRaw * Q96 / collateralRaw);
  return requested;
}

/** Input ceiling at a fixed CF/debt-fraction policy, not a deposit limit.
 * Invert the same integer quote; never shrink an actual requested input.
 */
export function fluidMaxInputForBorrowCapacity(state: FluidBorrowState, capacity: bigint, debtBps = 10_000n): bigint {
  assertFluidBorrowState(state);
  if (capacity < 0n || debtBps <= 0n || debtBps > 10_000n) throw new Error("fluid-credit invalid capacity or ceiling fraction");
  if (capacity < 10_000n) return 0n;
  let low = 10_000n;
  const collateralBound = ((1n << 128n) * state.supplyExchangePrice - 1n) / 10n ** 12n;
  let high = collateralBound < (1n << 127n) - 1n ? collateralBound : (1n << 127n) - 1n;
  // Avoid zero raw collateral for very small raw input units.
  const minCollateral = (state.supplyExchangePrice + 10n ** 12n - 1n) / 10n ** 12n;
  if (low < minCollateral) low = minCollateral;
  if (low > high || borrowCeiling(low, state, debtBps) > capacity) return 0n;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (borrowCeiling(mid, state, debtBps) <= capacity) low = mid;
    else high = mid - 1n;
  }
  const requested = borrowCeiling(low, state, debtBps);
  const principal = requested * 10n ** 12n / state.borrowExchangePrice + 1n;
  const debtRaw = principal + principal * state.borrowFeeBps / 10_000n;
  if (requested < 10_000n || debtRaw * 1_000_000_001n / 1_000_000_000n + 1n < 10_000n) return 0n;
  return fluidMaxBorrowRequest(low, state, debtBps) <= capacity ? low : 0n;
}

function borrowCeiling(amountIn: bigint, state: FluidBorrowState, debtBps: bigint): bigint {
  assertFluidBorrowState(state);
  if (amountIn < 10_000n || amountIn > (1n << 127n) - 1n || debtBps <= 0n || debtBps > 10_000n) {
    throw new Error("fluid-credit invalid collateral amount or ceiling fraction");
  }
  const collateralRaw = amountIn * 10n ** 12n / state.supplyExchangePrice;
  if (collateralRaw === 0n || collateralRaw >= 1n << 128n) throw new Error("fluid-credit collateral outside position bounds");
  const rawOracle = state.oracleRate * state.supplyExchangePrice / state.borrowExchangePrice;
  const cappedOracle = rawOracle > 10n ** 45n ? 10n ** 45n : rawOracle;
  const cfTick = fluidTickAtRatio(cappedOracle * state.collateralFactorBps / 10_000n * Q96 / 10n ** 27n);
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
    return ratio < MIN_RATIO || (ratio <= MAX_RATIO && fluidTickAtRatio(ratio) + 1 <= cfTick);
  };
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (withinCf(mid)) low = mid; else high = mid - 1n;
  }
  return low * debtBps / 10_000n;
}
