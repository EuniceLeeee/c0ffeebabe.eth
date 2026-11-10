import { ethers } from "ethers";
import type { DeclarativeMathModel, MathValue } from "../../../declarative-math.js";
import type { RuntimeMathModel } from "../../../declarative-runtime-math.js";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { EKUBO_CORE } from "../ekubo/abi.js";
import { decodeQuote, decodeSizingProbe, decodeInitialized } from "./codec.js";
import { ekuboPoolId, type EkuboPoolKey } from "../ekubo/pool-key.js";

/**
 * Pure declarative adapters for the Ekubo router family. All protocol meaning
 * stays in the retained family codec/pool-key modules; these models only adapt
 * already-read quote results, sizing arithmetic and the anonymous Core swap
 * payload to lossless declarative data. They perform no transport, encoding,
 * admission or settlement decisions.
 */
type Data = Readonly<Record<string, any>>;
const MAX_UINT256 = (1n << 256n) - 1n;
const INT128_MODULUS = 1n << 128n;
const INT128_MASK = INT128_MODULUS - 1n;
const INT128_SIGN = 1n << 127n;

function record(value: MathValue, label: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`ekubo math: ${label} must be a record`);
  }
  return value as Data;
}
function array(value: MathValue, label: string): readonly MathValue[] {
  if (!Array.isArray(value)) throw new Error(`ekubo math: ${label} must be an array`);
  return value;
}
function bool(value: MathValue, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`ekubo math: ${label} must be a boolean`);
  return value;
}
function text(value: MathValue, label: string): string {
  if (typeof value !== "string") throw new Error(`ekubo math: ${label} must be a string`);
  return value;
}
function uint(value: MathValue, label: string): bigint {
  const parsed = typeof value === "bigint" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256) throw new Error(`ekubo math: ${label} must be uint256`);
  return parsed;
}
function addr(value: MathValue, label: string): string {
  try { return ethers.getAddress(text(value, label)).toLowerCase(); }
  catch { throw new Error(`ekubo math: ${label} must be an address`); }
}
function bytes32(value: MathValue, label: string): string {
  const parsed = text(value, label).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(parsed)) throw new Error(`ekubo math: ${label} must be bytes32`);
  return parsed;
}
function source(value: MathValue): CanonicalSource {
  const row = record(value, "source");
  if (!Number.isSafeInteger(row.number) || row.number < 0 || !Number.isSafeInteger(row.generation) ||
      row.generation < 0 || typeof row.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.hash))
    throw new Error("ekubo math: invalid canonical source");
  return Object.freeze({ number: row.number, hash: row.hash.toLowerCase(), generation: row.generation });
}
function poolKey(value: MathValue): EkuboPoolKey {
  const key = record(value, "poolKey");
  return Object.freeze({ token0: addr(key.token0, "token0"), token1: addr(key.token1, "token1"), config: bytes32(key.config, "config") });
}
function descriptor(value: MathValue): Data {
  const d = record(value, "descriptor");
  const key = poolKey(d.poolKey);
  if (bytes32(d.poolId, "poolId") !== ekuboPoolId(key)) throw new Error("ekubo math: descriptor pool id mismatch");
  const decimals = array(d.decimals, "decimals");
  if (decimals.length !== 2 || decimals.some(value => !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 36))
    throw new Error("ekubo math: descriptor decimals");
  return { ...d, poolKey: key, token0: key.token0, token1: key.token1, config: key.config };
}
function route(value: MathValue): Data {
  const r = record(value, "route");
  return { ...r, isToken1: bool(r.isToken1, "isToken1"), direction: text(r.direction, "direction"),
    routeKey: text(r.routeKey, "routeKey") };
}
function resultsFor(value: MathValue): readonly AdapterRequestResult[] {
  return array(value, "results") as unknown as readonly AdapterRequestResult[];
}
function result(results: readonly AdapterRequestResult[], id: string): AdapterRequestResult {
  const rows = results.filter(row => row.id === id);
  if (rows.length !== 1) throw new Error(`ekubo math: missing/duplicate result ${id}`);
  return rows[0]!;
}
function returned(results: readonly AdapterRequestResult[], id: string): string {
  const row = result(results, id);
  if (!row.ok || row.completion !== "returned") throw new Error(`ekubo math: unresolved result ${id}`);
  return row.data;
}
function oneSource(results: readonly AdapterRequestResult[]): CanonicalSource {
  const first = results[0];
  if (!first) throw new Error("ekubo math: empty results");
  const canonical = source(first.source as unknown as MathValue);
  for (const row of results) if (source(row.source as unknown as MathValue).hash !== canonical.hash ||
    source(row.source as unknown as MathValue).number !== canonical.number ||
    source(row.source as unknown as MathValue).generation !== canonical.generation)
    throw new Error("ekubo math: foreign result source");
  return canonical;
}
function probe(data: string, isToken1: boolean, amountIn: bigint) {
  const decoded = decodeSizingProbe(data, isToken1, amountIn);
  return Object.freeze({ filled: decoded.filledAmountIn, amountOut: decoded.amountOut,
    stateAfter: decoded.stateAfter, exact: decoded.filledAmountIn === amountIn });
}

