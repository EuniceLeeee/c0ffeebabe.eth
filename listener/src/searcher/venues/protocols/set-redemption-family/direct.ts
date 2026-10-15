import { Interface } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { TOKEN } from "./codec.js";
/** Single-output direct settlement. The original Family program enforces
 * protocol units, fee semantics and minimum actual receipt.
 * A separate VM frame keeps these snapshots independent of its registers. */
export function setDirectProgram(program: RuntimeAmountProgram, tokenIn: string, tokenOut: string,
  executor: string, recipient: string): RuntimeAmountProgram {
  const p = new RuntimeAmountProgram().constant(14, 1n).math("sub", 12, 0, 14);
  const read = (token: string, account: string, reg: number) => p.call(token,
    TOKEN.encodeFunctionData("balanceOf", [account]), { static: true }).load(reg, 0);
  read(tokenIn, executor, 1); read(tokenOut, recipient, 2); p.nativeBalance(3);
  const external = recipient.toLowerCase() !== executor.toLowerCase();
  if (external) { read(tokenOut, executor, 4); read(tokenIn, recipient, 5); }
  p.run(program.bytes(), 0, 13);
  read(tokenIn, executor, 6).math("sub", 6, 1, 6).equal(6, 0);
  read(tokenOut, recipient, 7).math("sub", 7, 7, 2).math("sub", 12, 7, 14);
  p.nativeBalance(8).equal(8, 3);
  if (external) { read(tokenOut, executor, 8).equal(8, 4); read(tokenIn, recipient, 8).equal(8, 5); }
  return p;
}

const TRANSFER = new Interface(["function transfer(address,uint256)"]);
const SUBSCRIPT = new Interface(["function execSubscript(bytes)"]);
/** Preserve every side output around the handoff, with invocation-local frames.
 * The existing 64KiB program bound remains the only encoding capacity limit. */
function preserveComponents(program: RuntimeAmountProgram, tokens: readonly string[], account: string, executor: string): RuntimeAmountProgram {
  let nested = program;
  for (let first = Math.floor((tokens.length - 1) / 8) * 8; first >= 0; first -= 8) {
    const end = Math.min(first + 8, tokens.length), p = new RuntimeAmountProgram();
    for (let n = first; n < end; n++) p.call(tokens[n], TOKEN.encodeFunctionData("balanceOf", [account]), { static: true }).load(1 + n - first, 0);
    // The existing executor-only self-call keeps each frame isolated without
    // consuming the VM subprogram depth budget for larger installed baskets.
    p.call(executor, SUBSCRIPT.encodeFunctionData("execSubscript", [runtimeProgramScript(nested.bytes())]), { patches: [{ offset: 69, reg: 0 }] });
    for (let n = first; n < end; n++) p.call(tokens[n], TOKEN.encodeFunctionData("balanceOf", [account]), { static: true }).load(9, 0).equal(9, 1 + n - first);
    nested = p;
  }
  return nested;
}
/** BasicIssuance burns the whole Set and delivers its entire basket to actor.
 * This explicit single-output mode then forwards ONLY the selected component's
 * actual new receipt. It is post-redemption delivery, not protocol-direct output
 * or deferred payment. Every other component retains its existing owner. */
export function setBasketDirectProgram(program: RuntimeAmountProgram, components: readonly string[], tokenIn: string,
  tokenOut: string, executor: string, recipient: string): RuntimeAmountProgram {
  if (recipient.toLowerCase() === executor.toLowerCase()) return setDirectProgram(program, tokenIn, tokenOut, executor, recipient);
  const other = components.filter(token => token.toLowerCase() !== tokenOut.toLowerCase());
  const transfer = new RuntimeAmountProgram().call(tokenOut, TRANSFER.encodeFunctionData("transfer", [recipient, 0n]), { patches: [{ offset: 36, reg: 0 }] });
  // Snapshot side outputs after redemption; transferring the selected receipt
  // must not touch either their original inventory or their new basket receipt.
  const handoff = preserveComponents(transfer, other, executor, executor);
  const p = new RuntimeAmountProgram()
    .call(tokenOut, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(1, 0)
    .call(tokenOut, TOKEN.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(2, 0)
    .run(program.bytes(), 0, 15)
    .call(tokenOut, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(3, 0)
    .math("sub", 4, 3, 1).constant(14, 1n).math("sub", 13, 4, 14)
    .run(handoff.bytes(), 4, 15)
    .call(tokenOut, TOKEN.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(3, 0)
    .math("sub", 3, 3, 2).equal(3, 4)
    .call(tokenOut, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(3, 0).equal(3, 1);
  // Receiver side-output balances are protected across both redemption and
  // forwarding. The outer guard independently binds full Set debit and native.
  return setDirectProgram(preserveComponents(p, other, recipient, executor), tokenIn, tokenOut, executor, recipient);
}
