import { getAddress } from "ethers";
import type {
  CompiledMutationIndex,
  MutationPricingEntry,
  UnifiedObservation,
} from "./adapter-family-plugin.js";

const EMPTY: readonly string[] = Object.freeze([]);
const addressKey = (address: string): string => getAddress(address).toLowerCase();

/** Startup writes replace frozen snapshots; event reads only lowercase and look up. */
export function createMutationLookup() {
  const byAddress = new Map<string, readonly string[]>();
  let addresses: readonly string[] | undefined = EMPTY;
  return Object.freeze({
    add(address: string, keys: readonly string[]): void {
      const normalized = addressKey(address);
      const previous = byAddress.get(normalized) ?? EMPTY;
      const merged = new Set(previous);
      for (const key of keys) {
        if (typeof key !== "string" || key.length === 0) {
          throw new Error("mutation state key must be a non-empty string");
        }
        merged.add(key.toLowerCase());
      }
      if (merged.size === previous.length) return;
      byAddress.set(normalized, Object.freeze([...merged]));
      if (previous === EMPTY) addresses = undefined;
    },
    get(address: string): readonly string[] {
      return byAddress.get(address.toLowerCase()) ?? EMPTY;
    },
    addresses(): readonly string[] {
      return addresses ??= Object.freeze([...byAddress.keys()]);
    },
  });
}

export function compileAddressMutations<D, R>(
  entries: readonly MutationPricingEntry<D, R>[],
  select: (entry: MutationPricingEntry<D, R>) => {
    addresses: readonly string[];
    keys: readonly string[];
  },
  options: {
    kinds: readonly ("log" | "call")[];
    accept?: (observation: UnifiedObservation) => boolean;
  },
): CompiledMutationIndex {
  const lookup = createMutationLookup();
  for (const entry of entries) {
    const dependencies = new Set(entry.dependencies.map(dependency => dependency.toLowerCase()));
    const selected = select(entry);
    for (const address of selected.addresses) {
      const normalized = addressKey(address);
      if (dependencies.has(normalized)) lookup.add(normalized, selected.keys);
    }
  }
  const logs = options.kinds.includes("log"), calls = options.kinds.includes("call");
  const accept = options.accept;
  return Object.freeze({
    dependencies: lookup.addresses(),
    affectedStateKeys({ observation }: { readonly observation: UnifiedObservation }): readonly string[] {
      const address = observation.kind === "log" && logs ? observation.address
        : observation.kind === "call" && calls ? observation.target : undefined;
      if (address === undefined) return EMPTY;
      if (accept && !accept(observation)) return EMPTY;
      return lookup.get(address);
    },
  });
}
