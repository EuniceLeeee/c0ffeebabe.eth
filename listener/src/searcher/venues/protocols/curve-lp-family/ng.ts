// Registry-bound StableSwap NG single-coin mint/burn extension. This deliberately
// does not reuse the v0.3.1 fee-free calc_token_amount or fixed precision model.
import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { ABI, META, address, assertSource, call, code, decode, uint } from "./codec.js";
import { MAX_EXECUTION_ROUNDING_RAW_UNITS, assertExecutionRounding, executionInputMatches, executionOutputMatches } from "../../../../shared/executor/amount-rounding.js";
import { FAMILY, NG_LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Descriptor, Direction, Identity, Route, State } from "./types.js";

import { proveNgCode, proveNgViews, type NgCodeProof } from "./ng-source.js";
export const NG = new ethers.Interface([
  "function N_COINS() view returns(uint256)", "function factory() view returns(address)",
  "function get_base_registry(address) view returns(address)",
  "function views_implementation() view returns(address)",
  "function add_liquidity(uint256[],uint256,address) returns(uint256)",
  "function remove_liquidity_one_coin(uint256,int128,uint256,address) returns(uint256)",
  "function calc_token_amount(uint256[],bool) view returns(uint256)",
  "function calc_withdraw_one_coin(uint256,int128) view returns(uint256)",
]);
export const NG_META = new ethers.Interface([
  "function add_liquidity(uint256[2],uint256,address) returns(uint256)",
  "function calc_token_amount(uint256[2],bool) view returns(uint256)",
]);
export const NG_DEFAULT = new ethers.Interface(["function add_liquidity(uint256[],uint256) returns(uint256)"]);
export const NG_CALLS = [
  { id: "add_liquidity", abi: NG, fn: "add_liquidity" },
  { id: "remove_liquidity_one_coin", abi: NG, fn: "remove_liquidity_one_coin" },
  { id: "add_liquidity_default", abi: NG_DEFAULT, fn: "add_liquidity" },
  { id: "meta_add_liquidity", abi: NG_META, fn: "add_liquidity" },
] as const;
export const NG_EVENTS = new ethers.Interface([
  "event AddLiquidity(address indexed provider,uint256[] token_amounts,uint256[] fees,uint256 invariant,uint256 token_supply)",
  "event RemoveLiquidityOne(address indexed provider,int128 token_id,uint256 token_amount,uint256 coin_amount,uint256 token_supply)",
]);
const ngAbi = (d: Binding, direction: Direction) => d.ng?.array === "fixed2" && direction === "mint" ? NG_META : NG;
export const ngInputOffset = (d: Binding, direction: Direction, index: number) => direction === "redeem" ? 4 : d.ng?.array === "fixed2" ? 4 + 32 * index : 132 + 32 * index;
export const NG_RECEIVER = "0x0000000000000000000000000000000000000001";
const executorProbeToken = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const nonzero = (values: readonly string[]) => values.map(v => v.toLowerCase()).filter(v => v !== ethers.ZeroAddress);
function registryCoins(values: readonly string[]): string[] {
  const out: string[] = []; let padding = false;
  for (const raw of values) { const coin = ethers.getAddress(raw).toLowerCase();
    if (coin === ethers.ZeroAddress) { padding = true; continue; }
    if (padding || out.includes(coin)) throw new Error("curve-lp NG malformed registry coins"); out.push(coin);
  } return out;
}
const read = (results: readonly AdapterRequestResult[], id: string, source?: CanonicalSource) => {
  const rows = results.filter(r => r.id === id); if (rows.length !== 1) throw new Error("curve-lp NG missing/duplicate " + id);
  const r = rows[0]; if (!r.ok) throw new RequiredAdapterRequestError(r);
  if (source) assertSource(r.source, source); return r;
};
const optionalCall = (request: AdapterRequest): AdapterRequest => request.kind === "eth-call"
  ? { ...request, required: false, completion: "return-or-revert-data" } : request;
