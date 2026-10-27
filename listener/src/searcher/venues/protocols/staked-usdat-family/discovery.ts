import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { standardFamily } from "./standard-base.js";
import type { StakedUsdatCandidate } from "./types.js";

// Shared ERC4626 observations nominate candidates; the independent identity
// lifecycle, not a known vault address or a label, decides this Family.
export const stakedUsdatDiscovery: DiscoverySemantics<StakedUsdatCandidate> = {
  ...standardFamily.discovery as unknown as DiscoverySemantics<StakedUsdatCandidate>,
  nominate: createAddressSurfaceNomination({ opaqueLabels: Object.freeze(["staked-usdat", "protocol:staked-usdat"]),
    interfaceFingerprints: Object.freeze(["erc4626-standard-behavior-v1"]) }),
};
