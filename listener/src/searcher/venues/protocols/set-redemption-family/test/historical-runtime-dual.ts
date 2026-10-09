// Opt-in historical single-leg evidence. Production Ready/Graph, prices,
// Exact and both encoders remain the authorities. N end-state + N environment
// is NOT original-TX pre-call state, next-hop flow, full-route sim or a merge gate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { AnvilStateBackend } from "../../../../../shared/state/state-backend.js";
import { buildExecuteCalldata, loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { createAdapterFamilyExactQuoteCache } from "../../../../adapter-family-exact-quote-cache.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { balanceStorageKey, resolveErc20BalanceSlot } from "../../../../solver/balance-slots.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { MAX } from "../codec.js";
import { key } from "../instance.js";
import { FAMILY } from "../manifest.js";
import { CORE, CORE_LIBRARIES, LEGACY_SET } from "../legacy.js";
import type { Descriptor } from "../types.js";
import { SAMPLE as BASIC_SAMPLE, ERC20, lower, same, json, sha, word, observeBalance, assertBasket, historicalReceipt } from "./historical-runtime-observations.js";
import { LEGACY_SAMPLES, legacyHistoricalReceipt, assertExecutionRevert, assertLegacyInvalidAmountEvidence } from "./historical-legacy-observations.js";

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
type Overrides = Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string> }>;
type Rpc = (method: string, params: unknown[]) => Promise<any>;
const git = (...args: string[]) => execFileSync("git", ["-c", "safe.directory=" + ROOT.replace(/\/$/, ""), ...args],
  { cwd: ROOT, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

// Match the current at-block producer's sourceTreeSha256, then additionally
// bind Solidity, packages, this test and its actual BotVM artifact.
function sourcePin() {
  const files: [string, string][] = [];
  const visit = (path: string) => {
    for (const e of readdirSync(resolve(ROOT, "listener/src", path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "test" || e.name === "templates") continue;
      const p = path ? path + "/" + e.name : e.name;
      if (e.isDirectory()) visit(p);
      else { assert(e.isFile(), "unsupported source file type"); files.push([p, sha(readFileSync(resolve(ROOT, "listener/src", p)))]); }
    }
  };
  visit("");
  const solidity = git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src", "lib")
    .split("\0").filter(p => p.endsWith(".sol")).sort();
  const packages = ["listener/package.json", "listener/package-lock.json", "foundry.toml"];
  return { sourceTreeSha256: sha(JSON.stringify(files)), fileCount: files.length,
    soliditySha256: sha(json(solidity.map(p => [p, sha(readFileSync(resolve(ROOT, p)))]))),
    packageSha256: sha(json(packages.map(p => [p, sha(readFileSync(resolve(ROOT, p)))]))),
    testSha256: sha(readFileSync(SELF)), helperSha256: sha(readFileSync(new URL("./historical-runtime-observations.ts", import.meta.url))),
    legacyHelperSha256: sha(readFileSync(new URL("./historical-legacy-observations.ts", import.meta.url))),
    artifactSha256: sha(readFileSync(resolve(ROOT, "out/BotVM.sol/BotVM.json"))),
    familyDefinitionHash: familyDefinitionHash(FAMILY), familyMemoDefinitionHash: familyMemoDefinitionHash(FAMILY) };
}

function options(argv: string[]) {
  const names = ["--ready", "--prices", "--rpc-file", "--out", "--port"], values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert([...names, "--sample", "--direction"].includes(argv[i]) && !values.has(argv[i]), "unknown/duplicate option");
    assert(argv[i + 1] && !argv[i + 1].startsWith("--"), "missing option value");
    values.set(argv[i], argv[i + 1]);
  }
  assert(names.every(n => values.has(n)), "required: --ready --prices --rpc-file --out --port");
  const sample = values.get("--sample") ?? "basic";
  assert(sample === "basic" || Object.hasOwn(LEGACY_SAMPLES, sample), "unknown sample");
  const direction = values.get("--direction") ?? "redeem";
  assert(direction === "redeem" || (direction === "issue" && sample !== "basic"), "unsupported direction");
  assert.equal(values.get("--port"), "8593", "this narrow test owns only loopback port 8593");
  const out = resolve(values.get("--out")!), parent = realpathSync(dirname(out)), logs = realpathSync(resolve(ROOT, "logs"));
  assert(parent === logs || parent.startsWith(logs + sep), "output parent must exist under this repo's logs/");
  assert.equal(git("check-ignore", "--", out).trim(), out, "output must be gitignored");
  // Reserve output before resolving/reading inputs, so input failures persist.
  return { ready: resolve(values.get("--ready")!), prices: resolve(values.get("--prices")!),
    rpcFile: resolve(values.get("--rpc-file")!), out, sample, issue: direction === "issue" };
}

function currentBotVm() {
  const a = JSON.parse(readFileSync(resolve(ROOT, "out/BotVM.sol/BotVM.json"), "utf8"));
  const m = typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata;
  assert.equal(m?.settings?.compilationTarget?.["src/BotVM.sol"], "BotVM");
  assert(Object.keys(m.sources).length > 0, "artifact lacks source hashes");
  for (const [name, entry] of Object.entries(m.sources) as [string, { keccak256: string }][]) {
    const path = resolve(ROOT, name);
    assert(!relative(ROOT, path).startsWith(".."), "artifact source outside repo");
    assert.equal(ethers.keccak256(readFileSync(path)), entry.keccak256, "stale BotVM artifact: " + name);
  }
  const groups = Object.values(a.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
  assert.equal(groups.length, 1, "only BotVM.owner may be patched");
  assert(groups[0].length > 0 && groups[0].every(r => r.length === 32));
  return loadBotVmRuntimeCode(OWNER);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = options(argv), fd = openSync(args.out, "wx", 0o600);
  const legacy = args.sample === "basic" ? undefined : LEGACY_SAMPLES[args.sample as keyof typeof LEGACY_SAMPLES];
  const SAMPLE = legacy ?? BASIC_SAMPLE;
  const report: Record<string, any> = { schemaVersion: 1, result: "failed", family: FAMILY, instanceKey: key(SAMPLE),
    claim: "N end-state + N environment single-leg dual execution, all basket receipts; not pre-call replay, next-hop flow, full-route sim, EV or merge acceptance",
    actor: { executor: EXECUTOR, owner: OWNER }, direction: args.issue ? "issue" : "redeem", samples: [], errors: [],
    safety: { signing: false, broadcast: false, minedBlocks: 0, remoteSubmission: false,
      executionOverrides: "actor code/native gas/ERC20 balance slots only; no protocol liquidity, units, supply, registry or eligibility override" } };
  let backend: AnvilStateBackend | undefined, secret = "", stage = "offline-inputs";
  let calls = 0, exactCalls = 0, constructing = false, constructionRpcAttempts = 0, constructionExactAttempts = 0, constructionAmountAttempts = 0;
  let checkPins: (() => void) | undefined, checkFork: (() => Promise<void>) | undefined;
  const abort = new AbortController(), deadline = Date.now() + 480_000;
  const timer = setTimeout(() => abort.abort(new Error("test wall budget exceeded")), 480_000);
  const interrupt = () => abort.abort(new Error("test interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const redact = (v: unknown) => String(v).split(secret || "\0").join("[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]").slice(0, 4000);
  const failure = (e: unknown) => ({ stage, message: redact(e instanceof Error ? e.message : e) });
  try {
    const startPin = sourcePin(); report.code = { headAtStart: git("rev-parse", "HEAD").trim(), ...startPin };
    const readyPath = realpathSync(args.ready), pricePath = realpathSync(args.prices);
    const provenancePath = realpathSync(resolve(dirname(pricePath), "input.json"));
    const inputs = [readyPath, pricePath, provenancePath].map(path => ({ path, bytes: readFileSync(path) }));
    const [readyInput, priceInput, provenanceInput] = inputs;
    report.inputHashes = inputs.map(i => ({ path: i.path, sha256: sha(i.bytes) }));
    checkPins = () => {
      report.codeAfter = sourcePin();
      report.inputHashesAfter = inputs.map(i => ({ path: i.path, sha256: sha(readFileSync(i.path)) }));
      assert.deepEqual(report.codeAfter, startPin, "working source/artifact changed during test");
      assert.deepEqual(report.inputHashesAfter, report.inputHashes, "Ready/prices/provenance changed during test");
    };
    const saved = parseAtBlockJson(priceInput.bytes.toString()), provenance = parseAtBlockJson(provenanceInput.bytes.toString());
    for (const p of [saved, provenance]) {
      assert.equal(p.readySha256, sha(readyInput.bytes), "price provenance does not bind this Ready");
      assert.equal(realpathSync(p.readyPath), readyPath);
    }
    assert.equal(provenance.executionMode, "source-block", "use current production at-block source-block prices");
    assert.equal(provenance.through, "prices"); assert.equal(provenance.broadcast, false);
    assert.equal(provenance.implementation?.sourceTreeSha256, startPin.sourceTreeSha256, "prices came from different working source");
    assert(same(provenance.executor, EXECUTOR) && same(provenance.owner, OWNER), "price caller differs");
    assert.equal(BigInt(provenance.chainId), 1n);
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load();
    assert(envelope && !envelope.inProgressRun, "completed Ready required; this test cannot rebuild or write memos");
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
    const source: CanonicalSource = ready.cutoff, pin = { blockHash: source.hash, requireCanonical: true };
    const sameBlock = (n: number, h: string) => { assert.equal(n, SAMPLE.number); assert(same(h, SAMPLE.hash)); };
    sameBlock(source.number, source.hash);
    assert.equal(ready.universeRange.fromBlock, SAMPLE.number); assert.equal(ready.universeRange.toBlock, SAMPLE.number);
    for (const s of [provenance.topologySource, provenance.stateSource]) sameBlock(s.number, s.hash);
    sameBlock(saved.runtime.sourceBlock, saved.runtime.sourceBlockHash);
    sameBlock(saved.runtime.pricing.sourceBlock, saved.runtime.pricing.sourceBlockHash);
    const header = provenance.sourceHeader;
    sameBlock(Number(BigInt(header.number)), header.hash);
    const family = asPricedFamily(catalog.forStrictFamily(FAMILY));
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FAMILY && m.instanceKey === key(SAMPLE));
    assert.equal(memos.length, 1, "exactly one admitted set:module memo required");
    const memo = memos[0];
    assert([startPin.familyDefinitionHash, startPin.familyMemoDefinitionHash].includes(memo.familyDefinitionHash),
      "stale admission fingerprint; use existing selective revalidation outside this test");
    const candidate = memo.candidateSnapshot as any;
    sameBlock(candidate.blockNumber, candidate.blockHash);
    assert(ethers.isHexString(candidate.transactionHash, 32), "natural transaction provenance required");
    if (!legacy) assert(same(candidate.transactionHash, SAMPLE.tx), "sample must be naturally discovered in this single-block Ready");
    const loopback = "http://127.0.0.1:8593";
    const wiring = createRebuildWiring({ rpcUrl: loopback, familyIds: [FAMILY],
      executionIdentity: { executor: EXECUTOR, transactionOrigin: OWNER } });
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d = instance.descriptor as Descriptor;
    assert.equal(d.instanceKey, key(SAMPLE));
    assert(same(d.set, SAMPLE.set) && same(d.module, SAMPLE.module) && same(d.controller, SAMPLE.controller));
    assert.equal(d.components.length, legacy ? legacy.components.length : 4, "whole historical basket required");
    if (legacy) { assert.equal(d.legacy?.kind, legacy.kind); assert(same(d.legacy!.vault, legacy.vault)); }
    else assert.equal(d.legacy, undefined);
    if (args.issue) assert(d.legacy?.issuance && d.components.length === 1, "unary issuance must be admitted");
    const inputToken = args.issue ? d.components[0] : d.set;
    const outputTokens = args.issue ? [d.set] : [...d.components];
    const tokens = [inputToken, ...outputTokens].map(lower);
    const dependencies = [...new Set([...tokens, d.module, d.controller,
      ...(d.legacy ? [d.legacy.vault, d.legacy.factory, ...CORE_LIBRARIES.map(l => l.address),
        ...(d.legacy.issuance ? [d.legacy.issuance.transferProxy] : [])] : [])].map(lower))];
    assert.equal(new Set(tokens).size, tokens.length);
    assert(!dependencies.some(t => same(t, OWNER) || same(t, EXECUTOR)), "actor aliases protocol dependency");
    const allEdges = graph.filter(e => e.instanceKey === instance.instanceKey);
    assert.equal(allEdges.length, instance.routes.length);
    const edges = allEdges.filter(e => same(e.tokenIn, inputToken));
    assert.equal(edges.length, outputTokens.length);
    report.pricingChecks = [];
    const rows = edges.map(edge => {
      assert(same(edge.target, d.module), "Set execution target is module, not instanceKey");
      const id = blockScanEdgeKey(edge), row = saved.runtime.pricing.effectiveMids.rows.get(id);
      assert(saved.runtime.graph.edges.some((e: any) => blockScanEdgeKey(e) === id), "price graph lacks Ready edge");
      const raw = saved.runtime.pricing.mids.get(id);
      report.pricingChecks.push({ edgeId: id, rawMid: raw ?? null, effective: row ?? null });
      assert(raw && Number.isFinite(raw.mid) && raw.mid > 0, "production raw mid missing");
      if (!legacy) {
        assert(row?.status === "quoted" && row.edgeId === id, "production P must be actually quoted; no amount shrinking");
        assert(same(row.tokenIn, d.set) && same(row.tokenOut, edge.tokenOut));
        assert(typeof row.amountIn === "bigint" && row.amountIn > 0n && row.amountIn < MAX);
        assert(typeof row.amountOut === "bigint" && row.amountOut > 0n);
        sameBlock(row.quotedAt.number, row.quotedAt.hash); assert.equal(row.quotedAt.generation, saved.runtime.generation);
      }
      const routes = instance.routes.filter(r => same(r.tokenIn, edge.tokenIn) && same(r.tokenOut, edge.tokenOut));
      assert.equal(routes.length, 1);
      const handles = instance.routeHandles.filter(h => h.routeKey === routes[0].routeKey); assert.equal(handles.length, 1);
      return { row, raw, edgeId: id, tokenOut: edge.tokenOut, route: handles[0] };
    });
    assert.deepEqual(rows.map(r => lower(r.tokenOut)).sort(), outputTokens.map(lower).sort());
    if (legacy) report.productionReferenceAcceptance = { status: "not-verified",
      reason: "isolated graph lacks valuation; legal unit/multi-unit trials below do not replace actual production P" };
    report.inputs = { source, graphHash: ready.graphHash, priceGeneration: saved.runtime.generation,
      memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, validity: memo.validity,
      candidate, descriptor: d, edges: rows.map(r => ({ routeKey: r.route.routeKey, rawMid: r.raw, effective: r.row })),
      priceImplementation: provenance.implementation, environment: header };
    report.expectedSamples = rows.length * 2;
    const botvm = currentBotVm(); report.runtimeCodeHash = botvm.keccak256;
    if (provenance.counterfactualExecutorCode != null) {
      assert.equal(provenance.counterfactualExecutorCode.keccak256, botvm.keccak256);
      assert(same(provenance.counterfactualExecutorCode.address, EXECUTOR));
    }
    const privateConfig = JSON.parse(readFileSync(args.rpcFile, "utf8"));
    assert(typeof privateConfig.MAINNET_RPC_URL === "string", "rpc-file requires MAINNET_RPC_URL");
    secret = privateConfig.MAINNET_RPC_URL;
    assert(["http:", "https:"].includes(new URL(secret).protocol), "HTTP archive RPC required");
    const allowed = new Set(["web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt",
      "eth_call", "eth_getCode", "eth_getStorageAt", "eth_createAccessList", "debug_traceCall"]);
    const rpc: Rpc = async (method, params) => {
      if (constructing) { constructionRpcAttempts++; throw new Error("RPC during runtime construction"); }
      if (method === "anvil_setCoinbase") {
        assert(backend, "environment pin requires this test's owned fork");
        assert.deepEqual(params, [header.miner], "only canonical N coinbase may be restored");
      } else assert(allowed.has(method), "non-read-only RPC blocked");
      abort.signal.throwIfAborted(); assert(Date.now() < deadline && ++calls <= 1600, "test read budget exceeded");
      const response = await fetch(loopback, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      assert(response.ok, method + ": loopback HTTP " + response.status);
      const body = await response.json() as any;
      if (body.error) throw new Error(method + ": " + body.error.code + " " + redact(body.error.message));
      assert(Object.hasOwn(body, "result"), "RPC result missing"); return body.result;
    };
    const headerCheck = async () => {
      const h = await rpc("eth_getBlockByNumber", ["latest", false]);
      for (const field of ["number", "hash", "parentHash", "stateRoot", "timestamp", "baseFeePerGas", "gasLimit", "miner", "mixHash", "excessBlobGas"]) {
        assert.equal(typeof h[field], typeof header[field], "N header " + field + " unavailable");
        assert.equal(String(h[field]).toLowerCase(), String(header[field]).toLowerCase(), "N environment " + field + " changed");
      }
      return h;
    };
    const call = (to: string, data: string, overrides: Overrides = {}) =>
      rpc("eth_call", [{ to, data, from: OWNER }, pin, overrides]);
    const balance = async (token: string, holder: string, overrides: Overrides = {}) =>
      BigInt(await call(token, ERC20.encodeFunctionData("balanceOf", [holder]), overrides));
    // Shared production cache retains its normal local-state/model semantics.
    // No requireChainAmountQuote, bespoke formula or per-amount RPC requirement.
    const cache = createAdapterFamilyExactQuoteCache(); cache.advanceState(source);
    const queryReads: any[] = [];
    const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: OWNER, exactQuoteCache: cache,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
      provider: {
        async call(tx, block) { assert.equal(block, source.number); assert(dependencies.includes(lower(tx.to)));
          queryReads.push({ kind: "call", to: tx.to, selector: tx.data.slice(0, 10) }); return rpc("eth_call", [tx, pin]); },
        async getCode(a, block) { assert.equal(block, source.number); assert(dependencies.includes(lower(a)));
          queryReads.push({ kind: "code", to: a }); return rpc("eth_getCode", [a, pin]); },
        async getStorage(a, k, block) { assert.equal(block, source.number); assert(dependencies.includes(lower(a)));
          queryReads.push({ kind: "storage", to: a, key: k }); return rpc("eth_getStorageAt", [a, k, pin]); },
      } });
    const exact = async (route: typeof rows[number]["route"], amountIn: bigint) => {
      if (constructing) { constructionExactAttempts++; throw new Error("Exact during runtime construction"); }
      exactCalls++;
      return executeFamilyExactQuote({ family, route, amountIn, source, generation: source.generation,
        executor: EXECUTOR, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs: deadline } });
    };
    // Construct ALL runtime legs before the first Exact or even starting the fork.
    // Construction can access only caller authority and the generation fence.
    stage = "runtime-construction";
    const guardedRuntime = new Proxy(runtime, { get(target, property, receiver) {
      if (constructing && !["callerAuthority", "generationFence"].includes(String(property))) {
        constructionExactAttempts++; throw new Error("runtime construction accessed quote/RPC service");
      }
      return Reflect.get(target, property, receiver);
    } });
    const legs = rows.map(({ route }) => {
      const input = { family, route, source, runtime: guardedRuntime, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog };
      for (const field of ["amountIn", "quotedAmountOut", "minAmountOut", "exact", "exactEvidence"])
        Object.defineProperty(input, field, { get() { constructionAmountAttempts++; throw new Error("runtime construction accessed " + field); } });
      constructing = true;
      try { const leg = buildFamilyRuntimeAmountLeg(input); assert(leg, "runtime declined; quoted fallback is not a pass"); return leg; }
      finally { constructing = false; }
    });
    assert.equal(exactCalls, 0); assert.equal(calls, 0);
    assert.equal(constructionRpcAttempts + constructionExactAttempts + constructionAmountAttempts, 0);
    report.runtimeConstruction = { directions: legs.length, exactCalls, rpcCalls: calls,
      programHashes: legs.map(l => ethers.keccak256(l.program)), quotedFallback: false };
    stage = "owned-fork-start";
    backend = new AnvilStateBackend(secret, loopback, 8593);
    await backend.forkAt(source.number, { signal: abort.signal, deadlineAtMs: deadline });
    report.client = await rpc("web3_clientVersion", []); assert(/anvil/i.test(report.client));
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    report.headerBefore = await headerCheck();
    checkFork = async () => {
      report.headerAfter = await headerCheck();
      for (const token of tokens) assert.equal(await balance(token, EXECUTOR), 0n, "ephemeral balance override persisted");
      assert.equal(await rpc("eth_getCode", [EXECUTOR, pin]), "0x", "ephemeral code override persisted");
    };
    for (const actor of [OWNER, EXECUTOR]) assert.equal(await rpc("eth_getCode", [actor, pin]), "0x", "actor has source code");
    // NUMBER,TIMESTAMP,BASEFEE,COINBASE,GASLIMIT,PREVRANDAO,CHAINID at the
    // same block-hash context used by debug_traceCall; actor code override only.
    stage = "N-environment-probe";
    const envCode = "0x43600052426020524860405241606052456080524460a0524660c05260e06000f3";
    const readEnvironment = async () => [...ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"),
      await call(EXECUTOR, "0x", { [EXECUTOR]: { code: envCode } }))] as bigint[];
    const expectedEnvironment = [BigInt(header.number), BigInt(header.timestamp), BigInt(header.baseFeePerGas),
      BigInt(header.miner), BigInt(header.gasLimit), BigInt(header.mixHash), 1n];
    report.environmentBefore = await readEnvironment();
    assert.deepEqual(report.environmentBefore.filter((_v: bigint, n: number) => n !== 3),
      expectedEnvironment.filter((_v, n) => n !== 3));
    // Anvil's fork header preserves N.miner but its EVM may use the local
    // coinbase default. Restore that environment field to N; no mining or
    // protocol/account storage changes. The subsequent opcode probe is decisive.
    if (report.environmentBefore[3] !== expectedEnvironment[3]) {
      report.environmentAdjustment = { field: "coinbase", before: word(report.environmentBefore[3]), after: header.miner,
        scope: "canonical N environment on this test's owned fork only" };
      await rpc("anvil_setCoinbase", [header.miner]);
    }
    report.observedEnvironment = await readEnvironment();
    assert.deepEqual(report.observedEnvironment, expectedEnvironment);
    stage = "historical-receipt";
    const originalReceipt = await rpc("eth_getTransactionReceipt", [SAMPLE.tx]);
    report.originalTransaction = legacy ? legacyHistoricalReceipt(originalReceipt, legacy, d.components) : historicalReceipt(originalReceipt, d.components);
    stage = "actor-balance-mapping";
    const slots = new Map<string, string>(); report.balanceMappings = [];
    for (const token of tokens) {
      assert.equal(await balance(token, EXECUTOR), 0n, "actor already has source inventory");
      const holder = same(token, d.set) ? report.originalTransaction.redeemer : (d.legacy?.vault ?? d.set);
      const holderBalance = await balance(token, holder);
      const index = await resolveErc20BalanceSlot(token, holder, { balanceOf: balance,
        getStorage: async (t, slot) => BigInt(await rpc("eth_getStorageAt", [t, slot, pin])) });
      const candidates: string[] = [];
      if (index !== null) candidates.push(balanceStorageKey(EXECUTOR, index).toLowerCase());
      else {
        const access = await rpc("eth_createAccessList", [{ from: OWNER, to: token,
          data: ERC20.encodeFunctionData("balanceOf", [EXECUTOR]), gas: "0x100000" }, ethers.toQuantity(source.number)]);
        assert(!access.error && Array.isArray(access.accessList));
        candidates.push(...access.accessList.filter((a: any) => same(a.address, token))
          .flatMap((a: any) => a.storageKeys.map((s: string) => word(s))));
      }
      assert(candidates.length > 0 && candidates.length <= 16, "bounded actual getter read slots required");
      let slot = "";
      for (const candidate of new Set(candidates)) {
        let matches = true;
        for (const probe of [717171717171n, 919191919193n]) {
          const state = { [token]: { stateDiff: { [candidate]: word(probe) } } };
          try { if (await balance(token, EXECUTOR, state) !== probe || await balance(token, holder, state) !== holderBalance) matches = false; }
          catch { matches = false; }
          if (!matches) break;
        }
        if (matches) { assert.equal(slot, "", "ambiguous actor balance slot"); slot = candidate; }
      }
      assert(slot, "actor-only balance mapping not proven");
      slots.set(token, slot); report.balanceMappings.push({ token, holder, holderBalance, slotIndex: index, actorStorageKey: slot, probes: 2 });
    }
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => {
      const adapter = adapters.find(a => a.id === node.adapterId); assert(adapter, "missing production action encoder");
      return adapter.encode(node, EXECUTOR, concatBytes(...node.children.map(compile)));
    };
    for (const [direction, { row, route, edgeId, tokenOut }] of rows.entries()) {
      // If P equals the historical amount, halve the latter for a second
      // distinct trial. Never shrink or replace the actual production P.
      const second = row?.amountIn === SAMPLE.amountIn ? SAMPLE.amountIn / 2n : SAMPLE.amountIn;
      const unit = args.issue ? BigInt(LEGACY_SET.decodeFunctionResult("getUnits", await call(d.set, LEGACY_SET.encodeFunctionData("getUnits")))[0][0]) : 0n;
      const amounts: readonly (readonly [string, bigint])[] = legacy
        ? [["legal-unit-N-not-production-P", args.issue ? unit : legacy.amounts[0]], ["legal-multi-unit-N-not-production-P", args.issue ? unit * 1000n : legacy.amounts[1]]]
        : [["production-P", row!.amountIn], ["historical-amount-at-N", second]];
      for (const [label, amountIn] of amounts) {
        const sample: Record<string, any> = { routeKey: route.routeKey, edgeId, label, amountIn,
          productionP: row?.amountIn ?? null, selectedComponent: tokenOut, status: "failed", executions: [] };
        report.samples.push(sample);
        try {
          stage = "production-exact";
          const before = queryReads.length, cacheBefore = cache.snapshot();
          // Evidence is sealed: request every basket projection through production
          // Exact; never inspect private evidence or duplicate unit math.
          const quotes = [];
          for (const component of outputTokens) {
            const r = rows.find(v => same(v.tokenOut, component))!;
            const quote = await exact(r.route, amountIn);
            assert.equal(quote.status, "resolved", "production Exact unresolved");
            if (quote.status !== "resolved") throw new Error("production Exact unresolved");
            assert.equal(quote.amountIn, amountIn); assert.deepEqual(quote.source, source); assert(quote.amountOut > 0n);
            quotes.push(quote);
          }
          const outputs = quotes.map(q => q.amountOut), quote = quotes[outputTokens.findIndex(t => same(t, tokenOut))];
          sample.quote = { model: "Family local state model", outputs, selectedAmountOut: quote.amountOut,
            reads: queryReads.slice(before), cacheBefore, cacheAfter: cache.snapshot(), evidenceRefs: quotes.map(q => q.evidenceRefs) };
          if (label === "production-P") assert.equal(quote.amountOut, row!.amountOut, "P quote differs from production price");
          sample.originalTxComparison = args.issue ? { preCallParity: "unverified; original redemption receipt is provenance, not an issuance comparison" } : { originalAmountIn: SAMPLE.amountIn, originalOutputs: SAMPLE.outputs,
            sameAmount: amountIn === SAMPLE.amountIn, signedDeltas: amountIn === SAMPLE.amountIn ? outputs.map((v, n) => v - SAMPLE.outputs[n]) : null,
            preCallParity: "unverified; source is N end-state" };
          const fragment = buildFamilyExecutionFragment({ family, route, exact: quote, minAmountOut: quote.amountOut,
            executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog });
          assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("fragment unresolved");
          sample.requirements = fragment.fragment.requirements;
          const scripts: [string, Uint8Array][] = [
            ["old-fragment", concatBytes(...planFragmentNodes(fragment.fragment, inputToken, amountIn).map(compile))],
            ["runtime-program", runtimeProgramScript(ethers.getBytes(legs[direction].program), amountIn)],
          ];
          // Large old inventory exposes underpayment even where an absolute
          // assert-balance would accept it. It never supplies a next-hop amount.
          const inventory = [101n, ...outputs.map((v, n) => v + 103n + BigInt(n))];
          assert(amountIn + inventory[0] <= MAX && inventory.slice(1).every((v, n) => v + outputs[n] <= MAX));
          const overrides: Overrides = { [OWNER]: { balance: ethers.toQuantity(100n * 10n ** 18n) }, [EXECUTOR]: { code: botvm.code } };
          tokens.forEach((token, n) => { overrides[token] = { stateDiff: { [slots.get(token)!]: word(inventory[n] + (n === 0 ? amountIn : 0n)) } }; });
          sample.actorInventory = inventory; sample.overrideSha256 = sha(json(overrides));
          for (const [encoding, script] of scripts) {
            const result: Record<string, any> = { encoding, status: "failed", scriptHash: ethers.keccak256(script) };
            sample.executions.push(result);
            try {
              stage = encoding;
              const initial = await Promise.all(tokens.map(t => balance(t, EXECUTOR, overrides)));
              assert.deepEqual(initial, inventory.map((v, n) => v + (n === 0 ? amountIn : 0n)));
              const tx = { from: OWNER, to: EXECUTOR, data: buildExecuteCalldata(script), gas: "0x800000",
                gasPrice: ethers.toQuantity(header.baseFeePerGas) };
              result.callTrace = await rpc("debug_traceCall", [tx, pin, { tracer: "callTracer", timeout: "30s", stateOverrides: overrides }]);
              assert(!result.callTrace.error, "encoded BotVM execution reverted");
              result.stateDiff = await rpc("debug_traceCall", [tx, pin,
                { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides: overrides }]);
              const measured = tokens.map((t, n) => observeBalance(result.stateDiff, t, slots.get(t)!, initial[n]));
              result.balances = tokens.map((token, n) => ({ token, ...measured[n] }));
              result.quoteDeltas = measured.slice(1).map((v, n) => v.delta - outputs[n]);
              // Getter cross-check overlays ONLY actor balance slots from the
              // independent trace. Protocol poststate is never overridden.
              const observedPost: Overrides = {};
              tokens.forEach((token, n) => { observedPost[token] = { stateDiff: { [slots.get(token)!]: word(measured[n].after) } }; });
              for (const [n, token] of tokens.entries()) assert.equal(await balance(token, EXECUTOR, observedPost), measured[n].after);
              assertBasket(measured[0], measured.slice(1), amountIn, outputs, inventory.slice(1), outputTokens.length);
              assert.equal(measured[0].after, inventory[0]);
              const noInput = structuredClone(overrides);
              noInput[inputToken].stateDiff![slots.get(inputToken)!] = word(0n);
              const rejected = await rpc("debug_traceCall", [tx, pin, { tracer: "callTracer", timeout: "30s", stateOverrides: noInput }]);
              assertExecutionRevert(rejected);
              result.missingInputControl = { error: rejected.error, reverted: true };
              result.oldInventoryConsumed = tokens.map(() => 0n); result.status = "pass";
            } catch (e) { result.error = failure(e); }
          }
          assert.equal(sample.executions.length, 2);
          assert(sample.executions.every((e: any) => e.status === "pass"), "one or both encoders failed; evidence retained");
          assert.deepEqual(sample.executions[0].balances, sample.executions[1].balances, "old/runtime basket differs");
          sample.status = "pass";
        } catch (e) { sample.error = failure(e); }
        abort.signal.throwIfAborted();
      }
    }
    if (legacy && !args.issue) {
      stage = "legacy-invalid-amount-controls"; report.invalidAmountControls = [];
      const naturalUnit = BigInt(await call(d.set, LEGACY_SET.encodeFunctionData("naturalUnit")));
      const supply = BigInt(await call(d.set, LEGACY_SET.encodeFunctionData("totalSupply")));
      for (const [label, amountIn] of [["non-natural-multiple", legacy.naturalUnit + 1n], ["original-amount-exceeds-N-capacity", legacy.amountIn]] as const) {
        const control: Record<string, any> = { label, amountIn, naturalUnit, supply, results: [], status: "failed" };
        report.invalidAmountControls.push(control);
        const quote = await exact(rows[0].route, amountIn);
        control.quote = quote;
        assert.notEqual(quote.status, "resolved", "invalid N amount unexpectedly quoted");
        if (quote.status === "resolved") throw new Error("invalid N amount unexpectedly quoted");
        assert.deepEqual(quote.outcome.source, source);
        const overrides: Overrides = { [OWNER]: { balance: ethers.toQuantity(100n * 10n ** 18n) },
          [EXECUTOR]: { code: botvm.code, balance: ethers.toQuantity(100n * 10n ** 18n) } };
        tokens.forEach((token, n) => { overrides[token] = { stateDiff: { [slots.get(token)!]: word(n === 0 ? amountIn : 10n ** 24n) } }; });
        for (const [mode, from, to, data] of [
          ["protocol-native", EXECUTOR, d.module, CORE.encodeFunctionData("redeemAndWithdrawTo", [d.set, EXECUTOR, amountIn, 0n])],
          ["runtime-program", OWNER, EXECUTOR, buildExecuteCalldata(runtimeProgramScript(ethers.getBytes(legs[0].program), amountIn))],
        ]) {
          const trace = await rpc("debug_traceCall", [{ from, to, data, gas: "0x800000", gasPrice: ethers.toQuantity(header.baseFeePerGas) }, pin,
            { tracer: "callTracer", timeout: "30s", stateOverrides: overrides }]);
          control.results.push({ mode, trace });
        }
        assertLegacyInvalidAmountEvidence({ sample: legacy, executor: EXECUTOR, label, amountIn, naturalUnit, supply,
          quote, results: control.results });
        control.status = "pass";
      }
    }
    if (args.issue) {
      stage = "legacy-issuance-quantization-control";
      const unit = BigInt(LEGACY_SET.decodeFunctionResult("getUnits", await call(d.set, LEGACY_SET.encodeFunctionData("getUnits")))[0][0]);
      assert(unit > 1n, "sample must have a nontrivial component unit");
      const amountIn = unit + 1n, quote = await exact(rows[0].route, amountIn);
      report.invalidAmountControls = [{ label: "non-component-multiple", amountIn, unit, quote, status: "failed" }];
      assert.equal(quote.status, "failed");
      if (quote.status !== "failed") throw Error("non-component multiple unexpectedly quoted");
      assert.equal(quote.outcome.reasonCode, "exact-decode:set-legacy input must be an exact component-unit multiple");
      const overrides: Overrides = { [OWNER]: { balance: ethers.toQuantity(100n * 10n ** 18n) }, [EXECUTOR]: { code: botvm.code },
        [inputToken]: { stateDiff: { [slots.get(inputToken)!]: word(amountIn) } } };
      const trace = await rpc("debug_traceCall", [{ from: OWNER, to: EXECUTOR,
        data: buildExecuteCalldata(runtimeProgramScript(ethers.getBytes(legs[0].program), amountIn)), gas: "0x800000",
        gasPrice: ethers.toQuantity(header.baseFeePerGas) }, pin, { tracer: "callTracer", timeout: "30s", stateOverrides: overrides }]);
      report.invalidAmountControls[0].trace = trace;
      assertExecutionRevert(trace);
      assert.equal(trace.output.slice(0, 10), "0x08c379a0");
      assert.equal(ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + trace.output.slice(10))[0], "runtime amount mismatch");
      report.invalidAmountControls[0].status = "pass";
    }
    report.exactCache = cache.snapshot();
    assert(report.samples.length === report.expectedSamples && report.samples.every((s: any) => s.status === "pass"),
      "one or more direction/amount cases failed");
    report.result = "pass";
  } catch (e) { report.errors.push(failure(e)); }
  finally {
    stage = "final-pins";
    try { await checkFork?.(); } catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    try { checkPins?.(); } catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    stage = "owned-fork-cleanup";
    try { if (backend) await backend.stopAndWait(); report.forkStopped = !!backend; }
    catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    finally { backend?.provider.destroy(); }
    clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    report.rpcCalls = calls; report.exactCalls = exactCalls;
    report.runtimeConstructionAttempts = { rpc: constructionRpcAttempts, exact: constructionExactAttempts, amount: constructionAmountAttempts };
    const output = json(report).split(secret || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/gi, "[REDACTED_URL]") + "\n";
    try { writeFileSync(fd, output); fsyncSync(fd); } finally { closeSync(fd); }
  }
  console.log(json({ result: report.result, samples: report.samples.length,
    executionsPassed: report.samples.flatMap((s: any) => s.executions).filter((e: any) => e.status === "pass").length, out: args.out }));
  if (report.result !== "pass") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) console.log("--ready FILE --prices FILE (with sibling input.json) --rpc-file FILE --out NEW_IGNORED_JSON --port 8593 [--sample basic|legacy-base|legacy-rebalancing] [--direction redeem|issue]; legacy trials do not claim production P acceptance");
  else main().catch(() => { console.error("Set historical test: input/output reservation failed; existing receipts were not overwritten"); process.exitCode = 1; });
}
