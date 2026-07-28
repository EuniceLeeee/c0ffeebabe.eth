import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ethers } from "ethers";

/**
 * Desensitized, append-only JSONL event emitter for the live searcher.
 *
 * Feeds the OFFLINE `analysis` live-loss tool — it is NOT imported by analysis,
 * and analysis is NOT imported here. One-way: searcher writes a plain file, the
 * sidecar reads it after the block lands.
 *
 * Hard rules (hot-path safety):
 *  - Opt-in: disabled unless SEARCHER_EVENTS_PATH is set → zero impact by default.
 *  - NEVER throws into the hot path (all fs wrapped; failure is swallowed).
 *  - NEVER writes private keys, raw env, or full calldata — calldata is hashed.
 */

let eventsPath = "";
let runId = "";
let chainId = 1;
const EVENT_SCHEMA_VERSION = 1;

export interface SearcherEventContext {
  readonly enabled: boolean;
  readonly path: string;
  readonly runId: string;
  readonly chainId: number;
}

export function initEvents(path?: string): SearcherEventContext {
  eventsPath = (path ?? process.env.SEARCHER_EVENTS_PATH ?? "").trim();
  runId = "";
  chainId = parseChainId(process.env.SEARCHER_CHAIN_ID);
  if (eventsPath) {
    runId = randomUUID();
    try {
      mkdirSync(dirname(eventsPath), { recursive: true });
      // Establish the exact formal-events inode before the optional route
      // sidecar performs its same-file safety checks. This is startup-only;
      // hot-path writes remain unchanged below.
      appendFileSync(eventsPath, "");
    } catch {
      // emitEvent remains fail-open; mkdir failure just means writes will no-op.
    }
    console.log(`[searcher/live] events emit → ${eventsPath}`);
  }
  return Object.freeze({
    enabled: eventsPath.length > 0,
    path: eventsPath,
    runId: runId || "unknown",
    chainId,
  });
}

export function makeOpportunityId(input: {
  targetBlock: number;
  victimHash: string;
  pool?: string;
  tokens?: string[];
}): string {
  const pool = normalize(input.pool);
  const tokens = [...new Set((input.tokens ?? []).map(normalize).filter(Boolean))].sort();
  return ethers.keccak256(ethers.toUtf8Bytes([
    String(input.targetBlock),
    normalize(input.victimHash),
    pool,
    tokens.join(","),
  ].join("|")));
}

export function makeBlockScanOpportunityId(input: {
  sourceBlock: number;
  cycleId: string;
  startToken: string;
  seedPools: string[];
}): string {
  const seedPools = input.seedPools.map(normalize).sort();
  return ethers.keccak256(ethers.toUtf8Bytes([
    "blockscan",
    String(input.sourceBlock),
    input.cycleId,
    normalize(input.startToken),
    seedPools.join(","),
  ].join("|")));
}

