import {
  DODO_DECIMAL_ONE,
  DODO_UINT256_MAX,
  type DodoPmmState,
  quoteDodoPmmExactInput,
} from "../venues/swaps/dodo-pmm-math.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function quote(input: {
  readonly state: DodoPmmState;
  readonly sellBase: boolean;
  readonly payAmount: bigint;
  readonly lpFeeRate?: bigint;
  readonly mtFeeRate?: bigint;
}) {
  return quoteDodoPmmExactInput({
    ...input,
    lpFeeRate: input.lpFeeRate ?? 0n,
    mtFeeRate: input.mtFeeRate ?? 0n,
  });
}

function amount(input: Parameters<typeof quote>[0]): bigint {
  const result = quote(input);
  assert(
    result.status === "quote",
    `unexpected ambiguity ${
      result.status === "needs-onchain-quote" ? result.reason : "unknown"
    }`,
  );
  return result.amountOut;
}

const rOneK0: DodoPmmState = Object.freeze({
  i: 2n * DODO_DECIMAL_ONE,
  K: 0n,
  B: 1_000n,
  Q: 1_000n,
  B0: 1_000n,
  Q0: 1_000n,
  R: 0,
});
assert(
  amount({ state: rOneK0, sellBase: true, payAmount: 100n }) === 200n,
  "R=ONE K=0 sell-base linear quote",
);
assert(
  amount({ state: rOneK0, sellBase: false, payAmount: 100n }) === 50n,
  "R=ONE K=0 sell-quote reciprocal quote",
);

const rAboveK0: DodoPmmState = Object.freeze({
  i: 2n * DODO_DECIMAL_ONE,
  K: 0n,
  B: 900n,
  Q: 1_200n,
  B0: 1_000n,
  Q0: 1_000n,
  R: 1,
});
assert(
  amount({ state: rAboveK0, sellBase: true, payAmount: 50n }) === 100n,
  "R=ABOVE_ONE sell-base before crossing",
);
assert(
  amount({ state: rAboveK0, sellBase: true, payAmount: 100n }) === 200n,
  "R=ABOVE_ONE sell-base exact crossing",
);
assert(
  amount({ state: rAboveK0, sellBase: true, payAmount: 150n }) === 300n,
  "R=ABOVE_ONE sell-base after crossing",
);
assert(
  amount({ state: rAboveK0, sellBase: false, payAmount: 100n }) === 50n,
  "R=ABOVE_ONE sell-quote direction",
);

const rBelowK0: DodoPmmState = Object.freeze({
  i: 2n * DODO_DECIMAL_ONE,
  K: 0n,
  B: 1_100n,
  Q: 900n,
  B0: 1_000n,
  Q0: 1_000n,
  R: 2,
});
assert(
  amount({ state: rBelowK0, sellBase: true, payAmount: 100n }) === 200n,
  "R=BELOW_ONE sell-base direction",
);
assert(
  amount({ state: rBelowK0, sellBase: false, payAmount: 50n }) === 25n,
  "R=BELOW_ONE sell-quote before crossing",
);
assert(
  amount({ state: rBelowK0, sellBase: false, payAmount: 100n }) === 100n,
  "R=BELOW_ONE sell-quote exact crossing",
);
assert(
  amount({ state: rBelowK0, sellBase: false, payAmount: 150n }) === 125n,
  "R=BELOW_ONE sell-quote after crossing",
);

const intermediateK: DodoPmmState = Object.freeze({
  i: DODO_DECIMAL_ONE,
  K: DODO_DECIMAL_ONE / 2n,
  B: 1_000n,
  Q: 1_000n,
  B0: 1_000n,
  Q0: 1_000n,
  R: 0,
});
assert(
  amount({ state: intermediateK, sellBase: true, payAmount: 100n }) === 96n,
  "intermediate-K quadratic rounding",
);

const kOne: DodoPmmState = Object.freeze({
  i: DODO_DECIMAL_ONE,
  K: DODO_DECIMAL_ONE,
  B: 1_000n,
  Q: 1_000n,
  B0: 1_000n,
  Q0: 1_000n,
  R: 0,
});
assert(
  amount({ state: kOne, sellBase: true, payAmount: 100n }) === 90n,
  "K=ONE quadratic rounding",
);

const feeQuote = quote({
  state: intermediateK,
  sellBase: true,
  payAmount: 100n,
  lpFeeRate: DODO_DECIMAL_ONE / 10n,
  mtFeeRate: 3n * DODO_DECIMAL_ONE / 100n,
});
assert(feeQuote.status === "quote", "fee quote is locally determined");
assert(
  feeQuote.status === "quote" &&
    feeQuote.grossAmountOut === 96n &&
    feeQuote.lpFee === 9n &&
    feeQuote.mtFee === 2n &&
    feeQuote.amountOut === 85n,
  "LP and MT fees floor independently",
);

const numeratorZero = quote({
  state: {
    i: DODO_DECIMAL_ONE,
    K: 1n,
    B: 1n,
    Q: 1n,
    B0: 1n,
    Q0: 1n,
    R: 0,
  },
  sellBase: true,
  payAmount: 2n,
});
assert(
  numeratorZero.status === "needs-onchain-quote" &&
    numeratorZero.reason === "legacy-numerator-zero",
  "legacy numerator-zero delegates to the deployed pool",
);

const overflowVariant = quote({
  state: {
    i: DODO_UINT256_MAX,
    K: DODO_DECIMAL_ONE,
    B: 2n,
    Q: 2n,
    B0: 2n,
    Q0: 2n,
    R: 0,
  },
  sellBase: true,
  payAmount: 1n,
});
assert(
  overflowVariant.status === "needs-onchain-quote" &&
    overflowVariant.reason === "solidity-overflow-semantics",
  "K=ONE overflow behavior delegates to the deployed pool",
);

let overflowRejected = false;
try {
  quote({
    state: {
      ...rOneK0,
      i: DODO_UINT256_MAX,
    },
    sellBase: true,
    payAmount: 2n,
  });
} catch (error) {
  overflowRejected = /uint256 overflow/.test(String(error));
}
assert(overflowRejected, "ordinary uint256 overflow is rejected");

console.log(
  "dodo-pmm-math PASS (R states + both directions + crossing + K0/K1/intermediate + fees + ambiguity)",
);
