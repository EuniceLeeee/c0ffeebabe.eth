import { cryptoClaimProfile, cryptoClaimGuardRequests, bindCryptoClaimDependencies, cryptoFeeWitness, hasCryptoClaim, cryptoClaimProgram, cryptoClaimQuoteRequest, decodeCryptoClaim, cryptoClaimRequirements, type CryptoClaimBinding, type CryptoFeeWitness } from "./generic-effects.js";
// Same-Family fixed-array Curve LP mint/burn extension. Registry membership
// grants identity; method shape and actual mint/burn deltas grant directions.
import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { ABI, META, address, assertSource, call, code, decode, uint } from "./codec.js";
import { FAMILY, GENERIC_LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Descriptor, Direction, Identity, Route, State } from "./types.js";

export const STABLE_CALC = "0xca8d0747b5573d69653c3ac22242e6341c36e4b4";
export const CURVE_V1_FACTORY = "0xfd6f33a0509ec67defc500755322abd9df1bd5b8";
export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const STABLE_CALC_CODE_HASH = "0x411b5d6a8f024f0d0aac6f5f06d60e38aaaabcdf163ea746d4403d9be6109270";
export const V1_FACTORY_CODE_HASH = "0x5461dc0d8c266670a5479a18d78991b1fa0f4b0fe3c4d6f9492b09698b440276";
// Reviewed shared implementation classes: both read the current base pool
// virtual price in their mint operation. These identify amount semantics,
// never pool membership; membership still comes from the reverse registry.
const FRESH_BASE_IMPLEMENTATION_CLASSES = new Set([
  "0x2c67f0058c5bebafdab722f691a698a56d1480b5dbaf9bca64bb036e9f24cf4a",
  "0x5c32133d4d3693b45c431b11cf9f07d5c97d921a4e5901f40dd0a5f9ce622d98",
]);
export const GENERIC_RECEIVER = "0x0000000000000000000000000000000000000001";
export const GENERIC = new ethers.Interface([
  "function gamma() view returns(uint256)", "function A() view returns(uint256)",
  "function is_meta(address) view returns(bool)", "function get_base_pool(address) view returns(address)",
  "function get_coins(address) view returns(address[2])", "function get_underlying_coins(address) view returns(address[8])",
  "function is_killed() view returns(bool)",
  "function base_virtual_price() view returns(uint256)", "function get_virtual_price() view returns(uint256)",
  "function calc_token_amount(address,address,uint256[10],uint256,bool,bool) view returns(uint256)",
  "function calc_token_amount_meta(address,address,uint256[10],uint256,address,address,bool,bool) view returns(uint256)",
  "function execSubscript(bytes)",
]);
type IndexAbi = "uint256" | "int128";
export type ReceiverMode = "none" | "receiver" | "bool-receiver";
export type GenericBinding = {
  readonly operationEffects?: CryptoClaimBinding;
  readonly kind: "stable" | "crypto";
  readonly identitySource: "meta-registry" | "v1-factory";
  readonly registryHandler: string;
  readonly registryCodeHash: string;
  readonly sourceCodeHash: string;
  readonly decimals: readonly number[];
  readonly coinIndex: IndexAbi;
  readonly basePool: string;
  readonly baseLp: string;
  readonly baseCodeHash: string;
  readonly calcCodeHash: string;
  readonly mintQuote: "stable-calc" | "crypto-onearg" | "crypto-bool";
  readonly implementation: string;
  readonly implementationCodeHash: string;
  readonly forwarderBytes: 0 | 4096;
  readonly directions: readonly { readonly direction: Direction; readonly index: number; readonly receiverMode: ReceiverMode }[];
}
const opt = (r: AdapterRequest): AdapterRequest => r.kind === "eth-call"
  ? { ...r, required: false, completion: "return-or-revert-data" } : r;
