import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, TypedDataEncoder, zeroPadValue, hexlify } from "ethers";
import { ABI, MAX_UINT, proveBearRuntime, proveLocalAssetRuntime, bearTransferReceipt } from "../variants.js";
import { FAMILY } from "../manifest.js";
import { discovery } from "../discovery.js";
import { identity } from "../identity.js";
import { exactProgram } from "../exact.js";
import { conversionSimulation, decodeConversionReceipt } from "../simulation.js";
import { mintAction, redeemAction } from "../action.js";
import type { Direction } from "../types.js";
import type { ConversionDescriptor, ConversionRoute } from "../types.js";
import type { AdapterRequestResult, CanonicalSource, ObservedEffects } from "../../../adapter-request-program.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { StrictProductionRuntimeRoot } from "../../../../strict-production-runtime-session.js";
import { readBlockTouchedStateKeys } from "../../../../blockscan-touched-state.js";
import { buildEffectiveMids, DEFAULT_EFFECTIVE_WETH_INPUT } from "../../../../blockscan-effective-mid.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { refreshFixture } from "./refresh-fixture.js";

// Raw evidence stays outside Git. Required input: the supplied read-only cache.
const cache = process.env.TOKEN_CONVERSION_EVIDENCE;
assert(cache, "TOKEN_CONVERSION_EVIDENCE must name the supplied offline cache");
const TARGET = getAddress("0x88888880d5ca13018d2dc11e2e4744bd91a5656f");
const ASSET = getAddress("0x88888888c90cd71b35830dabfd24743dbc135b51");
const EXECUTOR = getAddress(`0x${"17".repeat(20)}`);
const OTHER = getAddress(`0x${"18".repeat(20)}`);
const SOURCE: CanonicalSource = { number: 25000000, hash: `0x${"51".repeat(32)}`, generation: 1 };
const html = readFileSync(join(cache, "contracts", `${TARGET.toLowerCase()}.html`), "utf8");
const code = html.slice(html.indexOf("Deployed Bytecode")).match(/<div>(0x[0-9a-fA-F]+)<\/div>/)![1]!;
const codeHash = proveBearRuntime(code, TARGET, ASSET);
function returned(id: string, data: string, effects?: ObservedEffects): AdapterRequestResult {
  return { id, data, effects, ok: true, completion: "returned", source: SOURCE, provenance: { kind: "offline-fixture", fingerprint: "fixture" } };
}
function receipt(id: string, direction: Direction, amount: bigint, actor = EXECUTOR) {
  const sign = direction === "mint" ? 1n : -1n;
  const event = ABI.encodeEventLog(ABI.getEvent(direction === "mint" ? "Minted" : "Redeemed")!, [actor, amount, amount]);
  return returned(id, ABI.encodeFunctionResult(direction, [amount]), {
    tokenDeltas: [{ token: TARGET, account: actor, delta: sign * amount },
      { token: ASSET, account: actor, delta: -sign * amount }, { token: ASSET, account: TARGET, delta: sign * amount }],
    totalSupplyDeltas: [{ token: TARGET, delta: sign * amount }],
    logs: [{ address: TARGET, ...event }],
  });
}
function patchOperand(bytes: string, offset: number, value: string) {
  return bytes.slice(0, 2 + offset * 2) + value.slice(2).toLowerCase() + bytes.slice(2 + (offset + 32) * 2);
}

