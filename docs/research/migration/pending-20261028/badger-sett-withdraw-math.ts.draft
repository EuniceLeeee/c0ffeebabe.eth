import { Interface, MaxUint256, ZeroAddress, getAddress } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";
import type { RuntimeMathModel } from "./declarative-runtime-math.js";

const MAX_UINT256 = MaxUint256;
const CANONICAL_ABI: Readonly<Record<string, Interface>> = Object.freeze({
  vault: new Interface([
    "function token() view returns(address)", "function strategy() view returns(address)",
    "function totalSupply() view returns(uint256)", "function balance() view returns(uint256)",
    "function withdrawalFee() view returns(uint256)", "function treasury() view returns(address)",
    "function paused() view returns(bool)", "function decimals() view returns(uint8)",
    "function withdraw(uint256)", "function balanceOf(address) view returns(uint256)",
  ]),
  strategy: new Interface([
    "function vault() view returns(address)", "function want() view returns(address)",
    "function LOCKER() view returns(address)", "function paused() view returns(bool)",
    "function balanceOf() view returns(uint256)", "function withdrawalSafetyCheck() view returns(bool)",
    "function withdrawalMaxDeviationThreshold() view returns(uint256)",
  ]),
  token: new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]),
  locker: new Interface([
    "function stakingToken() view returns(address)",
    "function balances(address) view returns(uint112 locked,uint32 nextUnlockIndex)",
  ]),
});

/** The Family codec re-encodes every decoded ABI result and rejects trailing or
 * dirty bytes. The declarative `decode` op alone cannot express that check, so
 * the same canonical round-trip is enforced by this pure model operation. */
function canonical(value: MathValue): true {
  const row = plain(value, ["kind", "abi", "function", "data", "value"], "badger-sett canonical ABI input");
  const iface = CANONICAL_ABI[String(row.abi)];
  if (!iface || typeof row.function !== "string") throw new Error("badger-sett noncanonical ABI");
  if (typeof row.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(row.data)) throw new Error("badger-sett noncanonical ABI");
  const args = Array.isArray(row.value) ? row.value : [row.value];
  const encoded = iface.encodeFunctionResult(row.function, args as never[]).toLowerCase();
  if (encoded !== row.data.toLowerCase()) throw new Error("badger-sett noncanonical ABI");
  return true;
}

const WAD = 10n ** 18n;
const BPS = 10000n;
const ZERO = ZeroAddress.toLowerCase();

type State = {
  readonly supply: bigint;
  readonly vaultIdle: bigint;
  readonly strategyIdle: bigint;
  readonly locked: bigint;
  readonly feeBps: bigint;
  readonly deviationBps: bigint;
  readonly treasury: string;
  readonly vaultPaused: boolean;
  readonly strategyPaused: boolean;
  readonly safetyCheck: boolean;
};

function plain(value: MathValue, fields: readonly string[], label: string): Readonly<Record<string, MathValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const record = value as Record<string, MathValue>;
  const keys = Reflect.ownKeys(record);
  if (keys.some(key => typeof key !== "string") ||
      keys.some(key => typeof key === "string" && !fields.includes(key)) ||
      fields.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
  return record;
}

function uint(value: MathValue, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`${label} must be a uint256`);
  }
  return value;
}

/** Every intermediate the Solidity Family checks through `uint(...)` is
 * checked here with the same failure boundary; intermediate bigint values are
 * never silently truncated. */
function checked(value: bigint, label: string): bigint {
  if (value < 0n || value > MAX_UINT256) throw new Error(`${label} uint256 overflow`);
  return value;
}

function boolean(value: MathValue, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function address(value: MathValue, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an address`);
  const normalized = getAddress(value).toLowerCase();
  if (normalized === ZERO) throw new Error(`${label} must not be the zero address`);
  return normalized;
}

function treasury(value: MathValue, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an address`);
  return getAddress(value).toLowerCase();
}

