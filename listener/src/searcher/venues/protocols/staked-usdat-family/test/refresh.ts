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
import { executeAdapterFamilyLifecycleBatch } from "../../../adapter-family-runtime.js";
import type { FamilyId } from "../../../adapter-family-identifiers.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../../../swaps/univ2-family/codec.js";

import { STAKED_USDAT_INTERFACE, STAKED_USDAT_IMPLEMENTATION_SLOT, STAKED_USDAT_PROXY_CODE } from "../identity-proof.js";
import { STAKED_USDAT_FAMILY_ID } from "../manifest.js";
import { STAKED_USDAT_IMPLEMENTATION_CODE } from "./implementation-bytecode.js";
import erc4626Json from "../../erc4626-family/erc4626.json";
import { Interface as FamilyInterface } from "ethers";
import { getAddress as familyGetAddress } from "ethers";
import { plugin as erc4626Plugin } from "../../../production-families/erc4626.production.js";
import infinifiJson from "../../erc4626-family/infinifi.json";

const ERC4626_ERC20_INTERFACE = new FamilyInterface(erc4626Json.identity.definition.abi.token);
const ERC4626_INTERFACE = new FamilyInterface(erc4626Json.identity.definition.abi.vault);
const ERC4626_PROBE_ACTOR = familyGetAddress(erc4626Json.identity.definition.parameters.constants.actor);
const ERC4626_FAMILY_ID = erc4626Plugin.manifest.familyId;
const INFINIFI_ABI = new FamilyInterface(infinifiJson.abi.vault);
const INFINIFI_GATEWAY = infinifiJson.constants.gateway;

// Real code identity plus synthetic transport and token effects. This exercises
// production admission/scheduling/publication, not a new EVM or formula claim.
const lower = (address: string) => address.toLowerCase();
const word = (value: bigint) => ethers.toBeHex(value, 32);
const unit = 10n ** 18n, executor = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
// A distinct proxy subject proves admission does not depend on a vault address list.
const vault = "0x5151515151515151515151515151515151515151";
const ordinary = "0x5252525252525252525252525252525252525252";
const implementation = "0x2005e0ca201a37694125ff267ae57872bea0a0ce";
const asset = "0x23238f20b894f29041f48d88ee91131c395aaa71";
const oracle = "0x5f7ecd0d045c393da6cb6c933c671ac305a871bf";
const queue = "0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e";
const foreign = "0x5353535353535353535353535353535353535353";
const feeRecipient = "0x5454545454545454545454545454545454545454";
const depositFeeBps = 10n;
const netAssets = (gross: bigint, bps = depositFeeBps, recipient = feeRecipient) =>
  recipient === ethers.ZeroAddress || bps === 0n ? gross : gross - (gross * bps + 9999n) / 10000n;
const pools = ["0x4141414141414141414141414141414141414141",
  "0x4242424242424242424242424242424242424242", "0x4343434343434343434343434343434343434343"];
const at = (tick: number) => ({ number: 700 + tick, generation: 700 + tick, hash: word(BigInt(700 + tick)) });
const source = at(0);
type Mode = "healthy" | "transport-failed" | "paused" | "blacklisted" | "oracle-rebound" |
  "slot-upgraded" | "code-upgraded" | "proxy-upgraded" | "event-net-mismatch" | "input-underdebit" |
  "zero-fee" | "zero-fee-recipient";
type Read = { readonly lane: string; readonly target: string; readonly method: string };