const fn = (signature: string) => new ethers.Interface(["function " + signature]);
const scalarAbi = ethers.AbiCoder.defaultAbiCoder();
const word = (data: string) => {
  if (!ethers.isHexString(data, 32)) throw new Error("curve-lp generic noncanonical uint result");
  return uint(scalarAbi.decode(["uint256"], data)[0]);
};
const addr = (data: string) => {
  const v = scalarAbi.decode(["address"], data)[0];
  if (scalarAbi.encode(["address"], [v]).toLowerCase() !== data.toLowerCase()) throw new Error("curve-lp generic noncanonical address");
  return ethers.getAddress(v).toLowerCase();
};
const result = (results: readonly AdapterRequestResult[], id: string, source?: CanonicalSource) => {
  const rows = results.filter(r => r.id === id); if (rows.length !== 1) throw new Error("curve-lp generic missing/duplicate " + id);
  const r = rows[0]; if (!r.ok) throw new RequiredAdapterRequestError(r);
  if (source) assertSource(r.source, source); return r;
};
const data = (results: readonly AdapterRequestResult[], id: string, source?: CanonicalSource) => {
  const r = result(results, id, source); if (r.completion !== "returned") throw new Error("curve-lp generic interface unavailable " + id); return r.data;
};
export function genericScalarData(d: Binding, raw: string): string {
  // This exact historical forwarder copies a fixed 4096-byte return buffer.
  // Only pool-owned scalar responses may be normalized; registry/code bytes
  // retain their independent canonical shape checks.
  return d.generic?.forwarderBytes === 4096 && ethers.isHexString(raw, 4096) ? ethers.dataSlice(raw, 0, 32) : raw;
}
const optionalWord = (results: readonly AdapterRequestResult[], id: string, source: CanonicalSource, d?: Binding) => {
  const r = result(results, id, source), raw = d ? genericScalarData(d, r.data) : r.data;
  return r.completion === "returned" && ethers.isHexString(raw, 32) ? word(raw) : undefined;
};
function coins(raw: readonly string[]) {
  const values: string[] = []; let padding = false;
  for (const item of raw) { const v = ethers.getAddress(item).toLowerCase();
    if (v === ethers.ZeroAddress) { padding = true; continue; }
    if (padding || values.includes(v)) throw new Error("curve-lp generic malformed coins"); values.push(v);
  } return values;
}
function indexed(name: "coins" | "balances", index: IndexAbi) {
  return fn(`${name}(${index}) view returns(${name === "coins" ? "address" : "uint256"})`);
}
export function genericBinding(d: Binding): boolean { return d.generic !== undefined; }
export function genericDecimals(d: Binding, i: number): number { if (!d.generic) throw new Error("curve-lp not generic"); return d.generic.decimals[i]; }
export function genericGraphCoin(coin: string): string { return coin === NATIVE ? WETH : coin; }
export function genericAssets(d: Binding, direction: Direction, index: number) {
  const native = d.coins[index] === NATIVE;
  return { input: direction === "mint" && native ? "native" as const : "erc20" as const,
    output: direction === "redeem" && native ? "native" as const : "erc20" as const };
}
export function genericOperationAbi(d: Binding, direction: Direction, receiverMode: ReceiverMode) {
  if (!d.generic || d.coins.length < 2 || d.coins.length > 4) throw new Error("curve-lp generic operation domain");
  const receiver = receiverMode === "none" ? "" : receiverMode === "receiver" ? ",address" : ",bool,address";
  return direction === "mint" ? fn(`add_liquidity(uint256[${d.coins.length}],uint256${receiver})`)
    : fn(`remove_liquidity_one_coin(uint256,${d.generic.kind === "crypto" ? "uint256" : "int128"},uint256${receiver})`);
}
export function genericExecutionData(d: Binding, direction: Direction, index: number, amount: bigint, minimum: bigint, recipient: string, mode: ReceiverMode): string {
  if (!d.generic || !Number.isInteger(index) || index < 0 || index >= d.coins.length || !uint(minimum)) throw new Error("curve-lp generic operation");
  const abi = genericOperationAbi(d, direction, mode), name = direction === "mint" ? "add_liquidity" : "remove_liquidity_one_coin";
  const args: unknown[] = direction === "mint" ? [d.coins.map((_v, i) => i === index ? amount : 0n), minimum] : [amount, index, minimum];
  if (mode === "bool-receiver") args.push(false);
  if (mode !== "none") args.push(recipient);
  return abi.encodeFunctionData(name, args);
}
export function genericQuoteRequest(d: Binding, direction: Direction, index: number, amount: bigint, id: string, cryptoStyle = d.generic?.mintQuote): AdapterRequest {
  const g = d.generic; if (!g || !Number.isInteger(index) || index < 0 || index >= d.coins.length || !uint(amount)) throw new Error("curve-lp generic quote domain");
  if (direction === "redeem" && hasCryptoClaim(d)) throw new Error("curve-lp withdrawal requires operation effects quote");
  if (direction === "redeem") {
    const abi = fn(`calc_withdraw_one_coin(uint256,${g.kind === "crypto" ? "uint256" : "int128"}) view returns(uint256)`);
    return opt(call(id, d.pool, abi.encodeFunctionData("calc_withdraw_one_coin", [amount, index])));
  }
  if (g.kind === "crypto") {
    const bool = cryptoStyle === "crypto-bool", abi = fn(`calc_token_amount(uint256[${d.coins.length}]${bool ? ",bool" : ""}) view returns(uint256)`);
    const args: unknown[] = [d.coins.map((_v, i) => i === index ? amount : 0n)]; if (bool) args.push(true);
    return opt(call(id, d.pool, abi.encodeFunctionData("calc_token_amount", args)));
  }
  const amounts = Array.from({ length: 10 }, (_v, i) => i === index ? amount : 0n);
  // These are the pool's own coins. A meta pool's second coin is its base LP;
  // underlying=true belongs to a separately proved deposit-zap operation.
  return opt(call(id, STABLE_CALC, GENERIC.encodeFunctionData(g.basePool === ethers.ZeroAddress ? "calc_token_amount" : "calc_token_amount_meta",
    g.basePool === ethers.ZeroAddress ? [d.pool, d.lp, amounts, d.coins.length, true, false]
      : [d.pool, d.lp, amounts, d.coins.length, g.basePool, g.baseLp, true, false])));
}
export function genericQuoteResult(d: Binding, r: AdapterRequestResult): bigint {
  if (!r.ok) throw new RequiredAdapterRequestError(r);
  if (r.completion !== "returned") throw new Error("curve-lp generic amount quote reverted");
  const out = word(genericScalarData(d, r.data)); if (!out) throw new Error("curve-lp generic no positive output"); return out;
}
const identityReads = (d: Binding): AdapterRequest[] => {
  const g = d.generic!;
  const requests: AdapterRequest[] = [code("g-pool-code", d.pool), code("g-lp-code", d.lp), code("g-registry-code", META)];
  if (g.implementation !== ethers.ZeroAddress) requests.push(code("g-implementation-code", g.implementation));
  if (g.identitySource === "v1-factory") requests.push(code("g-source-code", CURVE_V1_FACTORY),
    call("g-source-coins", CURVE_V1_FACTORY, GENERIC.encodeFunctionData("get_coins", [d.pool])));
  else requests.push(call("g-handlers", META, ABI.encodeFunctionData("get_registry_handlers_from_pool", [d.pool])),
    call("g-registry-lp", META, ABI.encodeFunctionData("get_lp_token", [d.pool])),
    call("g-registry-pool", META, ABI.encodeFunctionData("get_pool_from_lp_token", [d.lp])),
    call("g-registry-coins", META, ABI.encodeFunctionData("get_coins", [d.pool])),
    call("g-registry-base", META, GENERIC.encodeFunctionData("get_base_pool", [d.pool])));
  if (g.kind === "stable") requests.push(code("g-calc-code", STABLE_CALC));
  if (g.basePool !== ethers.ZeroAddress) requests.push(code("g-base-code", g.basePool),
    call("g-base-reverse", META, ABI.encodeFunctionData("get_pool_from_lp_token", [g.baseLp])),
    ...(g.kind === "stable" ? [opt(call("g-cached-base-price", d.pool, GENERIC.encodeFunctionData("base_virtual_price"))),
      call("g-fresh-base-price", g.basePool, GENERIC.encodeFunctionData("get_virtual_price"))] : []));
  const c = indexed("coins", g.coinIndex);
  for (const [i, coin] of d.coins.entries()) {
    requests.push(call(`g-coin-${i}`, d.pool, c.encodeFunctionData("coins", [i])));
    if (coin !== NATIVE) requests.push(code(`g-coin-code-${i}`, coin), call(`g-decimal-${i}`, coin, ABI.encodeFunctionData("decimals")));
  } if (hasCryptoClaim(d)) requests.push(...cryptoClaimGuardRequests(d)); return requests;
};
export function genericStateRequests(d: Binding): AdapterRequest[] {
  if (!d.generic) throw new Error("curve-lp not generic"); const b = indexed("balances", d.generic.coinIndex);
  return [...identityReads(d), call("g-supply", d.lp, ABI.encodeFunctionData("totalSupply")),
    call("g-fee", d.pool, ABI.encodeFunctionData("fee")),
    opt(call("g-killed", d.pool, GENERIC.encodeFunctionData("is_killed"))),
    opt(call("g-amp", d.pool, ABI.encodeFunctionData("A_precise"))), opt(call("g-future", d.pool, ABI.encodeFunctionData("future_A"))),
    ...d.coins.map((_v, i) => call(`g-balance-${i}`, d.pool, b.encodeFunctionData("balances", [i])))];
}
export function decodeGenericState(d: Binding, results: readonly AdapterRequestResult[], source?: CanonicalSource): State {
  const g = d.generic, origin = source ?? results[0]?.source; if (!g || !origin) throw new Error("curve-lp generic source");
  const get = (id: string) => data(results, id, origin);
  if (ethers.keccak256(get("g-pool-code")) !== d.poolCodeHash || ethers.keccak256(get("g-lp-code")) !== d.lpCodeHash ||
      ethers.keccak256(get("g-registry-code")) !== g.registryCodeHash) throw new Error("curve-lp generic code binding changed");
  if (g.implementation !== ethers.ZeroAddress && ethers.keccak256(get("g-implementation-code")) !== g.implementationCodeHash) throw new Error("curve-lp generic implementation changed");
  if (g.identitySource === "v1-factory") {
    const actual = coins([...GENERIC.decodeFunctionResult("get_coins", get("g-source-coins"))[0]]);
    if (ethers.keccak256(get("g-source-code")) !== g.sourceCodeHash || actual.length !== d.coins.length || actual.some((v, i) => v !== d.coins[i]) || d.lp !== d.pool)
      throw new Error("curve-lp generic V1 membership changed");
  } else {
    const handlers = [...decode("get_registry_handlers_from_pool", get("g-handlers"))[0]].map((v: string) => v.toLowerCase()),
      actual = coins([...decode("get_coins", get("g-registry-coins"))[0]]);
    if (!handlers.includes(g.registryHandler) || addr(get("g-registry-lp")) !== d.lp || addr(get("g-registry-pool")) !== d.pool ||
        actual.length !== d.coins.length || actual.some((v, i) => v !== d.coins[i]) || addr(get("g-registry-base")) !== g.basePool)
      throw new Error("curve-lp generic registry binding changed");
  }
  if (g.kind === "stable" && ethers.keccak256(get("g-calc-code")) !== g.calcCodeHash) throw new Error("curve-lp generic calculator changed");
  if (g.basePool !== ethers.ZeroAddress && (ethers.keccak256(get("g-base-code")) !== g.baseCodeHash || addr(get("g-base-reverse")) !== g.basePool))
    throw new Error("curve-lp generic base binding changed");
  for (const [i, coin] of d.coins.entries()) if (addr(genericScalarData(d, get(`g-coin-${i}`))) !== coin || (coin !== NATIVE &&
      (ethers.keccak256(get(`g-coin-code-${i}`)) !== d.coinCodeHashes[i] || word(get(`g-decimal-${i}`)) !== BigInt(g.decimals[i])))) throw new Error("curve-lp generic coin binding changed");
  if (g.kind === "stable" && g.basePool !== ethers.ZeroAddress) {
    const cached = optionalWord(results, "g-cached-base-price", origin, d);
    // Conservative until the source-bound TTL/cache branch is modeled. A
    // stale cached value is never silently replaced by a fresh helper rate.
    if (cached === undefined && !FRESH_BASE_IMPLEMENTATION_CLASSES.has(g.implementationCodeHash)) throw new Error("curve-lp generic unproved base rate model");
    if (cached !== undefined && cached !== word(get("g-fresh-base-price"))) throw new Error("curve-lp generic cached/fresh base quote mismatch");
  }
  if (hasCryptoClaim(d)) cryptoFeeWitness(d, results, origin);
  const amp = optionalWord(results, "g-amp", origin, d), future = optionalWord(results, "g-future", origin, d), killed = optionalWord(results, "g-killed", origin, d);
  if (g.kind === "stable" && amp !== undefined && future !== undefined && amp !== future) throw new Error("curve-lp generic active ramp not proven");
  if (killed !== undefined && killed > 1n) throw new Error("curve-lp generic malformed kill flag");
  const fee = word(genericScalarData(d, get("g-fee"))); if (fee > 10n ** 10n) throw new Error("curve-lp generic fee bounds");
  return { source: origin, balances: d.coins.map((_v, i) => word(genericScalarData(d, get(`g-balance-${i}`)))),
    totalSupply: word(d.lp === d.pool ? genericScalarData(d, get("g-supply")) : get("g-supply")), amp: amp ?? 0n, fee, killed: killed === 1n };
}

