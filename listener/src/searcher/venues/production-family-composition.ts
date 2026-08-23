import type { ActionAdapter } from "../../types.js";
import capabilityShadowArtifact from
  "../generated/family-capability-shadow.generated.json";
import {
  assertDefinedFamilyPlugin,
  definedFamilyPluginContractSummary,
} from "./adapter-family-plugin.js";
import { assertBoundFamilyOwnedAction } from "./family-owned-action.js";
import {
  FamilyCapabilityCatalog,
} from "./family-capability-catalog.js";
import {
  generatedCapabilityManifestFromShadowArtifact,
} from "./family-capability-shadow.js";
import {
  PRODUCTION_INFRA_ACTION_ADAPTERS,
  PRODUCTION_INFRA_ACTION_ADAPTER_IDS,
} from "./production-infra-actions.js";
import {
  assertCompleteProductionFamilyLoad,
  loadStrictProductionFamilyPlugins,
} from "./production-families/loader.js";

const EXPECTED_STRICT_FAMILIES = 23;
const EXPECTED_EXACT_CAPABILITIES = 253;

const shadowShape = capabilityShadowArtifact as unknown as {
  readonly complete?: unknown;
  readonly legacy?: unknown;
  readonly issues?: unknown;
};
if (
  shadowShape.complete !== true ||
  !Array.isArray(shadowShape.legacy) ||
  shadowShape.legacy.length !== 0 ||
  !Array.isArray(shadowShape.issues) ||
  shadowShape.issues.length !== 0
) {
  throw new Error(
    "strict production requires a complete capability artifact with " +
      "legacy=0 and issues=0",
  );
}

const strictLoad = await loadStrictProductionFamilyPlugins({
  sharedInfraActionAdapterIds: PRODUCTION_INFRA_ACTION_ADAPTER_IDS,
});
assertCompleteProductionFamilyLoad(strictLoad);
if (strictLoad.modules.length !== 0) {
  throw new Error("strict production composition admitted a legacy module");
}
if (strictLoad.plugins.length !== EXPECTED_STRICT_FAMILIES) {
  throw new Error(
    `strict production composition requires ${EXPECTED_STRICT_FAMILIES} ` +
      `Families, received ${strictLoad.plugins.length}`,
  );
}

const strictFamilyIds = strictLoad.plugins.map((module) => module.familyId);
const generatedManifest = generatedCapabilityManifestFromShadowArtifact({
  artifact: capabilityShadowArtifact,
  strictFamilyIds,
});
if (generatedManifest.entries.length !== EXPECTED_EXACT_CAPABILITIES) {
  throw new Error(
    `strict production composition requires ${EXPECTED_EXACT_CAPABILITIES} ` +
      `exact capabilities, received ${generatedManifest.entries.length}`,
  );
}

const catalog = new FamilyCapabilityCatalog({
  requireCapture: true,
  modules: strictLoad.plugins.map((module) => ({
    sourceFile: module.sourceFile,
    definitionBoundaryHash: module.definitionBoundaryHash,
    plugin: module.plugin,
  })),
  generatedManifest,
});
if (catalog.listAll().length !== EXPECTED_STRICT_FAMILIES) {
  throw new Error("strict production Family catalog is incomplete");
}

const familyActions: ActionAdapter[] = [];
const actionIds = new Set<string>();
for (const module of strictLoad.plugins) {
  assertDefinedFamilyPlugin(module.plugin);
  const summary = definedFamilyPluginContractSummary(module.plugin);
  for (const requiredInfraId of summary.requiredInfraActionAdapterIds) {
    if (!PRODUCTION_INFRA_ACTION_ADAPTER_IDS.includes(requiredInfraId)) {
      throw new Error(
        `${summary.familyId} requires inactive production infra ` +
          requiredInfraId,
      );
    }
  }
  for (const action of module.plugin.actionAdapters) {
    assertBoundFamilyOwnedAction(action);
    if (catalog.ownerOfAction(action.id) !== summary.familyId) {
      throw new Error(
        `strict production action ${action.id} has inconsistent ownership`,
      );
    }
    if (actionIds.has(action.id)) {
      throw new Error(`strict production action ${action.id} is duplicated`);
    }
    actionIds.add(action.id);
    familyActions.push(action);
  }
}
for (const action of PRODUCTION_INFRA_ACTION_ADAPTERS) {
  if (actionIds.has(action.id)) {
    throw new Error(
      `Family-owned action ${action.id} conflicts with production infra`,
    );
  }
  actionIds.add(action.id);
}

/**
 * Complete strict composition used only to prove shadow-contract closure.
 * None of these exports are production runtime authority until the atomic
 * route/Graph/pricing/exact/planner/action cutover gate closes.
 */
export const PRODUCTION_STRICT_SHADOW_FAMILY_LOAD = strictLoad;
export const PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST =
  generatedManifest;
export const PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG = catalog;
export const PRODUCTION_STRICT_SHADOW_FAMILY_OWNED_ACTION_ADAPTERS =
  Object.freeze(
  familyActions,
);
export const PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS = Object.freeze([
  ...PRODUCTION_STRICT_SHADOW_FAMILY_OWNED_ACTION_ADAPTERS,
  ...PRODUCTION_INFRA_ACTION_ADAPTERS,
] satisfies readonly ActionAdapter[]);
