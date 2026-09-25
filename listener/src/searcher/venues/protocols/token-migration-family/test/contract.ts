import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/token-migration.production.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import type { Candidate } from "../types.js";
import { ABI, ERC20, IMMUTABLES, MAX, calculate, verifyRuntime, resultSet } from "../codec.js";
import { LOG_ID, TOPIC } from "../discovery.js";
import { decodeQuote } from "../state.js";
import { action } from "../action.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from "../../../../strict-production-runtime-session.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { executeFamilyExactQuote } from "../../../adapter-family-runtime.js";
import { FAMILY } from "../manifest.js";
import { buildEffectiveMids, DEFAULT_EFFECTIVE_WETH_INPUT } from "../../../../blockscan-effective-mid.js";
import { createVerifiedGraphView } from "../../../blockscan-state-capability.js";

// Explicit read-only public evidence input; no RPC, fixtures promoted to chain
// acceptance, or copies of raw receipts committed to the repository.
const cache = process.env.TOKEN_MIGRATION_EVIDENCE_DIR;
if (!cache) throw new Error("TOKEN_MIGRATION_EVIDENCE_DIR must name the cached coffee corpus");
const TX = "0x576dcfa02ef2f8c2a2038ed17070e14a757c9c2e0b2e19b2de65ff65b9e7c583";
const TARGET = ethers.getAddress("0x5c30d7494da55e23f62130c642c22af1814ef65d");
const raw = JSON.parse(readFileSync(join(cache, "raw", `${TX}.json`), "utf8"));
const html = readFileSync(join(cache, "contracts", `${TARGET.toLowerCase()}.html`), "utf8");
const runtime = html.slice(html.indexOf("Deployed Bytecode")).match(/0x[0-9a-fA-F]{200,}/)![0];
const constructor = html.slice(html.indexOf("Constructor Arguments")).match(/<pre[^>]*>([0-9a-f]{320})/)![1];
const args = ethers.AbiCoder.defaultAbiCoder().decode(["address", "address", "address", "uint256", "uint256"], `0x${constructor}`);
const binding = { tokenIn: String(args[0]), tokenOut: String(args[1]), numerator: BigInt(args[3]), denominator: BigInt(args[4]) };
const SOURCE: CanonicalSource = { number: Number(BigInt(raw.receipt.blockNumber)), hash: raw.receipt.blockHash, generation: 1 };
const EXECUTOR = ethers.getAddress("0x1000000000000000000000000000000000000002");
const FOREIGN = ethers.getAddress("0x1000000000000000000000000000000000000003");
const AMOUNT = 24496647146421036380821n;
const OUT = 1071728312n;
const success = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, ok: true, completion: "returned", data, source: SOURCE,
  provenance: { kind: "fixture", fingerprint: "token-migration-offline-contract" } });
