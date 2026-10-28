// Supplementary direct-only, one actual four-component BasicIssuance basket.
// Current production Ready/issuer/Exact/strict executor; no opportunity search.
import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../../../../shared/executor/botvm-program-entry.js";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { FAMILY } from "../manifest.js";
import { MODULE_CODE_HASH, SET_CODE_HASH } from "../codec.js";
import type { Descriptor } from "../types.js";
import { SAMPLE, historicalReceipt, sha, json, same } from "./historical-runtime-observations.js";
import { assertBasicRecipientEffects } from "./basic-recipient-observations.js";
const EXECUTOR = "0x1000000000000000000000000000000000000002", OWNER = "0x1000000000000000000000000000000000000001";
const EFFECTS = ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] as const;
function sourcePin() {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url)), files: [string, string][] = [];
  const visit = (relative: string) => {
    for (const e of readdirSync(resolve(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "test" || e.name === "templates") continue;
      const p = relative ? relative + "/" + e.name : e.name;
      if (e.isDirectory()) visit(p); else { assert(e.isFile()); files.push([p, sha(readFileSync(resolve(root, p)))]); }
    }
  };
  visit(""); return sha(JSON.stringify(files));
}
export function verifyBasicExecutorSources(root: string, artifactPath: string) {
  const bytes = readFileSync(artifactPath), artifact = JSON.parse(bytes.toString()), metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM"); assert(Object.hasOwn(metadata.sources, "src/BotVM.sol"));
  const sources = (Object.entries(metadata.sources) as [string, { keccak256: string }][]).map(([name, entry]) => {
    const path = realpathSync(resolve(root, name)); assert(name.endsWith(".sol") && !relative(realpathSync(root), path).startsWith(".."));
    const content = readFileSync(path); assert.equal(ethers.keccak256(content), entry.keccak256); return { path: name, keccak256: entry.keccak256, sha256: sha(content) };
  });
  return { artifactSha256: sha(bytes), sources };
}
export function basicReferences(prior: any, components: readonly string[]) {
  assert.equal(prior.result, "pass"); assert.equal(prior.family, FAMILY); assert.equal(prior.instanceKey, `${SAMPLE.set}:${SAMPLE.module}`);
  assert.equal(prior.headerBefore.hash, SAMPLE.hash); assert.equal(Number(BigInt(prior.headerBefore.number)), SAMPLE.number);
  assert.equal(prior.headerAfter.hash, SAMPLE.hash); assert.deepEqual(prior.codeAfter.sourceTreeSha256, prior.code.sourceTreeSha256);
  assert.equal(prior.samples.length, 8);
  for (const token of components) {
    const samples = prior.samples.filter((s: any) => same(s.selectedComponent, token)); assert.equal(samples.length, 2);
    assert.deepEqual(samples.map((s: any) => s.label).sort(), ["historical-amount-at-N", "production-P"].sort());
    for (const s of samples) assert(s.status === "pass" && s.executions.length === 2 && s.executions.every((e: any) => e.status === "pass"));
  }
  const rows = prior.samples.filter((s: any) => same(s.selectedComponent, components[0])).map((s: any) => ({ label: String(s.label), amountIn: BigInt(s.amountIn) }));
  for (const row of rows) { assert(row.amountIn > 0n); assert(prior.samples.filter((s: any) => s.label === row.label).every((s: any) => BigInt(s.amountIn) === row.amountIn)); }
  return rows;
}
async function main() {
  const args = new Map<string, string>(), required = ["--ready", "--reference-report", "--revm-bin", "--recipient", "--out"], allowed = [...required, "--rpc-file", "--rpc-env"];
  for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i]!, value = process.argv[i + 1]; assert(allowed.includes(key) && !args.has(key) && value); args.set(key, value); }
  required.forEach(k => assert(args.has(k))); assert(args.has("--rpc-file") !== args.has("--rpc-env")); if (args.has("--rpc-env")) assert.equal(args.get("--rpc-env"), "MAINNET_RPC_URL");
  const recipient = ethers.getAddress(args.get("--recipient")!); assert(recipient !== ethers.ZeroAddress && !same(recipient, EXECUTOR));
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [], controls: [], tx: SAMPLE.tx, block: SAMPLE.number, hash: SAMPLE.hash,
    broadcast: false, claim: "supplementary direct-only post-redemption delivery of the selected component; remaining basket stays with actor; original default/quoted executions retained separately" };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 600_000, timer = setTimeout(() => abort.abort(new Error("Basic recipient deadline")), 600_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0, constructing = false, constructionReads = 0, stage = "inputs";
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const error = (e: unknown) => ({ stage, message: redact(e instanceof Error ? e.message : e) });
  try {
    const root = fileURLToPath(new URL("../../../../../../../", import.meta.url)), readyPath = realpathSync(args.get("--ready")!), referencePath = realpathSync(args.get("--reference-report")!), artifactPath = realpathSync(resolve(root, "out/BotVM.sol/BotVM.json"));
    const paths = [readyPath, referencePath, args.get("--revm-bin")!, artifactPath, fileURLToPath(import.meta.url), fileURLToPath(new URL("./basic-recipient-observations.ts", import.meta.url)), fileURLToPath(new URL("./historical-runtime-observations.ts", import.meta.url))];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) })); report.inputs = pins(); report.sourceTreeSha256 = sourcePin(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    const prior = JSON.parse(readFileSync(referencePath, "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    assert.equal(source.number, SAMPLE.number); assert.equal(source.hash, SAMPLE.hash); assert.deepEqual(ready.universeRange, { fromBlock: SAMPLE.number, toBlock: SAMPLE.number });
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FAMILY && m.instanceKey === `${SAMPLE.set}:${SAMPLE.module}`); assert.equal(memos.length, 1);
    const memo = memos[0]!; assert([familyDefinitionHash(FAMILY), familyMemoDefinitionHash(FAMILY)].includes(memo.familyDefinitionHash));
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [FAMILY], executionIdentity: { executor: EXECUTOR, transactionOrigin: OWNER } }), family = asPricedFamily(catalog.forStrictFamily(FAMILY));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance; assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d = instance.descriptor as Descriptor; assert(!d.legacy && d.components.length === 4 && same(d.set, SAMPLE.set) && same(d.module, SAMPLE.module));
    assert(![d.set, d.module, d.controller, ...d.components].some(a => same(a, recipient)));
    const edges = graph.filter(e => e.instanceKey === instance.instanceKey); assert.equal(edges.length, 4); assert.equal(instance.routes.length, 4);
    const rows = instance.routes.map(route => { assert(edges.some(e => same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut))); const handle = instance.routeHandles.find(r => r.routeKey === route.routeKey)!; assert(handle); return { route, handle }; });
    const references = basicReferences(prior, d.components); report.reference = { path: referencePath, sha256: sha(readFileSync(referencePath)), sourceTreeSha256: prior.code.sourceTreeSha256, rows: references, claim: "Only prior legal production-P/original input quantities; all current quotes/receipts recalculated, not new natural price discovery." };
    report.ready = { graphHash: ready.graphHash, familyDefinitionHash: memo.familyDefinitionHash, memoFingerprint: memo.memoFingerprint, candidate: memo.candidateSnapshot, descriptor: d, directions: edges };
    rpcUrl = args.has("--rpc-file") ? JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL : process.env.MAINNET_RPC_URL!; assert(/^https?:\/\//.test(rpcUrl));
    const pin = { blockHash: SAMPLE.hash, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]) => {
      assert(!constructing); assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const id = ++reads; assert(id <= 1024); abort.signal.throwIfAborted(); const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) });
      assert(response.ok, `HTTP ${response.status}`); const body: any = await response.json(); assert.equal(body.id, id); assert.equal(body.jsonrpc, "2.0"); assert(!body.error, `read failed: ${method}`); return body.result;
    };
    stage = "source/identity"; const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(SAMPLE.number), false]); assert.equal(header.hash, SAMPLE.hash); assert.equal(BigInt(await rpc("eth_chainId", [])), 1n); report.header = header;
    const receipt = await rpc("eth_getTransactionReceipt", [SAMPLE.tx]); report.original = historicalReceipt(receipt, d.components); report.originalReceipt = receipt;
    report.deployedBindings = [];
    for (const address of [d.set, d.module, d.controller]) {
      const code = await rpc("eth_getCode", [address, pin]); assert(code !== "0x"); const hash = ethers.keccak256(code);
      assert.equal(hash, same(address, d.set) ? SET_CODE_HASH : same(address, d.module) ? MODULE_CODE_HASH : d.controllerCodeHash);
      report.deployedBindings.push({ address, source, codeHash: hash, codeBytes: ethers.getBytes(code).length });
    }
    report.executorArtifact = { path: artifactPath, ...verifyBasicExecutorSources(root, artifactPath) };
    const executorRuntimeCode = loadBotVmRuntimeCode(OWNER); report.executorCodeHash = executorRuntimeCode.keccak256; report.executorOwner = OWNER;
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000, createClient: ({ onFatal }) => {
        const client = new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 90_000, onFatal }), strict = client.strictSimulate.bind(client);
        client.strictSimulate = async (...input) => { const result = await strict(...input); (report.strictCalls ??= []).push({ stage, result }); return result; }; return client;
      }, onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor: EXECUTOR, transactionOrigin: OWNER,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, SAMPLE.number); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, SAMPLE.number); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, SAMPLE.number); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    const guardedRuntime = new Proxy(runtime, { get(target, key, receiver) { if (constructing && !["callerAuthority", "generationFence"].includes(String(key))) { constructionReads++; throw Error("runtime construction used service"); } return Reflect.get(target, key, receiver); } });
    const beforeConstruction = reads; constructing = true;
    const legs = rows.map(({ handle }) => [undefined, EXECUTOR, recipient].map(receiver => {
      const input: any = { family, route: handle, source, runtime: guardedRuntime, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog,
        ...(receiver ? { settlement: { kind: "direct-output", recipient: receiver } } : {}) };
      for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exact", "exactEvidence"]) Object.defineProperty(input, key, { get() { constructionReads++; throw Error("runtime read amount/Exact"); } });
      const leg = buildFamilyRuntimeAmountLeg(input); assert(leg && leg.settlement?.directOutput); assert.deepEqual(leg.settlementRequest, input.settlement); return leg;
    }));
    constructing = false; assert.equal(reads, beforeConstruction); assert.equal(constructionReads, 0); report.runtimeConstruction = { directions: rows.length, exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false };
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, EXECUTOR, concatBytes(...node.children.map(compile))); };
    for (const ref of references) {
      const amountIn = ref.amountIn; stage = "current-exact";
      const quotes = [];
      for (const { handle } of rows) { const q = await executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation, executor: EXECUTOR, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }); assert(q.status === "resolved" && q.amountIn === amountIn && q.amountOut > 0n); assert.deepEqual(q.source, source); quotes.push(q); }
      const outputs = d.components.map(token => quotes[rows.findIndex(r => same(r.route.tokenOut, token))]!.amountOut);
      for (const [index, { route, handle }] of rows.entries()) {
        const quote = quotes[index]!, sample: any = { label: ref.label, amountIn, selectedComponent: route.tokenOut, routeKey: route.routeKey, quote, outputs, executions: [], status: "failed" }; report.samples.push(sample);
        const fragment = buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog }); assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw Error("quoted unresolved");
        const scripts = [["old-fragment", concatBytes(...planFragmentNodes(fragment.fragment, d.set, amountIn).map(compile))], ["runtime-program", runtimeProgramScript(ethers.getBytes(legs[index]![0]!.program), amountIn)]] as const;
        const old = prior.samples.find((s: any) => s.label === ref.label && same(s.selectedComponent, route.tokenOut)); assert(old);
        sample.defaultProgramHashes = scripts.map(([encoding, script]) => { const hash = ethers.keccak256(script); assert.equal(hash, old.executions.find((e: any) => e.encoding === encoding).scriptHash, "default script changed"); return { encoding, hash }; });
        for (const [kind, receiver, leg] of [["direct-self", EXECUTOR, legs[index]![1]!], ["direct-external", recipient, legs[index]![2]!]] as const) for (const mode of ["input-only", "old-inventory", "missing-input", "post-execution-revert"] as const) {
          const inventory = mode !== "input-only", negative = mode === "missing-input" || mode === "post-execution-revert";
          const originalScript = runtimeProgramScript(ethers.getBytes(leg.program), amountIn), script = mode === "post-execution-revert" ? concatBytes(originalScript, runtimeProgramScript(new RuntimeAmountProgram().constant(1, 0n).constant(2, 1n).equal(1, 2).bytes(), 0n)) : originalScript;
          const row: any = { kind, mode, recipient: receiver, amountIn, status: "failed", scriptHash: ethers.keccak256(script) }; (negative ? report.controls : sample.executions).push(row); stage = kind + ":" + mode;
          const caller = { kind: "executor" as const }, tokens = [d.set, ...d.components], actors = [EXECUTOR, recipient, d.set];
          const request: AdapterRequest = { id: "execute", required: false, kind: "effect-delta-simulation", call: { caller, executionMode: "executor-program", to: EXECUTOR, data: buildSubscriptCalldata(script) },
            overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: d.set, amount: mode === "missing-input" ? 0n : amountIn + (inventory ? 101n : 0n) }, ...d.components.map(token => ({ token, amount: inventory ? 10n ** 24n : 0n }))] },
            observeTokenBalances: tokens.flatMap(token => actors.map(account => ({ token, account: same(account, EXECUTOR) ? caller : account }))), observeTotalSupplies: [d.set], observe: EFFECTS };
          row.request = request;
          const outcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: { stage: "exact-refine", familyId: FAMILY, source, generation: source.generation, programInput: undefined,
            program: { requirements: () => ({ transports: ["effect-delta-simulation"], caller: "executor", effects: EFFECTS }), buildRequests: () => [request], decode: ({ results }) => results } } }); row.outcome = outcome;
          assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw Error("execution issuer unresolved"); const evidence = outcome.executed.evidence; assert.equal(evidence.length, 1); const returned = evidence[0]!;
          assert(returned.ok, "transport failure is not rejection evidence"); assert.deepEqual(returned.source, source);
          if (negative) { assert.equal(returned.completion, "reverted-as-declared"); for (const delta of [...(returned.effects?.tokenDeltas ?? []), ...(returned.effects?.nativeDeltas ?? []), ...(returned.effects?.totalSupplyDeltas ?? [])]) assert.equal(delta.delta, 0n); row.rollbackScope = "strict declared main Revert, not independent storage rollback"; }
          else { assert(returned.completion === "returned" && returned.data === "0x"); assertBasicRecipientEffects(returned.effects, d, EXECUTOR, recipient, route.tokenOut, receiver, amountIn, outputs); row.effects = returned.effects; row.quoteDelta = 0n; }
          row.status = "pass";
        }
        assert.equal(sample.executions.length, 4); sample.status = "pass"; console.log(json({ selectedComponent: route.tokenOut, label: ref.label, status: sample.status }));
      }
    }
    assert.equal(report.samples.length, 8); assert.equal(report.controls.length, 32); assert(report.samples.every((s: any) => s.status === "pass") && report.controls.every((s: any) => s.status === "pass"));
    assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(SAMPLE.number), false])).hash, SAMPLE.hash); assert.equal(sourcePin(), report.sourceTreeSha256); assert.deepEqual(pins(), report.inputs);
    assert.deepEqual({ path: artifactPath, ...verifyBasicExecutorSources(root, artifactPath) }, report.executorArtifact); assert.equal(loadBotVmRuntimeCode(OWNER).keccak256, report.executorCodeHash); report.result = "pass";
  } catch (e) { report.error = error(e); process.exitCode = 1; }
  finally { try { await simulation?.closeAndDrain(); report.drained = true; } catch (e) { report.result = "failed"; report.drainError = error(e); process.exitCode = 1; } clearTimeout(timer); report.reads = reads; writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd); console.log(json({ result: report.result, error: report.error })); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error("invalid Basic recipient inputs; no success claimed"); process.exitCode = 1; });
