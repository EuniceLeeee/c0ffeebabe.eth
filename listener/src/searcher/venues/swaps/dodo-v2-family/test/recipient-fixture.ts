import { ethers } from "ethers";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { DODO_V2_FAMILY_ID, DODO_V2_REGISTRY_LINEAGE_ID } from "../manifest.js";
import type { DodoV2Descriptor } from "../types.js";
export const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
export const ACTOR = addr(107), RECEIVER = addr(91), SOURCE = { number: 1, hash: "0x" + "11".repeat(32), generation: 1 };
// Synthetic only: real historical issuer tests use production-attested Ready.
export function fixture(pool = addr(101), base = addr(102), quote = addr(103)): DodoV2Descriptor {
  return { familyId: DODO_V2_FAMILY_ID, lineageId: DODO_V2_REGISTRY_LINEAGE_ID, instanceKey: instanceKey(pool.toLowerCase()),
    provenance: [], runtimeRequirements: [], pool, baseToken: base, quoteToken: quote,
    registryBinding: { registry: addr(104), listedPool: pool }, quoteActorBinding: { actor: addr(106), role: "verified-actor",
      feeSemantics: "getUserFeeRate(actor)", querySemantics: "querySellBase/querySellQuote(actor,effectiveInput)", inputSemantics: "balance-reserve-mt-fee-v1" } };
}
