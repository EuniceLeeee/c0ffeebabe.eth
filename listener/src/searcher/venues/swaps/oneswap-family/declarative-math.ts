import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { LIMIT112, normalizedToken } from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import { decodeProxy } from "./proxy.js";
import { decodeState } from "./state.js";
import { quoteAmount } from "./math.js";
import type { Descriptor, Order, State } from "./types.js";

/**
 * Pure declarative-Swap adapters for OneSwap. Inputs are already-read chain
 * facts; these models never perform transport, encode a call or decide
 * admission. The decoded state and the integer quote delegate to the verified
 * handwritten family functions so the JSON and the retained TS entry cannot
 * drift into two different orderbook implementations.
 */
type Data = Readonly<Record<string, any>>;
const MAX_UINT256 = (1n << 256n) - 1n;

function record(value: MathValue, label: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`oneswap math: ${label} must be a record`);
  }
  return value as Data;
}

function array(value: MathValue, label: string): readonly MathValue[] {
  if (!Array.isArray(value)) throw new Error(`oneswap math: ${label} must be an array`);
  return value;
}

function uint(value: MathValue, label: string): bigint {
  const parsed = typeof value === "bigint" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value)
    : null;
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256) throw new Error(`oneswap math: ${label} must be uint256`);
  return parsed;
}

function bool(value: MathValue, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`oneswap math: ${label} must be a boolean`);
  return value;
}

function text(value: MathValue, label: string): string {
  if (typeof value !== "string") throw new Error(`oneswap math: ${label} must be a string`);
  return value;
}

function addr(value: MathValue, label: string): string {
  try { return ethers.getAddress(text(value, label)).toLowerCase(); }
  catch { throw new Error(`oneswap math: ${label} must be an address`); }
}

function hex32(value: MathValue, label: string): string {
  const value_ = text(value, label).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value_)) throw new Error(`oneswap math: ${label} must be bytes32`);
  return value_;
}

function canonicalSource(value: MathValue): CanonicalSource {
  const source = record(value, "source");
  if (!Number.isSafeInteger(source.number) || source.number < 0 || !Number.isSafeInteger(source.generation) ||
      source.generation < 0 || typeof source.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(source.hash)) {
    throw new Error("oneswap math: invalid canonical source");
  }
  return Object.freeze({ number: source.number, hash: source.hash.toLowerCase(), generation: source.generation });
}

function descriptor(value: MathValue): Descriptor {
  const d = record(value, "descriptor");
  return Object.freeze({
    familyId: ID, lineageId: LINEAGE, instanceKey: instanceKey(addr(d.pool, "pool")),
    pool: addr(d.pool, "pool"), stock: addr(d.stock, "stock"), money: addr(d.money, "money"),
    ones: addr(d.ones, "ones"), factory: addr(d.factory, "factory"), implementation: addr(d.implementation, "implementation"),
    isOnlySwap: bool(d.isOnlySwap, "isOnlySwap"), stockUnit: uint(d.stockUnit, "stockUnit"),
    priceMul: uint(d.priceMul, "priceMul"), priceDiv: uint(d.priceDiv, "priceDiv"),
    codeHash: hex32(d.codeHash, "codeHash"), implementationCodeHash: hex32(d.implementationCodeHash, "implementationCodeHash"),
    factoryCodeHash: hex32(d.factoryCodeHash, "factoryCodeHash"), provenance: [], runtimeRequirements: [],
  });
}

function order(value: MathValue, label: string): Order {
  const row = record(value, label);
  return Object.freeze({
    id: uint(row.id, `${label}.id`), next: uint(row.next, `${label}.next`),
    maker: addr(row.maker, `${label}.maker`), price: uint(row.price, `${label}.price`),
    amount: uint(row.amount, `${label}.amount`),
  });
}

function state(value: MathValue): State {
  const s = record(value, "state");
  return Object.freeze({
    source: canonicalSource(s.source), stock: uint(s.stock, "stock"), money: uint(s.money, "money"),
    bookedStock: uint(s.bookedStock, "bookedStock"), bookedMoney: uint(s.bookedMoney, "bookedMoney"),
    balanceStock: uint(s.balanceStock, "balanceStock"), balanceMoney: uint(s.balanceMoney, "balanceMoney"),
    feeBps: uint(s.feeBps, "feeBps"), sells: array(s.sells, "sells").map((row, i) => order(row, `sells[${i}]`)),
    buys: array(s.buys, "buys").map((row, i) => order(row, `buys[${i}]`)),
    sellTail: uint(s.sellTail, "sellTail"), buyTail: uint(s.buyTail, "buyTail"),
  });
}

const proxy: DeclarativeMathModel = {
  id: "oneswap:proxy",
  version: 1,
  validateInput(value) {
    const input = record(value, "proxy input");
    if (Object.keys(input).some(key => !["code", "pool"].includes(key))) throw new Error("oneswap math: unknown proxy input field");
    text(input.code, "code");
    addr(input.pool, "pool");
  },
  evaluate(value) {
    const input = record(value, "proxy input");
    const found = decodeProxy(text(input.code, "code"));
    if (!found) return null;
    const pool = addr(input.pool, "pool");
    // Same structural rejections as the retained handwritten identity.
    if ([found.stock, found.money, found.factory, found.ones].includes(pool)) return null;
    if (normalizedToken(found.stock) === normalizedToken(found.money)) return null;
    return Object.freeze({ ...found });
  },
  validateOutput(value) {
    if (value === null) return;
    const binding = record(value, "proxy output");
    for (const field of ["factory", "stock", "money", "ones"]) addr(binding[field], field);
    if (typeof binding.isOnlySwap !== "boolean") throw new Error("oneswap math: proxy flag");
    for (const field of ["stockUnit", "priceMul", "priceDiv"]) {
      if (uint(binding[field], field) === 0n) throw new Error(`oneswap math: ${field} must be positive`);
    }
  },
};