function fixtureRuntime(tick: number, lane: string, mode: Mode, reads: Read[]) {
  const current = at(tick);
  const feeBps = mode === "zero-fee" ? 0n : depositFeeBps;
  const recipient = mode === "zero-fee-recipient" ? ethers.ZeroAddress : feeRecipient;
  const net = (gross: bigint) => netAssets(gross, feeBps, recipient);
  return createStrictCentralAdapterRuntime({ executor,
    verifiedActors: { "erc4626-probe-actor": ERC4626_PROBE_ACTOR },
    generationFence: { assertCurrent(generation, requested) {
      assert.equal(generation, current.generation); assert.deepEqual(requested, current);
    } },
    provider: {
      async getCode(address, block) {
        assert.equal(block, current.number); const target = lower(address);
        reads.push({ lane, target, method: "get-code" });
        if (target === vault) return mode === "proxy-upgraded" ? "0x6001600055" : STAKED_USDAT_PROXY_CODE;
        if (target === implementation) return mode === "code-upgraded" ? "0x6001600055" : STAKED_USDAT_IMPLEMENTATION_CODE;
        return "0x6001600055";
      },
      async getStorage(address, slot, block) {
        assert.equal(block, current.number); assert.equal(lower(address), vault);
        assert.equal(slot, STAKED_USDAT_IMPLEMENTATION_SLOT);
        reads.push({ lane, target: vault, method: "implementation-slot" });
        return word(BigInt(mode === "slot-upgraded" ? foreign : implementation));
      },
      async call(request, block) {
        assert.equal(block, current.number); const target = lower(request.to);
        const selector = request.data.slice(0, 10);
        if (target === lower(INFINIFI_GATEWAY)) {
          const call = INFINIFI_ABI.parseTransaction({ data: request.data }); assert(call);
          assert.equal(call.name, "getAddress"); assert.equal(call.args[0], "stakedToken");
          reads.push({ lane, target, method: call.name });
          return INFINIFI_ABI.encodeFunctionResult(call.name, [foreign]);
        }
        if (pools.includes(target)) {
          assert.equal(selector, UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector);
          reads.push({ lane, target, method: "getReserves" });
          return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1000n * unit, 2000n * unit, source.number]);
        }
        if (selector === UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector) {
          const holder = lower(String(UNIV2_TOKEN_INTERFACE.decodeFunctionData("balanceOf", request.data)[0]));
          reads.push({ lane, target, method: "balanceOf" });
          return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf",
            [pools.includes(holder) ? target === lower(ADDR.WETH) ? 1000n * unit : 2000n * unit : 10n ** 30n]);
        }
        if (selector === ERC4626_ERC20_INTERFACE.getFunction("decimals")!.selector) {
          reads.push({ lane, target, method: "decimals" });
          return ERC4626_ERC20_INTERFACE.encodeFunctionResult("decimals", [18]);
        }
        if (target === vault) {
          const guard = STAKED_USDAT_INTERFACE.parseTransaction({ data: request.data });
          if (guard) {
            reads.push({ lane, target, method: guard.name });
            if (guard.name === "asset") return STAKED_USDAT_INTERFACE.encodeFunctionResult(guard.name, [asset]);
            if (guard.name === "getStrcOracle") return STAKED_USDAT_INTERFACE.encodeFunctionResult(guard.name,
              [mode === "oracle-rebound" ? foreign : oracle]);
            if (guard.name === "getWithdrawalQueue") return STAKED_USDAT_INTERFACE.encodeFunctionResult(guard.name, [queue]);
            if (guard.name === "depositFeeBps") return STAKED_USDAT_INTERFACE.encodeFunctionResult(guard.name, [feeBps]);
            if (guard.name === "feeRecipient") return STAKED_USDAT_INTERFACE.encodeFunctionResult(guard.name, [recipient]);
            if (guard.name === "paused") return STAKED_USDAT_INTERFACE.encodeFunctionResult(guard.name, [mode === "paused"]);
            if (guard.name === "isBlacklisted") {
              assert.equal(lower(String(guard.args[0])), executor);
              return STAKED_USDAT_INTERFACE.encodeFunctionResult(guard.name, [mode === "blacklisted"]);
            }
            assert.fail(`unexpected StakedUSDat guard ${guard.name}`);
          }
        }
        assert([vault, ordinary].includes(target));
        const call = ERC4626_INTERFACE.parseTransaction({ data: request.data }); assert(call);
        reads.push({ lane, target, method: call.name });
        if (call.name === "asset") return ERC4626_INTERFACE.encodeFunctionResult(call.name, [asset]);
        if (["totalAssets", "totalSupply"].includes(call.name))
          return ERC4626_INTERFACE.encodeFunctionResult(call.name, [10n ** 30n]);
        assert(["convertToShares", "convertToAssets", "previewDeposit", "previewRedeem"].includes(call.name));
        if (target === vault && lane !== "identity" && mode === "transport-failed" && call.name === "previewDeposit")
          throw new Error("synthetic offline preview transport failure");
        // Canned response drift represents a source-sensitive preview. It is
        // intentionally not an independent implementation of vesting/oracle math.
        const drift = target === vault && lane !== "identity" ? BigInt(Math.min(tick, 10)) : 0n;
        const amount = BigInt(call.args[0]);
        return ERC4626_INTERFACE.encodeFunctionResult(call.name,
          [(target === vault && call.name === "previewDeposit" ? net(amount) : amount) + drift]);
      },
    },
    simulator: { async simulate({ request, source: requested }) {
      assert.deepEqual(requested, current); assert.equal(lane, "identity");
      assert(["active-deposit", "active-redeem"].includes(request.id));
      const deposit = request.id === "active-deposit", name = deposit ? "deposit" : "redeem";
      const target = lower(request.call.to), amount = BigInt(ERC4626_INTERFACE.decodeFunctionData(name, request.call.data)[0]);
      const actor = lower(ERC4626_PROBE_ACTOR);
      if (target === vault && !deposit)
        throw Object.assign(new Error("execution reverted: queued withdrawal required"), { code: "CALL_EXCEPTION", data: "0x" });
      const shares = target === vault ? net(amount) : amount;
      // The real implementation debits gross assets in fee + net transfers,
      // while the superclass Deposit event records only net assets.
      const eventAssets = target === vault ? net(amount) + (mode === "event-net-mismatch" ? 1n : 0n) : amount;
      const debit = target === vault && mode === "input-underdebit" ? amount - 1n : amount;
      const event = ERC4626_INTERFACE.encodeEventLog(ERC4626_INTERFACE.getEvent(deposit ? "Deposit" : "Withdraw")!,
        deposit ? [actor, actor, eventAssets, shares] : [actor, actor, actor, amount, amount]);
      return { data: ERC4626_INTERFACE.encodeFunctionResult(name, [deposit ? shares : amount]), effects: {
        tokenDeltas: [{ token: deposit ? asset : target, account: actor, delta: -debit },
          { token: deposit ? target : asset, account: actor, delta: deposit ? shares : amount }],
        totalSupplyDeltas: [{ token: target, delta: deposit ? shares : -amount }],
        logs: [{ address: target, ...event }],
      } };
    } },
  });
}

