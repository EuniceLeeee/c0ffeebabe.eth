// Opt-in N-end Family acceptance. Current sealed issuers and strict REVM only.
// Natural amounts are inputs, not identity seeds. No original-precall/EV verdict.
import assert from "node:assert/strict";
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../../../../shared/executor/botvm-program-entry.js";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { AdapterRequest, AdapterRequestResult, ObservedEffects } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { assertPriceInput, assertHeader, constructionGuard, assertExecutorCode, assertOriginAccountCode, json, sha } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt, assertHistoricalPriceDirection } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { VAULT, VAULT_ABI, MAX_INPUT, MAX_UINT, same, lower, call, queryData, quoteOutput, resultSet, returned } from "../codec.js";
import { VAULT_ACTION } from "../action.js";
import { BALANCER_V2_FAMILY_ID as FAMILY } from "../manifest.js";
import { swapProgram } from "../runtime.js";
import type { BalancerV2Descriptor, BalancerV2Route } from "../types.js";

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
// Transaction/block provenance only; no pool list controls the tested universe.
const SAMPLES: Record<number, { tx: string; hash: string }> = {
  26138724: { tx: "0x9db5b6b8efe9dacc0931ee1b48c861b0284e8088f7c27c93455e95c374b50a4b", hash: "0xcad9e81827cbe1f29ff77fc163855dfe1647a17b8b4a44b209e900273ac4f70b" },
  26138511: { tx: "0x80334cda165c424da8ffc9bbb4ccd302b77b79a3bc1f4e25bbbcd643c1712e3d", hash: "0xffdbdda6829f743dc05ad148586e96dc671f31ee30968f07d91963b9de22e771" },
};
// The infrastructure deployment was matched to saved verified Vault source.
const VAULT_CODE_HASH = "0x9eb70db20a41bfbf4b022fd070fa7f154b7c4aec98177120dde7a958384f4e66";
const ERC20 = new ethers.Interface(["function allowance(address,address) view returns(uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects = ["return-data", "revert-data", "token-delta", "total-supply-delta", "native-delta", "logs"] as const;
const requirements = { transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects };

function observed(e: ObservedEffects | undefined, r: BalancerV2Route, executor: string, owner: string, recipient: string, amount: bigint, out: bigint) {
  assert.equal(e?.tokenDeltas?.length, 6); assert.equal(e?.nativeDeltas?.length, 1); assert.equal(e?.totalSupplyDeltas?.length, 2);
  const want: [string, string, bigint][] = [[r.tokenIn, executor, -amount], [r.tokenIn, VAULT, amount], [r.tokenIn, owner, 0n],
    [r.tokenOut, executor, same(recipient, executor) ? out : 0n], [r.tokenOut, VAULT, -out], [r.tokenOut, owner, same(recipient, owner) ? out : 0n]];
  for (const [token, account, delta] of want) {
    const rows = e!.tokenDeltas!.filter(x => same(x.token, token) && same(x.account, account));
    assert.equal(rows.length, 1); assert.equal(rows[0].delta, delta);
  }
  assert(same(e!.nativeDeltas![0].account, executor)); assert.equal(e!.nativeDeltas![0].delta, 0n);
  for (const token of [r.tokenIn, r.tokenOut]) {
    const rows = e!.totalSupplyDeltas!.filter(x => same(x.token, token)); assert.equal(rows.length, 1); assert.equal(rows[0].delta, 0n);
  }
  const swaps = e!.logs!.filter(l => same(l.address, VAULT) && l.topics[0] === VAULT_ABI.getEvent("Swap")!.topicHash);
  assert.equal(swaps.length, 1);
  const log = VAULT_ABI.decodeEventLog("Swap", swaps[0].data, [...swaps[0].topics]);
  assert.equal(VAULT_ABI.encodeEventLog(VAULT_ABI.getEvent("Swap")!, log).data, swaps[0].data);
  assert.equal(log.poolId.toLowerCase(), r.poolId.toLowerCase()); assert(same(log.tokenIn, r.tokenIn) && same(log.tokenOut, r.tokenOut));
  assert.equal(log.amountIn, amount); assert.equal(log.amountOut, out);
  for (const [token, from, to, value] of [[r.tokenIn, executor, VAULT, amount], [r.tokenOut, VAULT, recipient, out]] as const) {
    const rows = e!.logs!.filter(l => same(l.address, token) && l.topics[0] === ERC20.getEvent("Transfer")!.topicHash)
      .map(l => ERC20.decodeEventLog("Transfer", l.data, [...l.topics]))
      .filter(a => same(a.from, from) && same(a.to, to) && a.value === value);
    assert.equal(rows.length, 1, "actual input/output Transfer missing or ambiguous");
  }
}
function rejected(v: AdapterRequestResult) {
  assert(v.ok, "transport failure is not an EVM rejection"); assert.equal(v.completion, "reverted-as-declared");
  assert(ethers.isHexString(v.data, true) && ethers.dataLength(v.data) >= 4);
  assert.deepEqual(v.effects, { tokenDeltas: [], nativeDeltas: [], totalSupplyDeltas: [], logs: [] });
}

async function main() {
  const required = ["--ready", "--prices", "--rpc-file", "--revm-bin", "--out", "--block"], args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert([...required, "--double"].includes(key) && !args.has(key) && value && !value.startsWith("--")); args.set(key, value);
  }
  assert(required.every(k => args.has(k))); assert(!args.has("--double") || ["0", "1"].includes(args.get("--double")!));
  const N = Number(args.get("--block")), sample = SAMPLES[N]; assert(sample, "bounded historical block required");
  const doubled = args.get("--double") !== "0", out = resolve(args.get("--out")!);
  const logRoot = realpathSync(resolve(ROOT, "logs")), parent = realpathSync(dirname(out));
  assert(parent === logRoot || parent.startsWith(logRoot + sep), "output must be an existing ignored logs directory");
  const fd = openSync(out, "wx", 0o600), report: any = { result: "failed", samples: [], discoveryReceipts: [], drained: false,
    source: { number: N, hash: sample.hash }, signing: false, broadcast: false, doubles: doubled,
    scope: "All current Ready Balancer V2 pools/routes at one N; fresh self Exact + quoted/runtime and independent recipient query + issued direct runtime. Natural amounts only; no original-precall, opportunity, deferred, static-query or performance verdict.",
    allowanceObservation: "Independent allowance(executor,Vault)==0 EVM suffix after every positive program, not a synthetic effect row.",
    quoteCallerScope: "Production ordinary eth_call has from=executor. Executor-program simulations preserve caller=executor and transactionOrigin=owner. Equality is checked per sample; no universal origin-independent pool behavior is claimed.",
    rejectionObservation: "Declared main-EVM reverts expose empty effects; no separately read post-revert stateDiff is claimed." };
  const guard = constructionGuard(), abort = new AbortController(), deadlineAtMs = Date.now() + 600000;
  const timer = setTimeout(() => abort.abort(new Error("Balancer recipient acceptance deadline")), 600000);
  const interrupt = () => abort.abort(new Error("Balancer recipient acceptance interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let rpcUrl = "", reads = 0, stage = "inputs", simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined;
  let finalPins: (() => Promise<void>) | undefined;
  const redact = (x: unknown) => String(x).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricePath = realpathSync(args.get("--prices")!);
    const paths = [readyPath, pricePath, realpathSync(resolve(dirname(pricePath), "input.json")), fileURLToPath(import.meta.url), realpathSync(resolve(ROOT, "listener/package.json"))];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) })); report.inputs = pins(); report.code = sourcePin();
    const revmPath = realpathSync(args.get("--revm-bin")!); report.revmSha256 = sha(readFileSync(revmPath));
    const prices = parseAtBlockJson(readFileSync(pricePath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2], "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    assert.equal(source.number, N); assert.equal(source.hash, sample.hash);
    report.source = source; report.graphHash = ready.graphHash;
    assertPriceInput(prices, provenance, ready, { readySha256: report.inputs[0].sha256, sourceTreeSha256: report.code.sourceTreeSha256, number: N });
    assert.equal(realpathSync(provenance.readyPath), readyPath); assert.equal(realpathSync(prices.readyPath), readyPath);
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    const executor = ethers.getAddress(provenance.executor), owner = ethers.getAddress(provenance.owner);
    assert(executor !== ethers.ZeroAddress && owner !== ethers.ZeroAddress);
    assert(new Set([lower(executor), lower(owner), lower(VAULT)]).size === 3); report.actors = { executor, owner };
    rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(/^https?:\/\//.test(rpcUrl));
    const pin = { blockHash: source.hash, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      guard.check(); abort.signal.throwIfAborted(); const id = ++reads; assert(id <= 1000, "direct read budget");
      assert(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getStorageAt", "eth_getTransactionReceipt"].includes(method));
      const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25000)]) }); assert(r.ok, `HTTP ${r.status}`);
      const body = await r.json() as any; assert.equal(body.jsonrpc, "2.0"); assert.equal(body.id, id);
      // Positive quote/identity reads only: no RPC error is reclassified as a pass.
      assert(!body.error, `RPC ${method} failed (${body.error?.code})`); assert(Object.hasOwn(body, "result")); return body.result;
    };
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false]); assert.equal(header.hash, source.hash);
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n); report.header = header;
    assertHeader(header, provenance.sourceHeader);
    const artifactPath = resolve(ROOT, "out/BotVM.sol/BotVM.json"), artifactBytes = readFileSync(artifactPath), artifact = JSON.parse(artifactBytes.toString());
    const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
    assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM"); assert(Object.keys(metadata.sources).length > 0);
    report.soliditySources = Object.entries(metadata.sources).map(([name, value]) => {
      const path = realpathSync(resolve(ROOT, name)), bytes = readFileSync(path);
      assert(name.endsWith(".sol") && !relative(realpathSync(ROOT), path).startsWith(".."));
      assert.equal(ethers.keccak256(bytes), (value as { keccak256: string }).keccak256); paths.push(path); return { path, sha256: sha(bytes) };
    }); report.inputs = pins();
    const refs = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
    assert.equal(refs.length, 1); assert(refs[0].length > 0 && refs[0].every(r => r.length === 32));
    const executorRuntimeCode = loadBotVmRuntimeCode(owner); assert.equal(provenance.counterfactualExecutorCode.keccak256, executorRuntimeCode.keccak256);
    report.executorArtifactSha256 = sha(artifactBytes); report.executorCodeHash = executorRuntimeCode.keccak256;
    report.executorProvisioning = assertExecutorCode(await rpc("eth_getCode", [executor, pin]), executorRuntimeCode.code);
    assertOriginAccountCode(await rpc("eth_getCode", [owner, pin]));
    const vaultCode = await rpc("eth_getCode", [VAULT, pin]); report.vaultCodeHash = ethers.keccak256(vaultCode);
    assert.equal(report.vaultCodeHash, VAULT_CODE_HASH);
    finalPins = async () => { report.inputsAfter = pins(); report.codeAfter = sourcePin();
      assert.deepEqual(report.inputsAfter, report.inputs); assert.deepEqual(report.codeAfter, report.code);
      assert.equal(sha(readFileSync(artifactPath)), report.executorArtifactSha256); assert.equal(sha(readFileSync(revmPath)), report.revmSha256);
      report.headerAfter = await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false]); assert.equal(report.headerAfter.hash, source.hash); };
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => new RevmSimClient({ executablePath: revmPath, timeoutMs: 90000, onFatal }),
      onFatal: () => abort.abort(new Error("Balancer strict simulation fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, N); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, N); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, N); return rpc("eth_getStorageAt", [a, slot, pin]); } } } as never);
    const family = asPricedFamily(catalog.forStrictFamily(FAMILY));
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [FAMILY], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isFamilyEnabled?.(FAMILY), "enable the installed Family explicitly; never rewrite Ready");
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (n: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === n.adapterId); assert(a); return a.encode(n, executor, concatBytes(...n.children.map(compile))); };
    const receipts = new Map<string, any>();
    const receipt = async (tx: string) => { if (!receipts.has(tx)) receipts.set(tx, await rpc("eth_getTransactionReceipt", [tx])); return receipts.get(tx); };
    report.originalReceipt = await receipt(sample.tx); assertHistoricalDiscoveryReceipt(report.originalReceipt,
      { transactionHash: sample.tx, blockNumber: N, blockHash: sample.hash }, source);
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FAMILY); assert(memos.length > 0);
    const targetEdges = graph.filter(e => e.adapterId === VAULT_ACTION), cases = [];
    report.instances = [];
    for (const memo of memos) {
      assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
      const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
      const d = instance.descriptor as BalancerV2Descriptor; assert(same(d.binding.vault, VAULT)); assert.equal(d.binding.vaultCodeHash, report.vaultCodeHash);
      const historicalPoolCodeHash = ethers.keccak256(await rpc("eth_getCode", [d.pool, pin]));
      assert.equal(historicalPoolCodeHash, d.binding.poolCodeHash);
      assert(!d.binding.tokens.some(t => [executor, owner, VAULT].some(a => same(t, a)))); assert(!same(d.pool, executor) && !same(d.pool, owner));
      const candidate = memo.candidateSnapshot as any; assert(ethers.isHexString(candidate.transactionHash, 32));
      const discovery = await receipt(candidate.transactionHash); assertHistoricalDiscoveryReceipt(discovery, candidate, source);
      report.discoveryReceipts.push({ instanceKey: d.instanceKey, receipt: discovery });
      const edges = targetEdges.filter(e => e.instanceKey === d.instanceKey); assert.equal(edges.length, instance.routes.length); assert(edges.length > 0);
      report.instances.push({ descriptor: d, historicalPoolCodeHash, memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate });
      for (const route of instance.routes as readonly BalancerV2Route[]) {
        const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey); assert(handle);
        const matching = edges.filter(e => same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert.equal(matching.length, 1);
        const edge = matching[0], key = blockScanEdgeKey(edge), row = prices.runtime.pricing.effectiveMids.rows.get(key), raw = prices.runtime.pricing.mids.get(key);
        assert(row?.status === "quoted", "natural effective input missing; do not invent donor amount"); assertHistoricalPriceDirection(edge, row, d.instanceKey);
        assert(raw && Number.isFinite(raw.mid) && raw.mid > 0); assert(typeof row.amountIn === "bigint" && row.amountIn > 0n);
        assert(typeof row.amountOut === "bigint" && row.amountOut > 0n); assert.equal(row.quotedAt.number, N); assert.equal(row.quotedAt.hash, source.hash);
        assert.equal(row.quotedAt.generation, prices.runtime.generation); assert(prices.runtime.graph.edges.some((e: any) => blockScanEdgeKey(e) === key));
        const build = (settlement?: { kind: "direct-output"; recipient: string }) => guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor,
          runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog, ...(settlement ? { settlement } : {}) }));
        const leg = build(), direct = build({ kind: "direct-output", recipient: owner }); assert(leg && direct, "runtime decline is not coverage");
        assert.deepEqual(direct.settlementRequest, { kind: "direct-output", recipient: owner }); assert.equal(direct.settlement?.directOutput, true);
        assert.equal(direct.settlement?.quoteOutput, undefined); assert.equal(direct.settlement?.deferredInput, undefined);
        assert.equal(direct.program.toLowerCase(), ethers.hexlify(swapProgram(d.poolId, route.tokenIn, route.tokenOut, executor, 1n, owner).bytes()), "minimum diagnostic must share the exact issued emitter");
        cases.push({ d, route, handle, row, raw, leg, direct, edgeKey: key });
      }
    }
    assert.equal(cases.length, targetEdges.length); assert.equal(new Set(cases.map(c => c.edgeKey)).size, targetEdges.length);
    report.expectedDirections = cases.length; report.expectedAmountGroups = cases.length * (doubled ? 2 : 1);
    for (const c of cases) {
      const { d, route, handle, row, leg, direct } = c;
      // Separate read after the actual emitted program; the transport cannot
      // replace it with a declared allowance effect or Approval event.
      const allowanceObserver = runtimeProgramScript(new RuntimeAmountProgram()
        .call(route.tokenIn, ERC20.encodeFunctionData("allowance", [executor, VAULT]), { static: true })
        .load(1, 0).constant(2, 0n).equal(1, 2).bytes());
      const execute = async (run: any, script: Uint8Array, amount: bigint, missing = false) => {
        const caller = { kind: "executor" as const };
        const request: AdapterRequest = { id: "balancer-recipient-execution", required: false, kind: "effect-delta-simulation",
          call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(concatBytes(script, allowanceObserver)) },
          overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [
            { token: route.tokenIn, amount: missing ? (amount > 101n ? 101n : 0n) : amount + 101n }, { token: route.tokenOut, amount: 103n }] },
          observeTokenBalances: [route.tokenIn, route.tokenOut].flatMap(token => [{ token, account: caller }, { token, account: VAULT }, { token, account: owner }]),
          observeTotalSupplies: [route.tokenIn, route.tokenOut], observe: effects };
        run.request = request; run.scriptHash = ethers.keccak256(script); run.allowanceObserverHash = ethers.keccak256(allowanceObserver);
        run.outcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: { stage: "exact-refine", familyId: FAMILY,
          source, generation: source.generation, programInput: undefined, program: { requirements: () => requirements, buildRequests: () => [request], decode: ({ results }): readonly AdapterRequestResult[] => results } } });
        assert.equal(run.outcome.status, "resolved"); run.value = run.outcome.executed.evidence[0]; assert(run.value.ok, "transport failure is not an EVM rejection"); assert.deepEqual(run.value.source, source);
      };
      for (const multiplier of doubled ? [1n, 2n] : [1n]) {
        const amount = row.amountIn * multiplier; assert(amount > 0n && amount <= MAX_INPUT && amount + 101n <= MAX_UINT);
        const trial: any = { instanceKey: d.instanceKey, routeKey: route.routeKey, poolId: d.poolId, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
          edgeKey: c.edgeKey, natural: { raw: c.raw, effective: row }, amountIn: amount, multiplier, status: "failed", executions: [] }; report.samples.push(trial);
        stage = `self-Exact:${route.routeKey}:${multiplier}`;
        const exact = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn: amount, source, generation: source.generation,
          executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } })); trial.selfExact = exact;
        assert.equal(exact.status, "resolved"); if (exact.status !== "resolved") throw new Error("self Exact unresolved");
        assert.equal(exact.amountIn, amount); assert.deepEqual(exact.source, source); assert(exact.amountOut > 0n);
        if (multiplier === 1n) assert.equal(exact.amountOut, row.amountOut);
        const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: handle, exact, minAmountOut: exact.amountOut, executor, runtimeEvidence: [], actionOwnership: catalog }));
        assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
        const nodes = planFragmentNodes(fragment.fragment, route.tokenIn, amount), quoted = concatBytes(...nodes.map(compile));
        // queryBatchSwap is a normal eth_call, not a STATICCALL/quote-output leg.
        const query: AdapterRequest = { ...call("recipient-query", VAULT, queryData(d.poolId, route.tokenIn, route.tokenOut, amount, executor, owner)), caller: { kind: "executor" } };
        stage = `recipient-query:${route.routeKey}:${multiplier}`;
        trial.recipientQuote = { request: query, recipient: owner,
          scope: "independent same-N recipient query; not self Exact or a static quote-output capability" };
        const queryOutcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: { stage: "exact-refine", familyId: FAMILY,
          source, generation: source.generation, programInput: undefined, program: { requirements: () => ({ transports: ["eth-call"] as const, caller: "executor" as const, completions: ["return-or-revert-data"] as const }),
            buildRequests: () => [query], decode: ({ results }): readonly AdapterRequestResult[] => results } } });
        trial.recipientQuote.outcome = queryOutcome;
        assert.equal(queryOutcome.status, "resolved"); if (queryOutcome.status !== "resolved") throw new Error("recipient query unresolved");
        resultSet(queryOutcome.executed.evidence, ["recipient-query"], source);
        const recipientOut = quoteOutput(returned(queryOutcome.executed.evidence, "recipient-query").data, amount); assert(recipientOut > 0n);
        trial.recipientQuote.amountOut = recipientOut; trial.recipientQuote.deltaFromSelf = recipientOut - exact.amountOut;
        const scripts = [["quoted", quoted, executor, exact.amountOut], ["runtime", runtimeProgramScript(ethers.getBytes(leg.program), amount), executor, exact.amountOut],
          ["direct-runtime", runtimeProgramScript(ethers.getBytes(direct.program), amount), owner, recipientOut]] as const;
        for (const [encoding, script, recipient, expected] of scripts) for (const negative of [false, true]) {
          stage = `${encoding}:${negative ? "insufficient-input" : "positive"}`;
          const run: any = { encoding, negative: negative ? "insufficient-total-input" : "none", recipient, expectedOutput: expected, status: "failed" }; trial.executions.push(run);
          await execute(run, script, amount, negative);
          if (negative) rejected(run.value); else { assert.equal(run.value.completion, "returned"); assert.equal(run.value.data, "0x"); observed(run.value.effects, route, executor, owner, recipient, amount, expected); }
          run.status = "pass";
        }
        const stress = [["quoted-minimum-plus-one", concatBytes(...nodes.map(n => compile({ ...n, params: { ...n.params, minAmountOut: exact.amountOut + 1n } })))],
          ["direct-helper-minimum-plus-one", runtimeProgramScript(swapProgram(d.poolId, route.tokenIn, route.tokenOut, executor, recipientOut + 1n, owner).bytes(), amount)]] as const;
        for (const [encoding, script] of stress) {
          stage = encoding; const run: any = { encoding, negative: "minimum-plus-one", status: "failed",
            scope: encoding.startsWith("direct") ? "same Family emitter as issued min=1; diagnostic changes only the minimum argument" : "issued quoted node with minimum changed to self Exact +1" };
          trial.executions.push(run); await execute(run, script, amount); rejected(run.value); run.status = "pass";
        }
        if (multiplier === 1n) {
          for (const [encoding, program] of [["runtime-zero", leg.program], ["direct-zero", direct.program]] as const) {
            stage = encoding; const run: any = { encoding, negative: "zero-input", status: "failed" }; trial.executions.push(run);
            await execute(run, runtimeProgramScript(ethers.getBytes(program), 0n), 0n); rejected(run.value); run.status = "pass";
          }
          const run: any = { encoding: "direct-post-revert", negative: "post-execution-revert", status: "failed" }; trial.executions.push(run);
          const fail = runtimeProgramScript(new RuntimeAmountProgram().constant(1, 0n).constant(2, 1n).equal(1, 2).bytes());
          await execute(run, concatBytes(runtimeProgramScript(ethers.getBytes(direct.program), amount), fail), amount); rejected(run.value); run.status = "pass";
        }
        trial.status = "pass"; console.log(json({ instanceKey: d.instanceKey, routeKey: route.routeKey, amountIn: amount, selfOut: exact.amountOut, recipientOut, status: trial.status }));
      }
    }
    assert.equal(report.samples.length, report.expectedAmountGroups); assert(report.samples.every((s: any) => s.status === "pass"));
    const executions = report.samples.flatMap((s: any) => s.executions);
    report.executionCounts = { amountGroups: report.samples.length,
      positive: executions.filter((e: any) => e.negative === "none").length,
      negative: executions.filter((e: any) => e.negative !== "none").length,
      byEncoding: Object.fromEntries([...new Set(executions.map((e: any) => e.encoding))].map(k => [String(k), executions.filter((e: any) => e.encoding === k).length])) };
    assert.equal(report.executionCounts.positive, cases.length * (doubled ? 6 : 3));
    assert.equal(report.executionCounts.negative, cases.length * (doubled ? 13 : 8));
    assert.equal(guard.counts.forbiddenDuringBuild, 0); report.runtimeConstruction = { directions: cases.length, builds: cases.length * 2, rpc: 0, exact: 0, quotedFallback: false };
    report.result = "same-N-self-dual-and-direct-recipient-pass";
  } catch (e) { report.error = { stage, message: redact(e instanceof Error ? e.stack : e) }; process.exitCode = 1; }
  finally {
    try { await finalPins?.(); } catch (e) { report.finalPinError = redact(e); report.result = "failed"; process.exitCode = 1; }
    try { if (simulation) { await simulation.closeAndDrain(); report.drained = true; } else report.drainScope = "simulation not started"; }
    catch (e) { report.drainError = redact(e); report.result = "failed"; process.exitCode = 1; }
    clearTimeout(timer); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    report.directReads = reads; report.invocationCounts = guard.counts; writeFileSync(fd, redact(json(report)) + "\n"); fsyncSync(fd); closeSync(fd);
    console.log(json({ result: report.result, samples: report.samples.length, drained: report.drained, error: report.error, out }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("invalid Balancer historical recipient input; existing files preserved"); process.exitCode = 1;
});
