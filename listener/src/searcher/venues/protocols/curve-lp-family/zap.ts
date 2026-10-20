// Source-bound Curve metapool deposit zap. This is an extension of Curve LP,
// not a router or a new central execution/quote path.
import { ethers } from "ethers";
import type { IdentitySemantics, ExactRequestProgram, ExactQuoteInput } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { ABI, META, address, assertSource, call, code, decode, uint } from "./codec.js";
import { FAMILY, ZAP_LINEAGE } from "./manifest.js";
export { ZAP_LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Descriptor, Direction, Evidence, Identity, Route, State } from "./types.js";

// Shared executable class, never an instance allowlist. Every candidate must
// independently reverse-bind pool, LP, base pool and ordered coins below.
export const ZAP_CODE_HASH = "0x20c0273b6e9be0115880e3769e5cf845272a739e00518e8bf78cc7a0e790a240";
// Verified Vyper 0.1.0-beta.16 LP runtime: source-map-bound self.minter
// SLOADs at PCs 207/716/1073/1492/1696 and SSTORE at PC 224 use slot 6.
// Select this storage interpretation by full runtime class, never LP address.
export const LEGACY_BASE_LP_CODE_HASH = "0xcb1d74e22245d0cf403f0be2b26f91d1eeaa0236c94bfaeca3673392aa1b1170";
export const LEGACY_BASE_LP_MINTER_SLOT = "0x0000000000000000000000000000000000000000000000000000000000000006";
export const ZAP = new ethers.Interface([
  "function pool() view returns(address)", "function token() view returns(address)",
  "function base_pool() view returns(address)", "function coins(uint256) view returns(address)",
  "function base_coins(uint256) view returns(address)", "function get_base_pool(address) view returns(address)",
  "function add_liquidity(uint256[4],uint256) returns(uint256)",
  "function remove_liquidity_one_coin(uint256,int128,uint256) returns(uint256)",
  "function execSubscript(bytes)",
]);
const BASE = new ethers.Interface(["function coins(int128) view returns(address)"]);
export type ZapShape = {
  readonly metaPool: string; readonly basePool: string; readonly baseLp: string;
  readonly metaCoins: readonly string[]; readonly registryCodeHash: string;
  readonly metaCodeHash: string; readonly baseCodeHash: string; readonly baseLpCodeHash: string;
  readonly registryHandler: string; readonly baseRegistryHandler: string;
  readonly decimals: readonly number[];
  readonly directions: readonly { readonly direction: Direction; readonly index: number }[];
}
export type ZapBinding = Binding & { readonly zap: ZapShape };
export type ZapDescriptor = Descriptor & ZapBinding;
export function isZap(d: Binding): d is ZapBinding { return "zap" in d && d.zap !== undefined; }
export interface ZapState extends State { readonly zapInventory: readonly bigint[] }
export interface ZapSnapshot extends ZapState {
  readonly quotes: readonly { readonly direction: Direction; readonly index: number; readonly amountIn: bigint; readonly amountOut: bigint }[];
}
export const zapSimulationRequirements: RequestRequirements = {
  transports: ["effect-delta-simulation"], caller: "executor",
  effects: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"],
};
const caller = { kind: "executor" as const };
const word = (raw: string) => { if (!ethers.isHexString(raw, 32)) throw new Error("curve-lp zap noncanonical uint"); return BigInt(raw); };
const addr = (raw: string) => { if (!ethers.isHexString(raw, 32) || BigInt(raw) >> 160n !== 0n) throw new Error("curve-lp zap noncanonical address"); return address(ethers.dataSlice(raw, 12)); };
const zcall = (id: string, to: string, name: string, args: readonly unknown[] = []) => call(id, to, ZAP.encodeFunctionData(name, args));
function result(results: readonly AdapterRequestResult[], id: string, source?: CanonicalSource) {
  const matches = results.filter(r => r.id === id); if (matches.length !== 1) throw new Error("curve-lp zap missing/duplicate " + id);
  const r = matches[0]; if (!r.ok) throw new RequiredAdapterRequestError(r); if (source) assertSource(r.source, source); return r;
}
function checkResults(results: readonly AdapterRequestResult[], source?: CanonicalSource) {
  // An unavailable sibling direction cannot hide uncertain transport/source
  // evidence through a short-circuited predicate.
  for (const r of results) if (!r.ok) throw new RequiredAdapterRequestError(r);
  if (source) for (const r of results) assertSource(r.source, source);
}
function values(results: readonly AdapterRequestResult[], requests: readonly Pick<AdapterRequest, "id">[], source?: CanonicalSource) {
  checkResults(results, source);
  if (results.length !== requests.length || new Set(requests.map(r => r.id)).size !== requests.length) throw new Error("curve-lp zap request round");
  const origin = source ?? results[0]?.source; if (!origin) throw new Error("curve-lp zap missing source");
  checkResults(results, origin);
  for (const req of requests) result(results, req.id, origin);
  return { source: origin, get(id: string) { const r = result(results, id, origin); if (r.completion !== "returned") throw new Error("curve-lp zap unavailable " + id); return r.data; } };
}
function assertBinding(d: ZapBinding) {
  const z = d.zap;
  if (!z || d.generic || d.ng || d.poolCodeHash !== ZAP_CODE_HASH || d.coins.length !== 4 || z.metaCoins.length !== 2 ||
      z.metaCoins[0] !== d.coins[0] || z.metaCoins[1] !== z.baseLp || z.decimals.length !== 4 ||
      z.decimals.some(n => !Number.isSafeInteger(n) || n < 0 || n > 36)) throw new Error("curve-lp zap binding shape");
  const subjects = [d.pool, d.lp, z.metaPool, z.basePool, z.baseLp, ...d.coins];
  if (subjects.some(a => address(a) !== a || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") || new Set(subjects).size !== subjects.length)
    throw new Error("curve-lp zap aliased/native binding");
}
function assets(d: ZapBinding, r: Pick<Route, "direction" | "index">) {
  assertBinding(d);
  if (!Number.isInteger(r.index) || r.index < 0 || r.index >= 4 || !d.zap.directions.some(v => v.direction === r.direction && v.index === r.index))
    throw new Error("curve-lp zap unproved direction");
  return { tokenIn: r.direction === "mint" ? d.coins[r.index] : d.lp, tokenOut: r.direction === "mint" ? d.lp : d.coins[r.index] };
}
function route(d: ZapBinding, direction: Direction, index: number): Route { return { direction, index, ...assets(d, { direction, index }) } as Route; }
const allDirections = () => (["mint", "redeem"] as const).flatMap(direction => [0, 1, 2, 3].map(index => ({ direction, index })));
export function zapDependencies(d: ZapBinding): readonly string[] { return [...new Set([META, d.pool, d.lp, d.zap.metaPool, d.zap.basePool, d.zap.baseLp, ...d.coins])]; }
export function zapProjection(d: ZapBinding) { return { ...d.zap, metaCoins: [...d.zap.metaCoins], decimals: [...d.zap.decimals], directions: d.zap.directions.map(v => ({ ...v })) }; }

function surfaceRequests(zap: string): AdapterRequest[] {
  return [zcall("z-pool", zap, "pool"), zcall("z-token", zap, "token"), zcall("z-base", zap, "base_pool"),
    ...[0, 1].map(i => zcall(`z-meta-coin-${i}`, zap, "coins", [i])), ...[0, 1, 2].map(i => zcall(`z-base-coin-${i}`, zap, "base_coins", [i]))];
}
function actorRequest(d: ZapBinding): AdapterRequest {
  return { id: "z-actor", kind: "effect-delta-simulation", call: { caller, executionMode: "impersonated-call-frame", to: d.lp, data: ABI.encodeFunctionData("balanceOf", [ethers.ZeroAddress]) },
    overrideIntent: { caller }, observeTokenBalances: [{ token: d.lp, account: caller }], observe: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] };
}
function actorFrom(d: ZapBinding, results: readonly AdapterRequestResult[], source: CanonicalSource): string {
  const r = result(results, "z-actor", source), deltas = r.effects?.tokenDeltas, native = r.effects?.nativeDeltas;
  if (r.completion !== "returned" || deltas?.length !== 1 || deltas[0].token.toLowerCase() !== d.lp || deltas[0].delta !== 0n ||
      !native?.length || native.some(v => v.delta !== 0n)) throw new Error("curve-lp zap executor authority");
  return runtimeExecutor(deltas[0].account, ...zapDependencies(d)).toLowerCase();
}
export function zapStateRequests(d: ZapBinding): AdapterRequest[] {
  assertBinding(d); const z = d.zap;
  return [code("z-code", d.pool), code("z-registry-code", META), code("z-meta-code", z.metaPool), code("z-base-code", z.basePool),
    code("z-lp-code", d.lp), code("z-base-lp-code", z.baseLp), ...surfaceRequests(d.pool),
    ...[["meta", z.metaPool, d.lp], ["base", z.basePool, z.baseLp]].flatMap(([id, pool, lp]) => [
      call(`z-${id}-handlers`, META, ABI.encodeFunctionData("get_registry_handlers_from_pool", [pool])),
      call(`z-${id}-lp`, META, ABI.encodeFunctionData("get_lp_token", [pool])), call(`z-${id}-reverse`, META, ABI.encodeFunctionData("get_pool_from_lp_token", [lp])),
      call(`z-${id}-coins`, META, ABI.encodeFunctionData("get_coins", [pool])),
      id === "base" ? { ...call("z-base-minter", lp, ABI.encodeFunctionData("minter")), required: false, completion: "return-or-revert-data" as const }
        : call("z-meta-minter", lp, ABI.encodeFunctionData("minter")),
    ]),
    // Initial binding has no baseLpCodeHash yet. Read code, storage and optional
    // getter together; decode chooses using this round's source-bound raw code.
    { id: "z-base-minter-storage", kind: "get-storage", address: z.baseLp, slot: LEGACY_BASE_LP_MINTER_SLOT },
    zcall("z-registry-base", META, "get_base_pool", [z.metaPool]), zcall("z-pool-base", z.metaPool, "base_pool"),
    call("z-supply", d.lp, ABI.encodeFunctionData("totalSupply")), call("z-lp-decimals", d.lp, ABI.encodeFunctionData("decimals")),
    ...[z.baseLp, d.lp, ...d.coins].map((token, i) => call(`z-inventory-${i}`, token, ABI.encodeFunctionData("balanceOf", [d.pool]))),
    ...z.metaCoins.map((_c, i) => call(`z-pool-coin-${i}`, z.metaPool, ABI.encodeFunctionData("coins", [i]))),
    ...d.coins.flatMap((coin, i) => [code(`z-coin-code-${i}`, coin), call(`z-decimal-${i}`, coin, ABI.encodeFunctionData("decimals")),
      ...(i ? [call(`z-base-pool-coin-${i}`, z.basePool, BASE.encodeFunctionData("coins", [i - 1]))] : []),
      call(`z-balance-${i}`, coin, ABI.encodeFunctionData("balanceOf", [i ? z.basePool : z.metaPool]))]),
  ];
}
export function decodeZapState(d: ZapBinding, results: readonly AdapterRequestResult[], source?: CanonicalSource): ZapState {
  const v = values(results, zapStateRequests(d), source), get = v.get, z = d.zap;
  for (const [id, expected] of [["z-code", d.poolCodeHash], ["z-registry-code", z.registryCodeHash], ["z-meta-code", z.metaCodeHash], ["z-base-code", z.baseCodeHash], ["z-lp-code", d.lpCodeHash], ["z-base-lp-code", z.baseLpCodeHash]])
    if (ethers.keccak256(get(id)) !== expected) throw new Error("curve-lp zap code binding changed");
  for (const [id, expected] of [["z-pool", z.metaPool], ["z-token", d.lp], ["z-base", z.basePool], ["z-registry-base", z.basePool], ["z-pool-base", z.basePool]])
    if (addr(get(id)) !== expected) throw new Error("curve-lp zap getter binding changed");
  for (const [prefix, pool, lp, cs, handler] of [["meta", z.metaPool, d.lp, z.metaCoins, z.registryHandler], ["base", z.basePool, z.baseLp, d.coins.slice(1), z.baseRegistryHandler]] as const) {
    const handlers = [...decode("get_registry_handlers_from_pool", get(`z-${prefix}-handlers`))[0]].map(a => String(a).toLowerCase());
    const coins = [...decode("get_coins", get(`z-${prefix}-coins`))[0]].map(a => String(a).toLowerCase());
    const minter = prefix === "base" && ethers.keccak256(get("z-base-lp-code")) === LEGACY_BASE_LP_CODE_HASH
      ? addr(get("z-base-minter-storage")) : addr(get(`z-${prefix}-minter`));
    if (!handlers.includes(handler) || addr(get(`z-${prefix}-lp`)) !== lp || addr(get(`z-${prefix}-reverse`)) !== pool || minter !== pool ||
        coins.some((coin, i) => coin !== (cs[i] ?? ethers.ZeroAddress))) throw new Error("curve-lp zap registry reverse binding changed");
  }
  if (word(get("z-lp-decimals")) !== 18n) throw new Error("curve-lp zap LP precision");
  for (const [i, coin] of d.coins.entries()) {
    const expected = i ? get(`z-base-coin-${i - 1}`) : get("z-meta-coin-0");
    if (addr(expected) !== coin || ethers.keccak256(get(`z-coin-code-${i}`)) !== d.coinCodeHashes[i] || word(get(`z-decimal-${i}`)) !== BigInt(z.decimals[i]) ||
        (i && addr(get(`z-base-pool-coin-${i}`)) !== coin)) throw new Error("curve-lp zap underlying binding changed");
  }
  for (const [i, coin] of z.metaCoins.entries()) if (addr(get(`z-meta-coin-${i}`)) !== coin || addr(get(`z-pool-coin-${i}`)) !== coin) throw new Error("curve-lp zap pool coins changed");
  // State compatibility fields are never a fee/A/kill model for this variant:
  // each direction is priced by actual execution, including permission/fee.
  return { source: v.source, balances: d.coins.map((_c, i) => word(get(`z-balance-${i}`))), totalSupply: word(get("z-supply")), amp: 0n, fee: 0n, killed: false,
    zapInventory: Array.from({ length: 6 }, (_v, i) => word(get(`z-inventory-${i}`))) };
}
function inventoryAvailable(s: ZapState, r: Pick<Route, "direction" | "index">) {
  return s.zapInventory[0] === 0n && s.zapInventory[r.direction === "mint" ? 1 : r.index + 2] === 0n;
}

/** Call the real zap with r0. Never clear/override balances held by the zap.
 * Its source sweeps base LP and output balance, so require those real balances
 * to be zero and independently protect the executor's existing balances. */
export function zapProgram(d: ZapBinding, r: Route, executor: string, minimum = 1n): RuntimeAmountProgram {
  const { tokenIn, tokenOut } = assets(d, r), z = d.zap;
  if (r.tokenIn !== tokenIn || r.tokenOut !== tokenOut || !uint(minimum)) throw new Error("curve-lp zap route/amount");
  const actor = runtimeExecutor(executor, ...zapDependencies(d)).toLowerCase();
  const p = new RuntimeAmountProgram().constant(15, 0n).constant(12, 1n).math("sub", 11, 0, 12).nativeBalance(10);
  const balance = (token: string, account: string, reg: number) => p.call(token, ABI.encodeFunctionData("balanceOf", [account]), { static: true }).load(reg, 0);
  for (const token of new Set([z.baseLp, tokenOut])) balance(token, d.pool, 5).equal(5, 15);
  balance(tokenIn, actor, 14).math("sub", 8, 14, 0); balance(tokenOut, actor, 13); balance(z.baseLp, actor, 9);
  balance(tokenIn, d.pool, 7);
  p.call(tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n])).call(tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(tokenIn, ABI.encodeFunctionData("allowance", [actor, d.pool]), { static: true }).load(5, 0).equal(5, 0);
  const name = r.direction === "mint" ? "add_liquidity" : "remove_liquidity_one_coin";
  const args = r.direction === "mint" ? [Array<bigint>(4).fill(0n), minimum] : [0n, r.index, minimum];
  p.call(d.pool, ZAP.encodeFunctionData(name, args), { patches: [{ offset: r.direction === "mint" ? 4 + r.index * 32 : 4, reg: 0 }] }).load(4, 0);
  p.call(tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n])).call(tokenIn, ABI.encodeFunctionData("allowance", [actor, d.pool]), { static: true }).load(5, 0).equal(5, 15);
  balance(tokenIn, actor, 6).equal(6, 8); balance(tokenOut, actor, 6).math("sub", 6, 6, 13).equal(6, 4).constant(5, minimum).math("sub", 11, 6, 5);
  balance(z.baseLp, actor, 6).equal(6, 9);
  balance(tokenIn, d.pool, 6).equal(6, 7);
  for (const token of new Set([z.baseLp, tokenOut])) balance(token, d.pool, 5).equal(5, 15);
  p.nativeBalance(6).equal(6, 10); return p;
}
function observationScope(d: ZapBinding, r: Route, actor: string) {
  const { tokenIn, tokenOut } = assets(d, r);
  return [[tokenIn, actor], [tokenOut, actor], [tokenIn, d.pool], [tokenOut, d.pool], [d.zap.baseLp, d.pool], [d.zap.baseLp, actor]]
    .filter(([t, a], i, all) => all.findIndex(([otherT, otherA]) => t === otherT && a === otherA) === i).map(([token, account]) => ({ token, account }));
}
export function zapQuoteRequest(d: ZapBinding, r: Route, amount: bigint, executor: string, id: string): AdapterRequest {
  if (!uint(amount) || amount > ethers.MaxUint256 - 111n) throw new Error("curve-lp zap quote amount");
  const actor = runtimeExecutor(executor, ...zapDependencies(d)).toLowerCase(), { tokenIn } = assets(d, r);
  return { id, required: false, kind: "effect-delta-simulation", call: { caller, executionMode: "executor-program", to: actor,
    data: ZAP.encodeFunctionData("execSubscript", [ethers.hexlify(runtimeProgramScript(zapProgram(d, r, actor).bytes(), amount))]) },
    overrideIntent: { caller, tokenBalances: [{ token: tokenIn, amount: amount + 111n }] },
    observeTokenBalances: observationScope(d, r, actor), observeTotalSupplies: [d.lp, d.zap.baseLp],
    observe: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] };
}
export function decodeZapQuote(d: ZapBinding, r: Route, amount: bigint, actor: string, row: AdapterRequestResult, source: CanonicalSource): bigint | null {
  if (!row.ok) throw new RequiredAdapterRequestError(row); assertSource(row.source, source);
  if (row.completion !== "returned") return null;
  const { tokenIn, tokenOut } = assets(d, r), scope = observationScope(d, r, actor), deltas = row.effects?.tokenDeltas;
  if (!deltas || deltas.length !== scope.length) throw new Error("curve-lp zap incomplete receipt effects");
  const delta = (token: string, account: string) => { const m = deltas.filter(v => v.token.toLowerCase() === token && v.account.toLowerCase() === account); if (m.length !== 1) throw new Error("curve-lp zap missing/duplicate effects"); return m[0].delta; };
  const out = delta(tokenOut, actor); if (out <= 0n || out > ethers.MaxUint256 || delta(tokenIn, actor) !== -amount ||
      scope.some(({ token, account }) => (account !== actor || token === d.zap.baseLp) && delta(token, account) !== 0n)) throw new Error("curve-lp zap debit/receipt mismatch");
  const native = row.effects?.nativeDeltas; if (!native?.length || native.filter(v => v.account.toLowerCase() === actor).length !== 1 || native.some(v => v.delta !== 0n)) throw new Error("curve-lp zap native inventory changed");
  const supplies = row.effects?.totalSupplyDeltas, lp = supplies?.filter(v => v.token.toLowerCase() === d.lp), base = supplies?.filter(v => v.token.toLowerCase() === d.zap.baseLp);
  if (supplies?.length !== 2 || lp?.length !== 1 || base?.length !== 1 || lp[0].delta !== (r.direction === "mint" ? out : -amount) ||
      (r.index === 0 ? base[0].delta !== 0n : r.direction === "mint" ? base[0].delta <= 0n : base[0].delta >= 0n)) throw new Error("curve-lp zap supply mismatch");
  return out;
}
function samples(d: ZapBinding, state: State) {
  return d.zap.directions.flatMap(q => [1n, 2n].map(n => {
    const desired = n * 10n ** BigInt(q.direction === "mint" ? d.zap.decimals[q.index] : 18);
    const cap = q.direction === "mint" ? state.balances[q.index] / 1_000_000n : state.totalSupply / 1_000_000n;
    const amount = desired <= cap ? desired : cap / 2n * n;
    return { ...q, amount: amount > 0n ? amount : n };
  }));
}
export function zapPricingRequests(d: ZapBinding): AdapterRequest[] { return [...zapStateRequests(d), actorRequest(d)]; }
export function zapMidRequests(d: ZapBinding, initial: readonly AdapterRequestResult[], source: CanonicalSource): AdapterRequest[] {
  const state = decodeZapState(d, initial.filter(v => v.id !== "z-actor"), source), actor = actorFrom(d, initial, source);
  return d.zap.directions.map(q => { const amount = samples(d, state).find(v => v.direction === q.direction && v.index === q.index)!.amount;
    return zapQuoteRequest(d, route(d, q.direction, q.index), amount, actor, `z-mid-${q.direction}-${q.index}`); });
}
export function decodeZapSnapshot(d: ZapBinding, initial: readonly AdapterRequestResult[], quotes: readonly AdapterRequestResult[]): ZapSnapshot {
  checkResults([...initial, ...quotes]);
  const state = decodeZapState(d, initial.filter(v => v.id !== "z-actor")), actor = actorFrom(d, initial, state.source), requests = zapMidRequests(d, initial, state.source);
  if (quotes.length !== requests.length) throw new Error("curve-lp zap mid round");
  return { ...state, quotes: d.zap.directions.map(q => { const amount = samples(d, state).find(v => v.direction === q.direction && v.index === q.index)!.amount;
    return { ...q, amountIn: amount, amountOut: inventoryAvailable(state, q)
      ? decodeZapQuote(d, route(d, q.direction, q.index), amount, actor, result(quotes, `z-mid-${q.direction}-${q.index}`, state.source), state.source) ?? 0n : 0n }; }) };
}
export function zapSample(s: Pick<ZapSnapshot, "quotes">, r: Route) { const q = s.quotes.find(q => q.direction === r.direction && q.index === r.index); return q?.amountOut ? { amountIn: q.amountIn, amountOut: q.amountOut } : undefined; }

