import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { declareRequestProgram, type AdapterRequest, type AdapterRequestResult, type ObservedEffects } from "../../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../../adapter-request-failure.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { ABI, META } from "../codec.js";
import { GENERIC, GENERIC_CALLS, WETH, genericIdentityVariant, genericProgram, genericQuoteRequest, genericStateRequests, decodeGenericState } from "../generic.js";
import { CLAIM, proveCryptoClaimCode, cryptoClaimProfile, cryptoClaimGuardRequests, bindCryptoClaimDependencies, cryptoFeeWitness,
  cryptoClaimQuoteRequest, decodeCryptoClaim, cryptoClaimExactProgram, cryptoClaimProgram, hasCryptoClaim } from "../generic-effects.js";
import { exact } from "../exact.js";
import { pricing } from "../pricing.js";
import { instance } from "../instance.js";
import { routes } from "../routes.js";
import { execution } from "../execution.js";
import type { Binding, Descriptor, Direction, Route } from "../types.js";

// These tests use the independent instruction interpreter and a synthetic
// ledger. They prove ABI, admission, source, and conservation contracts; they
// do not execute the EVM or claim current historical-state fee activation.
const source = { number: 26202387, hash: ethers.id("synthetic-crypto-fee-source"), generation: 1 };
const addr = (n: number) => ethers.toBeHex(n, 20), actor = addr(3001), recipient = addr(3002);
const scalar = (n: bigint) => ethers.toBeHex(n, 32), addressWord = (a: string) => ethers.zeroPadValue(a, 32);
const publicRuntime = JSON.parse(readFileSync(new URL("generic-effects-source-runtime.json", import.meta.url), "utf8"));
const prefix: string = publicRuntime.records[0].prefix;
const smallCode = "0x6000", factoryCode = "0x6001", mathCode = "0x6002", smallHash = ethers.keccak256(smallCode);
const row = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, ok: true, source, completion: "returned", data,
  provenance: { kind: "synthetic", fingerprint: "crypto-fee-contract-ledger" } });
const reverted = (id: string): AdapterRequestResult => ({ ...row(id, "0x"), completion: "reverted-as-declared" });
function syntheticRuntime() {
  const tail = ethers.getBytes(publicRuntime.records[0].tail);
  for (const [slot, value] of [[2, addr(3012)], [3, addr(3013)], [4, addr(3014)], [5, addr(3015)]] as const)
    tail.set(ethers.getBytes(addressWord(value)), slot * 32);
  return ethers.concat([prefix, tail]);
}
type Fault = "none" | "under-debit" | "over-debit" | "native-spend" | "extra-pool-debit" | "fee-short-receipt" | "fee-old-spend" |
  "lp-mint" | "pool-old-lp" | "sticky-allowance" | "wrong-output-recipient" | "changed-fee-receiver";
function fixture() {
  const code = syntheticRuntime(), proof = proveCryptoClaimCode(code)!;
  const d: Binding = { pool: addr(3010), lp: addr(3010), coins: proof.coins, poolCodeHash: ethers.keccak256(code), lpCodeHash: ethers.keccak256(code),
    coinCodeHashes: [smallHash, smallHash], generic: { kind: "crypto", identitySource: "meta-registry", registryHandler: addr(3011),
      registryCodeHash: smallHash, sourceCodeHash: smallHash, decimals: [18, 18], coinIndex: "uint256", basePool: ethers.ZeroAddress,
      baseLp: ethers.ZeroAddress, baseCodeHash: "", calcCodeHash: "", mintQuote: "crypto-bool", implementation: ethers.ZeroAddress,
      implementationCodeHash: "", forwarderBytes: 0, directions: (["mint", "redeem"] as const).flatMap(direction => [0, 1].map(index => ({ direction, index, receiverMode: "receiver" as const }))),
      operationEffects: { ...cryptoClaimProfile(code, addr(3010), addr(3010), proof.coins)!, factoryCodeHash: ethers.keccak256(factoryCode), mathCodeHash: ethers.keccak256(mathCode) } } };
  return { d, code, feeReceiver: addr(3020), fees: [7n, 11n], claim: true, ramp: false, fault: "none" as Fault, disabled: new Set<string>(),
    transportId: "", calls: [] as AdapterRequest[], mutate: (_r: AdapterRequestResult) => {}, registered: true };
}
type Fixture = ReturnType<typeof fixture>;
const ABIS = [CLAIM, GENERIC, ABI, ...GENERIC_CALLS.map(v => v.abi), new ethers.Interface([
  "function coins(uint256) view returns(address)", "function coins(int128) view returns(address)",
  "function balances(uint256) view returns(uint256)", "function balances(int128) view returns(uint256)",
  "function calc_withdraw_one_coin(uint256,uint256) view returns(uint256)",
  "function calc_token_amount(uint256[2],bool) view returns(uint256)", "function calc_token_amount(uint256[2]) view returns(uint256)",
])];
function parse(data: string) { for (const abi of ABIS) { try { const p = abi.parseTransaction({ data }); if (p) return p; } catch { /* next ABI */ } }
  throw new Error("unexpected synthetic ABI " + data.slice(0, 10)); }
