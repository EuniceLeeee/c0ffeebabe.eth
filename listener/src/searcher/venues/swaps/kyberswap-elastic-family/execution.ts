import { kyberDirectOpening, kyberDirectClosing } from "./direct.js";
import { ethers } from "ethers";
import {
  RuntimeAmountProgram,
  runtimeCallbackPayment, runtimeDeferredPayment, runtimeDeferredOpeningFloor, type RuntimeSettlementRequest,
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
> & { settlement?: RuntimeSettlementRequest };

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
  const request=input.settlement;if(request?.kind==="quote-output")return null;
  const executor=ethers.getAddress(input.executor);
  const recipient = request?.kind==="direct-output"?ethers.getAddress(request.recipient):executor;
  if (
    [d.pool, r.tokenIn, r.tokenOut, executor, recipient].some(isZeroAddress) ||
    same(r.tokenIn, r.tokenOut) ||
    same(d.pool, recipient) || same(d.pool, executor)
  ) {
    throw new Error("kyberswap elastic runtime invalid execution addresses");
  }
  const isToken0 = r.isToken0;
  const deferred = request?.kind === "deferred-input"
    ? runtimeDeferredPayment({ tokenOut: r.tokenOut, executor,
      debtOffset: isToken0 ? KYSWAP_DELTA0_OFFSET : KYSWAP_DELTA1_OFFSET, ...request })
    : null;
  const payment = deferred ?? runtimeCallbackPayment(
    r.tokenIn,
    d.pool,
    isToken0 ? KYSWAP_DELTA0_OFFSET : KYSWAP_DELTA1_OFFSET,
  );
  const program = new RuntimeAmountProgram();
  if(request?.kind==="direct-output"){
    if(same(recipient,r.tokenIn)||same(recipient,r.tokenOut))throw new Error("kyber direct recipient aliases token");
    kyberDirectOpening(program,r,executor,recipient);
  }
  if(request?.kind==="deferred-input")runtimeDeferredOpeningFloor(program,r.tokenOut,executor,request.paymentAmount);
  program
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
          ...(deferred ?[{offset:KYSWAP_SWAP_DATA_OFFSET+deferred.floorOffset,reg:13}]:[]),
        ],
        callback: {
          incomingOffset: KYSWAP_CALLBACK_DATA_OFFSET,
          outgoingOffset: KYSWAP_SWAP_DATA_OFFSET,
        },
      },
    );
  if(request?.kind==="direct-output")kyberDirectClosing(program,r,executor,recipient);
  if(request?.kind==="deferred-input")program.load(1,isToken0?0:32).equal(1,0);
  return {
    settlement:{directOutput:true as const,deferredInput:d.pool},...(request?{settlementRequest:request}:{}),
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
    if(!leg)throw Error("quoted Kyber runtime leg unavailable");
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
    evidence.kind !== "kyberswap-elastic-exact-input" ||
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
