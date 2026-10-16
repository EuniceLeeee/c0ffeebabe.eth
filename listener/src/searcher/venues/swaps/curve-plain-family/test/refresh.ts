import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { runUniv2Lifecycle } from "../../../../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../../../swaps/univ2-family/codec.js";

import { CURVE_PLAIN_FAMILY_ID } from "../manifest.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { createBoundedRequestExecutor } from "../../../adapter-request-program.js";
import type { CentralAdapterRuntime } from "../../../../adapter-work-intent.js";
import { ERC20, EXECUTION, DISCOVERY_MODES, POOL, SIGNED_GETTERS, UINT_POOL, CURVE_METAREGISTRY,
  META, executionFunction, pullsInput, hasReceiver, lower, selector } from "../codec.js";
import type { CurveIndexAbi, CurvePlainExecutionMode, CurvePlainDescriptor } from "../types.js";
import { erc20ProbeCalls } from "./identity-probe.js";
import { curvePlainPricing } from "../pricing.js";
import { curveRefreshGuardRequests } from "../refresh-scope.js";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const HANDLER = "0xe06eba9cea16cc71d4498cdba7240bb20d475890";
const SOURCE: CanonicalSource = { number: 500, generation: 500, hash: "0x"+"0".repeat(61)+"1f4" };
const word = (n: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
const pad = (values: string[], n: number) => [...values, ...Array(n-values.length).fill(ethers.ZeroAddress)];
function success(id: string, data: string): Extract<AdapterRequestResult, {ok:true}> {
  return { id, ok:true, data, source:SOURCE, provenance:{kind:"fixture",fingerprint:"curve-refresh"},completion:"returned" };
}
function revert(id:string): AdapterRequestResult { return {...success(id,"0x"), completion:"reverted-as-declared"}; }
type Anchor = { pool: string; coins: string[]; decimals: number[] };
interface FixtureOptions {
  readonly coinAbis?: readonly CurveIndexAbi[];
  readonly balanceAbis?: readonly CurveIndexAbi[];
  readonly quoteAbi?: CurveIndexAbi;
  readonly scalarTail?: string;
}
function fixture(anchor: Anchor, allowedModes: readonly CurvePlainExecutionMode[] = ["exchange"], options: FixtureOptions = {}) {
  const balances = anchor.decimals.map(d => 10n ** BigInt(d) * 1_000_000n);
  const dy = (i: number, j: number, dx: bigint) => {
    // Nonlinear quote with fees and integer rounding. Never a cached unit-price multiplier.
    return dx * balances[j] * 9996n / ((balances[i] + dx) * 10000n);
  };
  const rawAnswer = (request: AdapterRequest): AdapterRequestResult => {
    if (request.kind === "get-code") return success(request.id, "0x6000");
    if (request.id === "probe-executor") {
      assert(request.kind === "effect-delta-simulation");
      assert.equal(request.call.executionMode, "impersonated-call-frame");
      assert.equal(request.call.to, ADDR.WETH);
      return { ...success(request.id, word(0n)), effects: {
        tokenDeltas: [{ token: ADDR.WETH, account: EXECUTOR, delta: 0n }],
        nativeDeltas: [{ account: EXECUTOR, delta: 0n }] } };
    }
    if (request.kind === "effect-delta-simulation") {
      const [setup, swap] = erc20ProbeCalls(request);
      assert.equal(lower(request.call.to), lower(EXECUTOR));
      assert.equal(swap.to, anchor.pool);
      const mode = DISCOVERY_MODES.find(m => swap.data.slice(0, 10) === selector(m))!;
      if (!allowedModes.includes(mode)) return revert(request.id);
      assert.equal(request.call.caller.kind, "executor");
      const args = EXECUTION[mode].decodeFunctionData(executionFunction(mode), swap.data);
      const [i, j, dx, minDy] = [Number(args[0]), Number(args[1]), BigInt(args[2]), BigInt(args[3])];
      const amountOut = dy(i, j, dx);
      assert.equal(minDy, amountOut);
      assert.equal(lower(setup.to), anchor.coins[i]);
      const setupArgs = ERC20.decodeFunctionData(pullsInput(mode) ? "approve" : "transfer", setup.data);
      assert.equal(lower(String(setupArgs[0])), anchor.pool);
      assert.equal(setupArgs[1], dx);
      const receiver = hasReceiver(mode) ? String(args[args.length - 1]) : EXECUTOR;
      return { ...success(request.id, word(amountOut)), effects: { tokenDeltas: [
        { token: anchor.coins[i], account: EXECUTOR, delta: -dx },
        { token: anchor.coins[i], account: anchor.pool, delta: dx },
        { token: anchor.coins[j], account: receiver, delta: amountOut },
        { token: anchor.coins[j], account: anchor.pool, delta: -amountOut },
      ] } };
    }
    if (request.kind !== "eth-call") throw new Error("unexpected fixture transport");
    if (lower(request.to) === lower(CURVE_METAREGISTRY)) {
      const parsed = META.parseTransaction({ data: request.data })!;
      assert.equal(lower(String(parsed.args[0])), anchor.pool);
      return success(request.id, META.encodeFunctionResult(parsed.name,
        [parsed.name === "get_coins" ? pad(anchor.coins, 8) : pad([HANDLER], 10)]));
    }
    if (request.data === ERC20.encodeFunctionData("decimals")) {
      return success(request.id, word(BigInt(anchor.decimals[anchor.coins.indexOf(lower(request.to))])));
    }
    assert.equal(lower(request.to), anchor.pool);
    const parsed = POOL.parseTransaction({ data: request.data }) ?? UINT_POOL.parseTransaction({ data: request.data }) ??
      SIGNED_GETTERS.parseTransaction({ data: request.data })!;
    const abi = parsed.signature.includes("int128") ? "int128" : "uint256";
    if (parsed.name === "coins" && !(options.coinAbis ?? ["uint256"]).includes(abi)) return revert(request.id);
    if (parsed.name === "balances" && !(options.balanceAbis ?? ["uint256"]).includes(abi)) return revert(request.id);
    if (parsed.name === "get_dy" && options.quoteAbi !== undefined && abi !== options.quoteAbi) return revert(request.id);
    switch (parsed.name) {
      case "coins": return success(request.id, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [anchor.coins[Number(parsed.args[0])]]));
      case "balances": return success(request.id, word(balances[Number(parsed.args[0])]));
      case "A": return success(request.id, word(100n));
      case "fee": return success(request.id, word(4_000_000n));
      case "get_dy": return success(request.id, word(dy(Number(parsed.args[0]), Number(parsed.args[1]), BigInt(parsed.args[2]))));
      default: throw new Error("unexpected fixture call");
    }
  };
  const answer = (request: AdapterRequest): AdapterRequestResult => {
    const read = rawAnswer(request);
    return options.scalarTail !== undefined && read.ok && read.completion === "returned" && ethers.isHexString(read.data, 32)
      ? { ...read, data: read.data + options.scalarTail } : read;
  };
  return { answer, dy, balances };
}

