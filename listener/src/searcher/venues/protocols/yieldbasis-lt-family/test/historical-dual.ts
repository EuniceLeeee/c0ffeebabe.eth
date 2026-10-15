// Opt-in same-N evidence from natural production Ready/price artifacts.
// Uses the production Exact issuer, quoted action and runtime builder, then
// independently observes both scripts through the trusted executor transport.
// Per-call times are diagnostics, NOT the live-stage latency benchmark.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../../../../shared/executor/botvm-program-entry.js";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { atBlockJson, parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { AdapterRequest, ObservedEffects } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { assertHistoricalDiscoveryReceipt, assertHistoricalPriceDirection } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { splicedProductionAmount, assertReceipt, ERC20 } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { YIELDBASIS_FAMILY_ID } from "../manifest.js";
import { DEPOSIT_REQUIREMENTS, DEPOSIT_EFFECTS, DEPOSIT_DEBT_POLICY } from "../deposit.js";
import { LT_INTERFACE } from "../abi.js";
import { assertRecipientEffects } from "./recipient-observations.js";

// Output assertions only: the single-block Ready must have discovered and
// admitted these independently. No sample address is a production allowlist.
export const YB_SAMPLES = {
  weth: { number: 26003536, hash: "0xf913fc4aaaeca0fd9fcd871c1a2b0159e1ecc3679724fff679a061ca7bedeaad",
    tx: "0x022a9ff85219675bcf0a0a2b17c76ac72b98d5e2c4177bc104edff56e706ee77",
    lt: "0x2b9c9f3bdceb5d8e36a4704f08a78fca53343cea", withdraw: true },
  cbbtc: { number: 25978646, hash: "0x92b3bae67fee715da326d8d9adcc0a9802bc99b44600996570d83c86ad2d43e4",
    tx: "0x1d1f257fc96b602e28292c8ff49a8e9924c3872a48ad0f9cf5d1b2af68d13e60",
    lt: "0x722fc3640ba007c3e9867ccdb0dca59f2e2f29f9", withdraw: true },
  wbtc: { number: 25981574, hash: "0x2c5ccdd115c093cd23b1ab3c54d9d94bc50d8f8a1c5a945571ff312e60f8cc04",
    tx: "0x061eb9595d5deb25b4e5b410a415e3e4567f28f7566c80aaf86cf30cada6a73e",
    lt: "0x651d4b8168488fa163d85304662e8278d4c55baa", withdraw: false },
} as const;
const EXECUTOR = "0x1000000000000000000000000000000000000002", OWNER = "0x1000000000000000000000000000000000000001";
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x, 2);
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function verifyExecutorSources(root: string, artifactPath: string) {
  const bytes = readFileSync(artifactPath), artifact = JSON.parse(bytes.toString());
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM");
  const entries = Object.entries(metadata.sources) as [string, { keccak256: string }][];
  assert(entries.length > 0 && Object.hasOwn(metadata.sources, "src/BotVM.sol"));
  const sources = entries.map(([name, entry]) => {
    const path = realpathSync(resolve(root, name));
    assert(name.endsWith(".sol") && !relative(realpathSync(root), path).startsWith(".."));
    const content = readFileSync(path); assert.equal(ethers.keccak256(content), entry.keccak256);
    return { path: name, keccak256: entry.keccak256, sha256: sha(content) };
  });
  return { artifactSha256: sha(bytes), sources };
}

/** Receipt/trace observation, not a quote or reconstructed pre-call state.
 * Emergency withdrawals must not be mislabeled ordinary single-asset exits. */
