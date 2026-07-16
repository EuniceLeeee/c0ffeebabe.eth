export type VenueId =
  | "unknown"
  | "univ2"
  | "sushiswap-v2"
  | "univ3"
  | "pancake-v3"
  | "univ3-fork-075c"
  | "panoramaswap-v1"
  | "univ4"
  | "balancer-v3"
  | "curve"
  | "curve-nr"
  | "goldx"
  | "psm"
  | "fluid"
  | "smardex"
  | "ousd"
  | "enzyme"
  | "rigelswap"
  | "difx";

export type VenueDiscovery =
  | { mode: "factory"; factories: readonly string[] }
  | { mode: "seed"; seeds?: readonly string[] }
  | { mode: "custom"; seeds?: readonly string[] };

export interface VenueCapability {
  venue: VenueId;
  discovery: VenueDiscovery;
  /** Proven adapter for this factory lineage; provisional admission may retain the event-derived shape. */
  runtimeAdapter?: "univ2" | "univ3" | "balancer-v3";
  discoverable: boolean;
  quotable: boolean;
  buildable: boolean;
  supported_in_prod: boolean;
}

// Source-of-truth cross-check:
// - token-graph ADAPTER_MAP supports curve, curve-nr, univ2, univ3, univ4, psm, fluid-vault, fluid-dex.
// - quoter.ts supports curve*, univ2-swap, univ3-swap, univ4-unlock, psm, fluid-dex-swap, fluid-vault.
// - plan-builder.ts supports those same swap/lend adapter ids.
// - ActionAdapter registry registers univ2/univ3/univ4/curve/psm/fluid adapters.
// - path-template.ts includes psm/univ4/univ3/univ2/curve* swap adapters.
export const VENUE_CAPABILITIES: readonly VenueCapability[] = [
  {
    venue: "univ2",
    discovery: { mode: "factory", factories: ["0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"] },
    runtimeAdapter: "univ2",
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    venue: "sushiswap-v2",
    discovery: { mode: "factory", factories: ["0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac"] },
    runtimeAdapter: "univ2",
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    venue: "univ3",
    discovery: { mode: "factory", factories: ["0x1F98431c8aD98523631AE4a59f267346ea31F984"] },
    runtimeAdapter: "univ3",
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    // Pancake V3 remains a distinct venue even though its approved runtime adapter is V3-compatible.
    venue: "pancake-v3",
    discovery: { mode: "factory", factories: ["0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"] },
    runtimeAdapter: "univ3",
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    // Coffee fixture 20260702: exact factory verified and the missing graph leg has a pinned fixture.
    venue: "univ3-fork-075c",
    discovery: { mode: "factory", factories: ["0x075C42cD233a1c723c0F18f6dd575c8d679FEA85"] },
    runtimeAdapter: "univ3",
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    // Standard-looking V2 events are insufficient: this venue needs its own invariant replay.
    venue: "panoramaswap-v1",
    discovery: { mode: "factory", factories: ["0x82Eeb5A22A25310ac15352197d92d6C17A49602e"] },
    discoverable: false,
    quotable: false,
    buildable: false,
    supported_in_prod: false,
  },
  {
    venue: "univ4",
    discovery: { mode: "custom", seeds: ["0x000000000004444c5dc75cB358380D2e3dE08A90"] },
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    venue: "balancer-v3",
    discovery: { mode: "custom", seeds: ["0xbA1333333333a1BA1108E8412f11850A5C319bA9"] },
    runtimeAdapter: "balancer-v3",
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    venue: "curve",
    discovery: { mode: "custom" },
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    venue: "goldx",
    discovery: { mode: "seed", seeds: ["0x355C665e101B9DA58704A8fDDb5FeeF210eF20c0"] },
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    venue: "curve-nr",
    discovery: { mode: "custom" },
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    venue: "psm",
    discovery: { mode: "seed", seeds: ["0xf6e72Db5454dd049d0788e411b06CfAF16853042"] },
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    venue: "fluid",
    discovery: {
      mode: "seed",
      seeds: [
        "0xee327311D8640156E87eC33ea55FcbF2309e0ce6", // vault wstUSR/USDC
        "0xea734B615888c669667038D11950f44b177F15C0", // DEX USDC/USDT
      ],
    },
    discoverable: true,
    quotable: true,
    buildable: true,
    supported_in_prod: true,
  },
  {
    // factories resolved on-chain from tx 0x4db34b5c…d4b606 pools 0xf3a4…0179 / 0xae26…97e4.
    venue: "smardex",
    discovery: { mode: "factory", factories: ["0x7753F36E711B66a0350a753aba9F5651BAE76A1D", "0xB878DC600550367e14220d4916Ff678fB284214F"] },
    discoverable: false,
    quotable: false,
    buildable: false,
    supported_in_prod: false,
  },
  {
    // OUSD has no factory() — seeds are the specific AMM pools seen on-chain (bytecode-signature fallback also covers it).
    venue: "ousd",
    discovery: { mode: "seed", seeds: ["0x1791bbfa950f7db0b52ecb0729584bad886665f5", "0x6d18e1a7faeb1f0467a77c0d293872ab685426dc"] },
    discoverable: false,
    quotable: false,
    buildable: false,
    supported_in_prod: false,
  },
  {
    // Enzyme redeemSharesInKind vault (non-AMM); seed is the vault seen on-chain.
    venue: "enzyme",
    discovery: { mode: "seed", seeds: ["0x4d54abd78590bf94c8406d019aff724dab659a84"] },
    discoverable: false,
    quotable: false,
    buildable: false,
    supported_in_prod: false,
  },
  {
    // v2-fork: quote/build reuse univ2 math once epic #2 promotes the factory into discovery.
    venue: "rigelswap",
    discovery: { mode: "factory", factories: ["0x880AE0A0aF8FF8f31F51599891baa8A65dB5e152"] },
    discoverable: false,
    quotable: true,
    buildable: true,
    supported_in_prod: false,
  },
  {
    // v2-fork: same as rigelswap.
    venue: "difx",
    discovery: { mode: "factory", factories: ["0xe5aaA01C4732d6B20cBb8522803f84a2cDf96334"] },
    discoverable: false,
    quotable: true,
    buildable: true,
    supported_in_prod: false,
  },
];

export function findVenueCapability(venue: string | null | undefined): VenueCapability | null {
  const key = (venue ?? "").toLowerCase();
  return VENUE_CAPABILITIES.find((entry) => entry.venue === key) ?? null;
}

export function findVenueByFactory(factory: string | null | undefined): VenueCapability | null {
  if (!factory) return null;
  return VENUE_CAPABILITIES.find((entry) =>
    entry.discovery.mode === "factory" &&
    entry.discovery.factories.some((pattern) => addressPatternMatches(pattern, factory)),
  ) ?? null;
}

export function findVenueBySeed(address: string | null | undefined): VenueCapability | null {
  if (!address) return null;
  return VENUE_CAPABILITIES.find((entry) =>
    "seeds" in entry.discovery &&
    (entry.discovery.seeds ?? []).some((pattern) => addressPatternMatches(pattern, address)),
  ) ?? null;
}

export function addressPatternMatches(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (!p.includes("...")) return p === v;
  const [prefix, suffix = ""] = p.split("...");
  return v.startsWith(prefix) && (!suffix || v.endsWith(suffix));
}
