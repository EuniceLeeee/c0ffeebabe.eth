// CLI-only conversion of an existing complete bootstrap table. Never opens a
// transport: the production amount-path builder can only look up saved tuples.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { EffectiveMidHistoryReplay } from "./blockscan-effective-mid-history.js";
import { buildEffectiveMids, exportEffectiveMidReplayState, restoreEffectiveMidReplayState,
  type EffectiveMidSnapshot, type EffectivePricingInput } from "./blockscan-effective-mid.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";

export async function readBootstrapPriceLog(path: string) {
  const stream = createReadStream(path), digest = createHash("sha256");
  stream.on("data", chunk => digest.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let record: any;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      assert(!record && value.type === "block_scan_mid_baseline", "import requires one original bootstrap publication, not a carried/delta log");
      record = value;
    }
  } finally { lines.close(); stream.destroy(); }
  assert(record && record.generation === 1 && record.effective_mids?.complete === true,
    "complete original bootstrap publication required; no repricing fallback");
  assert(typeof record.run_id === "string" && typeof record.graph_fingerprint === "string");
  const source = { number: record.source_block, hash: record.source_block_hash, generation: record.generation };
  assert.deepEqual(record.raw_mid_source, source, "bootstrap raw source differs from effective source");
  assert.equal(record.mid_count, record.mids?.length);
  const full = new EffectiveMidHistoryReplay().apply(record.effective_mids, source) as any;
  assert(full && full.complete && ["fixed", "default"].includes(full.reference),
    "bootstrap without prior gas observations required");
  const amount = (value: unknown): bigint | null => {
    assert(value === null || (typeof value === "string" && /^\d+$/.test(value)), "invalid saved amount");
    return value === null ? null : BigInt(value as string);
  };
  const effective: EffectiveMidSnapshot = { source, reference: full.reference,
    referenceWethInput: BigInt(full.reference_weth_input), complete: true, wallMs: full.wall_ms,
    rows: new Map(full.rows.map(([key, r]: [string, any]) => [key, {
      edgeId: r.edge_id, instanceKey: r.instance_key, tokenIn: r.token_in, tokenOut: r.token_out,
      amountIn: amount(r.amount_in), amountOut: amount(r.amount_out), effectiveMid: r.effective_mid, status: r.status,
      ...(r.quoted_at ? { quotedAt: r.quoted_at } : {}), ...(r.carried ? { carried: true as const } : {}),
    }])) };
  return { record, effective, sha256: digest.digest("hex") };
}

export async function recoverBootstrapLineage(pricing: EffectivePricingInput, saved: EffectiveMidSnapshot, weth: string) {
  assert(saved.complete && saved.source.generation === 1 && ["fixed", "default"].includes(saved.reference),
    "only a complete first publication can be recovered without earlier private lineage");
  assert.deepEqual(saved.source, { number: pricing.sourceBlock, hash: pricing.sourceBlockHash, generation: pricing.generation });
  for (const row of saved.rows.values()) {
    assert(!row.carried && row.status !== "cancelled" && row.status !== "disabled-for-run",
      "bootstrap import cannot infer carried/excluded observations");
    if (row.quotedAt) assert.deepEqual(row.quotedAt, saved.source, "quote observation is not from the bootstrap source");
  }
  const mismatches: string[] = [];
  let savedTupleLookups = 0;
  const replayed = await buildEffectiveMids({ pricing, weth, gasCostWei: null,
    ...(saved.reference === "fixed" ? { fixedWethInput: saved.referenceWethInput } : {}),
    enumerationSpreadBps: 0, concurrency: 1, control: {},
    quote: async ({ edge, amountIn }) => {
      const key = blockScanEdgeKey(edge), row = saved.rows.get(key);
      savedTupleLookups++;
      if (!row || row.amountIn !== amountIn) {
        mismatches.push(key); throw new Error("saved amount differs from production traversal");
      }
      if (row.status === "unsupported") throw Object.assign(new Error("saved unsupported observation"), { code: "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" });
      if (row.status === "quote-failed") throw new Error("saved failed observation");
      if ((row.status !== "quoted" && row.status !== "no-output") || row.amountOut === null) {
        mismatches.push(key); throw new Error("saved status differs from production traversal");
      }
      return { source: saved.source, amountIn, amountOut: row.amountOut };
    } });
  assert.equal(mismatches.length, 0, "saved tuple lookup mismatch; no RPC fallback");
  assert.equal(replayed.rows.size, saved.rows.size, "saved table differs from complete graph");
  assert.equal(replayed.referenceWethInput, saved.referenceWethInput);
  for (const [key, row] of saved.rows) {
    const actual = replayed.rows.get(key);
    assert(actual, "saved row is absent from production traversal");
    for (const field of ["edgeId", "instanceKey", "tokenIn", "tokenOut", "amountIn", "amountOut", "effectiveMid", "status", "quotedAt"] as const)
      assert.deepEqual(actual[field], row[field], `saved ${field} differs at ${key}`);
  }
  const lineage = exportEffectiveMidReplayState(replayed);
  restoreEffectiveMidReplayState(saved, lineage, pricing.graph.edges, weth);
  return { lineage, savedTupleLookups, quoteRpcCalls: 0, comparedRows: saved.rows.size };
}
