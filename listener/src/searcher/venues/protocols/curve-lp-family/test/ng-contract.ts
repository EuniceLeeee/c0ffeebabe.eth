import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { declareRequestProgram, type AdapterRequest, type AdapterRequestResult } from "../../../adapter-request-program.js";
import { ABI, META } from "../codec.js";
import { NG, NG_META, ngIdentityVariant, ngProgram, ngStateRequests, ngQuoteRequest } from "../ng.js";
import { program, requests } from "../exact.js";
import { execution } from "../execution.js";
import { instance } from "../instance.js";
import { routes } from "../routes.js";
import { discovery } from "../discovery.js";
import { pricing } from "../pricing.js";
import { action } from "../action.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { source, addr, actor, attest as attestLegacy } from "./fixtures.js";

// All amounts below are synthetic chain responses. No duplicated NG formula is
// used as a correctness oracle; historical view/receipt parity is a separate run.
const sourceRuntime = JSON.parse(readFileSync(new URL("ng-source-runtime.json", import.meta.url), "utf8"));
function fixture(count = 2, variant: "v7" | "v6" | "meta" = "v7") { const f = { pool: addr(201), factory: addr(202), views: addr(203),
  coins: Array.from({ length: count }, (_v, i) => addr(210 + i)), decimals: [18, 6, 8, 18, 9, 12, 18, 18].slice(0, count),
  code: "0x60016000", supply: 2_000_000n * 10n ** 18n, reverse: addr(201), native: false,
  change: (_r: any) => {}, quotedDelta: 0n, unavailableWithdrawIndex: -1 };
  const prefix = variant === "meta" ? sourceRuntime.metaPrefixBytes : variant === "v6" ? sourceRuntime.v6PrefixBytes : sourceRuntime.prefixBytes;
  const bytes = ethers.getBytes(variant === "meta" ? sourceRuntime.meta : variant === "v6" ? sourceRuntime.v6 : sourceRuntime.pool), word = (i: number, n: bigint) => bytes.set(ethers.getBytes(ethers.toBeHex(n, 32)), prefix + i * 32);
  if (variant === "meta") { assert.equal(count, 2); word(13, BigInt(f.factory)); word(14, 2n); word(15, BigInt(f.coins[0])); word(16, BigInt(f.coins[1])); }
  else { word(0, BigInt(count)); word(1, BigInt(count)); word(2, BigInt(f.factory)); word(3, BigInt(count));
    for (let i = 0; i < 8; i++) word(4 + i, i < count ? BigInt(f.coins[i]) : 0n);
    for (const lengthWord of variant === "v7" ? [12, 22, 31, 40, 49] : [12, 21, 30, 39]) word(lengthWord, BigInt(count)); }
  f.code = ethers.hexlify(bytes); return f;
}
type Fixture = ReturnType<typeof fixture>;
const row = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, ok: true, source, completion: "returned", data,
  provenance: { kind: "synthetic", fingerprint: "curve-lp-ng-contract" } });
function quote(f: Fixture, direction: "mint" | "redeem", index: number, amount: bigint): bigint {
  const scale = 10n ** BigInt(18 - f.decimals[index]);
  return direction === "mint" ? amount * scale * 99n / 100n : amount * 99n / 100n / scale;
}
function parse(data: string) { try { const p = NG.parseTransaction({ data }); if (p) return { abi: NG, parsed: p }; } catch {}
  try { const p = NG_META.parseTransaction({ data }); if (p) return { abi: NG_META, parsed: p }; } catch {}
  const p = ABI.parseTransaction({ data }); if (!p) throw new Error("unexpected synthetic call"); return { abi: ABI, parsed: p }; }
