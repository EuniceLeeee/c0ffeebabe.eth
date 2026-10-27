import { getAddress } from "ethers";
import erc4626Definition from "./protocols/erc4626-family/erc4626.json";
import {
  ERC4626_SILO_PROBE_ACTOR,
  ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID,
} from "./protocols/erc4626-silo-redeem-family/shared.js";
import {
  SELF_BURN_NATIVE_PRICING_ACTOR,
  SELF_BURN_NATIVE_PRICING_ACTOR_EVIDENCE_ID,
  SELF_BURN_NATIVE_PROBE_ACTOR,
  SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID,
} from "./protocols/self-burn-native-family/shared.js";
import {
  ETHERTOKEN_NATIVE_PROBE_ACTOR,
  ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID,
} from "./protocols/ethertoken-native-redeem-family/shared.js";
import { FLUID_CREDIT_PROBE_ACTOR } from
  "./credit/fluid-family/codec.js";
import { FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID } from
  "./credit/fluid-family/identity.js";
import {
  DODO_V2_QUOTE_ACTOR,
  DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
} from "./swaps/dodo-v2-family/identity.js";

/**
 * Central caller authority for every strict Family that declares
 * `caller: "verified-actor"` in identity/active-proof requirements. The map
 * is evidence id -> probe actor, exactly the surface the central runtime's
 * callerAuthority contract binds against. Omission keeps a family
 * fail-closed at caller-authority; these entries do not grant any
 * admission or routing authority by themselves.
 */
export const PRODUCTION_STRICT_VERIFIED_ACTORS: Readonly<
  Record<string, string>
> = Object.freeze({
  [erc4626Definition.identity.definition.parameters.constants.caller.evidenceId]:
    getAddress(erc4626Definition.identity.definition.parameters.constants.actor),
  [ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID]: ERC4626_SILO_PROBE_ACTOR,
  [SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID]:
    SELF_BURN_NATIVE_PROBE_ACTOR,
  [SELF_BURN_NATIVE_PRICING_ACTOR_EVIDENCE_ID]:
    SELF_BURN_NATIVE_PRICING_ACTOR,
  [ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID]:
    ETHERTOKEN_NATIVE_PROBE_ACTOR,
  [FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID]: FLUID_CREDIT_PROBE_ACTOR,
  [DODO_V2_QUOTE_ACTOR_EVIDENCE_ID]: DODO_V2_QUOTE_ACTOR,
});