const returned = (results: readonly AdapterRequestResult[], id: string, source?: CanonicalSource) => {
  const r = read(results, id, source); if (r.completion !== "returned") throw new Error("curve-lp NG unavailable " + id); return r;
};
function scalar(abi: ethers.Interface, fn: string, data: string): bigint {
  const v = abi.decodeFunctionResult(fn, data); if (abi.encodeFunctionResult(fn, v).toLowerCase() !== data.toLowerCase())
    throw new Error("curve-lp NG malformed " + fn); return uint(v[0]);
}
function value(abi: ethers.Interface, fn: string, data: string): string {
  const v = abi.decodeFunctionResult(fn, data); if (abi.encodeFunctionResult(fn, v).toLowerCase() !== data.toLowerCase())
    throw new Error("curve-lp NG malformed " + fn); return ethers.getAddress(v[0]).toLowerCase();
}
export const ngStateRequests = (d: Binding): AdapterRequest[] => {
  if (!d.ng) throw new Error("curve-lp not NG");
  return [code("pool-code", d.pool), code("factory-code", d.ng.factory), code("views-code", d.ng.views), ...d.ng.external.map((e, i) => code(`ng-external-code-${i}`, e.address)),
    call("registry-handlers", META, ABI.encodeFunctionData("get_registry_handlers_from_pool", [d.pool])),
    call("registry-lp", META, ABI.encodeFunctionData("get_lp_token", [d.pool])),
    call("registry-pool", META, ABI.encodeFunctionData("get_pool_from_lp_token", [d.lp])),
    call("registry-coins", META, ABI.encodeFunctionData("get_coins", [d.pool])),
    call("ng-factory", META, NG.encodeFunctionData("get_base_registry", [d.ng.registryHandler])),
    call("ng-views", d.ng.factory, NG.encodeFunctionData("views_implementation")),
    call("ng-count", d.pool, NG.encodeFunctionData("N_COINS")),
    call("ng-supply", d.lp, ABI.encodeFunctionData("totalSupply")),
    call("ng-amp", d.pool, ABI.encodeFunctionData("A_precise")), call("ng-fee", d.pool, ABI.encodeFunctionData("fee")),
    ...d.coins.map((_coin, i) => call(`ng-balance-${i}`, d.pool, ABI.encodeFunctionData("balances", [i]))),
    ...d.coins.map((coin, i) => code(`ng-coin-code-${i}`, coin)),
    ...d.coins.map((_coin, i) => call(`ng-coin-${i}`, d.pool, ABI.encodeFunctionData("coins", [i]))),
  ];
};
export function decodeNgState(d: Binding, results: readonly AdapterRequestResult[], source?: CanonicalSource): State {
  if (!d.ng) throw new Error("curve-lp not NG");
  const proof = proveNgCode(returned(results, "pool-code", source).data);
  if (proof.model !== d.ng.model || proof.factory !== d.ng.factory || proof.coins.some((coin, i) => coin !== d.coins[i]) || proof.external.length !== d.ng.external.length || proof.external.some((a, i) => a !== d.ng!.external[i].address)) throw new Error("curve-lp NG source class changed");
  const origin = source ?? results[0]?.source; if (!origin) throw new Error("curve-lp NG source");
  const get = (id: string) => returned(results, id, origin).data;
  const handlers = nonzero([...decode("get_registry_handlers_from_pool", get("registry-handlers"))[0]]);
  const registered = registryCoins([...decode("get_coins", get("registry-coins"))[0]]);
  if (ethers.keccak256(get("pool-code")) !== d.poolCodeHash || ethers.keccak256(get("factory-code")) !== d.ng.factoryCodeHash ||
      ethers.keccak256(get("views-code")) !== d.ng.viewsCodeHash || value(NG, "get_base_registry", get("ng-factory")) !== d.ng.factory ||
      value(NG, "views_implementation", get("ng-views")) !== d.ng.views ||
      value(ABI, "get_lp_token", get("registry-lp")) !== d.lp || value(ABI, "get_pool_from_lp_token", get("registry-pool")) !== d.pool ||
      scalar(NG, "N_COINS", get("ng-count")) !== BigInt(d.coins.length) ||
      registered.length !== d.coins.length || registered.some((v, i) => v !== d.coins[i]) || !handlers.includes(d.ng.registryHandler) ||
      d.ng.external.some((e, i) => ethers.keccak256(get(`ng-external-code-${i}`)) !== e.codeHash) ||
      d.coins.some((coin, i) => value(ABI, "coins", get(`ng-coin-${i}`)) !== coin || ethers.keccak256(get(`ng-coin-code-${i}`)) !== d.coinCodeHashes[i])) throw new Error("curve-lp NG binding changed");
  return { source: origin, totalSupply: scalar(ABI, "totalSupply", get("ng-supply")), balances: d.coins.map((_coin, i) => scalar(ABI, "balances", get(`ng-balance-${i}`))),
    amp: scalar(ABI, "A_precise", get("ng-amp")), fee: scalar(ABI, "fee", get("ng-fee")), killed: false };
}
export function ngQuoteRequest(d: Binding, direction: Direction, index: number, amount: bigint, id: string): AdapterRequest {
  if (!d.ng || !Number.isInteger(index) || index < 0 || index >= d.coins.length || uint(amount) === 0n) throw new Error("curve-lp NG quote request");
  const amounts = d.coins.map((_c, i) => i === index ? amount : 0n);
  return optionalCall(call(id, d.pool, ngAbi(d, direction).encodeFunctionData(direction === "mint" ? "calc_token_amount" : "calc_withdraw_one_coin",
    direction === "mint" ? [amounts, true] : [amount, index])));
}
export function ngQuoteResult(direction: Direction, result: AdapterRequestResult): bigint {
  if (!result.ok) throw new RequiredAdapterRequestError(result);
  if (result.completion !== "returned") throw new Error("curve-lp NG amount quote reverted");
  const output = scalar(NG, direction === "mint" ? "calc_token_amount" : "calc_withdraw_one_coin", result.data);
  if (!output) throw new Error("curve-lp NG no positive output"); return output;
}
export function ngExecutionData(d: Binding, direction: Direction, index: number, minimum: bigint, recipient: string): string {
  if (!d.ng || index < 0 || index >= d.coins.length || !uint(minimum)) throw new Error("curve-lp NG operation");
  return ngAbi(d, direction).encodeFunctionData(direction === "mint" ? "add_liquidity" : "remove_liquidity_one_coin", direction === "mint"
    ? [d.coins.map(() => 0n), minimum, recipient] : [0n, index, minimum, recipient]);
}
/** r0 is this transaction's actual input. No chain quote or preset output is
 * involved. The output receiver and payer are independently protected even
 * when pool and LP token share an address. NG has ERC20 coins; no ETH shim. */