function resolve(f: Fixture, req: AdapterRequest): AdapterRequestResult {
  if (req.kind === "get-code") return row(req.id, req.address.toLowerCase() === f.pool ? f.code : req.address.toLowerCase() === f.views ? sourceRuntime.views : "0x6000");
  if (req.kind === "effect-delta-simulation") {
    if (req.id === "ng-actor") return { ...row(req.id, ABI.encodeFunctionResult("balanceOf", [0n])), effects: {
      tokenDeltas: [{ token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", account: actor, delta: 0n }], nativeDeltas: [{ account: actor, delta: 0n }] } };
    const { parsed: p } = parse(req.call.data), mint = p.name === "add_liquidity", direction = mint ? "mint" : "redeem",
      index = mint ? [...p.args[0]].findIndex(v => v > 0n) : Number(p.args[1]), amount = mint ? p.args[0][index] : p.args[0],
      recipient = String(p.args[mint ? 2 : 3]).toLowerCase(), tokenIn = mint ? f.coins[index] : f.pool, tokenOut = mint ? f.pool : f.coins[index], out = quote(f, direction, index, amount);
    const result: any = { ...row(req.id, NG.encodeFunctionResult(p.name, [out])), effects: {
      tokenDeltas: req.observeTokenBalances!.map(v => { const account = typeof v.account === "string" ? v.account.toLowerCase() : actor, token = v.token.toLowerCase();
        const delta = token === tokenIn && account === actor ? -amount : token === tokenIn && account === f.pool ? mint ? amount : 0n :
          token === tokenOut && account === recipient ? out : token === tokenOut && account === f.pool ? mint ? 0n : -out : 0n;
        return { token, account, delta }; }),
      totalSupplyDeltas: [{ token: f.pool, delta: mint ? out : -amount }], nativeDeltas: [{ account: actor, delta: 0n }], logs: [] } };
    f.change(result); return result;
  }
  if (req.kind !== "eth-call") throw new Error("unexpected synthetic request");
  const { abi, parsed: p } = parse(req.data); let values: unknown[];
  switch (p.name) {
    case "get_registry_handlers_from_pool": values = [[addr(250), ...Array(9).fill(ethers.ZeroAddress)]]; break;
    case "get_lp_token": values = [f.pool]; break;
    case "get_pool_from_lp_token": values = [f.reverse]; break;
    case "get_coins": values = [[...f.coins, ...Array(8 - f.coins.length).fill(ethers.ZeroAddress)]]; break;
    case "coins": values = [f.coins[Number(p.args[0])]]; break;
    case "N_COINS": values = [f.coins.length]; break;
    case "factory": case "get_base_registry": values = [f.factory]; break;
    case "views_implementation": values = [f.views]; break;
    case "decimals": values = [req.to.toLowerCase() === f.pool ? 18 : f.decimals[f.coins.indexOf(req.to.toLowerCase())]]; break;
    case "totalSupply": values = [f.supply]; break;
    case "A_precise": values = [10000n]; break;
    case "fee": values = [1000000n]; break;
    case "balances": values = [1_000_000n * 10n ** BigInt(f.decimals[Number(p.args[0])])]; break;
    case "calc_token_amount": { const index = [...p.args[0]].findIndex(v => v > 0n); values = [quote(f, "mint", index, p.args[0][index]) + f.quotedDelta]; break; }
    case "calc_withdraw_one_coin": values = [f.unavailableWithdrawIndex === Number(p.args[1]) ? 0n : quote(f, "redeem", Number(p.args[1]), p.args[0]) + f.quotedDelta]; break;
    default: throw new Error("unexpected synthetic ABI " + p.name);
  }
  return row(req.id, abi.encodeFunctionResult(p.signature, values));
}
function attest(f: Fixture) { let step: any = { candidate: { candidateKind: "curve-lp", pool: f.pool }, step: 0 };
  for (let k = 0; k < 8; k++) { const declared = declareRequestProgram({ requirements: ngIdentityVariant.requirements,
    buildRequests: ngIdentityVariant.buildRequests, decode: () => null }, step);
    const results = declared.requests.map(r => resolve(f, r)); step = { ...step, step: k + 1, evidence: ngIdentityVariant.decode({ step, results }) };
    const decision = ngIdentityVariant.decide(step); if (decision.status !== "continue") return decision;
  } throw new Error("NG fixture did not finish"); }
function setup(f: Fixture) { const decision = attest(f); assert.equal(decision.status, "verified", JSON.stringify(decision)); assert(decision.status === "verified");
  const d = instance.compileDraft(decision.identity), rs = routes.project({ descriptor: d }); return { d, rs }; }

test("old source class is retained; NG self-LP supports each proved coin/direction without pool allowlists", () => {
  assert.equal(attestLegacy().decision.status, "verified");
  for (const [n, variant] of [[2, "v7"], [3, "v7"], [4, "v7"], [8, "v7"], [2, "v6"], [2, "meta"]] as const) { const f = fixture(n, variant), { d, rs } = setup(f); assert.equal(d.lp, d.pool); assert.equal(rs.length, 2 * n);
    assert.deepEqual([...new Set(rs.map(r => r.index))], Array.from({ length: n }, (_v, i) => i));
    assert(d.ng!.directions.every(r => r.directOutput)); }
});
test("non-original runtime nominations survive to strict; no-code and successful reverse contradictions are not RPC", async () => {
  const f = fixture(); const observations = await discovery.nominate!.nominate({ nominations: [{ address: f.pool, opaque: { familyId: "protocol:curve-lp" } }],
    source, provider: { async getCode() { return f.code; } } } as any);
  assert.equal(observations.length, 1); assert.equal(observations[0].kind, "address-surface");
  const validCode = f.code; f.code = "0x"; assert.equal(attest(f).status, "chain-proven-rejected"); f.code = validCode; f.reverse = addr(251);
  assert.equal(attest(f).status, "chain-proven-rejected");
});
test("view parity, actual payer debit, receiver, LP supply and native conservation independently gate NG", () => {
  for (const change of [
    (r: any) => { r.effects.tokenDeltas[0].delta = 0n; },
    (r: any) => { r.effects.tokenDeltas[2].delta -= 1n; },
    (r: any) => { r.effects.totalSupplyDeltas[0].delta = 0n; },
    (r: any) => { r.effects.nativeDeltas[0].delta = 1n; },
    (r: any) => { r.source = { ...source, hash: ethers.id("foreign") }; },
  ]) { const f = fixture(); f.change = change; assert.notEqual(attest(f).status, "verified"); }
  const f = fixture(); f.quotedDelta = 1n; assert.notEqual(attest(f).status, "verified");
});
test("source class and immutable factory/coin binding reject spoofed registry responses", () => {
  const unknown = fixture(); unknown.code = "0x60016000"; const decision: any = attest(unknown);
  assert.equal(decision.status, "retryable"); assert.match(decision.reasonCode, /unsupported NG runtime class/);
  const factory = fixture(); factory.factory = addr(254); assert.notEqual(attest(factory).status, "verified");
  const coins = fixture(); coins.coins[0] = addr(255); assert.notEqual(attest(coins).status, "verified");
});
test("unproved external receiver does not remove a proved default direction", () => {
  const f = fixture(); f.change = r => { if (r.id.endsWith("receiver")) r.completion = "reverted-as-declared"; };
  const { d, rs } = setup(f); assert.equal(rs.length, 4); assert(d.ng!.directions.every(r => !r.directOutput));
  for (const r of rs) assert.equal(execution.buildRuntimeLeg({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [],
    settlement: { kind: "direct-output", recipient: addr(252) } } as any), null);
});
test("specified input remains unchanged; current source/code guards and quote evidence bind quoted execution", () => {
  const f = fixture(4), { d, rs } = setup(f);
  for (const r of rs) for (const n of [1n, 37n, 268n]) { const amount = n * 10n ** BigInt(r.direction === "mint" ? f.decimals[r.index] : 18),
      input: any = { descriptor: d, route: r, source, amountIn: amount, executor: actor, runtimeEvidence: [] }, reads = requests(input).map(req => resolve(f, req));
    const q = program.decode({ programInput: input, initialResults: reads, dependentEvidence: [] }); assert.equal(q.amountOut, quote(f, r.direction, r.index, amount));
    const fragment = execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence });
    assert.equal(fragment.nodes[0].amount, amount); assert.doesNotThrow(() => ngProgram(d, r, actor, q.amountOut));
    assert.doesNotThrow(() => action.encode(fragment.nodes[0], actor, new Uint8Array()));
    assert.throws(() => execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: { ...q.evidence, amountIn: amount - 1n } }));
    assert.throws(() => program.decode({ programInput: input, initialResults: reads.map(v => ({ ...v, source: { ...source, generation: 2 } })), dependentEvidence: [] }));
  }
});
test("runtime consumes current r0 and protects old input/output, recipient and approvals", () => {
  const f = fixture(4), { d, rs } = setup(f), receiver = addr(252);
  for (const r of rs) for (const recipient of [actor, receiver]) {
    const amount = 37n * 10n ** BigInt(r.direction === "mint" ? f.decimals[r.index] : 18), out = quote(f, r.direction, r.index, amount), approvals: bigint[] = [];
    const run = (fault: { debit?: bigint; output?: bigint; returned?: bigint; approval?: boolean; approvalReturnNone?: boolean; receiver?: string; native?: bigint } = {}, toleranceRawUnits = 1n) => {
      let traded = false, allowance = 17n;
      return inspectRuntime(ethers.hexlify(ngProgram(d, r, actor, out, recipient, toleranceRawUnits).bytes()), amount, { nativeBalance: () => traded ? 17n + (fault.native ?? 0n) : 17n,
        call(c: any) { const { abi, parsed: p } = parse(c.data);
          if (p.name === "approve") { approvals.push(p.args[1]); if (fault.approval !== false) allowance = p.args[1]; return fault.approvalReturnNone ? "0x" : ABI.encodeFunctionResult("approve", [fault.approval ?? true]); }
          if (p.name === "allowance") return ABI.encodeFunctionResult("allowance", [allowance]);
          if (["add_liquidity", "remove_liquidity_one_coin"].includes(p.name)) { traded = true;
            assert.equal(r.direction === "mint" ? p.args[0][r.index] : p.args[0], amount);
            assert.equal(String(p.args[r.direction === "mint" ? 2 : 3]).toLowerCase(), recipient);
            return NG.encodeFunctionResult(p.name, [fault.returned ?? out]); }
          if (p.name === "balanceOf") { const who = String(p.args[0]).toLowerCase(), token = c.target.toLowerCase();
            const delta = !traded ? 0n : token === r.tokenIn && who === actor ? -(fault.debit ?? amount) :
              token === r.tokenOut && who === (fault.receiver ?? recipient) ? fault.output ?? out : 0n;
            return abi.encodeFunctionResult("balanceOf", [1_000_000n * 10n ** 18n + delta]); }
          throw new Error("unexpected runtime call"); }
      } as any);
    };
    run(); run({ approvalReturnNone: true }); run({ debit: amount - 1n }, 1n); assert.throws(() => run({ debit: amount - 1n }, 0n)); for (const fault of [{ debit: 0n }, { debit: amount - 2n }, { debit: amount + 1n }, { output: out - 1n },
      { returned: out + 2n }, { receiver: addr(253) }, { native: 1n }]) assert.throws(() => run(fault));
    if (r.direction === "mint") assert.throws(() => run({ approval: false }));
  }
});

