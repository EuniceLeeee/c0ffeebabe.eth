import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { erc4626Discovery } from "../erc4626-family/discovery.js";
import type { Erc4626Candidate } from "../erc4626-family/types.js";

// Shared ERC4626 observations nominate candidates; the independent identity
// lifecycle, not a known vault address or a label, decides this Family.
export const stakedUsdatDiscovery: DiscoverySemantics<Erc4626Candidate> = {
  ...erc4626Discovery,
  nominate: createAddressSurfaceNomination({ opaqueLabels: Object.freeze(["staked-usdat", "protocol:staked-usdat"]),
    interfaceFingerprints: Object.freeze(["erc4626-standard-behavior-v1"]) }),
};