/** Only the raw protocol operation. The route's executionAssets declaration
 * delegates ETH/WETH conversion to the common execution boundary. */
export function genericProgram(d: Binding, r: Route, executor: string, minimum = 1n, recipient = executor): RuntimeAmountProgram {
  return hasCryptoClaim(d) && r.direction === "redeem" ? cryptoClaimProgram(d, r, executor, minimum, recipient) : genericRawProgram(d, r, executor, minimum, recipient);
}
export function genericRawProgram(d: Binding, r: Pick<Route, "direction" | "index" | "tokenIn" | "tokenOut">, executor: string, minimum = 1n, recipient = executor): RuntimeAmountProgram {
  const g = d.generic; if (!g || !uint(minimum)) throw new Error("curve-lp generic program");
  const cap = g.directions.find(v => v.direction === r.direction && v.index === r.index); if (!cap) throw new Error("curve-lp generic unproved direction");
  const actor = runtimeExecutor(executor, d.pool, d.lp, ...d.coins).toLowerCase(), receiver = runtimeExecutor(recipient, d.pool, d.lp, ...d.coins).toLowerCase();
  const assets = genericAssets(d, r.direction, r.index), external = actor !== receiver;
  if (external && (cap.receiverMode === "none" || assets.input === "native" || assets.output === "native")) throw new Error("curve-lp generic unproved recipient");
  const tokenIn = r.direction === "mint" ? d.coins[r.index] : d.lp, tokenOut = r.direction === "mint" ? d.lp : d.coins[r.index];
  const p = new RuntimeAmountProgram().constant(15, 0n).constant(12, 1n).math("sub", 11, 0, 12).nativeBalance(10);
  const balance = (token: string, account: string, reg: number) => token === NATIVE ? p.nativeBalance(reg)
    : p.call(token, RUNTIME_ERC20.encodeFunctionData("balanceOf", [account]), { static: true }).load(reg, 0);
  balance(tokenIn, actor, 14); p.math("sub", 8, 14, 0); balance(tokenOut, receiver, 13);
  if (external) { balance(tokenOut, actor, 9); balance(tokenIn, receiver, 7); }
  if (tokenIn !== NATIVE) {
    p.call(tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n]))
      .call(tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
      .call(tokenIn, ABI.encodeFunctionData("allowance", [actor, d.pool]), { static: true }).load(5, 0).equal(5, 0);
  }
  const calldata = genericExecutionData(d, r.direction, r.index, 0n, minimum, receiver, external ? cap.receiverMode : "none");
  p.call(d.pool, calldata, { patches: [{ offset: r.direction === "mint" ? 4 + 32 * r.index : 4, reg: 0 }],
    ...(assets.input === "native" ? { valueReg: 0 } : {}) });
  if (tokenIn !== NATIVE) p.call(tokenIn, ABI.encodeFunctionData("approve", [d.pool, 0n]))
    .call(tokenIn, ABI.encodeFunctionData("allowance", [actor, d.pool]), { static: true }).load(5, 0).equal(5, 15);
  balance(tokenIn, actor, 6); p.equal(6, 8); balance(tokenOut, receiver, 6);
  p.math("sub", 6, 6, 13).constant(5, minimum).math("sub", 11, 6, 5);
  if (external) { balance(tokenOut, actor, 6); p.equal(6, 9); balance(tokenIn, receiver, 6); p.equal(6, 7); }
  if (assets.input !== "native" && assets.output !== "native") p.nativeBalance(6).equal(6, 10);
  return p;
}