const probeModel: DeclarativeMathModel = {
  id: "ekubo:probe",
  version: 1,
  validateInput(value) {
    const input = record(value, "probe input");
    if (Object.keys(input).some(key => !["data", "isToken1", "amountIn"].includes(key))) throw new Error("ekubo math: unknown probe input field");
    text(input.data, "data"); bool(input.isToken1, "isToken1"); uint(input.amountIn, "amountIn");
  },
  evaluate(value) {
    const input = record(value, "probe input");
    return Object.freeze(probe(text(input.data, "data"), bool(input.isToken1, "isToken1"), uint(input.amountIn, "amountIn")));
  },
  validateOutput(value) {
    const output = record(value, "probe output");
    if (uint(output.filled, "filled") > (1n << 127n) || uint(output.amountOut, "amountOut") === 0n ||
        typeof output.stateAfter !== "string" || !/^0x[0-9a-f]{64}$/.test(output.stateAfter) || typeof output.exact !== "boolean")
      throw new Error("ekubo math: invalid probe output");
  },
};

const unitsModel: DeclarativeMathModel = {
  id: "ekubo:units",
  version: 1,
  validateInput(value) {
    const input = record(value, "units input");
    if (Object.keys(input).some(key => !["descriptor", "route", "results"].includes(key))) throw new Error("ekubo math: unknown units input field");
    descriptor(input.descriptor); route(input.route); resultsFor(input.results);
  },
  evaluate(value) {
    const input = record(value, "units input");
    const d = descriptor(input.descriptor), r = route(input.route), results = resultsFor(input.results);
    const source_ = oneSource(results);
    const decimals = d.decimals as readonly number[];
    const unitIn = 10n ** BigInt(decimals[r.isToken1 ? 1 : 0]!);
    const unitOut = 10n ** BigInt(decimals[r.isToken1 ? 0 : 1]!);
    const forward = probe(returned(results, `unit-in:${r.direction}`), r.isToken1, unitIn);
    const reverse = probe(returned(results, `unit-out:${r.direction}`), !r.isToken1, unitOut);
    const witnessed = forward.filled > reverse.amountOut ? forward.filled : reverse.amountOut;
    const depthIn = witnessed / 4n > 0n ? witnessed / 4n : 1n;
    const amountIn = depthIn / 10_000n > 0n ? depthIn / 10_000n : 1n;
    return Object.freeze({ source: source_, unitIn, unitOut, witness: witnessed, depthIn, amountIn } as unknown as MathValue);
  },
  validateOutput(value) {
    const output = record(value, "units output");
    source(output.source);
    for (const field of ["unitIn", "unitOut", "depthIn", "amountIn"] as const) uint(output[field], field);
  },
};

const probeSizesModel: DeclarativeMathModel = {
  id: "ekubo:probe-sizes",
  version: 1,
  validateInput(value) {
    const input = record(value, "probe sizes input");
    if (Object.keys(input).some(key => !["descriptor", "route", "units", "results"].includes(key))) throw new Error("ekubo math: unknown probe sizes field");
    descriptor(input.descriptor); route(input.route); record(input.units, "units"); resultsFor(input.results);
  },
  evaluate(value) {
    const input = record(value, "probe sizes input");
    const r = route(input.route), units = record(input.units, "units"), results = resultsFor(input.results);
    const depthIn = uint(units.depthIn, "depthIn"), baseAmount = uint(units.amountIn, "amountIn");
    const observed = probe(returned(results, `current-depth:${r.direction}`), r.isToken1, depthIn);
    if (observed.filled === depthIn) return Object.freeze({ source: oneSource(results), retry: false, amountIn: baseAmount, depthIn } as unknown as MathValue);
    const nextDepth = observed.filled / 4n > 0n ? observed.filled / 4n : 1n;
    const ceiling = nextDepth / 2n > 0n ? nextDepth / 2n : 1n;
    const amountIn = baseAmount < ceiling ? baseAmount : ceiling;
    return Object.freeze({ source: oneSource(results), retry: true, amountIn, depthIn: nextDepth } as unknown as MathValue);
  },
  validateOutput(value) {
    const output = record(value, "probe sizes output");
    source(output.source); if (typeof output.retry !== "boolean") throw new Error("ekubo math: retry flag");
    uint(output.amountIn, "amountIn"); uint(output.depthIn, "depthIn");
  },
};

