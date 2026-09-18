import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ethers } from "ethers";
import { setTimeout as delay } from "node:timers/promises";
import type { CanonicalSource } from "../../../venues/adapter-request-program.js";
import { buildFamilyExecutionFragment, executeFamilyExactQuote } from "../../../venues/adapter-family-runtime.js";
import { decodeSwapLog } from "../../../venues/swaps/balancer-v3-family/discovery.js";
import { VAULT, VAULT_ABI, lower } from "../../../venues/swaps/balancer-v3-family/codec.js";
import type { BalancerV3Descriptor, BalancerV3Snapshot } from "../../../venues/swaps/balancer-v3-family/types.js";
import { admitToGraph, localCatalog } from "./lifecycle.js";
import { historicalExecution } from "./historical-execution.js";

// Explicit opt-in, sequential, bounded, read-only historical evidence check.
// Credentials and provider error bodies are never emitted. No retries on 429.
const envIndex = process.argv.indexOf("--env-file");
assert(envIndex >= 0 && process.argv[envIndex + 1], "explicit --env-file required");
const env = parseEnv(readFileSync(process.argv[envIndex + 1], "utf8"));
const endpoint = env.MAINNET_RPC_URL ?? env.ETH_RPC_URL;
assert(endpoint, "historical RPC is not configured");
let calls = 0, reverts = 0;
let queue: Promise<unknown> = Promise.resolve();
function rpc(method: string, params: unknown[]): Promise<any> {
  const next = queue.then(() => rpcOnce(method, params));
  queue = next.catch(() => undefined);
  return next;
}
async function rpcOnce(method: string, params: unknown[]): Promise<any> {
  assert(++calls <= 96, "historical RPC budget exhausted");
  await delay(200);
  let response: Response;
  try {
    response = await fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }), signal: AbortSignal.timeout(55000) });
  } catch { throw new Error(`historical transport failed (${method}); endpoint redacted`); }
  if (!response.ok) throw new Error(`historical HTTP ${response.status}; stopped without retry`);
  const body = await response.json() as { result?: unknown; error?: { code?: number; data?: unknown; message?: string } };
  if (body.error) {
    if (/429|throughput|compute units|rate limit/i.test(body.error.message ?? "")) throw new Error("historical rate limit; stopped without retry");
    if (method === "eth_call" && (body.error.code === 3 || /execution reverted/i.test(body.error.message ?? ""))) {
      reverts++;
      throw Object.assign(new Error("historical call reverted"), { code: "CALL_EXCEPTION",
        data: typeof body.error.data === "string" && ethers.isHexString(body.error.data) ? body.error.data : "0x" });
    }
    throw new Error(`historical RPC error ${body.error.code ?? "unknown"} (${method}); body redacted`);
  }
  return body.result;
}
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/loops/rocksolid-balancer-v3-7ce631.json", import.meta.url), "utf8"));
const originalLeg = fixture.legs.find((item: { kind: string }) => item.kind === "balancer-v3");
assert.equal(await rpc("eth_chainId", []), "0x1");
let receipt = await rpc("eth_getTransactionReceipt", [fixture.txHash]);
assert(receipt && receipt.status === "0x1");
assert.equal(Number(BigInt(receipt.blockNumber)), fixture.executionBlock);
let header = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
assert.equal(header.hash, receipt.blockHash);
let source: CanonicalSource = { number: fixture.executionBlock, hash: header.hash, generation: 1 };
const matching = receipt.logs.map((log: { address: string; topics: string[]; data: string }) => ({ log, decoded: decodeSwapLog(log) }))
  .filter((item: { decoded: ReturnType<typeof decodeSwapLog> }) => item.decoded && lower(item.decoded.pool) === lower(originalLeg.pool));
assert.equal(matching.length, 1);
assert.equal(matching[0].decoded.amountIn, BigInt(originalLeg.realized.amountIn));
assert.equal(matching[0].decoded.amountOut, BigInt(originalLeg.realized.amountOut));
assert.equal(lower(matching[0].decoded.tokenIn), lower(originalLeg.tokenIn));
assert.equal(lower(matching[0].decoded.tokenOut), lower(originalLeg.tokenOut));
const executor = "0x1000000000000000000000000000000000000002";
const providerAt = (at: CanonicalSource) => {
  const pin = (block?: number) => {
    assert.equal(block, at.number); return { blockHash: at.hash, requireCanonical: true };
  };
  return {
    call: (tx: { to: string; data: string; from?: string }, block?: number) => rpc("eth_call", [tx, pin(block)]),
    getCode: (address: string, block?: number) => rpc("eth_getCode", [address, pin(block)]),
    getStorage: (address: string, slot: string, block?: number) => rpc("eth_getStorageAt", [address, slot, pin(block)]),
  };
};
const catalog = await localCatalog();
const observations = (at: CanonicalSource, r: typeof receipt) => r.logs.map((log: { address: string; topics: string[]; data: string }) => ({
  kind: "log" as const, source: at, ...log, transactionHash: r.transactionHash }));