export function ngProgram(d: Descriptor, r: Route, executor: string, minimum = 1n, recipient = executor, toleranceRawUnits = MAX_EXECUTION_ROUNDING_RAW_UNITS): RuntimeAmountProgram {
  assertExecutionRounding(toleranceRawUnits);
  if (!d.ng || !d.ng.directions.some(v => v.direction === r.direction && v.index === r.index &&
      (recipient.toLowerCase() === executor.toLowerCase() || v.directOutput))) throw new Error("curve-lp NG unproved direction/receiver");
  const actor = runtimeExecutor(executor, ...d.coins).toLowerCase(), receiver = runtimeExecutor(recipient, ...d.coins).toLowerCase();
  if (actor === d.pool || receiver === d.pool || r.tokenIn === r.tokenOut) throw new Error("curve-lp NG aliased actor");
  const external = actor !== receiver, p = new RuntimeAmountProgram().constant(15, 0n).constant(12, 1n)
    .math("sub", 11, 0, 12).nativeBalance(10)
    .call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]), { static: true }).load(14, 0).math("sub", 8, 14, 0)
    .call(r.tokenOut, RUNTIME_ERC20.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(13, 0);
  if (external) p.call(r.tokenOut, RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]), { static: true }).load(9, 0)
    .call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(7, 0);
  if (r.direction === "mint") p.call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("approve", [d.pool, 0n]))
    .call(r.tokenIn, ABI.encodeFunctionData("allowance", [actor, d.pool]), { static: true }).load(5, 0).equal(5, 15)
    .call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("approve", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(r.tokenIn, ABI.encodeFunctionData("allowance", [actor, d.pool]), { static: true }).load(5, 0).equal(5, 0);
  const data = ngExecutionData(d, r.direction, r.index, minimum, receiver);
  // Dynamic array payload: head(3 words), length, then coin amounts.
  p.call(d.pool, data, { patches: [{ offset: ngInputOffset(d, r.direction, r.index), reg: 0 }] }).load(4, 0);
  if (r.direction === "mint") p.call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("approve", [d.pool, 0n]))
    .call(r.tokenIn, ABI.encodeFunctionData("allowance", [actor, d.pool]), { static: true }).load(5, 0).equal(5, 15);
  p.call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    // Positive debit, no old inventory, at most the common raw-unit dust.
    // The enclosing production issuer applies the selected strict 0/1 policy.
    .math("sub", 5, 14, 6).constant(11, 1n).math("sub", 5, 5, 11)
    .math("sub", 5, 6, 8).constant(11, toleranceRawUnits).math("sub", 5, 11, 5)
    .call(r.tokenOut, RUNTIME_ERC20.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(6, 0)
    .math("sub", 6, 6, 13).constant(5, minimum).math("sub", 11, 6, 5)
    .constant(5, 1n).math("sub", 11, 4, 5)
    .constant(5, toleranceRawUnits).math("add", 11, 6, 5).math("sub", 11, 11, 4)
    .math("add", 11, 4, 5).math("sub", 11, 11, 6);
  if (external) p.call(r.tokenOut, RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0).equal(6, 9)
    .call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(6, 0).equal(6, 7);
  return p.nativeBalance(6).equal(6, 10);
}

