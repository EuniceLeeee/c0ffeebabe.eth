import { Interface } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { CORE, LEGACY_SET, VAULT } from "./legacy.js";
import { TOKEN, WAD } from "./codec.js";
import type { Descriptor } from "./types.js";

const APPROVAL = new Interface(["function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)"]);
/** A unary issuance consumes precisely this leg's component amount. Core uses
 * Vault credit before wallet tokens, so fail before issue if old credit exists.
 * No component rounding, donation, old allowance, or output inventory can fill
 * a shortfall. The native Core/Set still enforce all issuance permissions. */
export function legacyIssueRuntime(d: Descriptor, actor: string, minimum?: bigint): RuntimeAmountProgram {
  const l = d.legacy, proxy = l?.issuance?.transferProxy;
  if (!l || !proxy || d.components.length !== 1) throw new Error("set-legacy unary issuance unavailable");
  const token = d.components[0], p = new RuntimeAmountProgram().constant(15, 0n).constant(14, 1n);
  p.call(d.set, LEGACY_SET.encodeFunctionData("getComponents"), { static: true }).load(1, 32).equal(1, 14)
    .load(1, 64).constant(2, BigInt(token)).equal(1, 2)
    .call(d.module, CORE.encodeFunctionData("transferProxy"), { static: true }).load(1, 0).constant(2, BigInt(proxy)).equal(1, 2)
    .call(l.vault, VAULT.encodeFunctionData("getOwnerBalance", [token, actor]), { static: true }).load(1, 0).equal(1, 15)
    .call(d.set, LEGACY_SET.encodeFunctionData("getUnits"), { static: true }).load(1, 32).equal(1, 14).load(1, 64)
    .math("div", 2, 0, 1).math("mul", 3, 2, 1).equal(3, 0)
    .call(d.set, LEGACY_SET.encodeFunctionData("naturalUnit"), { static: true }).load(1, 0).math("mul", 2, 2, 1);
  // r2=Core issue quantity; r3=minimum net receipt, r4/r5=old balances.
  if (minimum !== undefined) p.constant(3, minimum);
  else if (l.kind === "rebalancing-v3") {
    p.call(d.set, LEGACY_SET.encodeFunctionData("entryFee"), { static: true }).load(1, 0)
      .constant(3, WAD - 1n).math("sub", 3, 3, 1).math("mul", 3, 2, 1).constant(1, WAD).math("div", 3, 3, 1)
      .call(d.set, LEGACY_SET.encodeFunctionData("feeRecipient"), { static: true }).load(1, 0);
    // Both operands are uint160 addresses. (2^160+a-b)>>160 is the
    // a>=b bit without uint256 underflow; the AND of both comparisons is
    // equality. Retain the fee in our minimum when this executor receives it.
    p.constant(6, BigInt(actor)).constant(7, 1n << 160n).constant(9, 160n)
      .math("add", 8, 1, 7).math("sub", 8, 8, 6).math("shr", 8, 8, 9)
      .math("add", 10, 6, 7).math("sub", 10, 10, 1).math("shr", 10, 10, 9)
      .math("and", 8, 8, 10).math("sub", 8, 14, 8).math("mul", 3, 3, 8).math("sub", 3, 2, 3);
  }
  else p.math("add", 3, 2, 15);
  p.call(token, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(4, 0)
    .call(d.set, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(5, 0)
    .call(token, APPROVAL.encodeFunctionData("allowance", [actor, proxy]), { static: true }).load(1, 0).equal(1, 15)
    .call(token, APPROVAL.encodeFunctionData("approve", [proxy, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(token, APPROVAL.encodeFunctionData("allowance", [actor, proxy]), { static: true }).load(1, 0).equal(1, 0)
    .call(d.module, CORE.encodeFunctionData("issue", [d.set, 0n]), { patches: [{ offset: 36, reg: 2 }] })
    .call(token, APPROVAL.encodeFunctionData("approve", [proxy, 0n]))
    .call(token, APPROVAL.encodeFunctionData("allowance", [actor, proxy]), { static: true }).load(1, 0).equal(1, 15)
    .call(token, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0).math("sub", 1, 4, 1).equal(1, 0)
    .call(d.set, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0).math("sub", 1, 1, 5).math("sub", 1, 1, 3)
    .call(l.vault, VAULT.encodeFunctionData("getOwnerBalance", [token, actor]), { static: true }).load(1, 0).equal(1, 15);
  return p;
}