const w = (n: bigint) => ethers.toBeHex(n, 32);
function patchRuntime(b = binding) {
  const bytes = ethers.getBytes(runtime);
  for (const key of Object.keys(IMMUTABLES) as (keyof typeof IMMUTABLES)[]) {
    for (const offset of IMMUTABLES[key]) bytes.set(ethers.getBytes(w(BigInt(b[key]))), offset);
  }
  return ethers.hexlify(bytes);
}
function fixture(b = binding, target = TARGET) {
  let halted = false, inventory = OUT * 1000n;
  const amounts: bigint[] = [];
  function answer(r: AdapterRequest): AdapterRequestResult {
    if (r.kind === "get-code") return success(r.id, r.id === "code" ? patchRuntime(b) : "0x60006000");
    if (r.kind !== "eth-call") throw new Error(`unexpected request ${r.kind}`);
    if (r.id.endsWith("decimals")) return success(r.id, w(r.id === "input-decimals" ? 18n : 6n));
    if (r.id === "inventory") {
      assert.equal(r.to.toLowerCase(), b.tokenOut.toLowerCase());
      assert.equal(String(ERC20.decodeFunctionData("balanceOf", r.data)[0]).toLowerCase(), target.toLowerCase());
      return success(r.id, w(inventory));
    }
    assert.equal(r.to.toLowerCase(), target.toLowerCase());
    const fn = ABI.parseTransaction({ data: r.data })!;
    const values: Record<string, string | bigint | boolean> = {
      BIT_TOKEN_ADDRESS: b.tokenIn, MNT_TOKEN_ADDRESS: b.tokenOut, TOKEN_CONVERSION_NUMERATOR: b.numerator,
      TOKEN_CONVERSION_DENOMINATOR: b.denominator, halted,
    };
    if (fn.name === "tokenMigrationAmountToReceive") {
      const amount = BigInt(fn.args[0]); amounts.push(amount);
      return success(r.id, w(calculate(amount, b.numerator, b.denominator)));
    }
    return success(r.id, ABI.encodeFunctionResult(fn.name, [values[fn.name]]));
  }
  return { answer, amounts, halt: (value: boolean) => { halted = value; }, fund: (value: bigint) => { inventory = value; } };
}
function identify(f = fixture(), c: Candidate = { candidateKind: "token-migration", target: TARGET }, override?: (r: AdapterRequest) => AdapterRequestResult) {
  const v = plugin.identity.variants[0]; let evidence: unknown;
  for (let step = 0; step < 4; step++) {
    const input = { candidate: c, step, evidence };
    const decision = v.decide(input);
    if (decision.status !== "continue") return decision;
    evidence = v.decode({ step: input, results: v.buildRequests(input).map(override ?? f.answer) });
  }
  throw new Error("identity did not terminate");
}
function setup(b = binding, target = TARGET) {
  const f = fixture(b, target);
  const decision = identify(f, { candidateKind: "token-migration", target });
  assert(decision.status === "verified");
  const identity = decision.identity;
  const descriptor = plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
  const route = plugin.routes.project({ descriptor })[0];
  return { f, descriptor, route };
}
function quote(s = setup(), amountIn = AMOUNT) {
  const input = { descriptor: s.descriptor, route: s.route, amountIn, source: SOURCE, executor: EXECUTOR, runtimeEvidence: [] };
  const method = plugin.exact.methods(input)[0]; assert(method.kind === "request-program");
  const requests = method.program.buildRequests(input), results = requests.map(s.f.answer);
  const result = method.program.decode({ programInput: input, initialResults: results, dependentEvidence: [] });
  return { input, method, requests, results, result };
}
function fragment(s = setup()) {
  const q = quote(s);
  const input = { ...q.input, quotedAmountOut: q.result.amountOut, minAmountOut: q.result.amountOut, exactEvidence: q.result.evidence };
  return { input, fragment: plugin.execution.buildFragment(input) };
}