test("audited runtime proof binds all immutables and permits another deployment", () => {
  assert.equal(codeHash, keccak256(code));
  assert.throws(() => proveBearRuntime("0x6000", TARGET, ASSET), /unsupported/);
  assert.throws(() => proveBearRuntime(code, OTHER, ASSET), /immutable/);
  assert.throws(() => proveBearRuntime(code, TARGET, OTHER), /immutable/);
  const wrongCode = code.slice(0, 1000) + (code[1000] === "0" ? "1" : "0") + code.slice(1001);
  assert.throws(() => proveBearRuntime(wrongCode, TARGET, ASSET), /template/);
  let relocated = code;
  for (const offset of [837, 2621, 3170, 3892, 4108]) relocated = patchOperand(relocated, offset, zeroPadValue(EXECUTOR, 32));
  relocated = patchOperand(relocated, 4694, zeroPadValue(OTHER, 32));
  relocated = patchOperand(relocated, 4778, TypedDataEncoder.hashDomain({ name: "BTB Bear", version: "1", chainId: 1, verifyingContract: OTHER }));
  assert.equal(proveBearRuntime(relocated, OTHER, EXECUTOR), keccak256(relocated));
});

test("discovery requires the matching typed variant and rejects malformed calls", () => {
  const observation = { kind: "call" as const, source: SOURCE, target: TARGET, data: ABI.encodeFunctionData("mint", [123n]) };
  const candidate = discovery.decodeCandidate({ observation, matchedPatternId: "token-conversion-mint" });
  assert(candidate);
  for (const data of ["0xa0712d68", ABI.encodeFunctionData("mint", [0n]), observation.data + "00", `0x2b2dfd2c${"0".repeat(128)}`]) {
    assert.equal(discovery.decodeCandidate({ observation: { ...observation, data }, matchedPatternId: "token-conversion-mint" }), null);
  }
  const step = { candidate, step: 0 };
  const rejected = identity.variants[0]!.decode({ step, results: [returned("identity-code", "0x60006000")] });
  assert.equal(identity.variants[0]!.decide({ ...step, evidence: rejected }).status, "chain-proven-rejected");
  assert.throws(() => identity.variants[0]!.decode({ step, results: [] }), /missing|empty/);
});

test("asset dependency closure rejects external, proxy, environmental and unknown instructions", () => {
  assert.equal(proveLocalAssetRuntime("0x604360fa00"), keccak256("0x604360fa00")); // PUSH data is not an opcode.
  for (const op of ["31", "32", "3a", "3b", "3c", "3f", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "4a", "5a", "5c", "5d", "f0", "f1", "f2", "f4", "f5", "fa", "ff", "ef", "0c"])
    assert.throws(() => proveLocalAssetRuntime(`0x6000${op}00`), /closure unproven/);
  assert.throws(() => proveLocalAssetRuntime("0x61ff"), /truncated PUSH/);
  const candidate = { candidateKind: "token-conversion" as const, target: TARGET };
  const evidence = { phase: "code", asset: ASSET, codeHash };
  const step = { candidate, step: 1, evidence };
  const unproven = identity.variants[0]!.decode({ step, results: [returned("identity-asset-code", "0x6000fa")] });
  const decision = identity.variants[0]!.decide({ ...step, evidence: unproven });
  assert.equal(decision.status, "retryable");
});

