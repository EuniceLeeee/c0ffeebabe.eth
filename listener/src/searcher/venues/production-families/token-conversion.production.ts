import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { manifest } from "../protocols/token-conversion-family/manifest.js";
import { discovery } from "../protocols/token-conversion-family/discovery.js";
import { identity } from "../protocols/token-conversion-family/identity.js";
import { instance } from "../protocols/token-conversion-family/instance.js";
import { routes } from "../protocols/token-conversion-family/routes.js";
import { pricing } from "../protocols/token-conversion-family/pricing.js";
import { exact } from "../protocols/token-conversion-family/exact.js";
import { execution } from "../protocols/token-conversion-family/execution.js";
import { protocol } from "../protocols/token-conversion-family/protocol.js";
import { capture } from "../protocols/token-conversion-family/capture.js";
import { mintAction, redeemAction } from "../protocols/token-conversion-family/action.js";
export const plugin = defineProtocolFamily({ manifest, discovery, identity, instance, routes, pricing, exact, execution, protocol, capture, actionAdapters: [mintAction, redeemAction] });

// Keep xWin/BTB installed but off until local amount quotes pass historical acceptance.
export const activation = defineFamilyActivation({ enabled: false, envKey: "SEARCHER_FAMILY_TOKEN_CONVERSION_ENABLED" });