function transfer(token: string, from: string, to: string, n: bigint) { const e = CLAIM.encodeEventLog(CLAIM.getEvent("Transfer")!, [from, to, n]); return { address: token, ...e }; }
function claimLog(d: Binding, feeReceiver: string, fees: readonly bigint[]) { const e = CLAIM.encodeEventLog(CLAIM.getEvent("ClaimAdminFee")!, [feeReceiver, fees]); return { address: d.pool, ...e }; }
function receipt(f: Fixture, direction: Direction, index: number, amount: bigint, beforeClaim = false) {
  // Deliberately nonlinear test protocol, independent from production. The
  // pre-claim view differs whenever the synthetic source branch claims fees.
  const feeImpact = !beforeClaim && direction === "redeem" && f.claim && !f.ramp ? 3n : 0n;
  return amount * (direction === "mint" ? 997n : 983n - feeImpact) / 1000n - (amount > 10n ** 19n ? BigInt(index + 1) : 0n);
}
function simulate(f: Fixture, req: Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }>): AdapterRequestResult {
  const d = f.d;
  if (["g-actor", "g-effect-actor"].includes(req.id)) return { ...row(req.id, scalar(0n)), effects: {
    tokenDeltas: [{ token: req.id === "g-actor" ? WETH : d.lp, account: actor, delta: 0n }], nativeDeltas: [{ account: actor, delta: 0n }], totalSupplyDeltas: [], logs: [] } };
  assert.equal(req.call.executionMode, "executor-program"); assert.equal(req.call.to.toLowerCase(), actor);
  const script = ethers.getBytes(CLAIM.decodeFunctionData("execSubscript", req.call.data)[0]); assert.equal(script[0], 14);
  const amount = BigInt(ethers.hexlify(script.slice(1, 33))); assert.equal(Number(BigInt(ethers.hexlify(script.slice(33, 36)))), script.length - 36);
  const balances = new Map<string, bigint>(), before = new Map<string, bigint>(), logs: NonNullable<ObservedEffects["logs"]>[number][] = [];
  const key = (t: string, a: string) => `${t.toLowerCase()}:${a.toLowerCase()}`;
  const balance = (t: string, a: string) => { const k = key(t, a); if (!balances.has(k)) { const initial = a === d.pool ? t === d.lp ? 555n : 10n ** 30n : 777n; balances.set(k, initial); before.set(k, initial); } return balances.get(k)!; };
  const change = (t: string, a: string, n: bigint) => balances.set(key(t, a), balance(t, a) + n);
  for (const v of req.observeTokenBalances ?? []) balance(v.token, typeof v.account === "string" ? v.account.toLowerCase() : actor);
  for (const v of req.overrideIntent.tokenBalances ?? []) { balances.set(key(v.token, actor), v.amount); before.set(key(v.token, actor), v.amount); }
  let allowance = 0n, native = 999n, supply = 10n ** 26n, traded = false, currentReceiver = f.feeReceiver;
  try {
    inspectRuntime(ethers.hexlify(script.slice(36)), amount, { nativeBalance: () => native, call(c) {
      const p = parse(c.data), target = c.target.toLowerCase();
      if (p.name === "fee_receiver") return addressWord(currentReceiver);
      if (p.name === "totalSupply") return scalar(supply);
      if (p.name === "balanceOf") return scalar(balance(target, String(p.args[0]).toLowerCase()));
      if (p.name === "approve") { if (f.fault !== "sticky-allowance" || p.args[1] !== 0n || !traded) allowance = p.args[1]; return scalar(1n); }
      if (p.name === "allowance") return scalar(allowance);
      assert.equal(target, d.pool); assert(["add_liquidity", "remove_liquidity_one_coin"].includes(p.name));
      const direction = p.name === "add_liquidity" ? "mint" : "redeem", index = direction === "mint" ? [...p.args[0]].findIndex(v => v > 0n) : Number(p.args[1]);
      const mode = p.args.length === (direction === "mint" ? 2 : 3) ? "none" : p.signature.includes("bool,address") ? "bool-receiver" : "receiver";
      if (mode === "bool-receiver" || f.disabled.has(`${direction}:${index}`)) throw new Error("unsupported operation");
      const output = receipt(f, direction, index, amount); if (output <= 0n) throw new Error("dust operation reverted");
      assert.equal(direction === "mint" ? p.args[0][index] : p.args[0], amount); assert.equal(allowance, amount); assert.equal(c.value, 0n);
      const receiver = f.fault === "wrong-output-recipient" ? addr(3099) : mode === "none" ? actor : String(p.args[direction === "mint" ? 2 : 3]).toLowerCase();
      const input = direction === "mint" ? d.coins[index] : d.lp, tokenOut = direction === "mint" ? d.lp : d.coins[index];
      const debit = amount + (f.fault === "over-debit" ? 1n : f.fault === "under-debit" ? -1n : 0n);
      change(input, actor, -debit);
      if (direction === "mint") { change(input, d.pool, debit); supply += output; logs.push(transfer(input, actor, d.pool, debit), transfer(d.lp, ethers.ZeroAddress, receiver, output)); }
      else {
        if (f.claim && !f.ramp) {
          for (let i = 0; i < 2; i++) { change(d.coins[i], d.pool, -f.fees[i]); change(d.coins[i], f.feeReceiver, f.fees[i] - (f.fault === "fee-short-receipt" ? 1n : 0n)); logs.push(transfer(d.coins[i], d.pool, f.feeReceiver, f.fees[i])); }
          logs.push(claimLog(d, f.feeReceiver, f.fees));
        }
        if (f.fault === "fee-old-spend") change(d.coins[1 - index], f.feeReceiver, -100n);
        change(tokenOut, d.pool, -output - (f.fault === "extra-pool-debit" ? 1n : 0n));
        if (f.fault === "pool-old-lp") change(d.lp, d.pool, -1n);
        supply -= debit; if (f.fault === "lp-mint") supply += 1n;
        logs.push(transfer(d.lp, actor, ethers.ZeroAddress, debit), transfer(tokenOut, d.pool, receiver, output));
      }
      change(tokenOut, receiver, output); if (f.fault === "native-spend") native--; if (f.fault === "changed-fee-receiver") currentReceiver = addr(3098);
      traded = true; return scalar(output);
    } }); assert(traded);
  } catch { return reverted(req.id); }
  return { ...row(req.id, "0x"), effects: { tokenDeltas: (req.observeTokenBalances ?? []).map(v => { const account = typeof v.account === "string" ? v.account.toLowerCase() : actor;
    return { token: v.token, account, delta: balance(v.token, account) - before.get(key(v.token, account))! }; }),
    nativeDeltas: [{ account: actor, delta: native - 999n }], totalSupplyDeltas: [{ token: d.lp, delta: supply - 10n ** 26n }], logs } };
}
function resolve(f: Fixture, req: AdapterRequest): AdapterRequestResult {
  f.calls.push(req); if (req.id === f.transportId) return { id: req.id, ok: false, source, failure: "rpc" };
  let out: AdapterRequestResult;
  const d = f.d, effect = d.generic!.operationEffects!;
  if (req.kind === "get-code") out = row(req.id, req.address.toLowerCase() === d.pool ? f.code : req.address.toLowerCase() === effect.factory ? factoryCode : req.address.toLowerCase() === effect.math ? mathCode : smallCode);
  else if (req.kind === "effect-delta-simulation") out = simulate(f, req);
  else {
    assert.equal(req.kind, "eth-call"); if (req.kind !== "eth-call") throw new Error("unexpected synthetic transport"); const p = parse(req.data), target = req.to.toLowerCase();
    if (p.name === "get_registry_handlers_from_pool") out = row(req.id, ABI.encodeFunctionResult(p.name, [[f.registered ? d.generic!.registryHandler : ethers.ZeroAddress, ...Array(9).fill(ethers.ZeroAddress)]]));
    else if (p.name === "get_lp_token" || p.name === "get_pool_from_lp_token") out = row(req.id, addressWord(f.registered ? d.pool : ethers.ZeroAddress));
    else if (p.name === "get_coins") out = row(req.id, ABI.encodeFunctionResult(p.name, [[...d.coins, ...Array(6).fill(ethers.ZeroAddress)]]));
    else if (p.name === "get_base_pool") out = row(req.id, addressWord(ethers.ZeroAddress));
    else if (p.name === "factory") out = row(req.id, addressWord(effect.factory));
    else if (p.name === "MATH") out = row(req.id, addressWord(effect.math));
    else if (p.name === "fee_receiver") out = row(req.id, addressWord(f.feeReceiver));
    else if (p.name === "gamma") out = row(req.id, scalar(100n));
    else if (p.name === "coins" || p.name === "balances") out = p.signature.includes("int128") ? reverted(req.id) : row(req.id, p.name === "coins" ? addressWord(d.coins[Number(p.args[0])]) : scalar(10n ** 30n));
    else if (p.name === "decimals") out = row(req.id, scalar(18n));
    else if (p.name === "totalSupply") out = row(req.id, scalar(10n ** 26n));
    else if (p.name === "fee") out = row(req.id, scalar(1000000n));
    else if (["A_precise", "future_A", "is_killed"].includes(p.name)) out = reverted(req.id);
    else if (p.name === "calc_token_amount") { const index = [...p.args[0]].findIndex(v => v > 0n);
      out = !p.signature.includes("bool") || f.disabled.has(`mint:${index}`) ? reverted(req.id) : row(req.id, scalar(receipt(f, "mint", index, p.args[0][index]))); }
    else if (p.name === "calc_withdraw_one_coin") out = row(req.id, scalar(receipt(f, "redeem", Number(p.args[1]), p.args[0], true)));
    else throw new Error("unexpected synthetic read " + target + " " + p.name);
  }
  f.mutate(out); return out;
}
function attest(f: Fixture) { let step: any = { candidate: { candidateKind: "curve-lp", pool: f.d.pool }, step: 0 };
  for (let n = 0; n < 8; n++) { const v = genericIdentityVariant, declared = declareRequestProgram({ requirements: v.requirements, buildRequests: v.buildRequests, decode: () => null }, step);
    const results = declared.requests.map(r => resolve(f, r)); step = { ...step, step: n + 1, evidence: v.decode({ step, results }) };
    const decision = v.decide(step); if (decision.status !== "continue") return decision; }
  throw new Error("synthetic identity did not complete"); }
