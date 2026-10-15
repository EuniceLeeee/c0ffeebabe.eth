// Opt-in current production issuer acceptance using immutable historical input amounts.
// Reuses a separately production-revalidated Ready; does not rewrite old hashes or prices.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import { AnvilStateBackend } from "../../../../../shared/state/state-backend.js";
import { buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { createAdapterFamilyExactQuoteCache } from "../../../../adapter-family-exact-quote-cache.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { balanceStorageKey, resolveErc20BalanceSlot } from "../../../../solver/balance-slots.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { botvm, sourcePin } from "../../../../test/family-integration/three-family/historical-dual.js";
import { minimumExecutionOutput, executionOutputMatches, executionInputMatches } from "../../../../../shared/executor/amount-rounding.js";
import { json, sha, word, observeBalance } from "../../../protocols/set-redemption-family/test/historical-runtime-observations.js";
import { CURVE_UNDERLYING_FAMILY_ID as ID } from "../manifest.js";
import { CURVE_UNDERLYING_UINT_INTERFACE as POOL, CURVE_UNDERLYING_UINT_RECEIVER_INTERFACE as RECEIVER, lowerAddress as lower } from "../codec.js";
import { underlyingNativeAssets } from "../native.js";
import { curveReadyTargetHasSwap } from "../../curve-plain-family/test/historical-ready.js";
import { ADDR } from "../../../../../shared/constants/addresses.js";
const WETH = ADDR.WETH;
const selectors = [POOL, RECEIVER].map(i => i.getFunction("exchange_underlying")!.selector);

type Overrides = Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string> }>;
const same = (a: string, b: string) => lower(a) === lower(b);
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)"]);
function assertRollback(diff: any, natives: readonly [string, bigint][]) {
  for (const address of new Set([...Object.keys(diff.pre ?? {}), ...Object.keys(diff.post ?? {})])) {
    const pre = diff.pre?.[address]?.storage ?? {}, post = diff.post?.[address]?.storage ?? {};
    for (const key of new Set([...Object.keys(pre), ...Object.keys(post)])) assert.equal(word(BigInt(pre[key] ?? "0x0")), word(BigInt(post[key] ?? "0x0")), `rollback storage ${address}:${key}`);
  }
  for (const [address, initial] of natives) {
    const pre = diff.pre?.[address]?.balance, post = diff.post?.[address]?.balance;
    assert.equal(post !== undefined ? BigInt(post) : pre !== undefined ? 0n : initial, initial, `rollback native ${address}`);
  }
}
async function main() {
  const values = new Map<string, string>(), names = ["--ready", "--reference", "--pool", "--recipient", "--rpc-file", "--out", "--port"];
  for (let n = 2; n < process.argv.length; n += 2) { const k = process.argv[n], v = process.argv[n + 1];
    assert(names.includes(k) && !values.has(k) && v && !v.startsWith("--")); values.set(k, v); }
  assert.equal(values.size, names.length);
  const port = Number(values.get("--port")); assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
  const out = resolve(values.get("--out")!), fd = openSync(out, "wx", 0o600);
  const report: any = { result: "failed", samples: [], errors: [], claim: "current identity/production issuer same-state quoted/runtime/direct correctness; reference borrows input only; not natural pricing, pre-call, opportunity or performance",
    safety: { signing: false, broadcast: false, remoteSubmission: false, overrides: "test actor code/native/token balances only" } };
  let backend: AnvilStateBackend | undefined, secret = "", stage = "inputs", calls = 0, constructing = false, blocked = 0;
  let checkPins: (() => void) | undefined, checkFork: (() => Promise<void>) | undefined;
  const abort = new AbortController(), deadline = Date.now() + 480_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 480_000);
  const interrupt = () => abort.abort(new Error("historical dual interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const redact = (v: unknown) => String(v).split(secret || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const failure = (e: unknown) => ({ stage, message: redact(e instanceof Error ? e.message : e) });
  try {
    const initialPin = sourcePin(); report.code = initialPin; report.ownedHarnessSha256 = sha(readFileSync(new URL(import.meta.url)));
    const readyPath = realpathSync(values.get("--ready")!), referencePath = realpathSync(values.get("--reference")!);
    const reference = parseAtBlockJson(readFileSync(referencePath, "utf8"));
    const receiptPath = resolve(dirname(readyPath), "receipt.json"), headerPath = resolve(dirname(readyPath), "header.json");
    const inputPaths = [readyPath, referencePath, receiptPath, headerPath];
    const hashes = () => inputPaths.map(path => ({ path, sha256: sha(readFileSync(path)) })); report.inputHashes = hashes();
    checkPins = () => { assert.equal(sha(readFileSync(new URL(import.meta.url))), report.ownedHarnessSha256); report.codeAfter = sourcePin(); assert.deepEqual(report.codeAfter, initialPin); assert.deepEqual(hashes(), report.inputHashes); };
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const executor = "0x1000000000000000000000000000000000000002", owner = "0x1000000000000000000000000000000000000001", recipient = lower(values.get("--recipient")!);
    assert(ethers.isAddress(recipient) && ![executor, owner, ethers.ZeroAddress].includes(recipient));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    const pin = { blockHash: source.hash, requireCanonical: true }, header = JSON.parse(readFileSync(headerPath, "utf8"));
    assert.equal(ready.universeRange.fromBlock, source.number); assert.equal(ready.universeRange.toBlock, source.number);
    assert.equal(Number(BigInt(receipt.blockNumber)), source.number); assert.equal(receipt.blockHash, source.hash);
    assert.equal(Number(BigInt(header.number)), source.number); assert.equal(header.hash, source.hash); assert.equal(BigInt(receipt.status), 1n);
    const flat = (t: any): any[] => [t, ...(t.calls ?? []).flatMap(flat)];
    const targetPool = lower(values.get("--pool")!);
    assert(curveReadyTargetHasSwap(receipt.logs, targetPool, [ID]), "target has no actual swap in receipt");
    report.original = { tx: receipt.transactionHash, block: source.number, blockHash: source.hash, pool: targetPool, preCallParity: "unverified; N-end is used" };
    const referenceSource = reference.runtime.pricing.effectiveMids.source;
    assert.equal(referenceSource.number, source.number); assert.equal(referenceSource.hash, source.hash);
    const donorRows = [...reference.runtime.pricing.effectiveMids.rows.values()] as any[];
    report.inputOnlyReference = { path: referencePath, sha256: sha(readFileSync(referencePath)), source: referenceSource, oldReadyPath: reference.readyPath, oldReadySha256: reference.readySha256,
      policy: "Only amountIn is borrowed. Old outputs, identity and admission are not reused. No current natural valuation claim." };
    const loopback = `http://127.0.0.1:${port}`, family = asPricedFamily(catalog.forStrictFamily(ID));
    const wiring = createRebuildWiring({ rpcUrl: loopback, familyIds: [ID], executionIdentity: { executor, transactionOrigin: owner } });
    const entries = [targetPool].map(pool => {
      const memos = activeReadyMemos(envelope).filter(m => m.familyId === ID && m.instanceKey === pool); assert.equal(memos.length, 1, `target not admitted ${pool}`);
      const memo = memos[0]; assert([familyDefinitionHash(ID), familyMemoDefinitionHash(ID)].includes(memo.familyDefinitionHash));
      const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
      const descriptor = instance.descriptor as any; assert(descriptor.nativeAlias);
      const edges = graph.filter(e => e.instanceKey === instance.instanceKey); assert.equal(edges.length, descriptor.coins.length * (descriptor.coins.length - 1)); assert([2, 6].includes(edges.length));
      const rows = edges.map(edge => {
        const donor = donorRows.find(d => d.status === "quoted" && d.instanceKey === pool && same(d.tokenIn, edge.tokenIn) && same(d.tokenOut, edge.tokenOut)); assert(donor, "same-state input donor missing");
        assert.equal(donor.quotedAt.number, source.number); assert.equal(donor.quotedAt.hash, source.hash);
        const row = { tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, amountIn: BigInt(donor.amountIn) }; assert(row.amountIn > 0n);
        const projected = instance.routes.find(r => same(r.tokenIn, edge.tokenIn) && same(r.tokenOut, edge.tokenOut)); assert(projected);
        const route = instance.routeHandles.find(r => r.routeKey === projected.routeKey); assert(route);
        const direction = projected as any;
        return { route, row, direction, assets: underlyingNativeAssets(descriptor, direction), donor: { edgeId: donor.edgeId, amountIn: row.amountIn, source: donor.quotedAt, freshness: "fresh-at-original-same-block" } }; });
      assert.equal(new Set(rows.map(r => r.route.routeKey)).size, edges.length); return { pool, memo, instance, rows };
    });
    report.inputs = { source, graphHash: ready.graphHash, actor: { executor, owner, recipient }, instances: entries.map(e => ({ pool: e.pool, descriptor: e.instance.descriptor,
      memoFingerprint: e.memo.memoFingerprint, candidate: e.memo.candidateSnapshot, rows: e.rows.map(r => ({ input: r.row, donor: r.donor, routeKey: r.route.routeKey })) })) };
    const runtimeCode = botvm(owner); report.runtimeCodeHash = runtimeCode.keccak256;
    secret = JSON.parse(readFileSync(values.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(typeof secret === "string");
    const allowed = new Set(["web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_createAccessList", "debug_traceCall"]);
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      if (constructing) { blocked++; throw new Error("RPC during runtime construction"); }
      if (method === "anvil_setCoinbase") assert.deepEqual(params, [header.miner]); else assert(allowed.has(method));
      abort.signal.throwIfAborted(); const id = ++calls; assert(id <= 1800 && Date.now() < deadline, "read budget exceeded");
      const res = await fetch(loopback, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      assert(res.ok, `${method}: HTTP ${res.status}`); const body: any = await res.json(); assert.equal(body.id, id); assert.equal(body.jsonrpc, "2.0"); if (body.error) throw new Error(`${method}: ${body.error.code} ${redact(body.error.message)}`); return body.result;
    };
    const call = (to: string, data: string, state: Overrides = {}) => rpc("eth_call", [{ to, data, from: owner }, pin, state]);
    const balance = async (token: string, holder: string, state: Overrides = {}) => BigInt(await call(token, ERC20.encodeFunctionData("balanceOf", [holder]), state));
    const cache = createAdapterFamilyExactQuoteCache(); cache.advanceState(source); const reads: any[] = [];
    const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner, exactQuoteCache: cache,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } }, provider: {
        async call(tx, b) { assert.equal(b, source.number); reads.push({ kind: "call", to: tx.to, selector: tx.data.slice(0, 10) }); return rpc("eth_call", [tx, pin]); },
        async getCode(a, b) { assert.equal(b, source.number); reads.push({ kind: "code", to: a }); return rpc("eth_getCode", [a, pin]); },
        async getStorage(a, k, b) { assert.equal(b, source.number); return rpc("eth_getStorageAt", [a, k, pin]); } } });
    const poisoned = new Proxy(runtime, { get(target, key, receiver) { if (constructing && !["callerAuthority", "generationFence"].includes(String(key))) { blocked++; throw new Error("quote service during runtime construction"); } return Reflect.get(target, key, receiver); } });
    stage = "runtime-construction";
    const cases = entries.flatMap(entry => entry.rows.map(item => { constructing = true; try {
      const leg = buildFamilyRuntimeAmountLeg({ family, route: item.route, source, runtime: poisoned, executor, runtimeEvidence: [], actionOwnership: catalog }); assert(leg, "runtime declined");
      const direct = (to: string) => buildFamilyRuntimeAmountLeg({ family, route: item.route, source, runtime: poisoned, executor, runtimeEvidence: [], actionOwnership: catalog, settlement: { kind: "direct-output", recipient: to } });
      const directSelf = direct(executor), directExternal = direct(recipient); assert(directSelf && directExternal);
      assert.equal(leg.settlement?.directOutput, true); assert.equal(leg.settlement?.deferredInput, undefined);
      // Raw protocol receiver restrictions apply only when it receives directly.
      // Native output is delivered to executor, then common boundary forwards WETH.
      for (const bad of [ethers.ZeroAddress, item.row.tokenIn, item.row.tokenOut]) assert.throws(() => direct(bad));
      if (item.assets?.output !== "native") assert.throws(() => direct(entry.pool));
      for (const settlement of [{ kind: "quote-output" as const, recipient }, { kind: "deferred-input" as const, paymentAmount: 1n, paymentProgram: "0x01" }]) {
        assert.equal(buildFamilyRuntimeAmountLeg({ family, route: item.route, source, runtime: poisoned, executor, runtimeEvidence: [], actionOwnership: catalog, settlement }), null);
      }
      return { entry, ...item, leg, directSelf, directExternal }; } finally { constructing = false; } }));
    assert.equal(calls + reads.length + blocked, 0); report.runtimeConstruction = { directions: cases.length, rpcCalls: calls, exactCalls: 0, blocked, quotedFallback: false };
    stage = "fork-start"; backend = new AnvilStateBackend(secret, loopback, port); await backend.forkAt(source.number, { signal: abort.signal, deadlineAtMs: deadline });
    assert(/anvil/i.test(await rpc("web3_clientVersion", []))); assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const headerCheck = async () => { const h = await rpc("eth_getBlockByNumber", ["latest", false]); for (const f of ["number", "hash", "parentHash", "stateRoot", "timestamp", "baseFeePerGas", "gasLimit", "miner", "mixHash", "excessBlobGas"]) assert.equal(h[f], header[f], `N header ${f}`); return h; };
    report.headerBefore = await headerCheck(); checkFork = async () => { report.headerAfter = await headerCheck(); };
    const environment = async () => [...ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"), await call(executor, "0x", { [executor]: { code: "0x43600052426020524860405241606052456080524460a0524660c05260e06000f3" } }))];
    const expected = [BigInt(header.number), BigInt(header.timestamp), BigInt(header.baseFeePerGas), BigInt(header.miner), BigInt(header.gasLimit), BigInt(header.mixHash), 1n];
    report.environmentBefore = await environment(); if (report.environmentBefore[3] !== expected[3]) { report.coinbaseAdjustment = { before: report.environmentBefore[3], after: expected[3] }; await rpc("anvil_setCoinbase", [header.miner]); }
    report.environment = await environment(); assert.deepEqual(report.environment, expected);
    assert.deepEqual(await rpc("eth_getTransactionReceipt", [receipt.transactionHash]), receipt);
    report.actorCodeBefore = [];
    for (const address of [owner, executor, recipient]) {
      const code = await rpc("eth_getCode", [address, pin]);
      assert(code === "0x" || (address === executor && code.toLowerCase() === runtimeCode.code.toLowerCase()), `actor code collision ${address}`);
      report.actorCodeBefore.push({ address, codeHash: ethers.keccak256(code), empty: code === "0x" });
    }
    report.actualCodeIdentity = [];
    for (const entry of entries) {
      const code = await rpc("eth_getCode", [entry.pool, pin]), hash = ethers.keccak256(code);
      assert.equal(hash, (entry.instance.descriptor as any).nativeAlias.poolCodeHash);
      const clone = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
      const implementation = clone ? lower("0x" + clone[1]) : null;
      const implementationCode = implementation ? await rpc("eth_getCode", [implementation, pin]) : null;
      if (implementationCode) assert(implementationCode.length > 2);
      report.actualCodeIdentity.push({ pool: entry.pool, source, code, codeHash: hash, implementation, implementationCode,
        implementationCodeHash: implementationCode ? ethers.keccak256(implementationCode) : null,
        role: "same-N code provenance supplement; current production identity/receiver probe remains the admission source" });
    }
    stage = "actor-balance-mappings"; const slots = new Map<string, string>(), recipientSlots = new Map<string, string>(); report.balanceMappings = [];
    const tokens: string[] = [...new Set(cases.flatMap(c => [lower(c.row.tokenIn), lower(c.row.tokenOut)]))];
    for (const token of tokens) {
      const holder = String(entries.find(e => e.rows.some(r => same(r.row.tokenIn, token) || same(r.row.tokenOut, token)))!.pool);
      const holderBalance = await balance(token, holder);
      const index = await resolveErc20BalanceSlot(token, holder, { balanceOf: balance, getStorage: async (t, k) => BigInt(await rpc("eth_getStorageAt", [t, k, pin])) });
      const keys: string[] = index === null ? [] : [balanceStorageKey(executor, index).toLowerCase()];
      if (index === null) { const a = await rpc("eth_createAccessList", [{ from: owner, to: token, data: ERC20.encodeFunctionData("balanceOf", [executor]), gas: "0x100000" }, ethers.toQuantity(source.number)]);
        assert(!a.error && Array.isArray(a.accessList)); keys.push(...a.accessList.filter((x: any) => same(x.address, token)).flatMap((x: any) => x.storageKeys.map((k: string) => word(k)))); }
      assert(keys.length > 0 && keys.length <= 16); let found = "";
      for (const key of new Set(keys)) { let valid = true; for (const v of [717171717171n, 919191919193n]) { const o = { [token]: { stateDiff: { [key]: word(v) } } };
        if (await balance(token, executor, o) !== v || await balance(token, holder, o) !== holderBalance) valid = false; }
        if (valid) { assert.equal(found, ""); found = key; } }
      assert(found, `balance slot unproven ${token}`); slots.set(token, found);
      const recipientCandidates: string[] = index === null ? [] : [balanceStorageKey(recipient, index).toLowerCase()];
      if (index === null) { const a = await rpc("eth_createAccessList", [{ from: owner, to: token, data: ERC20.encodeFunctionData("balanceOf", [recipient]), gas: "0x100000" }, ethers.toQuantity(source.number)]);
        assert(!a.error && Array.isArray(a.accessList)); recipientCandidates.push(...a.accessList.filter((x: any) => same(x.address, token)).flatMap((x: any) => x.storageKeys.map((k: string) => word(k)))); }
      let recipientKey = ""; assert(recipientCandidates.length > 0 && recipientCandidates.length <= 16);
      for (const key of new Set(recipientCandidates)) { let valid = true; for (const v of [818181818181n, 929292929293n]) {
        const o = { [token]: { stateDiff: { [key]: word(v), [found]: word(10101n) } } };
        if (await balance(token, recipient, o) !== v || await balance(token, executor, o) !== 10101n || await balance(token, holder, o) !== holderBalance) valid = false;
      } if (valid) { assert.equal(recipientKey, ""); recipientKey = key; } }
      assert(recipientKey && recipientKey !== found); recipientSlots.set(token, recipientKey);
      report.balanceMappings.push({ token, holder, holderBalance, slotIndex: index, actorStorageKey: found, recipientStorageKey: recipientKey });
    }
    for (const { entry, row, route, direction, assets, leg, directSelf, directExternal } of cases) {
      const trials: [string, bigint][] = [["same-state-production-input-only", row.amountIn], ["ten-times-same-state-production-input", row.amountIn * 10n]];
      for (const [label, amountIn] of trials) {
        const sample: any = { pool: entry.pool, model: (entry.instance.descriptor as any).model, routeKey: route.routeKey, tokenIn: row.tokenIn, tokenOut: row.tokenOut, label, amountIn, status: "failed", executions: [] }; report.samples.push(sample);
        try {
          stage = "production-exact"; const start = performance.now(), startReads = reads.length;
          const quote = await executeFamilyExactQuote({ family, route, amountIn, source, generation: source.generation, executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs: deadline } });
          assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved"); assert.equal(quote.amountIn, amountIn); assert(quote.amountOut > 0n);
          sample.quote = { amountOut: quote.amountOut, reads: reads.slice(startReads), wallMs: performance.now() - start };
          const fragment = buildFamilyExecutionFragment({ family, route, exact: quote, minAmountOut: minimumExecutionOutput(quote.amountOut, 1n), executor, runtimeEvidence: [], actionOwnership: catalog }); assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("fragment unresolved");
          const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
          const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, executor, concatBytes(...node.children.map(compile))); };
          const scripts: [string, Uint8Array][] = [["quoted", concatBytes(...planFragmentNodes(fragment.fragment, row.tokenIn, amountIn).map(compile))], ["runtime", runtimeProgramScript(ethers.getBytes(leg.program), amountIn)], ["direct-self", runtimeProgramScript(ethers.getBytes(directSelf.program), amountIn)], ["direct-external", runtimeProgramScript(ethers.getBytes(directExternal.program), amountIn)]];
          const pair = [lower(row.tokenIn), lower(row.tokenOut)], inventory = [101n, quote.amountOut + 103n], initial = [amountIn + inventory[0], inventory[1]], nativeBefore = 12345n, recipientInitial = [107n, 109n], recipientNativeBefore = 13337n;
          const overrides: Overrides = { [owner]: { balance: ethers.toQuantity(100n * 10n ** 18n) }, [executor]: { code: runtimeCode.code, balance: ethers.toQuantity(nativeBefore) }, [recipient]: { balance: ethers.toQuantity(recipientNativeBefore) } };
          pair.forEach((t, n) => { overrides[t] = { stateDiff: { [slots.get(t)!]: word(initial[n]), [recipientSlots.get(t)!]: word(recipientInitial[n]) } }; }); sample.inventory = inventory; sample.overridesSha256 = sha(json(overrides));
          for (const [encoding, script] of scripts) {
            const result: any = { encoding, status: "failed", scriptHash: ethers.keccak256(script) }; sample.executions.push(result);
            try {
              stage = encoding; assert.deepEqual(await Promise.all(pair.map(t => balance(t, executor, overrides))), initial);
              const tx = { from: owner, to: executor, data: buildExecuteCalldata(script), gas: "0x1000000", gasPrice: ethers.toQuantity(header.baseFeePerGas) };
              result.callTrace = await rpc("debug_traceCall", [tx, pin, { tracer: "callTracer", stateOverrides: overrides }]); assert(!result.callTrace.error, "BotVM reverted");
              result.stateDiff = await rpc("debug_traceCall", [tx, pin, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, stateOverrides: overrides }]);
              const balances = pair.map((t, n) => observeBalance(result.stateDiff, t, slots.get(t)!, initial[n]));
              const recipientBalances = pair.map((t, n) => observeBalance(result.stateDiff, t, recipientSlots.get(t)!, recipientInitial[n]));
              result.balances = balances; result.recipientBalances = recipientBalances;
              const external = encoding === "direct-external", actualOutput = external ? recipientBalances[1].delta : balances[1].delta;
              result.quoteDelta = actualOutput - quote.amountOut;
              const inputTolerance = encoding.startsWith("direct-") ? 0n : 1n;
              assert(executionInputMatches(-balances[0].delta, amountIn, inputTolerance)); assert(balances[0].after >= inventory[0]);
              result.inputUnderdeduction = amountIn + balances[0].delta; result.outputDifference = actualOutput - quote.amountOut;
              assert(executionOutputMatches(actualOutput, quote.amountOut, 1n)); assert.equal(balances[1].delta, external ? 0n : actualOutput);
              assert.equal(recipientBalances[0].delta, 0n); assert.equal(recipientBalances[1].delta, external ? actualOutput : 0n);
              {
                const allCalls = (t: any): any[] => [t, ...(t.calls ?? []).flatMap(allCalls)];
                const callsInTx = allCalls(result.callTrace);
                const marketCalls = callsInTx.filter(t => same(t.to ?? ethers.ZeroAddress, entry.pool) && selectors.some(s => t.input?.startsWith(s)));
                assert.equal(marketCalls.length, 1); assert(!marketCalls[0].error);
                const receiverCall = encoding.startsWith("direct-") && assets?.output !== "native";
                const iface = receiverCall ? RECEIVER : POOL;
                assert(marketCalls[0].input.startsWith(iface.getFunction("exchange_underlying")!.selector));
                const args = iface.decodeFunctionData("exchange_underlying", marketCalls[0].input);
                const expectedReceiver = receiverCall && external ? recipient : executor;
                if (receiverCall) assert.equal(lower(args[4]), expectedReceiver);
                assert.equal(Number(args[0]), direction.i); assert.equal(Number(args[1]), direction.j); assert.equal(BigInt(args[2]), amountIn);
                assert.equal(BigInt(marketCalls[0].value ?? "0x0"), assets?.input === "native" ? amountIn : 0n);
                const wrappedCalls = callsInTx.filter(t => same(t.to ?? ethers.ZeroAddress, WETH));
                const withdraw = wrappedCalls.filter(t => t.input?.startsWith("0x2e1a7d4d")), deposit = wrappedCalls.filter(t => t.input === "0xd0e30db0");
                assert.equal(withdraw.length, assets?.input === "native" ? 1 : 0); assert.equal(deposit.length, assets ? 1 : 0);
                if (withdraw.length) assert.equal(BigInt("0x" + withdraw[0].input.slice(10)), amountIn);
                if (deposit.length) assert.equal(BigInt(deposit[0].value), assets?.output === "native" ? actualOutput : result.inputUnderdeduction);
                result.protocolCall = { selector: marketCalls[0].input.slice(0, 10), protocolRecipient: expectedReceiver, graphRecipient: external ? recipient : executor,
                  i: direction.i, j: direction.j, fullRequestedInput: amountIn, actualInputSpent: -balances[0].delta, actualOutput, withdrawals: withdraw.length, deposits: deposit.length };
              }
              const recipientPost = result.stateDiff.post?.[recipient]?.balance, recipientPre = result.stateDiff.pre?.[recipient]?.balance;
              result.recipientNativeAfter = recipientPost !== undefined ? BigInt(recipientPost) : recipientPre !== undefined ? 0n : recipientNativeBefore;
              assert.equal(result.recipientNativeAfter, recipientNativeBefore);
              const preNative = result.stateDiff.pre?.[executor]?.balance, postNative = result.stateDiff.post?.[executor]?.balance;
              result.nativeBefore = nativeBefore; result.nativeAfter = postNative !== undefined ? BigInt(postNative) : preNative !== undefined ? 0n : nativeBefore;
              assert.equal(result.nativeAfter, nativeBefore, "native inventory consumed or receipt left unwrapped");
              if (assets?.input !== "native") {
                // Decode the actually produced token storage through its own
                // allowance getter. These overrides are read-only observations,
                // never inputs to the execution or quote being verified.
                const observed: Overrides = {};
                const tokenPre = result.stateDiff.pre?.[pair[0]]?.storage ?? {};
                const tokenPost = result.stateDiff.post?.[pair[0]]?.storage ?? {};
                observed[pair[0]] = { stateDiff: Object.fromEntries([...new Set([...Object.keys(tokenPre), ...Object.keys(tokenPost)])]
                  .map(key => [key, tokenPost[key] ?? word(0n)])) };
                result.finalAllowance = BigInt(await call(pair[0], ERC20.encodeFunctionData("allowance", [executor, entry.pool]), observed));
                assert.equal(result.finalAllowance, 0n, "temporary input allowance remains");
              }
              if (encoding.startsWith("direct-")) {
                const zeroScript = runtimeProgramScript(ethers.getBytes((encoding === "direct-self" ? directSelf : directExternal).program), 0n);
                const zeroTx = { ...tx, data: buildExecuteCalldata(zeroScript) };
                result.zeroInputTrace = await rpc("debug_traceCall", [zeroTx, pin, { tracer: "callTracer", stateOverrides: overrides }]);
                assert(result.zeroInputTrace.error, "zero input must revert atomically");
                result.zeroInputStateDiff = await rpc("debug_traceCall", [zeroTx, pin, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, stateOverrides: overrides }]);
                assertRollback(result.zeroInputStateDiff, [[executor, nativeBefore], [recipient, recipientNativeBefore]]);
                for (const [n, t] of pair.entries()) {
                  assert.equal(observeBalance(result.zeroInputStateDiff, t, slots.get(t)!, initial[n]).delta, 0n);
                  assert.equal(observeBalance(result.zeroInputStateDiff, t, recipientSlots.get(t)!, recipientInitial[n]).delta, 0n);
                }
              }
              if (encoding !== "quoted") {
                result.negatives = [];
                for (const fault of ["forced-post-revert", "insufficient-input"] as const) {
                  const requested = amountIn;
                  const faultOverrides: Overrides = JSON.parse(JSON.stringify(overrides));
                  if (fault === "insufficient-input") faultOverrides[pair[0]].stateDiff![slots.get(pair[0])!] = word(0n);
                  const faultLeg = encoding === "direct-self" ? directSelf : encoding === "direct-external" ? directExternal : leg;
                  const faultProgram = fault === "forced-post-revert" ? new RuntimeAmountProgram().run(faultLeg.program).constant(1, 1n).constant(2, 2n).equal(1, 2).bytes() : ethers.getBytes(faultLeg.program);
                  assert(faultLeg);
                  const faultTx = { ...tx, data: buildExecuteCalldata(runtimeProgramScript(faultProgram, requested)) };
                  const trace = await rpc("debug_traceCall", [faultTx, pin, { tracer: "callTracer", stateOverrides: faultOverrides }]);
                  assert(trace.error, `fault ${fault} accepted`);
                  const diff = await rpc("debug_traceCall", [faultTx, pin, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, stateOverrides: faultOverrides }]);
                  assertRollback(diff, [[executor, nativeBefore], [recipient, recipientNativeBefore]]);
                  if (fault === "forced-post-revert") {
                    const executed = flat(trace).filter(t => same(t.to ?? ethers.ZeroAddress, entry.pool) && selectors.some(s => t.input?.startsWith(s)));
                    assert.equal(executed.length, 1); assert(!executed[0].error, "forced post-revert must occur after actual successful underlying swap");
                  }
                  result.negatives.push({ fault, status: "correctly-rejected", callTrace: trace, stateDiff: diff });
                }
              }
              result.status = "pass";
            } catch (e) { result.error = failure(e); }
          }
          assert(sample.executions.every((e: any) => e.status === "pass")); assert.deepEqual(sample.executions[0].balances, sample.executions[1].balances); assert.deepEqual(sample.executions[1].balances, sample.executions[2].balances); sample.status = "pass";
        } catch (e) { sample.error = failure(e); }
        console.log(json({ pool: sample.pool, label, tokenIn: row.tokenIn, status: sample.status }));
      }
    }
    report.cache = cache.snapshot(); assert.equal(report.samples.length, cases.length * 2); assert(report.samples.every((s: any) => s.status === "pass")); report.result = "pass";
  } catch (e) { report.errors.push(failure(e)); }
  finally {
    stage = "final-pins"; try { await checkFork?.(); checkPins?.(); } catch (e) { report.errors.push(failure(e)); report.result = "failed"; }
    stage = "fork-cleanup"; try { await backend?.stopAndWait(); report.forkStopped = !!backend; } catch (e) { report.errors.push(failure(e)); report.result = "failed"; } finally { backend?.provider.destroy(); }
    clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); report.rpcCalls = calls;
    try { writeFileSync(fd, redact(json(report)) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  console.log(json({ result: report.result, samples: report.samples.length, executionsPassed: report.samples.flatMap((s: any) => s.executions).filter((e: any) => e.status === "pass").length, out }));
  if (report.result !== "pass") process.exitCode = 1;
}
main().catch(() => { console.error("curve underlying recipient historical invalid inputs; existing files not overwritten"); process.exitCode = 1; });