function state(value: MathValue): State {
  const row = plain(value, ["supply", "vaultIdle", "strategyIdle", "locked", "feeBps",
    "deviationBps", "treasury", "vaultPaused", "strategyPaused", "safetyCheck"], "badger-sett state");
  const source: State = Object.freeze({
    supply: uint(row.supply!, "badger-sett totalSupply"),
    vaultIdle: uint(row.vaultIdle!, "badger-sett vault idle"),
    strategyIdle: uint(row.strategyIdle!, "badger-sett strategy idle"),
    locked: uint(row.locked!, "badger-sett locked"),
    feeBps: uint(row.feeBps!, "badger-sett withdrawal fee"),
    deviationBps: uint(row.deviationBps!, "badger-sett deviation"),
    treasury: treasury(row.treasury!, "badger-sett treasury"),
    vaultPaused: boolean(row.vaultPaused!, "badger-sett vault pause"),
    strategyPaused: boolean(row.strategyPaused!, "badger-sett strategy pause"),
    safetyCheck: boolean(row.safetyCheck!, "badger-sett safety check"),
  });
  if (source.feeBps > 200n) throw new Error("badger-sett withdrawal fee exceeds verified source cap");
  return source;
}

/** The verified TheVault backing equation; strategy.balanceOf() includes the
 * locker-locked amount, while vault.balance() is the complete backing. */
function backing(s: State): bigint {
  return checked(checked(s.vaultIdle + s.strategyIdle, "badger-sett liquid backing") + s.locked, "badger-sett backing");
}

function validateState(value: MathValue): State {
  const row = plain(value, ["supply", "vaultIdle", "strategyIdle", "locked", "strategyBalance",
    "vaultBalance", "feeBps", "deviationBps"], "badger-sett state reads");
  const s = state(Object.freeze({
    supply: row.supply!, vaultIdle: row.vaultIdle!, strategyIdle: row.strategyIdle!, locked: row.locked!,
    feeBps: row.feeBps!, deviationBps: row.deviationBps!, treasury: ZERO, vaultPaused: false,
    strategyPaused: false, safetyCheck: false,
  }));
  if (checked(s.strategyIdle + s.locked, "badger-sett strategy backing") !== uint(row.strategyBalance!, "badger-sett strategy balance")) {
    throw new Error("badger-sett inconsistent backing");
  }
  if (backing(s) !== uint(row.vaultBalance!, "badger-sett vault balance")) {
    throw new Error("badger-sett inconsistent backing");
  }
  return s;
}

export function badgerSettCapacity(s: State): bigint {
  if (!s.supply || s.vaultPaused) return 0n;
  const total = backing(s);
  if (!total) return 0n;
  const available = s.vaultIdle + (s.strategyPaused ? 0n : s.strategyIdle);
  // Largest q whose *floored* gross fits liquid backing, also SafeMath-safe.
  const liquidCap = ((available + 1n) * s.supply - 1n) / total;
  let cap = s.supply < liquidCap ? s.supply : liquidCap;
  const safe = MAX_UINT256 / total;
  if (safe < cap) cap = safe;
  return cap;
}

export function badgerSettWithdraw(s: State, shares: bigint, executor?: string) {
  const q = unint(shares);
  if (!q || !s.supply || q > s.supply) throw new Error("badger-sett shares exceed supply or zero input");
  if (s.vaultPaused) throw new Error("badger-sett vault paused");
  const total = backing(s);
  const gross = checked(total * q, "badger-sett gross product") / s.supply;
  const deficit = gross > s.vaultIdle ? gross - s.vaultIdle : 0n;
  if (deficit > 0n) {
    if (s.strategyPaused) throw new Error("badger-sett strategy paused for deficit");
    if (deficit > s.strategyIdle) throw new Error("badger-sett unsupported locker-unlock branch");
    // SafeMath multiplication happens even when the fully liquid check passes.
    if (s.safetyCheck && s.strategyIdle < checked(deficit * 9980n, "badger-sett safety product") / BPS) {
      throw new Error("badger-sett safety check");
    }
  }
  const fee = s.feeBps === 0n ? 0n : checked(gross * s.feeBps, "badger-sett fee product") / BPS;
  const amountOut = checked(gross - fee, "badger-sett output");
  const remainingSupply = s.supply - q;
  let feeShares = 0n;
  if (fee > 0n) {
    const pool = checked(total - gross, "badger-sett fee pool");
    if (remainingSupply > 0n && pool === 0n) throw new Error("badger-sett fee share denominator zero");
    feeShares = remainingSupply === 0n ? fee : checked(fee * remainingSupply, "badger-sett fee share product") / pool;
    if (feeShares > 0n && s.treasury === ZERO) throw new Error("badger-sett fee mint to zero");
    if (feeShares > 0n && executor !== undefined && s.treasury === address(executor, "badger-sett executor")) {
      throw new Error("badger-sett unsupported treasury executor alias");
    }
  }
  const state: State = Object.freeze({ ...s, supply: checked(remainingSupply + feeShares, "badger-sett supply"),
    vaultIdle: checked(s.vaultIdle + deficit - amountOut, "badger-sett vault idle"),
    strategyIdle: s.strategyIdle - deficit });
  return { amountOut, gross, fee, feeShares, state };
}

