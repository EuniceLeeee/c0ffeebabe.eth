import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { address, call, checked, code, FACTORY, IMPLEMENTATION_HASH, LIMIT112, MULTICALL, NATIVE, ORDER_LIMIT, POOL, resultsSource, returned, TOKEN, uint } from "./codec.js";
import type { Descriptor, Order, State } from "./types.js";
export const STATE_IDS = ["reserves", "booked", "fee", "logic", "implementation-code", "balance-stock", "balance-money", "sells", "buys"];
export function balanceRequest(id: string, token: string, account: string) {
  return token === ethers.ZeroAddress ? call(id, MULTICALL, NATIVE.encodeFunctionData("getEthBalance", [account]))
    : call(id, token, TOKEN.encodeFunctionData("balanceOf", [account]));
}
export function stateRequests(d: Descriptor) {
  return [call("reserves", d.pool, POOL.encodeFunctionData("getReserves")), call("booked", d.pool, POOL.encodeFunctionData("getBooked")),
    call("fee", d.factory, FACTORY.encodeFunctionData("feeBPS")), call("logic", d.factory, FACTORY.encodeFunctionData("pairLogic")),
    code("implementation-code", d.implementation), balanceRequest("balance-stock", d.stock, d.pool), balanceRequest("balance-money", d.money, d.pool),
    call("sells", d.pool, POOL.encodeFunctionData("getOrderList", [false, 0, ORDER_LIMIT + 1])),
    call("buys", d.pool, POOL.encodeFunctionData("getOrderList", [true, 0, ORDER_LIMIT + 1]))];
}
function book(data: string, first: bigint, source: CanonicalSource): { orders: Order[]; tail: bigint } {
  const words = POOL.decodeFunctionResult("getOrderList", data)[0] as readonly bigint[];
  if (!words.length || words.length > ORDER_LIMIT + 1 || words[0] !== (BigInt(source.number) << 24n | first)) throw new Error("oneswap book header mismatch");
  let id = first;
  const seen = new Set<bigint>(), orders: Order[] = [];
  for (const word of words.slice(1)) {
    if (!id || seen.has(id)) throw new Error("oneswap invalid book chain");
    seen.add(id);
    const next = word & ((1n << 22n) - 1n), amount = (word >> 22n) & ((1n << 42n) - 1n), price = (word >> 64n) & ((1n << 32n) - 1n);
    const mantissa = price & ((1n << 27n) - 1n);
    if (mantissa < 10_000_000n || mantissa > 99_999_999n || amount === 0n) throw new Error("oneswap malformed order");
    orders.push({ id, next, amount, price, maker: address(ethers.toBeHex(word >> 96n, 32)) }); id = next;
  }
  if (id && orders.length !== ORDER_LIMIT) throw new Error("oneswap truncated book response");
  return { orders, tail: id };
}
export function decodeState(d: Descriptor, results: readonly AdapterRequestResult[], expected?: CanonicalSource): State {
  const source = resultsSource(results, STATE_IDS, expected), data = (id: string) => returned(results, id);
  if (address(data("logic")) !== d.implementation || ethers.keccak256(data("implementation-code")) !== IMPLEMENTATION_HASH) throw new Error("oneswap implementation changed; reattestation required");
  const r = POOL.decodeFunctionResult("getReserves", data("reserves")), b = POOL.decodeFunctionResult("getBooked", data("booked"));
  const stock = checked(BigInt(r[0]), LIMIT112), money = checked(BigInt(r[1]), LIMIT112);
  const bookedStock = checked(BigInt(b[0]), LIMIT112), bookedMoney = checked(BigInt(b[1]), LIMIT112);
  const feeBps = uint(data("fee")), balanceStock = uint(data("balance-stock")), balanceMoney = uint(data("balance-money"));
  if (feeBps > 50n || balanceStock < stock + bookedStock || balanceMoney < money + bookedMoney || BigInt(r[2]) >= 1n << 22n || BigInt(b[2]) >= 1n << 22n)
    throw new Error("oneswap invalid fee or accounting");
  const sells = book(data("sells"), BigInt(r[2]), source), buys = book(data("buys"), BigInt(b[2]), source);
  if (d.isOnlySwap && (bookedStock || bookedMoney || sells.orders.length || buys.orders.length || sells.tail || buys.tail)) throw new Error("oneswap unexpected only-swap book");
  return { source, stock, money, bookedStock, bookedMoney, balanceStock, balanceMoney, feeBps,
    sells: sells.orders, buys: buys.orders, sellTail: sells.tail, buyTail: buys.tail };
}
