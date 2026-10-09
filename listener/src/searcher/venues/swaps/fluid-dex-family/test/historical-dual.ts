// Same-N Fluid single-leg evidence through production issuance and the local
// strict EVM. This is not original-TX replay, final route sim, or performance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { concatBytes } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../../../../shared/executor/botvm-program-entry.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { FLUID_DEX_FAMILY_ID } from "../manifest.js";

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function sourceFingerprint() {
  const names = execFileSync("git", ["-c", `safe.directory=${ROOT.replace(/\/$/, "")}`,
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "listener/src", "src"],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 })
    .split("\0").filter(p => /\.(ts|sol)$/.test(p) && !p.includes("/test/")).sort();
  return sha(names.map(p => `${p}\0${sha(readFileSync(resolve(ROOT, p)))}`).join("\n"));
}

async function main() {
  const names = ["--ready", "--prices", "--pool", "--rpc-file", "--revm-bin", "--executor", "--owner", "--out"];
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(names.includes(process.argv[i]) && !args.has(process.argv[i]) && process.argv[i + 1]);
    args.set(process.argv[i], process.argv[i + 1]);
  }
  assert(names.every(n => args.has(n)));
  const out = resolve(args.get("--out")!); assert(!existsSync(out));
  const readyPath = resolve(args.get("--ready")!), pricePath = resolve(args.get("--prices")!);
  const readyBytes = readFileSync(readyPath), priceBytes = readFileSync(pricePath);
  const pool = ethers.getAddress(args.get("--pool")!), executor = ethers.getAddress(args.get("--executor")!),
    owner = ethers.getAddress(args.get("--owner")!);
  assert(!same(executor, owner) && !same(executor, pool));
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  const redact = (s: string) => s.split(rpcUrl).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const report: any = { schema: "fluid-native-dual/v1", result: "failed", pool, executor, owner,
    claim: "current production issued quote/quoted/runtime same-N single-leg receipts, not original TX/full-route/performance acceptance",
    broadcast: false, signing: false, readyPath, pricePath, readySha256: sha(readyBytes), pricesSha256: sha(priceBytes),
    sourceFingerprint: sourceFingerprint(), harnessSha256: sha(readFileSync(fileURLToPath(import.meta.url))), samples: [], wire: [] };
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined;
  let stage = "inputs", constructing = false, quoteReads = 0;
  const control = { signal: AbortSignal.timeout(480000), deadlineAtMs: Date.now() + 480000 };
  try {
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load();
    assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
    const source = ready.cutoff, pin = { blockHash: source.hash, requireCanonical: true };
    assert.equal(ready.universeRange.fromBlock, source.number); assert.equal(ready.universeRange.toBlock, source.number);
    const saved = parseAtBlockJson(priceBytes.toString());
    assert.equal(saved.readySha256, sha(readyBytes)); assert.equal(resolve(saved.readyPath), readyPath);
    assert.equal(saved.runtime.sourceBlock, source.number); assert.equal(saved.runtime.sourceBlockHash, source.hash);
    const header = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]);
    assert.equal(header.hash, source.hash); report.source = source; report.header = header;
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FLUID_DEX_FAMILY_ID && same(m.instanceKey, pool));
    assert.equal(memos.length, 1, "one naturally admitted current pool memo required");
    assert([familyDefinitionHash(FLUID_DEX_FAMILY_ID), familyMemoDefinitionHash(FLUID_DEX_FAMILY_ID)].includes(memos[0].familyDefinitionHash));
    const family = asPricedFamily(catalog.forStrictFamily(FLUID_DEX_FAMILY_ID));
    const wiring = createRebuildWiring({ rpcUrl, familyIds: [FLUID_DEX_FAMILY_ID], executionIdentity: { executor, transactionOrigin: owner } });
    const instance = wiring.rehydrateVerifiedInstance({ memo: memos[0], cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const edges = graph.filter(e => e.instanceKey === instance.instanceKey && same(e.target, pool));
    assert.equal(edges.length, 2); assert.equal(instance.routes.length, 2);
    const code = loadBotVmRuntimeCode(owner); report.executorRuntimeCodeHash = code.keccak256;
    report.memoFingerprint = memos[0].memoFingerprint; report.familyDefinitionHash = memos[0].familyDefinitionHash;
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1 }, control,
      executionGasLimit: 8_000_000, executorRuntimeCode: code,
      createClient({ onFatal }) {
        const client = new RevmSimClient({ executablePath: args.get("--revm-bin"), timeoutMs: 60000, onFatal });
        const original = client.strictSimulate.bind(client);
        client.strictSimulate = async (request, workControl) => {
          const response = await original(request, workControl);
          report.wire.push({ request: { ...request, rpcUrl: "[REDACTED]" }, response }); return response;
        };
        return client;
      }, onFatal(reason) { report.fatal = reason; } });
    const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner,
      generationFence: { assertCurrent(generation, requested) { assert.equal(generation, source.generation); assert.deepEqual(requested, source); } },
      provider: {
        async call(tx, block) {
          assert(!constructing, "runtime construction used RPC"); assert.equal(block, source.number); assert(same(tx.to, pool));
          quoteReads++; return provider.send("eth_call", [tx, pin]);
        },
        async getCode() { throw new Error("unexpected post-admission getCode"); },
        async getStorage() { throw new Error("unexpected post-admission storage read"); },
      } });
    const actions = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => {
      const action = actions.find(a => a.id === node.adapterId); assert(action);
      return action.encode(node, executor, concatBytes(...node.children.map(compile)));
    };
    for (const edge of edges) {
      const row = saved.runtime.pricing.effectiveMids.rows.get(blockScanEdgeKey(edge));
      assert(row && row.status === "quoted" && row.amountIn > 0n && row.amountOut > 0n, "production effective reference required");
      assert.equal(row.quotedAt.number, source.number); assert.equal(row.quotedAt.hash, source.hash);
      const definition = instance.routes.find(r => same(r.tokenIn, edge.tokenIn) && same(r.tokenOut, edge.tokenOut)); assert(definition);
      const route = instance.routeHandles.find(r => r.routeKey === definition.routeKey); assert(route);
      const constructionReads = quoteReads; constructing = true;
      let leg: ReturnType<typeof buildFamilyRuntimeAmountLeg>;
      try {
        const input = { family, route, source, runtime, executor, runtimeEvidence: [], actionOwnership: catalog };
        for (const field of ["amountIn", "exact", "quotedAmountOut"])
          Object.defineProperty(input, field, { get() { throw new Error(`runtime read ${field}`); } });
        leg = buildFamilyRuntimeAmountLeg(input);
      } finally { constructing = false; }
      assert(leg); assert.equal(quoteReads, constructionReads);
      for (const multiplier of [1n, 10n]) {
        const amountIn = row.amountIn * multiplier, sample: any = { routeKey: route.routeKey, tokenIn: row.tokenIn,
          tokenOut: row.tokenOut, executionAssets: definition.executionAssets, amountSource: "current-production-effective",
          amountIn, multiplier, productionAmountIn: row.amountIn, runtimeConstructionRpc: 0, executions: [], result: "failed" };
        report.samples.push(sample); stage = "production-exact";
        const quote = await executeFamilyExactQuote({ family, route, amountIn, source, generation: source.generation,
          executor, runtimeEvidence: [], runtime });
        assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
        sample.quoteAmountOut = quote.amountOut; assert(quote.amountOut > 0n);
        if (multiplier === 1n) assert.equal(quote.amountOut, row.amountOut);
        const fragment = buildFamilyExecutionFragment({ family, route, exact: quote, minAmountOut: quote.amountOut,
          executor, runtimeEvidence: [], actionOwnership: catalog });
        assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("fragment unresolved");
        const programs: [string, Uint8Array][] = [
          ["quoted", concatBytes(...planFragmentNodes(fragment.fragment, row.tokenIn, amountIn).map(compile))],
          ["runtime", runtimeProgramScript(ethers.getBytes(leg.program), amountIn)],
        ];
        for (const [mode, script] of programs) {
          stage = mode; const caller = { kind: "executor" as const };
          const request: Extract<AdapterRequest, { kind: "effect-delta-simulation" }> = {
            id: `${mode}-${sample.executions.length}`, kind: "effect-delta-simulation",
            call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(script) },
            overrideIntent: { caller, nativeBalanceWei: 107n, tokenBalances: [
              { token: row.tokenIn, amount: amountIn + 101n }, { token: row.tokenOut, amount: 103n }], },
            observeTokenBalances: [row.tokenIn, row.tokenOut].map(token => ({ token, account: caller })),
            observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"],
          };
          const execution: any = { mode, scriptHash: ethers.keccak256(script), result: "failed" }; sample.executions.push(execution);
          const result = await simulation.transport.simulate({ request, source, callerAuthority: { executor, transactionOrigin: owner }, control });
          execution.observation = result;
          // The production transport throws on revert/invalid evidence. Its
          // returned value is a checked simulation observation, not a request result.
          assert.equal(result.data, "0x");
          const delta = (token: string) => {
            const matches = result.effects?.tokenDeltas?.filter(d => same(d.token, token) && same(d.account, executor));
            assert.equal(matches?.length, 1); return matches![0].delta;
          };
          assert.equal(delta(row.tokenIn), -amountIn); assert.equal(delta(row.tokenOut), quote.amountOut);
          const native = result.effects?.nativeDeltas; assert.equal(native?.length, 1);
          assert(same(native![0].account, executor)); assert.equal(native![0].delta, 0n);
          execution.actualAmountOut = delta(row.tokenOut); execution.result = "passed";
        }
        sample.result = "passed";
      }
    }
    assert.equal(report.samples.length, 4); assert.equal(report.wire.length, 8);
    assert.equal(sourceFingerprint(), report.sourceFingerprint, "source changed during evidence run");
    assert.equal(sha(readFileSync(readyPath)), report.readySha256); assert.equal(sha(readFileSync(pricePath)), report.pricesSha256);
    report.quoteReads = quoteReads; report.result = "passed";
  } catch (error) {
    report.error = { stage, message: redact(String(error instanceof Error ? error.message : error)) }; process.exitCode = 1;
  } finally {
    if (simulation) await simulation.closeAndDrain(); provider.destroy();
    writeFileSync(out, JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : typeof v === "string" ? redact(v) : v, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ out, result: report.result, error: report.error, samples: report.samples.length, executions: report.wire.length }));
}
main().catch(() => { console.error("Fluid historical-dual input/setup failed; no input overwritten"); process.exitCode = 1; });
