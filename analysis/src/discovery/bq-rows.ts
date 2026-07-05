import type { VenueScanInput } from "./venue-evidence.js";

export interface BqLogRow {
  tx_hash: string;
  block_number?: number;
  transaction_index?: number;
  from_address?: string;
  executor?: string;
  log_index?: number;
  log_address?: string;
  topics?: unknown;
  receipt_status?: number;
}

export function rowsToVenueInputs(rows: BqLogRow[]): VenueScanInput[] {
  const byTx = new Map<string, BqLogRow[]>();

  for (const row of rows) {
    const txHash = typeof row.tx_hash === "string" ? row.tx_hash : "";
    if (!txHash) continue;

    const txRows = byTx.get(txHash);
    if (txRows) txRows.push(row);
    else byTx.set(txHash, [row]);
  }

  return [...byTx.entries()].map(([txHash, txRows]) => {
    const sortedRows = [...txRows].sort((a, b) => logIndexOf(a) - logIndexOf(b));
    return {
      txHash,
      from: firstString(sortedRows, "from_address"),
      to: firstString(sortedRows, "executor"),
      receiptLogs: sortedRows.map((row) => ({
        address: row.log_address,
        topics: row.topics,
      })),
    };
  });
}

function logIndexOf(row: BqLogRow): number {
  return typeof row.log_index === "number" ? row.log_index : Number.MAX_SAFE_INTEGER;
}

function firstString(rows: BqLogRow[], key: "from_address" | "executor"): string | undefined {
  return rows.find((row) => typeof row[key] === "string")?.[key];
}