test("cached receipt and trace bind Ethereum N and actual ACX/USDC, not names", () => {
  assert.equal(Number(BigInt(raw.tx.chainId)), 1); assert.equal(raw.receipt.status, "0x1");
  assert.equal(raw.receipt.transactionHash, TX); assert.equal(raw.tx.hash, TX);
  assert.equal(raw.tx.blockHash, SOURCE.hash); assert.equal(Number(BigInt(raw.tx.blockNumber)), SOURCE.number);
  assert.equal(SOURCE.number, 26029585);
  assert.equal(SOURCE.hash, "0x7d657e10588fe0327698837441079dc5568813e20a53057ae806a28ab210dead");
  assert.equal(binding.tokenIn.toLowerCase(), "0x44108f0223a3c3028f5fe7aec7f9bb2e66bef82f");
  assert.equal(binding.tokenOut.toLowerCase(), "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.equal(binding.numerator, 43750n); assert.equal(binding.denominator, 10n ** 18n);
  const logs = raw.receipt.logs.filter((l: {address: string}) => l.address === TARGET.toLowerCase());
  assert.equal(logs.length, 1);
  const parsed = ABI.decodeEventLog("TokensMigrated", logs[0].data, logs[0].topics);
  assert.equal(parsed[1], AMOUNT); assert.equal(parsed[2], OUT);
  const calls: any[] = [];
  const walk = (c: any) => { if (c.to === TARGET.toLowerCase()) calls.push(c); for (const child of c.calls ?? []) walk(child); };
  walk(raw.trace); assert.equal(calls.length, 1); assert.equal(calls[0].input, ABI.encodeFunctionData("migrateAllBIT"));
  const transferFrom = calls[0].calls[1], payout = calls[0].calls[2];
  assert.equal(transferFrom.to, binding.tokenIn.toLowerCase()); assert.equal(payout.to, binding.tokenOut.toLowerCase());
  assert.equal(BigInt(`0x${transferFrom.input.slice(-64)}`), AMOUNT); assert.equal(BigInt(`0x${payout.input.slice(-64)}`), OUT);
  assert.equal(parsed[0].toLowerCase(), calls[0].from);
});
test("immutable offsets independently agree with creation patch stores", () => {
  const creation = ethers.getBytes(`0x${html.match(/id='verifiedbytecode2'>([0-9a-f]+)/)![1]}`);
  // Creation copies runtime then fills constructor immutables by ADD/MSTORE.
  const stores: number[] = [];
  for (let pc = 371; pc < 469; pc++) {
    if (creation[pc] === 0x61 && creation[pc + 3] === 0x01 && creation[pc + 4] === 0x52) stores.push(creation[pc + 1] * 256 + creation[pc + 2]);
  }
  assert.deepEqual(stores.sort((a,b) => a-b), Object.values(IMMUTABLES).flat().sort((a,b) => a-b));
  assert(verifyRuntime(runtime, binding));
});
test("runtime behavior generalizes across instance/token/rate bindings; unknown runtime rejects", () => {
  const b = { tokenIn: EXECUTOR, tokenOut: FOREIGN, numerator: 7n, denominator: 3n };
  const s = setup(b, FOREIGN); assert.equal(s.descriptor.tokenIn, EXECUTOR); assert.equal(s.descriptor.numerator, 7n);
  assert.equal(quote(s, 11n).result.amountOut, 25n);
  const f = fixture();
  for (const code of ["0x", "0x60006000", `${runtime.slice(0, -2)}00`]) {
    const d = identify(f, undefined, r => r.id === "code" ? success(r.id, code) : f.answer(r));
    assert.equal(d.status, "chain-proven-rejected");
  }
  const bytes = ethers.getBytes(runtime); bytes[IMMUTABLES.tokenIn[1] + 31] ^= 1;
  assert(!verifyRuntime(ethers.hexlify(bytes), binding));
  assert(!verifyRuntime(runtime, { ...binding, numerator: 1n }));
});
test("identity rejects bad token evidence; missing, reverted and mixed-source evidence cannot admit", () => {
  const f = fixture();
  const d = identify(f, undefined, r => r.id === "output-code" ? success(r.id, "0x") : f.answer(r));
  assert.equal(d.status, "chain-proven-rejected");
  assert.throws(() => identify(f, undefined, r => r.id === "code" ? { id: r.id, ok: false, failure: "rpc", source: SOURCE } : f.answer(r)), /unresolved/);
  assert.throws(() => identify(f, undefined, r => r.id === "input-code" ? { ...f.answer(r), source: { ...SOURCE, number: SOURCE.number + 1 } } : f.answer(r)), /foreign source/);
  assert.throws(() => identify(f, undefined, r => r.id === "code" ? { ...success(r.id, runtime), completion: "reverted-as-declared" } : f.answer(r)), /did not return/);
  assert.throws(() => identify(f, undefined, r => r.id === "input-decimals" ? success(r.id, w(78n)) : f.answer(r)), /scale/);
  assert.throws(() => resultSet([success("x", w(1n)), success("x", w(1n))], ["x", "y"]), /duplicate/);
});
test("natural call and log nominations decode narrowly without granting identity", () => {
  for (const name of ["migrateAllBIT", "migrateBIT"]) {
    const data = ABI.encodeFunctionData(name, name === "migrateBIT" ? [AMOUNT] : []);
    const observation = { kind: "call" as const, target: FOREIGN, data, source: SOURCE };
    const decode = (o = observation) => plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: `token-migration-${name}` });
    assert.equal(decode()!.target, FOREIGN); assert.equal(decode({ ...observation, data: `${data}00` }), null);
    assert.equal(decode({ ...observation, data: `0xdeadbeef${data.slice(10)}` }), null);
  }
  const event = ABI.encodeEventLog(ABI.getEvent("TokensMigrated")!, [EXECUTOR, AMOUNT, OUT]);
  const observation = { kind: "log" as const, address: FOREIGN, ...event, source: SOURCE };
  const decode = (o = observation) => plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: LOG_ID });
  assert.equal(decode()!.target, FOREIGN);
  assert.equal(decode({ ...observation, topics: [ethers.ZeroHash, event.topics[1]] }), null);
  assert.equal(decode({ ...observation, topics: [TOPIC, `0x01${event.topics[1].slice(4)}`] }), null);
  assert.equal(decode({ ...observation, data: `${event.data}00` }), null);
});
test("one directed route and bound graph projection reject cross-instance/token reuse", () => {
  const s = setup(); assert.equal(plugin.routes.project({ descriptor: s.descriptor }).length, 1);
  assert.equal(s.route.tokenIn, binding.tokenIn); assert.equal(s.route.tokenOut, binding.tokenOut);
  assert.equal(plugin.routes.projectGraph({ descriptor: s.descriptor, route: s.route }).executionTarget, TARGET);
  for (const route of [{ ...s.route, tokenIn: binding.tokenOut }, { ...s.route, target: FOREIGN }]) {
    assert.throws(() => quote({ ...s, route }), /binding|bound/);
  }
});
test("chain quoter receives actual amounts, floors exactly, and checks overflow", () => {
  const s = setup(); assert.equal(quote(s).result.amountOut, OUT);
  assert.deepEqual(s.f.amounts, [AMOUNT]);
  assert.equal(quote(s, 10n ** 18n).result.amountOut, 43750n);
  assert.equal(calculate(11n, 7n, 3n), 25n);
  assert.equal(calculate(MAX / 7n, 7n, 3n), (MAX / 7n * 7n) / 3n);
  for (const amount of [-1n, 0n, MAX + 1n, MAX]) assert.throws(() => quote(s, amount), /positive|bounds/);
  assert.throws(() => quote(s, 1n), /zero output/);
});
test("halt and finite output inventory are dynamic, recoverable quote constraints", () => {
  const s = setup(); s.f.halt(true); assert.throws(() => quote(s), /halted/);
  s.f.halt(false); s.f.fund(OUT - 1n); assert.throws(() => quote(s), /inventory/);
  s.f.fund(OUT); assert.equal(quote(s).result.amountOut, OUT);
  const q = quote(s);
  assert.throws(() => decodeQuote(s.descriptor, AMOUNT, q.results.map(r => r.id === "amount-quote" ? success(r.id, w(OUT + 1n)) : r)), /disagrees/);
  assert.throws(() => decodeQuote(s.descriptor, AMOUNT, q.results.map(r => r.id === "halted" ? success(r.id, w(2n)) : r)), /boolean/);
  assert.throws(() => decodeQuote(s.descriptor, AMOUNT, q.results, { ...SOURCE, hash: ethers.ZeroHash }), /foreign source/);
});
test("pricing is pure; inventory-only and halt changes refresh declared state keys", () => {
  const s = setup();
  const draft = plugin.pricing.compileDraft({ descriptor: s.descriptor, routes: [s.route], stateKey: s.route.instanceKey });
  const descriptor = plugin.pricing.finalizePricingDescriptor({ draft, staticEvidence: undefined, sharedBindings: [] });
  const read = () => plugin.pricing.current.decodeSnapshot({ descriptor, initialResults: plugin.pricing.current.buildRequests({ descriptor, source: SOURCE, routes: [s.route] }).map(s.f.answer), dependentEvidence: [] });
  const snapshot = read(); const amounts = s.f.amounts.length;
  const mids = plugin.pricing.current.deriveMids({ descriptor, snapshot, routes: [s.route] });
  assert.equal(mids.size, 1); assert.equal(mids.get(s.route.routeKey)!.mid, 43750 / 1e18); assert.equal(s.f.amounts.length, amounts);
  const dependencies = plugin.pricing.dependencies({ descriptor, routes: [s.route] });
  const index = plugin.pricing.mutation!.compile!({ entries: [{ descriptor, routes: [s.route], stateKey: s.route.instanceKey, dependencies }] });
  for (const address of [TARGET, binding.tokenIn, binding.tokenOut]) {
    assert.deepEqual(index.affectedStateKeys({ observation: { kind: "log", address, topics: [], data: "0x", source: SOURCE } }), [s.route.instanceKey]);
  }
  assert.deepEqual(index.affectedStateKeys({ observation: { kind: "log", address: FOREIGN, topics: [], data: "0x", source: SOURCE } }), []);
  s.f.halt(true); assert.equal(plugin.pricing.current.deriveMids({ descriptor, snapshot: read(), routes: [s.route] }).size, 0);
  s.f.halt(false); s.f.fund(0n); assert.equal(plugin.pricing.current.deriveMids({ descriptor, snapshot: read(), routes: [s.route] }).size, 0);
  s.f.fund(OUT); assert.equal(plugin.pricing.current.deriveMids({ descriptor, snapshot: read(), routes: [s.route] }).size, 1);
});
test("execution encodes exact approve/pull/reset and no balance-wide migration or output sweep", () => {
  const built = fragment(); const node = built.fragment.nodes[0] as ResolvedPlanNode;
  assert.equal(built.fragment.nodes.length, 1);
  const bytes = action.encode(node, EXECUTOR, new Uint8Array());
  const calls: { target: string; data: string }[] = [];
  for (let pc = 0; pc < bytes.length;) {
    assert.equal(bytes[pc], 0); const length = bytes[pc + 21] * 65536 + bytes[pc + 22] * 256 + bytes[pc + 23];
    calls.push({ target: ethers.getAddress(ethers.hexlify(bytes.slice(pc + 1, pc + 21))), data: ethers.hexlify(bytes.slice(pc + 24, pc + 24 + length)) });
    pc += 24 + length;
  }
  assert.deepEqual(calls.map(c => c.target), [binding.tokenIn, binding.tokenIn, TARGET, binding.tokenIn]);
  assert.deepEqual([0, 1, 3].map(i => ERC20.decodeFunctionData("approve", calls[i].data)[1]), [0n, AMOUNT, 0n]);
  assert.equal(calls[2].data, ABI.encodeFunctionData("migrateBIT", [AMOUNT]));
  assert(!action.matchTrace(TARGET, ABI.getFunction("migrateAllBIT")!.selector));
  assert(action.matchTrace(TARGET, ABI.getFunction("migrateBIT")!.selector));
  assert.throws(() => action.encode({ ...node, amount: 0n }, EXECUTOR, new Uint8Array()), /invalid/);
  assert.throws(() => action.encode(node, EXECUTOR, new Uint8Array([1])), /invalid/);
});
test("execution rejects changed input/output/recipient/binding/min-output evidence", () => {
  const { input } = fragment();
  for (const bad of [{ ...input, amountIn: AMOUNT + 1n }, { ...input, quotedAmountOut: OUT + 1n },
    { ...input, executor: FOREIGN }, { ...input, minAmountOut: OUT + 1n },
    { ...input, exactEvidence: { ...input.exactEvidence, bindingFingerprint: ethers.ZeroHash } }]) {
    assert.throws(() => plugin.execution.buildFragment(bad), /incompatible/);
  }
});

