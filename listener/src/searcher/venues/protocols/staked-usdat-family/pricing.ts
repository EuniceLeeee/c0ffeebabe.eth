import { compileAddressMutations } from "../../mutation-index.js";
import { lowerAddress } from "../standard-family/common.js";
import { standardFamily } from "./standard-base.js";
import type { erc4626Pricing as OriginalShared } from "../erc4626-family/pricing.js";
const erc4626Pricing = standardFamily.pricing as unknown as typeof OriginalShared;
import type { Erc4626PricingDescriptor } from "../erc4626-family/types.js";
import { checkStakedUsdatGuard, stakedUsdatGuardRequests } from "./identity-proof.js";

function binding(descriptor: Erc4626PricingDescriptor) {
  if (descriptor.stakedUsdat === undefined) throw new Error("StakedUSDat pricing binding missing");
  return descriptor.stakedUsdat;
}
function addresses(descriptor: Erc4626PricingDescriptor): readonly string[] {
  const b = binding(descriptor);
  return [descriptor.vault, b.asset, b.implementation, b.oracle, b.withdrawalQueue];
}
export const stakedUsdatPricing: typeof erc4626Pricing = {
  ...erc4626Pricing,
  // Definition guards replace callbacks before freezing each Family. Own both
  // nested method containers rather than sharing the ERC4626 definition's ones.
  staticEvidence: {
    ...erc4626Pricing.staticEvidence!,
    reusePolicy: { ...erc4626Pricing.staticEvidence!.reusePolicy },
  },
  // totalAssets depends on elapsed vesting and an external STRC oracle.
  refreshPolicyForInstance: () => "each-block",
  compileDraft(input) {
    if (!input.descriptor.stakedUsdat) throw new Error("StakedUSDat descriptor binding missing");
    return Object.freeze({ ...erc4626Pricing.compileDraft(input), stakedUsdat: input.descriptor.stakedUsdat });
  },
  snapshotCompatibilityProjection(input) {
    return { standard: erc4626Pricing.snapshotCompatibilityProjection(input),
      stakedUsdat: { ...input.descriptor.stakedUsdat!, proofSource: { ...input.descriptor.stakedUsdat!.proofSource } } };
  },
  current: {
    ...erc4626Pricing.current,
    requirements: () => ({ transports: ["get-code", "get-storage", "eth-call"] }),
    buildRequests(input) {
      return Object.freeze([...stakedUsdatGuardRequests("current-staked", input.descriptor.vault, binding(input.descriptor)),
        ...erc4626Pricing.current.buildRequests(input)]);
    },
    decodeSnapshot(input) {
      checkStakedUsdatGuard(input.initialResults, "current-staked", input.descriptor.vault, binding(input.descriptor));
      return erc4626Pricing.current.decodeSnapshot(input);
    },
  },
  dependencies: ({ descriptor, routes }) => Object.freeze([...new Set([
    ...erc4626Pricing.dependencies({ descriptor, routes }), ...addresses(descriptor).map(lowerAddress),
  ])].sort()),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({
      addresses: addresses(descriptor), keys: [descriptor.instanceKey],
    }), { kinds: ["log"] }),
    affectedStateKeys: ({ descriptor, observation }) => observation.kind === "log" &&
      addresses(descriptor).some(address => address.toLowerCase() === observation.address.toLowerCase())
      ? [descriptor.instanceKey] : [],
  },
};
