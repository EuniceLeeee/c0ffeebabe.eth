import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readBootstrapPriceLog, recoverBootstrapLineage } from "./blockscan-import-live-baseline.js";
import { writeHistoricalBenchmarkBaseline } from "./blockscan-historical-benchmark.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";

async function fileHash(path: string) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function importLiveBaseline(argv: string[]) {
  const { values: args } = parseArgs({ args: argv, options: Object.fromEntries(
    ["history", "ready", "config", "out", "chain-id"].map(name => [name, { type: "string" as const }])) });
  for (const key of ["history", "ready", "config", "out", "chain-id"]) assert(args[key], `--${key} required`);
  assert(/^\d+$/.test(args["chain-id"]!));
  assert(!process.env.OWNER_PRIVATE_KEY && !process.env.PRIVATE_KEY, "import is keyless");
  const out = resolve(args.out!); assert(!existsSync(out), "output must be new"); mkdirSync(out, { mode: 0o700 });
  const configBytes = readFileSync(args.config!, "utf8"), config = JSON.parse(configBytes);
  assert(config && typeof config === "object" && !Array.isArray(config));
  for (const [key, value] of Object.entries(config)) {
    assert(typeof value === "string" && !/PRIVATE_KEY|RPC_URL|SECRET|PASSWORD/.test(key), "public config only");
    if (key.startsWith("SEARCHER_") || ["BOTVM_ADDRESS", "BOTVM_OWNER"].includes(key)) process.env[key] = value;
  }
  Object.assign(process.env, { SEARCHER_DRY_RUN: "1", SEARCHER_BLOCKSCAN_SUBMIT: "0", SEARCHER_EV_GATE: "1",
    SEARCHER_TEST_DISABLE_DOTENV: "1", SEARCHER_DRY_RUN_KEYLESS: "1" });
  delete process.env.MAINNET_RPC_URL;
  // Load the production catalog only after the original Family switches apply.
  const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import("./venues/production-family-composition.js");
  const { activeReadyMemos, UniverseRebuildCheckpointStore } = await import("./universe-rebuild-checkpoint.js");
  const { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } = await import("./universe-rebuild-production.js");
  const { assertReadyFamilyActivation } = await import("./universe-rebuild-runner.js");
  const { resolveStrictReadyRuntime } = await import("./strict-ready-runtime.js");
  const { StrictReadyGraphViewCoordinator } = await import("./strict-ready-graph-view.js");
  const { StrictProductionRuntimeRoot } = await import("./strict-production-runtime-session.js");
  const { familyId } = await import("./venues/adapter-family-identifiers.js");
  const { blockScanEdgeKey, exactSetHash } = await import("./venues/blockscan-state-capability.js");
  const { edgeInstanceKey } = await import("./venues/route-instance-identity.js");
  const { ADDR } = await import("../shared/constants/addresses.js");
  const readyPath = realpathSync(args.ready!), readySha256 = await fileHash(readyPath);
  console.log("[baseline-import] loading existing Ready; no discovery, attestation or price RPC");
  const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load();
  assert(envelope && !envelope.inProgressRun);
  const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
  const identity = { executor: config.BOTVM_ADDRESS?.toLowerCase(), transactionOrigin: config.BOTVM_OWNER?.toLowerCase() };
  assert(/^0x[0-9a-f]{40}$/.test(identity.executor) && /^0x[0-9a-f]{40}$/.test(identity.transactionOrigin));
  // This wiring is used only for local rehydration. No provider-backed method is called.
  const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", executionIdentity: identity });
  const memos = activeReadyMemos(envelope); assertReadyFamilyActivation(memos, wiring.isFamilyEnabled);
  const instances = [], funding = [];
  for (const memo of memos) {
    assert([familyDefinitionHash(memo.familyId), familyMemoDefinitionHash(memo.familyId)].includes(memo.familyDefinitionHash),
      "Ready Family definition changed; import cannot revalidate it");
    const family = catalog.forStrictFamily(familyId(memo.familyId));
    const value = wiring.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff });
    if (family.plugin.manifest.domain === "funding") funding.push({ familyId: familyId(memo.familyId), asset: (value as any).asset });
    else instances.push(value as import("./venues/adapter-family-runtime.js").PreparedFamilyInstance);
  }
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: ready.cutoff, readyGraph: graph,
    readyInstances: instances, readyFundingAssets: funding });
  const index = root.pricingIndex();
  const { record, effective, sha256: historySha256 } = await readBootstrapPriceLog(args.history!);
  const view = new StrictReadyGraphViewCoordinator({ catalog, ready, edges: graph }).build({
    id: "imported-bootstrap-data", topologyKey: `strict-ready:${ready.generation}:${ready.graphHash}`, edges: graph,
    sourceBlock: effective.source.number, sourceBlockHash: effective.source.hash, generation: effective.source.generation });
  assert.equal([view.orderedEdgeHash, view.metadataHash, view.ownershipHash, String(view.scannerEdgeCount), view.scannerEdgeKeyHash].join("\u001f"),
    record.graph_fingerprint, "price log and Ready graph differ");
  const edges = new Map(graph.map(edge => [blockScanEdgeKey(edge), edge]));
  const mids = new Map<string, RouteVenueMid>();
  for (const [key, mid] of record.mids) {
    const edge = edges.get(key); assert(edge && !mids.has(key), "raw mid graph key mismatch");
    mids.set(key, { kind: mid.kind, pool: edgeInstanceKey(edge), edges: [edge], mid: mid.mid,
      feeBps: mid.fee_bps, depthProxy: mid.depth_proxy,
      ...Object.fromEntries([["reserve_a", "reserveA"], ["reserve_b", "reserveB"], ["balance_headroom_in", "balanceHeadroomIn"],
        ["sqrt_ab_x96", "sqrtABX96"], ["liquidity", "liquidity"]].filter(([field]) => mid[field!] !== undefined)
        .map(([from, to]) => [to!, BigInt(mid[from!])])) });
  }
  const expected = [...index.expectedEdgeKeys].sort(), resolved = [...mids.keys()].sort(), unresolved = expected.filter(key => !mids.has(key));
  assert(resolved.every(key => index.stateKeyByEdgeKey.has(key)), "raw mid not owned by pricing index");
  const stateKeys = [...new Set(index.stateKeyByEdgeKey.values())].sort();
  const coverage = { expectedStateKeys: stateKeys, resolvedStateKeys: [], unresolvedStateKeys: stateKeys,
    expectedReadKeys: [], resolvedReadKeys: [], unresolvedReadKeys: [],
    expectedStateKeyHash: exactSetHash(stateKeys), resolvedStateKeyHash: exactSetHash([]), unresolvedStateKeyHash: exactSetHash(stateKeys),
    expectedReadKeyHash: exactSetHash([]), resolvedReadKeyHash: exactSetHash([]), unresolvedReadKeyHash: exactSetHash([]),
    expectedEdgeKeys: expected, resolvedEdgeKeys: resolved, unavailableEdgeKeys: [], unresolvedEdgeKeys: unresolved,
    refreshedEdgeKeys: resolved, carriedEdgeKeys: [], expectedEdgeKeyHash: exactSetHash(expected), resolvedEdgeKeyHash: exactSetHash(resolved),
    unavailableEdgeKeyHash: exactSetHash([]), unresolvedEdgeKeyHash: exactSetHash(unresolved),
    refreshedEdgeKeyHash: exactSetHash(resolved), carriedEdgeKeyHash: exactSetHash([]) };
  const raw: BlockScanStateSnapshot = { sourceBlock: effective.source.number, sourceBlockHash: effective.source.hash,
    generation: effective.source.generation, graph: view, mids, coverage,
    coverageByReadKey: new Map(), coverageByEdgeKey: new Map(), freshnessByReadKey: new Map(), stateByStateKey: new Map(),
    resolvedFamilyIds: [], incompleteFamilyIds: [], laneTelemetry: [],
    pricingStateKeyByEdgeKey: index.stateKeyByEdgeKey, pricingFamilyIdByEdgeKey: index.familyIdByEdgeKey,
    perBlockRefreshStateKeys: index.perBlockRefreshStateKeys };
  console.log(`[baseline-import] restoring ${effective.rows.size} saved rows; quote lookup is local-only`);
  const recovered = await recoverBootstrapLineage(raw, effective, ADDR.WETH);
  const baseline = { version: 1 as const, readyPath, readySha256, chainId: args["chain-id"]!, ...identity,
    owner: identity.transactionOrigin,
    pricingPolicy: { spreadBps: Number(config.SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS ?? 0),
      fixedWethInput: effective.reference === "fixed" ? effective.referenceWethInput : null,
      cascade: config.SEARCHER_BLOCKSCAN_EFFECTIVE_AMOUNT_CASCADE_ENABLED === "1" },
    pricing: { version: 1 as const, raw, pricing: { ...raw, effectiveMids: effective }, lineage: recovered.lineage, disabledInstances: [] },
    // This is the original first publication, before any search/simulation.
    // Canonical headers are checked by the benchmark before measurement.
    amounts: { version: 1 as const, headers: [], samples: [] } };
  writeHistoricalBenchmarkBaseline(resolve(out, "baseline.json"), baseline);
  assert.equal(await fileHash(readyPath), readySha256, "Ready changed during import");
  const proof = { schema: "existing-live-bootstrap-import/v1", runId: record.run_id, source: effective.source,
    historyPath: resolve(args.history!), historySha256, configPath: resolve(args.config!),
    configSha256: createHash("sha256").update(configBytes).digest("hex"), readyPath, readySha256,
    rawMids: mids.size, effectiveRows: effective.rows.size, quoted: [...effective.rows.values()].filter(r => r.status === "quoted").length,
    comparedRows: recovered.comparedRows, savedTupleLookups: recovered.savedTupleLookups, quoteRpcCalls: 0,
    fundingRestored: false, exactAuthorityRestored: false, networkRequests: 0, signing: false, broadcast: false,
    canonicalSourceCheck: "performed by benchmark before any measured pass", baselinePath: resolve(out, "baseline.json") };
  writeFileSync(resolve(out, "import-proof.json"), JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(proof));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  importLiveBaseline(process.argv.slice(2)).catch(error => {
    console.error(String(error.message).replace(/https?:\/\/[^\s"']+/g, "[URL_REDACTED]")); process.exitCode = 1;
  });
}
