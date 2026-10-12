import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import {
  applyRuntimeAssetBoundary, applyStrictAssetBoundary, applyQuotedAssetBoundary,
  executionAssetBoundaryAdapter,
} from "../../../../execution-asset-boundary.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { StrictProductionRuntimeRoot } from "../../../../strict-production-runtime-session.js";
import { plugin } from "../../../production-families/curve-underlying.production.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { executeAdapterFamilyLifecycleBatch, executeFamilyExactQuote, buildFamilyExecutionFragment } from "../../../adapter-family-runtime.js";
import { createBoundedRequestExecutor, declareRequestProgram } from "../../../adapter-request-program.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import type { PlanFragment } from "../../../route-leg-adapter.js";
import { CURVE_UNDERLYING_FAMILY_ID, CURVE_UNDERLYING_REGISTRY_LINEAGE_ID } from "../manifest.js";
import {
  CURVE_METAREGISTRY, CURVE_UNDERLYING_META_INTERFACE as META,
  CURVE_UNDERLYING_POOL_INTERFACE as LEGACY, CURVE_UNDERLYING_UINT_INTERFACE as UINT,
} from "../codec.js";
import {
  CURVE_UNDERLYING_NATIVE_ACTION, CURVE_UNDERLYING_NATIVE_QUOTE as QUOTE,
  underlyingNativeAliasProbe, underlyingNativeAliasProgram,
} from "../native.js";
import type { CurveUnderlyingDescriptor, CurveUnderlyingIdentity, CurveUnderlyingRoute } from "../types.js";

// Entirely offline. The only simulated state is the explicitly synthetic
// transport/ABI fixture below. Production owns discovery, identity scheduling,
// admission, quotes, asset boundaries, encoders and amount selection. This file
// neither opens an RPC connection nor proves historical EVM/TX acceptance.
const POOL = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const ACTOR = "0x3333333333333333333333333333333333333333";
const HANDLER = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const SOURCE: CanonicalSource = { number: 123, hash: ethers.id("underlying-native-offline-contract"), generation: 7 };
const CODE = "0x6000", BALANCE = 10n ** 24n, INVENTORY = 12345n;
const COINS = [ethers.getAddress(ADDR.WETH), TOKEN];
const AMOUNTS = [19n, 2_000_000_000_000_000n, 20_000_000_000_000_000n, 10n ** 18n + 23n];
const DIRECT = new ethers.Interface(["function get_coins(address) view returns(address[8])"]);
const GETTERS = new ethers.Interface(["function coins(uint256) view returns(address)", "function balances(uint256) view returns(uint256)"]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)",
  "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
  "function withdraw(uint256)", "function deposit() payable",
]);
const SUBSCRIPT = new ethers.Interface(["function execSubscript(bytes)"]);
const lower = (s: string) => s.toLowerCase();
const word = (n: bigint) => ethers.toBeHex(n, 32);
const pad = (values: readonly string[], n: number) => [...values, ...Array(n - values.length).fill(ethers.ZeroAddress)];
// A transport fixture response, deliberately amount-sensitive and not a Curve
// formula. Assertions below compare raw integers/calldata, never a point price.
const fixtureOutput = (amount: bigint) => amount * 2n + amount / 17n + 7n;
const ok = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({
  id, ok: true, completion: "returned", data, source: SOURCE,
  provenance: { kind: "offline-synthetic-contract", fingerprint: "curve-underlying-native-alias" },
});
// Native execution probes declare all three observations even on revert. An
// atomic revert retains no effects; omitted collections are transport-contract
// failures, not evidence that this direction failed to execute.
const revertedNativeExecution = (id: string): Extract<AdapterRequestResult, { ok: true }> => ({
  ...ok(id, "0x"), completion: "reverted-as-declared",
  effects: { tokenDeltas: [], nativeDeltas: [], logs: [] },
});

function scriptProgram(script: Uint8Array) {
  assert.equal(script[0], 0x0e);
  assert.equal(Number(BigInt(ethers.hexlify(script.slice(33, 36)))), script.length - 36);
  return { program: ethers.hexlify(script.slice(36)), amount: BigInt(ethers.hexlify(script.slice(1, 33))) };
}

type VmRoute = Pick<CurveUnderlyingRoute, "i" | "j" | "tokenIn" | "tokenOut" | "executionAssets">;
interface VmFaults {
  unspent?: bigint;
  extraDebit?: bigint;
  nativeLoss?: boolean;
  insufficient?: boolean;
  noCleanup?: boolean;
}

// Reuse the repository's bytecode interpreter, including recursive production
// asset envelopes. Only external token/pool responses are faked here.
function interpret(program: string, route: VmRoute, amount: bigint, receipt: bigint,
  minimum: bigint, faults: VmFaults = {}) {
  const nativeIn = route.executionAssets?.input === "native";
  const nativeOut = route.executionAssets?.output === "native";
  const balances = new Map([[lower(route.tokenIn), INVENTORY + amount], [lower(route.tokenOut), INVENTORY]]);
  if (faults.insufficient) balances.set(lower(route.tokenIn), amount - 1n);
  const initial = new Map(balances);
  let native = INVENTORY, allowance = 7n, exchanges = 0;
  const approvals: bigint[] = [], withdrawals: bigint[] = [], deposits: bigint[] = [];
  const context: Parameters<typeof inspectRuntime>[2] = {
    nativeBalance: () => native,
    call(c) {
      const target = lower(c.target);
      if (target === ACTOR) {
        const nested = scriptProgram(ethers.getBytes(SUBSCRIPT.decodeFunctionData("execSubscript", c.data)[0]));
        inspectRuntime(nested.program, nested.amount, context);
        return "0x";
      }
      if (target === POOL) {
        assert.deepEqual([...UINT.decodeFunctionData("exchange_underlying", c.data)],
          [BigInt(route.i), BigInt(route.j), amount, minimum]);
        assert.equal(c.value, nativeIn ? amount : 0n);
        const debit = amount - (faults.unspent ?? 0n) + (faults.extraDebit ?? 0n);
        if (nativeIn) native -= debit;
        else {
          assert.equal(allowance, amount, "approval must be precisely the current input");
          balances.set(lower(route.tokenIn), balances.get(lower(route.tokenIn))! - debit);
          if (!faults.noCleanup) allowance = 0n;
        }
        if (nativeOut) native += receipt;
        else balances.set(lower(route.tokenOut), balances.get(lower(route.tokenOut))! + receipt);
        exchanges++;
        return "0x";
      }
      const parsed = ERC20.parseTransaction({ data: c.data });
      assert(parsed, "unexpected external fixture call");
      if (parsed.name === "balanceOf") {
        assert.equal(lower(parsed.args[0]), ACTOR);
        assert(balances.has(target));
        return word(balances.get(target)!);
      }
      if (parsed.name === "allowance") {
        assert.equal(target, lower(route.tokenIn));
        assert.deepEqual([...parsed.args].map(lower), [ACTOR, POOL]);
        return word(allowance);
      }
      if (parsed.name === "approve") {
        assert.equal(target, lower(route.tokenIn)); assert.equal(lower(parsed.args[0]), POOL);
        approvals.push(parsed.args[1]);
        if (!(faults.noCleanup && exchanges > 0)) allowance = parsed.args[1];
        return word(1n);
      }
      assert.equal(target, lower(ADDR.WETH));
      if (parsed.name === "withdraw") {
        withdrawals.push(parsed.args[0]);
        balances.set(target, balances.get(target)! - parsed.args[0]); native += parsed.args[0];
      } else {
        assert.equal(parsed.name, "deposit"); deposits.push(c.value);
        native -= c.value; balances.set(target, balances.get(target)! + c.value);
        // Lose old ETH after wrapping, not merely one unit of a variable
        // protocol receipt (which is valid in the runtime-amount path).
        if (faults.nativeLoss) native--;
      }
      return "0x";
    },
  };
  const trace = inspectRuntime(program, amount, context);
  return { trace, balances, native, allowance, approvals, withdrawals, deposits, exchanges,
    effects: { tokenDeltas: [route.tokenIn, route.tokenOut].map(token => ({
      token, account: ACTOR, delta: balances.get(lower(token))! - initial.get(lower(token))!,
    })), nativeDeltas: [{ account: ACTOR, delta: native - INVENTORY }], logs: [] } };
}

