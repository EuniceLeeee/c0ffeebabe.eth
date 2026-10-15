// Opt-in current production issuer acceptance using immutable historical input amounts.
// Reuses a separately production-revalidated Ready; does not rewrite old hashes or prices.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import { AnvilStateBackend } from "../../../../../shared/state/state-backend.js";
import { buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
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
import { assertHistoricalDiscoveryReceipt, assertHistoricalPriceDirection } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { json, sha, word, observeBalance } from "../../../protocols/set-redemption-family/test/historical-runtime-observations.js";
import { ID } from "../manifest.js";
import { POOL, WETH, lower, same } from "../codec.js";

type Overrides = Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string> }>;
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)"]);
async function main() {
  const values = new Map<string, string>(), names = ["--ready", "--reference", "--recipient", "--rpc-file", "--out", "--port"];
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
    const initialPin = sourcePin(); report.code = initialPin;
    const readyPath = realpathSync(values.get("--ready")!), referencePath = realpathSync(values.get("--reference")!);
    const reference = parseAtBlockJson(readFileSync(referencePath, "utf8"));
    assert.equal(reference.result, "pass", "reference must be completed evidence, not a fabricated input");
    const receiptPath = reference.inputHashes.find((x: any) => x.path.endsWith("/receipt.json"))?.path; assert(receiptPath);
    const inputPaths = [readyPath, referencePath, receiptPath];
    const hashes = () => inputPaths.map(path => ({ path, sha256: sha(readFileSync(path)) })); report.inputHashes = hashes();
    checkPins = () => { assert.deepEqual(sourcePin(), initialPin); assert.deepEqual(hashes(), report.inputHashes); };
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const executor = lower(reference.inputs.actor.executor), owner = lower(reference.inputs.actor.owner), recipient = lower(values.get("--recipient")!);
    assert(ethers.isAddress(recipient) && ![executor, owner, ethers.ZeroAddress].includes(recipient));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    const pin = { blockHash: source.hash, requireCanonical: true }, header = reference.headerBefore;
    assert.equal(ready.universeRange.fromBlock, source.number); assert.equal(ready.universeRange.toBlock, source.number);
    for (const [n, h] of [[Number(BigInt(receipt.blockNumber)), receipt.blockHash], [Number(BigInt(header.number)), header.hash],
      [reference.inputs.source.number, reference.inputs.source.hash]]) { assert.equal(n, source.number); assert.equal(h, source.hash); }
    assert.equal(BigInt(receipt.status), 1n);
    const originals = receipt.logs.flatMap((l: any) => { try { const e = POOL.parseLog(l); if (!e || !["TokenPurchase", "EthPurchase"].includes(e.name)) return [];
      return [{ pool: lower(l.address), buy: e.name === "TokenPurchase", amountIn: e.args[1], amountOut: e.args[2], buyer: e.args[0], logIndex: l.logIndex }]; } catch { return []; } });
    assert(originals.length > 0); report.original = { tx: receipt.transactionHash, block: source.number, blockHash: source.hash, legs: originals, preCallParity: "unverified" };
    const loopback = `http://127.0.0.1:${port}`, family = asPricedFamily(catalog.forStrictFamily(ID));
    const wiring = createRebuildWiring({ rpcUrl: loopback, familyIds: [ID], executionIdentity: { executor, transactionOrigin: owner } });
    const entries = [...new Set<string>(originals.map((o: any) => String(o.pool)))].map(pool => {
      const memos = activeReadyMemos(envelope).filter(m => m.familyId === ID && m.instanceKey === pool); assert.equal(memos.length, 1, `target not admitted ${pool}`);
      const memo = memos[0]; assert([familyDefinitionHash(ID), familyMemoDefinitionHash(ID)].includes(memo.familyDefinitionHash));
      const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
      const edges = graph.filter(e => e.instanceKey === instance.instanceKey); assert.equal(edges.length, 2);
      const rows = edges.map(edge => {
        const donors = reference.samples.filter((s: any) => s.pool === pool && s.label === "production-effective" && same(s.tokenIn, edge.tokenIn) && same(s.tokenOut, edge.tokenOut));
        assert.equal(donors.length, 1); const donor = donors[0];
        const row = { tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, amountIn: BigInt(donor.amountIn) };
        assert(row.amountIn > 0n); const routes = instance.routes.filter(r => same(r.tokenIn, row.tokenIn) && same(r.tokenOut, row.tokenOut)); assert.equal(routes.length, 1);
        const handles = instance.routeHandles.filter(r => r.routeKey === routes[0].routeKey); assert.equal(handles.length, 1);
        return { row, route: handles[0], donor: { path: referencePath, source: reference.inputs.source, label: donor.label, amountIn: row.amountIn,
          policy: "input amount only; current quote and execution independently evaluated at the same historical state" } }; });
      assert.equal(new Set(rows.map(r => r.route.routeKey)).size, 2); return { pool, memo, instance, rows };
    });
    report.inputs = { source, graphHash: ready.graphHash, actor: { executor, owner, recipient }, instances: entries.map(e => ({ pool: e.pool, descriptor: e.instance.descriptor,
      memoFingerprint: e.memo.memoFingerprint, candidate: e.memo.candidateSnapshot, rows: e.rows.map(r => ({ input: r.row, donor: r.donor, routeKey: r.route.routeKey })) })) };
    const runtimeCode = botvm(owner); report.runtimeCodeHash = runtimeCode.keccak256;
    secret = JSON.parse(readFileSync(values.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(typeof secret === "string");
    const allowed = new Set(["web3_clientVersion", "eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_createAccessList", "debug_traceCall"]);
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      if (constructing) { blocked++; throw new Error("RPC during runtime construction"); }
      if (method === "anvil_setCoinbase") assert.deepEqual(params, [header.miner]); else assert(allowed.has(method));
      abort.signal.throwIfAborted(); assert(++calls <= 1800 && Date.now() < deadline, "read budget exceeded");
      const res = await fetch(loopback, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      assert(res.ok, `${method}: HTTP ${res.status}`); const body: any = await res.json(); if (body.error) throw new Error(`${method}: ${body.error.code} ${redact(body.error.message)}`); return body.result;
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
      for (const bad of [ethers.ZeroAddress, String(entry.pool), String((entry.instance.descriptor as any).issuer), item.row.tokenIn, item.row.tokenOut]) assert.throws(() => direct(bad));
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
    for (const entry of entries) { const c = entry.memo.candidateSnapshot as any; assertHistoricalDiscoveryReceipt(await rpc("eth_getTransactionReceipt", [c.transactionHash]), c, source); }
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
        try { if (await balance(token, executor, o) !== v || await balance(token, holder, o) !== holderBalance) valid = false; } catch { valid = false; } }
        if (valid) { assert.equal(found, ""); found = key; } }
      assert(found, `balance slot unproven ${token}`); slots.set(token, found);
      const recipientCandidates: string[] = index === null ? [] : [balanceStorageKey(recipient, index).toLowerCase()];
      if (index === null) { const a = await rpc("eth_createAccessList", [{ from: owner, to: token, data: ERC20.encodeFunctionData("balanceOf", [recipient]), gas: "0x100000" }, ethers.toQuantity(source.number)]);
        assert(!a.error && Array.isArray(a.accessList)); recipientCandidates.push(...a.accessList.filter((x: any) => same(x.address, token)).flatMap((x: any) => x.storageKeys.map((k: string) => word(k)))); }
      let recipientKey = ""; assert(recipientCandidates.length > 0 && recipientCandidates.length <= 16);
      for (const key of new Set(recipientCandidates)) { let valid = true; for (const v of [818181818181n, 929292929293n]) {
        const o = { [token]: { stateDiff: { [key]: word(v), [found]: word(10101n) } } };
        try { if (await balance(token, recipient, o) !== v || await balance(token, executor, o) !== 10101n || await balance(token, holder, o) !== holderBalance) valid = false; } catch { valid = false; }
      } if (valid) { assert.equal(recipientKey, ""); recipientKey = key; } }
      assert(recipientKey && recipientKey !== found); recipientSlots.set(token, recipientKey);
      report.balanceMappings.push({ token, holder, holderBalance, slotIndex: index, actorStorageKey: found, recipientStorageKey: recipientKey });
    }
    for (const { entry, row, route, leg, directSelf, directExternal } of cases) {
      const original = originals.find((o: any) => o.pool === entry.pool && o.buy === same(row.tokenIn, WETH));
      const trials: [string, bigint][] = [["reference-effective-input-only", row.amountIn], [original ? "historical-input-at-N" : "half-effective", original ? original.amountIn : row.amountIn / 2n]];
      for (const [label, amountIn] of trials) {
        const sample: any = { pool: entry.pool, model: (entry.instance.descriptor as any).model, routeKey: route.routeKey, tokenIn: row.tokenIn, tokenOut: row.tokenOut, label, amountIn, status: "failed", executions: [] }; report.samples.push(sample);
        try {
          stage = "production-exact"; const start = performance.now(), startReads = reads.length;
          const quote = await executeFamilyExactQuote({ family, route, amountIn, source, generation: source.generation, executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs: deadline } });
          assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved"); assert.equal(quote.amountIn, amountIn); assert(quote.amountOut > 0n);
          sample.quote = { amountOut: quote.amountOut, reads: reads.slice(startReads), wallMs: performance.now() - start };
          const quoterData = await call(String(entry.pool), POOL.encodeFunctionData(same(row.tokenIn, WETH) ? "getEthToTokenInputPrice" : "getTokenToEthInputPrice", [amountIn]));
          sample.publicQuoter = { amountOut: BigInt(quoterData.slice(0, 66)), signedDelta: BigInt(quoterData.slice(0, 66)) - quote.amountOut };
          if (sample.model === "uniswap-v1-997") assert.equal(sample.publicQuoter.signedDelta, 0n);
          sample.original = original ? { ...original, signedDelta: amountIn === original.amountIn ? quote.amountOut - original.amountOut : null, preCallParity: "unverified; N end-state differs" } : null;
          const fragment = buildFamilyExecutionFragment({ family, route, exact: quote, minAmountOut: quote.amountOut, executor, runtimeEvidence: [], actionOwnership: catalog }); assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("fragment unresolved");
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
              assert.equal(balances[0].delta, -amountIn); assert.equal(balances[0].after, inventory[0]);
              assert.equal(actualOutput, quote.amountOut); assert.equal(balances[1].delta, external ? 0n : quote.amountOut);
              assert.equal(recipientBalances[0].delta, 0n); assert.equal(recipientBalances[1].delta, external ? quote.amountOut : 0n);
              if (encoding.startsWith("direct-")) {
                const selector = same(row.tokenIn, WETH) ? "0xad65d76d" : "0x7237e031";
                const allCalls = (t: any): any[] => [t, ...(t.calls ?? []).flatMap(allCalls)];
                const transferCalls = allCalls(result.callTrace).filter(t => same(t.to ?? ethers.ZeroAddress, entry.pool) && t.input?.startsWith(selector));
                assert.equal(transferCalls.length, 1, "must call the actual TransferInput interface");
                const expectedReceiver = same(row.tokenIn, WETH) && external ? recipient : executor;
                assert.equal(lower("0x" + transferCalls[0].input.slice(-40)), expectedReceiver);
                result.transferInput = { selector, protocolRecipient: expectedReceiver, graphRecipient: external ? recipient : executor };
              }
              const recipientPost = result.stateDiff.post?.[recipient]?.balance, recipientPre = result.stateDiff.pre?.[recipient]?.balance;
              result.recipientNativeAfter = recipientPost !== undefined ? BigInt(recipientPost) : recipientPre !== undefined ? 0n : recipientNativeBefore;
              assert.equal(result.recipientNativeAfter, recipientNativeBefore);
              const preNative = result.stateDiff.pre?.[executor]?.balance, postNative = result.stateDiff.post?.[executor]?.balance;
              result.nativeBefore = nativeBefore; result.nativeAfter = postNative !== undefined ? BigInt(postNative) : preNative !== undefined ? 0n : nativeBefore;
              assert.equal(result.nativeAfter, nativeBefore, "native inventory consumed or receipt left unwrapped");
              if (!same(row.tokenIn, WETH)) {
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
                for (const [n, t] of pair.entries()) {
                  assert.equal(observeBalance(result.zeroInputStateDiff, t, slots.get(t)!, initial[n]).delta, 0n);
                  assert.equal(observeBalance(result.zeroInputStateDiff, t, recipientSlots.get(t)!, recipientInitial[n]).delta, 0n);
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
main().catch(() => { console.error("univ1 recipient historical invalid inputs; existing files not overwritten"); process.exitCode = 1; });
