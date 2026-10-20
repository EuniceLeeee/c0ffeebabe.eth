// The reviewed TwoCrypto withdrawal claims underlying fees BEFORE computing
// user output. A pre-claim view is not an amount quote for that operation.
import { ethers } from "ethers";
import type { ExactQuoteInput, ExactRequestProgram } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { ABI, address, assertSource, call, code, uint } from "./codec.js";
import { genericRawProgram, genericStateRequests, decodeGenericState, genericQuoteRequest, genericQuoteResult, type GenericBinding, type ReceiverMode } from "./generic.js";
import { assertRoute } from "./routes.js";
import type { Binding, Descriptor, Evidence, Route, State } from "./types.js";

const MODEL = "twocrypto-v0310-preclaim-underlying";
const PREFIX_BYTES = 17875, IMMUTABLE_BYTES = 480;
const PREFIX_HASH = "0xe40fd9046a6204d8e7985312d45a721dae1ff759dd9d91358f06024c5ec4bc37";
// Both saved runtime full matches (6dc8 and ee35) share this compiler prefix.
// Addresses are provenance, never membership gates. Immutable layout follows
// the verified declaration order: precisions[2], MATH, coins[2], factory, ... .
export type CryptoClaimBinding = { readonly model: string; readonly factory: string; readonly math: string;
  readonly factoryCodeHash: string; readonly mathCodeHash: string };
type Operation = Pick<Route, "direction" | "index" | "tokenIn" | "tokenOut">;
type Bound = Binding & { readonly generic: GenericBinding & { readonly operationEffects: CryptoClaimBinding } };
export type CryptoFeeWitness = { readonly source: CanonicalSource; readonly feeReceiver: string };
export const CLAIM = new ethers.Interface([
  "function factory() view returns(address)", "function MATH() view returns(address)", "function fee_receiver() view returns(address)",
  "function execSubscript(bytes)", "event ClaimAdminFee(address indexed admin,uint256[2] tokens)",
  "event Transfer(address indexed sender,address indexed receiver,uint256 value)",
]);
export const cryptoClaimRequirements: RequestRequirements = { transports: ["effect-delta-simulation"], caller: "executor",
  effects: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] };
const caller = { kind: "executor" as const };
function addr(raw: string, zero = false) { if (!ethers.isHexString(raw, 32) || BigInt(raw) >> 160n !== 0n) throw new Error("curve-lp effects address encoding");
  const a = ethers.getAddress(ethers.dataSlice(raw, 12)).toLowerCase(); if (!zero && a === ethers.ZeroAddress) throw new Error("curve-lp effects zero address"); return a; }
function get(results: readonly AdapterRequestResult[], id: string, source: CanonicalSource) {
  const matches = results.filter(r => r.id === id); if (matches.length !== 1) throw new Error("curve-lp effects missing/duplicate " + id);
  const r = matches[0]; if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, source); return r;
}
function data(results: readonly AdapterRequestResult[], id: string, source: CanonicalSource) { const r = get(results, id, source);
  if (r.completion !== "returned") throw new Error("curve-lp effects read unavailable " + id); return r.data; }
