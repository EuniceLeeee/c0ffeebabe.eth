import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { dodoV2Routes } from "./routes.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "./codec.js";
import type {
  DodoV2Descriptor,
  DodoV2ExactEvidence,
  DodoV2Route,
} from "./types.js";

export const dodoV2Execution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertProjectedRuntimeRoute(r, dodoV2Routes.project({ descriptor: d })); runtimeExecutor(executor, d.pool);
    const request = input.settlement;
    if (request && request.kind !== "direct-output") return null;
    const recipient = request ? runtimeExecutor(request.recipient, d.pool, r.tokenIn, r.tokenOut) : executor;
    if (!input.transactionOrigin) throw new Error("dodo-v2 runtime requires transaction origin");
    runtimeExecutor(input.transactionOrigin);
    if (request) {
      runtimeExecutor(executor, d.pool, r.tokenIn, r.tokenOut);
      return { ...runtimeLeg("dodo-v2-swap", directRecipientProgram(d.pool, r, executor, recipient)),
        settlement: { directOutput: true as const }, settlementRequest: request };
    }
    const p = new RuntimeAmountProgram()
      .call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("transfer", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
      .call(d.pool, new ethers.Interface(["function sellBase(address)", "function sellQuote(address)"])
        .encodeFunctionData(r.direction === "sell-base" ? "sellBase" : "sellQuote", [recipient]));
    return { ...runtimeLeg("dodo-v2-swap", p), settlement: { directOutput: true as const },
      ...(request ? { settlementRequest: request } : {}) };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertExecutionEvidence(input);
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "transfer-to-pool" as const,
        token: input.route.tokenIn,
        pool: input.descriptor.pool,
        amount: input.amountIn,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "dodo-v2-swap",
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: { sellBase: input.route.direction === "sell-base" },
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
  DodoV2Descriptor,
  DodoV2Route,
  DodoV2ExactEvidence
>;

/** Ordinary sell is input-first. Its receiver does not own the fee actor,
 * and the separate flashLoan callback is not a swap continuation. */
function directRecipientProgram(pool: string, route: DodoV2Route, actor: string, recipient: string): RuntimeAmountProgram {
  const external = !sameAddress(actor, recipient);
  const balance = (owner: string) => RUNTIME_ERC20.encodeFunctionData("balanceOf", [owner]);
  const p = new RuntimeAmountProgram().constant(8, 1n).math("sub", 7, 0, 8).nativeBalance(6)
    .call(route.tokenIn, balance(actor), { static: true }).load(1, 0).math("sub", 7, 1, 0)
    .call(route.tokenOut, balance(recipient), { static: true }).load(2, 0);
  if (external) p.call(route.tokenOut, balance(actor), { static: true }).load(4, 0)
    .call(route.tokenIn, balance(recipient), { static: true }).load(5, 0);
  // USDT's transfer has no return word. Actual debit and receipt, rather than
  // an assumed ERC20 bool, establish the transfer-to-pool settlement.
  p.call(route.tokenIn, RUNTIME_ERC20.encodeFunctionData("transfer", [pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(pool, new ethers.Interface(["function sellBase(address) returns(uint256)", "function sellQuote(address) returns(uint256)"])
      .encodeFunctionData(route.direction === "sell-base" ? "sellBase" : "sellQuote", [recipient])).load(3, 0)
    .call(route.tokenIn, balance(actor), { static: true }).load(7, 0).math("sub", 7, 1, 7).equal(7, 0)
    .call(route.tokenOut, balance(recipient), { static: true }).load(7, 0).math("sub", 7, 7, 2).equal(7, 3)
    .math("sub", 7, 7, 8);
  if (external) p.call(route.tokenOut, balance(actor), { static: true }).load(7, 0).equal(7, 4)
    .call(route.tokenIn, balance(recipient), { static: true }).load(7, 0).equal(7, 5);
  return p.nativeBalance(7).equal(7, 6);
}

function assertExecutionEvidence(input: {
  readonly descriptor: DodoV2Descriptor;
  readonly route: DodoV2Route;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: DodoV2ExactEvidence;
  readonly executor: string;
  readonly transactionOrigin?: string;
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "dodo-v2-actor-bound-query" ||
    !sameAddress(evidence.pool, input.descriptor.pool) ||
    typeof input.transactionOrigin !== "string" ||
    !sameAddress(evidence.transactionOrigin, input.transactionOrigin) ||
    !sameAddress(evidence.executor, input.executor) ||
    evidence.direction !== input.route.direction ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut
  ) {
    throw new Error("dodo-v2 execution received incompatible exact evidence");
  }
}