interface LifecycleFixture {
  legacy?: "empty" | "revert" | "positive";
  coins?: readonly string[];
  direct?: readonly string[];
  poolCoins?: readonly string[];
  handlers?: readonly string[];
  code?: string;
  provenInputs?: readonly number[];
  hintedI?: number;
  hintedJ?: number;
  fault?: "short-output" | "unspent-input" | "overdebit" | "native" | "recipient" | "duplicate" | "missing" | "authority" | "deadline";
  foreign?: Partial<CanonicalSource>;
  receiptLoss?: bigint;
}

async function lifecycle(options: LifecycleFixture = {}) {
  const coins = options.coins ?? COINS, rounds: AdapterRequest[][] = [];
  const answers: AdapterRequestResult[] = [], simulatorFailures: string[] = [];
  function answer(r: AdapterRequest): AdapterRequestResult {
    if (r.kind === "get-code") return ok(r.id, options.code ?? CODE);
    if (r.id === "probe-executor") return { ...ok(r.id, word(0n)), effects: {
      tokenDeltas: [{ token: ADDR.WETH, account: ACTOR, delta: 0n }],
      nativeDeltas: [{ account: ACTOR, delta: options.fault === "authority" ? 1n : 0n }],
    } };
    if (r.kind === "effect-delta-simulation") {
      assert(r.id.startsWith("native-execution:"));
      const [, ii, jj] = r.id.split(":"), i = Number(ii), j = Number(jj);
      assert.equal(r.call.executionMode, "executor-program"); assert.equal(lower(r.call.to), ACTOR);
      assert.deepEqual(r.call.caller, { kind: "executor" });
      const boundary = r.executionAssetBoundary;
      const nativeIn = lower(coins[i]) === lower(ADDR.WETH), nativeOut = lower(coins[j]) === lower(ADDR.WETH);
      const funding = r.overrideIntent?.tokenBalances;
      assert.equal(funding?.length, 1); assert(funding);
      const amount = funding[0].amount;
      assert.equal(lower(funding[0].token), lower(coins[i]));
      if (nativeIn || nativeOut) {
        assert(boundary);
        assert.deepEqual([boundary.tokenIn, boundary.tokenOut].map(lower), [coins[i], coins[j]].map(lower));
        assert.deepEqual(boundary.executionAssets, {
          input: nativeIn ? "native" : "erc20", output: nativeOut ? "native" : "erc20",
        });
        assert.equal(boundary.amountIn, amount);
      } else {
        assert(!Object.hasOwn(r, "executionAssetBoundary"), "pure ERC20 directions must omit the native boundary entirely");
      }
      if (options.fault === "deadline") return { id: r.id, ok: false, source: SOURCE, failure: "deadline" };
      if (options.provenInputs && !options.provenInputs.includes(i)) return revertedNativeExecution(r.id);
      const wrapped = boundary ? applyStrictAssetBoundary({ boundary, executor: ACTOR, data: r.call.data }) : r.call.data;
      const script = scriptProgram(ethers.getBytes(SUBSCRIPT.decodeFunctionData("execSubscript", wrapped)[0]));
      assert.equal(script.amount, amount);
      let simulated: ReturnType<typeof interpret>;
      try {
        simulated = interpret(script.program, { i, j, tokenIn: coins[i], tokenOut: coins[j],
          ...(boundary ? { executionAssets: boundary.executionAssets } : {}) }, script.amount,
        fixtureOutput(amount) - (options.receiptLoss ?? 0n), boundary?.minimum ?? fixtureOutput(amount) - 1n);
      } catch (error) {
        simulatorFailures.push(String(error));
        return revertedNativeExecution(r.id);
      }
      const effects = simulated.effects;
      switch (options.fault) {
        case "short-output": effects.tokenDeltas[1].delta -= 2n; break;
        case "unspent-input": effects.tokenDeltas[0].delta += 2n; break;
        case "overdebit": effects.tokenDeltas[0].delta--; break;
        case "native": effects.nativeDeltas[0].delta++; break;
        case "recipient": effects.tokenDeltas[1].account = OTHER; break;
        case "duplicate": effects.tokenDeltas.push({ ...effects.tokenDeltas[1] }); break;
        case "missing": effects.nativeDeltas.length = 0; break;
      }
      return { ...ok(r.id, "0x"), effects };
    }
    assert.equal(r.kind, "eth-call");
    if (r.kind !== "eth-call") throw new Error("unexpected fixture transport");
    if (r.id === "registry-handlers") {
      assert.equal(lower(r.to), lower(CURVE_METAREGISTRY));
      return ok(r.id, META.encodeFunctionResult("get_registry_handlers_from_pool", [pad(options.handlers ?? [HANDLER], 10)]));
    }
    if (r.id === "registry-underlying" || r.id === "registry-underlying-coins")
      return ok(r.id, META.encodeFunctionResult("get_underlying_coins", [pad(coins, 8)]));
    if (r.id === "registry-direct") return ok(r.id, DIRECT.encodeFunctionResult("get_coins", [pad(options.direct ?? coins, 8)]));
    if (r.id.startsWith("coin:")) return ok(r.id, GETTERS.encodeFunctionResult("coins", [(options.poolCoins ?? coins)[Number(r.id.split(":")[1])]]));
    if (r.id.startsWith("balance:")) return ok(r.id, word(BALANCE));
    if (r.data === ERC20.encodeFunctionData("decimals")) return ok(r.id, word(18n));
    if (r.id === "current-registry-decimals") return ok(r.id, META.encodeFunctionResult("get_underlying_decimals", [Array(8).fill(18n)]));
    if (r.id === "current-registry-balances") return ok(r.id, META.encodeFunctionResult("get_underlying_balances", [Array(8).fill(BALANCE)]));
    if (r.data.startsWith(LEGACY.getFunction("get_dy_underlying")!.selector)) {
      if ((options.legacy ?? "empty") === "empty") return ok(r.id, "0x");
      // Unlike a simulation, eth-call must not return physical effects, even
      // when its deterministic revert is valid chain evidence for the decoder.
      if (options.legacy === "revert") return { ...ok(r.id, "0x"), completion: "reverted-as-declared" };
      const [, , amount] = LEGACY.decodeFunctionData("get_dy_underlying", r.data);
      return ok(r.id, word(fixtureOutput(amount)));
    }
    if (r.data.startsWith(QUOTE.getFunction("get_dy")!.selector)) {
      assert.equal(lower(r.to), POOL);
      const [, , amount] = QUOTE.decodeFunctionData("get_dy", r.data);
      const result = ok(r.id, word(fixtureOutput(amount)));
      return options.foreign && r.id.startsWith("quote:") ? { ...result, source: { ...SOURCE, ...options.foreign } } : result;
    }
    throw new Error("unhandled offline request: " + r.id);
  }
  let now = 1000;
  const runtime: any = {
    clock: { nowMs: () => now++ }, generationFence: { assertCurrent() {} },
    callerAuthority: { bind: () => ({ executor: ACTOR, transactionOrigin: HANDLER }) },
    policy: { bind: (input: any) => ({ lane: "critical-proof", deadlineAtMs: 100000, maxAttempts: 1,
      transportPool: "state-read", fairnessKey: input.subjectKey }) },
    budgets: { assertAdmitted() {} }, scheduler: { issueExecutor: () => ({
      executor: createBoundedRequestExecutor({
        assertSupported() {}, assertCallerBinding() {}, assertWithinBudget() {},
        async execute(input) {
          rounds.push([...input.requests]);
          const results = input.requests.map(answer); answers.push(...results); return results;
        },
        sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
      }), timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    }) },
  };
  const i = options.hintedI ?? 0;
  const observation = { kind: "call" as const, source: SOURCE, target: POOL,
    data: (options.legacy === "positive" ? LEGACY : UINT).encodeFunctionData("exchange_underlying", [i, options.hintedJ ?? 1 - i, AMOUNTS[1], 0n]) };
  const matches = catalog.matches(observation).filter(m => m.familyId === CURVE_UNDERLYING_FAMILY_ID)
    .map(m => ({ matchedPatternId: m.patternId, observation }));
  assert(matches.length > 0, "installed production catalog must discover the actual selector");
  const family = asPricedFamily(catalog.forFamily(CURVE_UNDERLYING_FAMILY_ID));
  const result = await executeAdapterFamilyLifecycleBatch({
    family, matches,
    source: SOURCE, generation: SOURCE.generation, runtime, publisher: { publish() {} },
  });
  return { result, rounds, answers, simulatorFailures, family, runtime };
}