export function originalYbAmounts(receipt: any, trace: any, sample: (typeof YB_SAMPLES)[keyof typeof YB_SAMPLES], asset: string) {
  assertReceipt(receipt, sample.tx, { number: ethers.toQuantity(sample.number), hash: sample.hash });
  const logIds = receipt.logs.map((l: any) => { assert(typeof l.logIndex === "string"); return BigInt(l.logIndex).toString(); });
  assert.equal(new Set(logIds).size, logIds.length, "duplicate receipt log identity");
  assert(trace && !trace.error && !trace.revertReason, "original transaction reverted");
  const frames: any[] = [];
  const visit = (f: any) => {
    if (!f || f.error || f.revertReason) return;
    if (f.type === "CALL" && same(f.to ?? "", sample.lt)) frames.push(f);
    for (const child of f.calls ?? []) visit(child);
  };
  visit(trace);
  const result: Partial<Record<"deposit" | "withdraw", { amountIn: bigint; amountOut: bigint; interface: string; logIndex: string }>> = {};
  for (const [direction, event, functions, expected] of [
    ["deposit", "Deposit", ["deposit(uint256,uint256,uint256)", "deposit(uint256,uint256,uint256,address)"], 1],
    ["withdraw", "Withdraw", ["withdraw(uint256,uint256)", "withdraw(uint256,uint256,address)"], sample.withdraw ? 1 : 0],
  ] as const) {
    const logs = receipt.logs.filter((l: any) => same(l.address, sample.lt) && same(l.topics?.[0] ?? "", LT_INTERFACE.getEvent(event)!.topicHash));
    const calls = frames.flatMap(f => functions.filter(name => LT_INTERFACE.getFunction(name)!.selector === f.input?.slice(0, 10))
      .map(name => ({ frame: f, name })));
    assert.equal(logs.length, expected, "unexpected/ambiguous original event count");
    assert.equal(calls.length, expected, "ordinary call/event count differs (emergency is not ordinary)");
    if (expected === 0) continue;
    const log = logs[0], a = LT_INTERFACE.parseLog(log)!.args, { frame, name } = calls[0]!;
    const data = LT_INTERFACE.decodeFunctionData(name, frame.input);
    const amountIn = BigInt(direction === "deposit" ? a.assets : a.shares);
    const amountOut = BigInt(direction === "deposit" ? a.shares : a.assets);
    const receiver = direction === "deposit" ? (data.length === 4 ? data[3] : frame.from) : (data.length === 3 ? data[2] : frame.from);
    assert(amountIn > 0n && amountOut > 0n);
    assert.equal(data[0], amountIn); assert.equal(LT_INTERFACE.decodeFunctionResult(name, frame.output)[0], amountOut);
    assert(same(a.sender, frame.from) && same(direction === "deposit" ? a.owner : a.receiver, receiver));
    if (direction === "withdraw") assert(same(a.owner, frame.from));
    const tokenOut = direction === "deposit" ? sample.lt : asset;
    let payer = ethers.ZeroAddress;
    if (direction === "withdraw") {
      const payments: any[] = [];
      const visitPayment = (f: any) => {
        if (!f || f.error || f.revertReason) return;
        if (f.type === "CALL" && same(f.to ?? "", tokenOut) && f.input?.slice(0, 10) === ERC20.getFunction("transfer")!.selector) {
          const [to, amount] = ERC20.decodeFunctionData("transfer", f.input);
          if (same(to, receiver) && amount === amountOut) payments.push(f);
        }
        for (const child of f.calls ?? []) visitPayment(child);
      };
      visitPayment(frame); assert.equal(payments.length, 1, "withdraw payment not bound to original subtree");
      const returned = payments[0].output ?? "0x";
      assert(returned === "0x" || (ethers.isHexString(returned, 32) && BigInt(returned) === 1n));
      payer = payments[0].from;
    }
    const received = receipt.logs.filter((l: any) => same(l.address, tokenOut) && same(l.topics?.[0] ?? "", ERC20.getEvent("Transfer")!.topicHash))
      .map((l: any) => ERC20.parseLog(l)!.args).filter((t: any) => same(t.to, receiver) && t.value === amountOut &&
        same(t.from, payer));
    assert.equal(received.length, 1, "original independent output receipt missing/ambiguous");
    result[direction] = { amountIn, amountOut, interface: name, logIndex: log.logIndex };
  }
  return result;
}

/** A reverse-direction amount is taken from independently verified same-N
 * minted shares, not from a donor output or a raw-mid multiplication. This is
 * a separate same-state leg test, NOT a composed deposit/withdraw transaction. */