function setup(f: Fixture) { const decision = attest(f); assert.equal(decision.status, "verified", JSON.stringify(decision)); assert(decision.status === "verified");
  const d = instance.compileDraft(decision.identity), rs = routes.project({ descriptor: d }); return { d, rs }; }
const route = (d: Binding, index = 0) => ({ direction: "redeem", index, tokenIn: d.lp, tokenOut: d.coins[index] }) as Route;
const input = (d: Descriptor, r: Route, amountIn: bigint): any => ({ descriptor: d, route: r, amountIn, executor: actor, source, runtimeEvidence: [] });
function exactQuote(f: Fixture, d: Descriptor, r: Route, amountIn: bigint) {
  const i = input(d, r, amountIn), p = cryptoClaimExactProgram;
  const declared = declareRequestProgram({ requirements: p.requirements, buildRequests: p.buildRequests, decode: () => null }, i), initialResults = declared.requests.map(req => resolve(f, req));
  const dependent = p.buildDependentProgram!({ programInput: i, initialResults, completedRound: 0, priorEvidence: [] });
  const dependentEvidence = dependent ? [dependent.decode(declareRequestProgram({ requirements: () => dependent.requirements, buildRequests: () => dependent.requests, decode: () => null }, i).requests.map(req => resolve(f, req)))] : [];
  return p.decode({ programInput: i, initialResults, dependentEvidence });
}

