import { POOL_REGISTRY } from "../../../listener/src/searcher/planner/token-graph.js";
import { ADDR, lower, TOPICS } from "../registry/protocols.js";
import type { VenueScanInput } from "./venue-evidence.js";

/**
 * PER-TX loop-coverage classifier — the canonical fold of the throwaway per-tx classifier.
 *
 * Where the per-VENUE path (venue-evidence.ts) asks "what edge kinds does THIS emitter show across the
 * whole export?", this path asks a stricter per-TX question: is every venue this ONE tx touched inside
 * OUR supported set, and does it contain a REAL protocol leg (one of our vaults emitting an ERC4626
 * Deposit/Withdraw in this tx)? This is deliberately a RECEIPT-LOG candidate classifier, not an
 * atomicity or route-closure oracle. Position conservation, helper inventory and call ordering require
 * bundle-postmortem/trace. `protocolAdapterCandidate` only means that every NAMED protocol event in the
 * receipt maps to an adapter we already have.
 *
 * The classes and their REAL sets (do NOT hand-guess a subset — these are the authoritative
 * literals; the SWAP set here is intentionally BROADER than edge-kinds.ts SWAP_TOPICS because the coverage
 * question includes univ2 Sync / the curve TokenExchange uint256 variant / the curve router Exchange, which
 * the per-venue edge-kind derivation does not need):
 *   - supported-swap    : the emitter logs one of SUPPORTED_SWAP_TOPICS
 *                         (univ2/v3/v4/pancake/curve/balancer/dodo/fluid).
 *   - our-vault         : the emitter is one of OUR POOL_REGISTRY ERC4626 addresses AND it emits a
 *                         REAL ERC4626 event (Deposit 0xdcbc1c05 / Withdraw 0xfbde797d) in THIS tx.
 *   - our-protocol      : a non-ERC4626 protocol action (currently Sky PSM) maps to our registered adapter.
 *   - unsupported-protocol: a named protocol event is real, but its emitter has no matching registered adapter.
 *   - token             : the emitter only logs token topics (ERC20 Transfer/Approval + WETH wrap/unwrap).
 *   - flashloan         : Balancer V2 Vault / Aave V3 Pool — arb FUNDING, not an arb leg (excluded from gaps).
 *   - unclassified-emitter: anything else. It is evidence to trace, NOT automatically a route gap; helper,
 *                           accounting and token-specific events commonly land here.
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
    TOPICS.fluidDexSwap, // 0xdc004dbc — Fluid DEX T1 (receipt-verified 0x9be73297)
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

const PSM_EVENT_TOPICS: ReadonlySet<string> = new Set(
  [TOPICS.psmSellGem, TOPICS.psmBuyGem].map(lower),
);

/** Named protocol evidence is strong enough to say "unsupported protocol" when no adapter matches.
 *  Morpho Supply/Withdraw is intentionally absent: a vault may emit it internally and that does not make
 *  the transaction a credit/protocol leg we take (decision-log F-007/F-009). */