interface Quote { readonly direction: Direction; readonly index: number; readonly amount: bigint; readonly output: bigint }
interface NgProof { readonly phase: "registry" | "structure" | "binding" | "quotes" | "behavior" | "complete" | "unavailable";
  readonly source: CanonicalSource; readonly binding?: Binding; readonly actor?: string; readonly quotes?: readonly Quote[];
  readonly codeProof?: NgCodeProof; readonly behaviorHash?: string; readonly reason?: string; readonly supply?: bigint; readonly rejection?: string; readonly requestIds?: readonly string[]; readonly handlers?: readonly string[] }
const roots = (pool: string): AdapterRequest[] => [code("pool-code", pool),
  call("registry-handlers", META, ABI.encodeFunctionData("get_registry_handlers_from_pool", [pool])),
  call("registry-lp", META, ABI.encodeFunctionData("get_lp_token", [pool])),
  call("registry-pool", META, ABI.encodeFunctionData("get_pool_from_lp_token", [pool])),
  call("registry-coins", META, ABI.encodeFunctionData("get_coins", [pool]))];
function structure(d: Binding, handlers: readonly string[], proof: NgCodeProof): AdapterRequest[] { return [
  call("ng-count", d.pool, NG.encodeFunctionData("N_COINS")), call("ng-factory", META, NG.encodeFunctionData("get_base_registry", [handlers[0]])),
  call("ng-lp-decimals", d.lp, ABI.encodeFunctionData("decimals")), call("ng-supply", d.lp, ABI.encodeFunctionData("totalSupply")),
  ...proof.external.map((a, i) => code(`ng-external-code-${i}`, a)),
  ...d.coins.flatMap((coin, i) => [code(`ng-coin-code-${i}`, coin), call(`ng-coin-${i}`, d.pool, ABI.encodeFunctionData("coins", [i])),
    call(`ng-decimals-${i}`, coin, ABI.encodeFunctionData("decimals"))]),
  { id: "ng-actor", kind: "effect-delta-simulation", call: { caller: { kind: "executor" }, executionMode: "impersonated-call-frame",
    to: executorProbeToken, data: RUNTIME_ERC20.encodeFunctionData("balanceOf", [ethers.ZeroAddress]) },
    overrideIntent: { caller: { kind: "executor" } }, observeTokenBalances: [{ token: executorProbeToken, account: { kind: "executor" } }],
    observe: ["return-data", "revert-data", "token-delta", "native-delta"] },
]; }
function amounts(d: Binding, supply: bigint): Omit<Quote, "output">[] {
  if (!d.ng || !supply) throw new Error("curve-lp NG no liquidity");
  return (["mint", "redeem"] as const).flatMap(direction => d.coins.flatMap((_coin, index) => [1n, 2n].map(n => {
    const desired = n * 10n ** BigInt(direction === "mint" ? d.ng!.decimals[index] : 18);
    const amount = direction === "redeem" && desired >= supply ? supply * n / 3n : desired;
    if (!amount || (direction === "redeem" && amount >= supply)) throw new Error("curve-lp NG insufficient behavior capacity");
    return { direction, index, amount };
  }))); }
