import { getAddress, ZeroAddress } from "ethers";
import type { CallPattern, DiscoverySemantics, FamilyCandidate, UnifiedObservation } from "./adapter-family-plugin.js";
import { OBSERVED_CALL_MAX_AMOUNT, type ObservedCallTemplate } from "./observed-call-template.js";
import { validateObservedExecutionModule, type ObservedExecutionModule } from "./observed-execution-schema.js";
import { createTxEvidenceNomination } from "./tx-evidence-nomination.js";

type Data = Record<string, any>;
interface DiscoveryOwner {
  readonly familyId: string;
  readonly supportedLineages: readonly string[];
  readonly ownedActionAdapterIds: readonly string[];
}
function addressDeclaration(value: unknown): { readonly candidate: { readonly kind: string; readonly addressField: string }; readonly labels: readonly string[] } {
  const definition = value as Data;
  if (!definition || typeof definition !== "object" || Array.isArray(definition) ||
      (definition.version !== undefined && definition.version !== 1))
    throw new Error("observed execution discovery requires an address-only v1 owner; mapped v2 candidates are unsupported");
  const candidate = definition.candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || Object.keys(candidate).length !== 2 ||
      typeof candidate.kind !== "string" || !candidate.kind.trim() || candidate.kind.trim() !== candidate.kind ||
      typeof candidate.addressField !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(candidate.addressField) ||
      ["candidateKind", "constructor", "prototype", "__proto__"].includes(candidate.addressField) ||
      !Array.isArray(definition.labels) || definition.labels.some((label: unknown) => typeof label !== "string" || !label.trim()))
    throw new Error("observed execution discovery requires the owner's explicit address-only candidate projection");
  return { candidate: { kind: candidate.kind, addressField: candidate.addressField }, labels: [...definition.labels] };
}

/** A nomination payload, never a verified identity or a fabricated observation.
 * Reuse the existing owner's address projection before the normal source-bound
 * identity/instance stages. Extra mapped fields may not be guessed from tokens. */
export function observedExecutionCandidateForAddress(definition: unknown, address: string): FamilyCandidate {
  const declaration = addressDeclaration(definition), canonical = getAddress(address);
  if (canonical === ZeroAddress) throw new Error("observed execution candidate address must be nonzero");
  return Object.freeze({ candidateKind: declaration.candidate.kind, [declaration.candidate.addressField]: canonical });
}

/** Match the observed fixed layout without inventing an ABI. Only the proven
 * amount and actor words may differ; all other bytes retain their learned value.
 * The pair is bound again by normal owner route projection, not inferred here. */
export function matchesObservedExecutionCall(template: ObservedCallTemplate, observation: UnifiedObservation): boolean {
  if (observation.kind !== "call" || typeof observation.data !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(observation.data)) return false;
  try {
    if (getAddress(observation.target).toLowerCase() !== template.sample.target.toLowerCase()) return false;
    const data = observation.data.toLowerCase(), expected = template.calldataTemplate.toLowerCase();
    if (data.length !== expected.length || data.slice(0, 10) !== template.selector.toLowerCase()) return false;
    const actors = new Set(template.executorOffsets);
    for (let offset = 4; 2 + offset * 2 < data.length; offset += 32) {
      const start = 2 + offset * 2, word = data.slice(start, start + 64);
      if (offset === template.amountInOffset) {
        const amount = BigInt(`0x${word}`);
        if (amount <= 0n || amount > OBSERVED_CALL_MAX_AMOUNT) return false;
      } else if (actors.has(offset)) {
        if (!/^0{24}[0-9a-f]{40}$/.test(word) || /^0{64}$/.test(word)) return false;
      } else if (word !== expected.slice(start, start + 64)) return false;
    }
    return true;
  } catch { return false; }
}

/** The module adds real-call nomination, not admission. Both SQL discovery and
 * production use this decorator; capture must receive the decorated discovery.
 * The owner still verifies identity, constructs routes and prices them before
 * the central issuer can publish a Ready instance or a Graph handle. */
export function withObservedExecutionDiscovery<C extends FamilyCandidate>(input: {
  readonly base: DiscoverySemantics<C>;
  readonly definition: unknown;
  readonly owner: DiscoveryOwner;
  readonly module?: ObservedExecutionModule;
}): DiscoverySemantics<C> {
  if (!input.module) return input.base;
  validateObservedExecutionModule(input.module);
  const definition = addressDeclaration(input.definition), base = input.base, ownerId = input.owner.familyId;
  for (const entry of input.module.entries) {
    if (entry.familyId !== input.owner.familyId || !input.owner.supportedLineages.includes(entry.lineageId) ||
        !input.owner.ownedActionAdapterIds.includes(entry.adapterId))
      throw new Error("observed execution discovery binding has a different Family, lineage or action owner");
  }
  const templates = [...new Map(input.module.entries.map(entry => [entry.template.templateHash,
    JSON.parse(JSON.stringify(entry.template)) as ObservedCallTemplate])).values()];
  const selectors = [...new Set(templates.map(template => template.selector))].sort();
  const patterns: readonly CallPattern[] = Object.freeze(selectors.map(selector => Object.freeze({
    id: `observed-execution:${selector.slice(2)}`, selector: selector as `0x${string}`,
    signature: `observed-selector:${selector}`, candidateAddress: Object.freeze({ from: "call-target" as const }),
  })));
  const patternSelectors = new Map(patterns.map(pattern => [pattern.id, pattern.selector]));
  const existingIds = new Set([...(base.callPatterns ?? []), ...(base.logPatterns ?? []), ...(base.addressSurfaces ?? [])].map(pattern => pattern.id));
  if (patterns.some(pattern => existingIds.has(pattern.id))) throw new Error("observed execution discovery pattern ID collision");
  return {
    ...base,
    sources: Object.freeze([...new Set([...base.sources, "observed-call" as const])]),
    callPatterns: Object.freeze([...(base.callPatterns ?? []), ...patterns]),
    txSeedNominations: true,
    decodeCandidate(input) {
      const selector = patternSelectors.get(input.matchedPatternId);
      if (!selector) return base.decodeCandidate(input);
      if (!templates.some(template => template.selector === selector && matchesObservedExecutionCall(template, input.observation))) return null;
      return observedExecutionCandidateForAddress(definition, (input.observation as Extract<UnifiedObservation, { kind: "call" }>).target) as C;
    },
    nominate: {
      async nominate(input) {
        const observed: UnifiedObservation[] = [];
        for (const nomination of input.nominations) {
          let candidates: readonly ObservedCallTemplate[];
          try { candidates = templates.filter(template => template.sample.target.toLowerCase() === getAddress(nomination.address).toLowerCase()); }
          catch { candidates = []; }
          const current = { ...input, nominations: [nomination] };
          let derived: readonly UnifiedObservation[] = [];
          if (candidates.length) {
            const nominationCapability = createTxEvidenceNomination({
              opaqueLabels: [...definition.labels, ownerId],
              callPatterns: patterns.filter(pattern => candidates.some(template => template.selector === pattern.selector)),
              allMatches: true,
              acceptObservation: observation => candidates.some(template => matchesObservedExecutionCall(template, observation)),
            });
            derived = await nominationCapability.nominate(current);
          }
          if (!derived.length && base.nominate) derived = await base.nominate.nominate(current);
          observed.push(...derived);
        }
        return Object.freeze(observed);
      },
    },
  };
}