function assertVerified(run: Awaited<ReturnType<typeof lifecycle>>) {
  assert.deepEqual(run.simulatorFailures, [], "offline execution of the emitted program must succeed");
  assert(run.result.outcomes.some(o => o.stage === "identity" && o.status === "verified"),
    JSON.stringify(run.result.outcomes.map(o => ({ stage: o.stage, status: o.status, reason: o.reasonCode }))));
  assert.equal(run.result.publication?.instances.length, 1);
  const instance = run.result.publication!.instances[0];
  assert(instance.routes.length > 0, "pricing and route publication must also complete");
  return instance;
}
function assertNotVerified(run: Awaited<ReturnType<typeof lifecycle>>) {
  assert(!run.result.outcomes.some(o => o.stage === "identity" && o.status === "verified"));
  assert.equal(run.result.publication?.instances.length ?? 0, 0);
}

function nativeProbeStep(d: CurveUnderlyingDescriptor, selected: bigint,
  quotes: CurveUnderlyingDescriptor["verifiedDirections"] = d.verifiedDirections) {
  return { candidate: { candidateKind: "curve-underlying-pool" as const, pool: POOL,
    sourceKind: "pool-surface" as const, hintedI: null, hintedJ: null }, step: 3, executionRoundingRawUnits: selected,
    evidence: { phase: "quotes", source: SOURCE, pool: POOL, coins: d.coins,
      handlers: d.registryBinding.handlers, alias: d.nativeAlias, executor: ACTOR,
      decimals: d.coins.map(() => 18), balances: d.coins.map(() => BALANCE),
      quotes, directions: [], requestIds: [] } };
}

test("production catalog/lifecycle continues after legacy int128 returned 0x and publishes native uint identity", async () => {
  assert.deepEqual(plugin.identity.variants.map(v => v.id), ["metaregistry-member", "metaregistry-uint-native-alias"]);
  const run = await lifecycle(), instance = assertVerified(run);
  const ids = run.rounds.map(round => round.map(r => r.id));
  const oldRound = ids.findIndex(round => round.some(id => id.startsWith("behavior-get-dy:")));
  const nativeRound = ids.findIndex(round => round.includes("registry-direct"));
  assert(oldRound >= 0 && nativeRound > oldRound, "do not remove, reorder or bypass the failing legacy variant");
  const oldAnswers = run.answers.filter(r => r.id.startsWith("behavior-get-dy:"));
  assert(oldAnswers.length > 0 && oldAnswers.every(r => r.ok && r.completion === "returned" && r.data === "0x"));
  assert.equal(ids.flat().filter(id => id === "probe-executor").length, 1);
  assert.equal(ids.flat().filter(id => id.startsWith("native-execution:")).length, 2);
  assert(!run.result.outcomes.some(o => o.reasonCode.includes("identity-step-budget-exhausted")));
  const d = instance.descriptor as CurveUnderlyingDescriptor;
  assert.deepEqual(d.coins.map(lower), COINS.map(lower));
  assert.deepEqual(d.nativeAlias, { nativeIndex: 0, poolCodeHash: ethers.keccak256(CODE) });
  assert.deepEqual(d.registryBinding.handlers.map(lower), [HANDLER]);
  assert.equal(d.provenance.some(p => p.kind === "curve-underlying-native-alias-registry-execution"), true);
  assert.deepEqual(instance.routes.map(r => [lower(r.tokenIn), lower(r.tokenOut), r.executionAssets]), [
    [lower(COINS[0]), TOKEN, { input: "native", output: "erc20" }],
    [TOKEN, lower(COINS[0]), { input: "erc20", output: "native" }],
  ]);
});

test("production identity publishes only execution-proven directions and preserves the observed-direction guard", async () => {
  for (const i of [0, 1]) {
    const run = await lifecycle({ provenInputs: [i], hintedI: i }), instance = assertVerified(run);
    assert.deepEqual((instance.descriptor as CurveUnderlyingDescriptor).verifiedDirections.map(d => [d.i, d.j]), [[i, 1 - i]]);
    assert.equal(instance.routes.length, 1);
    const reverted = run.answers.find(r => r.id === `native-execution:${1 - i}:${i}`);
    assert(reverted?.ok && reverted.completion === "reverted-as-declared");
    assert.deepEqual(reverted.effects, { tokenDeltas: [], nativeDeltas: [], logs: [] });
    const unproven = await lifecycle({ provenInputs: [i], hintedI: 1 - i });
    assertNotVerified(unproven);
    assert(!unproven.result.outcomes.some(o => o.reasonCode.includes("scheduler-failure")),
      "unproven observed direction must fail identity, not the transport result contract");
  }
  const noDirections = await lifecycle({ provenInputs: [] });
  assertNotVerified(noDirections);
  assert(!noDirections.result.outcomes.some(o => o.reasonCode.includes("scheduler-failure")));
  const legacyRevert = await lifecycle({ legacy: "revert" }); assertVerified(legacyRevert);
  const legacyAnswers = legacyRevert.answers.filter(r => r.id.startsWith("behavior-get-dy:"));
  assert(legacyAnswers.length > 0);
  assert(legacyAnswers.every(r => r.ok && r.completion === "reverted-as-declared" && r.effects === undefined));
  const reversed = assertVerified(await lifecycle({ coins: [TOKEN, COINS[0]] }));
  assert.equal((reversed.descriptor as CurveUnderlyingDescriptor).nativeAlias!.nativeIndex, 1);
});

