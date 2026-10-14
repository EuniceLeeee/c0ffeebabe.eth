import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimePayment, runtimeProgramScript, type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../../../adapters/runtime-amount-program.js";
import { concatBytes, encodeReturn } from "../../../../encoder.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import type { UniV4Descriptor, UniV4Route } from "./types.js";
import { poolKeyFingerprint, sameAddress } from "./codec.js";

const tokenAbi = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
const managerAbi = new ethers.Interface([
  "function unlock(bytes data)",
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData) returns (int256)",
  "function take(address currency,address recipient,uint256 amount)",
  "function sync(address currency)", "function settle() payable returns(uint256)",
]);

export function buildUniV4RuntimeLeg(input: { descriptor: UniV4Descriptor; route: UniV4Route; executor: string; settlement?: RuntimeSettlementRequest }): RuntimeAmountLeg | null {
  const { descriptor: d, route: r, executor } = input;
  // Hook-specific execution/account semantics remain an explicit unsupported
  // capability, not a central protocol branch or synthetic Exact evidence.
  if (d.hookPolicy !== "no-hook" || !sameAddress(d.poolKey.hooks, ethers.ZeroAddress)) return null;
  return buildV4RuntimeProgram({ ...input, hookData: "0x", actionAdapterId: "univ4-unlock" });
}

/** PoolManager mechanics shared by the two owning V4 Families. Hook authority
 * and hook data remain the caller Family's responsibility. */
export function buildV4RuntimeProgram(input: { descriptor: UniV4Descriptor; route: UniV4Route;
  executor: string; hookData: string; actionAdapterId: string; settlement?: RuntimeSettlementRequest }): RuntimeAmountLeg | null {
  const { descriptor: d, route: r, executor } = input;
  const zero = r.direction === "zero-for-one", key = d.poolKey, manager = d.managerBinding.manager;
  runtimeExecutor(executor, manager);
  const request = input.settlement;
  const native = sameAddress(r.realTokenIn, ethers.ZeroAddress) || sameAddress(r.realTokenOut, ethers.ZeroAddress);
  if (request?.kind === "quote-output" || request !== undefined && native) return null;
  const recipient = request?.kind === "direct-output" ? ethers.getAddress(request.recipient) : executor;
  if (sameAddress(recipient, ethers.ZeroAddress) || sameAddress(recipient, manager)) throw new Error("univ4 runtime output recipient");
  if ((r.direction !== "zero-for-one" && r.direction !== "one-for-zero") ||
      r.instanceKey !== d.instanceKey || r.poolId !== d.poolId || !sameAddress(r.manager, manager) ||
      poolKeyFingerprint(r.poolKey) !== poolKeyFingerprint(key) ||
      !sameAddress(r.tokenIn, zero ? d.graphToken0 : d.graphToken1) ||
      !sameAddress(r.tokenOut, zero ? d.graphToken1 : d.graphToken0) ||
      r.executionAssets?.input !== (sameAddress(zero ? key.currency0 : key.currency1, ethers.ZeroAddress) ? "native" : "erc20") ||
      r.executionAssets?.output !== (sameAddress(zero ? key.currency1 : key.currency0, ethers.ZeroAddress) ? "native" : "erc20") ||
      !sameAddress(r.realTokenIn, zero ? key.currency0 : key.currency1) ||
      !sameAddress(r.realTokenOut, zero ? key.currency1 : key.currency0)) throw new Error("univ4 runtime route mismatch");
  const p = new RuntimeAmountProgram();
  p.constant(8, 127n).math("shr", 9, 0, 8).constant(10, 0n).equal(9, 10)
    .math("neg", 7, 0).call(manager, managerAbi.encodeFunctionData("swap", [key,
    { zeroForOne: zero, amountSpecified: 0n, sqrtPriceLimitX96: zero ? 4295128740n : 1461446703485210103287273052203988822378723970341n }, input.hookData]),
    { patches: [{ offset: 196, reg: 7 }] }).load(1, 0);
  // BalanceDelta packs signed int128 amount0 high / amount1 low. Decode the
  // input debit's magnitude modulo 2^128; common payment bounds reject a positive
  // input delta, int128 minimum, or debt above the current working amount.
  p.constant(2, 128n).constant(3, (1n << 128n) - 1n).math("shr", 5, 1, 2).math("and", 4, 1, 3);
  const out = zero ? 4 : 5, debt = zero ? 5 : 4;
  p.constant(2, 1n << 128n).math("sub", 6, 2, debt).math("and", 6, 6, 3)
    .math("shr", 9, out, 8).equal(9, 10);
  const payment = runtimePayment(p, 6, 12);
  if(request?.kind==="deferred-input")p.equal(6,0);
  if (request?.kind === "deferred-input") p.call(r.tokenOut, tokenAbi.encodeFunctionData("balanceOf", [executor]), { static: true }).load(13, 0);
  p.call(manager, managerAbi.encodeFunctionData("take", [r.realTokenOut, recipient, 0n]), { patches: [{ offset: 68, reg: out }] });
  if (request?.kind === "deferred-input") p.call(r.tokenOut, tokenAbi.encodeFunctionData("balanceOf", [executor]), { static: true }).load(15, 0)
    .math("sub", 15, 15, 13).constant(14, request.paymentAmount).math("sub", 15, 15, 14);
  if (sameAddress(r.realTokenIn, ethers.ZeroAddress)) {
    // The issuer supplied native input before unlock. Only the actual signed
    // PoolManager debt is settled here; it rewraps any unspent input afterward.
    p.call(manager, managerAbi.encodeFunctionData("sync", [ethers.ZeroAddress]));
    payment.callValue(manager, managerAbi.encodeFunctionData("settle"));
  } else {
    p.call(manager, managerAbi.encodeFunctionData("sync", [r.realTokenIn]));
    if (request?.kind === "deferred-input") p.constant(14, request.paymentAmount).run(request.paymentProgram, 14, 15).equal(15, 6);
    else payment.transfer(r.realTokenIn, manager);
    p.call(manager, managerAbi.encodeFunctionData("settle"));
  }
  payment.verifySettled(11);
  const callback = concatBytes(runtimeProgramScript(p.bytes()),
    encodeReturn(ethers.getBytes(ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], ["0x"]))));
  const outer = new RuntimeAmountProgram().call(manager, managerAbi.encodeFunctionData("unlock", [callback]), {
    callback: { incomingOffset: 68, outgoingOffset: 68 }, patches: [{ offset: 69, reg: 0 }],
  });
  return { actionAdapterId: input.actionAdapterId, program: ethers.hexlify(outer.bytes()),
    ...(native ? {} : { settlement: { directOutput: true as const, deferredInput: manager } }),
    ...(request === undefined ? {} : { settlementRequest: request }) };
}
