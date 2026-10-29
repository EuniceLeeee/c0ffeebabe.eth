import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { OLYMPUS_ERC20_INTERFACE, OLYMPUS_INTERFACE,
  OLYMPUS_INDEX_SCALE } from "./codec.js";
import type { OlympusDescriptor } from "./types.js";

/**
 * gOHM -> OHM through the staking contract. The staking contract burns gOHM
 * from msg.sender (the executor) and pays OHM to `recipient`, so no ERC20
 * allowance is granted. r0 is the previous leg's actual gOHM receipt; the
 * program independently checks the executor's gOHM debit and the recipient's
 * fresh OHM receipt against the on-chain `index()` read in the same frame.
 */
export function olympusDirectProgram(
  d: OlympusDescriptor,
  executor: string,
  recipient: string,
): RuntimeAmountProgram {
  const actor = ethers.getAddress(executor);
  const receiver = ethers.getAddress(recipient);
  const distinctRecipient = actor !== receiver;
  const balanceOf = (account: string) =>
    OLYMPUS_ERC20_INTERFACE.encodeFunctionData("balanceOf", [account]);
  const p = new RuntimeAmountProgram();
  p.call(d.gOHM, balanceOf(actor), { static: true }).load(1, 0)
    .call(d.OHM, balanceOf(receiver), { static: true }).load(2, 0);
  if (distinctRecipient) {
    p.call(d.OHM, balanceOf(actor), { static: true }).load(9, 0)
      .call(d.gOHM, balanceOf(receiver), { static: true }).load(10, 0);
  }
  p.call(d.staking, OLYMPUS_INTERFACE.encodeFunctionData("index"),
    { static: true }).load(5, 0)
    .constant(7, OLYMPUS_INDEX_SCALE)
    .math("mul", 6, 0, 5)
    .math("div", 6, 6, 7)
    .call(
      d.staking,
      OLYMPUS_INTERFACE.encodeFunctionData("unstake",
        [receiver, 0n, false, false]),
      { patches: [{ offset: 36, reg: 0 }] },
    )
    .call(d.gOHM, balanceOf(actor), { static: true }).load(8, 0)
    .math("sub", 8, 1, 8).equal(8, 0)
    .call(d.OHM, balanceOf(receiver), { static: true }).load(8, 0)
    .math("sub", 8, 8, 2).equal(8, 6);
  if (distinctRecipient) {
    p.call(d.OHM, balanceOf(actor), { static: true }).load(8, 0)
      .equal(8, 9)
      .call(d.gOHM, balanceOf(receiver), { static: true }).load(8, 0)
      .equal(8, 10);
  }
  return p;
}
