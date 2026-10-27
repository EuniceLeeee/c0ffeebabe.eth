// Compatibility export; behavior is compiled by the shared Family pipeline.
import { plugin } from "../../production-families/erc4626.production.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import type { Erc4626Candidate, Erc4626Identity, Erc4626Descriptor, Erc4626Route, Erc4626PricingDescriptor, Erc4626PricingDraft, Erc4626ExactEvidence } from "./types.js";
import type { ProtocolPricingSnapshot } from "../standard-family/common.js";
export const erc4626Pricing = plugin.pricing as unknown as PricingSemantics<Erc4626Descriptor, Erc4626Route, Erc4626PricingDescriptor, ProtocolPricingSnapshot, Erc4626PricingDraft, { readonly oneAsset: bigint; readonly oneShare: bigint }>;
