/**
 * V3 swap-math unit test — official Uniswap v3-core SwapMath.spec.ts vectors
 * (via degenbot's swapmath_test.py). Pure local, no RPC. Proves our bigint
 * computeSwapStep + SqrtPriceMath are bit-exact before we drive them with a
 * cross-tick loop on real pool state.
 */

import {
  computeSwapStep,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
} from "../solver/v3-math.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

/** Integer sqrt (floor) for encodePriceSqrt. */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** sqrt(reserve1/reserve0) as a Q64.96 value (ROUND_FLOOR). */
function encodePriceSqrt(reserve1: bigint, reserve0: bigint): bigint {
  return isqrt((reserve1 << 192n) / reserve0);
}

const E18 = 10n ** 18n;
let pass = 0;
let total = 0;

function step(
  label: string,
  args: [bigint, bigint, bigint, bigint, bigint],
  expect: { amountIn: bigint; amountOut: bigint; feeAmount: bigint; sqrtNext?: bigint },
): void {
  total++;
  const r = computeSwapStep(...args);
  const ok =
    r.amountIn === expect.amountIn &&
    r.amountOut === expect.amountOut &&
    r.feeAmount === expect.feeAmount &&
    (expect.sqrtNext === undefined || r.sqrtRatioNextX96 === expect.sqrtNext);
  if (ok) pass++;
  console.log(
    `[v3math] ${ok ? "PASS" : "FAIL"} ${label}` +
      (ok
        ? ""
        : `\n   got in=${r.amountIn} out=${r.amountOut} fee=${r.feeAmount} sqrtNext=${r.sqrtRatioNextX96}` +
          `\n   exp in=${expect.amountIn} out=${expect.amountOut} fee=${expect.feeAmount} sqrtNext=${expect.sqrtNext}`),
  );
}

function main(): void {
  // 1: exact-in capped at price target (one-for-zero)
  const price = encodePriceSqrt(1n, 1n);
  step("exactIn capped at target", [price, encodePriceSqrt(101n, 100n), 2n * E18, E18, 600n], {
    amountIn: 9975124224178055n,
    feeAmount: 5988667735148n,
    amountOut: 9925619580021728n,
    sqrtNext: encodePriceSqrt(101n, 100n),
  });

  // 2: exact-out capped at price target
  step("exactOut capped at target", [price, encodePriceSqrt(101n, 100n), 2n * E18, -E18, 600n], {
    amountIn: 9975124224178055n,
    feeAmount: 5988667735148n,
    amountOut: 9925619580021728n,
    sqrtNext: encodePriceSqrt(101n, 100n),
  });

  // 3: exact-in fully spent (price moves short of target)
  step("exactIn fully spent", [price, encodePriceSqrt(1000n, 100n), 2n * E18, E18, 600n], {
    amountIn: 999400000000000000n,
    feeAmount: 600000000000000n,
    amountOut: 666399946655997866n,
  });

  // 4: exact-out fully received
  step("exactOut fully received", [price, encodePriceSqrt(10000n, 100n), 2n * E18, -E18, 600n], {
    amountIn: 2000000000000000000n,
    feeAmount: 1200720432259356n,
    amountOut: E18,
  });

  // 5: amount out capped at desired (bare values)
  step(
    "amountOut capped at desired",
    [417332158212080721273783715441582n, 1452870262520218020823638996n, 159344665391607089467575320103n, -1n, 1n],
    { amountIn: 1n, amountOut: 1n, feeAmount: 1n, sqrtNext: 417332158212080721273783715441581n },
  );

  // 6: target price of 1 uses partial input
  step("partial input to target=1", [2n, 1n, 1n, 3915081100057732413702495386755767n, 1n], {
    amountIn: 39614081257132168796771975168n,
    feeAmount: 39614120871253040049813n,
    amountOut: 0n,
    sqrtNext: 1n,
  });

  // 7: entire input taken as fee
  step("entire input as fee", [2413n, 79887613182836312n, 1985041575832132834610021537970n, 10n, 1872n], {
    amountIn: 0n,
    feeAmount: 10n,
    amountOut: 0n,
    sqrtNext: 2413n,
  });

  // 8: intermediate insufficient liquidity, zero-for-one exact output
  const sqrtP8 = 20282409603651670423947251286016n;
  step("insufficient liq z4o exactOut", [sqrtP8, (sqrtP8 * 11n) / 10n, 1024n, -4n, 3000n], {
    amountIn: 26215n,
    feeAmount: 79n,
    amountOut: 0n,
    sqrtNext: (sqrtP8 * 11n) / 10n,
  });

  // 9: intermediate insufficient liquidity, one-for-zero exact output
  step("insufficient liq o4z exactOut", [sqrtP8, (sqrtP8 * 9n) / 10n, 1024n, -263000n, 3000n], {
    amountIn: 1n,
    feeAmount: 1n,
    amountOut: 26214n,
    sqrtNext: (sqrtP8 * 9n) / 10n,
  });

  // sanity on the standalone next-price helpers
  total++;
  const pIn = getNextSqrtPriceFromInput(price, 2n * E18, E18, false);
  const pOut = getNextSqrtPriceFromOutput(price, 2n * E18, E18, false);
  if (pIn > price && pOut > pIn) {
    pass++;
    console.log("[v3math] PASS next-price helpers monotonic");
  } else {
    console.log(`[v3math] FAIL next-price helpers: price=${price} pIn=${pIn} pOut=${pOut}`);
  }

  console.log(`[v3math] ${pass}/${total} vectors passed`);
  if (pass !== total) throw new Error("v3 swap-math mismatch");
  console.log("v3-math PASS (computeSwapStep + SqrtPriceMath)");
}

main();
