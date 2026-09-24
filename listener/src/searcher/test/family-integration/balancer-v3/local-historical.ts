// Opt-in Family diagnostic, not a Ready writer, live runner or acceptance gate.
// Only an explicitly supplied local Anvil fork is callable. No environment load.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { buildFamilyExecutionFragment, executeFamilyExactQuote } from "../../../venues/adapter-family-runtime.js";
import type { CanonicalSource } from "../../../venues/adapter-request-program.js";
import { buildEffectiveMids, type EffectivePricingInput } from "../../../blockscan-effective-mid.js";
import { tokenToWethReferences } from "../../../blockscan-amount-reference.js";
import { blockScanEdgeKey } from "../../../venues/blockscan-state-capability.js";
import type { RouteVenueMid } from "../../../venues/mid-readers.js";
import { decodeSwapLog } from "../../../venues/swaps/balancer-v3-family/discovery.js";
import { ROUTER, ROUTER_ABI, lower, probeAmounts, queryData } from "../../../venues/swaps/balancer-v3-family/codec.js";
import type { BalancerV3Descriptor, BalancerV3Snapshot } from "../../../venues/swaps/balancer-v3-family/types.js";
import { admitToGraph, localCatalog } from "./lifecycle.js";
import { localExecution } from "./local-execution.js";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const executor = "0x1000000000000000000000000000000000000002";
const json = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const parsePrices = (value: string): any => JSON.parse(value, (_key, v) => {
  if (v?.$type === "bigint") return BigInt(v.value);
  if (v?.$type === "number") return Number(v.value);
  if (v?.$type === "map") return new Map(v.entries);
  if (v?.$type === "set") return new Set(v.values);
  return v;
});