function unint(value: bigint): bigint {
  return uint(value, "badger-sett shares");
}

function evaluateOperation(value: MathValue): MathValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("badger-sett math input must be an object");
  const operation = (value as Record<string, MathValue>).kind;
  if (operation === "canonical") return canonical(value);
  if (operation === "state") {
    const row = plain(value, ["kind", "supply", "vaultIdle", "strategyIdle", "locked", "strategyBalance",
      "vaultBalance", "feeBps", "deviationBps"], "badger-sett state input");
    return validateState(Object.freeze({
      supply: row.supply!, vaultIdle: row.vaultIdle!, strategyIdle: row.strategyIdle!, locked: row.locked!,
      strategyBalance: row.strategyBalance!, vaultBalance: row.vaultBalance!, feeBps: row.feeBps!,
      deviationBps: row.deviationBps!,
    }));
  }
  if (operation === "sample") {
    const row = plain(value, ["kind", "state"], "badger-sett sample input");
    const s = state(row.state!);
    const capacity = badgerSettCapacity(s);
    const amountIn = capacity < WAD ? capacity : WAD;
    if (!amountIn) return null;
    const quote = badgerSettWithdraw(s, amountIn);
    return quote.amountOut > 0n ? Object.freeze({ amountIn, amountOut: quote.amountOut }) : null;
  }
  if (operation === "quote") {
    const row = plain(value, ["kind", "state", "shares", "executor"], "badger-sett quote input");
    const s = state(row.state!);
    const quote = badgerSettWithdraw(s, uint(row.shares!, "badger-sett shares"),
      typeof row.executor === "string" ? row.executor : undefined);
    if (!quote.amountOut) throw new Error("badger-sett output rounds to zero");
    return Object.freeze({ amountOut: quote.amountOut });
  }
  throw new Error("badger-sett math operation is unsupported");
}

/**
 * Source-faithful TheVault 1.5 liquid-share withdrawal arithmetic. The JSON
 * owns ABI/read orchestration; this model only performs the verified integer
 * math, backing check and fail-closed branch rejections from state.ts.
 */
export const badgerSettWithdrawMathModel: DeclarativeMathModel = Object.freeze({
  id: "badger-sett-withdraw:liquid",
  version: 1,
  validateInput(value: MathValue): void {
    evaluateOperation(value);
  },
  evaluate(value: MathValue): MathValue {
    return evaluateOperation(value);
  },
  validateOutput(value: MathValue): void {
    if (value === null || typeof value === "boolean") return;
    if (typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("badger-sett math output must be a plain object");
    }
  },
});

/**
 * In-transaction net-receipt terms. gross = floor(B*q/S); the fee complement
 * runs before multiplication so an over-cap fee underflows exactly like the
 * Solidity SafeMath branch; checked subtraction produces the liquid margin the
 * native call must fit. Outputs feed the shared runtime amount program.
 */
const runtimeOperations: RuntimeMathModel["operations"] = [
  { name: "grossProduct", op: "mul", left: { input: "amountIn" }, right: { input: "backing" } },
  { name: "gross", op: "div", left: { local: "grossProduct" }, right: { input: "supply" } },
  { name: "liquid", op: "add", left: { input: "vaultIdle" }, right: { input: "strategyIdle" } },
  { name: "margin", op: "sub", left: { local: "liquid" }, right: { local: "gross" } },
  { name: "feeComplement", op: "sub", left: { constant: "200" }, right: { input: "feeBps" } },
  { name: "feeNumerator", op: "mul", left: { local: "gross" }, right: { local: "feeComplement" } },
  { name: "fee", op: "div", left: { local: "feeNumerator" }, right: { constant: "10000" } },
  { name: "net", op: "sub", left: { local: "gross" }, right: { local: "fee" } },
];

export const badgerSettWithdrawRuntimeMathModel: RuntimeMathModel = Object.freeze({
  id: "badger-sett-withdraw:runtime-terms",
  version: 1,
  inputs: Object.freeze(["amountIn", "backing", "supply", "vaultIdle", "strategyIdle", "feeBps"]),
  outputs: Object.freeze(["net"]),
  operations: Object.freeze(runtimeOperations),
});