test("three-coin production lifecycle admits all six directions and declaration validation accepts raw ERC20 probes", async () => {
  const run = await lifecycle({ coins: [COINS[0], TOKEN, OTHER], hintedI: 1, hintedJ: 2 });
  const instance = assertVerified(run), d = instance.descriptor as CurveUnderlyingDescriptor;
  assert.equal(d.coins.length, 3); assert.equal(instance.routes.length, 6);
  assert.equal(run.rounds.flat().filter(r => r.id.startsWith("native-execution:")).length, 6);
  const variant = plugin.identity.variants.find(v => v.id === "metaregistry-uint-native-alias"); assert(variant);
  const step = nativeProbeStep(d, 1n);
  const declare = (requests: readonly AdapterRequest[]) => declareRequestProgram({
    requirements: () => variant.requirements(step), buildRequests: () => requests, decode: ({ results }) => results,
  }, undefined);
  const declared = declare(variant.buildRequests(step));
  assert.equal(declared.requests.length, 6);
  assert.equal(declared.requests.filter(r => r.kind === "effect-delta-simulation" && r.executionAssetBoundary).length, 4);
  for (const [i, j] of [[1, 2], [2, 1]]) {
    const request = declared.requests.find(r => r.id === `native-execution:${i}:${j}`);
    assert(request?.kind === "effect-delta-simulation");
    assert(!Object.hasOwn(request, "executionAssetBoundary"));
    const route = plugin.routes.project({ descriptor: d }).find(r => r.i === i && r.j === j); assert(route);
    assert(!Object.hasOwn(route, "executionAssets"));
    const quote = d.verifiedDirections.find(q => q.i === i && q.j === j)!;
    const script = scriptProgram(ethers.getBytes(SUBSCRIPT.decodeFunctionData("execSubscript", request.call.data)[0]));
    assert.equal(script.amount, quote.behaviorProbeAmountIn);
    const simulated = interpret(script.program, route, script.amount, quote.behaviorProbeAmountOut, quote.behaviorProbeAmountOut - 1n);
    assert.equal(simulated.exchanges, 1);
    assert.deepEqual(simulated.effects.tokenDeltas.map(row => row.delta), [-script.amount, quote.behaviorProbeAmountOut]);
    assert.deepEqual(simulated.effects.nativeDeltas, [{ account: ACTOR, delta: 0n }]);
    assert.deepEqual(simulated.approvals, [0n, script.amount, 0n]); assert.equal(simulated.allowance, 0n);
    assert.deepEqual(simulated.withdrawals, []); assert.deepEqual(simulated.deposits, []);
    // Counterfactual for the reviewed P2: this is the real central validator,
    // not a test-local predicate that merely inspects the optional property.
    assert.throws(() => declare([{ ...request, executionAssetBoundary: {
      tokenIn: route.tokenIn, tokenOut: route.tokenOut, executionAssets: { input: "erc20", output: "erc20" },
      amountIn: script.amount, minimum: quote.behaviorProbeAmountOut - 1n,
    } }]), /boundary|declaration/);
  }
});