const NAMED_PROTOCOL_EVENT_TOPICS: ReadonlySet<string> = new Set(
  [
    ...ERC4626_EVENT_TOPICS,
    ...PSM_EVENT_TOPICS,
    TOPICS.liquityTroveOperation,
    TOPICS.liquityTroveUpdated,
    TOPICS.liquityBatchUpdated,
  ].map(lower),
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

const REGISTERED_ADAPTER_BY_ADDRESS: ReadonlyMap<string, string> = new Map(
  POOL_REGISTRY.map((entry) => [lower(entry.address), entry.adapter]),
);

/** Backward-compatible export used by callers that need our registered ERC4626 vault set. */
export const OUR_VAULT_ADDRESSES: ReadonlySet<string> = new Set(
  POOL_REGISTRY.filter((entry) => entry.adapter === "erc4626").map((entry) => lower(entry.address)),
);

export type VenueClass =
  | "supported-swap"
  | "our-vault"
  | "our-protocol"
  | "unsupported-protocol"
  | "token"
  | "flashloan"
  | "unclassified-emitter";

export interface ClassifiedVenue {
  addr: string;
  klass: VenueClass;
  topic0s: string[];
}

export interface TxLoopCoverage {
  tx: string;
  /** OUR vault addresses that emitted a real ERC4626 event in this tx. */
  vaults: string[];
  /** All registered protocol venues evidenced in the receipt (includes vaults and PSM). */
  protocolVenues: string[];
  /** count of distinct supported-swap venues touched. */
  swapVenues: number;
  /** Named protocol events whose emitter has no matching registered adapter. */
  protocolVenueGaps: Array<{ addr: string; topic0: string }>;
  /** Unknown emitters needing trace/call-order inspection; NOT automatically route gaps. */
  unclassifiedEmitters: Array<{ addr: string; topic0: string }>;
  /** @deprecated compatibility alias for protocolVenueGaps. */
  gapVenues: Array<{ addr: string; topic0: string }>;
  /** Receipt evidence maps every named protocol leg to an adapter. Still requires a trace. */
  protocolAdapterCandidate: boolean;
  /** Strict legacy signal: no known protocol gap AND no unclassified emitter. Not proof of closure. */
  fullyCovered: boolean;
  coverageScope: "receipt_log_emitters_only";
  comparability: "requires_trace";
  /** full per-venue classification (audit trail). */
  venues: ClassifiedVenue[];
}

/** Classify one emitter given its distinct topic0s in this tx. */
function classifyEmitter(addr: string, topic0s: string[]): VenueClass {
  const set = new Set(topic0s);
  const adapter = REGISTERED_ADAPTER_BY_ADDRESS.get(addr);
  // Adapter support requires BOTH the registered target and evidence for that adapter's real action.
  if (adapter === "erc4626" && topic0s.some((t) => ERC4626_EVENT_TOPICS.has(t))) return "our-vault";
  if (adapter === "psm" && topic0s.some((t) => PSM_EVENT_TOPICS.has(t))) return "our-protocol";
  if (FLASHLOAN_ADDRESSES.has(addr)) return "flashloan";
  if (topic0s.some((t) => SUPPORTED_SWAP_TOPICS.has(t) || t.startsWith(CURVE_ROUTER_EXCHANGE_PREFIX))) {
    return "supported-swap";
  }
  if (topic0s.some((t) => NAMED_PROTOCOL_EVENT_TOPICS.has(t))) return "unsupported-protocol";
  // A vault-share token merely Transferred, or any plain token, is token-only.
  if (topic0s.length > 0 && [...set].every((t) => TOKEN_TOPICS.has(t))) return "token";
  return "unclassified-emitter";
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
  const protocolVenues: string[] = [];
  const protocolVenueGaps: Array<{ addr: string; topic0: string }> = [];
  const unclassifiedEmitters: Array<{ addr: string; topic0: string }> = [];
  let swapVenues = 0;

  for (const [addr, topicSet] of topicsByEmitter) {
    const topic0s = [...topicSet];
    const klass = classifyEmitter(addr, topic0s);
    venues.push({ addr, klass, topic0s });
    if (klass === "our-vault") {
      vaults.push(addr);
      protocolVenues.push(addr);
    } else if (klass === "our-protocol") protocolVenues.push(addr);
    else if (klass === "supported-swap") swapVenues++;
    else if (klass === "unsupported-protocol") {
      protocolVenueGaps.push({
        addr,
        topic0: topic0s.find((topic) => NAMED_PROTOCOL_EVENT_TOPICS.has(topic)) ?? "",
      });
    } else if (klass === "unclassified-emitter") {
      unclassifiedEmitters.push({ addr, topic0: topic0s[0] ?? "" });
    }
  }

  const sortedProtocolGaps = protocolVenueGaps.sort((a, b) => a.addr.localeCompare(b.addr));
  const sortedUnclassified = unclassifiedEmitters.sort((a, b) => a.addr.localeCompare(b.addr));
  const protocolAdapterCandidate = protocolVenues.length >= 1 && sortedProtocolGaps.length === 0;

  return {
    tx: input.txHash ?? "",
    vaults: vaults.sort(),
    protocolVenues: protocolVenues.sort(),
    swapVenues,
    protocolVenueGaps: sortedProtocolGaps,
    unclassifiedEmitters: sortedUnclassified,
    gapVenues: sortedProtocolGaps,
    protocolAdapterCandidate,
    fullyCovered: protocolAdapterCandidate && sortedUnclassified.length === 0,
    coverageScope: "receipt_log_emitters_only",
    comparability: "requires_trace",
    venues: venues.sort((a, b) => a.addr.localeCompare(b.addr)),
  };
}

function topic0Of(topics: unknown): string {
  return Array.isArray(topics) && typeof topics[0] === "string" ? lower(topics[0]) : "";
}