export function referenceMintAmount(sample: any, asset: string, share: string, externalRecipient?: string): bigint {
  assert(sample?.status === "pass" && same(sample.tokenIn, asset) && same(sample.tokenOut, share));
  assert(["production-effective", "spliced-production-input-at-N"].includes(sample.label));
  assert.equal(sample.executions.length, 4);
  assert.deepEqual(sample.executions.map((e: any) => `${e.encoding}:${e.mode}`).sort(),
    externalRecipient ? ["direct-external:input-only", "direct-external:old-inventory", "direct-self:input-only", "direct-self:old-inventory"] :
      ["quoted:input-only", "quoted:old-inventory", "runtime:input-only", "runtime:old-inventory"]);
  const received = sample.executions.map((e: any) => {
    assert(e.status === "pass");
    const rows = e.effects?.tokenDeltas?.filter((r: any) => same(r.token, share) && same(r.account, externalRecipient && e.encoding === "direct-external" ? externalRecipient : EXECUTOR));
    assert.equal(rows?.length, 1); assert(rows[0].delta > 0n); return rows[0].delta as bigint;
  });
  assert(received.every((n: bigint) => n === received[0]));
  return received[0]!;
}

export function assertObservedLeg(effects: ObservedEffects | undefined, input: string, output: string,
  stable: string, amountIn: bigint, amountOut: bigint): void {
  assert(effects?.tokenDeltas && effects.tokenDeltas.length === 3, "missing/extra balance observations");
  for (const [token, delta] of [[input, -amountIn], [output, amountOut], [stable, 0n]] as const) {
    const rows = effects.tokenDeltas.filter(r => same(r.token, token) && same(r.account, EXECUTOR));
    assert.equal(rows.length, 1, "ambiguous observation"); assert.equal(rows[0]!.delta, delta, "actual debit/receipt differs");
  }
  assert.equal(effects.nativeDeltas?.length, 1);
  assert(same(effects.nativeDeltas![0]!.account, EXECUTOR)); assert.equal(effects.nativeDeltas![0]!.delta, 0n);
}

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