const observation = (target: string) => ({ kind: "call" as const, target, source,
  data: ERC4626_INTERFACE.encodeFunctionData("deposit", [unit, executor]) });

async function rejectedLifecycle(familyId: FamilyId, mode: Mode) {
  const observed = observation(vault);
  const matches = catalog.matches(observed).filter(match => match.familyId === familyId)
    .map(match => ({ matchedPatternId: match.patternId, observation: observed }));
  assert(matches.length > 0, "the production catalog must actually nominate the observed candidate");
  const result = await executeAdapterFamilyLifecycleBatch({ family: catalog.forFamily(familyId), source,
    generation: source.generation, matches, runtime: fixtureRuntime(0, "identity", mode, []),
    publisher: { publish() { assert.fail("a rejected identity must not publish"); } } });
  assert.equal(result.publication, null);
  assert(result.outcomes.some(outcome => outcome.stage === "discovery" && outcome.status === "candidate"));
  const identities = result.outcomes.filter(outcome => outcome.stage === "identity");
  assert.equal(identities.length, 1);
  assert.deepEqual(identities[0]!.source, source); assert(identities[0]!.evidenceRefs.length > 0);
  return identities[0]!;
}

test("source-bound StakedUSDat identity admits a deposit-only proxy without ordinary ERC4626 duplication", async () => {
  for (const mode of ["proxy-upgraded", "code-upgraded", "oracle-rebound", "event-net-mismatch", "input-underdebit"] as const) {
    const rejected = await rejectedLifecycle(STAKED_USDAT_FAMILY_ID, mode);
    if (mode === "oracle-rebound") {
      assert.equal(rejected.status, "unresolved");
      assert.equal(rejected.reasonCode, "identity-work-unresolved:source-bound-staked-usdat-deposit:" +
        "family-decode:family decode failed: StakedUSDat getter binding mismatch");
    } else {
      const reason = mode === "proxy-upgraded" ? "staked_usdat_proxy_not_matched" :
        mode === "code-upgraded" ? "staked_usdat_implementation_not_matched" : "erc4626_execution_surfaces_failed";
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.reasonCode, `identity-proof-rejected:chain-proven:source-bound-staked-usdat-deposit:${reason}`);
    }
  }
  const admitted = await runStrictFamilyLifecycle({ catalog, familyId: STAKED_USDAT_FAMILY_ID, source,
    observations: [observation(vault)], runtime: fixtureRuntime(0, "identity", "healthy", []) });
  assert.equal(admitted.instances.length, 1); assert.equal(admitted.instances[0]!.routes.length, 1);
  assert.equal(Reflect.get(admitted.instances[0]!.routes[0]!, "direction"), "deposit");
  assert.deepEqual(Reflect.get(admitted.instances[0]!.descriptor, "verifiedDirections"), { deposit: true, redeem: false });
  const duplicate = await rejectedLifecycle(ERC4626_FAMILY_ID, "healthy");
  assert.equal(duplicate.status, "rejected", "the source-bound proxy belongs only to its specialized Family");
  assert.match(duplicate.reasonCode, /chain-proven:standalone-standard-behavior:erc4626_standard_views_failed/);
  for (const mode of ["zero-fee", "zero-fee-recipient"] as const) {
    const free = await runStrictFamilyLifecycle({ catalog, familyId: STAKED_USDAT_FAMILY_ID, source,
      observations: [observation(vault)], runtime: fixtureRuntime(0, "identity", mode, []) });
    assert.equal(free.instances.length, 1, `${mode} keeps the valid gross-assets Deposit event`);
    assert.equal(free.instances[0]!.routes.length, 1);
  }
});

