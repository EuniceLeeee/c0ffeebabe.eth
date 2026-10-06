import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeCallbackPayment, type RuntimeAmountLeg } from "../../../../adapters/runtime-amount-program.js";
import { MAX_SQRT_RATIO, MIN_SQRT_RATIO } from "../../../solver/v3-math.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { UNIV3_POOL_INTERFACE } from "../univ3-abi.js";
import { sameAddress } from "./codec.js";
import { univ3Routes } from "./routes.js";
import type { UniV3Descriptor, UniV3ExactEvidence, UniV3Route } from "./types.js";

type RuntimeInput = Pick<Parameters<ExecutionSemantics<UniV3Descriptor, UniV3Route, UniV3ExactEvidence>["buildFragment"]>[0],
  "descriptor" | "route" | "executor" | "transactionOrigin" | "runtimeEvidence">;

export function buildUniV3RuntimeLeg(input: RuntimeInput): RuntimeAmountLeg {
  const { descriptor: d, route: r } = input;
  const expected = univ3Routes.project({ descriptor: d }).find(route => route.direction === r.direction);
  if (!expected || r.familyId !== expected.familyId || r.lineageId !== expected.lineageId ||
      r.instanceKey !== expected.instanceKey || r.routeKey !== expected.routeKey ||
      r.bindingRef.bindingKey !== expected.bindingRef.bindingKey || r.bindingRef.fingerprint !== expected.bindingRef.fingerprint ||
      !sameAddress(r.pool, expected.pool) || !sameAddress(r.tokenIn, expected.tokenIn) || !sameAddress(r.tokenOut, expected.tokenOut) ||
      r.fee !== expected.fee || r.tickSpacing !== expected.tickSpacing ||
      r.taxonomy.slotKind !== "swap" || r.taxonomy.protocolAction !== undefined) {
    throw new Error("univ3 runtime route binding mismatch");
  }
  const executor = ethers.getAddress(input.executor);
  if ([d.pool, r.tokenIn, r.tokenOut, executor].some(address => sameAddress(address, ethers.ZeroAddress)) ||
      sameAddress(r.tokenIn, r.tokenOut) || sameAddress(d.pool, executor)) {
    throw new Error("univ3 runtime invalid execution addresses");
  }
  const zeroForOne = r.direction === "zero-for-one";
  const payment = runtimeCallbackPayment(r.tokenIn, d.pool, zeroForOne ? 4 : 36);
  const outgoingOffset = 4 + 5 * 32 + 32; // swap's dynamic bytes content
  const program = new RuntimeAmountProgram()
    // amountSpecified is signed. A high bit must never turn exact-input into exact-output.
    .constant(1, 255n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3)
    .call(d.pool, UNIV3_POOL_INTERFACE.encodeFunctionData("swap", [executor, zeroForOne, 0n,
      zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n, payment.script]), {
      patches: [{ offset: 68, reg: 0 }, { offset: outgoingOffset + payment.limitOffset, reg: 0 }],
      callback: { incomingOffset: 132, outgoingOffset },
    })
    .load(1, zeroForOne ? 0 : 32)
    .math("sub", 2, 0, 1); // partial fills are legal; input debt must stay within the cap
  return { actionAdapterId: "univ3-swap", program: ethers.hexlify(program.bytes()) };
}
