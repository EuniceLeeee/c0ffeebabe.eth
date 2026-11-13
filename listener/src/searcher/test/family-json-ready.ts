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
import { cachedFamilyReady, familyFactCacheDirectory, familyFactCacheKey, withFamilyFactCacheLock } from "./family-transaction-cache.js";
import type { UniverseRebuildDependencies } from "../universe-rebuild-runner.js";

import { validateTransactionStateSelection, type TransactionStateSelection } from "./family-transaction-source.js";

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
    concurrency: 1, attempts: 1, send, traceSend: (method, params) => {
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

/** TX receipt/trace transport is the existing Ready reader. Decode with the
 * production Catalog, then submit its candidates to normal Ready attestation.
 * No address, descriptor, graph edge or successful identity is synthesized. */
export async function discoverTransactionReadyInput(input: {
  wiring: UniverseRebuildDependencies;
  activityArchive: ReadyActivityArchive;
  directory: string;
  rpcUrl: string;
  familyId: string;
  target: TransactionReadyTarget;
  source: { number: number; hash: string; generation: number };
}) {
  const { wiring, source, target, familyId, activityArchive, directory } = input;
  const selection = target.stateSelection && validateTransactionStateSelection(target.stateSelection.evidenceSource, target.stateSelection);
  if (selection) { assert.equal(source.number, selection.executionSource.number); assert.equal(source.hash.toLowerCase(), selection.executionSource.hash.toLowerCase()); }
  const observationSource = selection ? { ...selection.evidenceSource, generation: selection.evidenceSource.number } : source;
  const discovery = await import("../universe-rebuild-production.js");
  // One canonical block archive shared by every tested Family. This is also
  // the source used by the normal Ready scanner, not another trace RPC path.
  await withFamilyFactCacheLock(resolve(directory, "activity", familyFactCacheKey(observationSource)), async () => {
    await wiring.scanSwapWindow({ fromBlock: observationSource.number, cutoff: observationSource });
  });
  const observations: unknown[] = [];
  const evidence = await readFamilyTransactionEvidence({ rpcUrl: input.rpcUrl, directory,
    transactionHash: target.transactionHash, source: observationSource,
    traceSend: async (method, params) => {
      assert.equal(params[0], target.transactionHash);
      if (method === "trace_transaction") {
        const raw = await activityArchive.readTrace({ blockNumber: observationSource.number, method: "trace_block" });
        if (raw !== null) return raw.filter(row => (row as any)?.transactionHash?.toLowerCase() === target.transactionHash);
        throw Object.assign(new Error("method not found in shared block archive"), { code: -32601 });
      }
      assert.equal(method, "debug_traceTransaction");
      const raw = await activityArchive.readTrace({ blockNumber: observationSource.number, method: "debug_traceBlockByNumber" });
      const matches = raw?.filter(row => String((row as any)?.txHash ?? (row as any)?.transactionHash).toLowerCase() === target.transactionHash);
      assert(matches?.length === 1, "TX not found uniquely in shared block trace");
      return (matches[0] as any).result;
    },
  });
  assert.equal(evidence.receipt.status, 1, "registered sample TX reverted on chain");
  const decoded = discovery.observationsFromSelectedTransaction(evidence,
    discovery.strictCatalogLogTopics(), new Set(discovery.strictCatalogCallPatterns().map(pattern => pattern.selector.toLowerCase())));
  observations.push(...decoded.logs, ...decoded.calls);
  // Other installed Families may recognize other pools in this TX. Their
  // absence/rejection is not a failure of the Family under acceptance.
  const all = observations.flatMap(raw => (raw as any).kind === "call"
    ? discovery.candidatesFromCall(raw as import("../universe-rebuild-production.js").RebuildCallObservation)
    : discovery.candidatesFromLog(raw as import("../universe-rebuild-production.js").RebuildScanObservation));
  const known = all.filter(candidate => candidate.familyId === familyId);
  const reverse = await wiring.reverseBindOpaqueCandidates?.({ observations, cutoff: source, knownCandidates: known }) ?? [];
  const candidates = wiring.dedupeFamilyCandidates([...known, ...reverse].map(candidate => ({ kind: "startup-candidate", candidate })));
  if (!candidates.length) throw Object.assign(new Error("TX discovery produced no candidate for the target Family"), {
    evidence: { familyId, target, source, recognizedFamilies: [...new Set(all.map(row => row.familyId))].sort(), identityAttempted: false },
  });
  const keys = [...new Set(candidates.map(candidate => wiring.familyCandidateKey(candidate)))].sort();
  const binding = { familyId, target, source, candidateKeys: keys };
  return { candidates: candidates as readonly Readonly<Record<string, unknown>>[],
    currentCandidateKeys: new Set(keys), currentInputFingerprint: familyFactCacheKey(binding),
    evidence: { ...binding, scope: "registered-transaction", observationCount: observations.length,
      recognizedCandidateCount: all.length, recognizedFamilies: [...new Set(all.map(row => row.familyId))].sort(),
      nominationOnly: true, identityBypass: false },
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
  assert.equal(instance.descriptor.lineageId, sample.lineageId, "case lineage differs from admitted instance");
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
      assert.equal(routes.length, 1, "case direction/route is absent or ambiguous in admitted instance");
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

/** Enumerate proven production routes, never classify a TX in the test layer. */
export async function transactionReadyRoutes(envelope: StartupCheckpointEnvelope, input: {
  source: { number: number; hash: string }; executor: string; owner: string;
}): Promise<import("./family-transaction-matching.js").ObservedReadyRoute[]> {
  const [{ activeReadyMemos }, { resolveStrictReadyRuntime }, { createRebuildWiring },
    { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog }, { projectFamilyRouteGraph }] = await Promise.all([
    import("../universe-rebuild-checkpoint.js"), import("../strict-ready-runtime.js"),
    import("../universe-rebuild-production.js"), import("../venues/production-family-composition.js"),
    import("../adapter-family-graph-runtime.js"),
  ]);
  assert.equal(envelope.inProgressRun, null, "matching requires a committed checkpoint");
  const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
  assert.equal(ready.cutoff.number, input.source.number);
  assert.equal(ready.cutoff.hash.toLowerCase(), input.source.hash.toLowerCase());
  const memos = activeReadyMemos(envelope);
  const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [...new Set(memos.map(m => m.familyId))],
    executionIdentity: { executor: input.executor, transactionOrigin: input.owner } });
  const result: import("./family-transaction-matching.js").ObservedReadyRoute[] = [];
  for (const memo of memos) {
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "matching Ready definition is stale");
    const family = catalog.forStrictFamily(memo.familyId as never);
    if (family.plugin.manifest.domain !== "protocol" && family.plugin.manifest.domain !== "swap") continue;
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: ready.cutoff }) as import("../venues/adapter-family-runtime.js").PreparedFamilyInstance;
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey); assert(handle);
      const edge = projectFamilyRouteGraph({ family: family as import("../venues/family-capability-catalog.js").LoadedFamilyPlugin,
        descriptor: instance.descriptor, route, handle }).edge;
      assertUniqueAcceptanceGraphEdge(graph, edge);
      const action = family.plugin.actionAdapters.find(a => a.id === edge.adapterId); assert(action, "route action missing");
      result.push({ familyId: memo.familyId, instanceKey: instance.instanceKey, lineageId: instance.descriptor.lineageId,
        routeKey: route.routeKey, adapterId: edge.adapterId!, target: edge.target!, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
        direction: action.descriptor.action, executionAssets: route.executionAssets, matchTrace: (target, selector) => action.matchTrace(target, selector) });
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
  const mode = input.executorCodeMode ?? "deployed", method = input.simulationMethod ?? "debug_traceCall";
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
  const request = { version: 2, familyId, domain, source, executor, owner,
    ...(input.target ? { target: input.target } : {}),
    executorCodeMode: mode, simulationMethod: method,
    ...(testExecutorProvisioning ? { executorCodeHash: testExecutorProvisioning.runtimeCode.keccak256, artifactSha256 } : {}),
    range: { fromBlock: source.number, toBlock: source.number } };
  const runId = `family-facts-${createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 20)}`;
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
  assert.equal(catalog.forStrictFamily(familyId as never).plugin.manifest.domain, domain);
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
  const observationArchive = stateSelection?.mode === "parent" ? makeArchive(stateSelection.evidenceSource) : activityArchive;
  const makeWiring = (startupCandidates?: readonly Readonly<Record<string, unknown>>[], archive = activityArchive) => createRebuildWiring({
    rpcUrl: rpc.MAINNET_RPC_URL, familyIds: [familyId], activityArchive: archive, startupCandidates,
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
  const binding = { request, preparationSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    reviewInput: wiring.readyReviewInputFingerprint!(),
    familyDefinition: wiring.familyDefinitionHash!(familyId), discoveryDefinition: wiring.familyDiscoveryDefinitionHash(familyId),
    familyEnabled: wiring.isFamilyEnabled!(familyId),
    readyPreparation: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    lifecycle: ["universe-rebuild-production.ts", "strict-identity-attestation.ts", "universe-rebuild-runner.ts", "universe-rebuild-checkpoint.ts", "strict-ready-runtime.ts", "ready-transaction-input.ts"].map(name =>
      [name, createHash("sha256").update(readFileSync(new URL(`../${name}`, import.meta.url))).digest("hex")]) };
  const cache = await cachedFamilyReady({ directory, binding, out, build: async path => {
    const store = new UniverseRebuildCheckpointStore({ path });
    const selection = input.target ? await discoverTransactionReadyInput({ wiring: observationArchive === activityArchive ? wiring : makeWiring(undefined, observationArchive), familyId, activityArchive: observationArchive,
      directory, rpcUrl: rpc.MAINNET_RPC_URL, target: input.target, source: await freeze() }) : undefined;
    if (selection) writeFileSync(`${out}.discovery.json`, JSON.stringify(selection.evidence, null, 2) + "\n", { mode: 0o600 });
    await rebuildUniverse({ ...(selection ? makeWiring(selection.candidates) : wiring),
      ...(selection ? { currentCandidateKeys: selection.currentCandidateKeys, currentInputFingerprint: selection.currentInputFingerprint } : {}),
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

/** Thin preparation CLI. The sample selects a source block and one installed
 * Family; no pool, expected route, output or admission enters production scan. */
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
