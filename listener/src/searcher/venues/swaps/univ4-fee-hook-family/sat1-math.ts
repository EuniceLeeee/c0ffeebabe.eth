// SPDX-License-Identifier: MIT
// Integer port of the MIT-licensed Sat1 Curve and PRBMath UD60x18 (Paul R. Berg).
// Source: verified Sat1Hook source bundle, hook runtime hash
// 0x7cbdd344a7f5e33ccdd136b4833010b6a23e423b5d6eb0012dbb683af4781dae.
// Curve: src/lib/Curve.sol; PRBMath: src/Common.sol and src/ud60x18/Math.sol.
// The independent Solidity fixture retains the original integer algorithms.
export const SAT1_WAD = 10n ** 18n;
export const SAT1_K = 21_000_000n * SAT1_WAD;
export const SAT1_S = 295_537_394_935_162_868_716n;
const UINT256_MAX = (1n << 256n) - 1n;
const LOG2_E = 1_442695040888963407n;
const MAX_EXP = 133_084258667509499440n;
const MAX_EXP2 = 192n * SAT1_WAD - 1n;
const EXP2_FACTORS = [
  0x16A09E667F3BCC909n,
  0x1306FE0A31B7152DFn,
  0x1172B83C7D517ADCEn,
  0x10B5586CF9890F62An,
  0x1059B0D31585743AEn,
  0x102C9A3E778060EE7n,
  0x10163DA9FB33356D8n,
  0x100B1AFA5ABCBED61n,
  0x10058C86DA1C09EA2n,
  0x1002C605E2E8CEC50n,
  0x100162F3904051FA1n,
  0x1000B175EFFDC76BAn,
  0x100058BA01FB9F96Dn,
  0x10002C5CC37DA9492n,
  0x1000162E525EE0547n,
  0x10000B17255775C04n,
  0x1000058B91B5BC9AEn,
  0x100002C5C89D5EC6Dn,
  0x10000162E43F4F831n,
  0x100000B1721BCFC9An,
  0x10000058B90CF1E6En,
  0x1000002C5C863B73Fn,
  0x100000162E430E5A2n,
  0x1000000B172183551n,
  0x100000058B90C0B49n,
  0x10000002C5C8601CCn,
  0x1000000162E42FFF0n,
  0x10000000B17217FBBn,
  0x1000000058B90BFCEn,
  0x100000002C5C85FE3n,
  0x10000000162E42FF1n,
  0x100000000B17217F8n,
  0x10000000058B90BFCn,
  0x1000000002C5C85FEn,
  0x100000000162E42FFn,
  0x1000000000B17217Fn,
  0x100000000058B90C0n,
  0x10000000002C5C860n,
  0x1000000000162E430n,
  0x10000000000B17218n,
  0x1000000000058B90Cn,
  0x100000000002C5C86n,
  0x10000000000162E43n,
  0x100000000000B1721n,
  0x10000000000058B91n,
  0x1000000000002C5C8n,
  0x100000000000162E4n,
  0x1000000000000B172n,
  0x100000000000058B9n,
  0x10000000000002C5Dn,
  0x1000000000000162En,
  0x10000000000000B17n,
  0x1000000000000058Cn,
  0x100000000000002C6n,
  0x10000000000000163n,
  0x100000000000000B1n,
  0x10000000000000059n,
  0x1000000000000002Cn,
  0x10000000000000016n,
  0x1000000000000000Bn,
  0x10000000000000006n,
  0x10000000000000003n,
  0x10000000000000001n,
  0x10000000000000001n,
] as const;

function uint(value: bigint): bigint {
  if (value < 0n || value > UINT256_MAX) throw new Error("sat1 uint256 overflow");
  return value;
}
const add = (a: bigint, b: bigint) => uint(a + b);
const sub = (a: bigint, b: bigint) => uint(a - b);
const mul = (a: bigint, b: bigint) => uint(a * b);
const divWad = (a: bigint, b: bigint) => mul(a, SAT1_WAD) / b;
const mulWad = (a: bigint, b: bigint) => mul(a, b) / SAT1_WAD;

/** PRBMath UD60x18 exp, not a floating-point or alternative log/exp model. */
export function sat1Exp(x: bigint): bigint {
  uint(x);
  if (x > MAX_EXP) throw new Error("sat1 exp input too big");
  return sat1Exp2(x * LOG2_E / SAT1_WAD);
}
export function sat1Exp2(x: bigint): bigint {
  uint(x);
  if (x > MAX_EXP2) throw new Error("sat1 exp2 input too big");
  const binary = (x << 64n) / SAT1_WAD;
  let result = 1n << 191n;
  for (let i = 0; i < EXP2_FACTORS.length; i++) {
    if ((binary & (1n << BigInt(63 - i))) !== 0n) result = (result * EXP2_FACTORS[i]!) >> 64n;
  }
  return (result * SAT1_WAD) >> (191n - (binary >> 64n));
}
export function sat1Log2(x: bigint): bigint {
  uint(x);
  if (x < SAT1_WAD) throw new Error("sat1 log input too small");
  let integer = x / SAT1_WAD, n = 0n;
  while (integer > 1n) { integer >>= 1n; n++; }
  let result = n * SAT1_WAD, y = x >> n;
  if (y === SAT1_WAD) return result;
  for (let delta = SAT1_WAD / 2n; delta > 0n; delta >>= 1n) {
    y = y * y / SAT1_WAD;
    if (y >= 2n * SAT1_WAD) { result += delta; y >>= 1n; }
  }
  return result;
}
export const sat1Ln = (x: bigint): bigint => sat1Log2(x) * SAT1_WAD / LOG2_E;

