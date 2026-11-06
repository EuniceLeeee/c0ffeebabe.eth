import { ethers } from "ethers";
import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";
import { sat1Permissions, hookDataFor, SAT1_FAIR_SUPPLY_CAP, SAT1_MAX_BUY } from "./sat1.js";
import { sat1QuoteAndApply, type Sat1LocalState } from "./sat1-math.js";
import { nativeBalanceState, storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";

/**
 * Pure declarative-Swap adapters for the univ4-fee-hook SAT1 curve. Inputs are
 * already-read chain facts; these models never perform transport, encode a call
 * or decide admission. The curve/cooldown transition delegates to the verified
 * handwritten family functions so JSON and the retained TS entry cannot drift
 * into two different implementations.
 */
type Data = Readonly<Record<string, any>>;
const MAX_UINT256 = (1n << 256n) - 1n;
const WAD = 10n ** 18n;

function record(value: MathValue, label: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`univ4-fee-hook math: ${label} must be a record`);
  }
  return value as Data;
}
function array(value: MathValue, label: string): readonly MathValue[] {
  if (!Array.isArray(value)) throw new Error(`univ4-fee-hook math: ${label} must be an array`);
  return value;
}
function uint(value: MathValue, label: string): bigint {
  const parsed = typeof value === "bigint" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value)
    : null;
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256) throw new Error(`univ4-fee-hook math: ${label} must be uint256`);
  return parsed;
}
function bool(value: MathValue, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`univ4-fee-hook math: ${label} must be a boolean`);
  return value;
}
function text(value: MathValue, label: string): string {
  if (typeof value !== "string") throw new Error(`univ4-fee-hook math: ${label} must be a string`);
  return value;
}
function addr(value: MathValue, label: string): string {
  try { return ethers.getAddress(text(value, label)); }
  catch { throw new Error(`univ4-fee-hook math: ${label} must be an address`); }
}

function actor(input: Data): string {
  const executor = addr(input.executor, "executor");
  const hook = addr(input.hook, "hook");
  const buy = bool(input.buy, "buy");
  if (buy) return executor;
  const seller = ethers.getAddress(ethers.dataSlice(ethers.solidityPackedKeccak256(
    ["string", "address", "address"],
    ["univ4-fee-hook:sat1:sell:v1", executor, hook],
  ), 12));
  if (seller === executor || seller === ethers.ZeroAddress) throw new Error("sat1 actor identity collision");
  return seller;
}

const permissions: DeclarativeMathModel = {
  id: "univ4-fee-hook:sat1-permissions",
  version: 1,
  validateInput(value) { addr(record(value, "permissions input").hook, "hook"); },
  evaluate(value) { return sat1Permissions(record(value, "permissions input").hook as string); },
  validateOutput(value) { if (typeof value !== "boolean") throw new Error("univ4-fee-hook math: invalid permission result"); },
};

const actorModel: DeclarativeMathModel = {
  id: "univ4-fee-hook:sat1-actor",
  version: 1,
  validateInput(value) {
    const input = record(value, "actor input");
    addr(input.executor, "executor"); addr(input.hook, "hook"); bool(input.buy, "buy");
  },
  evaluate(value) { return Object.freeze({ address: actor(record(value, "actor input")) }); },
  validateOutput(value) {
    const output = record(value, "actor output");
    addr(output.address, "actor address");
  },
};

const hookData: DeclarativeMathModel = {
  id: "univ4-fee-hook:sat1-hook-data",
  version: 1,
  validateInput(value) {
    const input = record(value, "hook data input");
    addr(input.executor, "executor"); addr(input.hook, "hook");
    if (input.direction !== "zero-for-one" && input.direction !== "one-for-zero") throw new Error("univ4-fee-hook math: direction");
  },
  evaluate(value) {
    const input = record(value, "hook data input");
    const executor = addr(input.executor, "executor");
    const hook = addr(input.hook, "hook");
    const encoded = hookDataFor({ hookModel: "sat1", hook }, executor, input.direction === "zero-for-one");
    return Object.freeze({ hookData: encoded });
  },
  validateOutput(value) {
    const output = record(value, "hook data output");
    if (typeof output.hookData !== "string" || !ethers.isHexString(output.hookData)) throw new Error("univ4-fee-hook math: invalid hookData");
  },
};

