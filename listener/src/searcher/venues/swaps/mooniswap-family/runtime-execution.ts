import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeAmountLeg } from "../../../../adapters/runtime-amount-program.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MAX_UINT, MOONISWAP_ACTION, POOL, assertRoute, lower, nonzero } from "./codec.js";
import type { MooniswapDescriptor, MooniswapQuoteEvidence, MooniswapRoute } from "./types.js";

type RuntimeInput = Pick<Parameters<ExecutionSemantics<MooniswapDescriptor, MooniswapRoute, MooniswapQuoteEvidence>["buildFragment"]>[0],
  "descriptor" | "route" | "executor" | "transactionOrigin" | "runtimeEvidence">;

export function buildMooniswapRuntimeLeg(input: RuntimeInput): RuntimeAmountLeg | null {
  const { descriptor, route, executor } = input;
  // Native variants explicitly defer to the whole-route selector.
  if ([descriptor.token0, descriptor.token1, route.tokenIn, route.tokenOut].some(token => lower(token) === ethers.ZeroAddress)) return null;
  assertRoute(descriptor, route);
  if (nonzero(executor) === lower(descriptor.pool)) throw new Error("mooniswap runtime executor equals pool");
  const program = new RuntimeAmountProgram()
    .allowance(route.tokenIn, descriptor.pool, 0, MAX_UINT)
    .call(descriptor.pool, POOL.encodeFunctionData("swapFor", [route.tokenIn, route.tokenOut, 0n, 1n, ethers.ZeroAddress, executor]), {
      patches: [{ offset: 68, reg: 0 }],
    });
  return { actionAdapterId: MOONISWAP_ACTION, program: ethers.hexlify(program.bytes()) };
}
