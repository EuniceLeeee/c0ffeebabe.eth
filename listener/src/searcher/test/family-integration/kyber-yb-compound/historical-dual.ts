// Opt-in, fixed-sample Family acceptance. Never imported as an automatic test.
// MAINNET_RPC_URL is injected by the operator; no env/key files are opened.
// --family SAMPLE_KEY (see SAMPLES) --ready FILE --prices FILE --port FREE_PORT --out NEW_FILE
// Optional --reference-prices FILE --reference-edges JSON_ARRAY borrows input only.
// Optional --expected-executor-code-hash BYTES32 explicitly tests current source-verified
// BotVM at the configured historical actor, using local per-call code overlays only.
// Requires the Family's existing activation env flag; never changes defaults.
// N-end + N environment single-leg evidence, NOT original-precall/EV/performance.
import assert from "node:assert/strict";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import "../../../../shared/adapters/index.js";
import { compilePlan } from "../../../../shared/compiler/compiler.js";
import { AnvilStateBackend } from "../../../../shared/state/state-backend.js";
import { buildExecuteCalldata, loadBotVmRuntimeCode } from "../../../../shared/executor/botvm-executor.js";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../encoder.js";
import { atBlockJson, parseAtBlockJson } from "../../../blockscan-at-block-cli.js";
import { createAdapterFamilyExactQuoteCache } from "../../../adapter-family-exact-quote-cache.js";
import { createRevmStrictSourceSimulation } from "../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../revm-sim-client.js";
import { createStrictCentralAdapterRuntime } from "../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../universe-rebuild-production.js";
import { planFragmentNodes } from "../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, executeFamilyExactQuote, buildFamilyExecutionFragment,
  buildFamilyRuntimeAmountLeg, type PreparedFamilyInstance } from "../../../venues/adapter-family-runtime.js";
import { asPricedFamily } from "../../../venues/family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../venues/production-family-composition.js";
import { blockScanEdgeKey } from "../../../venues/blockscan-state-capability.js";
import { EKUBO_CORE } from "../../../venues/swaps/ekubo/abi.js";
import { assertHistoricalDiscoveryReceipt } from "../three-family/historical-input-observations.js";
import { SAMPLES, ERC20, options, same, json, sha, word, observeBalance, assertDeltas, originalLegs, originalDirections, historicalAmountTrials,
  assertReceipt, assertHeader, assertPriceInput, productionAmount, splicedMissingProductionAmount, constructionGuard, assertOriginAccountCode, matchesBalanceSlotProbe, isLocalBalanceProbeRevert, assertNativeInventory, assertExecutorCode } from "./evidence.js";

import { loadV4FundingFixture, acceptV4NativeSettlement } from "./v4-native-settlement.js";

const ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
type Overrides = Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string> }>;
const GAS = "0x1000000";

/** Same production-tree fingerprint algorithm used by at-block input.json. */
export function sourcePin() {
  const files: [string, string][] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(resolve(ROOT, "listener/src", path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "test" || entry.name === "templates") continue;
      const p = path ? path + "/" + entry.name : entry.name;
      if (entry.isDirectory()) visit(p);
      else { assert(entry.isFile(), "source symlink unsupported"); files.push([p, sha(readFileSync(resolve(ROOT, "listener/src", p)))]); }
    }
  };
  visit("");
  return { sourceTreeSha256: sha(JSON.stringify(files)),
    harnessSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    evidenceSha256: sha(readFileSync(new URL("./evidence.ts", import.meta.url))),
    observationHelpers: ["./v4-native-settlement.ts", "../three-family/historical-input-observations.ts",
      "../../../venues/swaps/ekubo-family/test/history-evidence.ts",
      "../../../venues/swaps/univ4-family/test/history-evidence.ts",
      "../../../venues/protocols/token-conversion-family/test/history-evidence.ts",
      "../../../venues/protocols/erc4626-family/test/history-evidence.ts",
      "../../../venues/protocols/set-redemption-family/test/historical-runtime-observations.ts",
      "../../../venues/protocols/ethertoken-native-redeem-family/test/history-evidence.ts",
      "../../../venues/protocols/self-burn-native-family/test/history-evidence.ts",
      "../../../venues/protocols/compound-ctoken-family/test/history-evidence.ts"]
      .map(path => ({ path, sha256: sha(readFileSync(new URL(path, import.meta.url))) })) };
}

