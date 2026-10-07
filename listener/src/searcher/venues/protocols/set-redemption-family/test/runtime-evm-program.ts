// Emits the actual Family program for the isolated, synthetic Solidity test.
// No provider, Ready minting, saved-state override or historical claim.
import { plugin } from "../../../production-families/set-redemption.production.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { address } from "../codec.js";
import { FAMILY, LINEAGE } from "../manifest.js";
import { key } from "../instance.js";
import type { Descriptor } from "../types.js";
const [set, module, controller, executor, ...components] = process.argv.slice(2).map(address);
if (!set || !module || !controller || !executor || !components.length) throw new Error("runtime fixture arguments");
const descriptor: Descriptor = { familyId: FAMILY, lineageId: LINEAGE, instanceKey: instanceKey(key({ set, module })),
  set, module, controller, controllerCodeHash: "0x" + "00".repeat(32), components, provenance: [], runtimeRequirements: [] };
const route = plugin.routes.project({ descriptor })[0];
if (!plugin.execution.buildRuntimeLeg) throw new Error("missing runtime interface");
const leg = plugin.execution.buildRuntimeLeg({ descriptor, route, executor, runtimeEvidence: [] });
if (!leg) throw new Error("unsupported runtime fixture");
process.stdout.write(leg.program);
