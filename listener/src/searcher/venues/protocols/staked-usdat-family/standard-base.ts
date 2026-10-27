// Preserve this Family's separate identity/refresh ownership while its shared
// conversion implementation moves out of the ERC4626 TypeScript modules.
import { createDeclarativeProtocolRuntime } from "../../declarative-protocol.js";
import standard from "../erc4626-family/erc4626.json";
import { STAKED_USDAT_FAMILY_ID, STAKED_USDAT_LINEAGE_ID } from "./manifest.js";
const declaration = JSON.parse(JSON.stringify(standard));
declaration.scope.family = STAKED_USDAT_FAMILY_ID;
declaration.manifest.familyId = STAKED_USDAT_FAMILY_ID;
declaration.manifest.supportedLineages = [STAKED_USDAT_LINEAGE_ID];
declaration.standard.lineageId = STAKED_USDAT_LINEAGE_ID;
declaration.variantFiles = [];
declaration.instance.draft.stakedUsdat = "$identity.stakedUsdat";
declaration.instance.bindingProjection.stakedUsdat = "$descriptor.stakedUsdat";
declaration.pricing.draft.stakedUsdat = "$descriptor.stakedUsdat";
declaration.routes.directions[0].adapterId = "staked-usdat-deposit";
declaration.standard.assertions.push({
  condition: { op: "and", args: [
    { op: "defined", args: ["$descriptor.stakedUsdat"] },
    { op: "sameAddress", args: ["$descriptor.asset", "$descriptor.stakedUsdat.asset"] },
    { op: "eq", args: ["$route.direction", "deposit"] },
    { op: "not", args: ["$descriptor.verifiedDirections.redeem"] },
  ] }, error: "StakedUSDat deposit binding mismatch",
});
export const standardRuntime = createDeclarativeProtocolRuntime(declaration);
export const standardFamily = standardRuntime.definition;