const quoteRequests = (p: NgProof) => amounts(p.binding!, p.supply!).map((q, i) => ngQuoteRequest(p.binding!, q.direction, q.index, q.amount, `ng-quote-${i}`));
function behaviorRequests(p: NgProof): AdapterRequest[] { const d = p.binding!, actor = p.actor!, caller = { kind: "executor" as const };
  return p.quotes!.flatMap((q, i) => [false, true].map(direct => {
    const recipient = direct ? NG_RECEIVER : actor, tokenIn = q.direction === "mint" ? d.coins[q.index] : d.lp,
      tokenOut = q.direction === "mint" ? d.lp : d.coins[q.index], data = ngExecutionData(d, q.direction, q.index, 1n, recipient);
    const patched = ethers.getBytes(data), offset = ngInputOffset(d, q.direction, q.index);
    patched.set(ethers.getBytes(ethers.toBeHex(q.amount, 32)), offset);
    return { id: `ng-behavior-${i}-${direct ? "receiver" : "actor"}`, required: false, kind: "effect-delta-simulation" as const,
      preCalls: q.direction === "mint" ? [0n, q.amount].map(n => ({ caller, to: tokenIn, data: ABI.encodeFunctionData("approve", [d.pool, n]) })) : [],
      call: { caller, executionMode: "impersonated-call-frame" as const, to: d.pool, data: ethers.hexlify(patched) },
      overrideIntent: { caller, tokenBalances: [{ token: tokenIn, amount: q.amount }] },
      observeTokenBalances: [{ token: tokenIn, account: actor }, { token: tokenIn, account: d.pool },
        { token: tokenOut, account: recipient }, { token: tokenOut, account: d.pool },
        ...(direct ? [{ token: tokenOut, account: actor }, { token: tokenIn, account: recipient }] : [])],
      observeTotalSupplies: [d.lp], observe: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] as const };
  })); }
