import { ethers } from "ethers";
import {
  RuntimeAmountProgram,
  runtimeCallbackPayment,
} from "../../../../adapters/runtime-amount-program.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import {
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} from "../../../solver/v3-math.js";
import {
  KYSWAP_CALLBACK_DATA_OFFSET,
  KYSWAP_DELTA0_OFFSET,
  KYSWAP_DELTA1_OFFSET,
  KYSWAP_POOL_INTERFACE,
  KYSWAP_SWAP_DATA_OFFSET,
  KYSWAP_SWAP_QTY_OFFSET,
} from "./abi.js";
import {
  assertKyberSwapInvocation,
  isZeroAddress,
  lower,
  same,
} from "./codec.js";
import { KYSWAP_SWAP_ACTION } from "./manifest.js";
import type {
  KyberSwapDescriptor,
  KyberSwapExactEvidence,
  KyberSwapRoute,
} from "./types.js";

type RuntimeInput = Pick<
  Parameters<
    ExecutionSemantics<
      KyberSwapDescriptor,
      KyberSwapRoute,
      KyberSwapExactEvidence
    >["buildFragment"]
  >[0],
  | "descriptor"
  | "route"
  | "executor"
  | "transactionOrigin"
  | "runtimeEvidence"
>;

/**
 * Runtime-actual leg. `swap(recipient, swapQty, isToken0, limitSqrtP, data)` is
 * built with `swapQty` patched straight from register r0, which the enclosing
 * runtime flow primes with the previous hop's ACTUAL received amount, and with
 * the callback-payment script's declared amount patched from that same
 * register. No quote result, and no preset output amount, is an input.
 *
 * `isToken0` is the input-token flag only because this leg is always exact
 * input (`swapQty > 0`), which the leading register guard enforces: the top bit
 * of the working amount is proven clear, so a negative `swapQty` (exact output,
 * where the same flag denotes an output token) can never be emitted. The pool
 * pulls the input token from this contract through `swapCallback`, so no
 * approval is required — `runtimeCallbackPayment` pays the debt word the pool
 * itself declares (`deltaQty0` when token0 is in, `deltaQty1` otherwise).
 */
function buildKyberSwapRuntimeLeg(input: RuntimeInput) {
  const { descriptor: d, route: r } = input;
  assertKyberSwapInvocation(d, r);
  const recipient = ethers.getAddress(input.executor);
  if (
    [d.pool, r.tokenIn, r.tokenOut, recipient].some(isZeroAddress) ||
    same(r.tokenIn, r.tokenOut) ||
    same(d.pool, recipient)
  ) {
    throw new Error("kyberswap elastic runtime invalid execution addresses");
  }
  const isToken0 = r.isToken0;
  const payment = runtimeCallbackPayment(
    r.tokenIn,
    d.pool,
    isToken0 ? KYSWAP_DELTA0_OFFSET : KYSWAP_DELTA1_OFFSET,
  );
  const program = new RuntimeAmountProgram()
    // `isExactInput = swapQty > 0`: a high bit must never select exact output.
    .constant(1, 255n)
    .math("shr", 2, 0, 1)
    .constant(3, 0n)
    .equal(2, 3)
    .call(
      d.pool,
      KYSWAP_POOL_INTERFACE.encodeFunctionData("swap", [
        recipient,
        0n,
        isToken0,
        isToken0 ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n,
        payment.script,
      ]),
      {
        patches: [
          { offset: KYSWAP_SWAP_QTY_OFFSET, reg: 0 },
          { offset: KYSWAP_SWAP_DATA_OFFSET + payment.limitOffset, reg: 0 },
        ],
        callback: {
          incomingOffset: KYSWAP_CALLBACK_DATA_OFFSET,
          outgoingOffset: KYSWAP_SWAP_DATA_OFFSET,
        },
      },
    );
  return {
    actionAdapterId: KYSWAP_SWAP_ACTION,
    program: ethers.hexlify(program.bytes()),
  };
}

export const kyberswapElasticExecution = {
  buildRuntimeLeg: buildKyberSwapRuntimeLeg,
  runtimeProjection: () => Object.freeze({
    // The pool pulls the input token inside its own callback, so no standing
    // allowance is needed for this leg.
    allowanceSpender: null,
    prewarmQuoteCalls: Object.freeze([]),
  }),
  buildFragment(input) {
    assertExecutionEvidence(input);
    const leg = buildKyberSwapRuntimeLeg(input);
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: KYSWAP_SWAP_ACTION,
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: { runtimeAmountProgram: leg.program },
        children: [],
      })]),
    });
  },
  expectedEffects: ({ route }: { readonly route: KyberSwapRoute }) => [
    {
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
      direction: "decrease" as const,
    },
    {
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "route-target" as const,
      direction: "increase" as const,
    },
    {
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "route-target" as const,
      direction: "decrease" as const,
    },
    {
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    },
  ],
} satisfies ExecutionSemantics<
  KyberSwapDescriptor,
  KyberSwapRoute,
  KyberSwapExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: KyberSwapDescriptor;
  readonly route: KyberSwapRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly minAmountOut?: bigint;
  readonly exactEvidence: KyberSwapExactEvidence;
  readonly executor: string;
}): void {
  assertKyberSwapInvocation(input.descriptor, input.route);
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "kyberswap-elastic-single-range" ||
    evidence.refusal !== null ||
    !same(evidence.pool, input.descriptor.pool) ||
    !same(evidence.tokenIn, input.route.tokenIn) ||
    !same(evidence.tokenOut, input.route.tokenOut) ||
    evidence.direction !== input.route.direction ||
    evidence.isToken0 !== input.route.isToken0 ||
    evidence.feeUnits !== input.descriptor.feeUnits ||
    evidence.amountIn !== input.amountIn ||
    input.amountIn <= 0n ||
    input.quotedAmountOut <= 0n ||
    evidence.amountOut !== input.quotedAmountOut ||
    evidence.bindingFingerprint !== input.route.bindingRef.fingerprint ||
    lower(evidence.pool) !== lower(input.route.pool) ||
    (input.minAmountOut !== undefined &&
      (input.minAmountOut <= 0n ||
        input.minAmountOut > input.quotedAmountOut))
  ) {
    throw new Error(
      "KyberSwap Elastic execution received incompatible exact evidence",
    );
  }
}