interface Quote { readonly direction: Direction; readonly index: number; readonly amount: bigint; readonly output: bigint }
interface GenericProof {
  readonly phase: "v1" | "structure" | "quotes" | "behavior" | "complete" | "unavailable";
  readonly source: CanonicalSource;
  readonly binding?: Binding;
  readonly actor?: string;
  readonly supply?: bigint;
  readonly quotes?: readonly Quote[];
  readonly feeWitness?: CryptoFeeWitness;
  readonly behaviorHash?: string;
  readonly reason?: string;
  readonly rejection?: string;
  readonly requestIds?: readonly string[];
}
const roots = (pool: string): AdapterRequest[] => [code("g-pool-code", pool), code("g-registry-code", META),
  call("g-handlers", META, ABI.encodeFunctionData("get_registry_handlers_from_pool", [pool])),
  call("g-registry-lp", META, ABI.encodeFunctionData("get_lp_token", [pool])),
  call("g-registry-coins", META, ABI.encodeFunctionData("get_coins", [pool])),
  call("g-registry-base", META, GENERIC.encodeFunctionData("get_base_pool", [pool])),
  call("g-gamma", pool, GENERIC.encodeFunctionData("gamma")),
];
function structuralRequests(p: GenericProof): AdapterRequest[] {
  const d = p.binding!, g = d.generic!, requests: AdapterRequest[] = [code("g-lp-code", d.lp),
    call("g-lp-decimals", d.lp, ABI.encodeFunctionData("decimals")), call("g-supply", d.lp, ABI.encodeFunctionData("totalSupply")),
    call("g-registry-pool", META, ABI.encodeFunctionData("get_pool_from_lp_token", [d.lp])),
    { id: "g-actor", kind: "effect-delta-simulation", call: { caller: { kind: "executor" }, executionMode: "impersonated-call-frame",
      to: WETH, data: RUNTIME_ERC20.encodeFunctionData("balanceOf", [ethers.ZeroAddress]) },
      overrideIntent: { caller: { kind: "executor" } }, observeTokenBalances: [{ token: WETH, account: { kind: "executor" } }],
      observe: ["return-data", "revert-data", "token-delta", "native-delta"] },
  ];
  if (g.kind === "stable") requests.push(code("g-calc-code", STABLE_CALC));
  if (g.implementation !== ethers.ZeroAddress) requests.push(code("g-implementation-code", g.implementation));
  if (g.basePool !== ethers.ZeroAddress || g.identitySource === "v1-factory") requests.push(
    call("g-base-reverse", META, ABI.encodeFunctionData("get_pool_from_lp_token", [g.baseLp])));
  for (const [i, coin] of d.coins.entries()) {
    for (const t of ["uint256", "int128"] as const) { const a = indexed("coins", t);
      requests.push(call(`g-coin-${t}-${i}`, d.pool, a.encodeFunctionData("coins", [i]))); }
    if (coin !== NATIVE) requests.push(code(`g-coin-code-${i}`, coin), call(`g-decimal-${i}`, coin, ABI.encodeFunctionData("decimals")));
  } if (hasCryptoClaim(d)) requests.push(...cryptoClaimGuardRequests(d)); return requests.map(opt);
}
function samples(d: Binding, supply: bigint): Omit<Quote, "output">[] {
  const g = d.generic; if (!g || !supply) throw new Error("curve-lp generic no liquidity");
  return (["mint", "redeem"] as const).flatMap(direction => d.coins.flatMap((_coin, index) => [1n, 2n].map(n => {
    const desired = n * 10n ** BigInt(direction === "mint" ? g.decimals[index] : 18);
    const amount = direction === "redeem" && desired >= supply ? supply * n / 3n : desired;
    if (!amount || (direction === "redeem" && amount >= supply)) throw new Error("curve-lp generic insufficient probe capacity");
    return { direction, index, amount };
  })));
}
function quoteRequests(p: GenericProof): AdapterRequest[] {
  const d = p.binding!;
  return [...(d.generic!.basePool === ethers.ZeroAddress ? [] : [code("g-base-code", d.generic!.basePool)]),
    ...samples(d, p.supply!).flatMap((q, i) => hasCryptoClaim(d) && q.direction === "redeem"
      ? [cryptoClaimQuoteRequest(d, { ...q, tokenIn: d.lp, tokenOut: d.coins[q.index] }, q.amount, p.actor!, p.feeWitness!, `g-quote-${i}`)]
      : q.direction === "mint" && d.generic!.kind === "crypto"
      ? (["crypto-onearg", "crypto-bool"] as const).map(style => genericQuoteRequest(d, q.direction, q.index, q.amount, `g-quote-${i}-${style}`, style))
      : [genericQuoteRequest(d, q.direction, q.index, q.amount, `g-quote-${i}`)])];
}
const modes = (d: Binding, q: Quote): readonly ReceiverMode[] => d.coins[q.index] === NATIVE ? ["none"]
  : hasCryptoClaim(d) && q.direction === "redeem" ? ["none", "receiver"] : d.generic!.kind === "crypto" ? ["none", "receiver", "bool-receiver"] : ["none", "receiver"];