function admissionRuntime(anchor: Anchor): CentralAdapterRuntime {
  let now=1000;
  return { clock:{nowMs:()=>now++}, generationFence:{assertCurrent(g,s){assert.equal(g,SOURCE.generation);assert.deepEqual(s,SOURCE);}},
    callerAuthority:{bind:()=>({executor:EXECUTOR,transactionOrigin:"0x1000000000000000000000000000000000000001"})},
    policy:{bind:i=>({lane:i.stage==="identity"?"critical-proof":"background",deadlineAtMs:100000,maxAttempts:1,transportPool:"state-read",fairnessKey:i.subjectKey})},
    budgets:{assertAdmitted(){}}, scheduler:{issueExecutor(input){return {executor:createBoundedRequestExecutor({
      assertSupported:r=>assert.deepEqual(r,input.requirements),assertCallerBinding(){},assertWithinBudget:(_f,rs)=>assert.deepEqual(rs,input.requests),
      execute:async e=>e.requests.map(request=>{
        const result=fixture(anchor).answer(request);
        if (request.kind!=="effect-delta-simulation" || !result.ok) return result;
        const defaults = { ...(request.observe.includes("token-delta") ? {tokenDeltas:[]} : {}),
          ...(request.observe.includes("native-delta") ? {nativeDeltas:[]} : {}),
          ...(request.observe.includes("logs") ? {logs:[]} : {}) };
        return {...result,effects:{...defaults,...result.effects}};
      }),sealStaticEvidenceReuseProof:()=>({proofHash:"ab".repeat(32)})}),
      timing:()=>({queueWaitMs:0,transportWallMs:1,attempts:1})};}} };
}


