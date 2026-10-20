// Current production issuer and native same-N execution, shared with the
// standard ERC4626 evidence harness. Saved old-family reports stay immutable.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runStandardRecipientHistorical } from "../../erc4626-family/test/standard-recipient-historical.js";
import { STAKED_USDAT_FAMILY_ID } from "../manifest.js";
import { observeStakedUsdatDepositAssets } from "./observations.js";

const manual = process.argv.indexOf("--manual-inputs");
assert(manual === process.argv.lastIndexOf("--manual-inputs"), "duplicate --manual-inputs");
if (manual >= 0) process.argv.splice(manual, 1);
const requireEffectivePrice = process.argv.includes("--prices");
assert((manual >= 0) !== requireEffectivePrice, "choose explicit --manual-inputs or --prices FILE");
runStandardRecipientHistorical({ familyId: STAKED_USDAT_FAMILY_ID, depositOnly: true,
  requireEffectivePrice, manualInputs: manual >= 0, depositEventObserver: observeStakedUsdatDepositAssets,
  evidencePaths: [fileURLToPath(new URL("./observations.ts", import.meta.url))] }).catch(() => {
  console.error("StakedUSDat historical dual input/check failed; existing evidence preserved"); process.exitCode = 1;
});