const hookNegative = await admitToGraph({ catalog, source, executor, provider: providerAt(source), observations: observations(source, receipt) });
assert.equal(hookNegative.lifecycle.publication, null);
assert.equal(hookNegative.graph.edges.length, 0);
assert(hookNegative.lifecycle.outcomes.some(outcome => outcome.reasonCode.includes("unsupported-swap-hook-caller-context")));
const hookEvidence = { txHash: fixture.txHash, source, outcomes: hookNegative.lifecycle.outcomes };
// Second real sample comes from docs/research/reports/step1-R15-20260704.json,
// not a fabricated fixture; all pool/token/amount facts below come from RPC.
const txHash = "0x38840fe7b3be155e5065e25f022e3076ec35c58264c407e5f2416a132e43c698";
receipt = await rpc("eth_getTransactionReceipt", [txHash]);
assert(receipt && receipt.status === "0x1"); assert.equal(Number(receipt.blockNumber), 25453353);
header = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]); assert.equal(header.hash, receipt.blockHash);
source = { number: Number(receipt.blockNumber), hash: receipt.blockHash, generation: 1 };
const swaps = receipt.logs.map(decodeSwapLog).filter(Boolean) as NonNullable<ReturnType<typeof decodeSwapLog>>[];
assert.equal(swaps.length, 1);
const leg = { ...swaps[0], realized: { amountIn: String(swaps[0].amountIn), amountOut: String(swaps[0].amountOut) } };
// All receipt logs enter catalog discovery. The fixture route is only checked
// after publication; it is never injected as a candidate or Graph edge.
const admitted = await admitToGraph({ catalog, source, executor,
  observations: observations(source, receipt), provider: providerAt(source) });
const publication = admitted.lifecycle.publication;
assert(publication, JSON.stringify(admitted.lifecycle.outcomes));
assert.equal(publication.instances.length, 1);
const instance = publication.instances[0];
const descriptor = instance.descriptor as BalancerV3Descriptor;
const { routes } = instance;
assert.equal(routes.length, descriptor.binding.tokens.length * (descriptor.binding.tokens.length - 1));
assert.equal(admitted.graph.edges.length, routes.length);
assert(admitted.graph.edges.every(edge => lower(edge.target) === lower(leg.pool) && edge.canonicalEdgeId));
const routeIndex = routes.findIndex(r => lower(r.tokenIn) === lower(leg.tokenIn) && lower(r.tokenOut) === lower(leg.tokenOut));
assert(routeIndex >= 0);
const route = instance.routeHandles[routeIndex];
const snapshot = instance.pricingInstances.find(p => p.routes.some(r => r.routeKey === route.routeKey))!.snapshot as BalancerV3Snapshot;
const quotes: { amountIn: string; amountOut: string }[] = [];
const executions = [];
const artifactIndex = process.argv.indexOf("--botvm-artifact");
for (const amountIn of [BigInt(leg.realized.amountIn), BigInt(leg.realized.amountIn) * 10n]) {
  const quote = await executeFamilyExactQuote({ family: admitted.family, route, amountIn, source,
    generation: source.generation, executor, runtimeEvidence: [], runtime: admitted.runtime, requireChainAmountQuote: true });
  assert(quote.status === "resolved", JSON.stringify(quote.outcome));
  assert(quote.amountOut > 0n);
  const execution = buildFamilyExecutionFragment({ family: admitted.family, actionOwnership: catalog, route,
    exact: quote, minAmountOut: quote.amountOut * 999n / 1000n, executor, runtimeEvidence: [] });
  assert(execution.status === "resolved", JSON.stringify(execution.outcome));
  assert.equal(execution.fragment.nodes[0].amount, amountIn);
  quotes.push({ amountIn: String(amountIn), amountOut: String(quote.amountOut) });
  if (artifactIndex >= 0) executions.push(await historicalExecution({ rpc, source, header,
    artifactFile: process.argv[artifactIndex + 1], executor, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut,
    amountIn, amountOut: quote.amountOut, fragment: execution.fragment }));
}
const notRegistered = await rpc("eth_call", [{ to: VAULT,
  data: VAULT_ABI.encodeFunctionData("isPoolRegistered", ["0x0000000000000000000000000000000000000001"]) },
  { blockHash: source.hash, requireCanonical: true }]);
assert.equal(VAULT_ABI.decodeFunctionResult("isPoolRegistered", notRegistered)[0], false);
assert.equal((await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])).hash, source.hash);
console.log(JSON.stringify({ result: "historical-production-lifecycle-graph-pass", txHash, source, hookEvidence,
  pool: descriptor.pool, tokens: descriptor.binding.tokens, routes: routes.length,
  catalogHash: catalog.catalogHash, publicationFingerprint: publication.publicationFingerprint,
  graphEdgeIds: admitted.graph.edges.map(edge => edge.canonicalEdgeId),
  hook: descriptor.binding.hooks,
  landed: { amountIn: leg.realized.amountIn, amountOut: leg.realized.amountOut },
  postBlockPricing: { amountIn: String(snapshot.amountIn), amountOut: String(snapshot.amountOut) },
  postBlockExactQuotes: quotes, quoteProbeReverts: reverts,
  calls, executions, execution: executions.length === 2 ? "encoded BotVM fragments passed with exact per-wei deltas" : "not run: --botvm-artifact required" }, null, 2));
