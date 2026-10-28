import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeClearApproval, runtimeExactApproval } from "../../runtime-execution.js";
import { lower, MULTICALL, NATIVE, normalizedToken, POOL, TOKEN } from "./codec.js";
const ALLOWANCE = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);

/** Raw operation only. The production issuer owns WETH/native conversion. */
export function executionProgram(input: {
  pool: string; rawIn: string; rawOut: string; executor: string; minimum: bigint; recipient?: string;
}): Uint8Array {
  const pool = lower(input.pool), rawIn = lower(input.rawIn), rawOut = lower(input.rawOut), executor = lower(input.executor);
  const tokenIn = normalizedToken(rawIn), tokenOut = normalizedToken(rawOut);
  const direct = input.recipient !== undefined, recipient = direct ? lower(input.recipient!) : executor;
  const external = recipient !== executor;
  if ([pool, executor, recipient].includes(ethers.ZeroAddress) || pool === executor || tokenIn === tokenOut ||
      [tokenIn, tokenOut].includes(pool) || [tokenIn, tokenOut].includes(executor) ||
      [pool, tokenIn, tokenOut].includes(recipient) || rawOut === ethers.ZeroAddress && external ||
      input.minimum <= 0n || input.minimum > ethers.MaxUint256) throw new Error("precision-pool invalid execution binding");
  const p = new RuntimeAmountProgram();
  const balance = (token: string, account: string, reg: number) => {
    if (token === ethers.ZeroAddress) {
      if (account === executor) p.nativeBalance(reg);
      else p.call(MULTICALL, NATIVE.encodeFunctionData("getEthBalance", [account]), { static: true }).load(reg, 0);
    } else p.call(token, TOKEN.encodeFunctionData("balanceOf", [account]), { static: true }).load(reg, 0);
  };
  p.constant(1, 0n).call(pool, POOL.encodeFunctionData("hook"), { static: true }).load(2, 0).equal(1, 2)
    .call(pool, POOL.encodeFunctionData("creatorFeeBps"), { static: true }).load(2, 0).equal(1, 2);
  if (direct) p.constant(1, 1n).math("sub", 2, 0, 1);
  balance(rawIn, executor, 6); balance(rawOut, recipient, 4); p.nativeBalance(9);
  if (external) {
    balance(rawOut, executor, 10); balance(tokenIn, recipient, 11); balance(ethers.ZeroAddress, recipient, 12);
  }
  if (rawIn !== ethers.ZeroAddress) {
    if (direct) runtimeExactApproval(p, rawIn, pool);
    else p.allowance(rawIn, pool); // Preserve the established default MAX_UINT policy.
  }
  // swapExactIn pulls the whole input before paying `to`; there is no caller
  // continuation or deferred-input capability in the admitted zero-hook profile.
  p.call(pool, POOL.encodeFunctionData("swapExactIn", [rawIn, 0n, input.minimum, recipient]), {
    patches: [{ offset: 36, reg: 0 }], ...(rawIn === ethers.ZeroAddress ? { valueReg: 0 } : {}),
  });
  if (direct) p.load(8, 0);
  if (direct && rawIn !== ethers.ZeroAddress) {
    runtimeClearApproval(p, rawIn, pool);
    p.call(rawIn, ALLOWANCE.encodeFunctionData("allowance", [executor, pool]), { static: true }).load(2, 0)
      .constant(1, 0n).equal(2, 1);
  }
  balance(rawOut, recipient, 5); p.math("sub", 5, 5, 4);
  if (direct) p.equal(5, 8); // A return value cannot stand in for actual receipt.
  p.constant(1, input.minimum).math("sub", 2, 5, 1);
  balance(rawIn, executor, 7); p.math("sub", 7, 6, 7).equal(7, 0);
  if (rawIn !== ethers.ZeroAddress && rawOut !== ethers.ZeroAddress) p.nativeBalance(3).equal(3, 9);
  // For native input, the exact raw debit above also rejects refunds or loss of
  // old ETH. For native output, the measured delta is wrapped by the issuer.
  if (external) {
    balance(rawOut, executor, 3); p.equal(3, 10);
    balance(tokenIn, recipient, 3); p.equal(3, 11);
    balance(ethers.ZeroAddress, recipient, 3); p.equal(3, 12);
  }
  return p.bytes();
}
