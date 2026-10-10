import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ethers } from "ethers";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog,
  PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS as actions } from "../../../production-family-composition.js";
import { executeAdapterFamilyLifecycleBatch, executeFamilyExactQuote, buildFamilyExecutionFragment,
  buildFamilyRuntimeAmountLeg, assertIssuedPreparedFamilyInstance, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { concatBytes, encodeAssertBalanceGte } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";
import { DEFAULT_EFFECTIVE_WETH_INPUT } from "../../../../blockscan-effective-mid.js";
import { ELLA_ID } from "../manifest.js";
import { UNIT, assertSource, same, TOKEN, POOL } from "../codec.js";
import type { EllaDescriptor, EllaState } from "../types.js";
import sample from "./public-sample.json";
import { assertAcceptanceBinding, assertInventoryRejection, requireProductionReference } from "./historical-evidence.js";

const arg = (name: string) => { const n = process.argv.indexOf(name); assert(n >= 0 && process.argv[n + 1], `${name} required`); return process.argv[n + 1]; };
const envFile = arg("--env-file"), artifactPath = arg("--artifact"), receiptPath = arg("--receipt"), outputPath = arg("--out");
assert(!existsSync(outputPath), "never overwrite execution evidence");
assert.equal(process.env.SEARCHER_TEST_DISABLE_DOTENV, "1", "disable dotenv before imports");
const readyPath = process.argv.includes("--ready") ? resolve(arg("--ready")) : undefined;
const pricesPath = process.argv.includes("--prices") ? resolve(arg("--prices")) : undefined;
assert.equal(!!readyPath, !!pricesPath, "Ready and price inputs are a pair");
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const readyBytes = readyPath ? readFileSync(readyPath) : undefined;
const priceBytes = pricesPath ? readFileSync(pricesPath) : undefined;
const priceInputPath = pricesPath ? resolve(dirname(pricesPath), "input.json") : undefined;
const priceInputBytes = priceInputPath ? readFileSync(priceInputPath) : undefined;
const priceInput = priceInputBytes ? parseAtBlockJson(priceInputBytes.toString()) : undefined;
const envelope = readyPath ? await new UniverseRebuildCheckpointStore({ path: readyPath }).load() : undefined;
if (readyPath) assert(envelope && envelope.inProgressRun === null);
const saved = priceBytes ? parseAtBlockJson(priceBytes.toString()) : undefined;
const readyView = envelope ? resolveStrictReadyRuntime(envelope.readyGeneration) : undefined;
if (saved) {
  assert.equal(saved.readySha256, sha(readyBytes!)); assert.equal(resolve(saved.readyPath), readyPath);
  assert.equal(saved.runtime.sourceBlock, readyView!.ready.cutoff.number);
  assert.equal(saved.runtime.sourceBlockHash, readyView!.ready.cutoff.hash);
  assert.equal(readyView!.ready.universeRange.fromBlock, readyView!.ready.cutoff.number);
  assert.equal(readyView!.ready.universeRange.toBlock, readyView!.ready.cutoff.number);
}
const env = readFileSync(envFile, "utf8");
const rpcUrl = env.split(/\r?\n/).find(l => /^(?:export\s+)?MAINNET_RPC_URL=/.test(l))?.replace(/^(?:export\s+)?MAINNET_RPC_URL=/, "").replace(/^["']|["']$/g, "");
assert(rpcUrl);
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
assert.equal(receipt.transactionHash, sample.tx); assert.equal(receipt.status, "0x1");
const N = Number(BigInt(receipt.blockNumber));
assert.equal(receipt.blockHash, sample.states.find(s => s.block === N)!.blockHash);
if (readyView) assert.equal(readyView.ready.cutoff.number, N);
const owner = "0x1000000000000000000000000000000000000001", executor = "0x1000000000000000000000000000000000000002";
const bought = receipt.logs.filter((log: any) => log.topics[0] === POOL.getEvent("Bought")!.topicHash)
  .filter((log: any) => {
    assert.equal(log.transactionHash, receipt.transactionHash); assert.equal(log.blockHash, receipt.blockHash);
    assert.equal(log.blockNumber, receipt.blockNumber); assert.equal(log.removed, false);
    const e = POOL.decodeEventLog("Bought", log.data, log.topics);
    return e.isBuy && BigInt(e.amountIn) === BigInt(sample.amountIn) && same(log.address, e.exchange);
  });
assert.equal(bought.length, 1); const receiptPool = bought[0].address;
if (saved) assertAcceptanceBinding({ saved: priceInput, readyPath: readyPath!, readySha256: sha(readyBytes!),
  source: readyView!.ready.cutoff, executor, owner });
const nativeObserver = "0x1000000000000000000000000000000000000003";
// Test-only balanceOf(address) observer: CALLDATALOAD(4), BALANCE, return word.
// Lets the unchanged production executor assert native conservation too;
// otherwise wrapping exactly the quote could conceal surplus native output.
const nativeObserverCode = "0x6004353160005260206000f3";
let port: number;
let count = 0;
const results: unknown[] = [];
let constructing = false, constructionRpcAttempts = 0, completed = false;
async function rpc(method: string, params: unknown[]): Promise<any> {
  if (constructing) { constructionRpcAttempts++; throw new Error("runtime construction used RPC"); }
  assert(++count <= 480, "bounded local fork RPC budget");
  assert(!/sendTransaction|sendRawTransaction|mine|impersonate/i.test(method), "execution check never submits/mines");
  const r = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: count, method, params }), signal: AbortSignal.timeout(30000) });
  assert(r.ok, `local HTTP ${r.status}`); const v = await r.json() as any;
  if (v.error) throw Object.assign(new Error(`local ${method} RPC ${v.error.code}`), { rpc: v.error });
  return v.result;
}
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
let code: string = artifact.deployedBytecode.object;
const refs = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
assert.equal(refs.length, 1);
for (const ref of refs[0]) { assert.equal(ref.length, 32); const start = 2 + ref.start * 2;
  code = code.slice(0, start) + ethers.zeroPadValue(owner, 32).slice(2) + code.slice(start + 64); }
