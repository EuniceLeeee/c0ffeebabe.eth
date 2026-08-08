import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { ResolvedPlanNode } from "../../../../shared/types/plan.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import {
  poolKeyFingerprint,
  sameAddress,
} from "./codec.js";
import type {
  UniV4Descriptor,
  UniV4ExactEvidence,
  UniV4Route,
} from "./types.js";

const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE =
  1461446703485210103287273052203988822378723970341n;

export const univ4Execution = {
  buildFragment(input) {
    assertExecutionEvidence(input);
    const key = input.descriptor.poolKey;
    const zeroForOne = input.route.direction === "zero-for-one";
    const inputIsNative = sameAddress(input.route.realTokenIn, ethers.ZeroAddress);
    const outputIsNative = sameAddress(input.route.realTokenOut, ethers.ZeroAddress);
    const children: ResolvedPlanNode[] = [
      {
        adapterId: "univ4-swap",
        target: input.descriptor.managerBinding.manager,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {
          currency0: key.currency0,
          currency1: key.currency1,
          fee: BigInt(key.fee),
          tickSpacing: BigInt(key.tickSpacing),
          hooks: key.hooks,
          zeroForOne,
          amountSpecified: -input.amountIn,
          sqrtPriceLimit: zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE,
        },
        children: [],
      },
      {
        adapterId: "univ4-take",
        target: input.descriptor.managerBinding.manager,
        tokenIn: "",
        tokenOut: input.route.tokenOut,
        amount: input.quotedAmountOut,
        params: { currency: input.route.realTokenOut },
        children: [],
      },
    ];

    if (outputIsNative) {
      children.push({
        adapterId: "weth-deposit-value",
        target: ADDR.WETH,
        tokenIn: input.route.realTokenOut,
        tokenOut: ADDR.WETH,
        amount: input.quotedAmountOut,
        params: {},
        children: [],
      });
    }

    if (inputIsNative) {
      children.push(
        {
          adapterId: "weth-withdraw-amount",
          target: ADDR.WETH,
          tokenIn: ADDR.WETH,
          tokenOut: input.route.realTokenIn,
          amount: input.amountIn,
          params: {},
          children: [],
        },
        {
          adapterId: "univ4-sync",
          target: input.descriptor.managerBinding.manager,
          tokenIn: input.route.realTokenIn,
          tokenOut: "",
          amount: 0n,
          params: { currency: ethers.ZeroAddress },
          children: [],
        },
        {
          adapterId: "univ4-settle-value",
          target: input.descriptor.managerBinding.manager,
          tokenIn: "",
          tokenOut: "",
          amount: input.amountIn,
          params: {},
          children: [],
        },
      );
    } else {
      children.push(
        {
          adapterId: "univ4-sync",
          target: input.descriptor.managerBinding.manager,
          tokenIn: input.route.realTokenIn,
          tokenOut: "",
          amount: 0n,
          params: { currency: input.route.realTokenIn },
          children: [],
        },
        {
          adapterId: "erc20-transfer",
          target: input.route.realTokenIn,
          tokenIn: input.route.realTokenIn,
          tokenOut: input.route.realTokenIn,
          amount: input.amountIn,
          params: {
            to: input.descriptor.managerBinding.manager,
            amount: input.amountIn,
          },
          children: [],
        },
        {
          adapterId: "univ4-settle",
          target: input.descriptor.managerBinding.manager,
          tokenIn: "",
          tokenOut: "",
          amount: 0n,
          params: {},
          children: [],
        },
      );
    }

    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "univ4-unlock",
        target: input.descriptor.managerBinding.manager,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: 0n,
        params: {},
        children,
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
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    },
  ],
} satisfies ExecutionSemantics<
  UniV4Descriptor,
  UniV4Route,
  UniV4ExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: UniV4Descriptor;
  readonly route: UniV4Route;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: UniV4ExactEvidence;
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "univ4-no-hook-quoter" ||
    evidence.poolId !== input.descriptor.poolId ||
    evidence.poolKeyFingerprint !== poolKeyFingerprint(input.descriptor.poolKey) ||
    !sameAddress(evidence.quoter, input.descriptor.managerBinding.quoter) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut ||
    evidence.hookData !== "0x"
  ) {
    throw new Error("univ4 execution received incompatible exact evidence");
  }
}
