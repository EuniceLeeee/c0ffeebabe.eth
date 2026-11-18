import type { CompiledMutationIndex, MutationPricingEntry, MutationSemantics, UnifiedObservation } from "./adapter-family-plugin.js";

const EMPTY: readonly string[] = Object.freeze([]);
const touchedAddress = (observation: UnifiedObservation): string | undefined => observation.kind === "call"
  ? observation.target.toLowerCase() : observation.kind === "log" ? observation.address.toLowerCase() : undefined;
const unique = (items: readonly string[]): readonly string[] => Object.freeze([...new Set(items)]);

/** Unknown call semantics cannot justify a protocol-specific event filter.
 * Keep the owner's mutation behavior, and conservatively invalidate learned
 * pricing groups on any call/log at their declared dependencies. These are
 * existing pricing state keys, never new identities, routes or Ready claims.
 */
export function createObservedExecutionMutation<Descriptor, Route>(input: {
  readonly base?: MutationSemantics<Descriptor, Route>;
  readonly isLearned: (route: Route) => boolean;
  readonly stateKey: (route: Route) => string;
  readonly dependencies: (input: { readonly descriptor: Descriptor; readonly routes: readonly Route[] }) => readonly string[];
}): MutationSemantics<Descriptor, Route> {
  type Entry = MutationPricingEntry<Descriptor, Route>;
  const keysFor = (routes: readonly Route[]) => unique(routes.map(input.stateKey));
  function stateKey(entry: Entry): string {
    const keys = keysFor(entry.routes), key = entry.stateKey ?? (keys.length === 1 ? keys[0] : undefined);
    if (typeof key !== "string" || !key || keys.some(value => value !== key))
      throw new Error("observed mutation entry must identify one existing pricing state group");
    return key;
  }
  const ownerIndex = (entries: readonly Entry[]): CompiledMutationIndex => {
    if (input.base?.compile) return input.base.compile({ entries });
    // Preserve the framework's optional-mutation fallback without scanning
    // unrelated entries on every event. The original callback still receives
    // its own descriptor and full route group when that dependency is hit.
    const byAddress = new Map<string, readonly Entry[]>();
    for (const entry of entries) for (const dependency of new Set(entry.dependencies.map(value => value.toLowerCase())))
      byAddress.set(dependency, Object.freeze([...(byAddress.get(dependency) ?? []), entry]));
    return Object.freeze({ dependencies: Object.freeze([...byAddress.keys()]), affectedStateKeys({ observation }: { readonly observation: UnifiedObservation }) {
      const address = touchedAddress(observation);
      if (address === undefined) return EMPTY;
      const entries = byAddress.get(address);
      return entries ? unique(entries.flatMap(entry => input.base
        ? input.base.affectedStateKeys({ descriptor: entry.descriptor, routes: entry.routes, observation }) : [stateKey(entry)])) : EMPTY;
    } });
  };
  return {
    compile({ entries }) {
      const base = ownerIndex(entries);
      const byAddress = new Map<string, readonly string[]>();
      for (const entry of entries) {
        if (!entry.routes.some(input.isLearned)) continue;
        const key = stateKey(entry);
        for (const dependency of entry.dependencies) {
          const address = dependency.toLowerCase();
          byAddress.set(address, unique([...(byAddress.get(address) ?? EMPTY), key]));
        }
      }
      if (!byAddress.size) return base;
      // Capture only frozen lookup results, not route/descriptor evaluators.
      // Opaque state key casing is preserved; only address keys are normalized.
      return Object.freeze({ dependencies: unique([...base.dependencies, ...byAddress.keys()]), affectedStateKeys({ observation }: { readonly observation: UnifiedObservation }) {
        const original = base.affectedStateKeys({ observation }), address = touchedAddress(observation);
        const learned = address === undefined ? EMPTY : byAddress.get(address) ?? EMPTY;
        return learned.length ? unique([...original, ...learned]) : original;
      } });
    },
    affectedStateKeys(current) {
      const address = touchedAddress(current.observation);
      const learned = current.routes.filter(input.isLearned);
      const original = input.base?.affectedStateKeys(current);
      if (input.base && !learned.length) return original!;
      const dependencies = new Set(input.dependencies(current).map(value => value.toLowerCase()));
      if (address === undefined || !dependencies.has(address)) return original ?? EMPTY;
      if (!input.base) return keysFor(current.routes);
      return learned.length ? unique([...original!, ...keysFor(learned)]) : original!;
    },
  };
}
