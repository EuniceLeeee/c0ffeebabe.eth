import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { CanonicalSource, ObservedEffects } from "../../../adapter-request-program.js";

// Acceptance oracle derived from the verified source/event interface. It
// deliberately does not import production quote/effect decoding.
export const PRECLAIM = new ethers.Interface([
  "function fee_receiver() view returns(address)",
  "function calc_withdraw_one_coin(uint256,uint256) view returns(uint256)",
  "event ClaimAdminFee(address indexed admin,uint256[2] tokens)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const normal = (a: string) => ethers.getAddress(a).toLowerCase();
export interface FeeWitness { readonly pool: string; readonly factory: string; readonly feeReceiver: string; readonly source: CanonicalSource;
  readonly poolResult: string; readonly factoryResult: string }
export function feeWitness(source: CanonicalSource, pool: string, factory: string, poolResult: string, factoryResult: string): FeeWitness {
  const decode = (raw: string) => { assert(ethers.isHexString(raw, 32) && BigInt(raw) >> 160n === 0n, "noncanonical fee receiver"); return normal(ethers.dataSlice(raw, 12)); };
  const feeReceiver = decode(poolResult); assert.equal(decode(factoryResult), feeReceiver, "pool/factory fee receiver disagreement");
  return { source: { ...source }, pool: normal(pool), factory: normal(factory), feeReceiver, poolResult, factoryResult };
}
export function preclaimScope(tokens: readonly string[], accounts: readonly string[]) {
  return [...new Set(tokens.map(normal))].flatMap(token => [...new Set(accounts.map(normal))].map(account => ({ token, account })));
}
function event(name: "ClaimAdminFee" | "Transfer", log: { readonly data: string; readonly topics: readonly string[] }) {
  const fragment = PRECLAIM.getEvent(name)!, args = PRECLAIM.decodeEventLog(fragment, log.data, [...log.topics]), encoded = PRECLAIM.encodeEventLog(fragment, args);
  assert.equal(log.data.toLowerCase(), encoded.data.toLowerCase(), "noncanonical event data");
  assert.deepEqual(log.topics.map(t => t.toLowerCase()), encoded.topics.map(t => t.toLowerCase()), "noncanonical event topics"); return args;
}
export function assertPreclaimEffects(i: { readonly source: CanonicalSource; readonly pool: string; readonly lp: string; readonly coins: readonly string[];
  readonly executor: string; readonly owner: string; readonly recipient: string; readonly index: number; readonly amountIn: bigint; readonly witness: FeeWitness }, observed: ObservedEffects) {
  const pool = normal(i.pool), lp = normal(i.lp), coins = i.coins.map(normal), actor = normal(i.executor), owner = normal(i.owner), recipient = normal(i.recipient), admin = i.witness.feeReceiver;
  assert.deepEqual(i.witness.source, i.source); assert.equal(i.witness.pool, pool); assert.equal(pool, lp); assert.equal(coins.length, 2); assert.equal(new Set([lp, ...coins]).size, 3);
  assert(i.index === 0 || i.index === 1); assert(i.amountIn > 0n); assert(![actor, recipient, pool, ...coins].includes(admin), "ambiguous fee/output recipient");
  const scope = preclaimScope([...coins, lp], [actor, owner, pool, admin]), deltas = observed.tokenDeltas!;
  assert.equal(deltas?.length, scope.length, "incomplete preclaim balance matrix");
  const delta = (token: string, account: string) => { const rows = deltas.filter(r => normal(r.token) === token && normal(r.account) === account); assert.equal(rows.length, 1, "missing/duplicate token account"); return rows[0]!.delta; };
  const received = delta(coins[i.index]!, recipient); assert(received > 0n, "no fresh recipient output");
  const logs = observed.logs; assert(logs, "missing independent logs");
  const claims = logs.filter(l => normal(l.address) === pool && l.topics[0]?.toLowerCase() === PRECLAIM.getEvent("ClaimAdminFee")!.topicHash.toLowerCase()); assert(claims.length <= 1, "duplicate fee claim");
  const claim = claims.length ? event("ClaimAdminFee", claims[0]!) : undefined;
  const fees = coins.map(token => delta(token, admin)); assert(fees.every(n => n >= 0n), "old fee inventory consumed");
  if (claim) { assert.equal(normal(claim.admin), admin); assert.notEqual(admin, ethers.ZeroAddress); assert.deepEqual([...claim.tokens], fees, "fee event differs from measured admin receipt"); }
  else assert.deepEqual(fees, [0n, 0n], "admin receipt without canonical claim");
  const matrix = scope.map(v => [v.token, v.account, 0n] as [string, string, bigint]);
  const add = (token: string, account: string, amount: bigint) => { const rows = matrix.filter(v => v[0] === token && v[1] === account); assert.equal(rows.length, 1); rows[0]![2] += amount; };
  add(lp, actor, -i.amountIn); add(coins[i.index]!, recipient, received);
  coins.forEach((token, j) => { add(token, pool, -fees[j]! - (j === i.index ? received : 0n)); add(token, admin, fees[j]!); });
  for (const [token, account, expected] of matrix) assert.equal(delta(token, account), expected, "preclaim balance conservation failed");
  const supply = observed.totalSupplyDeltas; assert.equal(supply?.length, 1); assert.equal(normal(supply![0]!.token), lp); assert.equal(supply![0]!.delta, -i.amountIn, "unexplained LP supply");
  assert(observed.nativeDeltas?.length && observed.nativeDeltas.filter(r => normal(r.account) === actor).length === 1 && observed.nativeDeltas.every(r => r.delta === 0n), "native inventory changed");
  const expected = new Map<string, bigint>(), actual = new Map<string, bigint>(), edge = (token: string, from: string, to: string) => `${token}:${from}:${to}`;
  expected.set(edge(lp, actor, ethers.ZeroAddress), i.amountIn);
  coins.forEach((token, j) => expected.set(edge(token, pool, admin), fees[j]!)); expected.set(edge(coins[i.index]!, pool, recipient), received);
  const transfers = logs.filter(l => [lp, ...coins].includes(normal(l.address)) && l.topics[0]?.toLowerCase() === PRECLAIM.getEvent("Transfer")!.topicHash.toLowerCase()).map(l => {
    const args = event("Transfer", l), token = normal(l.address), from = normal(args.from), to = normal(args.to), value = BigInt(args.value), key = edge(token, from, to);
    assert(expected.has(key), "unexpected token transfer"); actual.set(key, (actual.get(key) ?? 0n) + value); return { token, from, to, value };
  });
  for (const [key, value] of expected) assert.equal(actual.get(key) ?? 0n, value, "fee/output/burn transfer amount mismatch");
  for (const [token, account, expected] of matrix) {
    // A burn's zero-address event endpoint is a supply marker, not a token
    // balance credited to zero. Zero fee receiver is accepted only no-claim.
    const flow = account === ethers.ZeroAddress ? 0n : transfers.filter(t => t.token === token).reduce((n, t) => n + (t.to === account ? t.value : 0n) - (t.from === account ? t.value : 0n), 0n);
    assert.equal(flow, expected, "Transfer flow differs from measured balance matrix");
  }
  const minted = transfers.filter(t => t.token === lp && t.from === ethers.ZeroAddress).reduce((n, t) => n + t.value, 0n), burned = transfers.filter(t => t.token === lp && t.to === ethers.ZeroAddress).reduce((n, t) => n + t.value, 0n);
  assert.equal(minted - burned, supply![0]!.delta);
  return { claimPresent: !!claim, adminTokens: fees, feeReceiver: admin, source: i.source, actualReceipt: received, actualDebit: -delta(lp, actor), expectedMatrix: matrix,
    measuredTokenDeltas: deltas, measuredSupplyDeltas: supply, canonicalTransfers: transfers, claimLog: claims[0] ?? null, protocolBalanceOverrides: false };
}
