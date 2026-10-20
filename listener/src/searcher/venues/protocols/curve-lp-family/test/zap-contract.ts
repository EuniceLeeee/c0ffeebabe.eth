import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { declareRequestProgram, type AdapterRequest, type AdapterRequestResult } from "../../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../../adapter-request-failure.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { ABI, META } from "../codec.js";
import { ZAP, ZAP_CODE_HASH, ZAP_LINEAGE, zapIdentityVariant, zapProgram, zapQuoteRequest, decodeZapQuote,
  LEGACY_BASE_LP_CODE_HASH, LEGACY_BASE_LP_MINTER_SLOT, zapExactProgram, zapPricingRequests, zapMidRequests, decodeZapSnapshot, zapSample, type ZapBinding, type ZapDescriptor } from "../zap.js";
import type { Direction, Route } from "../types.js";
import { affected, pricing } from "../pricing.js";

// Independent instruction interpreter + synthetic protocol ledger. These are
// ABI/guard contract tests, never deployed-state amount or EVM evidence.
const addr = (n: number) => ethers.toBeHex(n, 20), actor = addr(1901);
const source = { number: 26202387, hash: ethers.id("curve-zap-contract-source"), generation: 1 };
const raw = (n: bigint) => ethers.toBeHex(n, 32), hexAddress = (a: string) => ethers.zeroPadValue(a, 32);
const publicRuntime = JSON.parse(readFileSync(new URL("zap-source-runtime.json", import.meta.url), "utf8"));
const privateMinterRuntime = JSON.parse(readFileSync(new URL("legacy-private-minter-runtime.json", import.meta.url), "utf8"));
const deployedCode = publicRuntime.runtime as string;
const code = "0x6000", codeHash = ethers.keccak256(code);
type Fault = "none" | "zero-debit" | "under-debit" | "over-debit" | "short-receipt" | "wrong-return" | "native-spend" | "sticky-allowance" | "zap-input-spend";
function fixture() {
  const d: ZapBinding = { pool: addr(1910), lp: addr(1911), coins: [addr(1912), addr(1913), addr(1914), addr(1915)], poolCodeHash: ZAP_CODE_HASH,
    lpCodeHash: codeHash, coinCodeHashes: Array(4).fill(codeHash), zap: { metaPool: addr(1920), basePool: addr(1921), baseLp: addr(1922),
      metaCoins: [addr(1912), addr(1922)], registryCodeHash: codeHash, metaCodeHash: codeHash, baseCodeHash: codeHash, baseLpCodeHash: codeHash,
      registryHandler: addr(1930), baseRegistryHandler: addr(1931), decimals: [18, 8, 8, 18],
      directions: (["mint", "redeem"] as const).flatMap(direction => [0, 1, 2, 3].map(index => ({ direction, index }))) } };
  return { d, fault: "none" as Fault, zapCode: deployedCode, baseLpCode: code, baseMinterGetter: true, minterStorage: hexAddress(d.zap.basePool), donated: new Map<string, bigint>(), disabled: new Set<string>(),
    mutate: (_r: AdapterRequestResult) => {}, reversed: false, rebound: false, transportId: "", observedOverrides: [] as unknown[], calls: 0 };
}
type Fixture = ReturnType<typeof fixture>;
const row = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, ok: true, source, provenance: { kind: "synthetic", fingerprint: "zap-contract-ledger" }, completion: "returned", data });
const reverted = (id: string): AdapterRequestResult => ({ ...row(id, "0x"), completion: "reverted-as-declared" });
const route = (d: ZapBinding, direction: Direction, index: number) => ({ direction, index, tokenIn: direction === "mint" ? d.coins[index] : d.lp,
  tokenOut: direction === "mint" ? d.lp : d.coins[index], lineageId: ZAP_LINEAGE, routeKey: `zap:${direction}:${index}`,
  bindingRef: { bindingKey: d.pool, fingerprint: ethers.id("synthetic-issued-binding") } }) as Route;