test("receipt proof distinguishes mint from taxed transfer and rejects false receipts", () => {
  for (const direction of ["mint", "redeem"] as const) {
    for (const amount of [1n, 99n, 100n, 101n, 1234567890123456789n]) {
      const r = receipt("probe", direction, amount);
      assert.equal(decodeConversionReceipt([r], "probe", TARGET, ASSET, direction, amount, EXECUTOR).amountOut, amount);
      assert.throws(() => decodeConversionReceipt([r], "probe", TARGET, ASSET, direction, amount + 1n, EXECUTOR), /mismatch/);
      assert.throws(() => decodeConversionReceipt([r], "probe", TARGET, ASSET, direction, amount, OTHER), /actor/);
    }
  }
  assert.deepEqual(bearTransferReceipt(101n), { net: 100n, tax: 1n });
  assert.deepEqual(bearTransferReceipt(99n), { net: 99n, tax: 0n });
  assert.throws(() => bearTransferReceipt(MAX_UINT / 100n + 1n), /overflow/);
  const good = receipt("probe", "mint", 10000n);
  assert(good.ok);
  const effects = good.effects!;
  const mutations: ObservedEffects[] = [
    { ...effects, tokenDeltas: effects.tokenDeltas!.map((r,i) => i === 0 ? { ...r, delta: 9900n } : r) },
    { ...effects, tokenDeltas: effects.tokenDeltas!.map((r,i) => i === 1 ? { ...r, delta: -10001n } : r) },
    { ...effects, tokenDeltas: effects.tokenDeltas!.slice(0,2) },
    { ...effects, tokenDeltas: [...effects.tokenDeltas!, effects.tokenDeltas![0]!] },
    { ...effects, totalSupplyDeltas: [] }, { ...effects, logs: [] },
  ];
  for (const bad of mutations) assert.throws(() => decodeConversionReceipt([{ ...good, effects: bad }], "probe", TARGET, ASSET, "mint", 10000n, EXECUTOR));
  assert.throws(() => decodeConversionReceipt([{ ...good, data: ABI.encodeFunctionResult("mint", [9999n]) }], "probe", TARGET, ASSET, "mint", 10000n, EXECUTOR));
  const sim = conversionSimulation("amount", TARGET, ASSET, "mint", 123456789n);
  assert(sim.kind === "effect-delta-simulation");
  assert.equal(BigInt(ABI.decodeFunctionData("mint", sim.call.data)[0]), 123456789n);
  assert.equal(sim.call.executionMode, "impersonated-call-frame");
  assert.equal(sim.observeTokenBalances!.length, 3);
  assert.throws(() => conversionSimulation("bad", TARGET, ASSET, "mint", -1n));
});

test("cached real receipts establish N and mint receipt separately from 1% transfer", () => {
  const hash = "0x86a480c93d60c9eb2c6a3c3ef7c322c8b3a290dc541a96554fa224adaf8d8f91";
  const raw = JSON.parse(readFileSync(join(cache, "raw", `${hash}.json`), "utf8"));
  assert.equal(raw.receipt.status, "0x1"); assert.equal(BigInt(raw.tx.chainId), 1n);
  assert.equal(raw.receipt.transactionHash, hash); assert.equal(raw.receipt.blockHash, raw.tx.blockHash);
  const logs = raw.receipt.logs.filter((l: {address:string}) => l.address === TARGET.toLowerCase())
    .flatMap((l: {topics:string[];data:string}) => { try { const e = ABI.parseLog(l); return e ? [e] : []; } catch { return []; } });
  const minted = logs.find((e: {name:string}) => e.name === "Minted")!;
  const amount = BigInt(minted.args.btbbAmount);
  assert.equal(amount, BigInt(minted.args.btbAmount));
  const transfers = logs.filter((e: {name:string}) => e.name === "Transfer");
  assert.equal(BigInt(transfers[0].args.value), amount);
  assert.equal(BigInt(transfers[0].args.from), 0n);
  const taxed = bearTransferReceipt(amount);
  assert.equal(BigInt(transfers[1].args.value), taxed.tax);
  assert.equal(BigInt(transfers[2].args.value), taxed.net);
  assert.notEqual(amount, taxed.net);
  console.log(JSON.stringify({ evidence: "cached-receipt-only", tx: hash, N: Number(BigInt(raw.receipt.blockNumber)), blockHash: raw.receipt.blockHash,
    mintReceipt: amount.toString(), subsequentTransferReceipt: taxed.net.toString(), tax: taxed.tax.toString() }));
  const xhash = "0xacb3f261665bb1516ff03be65b890b3edf9413edc5ea32a78ff4b5a667b3ea8b";
  const x = JSON.parse(readFileSync(join(cache, "raw", `${xhash}.json`), "utf8"));
  assert.equal(x.receipt.transactionHash, xhash); assert.equal(x.receipt.status, "0x1"); assert.equal(BigInt(x.tx.chainId), 1n);
  console.log(JSON.stringify({ evidence: "cached-receipt-only", tx: xhash, N: Number(BigInt(x.receipt.blockNumber)), blockHash: x.receipt.blockHash, support: "xwin-allocations-v1: chain acceptance unverified" }));
});

