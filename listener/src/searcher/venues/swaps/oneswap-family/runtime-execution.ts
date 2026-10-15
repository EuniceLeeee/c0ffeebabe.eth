import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { FACTORY, LIMIT112, lower, normalizedToken, POOL, TOKEN } from "./codec.js";

/** Emit raw protocol currencies. The production issuer owns ETH/WETH conversion.
 * addMarketOrder takes input first; its sender argument is the output recipient,
 * not a callback target. Never infer receipt from its returned amount alone. */
export function executionProgram(input: { pool: string; rawIn: string; rawOut: string; factory: string;
  implementation: string; executor: string; minimum: bigint; recipient?: string }): Uint8Array {
  const pool = lower(input.pool), rawIn = lower(input.rawIn), rawOut = lower(input.rawOut);
  const tokenIn = normalizedToken(rawIn), tokenOut = normalizedToken(rawOut);
  const actor = runtimeExecutor(input.executor, pool, input.factory, input.implementation, tokenIn, tokenOut);
  const recipient = input.recipient === undefined ? actor : runtimeExecutor(input.recipient, pool,
    input.factory, input.implementation, tokenIn, tokenOut);
  if ([pool, lower(input.factory), lower(input.implementation)].includes(ethers.ZeroAddress) || tokenIn === tokenOut ||
      [tokenIn, tokenOut].includes(pool) || input.minimum <= 0n || input.minimum >= LIMIT112 ||
      rawOut === ethers.ZeroAddress && recipient !== actor) throw new Error("oneswap invalid execution binding");
  const nativeIn = rawIn === ethers.ZeroAddress, nativeOut = rawOut === ethers.ZeroAddress;
  const external = recipient !== actor;
  const balance = (token: string, holder: string, reg: number, p: RuntimeAmountProgram) =>
    p.call(token, TOKEN.encodeFunctionData("balanceOf", [holder]), { static: true }).load(reg, 0);
  const p = new RuntimeAmountProgram().constant(1, 1n).math("sub", 2, 0, 1)
    .constant(1, LIMIT112).math("div", 2, 0, 1).constant(1, 0n).equal(2, 1)
    .call(input.factory, FACTORY.encodeFunctionData("pairLogic"), { static: true }).load(2, 0)
    .constant(1, BigInt(input.implementation)).equal(1, 2).nativeBalance(9);
  if (!nativeIn) balance(rawIn, actor, 6, p);
  if (!nativeOut) balance(rawOut, recipient, 4, p);
  if (external) {
    balance(tokenIn, recipient, 11, p);
    balance(tokenOut, actor, 10, p);
  }
  if (!nativeIn) p.call(rawIn, TOKEN.encodeFunctionData("transfer", [pool, 0n]), { patches: [{ offset: 36, reg: 0 }] });
  p.call(pool, POOL.encodeFunctionData("addMarketOrder", [rawIn, recipient, 0n]), {
    patches: [{ offset: 68, reg: 0 }], ...(nativeIn ? { valueReg: 0 } : {}),
  }).load(8, 0);
  if (nativeOut) p.nativeBalance(5).math("sub", 5, 5, 9);
  else balance(rawOut, recipient, 5, p).math("sub", 5, 5, 4);
  // The protocol can ignore failed native sends or redirect a failed token send
  // to its token owner. Both cases must fail our independently measured receipt.
  p.equal(5, 8).constant(1, input.minimum).math("sub", 5, 5, 1);
  if (nativeIn) p.nativeBalance(7).math("sub", 7, 9, 7).equal(7, 0);
  else balance(rawIn, actor, 7, p).math("sub", 7, 6, 7).equal(7, 0);
  if (!nativeIn && !nativeOut) p.nativeBalance(7).equal(7, 9);
  if (external) {
    balance(tokenIn, recipient, 7, p).equal(7, 11);
    balance(tokenOut, actor, 7, p).equal(7, 10);
  }
  return p.bytes();
}
