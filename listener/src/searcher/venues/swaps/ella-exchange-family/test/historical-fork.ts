import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ethers } from "ethers";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog,
  PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS as actions } from "../../../production-family-composition.js";
import { executeAdapterFamilyLifecycleBatch, executeFamilyExactQuote, buildFamilyExecutionFragment } from "../../../adapter-family-runtime.js";
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

const arg = (name: string) => { const n = process.argv.indexOf(name); assert(n >= 0 && process.argv[n + 1], `${name} required`); return process.argv[n + 1]; };
const envFile = arg("--env-file"), artifactPath = arg("--artifact"), receiptPath = arg("--receipt"), outputPath = arg("--out");
const env = readFileSync(envFile, "utf8");
const rpcUrl = env.split(/\r?\n/).find(l => /^(?:export\s+)?MAINNET_RPC_URL=/.test(l))?.replace(/^(?:export\s+)?MAINNET_RPC_URL=/, "").replace(/^["']|["']$/g, "");
assert(rpcUrl);
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
assert.equal(receipt.transactionHash, sample.tx); assert.equal(receipt.status, "0x1");
const N = Number(BigInt(receipt.blockNumber));
const owner = "0x1000000000000000000000000000000000000001", executor = "0x1000000000000000000000000000000000000002";
const nativeObserver = "0x1000000000000000000000000000000000000003";
// Test-only balanceOf(address) observer: CALLDATALOAD(4), BALANCE, return word.
// Lets the unchanged production executor assert native conservation too;
// otherwise wrapping exactly the quote could conceal surplus native output.
const nativeObserverCode = "0x6004353160005260206000f3";
let port: number;
let count = 0;
const results: unknown[] = [];
async function rpc(method: string, params: unknown[]): Promise<any> {
  assert(++count <= 240, "bounded local fork RPC budget");
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
  for (const block of [N, N - 1]) {
    if (block !== N) await rpc("anvil_reset", [{ forking: { jsonRpcUrl: rpcUrl, blockNumber: block } }]);
    const at = ethers.toQuantity(block), header = await rpc("eth_getBlockByNumber", [at, false]);
    assert.equal(Number(BigInt(header.number)), block);
    assert.equal(header.hash, sample.states.find(s => s.block === block)!.blockHash);
    const source: CanonicalSource = { number: block, hash: header.hash, generation: 1 };
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
    const runtime = createStrictCentralAdapterRuntime({ executor, provider: {
      call: (tx, n) => rpc("eth_call", [tx, pin(n)]), getCode: (a, n) => rpc("eth_getCode", [a, pin(n)]),
      getStorage: (a, s, n) => rpc("eth_getStorageAt", [a, s, pin(n)]),
    }, generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assertSource(s, source); } } });
    const family = catalog.forFamily(ELLA_ID);
    // N receipt supplies topology evidence. For B this is only a pinned
    // Family execution check, never claimed as natural B discovery.
    const observations = receipt.logs.map((log: any) => ({ kind: "log" as const, source, address: log.address, topics: log.topics, data: log.data }));
    const matches = observations.flatMap((observation: any) => catalog.matches(observation).filter(m => m.familyId === ELLA_ID)
      .map(m => ({ observation, matchedPatternId: m.patternId })));
    const life = await executeAdapterFamilyLifecycleBatch({ family, matches, source, generation: 1, runtime, publisher: { publish() {} } });
    assert(life.publication, JSON.stringify(life.outcomes));
    const instance = life.publication.instances[0], descriptor = instance.descriptor as EllaDescriptor;
    const graph = buildFamilyRouteGraphView({ routes: instance.routes.map((route, i) => ({ family, descriptor, route, handle: instance.routeHandles[i] })) });
    assert.equal(graph.edges.length, 2);
    const state = instance.pricingInstances[0].snapshot as EllaState;
    const buyCapacity = state.tokenBalance * state.price / UNIT, sellCapacity = state.nativeBalance * UNIT / state.price;
    const quotes: unknown[] = [];
    for (const [index, amountIn, purpose] of [[0, buyCapacity / 100n, "N-small-capacity-check"],
      [1, sellCapacity / 100n, "N-reverse-capacity-check"], [0, DEFAULT_EFFECTIVE_WETH_INPUT, "production-default-P"],
      [0, BigInt(sample.amountIn), "original-tx-amount"]] as const) {
      const route = instance.routeHandles[index];
      const q = await executeFamilyExactQuote({ family, route, amountIn, source, generation: 1, executor, runtimeEvidence: [], runtime });
      assert.equal(q.status, "resolved"); if (q.status !== "resolved") throw new Error("quote unresolved");
      if (q.amountOut === 0n) {
        // Negative control: no issued fragment is built for an unavailable
        // amount. The native contract call itself must reject that inventory.
        assert.equal(index, 0);
        let revertedForInventory = false;
        try { await rpc("eth_call", [{ from: owner, to: descriptor.pool, data: POOL.encodeFunctionData("swapBase1"),
          value: ethers.toQuantity(amountIn), gas: "0x300000" }, at]); }
        catch (error) { revertedForInventory = /No fund to execute the trade/.test(JSON.stringify((error as any).rpc)); }
        assert(revertedForInventory, "unavailable quote must match the contract inventory rejection");
        quotes.push({ purpose, amountIn: String(amountIn), amountOut: "0", execution: "contract-reverted-for-inventory-as-expected" }); continue;
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
      assert.equal(BigInt(await rpc("eth_call", [{ to: tokenOut, data: TOKEN.encodeFunctionData("balanceOf", [executor]) }, at])), 0n);
      const script = concatBytes(...[...approvals, ...fragment.nodes].map(compile));
      const overrides = { [tokenIn]: { stateDiff: { [slot]: ethers.toBeHex(amountIn, 32) } } };
      const transaction = (minimum: bigint, body = script, checkNative = false) => ({ from: owner, to: executor, gas: "0x500000", gasPrice: header.baseFeePerGas,
        data: buildExecuteCalldata(concatBytes(body, encodeAssertBalanceGte(tokenOut, minimum),
          ...(checkNative ? [encodeAssertBalanceGte(nativeObserver, 1n)] : []))) });
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
        // Deliberately misencode ONLY the wrap amount, not the pool call.
        // Token-only equality would falsely certify this underquote; the
        // independent native check must expose the one-wei residual.
        const underquoted = q.amountOut - 1n;
        assert(underquoted > 0n);
        const altered = fragment.nodes.map(node => node.adapterId === "weth-deposit-value"
          ? { ...node, amount: underquoted } : node);
        const badScript = concatBytes(...[...approvals, ...altered].map(compile));
        await rpc("eth_call", [transaction(underquoted, badScript, true), at, overrides]);
        let upperBoundReverted = false;
        try { await rpc("eth_call", [transaction(q.amountOut, badScript), at, overrides]); }
        catch (error) { upperBoundReverted = /min profit/.test(JSON.stringify((error as any).rpc)); }
        assert(upperBoundReverted, "underquote control has exact quoted-minus-one WETH and residual native wei");
      }
      quotes.push({ purpose, direction: index === 0 ? "WETH->token" : "token->WETH", amountIn: String(amountIn), amountOut: String(q.amountOut),
        execution: "same-block-local-fork-pass", balanceEquality: "GTE quote succeeds; GTE quote+1 reverts; native balance is zero",
        ...(index === 1 ? { underquoteControl: "wrap quote-1 leaves one native wei; token-only equality is insufficient" } : {}),
        scriptHash: ethers.keccak256(script) });
      if (block === N - 1 && purpose === "original-tx-amount") assert.equal(q.amountOut, BigInt(sample.netAmountOut));
    }
    results.push({ block, blockHash: header.hash, executionBlock: block, discovery: block === N ? "real-N-receipt" : "N-topology-pinned-at-B",
      strict: "passed", graphEdges: graph.edges.length, quotes });
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  fork.kill("SIGTERM");
  writeFileSync(outputPath, JSON.stringify({ tx: sample.tx, backend: "task-local-anvil-eth_call", broadcast: false, localRpcCalls: count, results }, null, 2));
}