function parse(data: string) { for (const abi of [ZAP, ABI, new ethers.Interface(["function coins(int128) view returns(address)"])]) {
  try { const p = abi.parseTransaction({ data }); if (p) return p; } catch { /* next deployed interface */ }
} throw new Error("unexpected fixture calldata"); }
// Deliberately nonlinear, fee-bearing mock. Production never imports this
// formula; it only consumes the ledger's observed integer receipt.
function model(d: ZapBinding, r: Route, amount: bigint) {
  const scale = 10n ** BigInt(18 - d.zap.decimals[r.index]);
  const intermediate = r.index ? (r.direction === "mint" ? amount * scale * 997n / 1000n : amount * 983n / 1000n) : 0n;
  const output = r.direction === "mint" ? (r.index ? intermediate : amount) * 991n / 1000n
    : (r.index ? intermediate * 977n / 1000n : amount * 983n / 1000n) / scale;
  return { output, intermediate };
}
function simulate(f: Fixture, req: Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }>): AdapterRequestResult {
  const d = f.d, z = d.zap;
  if (req.id === "z-actor") return { ...row(req.id, raw(0n)), effects: { tokenDeltas: [{ token: d.lp, account: actor, delta: 0n }], nativeDeltas: [{ account: actor, delta: 0n }], totalSupplyDeltas: [], logs: [] } };
  f.observedOverrides.push(req.overrideIntent);
  assert.equal(req.call.executionMode, "executor-program"); assert.equal(req.call.to.toLowerCase(), actor);
  const programScript = ethers.getBytes(ZAP.decodeFunctionData("execSubscript", req.call.data)[0]);
  assert.equal(programScript[0], 14); const amount = BigInt(ethers.hexlify(programScript.slice(1, 33))), program = ethers.hexlify(programScript.slice(36));
  assert.equal(Number(BigInt(ethers.hexlify(programScript.slice(33, 36)))), programScript.length - 36);
  const balances = new Map<string, bigint>(), initial = new Map<string, bigint>(), allowances = new Map<string, bigint>();
  const key = (t: string, a: string) => t.toLowerCase() + ":" + a.toLowerCase();
  for (const scope of req.observeTokenBalances ?? []) { const account = typeof scope.account === "string" ? scope.account : actor;
    balances.set(key(scope.token, account), account === actor ? 333n : f.donated.get(scope.token.toLowerCase()) ?? 0n); }
  for (const override of req.overrideIntent.tokenBalances ?? []) balances.set(key(override.token, actor), override.amount);
  for (const [k, v] of balances) initial.set(k, v);
  let native = 999n, lpDelta = 0n, baseDelta = 0n, traded = false;
  try {
    inspectRuntime(program, amount, { nativeBalance: () => native, call(c) {
      const p = parse(c.data), target = c.target.toLowerCase();
      if (p.name === "balanceOf") return raw(balances.get(key(target, String(p.args[0]))) ?? 0n);
      if (p.name === "approve") { if (f.fault !== "sticky-allowance" || p.args[1] !== 0n) allowances.set(target, p.args[1]); return "0x"; }
      if (p.name === "allowance") return raw(allowances.get(target) ?? 0n);
      assert.equal(target, d.pool); assert.equal(c.value, 0n);
      const direction = p.name === "add_liquidity" ? "mint" : "redeem", index = direction === "mint" ? [...p.args[0]].findIndex(n => n > 0n) : Number(p.args[1]);
      const r = route(d, direction, index), q = model(d, r, amount);
      if (f.disabled.has(`${direction}:${index}`) || !q.output) throw new Error("synthetic unavailable operation");
      assert.equal(allowances.get(r.tokenIn), amount); assert.equal(direction === "mint" ? p.args[0][index] : p.args[0], amount);
      const debit = f.fault === "zero-debit" ? 0n : f.fault === "under-debit" ? amount - 1n : f.fault === "over-debit" ? amount + 1n : amount;
      balances.set(key(r.tokenIn, actor), balances.get(key(r.tokenIn, actor))! - debit);
      balances.set(key(r.tokenOut, actor), balances.get(key(r.tokenOut, actor))! + q.output - (f.fault === "short-receipt" ? 1n : 0n));
      if (f.fault === "zap-input-spend") balances.set(key(r.tokenIn, d.pool), balances.get(key(r.tokenIn, d.pool))! - 1n);
      if (f.fault === "native-spend") native--;
      lpDelta = direction === "mint" ? q.output : -amount; baseDelta = direction === "mint" ? q.intermediate : -q.intermediate; traded = true;
      return raw(q.output + (f.fault === "wrong-return" ? 1n : 0n));
    } }); assert(traded);
  } catch { return reverted(req.id); }
  return { ...row(req.id, "0x"), effects: { tokenDeltas: (req.observeTokenBalances ?? []).map(v => { const a = typeof v.account === "string" ? v.account : actor;
    return { token: v.token, account: a, delta: balances.get(key(v.token, a))! - initial.get(key(v.token, a))! }; }),
    nativeDeltas: [{ account: actor, delta: native - 999n }], totalSupplyDeltas: [{ token: d.lp, delta: lpDelta }, { token: z.baseLp, delta: baseDelta }], logs: [] } };
}
function resolve(f: Fixture, req: AdapterRequest): AdapterRequestResult {
  f.calls++;
  if (req.id === f.transportId) return { id: req.id, ok: false, source, failure: "rpc" };
  let out: AdapterRequestResult;
  if (req.kind === "get-code") out = row(req.id, req.address.toLowerCase() === f.d.pool ? f.zapCode : req.address.toLowerCase() === f.d.zap.baseLp ? f.baseLpCode : code);
  else if (req.kind === "get-storage") { assert.equal(req.address, f.d.zap.baseLp); assert.equal(req.slot, LEGACY_BASE_LP_MINTER_SLOT); out = row(req.id, f.minterStorage); }
  else if (req.kind === "effect-delta-simulation") out = simulate(f, req);
  else {
    assert.equal(req.kind, "eth-call"); if (req.kind !== "eth-call") throw new Error("unexpected fixture transport");
    const d = f.d, z = d.zap, p = parse(req.data), target = req.to.toLowerCase(), meta = p.args.length > 0 && p.args[0]?.toLowerCase?.() === z.metaPool;
    if (p.name === "pool") out = row(req.id, hexAddress(f.rebound ? addr(1999) : z.metaPool));
    else if (p.name === "token") out = row(req.id, hexAddress(d.lp));
    else if (p.name === "base_pool" || p.name === "get_base_pool") out = row(req.id, hexAddress(z.basePool));
    else if (p.name === "coins") out = row(req.id, hexAddress(target === z.basePool ? d.coins[Number(p.args[0]) + 1] : z.metaCoins[Number(p.args[0])]));
    else if (p.name === "base_coins") out = row(req.id, hexAddress(d.coins[Number(p.args[0]) + 1]));
    else if (p.name === "get_registry_handlers_from_pool") out = row(req.id, ABI.encodeFunctionResult(p.name, [[meta ? z.registryHandler : z.baseRegistryHandler, ...Array(9).fill(ethers.ZeroAddress)]]));
    else if (p.name === "get_lp_token") out = row(req.id, hexAddress(meta ? d.lp : z.baseLp));
    else if (p.name === "get_pool_from_lp_token") out = row(req.id, hexAddress(f.reversed ? addr(1999) : p.args[0].toLowerCase() === d.lp ? z.metaPool : z.basePool));
    else if (p.name === "get_coins") out = row(req.id, ABI.encodeFunctionResult(p.name, [[...(meta ? z.metaCoins : d.coins.slice(1)), ...Array(meta ? 6 : 5).fill(ethers.ZeroAddress)]]));
    else if (p.name === "minter") out = target === z.baseLp && !f.baseMinterGetter ? reverted(req.id) : row(req.id, hexAddress(target === d.lp ? z.metaPool : z.basePool));
    else if (p.name === "totalSupply") out = row(req.id, raw(10n ** 25n));
    else if (p.name === "decimals") out = row(req.id, raw(BigInt(target === d.lp ? 18 : z.decimals[d.coins.indexOf(target)])));
    else if (p.name === "balanceOf") out = row(req.id, raw(p.args[0].toLowerCase() === d.pool ? f.donated.get(target) ?? 0n : 10n ** 25n));
    else throw new Error("unexpected fixture ABI " + p.name);
  }
  f.mutate(out); return out;
}
function attest(f: Fixture) { const v = zapIdentityVariant; let step: any = { candidate: { candidateKind: "curve-lp", pool: f.d.pool }, step: 0 };
  for (let n = 0; n < 6; n++) {
    const declared = declareRequestProgram({ requirements: v.requirements, buildRequests: v.buildRequests, decode: () => null }, step);
    const results = declared.requests.map(req => resolve(f, req)); step = { ...step, step: n + 1, evidence: v.decode({ step, results }) };
    const decision = v.decide(step); if (decision.status !== "continue") return decision;
  } throw new Error("zap fixture did not finish"); }