const retrySizesModel: DeclarativeMathModel = {
  id: "ekubo:retry-sizes",
  version: 1,
  validateInput(value) {
    const input = record(value, "retry sizes input");
    if (Object.keys(input).some(key => !["descriptor", "route", "probe", "results"].includes(key))) throw new Error("ekubo math: unknown retry sizes field");
    route(input.route); record(input.probe, "probe"); resultsFor(input.results);
  },
  evaluate(value) {
    const input = record(value, "retry sizes input");
    const probeSizes = record(input.probe, "probe"), results = resultsFor(input.results);
    if (probeSizes.retry !== true)
      return Object.freeze({ source: source(probeSizes.source as unknown as MathValue), retry: false } as unknown as MathValue);
    if (results.length === 0) throw new Error("ekubo math: retry requires results");
    return Object.freeze({ source: oneSource(results), retry: true } as unknown as MathValue);
  },
  validateOutput(value) {
    const output = record(value, "retry sizes output");
    source(output.source); if (typeof output.retry !== "boolean") throw new Error("ekubo math: retry flag");
  },
};

const snapshotModel: DeclarativeMathModel = {
  id: "ekubo:pricing-snapshot",
  version: 1,
  validateInput(value) {
    const input = record(value, "snapshot input");
    if (Object.keys(input).some(key => !["descriptor", "route", "probe", "retry", "probeResults", "retryResults"].includes(key)))
      throw new Error("ekubo math: unknown snapshot field");
    descriptor(input.descriptor); route(input.route); record(input.probe, "probe"); record(input.retry, "retry");
    resultsFor(input.probeResults); resultsFor(input.retryResults);
  },
  evaluate(value) {
    const input = record(value, "snapshot input");
    const r = route(input.route), probeSizes = record(input.probe, "probe");
    const retry = probeSizes.retry === true;
    const sizes = { amountIn: uint(probeSizes.amountIn, "amountIn"), depthIn: uint(probeSizes.depthIn, "depthIn") };
    const results = resultsFor(retry ? input.retryResults : input.probeResults);
    const suffix = retry ? "-retry" : "";
    const small = decodeQuote(returned(results, `current-small${suffix}:${r.direction}`), r.isToken1, sizes.amountIn);
    const depth = decodeQuote(returned(results, `current-depth${suffix}:${r.direction}`), r.isToken1, sizes.depthIn);
    if (depth.amountOut < small.amountOut) throw new Error("ekubo math: inconsistent current quote depth");
    return Object.freeze({ source: oneSource(results), amountIn: sizes.amountIn, amountOut: small.amountOut,
      depthIn: sizes.depthIn, depthOut: depth.amountOut, stateAfter: small.stateAfter } as unknown as MathValue);
  },
  validateOutput(value) {
    const output = record(value, "snapshot output");
    source(output.source);
    for (const field of ["amountIn", "amountOut", "depthIn", "depthOut"] as const) {
      if (uint(output[field], field) === 0n) throw new Error(`ekubo math: ${field} must be positive`);
    }
    if (!/^0x[0-9a-f]{64}$/.test(text(output.stateAfter, "stateAfter"))) throw new Error("ekubo math: snapshot state");
  },
};

const exactQuoteModel: DeclarativeMathModel = {
  id: "ekubo:exact-quote",
  version: 1,
  validateInput(value) {
    const input = record(value, "exact quote input");
    if (Object.keys(input).some(key => !["data", "isToken1", "amountIn"].includes(key))) throw new Error("ekubo math: unknown exact quote field");
    text(input.data, "data"); bool(input.isToken1, "isToken1"); uint(input.amountIn, "amountIn");
  },
  evaluate(value) {
    const input = record(value, "exact quote input");
    const decoded = decodeQuote(text(input.data, "data"), bool(input.isToken1, "isToken1"), uint(input.amountIn, "amountIn"));
    return Object.freeze({ amountOut: decoded.amountOut, stateAfter: decoded.stateAfter } as unknown as MathValue);
  },
  validateOutput(value) {
    const output = record(value, "exact quote output");
    if (uint(output.amountOut, "amountOut") === 0n) throw new Error("ekubo math: exact amountOut must be positive");
    if (!/^0x[0-9a-f]{64}$/.test(text(output.stateAfter, "stateAfter"))) throw new Error("ekubo math: exact state");
  },
};