test("production lifecycle, Graph, raw pricing, Exact and execution use the Family (fixture transport)", async () => {
  let badOutput = false;
  const observedAmounts: bigint[] = [];
  const cost: Record<string, { code: number; call: number; simulation: number }> = {};
  const count = (lane: string, kind: "code" | "call" | "simulation") => {
    cost[lane] ??= { code: 0, call: 0, simulation: 0 }; cost[lane]![kind]++;
  };
  const runtime = (source: CanonicalSource, backing = 10n ** 24n, assetCode = "0x6000", lane = "other") => createStrictCentralAdapterRuntime({
    executor: EXECUTOR, transactionOrigin: OTHER, generationFence: { assertCurrent() {} },
    provider: {
      async getCode(address) { count(lane, "code"); return address.toLowerCase() === TARGET.toLowerCase() ? code : assetCode; },
      async getStorage() { throw new Error("unexpected storage read"); },
      async call(tx) {
        count(lane, "call");
        const parsed = ABI.parseTransaction(tx)!;
        if (parsed.name === "BTB_TOKEN") return ABI.encodeFunctionResult("BTB_TOKEN", [ASSET]);
        if (parsed.name === "totalSupply") return ABI.encodeFunctionResult("totalSupply", [10n ** 24n]);
        if (parsed.name === "balanceOf") return ABI.encodeFunctionResult("balanceOf", [backing]);
        throw new Error(`unexpected fixture call ${parsed.name}`);
      },
    },
    simulator: { async simulate({ request, source: actual, callerAuthority }) {
      count(lane, "simulation");
      assert.deepEqual(actual, source); assert.equal(callerAuthority.executor, EXECUTOR);
      const parsed = ABI.parseTransaction({ data: request.call.data })!;
      const amount = BigInt(parsed.args[0]); observedAmounts.push(amount);
      if (parsed.name === "redeem" && amount > backing) throw Object.assign(new Error("fixture: insufficient backing"), { code: "CALL_EXCEPTION", data: "0x" });
      const result = receipt(request.id, parsed.name as Direction, amount);
      assert(result.ok);
      return { data: result.data, effects: badOutput ? { ...result.effects, logs: [] } : result.effects };
    } },
  });
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: FAMILY, source: SOURCE, runtime: runtime(SOURCE),
    observations: [{ kind: "call", source: SOURCE, target: TARGET, data: ABI.encodeFunctionData("mint", [123n]) }] });
  assert.equal(publication.instances.length, 1);
  await assert.rejects(runStrictFamilyLifecycle({ catalog, familyId: FAMILY, source: SOURCE, runtime: runtime(SOURCE, 10n ** 24n, "0x6000fa"),
    observations: [{ kind: "call", source: SOURCE, target: TARGET, data: ABI.encodeFunctionData("mint", [123n]) }] }), /conversion_asset_dependency_closure_unproven/);
  const family = catalog.forFamily(FAMILY);
  const graph = buildFamilyRouteGraphView({ routes: publication.instances.flatMap(instance => instance.routes.map((route,index) => ({
    family, descriptor: instance.descriptor, route, handle: instance.routeHandles[index],
  }))) });
  assert.equal(graph.edges.length, 2);
  assert(graph.edges.every(e => !e.leavesStandingPosition));
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: SOURCE, readyGraph: graph.edges, readyInstances: publication.instances, readyFundingAssets: [] });
  const next = { number: SOURCE.number + 1, hash: `0x${"52".repeat(32)}`, generation: 2 };
  const session = await root.createSession({ source: next, runtime: runtime(next), fundingAssets: [], kind: "pricing" });
  assert.equal(session.edges.length, 2);
  for (const e of session.edges) {
    const price = session.currentPricingForEdge(e);
    assert.equal(price?.status, "priced");
    assert(price?.status === "priced"); assert.equal(price.mid.mid, 1);
  }
  const edge = session.edges.find(e => e.adapterId === "token-conversion-mint")!;
  const amount = 123456789012345678901n;
  const quoted = await session.issueExact({ edge, amountIn: amount, executor: EXECUTOR, runtimeEvidence: [], requireChainAmountQuote: true });
  assert.equal(quoted.amountOut, amount); assert(observedAmounts.includes(amount));
  const built = session.buildExecution({ edge, exact: quoted, minAmountOut: amount, executor: EXECUTOR });
  assert.equal(built.status, "resolved");
  const instance = publication.instances[0]!;
  const d = instance.descriptor as ConversionDescriptor;
  const r = instance.routes.find(r => (r as ConversionRoute).direction === "mint") as ConversionRoute;
  const input = { descriptor: d, route: r, source: SOURCE, executor: EXECUTOR, amountIn: amount, runtimeEvidence: [] };
  const resultSet = [returned("exact-code", code), returned("exact-asset-code", "0x6000"), receipt("exact-conversion", "mint", amount)];
  assert.equal(exactProgram.decode({ programInput: input, initialResults: resultSet, dependentEvidence: [] }).amountOut, amount);
  assert.throws(() => exactProgram.decode({ programInput: input, initialResults: resultSet.map(r => r.id === "exact-asset-code" ? returned(r.id, "0x600100") : r), dependentEvidence: [] }), /asset runtime changed/);
  assert.throws(() => exactProgram.decode({ programInput: { ...input, source: next }, initialResults: resultSet, dependentEvidence: [] }), /source/);
  assert.throws(() => exactProgram.buildRequests({ ...input, amountIn: MAX_UINT + 1n }), /uint256/);
  assert.throws(() => exactProgram.buildRequests({ ...input, route: { ...r, tokenOut: ASSET } }), /binding/);
  // The original production amount-reference code picks P; this fixture calls
  // its anchor ASSET. It does not claim a real BTB/WETH valuation or chain gate.
  const mids = new Map(session.edges.map(e => {
    const p = session.currentPricingForEdge(e); assert(p?.status === "priced");
    return [blockScanEdgeKey(e), p.mid] as const;
  }));
  const effective = await buildEffectiveMids({
    pricing: { sourceBlock: next.number, sourceBlockHash: next.hash, generation: next.generation,
      graph: { edges: session.edges }, mids, coverage: { resolvedEdgeKeys: [...mids.keys()] },
      pricingStateKeyByEdgeKey: new Map(session.edges.map(e => [blockScanEdgeKey(e), TARGET.toLowerCase()])) },
    weth: ASSET, gasCostWei: null, enumerationSpreadBps: 10, concurrency: 1,
    control: { deadlineAtMs: Date.now() + 10000 },
    quote: async args => {
      const quote = await session.issueExact({ ...args, executor: EXECUTOR, runtimeEvidence: [], requireChainAmountQuote: true });
      assert("amountIn" in quote, "conversion must return an amount-bearing Exact quote");
      return quote;
    },
  });
  assert.equal(effective.rows.size, 2);
  for (const row of effective.rows.values()) {
    assert.equal(row.status, "quoted"); assert.equal(row.amountIn, DEFAULT_EFFECTIVE_WETH_INPUT); assert.equal(row.amountOut, row.amountIn);
  }
  assert.deepEqual(root.resolveBlockTouchedStateKeys({ kind: "call", target: ASSET, data: "0x" }, next), [TARGET.toLowerCase()]);
  assert.deepEqual(root.resolveBlockTouchedStateKeys({ kind: "call", target: OTHER, data: "0x" }, next), []);
  const quiet = refreshFixture({ publication, start: SOURCE, executor: EXECUTOR, asset: ASSET,
    runtime: (at, lane) => runtime(at, 10n ** 24n, "0x6000", lane) });
  assert.deepEqual(quiet.root.pricingIndex().perBlockRefreshStateKeys, [TARGET.toLowerCase()]);
  const quietStart = await quiet.step(SOURCE);
  cost.raw = { code: 0, call: 0, simulation: 0 }; cost.exact = { code: 0, call: 0, simulation: 0 };
  const quietNext = await quiet.step(next);
  assert.equal(quietNext.mids.size, 2); assert.equal(quietNext.effectiveMids!.rows.size, 2);
  assert.strictEqual(quietNext.mids, quietStart.mids);
  assert.deepEqual(quietNext.rawMidSource, SOURCE);
  for (const [key, row] of quietNext.effectiveMids!.rows) {
    assert.equal(row.status, "quoted"); assert.deepEqual(row.quotedAt, next);
    assert.equal(quietNext.pricingProvenanceByEdgeKey!.get(key), "refreshed");
  }
  assert.deepEqual(cost.raw, { code: 0, call: 0, simulation: 0 });
  assert.deepEqual(cost.exact, { code: 4, call: 0, simulation: 2 });
  console.log(JSON.stringify({ kind: "offline-btbb-empty-block-cost-fixture", perInstancePerBlock: {
    raw: cost.raw, effective: cost.exact }, previouslyUntouchedCarry: "zero quote transport calls",
    excludes: "transport batching/retries, simulator-internal reads, later Solver and final execution",
    actualUnderlyingRuntimeCompatibility: "unverified", historicalParity: "not run" }));
  const touched = await readBlockTouchedStateKeys({
    async getLogs() { return [{ address: ASSET, topics: [], data: "0x", blockHash: next.hash }]; },
    async send(method) { assert.equal(method, "debug_traceBlockByHash"); return []; },
  }, next.number, OTHER, { hash: next.hash, parentHash: SOURCE.hash, transactionHashes: [] }, undefined, root.resolveBlockTouchedStateKeys);
  assert(touched.has(TARGET.toLowerCase()));
  const empty = await root.createSession({ source: next, runtime: runtime(next, 0n), fundingAssets: [], kind: "pricing", touchedPools: touched });
  // A backing-only update traverses the production dependency resolver and
  // removes the redeem price; mint still has its independent receipt proof.
  assert.equal(empty.edges.length, 2);
  assert.equal(empty.currentPricingForEdge(empty.edges.find(e => e.adapterId === "token-conversion-redeem")!)?.status, "behavior-proven-unavailable");
  assert.equal(empty.currentPricingForEdge(empty.edges.find(e => e.adapterId === "token-conversion-mint")!)?.status, "priced");
  badOutput = true;
  await assert.rejects(session.issueExact({ edge, amountIn: amount + 1n, executor: EXECUTOR, runtimeEvidence: [] }));
  const failed = await root.createSession({ source: next, runtime: runtime(next), fundingAssets: [], kind: "pricing", touchedPools: touched });
  for (const e of failed.edges) assert.notEqual(failed.currentPricingForEdge(e)?.status, "priced", "failed refresh must not publish stale pricing");
  const node = { adapterId: "token-conversion-mint", target: TARGET, tokenIn: ASSET, tokenOut: TARGET, amount,
    params: { variant: "btb-bear-v1" }, children: [] };
  const bytes = hexlify(mintAction.encode(node, EXECUTOR, new Uint8Array()));
  assert(bytes.includes(ABI.encodeFunctionData("mint", [amount]).slice(2)));
  assert.equal((bytes.match(/095ea7b3/g) ?? []).length, 3);
  assert.throws(() => mintAction.encode({ ...node, params: { variant: "xwin-allocations" } }, EXECUTOR, new Uint8Array()));
  assert.throws(() => mintAction.encode(node, EXECUTOR, new Uint8Array([1])));
  assert.throws(() => redeemAction.encode(node, EXECUTOR, new Uint8Array()));
  console.log("fixture-only production lifecycle and balance-quote checks; no chain acceptance");
});