test("three-coin ERC20-only uint directions execute both quoted and runtime emitters with temporary approvals", async () => {
  const d = assertVerified(await lifecycle({ coins: [COINS[0], TOKEN, OTHER], hintedI: 2, hintedJ: 1 })).descriptor as CurveUnderlyingDescriptor;
  const routes = plugin.routes.project({ descriptor: d }).filter(r => r.i !== 0 && r.j !== 0);
  assert.deepEqual(routes.map(r => [r.i, r.j]), [[1, 2], [2, 1]]);
  for (const route of routes) for (const amount of AMOUNTS) {
    const output = fixtureOutput(amount), input = invocation(d, route, amount), quoted = fragment(input);
    assert.deepEqual(quoted.quote.evidence.nativeAlias, d.nativeAlias, "uint variant binding survives without a native asset boundary");
    assert.deepEqual(quoted.value.requirements, []);
    const node = quoted.value.nodes[0];
    assert.equal(node.adapterId, CURVE_UNDERLYING_NATIVE_ACTION);
    assert.equal(node.params.nativeIn, false); assert.equal(node.params.nativeOut, false);
    const action = plugin.actionAdapters.find(a => a.id === node.adapterId); assert(action);
    const encoded = scriptProgram(action.encode(node, ACTOR, new Uint8Array()));
    assert.equal(encoded.amount, amount);
    assert.strictEqual(applyQuotedAssetBoundary({ route, executor: ACTOR, amountIn: amount,
      minimum: output, inputToleranceRawUnits: 0n, fragment: quoted.value }), quoted.value);
    const runtimeInput = { descriptor: d, route, executor: ACTOR, runtimeEvidence: [] };
    for (const field of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(runtimeInput, field, { get() { throw Error("ERC20 runtime read quoted field: " + field); } });
    const raw = plugin.execution.buildRuntimeLeg!(runtimeInput); assert(raw);
    assert.equal(raw.actionAdapterId, CURVE_UNDERLYING_NATIVE_ACTION);
    assert.strictEqual(applyRuntimeAssetBoundary({ route, executor: ACTOR, leg: raw }), raw);
    for (const [program, minimum] of [[encoded.program, output], [raw.program, 1n]] as const) {
      const simulated = interpret(program, route, amount, output, minimum);
      assert.equal(simulated.exchanges, 1); assert.equal(simulated.native, INVENTORY);
      assert.equal(simulated.balances.get(lower(route.tokenIn)), INVENTORY);
      assert.equal(simulated.balances.get(lower(route.tokenOut)), INVENTORY + output);
      assert.deepEqual(simulated.approvals, [0n, amount, 0n]); assert.equal(simulated.allowance, 0n);
      assert.deepEqual(simulated.trace.allowances, [], "no standing allowance instruction");
      assert(!simulated.trace.calls.some(c => lower(c.target) === lower(ADDR.WETH) || lower(c.target) === ACTOR));
      assert.throws(() => interpret(program, route, amount, minimum - 1n, minimum), /checked uint256/);
      assert.throws(() => interpret(program, route, amount, output, minimum, { extraDebit: 1n }), /checked uint256/);
      assert.throws(() => interpret(program, route, amount, output, minimum, { noCleanup: true }), /mismatch/);
    }
    assert.throws(() => interpret(raw.program, route, 1n, 7n, 1n, { unspent: 1n }), /checked uint256/);
  }
});

test("registry membership, direct/underlying/WETH topology and direct getters are mandatory", async () => {
  for (const options of [
    { handlers: [] }, { code: "0x" }, { coins: [TOKEN, OTHER] },
    { direct: [COINS[0], OTHER] }, { direct: [TOKEN, COINS[0]] }, { direct: [COINS[0]] },
    { poolCoins: [COINS[0], OTHER] }, { coins: [COINS[0], COINS[0]] },
  ] satisfies LifecycleFixture[]) {
    const run = await lifecycle(options); assertNotVerified(run);
    assert(!run.rounds.flat().some(r => r.id.startsWith("native-execution:")), "invalid topology must not reach execution proof");
  }
});

test("foreign source, unresolved transport and malformed executor effects never certify native identity", async () => {
  for (const foreign of [{ number: SOURCE.number + 1 }, { generation: SOURCE.generation + 1 }, { hash: ethers.id("foreign-source") }]) {
    const run = await lifecycle({ foreign }); assertNotVerified(run);
    assert(run.rounds.flat().some(r => r.id.startsWith("quote:")), "negative must reach the affected round");
  }
  for (const fault of ["short-output", "unspent-input", "overdebit", "native", "recipient", "duplicate", "missing", "authority", "deadline"] as const) {
    const run = await lifecycle({ fault }); assertNotVerified(run);
    assert(run.rounds.flat().some(r => r.id === (fault === "authority" ? "probe-executor" : "native-execution:0:1")), fault);
  }
  // Production identity supplies the shared one-raw-unit ceiling. Two units
  // still fail the emitted minimum check; a native residue is never tolerance.
  assertVerified(await lifecycle({ receiptLoss: 1n }));
  const shortReceipt = await lifecycle({ receiptLoss: 2n });
  assertNotVerified(shortReceipt);
  assert(shortReceipt.simulatorFailures.length > 0, "negative receipt must reach the emitted program's minimum guard");
  assert(!shortReceipt.result.outcomes.some(o => o.reasonCode.includes("scheduler-failure")),
    "an emitted-program revert must remain execution evidence, not malformed transport output");
});

// Unit descriptors are synthetic, never inserted into Ready or the catalog.
// The separate lifecycle tests above obtain their descriptors from production.
function fixtureIdentity(native = true): CurveUnderlyingIdentity {
  const coins = native ? COINS : [TOKEN, OTHER];
  return { familyId: CURVE_UNDERLYING_FAMILY_ID, lineageId: CURVE_UNDERLYING_REGISTRY_LINEAGE_ID,
    subject: POOL, provenance: [], facts: { pool: POOL, coins,
      registryBinding: { registry: CURVE_METAREGISTRY, handlers: [HANDLER], lookupSemantics: "get_registry_handlers_from_pool+get_underlying_coins" },
      ...(native ? { nativeAlias: { nativeIndex: 0, poolCodeHash: ethers.keccak256(CODE) } } : {}),
      verifiedDirections: [0, 1].map(i => ({ i, j: 1 - i, tokenIn: coins[i], tokenOut: coins[1 - i],
        behaviorProbeAmountIn: AMOUNTS[1], behaviorProbeAmountOut: fixtureOutput(AMOUNTS[1]) })),
    } };
}
function descriptor(native = true) {
  const identity = fixtureIdentity(native);
  return plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
}
function invocation(d: CurveUnderlyingDescriptor, route: CurveUnderlyingRoute, amountIn: bigint) {
  return { descriptor: d, route, amountIn, source: SOURCE, executor: ACTOR, runtimeEvidence: [] };
}
function exact(input: ReturnType<typeof invocation>) {
  const method = plugin.exact.methods(input).find(m => m.kind === "request-program");
  assert(method?.kind === "request-program");
  const requests = method.program.buildRequests(input);
  assert.equal(requests.length, input.amountIn === 0n ? 0 : 1);
  if (input.amountIn > 0n) {
    assert.equal(requests[0].kind, "eth-call");
    const r = requests[0] as Extract<AdapterRequest, { kind: "eth-call" }>;
    assert.equal(lower(r.to), POOL);
    const abi = input.descriptor.nativeAlias ? QUOTE : LEGACY, name = input.descriptor.nativeAlias ? "get_dy" : "get_dy_underlying";
    assert.deepEqual([...abi.decodeFunctionData(name, r.data)], [BigInt(input.route.i), BigInt(input.route.j), input.amountIn]);
  }
  const initialResults = requests.map(r => ok(r.id, word(fixtureOutput(input.amountIn))));
  const result = method.program.decode({ programInput: input, initialResults, dependentEvidence: [] });
  return { result, method, requests, initialResults };
}
function fragment(input: ReturnType<typeof invocation>, minimum = fixtureOutput(input.amountIn), quoteToleranceRawUnits?: bigint) {
  const { result } = exact(input);
  return { quote: result, value: plugin.execution.buildFragment({ ...input, exactEvidence: result.evidence,
    quotedAmountOut: result.amountOut, minAmountOut: minimum,
    ...(quoteToleranceRawUnits === undefined ? {} : { quoteToleranceRawUnits }) }) };
}

// Encode only the actual fragment's nodes with their registered production
// encoders. In issuer tests the boundary and its policy already came from the
// production issuer; this helper never reconstructs either of them.
function encodeQuotedFragment(value: PlanFragment, route: CurveUnderlyingRoute) {
  assert.deepEqual(value.requirements, []); assert.equal(value.nodes.length, 1);
  const root = value.nodes[0], hasNative = route.executionAssets !== undefined;
  if (hasNative) { assert.equal(root.adapterId, executionAssetBoundaryAdapter.id); assert.equal(root.children.length, 1); }
  const node = hasNative ? root.children[0] : root;
  assert.equal(node.adapterId, CURVE_UNDERLYING_NATIVE_ACTION); assert.equal(node.children.length, 0);
  const action = plugin.actionAdapters.find(a => a.id === node.adapterId); assert(action);
  const inner = action.encode(node, ACTOR, new Uint8Array());
  return { ...scriptProgram(hasNative ? executionAssetBoundaryAdapter.encode(root, ACTOR, inner) : inner), node, root };
}

function assertSelectedInputTolerance(program: string, route: VmRoute, amount: bigint,
  output: bigint, minimum: bigint, selected: bigint) {
  assert(amount > 0n); assert(selected === 0n || selected === 1n);
  const checkReceipt = (simulation: ReturnType<typeof interpret>, residual: bigint) => {
    assert.equal(simulation.exchanges, 1); assert.equal(simulation.native, INVENTORY);
    assert.equal(simulation.balances.get(lower(route.tokenIn)), INVENTORY + residual);
    assert.equal(simulation.balances.get(lower(route.tokenOut)), INVENTORY + output);
    assert.deepEqual(simulation.effects.tokenDeltas.map(r => r.delta), [-amount + residual, output]);
    if (route.executionAssets?.input !== "native") {
      assert.equal(simulation.allowance, 0n); assert.deepEqual(simulation.approvals, [0n, amount, 0n]);
    }
  };
  checkReceipt(interpret(program, route, amount, output, minimum), 0n);
  const residualOne = () => interpret(program, route, amount, output, minimum, { unspent: 1n });
  // A fresh amount=1 program is supplied by each caller. Reusing a larger
  // quoted program would retain its fixed inner amount and test the wrong gate.
  if (selected === 0n || amount === 1n) assert.throws(residualOne, /checked uint256|mismatch/,
    selected === 0n ? "selected zero must reject residual one" : "tolerance one must not permit zero debit");
  else checkReceipt(residualOne(), 1n);
  for (const faults of [{ extraDebit: 1n }, { unspent: 2n }, { unspent: amount }])
    assert.throws(() => interpret(program, route, amount, output, minimum, faults), /checked uint256|mismatch/);
}

test("quoted Family action obeys selected 0/1 on all three-coin directions without hiding behind the native boundary", async () => {
  const d = assertVerified(await lifecycle({ coins: [COINS[0], TOKEN, OTHER], hintedI: 1, hintedJ: 2 })).descriptor as CurveUnderlyingDescriptor;
  const routes = plugin.routes.project({ descriptor: d }); assert.equal(routes.length, 6);
  for (const route of routes) {
    for (const amount of [1n, ...AMOUNTS]) for (const selected of [undefined, 0n, 1n]) {
      const output = fixtureOutput(amount), quoted = fragment(invocation(d, route, amount), output, selected);
      const bounded = applyQuotedAssetBoundary({ route, executor: ACTOR, amountIn: amount,
        minimum: output, inputToleranceRawUnits: 1n, fragment: quoted.value });
      const encoded = encodeQuotedFragment(bounded, route);
      assert.equal(encoded.amount, amount);
      assert.equal(encoded.node.params.inputToleranceRawUnits, selected ?? 0n);
      // Deliberately keep the outer native boundary permissive (1). Its own
      // selected-zero guard must not mask a missing Family input-debit guard.
      if (route.executionAssets) assert.equal(encoded.root.params.inputToleranceRawUnits, 1n);
      else assert.strictEqual(bounded, quoted.value, "ERC20 A<->B has no outer boundary to enforce its policy");
      assertSelectedInputTolerance(encoded.program, route, amount, output, output, selected ?? 0n);
    }
    const output = fixtureOutput(19n), node = fragment(invocation(d, route, 19n)).value.nodes[0];
    const action = plugin.actionAdapters.find(a => a.id === node.adapterId); assert(action);
    for (const invalid of [-1n, 2n]) {
      assert.throws(() => {
        const invalidNode = fragment(invocation(d, route, 19n), output, invalid).value.nodes[0];
        action.encode(invalidNode, ACTOR, new Uint8Array());
      }, "invalid Family policy must not silently become the default tolerance");
      assert.throws(() => action.encode({ ...node, params: { ...node.params, inputToleranceRawUnits: invalid } },
        ACTOR, new Uint8Array()), "action encoding must reject tolerance outside 0/1");
      assert.throws(() => underlyingNativeAliasProgram(POOL, route.tokenIn, route.tokenOut, route.i, route.j,
        ACTOR, route.executionAssets?.input === "native", route.executionAssets?.output === "native", output, invalid));
    }
  }
});

test("strict probes forward admission tolerance to the actual uint emitter, including ERC20 A<->B", async () => {
  const d = assertVerified(await lifecycle({ coins: [COINS[0], TOKEN, OTHER], hintedI: 1, hintedJ: 2 })).descriptor as CurveUnderlyingDescriptor;
  const variant = plugin.identity.variants.find(v => v.id === "metaregistry-uint-native-alias"); assert(variant);
  for (const route of plugin.routes.project({ descriptor: d })) {
    for (const amount of [1n, ...AMOUNTS]) for (const selected of [0n, 1n]) {
      const output = fixtureOutput(amount), minimum = output - selected;
      const quote = { i: route.i, j: route.j, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
        behaviorProbeAmountIn: amount, behaviorProbeAmountOut: output };
      const step = nativeProbeStep(d, selected, [quote]);
      const declared = declareRequestProgram({ requirements: () => variant.requirements(step),
        buildRequests: () => variant.buildRequests(step), decode: ({ results }) => results }, undefined);
      assert.equal(declared.requests.length, 1);
      const request = declared.requests[0]; assert(request.kind === "effect-delta-simulation");
      assert.deepEqual(request, underlyingNativeAliasProbe(POOL, d.coins, d.nativeAlias!, quote, ACTOR, selected));
      assert.equal(Object.hasOwn(request, "executionAssetBoundary"), route.executionAssets !== undefined);
      const data = request.executionAssetBoundary ? applyStrictAssetBoundary({
        boundary: request.executionAssetBoundary, executor: ACTOR, data: request.call.data,
      }) : request.call.data;
      const encoded = scriptProgram(ethers.getBytes(SUBSCRIPT.decodeFunctionData("execSubscript", data)[0]));
      assert.equal(encoded.amount, amount);
      assertSelectedInputTolerance(encoded.program, route, amount, output, minimum, selected);
      // Output tolerance is independent from input debit and remains bounded.
      assert.equal(interpret(encoded.program, route, amount, minimum, minimum).exchanges, 1);
      assert.throws(() => interpret(encoded.program, route, amount, minimum - 1n, minimum), /checked uint256/);
      for (const invalid of [-1n, 2n]) {
        assert.throws(() => underlyingNativeAliasProbe(POOL, d.coins, d.nativeAlias!, quote, ACTOR, invalid));
        assert.throws(() => variant.buildRequests(nativeProbeStep(d, invalid, [quote])));
      }
    }
  }
});

test("production issuer carries selected 0/1 from real lifecycle and Exact handles into native and ERC20 quoted actions", async () => {
  const run = await lifecycle({ coins: [COINS[0], TOKEN, OTHER], hintedI: 1, hintedJ: 2 });
  const instance = assertVerified(run); assert.equal(instance.routes.length, 6);
  // No fake issuer, manually issued handles or mutations to the loaded box.
  // Only the existing lifecycle transport's ABI results are synthetic.
  for (const [index, storedRoute] of instance.routes.entries()) for (const amount of [1n, ...AMOUNTS]) {
    const route = storedRoute as CurveUnderlyingRoute, handle = instance.routeHandles[index];
    const beforeQuote = run.rounds.length;
    const quote = await executeFamilyExactQuote({ family: run.family, route: handle, amountIn: amount,
      executor: ACTOR, runtimeEvidence: [], source: SOURCE, generation: SOURCE.generation,
      runtime: run.runtime, requireChainAmountQuote: true, actionOwnership: catalog });
    assert(quote.status === "resolved", quote.outcome.reasonCode);
    assert.equal(quote.amountIn, amount); assert.equal(quote.amountOut, fixtureOutput(amount));
    assert.equal(quote.routeKey, route.routeKey); assert.deepEqual(quote.source, SOURCE);
    const requests = run.rounds.slice(beforeQuote).flat(); assert.equal(requests.length, 1);
    assert(requests[0].kind === "eth-call"); assert.equal(lower(requests[0].to), POOL);
    assert.deepEqual([...QUOTE.decodeFunctionData("get_dy", requests[0].data)], [BigInt(route.i), BigInt(route.j), amount]);
    const afterQuote = run.rounds.length;
    const build = (selected?: bigint) => buildFamilyExecutionFragment({ family: run.family, actionOwnership: catalog,
      route: handle, exact: quote, minAmountOut: quote.amountOut, executor: ACTOR, runtimeEvidence: [],
      ...(selected === undefined ? {} : { quoteToleranceRawUnits: selected }) });
    for (const selected of [undefined, 0n, 1n]) {
      const execution = build(selected); assert(execution.status === "resolved", execution.outcome.reasonCode);
      const encoded = encodeQuotedFragment(execution.fragment, route);
      assert.equal(encoded.amount, amount);
      assert.equal(encoded.node.params.inputToleranceRawUnits, selected ?? 0n,
        "central execution issuer must forward the validated policy to the Family, not only its own envelope");
      if (route.executionAssets) {
        assert.equal(encoded.root.params.inputToleranceRawUnits, selected);
        assert.equal(Object.hasOwn(encoded.root.params, "inputToleranceRawUnits"), selected !== undefined);
      } else assert.strictEqual(encoded.root, encoded.node);
      assertSelectedInputTolerance(encoded.program, route, amount, quote.amountOut, quote.amountOut, selected ?? 0n);
    }
    for (const invalid of [-1n, 2n]) {
      const execution = build(invalid);
      assert.equal(execution.status, "failed", "issuer rejects invalid tolerance before issuing a fragment");
      assert(!Object.hasOwn(execution, "fragment"));
    }
    assert.equal(run.rounds.length, afterQuote, "execution construction is synchronous and does not make more transport calls");
  }
});

test("Exact preserves specified uint get_dy amounts, source and native evidence binding", () => {
  const d = descriptor();
  for (const route of plugin.routes.project({ descriptor: d })) {
    for (const amount of AMOUNTS) {
      const input = invocation(d, route, amount), { result, method, initialResults } = exact(input);
      assert.equal(result.amountOut, fixtureOutput(amount));
      assert.equal(result.evidence.amountIn, amount); assert.equal(result.evidence.amountOut, result.amountOut);
      assert.deepEqual(result.evidence.source, SOURCE); assert.deepEqual(result.evidence.nativeAlias, d.nativeAlias);
      assert.equal(result.evidence.routeKey, route.routeKey); assert.equal(result.evidence.kind, "curve-underlying-get-dy");
      for (const foreign of [{ number: SOURCE.number + 1 }, { generation: SOURCE.generation + 1 }, { hash: ethers.id("foreign-quote") }])
        assert.throws(() => method.program.decode({ programInput: input, dependentEvidence: [],
          initialResults: initialResults.map(r => ({ ...r, source: { ...SOURCE, ...foreign } })) }), /source/);
      for (const data of ["0x", "0x01", word(0n)])
        assert.throws(() => method.program.decode({ programInput: input, dependentEvidence: [], initialResults: [ok(initialResults[0].id, data)] }));
    }
    assert.equal(exact(invocation(d, route, 0n)).result.amountOut, 0n);
    const input = invocation(d, route, 1n), { method } = exact(input);
    for (const amountIn of [-1n, ethers.MaxUint256 + 1n]) assert.throws(() => method.program.buildRequests({ ...input, amountIn }), /uint256/);
    assert.equal(method.program.buildRequests({ ...input, amountIn: ethers.MaxUint256 }).length, 1);
    assert.throws(() => method.program.buildRequests({ ...input, route: { ...route, tokenOut: OTHER } }), /descriptor/);
  }
});

test("quoted uint action and runtime emitter preserve exact calldata, inventories, receipt wrapping and approval cleanup", () => {
  const d = descriptor();
  for (const route of plugin.routes.project({ descriptor: d })) for (const amount of AMOUNTS) {
    const input = invocation(d, route, amount), output = fixtureOutput(amount);
    const runtimeInput = { descriptor: d, route, executor: ACTOR, runtimeEvidence: [] };
    for (const field of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(runtimeInput, field, { get() { throw Error("runtime read quoted field: " + field); } });
    const raw = plugin.execution.buildRuntimeLeg!(runtimeInput); assert(raw);
    assert.equal(raw.actionAdapterId, CURVE_UNDERLYING_NATIVE_ACTION);
    const guarded = applyRuntimeAssetBoundary({ route, executor: ACTOR, leg: raw });
    const runtime = interpret(guarded.program, route, amount, output, 1n);
    const quoted = fragment(input), node = quoted.value.nodes[0];
    assert.deepEqual(quoted.value.requirements, []); assert.equal(node.adapterId, CURVE_UNDERLYING_NATIVE_ACTION);
    const action = plugin.actionAdapters.find(a => a.id === node.adapterId); assert(action);
    const inner = action.encode(node, ACTOR, new Uint8Array());
    const boundary = applyQuotedAssetBoundary({ route, executor: ACTOR, amountIn: amount,
      minimum: output, inputToleranceRawUnits: 0n, fragment: quoted.value });
    const encoded = scriptProgram(executionAssetBoundaryAdapter.encode(boundary.nodes[0], ACTOR, inner));
    assert.equal(encoded.amount, amount);
    const fixed = interpret(encoded.program, route, amount, output, output);
    for (const simulation of [runtime, fixed]) {
      assert.equal(simulation.exchanges, 1); assert.equal(simulation.native, INVENTORY);
      assert.equal(simulation.balances.get(lower(route.tokenIn)), INVENTORY);
      assert.equal(simulation.balances.get(lower(route.tokenOut)), INVENTORY + output);
      if (route.executionAssets!.input === "native") {
        assert.deepEqual(simulation.withdrawals, [amount]); assert.deepEqual(simulation.approvals, []);
      } else {
        assert.equal(simulation.allowance, 0n); assert.deepEqual(simulation.approvals, [0n, amount, 0n]);
        assert.deepEqual(simulation.deposits, [output]);
      }
    }
    assert.deepEqual(plugin.execution.expectedEffects({ descriptor: d, route, amountIn: amount, quotedAmountOut: output }), [
      { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
      { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
    ]);
    assert.deepEqual(plugin.execution.runtimeProjection({ hop: { adapterId: node.adapterId, target: POOL,
      tokenIn: route.tokenIn, tokenOut: route.tokenOut } }), { allowanceSpender: null, prewarmQuoteCalls: [] });
    assert.throws(() => interpret(encoded.program, route, amount, output - 1n, output), /checked uint256/);
    for (const faults of [{ insufficient: true }, { extraDebit: 1n }, { nativeLoss: true }, { unspent: 2n }, { unspent: amount }])
      assert.throws(() => interpret(guarded.program, route, amount, output, 1n, faults), /mismatch|checked uint256/);
    if (route.executionAssets!.input === "erc20")
      assert.throws(() => interpret(guarded.program, route, amount, output, 1n, { noCleanup: true }), /mismatch/);
    assert.throws(() => interpret(guarded.program, route, amount, 0n, 1n), /checked uint256/);
  }
});

test("quoted evidence cannot cross variants, bindings or amounts; invalid raw action and runtime routes fail closed", () => {
  const d = descriptor(), legacy = descriptor(false);
  for (const route of plugin.routes.project({ descriptor: d })) {
    const input = invocation(d, route, 19n), { result } = exact(input);
    const build = (patch: object) => plugin.execution.buildFragment({ ...input, exactEvidence: result.evidence,
      quotedAmountOut: result.amountOut, minAmountOut: result.amountOut, ...patch });
    for (const evidence of [
      { ...result.evidence, nativeAlias: undefined },
      { ...result.evidence, nativeAlias: { ...d.nativeAlias!, nativeIndex: 1 } },
      { ...result.evidence, nativeAlias: { ...d.nativeAlias!, poolCodeHash: ethers.id("wrong-implementation") } },
      { ...result.evidence, pool: OTHER }, { ...result.evidence, amountIn: 20n },
      { ...result.evidence, amountOut: result.amountOut + 1n },
      { ...result.evidence, tokenOut: OTHER }, { ...result.evidence, kind: "curve-underlying-classic-meta" },
    ]) assert.throws(() => build({ exactEvidence: evidence }), /incompatible/);
    assert.throws(() => build({ descriptor: { ...d, nativeAlias: undefined } }), /incompatible/);
    for (const minAmountOut of [-1n, result.amountOut + 1n]) assert.throws(() => build({ minAmountOut }), /amount/);
    for (const amountIn of [0n, -1n, ethers.MaxUint256 + 1n])
      assert.throws(() => build({ amountIn, exactEvidence: { ...result.evidence, amountIn } }), /amount/);
    assert.throws(() => build({ quotedAmountOut: 0n, exactEvidence: { ...result.evidence, amountOut: 0n } }), /amount/);
    const zeroMinimum = build({ minAmountOut: 0n }), node = zeroMinimum.nodes[0];
    const action = plugin.actionAdapters.find(a => a.id === node.adapterId)!;
    assert(action.encode(node, ACTOR, new Uint8Array()).length > 0, "zero minimum is allowed; shared safety gates still apply");
    for (const params of [
      { ...node.params, i: 8n }, { ...node.params, j: node.params.i },
      { ...node.params, nativeIn: true, nativeOut: true }, { ...node.params, minDy: -1n },
    ]) assert.throws(() => action.encode({ ...node, params }, ACTOR, new Uint8Array()));
    assert.throws(() => action.encode({ ...node, amount: 0n }, ACTOR, new Uint8Array()));
    assert.throws(() => action.encode(node, ACTOR, new Uint8Array([1])));
    for (const wrong of [{ ...route, tokenOut: OTHER }, { ...route, executionAssets: undefined },
      { ...route, executionAssets: { input: "erc20" as const, output: "erc20" as const } }])
      assert.throws(() => plugin.execution.buildRuntimeLeg!({ descriptor: d, route: wrong, executor: ACTOR, runtimeEvidence: [] }));
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ descriptor: legacy, route, executor: ACTOR, runtimeEvidence: [] }));
  }
  const mixed = fixtureIdentity();
  assert.throws(() => plugin.instance.compileDraft({ ...mixed, facts: { ...mixed.facts,
    quoteModel: { kind: "classic-meta-base-3pool-v1" } as NonNullable<CurveUnderlyingDescriptor["quoteModel"]> } }));
});

test("runtime raw default remains one unit on all three-coin directions but never permits zero actual input debit", async () => {
  const d = assertVerified(await lifecycle({ coins: [COINS[0], TOKEN, OTHER], hintedI: 1, hintedJ: 2 })).descriptor as CurveUnderlyingDescriptor;
  for (const route of plugin.routes.project({ descriptor: d })) {
    const raw = plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor: ACTOR, runtimeEvidence: [] }); assert(raw);
    const leg = applyRuntimeAssetBoundary({ route, executor: ACTOR, leg: raw });
    for (const amount of [1n, ...AMOUNTS])
      assertSelectedInputTolerance(leg.program, route, amount, fixtureOutput(amount), 1n, 1n);
  }
});