const coreSwapLogModel: DeclarativeMathModel = {
  id: "ekubo:core-swap-log",
  version: 1,
  validateInput(value) {
    const input = record(value, "core swap input");
    if (Object.keys(input).some(key => !["balanceUpdate"].includes(key))) throw new Error("ekubo math: unknown core swap field");
    bytes32(input.balanceUpdate, "balanceUpdate");
  },
  evaluate(value) {
    const input = record(value, "core swap input");
    const packed = BigInt(bytes32(input.balanceUpdate, "balanceUpdate"));
    const raw0 = packed >> 128n, raw1 = packed & INT128_MASK;
    const delta0 = raw0 >= INT128_SIGN ? raw0 - INT128_MODULUS : raw0;
    const delta1 = raw1 >= INT128_SIGN ? raw1 - INT128_MODULUS : raw1;
    const positive0 = delta0 > 0n, positive1 = delta1 > 0n, negative0 = delta0 < 0n, negative1 = delta1 < 0n;
    if ((positive0 && positive1) || (negative0 && negative1)) throw new Error("ekubo math: invalid signed swap deltas");
    const isToken1 = positive1 && negative0;
    const directed = isToken1 || positive0 && negative1;
    return Object.freeze({
      delta0, delta1, isToken1, directed,
      amountIn: directed ? (isToken1 ? delta1 : delta0) : 0n,
      amountOut: directed ? (isToken1 ? -delta0 : -delta1) : 0n,
    } as unknown as MathValue);
  },
  validateOutput(value) {
    const output = record(value, "core swap output");
    if (typeof output.isToken1 !== "boolean" || typeof output.directed !== "boolean") throw new Error("ekubo math: swap direction");
    if (output.directed === true && (uint(output.amountIn, "amountIn") === 0n || uint(output.amountOut, "amountOut") === 0n))
      throw new Error("ekubo math: directed flow must be positive");
  },
};

const initLogModel: DeclarativeMathModel = {
  id: "ekubo:init-log",
  version: 1,
  validateInput(value) {
    const input = record(value, "init log input");
    if (Object.keys(input).some(key => !["topics", "data"].includes(key))) throw new Error("ekubo math: unknown init log field");
    array(input.topics, "topics"); text(input.data, "data");
  },
  evaluate(value) {
    const input = record(value, "init log input");
    const log = { address: EKUBO_CORE, topics: array(input.topics, "topics").map(topic => text(topic, "topic")), data: text(input.data, "data") };
    const found = decodeInitialized(log);
    return found ? Object.freeze({ poolId: found.poolId, poolKey: { ...found.poolKey } } as unknown as MathValue) : null;
  },
  validateOutput(value) {
    if (value === null) return;
    const output = record(value, "init log output");
    poolKey(output.poolKey); bytes32(output.poolId, "poolId");
  },
};

const lowerModel: DeclarativeMathModel = {
  id: "ekubo:graph-token",
  version: 1,
  validateInput(value) {
    const input = record(value, "graph token input");
    if (Object.keys(input).some(key => !["token"].includes(key))) throw new Error("ekubo math: unknown graph token field");
    addr(input.token, "token");
  },
  evaluate(value) {
    const input = record(value, "graph token input");
    const token = addr(input.token, "token");
    return token === ethers.ZeroAddress ? STATIC_WETH : token;
  },
  validateOutput(value) { addr(value, "graph token"); },
};

const STATIC_WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

export const ekuboMathModels: readonly DeclarativeMathModel[] = Object.freeze([
  probeModel, unitsModel, probeSizesModel, retrySizesModel, snapshotModel,
  exactQuoteModel, coreSwapLogModel, initLogModel, lowerModel,
]);

/** Swap balance-update decode for the direct ERC-20 execution path. `flag` is 1
 * for isToken1 and 0 otherwise; the flag arithmetic preserves the retained
 * program's exact specified/magnitude comparisons without a conditional op. */
export const ekuboSwapReturnRuntimeMathModel: RuntimeMathModel = {
  id: "ekubo:swap-return",
  version: 1,
  inputs: ["word", "flag"],
  outputs: ["specified", "magnitude", "calculatedHigh"],
  operations: [
    { name: "high", op: "shr", left: { input: "word" }, right: { constant: "128" } },
    { name: "low", op: "and", left: { input: "word" }, right: { constant: INT128_MASK.toString() } },
    { name: "inverse", op: "sub", left: { constant: "1" }, right: { input: "flag" } },
    { name: "lowSelected", op: "mul", left: { local: "low" }, right: { input: "flag" } },
    { name: "highSelected", op: "mul", left: { local: "high" }, right: { local: "inverse" } },
    { name: "specified", op: "add", left: { local: "lowSelected" }, right: { local: "highSelected" } },
    { name: "highSelectedCalc", op: "mul", left: { local: "high" }, right: { input: "flag" } },
    { name: "lowSelectedCalc", op: "mul", left: { local: "low" }, right: { local: "inverse" } },
    { name: "calculated", op: "add", left: { local: "highSelectedCalc" }, right: { local: "lowSelectedCalc" } },
    { name: "magnitude", op: "sub", left: { constant: INT128_MODULUS.toString() }, right: { local: "calculated" } },
    { name: "calculatedHigh", op: "shr", left: { local: "magnitude" }, right: { constant: "127" } },
  ],
};
