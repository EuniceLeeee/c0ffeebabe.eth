import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import { assertModuleData } from "./declarative-modules.js";
import {
  normalizeSelectorNativeExecutionDefinition,
  type SelectorNativeExecutionDefinition,
} from "./selector-native-definition.js";
import {
  normalizeSelectorNativeFundingDefinition,
  type SelectorNativeFundingDefinition,
} from "./selector-native-funding-definition.js";
import { normalizeSelectorNativeCreditDefinition, type SelectorNativeCreditDefinition } from "./selector-native-credit-definition.js";

export const SELECTOR_FAMILY_FORMAT = "selector-family/v2" as const;
export type SelectorFamilyDefinition = SelectorNativeExecutionDefinition | SelectorNativeFundingDefinition | SelectorNativeCreditDefinition;

/** The same semantic normalization is used by runtime, discovery and build
 * fingerprints. Metadata is removed by the domain normalizer, never by a
 * recursive name filter which could accidentally erase execution arguments. */
export function normalizeSelectorFamilyDefinition(raw: unknown): SelectorFamilyDefinition {
  assertModuleData(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("selector Family definition must be a JSON object");
  const value = raw as Record<string, unknown>;
  if (value.format !== undefined && value.format !== SELECTOR_FAMILY_FORMAT)
    throw new Error("retired Family JSON format; expected selector-family/v2");
  return value.domain === "funding"
    ? normalizeSelectorNativeFundingDefinition(raw)
    : value.domain === "credit" ? normalizeSelectorNativeCreditDefinition(raw) : normalizeSelectorNativeExecutionDefinition(raw);
}

export function selectorFamilySemanticHash(raw: unknown): string {
  return hashCanonical(normalizeSelectorFamilyDefinition(raw) as unknown as CanonicalValue);
}