function checkRound(results: readonly AdapterRequestResult[], source?: CanonicalSource) {
  for (const r of results) if (!r.ok) throw new RequiredAdapterRequestError(r);
  if (source) for (const r of results) assertSource(r.source, source);
}
export function proveCryptoClaimCode(raw: string) {
  if (!ethers.isHexString(raw, true)) throw new Error("curve-lp effects malformed code"); const bytes = ethers.getBytes(raw);
  if (bytes.length !== PREFIX_BYTES + IMMUTABLE_BYTES || ethers.keccak256(bytes.slice(0, PREFIX_BYTES)) !== PREFIX_HASH) return undefined;
  const tail = bytes.slice(PREFIX_BYTES), word = (i: number) => ethers.hexlify(tail.slice(i * 32, (i + 1) * 32));
  if (BigInt(word(0)) === 0n || BigInt(word(1)) === 0n || BigInt(word(12)) !== 1n) throw new Error("curve-lp effects immutable domain");
  const math = addr(word(2)), coins = [addr(word(3)), addr(word(4))], factory = addr(word(5));
  if (new Set([math, factory, ...coins]).size !== 4) throw new Error("curve-lp effects aliased immutables");
  return { model: MODEL, math, coins, factory };
}
export function hasCryptoClaim(d: Binding): d is Bound { return d.generic?.operationEffects !== undefined; }
function bound(d: Binding): asserts d is Bound {
  const g = d.generic, p = g?.operationEffects;
  if (!p || p.model !== MODEL || g.kind !== "crypto" || d.pool !== d.lp || d.coins.length !== 2 || g.basePool !== ethers.ZeroAddress ||
      d.coins.some(a => address(a) !== a || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")) throw new Error("curve-lp effects unsupported binding");
}
export function cryptoClaimProfile(raw: string, pool: string, lp: string, coins: readonly string[]): CryptoClaimBinding | undefined {
  const p = proveCryptoClaimCode(raw); if (!p) return undefined;
  if (pool !== lp || coins.length !== 2 || coins.some((a, i) => a !== p.coins[i])) throw new Error("curve-lp effects registry/immutable mismatch");
  return { model: p.model, math: p.math, factory: p.factory, factoryCodeHash: "", mathCodeHash: "" };
}
export function cryptoClaimGuardRequests(d: Binding): AdapterRequest[] {
  bound(d); const p = d.generic.operationEffects;
  return [code("g-effect-factory-code", p.factory), code("g-effect-math-code", p.math),
    call("g-effect-factory", d.pool, CLAIM.encodeFunctionData("factory")), call("g-effect-math", d.pool, CLAIM.encodeFunctionData("MATH")),
    call("g-effect-fee-receiver", d.pool, CLAIM.encodeFunctionData("fee_receiver")), call("g-effect-factory-receiver", p.factory, CLAIM.encodeFunctionData("fee_receiver"))];
}
export function bindCryptoClaimDependencies(d: Binding, results: readonly AdapterRequestResult[], source: CanonicalSource): Bound {
  bound(d); checkRound(results, source);
  const factoryCode = data(results, "g-effect-factory-code", source), mathCode = data(results, "g-effect-math-code", source);
  if (factoryCode === "0x" || mathCode === "0x") throw new Error("curve-lp effects missing executable dependency");
  const next: Bound = { ...d, generic: { ...d.generic, operationEffects: { ...d.generic.operationEffects,
    factoryCodeHash: ethers.keccak256(factoryCode), mathCodeHash: ethers.keccak256(mathCode) } } };
  cryptoFeeWitness(next, results, source); return next;
}
export function cryptoFeeWitness(d: Binding, results: readonly AdapterRequestResult[], source: CanonicalSource): CryptoFeeWitness {
  bound(d); checkRound(results, source); const p = d.generic.operationEffects;
  if (addr(data(results, "g-effect-factory", source)) !== p.factory || addr(data(results, "g-effect-math", source)) !== p.math ||
      ethers.keccak256(data(results, "g-effect-factory-code", source)) !== p.factoryCodeHash || ethers.keccak256(data(results, "g-effect-math-code", source)) !== p.mathCodeHash)
    throw new Error("curve-lp effects dependency binding changed");
  const feeReceiver = addr(data(results, "g-effect-fee-receiver", source), true);
  if (addr(data(results, "g-effect-factory-receiver", source), true) !== feeReceiver) throw new Error("curve-lp effects fee receiver disagreement");
  return { source: { ...source }, feeReceiver };
}
export function cryptoClaimDependencies(d: Binding): readonly string[] { bound(d); return [d.generic.operationEffects.factory, d.generic.operationEffects.math]; }
function actors(d: Binding, r: Operation, executor: string, recipient: string) {
  bound(d);
  if (r.direction !== "redeem" || !Number.isInteger(r.index) || r.index < 0 || r.index > 1 || r.tokenIn !== d.lp || r.tokenOut !== d.coins[r.index]) throw new Error("curve-lp effects wrong route");
  const excluded = [d.pool, ...d.coins, ...cryptoClaimDependencies(d)], actor = runtimeExecutor(executor, ...excluded).toLowerCase(), receiver = runtimeExecutor(recipient, ...excluded).toLowerCase();
  return { actor, receiver };
}
/** Preserve actual receipts while independently conserving pool debits, fee
 * receipts and LP supply in the transaction. Child registers are scoped. */
export function cryptoClaimProgram(d: Binding, r: Operation, executor: string, minimum = 1n, recipient = executor): RuntimeAmountProgram {
  const { actor, receiver } = actors(d, r, executor, recipient); if (!uint(minimum)) throw new Error("curve-lp effects zero floor");
  const p = new RuntimeAmountProgram().constant(15, 0n).call(d.pool, CLAIM.encodeFunctionData("fee_receiver"), { static: true }).load(14, 0);
  for (const a of new Set([actor, receiver, d.pool, ...d.coins])) p.constant(4, BigInt(a)).math("eq", 3, 14, 4).equal(3, 15);
  const balance = (token: string, account: string, reg: number) => p.call(token, ABI.encodeFunctionData("balanceOf", [account]), { static: true }).load(reg, 0);
  const feeBalance = (token: string, reg: number) => p.call(token, ABI.encodeFunctionData("balanceOf", [ethers.ZeroAddress]), { static: true, patches: [{ offset: 4, reg: 14 }] }).load(reg, 0);
  balance(d.coins[0], d.pool, 13); balance(d.coins[1], d.pool, 12); feeBalance(d.coins[0], 11); feeBalance(d.coins[1], 10);
  p.call(d.lp, ABI.encodeFunctionData("totalSupply"), { static: true }).load(9, 0); balance(d.lp, d.pool, 8); balance(r.tokenOut, receiver, 7);
  p.run(genericRawProgram(d, r, actor, minimum, receiver).bytes(), 0, 1).equal(1, 0);
  balance(r.tokenOut, receiver, 5).math("sub", 5, 5, 7);
  for (const i of [0, 1]) {
    balance(d.coins[i], d.pool, 4).math("sub", 3, i === 0 ? 13 : 12, 4); feeBalance(d.coins[i], 4).math("sub", 2, 4, i === 0 ? 11 : 10);
    if (i === r.index) p.math("add", 2, 2, 5); p.equal(3, 2);
  }
  p.call(d.lp, ABI.encodeFunctionData("totalSupply"), { static: true }).load(4, 0).math("sub", 3, 9, 4).equal(3, 0);
  balance(d.lp, d.pool, 4).equal(4, 8);
  p.call(d.pool, CLAIM.encodeFunctionData("fee_receiver"), { static: true }).load(4, 0).equal(4, 14); return p;
}
function scope(d: Binding, r: Operation, actor: string, receiver: string, feeReceiver: string) {
  return [...d.coins, d.lp].flatMap(token => [...new Set([d.pool, feeReceiver, actor, receiver])].map(account => ({ token, account })));
}
export function cryptoClaimQuoteRequest(d: Binding, r: Operation, amount: bigint, executor: string, witness: CryptoFeeWitness, id: string,
  mode: ReceiverMode = "none", recipient = executor): AdapterRequest {
  if (!uint(amount) || amount > ethers.MaxUint256 - 111n || !["none", "receiver"].includes(mode)) throw new Error("curve-lp effects amount/mode");
  const { actor, receiver } = actors(d, r, executor, recipient);
  if ([actor, receiver, d.pool, ...d.coins].includes(witness.feeReceiver)) throw new Error("curve-lp effects ambiguous fee receiver");
  const provisional: Binding = { ...d, generic: { ...d.generic!, directions: [{ direction: "redeem", index: r.index, receiverMode: mode }] } };
  return { id, required: false, kind: "effect-delta-simulation", call: { caller, executionMode: "executor-program", to: actor,
    data: CLAIM.encodeFunctionData("execSubscript", [ethers.hexlify(runtimeProgramScript(cryptoClaimProgram(provisional, r, actor, 1n, receiver).bytes(), amount))]) },
    overrideIntent: { caller, tokenBalances: [{ token: d.lp, amount: amount + 111n }] }, observeTokenBalances: scope(d, r, actor, receiver, witness.feeReceiver),
    observeTotalSupplies: [d.lp], observe: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] };
}
function canonicalEvent(name: "ClaimAdminFee" | "Transfer", log: { data: string; topics: readonly string[] }) {
  const decoded = CLAIM.decodeEventLog(name, log.data, [...log.topics]), encoded = CLAIM.encodeEventLog(CLAIM.getEvent(name)!, decoded);
  if (encoded.data.toLowerCase() !== log.data.toLowerCase() || encoded.topics.length !== log.topics.length || encoded.topics.some((t, i) => t.toLowerCase() !== log.topics[i].toLowerCase()))
    throw new Error("curve-lp effects noncanonical event"); return decoded;
}
export function decodeCryptoClaim(d: Binding, r: Operation, amount: bigint, executor: string, witness: CryptoFeeWitness, row: AdapterRequestResult, source: CanonicalSource, recipient = executor): bigint | null {
  const { actor, receiver } = actors(d, r, executor, recipient); assertSource(witness.source, source);
  if (!row.ok) throw new RequiredAdapterRequestError(row); assertSource(row.source, source); if (row.completion !== "returned") return null;
  if ([actor, receiver, d.pool, ...d.coins].includes(witness.feeReceiver)) throw new Error("curve-lp effects ambiguous fee receiver");
  const deltas = row.effects?.tokenDeltas, observations = scope(d, r, actor, receiver, witness.feeReceiver);
  if (!deltas || deltas.length !== observations.length) throw new Error("curve-lp effects incomplete balance observations");
  const delta = (token: string, account: string) => { const matches = deltas.filter(v => v.token.toLowerCase() === token && v.account.toLowerCase() === account);
    if (matches.length !== 1) throw new Error("curve-lp effects missing/duplicate balance"); return matches[0].delta; };
  const out = delta(r.tokenOut, receiver); if (out <= 0n || out > ethers.MaxUint256) throw new Error("curve-lp effects no fresh output");
  const logs = row.effects?.logs; if (!logs) throw new Error("curve-lp effects missing log observation");
  const claims = logs.filter(l => l.address.toLowerCase() === d.pool && l.topics[0]?.toLowerCase() === CLAIM.getEvent("ClaimAdminFee")!.topicHash.toLowerCase());
  if (claims.length > 1) throw new Error("curve-lp effects duplicate fee claim");
  const claimed = claims.length ? canonicalEvent("ClaimAdminFee", claims[0]) : undefined, fees: bigint[] = claimed ? [...claimed.tokens] : [0n, 0n];
  if (claimed && (String(claimed.admin).toLowerCase() !== witness.feeReceiver || witness.feeReceiver === ethers.ZeroAddress)) throw new Error("curve-lp effects fee recipient mismatch");
  for (const { token, account } of observations) {
    const i = d.coins.indexOf(token), expected = token === d.lp ? account === actor ? -amount : 0n : account === d.pool ? -fees[i] - (i === r.index ? out : 0n)
      : account === witness.feeReceiver ? fees[i] : account === receiver && i === r.index ? out : 0n;
    if (delta(token, account) !== expected) throw new Error("curve-lp effects per-account conservation mismatch");
  }
  const supply = row.effects?.totalSupplyDeltas;
  if (supply?.length !== 1 || supply[0].token.toLowerCase() !== d.lp || supply[0].delta !== -amount) throw new Error("curve-lp effects unexplained LP supply");
  const native = row.effects?.nativeDeltas; if (!native?.length || native.filter(v => v.account.toLowerCase() === actor).length !== 1 || native.some(v => v.delta !== 0n)) throw new Error("curve-lp effects native subsidy");
  const expected = new Map<string, bigint>(), actual = new Map<string, bigint>(), key = (t: string, a: string, b: string) => `${t}:${a}:${b}`;
  expected.set(key(d.lp, actor, ethers.ZeroAddress), amount);
  for (let i = 0; i < 2; i++) expected.set(key(d.coins[i], d.pool, witness.feeReceiver), fees[i]);
  expected.set(key(r.tokenOut, d.pool, receiver), out);
  for (const log of logs.filter(l => [...d.coins, d.lp].includes(l.address.toLowerCase()) && l.topics[0]?.toLowerCase() === CLAIM.getEvent("Transfer")!.topicHash.toLowerCase())) {
    const v = canonicalEvent("Transfer", log), k = key(log.address.toLowerCase(), String(v.sender).toLowerCase(), String(v.receiver).toLowerCase());
    if (!expected.has(k)) throw new Error("curve-lp effects unexpected token transfer"); actual.set(k, (actual.get(k) ?? 0n) + BigInt(v.value));
  }
  for (const [k, v] of expected) if ((actual.get(k) ?? 0n) !== v) throw new Error("curve-lp effects fee/burn transfer evidence mismatch");
  return out;
}

function effectActorRequest(d: Binding): AdapterRequest { return { id: "g-effect-actor", kind: "effect-delta-simulation", call: { caller, executionMode: "impersonated-call-frame",
  to: d.lp, data: ABI.encodeFunctionData("balanceOf", [ethers.ZeroAddress]) }, overrideIntent: { caller }, observeTokenBalances: [{ token: d.lp, account: caller }],
  observe: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] }; }
