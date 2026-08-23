import { ADDR } from "../../../../shared/constants/addresses.js";
import type { ResolvedPlanNode } from "../../../../shared/types/plan.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import {
  poolKeyFingerprint,
  sameAddress,
} from "../univ4-family/codec.js";
import {
  UNIV4_FEE_HOOK_ADDRESS,
} from "./manifest.js";
import type {
  FeeHookDescriptor,
  FeeHookExactEvidence,
  FeeHookRoute,
} from "./types.js";

const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE =
  1461446703485210103287273052203988822378723970341n;

/**
 * Same execution fragment as the standard univ4 Family (unlock wraps
 * swap/take/settle under the same manager), bound to the fee-hook owned
 * adapter ids and the audited hook. The hook itself is executed by the
 * manager during the final simulation on the fork; no adapter-side hook
 * logic exists.
 */
export const univ4FeeHookExecution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertExecutionEvidence(input);
    const key = input.descriptor.poolKey;
    const zeroForOne = input.route.direction === "zero-for-one";
    const inputIsNative = sameAddress(input.route.realTokenIn, "0x0000000000000000000000000000000000000000");
    const outputIsNative = sameAddress(input.route.realTokenOut, "0x0000000000000000000000000000000000000000");
    const children: ResolvedPlanNode[] = [
      {
        adapterId: "univ4-fee-hook-swap",
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
        adapterId: "univ4-fee-hook-take",
        target: input.descriptor.managerBinding.manager,
        tokenIn: input.route.tokenIn,
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
          adapterId: "univ4-fee-hook-sync",
          target: input.descriptor.managerBinding.manager,
          tokenIn: input.route.realTokenIn,
          tokenOut: input.route.tokenOut,
          amount: 0n,
          params: { currency: "0x0000000000000000000000000000000000000000" },
          children: [],
        },
        {
          adapterId: "univ4-fee-hook-settle-value",
          target: input.descriptor.managerBinding.manager,
          tokenIn: input.route.tokenIn,
          tokenOut: input.route.tokenOut,
          amount: input.amountIn,
          params: {},
          children: [],
        },
      );
    } else {
      children.push(
        {
          adapterId: "univ4-fee-hook-sync",
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
          adapterId: "univ4-fee-hook-settle",
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
        adapterId: "univ4-fee-hook-unlock",
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
  FeeHookDescriptor,
  FeeHookRoute,
  FeeHookExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: FeeHookDescriptor;
  readonly route: FeeHookRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: FeeHookExactEvidence;
  readonly minAmountOut?: bigint;
  readonly executor?: string;
  readonly runtimeEvidence?: readonly unknown[];
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "univ4-fee-hook-quoter" ||
    evidence.poolId !== input.descriptor.poolId ||
    evidence.poolKeyFingerprint !== poolKeyFingerprint(input.descriptor.poolKey) ||
    !sameAddress(evidence.quoter, input.descriptor.managerBinding.quoter) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut ||
    evidence.hookData !== "0x"
  ) {
    throw new Error(
      "univ4 fee-hook execution received incompatible exact evidence",
    );
  }
  if (!sameAddress(input.descriptor.hook, UNIV4_FEE_HOOK_ADDRESS)) {
    throw new Error("univ4 fee-hook execution hook binding diverged");
  }
}