// Offline transport fixtures exercise the unchanged production lifecycle,
// Family, Exact, coordinator and publication. No RPC, EVM or pricing formula claim.
test("Curve plain unproven dependency quiet effective refresh, failure withdrawal/recovery and unrelated carry", async () => {
  const vault = "0x5151515151515151515151515151515151515151", asset = "0x5252525252525252525252525252525252525252";
  const second = "0x5353535353535353535353535353535353535353";
  const anchor = {pool:vault,coins:[asset,second],decimals:[18,18]};
  const familyId = CURVE_PLAIN_FAMILY_ID;
  const unit = 10n ** 18n, executor = EXECUTOR;
  const at = (tick: number) => ({ number: 500 + tick, generation: 500 + tick, hash: ethers.toBeHex(500 + tick, 32) });
  const source = at(0), pools = ["0x4141414141414141414141414141414141414141", "0x4242424242424242424242424242424242424242"];
  const factory = "0x4343434343434343434343434343434343434343";
  const admitted = await runStrictFamilyLifecycle({ catalog, familyId, source,
    observations: [{ kind: "call", target: vault, data: EXECUTION.exchange.encodeFunctionData("exchange", [0,1,unit,0n]), source }], runtime: admissionRuntime(anchor) });
  assert.equal(admitted.instances.length, 1);
  assert.equal(admitted.instances[0]!.routes.length, 2);
  const background = await Promise.all(pools.map((pool, i) => runUniv2Lifecycle(source, { pool, factory,
    token0: ADDR.WETH, token1: [asset, second][i]!, reserves: { reserve0: 1000n * unit,
      reserve1: 2000n * unit, blockTimestampLast: source.number } }, catalog)));
  const instances = [...admitted.instances, ...background.flatMap(r => r.instances)];
  const edges = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[i],
  }))) }).edges;
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: edges,
    readyInstances: instances, readyFundingAssets: [] });
  const ownKeys = edges.map(blockScanEdgeKey).filter(key => root.pricingIndex().familyIdByEdgeKey.get(key) === familyId);
  const otherKeys = edges.map(blockScanEdgeKey).filter(k => !ownKeys.includes(k));
  assert.equal(ownKeys.length, 2); assert.equal(otherKeys.length, 4);
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys,
    ownKeys.map(key => root.pricingIndex().stateKeyByEdgeKey.get(key)!));
  const d = admitted.instances[0]!.descriptor as CurvePlainDescriptor;
  const policy = (descriptor: CurvePlainDescriptor) => {
    const p = curvePlainPricing as typeof curvePlainPricing & { refreshPolicyForInstance?: (x:any)=>string; refreshPolicy?: string };
    return p.refreshPolicyForInstance?.({descriptor:{instance:descriptor,route:admitted.instances[0]!.routes[0]},routes:[]}) ?? p.refreshPolicy ?? "on-touch";
  };
  assert.equal(policy(d),"each-block");
  // Exact immutable model proof, not instance admission or a pool-address list.
  for (const [implementation,abi] of [["a85461afc2deec01bda23b5cd267d51f765fba10","uint256"],
    ["c629a01ec23ab04e1050500a3717a2a5c0701497","int128"],
    ["67fe41a94e779ccfa22cff02cc2957dc9c0e4286","int128"],
    ["6523ac15ec152cb70a334230f6c5d62c5bd963f1","int128"]] as const) {
    const known = {...d,binding:{...d.binding,quoteAbi:abi,codeHash:ethers.keccak256("0x363d3d373d3d3d363d73"+implementation+"5af43d82803e903d91602b57fd5bf3")}};
    assert.equal(policy(known),"on-touch"); assert(curveRefreshGuardRequests(known).length>0);
    assert.equal(policy({...known,pool:"0x5454545454545454545454545454545454545454"}),"on-touch");
    assert.equal(policy({...known,binding:{...known.binding,quoteAbi:abi==="int128"?"uint256":"int128"}}),"each-block");
    assert.equal(policy({...known,binding:{...known.binding,coins:[...known.binding.coins,ADDR.WETH]}}),"each-block");
  }
  for (const codeHash of [ethers.keccak256("0x6001"), "0xf29fb95ca44fe2f979303e309cbaba61d44dd503fddeb111caae94e1b0857154"]) {
    assert.equal(policy({...d,binding:{...d.binding,codeHash}}),"each-block");
  }
  let failed = false;
  const reads: { lane: string; method: string; tick: number }[] = [];
  function runtime(tick: number, lane: string) {
    const current = at(tick);
    return createStrictCentralAdapterRuntime({ executor,
      generationFence: { assertCurrent(generation, requested) { assert.equal(generation, current.generation); assert.deepEqual(requested, current); } },
      provider: {
        async getCode() { throw new Error("unexpected refresh code read"); },
        async getStorage() { throw new Error("unexpected refresh storage read"); },
        async call(request, block) {
          assert.equal(block, current.number);
          const target = request.to.toLowerCase(), selector = request.data.slice(0, 10);
          if (pools.includes(target)) {
            assert.equal(selector, UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector);
            reads.push({ lane, method: "getReserves", tick });
            return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1000n * unit, 2000n * unit, source.number]);
          }
          if (selector === UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector) {
            const holder = String(UNIV2_TOKEN_INTERFACE.decodeFunctionData("balanceOf", request.data)[0]).toLowerCase();
            assert(pools.includes(holder));
            return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [target === ADDR.WETH.toLowerCase() ? 1000n * unit : 2000n * unit]);
          }
          assert.equal(target, vault);
          const call = POOL.parseTransaction({ data: request.data }); assert(call);
          reads.push({ lane, method: call.name, tick });
          if (call.name === "A") return word(100n);
          if (call.name === "fee") return word(4_000_000n);
          if (call.name === "balances") return word(10n ** 24n);
          assert.equal(call.name, "get_dy");
          if (failed) throw new Error("synthetic external view unavailable");
          return word(fixture(anchor).dy(Number(call.args[0]),Number(call.args[1]),BigInt(call.args[2])) + BigInt(Math.min(tick,4)));

        },
      },
    });
  }
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({ source: request.source,
    runtime: runtime(request.source.number - source.number, "raw"), fundingAssets: [],
    kind: request.purpose === "exact-execution" ? "exact" : "pricing", touchedPools: request.touchedPools,
    requiredEdgeIds: request.requiredEdgeIds, control: request.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const current = reuse?.quoteGraph ?? pricing;
    const requested = { number: current.sourceBlock, hash: current.sourceBlockHash, generation: current.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds, control,
      weth: ADDR.WETH, gasCostWei: null, enumerationSpreadBps: 50, concurrency: 2,
      prepareQuote: async requiredEdgeIds => { exact = await root.createSession({ source: requested,
        runtime: runtime(requested.number - source.number, "exact"), fundingAssets: [], kind: "exact", requiredEdgeIds, control }); },
      quote: async request => { assert(exact); const q = await exact.issueExact({ ...request, executor, runtimeEvidence: [] });
        assert("amountIn" in q); return q; },
    });
  });
  async function step(tick: number) {
    reads.length = 0;
    const current = at(tick), touched = new Set<string>();
    const graph = createVerifiedGraphView({ id: "curve-refresh-" + tick, edges, generation: current.generation,
      sourceBlock: current.number, sourceBlockHash: current.hash, completenessWatermark: current.number,
      familyIdForEdge: e => root.pricingIndex().familyIdByEdgeKey.get(blockScanEdgeKey(e))!,
      perSourceCoverage: [...new Set(instances.map(i => i.familyId))].map(familyId => ({ familyId,
        sourceId: "offline", sourceFingerprint: "curve-refresh", completeThroughBlock: current.number, completeThroughHash: current.hash })),
    });
    await coordinator.prepareCoarsePricing({ graph, deadlineAtMs: Date.now() + 10000, touchedPools: touched,
      canonicalActivity: { source: current, parentHash: tick === 0 ? ethers.ZeroHash : at(tick - 1).hash,
        touchedStateKeys: touched, complete: true } });
    assert.equal(touched.size, 0);
    const snapshot = coordinator.latestPricingSnapshot()!;
    if (tick > 0) {
      assert(!reads.some(r => r.lane === "raw"), "no bootstrap raw reread");
      assert(!reads.some(r => r.method === "getReserves"), "unrelated on-touch pools remain carried");
      assert.equal(reads.length, failed ? 4 : 2, "only selected effective directions/dependent rounds; existing bounded retry only");
    }
    return snapshot;
  }
  const baseline = await step(0);
  let recovered: ReturnType<typeof coordinator.latestPricingSnapshot>;
  for (const [tick, fail] of [[1, false], [2, true], [3, true], [4, false], [5, false]] as const) {
    failed = fail; const snapshot = await step(tick);
    assert.strictEqual(snapshot.mids, baseline.mids); assert.deepEqual(snapshot.rawMidSource, source);
    for (const key of otherKeys) {
      assert.strictEqual(snapshot.effectiveMids!.rows.get(key), baseline.effectiveMids!.rows.get(key));
      assert.equal(snapshot.pricingProvenanceByEdgeKey!.get(key), "carried");
    }
    for (const key of ownKeys) {
      const row = snapshot.effectiveMids!.rows.get(key)!;
      assert.equal(row.status, fail ? "quote-failed" : "quoted");
      if (fail) { assert.equal(row.amountOut, null); assert.equal(row.quotedAt, undefined);
        assert(snapshot.coverage.unresolvedEdgeKeys.includes(key)); assert(!snapshot.coverage.resolvedEdgeKeys.includes(key)); }
      else { assert.notEqual(row.amountOut, baseline.effectiveMids!.rows.get(key)!.amountOut);
        assert.deepEqual(row.quotedAt, at(tick)); assert(snapshot.coverage.resolvedEdgeKeys.includes(key));
        if (tick === 5) assert.equal(row.amountOut, recovered!.effectiveMids!.rows.get(key)!.amountOut); }
    }
    if (tick === 4) recovered = snapshot;
  }
});