function effectActor(d: Binding, initial: readonly AdapterRequestResult[], source: CanonicalSource) {
  const r = get(initial, "g-effect-actor", source), ds = r.effects?.tokenDeltas;
  if (r.completion !== "returned" || ds?.length !== 1 || ds[0].token.toLowerCase() !== d.lp || ds[0].delta !== 0n || !r.effects?.nativeDeltas?.length || r.effects.nativeDeltas.some(v => v.delta !== 0n)) throw new Error("curve-lp effects executor probe");
  return runtimeExecutor(ds[0].account, d.pool, ...d.coins, ...cryptoClaimDependencies(d)).toLowerCase();
}
const projected = (d: Binding, direction: "mint" | "redeem", index: number) => ({ direction, index, tokenIn: direction === "mint" ? d.coins[index] : d.lp, tokenOut: direction === "mint" ? d.lp : d.coins[index] }) satisfies Operation;
function midAmount(d: Binding, s: State, direction: "mint" | "redeem", index: number) { const unit = 10n ** BigInt(direction === "mint" ? d.generic!.decimals[index] : 18), cap = (direction === "mint" ? s.balances[index] : s.totalSupply) / 1_000_000n; return cap < 1n ? 1n : cap < unit ? cap : unit; }
export function cryptoClaimPricingRequests(d: Binding): AdapterRequest[] { bound(d); return [...genericStateRequests(d), effectActorRequest(d)]; }
export function cryptoClaimMidRequests(d: Binding, initial: readonly AdapterRequestResult[], source: CanonicalSource): AdapterRequest[] {
  bound(d); checkRound(initial, source); const s = decodeGenericState(d, initial, source), actor = effectActor(d, initial, source), witness = cryptoFeeWitness(d, initial, source);
  return d.generic.directions.map(q => q.direction === "redeem" ? cryptoClaimQuoteRequest(d, projected(d, q.direction, q.index), midAmount(d, s, q.direction, q.index), actor, witness, `g-effect-mid-${q.direction}-${q.index}`)
    : genericQuoteRequest(d, q.direction, q.index, midAmount(d, s, q.direction, q.index), `g-effect-mid-${q.direction}-${q.index}`));
}
export function decodeCryptoClaimSnapshot(d: Binding, initial: readonly AdapterRequestResult[], quotes: readonly AdapterRequestResult[]) {
  bound(d); checkRound([...initial, ...quotes]); const s = decodeGenericState(d, initial), actor = effectActor(d, initial, s.source), witness = cryptoFeeWitness(d, initial, s.source);
  if (quotes.length !== d.generic.directions.length) throw new Error("curve-lp effects mid round length");
  const ngQuotes = d.generic.directions.map(q => { const r = get(quotes, `g-effect-mid-${q.direction}-${q.index}`, s.source), amountIn = midAmount(d, s, q.direction, q.index);
    return { ...q, amountIn, amountOut: q.direction === "redeem" ? decodeCryptoClaim(d, projected(d, q.direction, q.index), amountIn, actor, witness, r, s.source) ?? 0n
      : r.completion === "returned" ? genericQuoteResult(d, r) : 0n }; });
  return { ...s, withdraw: [] as bigint[], ngQuotes };
}
type Input = ExactQuoteInput<Descriptor, Route>;
function invocation(i: Input) { assertRoute(i.descriptor, i.route); actors(i.descriptor, i.route, i.executor, i.executor); uint(i.amountIn);
  if (i.prefix?.length || i.runtimeEvidence.length) throw new Error("curve-lp effects prefix requires runtime execution"); }
