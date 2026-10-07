import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeAmountLeg } from "../../../../adapters/runtime-amount-program.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_POOL_QUOTE_INTERFACE, UNIV2_TOKEN_INTERFACE, sameAddress } from "./codec.js";
import { univ2Routes } from "./routes.js";
import type { UniV2Descriptor, UniV2ExactEvidence, UniV2Route } from "./types.js";

type RuntimeInput = Pick<Parameters<ExecutionSemantics<UniV2Descriptor, UniV2Route, UniV2ExactEvidence>["buildFragment"]>[0],
  "descriptor" | "route" | "executor" | "transactionOrigin" | "runtimeEvidence">;
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
  // A verified non-xyk pair owns its amount function. Read it in the same
  // transaction, after measuring this transfer's actual pair credit.
  if (d.quoteModel.kind === "pool-get-amount-out") {
    if (d.feeRule.kind !== "included-in-pool-quote") throw new Error("univ2 runtime incompatible pool quote fee");
    const balance = UNIV2_TOKEN_INTERFACE.encodeFunctionData("balanceOf", [d.pool]);
    const p = new RuntimeAmountProgram()
      .call(r.tokenIn, balance, { static: true }).load(1, 0)
      .call(r.tokenIn, TRANSFER.encodeFunctionData("transfer", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
      .call(r.tokenIn, balance, { static: true }).load(2, 0).math("sub", 2, 2, 1)
      .call(d.pool, UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionData("getAmountOut", [r.tokenIn, 0n]),
        { static: true, patches: [{ offset: 36, reg: 2 }] }).load(3, 0)
      .call(d.pool, UNIV2_PAIR_INTERFACE.encodeFunctionData("swap", [0n, 0n, executor, "0x"]),
        { patches: [{ offset: r.direction === "zero-for-one" ? 36 : 4, reg: 3 }] });
    return { actionAdapterId: "univ2-swap", program: ethers.hexlify(p.bytes()) };
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
    .call(d.pool, UNIV2_PAIR_INTERFACE.encodeFunctionData("swap", [0n, 0n, executor, "0x"]), {
      patches: [{ offset: zeroForOne ? 36 : 4, reg: 6 }],
    });
  // The enclosing flow checks route inventory and measures actual receipts;
  // neither an optional transfer bool nor a quoted amount supplies that proof.
  return { actionAdapterId: "univ2-swap", program: ethers.hexlify(program.bytes()) };
}