test("legacy int128 remains discoverable, quotable and executable when native topology does not apply", async () => {
  const run = await lifecycle({ legacy: "positive", coins: [TOKEN, OTHER] }), instance = assertVerified(run);
  const d = instance.descriptor as CurveUnderlyingDescriptor;
  assert.equal(d.nativeAlias, undefined);
  assert.equal(instance.routes.length, 2);
  for (const route of plugin.routes.project({ descriptor: d })) for (const amount of AMOUNTS) {
    const input = invocation(d, route, amount), quoted = fragment(input);
    assert.equal(quoted.quote.evidence.nativeAlias, undefined);
    assert.equal(quoted.value.nodes[0].adapterId, "curve-exchange-underlying");
    assert.equal(route.executionAssets, undefined);
    const leg = plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor: ACTOR, runtimeEvidence: [] }); assert(leg);
    const trace = inspectRuntime(leg.program, amount);
    const calls = trace.calls.filter(c => lower(c.target) === POOL);
    assert.equal(calls.length, 1);
    assert.deepEqual([...LEGACY.decodeFunctionData("exchange_underlying", calls[0].data)], [BigInt(route.i), BigInt(route.j), amount, 1n]);
    assert.equal(trace.allowances[0].minimum, amount);
    assert.deepEqual(plugin.execution.runtimeProjection({ hop: { adapterId: "curve-exchange-underlying", target: POOL,
      tokenIn: route.tokenIn, tokenOut: route.tokenOut } }), { allowanceSpender: POOL, prewarmQuoteCalls: [] });
  }
});