const quoted = (i: Input, amountOut: bigint) => ({ amountOut, evidence: { kind: "curve-lp-exact" as const, source: i.source, binding: i.route.bindingRef.fingerprint,
  routeKey: i.route.routeKey, executor: address(i.executor), amountIn: i.amountIn, amountOut } });
export const cryptoClaimExactProgram: ExactRequestProgram<Descriptor, Route, Evidence> = {
  requirements(i) { invocation(i); return i.amountIn ? { transports: ["get-code", "eth-call"] } : { transports: [] }; },
  buildRequests(i) { invocation(i); return i.amountIn ? genericStateRequests(i.descriptor) : []; },
  buildDependentProgram({ programInput: i, completedRound, initialResults }) { invocation(i); if (!i.amountIn || completedRound !== 0) return null;
    const s = decodeGenericState(i.descriptor, initialResults, i.source); if (!s.totalSupply || i.amountIn >= s.totalSupply) throw new Error("curve-lp effects no withdrawal capacity");
    const witness = cryptoFeeWitness(i.descriptor, initialResults, i.source), request = cryptoClaimQuoteRequest(i.descriptor, i.route, i.amountIn, i.executor, witness, "g-effect-exact");
    return { requirements: cryptoClaimRequirements, requests: [request], decode: results => ({ results: [...results] }) }; },
  decode({ programInput: i, initialResults, dependentEvidence }) { invocation(i); checkRound(initialResults, i.source);
    if (!i.amountIn) { if (initialResults.length || dependentEvidence.length) throw new Error("curve-lp effects zero-input reads"); return quoted(i, 0n); }
    if (dependentEvidence.length !== 1) throw new Error("curve-lp effects quote dependent round");
    decodeGenericState(i.descriptor, initialResults, i.source); const witness = cryptoFeeWitness(i.descriptor, initialResults, i.source);
    const results = (dependentEvidence[0] as { readonly results: readonly AdapterRequestResult[] }).results;
    if (!Array.isArray(results) || results.length !== 1) throw new Error("curve-lp effects quote results");
    const out = decodeCryptoClaim(i.descriptor, i.route, i.amountIn, i.executor, witness, get(results, "g-effect-exact", i.source), i.source);
    if (out === null) throw new Error("curve-lp effects requested withdrawal unavailable"); return quoted(i, out); },
};
