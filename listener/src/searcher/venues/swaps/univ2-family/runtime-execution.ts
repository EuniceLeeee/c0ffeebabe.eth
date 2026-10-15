import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, runtimeDeferredPayment, runtimeDeferredOpeningFloor, type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../../../adapters/runtime-amount-program.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_POOL_QUOTE_INTERFACE, UNIV2_TOKEN_INTERFACE, sameAddress } from "./codec.js";
import { tokenTransferReceived } from "../../token-transfer-semantics/index.js";
import { univ2Routes } from "./routes.js";
import type { UniV2Descriptor, UniV2ExactEvidence, UniV2Route } from "./types.js";

type RuntimeInput = Pick<Parameters<ExecutionSemantics<UniV2Descriptor, UniV2Route, UniV2ExactEvidence>["buildFragment"]>[0],
  "descriptor" | "route" | "executor" | "transactionOrigin" | "runtimeEvidence"> & { settlement?: RuntimeSettlementRequest };
const TRANSFER = new ethers.Interface(["function transfer(address to,uint256 amount)"]);

export function buildUniV2RuntimeLeg(input: RuntimeInput): RuntimeAmountLeg | null {
  const { descriptor: d, route: r } = input;
  const expected = univ2Routes.project({ descriptor: d }).find(route => route.direction === r.direction);
  if (!expected || r.familyId !== expected.familyId || r.lineageId !== expected.lineageId ||
      r.instanceKey !== expected.instanceKey || r.routeKey !== expected.routeKey ||
      r.bindingRef.bindingKey !== expected.bindingRef.bindingKey || r.bindingRef.fingerprint !== expected.bindingRef.fingerprint ||
      !sameAddress(r.pool, expected.pool) || !sameAddress(r.tokenIn, expected.tokenIn) || !sameAddress(r.tokenOut, expected.tokenOut) ||
      r.feeBps !== expected.feeBps || r.taxonomy.slotKind !== "swap" || r.taxonomy.protocolAction !== undefined) {
    throw new Error("univ2 runtime route binding mismatch");
  }
  const executor = ethers.getAddress(input.executor);
  if ([d.pool, r.tokenIn, r.tokenOut, executor].some(address => sameAddress(address, ethers.ZeroAddress)) ||
      sameAddress(r.tokenIn, r.tokenOut) || sameAddress(d.pool, executor)) {
    throw new Error("univ2 runtime invalid execution addresses");
  }
  const request = input.settlement;
  const recipient = request?.kind === "direct-output" || request?.kind === "settle-output"
    ? ethers.getAddress(request.recipient) : executor;
  if ([ethers.ZeroAddress, r.tokenIn, r.tokenOut, d.pool].some(address => sameAddress(recipient, address))) {
    throw new Error("univ2 runtime invalid output recipient");
  }
  const finish = (p: RuntimeAmountProgram): RuntimeAmountLeg => ({ actionAdapterId: "univ2-swap", program: ethers.hexlify(p.bytes()),
    settlement: { quoteOutput: true, directOutput: true, deferredInput: d.pool, deferredDebtInput: true,
      ...(d.quoteModel.kind === "constant-product" && d.feeRule.kind === "constant-bps" ? { settleOutput: true as const } : {}) },
    ...(request === undefined ? {} : { settlementRequest: request }) });
  if (request?.kind === "settle-output") {
    if (d.quoteModel.kind !== "constant-product" || d.feeRule.kind !== "constant-bps") return null;
    if (request.amountIn <= 0n || request.amountIn > ethers.MaxUint256) throw new Error("univ2 runtime settlement amount");
    // r0 is the authenticated downstream callback's actual debt, capped by
    // this transaction's quote. Pay only this trial's fixed input. The pair's
    // invariant checks actual input credit; the recipient pool checks actual
    // output credit. Neither executor inventory nor a second quote supplies it.
    return finish(new RuntimeAmountProgram().constant(1, request.amountIn)
      .call(r.tokenIn, TRANSFER.encodeFunctionData("transfer", [d.pool, 0n]), { patches: [{ offset: 36, reg: 1 }] })
      .call(d.pool, UNIV2_PAIR_INTERFACE.encodeFunctionData("swap", [0n, 0n, recipient, "0x"]), {
        patches: [{ offset: r.direction === "zero-for-one" ? 36 : 4, reg: 0 }],
      }));
  }
  if (request?.kind === "quote-output" || request?.kind === "deferred-input") {
    const p = quoteProgram(d, r);
    if (request.kind === "quote-output") return finish(p.constant(7, 0n).math("add", 0, 6, 7));
    // The swap releases output first. The authenticated callback executes the
    // upstream segment, which must deliver exactly this invocation's input.
    const payment = runtimeDeferredPayment({ tokenOut: r.tokenOut, executor, ...request });
    runtimeDeferredOpeningFloor(p, r.tokenOut, executor, request.paymentAmount);
    return finish(p.call(d.pool, UNIV2_PAIR_INTERFACE.encodeFunctionData("swap",
      [0n, 0n, recipient, payment.script]), {
      callback: { incomingOffset: 164, outgoingOffset: 164 },
      patches: [{ offset: r.direction === "zero-for-one" ? 36 : 4, reg: 6 }, { offset: 165, reg: 0 },
        { offset: 164 + payment.floorOffset, reg: 13 }],
    }));
  }
  // Preserve the quoted path's settlement order: quote against pre-transfer
  // state, then pay the current input inside the authenticated pair callback.
  if (d.quoteModel.kind === "pool-get-amount-out") {
    if (d.feeRule.kind !== "included-in-pool-quote") throw new Error("univ2 runtime incompatible pool quote fee");
    const p = new RuntimeAmountProgram().constant(1, 0n).math("add", 1, 0, 1);
    const transfer = d.tokenTransfers?.[r.direction === "zero-for-one" ? 0 : 1];
    tokenTransferReceived(transfer, 0n, d.pool); // validate the existing Family-owned transfer model
    if (transfer?.kind === "verified-transfer-tax" && !sameAddress(d.pool, transfer.token)) {
      p.constant(2, transfer.taxNumerator).math("mul", 3, 0, 2)
        .constant(2, transfer.taxDenominator).math("div", 3, 3, 2).math("sub", 1, 0, 3);
    }
    const payment = new RuntimeAmountProgram().call(r.tokenIn,
      TRANSFER.encodeFunctionData("transfer", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] });
    p.call(d.pool, UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionData("getAmountOut", [r.tokenIn, 0n]),
        { static: true, patches: [{ offset: 36, reg: 1 }] }).load(2, 0)
      .call(d.pool, UNIV2_PAIR_INTERFACE.encodeFunctionData("swap", [0n, 0n, recipient, runtimeProgramScript(payment.bytes())]),
        { callback: { incomingOffset: 164, outgoingOffset: 164 },
          patches: [{ offset: r.direction === "zero-for-one" ? 36 : 4, reg: 2 }, { offset: 165, reg: 0 }] });
    return finish(p);
  }
  if (d.quoteModel.kind !== "constant-product" || d.feeRule.kind !== "constant-bps" ||
      d.feeRule.feeBps < 0n || d.feeRule.feeBps >= 10_000n) {
    throw new Error("univ2 runtime unsupported fee rule");
  }
  const zeroForOne = r.direction === "zero-for-one";
  const balance = UNIV2_TOKEN_INTERFACE.encodeFunctionData("balanceOf", [d.pool]);
  const program = new RuntimeAmountProgram()
    .call(d.pool, UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves", []), { static: true })
    .load(1, zeroForOne ? 0 : 32) // reserveIn
    .load(2, zeroForOne ? 32 : 0) // reserveOut
    .call(r.tokenIn, balance, { static: true }).load(3, 0)
    .call(r.tokenIn, TRANSFER.encodeFunctionData("transfer", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(r.tokenIn, balance, { static: true }).load(4, 0)
    .math("sub", 4, 4, 3) // actual pair credit, including transfer tax
    .constant(5, 10_000n - d.feeRule.feeBps)
    .math("mul", 4, 4, 5) // received * fee multiplier
    .math("mul", 6, 4, 2) // numerator
    .constant(5, 10_000n)
    .math("mul", 7, 1, 5)
    .math("add", 7, 7, 4)
    .math("div", 6, 6, 7)
    .call(d.pool, UNIV2_PAIR_INTERFACE.encodeFunctionData("swap", [0n, 0n, recipient, "0x"]), {
      patches: [{ offset: zeroForOne ? 36 : 4, reg: 6 }],
    });
  // The enclosing flow checks route inventory and measures actual receipts;
  // neither an optional transfer bool nor a quoted amount supplies that proof.
  return finish(program);
}

/** Read-only preparation, never off-chain Exact. The actual settlement still
 * measures recipient credit; changed state/transfer behavior fails atomically. */
function quoteProgram(d: UniV2Descriptor, r: UniV2Route): RuntimeAmountProgram {
  const p = new RuntimeAmountProgram().constant(7, 0n).math("add", 4, 0, 7);
  const transfer = d.tokenTransfers?.[r.direction === "zero-for-one" ? 0 : 1];
  tokenTransferReceived(transfer, 0n, d.pool);
  if (transfer?.kind === "verified-transfer-tax" && !sameAddress(d.pool, transfer.token)) {
    p.constant(5, transfer.taxNumerator).math("mul", 3, 0, 5)
      .constant(5, transfer.taxDenominator).math("div", 3, 3, 5).math("sub", 4, 0, 3);
  }
  if (d.quoteModel.kind === "pool-get-amount-out") {
    if (d.feeRule.kind !== "included-in-pool-quote") throw new Error("univ2 runtime incompatible pool quote fee");
    return p.call(d.pool, UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionData("getAmountOut", [r.tokenIn, 0n]),
      { static: true, patches: [{ offset: 36, reg: 4 }] }).load(6, 0);
  }
  if (d.quoteModel.kind !== "constant-product" || d.feeRule.kind !== "constant-bps" ||
      d.feeRule.feeBps < 0n || d.feeRule.feeBps >= 10000n) throw new Error("univ2 runtime unsupported fee rule");
  const zero = r.direction === "zero-for-one";
  return p.call(d.pool, UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves", []), { static: true })
    .load(1, zero ? 0 : 32).load(2, zero ? 32 : 0)
    .constant(5, 10000n - d.feeRule.feeBps).math("mul", 4, 4, 5).math("mul", 6, 4, 2)
    .constant(5, 10000n).math("mul", 7, 1, 5).math("add", 7, 7, 4).math("div", 6, 6, 7);
}