test("native pricing is each-block, legacy stays on-touch, and the production pricing index consumes both policies", async () => {
  for (const native of [true, false]) {
    const run = await lifecycle(native ? {} : { legacy: "positive", coins: [TOKEN, OTHER] });
    const instance = assertVerified(run), d = instance.descriptor as CurveUnderlyingDescriptor;
    for (const route of plugin.routes.project({ descriptor: d })) {
      const pricing = plugin.pricing.finalizePricingDescriptor({ sharedBindings: [],
        draft: plugin.pricing.compileDraft({ descriptor: d, routes: [route], stateKey: route.routeKey }) });
      assert.equal(plugin.pricing.refreshPolicyForInstance!({ descriptor: pricing, routes: [route] }),
        native ? "each-block" : "on-touch");
    }
    // Exercise the existing production consumer with issued lifecycle handles;
    // no manually admitted instances, injected edges or alternate scheduler.
    const edges = buildFamilyRouteGraphView({ routes: instance.routes.map((route, i) => ({
      family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor,
      route, handle: instance.routeHandles[i],
    })) }).edges;
    assert.equal(edges.length, 2);
    const root = new StrictProductionRuntimeRoot({ catalog, readySource: SOURCE, readyGraph: edges,
      readyInstances: [instance], readyFundingAssets: [] });
    const index = root.pricingIndex(), allStateKeys = [...new Set(index.stateKeyByEdgeKey.values())].sort();
    assert.equal(allStateKeys.length, 2);
    assert.deepEqual([...index.perBlockRefreshStateKeys].sort(), native ? allStateKeys : []);
    // This checks production registration of quiet-block refresh work, not a
    // historical timed refresh or a separate reimplementation of the scheduler.
  }
});