test("saved deployed runtimes share the exact executable template; a new deployment uses immutable-derived dependencies and reverse identity", () => {
  assert.equal(publicRuntime.records.length, 2);
  for (const v of publicRuntime.records) { const code = ethers.concat([prefix, v.tail]); assert.equal(ethers.keccak256(code), v.codeHash); assert.equal(v.runtimeMatch, "match"); assert(proveCryptoClaimCode(code)); }
  const f = fixture(), { d, rs } = setup(f); assert(hasCryptoClaim(d)); assert.equal(rs.length, 4);
  assert(!publicRuntime.records.some((v: any) => v.address === d.pool)); assert.notEqual(d.generic!.operationEffects!.factory, "0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f");
  const unknown = fixture(); unknown.registered = false; assert.notEqual(attest(unknown).status, "verified");
  const changed = ethers.getBytes(f.code); changed[100] ^= 1; assert.equal(proveCryptoClaimCode(ethers.hexlify(changed)), undefined);
  assert.throws(() => cryptoClaimProfile(f.code, f.d.pool, f.d.pool, [...f.d.coins].reverse()), /immutable mismatch/);
});
test("binding guards preserve source and dependency code while the current fee recipient may legitimately change", () => {
  const f = fixture(), good = cryptoClaimGuardRequests(f.d).map(req => resolve(f, req)), bound = bindCryptoClaimDependencies(f.d, good, source);
  assert.equal(cryptoFeeWitness(bound, good, source).feeReceiver, f.feeReceiver);
  f.feeReceiver = addr(3030); const current = cryptoClaimGuardRequests(bound).map(req => resolve(f, req)); assert.equal(cryptoFeeWitness(bound, current, source).feeReceiver, f.feeReceiver);
  for (const id of ["g-effect-factory", "g-effect-math", "g-effect-fee-receiver", "g-effect-factory-receiver", "g-effect-math-code", "g-effect-factory-code"]) {
    assert.throws(() => cryptoFeeWitness(bound, current.map(r => r.id === id && r.ok ? { ...r, data: id.endsWith("code") ? "0x6003" : addressWord(addr(3099)) } : r), source));
    assert.throws(() => cryptoFeeWitness(bound, current.map(r => r.id === id ? { ...r, source: { ...source, generation: 2 } } : r), source));
  }
  const failed = current.map(r => r.id === "g-effect-math-code" ? { id: r.id, ok: false as const, source, failure: "rpc" as const } : r);
  assert.throws(() => cryptoFeeWitness(bound, failed, source), RequiredAdapterRequestError);
});
test("operation quote uses the exact requested input and post-claim receipt while a pre-claim view demonstrably differs", () => {
  const f = fixture(), { d, rs } = setup(f);
  for (const r of rs.filter(r => r.direction === "redeem")) for (const amount of [10n ** 18n, 123456789012345678901n]) {
    const q = exactQuote(f, d, r, amount); assert.equal(q.amountOut, receipt(f, "redeem", r.index, amount)); assert.notEqual(q.amountOut, receipt(f, "redeem", r.index, amount, true));
    assert.equal(q.evidence.amountIn, amount); assert.equal(q.evidence.executor, actor); assert.deepEqual(q.evidence.source, source);
    assert.equal(exact.methods(input(d, r, amount)).find(v => v.id === "source-bound-withdrawal-effects")?.kind, "request-program");
    const fragment = execution.buildFragment({ ...input(d, r, amount), quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence }); assert.equal(fragment.nodes[0].amount, amount);
    assert(execution.buildRuntimeLeg({ ...input(d, r, amount) }));
    assert.throws(() => genericQuoteRequest(d, "redeem", r.index, amount, "unsafe-view"), /operation effects/);
  }
  const mint = rs.find(r => r.direction === "mint")!;
  assert(!exact.methods(input(d, mint, 10n ** 18n)).some(v => v.id === "source-bound-withdrawal-effects"));
  const simulations = f.calls.filter(r => r.kind === "effect-delta-simulation" && ["g-effect-exact"].includes(r.id)); assert(simulations.length > 0);
  for (const req of simulations) { assert(req.kind === "effect-delta-simulation"); assert.equal(req.call.to, actor); assert.equal(req.call.executionMode, "executor-program");
    assert.equal(req.preCalls, undefined); assert.equal(req.executionAssetBoundary, undefined); assert.equal(req.overrideIntent.nativeBalanceWei, undefined);
    assert.equal(req.overrideIntent.tokenBalances?.length, 1); assert.equal(req.overrideIntent.tokenBalances![0].token, d.lp); }
});
test("zero is local; one truthfully reverts when no positive receipt exists; source and prefix evidence are never mixed", () => {
  const f = fixture(), { d, rs } = setup(f), r = rs.find(r => r.direction === "redeem")!, before = f.calls.length;
  assert.equal(exactQuote(f, d, r, 0n).amountOut, 0n); assert.equal(f.calls.length, before);
  assert.throws(() => exactQuote(f, d, r, 1n), /withdrawal unavailable/);
  assert.throws(() => cryptoClaimExactProgram.buildRequests({ ...input(d, r, 7n), route: { ...r, bindingRef: { ...r.bindingRef, fingerprint: ethers.id("forged") } } }));
  const i = input(d, r, 7n); assert.throws(() => cryptoClaimExactProgram.buildRequests({ ...i, runtimeEvidence: [{}] }));
  assert.throws(() => cryptoClaimExactProgram.buildRequests({ ...i, prefix: [{}] }));
  const witness = { source, feeReceiver: f.feeReceiver }, req = cryptoClaimQuoteRequest(d, r, 10n ** 18n, actor, witness, "one"), result = resolve(f, req);
  assert.throws(() => decodeCryptoClaim(d, r, 10n ** 18n, actor, witness, { ...result, source: { ...source, hash: ethers.id("other") } }, source));
  assert.throws(() => decodeCryptoClaim(d, r, 10n ** 18n, actor, { ...witness, source: { ...source, generation: 2 } }, result, source));
});
test("fee-due, no-fee, active ramp and zero-receiver no-claim states use actual operation effects", () => {
  for (const state of ["due", "no-fee", "ramp", "zero-receiver"] as const) { const f = fixture(); f.claim = state === "due"; f.ramp = state === "ramp"; if (state === "zero-receiver") f.feeReceiver = ethers.ZeroAddress;
    const { d, rs } = setup(f), r = rs.find(r => r.direction === "redeem")!, n = 10n ** 18n; assert.equal(exactQuote(f, d, r, n).amountOut, receipt(f, "redeem", r.index, n)); }
});
test("runtime itself rejects incorrect input, pool debit, fee receipt, fee inventory, LP supply, old pool LP, allowance, recipient and native deltas", () => {
  const f = fixture(), { d, rs } = setup(f), witness = { source, feeReceiver: f.feeReceiver };
  for (const r of rs.filter(r => r.direction === "redeem")) for (const fault of ["under-debit", "over-debit", "native-spend", "extra-pool-debit", "fee-short-receipt", "fee-old-spend", "lp-mint", "pool-old-lp", "sticky-allowance", "wrong-output-recipient", "changed-fee-receiver"] as const) {
    f.fault = fault; const req = cryptoClaimQuoteRequest(d, r, 10n ** 18n, actor, witness, `fault-${fault}`), result = resolve(f, req);
    assert(result.ok && result.completion === "reverted-as-declared", `runtime accepted ${fault} for ${r.index}`);
  }
  f.fault = "none";
  for (const alias of [actor, recipient, d.pool, ...d.coins]) { f.feeReceiver = alias; const r = rs.find(r => r.direction === "redeem")!;
    assert.throws(() => cryptoClaimQuoteRequest(d, r, 10n ** 18n, actor, { source, feeReceiver: alias }, "alias", "receiver", recipient));
    // A runtime-only program has no saved witness: its live getter must still reject the alias.
    const valid = cryptoClaimQuoteRequest(d, r, 10n ** 18n, actor, witness, "runtime-alias", "receiver", recipient); const result = resolve(f, valid); assert(result.ok && result.completion === "reverted-as-declared"); }
});
test("quoted decoder independently requires canonical fee events, complete per-account deltas, full burn and exact supply", () => {
  const f = fixture(), { d, rs } = setup(f), r = rs.find(r => r.direction === "redeem")!, n = 10n ** 18n, witness = { source, feeReceiver: f.feeReceiver };
  const result = resolve(f, cryptoClaimQuoteRequest(d, r, n, actor, witness, "decode", "receiver", recipient)); assert(result.ok && result.effects);
  const e = result.effects, decode = (effects: ObservedEffects) => decodeCryptoClaim(d, r, n, actor, witness, { ...result, effects }, source, recipient);
  assert.equal(decode(e), receipt(f, "redeem", r.index, n));
  const claims = e.logs!.filter(l => l.topics[0] === CLAIM.getEvent("ClaimAdminFee")!.topicHash);
  for (const effects of [
    { ...e, logs: e.logs!.filter(l => !claims.includes(l)) }, { ...e, logs: [...e.logs!, claims[0]] },
    { ...e, logs: e.logs!.map(l => claims.includes(l) ? claimLog(d, addr(3099), f.fees) : l) },
    { ...e, logs: e.logs!.map(l => claims.includes(l) ? claimLog(d, f.feeReceiver, [f.fees[0] + 1n, f.fees[1]]) : l) },
    { ...e, logs: e.logs!.map(l => claims.includes(l) ? { ...l, data: l.data + "00".repeat(32) } : l) },
    { ...e, tokenDeltas: e.tokenDeltas!.slice(1) }, { ...e, tokenDeltas: [...e.tokenDeltas!, e.tokenDeltas![0]] },
    { ...e, tokenDeltas: e.tokenDeltas!.map(v => v.token === d.lp && v.account === actor ? { ...v, delta: -n + 1n } : v) },
    { ...e, tokenDeltas: e.tokenDeltas!.map(v => v.token === r.tokenOut && v.account === recipient ? { ...v, delta: v.delta - 1n } : v) },
    { ...e, totalSupplyDeltas: [{ token: d.lp, delta: -n + 1n }] }, { ...e, nativeDeltas: [{ account: actor, delta: -1n }] },
    { ...e, logs: e.logs!.filter(l => !(l.address === d.lp && l.topics[0] === CLAIM.getEvent("Transfer")!.topicHash)) },
    { ...e, logs: [...e.logs!, transfer(d.coins[0], d.pool, addr(3099), 1n)] },
  ]) assert.throws(() => decode(effects));
});
test("identity transports remain uncertain even when an earlier operation failed; verified directions remain independent", () => {
  const f = fixture(); f.disabled.add("redeem:0"); const decision = attest(f); assert.equal(decision.status, "verified");
  if (decision.status === "verified") { const dirs = (decision.identity.binding as Binding).generic!.directions; assert.equal(dirs.length, 3); assert(!dirs.some(v => v.direction === "redeem" && v.index === 0)); }
  const failed = fixture(); failed.disabled.add("redeem:0"); failed.transportId = "g-quote-7"; assert.throws(() => attest(failed), RequiredAdapterRequestError);
});
test("current quote failure withdraws only the affected direction and a later healthy round recovers; dynamic transports cover mint/redeem subsets", () => {
  const f = fixture(), { d } = setup(f);
  for (const direction of [undefined, "mint", "redeem"] as const) {
    const descriptor = direction ? { ...d, generic: { ...d.generic!, directions: d.generic!.directions.filter(v => v.direction === direction) } } : d;
    const rs = routes.project({ descriptor }), current = { descriptor, routes: rs, source };
    const run = () => { const initial = declareRequestProgram({ requirements: pricing.current.requirements, buildRequests: pricing.current.buildRequests, decode: () => null }, current).requests.map(req => resolve(f, req));
      const dep = pricing.current.buildDependentProgram!({ current, completedRound: 0, initialResults: initial, priorEvidence: [] }); assert(dep);
      const results = declareRequestProgram({ requirements: () => dep.requirements, buildRequests: () => dep.requests, decode: () => null }, current).requests.map(req => resolve(f, req));
      const s = pricing.current.decodeSnapshot({ descriptor, initialResults: initial, dependentEvidence: [dep.decode(results)] });
      return pricing.current.deriveMids({ descriptor, snapshot: s, routes: rs }); };
    f.disabled.clear(); assert.equal(run().size, rs.length);
    f.disabled.add(`${direction ?? "redeem"}:0`); assert.equal(run().size, rs.length - 1);
    f.disabled.clear(); f.feeReceiver = addr(3040); assert.equal(run().size, rs.length);
    for (let cycle = 0; cycle < 2; cycle++) { for (const r of rs) f.disabled.add(`${r.direction}:${r.index}`); assert.equal(run().size, 0);
      f.disabled.clear(); assert.equal(run().size, rs.length); }
    assert.equal(pricing.refreshPolicyForInstance!({ descriptor, routes: rs }), "each-block");
    assert(pricing.dependencies({ descriptor, routes: rs }).includes(descriptor.generic!.operationEffects!.factory));
    assert.deepEqual(pricing.mutation.affectedStateKeys!({ descriptor, routes: rs, observation: { kind: "call", target: descriptor.generic!.operationEffects!.factory } as any }), [descriptor.instanceKey]);
  }
});
test("runtime and quoted construction preserve action ownership and recipient binding without invoking Exact", () => {
  const f = fixture(), { d, rs } = setup(f), r = rs.find(r => r.direction === "redeem")!, i = input(d, r, 10n ** 18n), q = exactQuote(f, d, r, i.amountIn), calls = f.calls.length;
  const ordinary = execution.buildRuntimeLeg(i), external = execution.buildRuntimeLeg({ ...i, settlement: { kind: "direct-output", recipient } }); assert(ordinary && external);
  assert.equal(f.calls.length, calls); assert.throws(() => execution.buildFragment({ ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: { ...q.evidence, amountIn: i.amountIn - 1n } }));
  assert.equal(ethers.hexlify(genericProgram(d, r, actor).bytes()), ethers.hexlify(cryptoClaimProgram(d, r, actor).bytes()));
  assert.throws(() => decodeGenericState(d, genericStateRequests(d).map(req => resolve(f, req)).map(v => v.id === "g-effect-factory-code" && v.ok ? { ...v, data: "0x6003" } : v), source));
});
test("production amount selector constructs the proved fee-claim routes through runtime without Exact, quoted fallback or construction RPC", async () => {
  const { RuntimeAmountProgram } = await import("../../../../../adapters/runtime-amount-program.js");
  const { createBlockScanSimAmountSelector } = await import("../../../../simulator/blockscan-sim-amount-selector.js");
  const f = fixture(), { d, rs } = setup(f); let exactCalls = 0, quotedCalls = 0, rpcCalls = 0, simulations = 0;
  for (const r of rs.filter(r => r.direction === "redeem")) {
    const edges = [{ adapterId: "curve-lp", target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
      { adapterId: "fixture-return", target: actor, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
    const session: any = { source, blocksPrefixInversion: () => false, fundingActionIds: () => ["fixture-funding"],
      buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? execution.buildRuntimeLeg({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] })
        : { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }; },
      issueExact() { exactCalls++; throw new Error("forbidden Exact"); }, buildExecution() { quotedCalls++; throw new Error("forbidden quoted fallback"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture-funding", target: actor, tokenIn: r.tokenIn, tokenOut: r.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate() { simulations++; return {
      success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" }; } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: r.tokenIn, profitToken: r.tokenIn },
      tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "crypto-claim-fixture" } as any,
      { call() { rpcCalls++; throw new Error("forbidden RPC"); } } as any, { executor: actor } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
  }
  assert.equal(exactCalls, 0); assert.equal(quotedCalls, 0); assert.equal(rpcCalls, 0); assert(simulations >= 12);
});
