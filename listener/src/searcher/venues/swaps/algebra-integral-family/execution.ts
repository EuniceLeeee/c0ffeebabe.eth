import { ethers } from "ethers";
import {
  RuntimeAmountProgram,
  runtimeCallbackPayment,
  type RuntimeAmountLeg,
} from "../../../../adapters/runtime-amount-program.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import {
  ALGEBRA_INTEGRAL_ADAPTER_ID,
  ALGEBRA_MAX_SQRT_RATIO,
  ALGEBRA_MIN_SQRT_RATIO,
  ALGEBRA_POOL_INTERFACE,
} from "./abi.js";
import { sameAddress } from "./codec.js";
import { algebraIntegralRoutes } from "./routes.js";
import type {
  AlgebraIntegralDescriptor,
  AlgebraIntegralExactEvidence,
  AlgebraIntegralRoute,
} from "./types.js";

type RuntimeInput = Pick<
  Parameters<
    ExecutionSemantics<
      AlgebraIntegralDescriptor,
      AlgebraIntegralRoute,
      AlgebraIntegralExactEvidence
    >["buildFragment"]
  >[0],
  "descriptor" | "route" | "executor" | "transactionOrigin" | "runtimeEvidence"
>;

/**
 * Algebra's `swap(address recipient, bool zeroToOne, int256 amountRequired,
 * uint160 limitSqrtPrice, bytes data)` has the UniV3 head layout, so the
 * amount-sensitive words sit at the same offsets: recipient at 4, zeroToOne at
 * 36, amountRequired at 68, limitSqrtPrice at 100 and the callback bytes at 132.
 * The pool calls `algebraSwapCallback(int256,int256,bytes)` on this executor;
 * the runtime kernel authenticates any callback by the installed script hash, so
 * the debt words are the same offsets (amount0Delta at 4, amount1Delta at 36).
 */
const AMOUNT_REQUIRED_OFFSET = 68;
const CALLBACK_FIELD2_OFFSET = 132;
const OUTGOING_OFFSET = 4 + 5 * 32 + 32; // swap's dynamic bytes content

export function buildAlgebraIntegralRuntimeLeg(
  input: RuntimeInput,
): RuntimeAmountLeg {
  const { descriptor: d, route: r } = input;
  const expected = algebraIntegralRoutes.project({ descriptor: d })
    .find((route) => route.direction === r.direction);
  if (
    expected === undefined ||
    r.familyId !== expected.familyId ||
    r.lineageId !== expected.lineageId ||
    r.instanceKey !== expected.instanceKey ||
    r.routeKey !== expected.routeKey ||
    r.bindingRef.bindingKey !== expected.bindingRef.bindingKey ||
    r.bindingRef.fingerprint !== expected.bindingRef.fingerprint ||
    !sameAddress(r.pool, expected.pool) ||
    !sameAddress(r.tokenIn, expected.tokenIn) ||
    !sameAddress(r.tokenOut, expected.tokenOut) ||
    r.tickSpacing !== expected.tickSpacing ||
    r.taxonomy.slotKind !== "swap" ||
    r.taxonomy.protocolAction !== undefined
  ) {
    throw new Error("algebra-integral runtime route binding mismatch");
  }
  const executor = ethers.getAddress(input.executor);
  if (
    [d.pool, r.tokenIn, r.tokenOut, executor].some((address) =>
      sameAddress(address, ethers.ZeroAddress)
    ) ||
    sameAddress(r.tokenIn, r.tokenOut) ||
    sameAddress(d.pool, executor)
  ) {
    throw new Error("algebra-integral runtime invalid execution addresses");
  }

  const zeroForOne = r.direction === "zero-for-one";
  const payment = runtimeCallbackPayment(r.tokenIn, d.pool, zeroForOne ? 4 : 36);
  const program = new RuntimeAmountProgram()
    // amountRequired is signed. A high bit must never turn exact-input into
    // exact-output: the pool reads a negative amount as an output request.
    .constant(1, 255n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3)
    .call(
      d.pool,
      ALGEBRA_POOL_INTERFACE.encodeFunctionData("swap", [
        executor,
        zeroForOne,
        0n,
        zeroForOne
          ? ALGEBRA_MIN_SQRT_RATIO + 1n
          : ALGEBRA_MAX_SQRT_RATIO - 1n,
        payment.script,
      ]),
      {
        // r0 is the current leg's working amount: it is patched into the
        // amountRequired word and into the callback script's debt cap.
        patches: [
          { offset: AMOUNT_REQUIRED_OFFSET, reg: 0 },
          { offset: OUTGOING_OFFSET + payment.limitOffset, reg: 0 },
        ],
        callback: { incomingOffset: 132, outgoingOffset: OUTGOING_OFFSET },
      },
    )
    // The pool returns (amount0, amount1). The signed input delta is the word
    // the swap direction consumes: partial fills are legal, but the input the
    // pool took must stay within this leg's amount (an underflow fails closed).
    .load(1, zeroForOne ? 0 : 32)
    .math("sub", 2, 0, 1);
  return { actionAdapterId: ALGEBRA_INTEGRAL_ADAPTER_ID, program: ethers.hexlify(program.bytes()) };
}

export const algebraIntegralExecution = {
  buildRuntimeLeg: buildAlgebraIntegralRuntimeLeg,
  runtimeProjection: () => Object.freeze({
    // The callback pays the pool by direct ERC20 transfer from the executor, so
    // no standing allowance is required for this family's leg.
    allowanceSpender: null,
    prewarmQuoteCalls: Object.freeze([]),
  }),
  buildFragment(input) {
    assertExecutionEvidence(input);
    const leg = buildAlgebraIntegralRuntimeLeg(input);
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: ALGEBRA_INTEGRAL_ADAPTER_ID,
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: { runtimeAmountProgram: leg.program },
        children: [],
      })]),
    });
  },
  expectedEffects: ({ route }) => [
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
  AlgebraIntegralDescriptor,
  AlgebraIntegralRoute,
  AlgebraIntegralExactEvidence
>;

/**
 * The quoted fragment and the runtime leg are the same program, so the evidence
 * must describe exactly this pool, direction, amount and executed fee. Any
 * disagreement is a programming error, never a fallback to quoted amounts.
 */
function assertExecutionEvidence(input: {
  readonly descriptor: AlgebraIntegralDescriptor;
  readonly route: AlgebraIntegralRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: AlgebraIntegralExactEvidence;
  readonly executor: string;
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "algebra-integral-single-range" ||
    evidence.declinedReason !== null ||
    !sameAddress(evidence.pool, input.descriptor.pool) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.tickSpacing !== input.descriptor.tickSpacing ||
    evidence.executedFee !== input.descriptor.executedFee.fee ||
    evidence.pluginConfig !== input.descriptor.executedFee.pluginConfig ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut ||
    evidence.amountOut <= 0n
  ) {
    throw new Error("algebra-integral execution received incompatible exact evidence");
  }
}
