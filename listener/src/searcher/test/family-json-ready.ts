import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAddress, JsonRpcProvider } from "ethers";
import { parseProtocolJsonAcceptanceCase, type ProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { StartupCheckpointEnvelope } from "../universe-rebuild-checkpoint.js";
import { ReadyActivityArchive } from "../ready-activity-archive.js";
import { cachedFamilyReady, familyFactCacheDirectory, familyFactCacheKey } from "./family-transaction-cache.js";
import type { UniverseRebuildDependencies } from "../universe-rebuild-runner.js";

import { validateTransactionStateSelection, type TransactionStateSelection } from "./family-transaction-source.js";
import { canonicalExecutionCall, sameExecutionResource, transactionSelectorCensus } from "./family-transaction-selector.js";
import type { ReadySelectorCensusTransaction } from "../ready-selector-census.js";

const sameKey = (a: string, b: string) => isAddress(a) && isAddress(b) ? a.toLowerCase() === b.toLowerCase() : a === b;

export interface TransactionReadyTarget {
  transactionHash: string;
  instanceKey: string;
  stateSelection?: TransactionStateSelection;
}

/** Shared production TX transport/cache, also used after a Ready cache hit. */
export async function readFamilyTransactionEvidence(input: {
  rpcUrl: string; directory: string; transactionHash: string;
  source: { number: number; hash: string; generation: number };
  withFrameLogs?: boolean;
  traceSend?: (method: string, params: readonly unknown[]) => Promise<unknown>;
}) {
  const { ReadyTransactionReader, parseReadyTransactionInput } = await import("../ready-transaction-input.js");
  const provider = new JsonRpcProvider(input.rpcUrl, 1, { staticNetwork: true });
  const reads = { receipt: 0, trace: 0, canonical: 0 };
  const send = (method: string, params: readonly unknown[]) => {
    if (method === "eth_getTransactionReceipt") reads.receipt++;
    if (method === "eth_getBlockByNumber") reads.canonical++;
    return provider.send(method, [...params]);
  };
  const { observationsFromSelectedTransaction } = await import("../universe-rebuild-production.js");
  const reader = new ReadyTransactionReader({
    selection: parseReadyTransactionInput(`transaction_hash,block_number,block_hash\n${input.transactionHash},${input.source.number},${input.source.hash}`),
    cacheDir: resolve(input.directory, "transactions", input.source.hash),
    concurrency: 1, attempts: 1, traceWithLogs: input.withFrameLogs !== false, send, traceSend: (method, params) => {
      reads.trace++; return (input.traceSend ?? send)(method, params);
    },
  });
  let result: import("../ready-transaction-input.js").ReadyTransactionEvidence | undefined;
  try {
    assert.deepEqual(await reader.prepare(), { fromBlock: input.source.number, toBlock: input.source.number });
    await reader.scan(input.source, async evidence => {
      assert(!result, "multiple selected TXs");
      observationsFromSelectedTransaction(evidence, [], new Set()); // Validate before the reader seals its cache.
      result = evidence;
    });
    assert(result, "selected TX evidence unavailable");
    return { ...result, cache: { receipt: reads.receipt ? "read" : "reused", trace: reads.trace ? "read" : "reused",
      canonicalRpcReads: reads.canonical } };
  } finally { provider.destroy(); }
}

/** Decode every observed call with the active production selector catalog.
 * Fixture protocol labels never restrict discovery; unsupported selectors stay
 * in the census. Historical trace transport belongs only to this diagnostic. */
export async function discoverTransactionReadyInput(input: {
  wiring: UniverseRebuildDependencies;
  directory: string;
  rpcUrl: string;
  familyIds: readonly string[];
  target: TransactionReadyTarget;
  source: { number: number; hash: string; generation: number };
}) {
  const { wiring, source, target, familyIds, directory } = input;
  const selection = target.stateSelection && validateTransactionStateSelection(target.stateSelection.evidenceSource, target.stateSelection);
  if (selection) { assert.equal(source.number, selection.executionSource.number); assert.equal(source.hash.toLowerCase(), selection.executionSource.hash.toLowerCase()); }
  const observationSource = selection ? { ...selection.evidenceSource, generation: selection.evidenceSource.number } : source;
  const evidence = await readFamilyTransactionEvidence({ rpcUrl: input.rpcUrl, directory,
    transactionHash: target.transactionHash, source: observationSource });
  assert.equal(evidence.receipt.status, 1, "registered sample TX reverted on chain");
  const census = transactionSelectorCensus(evidence);
  const { candidatesFromCall, candidatesFromLog } = await import("../universe-rebuild-production.js");
  const observations = census.calls.flatMap(call => call.executionStatus === "success" && call.target && call.calldata && call.selector && call.traceAddress
    ? [{ kind: "call" as const, target: call.target, data: call.calldata, ...(call.sender ? { sender: call.sender } : {}),
      transactionHash: census.transactionHash!, blockNumber: census.blockNumber!, blockHash: census.blockHash!, traceAddress: call.traceAddress,
      opaque: { selectorCensus: census, callId: call.id } as unknown as import("../venues/canonical-value.js").CanonicalValue }] : []);
  const all = observations.flatMap(call => candidatesFromCall(call, familyIds));
  // Funding and other non-selector domains retain their owning log decoders.
  for (const raw of evidence.receipt.logs as any[]) all.push(...candidatesFromLog({ address: raw.address,
    topics: raw.topics, data: raw.data, transactionHash: census.transactionHash!, blockNumber: census.blockNumber!,
    blockHash: census.blockHash!, logIndex: Number(raw.logIndex) }, familyIds));
  const candidates = wiring.dedupeFamilyCandidates(all.map(candidate => ({ kind: "startup-candidate", candidate })));
  const keys = [...new Set(candidates.map(candidate => wiring.familyCandidateKey(candidate)))].sort();
  const binding = { familyIds, target: { transactionHash: target.transactionHash,
    ...(target.stateSelection ? { stateSelection: target.stateSelection } : {}) }, source, candidateKeys: keys, censusFingerprint: familyFactCacheKey(census) };
  return { census, candidates: candidates as readonly Readonly<Record<string, unknown>>[],
    currentCandidateKeys: new Set(keys), currentInputFingerprint: familyFactCacheKey(binding),
    evidence: { ...binding, scope: "registered-transaction-full-active-catalog", observationCount: census.calls.length,
      recognizedCandidateCount: all.length, recognizedFamilies: [...new Set(all.map(row => row.familyId))].sort(),
      nominationOnly: true, identityBypass: false, censusCoverage: census.coverage },
  };
}

export function readyTargetOutcomes(envelope: StartupCheckpointEnvelope, familyId: string) {
  const partition = envelope.readyGeneration?.familyPartitions?.[familyId];
  return Object.entries(partition?.outcomesByCandidateKey ?? {}).map(([key, outcome]) => ({ candidateKey: key, ...outcome }));
}

/** Compare every public edge field against the actual production projection. */
export function assertUniqueAcceptanceGraphEdge(graph: readonly TokenEdge[], expected: TokenEdge): TokenEdge {
  assert(expected.canonicalEdgeId && expected.instanceKey && expected.executionVariantKey && expected.adapterId &&
    expected.target && expected.tokenIn && expected.tokenOut && expected.slotKind && expected.edgeKind &&
    typeof expected.leavesStandingPosition === "boolean", "production edge is incomplete");
  const matches = graph.filter(edge => edge.canonicalEdgeId === expected.canonicalEdgeId ||
    sameKey(edge.instanceKey ?? "", expected.instanceKey!) && edge.executionVariantKey === expected.executionVariantKey &&
    sameKey(edge.tokenIn, expected.tokenIn) && sameKey(edge.tokenOut, expected.tokenOut));
  assert.equal(matches.length, 1, "case requires one unique production Graph edge");
  assert.deepEqual(matches[0], expected, "checkpoint Graph edge differs from complete production projection");
  return matches[0]!;
}

export async function assertAcceptanceReadyTarget(envelope: StartupCheckpointEnvelope, sample: ProtocolJsonAcceptanceCase) {
  const [{ activeReadyMemos }, { resolveStrictReadyRuntime }, { createRebuildWiring },
    { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog }] = await Promise.all([
    import("../universe-rebuild-checkpoint.js"), import("../strict-ready-runtime.js"),
    import("../universe-rebuild-production.js"), import("../venues/production-family-composition.js"),
  ]);
  assert.equal(envelope.inProgressRun, null, "target requires a committed checkpoint");
  const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
  assert.equal(ready.cutoff.number, sample.source.number);
  assert.equal(ready.cutoff.hash.toLowerCase(), sample.source.hash.toLowerCase());
  const family = catalog.forStrictFamily(sample.familyId as never);
  assert.equal(family.plugin.manifest.domain, sample.domain ?? "protocol");
  const matches = activeReadyMemos(envelope).filter(m => m.familyId === sample.familyId && sameKey(m.instanceKey, sample.instanceKey));
  if (matches.length !== 1) throw Object.assign(new Error("target instance did not produce one admitted Ready identity"), {
    evidence: { familyId: sample.familyId, instanceKey: sample.instanceKey,
      admittedMatches: matches.length, outcomes: readyTargetOutcomes(envelope, sample.familyId) },
  });
  const memo = matches[0]!;
  const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [sample.familyId],
    executionIdentity: { executor: sample.executor, transactionOrigin: sample.owner } });
  assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "case Ready definition is stale");
  const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff }) as import("../venues/adapter-family-runtime.js").PreparedFamilyInstance;
  assert.equal(instance.familyId, sample.familyId); assert(sameKey(instance.instanceKey, sample.instanceKey));
  assert.equal(instance.descriptor.lineageId, sample.lineageId, "stale fixture: regenerate required (case lineage differs from admitted instance)");
  const [{ projectFamilyRouteGraph }, { prepareCreditFamilyRoutes, projectCreditRouteGraph }] = await Promise.all([
    import("../adapter-family-graph-runtime.js"), import("../adapter-credit-runtime.js"),
  ]);
  const credit = family.plugin.manifest.domain === "credit"
    ? prepareCreditFamilyRoutes({ family, instance, source: ready.cutoff, generation: ready.cutoff.generation }) : undefined;
  const edges = sample.trials.map(trial => {
    let expected: TokenEdge;
    if (credit) {
      // Unpriced Credit instances intentionally have no ordinary routes. Its
      // issued Credit handles and public Graph projection own these directions.
      const candidates = credit.routes.map(handle => ({ handle, edge: projectCreditRouteGraph({ family, route: handle }).edge }))
        .filter(({ handle, edge }) => sameKey(edge.tokenIn, trial.tokenIn) && sameKey(edge.tokenOut, trial.tokenOut) &&
          (trial.routeKey === undefined || handle.routeKey === trial.routeKey));
      assert.equal(candidates.length, 1, "case Credit direction/route is absent or ambiguous in admitted instance");
      expected = candidates[0]!.edge;
    } else {
      const routes = instance.routes.filter(route => sameKey(route.tokenIn, trial.tokenIn) && sameKey(route.tokenOut, trial.tokenOut) &&
        (trial.routeKey === undefined || route.routeKey === trial.routeKey));
      assert.equal(routes.length, 1, "stale fixture: regenerate required (case direction/route is absent or ambiguous in admitted instance)");
      const route = routes[0]!;
      const handle = instance.routeHandles.find(item => item.routeKey === route.routeKey); assert(handle, "route handle missing");
      expected = projectFamilyRouteGraph({ family: family as import("../venues/family-capability-catalog.js").LoadedFamilyPlugin,
        descriptor: instance.descriptor, route, handle }).edge;
    }
    return assertUniqueAcceptanceGraphEdge(graph, expected);
  });
  return { familyId: sample.familyId, instanceKey: sample.instanceKey, lineageId: sample.lineageId,
    source: ready.cutoff, memoFingerprint: memo.memoFingerprint, graphHash: ready.graphHash, edges };
}

