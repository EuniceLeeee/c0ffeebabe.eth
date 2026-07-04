/**
 * BS-0 pure-local replay harness.
 *
 * Fixture provenance: v4/v2 receipt-derived from committed
 * analysis/src/test/fixtures/coffee-20260704/tx-3.json; curve leg
 * state captured from local reth at block 25455296.
 *
 * Rule-12 quartet:
 * - failing_sample: coffee tx #3 0xf2de7499 block 25455297
 * - baseline_failure: no BS-0 gate existed
 * - expected_transition: curve leg receipt-anchored -> state-verified (curveNgGetDy bit-exact both rates) + boundary -EV finding
 * - regression_gate: this deterministic replay must pass with the recorded expectedGrossWei
 */

import { readFileSync } from "node:fs";
import { curveNgGetDy, type CurveNgState } from "../solver/curve-math.js";
import { computeSwapStep } from "../solver/v3-math.js";

interface CurveNgReplayPreState {
  variant: "stableswap-ng";
  A: string;
  fee: string;
  offpegFeeMultiplier: string;
  balances: string[];
  ratesAtSourceBoundary: string[];
  ratesAtExecution: string[];
  rateNote: string;
}

interface ReplayFixture {
  flash: {
    amount: string;
  };
  legs: [
    {
      seq: 1;
      kind: "univ4";
      zeroForOne: boolean;
      preState: { sqrtPriceX96: string; liquidity: string };
      postStateFromEvent: { sqrtPriceX96: string };
      realized: { amountIn: string; amountOut: string };
    },
    {
      seq: 2;
      kind: "univ4";
      zeroForOne: boolean;
      preState: { sqrtPriceX96: string; liquidity: string };
      postStateFromEvent: { sqrtPriceX96: string };
      realized: { amountIn: string; amountOut: string };
    },
    {
      seq: 3;
      kind: "curve";
      receiptAnchored: false;
      preState: CurveNgReplayPreState;
      realized: { amountIn: string; amountOut: string };
    },
    {
      seq: 4;
      kind: "univ2";
      preReserves: { r0: string; r1: string };
      realized: { amountIn: string; amountOut: string };
    },
  ];
  boundarySurplusUnits: string;
  expectedGrossWei: string;
}

let checks = 0;
let passed = 0;

function check(label: string, cond: boolean): void {
  checks += 1;
  if (cond) {
    passed += 1;
    console.log(`[blockscan-a0] ${label}: PASS`);
    return;
  }
  console.error(`[blockscan-a0] ${label}: FAIL`);
  process.exit(1);
}

function bi(value: string, label: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`invalid bigint field: ${label}`);
  }
}

function curveNgState(
  preState: CurveNgReplayPreState,
  rates: string[],
  rateLabel: string,
): CurveNgState {
  return {
    A: bi(preState.A, "leg3.preState.A"),
    fee: bi(preState.fee, "leg3.preState.fee"),
    offpegFeeMultiplier: bi(preState.offpegFeeMultiplier, "leg3.preState.offpegFeeMultiplier"),
    balances: preState.balances.map((value, index) => bi(value, `leg3.preState.balances[${index}]`)),
    rates: rates.map((value, index) => bi(value, `${rateLabel}[${index}]`)),
  };
}

