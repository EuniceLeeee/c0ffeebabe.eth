import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeAmountLeg } from "../../../../adapters/runtime-amount-program.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MAX_UINT, MOONISWAP_ACTION, POOL, TOKEN, assertRoute, lower, nonzero } from "./codec.js";
import type { MooniswapDescriptor, MooniswapQuoteEvidence, MooniswapRoute } from "./types.js";

type RuntimeInput = Parameters<NonNullable<ExecutionSemantics<MooniswapDescriptor, MooniswapRoute, MooniswapQuoteEvidence>["buildRuntimeLeg"]>>[0];

export function buildMooniswapRuntimeLeg(input: RuntimeInput): RuntimeAmountLeg | null {
  const { descriptor: d, route: r, executor } = input;
  // Native variants explicitly defer to the whole-route selector.
  if ([d.token0, d.token1, r.tokenIn, r.tokenOut].some(token => lower(token) === ethers.ZeroAddress)) return null;
  assertRoute(d, r);
  if (nonzero(executor) === lower(d.pool)) throw new Error("mooniswap runtime executor equals pool");
  const request = input.settlement;
  if (request && request.kind !== "quote-output" && request.kind !== "direct-output") return null;
  const recipient = request?.kind === "direct-output" || request?.recipient !== undefined
    ? ethers.getAddress(request.recipient!) : executor;
  if ([ethers.ZeroAddress, d.pool, r.tokenIn, r.tokenOut].some(address => lower(recipient) === lower(address))) {
    throw new Error("mooniswap runtime invalid output recipient");
  }
  const finish = (program: RuntimeAmountProgram): RuntimeAmountLeg => ({
    actionAdapterId: MOONISWAP_ACTION, program: ethers.hexlify(program.bytes()),
    settlement: { quoteOutput: true, directOutput: true },
    ...(request === undefined ? {} : { settlementRequest: request }),
  });
  if (request?.kind === "quote-output") return finish(quoteProgram(d, r));
  const p = new RuntimeAmountProgram();
  if (request?.kind === "direct-output") {
    p.run(ethers.hexlify(quoteProgram(d, r).bytes()), 0, 8, true)
      .call(r.tokenIn, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(1, 0)
      .call(r.tokenOut, TOKEN.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(2, 0)
      .nativeBalance(5);
    if (lower(recipient) !== lower(executor)) p
      .call(r.tokenOut, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(3, 0)
      .call(r.tokenIn, TOKEN.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(4, 0);
  }
  // Preserve default bytes, the standing allowance policy and zero referral.
  p.allowance(r.tokenIn, d.pool, 0, MAX_UINT)
    .call(d.pool, POOL.encodeFunctionData("swapFor", [r.tokenIn, r.tokenOut, 0n, 1n, ethers.ZeroAddress, recipient]), {
      patches: [{ offset: 68, reg: 0 }],
    });
  if (request?.kind === "direct-output") {
    p.call(r.tokenIn, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(6, 0)
      .math("sub", 6, 1, 6).equal(6, 0)
      .call(r.tokenOut, TOKEN.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(6, 0)
      .math("sub", 6, 6, 2).equal(6, 8).nativeBalance(6).equal(6, 5);
    if (lower(recipient) !== lower(executor)) p
      .call(r.tokenOut, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(6, 0).equal(6, 3)
      .call(r.tokenIn, TOKEN.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(6, 0).equal(6, 4);
  }
  return finish(p);
}

// Read-only amount preparation uses the pool's virtual balances, voted fees and
// current timestamp. getReturn is independent of receiver/referral; it is not an
// execution permission check. swapFor still checks mutable governance activity,
// transfer behavior and capacity, then direct-output checks the actual receipt.
function quoteProgram(d: MooniswapDescriptor, r: MooniswapRoute): RuntimeAmountProgram {
  return new RuntimeAmountProgram().constant(12, 1n).math("sub", 1, 0, 12)
    .call(d.pool, POOL.encodeFunctionData("getReturn", [r.tokenIn, r.tokenOut, 0n]),
      { static: true, patches: [{ offset: 68, reg: 0 }] }).load(1, 0).math("sub", 2, 1, 12)
    .call(r.tokenIn, TOKEN.encodeFunctionData("balanceOf", [d.pool]), { static: true }).load(2, 0).math("sub", 2, 2, 12)
    .call(r.tokenOut, TOKEN.encodeFunctionData("balanceOf", [d.pool]), { static: true }).load(2, 0).math("sub", 2, 2, 1)
    .constant(2, 0n).math("add", 0, 1, 2);
}
