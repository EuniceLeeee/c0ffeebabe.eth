import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/precision-pool.production.js";
import { readBlockTouchedStateKeys } from "../../../../blockscan-touched-state.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { address, FACTORY, MARKET_TYPE, marketTuple, normalizedToken, POOL, TOKEN, WETH } from "../codec.js";
import { ID, LINEAGE } from "../manifest.js";
import { decodeFactoryRuntime, decodePoolRuntime, FACTORY_IMMUTABLES, POOL_IMMUTABLES, POOL_INIT_CODE_HASH } from "../runtime.js";
import { decodeState, STATE_IDS } from "../state.js";
import { program } from "../exact.js";
import { binding } from "../instance.js";
import { hashCanonical } from "../../../canonical-value.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import type { Descriptor } from "../types.js";
import { runProgram } from "./runtime-machine.js";
import { applyRuntimeAssetBoundary } from "../../../../execution-asset-boundary.js";
const fixture = JSON.parse(readFileSync(new URL("./runtime-fixture.json", import.meta.url), "utf8"));
const pool = fixture.pool, executor = "0x1000000000000000000000000000000000000011";
const source = { number: 26129175, hash: "0x" + "11".repeat(32), generation: 1 };
const p = decodePoolRuntime(fixture.poolRuntime)!, f = decodeFactoryRuntime(fixture.factoryRuntime)!;
const d: Descriptor = { familyId: ID, lineageId: LINEAGE, instanceKey: instanceKey(pool), pool, ...p, ...f,
  codeHash: ethers.keccak256(fixture.poolRuntime), factoryCodeHash: ethers.keccak256(fixture.factoryRuntime), provenance: [], runtimeRequirements: [] };
const routePair = () => plugin.routes.project({ descriptor: d });
const candidate = { candidateKind: "precision-pool" as const, pool };
const encode = (n: bigint | string) => ethers.toBeHex(BigInt(n), 32);
const result = (id: string, data: string) => ({ id, data, source, ok: true as const, completion: "returned" as const,
  provenance: { kind: "fixture-only", fingerprint: "not-chain-admission" } });
function mutate(code: string, positions: readonly number[], value: bigint) {
  const bytes = ethers.getBytes(code); for (const offset of positions) bytes.set(ethers.getBytes(encode(value)), offset); return ethers.hexlify(bytes);
}
function identityData(id: string): string {
  if (id === "pool-code") return fixture.poolRuntime;
  if (id === "factory-code") return fixture.factoryRuntime;
  if (id === "creation-blob") return "0x00" + fixture.poolCreation.slice(2);
  if (id.startsWith("token-code")) return "0x6000";
  if (id.startsWith("decimals")) return encode(18n);
  if (id === "registered") return encode(1n);
  if (id === "reverse") return encode(pool);
  if (id.startsWith("pool-")) return encode(p[id.slice(5) as keyof typeof p]);
  return encode(f[id as keyof typeof f]);
}
function attest(overrides: Record<string, string> = {}, nominatedPool = pool) {
  const v = plugin.identity.variants[0]; let evidence: any;
  for (let round = 0; round < 3; round++) {
    const step = { candidate: { ...candidate, pool: nominatedPool }, evidence, step: round };
    const reqs = v.buildRequests(step);
    assert.deepEqual([...new Set(reqs.map(r => r.kind))].sort(), [...v.requirements(step).transports].sort());
    evidence = v.decode({ step, results: reqs.map(r => result(r.id, overrides[r.id] ?? identityData(r.id))) });
    const decision = v.decide({ ...step, evidence });
    if (decision.status !== "continue") return decision;
  }
  throw Error("identity did not terminate");
}
function stateRows(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = { "pool-code": fixture.poolRuntime, reserve0: encode(4602902969736305636n),
    reserve1: encode(32300201257123215153332n), totalSupply: encode(390735989515664243220n),
    balance0: encode(4602902969736305636n), balance1: encode(32300201257123215153332n),
    hookOwed0: encode(0n), hookOwed1: encode(0n), creatorOwed0: encode(0n), creatorOwed1: encode(0n) };
  return STATE_IDS.map(id => result(id, overrides[id] ?? values[id]));
}
const quoteInput = (amountIn = 27866654756646780718n) => ({ descriptor: d, route: routePair()[1], source, executor, amountIn, runtimeEvidence: [] });
const quoteRows = (amountOut = 3867961447751968n, fits = true) => [...stateRows(), result("quote", POOL.encodeFunctionResult("quoteExactIn", [amountOut, fits]))];

