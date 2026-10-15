import { checked, LIMIT112 } from "./codec.js";
import type { Descriptor, State } from "./types.js";
const Q32 = 1n << 32n, Q64 = 1n << 64n;
function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
export function expandPrice(price: bigint, d: Pick<Descriptor, "priceMul" | "priceDiv">) {
  const exponent = Number(price >> 27n) - 23, mantissa = price & ((1n << 27n) - 1n);
  return { numerator: mantissa * (exponent > 0 ? 10n ** BigInt(exponent) : 1n) * d.priceMul,
    denominator: (exponent < 0 ? 10n ** BigInt(-exponent) : 1n) * d.priceDiv };
}
// Exact source algorithm, including its Taylor branch, truncation and sell-side
// stockUnit rounding. An idealized square-root price boundary is NOT equivalent.
export function intoPoolTillPrice(buy: boolean, stock: bigint, money: bigint, numerator: bigint, denominator: bigint, stockUnit: bigint): bigint {
  let n = money * denominator, d = stock * numerator;
  if (buy) [n, d] = [d, n];
  while (n >= 1n << 192n) { n >>= 16n; d >>= 16n; }
  if (d === 0n) throw new Error("oneswap price denominator zero");
  const q = checked(n * Q64) / d;
  let amount = 0n;
  if (q > Q64 && q <= Q64 * 5n / 4n) {
    const x = q - Q64, y = x * x;
    amount = (buy ? money : stock) * (x / 2n - y / (8n * Q64) + y * x / (16n * Q64 * Q64)) / Q64;
  } else if (q > Q64) amount = (buy ? money : stock) * (sqrt(q) - Q32) / Q32;
  checked(amount, LIMIT112);
  return buy ? amount : amount / stockUnit * stockUnit;
}
export function quoteAmount(d: Descriptor, s: State, buy: boolean, amountIn: bigint) {
  checked(amountIn, LIMIT112);
  if (!amountIn) return { amountOut: 0n, amountIntoPool: 0n, bookOutput: 0n, fee: 0n };
  // _checkRemainAmount incorporates only the input-side pre-existing surplus.
  const stock = checked(buy ? s.stock : s.balanceStock - s.bookedStock, LIMIT112);
  const money = checked(buy ? s.balanceMoney - s.bookedMoney : s.money, LIMIT112);
  if (!stock || !money) throw new Error("oneswap empty AMM reserves");
  let remain = amountIn, amountIntoPool = 0n, dealStock = 0n, dealMoney = 0n;
  let next = (buy ? s.sells : s.buys)[0]?.id ?? (buy ? s.sellTail : s.buyTail);
  for (const order of buy ? s.sells : s.buys) {
    const p = expandPrice(order.price, d);
    const capacity = intoPoolTillPrice(buy, stock, money, p.numerator, p.denominator, d.stockUnit);
    if (capacity > amountIntoPool) {
      const available = capacity - amountIntoPool;
      const take = available < remain ? available : remain;
      amountIntoPool += take; remain -= take;
      if (!remain) break;
    }
    let units = buy ? checked(remain * p.denominator) / checked(p.numerator * d.stockUnit) : remain / d.stockUnit;
    if (units > order.amount) units = order.amount;
    checked(units, 1n << 42n);
    const stockTrans = units * d.stockUnit, moneyTrans = checked(stockTrans * p.numerator) / p.denominator;
    remain = checked(remain - (buy ? moneyTrans : stockTrans));
    dealStock += stockTrans; dealMoney += moneyTrans;
    if (units !== order.amount) { next = 0n; break; } // residual dust executes in AMM
    next = order.next;
  }
  // A fetched prefix grants no knowledge of prices beyond its tail. Never
  // treat an exhausted 64-order page as the end of the on-chain orderbook.
  if (remain && next) throw new Error("oneswap orderbook quote coverage exhausted");
  amountIntoPool += remain;
  const outReserve = buy ? stock : money, inReserve = buy ? money : stock;
  const poolOutput = outReserve * amountIntoPool / (inReserve + amountIntoPool);
  const bookOutput = buy ? dealStock : dealMoney, raw = checked(poolOutput + bookOutput, LIMIT112);
  const fee = (raw * s.feeBps + 9999n) / 10000n, amountOut = checked(raw - fee, LIMIT112);
  checked(inReserve + amountIntoPool, LIMIT112); checked(outReserve - poolOutput + fee, LIMIT112);
  checked(buy ? s.bookedStock - dealStock : s.bookedMoney - dealMoney, LIMIT112);
  if (amountOut > (buy ? s.balanceStock : s.balanceMoney)) throw new Error("oneswap insufficient output balance");
  return { amountOut, amountIntoPool, bookOutput, fee };
}
