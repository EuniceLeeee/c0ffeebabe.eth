import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { applyRuntimeAssetBoundary } from "../../../../execution-asset-boundary.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { plugin } from "../../../production-families/curve-plain.production.js";
import { CURVE_PLAIN_FAMILY_ID, CURVE_PLAIN_LINEAGE } from "../manifest.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { ERC20, EXECUTION, META, POOL, routeToken, isNativeCoin } from "../codec.js";
import { nativeExchangeProgram } from "../native.js";
import type { CurvePlainDescriptor } from "../types.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import { createBoundedRequestExecutor } from "../../../adapter-request-program.js";
import { executeAdapterFamilyLifecycleBatch } from "../../../adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { executionData } from "../codec.js";

const pool = "0x1111111111111111111111111111111111111111", token = "0x2222222222222222222222222222222222222222";
const actor = "0x3333333333333333333333333333333333333333", handler = "0x4444444444444444444444444444444444444444";
const native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", coins = [native, token];
const source = { number: 123, hash: ethers.id("native-fixture"), generation: 1 };
const word = (n: bigint) => ethers.toBeHex(n, 32);
const balance = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
  "function withdraw(uint256)", "function deposit() payable"]);
const d: CurvePlainDescriptor = { familyId: CURVE_PLAIN_FAMILY_ID, lineageId: CURVE_PLAIN_LINEAGE,
  instanceKey: instanceKey(pool), pool, provenance: [], runtimeRequirements: [],
  binding: { quoteAbi: "int128", coinAbi: "uint256", balanceAbi: "uint256", registry: handler,
    handlers: [handler], codeHash: ethers.keccak256("0x6000"), coins, decimals: [18, 18] },
  directions: [0, 1].map(i => ({ i, j: 1 - i, tokenIn: routeToken(coins[i]), tokenOut: routeToken(coins[1 - i]),
    amountIn: 10n, amountOut: 20n, executionMode: "native-exchange" as const })) };

// Emitter interpreter only. Same-N EVM execution is a separate acceptance.
function run(i: number, amount: bigint, options: { short?: boolean; extraDebit?: boolean; nativeLoss?: boolean;
  noCleanup?: boolean; insufficient?: boolean; minimum?: bigint; unspent?: bigint } = {}) {
  const inventory = 12345n, receipt = amount * 2n - (options.short ? 1n : 0n);
  const balances = new Map([[ADDR.WETH.toLowerCase(), inventory + (i === 0 ? amount : 0n)],
    [token, inventory + (i === 1 ? amount : 0n)]]);
  if (options.insufficient) balances.set(routeToken(coins[i]).toLowerCase(), amount - 1n);
  let nativeBalance = inventory, allowance = 7n, exchanges = 0;
  const program = nativeExchangeProgram(pool, routeToken(coins[i]), routeToken(coins[1 - i]), i, 1 - i,
    "native-exchange", actor, i === 0, options.minimum ?? amount * 2n);
  const route = plugin.routes.project({ descriptor: d }).find(r => r.i === i)!;
  const guarded = applyRuntimeAssetBoundary({ route, executor: actor,
    leg: { actionAdapterId: "curve-native-exchange", program: ethers.hexlify(program.bytes()) } });
  const context: Parameters<typeof inspectRuntime>[2] = {
    nativeBalance: () => nativeBalance,
    call(c) {
      const target = c.target.toLowerCase();
      if (target === actor) {
        const sub = new ethers.Interface(["function execSubscript(bytes)"]);
        const script = ethers.getBytes(sub.decodeFunctionData("execSubscript", c.data)[0]);
        inspectRuntime(ethers.hexlify(script.slice(36)), BigInt(ethers.hexlify(script.slice(1, 33))), context);
        return "0x";
      }
      if (target === pool) {
        const args = EXECUTION["native-exchange"].decodeFunctionData("exchange", c.data);
        assert.deepEqual([...args], [BigInt(i), BigInt(1 - i), amount, options.minimum ?? amount * 2n]);
        assert.equal(c.value, i === 0 ? amount : 0n); exchanges++;
        if (i === 0) { nativeBalance -= amount; balances.set(token, balances.get(token)! + receipt); }
        else {
          assert.equal(allowance, amount);
          balances.set(token, balances.get(token)! - amount - (options.extraDebit ? 1n : 0n) + (options.unspent ?? 0n));
          allowance -= amount; nativeBalance += receipt;
        }
        if (options.nativeLoss) nativeBalance--;
        return "0x";
      }
      const parsed = balance.parseTransaction({ data: c.data }); assert(parsed);
      if (parsed.name === "balanceOf") { assert.equal(parsed.args[0].toLowerCase(), actor); return word(balances.get(target)!); }
      if (parsed.name === "allowance") return word(allowance);
      if (parsed.name === "approve") { if (!(options.noCleanup && exchanges)) allowance = parsed.args[1]; return word(1n); }
      assert.equal(target, ADDR.WETH.toLowerCase());
      if (parsed.name === "withdraw") { assert.equal(parsed.args[0], amount); balances.set(target, balances.get(target)! - amount); nativeBalance += amount; }
      else { assert.equal(parsed.name, "deposit"); assert.equal(c.value, i === 0 ? 0n : receipt - (options.nativeLoss ? 1n : 0n));
        nativeBalance -= c.value; balances.set(target, balances.get(target)! + c.value); }
      return "0x";
    },
  };
  const trace = inspectRuntime(guarded.program, amount, context);
  assert.equal(exchanges, 1); assert.equal(nativeBalance, inventory);
  assert.equal(balances.get(routeToken(coins[i]).toLowerCase()), inventory + (options.unspent ?? 0n));
  assert.equal(balances.get(routeToken(coins[1 - i]).toLowerCase()), inventory + receipt);
  if (i === 1) assert.equal(allowance, 0n);
  return trace;
}

