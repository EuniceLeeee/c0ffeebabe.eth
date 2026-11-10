// Curve Tricrypto-NG (fixed three-coin, self-LP) single-sided mint extension.
//
// The registry-bound generic fixed-array path is reused unchanged for pricing,
// exact quotes, state and execution: this variant only produces the same
// `generic` Binding shape (`kind: "crypto"`, `coinIndex: "uint256"`), so no
// second quote/execution pipeline exists. What is new here is the identity
// class, the fixed-3/self-LP surface, and the admin-fee LP mint that the
// generic behavior proof refuses to ignore.
//
// Observed runtime class (chain 1, block N=26185253,
// blockHash 0xdd643ebc4407cddccee0ae6e7f5e9d34f8978fde5340d24aaacc39849ad91a2f):
//   pool 0xdb6925ea42897ca786a045b252d95aa7370f44b4
//   runtime 21789 bytes, keccak256 = 0xdd856fa3fba4688c8109bb884689932b6097c73d9cb58522c573c848a20c883d
//   factory() = 0x0c0e5f2ff0ff18a3be9b835635039256dc4b4963 (5314 bytes,
//   keccak256 0xf757bf9a20a2bc4bfdfbe4a5975e6325c2513f517707b3ae598dda7187806d24)
//   factory.fee_receiver() = pool.fee_receiver() = 0xa2bcd1a4efbd04b63cd03f5aff2561106ebcce00
//   MetaRegistry 0xf98b45fa17de75fb1ad0e7afd971b0ca00e379fc reports
//   get_lp_token(pool) = get_pool_from_lp_token(pool) = pool,
//   get_coins(pool) = [0xE72B141DF173b999AE7c1aDcbF60Cc9833Ce56a8,
//   0xA0d69E286B938e21CBf7E51D71F6A4c8918f482F, 0x320623b8E4fF03373931769A31Fc52A4E78B5d70]
//   and handler 0xcbc1be39ba277525e774976c61660f29fa75c5a4.
//
// This hash identifies the deployed code that was exercised here; no upstream
// Vyper artifact was recompiled for this pin, so it is not a source-text
// attestation. It also grants no membership: each instance must additionally
// pass the registry reverse binding, the pinned factory, the factory fee
// receiver agreement and actual same-state mint/admin-fee behavior.
import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { ABI, META, address, assertSource, call, code, decode, uint } from "./codec.js";
import { FAMILY, GENERIC_LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Identity } from "./types.js";

export type TricryptoNgBinding = { readonly model: string; readonly factory: string; readonly factoryCodeHash: string;
  readonly feeReceiver: string; readonly poolBytes: number };