export function sat1TotalMinted(eth: bigint): bigint {
  uint(eth);
  if (eth === 0n) return 0n;
  const x = divWad(eth, SAT1_S);
  if (x >= 50n * SAT1_WAD) return SAT1_K;
  return mulWad(SAT1_K, sub(SAT1_WAD, divWad(SAT1_WAD, sat1Exp(x))));
}
export function sat1MarginalPrice(eth: bigint): bigint {
  uint(eth);
  const x = divWad(eth, SAT1_S);
  return divWad(mulWad(SAT1_S, sat1Exp(x >= 50n * SAT1_WAD ? 50n * SAT1_WAD : x)), SAT1_K);
}
export function sat1MintFor(ethBefore: bigint, eth: bigint): bigint {
  uint(ethBefore); uint(eth);
  if (eth === 0n) return 0n;
  const a = sat1TotalMinted(ethBefore), b = sat1TotalMinted(add(ethBefore, eth));
  return b > a ? b - a : 0n;
}
export function sat1BurnFor(currentTotal: bigint, amount: bigint): bigint {
  uint(currentTotal); uint(amount);
  if (amount === 0n) return 0n;
  if (amount > currentTotal) throw new Error("sat1 sell exceeds fair supply");
  const denominator = sub(SAT1_K, currentTotal);
  if (denominator === 0n) throw new Error("sat1 inverse domain");
  return mulWad(SAT1_S, sat1Ln(divWad(add(denominator, amount), denominator)));
}

export interface Sat1LocalState {
  readonly ethCum: bigint;
  readonly actualSupply: bigint;
  readonly nativeBalance: bigint;
  /** Hook takes input before the executor settles it; these temporary payout
   * limits remain unchanged after a fully settled leg. */
  readonly managerNativeBalance: bigint;
  readonly managerTokenBalance: bigint;
  readonly genesisBlock: bigint;
  readonly initialized: boolean;
  readonly deprecated: boolean;
  readonly lastBuyBlocks: Readonly<Record<string, bigint>>;
}
export function sat1QuoteAndApply(
  state: Sat1LocalState, amountIn: bigint, buy: boolean, actor: string, blockNumber: bigint,
): { readonly amountOut: bigint; readonly nextState: Sat1LocalState } {
  for (const value of [state.ethCum, state.actualSupply, state.nativeBalance, state.managerNativeBalance,
    state.managerTokenBalance, state.genesisBlock, amountIn, blockNumber]) uint(value);
  if (!state.initialized || blockNumber < add(state.genesisBlock, 100n)) throw new Error("sat1 unavailable before post-entropy initialization");
  if (amountIn >= (1n << 127n)) throw new Error("sat1 exact input does not fit positive int128");
  actor = actor.toLowerCase();
  const lastBlock = state.lastBuyBlocks[actor];
  if (lastBlock === undefined) throw new Error("sat1 missing actor cooldown state");
  uint(lastBlock);
  if (amountIn === 0n) return { amountOut: 0n, nextState: state };
  if (amountIn > (buy ? state.managerNativeBalance : state.managerTokenBalance)) {
    throw new Error("sat1 PoolManager temporary input capacity exceeded");
  }
  let amountOut: bigint, ethCum: bigint, actualSupply: bigint, nativeBalance: bigint;
  let deprecated = state.deprecated;
  let lastBuyBlocks = state.lastBuyBlocks;
  if (buy) {
    if (amountIn > 5n * SAT1_WAD) throw new Error("sat1 buy exceeds contract MAX_BUY");
    if (deprecated) throw new Error("sat1 self deprecated");
    const fee = mul(amountIn, 30n) / 10_000n;
    amountOut = sat1MintFor(state.ethCum, sub(amountIn, fee));
    ethCum = add(state.ethCum, amountIn); // Full input, including fee, compounds.
    actualSupply = add(state.actualSupply, amountOut);
    nativeBalance = add(state.nativeBalance, amountIn);
    lastBuyBlocks = Object.freeze({ ...state.lastBuyBlocks, [actor]: blockNumber });
    deprecated ||= mul(sat1TotalMinted(ethCum), 100n) >= SAT1_K * 99n;
  } else {
    if (lastBlock !== 0n && sub(blockNumber, lastBlock) < 1n) throw new Error("sat1 cooldown active");
    const fairSupply = sat1TotalMinted(state.ethCum);
    let fairIn = mul(amountIn, fairSupply) / state.actualSupply;
    if (fairIn > fairSupply) fairIn = fairSupply;
    const raw = sat1BurnFor(fairSupply, fairIn);
    amountOut = sub(raw, mul(raw, 30n) / 10_000n);
    if (amountOut > state.ethCum || amountOut > state.nativeBalance) throw new Error("sat1 insufficient ETH reserves");
    ethCum = sub(state.ethCum, amountOut); // Retained sell fee remains in the curve.
    actualSupply = sub(state.actualSupply, amountIn);
    nativeBalance = sub(state.nativeBalance, amountOut);
  }
  if (amountOut >= (1n << 127n)) throw new Error("sat1 exact output does not fit positive int128");
  return { amountOut, nextState: Object.freeze({ ...state, ethCum, actualSupply, nativeBalance, deprecated, lastBuyBlocks }) };
}
