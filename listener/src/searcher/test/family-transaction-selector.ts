import assert from "node:assert/strict";
import { Interface } from "ethers";
import { readySelectorCensusFromTransaction, type ReadySelectorCensusTransaction } from "../ready-selector-census.js";
import type { ReadyTransactionEvidence } from "../ready-transaction-input.js";
import { observationsFromSelectedTransaction } from "../universe-rebuild-production.js";

/** Historical diagnostic transport feeds the exact census decoder used by SQL.
 * Retain unsupported calls and reverted descendants; do not turn token logs
 * into invented internal calldata or claim complete provider trace coverage. */
export function transactionSelectorCensus(evidence: ReadyTransactionEvidence): ReadySelectorCensusTransaction {
  observationsFromSelectedTransaction(evidence, [], new Set());
  const traces: Record<string, unknown>[] = [];
  const add = (frame: any, path: readonly number[]) => {
    const action = frame.action ?? frame;
    traces.push({ trace_address: [...path], to_address: action.to, from_address: action.from,
      input: action.input, value: action.value, call_type: String(action.callType ?? frame.type ?? "").toLowerCase(),
      status: frame.error ? 0 : 1, ...(frame.error ? { error: frame.error } : {}) });
  };
  if (evidence.method === "trace_transaction") {
    assert(Array.isArray(evidence.rawTrace), "transaction trace array required");
    for (const frame of evidence.rawTrace as any[]) add(frame, frame.traceAddress);
  } else {
    const walk = (frame: any, path: readonly number[]) => {
      add(frame, path); (frame.calls ?? []).forEach((child: any, index: number) => walk(child, [...path, index]));
    };
    walk(evidence.rawTrace, []);
  }
  return readySelectorCensusFromTransaction({ chain_id: 1, tx_hash: evidence.receipt.transactionHash,
    block_number: evidence.receipt.blockNumber, block_hash: evidence.receipt.blockHash,
    transaction_index: evidence.receipt.transactionIndex, receipt_status: evidence.receipt.status,
    logs: evidence.receipt.logs, traces });
}

export interface TransactionExecutionBinding {
  familyId: string;
  domain: "swap" | "protocol" | "credit";
  instanceKey: string;
  lineageId: string;
  routeKey: string;
  target: string;
  selector: string;
  signature: string;
  poolId?: string;
  poolNamespace?: string;
  tokenInId?: string;
  tokenOutId?: string;
}

/** Hex resources are byte identifiers; opaque pool/instance keys retain case. */
export function sameExecutionResource(a: string, b: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(a) && /^0x[0-9a-fA-F]+$/.test(b)
    ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The installed declaration supplies the ABI. Canonical re-encoding rejects
 * wrong argument shapes and trailing bytes despite a matching four-byte selector. */
export function canonicalExecutionCall(signature: string, target: string, call: { target: string; data: string }): boolean {
  if (target.toLowerCase() !== call.target.toLowerCase()) return false;
  try {
    const abi = new Interface([signature]), parsed = abi.parseTransaction({ data: call.data });
    return parsed !== null && abi.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() === call.data.toLowerCase();
  } catch { return false; }
}