const readState: DeclarativeMathModel = {
  id: "oneswap:state",
  version: 1,
  validateInput(value) {
    const input = record(value, "state input");
    if (Object.keys(input).some(key => !["descriptor", "results", "source"].includes(key))) throw new Error("oneswap math: unknown state input field");
    array(input.results, "results");
    descriptor(input.descriptor);
  },
  evaluate(value) {
    const input = record(value, "state input");
    const d = descriptor(input.descriptor);
    const results = array(input.results, "results") as unknown as readonly AdapterRequestResult[];
    // The retained decodeState returns the frozen State record; it is lossless
    // JSON data at this boundary (the immutable wrapper re-validates it).
    return decodeState(d, results, canonicalSource(input.source)) as unknown as MathValue;
  },
  validateOutput(value) {
    state(value);
  },
};

const quote: DeclarativeMathModel = {
  id: "oneswap:quote",
  version: 1,
  validateInput(value) {
    const input = record(value, "quote input");
    if (Object.keys(input).some(key => !["descriptor", "state", "buy", "amountIn", "executor"].includes(key))) throw new Error("oneswap math: unknown quote input field");
    descriptor(input.descriptor); state(input.state); bool(input.buy, "buy"); uint(input.amountIn, "amountIn");
    if (input.executor !== undefined && input.executor !== null) addr(input.executor, "executor");
  },
  evaluate(value) {
    const input = record(value, "quote input");
    const d = descriptor(input.descriptor), s = state(input.state), buy = bool(input.buy, "buy");
    const amountIn = uint(input.amountIn, "amountIn");
    if (input.executor !== undefined && input.executor !== null) {
      const executor = addr(input.executor, "executor");
      // Maker payments to the executor would change the net input/output flow.
      if ((buy ? s.sells : s.buys).some(o => o.maker === executor)) throw new Error("oneswap executor is a maker");
    }
    return Object.freeze(quoteAmount(d, s, buy, amountIn));
  },
  validateOutput(value) {
    const amounts = record(value, "quote output");
    if (Object.keys(amounts).some(key => !["amountOut", "amountIntoPool", "bookOutput", "fee"].includes(key))) throw new Error("oneswap math: unknown quote output field");
    for (const field of ["amountOut", "amountIntoPool", "bookOutput", "fee"] as const) {
      if (uint(amounts[field], field) >= LIMIT112) throw new Error(`oneswap math: ${field} must be uint112`);
    }
  },
};

const pricing: DeclarativeMathModel = {
  id: "oneswap:pricing",
  version: 1,
  validateInput(value) {
    const input = record(value, "pricing input");
    if (Object.keys(input).some(key => !["descriptor", "state", "routes"].includes(key))) throw new Error("oneswap math: unknown pricing input field");
    descriptor(input.descriptor); state(input.state); array(input.routes, "routes");
  },
  evaluate(value) {
    const input = record(value, "pricing input");
    const d = descriptor(input.descriptor), s = state(input.state);
    const rows: Data[] = [], unavailable: (readonly [string, string])[] = [];
    const pairs: [string, Data][] = [];
    for (const item of array(input.routes, "routes")) {
      const route = record(item, "route");
      const routeKey = text(route.routeKey, "routeKey"), buy = bool(route.buy, "buy");
      // Mirrors the retained pricing.deriveMids skip rules exactly.
      const depthIn = buy ? s.money : s.stock, depthOut = buy ? s.stock : s.money;
      const amountIn = depthIn / 100_000n;
      if (!amountIn || !depthOut) {
        unavailable.push(Object.freeze([routeKey, "oneswap zero depth at the current source"]));
        continue;
      }
      const amounts = quoteAmount(d, s, buy, amountIn);
      if (!amounts.amountOut) {
        unavailable.push(Object.freeze([routeKey, "oneswap zero quote at the current source"]));
        continue;
      }
      pairs.push([routeKey, Object.freeze({ amountIn, amountOut: amounts.amountOut })]);
      rows.push(Object.freeze({
        routeKey, numerator: amounts.amountOut, denominator: amountIn,
        depth: depthIn < depthOut ? depthIn : depthOut, reserveA: depthIn, reserveB: depthOut, feeBps: s.feeBps,
      }));
    }
    return Object.freeze({ source: s.source, state: s, quotes: Object.fromEntries(pairs),
      rows: Object.freeze(rows), unavailable: Object.freeze(unavailable) }) as unknown as MathValue;
  },
  validateOutput(value) {
    const snapshot = record(value, "pricing output");
    if (Object.keys(snapshot).some(key => !["source", "state", "quotes", "rows", "unavailable"].includes(key))) throw new Error("oneswap math: unknown pricing output field");
    canonicalSource(snapshot.source); state(snapshot.state); array(snapshot.rows, "rows"); array(snapshot.unavailable, "unavailable");
    const quotes = record(snapshot.quotes, "quotes");
    for (const [key, item] of Object.entries(quotes)) {
      if (!key) throw new Error("oneswap math: empty quote route key");
      const row = record(item as MathValue, "quote row");
      if (Object.keys(row).some(field => !["amountIn", "amountOut"].includes(field))) throw new Error("oneswap math: unknown quote row field");
      if (uint(row.amountIn, "amountIn") === 0n || uint(row.amountOut, "amountOut") === 0n) throw new Error("oneswap math: positive priced quote");
    }
  },
};

export const oneswapMathModels: readonly DeclarativeMathModel[] = Object.freeze([proxy, readState, quote, pricing]);
