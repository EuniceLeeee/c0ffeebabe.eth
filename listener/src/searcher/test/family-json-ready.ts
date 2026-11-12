import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAddress } from "ethers";
import { parseProtocolJsonAcceptanceCase, type ProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { StartupCheckpointEnvelope } from "../universe-rebuild-checkpoint.js";

const sameKey = (a: string, b: string) => isAddress(a) && isAddress(b) ? a.toLowerCase() === b.toLowerCase() : a === b;

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
  assert.equal(matches.length, 1, "case family/instance is absent or ambiguous in active Ready");
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

export interface FamilyReadyInput {
  familyId: string; domain: "swap" | "protocol" | "credit" | "funding";
  source: { number: number; hash: string }; executor: string; owner: string;
  rpcFile: string; out: string; revmBin?: string;
  executorCodeMode?: "deployed" | "counterfactual";
  simulationMethod?: "debug_traceCall" | "eth_simulateV1";
}

/** Only family and block scope enter the natural producer, never a target pool or route. */
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
  const request = { version: 1, familyId, domain, source, executor, owner,
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
  const store = new UniverseRebuildCheckpointStore({ path: out });
  const wiring = createRebuildWiring({ rpcUrl: rpc.MAINNET_RPC_URL, familyIds: [familyId],
    executionIdentity: { executor, transactionOrigin: owner },
    simulationMethod: method, ...(testExecutorProvisioning ? { testExecutorProvisioning } : {}) });
  const freeze = wiring.freezeCanonicalHead;
  await rebuildUniverse({ ...wiring, store, runId, observationRange: request.range, attestationConcurrency: 1,
    freezeCanonicalHead: async requested => {
      const actual = await freeze(requested); assert.equal(actual.number, source.number);
      assert.equal(actual.hash.toLowerCase(), source.hash.toLowerCase()); return actual;
    }, log: message => console.log(message.replaceAll(rpc.MAINNET_RPC_URL, "[REDACTED]")),
  });
  const envelope = await store.load(); assert(envelope, "producer did not persist a checkpoint");
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
