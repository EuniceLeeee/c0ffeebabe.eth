import { POOL_REGISTRY } from "../../../listener/src/searcher/planner/token-graph.js";
import { ADDR, lower, TOPICS } from "../registry/protocols.js";
import type { VenueScanInput } from "./venue-evidence.js";

/**
 * PER-TX loop-coverage classifier — the canonical fold of the throwaway per-tx classifier.
 *
 * Where the per-VENUE path (venue-evidence.ts) asks "what edge kinds does THIS emitter show across the
 * whole export?", this path asks a stricter per-TX question: is every venue this ONE tx touched inside
 * OUR supported set, and does it contain a REAL protocol leg (one of our vaults emitting an ERC4626
 * Deposit/Withdraw in this tx)? A tx is `fullyCovered` iff it has >=1 real vault leg AND zero GAP venues
 * — i.e. the whole atomic loop could in principle be reconstructed through venues+adapters we already have.
 *
 * The four supported classes and their REAL sets (do NOT hand-guess a subset — these are the authoritative
 * literals; the SWAP set here is intentionally BROADER than edge-kinds.ts SWAP_TOPICS because the coverage
 * question includes univ2 Sync / the curve TokenExchange uint256 variant / the curve router Exchange, which
 * the per-venue edge-kind derivation does not need):
 *   - supported-swap    : the emitter logs one of SUPPORTED_SWAP_TOPICS (univ2/v3/v4/pancake/curve/balancer/dodo).
 *   - our-vault         : the emitter is one of OUR POOL_REGISTRY vault/protocol addresses AND it emits a
 *                         REAL ERC4626 event (Deposit 0xdcbc1c05 / Withdraw 0xfbde797d) in THIS tx.
 *   - token             : the emitter only logs token topics (ERC20 Transfer/Approval + WETH wrap/unwrap).
 *   - flashloan         : Balancer V2 Vault / Aave V3 Pool — arb FUNDING, not an arb leg (excluded from gaps).
 *   - GAP               : anything else = an unsupported venue we could not route through.
 *
 * A vault-share token that is merely Transferred in a swap is a TOKEN here, not a protocol leg — only an
 * actual ERC4626 Deposit/Withdraw emitted BY one of our vault addresses counts as `our-vault`.
 */

// ── SWAP topics (authoritative literals; broader than edge-kinds.ts SWAP_TOPICS on purpose) ──
// Full 32-byte topic0s (derived via ethers.id, cross-checked against the operator-provided 4-byte prefixes).
export const SUPPORTED_SWAP_TOPICS: ReadonlySet<string> = new Set(
  [
    TOPICS.univ2Swap, // 0xd78ad95f
    "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1", // univ2 Sync(uint112,uint112) 0x1c411e9a
    TOPICS.univ3Swap, // 0xc42079f9
    TOPICS.pancakeV3Swap, // 0x19b47279
    TOPICS.univ4Swap, // 0x40e9cecb (PoolManager singleton)
    TOPICS.curveTokenExchange, // TokenExchange int128 variant 0x8b3e96f2
    "0xb2e76ae99761dc136e598d4a629bb347eccb9532a5f8bbd72e18467c3c34cc98", // curve TokenExchange(address,uint256,uint256,uint256,uint256) 0xb2e76ae9 — easy-to-miss uint256 variant
    TOPICS.curveTokenExchangeUnderlying, // 0xd013ca23
    TOPICS.balancerV2Swap, // 0x2170c741 — supported per edge-kinds.ts SWAP set
    TOPICS.dodoSwap, // 0xc2c0245e — supported per edge-kinds.ts SWAP set
  ].map(lower),
);

// Curve router Exchange — matched by the operator-provided 4-byte selector prefix 0x56d0661e (the full
// 32-byte topic0 is not re-derivable from the router ABI variants we tried; prefix-match is authoritative
// and safe here — no other supported/token/flashloan topic shares this prefix).
const CURVE_ROUTER_EXCHANGE_PREFIX = "0x56d0661e";

// ── ERC4626 protocol-leg event topics (a REAL protocol action, not a token move) ──
export const ERC4626_EVENT_TOPICS: ReadonlySet<string> = new Set(
  [TOPICS.erc4626Deposit, TOPICS.erc4626Withdraw].map(lower),
);

// ── Token-only topics (an emitter with ONLY these is a plain token, not a venue) ──
export const TOKEN_TOPICS: ReadonlySet<string> = new Set(
  [TOPICS.transfer, "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", // Approval
    TOPICS.wethDeposit, TOPICS.wethWithdrawal].map(lower),
);