function proves(p: NgProof, q: Quote, i: number, direct: boolean, results: readonly AdapterRequestResult[], toleranceRawUnits: bigint): boolean {
  const d = p.binding!, actor = p.actor!, recipient = direct ? NG_RECEIVER : actor,
    r = read(results, `ng-behavior-${i}-${direct ? "receiver" : "actor"}`, p.source);
  if (r.completion !== "returned") return false;
  const output = scalar(NG, q.direction === "mint" ? "add_liquidity" : "remove_liquidity_one_coin", r.data);
  const tokenIn = q.direction === "mint" ? d.coins[q.index] : d.lp, tokenOut = q.direction === "mint" ? d.lp : d.coins[q.index];
  const expected = [[tokenIn, actor, -q.amount], [tokenIn, d.pool, q.direction === "mint" ? q.amount : 0n],
    [tokenOut, recipient, q.output], [tokenOut, d.pool, q.direction === "redeem" ? -q.output : 0n],
    ...(direct ? [[tokenOut, actor, 0n], [tokenIn, recipient, 0n]] : [])] as const;
  const deltas = r.effects?.tokenDeltas;
  if (!deltas || !output || !executionOutputMatches(output, q.output, toleranceRawUnits) || deltas.length !== expected.length) return false;
  const delta = (token: string, account: string): bigint | undefined => { const rows = deltas.filter(v => v.token.toLowerCase() === token && v.account.toLowerCase() === account); return rows.length === 1 ? rows[0].delta : undefined; };
  const spent = delta(tokenIn, actor), poolIn = delta(tokenIn, d.pool), received = delta(tokenOut, recipient), poolOut = delta(tokenOut, d.pool);
  if (spent === undefined || poolIn === undefined || received === undefined || poolOut === undefined ||
      !executionInputMatches(-spent, q.amount, q.direction === "mint" ? toleranceRawUnits : 0n) ||
      !executionOutputMatches(received, output, toleranceRawUnits) ||
      (q.direction === "mint" ? !executionInputMatches(poolIn, q.amount, toleranceRawUnits) || poolOut !== 0n : poolIn !== 0n || !executionOutputMatches(-poolOut, output, toleranceRawUnits)) ||
      (direct && (delta(tokenOut, actor) !== 0n || delta(tokenIn, recipient) !== 0n))) return false;
  const supply = r.effects?.totalSupplyDeltas;
  return supply?.length === 1 && supply[0].token.toLowerCase() === d.lp && supply[0].delta === (q.direction === "mint" ? output : -q.amount) &&
    (r.effects?.nativeDeltas?.length ?? 0) > 0 && r.effects!.nativeDeltas!.every(v => v.delta === 0n);
}
export const ngIdentityVariant: IdentitySemantics<Candidate, Identity>["variants"][number] = {
  id: "registry-ng-self-lp-and-mint-burn-effects", kind: "registry-member", lineageId: NG_LINEAGE, applies: c => c.candidateKind === "curve-lp",
  requirements: ({ evidence }) => {
    const phase = (evidence as NgProof | undefined)?.phase;
    if (phase === "registry") return { transports: ["get-code", "eth-call", "effect-delta-simulation"], caller: "executor",
      effects: ["return-data", "revert-data", "token-delta", "native-delta"] };
    if (phase === "quotes") return { transports: ["effect-delta-simulation"], caller: "executor",
      effects: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] };
    return { transports: ["get-code", "eth-call"] };
  },
  buildRequests({ candidate, evidence }) { const p = evidence as NgProof | undefined;
    if (!p) return roots(candidate.pool).map(optionalCall);
    if (p.phase === "registry") return structure(p.binding!, p.handlers!, p.codeProof!).map(optionalCall);
    if (p.phase === "structure") return [code("ng-factory-code", p.binding!.ng!.factory),
      optionalCall(call("ng-views", p.binding!.ng!.factory, NG.encodeFunctionData("views_implementation")))];
    if (p.phase === "binding") return [code("ng-views-code", p.binding!.ng!.views), ...quoteRequests(p)];
    if (p.phase === "quotes") return behaviorRequests(p); return [];
  },
  decode({ step, results }): NgProof { const p = step.evidence as NgProof | undefined, source = p?.source ?? results[0]?.source;
    if (!source) throw new Error("curve-lp NG missing source");
    try {
      if (!p) {
        const pool = address(step.candidate.pool), get = (id: string) => returned(results, id, source).data, poolCode = get("pool-code");
        if (poolCode === "0x") return { phase: "unavailable", source, reason: "curve-lp no runtime code", rejection: "curve-lp-no-code", requestIds: ["pool-code"] };
        const codeProof = proveNgCode(poolCode);
        const lp = value(ABI, "get_lp_token", get("registry-lp")), inverse = value(ABI, "get_pool_from_lp_token", get("registry-pool")),
          handlers = nonzero([...decode("get_registry_handlers_from_pool", get("registry-handlers"))[0]]),
          coins = registryCoins([...decode("get_coins", get("registry-coins"))[0]]);
        if (lp !== pool && lp !== ethers.ZeroAddress) throw new Error("curve-lp registered separate-LP surface is not NG");
        if (inverse !== pool && inverse !== ethers.ZeroAddress && lp === pool) return { phase: "unavailable", source, reason: "curve-lp reciprocal registry contradiction",
          rejection: "curve-lp-registry-reverse-mismatch", requestIds: ["registry-lp", "registry-pool"] };
        if (!handlers.length || lp !== pool || inverse !== pool || coins.length < 2 || coins.length > 8 ||
            codeProof.coins.length !== coins.length || codeProof.coins.some((coin, i) => coin !== coins[i]) || new Set([pool, META, ...coins]).size !== coins.length + 2 || coins.some(v => v === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"))
          throw new Error("curve-lp not a registry-bound NG ERC20 self-LP surface");
        return { phase: "registry", source, codeProof, handlers, binding: { pool, lp, coins, poolCodeHash: ethers.keccak256(poolCode), lpCodeHash: ethers.keccak256(poolCode), coinCodeHashes: [] } };
      }
      const d = p.binding!, get = (id: string) => returned(results, id, source).data;
      if (p.phase === "registry") {
        if (scalar(NG, "N_COINS", get("ng-count")) !== BigInt(d.coins.length) || scalar(ABI, "decimals", get("ng-lp-decimals")) !== 18n)
          throw new Error("curve-lp incompatible NG supply/coin domain");
        const decimals = d.coins.map((_coin, i) => Number(scalar(ABI, "decimals", get(`ng-decimals-${i}`))));
        if (decimals.some(n => !Number.isSafeInteger(n) || n < 0 || n > 18) || d.coins.some((coin, i) => value(ABI, "coins", get(`ng-coin-${i}`)) !== coin || get(`ng-coin-code-${i}`) === "0x"))
          throw new Error("curve-lp incompatible NG coins");
        const probe = returned(results, "ng-actor", source), effect = probe.effects?.tokenDeltas;
        if (effect?.length !== 1 || effect[0].token.toLowerCase() !== executorProbeToken || effect[0].delta !== 0n ||
            !probe.effects?.nativeDeltas?.length || probe.effects.nativeDeltas.some(v => v.delta !== 0n)) throw new Error("curve-lp NG executor authority");
        if (value(NG, "get_base_registry", get("ng-factory")) !== p.codeProof!.factory) throw new Error("curve-lp NG immutable/registry factory mismatch");
        const actor = address(effect[0].account); if ([d.pool, NG_RECEIVER, ...d.coins].includes(actor)) throw new Error("curve-lp NG aliased executor");
        return { ...p, phase: "structure", actor, binding: { ...d, coinCodeHashes: d.coins.map((_c, i) => ethers.keccak256(get(`ng-coin-code-${i}`))),
          ng: { model: p.codeProof!.model, array: p.codeProof!.array,
            external: p.codeProof!.external.map((a, i) => { const code = get(`ng-external-code-${i}`); if (code === "0x") throw new Error("curve-lp NG no external dependency code"); return { address: a, codeHash: ethers.keccak256(code) }; }), decimals, registryHandler: p.handlers![0], factory: value(NG, "get_base_registry", get("ng-factory")), factoryCodeHash: "", views: "", viewsCodeHash: "", directions: [] } }, supply: scalar(ABI, "totalSupply", get("ng-supply")) };
      }
      if (p.phase === "structure") {
        if (get("ng-factory-code") === "0x") throw new Error("curve-lp NG no factory code");
        return { ...p, phase: "binding", binding: { ...d, ng: { ...d.ng!, factoryCodeHash: ethers.keccak256(get("ng-factory-code")),
          views: value(NG, "views_implementation", get("ng-views")) } } };
      }
      if (p.phase === "binding") {
        if (get("ng-views-code") === "0x") throw new Error("curve-lp NG no views code");
        const quotes = amounts(d, p.supply!).flatMap((q, i) => {
          const r = read(results, `ng-quote-${i}`, source); if (r.completion !== "returned") return [];
          const output = scalar(NG, q.direction === "mint" ? "calc_token_amount" : "calc_withdraw_one_coin", r.data);
          return output > 0n ? [{ ...q, output }] : [];
        });
        if (!quotes.length) throw new Error("curve-lp NG no positive amount quote");
        return { ...p, phase: "quotes", quotes, binding: { ...d, ng: { ...d.ng!, viewsCodeHash: proveNgViews(get("ng-views-code")) } } };
      }
      if (p.phase !== "quotes") throw new Error("curve-lp NG identity phase");
      const directions = (["mint", "redeem"] as const).flatMap(direction => d.coins.flatMap((_c, index) => {
        const group = p.quotes!.map((q, i) => ({ q, i })).filter(v => v.q.direction === direction && v.q.index === index);
        return group.length === 2 && group.every(({ q, i }) => proves(p, q, i, false, results, step.executionRoundingRawUnits ?? 0n))
          ? [{ direction, index, directOutput: group.every(({ q, i }) => proves(p, q, i, true, results, step.executionRoundingRawUnits ?? 0n)) }] : [];
      }));
      if (!directions.length) throw new Error("curve-lp NG no behavior-proven direction");
      return { ...p, phase: "complete", binding: { ...d, ng: { ...d.ng!, directions } },
        behaviorHash: hashCanonical(JSON.parse(JSON.stringify(results, (_k, v) => typeof v === "bigint" ? v.toString() : v))) };
    } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e; return { phase: "unavailable", source, reason: e instanceof Error ? e.message : "curve-lp NG unavailable" }; }
  },
  decide({ evidence }) { const p = evidence as NgProof | undefined;
    if (p?.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.requestIds! };
    if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
    if (p?.phase !== "complete" || !p.binding?.ng || !p.behaviorHash) return { status: "continue" };
    return { status: "verified", identity: { familyId: FAMILY, lineageId: NG_LINEAGE, subject: p.binding.pool, binding: p.binding,
      provenance: [{ kind: "curve-ng-registry-self-lp-and-actual-mint-burn", subject: p.binding.pool,
        evidenceHash: hashCanonical(JSON.parse(JSON.stringify({ binding: p.binding, source: p.source, behaviorHash: p.behaviorHash }))) }] } };
  },
};
