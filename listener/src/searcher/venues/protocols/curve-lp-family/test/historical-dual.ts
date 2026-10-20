// Opt-in same-state single-leg acceptance. A saved discovery window is not
// the tested state. No discovery, Ready mutation, search, signing or broadcast.
import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { constructionGuard, assertExecutorCode, assertOriginAccountCode, json, sha, same } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { FAMILY } from "../manifest.js";
import { ABI } from "../codec.js";
import type { Descriptor, Route } from "../types.js";
import type { ZapShape } from "../zap.js";
import { historicalRpcResponse } from "./historical-rpc-response.js";
import { PRECLAIM, feeWitness as decodeFeeWitness, preclaimScope, assertPreclaimEffects } from "./historical-preclaim-effects.js";

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const TOKEN = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] as const;
const requirements = { transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects };
type Input = { direction: "mint" | "redeem"; index: number; amountIn?: string; provenance: { kind: string; description?: string };
  receipt?: { path: string; sha256: string; transactionHash: string; blockNumber: number; blockHash: string; logIndex: number } };
type Target = { pool: string; candidate: { transactionHash: string; blockNumber: number; blockHash: string; logIndex?: number }; inputs: Input[] };

/** Receipt amounts are decoded from a pinned token Transfer, never an old
 * quote/output. Other amounts must explicitly remain manual input evidence. */
function inputAmount(input: Input, route: Route, pool: string, planPath: string, pinFile: (path: string) => string) {
  if (input.receipt) {
    assert.equal(input.provenance.kind, "receipt-transfer");
    const ref = input.receipt, path = pinFile(resolve(dirname(planPath), ref.path));
    assert.equal(sha(readFileSync(path)), ref.sha256);
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(BigInt(receipt.status), 1n); assert(same(receipt.transactionHash, ref.transactionHash));
    assert.equal(Number(BigInt(receipt.blockNumber)), ref.blockNumber); assert(same(receipt.blockHash, ref.blockHash));
    const logs = receipt.logs.filter((log: any) => Number(BigInt(log.logIndex)) === ref.logIndex); assert.equal(logs.length, 1);
    const log = logs[0]; assert(same(log.address, route.tokenIn));
    assert.equal(log.topics[0].toLowerCase(), TOKEN.getEvent("Transfer")!.topicHash.toLowerCase());
    const event = TOKEN.parseLog(log)!; assert(!same(event.args.from, ethers.ZeroAddress));
    assert(route.direction === "mint" ? same(event.args.to, pool) : same(event.args.to, pool) || same(event.args.to, ethers.ZeroAddress));
    const amount = event.args.value as bigint; assert(amount > 0n && amount <= ethers.MaxUint256 / 2n);
    if (input.amountIn !== undefined) assert.equal(BigInt(input.amountIn), amount);
    return { amount, provenance: { ...input.provenance, receipt: ref, transfer: { token: log.address, from: event.args.from, to: event.args.to, value: amount }, originalPrecallOutput: "NOT VERIFIED" } };
  }
  assert(input.provenance.kind === "manual" && input.provenance.description, "manual amount requires an explicit source description");
  assert(typeof input.amountIn === "string" && /^[0-9]+$/.test(input.amountIn));
  const amount = BigInt(input.amountIn); assert(amount > 0n && amount <= ethers.MaxUint256 / 2n);
  return { amount, provenance: input.provenance };
}

