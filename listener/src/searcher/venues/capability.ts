import { findV2LineageByFactory, V2_LINEAGES } from "./v2-lineage.js";
import type { VenueId } from "./registry-ids.js";
export type { VenueId } from "./registry-ids.js";

export type FactoryIdentityPoolAdapter = "univ2" | "univ3";

export type VenueIdentityCatalogEntry =
  | {
      readonly venue: VenueId;
      readonly discovery: {
        readonly mode: "factory";
        readonly factories: readonly string[];
      };
      /**
       * Pool shape attested by this identity source. Runtime support is not
       * declared here; consumers must project it from AdapterFamilyRegistry.
       */
      readonly poolAdapter: FactoryIdentityPoolAdapter;
      readonly compatibility: "standard";
    }
  | {
      readonly venue: VenueId;
      readonly discovery: {
        readonly mode: "factory";
        readonly factories: readonly string[];
      };
      /** Known factory whose execution semantics must not reuse a standard family. */
      readonly compatibility: "incompatible";
    }
  | {
      readonly venue: VenueId;
      readonly discovery: {
        readonly mode: "pool-registry";
        readonly registries: readonly string[];
      };
      readonly poolAdapter: "dodo-v2";
      readonly compatibility: "standard";
    };

/**
 * Identity roots only.
 *
 * This catalog deliberately contains no runtime readiness booleans and no
 * protocol/singleton instance seeds. Execution support comes from the sole
 * AdapterFamilyRegistry; protocol instances come from each registered
 * family's declared venues or behavior discovery. V2 fee evidence remains in
 * V2_LINEAGES and is checked separately before admission/discovery.
 */
export const VENUE_IDENTITY_CATALOG: readonly VenueIdentityCatalogEntry[] =
  Object.freeze([
    // Explicit incompatibilities precede generated V2 lineages and also win
    // in findVenueByFactory. A refreshed lineage can never relabel them.
    {
      venue: "panoramaswap-v1",
      discovery: {
        mode: "factory",
        factories: ["0x82Eeb5A22A25310ac15352197d92d6C17A49602e"],
      },
      compatibility: "incompatible",
    },
    {
      venue: "smardex",
      discovery: {
        mode: "factory",
        factories: [
          "0x7753F36E711B66a0350a753aba9F5651BAE76A1D",
          "0xB878DC600550367e14220d4916Ff678fB284214F",
        ],
      },
      compatibility: "incompatible",
    },
    ...V2_LINEAGES.map((descriptor): VenueIdentityCatalogEntry => ({
      venue: descriptor.venue,
      discovery: { mode: "factory", factories: [descriptor.factory] },
      poolAdapter: "univ2",
      compatibility: "standard",
    })),
    {
      venue: "univ3",
      discovery: {
        mode: "factory",
        factories: ["0x1F98431c8aD98523631AE4a59f267346ea31F984"],
      },
      poolAdapter: "univ3",
      compatibility: "standard",
    },
    {
      // Pancake V3 is a distinct identity with standard V3 execution shape.
      venue: "pancake-v3",
      discovery: {
        mode: "factory",
        factories: ["0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"],
      },
      poolAdapter: "univ3",
      compatibility: "standard",
    },
    {
      venue: "univ3-fork-075c",
      discovery: {
        mode: "factory",
        factories: ["0x075C42cD233a1c723c0F18f6dd575c8d679FEA85"],
      },
      poolAdapter: "univ3",
      compatibility: "standard",
    },
    {
      venue: "dodo-v2",
      discovery: {
        mode: "pool-registry",
        registries: [
          "0x72d220cE168C4f361dD4deE5D826a01AD8598f6C",
          "0x5336edE8F971339F6c0e304c66ba16F1296A2Fbe",
          "0x6fdDB76c93299D985f4d3FC7ac468F9A168577A4",
        ],
      },
      poolAdapter: "dodo-v2",
      compatibility: "standard",
    },
  ]);

export type FactoryIdentityCatalogEntry = Extract<
  VenueIdentityCatalogEntry,
  { readonly discovery: { readonly mode: "factory" } }
>;

export type StandardFactoryIdentityCatalogEntry = Extract<
  FactoryIdentityCatalogEntry,
  { readonly compatibility: "standard" }
>;

export function findVenueIdentity(
  venue: string | null | undefined,
): VenueIdentityCatalogEntry | null {
  const key = (venue ?? "").toLowerCase();
  return VENUE_IDENTITY_CATALOG.find((entry) => entry.venue === key) ?? null;
}

export function findVenueByFactory(
  factory: string | null | undefined,
): FactoryIdentityCatalogEntry | null {
  if (!factory) return null;
  const matches = VENUE_IDENTITY_CATALOG.filter(
    (entry): entry is FactoryIdentityCatalogEntry =>
      entry.discovery.mode === "factory" &&
      entry.discovery.factories.some((pattern) =>
        addressPatternMatches(pattern, factory)
      ),
  );
  return matches.find((entry) => entry.compatibility === "incompatible") ??
    matches[0] ??
    null;
}

export function findVenueByPoolRegistry(
  registry: string | null | undefined,
): Extract<
  VenueIdentityCatalogEntry,
  { readonly discovery: { readonly mode: "pool-registry" } }
> | null {
  if (!registry) return null;
  return VENUE_IDENTITY_CATALOG.find(
    (entry): entry is Extract<
      VenueIdentityCatalogEntry,
      { readonly discovery: { readonly mode: "pool-registry" } }
    > =>
      entry.discovery.mode === "pool-registry" &&
      entry.discovery.registries.some((pattern) =>
        addressPatternMatches(pattern, registry)
      ),
  ) ?? null;
}

/**
 * Join identity roots with the registry-derived mature DEX projection.
 * Removing a family registration therefore removes all of its factory sources
 * without editing this catalog. Unmeasured V2 lineages always fail closed.
 */
export function factoryDiscoverySourcesForPoolAdapters(
  registeredPoolAdapters: readonly string[],
): readonly StandardFactoryIdentityCatalogEntry[] {
  const registered = new Set(registeredPoolAdapters);
  const selected: StandardFactoryIdentityCatalogEntry[] = [];
  for (const entry of VENUE_IDENTITY_CATALOG) {
    if (
      !isStandardFactoryIdentity(entry) ||
      !registered.has(entry.poolAdapter)
    ) {
      continue;
    }
    const isSelectedIdentity = entry.discovery.factories.every(
      (factory) => findVenueByFactory(factory) === entry,
    );
    if (!isSelectedIdentity) continue;
    if (
      entry.poolAdapter === "univ2" &&
      entry.discovery.factories.some(
        (factory) => findV2LineageByFactory(factory)?.measuredFeeRule == null,
      )
    ) {
      continue;
    }
    selected.push(entry);
  }
  return Object.freeze(selected);
}

function isStandardFactoryIdentity(
  entry: VenueIdentityCatalogEntry,
): entry is StandardFactoryIdentityCatalogEntry {
  return entry.discovery.mode === "factory" &&
    entry.compatibility === "standard";
}

export function addressPatternMatches(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (!p.includes("...")) return p === v;
  const [prefix, suffix = ""] = p.split("...");
  return v.startsWith(prefix) && (!suffix || v.endsWith(suffix));
}