test("native direct-coin runtime preserves inventories and transfers only current input/receipt", () => {
  for (const i of [0, 1]) for (const amount of [19n, 2_000_000_000_000_000n, 10n ** 18n]) run(i, amount);
  for (const i of [0, 1]) {
    assert.throws(() => run(i, 19n, { short: true }), /checked uint256/);
    assert.throws(() => run(i, 19n, { insufficient: true }), /checked uint256/);
    assert.throws(() => run(i, 19n, { nativeLoss: true }), /mismatch|checked uint256/);
  }
  assert.throws(() => run(1, 19n, { extraDebit: true }), /checked uint256/);
  run(1, 19n, { unspent: 1n });
  assert.throws(() => run(1, 19n, { unspent: 2n }), /checked uint256/);
});

test("native dual construction uses production Family routes, source quotes and no runtime Exact", () => {
  assert.equal(isNativeCoin(ethers.ZeroAddress), false);
  for (const route of plugin.routes.project({ descriptor: d })) {
    const input = { descriptor: d, route, executor: actor, runtimeEvidence: [] };
    for (const field of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(input, field, { get() { throw new Error("read " + field); } });
    const leg = plugin.execution.buildRuntimeLeg!(input); assert(leg);
    const exact = { kind: "curve-plain-get-dy" as const, quoteAbi: route.quoteAbi, source,
      binding: route.bindingRef.fingerprint, routeKey: route.routeKey, amountIn: 19n, amountOut: 38n };
    const fragment = plugin.execution.buildFragment({ descriptor: d, route, executor: actor, runtimeEvidence: [], source,
      amountIn: 19n, quotedAmountOut: 38n, minAmountOut: 38n, exactEvidence: exact });
    assert.deepEqual(fragment.requirements, []);
    const node = fragment.nodes[0], action = plugin.actionAdapters.find(a => a.id === node.adapterId)!;
    const script = action.encode(node, actor, new Uint8Array()); assert.equal(script[0], 0x0e);
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input, route: { ...route, tokenIn: native } }), /descriptor/);
    assert.throws(() => action.encode({ ...node, params: { ...node.params, nativeIn: !node.params.nativeIn } }, actor, new Uint8Array()), /binding/);
  }
});