async function run() {
  const argv = process.argv.slice(2);
  const allowed = new Set(["--run", "--rpc", "--tx", "--pool", "--out", "--botvm-artifact", "--valuation-prices", "--production-effective-log"]);
  for (let i = 0; i < argv.length; i++) {
    assert(allowed.has(argv[i]), "unknown option");
    if (argv[i] !== "--run") { assert(argv[i + 1] && !argv[i + 1].startsWith("--"), "missing option value"); i++; }
  }
  const option = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  assert(option("--rpc") && option("--tx") && option("--out"), "--rpc, --tx and --out are required");
  const endpoint = new URL(option("--rpc")!);
  assert(endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
    endpoint.port && endpoint.username === "" && endpoint.password === "" && endpoint.pathname === "/" &&
    endpoint.search === "" && endpoint.hash === "", "explicit plain loopback fork URL required");
  const txHash = option("--tx")!; assert(ethers.isHexString(txHash, 32), "transaction hash required");
  const wantedPool = option("--pool") && lower(option("--pool")!);
  const out = resolve(option("--out")!); assert(out.includes("/logs/"), "evidence must be written under ignored logs/");
  const report: Record<string, any> = { schemaVersion: 1, txHash, result: "not-completed",
    claim: "Family-local same-source raw/Exact/effective price and optional encoded-balance diagnostic; not Ready, final-route sim/EV or latency acceptance",
    broadcast: false, sourceEnvironment: "N end-state and N timestamp; not original transaction pre-state",
    effectiveReferencePolicy: "production buildEffectiveMids cold-start default P; no ancestral successful-sim gas sample",
    rows: [], executions: [] };
  const started = Date.now();
  let calls = 0, productionRouterCalls = 0, phase = "reference";
  const methods = new Set(["web3_clientVersion", "eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber",
    "eth_getBlockByHash", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_createAccessList", "debug_traceCall"]);
  let queue: Promise<unknown> = Promise.resolve();
  function rpc(method: string, params: unknown[]): Promise<any> {
    const requestPhase = phase;
    const next = queue.then(async () => {
      assert(methods.has(method), "RPC method is outside the local read-only diagnostic");
      assert(++calls <= 2048, "local diagnostic RPC budget exhausted");
      assert(Date.now() - started < 10 * 60_000, "local diagnostic ten-minute wall budget exhausted");
      const transaction = params[0] as { to?: string; data?: string } | undefined;
      if (requestPhase === "production" && method === "eth_call" && transaction?.to && lower(transaction.to) === lower(ROUTER) &&
          transaction.data?.startsWith(ROUTER_ABI.getFunction("querySwapSingleTokenExactIn")!.selector)) {
        productionRouterCalls++;
        throw new Error("local model unexpectedly used Router during production pricing");
      }
      let response: Response;
      try { response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }), signal: AbortSignal.timeout(45000) }); }
      catch { throw new Error(`local fork transport failed (${method}); no retry`); }
      assert(response.ok, `local fork HTTP ${response.status}; no retry`);
      const body = await response.json() as { result?: unknown; error?: { code?: number; data?: unknown; message?: string } };
      if (body.error) {
        if (/429|throughput|compute units|rate limit/i.test(body.error.message ?? "")) throw new Error("fork upstream quota; stopped without retry");
        if (method === "eth_call" && (body.error.code === 3 || /execution reverted/i.test(body.error.message ?? ""))) {
          throw Object.assign(new Error("local fork call reverted"), { code: "CALL_EXCEPTION",
            data: typeof body.error.data === "string" && ethers.isHexString(body.error.data) ? body.error.data : "0x" });
        }
        throw new Error(`local fork RPC ${body.error.code ?? "unknown"} (${method}); body redacted`);
      }
      return body.result;
    });
    queue = next.catch(() => undefined); return next;
  }
  try {
    assert.match(String(await rpc("web3_clientVersion", [])), /anvil/i, "only local Anvil fork is permitted");
    assert.equal(await rpc("eth_chainId", []), "0x1");
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    assert(receipt?.status === "0x1" && receipt.transactionHash.toLowerCase() === txHash.toLowerCase(), "successful real receipt required");
    const header = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(header.hash.toLowerCase(), receipt.blockHash.toLowerCase());
    const source: CanonicalSource = { number: Number(BigInt(receipt.blockNumber)), hash: header.hash, generation: 1 };
    const head = await rpc("eth_getBlockByNumber", ["latest", false]);
    assert.equal(head.hash.toLowerCase(), source.hash.toLowerCase(), "fork must be pinned at receipt N, not N-1 or N+1");
    assert.equal(head.timestamp, header.timestamp);
    report.source = source; report.timestamp = header.timestamp; report.receiptSha256 = sha(json(receipt));
    const swaps = receipt.logs.map(decodeSwapLog).filter(Boolean) as NonNullable<ReturnType<typeof decodeSwapLog>>[];
    assert(swaps.length > 0, "receipt contains no natural Balancer swap evidence");
    const pin = { blockHash: source.hash, requireCanonical: true };
    const checkPin = (block?: number) => { assert.equal(block, source.number); return pin; };
    const provider = {
      call: (tx: { to: string; data: string; from?: string }, block?: number) => rpc("eth_call", [tx, checkPin(block)]),
      getCode: (address: string, block?: number) => rpc("eth_getCode", [address, checkPin(block)]),
      getStorage: (address: string, slot: string, block?: number) => rpc("eth_getStorageAt", [address, slot, checkPin(block)]),
    };
    const catalog = await localCatalog();
    // Feed every original receipt log. Pool selection below happens only after
    // production lifecycle/Graph publication; it cannot inject an admitted edge.
    phase = "production";
    const admitted = await admitToGraph({ catalog, source, executor, provider,
      observations: receipt.logs.map((log: { address: string; topics: string[]; data: string }) => ({
        kind: "log" as const, source, address: log.address, topics: log.topics, data: log.data, transactionHash: txHash })) });
    phase = "reference";
    report.lifecycleOutcomes = admitted.lifecycle.outcomes;
    const publication = admitted.lifecycle.publication; assert(publication, "no actual lifecycle publication");
    report.catalogHash = catalog.catalogHash; report.publicationFingerprint = publication.publicationFingerprint;
    report.graphEdgeIds = admitted.graph.edges.map(edge => edge.canonicalEdgeId);
    const instances = publication.instances.filter(instance => !wantedPool || lower((instance.descriptor as BalancerV3Descriptor).pool) === wantedPool);
    assert(instances.length > 0 && instances.length <= 4, "select one of the naturally published pools for bounded diagnostics");
    for (const instance of instances) assert((instance.descriptor as BalancerV3Descriptor).binding.localModel,
      "selected naturally admitted pool has no proven local model; Router fallback is not a local-pricing pass");
    const selectedHandles = new Map(instances.flatMap(instance => instance.routeHandles.map(handle => [handle.routeKey, handle] as const)));
    const selectedEdges = admitted.graph.routes.filter(row => selectedHandles.has(row.handle.routeKey)).map(row => row.edge);
    const mids = new Map<string, RouteVenueMid>();
    for (const row of admitted.graph.routes) {
      if (!selectedHandles.has(row.handle.routeKey)) continue;
      const mid = instances.flatMap(instance => instance.pricingInstances).map(state => state.mids.get(row.handle.routeKey)).find(Boolean);
      assert(mid, "natural Graph route has no raw mid"); mids.set(blockScanEdgeKey(row.edge), mid);
    }
    const pricing: EffectivePricingInput = { sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
      graph: { edges: selectedEdges }, mids, coverage: { resolvedEdgeKeys: [...mids.keys()] } };
    let referencePricing = pricing;
    if (option("--valuation-prices")) {
      const bytes = readFileSync(option("--valuation-prices")!, "utf8"), parsed = parsePrices(bytes);
      referencePricing = parsed.runtime?.pricing ?? parsed;
      assert(referencePricing.graph?.edges && referencePricing.mids instanceof Map && referencePricing.coverage?.resolvedEdgeKeys,
        "valuation input must be an actual production prices.json/raw pricing serialization");
      report.valuationReference = { path: resolve(option("--valuation-prices")!), sha256: sha(bytes),
        sourceBlock: referencePricing.sourceBlock, sourceBlockHash: referencePricing.sourceBlockHash };
    }
    const marks = tokenToWethReferences(referencePricing, WETH);
    const exact = async (handle: (typeof instances)[number]["routeHandles"][number], amountIn: bigint) => {
      phase = "production";
      try { return await executeFamilyExactQuote({ family: admitted.family, route: handle, amountIn, source,
        generation: source.generation, executor, runtimeEvidence: [], runtime: admitted.runtime }); }
      finally { phase = "reference"; }
    };
    const effective = await buildEffectiveMids({ pricing, weth: WETH, gasCostWei: null, enumerationSpreadBps: 0,
      tokenReferences: () => marks, control: {}, concurrency: 1,
      quote: async ({ edge, amountIn }) => {
        const projected = admitted.graph.handleByCanonicalEdgeId.get(edge.canonicalEdgeId!); assert(projected);
        const handle = selectedHandles.get(projected.routeKey); assert(handle);
        const result = await exact(handle, amountIn); assert(result.status === "resolved", "production effective Exact unresolved");
        return { source, amountIn, amountOut: result.amountOut };
      } });
    report.effective = { complete: effective.complete, reference: effective.reference, referenceWethInput: effective.referenceWethInput,
      rows: [...effective.rows.values()] };
    let recordedEffective: any[] = [];
    if (option("--production-effective-log")) {
      const bytes = readFileSync(option("--production-effective-log")!, "utf8");
      // Deterministically take the first complete baseline, not a favourable
      // direction or successful later retry. The original row supplies ONLY
      // the amount to test, never an expected output at the historical source.
      const baseline = bytes.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        .find(row => row.type === "block_scan_mid_baseline" && row.effective_mids?.complete === true);
      assert(baseline, "production log has no complete effective baseline");
      const logged = baseline.effective_mids;
      assert.equal(logged.source.number, baseline.source_block);
      assert.equal(logged.source.hash.toLowerCase(), baseline.source_block_hash.toLowerCase());
      assert.equal(logged.source.generation, baseline.generation);
      assert(Array.isArray(logged.rows));
      recordedEffective = logged.rows.map((entry: any) => {
        assert(Array.isArray(entry) && entry.length === 2 && entry[0] === entry[1].edge_id);
        return entry[1];
      }).filter((row: any) => typeof row.instance_key === "string" && instances.some(instance =>
        lower((instance.descriptor as BalancerV3Descriptor).pool) === row.instance_key.toLowerCase()));
      report.recordedProductionEffective = { path: resolve(option("--production-effective-log")!), sha256: sha(bytes),
        source: logged.source, reference: logged.reference, referenceWethInput: logged.reference_weth_input,
        rows: recordedEffective,
        meaning: "observed production input amounts only; outputs are freshly compared at historical N, not compared to this later source price" };
    }
    for (const instance of instances) {
      const descriptor = instance.descriptor as BalancerV3Descriptor;
      for (let index = 0; index < instance.routes.length; index++) {
        const route = instance.routes[index], handle = instance.routeHandles[index];
        const state = instance.pricingInstances.find(item => item.routes.some(itemRoute => itemRoute.routeKey === route.routeKey)); assert(state);
        const snapshot = state.snapshot as BalancerV3Snapshot;
        const edge = admitted.graph.routes.find(row => row.handle === handle)?.edge; assert(edge);
        const effectiveRow = effective.rows.get(blockScanEdgeKey(edge)); assert(effectiveRow);
        const amountKinds = new Map<bigint, string[]>();
        const add = (amount: bigint, kind: string) => amountKinds.set(amount, [...(amountKinds.get(amount) ?? []), kind]);
        const tokenIndex = descriptor.binding.tokens.findIndex(token => lower(token) === lower(route.tokenIn)); assert(tokenIndex >= 0);
        probeAmounts(descriptor.binding.decimals[tokenIndex], snapshot.balanceIn).forEach((amount, i) => add(amount, `raw-probe:${i}`));
        add(snapshot.amountIn, "published-raw");
        const landed = swaps.filter(swap => lower(swap.pool) === lower(descriptor.pool) && lower(swap.tokenIn) === lower(route.tokenIn) && lower(swap.tokenOut) === lower(route.tokenOut));
        for (const swap of landed) add(swap.amountIn, "actual-tx-input");
        if (effectiveRow.amountIn !== null) add(effectiveRow.amountIn, "production-effective-reference");
        const recorded = recordedEffective.filter(row => lower(row.instance_key) === lower(descriptor.pool) &&
          lower(row.token_in) === lower(route.tokenIn) && lower(row.token_out) === lower(route.tokenOut));
        assert(recorded.length <= 1, "ambiguous recorded production effective direction");
        if (recorded[0]?.status === "quoted") {
          const amount = BigInt(recorded[0].amount_in); assert(amount > 0n);
          add(amount, "recorded-production-effective-input");
        }
        for (const [amountIn, kinds] of amountKinds) {
          const local = await exact(handle, amountIn);
          let router: bigint | null = null, routerRevert: string | null = null;
          try { router = BigInt(await rpc("eth_call", [{ to: ROUTER, data: queryData(descriptor.pool, route.tokenIn, route.tokenOut, amountIn, executor) }, pin])); }
          catch (error) { if ((error as { code?: string }).code !== "CALL_EXCEPTION") throw error; routerRevert = String((error as { data?: string }).data ?? "0x"); }
          const row = { pool: descriptor.pool, model: descriptor.binding.localModel, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
            amountIn, kinds, localStatus: local.status, localAmountOut: local.status === "resolved" ? local.amountOut : null,
            routerAmountOut: router, routerRevert, signedDelta: local.status === "resolved" && router !== null ? local.amountOut - router : null,
            originalTransactionOutputs: landed.filter(swap => swap.amountIn === amountIn).map(swap => swap.amountOut),
            originalTransactionOutputComparison: "not asserted: quote uses N end-state, not original leg pre-state" };
          report.rows.push(row);
          assert.equal(local.status === "resolved", router !== null, "local and same-source Router availability differ");
          if (local.status !== "resolved") continue;
          assert.equal(local.amountOut, router, "local and same-source Router outputs differ per wei");
          if (kinds.includes("published-raw")) assert.equal(snapshot.amountOut, local.amountOut);
          if (kinds.includes("production-effective-reference")) { assert.equal(effectiveRow.status, "quoted"); assert.equal(effectiveRow.amountOut, local.amountOut); }
          if (option("--botvm-artifact") && kinds.some(kind => kind === "actual-tx-input" || kind === "production-effective-reference" ||
              kind === "recorded-production-effective-input")) {
            const execution = buildFamilyExecutionFragment({ family: admitted.family, actionOwnership: catalog, route: handle,
              exact: local, minAmountOut: local.amountOut, executor, runtimeEvidence: [] });
            assert(execution.status === "resolved", "production encoded fragment unresolved");
            report.executions.push(await localExecution({ rpc, source, timestamp: header.timestamp, baseFeePerGas: header.baseFeePerGas,
              artifactFile: option("--botvm-artifact")!, executor, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
              amountIn, amountOut: local.amountOut, fragment: execution.fragment }));
          }
        }
      }
    }
    assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false])).hash, source.hash);
    assert.equal((await rpc("eth_getBlockByNumber", ["latest", false])).hash, source.hash, "fork moved during diagnostic");
    assert.equal(productionRouterCalls, 0);
    report.missingEffectiveValuations = [...effective.rows.values()].filter(row => row.status === "missing-valuation").map(row => row.edgeId);
    report.unquotedEffective = [...effective.rows.values()].filter(row => row.status !== "quoted").map(row => ({ edgeId: row.edgeId, status: row.status }));
    report.executionStatus = option("--botvm-artifact") ? "executed" : "not-run: explicit --botvm-artifact required";
    report.result = report.unquotedEffective.length === 0 ? "local-raw-effective-router-parity-pass" : "partial: raw/Exact parity passed; some effective rows unavailable";
    if (report.unquotedEffective.length > 0) process.exitCode = 2;
  } catch (error) {
    report.result = "failed"; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  } finally {
    report.rpcCalls = calls; report.productionRouterCalls = productionRouterCalls; report.wallMs = Date.now() - started;
    writeFileSync(out, json(report) + "\n", { flag: "wx", mode: 0o600 });
    console.log(json({ result: report.result, source: report.source, rows: report.rows.length,
      executions: report.executions.length, rpcCalls: calls, report: out, error: report.error }));
  }
}

if (process.argv.includes("--run")) await run();