function provisional(d: Binding, q: Quote, mode: ReceiverMode): Binding {
  return { ...d, generic: { ...d.generic!, directions: [{ direction: q.direction, index: q.index, receiverMode: mode }] } };
}
function behaviorRequests(p: GenericProof): AdapterRequest[] {
  const d = p.binding!, actor = p.actor!, caller = { kind: "executor" as const };
  return p.quotes!.flatMap((q, i) => modes(d, q).map(mode => {
    const recipient = mode === "none" ? actor : GENERIC_RECEIVER, tokenIn = q.direction === "mint" ? d.coins[q.index] : d.lp,
      tokenOut = q.direction === "mint" ? d.lp : d.coins[q.index];
    const route = { direction: q.direction, index: q.index, tokenIn: genericGraphCoin(tokenIn), tokenOut: genericGraphCoin(tokenOut) } as Route;
    if (hasCryptoClaim(d) && q.direction === "redeem") return cryptoClaimQuoteRequest(d, route, q.amount, actor, p.feeWitness!, `g-behavior-${i}-${mode}`, mode, recipient);
    const program = genericProgram(provisional(d, q, mode), route, actor, 1n, recipient), scope: { token: string; account: string }[] = [];
    const observe = (token: string, account: string) => { if (token !== NATIVE && !scope.some(v => v.token === token && v.account === account)) scope.push({ token, account }); };
    observe(tokenIn, actor); observe(tokenIn, d.pool); observe(tokenOut, recipient); observe(tokenOut, d.pool);
    if (recipient !== actor) { observe(tokenOut, actor); observe(tokenIn, recipient); }
    return { id: `g-behavior-${i}-${mode}`, required: false, kind: "effect-delta-simulation" as const,
      call: { caller, executionMode: "executor-program" as const, to: actor,
        data: GENERIC.encodeFunctionData("execSubscript", [ethers.hexlify(runtimeProgramScript(program.bytes(), q.amount))]) },
      overrideIntent: { caller, ...(tokenIn === NATIVE ? { nativeBalanceWei: q.amount + 10n ** 18n }
        : { tokenBalances: [{ token: tokenIn, amount: q.amount + 111n }] }) },
      observeTokenBalances: scope, observeTotalSupplies: [d.lp],
      observe: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] as const };
  }));
}
function proves(p: GenericProof, q: Quote, i: number, mode: ReceiverMode, results: readonly AdapterRequestResult[]): boolean {
  const d = p.binding!, actor = p.actor!, recipient = mode === "none" ? actor : GENERIC_RECEIVER,
    r = result(results, `g-behavior-${i}-${mode}`, p.source);
  if (hasCryptoClaim(d) && q.direction === "redeem") return decodeCryptoClaim(d, { ...q, tokenIn: d.lp, tokenOut: d.coins[q.index] }, q.amount, actor, p.feeWitness!, r, p.source, recipient) === q.output;
  if (r.completion !== "returned") return false;
  const tokenIn = q.direction === "mint" ? d.coins[q.index] : d.lp, tokenOut = q.direction === "mint" ? d.lp : d.coins[q.index];
  const expected: (readonly [string, string, bigint])[] = [[tokenIn, actor, -q.amount], [tokenIn, d.pool, q.direction === "mint" ? q.amount : 0n],
    [tokenOut, recipient, q.output], [tokenOut, d.pool, q.direction === "redeem" ? -q.output : 0n],
    ...(recipient === actor ? [] : [[tokenOut, actor, 0n], [tokenIn, recipient, 0n]] as const)];
  const erc20 = expected.filter(([token]) => token !== NATIVE), deltas = r.effects?.tokenDeltas;
  if (!deltas || deltas.length !== erc20.length || erc20.some(([token, account, delta]) => {
    const entries = deltas.filter(v => v.token.toLowerCase() === token && v.account.toLowerCase() === account);
    return entries.length !== 1 || entries[0].delta !== delta;
  })) return false;
  const native = r.effects?.nativeDeltas, actorNative = tokenIn === NATIVE ? -q.amount : tokenOut === NATIVE ? q.output : 0n;
  if (!native?.length || native.filter(v => v.account.toLowerCase() === actor).length !== 1 ||
      native.some(v => v.delta !== (v.account.toLowerCase() === actor ? actorNative : v.account.toLowerCase() === d.pool ? -actorNative : 0n))) return false;
  const supplies = r.effects?.totalSupplyDeltas;
  // Admin LP mint during an operation is not silently accepted as user output.
  // Such a state remains unavailable until its separate fee-recipient deltas
  // are implemented and verified; no successful sample is manufactured.
  return supplies?.length === 1 && supplies[0].token.toLowerCase() === d.lp &&
    supplies[0].delta === (q.direction === "mint" ? q.output : -q.amount);
}
function rootBinding(pool: string, lp: string, poolCoins: readonly string[], poolCode: string, registryCode: string,
  kind: "stable" | "crypto", identitySource: GenericBinding["identitySource"], handler: string, basePool: string, sourceCodeHash = ethers.keccak256(registryCode)): Binding {
  const forwarder = /^0x366000600037611000600036600073([0-9a-fA-F]{40})5af4602c57600080fd5b6110006000f3$/.exec(poolCode);
  const minimal = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/.exec(poolCode);
  const implementation = forwarder?.[1] ?? minimal?.[1];
  const operationEffects = kind === "crypto" ? cryptoClaimProfile(poolCode, pool, lp, poolCoins) : undefined;
  return { pool, lp, coins: poolCoins, poolCodeHash: ethers.keccak256(poolCode), lpCodeHash: "", coinCodeHashes: [], generic: {
    ...(operationEffects ? { operationEffects } : {}), kind, identitySource, registryHandler: handler, registryCodeHash: ethers.keccak256(registryCode), sourceCodeHash,
    decimals: [], coinIndex: "uint256", basePool, baseLp: basePool !== ethers.ZeroAddress || identitySource === "v1-factory" ? (poolCoins[poolCoins.length - 1] ?? ethers.ZeroAddress) : ethers.ZeroAddress,
    baseCodeHash: "", calcCodeHash: "", mintQuote: kind === "stable" ? "stable-calc" : "crypto-bool",
    implementation: implementation ? address("0x" + implementation) : ethers.ZeroAddress,
    implementationCodeHash: "", forwarderBytes: forwarder ? 4096 : 0, directions: [],
  } };
}
export const genericIdentityVariant: IdentitySemantics<Candidate, Identity>["variants"][number] = {
  id: "registry-fixed-array-lp-and-actual-effects", kind: "registry-member", lineageId: GENERIC_LINEAGE, applies: c => c.candidateKind === "curve-lp",
  requirements: ({ evidence }) => { const p = evidence as GenericProof | undefined;
    if (p?.phase === "behavior") return { transports: ["effect-delta-simulation"], caller: "executor", effects: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] };
    if (p?.phase === "structure") return { transports: ["get-code", "eth-call", "effect-delta-simulation"], caller: "executor", effects: ["return-data", "revert-data", "token-delta", "native-delta"] };
    if (p?.phase === "quotes" && hasCryptoClaim(p.binding!)) return { ...cryptoClaimRequirements, transports: ["eth-call", "effect-delta-simulation"] };
    if (p?.phase === "quotes") return { transports: p.binding!.generic!.basePool === ethers.ZeroAddress ? ["eth-call"] : ["get-code", "eth-call"] };
    return { transports: ["get-code", "eth-call"] };
  },
  buildRequests({ candidate, evidence }) { const p = evidence as GenericProof | undefined;
    if (!p) return roots(candidate.pool).map(opt);
    if (p.phase === "v1") return [code("g-v1-code", CURVE_V1_FACTORY), opt(call("g-v1-coins", CURVE_V1_FACTORY, GENERIC.encodeFunctionData("get_coins", [candidate.pool])))];
    if (p.phase === "structure") return structuralRequests(p);
    if (p.phase === "quotes") return quoteRequests(p);
    if (p.phase === "behavior") return behaviorRequests(p); return [];
  },
  decode({ step, results }): GenericProof { const p = step.evidence as GenericProof | undefined, source = p?.source ?? results[0]?.source;
    if (!source) throw new Error("curve-lp generic missing source");
    try {
      if (p?.binding && hasCryptoClaim(p.binding)) { for (const r of results) { if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, source); } }
      const get = (id: string) => data(results, id, source);
      if (!p) {
        const pool = address(step.candidate.pool), poolCode = get("g-pool-code"), registryCode = get("g-registry-code");
        if (poolCode === "0x") return { phase: "unavailable", source, rejection: "curve-lp-no-code", requestIds: ["g-pool-code"] };
        if (registryCode === "0x") throw new Error("curve-lp generic registry identity source unavailable");
        const lpResult = result(results, "g-registry-lp", source), handlersResult = result(results, "g-handlers", source), coinResult = result(results, "g-registry-coins", source);
        const lp = lpResult.completion === "returned" && lpResult.data.length === 66 ? addr(lpResult.data) : ethers.ZeroAddress;
        const handlers = handlersResult.completion === "returned" ? [...decode("get_registry_handlers_from_pool", handlersResult.data)[0]].map((v: string) => v.toLowerCase()).filter(v => v !== ethers.ZeroAddress) : [];
        const poolCoins = coinResult.completion === "returned" ? coins([...decode("get_coins", coinResult.data)[0]]) : [];
        if (lp === ethers.ZeroAddress || !handlers.length || !poolCoins.length) return { phase: "v1", source,
          binding: rootBinding(pool, pool, [], poolCode, registryCode, "stable", "v1-factory", CURVE_V1_FACTORY, ethers.ZeroAddress) };
        if (poolCoins.length < 2 || poolCoins.length > 4 || new Set([pool, META, ...poolCoins]).size !== poolCoins.length + 2 || poolCoins.includes(lp)) throw new Error("curve-lp generic unsupported coin/LP domain");
        const gamma = optionalWord(results, "g-gamma", source), basePool = addr(get("g-registry-base"));
        return { phase: "structure", source, binding: rootBinding(pool, lp, poolCoins, poolCode, registryCode, gamma ? "crypto" : "stable", "meta-registry", handlers[0], basePool) };
      }
      const d = p.binding!;
      if (p.phase === "v1") {
        const raw = get("g-v1-code"); if (raw === "0x" || ethers.keccak256(raw) !== V1_FACTORY_CODE_HASH) throw new Error("curve-lp generic V1 identity source unavailable");
        // This infrastructure singleton's verified getter reads stored
        // pool_data, populated only by deploy_metapool. It does not reflect
        // arbitrary candidate getters or grant identity by a pool allowlist.
        const poolCoins = coins([...GENERIC.decodeFunctionResult("get_coins", get("g-v1-coins"))[0]]);
        if (poolCoins.length !== 2 || new Set([d.pool, META, ...poolCoins]).size !== 4 || poolCoins.includes(NATIVE)) throw new Error("curve-lp generic unknown V1 membership");
        return { ...p, phase: "structure", binding: { ...d, coins: poolCoins, generic: { ...d.generic!, sourceCodeHash: ethers.keccak256(raw), baseLp: poolCoins[1] } } };
      }
      if (p.phase === "structure") {
        const g = d.generic!, inverse = addr(get("g-registry-pool"));
        if (g.identitySource === "meta-registry" && inverse !== ethers.ZeroAddress && inverse !== d.pool) return {
          phase: "unavailable", source, rejection: "curve-lp-registry-reverse-mismatch", requestIds: ["g-registry-pool"] };
        if (g.identitySource === "meta-registry" && inverse !== d.pool) throw new Error("curve-lp generic unknown reciprocal LP identity");
        if (get("g-lp-code") === "0x" || word(d.lp === d.pool ? genericScalarData(d, get("g-lp-decimals")) : get("g-lp-decimals")) !== 18n) throw new Error("curve-lp generic LP code/decimals");
        const index = (["uint256", "int128"] as const).find(t => d.coins.every((coin, i) => {
          const r = result(results, `g-coin-${t}-${i}`, source), raw = genericScalarData(d, r.data);
          return r.completion === "returned" && raw.length === 66 && addr(raw) === coin;
        }));
        if (!index) throw new Error("curve-lp generic no registry-matching pool coin ABI");
        const decimals = d.coins.map((coin, i) => coin === NATIVE ? 18 : Number(word(get(`g-decimal-${i}`))));
        if (decimals.some(v => !Number.isInteger(v) || v < 0 || v > 36) || d.coins.some((coin, i) => coin !== NATIVE && get(`g-coin-code-${i}`) === "0x")) throw new Error("curve-lp generic coin code/decimals");
        let basePool = g.basePool;
        if (basePool !== ethers.ZeroAddress || g.identitySource === "v1-factory") {
          const base = addr(get("g-base-reverse"));
          if (base === ethers.ZeroAddress || (basePool !== ethers.ZeroAddress && base !== basePool)) throw new Error("curve-lp generic base LP identity unavailable"); basePool = base;
        }
        const probe = result(results, "g-actor", source), actors = probe.effects?.tokenDeltas;
        if (probe.completion !== "returned" || actors?.length !== 1 || actors[0].token.toLowerCase() !== WETH || actors[0].delta !== 0n || !probe.effects?.nativeDeltas?.length || probe.effects.nativeDeltas.some(v => v.delta !== 0n)) throw new Error("curve-lp generic executor authority");
        const actor = address(actors[0].account); runtimeExecutor(actor, d.pool, d.lp, GENERIC_RECEIVER, ...d.coins);
        if (g.kind === "stable" && ethers.keccak256(get("g-calc-code")) !== STABLE_CALC_CODE_HASH) throw new Error("curve-lp generic fee-aware calculator unavailable");
        if (g.implementation !== ethers.ZeroAddress && get("g-implementation-code") === "0x") throw new Error("curve-lp generic implementation code unavailable");
        const effectBound = hasCryptoClaim(d) ? bindCryptoClaimDependencies(d, results, source) : d;
        return { ...p, ...(hasCryptoClaim(effectBound) ? { feeWitness: cryptoFeeWitness(effectBound, results, source) } : {}), phase: "quotes", actor, supply: word(d.lp === d.pool ? genericScalarData(d, get("g-supply")) : get("g-supply")), binding: { ...effectBound,
          lpCodeHash: ethers.keccak256(get("g-lp-code")), coinCodeHashes: d.coins.map((coin, i) => coin === NATIVE ? ethers.ZeroHash : ethers.keccak256(get(`g-coin-code-${i}`))),
          generic: { ...effectBound.generic!, coinIndex: index, decimals, basePool,
            implementationCodeHash: g.implementation === ethers.ZeroAddress ? "" : ethers.keccak256(get("g-implementation-code")),
            calcCodeHash: g.kind === "stable" ? ethers.keccak256(get("g-calc-code")) : "" } } };
      }
      if (p.phase === "quotes") {
        const all = samples(d, p.supply!), valid = (id: string) => { const r = result(results, id, source), raw = genericScalarData(d, r.data);
          return r.completion === "returned" && ethers.isHexString(raw, 32) && word(raw) > 0n ? word(raw) : undefined; };
        const style = d.generic!.kind === "stable" ? "stable-calc" : (["crypto-bool", "crypto-onearg"] as const).find(style =>
          all.some((q, i) => q.direction === "mint" && valid(`g-quote-${i}-${style}`) !== undefined)) ?? "crypto-bool";
        const quotes = all.flatMap((q, i) => {
          if (hasCryptoClaim(d) && q.direction === "redeem") { const output = decodeCryptoClaim(d, { ...q, tokenIn: d.lp, tokenOut: d.coins[q.index] }, q.amount, p.actor!, p.feeWitness!, result(results, `g-quote-${i}`, source), source); return output === null ? [] : [{ ...q, output }]; }
          const id = q.direction === "mint" && d.generic!.kind === "crypto" ? `g-quote-${i}-${style}` : `g-quote-${i}`, output = valid(id);
          return output === undefined ? [] : [{ ...q, output }]; });
        if (!quotes.length) throw new Error("curve-lp generic no positive amount quote");
        const baseCode = d.generic!.basePool === ethers.ZeroAddress ? "" : get("g-base-code");
        if (d.generic!.basePool !== ethers.ZeroAddress && baseCode === "0x") throw new Error("curve-lp generic base code unavailable");
        return { ...p, phase: "behavior", quotes, binding: { ...d, generic: { ...d.generic!, mintQuote: style, baseCodeHash: baseCode ? ethers.keccak256(baseCode) : "" } } };
      }
      if (p.phase !== "behavior") throw new Error("curve-lp generic identity phase");
      const directions: GenericBinding["directions"] = (["mint", "redeem"] as const).flatMap(direction => d.coins.flatMap((_c, index) => {
        const group = p.quotes!.map((q, i) => ({ q, i })).filter(v => v.q.direction === direction && v.q.index === index);
        if (group.length !== 2 || !group.every(({ q, i }) => proves(p, q, i, "none", results))) return [];
        const receiverMode = (["receiver", "bool-receiver"] as const).find(mode => modes(d, group[0].q).includes(mode) && group.every(({ q, i }) => proves(p, q, i, mode, results))) ?? ("none" as const);
        return [{ direction, index, receiverMode }];
      }));
      if (!directions.length) throw new Error("curve-lp generic no behavior-proven direction");
      return { ...p, phase: "complete", binding: { ...d, generic: { ...d.generic!, directions } },
        behaviorHash: hashCanonical(JSON.parse(JSON.stringify(results, (_k, v) => typeof v === "bigint" ? v.toString() : v))) };
    } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e; return { phase: "unavailable", source, reason: e instanceof Error ? e.message : "curve-lp generic unavailable" }; }
  },
  decide({ evidence }) { const p = evidence as GenericProof | undefined;
    if (p?.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.requestIds! };
    if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
    if (p?.phase !== "complete" || !p.binding?.generic || !p.behaviorHash) return { status: "continue" };
    return { status: "verified", identity: { familyId: FAMILY, lineageId: GENERIC_LINEAGE, subject: p.binding.pool, binding: p.binding,
      provenance: [{ kind: "curve-registry-fixed-array-source-and-mint-burn-effects", subject: p.binding.pool,
        evidenceHash: hashCanonical(JSON.parse(JSON.stringify({ binding: p.binding, source: p.source, behaviorHash: p.behaviorHash }))) }] } };
  },
};

