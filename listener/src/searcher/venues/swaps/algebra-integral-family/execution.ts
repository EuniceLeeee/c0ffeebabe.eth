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
const ERC20_BALANCE_INTERFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

export function buildAlgebraIntegralRuntimeLeg(
  input: RuntimeInput,
): RuntimeAmountLeg {
  // Output measurement/next-hop sizing remains owned by the central runtime
  // flow. This entry must never read an off-chain amount or Exact evidence.
  return buildAlgebraIntegralLeg(input);
}

function buildAlgebraIntegralLeg(
  input: RuntimeInput,
  minAmountOut?: bigint,
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
  const balance = ERC20_BALANCE_INTERFACE.encodeFunctionData("balanceOf", [executor]);
  const program = new RuntimeAmountProgram()
    // amountRequired is signed. A high bit must never turn exact-input into
    // exact-output: the pool reads a negative amount as an output request.
    .constant(1, 255n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3)
    .call(r.tokenIn, balance, { static: true }).load(4, 0);
  if (minAmountOut !== undefined) {
    program.call(r.tokenOut, balance, { static: true }).load(5, 0);
  }
  program.call(
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
        callback: { incomingOffset: CALLBACK_FIELD2_OFFSET, outgoingOffset: OUTGOING_OFFSET },
      },
    )
    // A pool may legally stop at its price limit, but this execution contract
    // requires full exact-input consumption. Check both the returned input
    // delta and the actual executor debit; a fabricated return is not payment.
    .load(1, zeroForOne ? 0 : 32).equal(1, 0)
    .call(r.tokenIn, balance, { static: true }).load(1, 0)
    .math("sub", 2, 4, 1).equal(2, 0);
  if (minAmountOut !== undefined) {
    // Checked subtraction enforces the quoted minimum against NEW receipts.
    // Neither a nominal returned output nor pre-existing inventory can pay it.
    program.call(r.tokenOut, balance, { static: true }).load(1, 0)
      .math("sub", 2, 1, 5).constant(3, minAmountOut).math("sub", 2, 2, 3);
  }
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
    const leg = buildAlgebraIntegralLeg(input, input.minAmountOut);
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
 * Both paths share full-input settlement; the quoted path additionally carries
 * its minimum receipt. The central issued-Exact boundary binds source/caller.
 * Fee and pluginConfig in Ready describe admission-time state, not the current
 * quote: comparing them here rejects a valid later static-fee update. Current
 * quote semantics stay in Exact; execution enforces actual debit/receipt in EVM.
 */
function assertExecutionEvidence(input: {
  readonly descriptor: AlgebraIntegralDescriptor;
  readonly route: AlgebraIntegralRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly minAmountOut: bigint;
  readonly exactEvidence: AlgebraIntegralExactEvidence;
  readonly executor: string;
  readonly transactionOrigin?: string;
}): void {
  const evidence = input.exactEvidence;
  if (
    input.amountIn <= 0n ||
    input.amountIn >= (1n << 255n) ||
    input.minAmountOut < 0n ||
    input.minAmountOut > input.quotedAmountOut ||
    input.minAmountOut > ethers.MaxUint256 ||
    evidence.declinedReason !== null ||
    !sameAddress(evidence.pool, input.descriptor.pool) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.tickSpacing !== input.descriptor.tickSpacing ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut ||
    evidence.amountOut <= 0n
  ) {
    throw new Error("algebra-integral execution received incompatible exact evidence");
  }
  const fee = input.descriptor.executedFee;
  if (evidence.kind === "algebra-integral-single-range" && fee.kind === "global-state-last-fee") {
    return;
  }
  if (
    evidence.kind === "algebra-integral-bound-quoter" &&
    fee.kind === "cypher-bound-quoter" &&
    evidence.binding === input.route.bindingRef.fingerprint &&
    evidence.routeKey === input.route.routeKey &&
    sameAddress(evidence.executor, input.executor) &&
    input.transactionOrigin !== undefined &&
    sameAddress(evidence.transactionOrigin, input.transactionOrigin) &&
    sameAddress(evidence.quoter, fee.quoterBinding.quoter) &&
    sameAddress(evidence.plugin, fee.plugin)
  ) {
    // reportedLastFee is a diagnostic globalState value, not the executed
    // dynamic fee. Callback-revert quoting does not prove payment, full input
    // consumption or afterSwap success; the shared EVM guards and final sim do.
    return;
  }
  throw new Error("algebra-integral execution received incompatible exact evidence");
}
