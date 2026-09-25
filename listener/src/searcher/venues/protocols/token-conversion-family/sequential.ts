import type { ExactQuoteInput } from "../../adapter-family-plugin.js";
import { sameAddress } from "../standard-family/common.js";
import { assertInvocation, staticProjection } from "./binding.js";
import { hashCanonical } from "../../canonical-value.js";
import { MAX_UINT } from "./variants.js";
import type { ConversionDescriptor, ConversionRoute } from "./types.js";
import type { XwinPrefixStep } from "./xwin.js";

type Input = ExactQuoteInput<ConversionDescriptor, ConversionRoute>;

/** Only complete, contiguous same-instance sequences are supported. In
 * particular, never discard intervening foreign legs from the issued prefix. */
export function xwinPrefix(input: Input): readonly XwinPrefixStep[] {
  if (!input.prefix?.length) return [];
  if (input.descriptor.variant !== "xwin-allocations-v1") throw new Error("conversion sequential prefix unsupported");
  const binding = hashCanonical(staticProjection(input.descriptor));
  const steps = [...input.prefix, input];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const d = step.descriptor as ConversionDescriptor, r = step.route as ConversionRoute;
    if (d.variant !== "xwin-allocations-v1" || d.instanceKey !== input.descriptor.instanceKey ||
        hashCanonical(staticProjection(d)) !== binding) throw new Error("xWin sequential instance mismatch");
    assertInvocation(d, r);
    if (typeof step.amountIn !== "bigint" || step.amountIn <= 0n || step.amountIn > MAX_UINT)
      throw new Error("xWin sequential amount outside uint256");
    if (index > 0) {
      const previous = input.prefix[index - 1]!;
      if (!sameAddress(previous.route.tokenOut, r.tokenIn) || previous.amountOut !== step.amountIn)
        throw new Error("xWin sequential token/amount mismatch");
    }
  }
  return input.prefix.map(step => ({ direction: (step.route as ConversionRoute).direction,
    amountIn: step.amountIn, amountOut: step.amountOut }));
}

export function supportsXwinPrefix(input: Input): boolean {
  if (!input.prefix?.length) return true;
  try { xwinPrefix(input); return true; } catch { return false; }
}
