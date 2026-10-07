import { ethers } from "ethers";
import type { BalancerV3Descriptor } from "./types.js";

/** localModel is issued only after the immutable pool runtime AND the whole
 * immutable Vault delegate chain match the verified implementation templates.
 * Weighted weights/minimum balances are immutable. STANDARD token rates are
 * exactly 1; getPoolData uses Vault accounting, not external ERC20 balances.
 * Therefore unrelated coin logs cannot change this mathematical quote.
 * Vault calls/non-swap events and pool activity MUST still invalidate it.
 *
 * This is a refresh proof, never admission. No A-ramp/rate/hook/unknown model
 * is included. A previously unpaused pool cannot become paused by time alone;
 * explicit pause/query/fee/recovery/liquidity changes touch the Vault.
 */
export function hasStateOnlyWeightedPrice(descriptor: BalancerV3Descriptor): boolean {
  const binding = descriptor.binding;
  return (binding.localModel === "weighted-v1" || binding.localModel === "weighted-v2") &&
    binding.tokens.length >= 2 && binding.tokenInfo.length === binding.tokens.length &&
    binding.tokenInfo.every(info => info.tokenType === 0 &&
      info.rateProvider.toLowerCase() === ethers.ZeroAddress && !info.paysYieldFees) &&
    binding.hooks.address.toLowerCase() === ethers.ZeroAddress &&
    binding.hooks.flags.length === 10 && binding.hooks.flags.every(flag => !flag);
}

export function directRefreshAddresses(descriptor: BalancerV3Descriptor): readonly string[] {
  return hasStateOnlyWeightedPrice(descriptor) ? [descriptor.pool] : [
    descriptor.pool, ...descriptor.binding.tokens, descriptor.binding.hooks.address,
    ...descriptor.binding.tokenInfo.map(info => info.rateProvider),
  ];
}