export type SearcherEvent =
  | {
      type: "protocol_discovery";
      adapter_id: string;
      target?: string;
      selectors: string[];
      sources: string[];
      verdict: "rejected" | "would_admit" | "admitted" | "removed";
      stage: "feature_flag" | "candidate" | "identity" | "probe" | "arbitration" | "lifecycle";
      reason?: string;
      edge_count: number;
      mode: "shadow" | "active" | "observed";
      block_number: number;
    }
  | {
      type: "protocol_discovery_unknown_selector";
      target: string;
      selector: string;
      reason: "protocol_like_flow_unknown_selector" |
        "protocol_like_flow_unverified_match" |
        "protocol_like_flow_ambiguous_adapter";
      recommendation: "inspect_calltrace";
      matching_adapter_ids?: string[];
      tx_hash: string;
      block_number: number;
    }
  | {
      type: "mempool_filter_config";
      source: "filtered_mempool";
      to_addresses: string[];
      address_count: number;
      router_count: number;
      full_address_count?: number;
      canonical_target_count?: number;
      dynamic_target_count?: number;
      graph_target_count?: number;
      filtered_truncated?: boolean;
      max_addresses?: number;
    }
  | {
      type: "opportunity_seen";
      opportunity_id: string;
      target_block: number;
      victim_hash?: string;
      opportunity_kind?: "backrun-arb" | "block-scan-arb";
      source_block?: number;
      cycle_id?: string;
      cycle_fingerprint?: string;
      strategy_view_used?: "backrun" | "blockscan";
      search_center?: string;
      candidate_rank?: number;
      scanner_budget_ms?: number;
      seed_venues?: string[];
      strategy_view_version?: string;
      blockscan_view_hash?: string;
      backrun_view_hash?: string;
      pool?: string;
      tokens?: string[];
    }
	  | {
	      type: "simulation_result";
	      opportunity_id: string;
	      target_block: number;
      victim_hash?: string;
      opportunity_kind?: "backrun-arb" | "block-scan-arb";
      source_block?: number;
      cycle_id?: string;
      cycle_fingerprint?: string;
      strategy_view_used?: "backrun" | "blockscan";
      search_center?: string;
      candidate_rank?: number;
      scanner_budget_ms?: number;
      seed_venues?: string[];
      strategy_view_version?: string;
      blockscan_view_hash?: string;
      backrun_view_hash?: string;
      path_id?: string;
      route_id?: string;
      template_id?: string;
      ok: boolean;
      simulated_profit?: string;
      profit_token?: string;
	      gas_estimate?: string;
	      failure_reason?: string;
	    }
	  | {
	      type: "pipeline_dropped";
	      opportunity_id: string;
	      target_block: number;
	      victim_hash?: string;
	      sender?: string;
	      opportunity_kind?: "backrun-arb" | "block-scan-arb";
	      source_block?: number;
	      cycle_id?: string;
	      cycle_fingerprint?: string;
	      strategy_view_used?: "backrun" | "blockscan";
	      search_center?: string;
	      candidate_rank?: number;
	      scanner_budget_ms?: number;
	      seed_venues?: string[];
	      strategy_view_version?: string;
	      blockscan_view_hash?: string;
	      backrun_view_hash?: string;
	      victim_source?: "mev-share" | "mempool";
	      stage: string;
	      reason: string;
	      error?: string;
	      pool?: string;
	      tokens?: string[];
	      path_id?: string;
	      route_id?: string;
	      template_id?: string;
	      plans?: number;
	      no_candidate_diagnostic?: unknown;
	      expected_profit_eth?: string;
	      gas_cost_eth?: string;
	      bid_eth?: string;
	      net_ev_wei?: string;
	      eth_usd?: number | null;
	      eth_usd_round_id?: string | null;
	      eth_usd_updated_at?: string | null;
	      max_base_fee_per_gas?: string;
	      decision_parent_hash?: string | null;
	    }
	  | {
	      type: "bundle_submitted";
	      opportunity_id: string;
      target_block: number;
      submission_target_block?: number;
      victim_hash?: string;
      opportunity_kind?: "backrun-arb" | "block-scan-arb";
      source_block?: number;
      cycle_id?: string;
      cycle_fingerprint?: string;
      strategy_view_used?: "backrun" | "blockscan";
      search_center?: string;
      candidate_rank?: number;
      scanner_budget_ms?: number;
      seed_venues?: string[];
      strategy_view_version?: string;
      blockscan_view_hash?: string;
      backrun_view_hash?: string;
      mode: string;
      path_id?: string;
      route_id?: string;
      template_id?: string;
      simulated_profit?: string;
      simulated_profit_eth?: string;
      bid?: string;
      gas_cost_eth?: string;
      net_ev_wei?: string;
      eth_usd?: number | null;
      eth_usd_round_id?: string | null;
      eth_usd_updated_at?: string | null;
      max_base_fee_per_gas?: string;
      decision_parent_hash?: string | null;
      tx_hash: string;
      calldata_hash: string;
      builders_sent?: string[];
      bundle_hash?: string;
      accepted?: number;
    }
  | {
      type: "block_scan_result";
      source_block: number;
      state_block: number | null;
      outcome: "ran" | "startup_warm" | "degraded" | "skipped_busy" | "stale_state" | "budget_exceeded" | "disabled" | "breaker_open";
      startup_warm?: boolean;
      scanned_pairs: number;
      swap_touched_pools: number;
      candidates: number;
      scan_ms: number;
      skipped_reason?: string;
    }
  | {
      type: "bundle_included";
      opportunity_id: string;
      tx_hash: string;
      target_block: number;
      mined_block: number;
      status: "success" | "revert";
      gas_used?: string;
      effective_gas_price?: string;
    }
  | {
      type: "bundle_not_included";
      opportunity_id: string;
      tx_hash: string;
      target_block: number;
      blocks_waited: number;
    };

/** Fire-and-forget. Any failure (disabled, fs error) is silently ignored so the
 *  hot path is never affected. */
export function emitEvent(ev: SearcherEvent): void {
  if (!eventsPath) return;
  try {
    appendFileSync(eventsPath, JSON.stringify({
      ...ev,
      schema_version: EVENT_SCHEMA_VERSION,
      run_id: runId || "unknown",
      chain_id: chainId,
      emitted_at_ms: Date.now(),
    }) + "\n");
  } catch {
    // never let event logging break submission
  }
}

function parseChainId(value?: string): number {
  const parsed = Number(value ?? "1");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalize(value?: string): string {
  return (value ?? "").toLowerCase();
}