async function main() {
  const required = ["--ready", "--prices", "--revm-bin", "--out"];
  const args = new Map<string, string>(), names = [...required, "--rpc-env", "--rpc-file", "--sample", "--reference-prices", "--reference-edges", "--recipient"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert(names.includes(key) && !args.has(key) && value); args.set(key, value);
  }
  assert(required.every(k => args.has(k))); assert(args.has("--rpc-env") !== args.has("--rpc-file"));
  if (args.has("--rpc-env")) assert.equal(args.get("--rpc-env"), "MAINNET_RPC_URL");
  const sampleKey = args.get("--sample") ?? "weth"; assert(Object.hasOwn(YB_SAMPLES, sampleKey));
  const selected = YB_SAMPLES[sampleKey as keyof typeof YB_SAMPLES];
  const { number: N, hash: HASH, tx: TX, lt: LT } = selected;
  assert.equal(args.has("--reference-prices"), args.has("--reference-edges"));
  const referenceEdges: unknown = args.has("--reference-edges") ? JSON.parse(args.get("--reference-edges")!) : [];
  assert(Array.isArray(referenceEdges) && referenceEdges.every(e => typeof e === "string" && e.length > 0));
  if (args.has("--reference-prices")) assert.equal(referenceEdges.length, 1, "only one explicit underlying input donor is needed");
  const recipient = args.has("--recipient") ? ethers.getAddress(args.get("--recipient")!) : undefined;
  if (recipient) assert(!same(recipient, EXECUTOR) && recipient !== ethers.ZeroAddress);
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [],
    tx: TX, block: N, hash: HASH, instance: LT, policy: DEPOSIT_DEBT_POLICY, broadcast: false, controls: [],
    claim: recipient ? "supplementary direct-only same-N production issuer/Exact and actual receipts; quoted/default are constructed for byte reuse only, not reexecuted" : "same-N production quote/quoted/runtime actual receipts; no original-precall, profitability or representative latency verdict" };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 360_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 360_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0;
  let constructing = false, constructionReads = 0, stage = "inputs";
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const error = (e: unknown) => ({ stage, message: redact(e instanceof Error ? e.message : e) });
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const referencePath = args.has("--reference-prices") ? realpathSync(args.get("--reference-prices")!) : undefined;
    const declarationPath = referencePath ? realpathSync(resolve(dirname(referencePath), "declaration.json")) : undefined;
    const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
    const artifactPath = realpathSync(resolve(root, "out/BotVM.sol/BotVM.json"));
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json"), args.get("--revm-bin")!, fileURLToPath(import.meta.url), fileURLToPath(new URL("./recipient-observations.ts", import.meta.url)), artifactPath, ...(referencePath ? [referencePath, declarationPath!] : [])];
    const inputPins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = inputPins(); report.sourceTreeSha256 = sourcePin();
    report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!)); report.harnessSha256 = sha(readFileSync(fileURLToPath(import.meta.url)));
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    const reference = referencePath ? { saved: parseAtBlockJson(readFileSync(referencePath, "utf8")),
      declaration: parseAtBlockJson(readFileSync(declarationPath!, "utf8")) } : undefined;
    for (const p of [prices, provenance]) {
      assert.equal(p.readySha256, report.inputs[0].sha256); assert.equal(realpathSync(p.readyPath), readyPath);
    }
    assert.equal(provenance.implementation.sourceTreeSha256, report.sourceTreeSha256);
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    assert.equal(provenance.executionMode, "source-block"); assert.equal(provenance.through, "prices"); assert.equal(provenance.broadcast, false);
    assert(same(provenance.executor, EXECUTOR) && same(provenance.owner, OWNER)); assert.equal(BigInt(provenance.chainId), 1n);
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    assert.equal(source.number, N); assert.equal(source.hash, HASH);
    assert.equal(ready.universeRange.fromBlock, N); assert.equal(ready.universeRange.toBlock, N);
    for (const s of [provenance.topologySource, provenance.stateSource]) { assert.equal(s.number, N); assert.equal(s.hash, HASH); }
    assert.equal(prices.runtime.sourceBlock, N); assert.equal(prices.runtime.sourceBlockHash, HASH);
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === YIELDBASIS_FAMILY_ID && same(m.instanceKey, LT)); assert.equal(memos.length, 1);
    const memo = memos[0]!; assert([familyDefinitionHash(YIELDBASIS_FAMILY_ID), familyMemoDefinitionHash(YIELDBASIS_FAMILY_ID)].includes(memo.familyDefinitionHash));
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [YIELDBASIS_FAMILY_ID], executionIdentity: { executor: EXECUTOR, transactionOrigin: OWNER } });
    const family = asPricedFamily(catalog.forStrictFamily(YIELDBASIS_FAMILY_ID));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d = instance.descriptor as any; report.descriptor = d; report.source = source; report.recipientAcceptance = { recipient: recipient ?? EXECUTOR, scope: recipient ? "supplementary direct-only; default/quoted bytes only" : "original quoted/default" }; assert.equal(d.depositPathVerified, true); assert.equal(d.redemptionPathVerified, true);
    assert.equal(instance.routes.length, 2); const edges = graph.filter(e => e.instanceKey === instance.instanceKey); assert.equal(edges.length, 2);
    const rows = edges.map(edge => {
      const key = blockScanEdgeKey(edge), row = prices.runtime.pricing.effectiveMids.rows.get(key), raw = prices.runtime.pricing.mids.get(key);
      assert(row && raw?.mid > 0); assertHistoricalPriceDirection(edge, row, instance.instanceKey);
      if (row.status === "quoted") {
        assert(row.amountIn > 0n && row.amountOut > 0n); assert.equal(row.quotedAt.number, N); assert.equal(row.quotedAt.hash, HASH);
      } else assert(reference && row.status === "missing-valuation", "not a donor-addressable valuation gap");
      const route = instance.routes.find(r => same(r.tokenIn, row.tokenIn) && same(r.tokenOut, row.tokenOut))!; assert(route);
      const handle = instance.routeHandles.find(r => r.routeKey === route.routeKey)!; assert(handle);
      return { row, route, handle };
    }).sort((a, b) => Number(same(b.row.tokenIn, d.asset)) - Number(same(a.row.tokenIn, d.asset)));
    const splice = reference ? splicedProductionAmount(reference.saved, reference.declaration, referenceEdges, d.asset) : undefined;
    if (reference) report.referenceInput = { prices: referencePath, declaration: declarationPath, sourceCommit: reference.declaration.head,
      cfg: JSON.parse(atBlockJson(reference.saved.cfg)), donorReadySha256: reference.saved.readySha256,
      referenceWethInput: reference.saved.runtime.pricing.effectiveMids.referenceWethInput, selected: splice,
      inputOnly: true, naturalTargetValuation: false, quoteAndExecutionState: source };
    report.ready = { graphHash: ready.graphHash, memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate: memo.candidateSnapshot };
    report.prices = rows.map(r => r.row); report.originalPriceStageMs = prices.runtime.pricing.effectiveMids.wallMs;
    rpcUrl = args.has("--rpc-file") ? JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL : process.env.MAINNET_RPC_URL!;
    assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
    const pin = { blockHash: HASH, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]) => {
      assert(!constructing); assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "debug_traceTransaction", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const id = ++reads; assert(id <= 100); abort.signal.throwIfAborted();
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) });
      assert(response.ok, `HTTP ${response.status}`); const body: any = await response.json();
      assert.equal(body.id, id); assert.equal(body.jsonrpc, "2.0"); assert(!body.error, `read failed: ${method}`); return body.result;
    };
    stage = "source/receipt";
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false]); assert.equal(header.hash, HASH);
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n); report.header = header;
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, source);
    const candidateReceipt = (memo.candidateSnapshot as any).transactionHash === TX ? receipt : await rpc("eth_getTransactionReceipt", [(memo.candidateSnapshot as any).transactionHash]);
    assertHistoricalDiscoveryReceipt(candidateReceipt, memo.candidateSnapshot as any, source);
    const trace = await rpc("debug_traceTransaction", [TX, { tracer: "callTracer" }]);
    const originals = originalYbAmounts(receipt, trace, selected, d.asset);
    report.originalEvidence = { receiptSha256: sha(json(receipt)), traceSha256: sha(json(trace)), receipt, trace };
    report.original = { ...originals, comparison: "original call-prestate not restored; N-end output may differ" };
    report.deployedBindings = [];
    for (const [label, address] of Object.entries({ lt: d.lt, asset: d.asset, stablecoin: d.stablecoin, cryptopool: d.cryptopool, amm: d.amm, staker: d.staker })) {
      const code = await rpc("eth_getCode", [address, pin]); assert(code && code !== "0x");
      report.deployedBindings.push({ label, address, source, codeHash: ethers.keccak256(code), codeBytes: ethers.getBytes(code).length });
    }
    report.executorArtifact = { path: artifactPath, ...verifyExecutorSources(root, artifactPath) };
    const executorRuntimeCode = loadBotVmRuntimeCode(OWNER); report.executorCodeHash = executorRuntimeCode.keccak256; report.executorOwner = OWNER;
    assert.equal(provenance.counterfactualExecutorCode.keccak256, executorRuntimeCode.keccak256);
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => {
        const client = new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 90_000, onFatal });
        const strict = client.strictSimulate.bind(client);
        client.strictSimulate = async (...input) => { const result = await strict(...input); (report.strictCalls ??= []).push({ stage, result }); return result; };
        return client;
      },
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor: EXECUTOR, transactionOrigin: OWNER,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, N); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, N); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, N); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    // The production boundary needs sealed caller authority. All service access
    // is forbidden during construction, including simulation as well as Exact.
    const guardedRuntime = new Proxy(runtime, { get(target, key, receiver) {
      if (constructing && !["callerAuthority", "generationFence"].includes(String(key))) {
        constructionReads++; throw new Error("runtime construction accessed quote/simulation service");
      }
      return Reflect.get(target, key, receiver);
    } });
    const beforeConstruction = reads; constructing = true;
    const legs = rows.map(({ handle }) => {
      const input: any = { family, route: handle, source, runtime: guardedRuntime, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog };
      for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exact", "exactEvidence"])
        Object.defineProperty(input, key, { get() { constructionReads++; throw new Error("runtime construction read a quote/amount"); } });
      const leg = buildFamilyRuntimeAmountLeg(input); assert(leg, "runtime fallback is not accepted"); return leg;
    });
    const directLegs = recipient ? rows.map(({ handle }) => [EXECUTOR, recipient].map(receiver => {
      const input: any = { family, route: handle, source, runtime: guardedRuntime, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog,
        settlement: { kind: "direct-output", recipient: receiver } };
      for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exact", "exactEvidence"])
        Object.defineProperty(input, key, { get() { constructionReads++; throw new Error("direct construction read a quote/amount"); } });
      const leg = buildFamilyRuntimeAmountLeg(input); assert(leg, "direct runtime fallback is not accepted");
      assert.deepEqual(leg.settlementRequest, input.settlement); return leg;
    })) : undefined;
    if (recipient) for (const { handle } of rows) assert.throws(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source,
      runtime: guardedRuntime, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog,
      settlement: { kind: "direct-output", recipient: d.staker } }));
    constructing = false; assert.equal(constructionReads, 0); assert.equal(reads, beforeConstruction);
    report.runtimeConstruction = { directions: legs.length, exactCalls: 0, rpcCalls: 0, quotedFallback: false };
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, EXECUTOR, concatBytes(...node.children.map(compile))); };
    let referenceDeposit: any;
    for (const [index, { row, route, handle }] of rows.entries()) {
      const deposit = same(row.tokenIn, d.asset), original = deposit ? originals.deposit : originals.withdraw;
      const referenceTrial = row.status === "quoted" ? { label: "production-effective", amountIn: row.amountIn as bigint } : deposit
        ? { label: "spliced-production-input-at-N", amountIn: splice!.amountIn }
        : { label: "same-N-minted-reference-input", amountIn: referenceMintAmount(referenceDeposit, d.asset, d.share, recipient) };
      if (!deposit && row.status !== "quoted") report.reverseReference = { ...referenceTrial, parentSampleIndex: report.samples.indexOf(referenceDeposit),
        source, kind: "actual target mint receipts, independent same-N reverse leg", naturalWethValuation: false,
        composedRoundTrip: false, donorOutputBorrowed: false };
      const trials = [referenceTrial, original ? { label: "original-amount-at-N", amountIn: original.amountIn }
        : { label: "twice-same-N-minted-reference-input", amountIn: referenceTrial.amountIn * 2n }];
      for (const { label, amountIn } of trials) {
        const sample: any = { label, direction: (route as any).direction, tokenIn: row.tokenIn, tokenOut: row.tokenOut, amountIn, status: "failed", executions: [] }; report.samples.push(sample);
        try {
          stage = "production-exact"; const started = performance.now();
          const quote = await executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation, executor: EXECUTOR,
            runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } });
          sample.quoteDiagnosticMs = performance.now() - started; sample.quote = quote;
          assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
          assert.equal(quote.amountIn, amountIn); assert.deepEqual(quote.source, source); assert(quote.amountOut > 0n);
          if (label === "production-effective") assert.equal(quote.amountOut, row.amountOut, "saved effective differs");
          const fragment = buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog });
          assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
          const originalScripts = [["quoted", concatBytes(...planFragmentNodes(fragment.fragment, row.tokenIn, amountIn).map(compile))],
            ["runtime", runtimeProgramScript(ethers.getBytes(legs[index]!.program), amountIn)]] as const;
          sample.defaultProgramHashes = originalScripts.map(([encoding, script]) => ({ encoding, hash: ethers.keccak256(script) }));
          const scripts: readonly (readonly [string, Uint8Array])[] = recipient ? [
            ["direct-self", runtimeProgramScript(ethers.getBytes(directLegs![index]![0]!.program), amountIn)],
            ["direct-external", runtimeProgramScript(ethers.getBytes(directLegs![index]![1]!.program), amountIn)]] : originalScripts;
          const modes = recipient ? ["input-only", "old-inventory", "missing-input", "post-execution-revert"] : ["input-only", "old-inventory", "missing-input"];
          for (const [encoding, originalScript] of scripts) for (const mode of modes) {
            const chosenRecipient = encoding === "direct-external" ? recipient! : EXECUTOR;
            const script = mode === "post-execution-revert" ? concatBytes(originalScript, runtimeProgramScript(
              new RuntimeAmountProgram().constant(1, 0n).constant(2, 1n).equal(1, 2).bytes(), 0n)) : originalScript;
            stage = encoding + ":" + mode; const negative = mode === "missing-input" || mode === "post-execution-revert", inventory = mode !== "input-only";
            const result: any = { encoding, mode, amountIn, recipient: chosenRecipient, status: "failed", scriptHash: ethers.keccak256(script) };
            (negative ? report.controls : sample.executions).push(result);
            const caller = { kind: "executor" as const }, request: AdapterRequest = { id: "execute", ...(recipient ? { required: false } : {}), kind: "effect-delta-simulation",
              call: { caller, executionMode: "executor-program", to: EXECUTOR, data: buildSubscriptCalldata(script) },
              overrideIntent: { caller, ...(recipient ? { nativeBalanceWei: 17n } : {}), tokenBalances: [{ token: row.tokenIn, amount: mode === "missing-input" ? 0n : amountIn + (inventory ? 101n : 0n) },
                { token: row.tokenOut, amount: inventory ? quote.amountOut + 103n : 0n }, { token: d.stablecoin, amount: inventory ? 107n : 0n }] },
              observeTokenBalances: [row.tokenIn, row.tokenOut, d.stablecoin].flatMap(token =>
                [EXECUTOR, ...(same(chosenRecipient, EXECUTOR) ? [] : [chosenRecipient])].map(account => ({ token,
                  account: same(account, EXECUTOR) ? caller : account }))), observe: DEPOSIT_EFFECTS };
            result.request = request;
            const begin = performance.now(); const outcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: {
              stage: "exact-refine", familyId: YIELDBASIS_FAMILY_ID, source, generation: source.generation, programInput: undefined,
              program: { requirements: () => DEPOSIT_REQUIREMENTS, buildRequests: () => [request], decode: ({ results }) => results } } });
            result.diagnosticMs = performance.now() - begin; result.outcome = outcome;
            assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("execution issuer unresolved");
            const evidence = outcome.executed.evidence; assert.equal(evidence.length, 1); const returned = evidence[0]!;
            assert(returned.ok, "transport failure is not execution/revert evidence"); assert.deepEqual(returned.source, source);
            if (negative) {
              assert.equal(returned.completion, "reverted-as-declared", "missing input consumed inventory or produced a false pass");
              result.rollbackScope = "strict declared main revert only; no independent post-rollback storage observation";
              for (const effect of [...(returned.effects?.tokenDeltas ?? []), ...(returned.effects?.nativeDeltas ?? [])]) assert.equal(effect.delta, 0n);
              result.status = "pass"; continue;
            }
            assert(returned.completion === "returned" && returned.data === "0x", "program reverted or returned unexpected data");
            if (recipient) assertRecipientEffects(returned.effects, deposit ? "deposit" : "withdraw", EXECUTOR, chosenRecipient,
              d.asset, d.share, d.stablecoin, amountIn, quote.amountOut);
            else assertObservedLeg(returned.effects, row.tokenIn, row.tokenOut, d.stablecoin, amountIn, quote.amountOut);
            result.effects = returned.effects; result.quoteDelta = 0n; result.oldInventoryConsumed = 0n; result.status = "pass";
          }
          assert.equal(sample.executions.length, 4);
          for (const e of sample.executions) {
            const peer = recipient ? sample.executions.find((x: any) => x.encoding === e.encoding) : sample.executions[0];
            assert.deepEqual(peer.effects.tokenDeltas, e.effects.tokenDeltas);
          }
          sample.status = "pass";
          if (deposit && label === referenceTrial.label) referenceDeposit = sample;
        } catch (e) { sample.error = error(e); }
        console.log(json({ direction: sample.direction, label, status: sample.status, quoteMs: sample.quoteDiagnosticMs }));
        abort.signal.throwIfAborted();
      }
    }
    assert.equal(report.samples.length, 4); assert(report.samples.every((s: any) => s.status === "pass"));
    assert.equal(report.controls.length, recipient ? 16 : 8); assert(report.controls.every((c: any) => c.status === "pass"));
    assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false])).hash, HASH);
    assert.equal(sourcePin(), report.sourceTreeSha256); assert.deepEqual(inputPins(), report.inputs);
    assert.equal(loadBotVmRuntimeCode(OWNER).keccak256, report.executorCodeHash);
    assert.deepEqual({ path: artifactPath, ...verifyExecutorSources(root, artifactPath) }, report.executorArtifact);
    report.result = reference ? "pass-with-spliced-reference" : "pass";
  } catch (e) { report.error = error(e); process.exitCode = 1; }
  finally {
    const start = performance.now(); try { await simulation?.closeAndDrain(); report.drained = true; } catch (e) { report.drainError = error(e); report.result = "failed"; process.exitCode = 1; }
    clearTimeout(timer); report.drainDiagnosticMs = performance.now() - start; report.directReads = reads;
    writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, samples: report.samples.length, executions: report.samples.reduce((n: number, s: any) => n + s.executions.filter((e: any) => e.status === "pass").length, 0) }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid YB dual inputs; existing outputs untouched"); process.exitCode = 1; });