// Artifact must be compiled from the current production executor sources.
const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
for (const [file, info] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) {
  const root = new URL("../../../../../../../", import.meta.url);
  assert.equal(ethers.keccak256(readFileSync(new URL(file, root))), info.keccak256, `stale artifact source ${file}`);
}
const compile = (node: ResolvedPlanNode): Uint8Array => {
  const action = actions.find(a => a.id === node.adapterId); assert(action);
  return action.encode(node, executor, concatBytes(...node.children.map(compile)));
};
async function balanceSlot(token: string, at: string): Promise<string> {
  const data = TOKEN.encodeFunctionData("balanceOf", [executor]), marker = 123456789n;
  assert.equal(BigInt(await rpc("eth_call", [{ to: token, data }, at])), 0n, "fresh output/input actor");
  const access = await rpc("eth_createAccessList", [{ from: owner, to: token, data, gas: "0x100000" }, at]);
  const candidates: string[] = (access.accessList ?? []).filter((a: any) => same(a.address, token)).flatMap((a: any) => a.storageKeys);
  for (let slot = 0; slot < 8; slot++) candidates.push(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [executor, slot])));
  for (const slot of [...new Set(candidates)].slice(0, 12)) {
    const out = await rpc("eth_call", [{ to: token, data }, at, { [token]: { stateDiff: { [slot]: ethers.toBeHex(marker, 32) } } }]);
    if (BigInt(out) === marker) return slot;
  }
  throw new Error("actor balance slot not proven");
}
// Select a free task-local port rather than resetting an unrelated local fork.
port = await new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address(); assert(address && typeof address !== "string");
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const fork = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--fork-url", rpcUrl,
  "--fork-block-number", String(N), "--no-mining", "--silent"], { stdio: "ignore" });
