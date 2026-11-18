import { assertModuleData } from "./declarative-modules.js";
import { hashCanonical } from "./canonical-value.js";
import type { DeclarativeCreditDomain } from "./declarative-credit-domain.js";
import type { DeclarativeReadFlow } from "./declarative-read-flow.js";
import { freezeSelectorNative, normalizeSelectorNativeExecutionDefinition, selectorNativeFamilyId,
  type SelectorNativeExecutionDefinition } from "./selector-native-definition.js";
import { compileSelectorNativeDiscovery } from "./selector-native-discovery.js";

export interface SelectorNativeCreditDefinition extends Omit<SelectorNativeExecutionDefinition, "domain" | "unsupportedReason"> {
  readonly domain: "credit";
  readonly credit: DeclarativeCreditDomain;
  readonly pricing: {
    readonly flow: DeclarativeReadFlow;
    readonly projection: { readonly checks: readonly unknown[]; readonly rows: unknown };
    readonly liveState?: unknown;
  };
}
const POLICY_BINDING = "selectorCreditPolicyFingerprint";

/** Credit uses the same entry ABI, parameter binding and instance keys. Its
 * additional declaration is the standing-position proof, not an identity gate. */
export function normalizeSelectorNativeCreditDefinition(raw: unknown): SelectorNativeCreditDefinition {
  assertModuleData(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("selector-family Credit definition must be data");
  const author = raw as Record<string, any>;
  if (author.domain !== "credit" || !Object.hasOwn(author, "credit") || !Object.hasOwn(author, "pricing"))
    throw new Error("selector-family Credit requires credit and pricing declarations");
  const { credit, pricing, ...execution } = author;
  const normalized = normalizeSelectorNativeExecutionDefinition({ ...execution, domain: "protocol" });
  if (normalized.programs.length !== 1 || normalized.unsupportedReason)
    throw new Error("selector-family Credit requires one complete position program");
  if (!normalized.programs[0]!.execution || !normalized.programs[0]!.binding?.flow)
    throw new Error("selector-family Credit requires explicit position execution and active binding proof");
  if (Object.hasOwn(normalized.programs[0]!.values?.constants ?? {}, POLICY_BINDING))
    throw new Error("selector-family Credit policy binding is compiler-owned");
  if (!credit || credit.version !== 1 || credit.activeBehaviorProof !== "required" ||
      credit.position?.lifecycle !== "standing-position" || credit.position?.finalSafety !== "position-and-repayment-required" ||
      credit.risk?.blocksPrefixInversion !== true || credit.risk?.proof?.profile !== "new-position-return-and-effects-v1")
    throw new Error("selector-family Credit requires active position, repayment and risk evidence");
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing) ||
      !Object.hasOwn(pricing, "flow") || !Object.hasOwn(pricing, "projection") ||
      Object.keys(pricing).some(key => !["flow", "projection", "liveState"].includes(key)))
    throw new Error("selector-family Credit pricing fields");
  if (!pricing.flow || pricing.flow.version !== 1 || !Array.isArray(pricing.flow.steps) || !pricing.flow.steps.length)
    throw new Error("selector-family Credit requires a current pricing read flow");
  if (!pricing.projection || Object.keys(pricing.projection).some(key => !["checks", "rows"].includes(key)) ||
      !Array.isArray(pricing.projection.checks) || !Object.hasOwn(pricing.projection, "rows"))
    throw new Error("selector-family Credit pricing projection fields");
  return freezeSelectorNative(JSON.parse(JSON.stringify({ ...normalized, domain: "credit", credit, pricing })));
}
export const validateSelectorNativeCreditDefinition = (raw: unknown): void => { normalizeSelectorNativeCreditDefinition(raw); };
export const selectorNativeCreditFamilyId = (raw: Pick<SelectorNativeCreditDefinition, "signature" | "selector">) => selectorNativeFamilyId(raw);

/** The ordinary binding compiler is reused only after v2 normalization. The
 * policy digest makes every candidate/route/Ready proof sensitive to actual
 * credit semantics while optional author metadata never enters a digest. */
export function selectorNativeCreditExecutionDefinition(raw: unknown): SelectorNativeExecutionDefinition {
  const d = normalizeSelectorNativeCreditDefinition(raw), program = d.programs[0]!;
  return normalizeSelectorNativeExecutionDefinition({ format: d.format, selector: d.selector, signature: d.signature,
    domain: "protocol", ...(d.activation ? { activation: d.activation } : {}), programs: [{ ...program,
      values: { ...program.values, constants: { ...program.values?.constants,
        [POLICY_BINDING]: hashCanonical({ credit: d.credit, pricing: d.pricing } as any) } } }] });
}
export function compileSelectorNativeCreditDiscovery(raw: unknown) {
  const d = normalizeSelectorNativeCreditDefinition(raw), base = compileSelectorNativeDiscovery(selectorNativeCreditExecutionDefinition(d));
  return { ...base, manifest: { ...base.manifest, domain: "credit" as const, allowedTaxonomy: [{ slotKind: "lend" as const }] } };
}
