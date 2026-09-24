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
  capabilityManifestHash,
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
  type ProductionFamilyLoadResult,
} from "./production-families/loader.js";

/** Validate every installed definition before projecting the entry-owned active set. */
export function composeProductionFamilyActivation(input: {
  readonly load: ProductionFamilyLoadResult;
  readonly artifact: unknown;
}) {
  const strictLoad = input.load;
  assertCompleteProductionFamilyLoad(strictLoad);
  const shadowShape = input.artifact as {
    readonly complete?: unknown;
    readonly legacy?: unknown;
    readonly issues?: unknown;
  };
  if (
    shadowShape === null || typeof shadowShape !== "object" || shadowShape.complete !== true ||
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

  if (strictLoad.modules.length !== 0) {
    throw new Error("strict production composition admitted a legacy module");
  }
  const allPlugins = [...strictLoad.plugins, ...strictLoad.disabledPlugins];
  if (allPlugins.length === 0) {
    throw new Error("strict production composition requires a nonempty Family catalog");
  }

  if (strictLoad.plugins.some(module => !module.activation.enabled) ||
      strictLoad.disabledPlugins.some(module => module.activation.enabled)) {
    throw new Error("production Family activation partition disagrees with its entry declarations");
  }
  const fullManifest = generatedCapabilityManifestFromShadowArtifact({
    artifact: input.artifact,
    strictFamilyIds: allPlugins.map((module) => module.familyId),
  });
  // The generated manifest validator checks exact Family-set equality and every
  // required capability, including disabled definitions. Disabling a Family must
  // never disguise a stale artifact or a conflicting installed definition.
  const fullCatalog = new FamilyCapabilityCatalog({
    requireCapture: true,
    modules: allPlugins,
    generatedManifest: fullManifest,
  });
  const activeIds = new Set(strictLoad.plugins.map(module => module.familyId));
  const entries = Object.freeze(fullManifest.entries.filter(entry => activeIds.has(entry.familyId)));
  const generatedManifest = Object.freeze({ format: fullManifest.format, entries,
    manifestHash: capabilityManifestHash(entries) });

  const catalog = strictLoad.disabledPlugins.length === 0 ? fullCatalog : new FamilyCapabilityCatalog({
    requireCapture: true,
    modules: strictLoad.plugins.map((module) => ({
      sourceFile: module.sourceFile,
      definitionBoundaryHash: module.definitionBoundaryHash,
      plugin: module.plugin,
    })),
    generatedManifest,
  });
  if (catalog.listAll().length !== strictLoad.plugins.length) {
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
  return Object.freeze({
    catalog,
    generatedManifest,
    fullGeneratedManifest: fullManifest,
    activations: Object.freeze(allPlugins.map(module => Object.freeze({
      familyId: module.familyId, sourceFile: module.sourceFile, ...module.activation,
    })).sort((left, right) => left.sourceFile.localeCompare(right.sourceFile))),
    familyActions: Object.freeze(familyActions),
    actionAdapters: Object.freeze([...familyActions, ...PRODUCTION_INFRA_ACTION_ADAPTERS]),
  });
}

const strictLoad = await loadStrictProductionFamilyPlugins({
  sharedInfraActionAdapterIds: PRODUCTION_INFRA_ACTION_ADAPTER_IDS,
});
const composition = composeProductionFamilyActivation({ load: strictLoad, artifact: capabilityShadowArtifact });

/**
 * Complete strict composition used only to prove shadow-contract closure.
 * None of these exports are production runtime authority until the atomic
 * route/Graph/pricing/exact/planner/action cutover gate closes.
 */
export const PRODUCTION_STRICT_SHADOW_FAMILY_LOAD = strictLoad;
export const PRODUCTION_FAMILY_ACTIVATIONS = composition.activations;
export const PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST =
  composition.generatedManifest;
export const PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG = composition.catalog;
export const PRODUCTION_STRICT_SHADOW_FAMILY_OWNED_ACTION_ADAPTERS =
  composition.familyActions;
export const PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS = composition.actionAdapters;