let launchError = false; fork.once("error", () => { launchError = true; });
try {
  let connected = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (launchError || fork.exitCode !== null) throw new Error("task fork failed to start");
    try { connected = await rpc("eth_chainId", []) === "0x1"; if (connected) break; } catch {}
    await delay(500);
  }
  assert(connected, "local fork unavailable");
  for (const block of readyView ? [N] : [N, N - 1]) {
    if (block !== N) await rpc("anvil_reset", [{ forking: { jsonRpcUrl: rpcUrl, blockNumber: block } }]);
    const at = ethers.toQuantity(block), header = await rpc("eth_getBlockByNumber", [at, false]);
    assert.equal(Number(BigInt(header.number)), block);
    assert.equal(header.hash, sample.states.find(s => s.block === block)!.blockHash);
    const source: CanonicalSource = readyView?.ready.cutoff ?? { number: block, hash: header.hash, generation: 1 };
    assert.equal(source.number, block); assert.equal(source.hash, header.hash);
    await rpc("anvil_setCode", [executor, code]);
    await rpc("anvil_setBalance", [executor, "0x0"]);
    assert.equal(await rpc("eth_getCode", [nativeObserver, at]), "0x");
    await rpc("anvil_setCode", [nativeObserver, nativeObserverCode]);
    await rpc("anvil_setBalance", [owner, ethers.toQuantity(UNIT)]);
    assert.equal(BigInt(await rpc("eth_getBalance", [executor, at])), 0n);
    const nativeRead = { to: nativeObserver, data: TOKEN.encodeFunctionData("balanceOf", [executor]) };
    assert.equal(BigInt(await rpc("eth_call", [nativeRead, at])), 0n);
    assert.equal(BigInt(await rpc("eth_call", [nativeRead, at, { [executor]: { balance: "0x1" } }])), 1n,
      "native observer must distinguish zero from one actual native wei");
    const pin = (n?: number) => { assert.equal(n, block); return at; };
    const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner, provider: {
      call: (tx, n) => rpc("eth_call", [tx, pin(n)]), getCode: (a, n) => rpc("eth_getCode", [a, pin(n)]),
      getStorage: (a, s, n) => rpc("eth_getStorageAt", [a, s, pin(n)]),
    }, generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assertSource(s, source); } } });
    const family = catalog.forFamily(ELLA_ID);
    // N receipt supplies topology evidence. For B this is only a pinned
    // Family execution check, never claimed as natural B discovery.
    const observations = receipt.logs.map((log: any) => ({ kind: "log" as const, source, address: log.address, topics: log.topics, data: log.data }));
    const matches = observations.flatMap((observation: any) => catalog.matches(observation).filter(m => m.familyId === ELLA_ID)
      .map(m => ({ observation, matchedPatternId: m.patternId })));
    let instance: PreparedFamilyInstance;
    if (envelope) {
      const memos = activeReadyMemos(envelope).filter(m => m.familyId === ELLA_ID);
      assert.equal(memos.length, 1);
      assert(same(memos[0].instanceKey, receiptPool), "Ready Ella instance differs from receipt");
      const wiring = createRebuildWiring({ rpcUrl, familyIds: [ELLA_ID], executionIdentity: { executor, transactionOrigin: owner } });
      assert(wiring.isReadyMemoDefinitionCurrent?.(memos[0]), "stale Ella admission");
      instance = wiring.rehydrateVerifiedInstance({ memo: memos[0], cutoff: source }) as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    } else {
      const life = await executeAdapterFamilyLifecycleBatch({ family, matches, source, generation: source.generation, runtime, publisher: { publish() {} } });
      assert(life.publication, JSON.stringify(life.outcomes)); instance = life.publication.instances[0];
    }
    const descriptor = instance.descriptor as EllaDescriptor;
    assert(same(descriptor.pool, receiptPool), "execution descriptor differs from receipt");
    const graph = buildFamilyRouteGraphView({ routes: instance.routes.map((route, i) => ({ family, descriptor, route, handle: instance.routeHandles[i] })) });
    assert.equal(graph.edges.length, 2);
    const state = instance.pricingInstances[0].snapshot as EllaState;
    const buyCapacity = state.tokenBalance * state.price / UNIT, sellCapacity = state.nativeBalance * UNIT / state.price;
    const quotes: unknown[] = [];
    results.push({ block, blockHash: header.hash, stateRoot: header.stateRoot, executionBlock: block,
      discovery: readyView ? "natural-single-block-Ready" : block === N ? "real-N-receipt" : "N-topology-pinned-at-B",
      strict: "passed", graphEdges: graph.edges.length, quotes });
    const amounts: [number, bigint, string][] = [[0, buyCapacity / 100n, "legal-capacity-control"],
      [1, sellCapacity / 100n, "legal-reverse-capacity-control"], [0, BigInt(sample.amountIn), "original-tx-amount"]];
    if (saved) {
      for (let index = 0; index < instance.routes.length; index++) {
        const route = instance.routes[index];
        const edge = readyView!.graph.find(e => e.instanceKey === instance.instanceKey &&
          same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert(edge);
        const row = saved.runtime.pricing.effectiveMids.rows.get(blockScanEdgeKey(edge)); assert(row);
        assert(same(row.tokenIn, route.tokenIn) && same(row.tokenOut, route.tokenOut));
        requireProductionReference(row);
        amounts.push([index, row.amountIn, `production-effective:${row.status}`]);
      }
    } else amounts.push([0, DEFAULT_EFFECTIVE_WETH_INPUT, "production-default-P"]);
    for (const [index, amountIn, purpose] of amounts) {
      const route = instance.routeHandles[index];
      const q = await executeFamilyExactQuote({ family, route, amountIn, source, generation: source.generation, executor, runtimeEvidence: [], runtime });
      assert.equal(q.status, "resolved"); if (q.status !== "resolved") throw new Error("quote unresolved");
      if (saved && purpose.startsWith("production-effective:")) {
        const edge = readyView!.graph.find(e => e.instanceKey === instance.instanceKey && same(e.tokenIn, instance.routes[index].tokenIn)); assert(edge);
        const row = saved.runtime.pricing.effectiveMids.rows.get(blockScanEdgeKey(edge))!;
        if (row.status === "quoted") {
          assert.equal(row.quotedAt.number, block); assert.equal(row.quotedAt.hash, header.hash);
          assert.equal(row.amountOut, q.amountOut, "effective and same-state Exact must agree");
        } else assert.equal(q.amountOut, 0n, "unquoted reference cannot silently become accepted");
      }
      constructing = true;
      let leg: ReturnType<typeof buildFamilyRuntimeAmountLeg>;
      try {
        const input = { family, route, source, runtime, executor, runtimeEvidence: [], actionOwnership: catalog };
        for (const name of ["amountIn", "exact", "quotedAmountOut"])
          Object.defineProperty(input, name, { get() { throw new Error(`runtime construction read ${name}`); } });
        leg = buildFamilyRuntimeAmountLeg(input);
      } finally { constructing = false; }
      assert(leg); assert.equal(constructionRpcAttempts, 0);
      const runtimeScript = runtimeProgramScript(ethers.getBytes(leg.program), amountIn);
      if (q.amountOut === 0n) {
        // Negative control: no issued fragment is built for an unavailable
        // amount. The native contract call itself must reject that inventory.
        assert.equal(index, 0);
        let revertedForInventory = false;
        try { await rpc("eth_call", [{ from: owner, to: descriptor.pool, data: POOL.encodeFunctionData("swapBase1"),
          value: ethers.toQuantity(amountIn), gas: "0x300000" }, at]); }
        catch (error) { revertedForInventory = /No fund to execute the trade/.test(JSON.stringify((error as any).rpc)); }
        assert(revertedForInventory, "unavailable quote must match the contract inventory rejection");
        const slot = await balanceSlot(instance.routes[index].tokenIn, at);
        const tx = { from: owner, to: executor, gas: "0x500000", gasPrice: header.baseFeePerGas,
          data: buildExecuteCalldata(runtimeScript) };
        const overrides = { [instance.routes[index].tokenIn]: { stateDiff: { [slot]: ethers.toBeHex(amountIn, 32) } } };
        const trace = await rpc("debug_traceCall", [tx, at, { tracer: "callTracer", stateOverrides: overrides }]);
        assertInventoryRejection(trace, descriptor.pool, executor, amountIn);
        quotes.push({ purpose, amountIn: String(amountIn), amountOut: "0", execution: "contract-and-runtime-inventory-rejection",
          quotedExecution: "not constructed for unavailable amount", runtimeConstructionRpc: constructionRpcAttempts,
          rejectedRuntime: { tx, at, overrides, trace } }); continue;
      }
      const execution = buildFamilyExecutionFragment({ family, actionOwnership: catalog, route, exact: q, minAmountOut: q.amountOut, executor, runtimeEvidence: [] });
      assert.equal(execution.status, "resolved"); if (execution.status !== "resolved") throw new Error("fragment unresolved");
      const fragment = execution.fragment;
      const approvals: ResolvedPlanNode[] = fragment.requirements.map(requirement => {
        assert.equal(requirement.kind, "approve"); if (requirement.kind !== "approve") throw new Error("unexpected requirement");
        return { adapterId: "erc20-approve", target: requirement.token, tokenIn: requirement.token, tokenOut: requirement.token,
          amount: requirement.amount, params: { spender: requirement.spender }, children: [] };
      });
      const tokenIn = instance.routes[index].tokenIn, tokenOut = instance.routes[index].tokenOut;
      const slot = await balanceSlot(tokenIn, at);
      const outputSlot = await balanceSlot(tokenOut, at);
      assert.equal(BigInt(await rpc("eth_call", [{ to: tokenOut, data: TOKEN.encodeFunctionData("balanceOf", [executor]) }, at])), 0n);
      const script = concatBytes(...[...approvals, ...fragment.nodes].map(compile));
      const oldInput = 101n, oldOutput = 103n, oldNative = 107n;
      const overrides = { [tokenIn]: { stateDiff: { [slot]: ethers.toBeHex(amountIn + oldInput, 32) } },
        [tokenOut]: { stateDiff: { [outputSlot]: ethers.toBeHex(oldOutput, 32) } }, [executor]: { balance: ethers.toQuantity(oldNative) } };
      const transaction = (minimum: bigint, body = script, checkNative = false) => ({ from: owner, to: executor, gas: "0x500000", gasPrice: header.baseFeePerGas,
        data: buildExecuteCalldata(concatBytes(body, encodeAssertBalanceGte(tokenIn, oldInput),
          encodeAssertBalanceGte(tokenOut, oldOutput + minimum), encodeAssertBalanceGte(nativeObserver, oldNative),
          ...(checkNative ? [encodeAssertBalanceGte(nativeObserver, oldNative + 1n)] : []))) });
      for (const [mode, body] of [["quoted", script], ["runtime", runtimeScript]] as const) {
        await rpc("eth_call", [transaction(q.amountOut, body), at, overrides]);
        for (const [label, tx] of [["output+1", transaction(q.amountOut + 1n, body)],
          ["native+1", transaction(q.amountOut, body, true)],
          ["input+1", transaction(q.amountOut, concatBytes(body, encodeAssertBalanceGte(tokenIn, oldInput + 1n)))]] as const) {
          await assert.rejects(() => rpc("eth_call", [tx, at, overrides]),
            (error: any) => /min profit/.test(JSON.stringify(error.rpc)), `${mode} ${label} bound`);
        }
        await assert.rejects(() => rpc("eth_call", [transaction(0n, body), at,
          { ...overrides, [tokenIn]: { stateDiff: { [slot]: ethers.toBeHex(oldInput, 32) } } }]),
          (error: any) => !!error.rpc && /revert/i.test(JSON.stringify(error.rpc)), `${mode} missing-input control`);
      }
      await rpc("eth_call", [transaction(q.amountOut), at, overrides]);
      let guardReverted = false;
      try { await rpc("eth_call", [transaction(q.amountOut + 1n), at, overrides]); }
      catch (error) { guardReverted = /min profit/.test(JSON.stringify((error as any).rpc)); }
      assert(guardReverted, "received balance must be exactly quote, not at least quote");
      let nativeGuardReverted = false;
      try { await rpc("eth_call", [transaction(q.amountOut, script, true), at, overrides]); }
      catch (error) { nativeGuardReverted = /min profit/.test(JSON.stringify((error as any).rpc)); }
      assert(nativeGuardReverted, "valid fragment must leave exactly zero native wei");
      if (index === 1) {
        // Lowering the minimum must not fix the wrap quantity: the central
        // boundary still returns the full actual receipt and restores native.
        assert.equal(fragment.nodes.length, 1);
        assert.equal(fragment.nodes[0].adapterId, "execution-asset-boundary");
        const withMinimum = (minimum: bigint) => concatBytes(...[...approvals,
          { ...fragment.nodes[0], params: { ...fragment.nodes[0].params, minAmountOut: minimum } }].map(compile));
        const lowerMinimum = q.amountOut - 1n;
        assert(lowerMinimum > 0n);
        const lowerScript = withMinimum(lowerMinimum);
        await rpc("eth_call", [transaction(q.amountOut, lowerScript), at, overrides]);
        let upperBoundReverted = false;
        try { await rpc("eth_call", [transaction(q.amountOut + 1n, lowerScript), at, overrides]); }
        catch (error) { upperBoundReverted = /min profit/.test(JSON.stringify((error as any).rpc)); }
        assert(upperBoundReverted, "lower minimum must still return exactly the actual quote");
        let residualReverted = false;
        try { await rpc("eth_call", [transaction(q.amountOut, lowerScript, true), at, overrides]); }
        catch (error) { residualReverted = /min profit/.test(JSON.stringify((error as any).rpc)); }
        assert(residualReverted, "lower minimum must not leave residual native wei");
        await assert.rejects(() => rpc("eth_call", [transaction(0n, withMinimum(q.amountOut + 1n)), at, overrides]),
          (error: any) => !!error.rpc && /revert/i.test(JSON.stringify(error.rpc)),
          "the boundary itself must reject a minimum above the actual receipt");
      }
      quotes.push({ purpose, direction: index === 0 ? "WETH->token" : "token->WETH", amountIn: String(amountIn), amountOut: String(q.amountOut),
        execution: "same-block-local-fork-quoted-and-runtime-pass",
        balanceEquality: "input old101, output old103+quote and native old107 equality checked independently; +1 bounds and missing-input reject",
        runtimeConstructionRpc: constructionRpcAttempts,
        ...(index === 1 ? { minimumControl: "lower minimum preserves full WETH receipt and old native; receipt+1 minimum reverts" } : {}),
        scriptHash: ethers.keccak256(script), runtimeScriptHash: ethers.keccak256(runtimeScript) });
      if (block === N - 1 && purpose === "original-tx-amount") assert.equal(q.amountOut, BigInt(sample.netAmountOut));
    }
    console.log(JSON.stringify({ block, cases: quotes.length, completed: true }));
  }
  if (readyPath) assert.equal(sha(readFileSync(readyPath)), sha(readyBytes!));
  if (pricesPath) assert.equal(sha(readFileSync(pricesPath)), sha(priceBytes!));
  if (priceInputPath) assert.equal(sha(readFileSync(priceInputPath)), sha(priceInputBytes!));
  completed = true;
} finally {
  fork.kill("SIGTERM");
  writeFileSync(outputPath, JSON.stringify({ tx: sample.tx, backend: "task-local-anvil-eth_call", completed,
    broadcast: false, localRpcCalls: count, runtimeConstructionRpc: constructionRpcAttempts,
    readyPath, pricesPath, readySha256: readyBytes ? sha(readyBytes) : null, pricesSha256: priceBytes ? sha(priceBytes) : null,
    priceInputSha256: priceInputBytes ? sha(priceInputBytes) : null,
    artifactSha256: sha(readFileSync(artifactPath)), results }, null, 2), { flag: "wx" });
}