export const TRICRYPTO_NG_MODEL = "tricrypto-ng-fixed3-admin-lp-fee";
export const TRICRYPTO_NG_POOL_HASH = "0xdd856fa3fba4688c8109bb884689932b6097c73d9cb58522c573c848a20c883d";
export const TRICRYPTO_NG_POOL_BYTES = 21789;
export const TRICRYPTO_NG_FACTORY = "0x0c0e5f2ff0ff18a3be9b835635039256dc4b4963";
export const TRICRYPTO_NG_FACTORY_HASH = "0xf757bf9a20a2bc4bfdfbe4a5975e6325c2513f517707b3ae598dda7187806d24";
export const TRICRYPTO_NG_FACTORY_BYTES = 5314;
export const TRICRYPTO_NG = new ethers.Interface([
  "function coins(uint256) view returns(address)", "function price_scale(uint256) view returns(uint256)",
  "function gamma() view returns(uint256)", "function A() view returns(uint256)", "function fee() view returns(uint256)",
  "function mid_fee() view returns(uint256)", "function out_fee() view returns(uint256)",
  "function factory() view returns(address)", "function fee_receiver() view returns(address)",
  "function totalSupply() view returns(uint256)", "function decimals() view returns(uint256)",
  "function calc_token_amount(uint256[3],bool) view returns(uint256)", "function calc_withdraw_one_coin(uint256,uint256) view returns(uint256)",
  "function add_liquidity(uint256[3],uint256) returns(uint256)", "function remove_liquidity_one_coin(uint256,uint256,uint256) returns(uint256)",
  "function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)",
  "event AddLiquidity(address indexed provider,uint256[3] token_amounts,uint256 fee,uint256 token_supply,uint256 packed_price_scale)",
  "event ClaimAdminFee(address indexed admin,uint256 admin_fees)",
  "event Transfer(address indexed sender,address indexed receiver,uint256 value)",
]);
const ZERO = ethers.ZeroAddress;
const effectSet = ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] as const;
const actorEffectSet = ["return-data", "revert-data", "token-delta", "native-delta"] as const;
const caller = { kind: "executor" as const };
const opt = (r: AdapterRequest): AdapterRequest => r.kind === "eth-call" ? { ...r, required: false, completion: "return-or-revert-data" } : r;
type OkResult = Extract<AdapterRequestResult, { readonly ok: true }>;
function one(results: readonly AdapterRequestResult[], id: string): OkResult {
  const rows = results.filter(r => r.id === id); if (rows.length !== 1) throw new Error("curve-lp tricrypto-ng missing/duplicate " + id);
  const r = rows[0]!; if (!r.ok) throw new RequiredAdapterRequestError(r); return r;
}
function data(results: readonly AdapterRequestResult[], id: string, source?: CanonicalSource): string {
  const r = one(results, id); if (source) assertSource(r.source, source);
  if (r.completion !== "returned") throw new Error("curve-lp tricrypto-ng unavailable " + id); return r.data;
}
function optionalWord(results: readonly AdapterRequestResult[], id: string): bigint | undefined {
  const r = one(results, id); return r.completion === "returned" && ethers.isHexString(r.data, 32) ? uint(BigInt(r.data)) : undefined;
}
function optionalAddress(results: readonly AdapterRequestResult[], id: string): string | undefined {
  const raw = optionalWord(results, id); if (raw === undefined || raw === 0n) return undefined;
  if (raw >> 160n !== 0n) throw new Error("curve-lp tricrypto-ng noncanonical optional address");
  return address(ethers.toBeHex(raw, 20));
}
function word(raw: string): bigint {
  if (!ethers.isHexString(raw, 32)) throw new Error("curve-lp tricrypto-ng noncanonical word"); return uint(BigInt(raw));
}
function addressWord(raw: string): string {
  if (!ethers.isHexString(raw, 32) || BigInt(raw) >> 160n !== 0n) throw new Error("curve-lp tricrypto-ng noncanonical address");
  return address(ethers.dataSlice(raw, 12));
}
function addressWordOrZero(raw: string): string {
  if (!ethers.isHexString(raw, 32) || BigInt(raw) >> 160n !== 0n) throw new Error("curve-lp tricrypto-ng noncanonical address");
  const value = ethers.dataSlice(raw, 12).toLowerCase(); return value === ZERO ? ZERO : address(value);
}
function checkRound(results: readonly AdapterRequestResult[], source: CanonicalSource): void {
  for (const r of results) { if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, source); }
}
/** Registry coin ladders are zero padded; a gap or a duplicate is malformed. */
function ladder(raw: readonly string[]): string[] {
  const out: string[] = []; let padding = false;
  for (const item of raw) { const coin = ethers.getAddress(item).toLowerCase();
    if (coin === ZERO) { padding = true; continue; }
    if (padding || out.includes(coin)) throw new Error("curve-lp tricrypto-ng malformed coin ladder"); out.push(coin); }
  return out;
}
interface Quote { readonly index: number; readonly amount: bigint; readonly output: bigint }
interface Behavior { readonly index: number; readonly amount: bigint; readonly output: bigint; readonly adminFee: bigint }
interface Proof {
  readonly phase: "structure" | "quotes" | "behavior" | "complete" | "unavailable";
  readonly source: CanonicalSource;
  readonly binding?: Binding;
  readonly actor?: string;
  readonly quotes?: readonly Quote[];
  readonly behavior?: readonly Behavior[];
  readonly behaviorHash?: string;
  readonly reason?: string;
}
const samples = (d: Binding): { readonly index: number; readonly amount: bigint }[] =>
  d.coins.flatMap((_coin, index) => [1n, 2n].map(n => ({ index, amount: n * 10n ** BigInt(d.generic!.decimals[index]!) })));
