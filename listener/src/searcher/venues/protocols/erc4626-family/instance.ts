// Compatibility export; behavior is compiled by the shared Family pipeline.
import { plugin } from "../../production-families/erc4626.production.js";
import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import type { Erc4626Candidate, Erc4626Identity, Erc4626Descriptor, Erc4626Route, Erc4626PricingDescriptor, Erc4626PricingDraft, Erc4626ExactEvidence } from "./types.js";
export const erc4626Instance = plugin.instance as unknown as InstanceSemantics<Erc4626Identity, Erc4626Descriptor>;