// ── Flashloan funding venues (NOT arb legs — excluded from the gap set) ──
export const FLASHLOAN_ADDRESSES: ReadonlySet<string> = new Set(
  ["0xba12222222228d8ba445958a75a0704d566bf2c8", // Balancer V2 Vault
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", // Aave V3 Pool
  ].map(lower),
);

/** OUR protocol venues = the `.address` of every POOL_REGISTRY entry whose adapter is a protocol adapter
 *  (erc4626 / psm / wsteth / fluid*). These are the addresses whose ERC4626 events make a real protocol leg. */
export const OUR_VAULT_ADDRESSES: ReadonlySet<string> = new Set(
  POOL_REGISTRY.filter((p) =>
    p.adapter === "erc4626"
    || p.adapter === "psm"
    || p.adapter === "wsteth"
    || p.adapter === "fluid-vault"
    || p.adapter === "fluid-dex",
  ).map((p) => lower(p.address)),
);

export type VenueClass =
  | "supported-swap"
  | "our-vault"
  | "token"
  | "flashloan"
  | "gap";

export interface ClassifiedVenue {
  addr: string;
  klass: VenueClass;
  topic0s: string[];
}

export interface TxLoopCoverage {
  tx: string;
  /** OUR vault addresses that emitted a real ERC4626 event in this tx. */
  vaults: string[];
  /** count of distinct supported-swap venues touched. */
  swapVenues: number;
  /** unsupported venues we could not route through (excludes token/flashloan/our-vault/swap). */
  gapVenues: Array<{ addr: string; topic0: string }>;
  /** true ⇔ zero gap venues AND >=1 real vault leg (a candidate fully-covered protocol loop). */
  fullyCovered: boolean;
  /** full per-venue classification (audit trail). */
  venues: ClassifiedVenue[];
}

/** Classify one emitter given its distinct topic0s in this tx. */
function classifyEmitter(addr: string, topic0s: string[]): VenueClass {
  const set = new Set(topic0s);
  // Our-vault requires BOTH: it's one of our protocol addresses AND it emitted a real ERC4626 event here.
  if (OUR_VAULT_ADDRESSES.has(addr) && topic0s.some((t) => ERC4626_EVENT_TOPICS.has(t))) return "our-vault";
  if (FLASHLOAN_ADDRESSES.has(addr)) return "flashloan";
  if (topic0s.some((t) => SUPPORTED_SWAP_TOPICS.has(t) || t.startsWith(CURVE_ROUTER_EXCHANGE_PREFIX))) {
    return "supported-swap";
  }
  // A vault-share token merely Transferred, or any plain token, is token-only.
  if (topic0s.length > 0 && [...set].every((t) => TOKEN_TOPICS.has(t))) return "token";
  return "gap";
}

export function classifyTxLoopCoverage(input: VenueScanInput): TxLoopCoverage {
  const topicsByEmitter = new Map<string, Set<string>>();
  for (const log of input.receiptLogs) {
    const addr = lower(log.address);
    if (!addr) continue;
    const t0 = topic0Of(log.topics);
    if (!t0) continue;
    const set = topicsByEmitter.get(addr);
    if (set) set.add(t0);
    else topicsByEmitter.set(addr, new Set([t0]));
  }

  const venues: ClassifiedVenue[] = [];
  const vaults: string[] = [];
  const gapVenues: Array<{ addr: string; topic0: string }> = [];
  let swapVenues = 0;

  for (const [addr, topicSet] of topicsByEmitter) {
    const topic0s = [...topicSet];
    const klass = classifyEmitter(addr, topic0s);
    venues.push({ addr, klass, topic0s });
    if (klass === "our-vault") vaults.push(addr);
    else if (klass === "supported-swap") swapVenues++;
    else if (klass === "gap") gapVenues.push({ addr, topic0: topic0s[0] ?? "" });
  }

  return {
    tx: input.txHash ?? "",
    vaults: vaults.sort(),
    swapVenues,
    gapVenues: gapVenues.sort((a, b) => a.addr.localeCompare(b.addr)),
    fullyCovered: gapVenues.length === 0 && vaults.length >= 1,
    venues: venues.sort((a, b) => a.addr.localeCompare(b.addr)),
  };
}

function topic0Of(topics: unknown): string {
  return Array.isArray(topics) && typeof topics[0] === "string" ? lower(topics[0]) : "";
}