test("production lifecycle and touched resolver consume this Family (synthetic transport only)", async () => {
  const f = fixture();
  let failInventory = false;
  const provider = {
    async getCode(address: string) { return address.toLowerCase() === TARGET.toLowerCase() ? runtime : "0x60006000"; },
    async call(tx: { to: string; data: string }) {
      let id: string;
      if (tx.data === ERC20.encodeFunctionData("decimals")) id = tx.to.toLowerCase() === binding.tokenIn.toLowerCase() ? "input-decimals" : "output-decimals";
      else if (tx.data.startsWith(ERC20.getFunction("balanceOf")!.selector)) id = "inventory";
      else {
        const name = ABI.parseTransaction({ data: tx.data })!.name;
        id = name === "tokenMigrationAmountToReceive" ? "amount-quote" : name;
      }
      if (id === "inventory" && failInventory) throw new Error("fixture inventory transport failure");
      const result = f.answer({ kind: "eth-call", id, to: tx.to, data: tx.data, completion: "return-data" });
      assert(result.ok); return result.data;
    },
    async getStorage() { throw new Error("no storage transport expected"); },
  };
  const central = createStrictCentralAdapterRuntime({ provider, executor: EXECUTOR,
    generationFence: { assertCurrent(generation, source) { assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE); } } });
  const observation = raw.receipt.logs.find((l: {address: string}) => l.address === TARGET.toLowerCase());
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: FAMILY, source: SOURCE,
    observations: [{ kind: "log", ...observation, source: SOURCE }], runtime: central });
  assert.equal(publication.instances.length, 1);
  const family = catalog.forFamily(FAMILY), instance = publication.instances[0];
  const graph = buildFamilyRouteGraphView({ routes: instance.routes.map((route, i) => ({ family, route,
    descriptor: instance.descriptor, handle: instance.routeHandles[i] })) });
  assert.equal(graph.edges.length, 1);
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: SOURCE, readyGraph: graph.edges,
    readyInstances: publication.instances, readyFundingAssets: [] });
  for (const address of [TARGET, binding.tokenIn, binding.tokenOut]) {
    assert.deepEqual(root.resolveBlockTouchedStateKeys({ kind: "log", address, data: "0x", topics: [] }, SOURCE), [instance.instanceKey]);
  }
  assert.deepEqual(root.resolveBlockTouchedStateKeys({ kind: "log", address: FOREIGN, data: "0x", topics: [] }, SOURCE), []);
  const quoted = await executeFamilyExactQuote({ family, route: instance.routeHandles[0], amountIn: AMOUNT, source: SOURCE,
    generation: SOURCE.generation, executor: EXECUTOR, runtimeEvidence: [], runtime: central, requireChainAmountQuote: true });
  assert.equal(quoted.status, "resolved");
  if (quoted.status === "resolved") assert.equal(quoted.amountOut, OUT);
  f.halt(true);
  const blocked = await executeFamilyExactQuote({ family, route: instance.routeHandles[0], amountIn: AMOUNT + 1n, source: SOURCE,
    generation: SOURCE.generation, executor: EXECUTOR, runtimeEvidence: [], runtime: central, requireChainAmountQuote: true });
  assert.notEqual(blocked.status, "resolved");

  // Fresh source-bound production sessions must recompute raw/effective on a
  // dependency-only update. The input token is the synthetic valuation anchor;
  // this does not claim a real production WETH reference or chain acceptance.
  const edge = graph.edges[0];
  for (const [index, mode] of ["funded", "halted", "empty", "failed", "restored"].entries()) {
    failInventory = mode === "failed";
    f.halt(mode === "halted"); f.fund(mode === "empty" ? 0n : OUT * 1000n);
    const source = { ...SOURCE, number: SOURCE.number + index + 1, hash: ethers.toBeHex(index + 1, 32), generation: index + 2 };
    const runtimeAt = createStrictCentralAdapterRuntime({ provider, executor: EXECUTOR,
      generationFence: { assertCurrent(generation, actual) { assert.equal(generation, source.generation); assert.deepEqual(actual, source); } } });
    const touched = new Set(root.resolveBlockTouchedStateKeys({ kind: "log", address: binding.tokenOut, data: "0x", topics: [] }, source));
    const session = await root.createSession({ source, runtime: runtimeAt, fundingAssets: [], kind: "pricing", touchedPools: touched });
    const current = session.currentPricingForEdge(edge);
    const available = mode === "funded" || mode === "restored";
    assert.equal(current?.status, available ? "priced" : failInventory ? "unresolved" : "behavior-proven-unavailable");
    const view = createVerifiedGraphView({ id: `migration-offline-${index}`, sourceBlock: source.number,
      sourceBlockHash: source.hash, generation: source.generation, completenessWatermark: SOURCE.number,
      perSourceCoverage: [], edges: graph.edges, familyIdForEdge: () => FAMILY });
    const effective = await buildEffectiveMids({ pricing: { graph: view,
      sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
      mids: new Map(current?.status === "priced" ? [[edge.canonicalEdgeId!, current.mid]] : []),
      coverage: { resolvedEdgeKeys: current?.status === "priced" ? [edge.canonicalEdgeId!] : [] },
      pricingStateKeyByEdgeKey: new Map([[edge.canonicalEdgeId!, instance.instanceKey]]) }, quoteGraph: view,
      weth: binding.tokenIn, gasCostWei: null, enumerationSpreadBps: 1, concurrency: 1,
      control: { deadlineAtMs: Date.now() + 5000 }, touchedStateKeys: touched,
      quote: async input => {
        const exact = await session.issueExact({ ...input, executor: EXECUTOR, runtimeEvidence: [], requireChainAmountQuote: true });
        assert("amountIn" in exact); return exact;
      } });
    const row = effective.rows.get(edge.canonicalEdgeId!)!;
    assert.equal(row.status, available ? "quoted" : "quote-failed");
    if (available) {
      assert.equal(row.amountIn, DEFAULT_EFFECTIVE_WETH_INPUT);
      assert.equal(row.amountOut, calculate(DEFAULT_EFFECTIVE_WETH_INPUT, binding.numerator, binding.denominator));
    }
  }
});
