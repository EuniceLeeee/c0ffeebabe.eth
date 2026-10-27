import { compileAddressMutations } from "../../mutation-index.js";
import { lowerAddress } from "../standard-family/common.js";
import { standardFamily } from "./standard-base.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { ProtocolPricingSnapshot } from "../standard-family/common.js";
import type { StakedUsdatDescriptor, StakedUsdatRoute, StakedUsdatPricingDescriptor, StakedUsdatPricingDraft } from "./types.js";
import { checkStakedUsdatGuard, stakedUsdatGuardRequests } from "./identity-proof.js";
const conversionPricing = standardFamily.pricing as unknown as PricingSemantics<StakedUsdatDescriptor, StakedUsdatRoute,
  StakedUsdatPricingDescriptor, ProtocolPricingSnapshot, StakedUsdatPricingDraft, { readonly oneAsset: bigint; readonly oneShare: bigint }>;

function binding(descriptor: StakedUsdatPricingDescriptor) {
  if (descriptor.stakedUsdat === undefined) throw new Error("StakedUSDat pricing binding missing");
  return descriptor.stakedUsdat;
}
function addresses(descriptor: StakedUsdatPricingDescriptor): readonly string[] {
  const b = binding(descriptor);
  return [descriptor.vault, b.asset, b.implementation, b.oracle, b.withdrawalQueue];
}
export const stakedUsdatPricing: typeof conversionPricing = {
  ...conversionPricing,
  // Definition guards replace callbacks before freezing each Family. Own both
  // nested method containers rather than sharing the ERC4626 definition's ones.
  staticEvidence: {
    ...conversionPricing.staticEvidence!,
    reusePolicy: { ...conversionPricing.staticEvidence!.reusePolicy },
  },
  // totalAssets depends on elapsed vesting and an external STRC oracle.
  refreshPolicyForInstance: () => "each-block",
  compileDraft(input) {
    if (!input.descriptor.stakedUsdat) throw new Error("StakedUSDat descriptor binding missing");
    return Object.freeze({ ...conversionPricing.compileDraft(input), stakedUsdat: input.descriptor.stakedUsdat });
  },
  snapshotCompatibilityProjection(input) {
    return { standard: conversionPricing.snapshotCompatibilityProjection(input),
      stakedUsdat: { ...input.descriptor.stakedUsdat!, proofSource: { ...input.descriptor.stakedUsdat!.proofSource } } };
  },
  current: {
    ...conversionPricing.current,
    requirements: () => ({ transports: ["get-code", "get-storage", "eth-call"] }),
    buildRequests(input) {
      return Object.freeze([...stakedUsdatGuardRequests("current-staked", input.descriptor.vault, binding(input.descriptor)),
        ...conversionPricing.current.buildRequests(input)]);
    },
    decodeSnapshot(input) {
      checkStakedUsdatGuard(input.initialResults, "current-staked", input.descriptor.vault, binding(input.descriptor));
      return conversionPricing.current.decodeSnapshot(input);
    },
  },
  dependencies: ({ descriptor, routes }) => Object.freeze([...new Set([
    ...conversionPricing.dependencies({ descriptor, routes }), ...addresses(descriptor).map(lowerAddress),
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