test("StakedUSDat quiet effective refresh withdraws full failures and recovers while ordinary ERC4626 and V2 carry", async () => {
  const staked = await runStrictFamilyLifecycle({ catalog, familyId: STAKED_USDAT_FAMILY_ID, source,
    observations: [observation(vault)], runtime: fixtureRuntime(0, "identity", "healthy", []) });
  const standard = await runStrictFamilyLifecycle({ catalog, familyId: ERC4626_FAMILY_ID, source,
    observations: [observation(ordinary)], runtime: fixtureRuntime(0, "identity", "healthy", []) });
  assert.equal(staked.instances.length, 1); assert.equal(standard.instances.length, 1);
  const background = await Promise.all(pools.map((pool, i) => runUniv2Lifecycle(source, {
    pool, factory: "0x4444444444444444444444444444444444444444", token0: ADDR.WETH,
    token1: [asset, vault, ordinary][i]!, reserves: { reserve0: 1000n * unit, reserve1: 2000n * unit, blockTimestampLast: source.number },
  }, catalog)));
  const instances = [...staked.instances, ...standard.instances, ...background.flatMap(result => result.instances)];
  const edges = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[i],
  }))) }).edges;
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: edges, readyInstances: instances, readyFundingAssets: [] });
  const ownKeys = edges.map(blockScanEdgeKey).filter(key => root.pricingIndex().familyIdByEdgeKey.get(key) === STAKED_USDAT_FAMILY_ID);
  const ordinaryKeys = edges.map(blockScanEdgeKey).filter(key => root.pricingIndex().familyIdByEdgeKey.get(key) === ERC4626_FAMILY_ID);
  const otherKeys = edges.map(blockScanEdgeKey).filter(key => !ownKeys.includes(key));
  assert.equal(ownKeys.length, 1); assert.equal(ordinaryKeys.length, 2); assert.equal(otherKeys.length, 8);
  const stateKey = root.pricingIndex().stateKeyByEdgeKey.get(ownKeys[0]!)!;
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys, [stateKey]);
  assert(ordinaryKeys.every(key => !root.pricingIndex().perBlockRefreshStateKeys.includes(root.pricingIndex().stateKeyByEdgeKey.get(key)!)));
  const reads: Read[] = [], preparations: string[][] = [];
  let mode: Mode = "healthy", quoteCalls = 0;
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({ source: request.source,
    runtime: fixtureRuntime(request.source.number - source.number, "raw", mode, reads), fundingAssets: [],
    kind: request.purpose === "exact-execution" ? "exact" : "pricing", touchedPools: request.touchedPools,
    requiredEdgeIds: request.requiredEdgeIds, control: request.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const current = reuse?.quoteGraph ?? pricing;
    const requested = { number: current.sourceBlock, hash: current.sourceBlockHash, generation: current.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds, control,
      weth: ADDR.WETH, gasCostWei: null, enumerationSpreadBps: 50, concurrency: 2,
      prepareQuote: async requiredEdgeIds => { preparations.push([...requiredEdgeIds].sort());
        exact = await root.createSession({ source: requested, runtime: fixtureRuntime(requested.number - source.number, "exact", mode, reads),
          fundingAssets: [], kind: "exact", requiredEdgeIds, control }); },
      quote: async request => { quoteCalls++; assert(exact);
        const quote = await exact.issueExact({ ...request, executor, runtimeEvidence: [] }); assert("amountIn" in quote); return quote; },
    });
  });
  async function step(tick: number, oracleTouch = false) {
    reads.length = 0; preparations.length = 0; quoteCalls = 0;
    const current = at(tick);
    const touched = new Set(oracleTouch ? root.resolveBlockTouchedStateKeys({ kind: "log", address: oracle, topics: [], data: "0x" }, current) : []);
    assert.deepEqual([...touched], oracleTouch ? [stateKey] : [], "derived oracle dependency maps only to StakedUSDat");
    const graph = createVerifiedGraphView({ id: `staked-usdat-refresh-${tick}`, edges, generation: current.generation,
      sourceBlock: current.number, sourceBlockHash: current.hash, completenessWatermark: current.number,
      familyIdForEdge: edge => root.pricingIndex().familyIdByEdgeKey.get(blockScanEdgeKey(edge))!,
      perSourceCoverage: [...new Set(instances.map(instance => instance.familyId))].map(familyId => ({ familyId,
        sourceId: "offline", sourceFingerprint: "staked-usdat-refresh", completeThroughBlock: current.number, completeThroughHash: current.hash })),
    });
    await coordinator.prepareCoarsePricing({ graph, deadlineAtMs: Date.now() + 10000, touchedPools: touched,
      canonicalActivity: { source: current, parentHash: tick === 0 ? ethers.ZeroHash : at(tick - 1).hash,
        touchedStateKeys: touched, complete: true } });
    assert.deepEqual([...touched], oracleTouch ? [stateKey] : [], "scheduler must not mutate canonical touches");
    const snapshot = coordinator.latestPricingSnapshot()!;
    assert.equal(snapshot.sourceBlock, current.number); assert.equal(snapshot.sourceBlockHash, current.hash);
    assert.equal(snapshot.generation, current.generation);
    assert.deepEqual(snapshot.effectiveMids!.source, current); assert(snapshot.effectiveMids!.complete);
    return snapshot;
  }
  const baseline = await step(0);
  assert.equal(baseline.mids.size, 9); assert.equal(baseline.effectiveMids!.rows.size, 9);
  assert([...baseline.effectiveMids!.rows.values()].every(row => row.status === "quoted"));
  let previousHealthy = baseline;
  const modes: Mode[] = ["healthy", "healthy", "transport-failed", "transport-failed", "healthy",
    "blacklisted", "paused", "oracle-rebound", "slot-upgraded", "healthy", "healthy"];
  for (const [i, nextMode] of modes.entries()) {
    mode = nextMode; const tick = i + 1, snapshot = await step(tick, tick === 2);
    assert.strictEqual(snapshot.mids, baseline.mids); assert.deepEqual(snapshot.rawMidSource, source);
    assert(!reads.some(read => read.lane === "raw"), "startup raw mids remain immutable");
    assert(!reads.some(read => read.target === ordinary || pools.includes(read.target)), "ordinary and V2 need no reads");
    assert.equal(quoteCalls, 1); assert.deepEqual(preparations, [ownKeys]);
    assert.equal(reads.filter(read => read.method === "previewDeposit").length, mode === "transport-failed" ? 2 : 1,
      "only the Staked direction refreshes, with the existing bounded transport retry");
    for (const key of otherKeys) {
      assert.strictEqual(snapshot.effectiveMids!.rows.get(key), baseline.effectiveMids!.rows.get(key));
      assert.deepEqual(snapshot.effectiveMids!.rows.get(key)!.quotedAt, source);
      assert.equal(snapshot.pricingProvenanceByEdgeKey!.get(key), "carried"); assert(snapshot.coverage.carriedEdgeKeys.includes(key));
    }
    const row = snapshot.effectiveMids!.rows.get(ownKeys[0]!)!;
    assert.equal(row.status, mode === "healthy" ? "quoted" : "quote-failed", mode);
    if (mode === "healthy") {
      assert.deepEqual(row.quotedAt, at(tick)); assert(snapshot.coverage.resolvedEdgeKeys.includes(ownKeys[0]!));
      assert.equal(snapshot.pricingProvenanceByEdgeKey!.get(ownKeys[0]!), "refreshed");
      if (tick < 11) assert.notEqual(row.amountOut, previousHealthy.effectiveMids!.rows.get(ownKeys[0]!)!.amountOut);
      else assert.equal(row.amountOut, previousHealthy.effectiveMids!.rows.get(ownKeys[0]!)!.amountOut,
        "unchanged response still gets a fresh source-bound quote each block");
      previousHealthy = snapshot;
    } else {
      assert.equal(row.amountOut, null); assert.equal(row.effectiveMid, null); assert.equal(row.quotedAt, undefined);
      assert(snapshot.coverage.unresolvedEdgeKeys.includes(ownKeys[0]!)); assert(!snapshot.coverage.resolvedEdgeKeys.includes(ownKeys[0]!));
    }
  }
  reads.length = 0;
  const exact = await root.createSession({ source: at(12), runtime: fixtureRuntime(12, "runtime-construction", "healthy", reads),
    fundingAssets: [], kind: "exact", requiredEdgeIds: new Set(ownKeys) });
  const edge = edges.find(candidate => blockScanEdgeKey(candidate) === ownKeys[0])!;
  assert(exact.buildRuntimeAmountLeg({ edge, executor, runtimeEvidence: [] }));
  assert.equal(reads.length, 0, "later-source actual-receipt construction makes no off-chain guard or quote reads");
});