type Input = ExactQuoteInput<Descriptor, Route>;
function invocation(i: Input) {
  if (!isZap(i.descriptor)) throw new Error("curve-lp zap quote descriptor");
  const d = i.descriptor, a = assets(d, i.route); uint(i.amountIn);
  if (a.tokenIn !== i.route.tokenIn || a.tokenOut !== i.route.tokenOut || i.prefix?.length || i.runtimeEvidence.length) throw new Error("curve-lp zap quote invocation; prefix requires runtime simulation");
  return { d, actor: runtimeExecutor(i.executor, ...zapDependencies(d)).toLowerCase() }; }
function output(i: Input, amountOut: bigint) { return { amountOut, evidence: { kind: "curve-lp-exact" as const, source: i.source, binding: i.route.bindingRef.fingerprint,
  routeKey: i.route.routeKey, executor: invocation(i).actor, amountIn: i.amountIn, amountOut } }; }
export const zapExactProgram: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements: i => { invocation(i); return i.amountIn ? { ...zapSimulationRequirements, transports: ["get-code", "get-storage", "eth-call", "effect-delta-simulation"] } : { transports: [] }; },
  buildRequests: i => { const { d, actor } = invocation(i); return i.amountIn ? [...zapStateRequests(d), zapQuoteRequest(d, i.route, i.amountIn, actor, "z-exact")] : []; },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    const { d, actor } = invocation(i); if (dependentEvidence.length) throw new Error("curve-lp zap unexpected quote round");
    if (!i.amountIn) { if (initialResults.length) throw new Error("curve-lp zap zero-input reads"); return output(i, 0n); }
    checkResults(initialResults, i.source);
    const state = decodeZapState(d, initialResults.filter(v => v.id !== "z-exact"), i.source);
    if (!state.totalSupply || i.route.direction === "redeem" && i.amountIn >= state.totalSupply || !inventoryAvailable(state, i.route)) throw new Error("curve-lp zap no capacity or nonzero swept inventory");
    const out = decodeZapQuote(d, i.route, i.amountIn, actor, result(initialResults, "z-exact", i.source), i.source);
    if (out === null) throw new Error("curve-lp zap amount execution unavailable"); return output(i, out);
  },
};