function probeRequests(pool: string): AdapterRequest[] {
  return [code("ng3-pool-code", pool),
    ...[0, 1, 2, 3].map(i => opt(call(`ng3-coins-${i}`, pool, TRICRYPTO_NG.encodeFunctionData("coins", [i])))),
    opt(call("ng3-decimals", pool, TRICRYPTO_NG.encodeFunctionData("decimals"))),
    opt(call("ng3-factory", pool, TRICRYPTO_NG.encodeFunctionData("factory")))];
}
function structureRequests(d: Binding): AdapterRequest[] {
  const factory = d.generic!.tricryptoNg!.factory;
  return [code("ng3-factory-code", factory), code("ng3-lp-code", d.lp), code("ng3-registry-code", META),
    call("ng3-registry-lp", META, ABI.encodeFunctionData("get_lp_token", [d.pool])),
    call("ng3-registry-pool", META, ABI.encodeFunctionData("get_pool_from_lp_token", [d.lp])),
    call("ng3-registry-coins", META, ABI.encodeFunctionData("get_coins", [d.pool])),
    call("ng3-registry-handlers", META, ABI.encodeFunctionData("get_registry_handlers_from_pool", [d.pool])),
    call("ng3-registry-base", META, ABI.encodeFunctionData("get_base_pool", [d.pool])),
    call("ng3-supply", d.lp, TRICRYPTO_NG.encodeFunctionData("totalSupply")),
    call("ng3-fee", d.pool, TRICRYPTO_NG.encodeFunctionData("fee")),
    call("ng3-gamma", d.pool, TRICRYPTO_NG.encodeFunctionData("gamma")),
    call("ng3-A", d.pool, TRICRYPTO_NG.encodeFunctionData("A")),
    call("ng3-mid-fee", d.pool, TRICRYPTO_NG.encodeFunctionData("mid_fee")),
    call("ng3-out-fee", d.pool, TRICRYPTO_NG.encodeFunctionData("out_fee")),
    ...[0, 1, 2].map(i => opt(call(`ng3-price-scale-${i}`, d.pool, TRICRYPTO_NG.encodeFunctionData("price_scale", [i])))),
    ...d.coins.flatMap((coin, i) => [code(`ng3-coin-code-${i}`, coin), call(`ng3-coin-decimals-${i}`, coin, ABI.encodeFunctionData("decimals"))]),
    call("ng3-factory-fee-receiver", factory, TRICRYPTO_NG.encodeFunctionData("fee_receiver")),
    opt(call("ng3-pool-fee-receiver", d.pool, TRICRYPTO_NG.encodeFunctionData("fee_receiver"))),
    // Executor authority witness: an immutable view in a fresh impersonated
    // frame. Its observed balance delta is zero; only the actor is retained.
    { id: "ng3-actor", kind: "effect-delta-simulation" as const, call: { caller, executionMode: "impersonated-call-frame" as const,
      to: d.coins[0]!, data: TRICRYPTO_NG.encodeFunctionData("balanceOf", [ZERO]) },
      overrideIntent: { caller }, observeTokenBalances: [{ token: d.coins[0]!, account: caller }],
      observe: [...actorEffectSet] as const }];
}
const quoteRequest = (d: Binding, q: { readonly index: number; readonly amount: bigint }, id: string): AdapterRequest => {
  const amounts = d.coins.map((_coin, i) => i === q.index ? q.amount : 0n);
  return opt(call(id, d.pool, TRICRYPTO_NG.encodeFunctionData("calc_token_amount", [amounts, true])));
};
function behaviorRequest(d: Binding, q: Quote, actor: string, feeReceiver: string, id: string): AdapterRequest {
  const coin = d.coins[q.index]!, amounts = d.coins.map((_coin, i) => i === q.index ? q.amount : 0n);
  const scope = [...d.coins, d.lp].flatMap(token => [actor, d.pool, feeReceiver].map(account => ({ token, account })));
  return { id, required: false, kind: "effect-delta-simulation" as const,
    preCalls: [0n, q.amount].map(n => ({ caller, to: coin, data: ABI.encodeFunctionData("approve", [d.pool, n]) })),
    call: { caller, executionMode: "impersonated-call-frame" as const, to: d.pool,
      data: TRICRYPTO_NG.encodeFunctionData("add_liquidity", [amounts, 1n]) },
    overrideIntent: { caller, tokenBalances: [{ token: coin, amount: q.amount }] },
    observeTokenBalances: scope, observeTotalSupplies: [d.lp], observe: [...effectSet] as const };
}
function canonicalEvent(name: "ClaimAdminFee" | "Transfer", log: { readonly address: string; readonly data: string; readonly topics: readonly string[] }) {
  const decoded = TRICRYPTO_NG.decodeEventLog(name, log.data, [...log.topics]),
    encoded = TRICRYPTO_NG.encodeEventLog(TRICRYPTO_NG.getEvent(name)!, decoded);
  if (encoded.data.toLowerCase() !== log.data.toLowerCase() || encoded.topics.length !== log.topics.length ||
      encoded.topics.some((t, i) => t.toLowerCase() !== log.topics[i]!.toLowerCase())) throw new Error("curve-lp tricrypto-ng noncanonical event");
  return decoded;
}
/** Exact request/result proof for one single-sided mint. The admin LP fee mint
 * is measured, matched against its canonical ClaimAdminFee log and the LP
 * supply delta, and never folded into the user's output. */
