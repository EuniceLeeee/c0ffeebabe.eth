// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/erc4626-family/erc4626.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import definition from "../protocols/erc4626-family/erc4626.json";
import child0 from "../protocols/erc4626-family/custodian.json";
import child1 from "../protocols/erc4626-family/infinifi.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_ERC4626_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol(definition, [child0, child1]));
