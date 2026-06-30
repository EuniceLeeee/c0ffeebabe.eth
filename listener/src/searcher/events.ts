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

export function initEvents(path?: string): void {
  eventsPath = (path ?? process.env.SEARCHER_EVENTS_PATH ?? "").trim();
  if (eventsPath) {
    runId = randomUUID();
    chainId = parseChainId(process.env.SEARCHER_CHAIN_ID);
    try {
      mkdirSync(dirname(eventsPath), { recursive: true });
    } catch {
      // emitEvent remains fail-open; mkdir failure just means writes will no-op.
    }
    console.log(`[searcher/live] events emit → ${eventsPath}`);
  }
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

export type SearcherEvent =
  | {
      type: "opportunity_seen";
      opportunity_id: string;
      target_block: number;
      victim_hash: string;
      pool?: string;
      tokens?: string[];
    }
	  | {
	      type: "simulation_result";
	      opportunity_id: string;
	      target_block: number;
      victim_hash: string;
      path_id?: string;
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
	      victim_hash: string;
	      stage: string;
	      reason: string;
	      error?: string;
	      pool?: string;
	      tokens?: string[];
	      path_id?: string;
	      template_id?: string;
	      plans?: number;
	      no_candidate_diagnostic?: unknown;
	    }
	  | {
	      type: "bundle_submitted";
	      opportunity_id: string;
      target_block: number;
      submission_target_block?: number;
      victim_hash: string;
      mode: string;
      path_id?: string;
      template_id?: string;
      simulated_profit?: string;
      simulated_profit_eth?: string;
      bid?: string;
      tx_hash: string;
      calldata_hash: string;
      builders_sent?: string[];
      bundle_hash?: string;
      accepted?: number;
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