const input = (d: ZapBinding, r: Route, amountIn: bigint): any => ({ descriptor: d as ZapDescriptor, route: r, amountIn, source, executor: actor, runtimeEvidence: [] });
function privateMinterFixture() {
  const f = fixture(); f.baseLpCode = privateMinterRuntime.runtimeCode; f.baseMinterGetter = false;
  f.d = { ...f.d, zap: { ...f.d.zap, baseLpCodeHash: LEGACY_BASE_LP_CODE_HASH } }; return f;
}

test("verified private-minter LP runtime admits through current slot6 permission, including initially unbound code hash", () => {
  assert.equal(ethers.keccak256(privateMinterRuntime.runtimeCode), LEGACY_BASE_LP_CODE_HASH);
  assert.equal(privateMinterRuntime.runtimeCodeKeccak256, LEGACY_BASE_LP_CODE_HASH);
  assert.equal(privateMinterRuntime.privateMinterStorageSlot, LEGACY_BASE_LP_MINTER_SLOT);
  const lpAbi = new ethers.Interface(privateMinterRuntime.abi);
  assert.equal(lpAbi.getFunction("minter"), null); assert.equal(lpAbi.getFunction("owner"), null); assert(lpAbi.getFunction("set_minter"));
  const f = privateMinterFixture(), decision = attest(f); assert.equal(decision.status, "verified");
  if (decision.status === "verified") {
    const bound = decision.identity.binding as ZapBinding;
    assert.equal(bound.zap.baseLpCodeHash, LEGACY_BASE_LP_CODE_HASH); assert.equal(bound.zap.directions.length, 8);
    assert(!("minter" in bound.zap), "current permission is re-read, never frozen into a descriptor");
  }
});
test("private-minter storage cannot bypass reciprocal identity, canonical words or unknown getterless code", () => {
  for (const value of [hexAddress(addr(1999)), raw((1n << 160n) | BigInt(addr(1921))), "0x06", raw(0n)]) {
    const f = privateMinterFixture(); f.minterStorage = value; assert.equal(attest(f).status, "retryable");
  }
  const unknown = privateMinterFixture(); unknown.baseLpCode = code;
  assert.equal(attest(unknown).status, "retryable", "matching slot6 grants no permission to unknown getterless code");
  const reverse = privateMinterFixture(); reverse.reversed = true; assert.equal(attest(reverse).status, "retryable");
  const publicGetter = fixture(); publicGetter.minterStorage = hexAddress(addr(1999));
  assert.equal(attest(publicGetter).status, "verified", "other executable classes retain the public getter proof");
  const wrongGetter = fixture(); wrongGetter.mutate = r => { if (r.ok && r.id === "z-base-minter") Object.assign(r, { data: hexAddress(addr(1999)) }); };
  assert.equal(attest(wrongGetter).status, "retryable");
});
test("private-minter binding rejects foreign source and uncertain code/storage/getter transport", () => {
  for (const id of ["z-base-lp-code", "z-base-minter-storage", "z-base-minter"]) {
    const mixed = privateMinterFixture(); mixed.mutate = r => { if (r.id === id) Object.assign(r, { source: { ...source, generation: source.generation + 1 } }); };
    assert.equal(attest(mixed).status, "retryable", id);
    const transport = privateMinterFixture(); transport.transportId = id; assert.throws(() => attest(transport), RequiredAdapterRequestError, id);
  }
});
test("pricing and Exact declare storage transport and re-read private minter, runtime class and source", () => {
  const f = privateMinterFixture(), d = { ...f.d, instanceKey: f.d.pool } as ZapDescriptor, r = route(d, "redeem", 1), amount = 10n ** 18n;
  const current = { descriptor: d, source, routes: [r] };
  const declared = declareRequestProgram({ requirements: pricing.current.requirements, buildRequests: pricing.current.buildRequests, decode: () => null }, current);
  assert(declared.requirements.transports.includes("get-storage"));
  assert(declared.requests.some(q => q.kind === "get-storage" && q.address === d.zap.baseLp && q.slot === LEGACY_BASE_LP_MINTER_SLOT));
  const initial = declared.requests.map(q => resolve(f, q)), requests = zapMidRequests(d, initial, source), quotes = requests.map(q => resolve(f, q));
  assert(zapSample(decodeZapSnapshot(d, initial, quotes), r));
  const i = input(d, r, amount), exact = declareRequestProgram({ requirements: zapExactProgram.requirements, buildRequests: zapExactProgram.buildRequests, decode: () => null }, i);
  assert(exact.requirements.transports.includes("get-storage"));
  assert.equal(zapExactProgram.decode({ programInput: i, initialResults: exact.requests.map(q => resolve(f, q)), dependentEvidence: [] }).amountOut, model(d, r, amount).output);
  for (const fault of ["minter", "code", "source"] as const) {
    const changed = privateMinterFixture();
    if (fault === "minter") changed.minterStorage = hexAddress(addr(1999));
    if (fault === "code") changed.baseLpCode = code;
    if (fault === "source") changed.mutate = row => { if (row.id === "z-base-minter-storage") Object.assign(row, { source: { ...source, generation: 2 } }); };
    assert.throws(() => zapMidRequests(d, declared.requests.map(q => resolve(changed, q)), source), fault);
    assert.throws(() => zapExactProgram.decode({ programInput: i, initialResults: exact.requests.map(q => resolve(changed, q)), dependentEvidence: [] }), fault);
  }
  for (const id of ["z-base-lp-code", "z-base-minter-storage", "z-base-minter"]) {
    const transport = privateMinterFixture(); transport.transportId = id;
    assert.throws(() => zapMidRequests(d, declared.requests.map(q => resolve(transport, q)), source), RequiredAdapterRequestError, id);
    assert.throws(() => zapExactProgram.decode({ programInput: i, initialResults: exact.requests.map(q => resolve(transport, q)), dependentEvidence: [] }), RequiredAdapterRequestError, id);
  }
});