function state(value: MathValue): Sat1LocalState & { source?: any } {
  const raw = record(value, "trial state");
  const lastBuyBlocks = record(raw.lastBuyBlocks, "lastBuyBlocks");
  return Object.freeze({
    ethCum: uint(raw.ethCum, "ethCum"),
    actualSupply: uint(raw.actualSupply, "actualSupply"),
    nativeBalance: uint(raw.nativeBalance, "nativeBalance"),
    managerNativeBalance: uint(raw.managerNativeBalance, "managerNativeBalance"),
    managerTokenBalance: uint(raw.managerTokenBalance, "managerTokenBalance"),
    genesisBlock: uint(raw.genesisBlock, "genesisBlock"),
    initialized: bool(raw.initialized, "initialized"),
    deprecated: bool(raw.deprecated, "deprecated"),
    lastBuyBlocks: Object.freeze(Object.fromEntries(Object.entries(lastBuyBlocks).map(([key, item]) => [key, uint(item, "lastBuyBlock")]))),
    ...(raw.source === undefined ? {} : { source: raw.source }),
  });
}

const quote: DeclarativeMathModel = {
  id: "univ4-fee-hook:sat1-local-quote",
  version: 1,
  validateInput(value) {
    const input = record(value, "quote input");
    state(input.state);
    uint(input.amountIn, "amountIn");
    bool(input.buy, "buy");
    addr(input.actor, "actor");
    uint(input.blockNumber, "blockNumber");
  },
  evaluate(value) {
    const input = record(value, "quote input");
    const current = state(input.state);
    const result = sat1QuoteAndApply(current, uint(input.amountIn, "amountIn"), bool(input.buy, "buy"),
      addr(input.actor, "actor"), uint(input.blockNumber, "blockNumber"));
    return Object.freeze({
      amountOut: result.amountOut,
      nextState: Object.freeze({ ...result.nextState, ...(current.source === undefined ? {} : { source: current.source }) }),
    });
  },
  validateOutput(value) {
    const output = record(value, "quote output");
    uint(output.amountOut, "amountOut");
    state(output.nextState);
  },
};

const stateEffects: DeclarativeMathModel = {
  id: "univ4-fee-hook:sat1-state-effects",
  version: 1,
  validateInput(value) {
    const input = record(value, "state effects input");
    addr(input.executor, "executor"); addr(input.hook, "hook");
    addr(input.token, "token"); addr(input.graphToken0, "graphToken0");
  },
  evaluate(value) {
    const input = record(value, "state effects input");
    const executor = addr(input.executor, "executor");
    const hook = addr(input.hook, "hook"), token = addr(input.token, "token"), graphToken0 = addr(input.graphToken0, "graphToken0");
    return Object.freeze([
      storageState(hook), nativeBalanceState(hook), storageState(token),
      tokenSupplyState(token), tokenBalanceState(token, executor),
      tokenBalanceState(graphToken0, executor), tokenSupplyState(graphToken0),
      nativeBalanceState(graphToken0),
    ]);
  },
  validateOutput(value) {
    for (const item of array(value, "state effects output")) if (typeof item !== "string") throw new Error("univ4-fee-hook math: invalid state effect");
  },
};

function snapshot(value: MathValue) {
  const raw = record(value, "snapshot");
  return {
    ethCum: uint(raw.ethCum, "ethCum"),
    marginalPrice: uint(raw.marginalPrice, "marginalPrice"),
    fairSupply: uint(raw.fairSupply, "fairSupply"),
    actualSupply: uint(raw.actualSupply, "actualSupply"),
    deprecated: bool(raw.deprecated, "deprecated"),
  };
}
function inactive(s: ReturnType<typeof snapshot>, buy: boolean): boolean {
  if (s.marginalPrice <= 0n || s.fairSupply < 0n || s.actualSupply < 0n) return true;
  return buy
    ? s.deprecated || s.fairSupply >= SAT1_FAIR_SUPPLY_CAP
    : s.ethCum === 0n || s.fairSupply === 0n || s.actualSupply === 0n;
}