function main(): void {
  const fixtureUrl = new URL("./fixtures/blockscan-coffee-f2de7499.json", import.meta.url);
  const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as ReplayFixture;
  const [leg1, leg2, leg3, leg4] = fixture.legs;
  const flashAmount = bi(fixture.flash.amount, "fixture.flash.amount");

  check("fixture leg 1 is univ4 USDC->USDT zeroForOne", leg1.seq === 1 && leg1.kind === "univ4" && leg1.zeroForOne);
  const step1 = computeSwapStep(
    bi(leg1.preState.sqrtPriceX96, "leg1.preState.sqrtPriceX96"),
    4295128740n,
    bi(leg1.preState.liquidity, "leg1.preState.liquidity"),
    bi(leg1.realized.amountIn, "leg1.realized.amountIn"),
    7n,
  );
  check("leg 1 input fully consumed within tick", step1.amountIn + step1.feeAmount === 1807735808n);
  check("leg 1 amountOut bit-exact", step1.amountOut === 1809208404n);
  check(
    "leg 1 sqrtRatioNextX96 bit-exact",
    step1.sqrtRatioNextX96 === bi(leg1.postStateFromEvent.sqrtPriceX96, "leg1.postStateFromEvent.sqrtPriceX96"),
  );

  check(
    "fixture leg 2 is univ4 USDT->D166 oneForZero",
    leg2.seq === 2 && leg2.kind === "univ4" && !leg2.zeroForOne,
  );
  const step2 = computeSwapStep(
    bi(leg2.preState.sqrtPriceX96, "leg2.preState.sqrtPriceX96"),
    1461446703485210103287273052203988822378723970341n,
    bi(leg2.preState.liquidity, "leg2.preState.liquidity"),
    bi(leg2.realized.amountIn, "leg2.realized.amountIn"),
    5000n,
  );
  check("leg 2 input fully consumed within tick", step2.amountIn + step2.feeAmount === 1809208405n);
  check("leg 2 amountOut bit-exact", step2.amountOut === 2040627466925953875895n);
  check(
    "leg 2 sqrtRatioNextX96 bit-exact",
    step2.sqrtRatioNextX96 === bi(leg2.postStateFromEvent.sqrtPriceX96, "leg2.postStateFromEvent.sqrtPriceX96"),
  );

  check(
    "leg 3 is state-verified curve ng leg",
    leg3.seq === 3 &&
      leg3.kind === "curve" &&
      !leg3.receiptAnchored &&
      leg3.preState?.variant === "stableswap-ng" &&
      leg3.preState.balances.length === 2 &&
      leg3.preState.ratesAtSourceBoundary.length === 2 &&
      leg3.preState.ratesAtExecution.length === 2,
  );
  const curveIn = bi(leg3.realized.amountIn, "leg3.realized.amountIn");
  const curveOut = bi(leg3.realized.amountOut, "leg3.realized.amountOut");
  check("leg 3 pinned amountIn bit-exact", curveIn === 2040627466925953875895n);
  check("leg 3 pinned amountOut bit-exact", curveOut === 1808005999n);
  check("leg 2 -> leg 3 continuity", curveIn === step2.amountOut);

  const stateWithBoundaryRates = curveNgState(
    leg3.preState,
    leg3.preState.ratesAtSourceBoundary,
    "leg3.preState.ratesAtSourceBoundary",
  );
  const curveOutAtBoundary = curveNgGetDy(stateWithBoundaryRates, 1, 0, curveIn);
  check("leg 3 boundary-rate curveNgGetDy matches on-chain get_dy", curveOutAtBoundary === 1807346489n);
  const boundarySurplus = curveOutAtBoundary - flashAmount;
  check("boundary-rate loop surplus is exact and negative", boundarySurplus === -389319n && boundarySurplus < 0n);
  check("recorded boundary surplus matches replay", boundarySurplus === bi(fixture.boundarySurplusUnits, "boundarySurplusUnits"));

  const stateWithExecutionRates = curveNgState(
    leg3.preState,
    leg3.preState.ratesAtExecution,
    "leg3.preState.ratesAtExecution",
  );
  const curveOutAtExecution = curveNgGetDy(stateWithExecutionRates, 1, 0, curveIn);
  check("leg 3 execution-rate curveNgGetDy matches realized amountOut", curveOutAtExecution === 1808005999n && curveOutAtExecution === curveOut);

  check("fixture leg 4 is univ2 profit conversion", leg4.seq === 4 && leg4.kind === "univ2");
  const inWF = bi(leg4.realized.amountIn, "leg4.realized.amountIn") * 997n;
  const r0 = bi(leg4.preReserves.r0, "leg4.preReserves.r0");
  const r1 = bi(leg4.preReserves.r1, "leg4.preReserves.r1");
  const v2Out = (inWF * r1) / (r0 * 1000n + inWF);
  check("leg 4 canonical univ2 getAmountOut bit-exact", v2Out === 157203701650240n);

  const surplus = curveOutAtExecution - flashAmount;
  check("closed-loop surplus is exact and positive", surplus === 270191n && surplus > 0n);
  check(
    "v2 spends surplus minus one USDC unit dust",
    surplus - bi(leg4.realized.amountIn, "leg4.realized.amountIn") === 1n,
  );
  check(
    "leg 1 -> leg 2 continuity uses one USDT unit executor dust top-up",
    bi(leg2.realized.amountIn, "leg2.realized.amountIn") - step1.amountOut === 1n,
  );

  const expectedGrossWei = v2Out;
  check("expectedGrossWei is positive", expectedGrossWei > 0n);
  check("expectedGrossWei matches recorded fixture value", expectedGrossWei === bi(fixture.expectedGrossWei, "expectedGrossWei"));

  console.log(`blockscan-a0 PASS (${passed}/${checks})`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