test("production sim amount selector forwards selected 0/1 with zero Exact, quoted fallback and RPC calls", async () => {
  const threeCoin = assertVerified(await lifecycle({ coins: [COINS[0], TOKEN, OTHER], hintedI: 1, hintedJ: 2 })).descriptor as CurveUnderlyingDescriptor;
  for (const d of [descriptor(true), descriptor(false), threeCoin]) {
    for (const route of plugin.routes.project({ descriptor: d })) for (const selected of [0n, 1n]) {
      const raw = plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor: ACTOR, runtimeEvidence: [] }); assert(raw);
      const leg = applyRuntimeAssetBoundary({ route, executor: ACTOR, leg: raw });
      const edges: any[] = [{ adapterId: leg.actionAdapterId, target: POOL, tokenIn: route.tokenIn, tokenOut: route.tokenOut },
        { adapterId: "fixture-return", target: ACTOR, tokenIn: route.tokenOut, tokenOut: route.tokenIn }];
      let exactCalls = 0, quotedCalls = 0, rpcCalls = 0, simulated = 0;
      const events: any[] = [];
      const session: any = { source: SOURCE, fundingActionIds: () => ["fixture-funding"],
        buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? leg : {
          actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()),
        }; },
        issueExact() { exactCalls++; throw Error("unexpected Exact"); },
        buildExecution() { quotedCalls++; throw Error("unexpected quoted fallback"); },
        buildFundingRoot(input: any) { return { adapterId: "fixture-funding", target: ACTOR, tokenIn: route.tokenIn,
          tokenOut: route.tokenIn, amount: input.amount, params: {}, children: input.children }; },
      };
      const selector = createBlockScanSimAmountSelector({ source: SOURCE, executor: ACTOR, record: event => events.push(event),
        async simulate(plan) {
          simulated++;
          const flow = plan.root.children[0]; assert(flow);
          assert.equal(flow.adapterId, "runtime-amount-flow");
          assert.equal(JSON.parse(flow.params.legs as string)[0].program, leg.program);
          assert.equal(flow.params.quoteToleranceRawUnits, selected);
          return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: route.tokenIn, calldata: "0x" };
        } });
      await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
        flashToken: route.tokenIn, profitToken: route.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n,
        templateName: "offline-underlying-native-contract" } as any,
      { call() { rpcCalls++; throw Error("unexpected RPC"); } } as any, { executor: ACTOR } as any,
      { strictSession: session, quoteToleranceRawUnits: selected, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 30000 });
      assert.deepEqual([exactCalls, quotedCalls, rpcCalls], [0, 0, 0]); assert(simulated >= 4);
      const construction = events.filter(event => event.type === "sim_amount_construction");
      assert(construction.length > 0); assert(construction.every(event => event.mode === "runtime-actual"));
    }
  }
});