function proves(d: Binding, q: Quote, actor: string, feeReceiver: string, row: OkResult, source: CanonicalSource):
  { readonly output: bigint; readonly adminFee: bigint } | null {
  assertSource(row.source, source); if (row.completion !== "returned") return null;
  const output = word(row.data), coin = d.coins[q.index]!;
  if (!output || output !== q.output) return null;
  const deltas = row.effects?.tokenDeltas;
  const scope = [...d.coins, d.lp].flatMap(token => [actor, d.pool, feeReceiver].map(account => ({ token, account })));
  if (!deltas || deltas.length !== scope.length) return null;
  const delta = (token: string, account: string): bigint | undefined => {
    const rows = deltas.filter(v => v.token.toLowerCase() === token && v.account.toLowerCase() === account);
    return rows.length === 1 ? rows[0]!.delta : undefined; };
  const adminFee = delta(d.lp, feeReceiver); if (adminFee === undefined || adminFee < 0n) return null;
  if (delta(coin, actor) !== -q.amount || delta(coin, d.pool) !== q.amount || delta(d.lp, actor) !== output || delta(d.lp, d.pool) !== 0n) return null;
  for (const { token, account } of scope) {
    if (token === coin && (account === actor || account === d.pool)) continue;
    if (token === d.lp && (account === actor || account === feeReceiver)) continue;
    if (delta(token, account) !== 0n) return null;
  }
  const supply = row.effects?.totalSupplyDeltas;
  if (supply?.length !== 1 || supply[0]!.token.toLowerCase() !== d.lp || supply[0]!.delta !== output + adminFee) return null;
  const native = row.effects?.nativeDeltas;
  if (!native?.length || native.filter(v => v.account.toLowerCase() === actor).length !== 1 || native.some(v => v.delta !== 0n)) return null;
  const logs = row.effects?.logs; if (!logs) return null;
  const poolLogs = logs.filter(l => l.address.toLowerCase() === d.pool);
  const transferTopic = TRICRYPTO_NG.getEvent("Transfer")!.topicHash.toLowerCase();
  const claimTopic = TRICRYPTO_NG.getEvent("ClaimAdminFee")!.topicHash.toLowerCase();
  const transfers = poolLogs.filter(l => l.topics[0]?.toLowerCase() === transferTopic).map(l => canonicalEvent("Transfer", l));
  const mints = transfers.filter(v => String(v.sender).toLowerCase() === ZERO);
  if (transfers.length !== mints.length) return null;
  const mintTo = (account: string) => mints.filter(v => String(v.receiver).toLowerCase() === account).reduce((n, v) => n + BigInt(v.value), 0n);
  if (mints.filter(v => String(v.receiver).toLowerCase() === actor).length !== 1 || mintTo(actor) !== output) return null;
  if (adminFee === 0n ? mints.length !== 1 : mints.length !== 2 || mintTo(feeReceiver) !== adminFee) return null;
  const claims = poolLogs.filter(l => l.topics[0]?.toLowerCase() === claimTopic).map(l => canonicalEvent("ClaimAdminFee", l));
  if (claims.length !== (adminFee === 0n ? 0 : 1)) return null;
  if (adminFee !== 0n && (String(claims[0]!.admin).toLowerCase() !== feeReceiver || BigInt(claims[0]!.admin_fees) !== adminFee)) return null;
  const coinTransfers = logs.filter(l => l.address.toLowerCase() === coin && l.topics[0]?.toLowerCase() === transferTopic).map(l => canonicalEvent("Transfer", l));
  if (coinTransfers.length !== 1 || String(coinTransfers[0]!.sender).toLowerCase() !== actor ||
      String(coinTransfers[0]!.receiver).toLowerCase() !== d.pool || BigInt(coinTransfers[0]!.value) !== q.amount) return null;
  if (logs.some(l => l.topics[0]?.toLowerCase() === transferTopic && d.coins.some((other, i) => i !== q.index && l.address.toLowerCase() === other))) return null;
  return { output, adminFee };
}
export const tricryptoNgIdentityVariant: IdentitySemantics<Candidate, Identity>["variants"][number] = {
  id: "registry-tricrypto-ng-fixed3-and-mint-burn-effects", kind: "registry-member", lineageId: GENERIC_LINEAGE,
  applies: c => c.candidateKind === "curve-lp",
  requirements: ({ evidence }) => { const p = evidence as Proof | undefined;
    if (p?.phase === "structure") return { transports: ["get-code", "eth-call", "effect-delta-simulation"], caller: "executor", effects: [...actorEffectSet] };
    if (p?.phase === "quotes") return { transports: ["eth-call"] };
    if (p?.phase === "behavior") return { transports: ["effect-delta-simulation"], caller: "executor", effects: [...effectSet] };
    return { transports: ["get-code", "eth-call"] }; },
  buildRequests({ candidate, evidence }) { const p = evidence as Proof | undefined;
    if (!p) return probeRequests(candidate.pool);
    if (p.phase === "structure") return structureRequests(p.binding!);
    if (p.phase === "quotes") return samples(p.binding!).map((q, i) => quoteRequest(p.binding!, q, `ng3-quote-${i}`));
    if (p.phase === "behavior") return (p.quotes ?? []).map((q, i) => behaviorRequest(p.binding!, q, p.actor!, p.binding!.generic!.tricryptoNg!.feeReceiver, `ng3-mint-${i}`));
    return []; },
  decode({ step, results }): Proof { const p = step.evidence as Proof | undefined, source = p?.source ?? results[0]?.source;
    if (!source) throw new Error("curve-lp tricrypto-ng missing source");
    try {
      checkRound(results, source);
      if (!p) {
        const pool = address(step.candidate.pool), poolCode = data(results, "ng3-pool-code", source);
        if (poolCode === "0x") return { phase: "unavailable", source, reason: "curve-lp tricrypto-ng no runtime code" };
        if (ethers.getBytes(poolCode).length !== TRICRYPTO_NG_POOL_BYTES || ethers.keccak256(poolCode) !== TRICRYPTO_NG_POOL_HASH)
          return { phase: "unavailable", source, reason: "curve-lp unsupported tricrypto-ng runtime class" };
        const coins = [0, 1, 2].map(i => addressWord(data(results, `ng3-coins-${i}`, source)));
        const fourth = optionalWord(results, "ng3-coins-3"); if (fourth !== undefined && fourth !== 0n) throw new Error("curve-lp tricrypto-ng not a fixed three-coin domain");
        if (new Set(coins).size !== 3 || coins.includes(pool) || coins.includes(META)) throw new Error("curve-lp tricrypto-ng aliased coins");
        if (word(data(results, "ng3-decimals", source)) !== 18n) throw new Error("curve-lp tricrypto-ng LP decimals");
        if (addressWord(data(results, "ng3-factory", source)) !== TRICRYPTO_NG_FACTORY)
          return { phase: "unavailable", source, reason: "curve-lp tricrypto-ng factory mismatch" };
        return { phase: "structure", source, binding: { pool, lp: pool, coins, poolCodeHash: TRICRYPTO_NG_POOL_HASH, lpCodeHash: "",
          coinCodeHashes: [], generic: { kind: "crypto", identitySource: "meta-registry", registryHandler: "", registryCodeHash: "",
            sourceCodeHash: "", decimals: [], coinIndex: "uint256", basePool: ZERO, baseLp: ZERO, baseCodeHash: "", calcCodeHash: "",
            mintQuote: "crypto-bool", implementation: ZERO, implementationCodeHash: "", forwarderBytes: 0, directions: [],
            tricryptoNg: { model: TRICRYPTO_NG_MODEL, factory: TRICRYPTO_NG_FACTORY, factoryCodeHash: TRICRYPTO_NG_FACTORY_HASH,
              feeReceiver: ZERO, poolBytes: TRICRYPTO_NG_POOL_BYTES } } } };
      }
      const d = p.binding!, g = d.generic!;
      if (p.phase === "structure") {
        const factoryCode = data(results, "ng3-factory-code", source);
        if (ethers.getBytes(factoryCode).length !== TRICRYPTO_NG_FACTORY_BYTES || ethers.keccak256(factoryCode) !== TRICRYPTO_NG_FACTORY_HASH)
          throw new Error("curve-lp tricrypto-ng factory class changed");
        // The pool is its own LP token: the structure round must observe the
        // same pinned runtime at the LP address (and the root round already
        // proved that address is the pool).
        const lpCode = data(results, "ng3-lp-code", source);
        if (ethers.keccak256(lpCode) !== TRICRYPTO_NG_POOL_HASH || d.poolCodeHash !== TRICRYPTO_NG_POOL_HASH)
          throw new Error("curve-lp tricrypto-ng LP is not the pool");
        const registryCode = data(results, "ng3-registry-code", source); if (registryCode === "0x") throw new Error("curve-lp tricrypto-ng registry code unavailable");
        const coinCodeHashes = d.coins.map((_coin, i) => { const raw = data(results, `ng3-coin-code-${i}`, source);
          if (raw === "0x") throw new Error("curve-lp tricrypto-ng coin code unavailable"); return ethers.keccak256(raw); });
        const decimals = d.coins.map((_coin, i) => Number(word(data(results, `ng3-coin-decimals-${i}`, source))));
        if (decimals.some(v => !Number.isSafeInteger(v) || v < 0 || v > 36)) throw new Error("curve-lp tricrypto-ng coin decimals");
        const lp = addressWord(data(results, "ng3-registry-lp", source)), inverse = addressWord(data(results, "ng3-registry-pool", source)),
          registered = ladder([...decode("get_coins", data(results, "ng3-registry-coins", source))[0]]),
          handlers = [...decode("get_registry_handlers_from_pool", data(results, "ng3-registry-handlers", source))[0]]
            .map((v: string) => String(v).toLowerCase()).filter((v: string) => v !== ZERO),
          base = addressWordOrZero(data(results, "ng3-registry-base", source));
        if (lp !== d.pool || inverse !== d.pool || registered.length !== 3 || registered.some((v, i) => v !== d.coins[i]) ||
            !handlers.length || base !== ZERO) throw new Error("curve-lp tricrypto-ng registry binding");
        if (address(handlers[0]!) !== handlers[0]) throw new Error("curve-lp tricrypto-ng registry handler");
        if (word(data(results, "ng3-supply", source)) === 0n) throw new Error("curve-lp tricrypto-ng zero supply");
        const fee = word(data(results, "ng3-fee", source)); if (fee > 10n ** 10n) throw new Error("curve-lp tricrypto-ng fee bounds");
        const gamma = word(data(results, "ng3-gamma", source)), amp = word(data(results, "ng3-A", source));
        const midFee = word(data(results, "ng3-mid-fee", source)), outFee = word(data(results, "ng3-out-fee", source));
        if (!gamma || !amp || !midFee || midFee > outFee) throw new Error("curve-lp tricrypto-ng curve parameters");
        const scales = [0, 1].map(i => word(data(results, `ng3-price-scale-${i}`, source)));
        const thirdScale = optionalWord(results, "ng3-price-scale-2");
        if (!scales.every(v => v > 0n) || (thirdScale !== undefined && thirdScale !== 0n)) throw new Error("curve-lp tricrypto-ng price scale domain");
        const feeReceiver = addressWord(data(results, "ng3-factory-fee-receiver", source));
        const poolFeeReceiver = optionalAddress(results, "ng3-pool-fee-receiver");
        if (poolFeeReceiver !== undefined && poolFeeReceiver !== feeReceiver) throw new Error("curve-lp tricrypto-ng fee receiver disagreement");
        if ([d.pool, ...d.coins].includes(feeReceiver)) throw new Error("curve-lp tricrypto-ng aliased fee receiver");
        const probe = one(results, "ng3-actor"), observed = probe.effects?.tokenDeltas;
        if (probe.completion !== "returned" || observed?.length !== 1 || observed[0]!.token.toLowerCase() !== d.coins[0] || observed[0]!.delta !== 0n ||
            !probe.effects?.nativeDeltas?.length || probe.effects.nativeDeltas.some(v => v.delta !== 0n)) throw new Error("curve-lp tricrypto-ng executor authority");
        const actor = address(observed[0]!.account);
        if ([d.pool, feeReceiver, ...d.coins].includes(actor)) throw new Error("curve-lp tricrypto-ng aliased executor");
        return { phase: "quotes", source, actor, binding: { ...d, lpCodeHash: ethers.keccak256(lpCode), coinCodeHashes,
          generic: { ...g, registryHandler: handlers[0]!, registryCodeHash: ethers.keccak256(registryCode), sourceCodeHash: d.poolCodeHash,
            decimals, tricryptoNg: { ...g.tricryptoNg!, feeReceiver } } } };
      }
      if (p.phase === "quotes") {
        const quotes = samples(d).flatMap((q, i) => { const output = optionalWord(results, `ng3-quote-${i}`);
          return output !== undefined && output > 0n ? [{ index: q.index, amount: q.amount, output }] : []; });
        if (!quotes.length) throw new Error("curve-lp tricrypto-ng no positive amount quote");
        return { ...p, phase: "behavior", quotes };
      }
      if (p.phase !== "behavior") throw new Error("curve-lp tricrypto-ng identity phase");
      const feeReceiver = g.tricryptoNg!.feeReceiver, behavior: Behavior[] = [];
      for (const [i, q] of p.quotes!.entries()) {
        const row = one(results, `ng3-mint-${i}`), proved = proves(d, q, p.actor!, feeReceiver, row, source);
        if (proved) behavior.push({ index: q.index, amount: q.amount, output: proved.output, adminFee: proved.adminFee });
      }
      const directions = d.coins.flatMap((_coin, index) => behavior.filter(v => v.index === index).length === 2
        ? [{ direction: "mint" as const, index, receiverMode: "none" as const }] : []);
      if (!directions.length) throw new Error("curve-lp tricrypto-ng no behavior-proven mint direction");
      return { ...p, phase: "complete", behavior, binding: { ...d, generic: { ...g, directions } },
        behaviorHash: hashCanonical(JSON.parse(JSON.stringify(results, (_k, v) => typeof v === "bigint" ? v.toString() : v))) };
    } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e; return { phase: "unavailable", source, reason: e instanceof Error ? e.message : "curve-lp tricrypto-ng unavailable" }; } },
  decide({ evidence }) { const p = evidence as Proof | undefined;
    if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
    if (p?.phase !== "complete" || !p.binding?.generic || !p.behaviorHash) return { status: "continue" };
    return { status: "verified", identity: { familyId: FAMILY, lineageId: GENERIC_LINEAGE, subject: p.binding.pool, binding: p.binding,
      provenance: [{ kind: "curve-tricrypto-ng-factory-self-lp-and-actual-mint-fee", subject: p.binding.pool,
        evidenceHash: hashCanonical(JSON.parse(JSON.stringify({ binding: p.binding, source: p.source, behaviorHash: p.behaviorHash }))) }] } }; },
};