function botvm(owner: string) {
  const file = resolve(ROOT, "out/BotVM.sol/BotVM.json"), bytes = readFileSync(file), artifact = JSON.parse(bytes.toString());
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata?.settings?.compilationTarget?.["src/BotVM.sol"], "BotVM");
  const sources = Object.entries(metadata.sources) as [string, { keccak256: string }][];
  assert(sources.length > 0);
  for (const [name, entry] of sources) {
    const p = realpathSync(resolve(ROOT, name));
    assert(name.endsWith(".sol") && !relative(realpathSync(ROOT), p).startsWith(".."), "artifact source escapes repository");
    assert.equal(ethers.keccak256(readFileSync(p)), entry.keccak256, "stale BotVM artifact: " + name);
  }
  const refs = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
  assert.equal(refs.length, 1); assert(refs[0]!.length > 0 && refs[0]!.every(r => r.length === 32));
  return { ...loadBotVmRuntimeCode(owner), artifactSha256: sha(bytes) };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = options(argv), sample = SAMPLES[args.family];
  // Exclusive creation happens before work, preserving every previous failure.
  const fd = openSync(resolve(args.out), "wx", 0o600), started = performance.now();
  const report: any = { schema: "four-family-same-n-dual/v2", result: "failed", family: sample.family,
    claim: "fixed real instances, both swap directions and original protocol directions, N-end/N environment, independent single-leg quote/quoted/runtime receipts only",
    originalPreCallParity: "NOT RUN", representativePerformance: "NOT RUN", samples: [], errors: [],
    safety: { signing: false, broadcast: false, minedBlocks: 0, protocolOverrides: false,
      mainExecutionFunding: "actor input only; existing input/output inventory preserved",
      inventoryControl: "separate actor-only output inventory; never counted as received output" } };
  const abort = new AbortController(), deadline = Date.now() + 480_000;
  const timer = setTimeout(() => abort.abort(new Error("diagnostic deadline")), 480_000);
  const interrupt = () => abort.abort(new Error("interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let secret = "", stage = "inputs", calls = 0, backend: AnvilStateBackend | undefined;
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined;
  let finalChecks: (() => Promise<void>) | undefined;
  const guard = constructionGuard();
  const redact = (v: unknown) => String(v instanceof Error ? v.message : v).split(secret || "\0").join("[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]");
  const failure = (e: unknown) => ({ stage, message: redact(e) });
  try {
    const codePin = sourcePin(); report.code = codePin;
    const v4Fixture = args.v4SettlementArtifact ? loadV4FundingFixture(ROOT, args.v4SettlementArtifact) : undefined;
    if (v4Fixture) report.v4FundingFixture = { ...v4Fixture, code: undefined };
    const readyPath = realpathSync(args.ready), pricesPath = realpathSync(args.prices);
    const inputPath = realpathSync(resolve(dirname(pricesPath), "input.json"));
    const referencePath = args.referencePrices ? realpathSync(args.referencePrices) : undefined;
    const declarationPath = referencePath ? realpathSync(resolve(dirname(referencePath), "declaration.json")) : undefined;
    const donorInput = args.inputOnlyReference ? parseAtBlockJson(readFileSync(inputPath, "utf8")) : undefined;
    const donorReadyPath = donorInput ? realpathSync(donorInput.readyPath) : undefined;
    const inputHashes = () => [readyPath, pricesPath, inputPath, ...(donorReadyPath ? [donorReadyPath] : []), ...(referencePath ? [referencePath, declarationPath!] : []), ...(args.targetHeader ? [realpathSync(args.targetHeader)] : []), ...(args.revmBin ? [realpathSync(args.revmBin)] : [])]
      .map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputHashes = inputHashes();
    const reference = referencePath ? { saved: parseAtBlockJson(readFileSync(referencePath, "utf8")),
      declaration: parseAtBlockJson(readFileSync(declarationPath!, "utf8")) } : undefined;
    if (reference) report.referenceInputSource = { prices: referencePath, declaration: declarationPath,
      sourceCommit: reference.declaration.head, cfg: JSON.parse(atBlockJson(reference.saved.cfg)), readySha256: reference.saved.readySha256,
      graphEdges: reference.saved.runtime.graph.edges.length, inputOnly: true, actualLiveEvidence: false,
      reference: reference.saved.runtime.pricing.effectiveMids.reference,
      referenceWethInput: reference.saved.runtime.pricing.effectiveMids.referenceWethInput };
    const saved = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(inputPath, "utf8"));
    if (!args.inputOnlyReference) {
      assert.equal(realpathSync(provenance.readyPath), readyPath); assert.equal(realpathSync(saved.readyPath), readyPath);
    } else assert.equal(realpathSync(saved.readyPath), donorReadyPath);
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope);
    const memos = activeReadyMemos(envelope), { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration);
    if (args.inputOnlyReference) {
      const donor = await new UniverseRebuildCheckpointStore({ path: donorReadyPath! }).load();
      assert(donor?.readyGeneration && !donor.inProgressRun, "complete input donor Ready required");
      const donorHash = sha(readFileSync(donorReadyPath!));
      assert(/^[a-f0-9]{64}$/.test(provenance.implementation?.sourceTreeSha256), "donor source fingerprint required");
      assertPriceInput(saved, provenance, donor.readyGeneration, { readySha256: donorHash,
        sourceTreeSha256: provenance.implementation.sourceTreeSha256, number: args.erc20InputOnly ? donor.readyGeneration.cutoff.number : sample.number });
      assert.equal(ready.cutoff.number, sample.number);
      if (!args.erc20InputOnly) assert.equal(ready.cutoff.hash.toLowerCase(), donor.readyGeneration.cutoff.hash.toLowerCase());
      report.inputOnlyReference = { donorPricesPath: pricesPath, donorReadyPath, donorReadySha256: donorHash,
        donorSourceTreeSha256: provenance.implementation.sourceTreeSha256, targetSourceTreeSha256: codePin.sourceTreeSha256,
        donorState: donor.readyGeneration.cutoff, targetState: ready.cutoff, configuration: JSON.parse(atBlockJson(provenance.cfg)),
        policy: "borrow amountIn only; current Ready identity and current same-state quote/quoted/runtime independently verified; donor output is not used or compared; current natural valuation NOT RUN" };
    } else assertPriceInput(saved, provenance, ready, { readySha256: report.inputHashes[0].sha256,
      sourceTreeSha256: codePin.sourceTreeSha256, number: sample.number });
    const source = ready.cutoff, header = args.targetHeader ? JSON.parse(readFileSync(args.targetHeader, "utf8")) : provenance.sourceHeader;
    assert.equal(Number(BigInt(header.number)), source.number); assert(same(header.hash, source.hash));
    assertHeader(header, header);
    const executor = ethers.getAddress(provenance.executor).toLowerCase(), owner = ethers.getAddress(provenance.owner).toLowerCase();
    assert(executor !== owner && executor !== ethers.ZeroAddress && owner !== ethers.ZeroAddress);
    const runtimeCode = botvm(owner); report.runtimeCode = { keccak256: runtimeCode.keccak256, artifactSha256: runtimeCode.artifactSha256 };
    assert(!graph.some(e => [e.target, e.tokenIn, e.tokenOut].some(a => same(a, executor))), "executor aliases graph protocol/token");
    report.source = source; report.environment = header; report.actors = { executor, owner }; report.graphHash = ready.graphHash;
    const loopback = `http://127.0.0.1:${args.port}`;
    const wiring = createRebuildWiring({ rpcUrl: loopback, familyIds: [sample.family], executionIdentity: { executor, transactionOrigin: owner } });
    const family = asPricedFamily(catalog.forStrictFamily(sample.family as never));
    assert(wiring.isFamilyEnabled?.(sample.family), "enable this Family explicitly using its existing configuration");
    const entries = sample.instances.map(instanceKey => {
      const found = memos.filter(m => m.familyId === sample.family && same(m.instanceKey, instanceKey));
      assert.equal(found.length, 1, "target must already be admitted in sealed Ready");
      const memo = found[0]!;
      assert([familyDefinitionHash(sample.family), familyMemoDefinitionHash(sample.family)].includes(memo.familyDefinitionHash), "selective Ready revalidation required");
      assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "memo projection is stale");
      const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
      return { memo, instance, instanceKey };
    });
    report.admission = entries.map(e => ({ instanceKey: e.instanceKey, memoFingerprint: e.memo.memoFingerprint,
      familyDefinitionHash: e.memo.familyDefinitionHash, candidate: e.memo.candidateSnapshot }));
    const checkFiles = () => { assert.deepEqual(sourcePin(), codePin);
      if (v4Fixture) assert.deepEqual(loadV4FundingFixture(ROOT, args.v4SettlementArtifact!), v4Fixture); assert.deepEqual(inputHashes(), report.inputHashes);
      assert.deepEqual(botvm(owner), runtimeCode, "executor code/source changed during run"); };
    finalChecks = async () => checkFiles();
    secret = process.env.MAINNET_RPC_URL ?? ""; assert(/^https?:\/\//.test(secret), "operator-injected MAINNET_RPC_URL required");
    const allowed = new Set(["web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash",
      "debug_traceTransaction", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_createAccessList", "debug_traceCall"]);
    const rpc = async (method: string, params: unknown[], upstream = false): Promise<any> => {
      guard.check(); abort.signal.throwIfAborted(); const id = ++calls;
      assert(id <= 1800 && Date.now() < deadline, "diagnostic read budget exhausted");
      assert(allowed.has(method) || (method === "anvil_setCoinbase" && backend && !upstream));
      if (upstream) assert(["eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "debug_traceTransaction"].includes(method));
      if (method === "anvil_setCoinbase") assert.deepEqual(params, [header.miner]);
      const res = await fetch(upstream ? secret : loopback, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      assert(res.ok, `RPC HTTP ${res.status}`); const body = await res.json() as any;
      assert(body?.jsonrpc === "2.0" && body.id === id, "RPC response identity mismatch");
      if (body.error) throw Object.assign(new Error(method + ": " + redact(body.error.message)), {
        localCall: !upstream && method === "eth_call", rpcCode: body.error.code, returnData: body.error.data,
      });
      assert(Object.hasOwn(body, "result")); return body.result;
    };
    stage = "canonical-original-evidence";
    assertHeader(await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false], true), header);
    const receipt = await rpc("eth_getTransactionReceipt", [sample.tx], true); assertReceipt(receipt, sample.tx, header);
    const tx = await rpc("eth_getTransactionByHash", [sample.tx], true);
    assert(same(tx.hash, sample.tx) && same(tx.blockHash, source.hash)); assert.equal(BigInt(tx.blockNumber), BigInt(source.number));
    const trace = await rpc("debug_traceTransaction", [sample.tx, { tracer: "callTracer", timeout: "30s",
      ...((args.family === "xwin-mint" || args.family === "xwin-redeem" || args.family === "erc4626-fluid") ? { tracerConfig: { withLog: true } } : {}) }], true);
    assert(trace.type === "CALL" && same(trace.from, tx.from) && same(trace.to, tx.to) && same(trace.input, tx.input));
    report.original = { receipt, transaction: tx, trace, receiptSha256: sha(json(receipt)), traceSha256: sha(json(trace)) };
    stage = "owned-local-fork";
    backend = new AnvilStateBackend(secret, loopback, args.port);
    await backend.forkAt(source.number, { signal: abort.signal, deadlineAtMs: deadline });
    assert(/anvil/i.test(await rpc("web3_clientVersion", []))); assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const pin = { blockHash: source.hash, requireCanonical: true };
    const quoteOverlay: Overrides = args.expectedExecutorCodeHash ? { [executor]: { code: runtimeCode.code } } : {};
    const call = (to: string, data: string, overrides: Overrides = {}) => rpc("eth_call", [{ from: owner, to, data }, pin, { ...quoteOverlay, ...overrides }]);
    const balance = async (token: string, holder: string, overrides: Overrides = {}) => BigInt(await call(token, ERC20.encodeFunctionData("balanceOf", [holder]), overrides));
    const headerCheck = async () => assertHeader(await rpc("eth_getBlockByNumber", ["latest", false]), header);
    await headerCheck();
    const ownerCode = await rpc("eth_getCode", [owner, pin]);
    assertOriginAccountCode(ownerCode);
    report.originAccount = { code: ownerCode, keccak256: ethers.keccak256(ownerCode), overridden: false };
    const executorCode = await rpc("eth_getCode", [executor, pin]);
    report.executorProvisioning = assertExecutorCode(executorCode, runtimeCode.code, args.expectedExecutorCodeHash);
    report.executorProvisioning.admission = "existing historical Ready retained; code overlay is execution-test provisioning, not new identity evidence";
    // Probe EVM opcodes, not only the header returned by the fork.
    const environment = async () => [...ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"), await call(executor, "0x",
      { [executor]: { code: "0x43600052426020524860405241606052456080524460a0524660c05260e06000f3" } }))] as bigint[];
    const expectedEnvironment = [BigInt(header.number), BigInt(header.timestamp), BigInt(header.baseFeePerGas), BigInt(header.miner), BigInt(header.gasLimit), BigInt(header.mixHash), 1n];
    const before = await environment();
    assert.deepEqual(before.filter((_, i) => i !== 3), expectedEnvironment.filter((_, i) => i !== 3));
    if (before[3] !== expectedEnvironment[3]) { await rpc("anvil_setCoinbase", [header.miner]); report.coinbaseRestored = header.miner; }
    assert.deepEqual(await environment(), expectedEnvironment); report.observedEnvironment = expectedEnvironment;
    const baselines = new Map<string, bigint>();
    finalChecks = async () => { checkFiles(); await headerCheck(); assert.deepEqual(await environment(), expectedEnvironment);
      assertHeader(await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false], true), header);
      assert.equal(await rpc("eth_getCode", [executor, pin]), executorCode);
      assert.equal(await rpc("eth_getCode", [owner, pin]), ownerCode, "origin account code changed");
      for (const [token, initial] of baselines) assert.equal(await balance(token, executor), initial, "simulation persisted actor state"); };
    const cache = createAdapterFamilyExactQuoteCache(); cache.advanceState(source);
    const quoteReads: any[] = [];
    if (args.revmBin) {
      const executorRuntimeCode = loadBotVmRuntimeCode(owner); assert.equal(executorRuntimeCode.keccak256, runtimeCode.keccak256);
      simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl: loopback, chainId: 1, stateRoot: header.stateRoot },
        executorRuntimeCode, control: { signal: abort.signal, deadlineAtMs: deadline }, executionGasLimit: Number(BigInt(GAS)),
        createClient: ({ onFatal }) => new RevmSimClient({ executablePath: args.revmBin!, timeoutMs: 90_000, onFatal }),
        onFatal: () => abort.abort(new Error("production strict source/transport fatal")) });
      report.productionEffectQuote = { factory: "createRevmStrictSourceSimulation", source, stateRoot: header.stateRoot,
        executor, transactionOrigin: owner, executorCodeHash: executorRuntimeCode.keccak256, executionGasLimit: Number(BigInt(GAS)),
        budgetScope: "0x1000000 matches current main/rebuild production strict-source factory and this harness execution; not performance evidence" };
    }
    const productionSimulation = simulation?.transport;
    const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner, exactQuoteCache: cache,
      ...(productionSimulation ? { simulator: { ...productionSimulation, async simulate(invocation) {
        guard.check(); const read: any = { kind: "production-revm-effect", request: invocation.request, source: invocation.source,
          callerAuthority: invocation.callerAuthority }; quoteReads.push(read);
        read.result = await productionSimulation.simulate(invocation); return read.result;
      } } } : {}),
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } }, provider: {
        async call(t, b) {
          assert.equal(b, source.number);
          const read: any = { kind: "call", to: t.to, selector: t.data.slice(0, 10), data: t.data, block: b };
          quoteReads.push(read); read.result = await rpc("eth_call", [t, pin, quoteOverlay]); return read.result;
        },
        async getCode(a, b) { assert.equal(b, source.number); quoteReads.push({ kind: "code", to: a });
          return args.expectedExecutorCodeHash && same(a, executor) ? runtimeCode.code : rpc("eth_getCode", [a, pin]); },
        async getStorage(a, k, b) { assert.equal(b, source.number); quoteReads.push({ kind: "storage", to: a, slot: k }); return rpc("eth_getStorageAt", [a, k, pin]); },
      } });
    const slots = new Map<string, string>();
    const slotFor = async (token: string, protectedAccount: string, holder = executor) => {
      const slotKey = token + ":" + holder;
      if (slots.has(slotKey)) return slots.get(slotKey)!;
      assert(![owner, executor].includes(token) && !same(protectedAccount, executor));
      const original = await balance(token, holder), protectedBalance = await balance(token, protectedAccount);
      const supply = await call(token, ERC20.encodeFunctionData("totalSupply")); if (same(holder, executor)) baselines.set(token, original);
      const access = await rpc("eth_createAccessList", [{ from: owner, to: token, data: ERC20.encodeFunctionData("balanceOf", [holder]), gas: "0x100000" }, ethers.toQuantity(source.number)]);
      assert(!access.error && Array.isArray(access.accessList));
      const candidates: string[] = [...new Set<string>(access.accessList.filter((a: any) => same(a.address, token)).flatMap((a: any) => a.storageKeys.map(word)))];
      assert(candidates.length > 0 && candidates.length <= 16, "bounded actor balance-slot proof unavailable");
      const matches: string[] = [];
      for (const key of candidates) {
        let valid = true;
        for (const probe of [717171717171n, 919191919193n]) {
          const o = { [token]: { stateDiff: { [key]: word(probe) } } };
          // Fault-injecting a proxy/control slot may return empty data or revert.
          // Neither is a valid balance slot. Retain that evidence; never absorb
          // transport/unknown errors or a failure of an uninjected baseline.
          let returned: string;
          try { returned = await call(token, ERC20.encodeFunctionData("balanceOf", [holder]), o); }
          catch (error) {
            if (!isLocalBalanceProbeRevert(error)) throw error;
            (report.balanceSlotCandidateChecks ??= []).push({ token, slot: key, probe, matched: false,
              completion: "reverted", returnData: (error as { returnData: string }).returnData });
            valid = false; break;
          }
          const matched = matchesBalanceSlotProbe(returned, probe);
          (report.balanceSlotCandidateChecks ??= []).push({ token, slot: key, probe, returned, matched });
          if (!matched || await balance(token, protectedAccount, o) !== protectedBalance ||
            await call(token, ERC20.encodeFunctionData("totalSupply"), o) !== supply) { valid = false; break; }
        }
        if (valid) matches.push(key);
      }
      assert.equal(matches.length, 1, "actor-only balance slot not uniquely proven");
      (report.balanceSlotProofs ??= []).push({ token, actor: holder, slot: matches[0], originalBalance: original,
        protectedAccount, protectedBalance, totalSupply: BigInt(supply), probes: [717171717171n, 919191919193n] });
      slots.set(slotKey, matches[0]!); return matches[0]!;
    };
    let unmet = false, naturalUnmet = false;
    const usedReferenceEdges = new Set<string>();
    const directions: (ReturnType<typeof originalDirections>[number] & { entry: typeof entries[number] })[] = [];
    for (const entry of entries) {
      const candidate = entry.memo.candidateSnapshot as any;
      assertHistoricalDiscoveryReceipt(await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, source);
      const originals = originalLegs(args.family, entry.instanceKey, entry.instance.descriptor, receipt, trace);
      const includeReverse = sample.family === "kyberswap-elastic" || sample.family === "swap:algebra-integral" || sample.family === "custom-swap:ekubo-router-v1" || sample.family === "protocol:erc4626" || sample.family === "univ4" || sample.family === "univ4-fee-hook";
      if (includeReverse) {
        assert.equal(entry.instance.routes.length, 2, "fixed swap instance must project both directions");
      }
      directions.push(...originalDirections(originals, includeReverse).map(d => ({ ...d, entry })));
    }
    for (const { entry, originals, tokenIn, tokenOut } of directions) {
      const routes = entry.instance.routes.filter(r => same(r.tokenIn, tokenIn) && same(r.tokenOut, tokenOut)); assert.equal(routes.length, 1);
      const route = entry.instance.routeHandles.filter(r => r.routeKey === routes[0]!.routeKey); assert.equal(route.length, 1);
      const edges = graph.filter(e => e.instanceKey === entry.instance.instanceKey && same(e.tokenIn, tokenIn) && same(e.tokenOut, tokenOut)); assert.equal(edges.length, 1);
      const edgeId = blockScanEdgeKey(edges[0]!);
      if (!args.erc20InputOnly) assert(saved.runtime.graph.edges.some((e: any) => blockScanEdgeKey(e) === edgeId), "saved production graph lacks target direction");
      assert(saved.runtime.pricing.effectiveMids?.rows instanceof Map && saved.runtime.pricing.mids instanceof Map);
      // New ERC20 acceptance borrows only input from a deterministically selected
      // saved production row for the same token. No target identity/output is borrowed.
      const donorEdge = args.erc20InputOnly ? saved.runtime.graph.edges
        .filter((e: any) => same(e.tokenIn, tokenIn) && saved.runtime.pricing.effectiveMids.rows.get(blockScanEdgeKey(e))?.status === "quoted")
        .sort((a: any, b: any) => blockScanEdgeKey(a).localeCompare(blockScanEdgeKey(b)))[0] : edges[0];
      assert(donorEdge, "no saved production input for target token");
      const donorEdgeId = blockScanEdgeKey(donorEdge);
      const donorSource = args.erc20InputOnly ? { number: saved.runtime.sourceBlock, hash: saved.runtime.sourceBlockHash } : source;
      const effective = saved.runtime.pricing.effectiveMids.rows.get(donorEdgeId);
      if (effective) assert.equal(effective.edgeId, donorEdgeId);
      const p = productionAmount(effective, saved.runtime.pricing.mids.get(donorEdgeId), donorEdge, donorSource, saved.runtime.generation);
      const splice = p.status === "unmet" && reference
        ? splicedMissingProductionAmount(effective, tokenIn, reference.saved, reference.declaration, args.referenceEdges) : null;
      if (p.status === "unmet") { naturalUnmet = true; if (!splice) unmet = true; }
      if (splice) usedReferenceEdges.add(splice.donorRow.edgeId);
      const row: any = { instance: entry.instanceKey, edgeId, tokenIn, tokenOut, originals,
        original: originals.length === 1 ? originals[0] : null,
        directionEvidence: originals.length ? "original transaction direction" : "opposite production Ready direction; not an original TX leg",
        productionReferenceGate: args.inputOnlyReference ? { status: "not-run-input-only", donorStatus: p.status,
          ...(p.status === "met" ? { amountIn: p.amountIn, tokenIn, donorRow: donorEdgeId, donorSource, quotedAt: effective.quotedAt,
            freshness: effective.freshness ?? effective.source ?? "recorded-in-donor-row", donorRowEvidence: effective } : { reason: p.reason }) } : p,
        splicedReferenceInput: splice, trials: [] }; report.samples.push(row);
      const beforeBuild = { calls, ...guard.counts };
      const leg = guard.build(() => {
        const input = { family, route: route[0]!, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog };
        for (const key of ["amountIn", "amountOut", "minAmountOut", "quotedAmountOut", "exact", "exactEvidence"]) {
          Object.defineProperty(input, key, { get() { guard.check(); throw new Error("amount read during runtime construction"); } });
        }
        return buildFamilyRuntimeAmountLeg(input);
      });
      assert(leg, "runtime decline is not a pass; quoted fallback forbidden");
      assert.deepEqual({ calls, ...guard.counts }, beforeBuild);
      row.runtimeConstruction = { exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false, programHash: ethers.keccak256(leg.program) };
      stage = "actor-balance-slot-proof";
      // Singleton protocols hold assets at the Core, not at their bytes32 key.
      // This is test-only observation, not production identity or dispatch.
      const protectedAccount = sample.family === "custom-swap:ekubo-router-v1" ? EKUBO_CORE
        : sample.family === "univ4" || sample.family === "univ4-fee-hook" ? (entry.instance.descriptor as any).managerBinding.manager : entry.instanceKey;
      const pair = [tokenIn, tokenOut], keys = await Promise.all(pair.map(t => slotFor(t, protectedAccount)));
      const base = await Promise.all(pair.map(t => balance(t, executor)));
      assert(pair.every(t => ![executor, owner].includes(t)) && ![executor, owner].includes(entry.instanceKey));
      const referenceAmount = p.status === "met" ? { label: args.inputOnlyReference ? "saved-production-input-only" : "production-effective", amountIn: p.amountIn }
        : splice ? { label: "spliced-production-input-at-N", amountIn: splice.amountIn } : null;
      const trials = historicalAmountTrials(originals, referenceAmount,
        args.family === "xwin-mint" || args.family === "xwin-redeem" || args.family === "ethertoken-native" || args.family === "cuni");
      report.preparationMs ??= performance.now() - started;
      for (const { label, amountIn, original } of trials) {
        const result: any = { label, amountIn, original, status: "failed", executions: [] }; row.trials.push(result);
        try {
          stage = "production-Exact"; const quoteStart = performance.now(), readsBefore = quoteReads.length;
          const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: route[0]!, amountIn, source, generation: source.generation,
            executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs: deadline } }));
          result.quoteMs = performance.now() - quoteStart;
          result.quoteReads = quoteReads.slice(readsBefore);
          if (quote.status !== "resolved") result.unresolvedQuote = quote;
          assert.equal(quote.status, "resolved", "real amount cannot be quoted"); if (quote.status !== "resolved") throw new Error("unresolved quote");
          // Preserve refused/zero quotes and their state reads before asserting;
          // a failed trial must retain the same diagnostic evidence as a pass.
          result.quote = { amountIn: quote.amountIn, amountOut: quote.amountOut, methodId: quote.methodId,
            outcome: quote.outcome, evidenceRefs: quote.evidenceRefs, reads: result.quoteReads };
          assert.equal(quote.amountIn, amountIn); assert(quote.amountOut > 0n); assert.deepEqual(quote.source, source);
          if (label === "production-effective" && p.status === "met") assert.equal(quote.amountOut, p.amountOut, "current Exact differs from production effective");
          result.originalTxComparison = original ? { originalAmountOut: original.amountOut,
            signedDelta: label === "historical-input-at-N" ? quote.amountOut - original.amountOut : null,
            observationId: original.observationId ?? null, logIndex: original.logIndex,
            verdict: original.comparison } : { verdict: "non-original amount trial; no original TX leg comparison" };
          const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: route[0]!, exact: quote,
            minAmountOut: quote.amountOut, executor, runtimeEvidence: [], actionOwnership: catalog }));
          assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
          const scripts: [string, Uint8Array][] = [
            ["quoted", concatBytes(...planFragmentNodes(fragment.fragment, tokenIn, amountIn).map(node => compilePlan(node, executor)))],
            ["runtime", runtimeProgramScript(ethers.getBytes(leg.program), amountIn)],
          ];
          // Main trials inject input ONLY. A separate, fixed inventory control
          // deliberately starts with output; all assertions still use delta.
          for (const inventoryControl of [false, true]) {
            const initial = [base[0]! + amountIn, base[1]! + (inventoryControl ? 10n ** 24n : 0n)];
            assert(initial.every(v => v <= ethers.MaxUint256));
            const nativeBefore = 17n;
            const overrides: Overrides = { [owner]: { balance: ethers.toQuantity(100n * 10n ** 18n) }, [executor]: { code: runtimeCode.code, balance: ethers.toQuantity(nativeBefore) },
              [pair[0]!]: { stateDiff: { [keys[0]!]: word(initial[0]!) } } };
            if (inventoryControl) overrides[pair[1]!] = { stateDiff: { [keys[1]!]: word(initial[1]!) } };
            for (const [encoding, script] of scripts) {
              stage = encoding; const executionStart = performance.now();
              const executed: any = { encoding, inventoryControl, status: "failed", scriptHash: ethers.keccak256(script), initial,
                stateOverridesSha256: sha(json(overrides)), source, executorCodeHash: runtimeCode.keccak256 };
              result.executions.push(executed);
              assert.deepEqual(await Promise.all(pair.map(t => balance(t, executor, overrides))), initial);
              const transaction = { from: owner, to: executor, data: buildExecuteCalldata(script), gas: GAS, gasPrice: header.baseFeePerGas };
              executed.transaction = transaction;
              executed.trace = await rpc("debug_traceCall", [transaction, pin, { tracer: "callTracer", timeout: "30s", stateOverrides: overrides }]);
              assert(executed.trace?.type === "CALL" && same(executed.trace.from, owner) && same(executed.trace.to, executor)
                && same(executed.trace.input, transaction.data), "execution trace belongs to another call");
              assert(!executed.trace.error && !executed.trace.revertReason, "real BotVM execution reverted");
              executed.diff = await rpc("debug_traceCall", [transaction, pin, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, timeout: "30s", stateOverrides: overrides }]);
              const measured = pair.map((t, i) => observeBalance(executed.diff, t, keys[i]!, initial[i]!));
              executed.balances = measured; executed.signedDelta = measured[1]!.delta - quote.amountOut;
              assertDeltas(measured[0]!, measured[1]!, amountIn, quote.amountOut);
              executed.nativeInventory = assertNativeInventory(executed.diff, executor, nativeBefore);
              // Identical program with NO input and abundant output must revert:
              // a pre-existing output balance cannot turn a failed leg into PASS.
              if (inventoryControl) {
                const noInput = { ...overrides, [pair[0]!]: { stateDiff: { [keys[0]!]: word(0n) } } };
                executed.noInput = await rpc("debug_traceCall", [transaction, pin, { tracer: "callTracer", timeout: "30s", stateOverrides: noInput }]);
                assert(executed.noInput?.type === "CALL" && same(executed.noInput.from, owner) && same(executed.noInput.to, executor)
                  && same(executed.noInput.input, transaction.data) && executed.noInput.error, "output inventory masked missing input");
              }
              executed.status = "pass"; executed.executionMs = performance.now() - executionStart;
            }
          }
          assert.equal(result.executions.length, 4); assert(result.executions.every((e: any) => e.status === "pass"));
          if (v4Fixture) {
            stage = "native-explicit-settlement";
            await acceptV4NativeSettlement({ fixture: v4Fixture, route: routes[0]!, descriptor: entry.instance.descriptor,
              source, header, executor, owner, runtimeCode, amountIn, amountOut: quote.amountOut,
              keys, base, pin, report, result, rpc, balance, slotFor,
              build(settlement) {
                const before = { calls, ...guard.counts };
                const explicit = guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: route[0]!, source, executor,
                  runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog, settlement }));
                assert.deepEqual({ calls, ...guard.counts }, before, "explicit runtime must not quote or call RPC");
                return explicit;
              } });
          }
          result.status = "pass";
        } catch (e) { result.error = failure(e); }
        abort.signal.throwIfAborted();
      }
    }
    report.cache = cache.snapshot();
    const trials = report.samples.flatMap((s: any) => s.trials);
    assert(trials.length > 0 && trials.every((t: any) => t.status === "pass"), "at least one real quote/execution failed");
    assert.deepEqual([...usedReferenceEdges].sort(), [...args.referenceEdges].sort(), "unused reference selection");
    report.naturalProductionReferenceGate = args.inputOnlyReference ? "not-run-input-only" : naturalUnmet ? "unmet" : "met";
    report.result = unmet ? "incomplete-production-reference" : args.inputOnlyReference ? "pass-with-input-only-reference" : usedReferenceEdges.size ? "pass-with-spliced-reference" : "pass";
  } catch (e) { report.errors.push(failure(e)); }
  finally {
    stage = "final-pins";
    try { await finalChecks?.(); } catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    stage = "strict-source-drain";
    try { await simulation?.closeAndDrain(); } catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    stage = "owned-fork-cleanup";
    try { if (backend) await backend.stopAndWait(); } catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    backend?.provider.destroy(); clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    report.diagnostics = { elapsedMs: performance.now() - started, directRpcCalls: calls, forkInternalRpcCalls: "not counted",
      invocationCounts: guard.counts, timingClaim: "diagnostic wall time only; not production scheduling/performance acceptance" };
    try { writeFileSync(fd, redact(json(report)) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  console.log(json({ result: report.result, family: sample.family, out: resolve(args.out), errors: report.errors }));
  if (!["pass", "pass-with-spliced-reference", "pass-with-input-only-reference"].includes(report.result)) process.exitCode = report.result === "incomplete-production-reference" ? 2 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("invalid arguments/output; existing files untouched; historical execution NOT established"); process.exitCode = 1;
});