function nativeIdentity(corrupt?: "authority" | "output" | "output2" | "input" | "input2" | "overdebit" | "native" | "unknown",
  answers?: Map<string, AdapterRequestResult>, executionRoundingRawUnits = 0n) {
  const variant = plugin.identity.variants[0], candidate = { candidateKind: "curve-plain-pool" as const, pool, hintedI: null, hintedJ: null };
  let evidence: any;
  const ok = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, ok: true, data, source,
    provenance: { kind: "fixture", fingerprint: "native" }, completion: "returned" });
  const pad = (values: string[], n: number) => [...values, ...Array(n - values.length).fill(ethers.ZeroAddress)];
  for (let step = 0; step < 6; step++) {
    const input = { candidate, step, evidence, executionRoundingRawUnits }, decision = variant.decide(input);
    if (decision.status !== "continue") return decision;
    const { requests } = declareRequestProgram({
      requirements: () => variant.requirements(input),
      buildRequests: () => variant.buildRequests(input),
      decode: results => results,
    }, undefined);
    assert(!requests.some(r => r.kind === "eth-call" && r.to.toLowerCase() === native), "never read native sentinel as ERC20");
    const results: AdapterRequestResult[] = requests.map(r => {
      if (r.id === "native-executor") return { ...ok(r.id, word(0n)), effects: {
        tokenDeltas: [{ token: ADDR.WETH, account: actor, delta: 0n }], nativeDeltas: [{ account: actor, delta: corrupt === "authority" ? 1n : 0n }] } };
      if (r.kind === "effect-delta-simulation") {
        assert.equal(r.call.executionMode, "executor-program"); assert.equal(r.call.to.toLowerCase(), actor);
        if (corrupt === "unknown") return { id: r.id, ok: false, source, failure: "deadline" };
        const q = evidence.quotes.find((q: any) => r.id.startsWith(`execution:${q.i}:${q.j}:`)); assert(q);
        return { ...ok(r.id, "0x"), effects: { tokenDeltas: [
          { token: q.tokenIn, account: actor, delta: -q.amountIn +
            (corrupt === "input" ? 1n : corrupt === "input2" ? 2n : corrupt === "overdebit" ? -1n : 0n) },
          { token: q.tokenOut, account: actor, delta: q.amountOut - (corrupt === "output" ? 1n : corrupt === "output2" ? 2n : 0n) }],
          nativeDeltas: [{ account: actor, delta: corrupt === "native" ? 1n : 0n }], logs: [] } };
      }
      if (r.kind === "get-code") return ok(r.id, "0x6000");
      if (r.kind !== "eth-call") throw new Error("unexpected request");
      if (r.id === "registry-handlers") return ok(r.id, META.encodeFunctionResult("get_registry_handlers_from_pool", [pad([handler], 10)]));
      if (r.id === "registry-coins") return ok(r.id, META.encodeFunctionResult("get_coins", [pad(coins, 8)]));
      if (r.id === "amplification") return ok(r.id, word(100n));
      if (r.id === "fee") return ok(r.id, word(1_000_000n));
      if (r.id.startsWith("coin-int128") || r.id.startsWith("balance-int128")) return { ...ok(r.id, "0x"), completion: "reverted-as-declared" };
      if (r.id.startsWith("coin:")) return ok(r.id, POOL.encodeFunctionResult("coins", [coins[Number(r.id.split(":")[1])]]));
      if (r.id.startsWith("balance:")) return ok(r.id, word(10n ** 24n));
      if (r.data === ERC20.encodeFunctionData("decimals")) return ok(r.id, word(18n));
      if (r.id.startsWith("quote:")) return ok(r.id, word(r.id.endsWith(":0") ? 99n : 990n));
      throw new Error(r.id);
    });
    for (const result of results) answers?.set(result.id, result);
    evidence = variant.decode({ step: input, results });
  }
  throw new Error("native identity did not terminate");
}
test("native identity binds real coins, symbolic actor, WETH graph assets and exact effects", () => {
  const decision = nativeIdentity(); assert.equal(decision.status, "verified");
  if (decision.status === "verified") {
    assert.deepEqual(decision.identity.facts.binding.coins.map(x => x.toLowerCase()), coins);
    assert.equal(decision.identity.facts.directions.length, 2);
    assert(decision.identity.facts.directions.every(d => d.executionMode === "native-exchange" && d.tokenIn !== native && d.tokenOut !== native));
  }
  assert.throws(() => nativeIdentity("authority"), /authority/);
  assert.throws(() => nativeIdentity("unknown"), /unresolved/);
  for (const corrupt of ["output", "input", "native"] as const) assert.equal(nativeIdentity(corrupt).status, "retryable");
  for (const corrupt of ["output", "input"] as const) assert.equal(nativeIdentity(corrupt, undefined, 1n).status, "verified");
  for (const corrupt of ["output2", "input2", "overdebit", "native"] as const)
    assert.equal(nativeIdentity(corrupt, undefined, 1n).status, "retryable");
});

test("mixed native pool declares effects for executable directions, not all pool coins", () => {
  const other = "0x5555555555555555555555555555555555555555";
  for (const variant of plugin.identity.variants) {
    const input = { candidate: { candidateKind: "curve-plain-pool" as const, pool, hintedI: null, hintedJ: null }, step: 3,
      evidence: { phase: "quotes", source, pool, binding: { ...d.binding, coins: [native, token, other], decimals: [18, 18, 18] },
        executor: actor, quotes: [
          { i: 1, j: 2, tokenIn: token, tokenOut: other, amountIn: 19n, amountOut: 38n },
          { i: 2, j: 1, tokenIn: other, tokenOut: token, amountIn: 19n, amountOut: 38n },
        ], directions: [], balances: [], requestIds: [] } };
    const declared = declareRequestProgram({ requirements: () => variant.requirements(input),
      buildRequests: () => variant.buildRequests(input), decode: results => results }, undefined);
    assert(declared.requests.length > 0);
    assert(!declared.requirements.effects?.includes("native-delta"));
    assert(declared.requests.every(r => r.kind === "effect-delta-simulation" && r.call.executionMode === "impersonated-call-frame"));
  }
});