test("small positive LP supply bounds strict and current raw-mid samples instead of overburning", () => {
  const f = fixture(); f.supply = 3n * 10n ** 15n;
  const { d, rs } = setup(f), current: any = { descriptor: d, source }, initialResults = pricing.current.buildRequests(current).map(req => resolve(f, req));
  const dependent: any = pricing.current.buildDependentProgram!({ current, completedRound: 0, initialResults, priorEvidence: [] });
  // The production pricing program owns this second quote round. It does not
  // turn one LP token into an amount exceeding the entire observed LP supply.
  const built: any = dependent.buildRequests ? dependent.buildRequests({}) : dependent;
  const requests = Array.isArray(built) ? built : built.requests;
  assert(requests?.length === rs.length);
  for (const req of requests) { const parsed = parse(req.data).parsed;
    if (parsed.name === "calc_withdraw_one_coin") assert(parsed.args[0] > 0n && parsed.args[0] < f.supply); }
});

test("NG production sim construction has zero off-chain Exact/quoted/RPC calls for every admitted route", async () => {
  const { d, rs } = setup(fixture(4)); let exact = 0, quoted = 0, rpc = 0, simulated = 0;
  for (const r of rs) {
    const edges = [{ adapterId: "curve-lp", target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
      { adapterId: "fixture-return", target: actor, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
    const session: any = { source, blocksPrefixInversion: () => false, fundingActionIds: () => ["fixture-funding"], buildRuntimeAmountLeg({ edge }: any) {
      return edge === edges[0] ? execution.buildRuntimeLeg({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] }) :
        { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) };
    }, issueExact() { exact++; throw new Error("forbidden NG Exact"); }, buildExecution() { quoted++; throw new Error("forbidden NG quoted fallback"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture-funding", target: actor, tokenIn: r.tokenIn, tokenOut: r.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate() { simulated++; return {
      success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" }; } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: r.tokenIn, profitToken: r.tokenIn },
      tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "curve-lp-ng-fixture" } as any,
    { call() { rpc++; throw new Error("forbidden NG construction RPC"); } } as any, { executor: actor } as any,
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
  }
  assert.equal(exact, 0); assert.equal(quoted, 0); assert.equal(rpc, 0); assert(simulated >= rs.length * 6);
});


test("confirmed zero quote excludes that stateful direction without classifying it as RPC", () => {
  const f = fixture(); f.unavailableWithdrawIndex = 1; const { d, rs } = setup(f);
  assert.equal(rs.length, 3); assert(!rs.some(r => r.direction === "redeem" && r.index === 1));
  assert(d.ng!.directions.every(r => r.direction === "mint" || r.index === 0));
});