const rows: DeclarativeMathModel = {
  id: "univ4-fee-hook:sat1-rows",
  version: 1,
  validateInput(value) {
    const input = record(value, "rows input");
    snapshot(input.snapshot);
    record(input.descriptor, "descriptor");
    array(input.routes, "routes");
  },
  evaluate(value) {
    const input = record(value, "rows input");
    const s = snapshot(input.snapshot);
    const descriptor = record(input.descriptor, "descriptor");
    const out: any[] = [];
    for (const raw of array(input.routes, "routes")) {
      const route = record(raw, "route");
      const buy = route.direction === "zero-for-one";
      if (inactive(s, buy)) continue;
      const tokenIn = addr(route.tokenIn, "tokenIn");
      const tokenOut = addr(route.tokenOut, "tokenOut");
      const expectedIn = buy ? addr(descriptor.graphToken0, "graphToken0") : addr(descriptor.graphToken1, "graphToken1");
      const expectedOut = buy ? addr(descriptor.graphToken1, "graphToken1") : addr(descriptor.graphToken0, "graphToken0");
      if (tokenIn !== expectedIn || tokenOut !== expectedOut) throw new Error("sat1 price route mismatch");
      const reserveIn = buy ? SAT1_MAX_BUY : s.actualSupply;
      const reserveOut = buy ? SAT1_FAIR_SUPPLY_CAP - s.fairSupply : s.ethCum;
      if (reserveIn <= 0n || reserveOut <= 0n) continue;
      const numerator = buy ? 997n * WAD : s.marginalPrice * s.fairSupply * 997n;
      const denominator = buy ? 1000n * s.marginalPrice : WAD * s.actualSupply * 1000n;
      if (numerator <= 0n || denominator <= 0n) continue;
      out.push(Object.freeze({ routeKey: text(route.routeKey, "routeKey"), numerator, denominator,
        depth: reserveIn < reserveOut ? reserveIn : reserveOut, reserveA: reserveIn, reserveB: reserveOut, feeBps: 30n }));
    }
    return Object.freeze(out);
  },
  validateOutput(value) {
    for (const raw of array(value, "rows output")) {
      const row = record(raw, "row");
      if (typeof row.routeKey !== "string" || typeof row.numerator !== "bigint" || typeof row.denominator !== "bigint" ||
          typeof row.depth !== "bigint" || typeof row.feeBps !== "bigint") throw new Error("univ4-fee-hook math: invalid price row");
    }
  },
};

const unavailable: DeclarativeMathModel = {
  id: "univ4-fee-hook:sat1-unavailable",
  version: 1,
  validateInput(value) {
    const input = record(value, "unavailable input");
    snapshot(input.snapshot);
    array(input.routes, "routes");
  },
  evaluate(value) {
    const input = record(value, "unavailable input");
    const s = snapshot(input.snapshot);
    return Object.freeze(array(input.routes, "routes").flatMap(raw => {
      const route = record(raw, "route");
      return inactive(s, route.direction === "zero-for-one")
        ? [Object.freeze([text(route.routeKey, "routeKey"), "sat1 direction inactive"])] : [];
    }));
  },
  validateOutput(value) {
    for (const raw of array(value, "unavailable output")) {
      if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "string" || typeof raw[1] !== "string") {
        throw new Error("univ4-fee-hook math: invalid unavailable row");
      }
    }
  },
};

export const univ4FeeHookMathModels: readonly DeclarativeMathModel[] = Object.freeze([
  permissions, actorModel, hookData, quote, stateEffects, rows, unavailable,
]);