async function main(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(); let manual = false;
  const names = ["--ready", "--plan", "--rpc-file", "--revm-bin", "--revm-sha256", "--out", "--prices", "--target", "--route"];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!; if (name === "--manual-inputs") { assert(!manual); manual = true; continue; }
    assert(names.includes(name) && !args.has(name) && argv[i + 1]); args.set(name, argv[++i]!);
  }
  assert(names.slice(0, 6).every(name => args.has(name))); assert(manual !== args.has("--prices"), "choose --manual-inputs or --prices");
  assert(/^[a-f0-9]{64}$/.test(args.get("--revm-sha256")!));
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [], roundTrips: [], rawStrict: [], admissions: [],
    claim: "current Ready/Graph and same-state quote, quoted/runtime plus actual debit/receipt; saved transaction amounts are input provenance only",
    naturalValuation: !manual, priceSource: manual ? "explicit-manual-or-receipt-inputs" : "production-effective-row", performance: "NOT RUN",
    originalPrecallParity: "NOT RUN", fullLoop: "NOT RUN", signing: false, broadcast: false, protocolOverrides: false, newReadyDiscovery: false };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 600_000;
  const timer = setTimeout(() => abort.abort(new Error("Curve LP historical dual deadline")), 600_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0, stage = "inputs";
  const guard = constructionGuard(), redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  let finalPins: (() => Promise<void>) | undefined;
  try {
    const files = new Map<string, string>(), pinFile = (path: string) => { const p = realpathSync(path), digest = sha(readFileSync(p));
      assert(!files.has(p) || files.get(p) === digest); files.set(p, digest); report.inputs = [...files].map(([path, sha256]) => ({ path, sha256 })); return p; };
    const readyPath = pinFile(args.get("--ready")!), planPath = pinFile(args.get("--plan")!); pinFile(fileURLToPath(import.meta.url));
    for (const helper of ["historical-rpc-response.ts", "historical-preclaim-effects.ts"]) pinFile(fileURLToPath(new URL(helper, import.meta.url)));
    const plan = JSON.parse(readFileSync(planPath, "utf8")); assert.equal(plan.schema, "curve-lp-historical-input-plan-v1");
    const executor = ethers.getAddress(plan.actors.executor), owner = ethers.getAddress(plan.actors.owner); assert(!same(executor, owner)); report.actors = { executor, owner };
    let targets = plan.targets as Target[]; assert(Array.isArray(targets) && targets.length > 0);
    if (args.has("--target")) targets = targets.filter(target => same(target.pool, args.get("--target")!)); assert(targets.length > 0);
    assert.equal(new Set(targets.map(target => ethers.getAddress(target.pool).toLowerCase())).size, targets.length);
    report.code = sourcePin(); report.revmSha256 = sha(readFileSync(pinFile(args.get("--revm-bin")!))); assert.equal(report.revmSha256, args.get("--revm-sha256"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    assert.equal(source.number, plan.source.number); assert(same(source.hash, plan.source.hash)); report.source = source; report.discoveryWindow = ready.universeRange;
    let prices: any, priceSource: CanonicalSource | undefined;
    if (!manual) {
      const path = pinFile(args.get("--prices")!), input = JSON.parse(readFileSync(pinFile(resolve(dirname(path), "input.json")), "utf8"));
      prices = parseAtBlockJson(readFileSync(path, "utf8")); assert.equal(prices.readySha256, files.get(readyPath)); assert.equal(input.readySha256, files.get(readyPath));
      assert.equal(input.executionMode, "source-block"); assert.equal(input.through, "prices"); assert.equal(input.broadcast, false);
      assert.equal(BigInt(input.chainId), 1n); assert.equal(input.implementation.sourceTreeSha256, report.code.sourceTreeSha256);
      assert.equal(input.implementation.revmBinarySha256, report.revmSha256); assert(same(input.executor, executor) && same(input.owner, owner));
      const pricing = prices.runtime.pricing;
      for (const frame of [prices.runtime, pricing]) { assert.equal(frame.sourceBlock, source.number); assert(same(frame.sourceBlockHash, source.hash)); assert(Number.isSafeInteger(frame.generation)); }
      assert.equal(pricing.generation, prices.runtime.generation); priceSource = { number: source.number, hash: source.hash, generation: pricing.generation };
      assert(pricing.effectiveMids.complete); assert.deepEqual(pricing.effectiveMids.source, priceSource);
      for (const frame of [input.stateSource, input.topologySource]) { assert.equal(frame.number, source.number); assert(same(frame.hash, source.hash)); }
      report.productionPrices = { path, sha256: files.get(path), priceSource, executionSource: source };
    }
    rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(/^https?:\/\//.test(rpcUrl));
    const pin = { blockHash: source.hash, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      guard.check(); abort.signal.throwIfAborted(); const id = ++reads; assert(id <= 1000);
      assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const payload = { jsonrpc: "2.0" as const, id, method, params }; let res: Response | undefined, body: any;
      try { res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25_000)]) });
        body = await res.json(); return historicalRpcResponse(payload, res.status, body);
      } catch (error) { const e = error as { code?: unknown; message?: unknown };
        (report.rpcFailures ??= []).push({ stage, method, id, httpStatus: res?.status ?? null, rpcError: body?.error ?? null,
          code: e?.code ?? null, message: redact(e?.message ?? error) }); throw error; }
    };
    stage = "source-and-runtime"; const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]); assert(same(header.hash, source.hash)); report.header = header;
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const artifactPath = pinFile(resolve(ROOT, "out/BotVM.sol/BotVM.json")), artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
    assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM"); assert(Object.keys(metadata.sources).length > 0);
    for (const [name, entry] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) { const p = realpathSync(resolve(ROOT, name));
      assert(name.endsWith(".sol") && !relative(realpathSync(ROOT), p).startsWith("..")); assert.equal(ethers.keccak256(readFileSync(p)), entry.keccak256, "stale executor source"); }
    const refs = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
    assert.equal(refs.length, 1); assert(refs[0]!.length > 0 && refs[0]!.every(ref => ref.length === 32));
    const executorRuntimeCode = loadBotVmRuntimeCode(owner); report.executorCodeHash = executorRuntimeCode.keccak256; report.executorArtifactSha256 = files.get(artifactPath);
    report.executorProvisioning = assertExecutorCode(await rpc("eth_getCode", [executor, pin]), executorRuntimeCode.code); assertOriginAccountCode(await rpc("eth_getCode", [owner, pin]));
    finalPins = async () => { for (const [path, digest] of files) assert.equal(sha(readFileSync(path)), digest); assert.deepEqual(sourcePin(), report.code);
      assert(same((await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false])).hash, source.hash)); };
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => { const client = new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 90_000, onFatal });
        const invoke = client.strictSimulate.bind(client); client.strictSimulate = async (...params) => { const result = await invoke(...params); report.rawStrict.push({ stage, result }); return result; }; return client; },
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, source.number); return rpc("eth_call", [tx, pin]); },
        getCode: async (address: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getCode", [address, pin]); },
        getStorage: async (address: string, slot: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getStorageAt", [address, slot, pin]); } } as never });
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [FAMILY], executionIdentity: { executor, transactionOrigin: owner } });
    const family = asPricedFamily(catalog.forStrictFamily(FAMILY)), adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const adapter = adapters.find(adapter => adapter.id === node.adapterId); assert(adapter); return adapter.encode(node, executor, concatBytes(...node.children.map(compile))); };
    const reverted = (value: AdapterRequestResult) => { assert(value.ok, "transport/resource failure is not an EVM rejection"); assert.equal(value.completion, "reverted-as-declared");
      for (const rows of [value.effects?.tokenDeltas, value.effects?.nativeDeltas, value.effects?.totalSupplyDeltas]) assert(rows?.every(row => row.delta === 0n) ?? true); assert.equal(value.effects?.logs?.length ?? 0, 0); };
    for (const target of targets) {
      const pool = ethers.getAddress(target.pool).toLowerCase(), memos = activeReadyMemos(envelope).filter(memo => memo.familyId === FAMILY && same(memo.instanceKey, pool)); assert.equal(memos.length, 1);
      const memo = memos[0]!; assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "current strict attestation required; do not relabel old Ready");
      const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
      const d = instance.descriptor as Descriptor; assert(same(d.pool, pool));
      const zap = (d as Descriptor & { zap?: ZapShape }).zap;
      assert(d.coins.every(coin => !/^0xe{40}$/i.test(coin)), "raw-native observer not in this first ERC20/NG acceptance slice");
      const candidate: any = memo.candidateSnapshot, receipt = await rpc("eth_getTransactionReceipt", [candidate.transactionHash]);
      assertHistoricalDiscoveryReceipt(receipt, candidate, { number: candidate.blockNumber, hash: candidate.blockHash });
      report.admissions.push({ pool, descriptor: d, memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate, receipt,
        originalCandidate: target.candidate, admittedRoutes: instance.routes, freshAdmissionPerformedByThisCli: false });
      let routes = instance.routes as readonly Route[]; if (args.has("--route")) routes = routes.filter(route => `${route.direction}:${route.index}` === args.get("--route")); assert(routes.length > 0);
      for (const route of routes) {
        const claimProfile = route.direction === "redeem" && d.generic?.operationEffects?.model === "twocrypto-v0310-preclaim-underlying" ? d.generic.operationEffects : undefined;
        const readFeeWitness = async () => { assert(claimProfile);
          const poolResult = await rpc("eth_call", [{ to: pool, data: PRECLAIM.encodeFunctionData("fee_receiver") }, pin]);
          const factoryResult = await rpc("eth_call", [{ to: claimProfile.factory, data: PRECLAIM.encodeFunctionData("fee_receiver") }, pin]);
          return decodeFeeWitness(source, pool, claimProfile.factory, poolResult, factoryResult); };
        const initialFeeWitness = claimProfile ? await readFeeWitness() : undefined;
        const currentFeeWitness = async () => { const witness = await readFeeWitness(); assert.deepEqual(witness.source, source);
          assert.equal(witness.feeReceiver, initialFeeWitness!.feeReceiver, "fee receiver changed at the same pinned source"); return witness; };
        const zapInventory = zap ? await Promise.all([...new Set([zap.baseLp, route.tokenOut])].map(async token => {
          const balance = BigInt(TOKEN.decodeFunctionResult("balanceOf", await rpc("eth_call", [{ to: token, data: TOKEN.encodeFunctionData("balanceOf", [pool]) }, pin]))[0]);
          assert.equal(balance, 0n, "actual zap swept inventory is nonzero; never override or clear it"); return { token, account: pool, balance, source };
        })) : undefined;
        const handle = instance.routeHandles.find(handle => handle.routeKey === route.routeKey)!; assert(handle);
        const edges = graph.filter(edge => edge.instanceKey !== undefined && same(edge.instanceKey, pool) && same(edge.tokenIn, route.tokenIn) && same(edge.tokenOut, route.tokenOut)); assert.equal(edges.length, 1);
        const key = blockScanEdgeKey(edges[0]!), inputs: { label: string; amount: bigint; provenance: unknown; expectedOutput?: bigint }[] = [];
        const nominated = target.inputs.filter(input => input.direction === route.direction && input.index === route.index); assert(nominated.length <= 1);
        if (nominated.length) { const input = inputAmount(nominated[0]!, route, pool, planPath, pinFile);
          for (const multiplier of [1n, 2n]) inputs.push({ label: multiplier === 1n ? "explicit-input" : "twice-explicit-input", amount: input.amount * multiplier, provenance: { ...input.provenance, multiplier } }); }
        if (!manual) { const pricing = prices.runtime.pricing, row = pricing.effectiveMids.rows.get(key), raw = pricing.mids.get(key);
          assert(row?.status === "quoted", `production input unavailable: ${row?.status ?? "missing"}`); assert.equal(row.edgeId, key); assert(same(row.tokenIn, route.tokenIn) && same(row.tokenOut, route.tokenOut));
          assert.deepEqual(row.quotedAt, priceSource); assert(raw && Number.isFinite(raw.mid) && raw.mid > 0); assert(typeof row.amountIn === "bigint" && row.amountIn > 0n && typeof row.amountOut === "bigint" && row.amountOut > 0n);
          for (const multiplier of nominated.length ? [1n] : [1n, 2n]) inputs.push({ label: multiplier === 1n ? "production-effective-input" : "twice-production-effective-input", amount: row.amountIn * multiplier,
            expectedOutput: multiplier === 1n ? row.amountOut : undefined, provenance: { kind: "production-effective-row", edgeId: key, row, multiplier } }); }
        assert(inputs.length >= 2, "manual mode needs a per-route explicit amount seed");
        const build = (settlement?: any) => guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog, settlement }));
        const defaultLeg = build(); assert(defaultLeg, "runtime unavailable; no quoted fallback");
        for (const request of [{ kind: "quote-output", recipient: owner }, { kind: "deferred-input", paymentAmount: 1n, paymentProgram: ethers.hexlify(new RuntimeAmountProgram().constant(1, 0n).bytes()) }]) assert.equal(build(request), null, "undeclared callback settlement");
        const modes = ["default", "direct-self", "direct-external"] as const;
        for (const mode of modes) {
          const recipient = mode === "direct-external" ? owner : executor, settlement = mode === "default" ? undefined : { kind: "direct-output", recipient };
          const leg = mode === "default" ? defaultLeg : build(settlement);
          if (!defaultLeg.settlement?.directOutput && settlement) { assert.equal(leg, null); continue; }
          assert(leg); assert.deepEqual(leg.settlementRequest, settlement); assert.notEqual(leg.inputMode, "maximum");
          const external = !same(recipient, executor);
          const execute = async (script: Uint8Array, inputBalance: bigint, oldOutput: bigint) => {
            const feeWitness = claimProfile ? await currentFeeWitness() : undefined;
            const caller = { kind: "executor" as const }, request: AdapterRequest = { id: "lp-execute", required: false, kind: "effect-delta-simulation",
              call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(script) },
              overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: route.tokenIn, amount: inputBalance }, { token: route.tokenOut, amount: oldOutput }] },
              observeTokenBalances: claimProfile ? preclaimScope([...d.coins, d.lp], [executor, owner, pool, feeWitness!.feeReceiver]) : zap ? [...new Set([d.lp, zap.baseLp, ...d.coins])].flatMap(token => [caller, owner, pool, zap.metaPool, zap.basePool].map(account => ({ token, account })))
                : [route.tokenIn, route.tokenOut].flatMap(token => [{ token, account: caller }, { token, account: owner }, { token, account: pool }]),
              observeTotalSupplies: zap ? [d.lp, zap.baseLp] : [d.lp], observe: effects };
            const outcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: { stage: "exact-refine", familyId: FAMILY, source, generation: source.generation,
              programInput: undefined, program: { requirements: () => requirements, buildRequests: () => [request], decode: ({ results }): readonly AdapterRequestResult[] => results } } });
            assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("execution unresolved"); const value = outcome.executed.evidence[0]!; assert.deepEqual(value.source, source);
            return { request, outcome, value, executionOrigin: "new-strict-execution", ...(feeWitness ? { feeWitness } : {}) };
          };
          for (const input of inputs) {
            stage = `quote:${pool}:${route.direction}:${route.index}`;
            const trial: any = { pool, routeKey: route.routeKey, direction: route.direction, index: route.index, mode, recipient, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
              label: input.label, amountIn: input.amount, inputProvenance: input.provenance, callback: "none", callerContinuation: false, recipientSupported: !!defaultLeg.settlement?.directOutput,
              ...(zap ? { zapSourceInventory: zapInventory, zapBalanceOverrides: false, intermediateModel: route.index === 0 ? "direct-meta-coin" : "meta-LP/base-LP/underlying-two-stage" } : {}), status: "failed", executions: [] }; report.samples.push(trial);
            if (claimProfile) {
              trial.feeWitness = await currentFeeWitness();
              const raw = await rpc("eth_call", [{ to: pool, data: PRECLAIM.encodeFunctionData("calc_withdraw_one_coin", [input.amount, route.index]) }, pin]);
              assert(ethers.isHexString(raw, 32), "noncanonical comparison view");
              trial.preclaimView = { source, amountIn: input.amount, amountOut: BigInt(raw), raw, role: "comparison only; not expected output or bound" };
            }
            const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn: input.amount, source, generation: source.generation, executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }));
            trial.quote = quote; assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved"); assert.equal(quote.amountIn, input.amount); assert.deepEqual(quote.source, source); assert(quote.amountOut > 0n);
            if (input.expectedOutput !== undefined) assert.equal(quote.amountOut, input.expectedOutput);
            if (claimProfile) trial.preclaimView.quoteDelta = quote.amountOut - trial.preclaimView.amountOut;
            const allowance = route.direction === "mint" || d.generic || zap ? runtimeProgramScript(new RuntimeAmountProgram().call(route.tokenIn, ABI.encodeFunctionData("allowance", [executor, pool]), { static: true }).load(1, 0).constant(2, 0n).equal(1, 2).bytes(), 0n) : new Uint8Array();
            const scripts: [string, Uint8Array][] = [[mode === "default" ? "runtime" : mode, concatBytes(runtimeProgramScript(ethers.getBytes(leg.program), input.amount), allowance)]];
            if (mode === "default") { const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut, executor, runtimeEvidence: [], actionOwnership: catalog }));
              assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved"); scripts.unshift(["quoted", concatBytes(...planFragmentNodes(fragment.fragment, route.tokenIn, input.amount).map(compile), allowance)]); }
            for (const [encoding, script] of scripts) for (const oldOutput of [0n, 103n]) for (const fault of input === inputs[0] ? ["none", "insufficient-input", "minimum-plus-one", "wrong-receiver-postcondition", "post-revert"] : ["none"]) {
              stage = `${pool}:${route.direction}:${route.index}:${encoding}:${input.label}:${oldOutput}:${fault}`;
              const post = new RuntimeAmountProgram().constant(1, 0n);
              if (fault === "minimum-plus-one" || fault === "wrong-receiver-postcondition") { const account = fault === "wrong-receiver-postcondition" ? external ? executor : owner : recipient;
                const opening = same(account, executor) ? oldOutput : BigInt(TOKEN.decodeFunctionResult("balanceOf", await rpc("eth_call", [{ to: route.tokenOut, data: TOKEN.encodeFunctionData("balanceOf", [account]) }, pin]))[0]);
                post.call(route.tokenOut, TOKEN.encodeFunctionData("balanceOf", [account]), { static: true }).load(1, 0).constant(2, opening).math("sub", 1, 1, 2).constant(2, quote.amountOut + (fault === "minimum-plus-one" ? 1n : 0n)).math("sub", 1, 1, 2); }
              if (fault === "post-revert") post.constant(1, 1n).constant(2, 0n).equal(1, 2);
              const run = await execute(concatBytes(script, runtimeProgramScript(post.bytes(), 0n)), fault === "insufficient-input" ? input.amount - 1n : input.amount + 101n, oldOutput);
              const record: any = { encoding, fault, oldOutput, ...run, status: "failed" }; trial.executions.push(record);
              if (fault !== "none") reverted(run.value);
              else { assert(run.value.ok); assert.equal(run.value.completion, "returned"); assert.equal(run.value.data, "0x"); const observed = run.value.effects!;
                let expected: readonly (readonly [string, string, bigint])[] = [[route.tokenIn, executor, -input.amount], [route.tokenOut, executor, external ? 0n : quote.amountOut],
                  [route.tokenIn, owner, 0n], [route.tokenOut, owner, external ? quote.amountOut : 0n], [route.tokenIn, pool, route.direction === "mint" ? input.amount : 0n], [route.tokenOut, pool, route.direction === "redeem" ? -quote.amountOut : 0n]];
                if (claimProfile) {
                  const proof = assertPreclaimEffects({ source, pool, lp: d.lp, coins: d.coins, executor, owner, recipient, index: route.index,
                    amountIn: input.amount, witness: run.feeWitness! }, observed);
                  assert.equal(proof.actualReceipt, quote.amountOut); expected = proof.expectedMatrix;
                  record.preclaimEffects = { ...proof, witness: run.feeWitness, preclaimView: trial.preclaimView,
                    receiptMinusView: proof.actualReceipt - trial.preclaimView.amountOut, observer: "independent full matrix and source events; production decoder not called" };
                }
                if (zap) {
                  assert(!external && !defaultLeg.settlement?.directOutput, "this zap source has no output-recipient parameter");
                  const supplies = observed.totalSupplyDeltas!; assert.equal(supplies?.length, 2);
                  const lp = supplies.filter(row => same(row.token, d.lp)), base = supplies.filter(row => same(row.token, zap.baseLp)); assert.equal(lp.length, 1); assert.equal(base.length, 1);
                  assert.equal(lp[0]!.delta, route.direction === "mint" ? quote.amountOut : -input.amount);
                  const baseDelta = base[0]!.delta;
                  assert(route.index === 0 ? baseDelta === 0n : route.direction === "mint" ? baseDelta > 0n : baseDelta < 0n);
                  const matrix: [string, string, bigint][] = [...new Set([d.lp, zap.baseLp, ...d.coins])].flatMap(token =>
                    [executor, owner, pool, zap.metaPool, zap.basePool].map(account => [token, account, 0n] as [string, string, bigint]));
                  const set = (token: string, account: string, delta: bigint) => { const rows = matrix.filter(row => same(row[0], token) && same(row[1], account)); assert.equal(rows.length, 1); rows[0]![2] = delta; };
                  set(route.tokenIn, executor, -input.amount); set(route.tokenOut, recipient, quote.amountOut);
                  set(d.coins[route.index]!, route.index === 0 ? zap.metaPool : zap.basePool, route.direction === "mint" ? input.amount : -quote.amountOut);
                  set(zap.baseLp, zap.metaPool, baseDelta); expected = matrix;
                  record.zapEffects = { metaPool: zap.metaPool, basePool: zap.basePool, baseLp: zap.baseLp, baseLpSupplyDelta: baseDelta,
                    metaLpSupplyDelta: lp[0]!.delta, path: route.index === 0 ? "direct-meta-coin" : "two-stage-base-LP", sweptInventoryBefore: zapInventory,
                    baseLpAndOutputAtZapAfter: "zero: source balance zero plus observed net zero", protocolBalanceOverrides: false };
                }
                assert.equal(observed.tokenDeltas?.length, expected.length);
                for (const [token, account, delta] of expected) { const rows = observed.tokenDeltas!.filter(row => same(row.token, token) && same(row.account, account)); assert.equal(rows.length, 1); assert.equal(rows[0]!.delta, delta); }
                if (!zap) assert.deepEqual(observed.totalSupplyDeltas, [{ token: d.lp, delta: route.direction === "mint" ? quote.amountOut : -input.amount }]);
                assert.equal(observed.nativeDeltas?.length, 1); assert(same(observed.nativeDeltas![0]!.account, executor)); assert.equal(observed.nativeDeltas![0]!.delta, 0n);
                const transfers = (observed.logs ?? []).filter(log => same(log.topics[0], TOKEN.getEvent("Transfer")!.topicHash)).map(log => ({ token: log.address, args: TOKEN.parseLog(log)!.args }));
                const flow = (token: string, account: string) => transfers.filter(log => same(log.token, token)).reduce((value, log) => value + (same(log.args.to, account) ? log.args.value as bigint : 0n) - (same(log.args.from, account) ? log.args.value as bigint : 0n), 0n);
                assert.equal(flow(route.tokenIn, executor), -input.amount); assert.equal(flow(route.tokenOut, recipient), quote.amountOut);
                if (zap) {
                  for (const row of observed.tokenDeltas!) assert.equal(flow(row.token, row.account), row.delta, "zap Transfer flow differs from independently observed token delta");
                  for (const row of observed.totalSupplyDeltas!) assert.equal(-flow(row.token, ethers.ZeroAddress), row.delta, "zap LP mint/burn log differs from independently observed supply");
                  record.zapEffects.measuredTokenDeltas = observed.tokenDeltas; record.zapEffects.measuredSupplyDeltas = observed.totalSupplyDeltas;
                }
                const debit = -observed.tokenDeltas!.find(row => same(row.token, route.tokenIn) && same(row.account, executor))!.delta;
                const received = observed.tokenDeltas!.find(row => same(row.token, route.tokenOut) && same(row.account, recipient))!.delta;
                record.actual = { payer: executor, recipient, debit, receipt: received, quoteDelta: received - quote.amountOut,
                  nativeDelta: observed.nativeDeltas![0]!.delta, outputInventoryPreserved: oldOutput };
              }
              record.status = fault === "none" ? "pass" : "correctly-rejected";
              if (fault !== "none") record.rollbackEvidence = "trusted MainRevert; no independent full-storage-diff claim";
            }
            trial.status = "pass"; console.log(json({ pool, direction: route.direction, index: route.index, mode, amountIn: input.amount, amountOut: quote.amountOut, status: trial.status }));
          }
          stage = `${pool}:${route.direction}:${route.index}:${mode}:zero-input`;
          const zero = await execute(runtimeProgramScript(ethers.getBytes(leg.program), 0n), 101n, 103n); report.roundTrips.push({ pool, routeKey: route.routeKey, mode, amountIn: 0n, ...zero }); reverted(zero.value);
        }
      }
    }
    assert.equal(guard.counts.forbiddenDuringBuild, 0); report.runtimeConstruction = { exact: 0, rpc: 0, quotedFallback: false, scope: "production runtime issuer construction; production sim selector tested separately" };
    report.coverage = { selectedTargets: targets.length, targetFilter: args.get("--target"), routeFilter: args.get("--route"), population187Accepted: false };
    report.result = "same-state-selected-curve-lp-dual-pass";
    report.inputs = [...files].map(([path, sha256]) => ({ path, sha256 }));
  } catch (error) { report.error = { stage, message: redact(error instanceof Error ? error.message : error) }; process.exitCode = 1; }
  finally {
    try { await finalPins?.(); await simulation?.closeAndDrain(); report.drained = true; }
    catch (error) { report.finalError = redact(error instanceof Error ? error.message : error); report.result = "failed"; process.exitCode = 1; await simulation?.closeAndDrain().catch(() => {}); }
    clearTimeout(timer); report.directReads = reads; report.invocationCounts = guard.counts; writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, out: args.get("--out"), samples: report.samples.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid Curve LP dual arguments/output; no success claimed"); process.exitCode = 1; });