/** Index the existing graph for diagnostics; never construct another graph or
 * skip full field equality. This keeps large sealed Ready inspection linear. */
function acceptanceGraphLookup(graph: readonly TokenEdge[]) {
  const byId = new Map<string, number[]>(), byBinding = new Map<string, number[]>();
  const key = (edge: TokenEdge) => JSON.stringify([isAddress(edge.instanceKey ?? "") ? edge.instanceKey!.toLowerCase() : edge.instanceKey,
    edge.executionVariantKey, edge.tokenIn.toLowerCase(), edge.tokenOut.toLowerCase()]);
  graph.forEach((edge, index) => {
    const add = (map: Map<string, number[]>, key: string) => { const entries = map.get(key); if (entries) entries.push(index); else map.set(key, [index]); };
    if (edge.canonicalEdgeId) add(byId, edge.canonicalEdgeId);
    add(byBinding, key(edge));
  });
  return (expected: TokenEdge) => {
    const candidates = [...new Set([...(byId.get(expected.canonicalEdgeId ?? "") ?? []), ...(byBinding.get(key(expected)) ?? [])])];
    return assertUniqueAcceptanceGraphEdge(candidates.map(index => graph[index]!), expected);
  };
}

/** Enumerate proven production routes, never classify a TX in the test layer. */
export async function transactionReadyRoutes(envelope: StartupCheckpointEnvelope, input: {
  source: { number: number; hash: string }; executor: string; owner: string;
}): Promise<import("./family-transaction-matching.js").ObservedReadyRoute[]> {
  const [{ activeReadyMemos }, { resolveStrictReadyRuntime }, { createRebuildWiring },
    { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog }, { projectFamilyRouteGraph },
    { prepareCreditFamilyRoutes, projectCreditRouteGraph }] = await Promise.all([
    import("../universe-rebuild-checkpoint.js"), import("../strict-ready-runtime.js"),
    import("../universe-rebuild-production.js"), import("../venues/production-family-composition.js"),
    import("../adapter-family-graph-runtime.js"),
    import("../adapter-credit-runtime.js"),
  ]);
  assert.equal(envelope.inProgressRun, null, "matching requires a committed checkpoint");
  const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
  assert.equal(ready.cutoff.number, input.source.number);
  assert.equal(ready.cutoff.hash.toLowerCase(), input.source.hash.toLowerCase());
  const memos = activeReadyMemos(envelope);
  const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [...new Set(memos.map(m => m.familyId))],
    executionIdentity: { executor: input.executor, transactionOrigin: input.owner } });
  const result: import("./family-transaction-matching.js").ObservedReadyRoute[] = [];
  const assertGraphEdge = acceptanceGraphLookup(graph);
  for (const memo of memos) {
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "matching Ready definition is stale");
    const family = catalog.forStrictFamily(memo.familyId as never);
    if (family.plugin.manifest.domain !== "protocol" && family.plugin.manifest.domain !== "swap" && family.plugin.manifest.domain !== "credit") continue;
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff }) as import("../venues/adapter-family-runtime.js").PreparedFamilyInstance;
    const credit = family.plugin.manifest.domain === "credit"
      ? prepareCreditFamilyRoutes({ family, instance, source: ready.cutoff, generation: ready.cutoff.generation }) : undefined;
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey); assert(handle);
      const creditHandle = credit?.routes.find(h => h.routeKey === route.routeKey);
      if (credit) assert(creditHandle, "Credit route handle missing");
      const projection = creditHandle ? projectCreditRouteGraph({ family, route: creditHandle })
        : projectFamilyRouteGraph({ family: family as import("../venues/family-capability-catalog.js").LoadedFamilyPlugin,
          descriptor: instance.descriptor, route, handle });
      const edge = projection.edge;
      assertGraphEdge(edge);
      const action = family.plugin.actionAdapters.find(a => a.id === edge.adapterId); assert(action, "route action missing");
      const venue = projection.graph.venueIdentity as any, scope = venue?.scope;
      const execution = typeof venue?.signature === "string" && typeof venue?.selector === "string" && scope ? {
        domain: family.plugin.manifest.domain as "swap" | "protocol" | "credit", target: edge.target, selector: venue.selector, signature: venue.signature,
        ...Object.fromEntries(["poolId", "poolNamespace", "tokenInId", "tokenOutId"].flatMap(key => scope[key] === undefined ? [] : [[key, String(scope[key])]])),
      } : undefined;
      const sourceDescriptor = (instance.descriptor as any).bound?.descriptor;
      result.push({ familyId: memo.familyId, instanceKey: instance.instanceKey, lineageId: instance.descriptor.lineageId,
        routeKey: route.routeKey, adapterId: edge.adapterId!, target: edge.target!, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
        direction: action.descriptor.action, executionAssets: route.executionAssets,
        ...(execution ? { execution,
          referenceInstanceKeys: [sourceDescriptor?.instanceKey].filter((key): key is string => typeof key === "string"),
          referenceRouteKeys: [(route as any).innerRouteKey].filter((key): key is string => typeof key === "string"),
          matchCall(call: import("../universe-rebuild-production.js").RebuildCallObservation, census: ReadySelectorCensusTransaction) {
            if (!canonicalExecutionCall(execution.signature, edge.target, call)) return false;
            const matches = census.calls.filter(observed => observed.target?.toLowerCase() === call.target.toLowerCase() &&
              observed.calldata?.toLowerCase() === call.data.toLowerCase() && JSON.stringify(observed.traceAddress) === JSON.stringify(call.traceAddress));
            if (matches.length !== 1) return false;
            const pattern = family.plugin.discovery.callPatterns?.find(pattern => pattern.selector.toLowerCase() === execution.selector.toLowerCase());
            if (!pattern) return false;
            const observed = matches[0]!;
            const candidate: any = family.plugin.discovery.decodeCandidate({ matchedPatternId: pattern.id, observation: {
              kind: "call", target: call.target, data: call.data, ...(call.sender ? { sender: call.sender } : {}),
              transactionHash: census.transactionHash!, source: { number: census.blockNumber!, hash: census.blockHash!, generation: census.blockNumber! },
              opaque: { selectorCensus: census, callId: observed.id },
            } as never });
            if (!candidate?.scope) return false;
            for (const key of ["target", "poolId", "parameterKey"])
              if (!sameExecutionResource(String(candidate.scope[key] ?? ""), String(scope[key] ?? ""))) return false;
            if (candidate.scope.poolNamespace !== scope.poolNamespace) return false;
            for (const key of ["tokenInId", "tokenOutId"])
              if (scope[key] !== undefined && String(candidate.scope[key] ?? "") !== String(scope[key])) return false;
            return true;
          },
        } : {}),
        matchTrace: (target, selector) => action.matchTrace(target, selector) });
    }
  }
  return result;
}

