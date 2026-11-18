import {
  assertDefinedFamilyPlugin,
  defineFundingFamily,
  defineCreditFamily,
  defineProtocolFamily,
  defineSwapFamily,
  type AnyDefinedStrictFamilyPlugin,
} from "./adapter-family-plugin.js";
import { compileSelectorNativeExecutionFamily } from "./selector-native-family.js";
import { compileSelectorNativeFundingFamily } from "./selector-native-funding.js";
import { compileSelectorNativeCreditFamily } from "./selector-native-credit.js";
import {
  normalizeSelectorFamilyDefinition,
  selectorFamilySemanticHash,
  SELECTOR_FAMILY_FORMAT,
  type SelectorFamilyDefinition,
} from "./selector-family-definition.js";
import {
  assertDefinedFamilyActivation,
  defineFamilyActivation,
  type FamilyActivation,
} from "./production-families/activation.js";

/** The public production contract accepts authored v2 data. Internal runtime
 * ports are issued here and cannot be supplied by a hand-written module. */
export interface SelectorFamilyModule {
  readonly contract: typeof SELECTOR_FAMILY_FORMAT;
  readonly definition: SelectorFamilyDefinition;
  readonly semanticDefinitionHash: string;
  readonly plugin: AnyDefinedStrictFamilyPlugin;
  readonly activation: FamilyActivation;
}

const issuedModules = new WeakSet<object>();

export function defineSelectorFamilyModule(raw: unknown): SelectorFamilyModule {
  const definition = normalizeSelectorFamilyDefinition(raw);
  const plugin = definition.domain === "funding"
    ? defineFundingFamily(compileSelectorNativeFundingFamily(definition))
    : definition.domain === "credit" ? defineCreditFamily(compileSelectorNativeCreditFamily(definition))
    : definition.domain === "protocol"
      ? defineProtocolFamily(compileSelectorNativeExecutionFamily<"protocol">(definition))
      : defineSwapFamily(compileSelectorNativeExecutionFamily<"swap">(definition));
  const activation = defineFamilyActivation(definition.activation ?? {
    enabled: true,
    envKey: `SEARCHER_FAMILY_SELECTOR_${definition.selector.slice(2).toUpperCase()}_ENABLED`,
  });
  const result = Object.freeze({ contract: SELECTOR_FAMILY_FORMAT, definition,
    semanticDefinitionHash: selectorFamilySemanticHash(definition), plugin, activation });
  issuedModules.add(result);
  return result;
}

export function assertSelectorFamilyModule(value: unknown): asserts value is SelectorFamilyModule {
  if (!value || typeof value !== "object" || !issuedModules.has(value))
    throw new Error("selectorFamilyModule must be issued by defineSelectorFamilyModule with selector-family/v2 JSON");
  const module = value as SelectorFamilyModule;
  if (module.contract !== SELECTOR_FAMILY_FORMAT ||
      module.semanticDefinitionHash !== selectorFamilySemanticHash(module.definition))
    throw new Error("selector Family semantic definition changed");
  assertDefinedFamilyPlugin(module.plugin);
  assertDefinedFamilyActivation(module.activation);
}