interface Proof { readonly phase: "surface" | "binding" | "behavior" | "complete" | "unavailable" | "rejected"; readonly source: CanonicalSource;
  readonly binding?: ZapBinding; readonly actor?: string; readonly state?: ZapState; readonly probes?: ReturnType<typeof samples>; readonly behaviorHash?: string; readonly reason?: string; readonly rejectionIds?: readonly string[] }
function bindingRequests(d: ZapBinding): AdapterRequest[] { return [...zapStateRequests(d), actorRequest(d)]; }
export const zapIdentityVariant = {
  id: "registry-underlying-zap-source-and-effects", kind: "standalone-contract", lineageId: ZAP_LINEAGE, applies: c => c.candidateKind === "curve-lp",
  requirements: ({ evidence }) => { const p = evidence as Proof | undefined;
    return !p ? { transports: ["get-code"] } : p.phase === "surface" ? { transports: ["eth-call"] }
      : p.phase === "binding" ? { ...zapSimulationRequirements, transports: ["get-code", "get-storage", "eth-call", "effect-delta-simulation"] }
      : p.phase === "behavior" ? zapSimulationRequirements : { transports: [] }; },
  buildRequests({ candidate, evidence }) { const p = evidence as Proof | undefined;
    if (!p) return [code("z-code", candidate.pool)]; if (p.phase === "surface") return surfaceRequests(candidate.pool);
    if (p.phase === "binding") return bindingRequests(p.binding!);
    if (p.phase === "behavior") return p.probes!.map((q, i) => zapQuoteRequest(p.binding!, route(p.binding!, q.direction, q.index), q.amount, p.actor!, `z-behavior-${i}`)); return []; },
  decode({ step, results }): Proof { const p = step.evidence as Proof | undefined, source = p?.source ?? results[0]?.source;
    if (!source) throw new Error("curve-lp zap no identity source");
    try {
      checkResults(results, source);
      if (!p) { const r = values(results, [code("z-code", step.candidate.pool)]), raw = r.get("z-code");
        if (raw === "0x") return { phase: "rejected", source, reason: "curve-lp-zap-no-code", rejectionIds: ["z-code"] };
        if (ethers.keccak256(raw) !== ZAP_CODE_HASH) throw new Error("curve-lp zap executable class unavailable"); return { phase: "surface", source }; }
      if (p.phase === "surface") { const v = values(results, surfaceRequests(step.candidate.pool), source), metaCoins = [0, 1].map(i => addr(v.get(`z-meta-coin-${i}`))),
        baseCoins = [0, 1, 2].map(i => addr(v.get(`z-base-coin-${i}`)));
        return { phase: "binding", source, binding: { pool: address(step.candidate.pool), lp: addr(v.get("z-token")), coins: [metaCoins[0], ...baseCoins], poolCodeHash: ZAP_CODE_HASH,
          lpCodeHash: "", coinCodeHashes: [], zap: { metaPool: addr(v.get("z-pool")), basePool: addr(v.get("z-base")), baseLp: metaCoins[1], metaCoins,
            registryCodeHash: "", registryHandler: "", baseRegistryHandler: "", metaCodeHash: "", baseCodeHash: "", baseLpCodeHash: "", decimals: [0, 0, 0, 0], directions: allDirections() } } }; }
      const d = p.binding!;
      if (p.phase === "binding") {
        const v = values(results, bindingRequests(d), source), get = v.get;
        const handlers = (id: string) => { const a = [...decode("get_registry_handlers_from_pool", get(id))[0]].map(a => String(a).toLowerCase()).find(a => a !== ethers.ZeroAddress); if (!a) throw new Error("curve-lp zap registry membership unavailable"); return a; };
        for (const id of ["z-registry-code", "z-meta-code", "z-base-code", "z-lp-code", "z-base-lp-code", ...[0, 1, 2, 3].map(i => `z-coin-code-${i}`)]) if (get(id) === "0x") throw new Error("curve-lp zap dependency has no code");
        const bound: ZapBinding = { ...d, lpCodeHash: ethers.keccak256(get("z-lp-code")), coinCodeHashes: d.coins.map((_c, i) => ethers.keccak256(get(`z-coin-code-${i}`))), zap: { ...d.zap,
          registryCodeHash: ethers.keccak256(get("z-registry-code")), metaCodeHash: ethers.keccak256(get("z-meta-code")), baseCodeHash: ethers.keccak256(get("z-base-code")), baseLpCodeHash: ethers.keccak256(get("z-base-lp-code")),
          registryHandler: handlers("z-meta-handlers"), baseRegistryHandler: handlers("z-base-handlers"), decimals: d.coins.map((_c, i) => Number(word(get(`z-decimal-${i}`)))) } };
        const state = decodeZapState(bound, results.filter(r => r.id !== "z-actor"), source); if (!state.totalSupply) throw new Error("curve-lp zap no liquidity");
        return { ...p, phase: "behavior", binding: bound, state, actor: actorFrom(bound, results, source), probes: samples(bound, state) };
      }
      if (p.phase !== "behavior") throw new Error("curve-lp zap identity phase");
      values(results, p.probes!.map((_q, i) => ({ id: `z-behavior-${i}` })), source);
      const directions = d.zap.directions.filter(q => inventoryAvailable(p.state!, q) && p.probes!.map((probe, i) => ({ probe, i })).filter(({ probe }) => probe.direction === q.direction && probe.index === q.index).every(({ probe, i }) =>
        decodeZapQuote(d, route(d, q.direction, q.index), probe.amount, p.actor!, result(results, `z-behavior-${i}`, source), source) !== null));
      if (!directions.length) throw new Error("curve-lp zap no behavior-proven direction");
      return { ...p, phase: "complete", binding: { ...d, zap: { ...d.zap, directions } }, behaviorHash: hashCanonical(JSON.parse(JSON.stringify(results, (_k, v) => typeof v === "bigint" ? v.toString() : v))) };
    } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e; return { phase: "unavailable", source, reason: e instanceof Error ? e.message : "curve-lp zap unavailable" }; }
  },
  decide({ evidence }) { const p = evidence as Proof | undefined;
    if (p?.phase === "rejected") return { status: "chain-proven-rejected", reasonCode: p.reason!, evidenceRequestIds: p.rejectionIds! };
    if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
    if (p?.phase !== "complete" || !p.binding || !p.behaviorHash) return { status: "continue" };
    return { status: "verified", identity: { familyId: FAMILY, lineageId: ZAP_LINEAGE, subject: p.binding.pool, binding: p.binding,
      provenance: [{ kind: "curve-zap-source-registry-meta-base-and-actual-receipts", subject: p.binding.pool, evidenceHash: hashCanonical(JSON.parse(JSON.stringify({ binding: p.binding, source: p.source, behaviorHash: p.behaviorHash }))) }] } };
  },
} satisfies IdentitySemantics<Candidate, Identity>["variants"][number];