export const GENERIC_CALLS = [2, 3, 4].flatMap(n => [
  ...["", ",address", ",bool", ",bool,address"].map((tail, i) => ({ id: `mint-${n}-${i}`, fn: "add_liquidity", abi: fn(`add_liquidity(uint256[${n}],uint256${tail})`) })),
  ...["int128", "uint256"].flatMap(index => ["", ",address", ",bool", ",bool,address"].map((tail, i) => ({ id: `redeem-${n}-${index}-${i}`, fn: "remove_liquidity_one_coin", abi: fn(`remove_liquidity_one_coin(uint256,${index},uint256${tail})`) }))),
]).filter((v, i, all) => all.findIndex(other => other.abi.getFunction(other.fn)!.selector === v.abi.getFunction(v.fn)!.selector) === i);
export const GENERIC_EVENTS = [...[2, 3, 4].flatMap(n => [
  { id: `stable-add-${n}`, fn: "AddLiquidity", abi: new ethers.Interface([`event AddLiquidity(address indexed provider,uint256[${n}] token_amounts,uint256[${n}] fees,uint256 invariant,uint256 token_supply)`]) },
  { id: `crypto-add-${n}`, fn: "AddLiquidity", abi: new ethers.Interface([`event AddLiquidity(address indexed provider,uint256[${n}] token_amounts,uint256 fee,uint256 token_supply)`]) },
]),
  { id: "crypto-add-price", fn: "AddLiquidity", abi: new ethers.Interface(["event AddLiquidity(address indexed provider,uint256[2] token_amounts,uint256 fee,uint256 token_supply,uint256 price_scale)"]) },
  { id: "crypto-add-receiver-price", fn: "AddLiquidity", abi: new ethers.Interface(["event AddLiquidity(address indexed provider,address indexed receiver,uint256[2] token_amounts,uint256 fee,uint256 token_supply,uint256 price_scale)"]) },
  { id: "legacy-remove", fn: "RemoveLiquidityOne", abi: new ethers.Interface(["event RemoveLiquidityOne(address indexed provider,uint256 token_amount,uint256 coin_amount)"]) },
  { id: "crypto-remove-price", fn: "RemoveLiquidityOne", abi: new ethers.Interface(["event RemoveLiquidityOne(address indexed provider,uint256 token_amount,uint256 coin_index,uint256 coin_amount,uint256 approx_fee,uint256 packed_price_scale)"]) },
];
