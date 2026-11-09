import type { DiscoverySemantics, FamilyCandidate } from "./adapter-family-plugin.js";
import { compileDeclarativeDiscovery } from "./declarative-discovery.js";
import { compileDeclarativeValues } from "./declarative-values.js";
import { normalizeDeclarativeVariant } from "./declarative-variant.js";
import { readFamilyModules } from "./declarative-family-modules.js";
import { compileSignedBlockEvidence } from "./declarative-runtime-evidence.js";

type Data = Record<string, any>;
/** Shared by production and the query-side discovery projection. */
export function assembleDeclarativeDiscovery<C extends FamilyCandidate>(definition: any,
  values: ReturnType<typeof compileDeclarativeValues>, signed?: Partial<DiscoverySemantics<C>>): DiscoverySemantics<C> {
  const base = compileDeclarativeDiscovery<C>(definition, values);
  return signed ? { ...base, ...signed } : base;
}

/** Pure projection of the same root/ordered children bound by the production
 * entry. No identity, price, execution or node transport is loaded in SQL.
 * Children currently specialize identity/execution, not discovery. Keep them
 * bound and validate their lineage rather than silently accepting another set.
 */
export function compileDeclarativeFamilyDiscovery(raw: Data, children: readonly Data[] = []) {
  if (raw.version !== 2 || raw.scope?.family !== raw.manifest?.familyId ||
      raw.production?.domain !== raw.manifest?.domain || !Array.isArray(raw.variantFiles) ||
      raw.variantFiles.length !== children.length) throw new Error("invalid discovery Family binding");
  const variants = [raw.standard, ...children].map(normalizeDeclarativeVariant);
  if (new Set(variants.map(v => v.id)).size !== variants.length ||
      variants.some(v => !raw.manifest.supportedLineages.includes(v.lineageId)))
    throw new Error("invalid discovery variant binding");
  const primary = variants[0]!;
  const modules = readFamilyModules(raw.modules, primary.modules);
  const { modules: _modules, ...definition } = primary;
  const values = compileDeclarativeValues(definition, {}, modules.get("math"));
  const signedDefinition = modules.get<Data>("signedBlockEvidence");
  if (signedDefinition && raw.production.domain !== "swap") throw new Error("signed block evidence requires Swap");
  const signed = signedDefinition && compileSignedBlockEvidence(raw.manifest.familyId, signedDefinition, values);
  return { manifest: raw.manifest, discovery: assembleDeclarativeDiscovery(raw.discovery.definition, values, signed?.discovery) };
}