test("authenticated runtime, all factory immutable words, blob and complete reverse registration", () => {
  assert(p && f); assert.equal(ethers.keccak256(fixture.poolCreation), POOL_INIT_CODE_HASH);
  assert.equal(p.hook, ethers.ZeroAddress); assert.equal(p.creatorFeeBps, 0n);
  assert.equal(attest().status, "verified");
  for (const key of Object.keys(POOL_IMMUTABLES)) {
    const offsets = POOL_IMMUTABLES[key as keyof typeof POOL_IMMUTABLES];
    const changed = mutate(fixture.poolRuntime, [offsets[0]], BigInt(p[key as keyof typeof p]) + 1n);
    assert.equal(decodePoolRuntime(changed), null, key + " repeated immutable mismatch");
  }
  assert.equal(decodePoolRuntime("0x363d3d373d3d3d363d73" + d.factory.slice(2) + "5af43d82803e903d91602b57fd5bf3"), null);
  assert.equal(attest({ "factory-code": fixture.poolRuntime }).status, "chain-proven-rejected");
  assert.equal(attest({ registered: encode(0n) }).status, "chain-proven-rejected");
  assert.equal(attest({ reverse: encode(executor) }).status, "chain-proven-rejected");
  assert.equal(attest({ "pool-fee": encode(500n) }).status, "chain-proven-rejected");
  assert.equal(attest({ "creation-blob": fixture.poolCreation }).status, "chain-proven-rejected");
  assert.equal(attest({ "creation-blob": "0x006000" }).status, "chain-proven-rejected");
  assert.equal(attest({ "token-code-1": "0x" }).status, "chain-proven-rejected");
  assert.equal(attest({ "decimals-1": encode(78n) }).status, "chain-proven-rejected");
  assert.equal(decodeFactoryRuntime(mutate(fixture.factoryRuntime, FACTORY_IMMUTABLES.poolInitCodeHash, 1n)), null);
});
test("no instance allowlist: same certified implementation admits another CREATE2 Market", () => {
  const fee = 500n, next = { ...p, fee }, abi = ethers.AbiCoder.defaultAbiCoder();
  const newPool = ethers.getCreate2Address(p.factory, ethers.keccak256(abi.encode([MARKET_TYPE], [marketTuple(next)])),
    ethers.keccak256(ethers.concat([fixture.poolCreation, abi.encode(["address", MARKET_TYPE], [p.factory, marketTuple(next)])]))).toLowerCase();
  assert.notEqual(newPool, pool);
  assert.equal(attest({ "pool-code": mutate(fixture.poolRuntime, POOL_IMMUTABLES.fee, fee), "pool-fee": encode(fee), reverse: encode(newPool) }, newPool).status, "verified");
});
test("unknown runtime, nonzero hook/share and ETH-WETH alias are refused", () => {
  assert.equal(decodePoolRuntime(mutate(fixture.poolRuntime, POOL_IMMUTABLES.hook, BigInt(executor))), null);
  assert.equal(decodePoolRuntime(mutate(fixture.poolRuntime, POOL_IMMUTABLES.creatorFeeBps, 1n)), null);
  assert.equal(decodePoolRuntime(mutate(fixture.poolRuntime, POOL_IMMUTABLES.token1, BigInt(WETH))), null);
  assert.equal(decodePoolRuntime(mutate(fixture.poolRuntime, POOL_IMMUTABLES.sqrtPLow, 0n)), null);
  assert.equal(decodePoolRuntime(mutate(fixture.poolRuntime, POOL_IMMUTABLES.fee, 100000n)), null);
  const bytes = ethers.getBytes(fixture.poolRuntime); bytes[0] ^= 1;
  assert.equal(decodePoolRuntime(ethers.hexlify(bytes)), null);
  assert.equal(attest({ "pool-code": "0x" }).status, "chain-proven-rejected");
});
test("missing, reverted, duplicate, malformed or cross-source identity evidence cannot become a rejection proof", () => {
  const v = plugin.identity.variants[0], step = { candidate, step: 0 };
  for (const results of [[], [result("pool-code", fixture.poolRuntime), result("pool-code", fixture.poolRuntime)],
    [{ ...result("pool-code", "0x"), ok: false, failure: "rpc" }],
    [{ ...result("pool-code", fixture.poolRuntime), source: { ...source, number: -1 } }]]) {
    assert.throws(() => v.decode({ step, results: results as any }));
  }
  assert.throws(() => attest({ registered: encode(2n) }), /noncanonical|decode|overflow|value/);
  assert.throws(() => attest({ "pool-fee": encode(p.fee) + "00" }), /noncanonical|invalid length/);
});
test("native normalized graph has both directed routes with exact independent effects", () => {
  const pair = routePair();
  assert.deepEqual(pair.map(r => [r.tokenIn, r.tokenOut]), [[WETH, p.token1], [p.token1, WETH]]);
  assert.deepEqual(pair.map(r => r.executionAssets), [{ input: "native", output: "erc20" }, { input: "erc20", output: "native" }]);
  for (const route of pair) {
    assert(plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor, runtimeEvidence: [] }));
    const venue = plugin.routes.projectGraph!({ descriptor: d, route }).venueIdentity;
    assert(venue !== null && typeof venue === "object" && !Array.isArray(venue) && "kind" in venue);
    assert.equal(venue.kind, "address-pool");
    assert.throws(() => plugin.routes.projectGraph!({ descriptor: d, route: { ...route, tokenOut: executor } }), /incompatible route/);
    assert.throws(() => plugin.routes.projectGraph!({ descriptor: d, route: { ...route, executionAssets: undefined } }), /incompatible route/);
    assert.throws(() => plugin.routes.projectGraph!({ descriptor: d, route: { ...route, executionAssets: { input: "erc20", output: "erc20" } } }), /incompatible route/);
    const effects = plugin.execution.expectedEffects({ descriptor: d, route } as any);
    assert.deepEqual(effects.map(e => e.kind), ["token-delta", "token-delta"]);
  }
});
test("Exact request uses the actual executor and unchanged finite amount; no local amount model", () => {
  const i = quoteInput(), requests = program.buildRequests(i);
  const request = requests.find(r => r.id === "quote") as any;
  const args = POOL.decodeFunctionData("quoteExactIn", request.data);
  assert.deepEqual([...args].map(String), [ethers.getAddress(executor), ethers.getAddress(p.token1), String(i.amountIn)]);
  assert.equal(request.to, pool);
  const q = program.decode({ programInput: i, initialResults: quoteRows(), dependentEvidence: [] });
  assert.equal(q.amountOut, 3867961447751968n);
  assert.equal(q.evidence.amountIn, i.amountIn);
  assert.equal(plugin.exact.methods({ descriptor: d, route: i.route } as any)[1].kind, "request-program");
  assert.equal((plugin.exact.methods({ descriptor: d, route: i.route } as any)[1] as any).chainAmountQuote, true);
});
test("positive Exact request passes the production issuer and binds its declared caller", () => {
  const i = quoteInput();
  const declaration = {
    requirements: () => program.requirements(i),
    buildRequests: () => program.buildRequests(i),
    decode: () => null,
  };
  const declared = declareRequestProgram(declaration, i);
  const request = declared.requests.find(r => r.id === "quote");
  assert(request?.kind === "eth-call");
  assert.deepEqual(request.caller, { kind: "executor" });
  assert.throws(() => declareRequestProgram({ ...declaration,
    buildRequests: () => declared.requests.map(r => r.kind === "eth-call" ? { ...r, caller: undefined } : r),
  }, i), /caller requirement executor is not used/);
  assert.throws(() => declareRequestProgram({ ...declaration,
    buildRequests: () => declared.requests.map(r => r.kind === "eth-call" && r.id === "quote"
      ? { ...r, caller: { kind: "transaction-origin" as const } } : r),
  }, i), /does not match requirement executor/);
  const zero = quoteInput(0n);
  assert.deepEqual(declareRequestProgram({ requirements: () => program.requirements(zero),
    buildRequests: () => program.buildRequests(zero), decode: () => null }, zero).requests, []);
});
test("fits false at small or large input, zero output, excess output, malformed ABI and source drift fail closed", () => {
  for (const amount of [1n, 10n ** 38n]) assert.throws(() => program.decode({ programInput: quoteInput(amount),
    initialResults: quoteRows(0n, false), dependentEvidence: [] }), /does not fit/);
  for (const rows of [quoteRows(0n), quoteRows(10n ** 25n), [...stateRows(), result("quote", encode(1n) + encode(2n).slice(2))],
    quoteRows().map(r => ({ ...r, source: { ...source, hash: "0x" + "22".repeat(32) } }))])
    assert.throws(() => program.decode({ programInput: quoteInput(), initialResults: rows, dependentEvidence: [] }));
  assert.equal(program.decode({ programInput: quoteInput(0n), initialResults: [], dependentEvidence: [] }).amountOut, 0n);
  assert.throws(() => program.buildRequests(quoteInput(-1n)), /overflow/);
  assert.throws(() => program.buildRequests(quoteInput(1n << 256n)), /overflow/);
});
test("current state verifies backing, code and zero owed; mid includes floored supply-derived virtual reserves", () => {
  const s = decodeState(d, stateRows(), source), pair = routePair();
  const m = plugin.pricing.current.deriveMids({ descriptor: d, snapshot: s, routes: pair });
  const expected = Number((s.reserve1 + s.supply * d.sqrtPLow / 10n ** 18n) * (1000000n - d.fee)) /
    Number((s.reserve0 + s.supply * 10n ** 18n / d.sqrtPHigh) * 1000000n);
  assert.equal(m.get(pair[0].routeKey)!.mid, expected);
  const badState: Record<string, string>[] = [{ balance0: encode(0n) }, { hookOwed1: encode(1n) }, { creatorOwed0: encode(1n) },
    { reserve0: encode(1n << 128n) }, { "pool-code": "0x6000" }];
  for (const overrides of badState) assert.throws(() => decodeState(d, stateRows(overrides)));
  const changed = plugin.pricing.current.deriveMids({ descriptor: d, snapshot: { ...s, supply: s.supply * 2n }, routes: pair });
  assert.notEqual(changed.get(pair[0].routeKey)!.mid, m.get(pair[0].routeKey)!.mid);
});
test("production touched reader consumes compiled token dependencies even without a pool call/log", async () => {
  const pair = routePair(), dependencies = plugin.pricing.dependencies({ descriptor: d, routes: pair });
  const index = plugin.pricing.mutation!.compile!({ entries: [{ descriptor: d, routes: pair, dependencies, stateKey: pool }] });
  const anchor = { hash: source.hash, parentHash: "0x" + "33".repeat(32), transactionHashes: [] };
  const reader = async (target: string) => readBlockTouchedStateKeys({ getLogs: async () => [{ address: target, topics: [], data: "0x", blockHash: source.hash }],
    send: async () => [] }, source.number, executor, anchor, undefined,
    (o, b) => index.affectedStateKeys({ observation: { ...o, source: { ...source, ...b } } }));
  assert((await reader(d.token1)).has(pool));
  assert(!(await reader(executor)).has(pool));
  assert(!dependencies.includes(ethers.ZeroAddress));
});
test("discovery is strict canonical event/call nomination, not admission", () => {
  const data = POOL.encodeFunctionData("swapExactIn", [p.token1, 7n, 1n, executor]);
  const o = { kind: "call" as const, target: pool, data, source };
  assert.equal(plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: "precision-pool-exact-in" })?.pool, pool);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...o, data: data + "00" }, matchedPatternId: "precision-pool-exact-in" }), null);
  const ev = POOL.encodeEventLog(POOL.getEvent("Swap")!, [p.token1, 7n, 2n, executor]);
  assert.equal(plugin.discovery.decodeCandidate({ observation: { kind: "log", address: pool, ...ev, source }, matchedPatternId: "precision-pool-Swap" })?.pool, pool);
});
for (const forward of [true, false]) test("runtime measured receipt, old inventory isolation and exact input debit: " + (forward ? "native-in" : "native-out"), () => {
  const route = routePair()[forward ? 0 : 1], amountIn = 1000n, amountOut = 777n;
  const i = { descriptor: d, route, executor, runtimeEvidence: [], amountIn, quotedAmountOut: amountOut, minAmountOut: amountOut,
    exactEvidence: { kind: "precision-pool-chain-quote" as const, source, executor, routeKey: route.routeKey,
      binding: hashCanonical(binding(d)), amountIn, amountOut } };
  const node = plugin.execution.buildFragment(i).nodes[0];
  const script = plugin.actionAdapters[0].encode(node, executor, new Uint8Array());
  assert.equal(script[0], 0x0e);
  const raw = script.slice(36); // opcode + uint256 seed + uint24 length
  const runtime = ethers.getBytes(applyRuntimeAssetBoundary({ route, executor,
    leg: { actionAdapterId: node.adapterId, program: ethers.hexlify(raw) } }).program);
  const input = { pool, executor, rawIn: forward ? p.token0 : p.token1, rawOut: forward ? p.token1 : p.token0,
    amountIn, amountOut, nativeBaseline: 991n, oldOutput: 888888n, wrapped: true };
  const receipt = runProgram(runtime, input);
  assert.equal(receipt.outputDelta, amountOut); assert.equal(receipt.nativeBalance, input.nativeBaseline);
  assert.equal(receipt.spent, amountIn);
  assert.equal(receipt.allowances, forward ? 0 : 1);
  assert.deepEqual(receipt.swapInput, amountIn);
  assert.throws(() => runProgram(runtime, { ...input, amountOut: amountOut - 1n }), /uint256|minimum/);
  assert.throws(() => runProgram(runtime, { ...input, deliveredOut: amountOut - 1n }), /uint256/);
  assert.throws(() => runProgram(runtime, { ...input, spent: amountIn - 1n }), /mismatch/);
  if (forward) assert.throws(() => runProgram(runtime, { ...input, nativeResidue: 1n }), /mismatch|uint256/);
  else assert.equal(runProgram(runtime, { ...input, nativeResidue: 1n }).outputDelta, amountOut + 1n);
  assert.throws(() => plugin.execution.buildFragment({ ...i, amountIn: amountIn + 1n }), /incompatible execution/);
  assert.throws(() => plugin.actionAdapters[0].encode({ ...node, tokenOut: executor }, executor, new Uint8Array()), /invalid action/);
});
test("same register program also supports ERC20/ERC20 without wrapping", () => {
  const token0 = "0x1000000000000000000000000000000000000001";
  const spec = { ...d, token0 }, route = plugin.routes.project({ descriptor: spec })[0];
  const leg = plugin.execution.buildRuntimeLeg!({ descriptor: spec, route, executor, runtimeEvidence: [] })!;
  const receipt = runProgram(ethers.getBytes(leg.program), { pool, executor, rawIn: token0, rawOut: p.token1,
    amountIn: 55n, amountOut: 83n, nativeBaseline: 90n, oldOutput: 100000n });
  assert.equal(receipt.outputDelta, 83n); assert.equal(receipt.nativeBalance, 90n); assert.equal(receipt.allowances, 1);
});