test("native identity runs through the production catalog and default four-round lifecycle", async () => {
  const answers = new Map<string, AdapterRequestResult>();
  nativeIdentity(undefined, answers);
  const rounds: string[][] = [];
  let now = 1000;
  const runtime: any = { clock: { nowMs: () => now++ }, generationFence: { assertCurrent() {} },
    callerAuthority: { bind: () => ({ executor: actor, transactionOrigin: handler }) },
    policy: { bind: (input: any) => ({ lane: "critical-proof", deadlineAtMs: 100000, maxAttempts: 1,
      transportPool: "state-read", fairnessKey: input.subjectKey }) }, budgets: { assertAdmitted() {} },
    scheduler: { issueExecutor: () => ({ executor: createBoundedRequestExecutor({
      assertSupported() {}, assertCallerBinding() {}, assertWithinBudget() {},
      async execute(input) {
        rounds.push(input.requests.map(r => r.id));
        return input.requests.map(request => {
          const answer = answers.get(request.id);
          assert(answer, "fixture intentionally does not cover pricing-current");
          return answer;
        });
      }, sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    }), timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }) }) } };
  const observation = { kind: "call" as const, source, target: pool,
    data: executionData("native-exchange", 0, 1, 10n ** 18n, 1n, actor) };
  const matches = catalog.matches(observation).filter(m => m.familyId === CURVE_PLAIN_FAMILY_ID)
    .map(m => ({ matchedPatternId: m.patternId, observation }));
  assert(matches.length > 0);
  const result = await executeAdapterFamilyLifecycleBatch({ family: asPricedFamily(catalog.forFamily(CURVE_PLAIN_FAMILY_ID)),
    matches, source, generation: source.generation, runtime, publisher: { publish() {} } });
  assert(result.outcomes.some(o => o.stage === "identity" && o.status === "verified"),
    JSON.stringify(result.outcomes.map(o => ({ stage: o.stage, status: o.status, reason: o.reasonCode }))));
  assert(!result.outcomes.some(o => o.reasonCode?.includes("identity-step-budget-exhausted")));
  assert(rounds[1].includes("native-executor"), "authority read shares the existing structure round");
  assert.equal(rounds[3].filter(id => id.startsWith("execution:")).length, 2);
  assert.equal(rounds.slice(0, 4).flat().filter(id => id === "native-executor").length, 1);
  // No publication/pricing/on-chain assertion: this is the real identity scheduler
  // and catalog with synthetic transport results, not historical execution.
});

test("production sim selector builds both native directions without Exact, quoted fallback or RPC", async () => {
  for (const route of plugin.routes.project({ descriptor: d })) {
    const leg = plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor: actor, runtimeEvidence: [] }); assert(leg);
    const edges: any[] = [{ adapterId: leg.actionAdapterId, target: pool, tokenIn: route.tokenIn, tokenOut: route.tokenOut },
      { adapterId: "fixture-return", target: actor, tokenIn: route.tokenOut, tokenOut: route.tokenIn }];
    let exact = 0, quoted = 0, rpc = 0, simulated = 0; const events: any[] = [];
    const session: any = { source, fundingActionIds: () => ["fixture-funding"],
      buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? leg : { actionAdapterId: "fixture-return", program: "0x010001" + "00".repeat(32) }; },
      issueExact() { exact++; throw Error("unexpected Exact"); }, buildExecution() { quoted++; throw Error("unexpected quoted"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture", target: actor, tokenIn: route.tokenIn,
        tokenOut: route.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source, executor: actor, record: e => events.push(e),
      async simulate(plan) { simulated++; const flow = plan.root.children[0]!;
        assert.equal(flow.adapterId, "runtime-amount-flow"); assert.equal(JSON.parse(flow.params.legs as string)[0].program, leg.program);
        assert.equal(flow.params.quoteToleranceRawUnits, 1n);
        return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: route.tokenIn, calldata: "0x" }; } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
      flashToken: route.tokenIn, profitToken: route.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "synthetic-native" } as any,
      { call() { rpc++; throw Error("unexpected RPC"); } } as any, { executor: actor } as any,
      { strictSession: session, quoteToleranceRawUnits: 1n, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 30000 });
    assert.equal(exact, 0); assert.equal(quoted, 0); assert.equal(rpc, 0); assert(simulated >= 4);
    assert(events.some(e => e.type === "sim_amount_construction"));
    assert(events.filter(e => e.type === "sim_amount_construction").every(e => e.mode === "runtime-actual"));
  }
});
