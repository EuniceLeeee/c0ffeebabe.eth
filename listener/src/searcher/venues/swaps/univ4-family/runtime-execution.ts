import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeAmountLeg } from "../../../../adapters/runtime-amount-program.js";
import { concatBytes, encodeReturn } from "../../../../encoder.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { UniV4Descriptor, UniV4Route } from "./types.js";
import { poolKeyFingerprint, sameAddress } from "./codec.js";

const managerAbi = new ethers.Interface([
  "function unlock(bytes data)",
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData) returns (int256)",
  "function take(address currency,address recipient,uint256 amount)",
  "function sync(address currency)", "function settle() payable returns(uint256)",
]);
const tokenAbi = new ethers.Interface(["function transfer(address,uint256) returns(bool)",
  "function withdraw(uint256)", "function deposit() payable"]);

export function buildUniV4RuntimeLeg(input: { descriptor: UniV4Descriptor; route: UniV4Route; executor: string }): RuntimeAmountLeg | null {
  const { descriptor: d, route: r, executor } = input;
  // Hook-specific execution/account semantics remain an explicit unsupported
  // capability, not a central protocol branch or synthetic Exact evidence.
  if (d.hookPolicy !== "no-hook" || !sameAddress(d.poolKey.hooks, ethers.ZeroAddress)) return null;
  const zero = r.direction === "zero-for-one", key = d.poolKey, manager = d.managerBinding.manager;
  if ((r.direction !== "zero-for-one" && r.direction !== "one-for-zero") ||
      r.instanceKey !== d.instanceKey || r.poolId !== d.poolId || !sameAddress(r.manager, manager) ||
      poolKeyFingerprint(r.poolKey) !== poolKeyFingerprint(key) ||
      !sameAddress(r.tokenIn, zero ? d.graphToken0 : d.graphToken1) ||
      !sameAddress(r.tokenOut, zero ? d.graphToken1 : d.graphToken0) ||
      !sameAddress(r.realTokenIn, zero ? key.currency0 : key.currency1) ||
      !sameAddress(r.realTokenOut, zero ? key.currency1 : key.currency0)) throw new Error("univ4 runtime route mismatch");
  const p = new RuntimeAmountProgram();
  p.math("neg", 7, 0).call(manager, managerAbi.encodeFunctionData("swap", [key,
    { zeroForOne: zero, amountSpecified: 0n, sqrtPriceLimitX96: zero ? 4295128740n : 1461446703485210103287273052203988822378723970341n }, "0x"]),
    { patches: [{ offset: 196, reg: 7 }] }).load(1, 0);
  // BalanceDelta packs signed int128 amount0 high / amount1 low. Require full
  // input consumption; reject partial fills before settling an excessive debt.
  p.constant(2, 128n).constant(3, (1n << 128n) - 1n).math("shr", 5, 1, 2).math("and", 4, 1, 3);
  const out = zero ? 4 : 5, debt = zero ? 5 : 4;
  p.math("and", 6, 7, 3).equal(debt, 6)
    .constant(8, 127n).math("shr", 9, 0, 8).constant(10, 0n).equal(9, 10)
    .math("shr", 9, out, 8).equal(9, 10);
  p.call(manager, managerAbi.encodeFunctionData("take", [r.realTokenOut, executor, 0n]), { patches: [{ offset: 68, reg: out }] });
  if (sameAddress(r.realTokenOut, ethers.ZeroAddress)) {
    p.call(ADDR.WETH, tokenAbi.encodeFunctionData("deposit"), { valueReg: out });
  }
  if (sameAddress(r.realTokenIn, ethers.ZeroAddress)) {
    p.call(ADDR.WETH, tokenAbi.encodeFunctionData("withdraw", [0n]), { patches: [{ offset: 4, reg: 0 }] })
      .call(manager, managerAbi.encodeFunctionData("sync", [ethers.ZeroAddress]))
      .call(manager, managerAbi.encodeFunctionData("settle"), { valueReg: 0 });
  } else {
    p.call(manager, managerAbi.encodeFunctionData("sync", [r.realTokenIn]))
      .call(r.realTokenIn, tokenAbi.encodeFunctionData("transfer", [manager, 0n]), { patches: [{ offset: 36, reg: 0 }] })
      .call(manager, managerAbi.encodeFunctionData("settle"));
  }
  p.load(11, 0).equal(11, 0);
  const callback = concatBytes(runtimeProgramScript(p.bytes()),
    encodeReturn(ethers.getBytes(ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], ["0x"]))));
  const outer = new RuntimeAmountProgram().call(manager, managerAbi.encodeFunctionData("unlock", [callback]), {
    callback: { incomingOffset: 68, outgoingOffset: 68 }, patches: [{ offset: 69, reg: 0 }],
  });
  return { actionAdapterId: "univ4-unlock", program: ethers.hexlify(outer.bytes()) };
}
