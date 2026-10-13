// Historical acceptance input only. Does not change Ready, prices or live sampling.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { blockScanEdgeKey } from "../../venues/blockscan-state-capability.js";
import { productionAmount, same } from "./kyber-yb-compound/evidence.js";

/** Explicit CLI amount derived from four recorded forward quotes at one state.
 * The final output is borrowed only as a target input; target quote/execution
 * and admission still run independently. This is not a natural input row. */
export function manualFourHopInput(manifest: any, saved: any, pricesSha256: string) {
  assert.equal(manifest?.schemaVersion, 1);
  assert.equal(manifest.kind, "manual-four-hop-output-input");
  assert(/^[0-9a-f]{64}$/.test(pricesSha256));
  assert.equal(manifest.pricesSha256, pricesSha256, "manual input refers to another price file");
  assert(ethers.isAddress(manifest.tokenIn));
  assert(typeof manifest.amountIn === "string" && /^[1-9][0-9]*$/.test(manifest.amountIn));
  const amountIn = BigInt(manifest.amountIn);
  assert(amountIn <= ethers.MaxUint256);
  assert(Array.isArray(manifest.edgeIds) && manifest.edgeIds.length === 4 &&
    manifest.edgeIds.every((key: unknown) => typeof key === "string" && key.length > 0) &&
    new Set(manifest.edgeIds).size === 4, "manual reference requires four distinct recorded edges");
  const runtime = saved.runtime, table = runtime?.pricing?.effectiveMids;
  assert(table?.complete === true && table.rows instanceof Map);
  const source = { number: runtime.sourceBlock, hash: runtime.sourceBlockHash, generation: runtime.generation };
  assert(Number.isSafeInteger(source.number) && source.number > 0 && ethers.isHexString(source.hash, 32));
  assert(Number.isSafeInteger(source.generation) && source.generation >= 0);
  assert.deepEqual(table.source, source, "manual reference table source mismatch");
  assert.equal(runtime.pricing.sourceBlock, source.number);
  assert.equal(runtime.pricing.sourceBlockHash, source.hash);
  assert.equal(runtime.pricing.generation, source.generation);
  let token = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  let amount = table.referenceWethInput;
  assert(typeof amount === "bigint" && amount > 0n);
  const seen = new Set([token]);
  const path = manifest.edgeIds.map((key: string) => {
    const edges = runtime.graph.edges.filter((e: any) => blockScanEdgeKey(e) === key);
    assert.equal(edges.length, 1, "manual path edge absent or ambiguous");
    assert(!edges[0].leavesStandingPosition, "standing position cannot supply this input");
    const row = table.rows.get(key);
    const gate = productionAmount(row, runtime.pricing.mids.get(key), edges[0], source, source.generation);
    assert.equal(gate.status, "met", "manual path must contain fresh successful quotes");
    assert(ethers.isAddress(row.tokenIn) && ethers.isAddress(row.tokenOut));
    assert(same(row.tokenIn, token), "manual path token discontinuity");
    assert.equal(row.amountIn, amount, "manual path amount discontinuity");
    token = row.tokenOut.toLowerCase(); amount = row.amountOut;
    assert(!seen.has(token), "manual path cannot repeat a token"); seen.add(token);
    return row;
  });
  assert(same(token, manifest.tokenIn), "manual target token mismatch");
  assert.equal(amountIn, amount, "manual amount differs from the fourth quote output");
  return { kind: "manual-four-hop-output-input" as const, tokenIn: token, amountIn,
    source, pricesSha256, path, freshness: "fresh" as const,
    naturalTargetValuation: "not supplied; default production sampling remains unchanged" };
}
