import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../../../adapters/runtime-amount-program.js";
import { applyRuntimeAssetBoundary } from "../../../execution-asset-boundary.js";
import { runtimeExecutor, runtimeExactApproval, runtimeClearApproval, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { MAX_UINT } from "./codec.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";

const exchange = new ethers.Interface([
  "function ethToTokenTransferInput(uint256 min_tokens,uint256 deadline,address recipient) payable returns(uint256)",
  "function tokenToEthTransferInput(uint256 tokens_sold,uint256 min_eth,uint256 deadline,address recipient) returns(uint256)",
]);
const allowance = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);
export function directRecipientLeg(d: Descriptor, r: Route, executor: string,
  request: Extract<RuntimeSettlementRequest, { kind: "direct-output" }>): RuntimeAmountLeg {
  const recipient = runtimeExecutor(request.recipient, d.pool, d.issuer, r.tokenIn, r.tokenOut);
  const p = new RuntimeAmountProgram();
  if (r.buy) {
    p.call(r.tokenOut, RUNTIME_ERC20.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(1, 0)
      .call(d.pool, exchange.encodeFunctionData("ethToTokenTransferInput", [1n, MAX_UINT, recipient]), { valueReg: 0 })
      .load(2, 0)
      .call(r.tokenOut, RUNTIME_ERC20.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(3, 0)
      .math("sub", 3, 3, 1).equal(3, 2);
  } else {
    runtimeExactApproval(p, r.tokenIn, d.pool);
    p.call(r.tokenIn, allowance.encodeFunctionData("allowance", [executor, d.pool]), { static: true }).load(4, 0).equal(4, 0)
      .nativeBalance(1)
      .call(d.pool, exchange.encodeFunctionData("tokenToEthTransferInput", [0n, 1n, MAX_UINT, executor]),
        { patches: [{ offset: 4, reg: 0 }] }).load(2, 0)
      .nativeBalance(3).math("sub", 3, 3, 1).equal(3, 2);
    runtimeClearApproval(p, r.tokenIn, d.pool);
    p.call(r.tokenIn, allowance.encodeFunctionData("allowance", [executor, d.pool]), { static: true }).load(4, 0)
      .constant(5, 0n).equal(4, 5);
  }
  // Legacy V1 routes expose WETH graph assets and keep their old default
  // wrapping. The new raw TransferInput operation declares its native sides
  // here, so the same common boundary performs measured wrapping/delivery.
  return applyRuntimeAssetBoundary({ route: { ...r, executionAssets: {
    input: r.buy ? "native" : "erc20", output: r.buy ? "erc20" : "native" } }, executor,
    leg: { actionAdapterId: ACTION, program: ethers.hexlify(p.bytes()),
      settlement: { directOutput: true }, settlementRequest: request } });
}