export interface FamilyReadyInput {
  familyId: string; domain: "swap" | "protocol" | "credit" | "funding";
  source: { number: number; hash: string }; executor: string; owner: string;
  rpcFile: string; out: string; revmBin?: string;
  executorCodeMode?: "deployed" | "counterfactual";
  simulationMethod?: "debug_traceCall" | "eth_simulateV1";
  target?: TransactionReadyTarget;
}

/** Test inputs select a TX/instance; admission always uses the production lifecycle. */
export async function prepareFamilyReady(input: FamilyReadyInput) {
  const { familyId, domain, source, executor, owner, rpcFile, out } = input;
  const mode = input.executorCodeMode ?? "counterfactual", method = input.simulationMethod ?? "eth_simulateV1";
  assert(["deployed", "counterfactual"].includes(mode)); assert(["debug_traceCall", "eth_simulateV1"].includes(method));
  let testExecutorProvisioning: { owner: string; runtimeCode: import("../revm-sim-client.js").ExecutorRuntimeCode } | undefined;
  let artifactSha256: string | undefined;
  if (mode === "counterfactual") {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const bytes = readFileSync(resolve(root, "out/BotVM.sol/BotVM.json"));
    const [{ verifyAcceptanceBotVmArtifact }, { loadBotVmRuntimeCode }] = await Promise.all([
      import("./protocol-json-acceptance-context.js"), import("../../shared/executor/botvm-executor.js"),
    ]);
    verifyAcceptanceBotVmArtifact(root, bytes);
    testExecutorProvisioning = { owner, runtimeCode: loadBotVmRuntimeCode(owner) };
    artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const [{ selectorReadyFamilyIds }, { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: activeCatalog }] = await Promise.all([
    import("../universe-rebuild-production.js"), import("../venues/production-family-composition.js"),
  ]);
  const selectorMode = input.target !== undefined;
  const familyIds = selectorMode ? selectorReadyFamilyIds() : activeCatalog.listAll().map(family => String(family.plugin.manifest.familyId)).sort();
  const request = { version: 3, referenceFamilyId: familyId, domain, familyIds, bindingMode: selectorMode ? "selector" : "legacy", source, executor, owner,
    ...(input.target ? { target: input.target } : {}),
    executorCodeMode: mode, simulationMethod: method,
    ...(testExecutorProvisioning ? { executorCodeHash: testExecutorProvisioning.runtimeCode.keccak256, artifactSha256 } : {}),
    range: { fromBlock: source.number, toBlock: source.number } };
  const preparationRequest = selectorMode ? { ...request, referenceFamilyId: undefined, domain: undefined,
    target: input.target && { transactionHash: input.target.transactionHash,
      ...(input.target.stateSelection ? { stateSelection: input.target.stateSelection } : {}) } } : request;
  const runId = `family-facts-${createHash("sha256").update(JSON.stringify(preparationRequest)).digest("hex").slice(0, 20)}`;
  const manifestPath = `${out}.request.json`;
  if (existsSync(manifestPath)) assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), request, "Ready preparation request changed");
  else { assert(!existsSync(out), "refusing an unrelated existing checkpoint"); writeFileSync(manifestPath, JSON.stringify(request, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  const rpc = JSON.parse(readFileSync(rpcFile, "utf8"));
  assert(typeof rpc.MAINNET_RPC_URL === "string", "RPC configuration lacks MAINNET_RPC_URL");
  const url = new URL(rpc.MAINNET_RPC_URL); assert(["http:", "https:"].includes(url.protocol), "invalid archive transport");
  process.env.SEARCHER_DRY_RUN = "1";
  if (input.revmBin) {
    process.env.SEARCHER_READY_REVM_SIM_BIN = input.revmBin;
    process.env.SEARCHER_REVM_SIM_BIN = input.revmBin;
  }
  const [{ createRebuildWiring }, { rebuildUniverse }, { UniverseRebuildCheckpointStore },
    { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog }] = await Promise.all([
    import("../universe-rebuild-production.js"), import("../universe-rebuild-runner.js"),
    import("../universe-rebuild-checkpoint.js"), import("../venues/production-family-composition.js"),
  ]);
  if (!selectorMode && (domain === "credit" || domain === "funding")) assert.equal(catalog.forStrictFamily(familyId as never).plugin.manifest.domain, domain);
  const directory = familyFactCacheDirectory();
  // Raw logs/trace are shared across Families. A producer change (including
  // tracer configuration) changes this key; Family classifiers stay separate.
  const producerSha256 = createHash("sha256").update(readFileSync(new URL("../universe-rebuild-production.ts", import.meta.url))).digest("hex");
  const makeArchive = (at: { number: number; hash: string }) => {
    const scope = { chainId: 1, fromBlock: at.number, toBlock: at.number, cutoffHash: at.hash };
    return new ReadyActivityArchive({ ...scope,
      directory: resolve(directory, "activity", familyFactCacheKey({ ...scope, producerSha256 })) });
  };
  const activityArchive = makeArchive(source);
  const stateSelection = input.target?.stateSelection;
  if (stateSelection) {
    validateTransactionStateSelection(stateSelection.evidenceSource, stateSelection);
    assert.equal(source.number, stateSelection.executionSource.number);
    assert.equal(source.hash.toLowerCase(), stateSelection.executionSource.hash.toLowerCase());
  }
  const makeWiring = (startupCandidates?: readonly Readonly<Record<string, unknown>>[], census?: readonly ReadySelectorCensusTransaction[]) => createRebuildWiring({
    rpcUrl: rpc.MAINNET_RPC_URL, familyIds, ...(selectorMode ? { selectorCensus: census ?? [], tracePolicy: "forbid" as const }
      : { activityArchive }), startupCandidates,
    executionIdentity: { executor, transactionOrigin: owner },
    ...(stateSelection?.mode === "parent" ? { testTransactionObservation: {
      transactionHash: input.target!.transactionHash,
      source: { ...stateSelection.evidenceSource, generation: stateSelection.evidenceSource.number },
    } } : {}),
    simulationMethod: method, ...(testExecutorProvisioning ? { testExecutorProvisioning } : {}) });
  const wiring = makeWiring();
  const freeze = async (requested = source.number) => {
    const actual = await wiring.freezeCanonicalHead(requested); assert.equal(actual.number, source.number);
    assert.equal(actual.hash.toLowerCase(), source.hash.toLowerCase()); return actual;
  };
  await freeze(); // A cached number never bypasses canonical source verification.
  const binding = { request: preparationRequest, preparationSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    reviewInput: wiring.readyReviewInputFingerprint!(),
    families: familyIds.map(id => ({ familyId: id, definition: wiring.familyDefinitionHash!(id),
      discoveryDefinition: wiring.familyDiscoveryDefinitionHash(id), enabled: wiring.isFamilyEnabled!(id) })),
    readyPreparation: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    lifecycle: ["universe-rebuild-production.ts", "strict-identity-attestation.ts", "universe-rebuild-runner.ts", "universe-rebuild-checkpoint.ts", "strict-ready-runtime.ts", "ready-transaction-input.ts"].map(name =>
      [name, createHash("sha256").update(readFileSync(new URL(`../${name}`, import.meta.url))).digest("hex")]) };
  const cache = await cachedFamilyReady({ directory, binding, out, build: async path => {
    const store = new UniverseRebuildCheckpointStore({ path });
    const selection = input.target ? await discoverTransactionReadyInput({ wiring, familyIds,
      directory, rpcUrl: rpc.MAINNET_RPC_URL, target: input.target, source: await freeze() }) : undefined;
    if (selection) writeFileSync(`${out}.discovery.json`, JSON.stringify(selection.evidence, null, 2) + "\n", { mode: 0o600 });
    // The supplied-census production path includes unknown selectors in its
    // durable coverage ledger. Parent-state diagnostics keep later observations
    // as explicit nominations, never claim them as parent-block activity.
    const selectedWiring = selection ? !selectorMode ? makeWiring(selection.candidates) : stateSelection?.mode === "parent"
      ? makeWiring(selection.candidates, []) : makeWiring(undefined, [selection.census]) : wiring;
    await rebuildUniverse({ ...selectedWiring,
      ...(selection && (!selectorMode || stateSelection?.mode === "parent") ? { currentCandidateKeys: selection.currentCandidateKeys, currentInputFingerprint: selection.currentInputFingerprint } : {}),
      store, runId, observationRange: request.range, attestationConcurrency: 1,
      freezeCanonicalHead: freeze, log: message => console.log(message.replaceAll(rpc.MAINNET_RPC_URL, "[REDACTED]")) });
    const built = await store.load();
    assert(built && built.inProgressRun === null, "production Ready did not finish");
  } });
  await freeze();
  const envelope = await new UniverseRebuildCheckpointStore({ path: out }).load();
  assert(envelope && envelope.inProgressRun === null, "producer did not persist committed Ready");
  // Preserve reject/retryable statuses. A cached checkpoint is not target acceptance.
  writeFileSync(`${out}.cache.json`, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
  console.log(`[family-facts] Ready ${cache.status} key=${cache.key}`);
  return envelope;
}

/** Thin preparation CLI. Samples select an observation/state anchor; the active
 * catalog and production lifecycle own admission and route construction. */
export async function familyJsonReadyMain(argv = process.argv.slice(2)) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--case", "--rpc-file", "--revm-bin", "--out"].includes(argv[i]) && !args.has(argv[i]) && argv[i + 1], "invalid Ready arguments");
    args.set(argv[i], resolve(argv[i + 1]));
  }
  assert(args.has("--case") && args.has("--rpc-file") && args.has("--out"), "--case --rpc-file --out are required");
  const bytes = readFileSync(args.get("--case")!), sample = parseProtocolJsonAcceptanceCase(JSON.parse(bytes.toString()));
  const out = args.get("--out")!;
  const envelope = await prepareFamilyReady({ ...sample, domain: sample.domain ?? "protocol", rpcFile: args.get("--rpc-file")!,
    out, revmBin: args.get("--revm-bin") });
  const target = await assertAcceptanceReadyTarget(envelope, sample);
  console.log(JSON.stringify({ readyPath: out, ...target }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  familyJsonReadyMain().catch(error => {
    const message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"'<>]+/g, "[REDACTED_RPC]").slice(0, 4000);
    console.error(`Family JSON Ready preparation failed: ${message}; checkpoint and request retained`);
    process.exitCode = 1;
  });