test("both saved deployed zap runtimes match the shared source class; unlisted synthetic deployment admits by reverse identity", () => {
  assert.equal(ethers.keccak256(deployedCode), ZAP_CODE_HASH); assert.equal(publicRuntime.deployments.length, 2);
  assert.deepEqual(publicRuntime.deployments.map((v: any) => v.address), ["0xaa82ca713d94bba7a89ceab55314f9effeddc78c", "0xd5bcf53e2c81e1991570f33fa881c49eea570c8d"]);
  assert(publicRuntime.deployments.every((v: any) => v.chainId === "1" && v.runtimeMatch === "match" && /^[a-f0-9]{64}$/.test(v.savedRecordSha256)));
  const f = fixture(), decision = attest(f); assert.equal(decision.status, "verified");
  if (decision.status === "verified") { assert.equal(decision.identity.lineageId, ZAP_LINEAGE); assert.equal(decision.identity.subject, f.d.pool); assert.equal((decision.identity.binding as ZapBinding).zap.directions.length, 8); }
});
test("wrong executable class, reciprocal mismatch, rebound getters and mixed sources cannot establish zap identity", () => {
  const empty = fixture(); empty.zapCode = "0x"; const noCode = attest(empty); assert.equal(noCode.status, "chain-proven-rejected");
  if (noCode.status === "chain-proven-rejected") assert.deepEqual(noCode.evidenceRequestIds, ["z-code"]);
  const badCode = fixture(); badCode.zapCode = code; assert.equal(attest(badCode).status, "retryable");
  const wrongReverse = fixture(); wrongReverse.reversed = true; assert.equal(attest(wrongReverse).status, "retryable");
  const getter = fixture(); getter.mutate = r => { if (r.ok && r.id === "z-pool-base") Object.assign(r, { data: hexAddress(addr(1999)) }); }; assert.equal(attest(getter).status, "retryable");
  const mixed = fixture(); mixed.mutate = r => { if (r.id === "z-meta-code") Object.assign(r, { source: { ...source, generation: 2 } }); }; assert.equal(attest(mixed).status, "retryable");
});
test("supported directions are gated separately; real transport failure remains uncertain", () => {
  const f = fixture(); f.disabled.add("redeem:2"); const admitted = attest(f); assert.equal(admitted.status, "verified");
  if (admitted.status === "verified") { const ds = (admitted.identity.binding as ZapBinding).zap.directions; assert.equal(ds.length, 7); assert(!ds.some(v => v.direction === "redeem" && v.index === 2)); }
  const rpc = fixture(); rpc.transportId = "z-base-code"; assert.throws(() => attest(rpc), RequiredAdapterRequestError);
  const mixed = fixture(); mixed.disabled.add("mint:0"); mixed.transportId = "z-behavior-1";
  assert.throws(() => attest(mixed), RequiredAdapterRequestError, "a reverted first probe must not hide the second probe transport failure");
});
test("source-bound exact simulation preserves every requested amount and actual receipt across eight routes", () => {
  const f = fixture(); for (const q of f.d.zap.directions) for (const amount of [10n ** 12n, 123456789012345n]) {
    const r = route(f.d, q.direction, q.index), i = input(f.d, r, amount), declared = declareRequestProgram({ requirements: zapExactProgram.requirements, buildRequests: zapExactProgram.buildRequests, decode: () => null }, i), results = declared.requests.map(req => resolve(f, req));
    const out = zapExactProgram.decode({ programInput: i, initialResults: results, dependentEvidence: [] });
    assert.equal(out.amountOut, model(f.d, r, amount).output); assert.equal(out.evidence.amountIn, amount); assert.deepEqual(out.evidence.source, source);
    assert.equal(out.evidence.executor, actor); assert.equal(out.evidence.routeKey, r.routeKey);
  }
  for (const override of f.observedOverrides as any[]) { assert.equal(override.tokenBalances.length, 1); assert.equal(override.caller.kind, "executor"); assert.equal(override.nativeBalanceWei, undefined); }
});
test("zero Exact performs no reads; one raw base unit is preserved, one LP with zero raw output refuses", () => {
  const f = fixture(), mint = route(f.d, "mint", 1), zero = input(f.d, mint, 0n);
  assert.deepEqual(zapExactProgram.buildRequests(zero), []); assert.deepEqual(zapExactProgram.requirements(zero), { transports: [] });
  assert.equal(zapExactProgram.decode({ programInput: zero, initialResults: [], dependentEvidence: [] }).amountOut, 0n);
  const req = zapQuoteRequest(f.d, mint, 1n, actor, "one"); assert(req.kind === "effect-delta-simulation");
  assert.equal(decodeZapQuote(f.d, mint, 1n, actor, resolve(f, req), source), model(f.d, mint, 1n).output);
  const burn = route(f.d, "redeem", 1); assert.equal(decodeZapQuote(f.d, burn, 1n, actor, resolve(f, zapQuoteRequest(f.d, burn, 1n, actor, "tiny-burn")), source), null);
  assert.throws(() => zapProgram(f.d, mint, actor, 0n)); assert.throws(() => zapQuoteRequest(f.d, mint, -1n, actor, "negative"));
  assert.throws(() => zapQuoteRequest(f.d, mint, ethers.MaxUint256 + 1n, actor, "overflow"));
});
test("runtime rejects zero/short/excess debit, fake/short receipt, retained allowance and native inventory spend", () => {
  for (const fault of ["zero-debit", "under-debit", "over-debit", "wrong-return", "short-receipt", "native-spend", "sticky-allowance"] as const) {
    const f = fixture(); f.fault = fault; const r = route(f.d, "mint", 2), req = zapQuoteRequest(f.d, r, 123456n, actor, fault);
    assert.equal(decodeZapQuote(f.d, r, 123456n, actor, resolve(f, req), source), null, fault);
  }
});
test("real donated zap base LP or swept output refuses without clearing protocol state; executor old output/base LP survive", () => {
  for (const direction of ["mint", "redeem"] as const) for (const donatedToken of ["base", "output"] as const) {
    const f = fixture(), r = route(f.d, direction, 2), token = donatedToken === "base" ? f.d.zap.baseLp : r.tokenOut;
    f.donated.set(token, 1n); const req = zapQuoteRequest(f.d, r, 10n ** 18n, actor, "donation");
    assert.equal(decodeZapQuote(f.d, r, 10n ** 18n, actor, resolve(f, req), source), null); assert.equal(f.donated.get(token), 1n);
  }
  const healthy = fixture(), r = route(healthy.d, "mint", 2), req = zapQuoteRequest(healthy.d, r, 123456n, actor, "inventory");
  assert.equal(decodeZapQuote(healthy.d, r, 123456n, actor, resolve(healthy, req), source), model(healthy.d, r, 123456n).output);
  const stateBlocked = fixture(); stateBlocked.donated.set(stateBlocked.d.lp, 1n);
  const blockedInitial = zapPricingRequests(stateBlocked.d).map(req => resolve(stateBlocked, req));
  const blocked = decodeZapSnapshot(stateBlocked.d, blockedInitial, zapMidRequests(stateBlocked.d, blockedInitial, source).map(req => resolve(stateBlocked, req)));
  assert.equal(zapSample(blocked, route(stateBlocked.d, "mint", 1)), undefined); assert(zapSample(blocked, route(stateBlocked.d, "redeem", 1)));
  const exact = input(stateBlocked.d, route(stateBlocked.d, "mint", 1), 123456n);
  assert.throws(() => zapExactProgram.decode({ programInput: exact, initialResults: zapExactProgram.buildRequests(exact).map(req => resolve(stateBlocked, req)), dependentEvidence: [] }), /swept inventory/);
});
test("runtime preserves nonzero old zap input and refuses a one-unit loss before quote decoding", () => {
  for (const direction of ["mint", "redeem"] as const) {
    const healthy = fixture(), r = route(healthy.d, direction, 1), amount = 10n ** 18n;
    healthy.donated.set(r.tokenIn, 777n);
    const accepted = resolve(healthy, zapQuoteRequest(healthy.d, r, amount, actor, "old-zap-input"));
    assert(accepted.ok); assert.equal(accepted.completion, "returned");
    assert.equal(decodeZapQuote(healthy.d, r, amount, actor, accepted, source), model(healthy.d, r, amount).output);
    assert.equal(healthy.donated.get(r.tokenIn), 777n, "the protocol's old input balance is permitted, never cleared");
    const bad = fixture(); bad.donated.set(r.tokenIn, 777n); bad.fault = "zap-input-spend";
    // The ledger keeps actor debit, output and return value correct. The
    // runtime itself must reject, before the Exact effects decoder can help.
    const rejected = resolve(bad, zapQuoteRequest(bad.d, r, amount, actor, "spent-zap-input"));
    assert(rejected.ok); assert.equal(rejected.completion, "reverted-as-declared");
    assert.equal(bad.donated.get(r.tokenIn), 777n);
  }
});
test("quote decoding rejects missing/duplicate/foreign receipt and supply evidence even with successful call status", () => {
  for (const fault of ["missing-output", "duplicate-output", "wrong-supply", "wrong-source"] as const) {
    const f = fixture(), r = route(f.d, "mint", 1), req = zapQuoteRequest(f.d, r, 123456n, actor, fault), out = resolve(f, req); assert(out.ok && out.effects);
    if (fault === "missing-output") Object.assign(out.effects, { tokenDeltas: out.effects.tokenDeltas!.filter(v => v.token !== r.tokenOut || v.account !== actor) });
    if (fault === "duplicate-output") Object.assign(out.effects, { tokenDeltas: [...out.effects.tokenDeltas!, out.effects.tokenDeltas![1]] });
    if (fault === "wrong-supply") Object.assign(out.effects, { totalSupplyDeltas: [{ token: f.d.lp, delta: 1n }, out.effects.totalSupplyDeltas![1]] });
    if (fault === "wrong-source") Object.assign(out, { source: { ...source, hash: ethers.id("foreign") } });
    assert.throws(() => decodeZapQuote(f.d, r, 123456n, actor, out, source), fault);
  }
});
test("raw mid calls the same simulation decoder, withdraws failed routes and recovers at a new source", () => {
  const f = fixture(), initial = zapPricingRequests(f.d).map(req => resolve(f, req)), requests = zapMidRequests(f.d, initial, source);
  const snapshot = decodeZapSnapshot(f.d, initial, requests.map(req => resolve(f, req))); assert.equal(snapshot.quotes.length, 8);
  for (const q of f.d.zap.directions) assert(zapSample(snapshot, route(f.d, q.direction, q.index)));
  f.disabled.add("mint:1"); const failed = decodeZapSnapshot(f.d, initial, requests.map(req => resolve(f, req)));
  assert.equal(zapSample(failed, route(f.d, "mint", 1)), undefined); assert(zapSample(failed, route(f.d, "redeem", 1)));
  f.disabled.clear(); const next = { number: source.number + 1, hash: ethers.id("zap-next"), generation: source.generation + 1 };
  const nextInitial = initial.map(r => ({ ...r, source: next })), nextQuotes = zapMidRequests(f.d, nextInitial, next).map(req => ({ ...resolve(f, req), source: next }));
  const recovered = decodeZapSnapshot(f.d, nextInitial, nextQuotes); assert(zapSample(recovered, route(f.d, "mint", 1))); assert.deepEqual(recovered.source, next);
  const mixed = requests.map(req => resolve(f, req)); Object.assign(mixed[0], { source: { ...source, generation: 2 } }); assert.throws(() => decodeZapSnapshot(f.d, initial, mixed));
});
test("runtime construction consumes r0 with no quote/Exact transport and no invented native/recipient/callback operation", () => {
  const f = fixture(), before = f.calls; for (const q of f.d.zap.directions) {
    const r = route(f.d, q.direction, q.index), program = zapProgram(f.d, r, actor); assert(ethers.getBytes(program.bytes()).length > 1);
    assert.throws(() => zapProgram(f.d, { ...r, tokenIn: addr(1998) }, actor));
  } assert.equal(f.calls, before);
});

test("zap inventory and nested pool transfers invalidate pricing, unrelated transfers do not", () => {
  const { d } = fixture(), descriptor = { ...d, instanceKey: d.pool } as ZapDescriptor;
  const change = (token: string, from: string, to: string) => {
    const event = ABI.encodeEventLog(ABI.getEvent("Transfer")!, [from, to, 1n]);
    return affected(descriptor, { kind: "log", source, address: token, topics: event.topics, data: event.data } as any);
  };
  for (const [token, target] of [[d.lp, d.pool], [d.zap.baseLp, d.pool], [d.zap.baseLp, d.zap.metaPool], [d.coins[1], d.zap.basePool], [d.lp, ethers.ZeroAddress]])
    assert.deepEqual(change(token, actor, target), [d.pool]);
  assert.deepEqual(change(d.lp, actor, addr(1998)), []);
  assert.deepEqual(change(d.coins[1], actor, addr(1998)), []);
  assert.deepEqual(change(addr(1999), actor, d.pool), []);
});
