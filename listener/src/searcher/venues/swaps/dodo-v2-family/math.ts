import type { DeclarativeMathModel, MathValue } from "../../declarative-math.js";
import {
  DODO_DECIMAL_ONE,
  DODO_UINT256_MAX,
  checkedDodoInput,
  quoteDodoPmmExactInput,
  type DodoPmmState,
  type DodoRState,
} from "../dodo-pmm-math.js";
import {
  applyDodoTransferToInput,
  selectDodoProbeInput,
} from "./pricing-helpers.js";

/**
 * DODO V2 declarative math.
 *
 * These models are pure functions of already-observed PMM state, token
 * balances and bounded multicall rows. They never issue a request, encode a
 * call, decide admission or cache anything. The models reuse the existing
 * checked PMM port and the Family-owned bounded-probe selector so the JSON
 * definition and the handwritten entry cannot drift into two formulas.
 *
 * Input/output contracts (all amounts are uint256 `bigint`):
 *   dodo-v2:pmm-state@1        {values:[i,K,B,Q,B0,Q0,R]} -> {i,K,B,Q,B0,Q0,R:number}
 *   dodo-v2:fee-rates@1        {values:[lpFeeRate,mtFeeRate]} -> {lpFeeRate,mtFeeRate}
 *   dodo-v2:input-position@1   {pool,rows:[{success,returnData}]} -> {base,quote}
 *   dodo-v2:effective-input@1  {pool,position,transferAmount} -> bigint
 *   dodo-v2:probe-selection@1  probe selector input -> bigint | plan | unavailable
 *   dodo-v2:probe-quote@1      {pool,tokenIn,tokenOut,plan,rows} -> quote
 *   dodo-v2:pricing-snapshot@1 {core,selections,probes,routes,pool} -> snapshot
 *
 * `rows` are the decoded `aggregate3` `(bool success, bytes returnData)` rows;
 * ABI decoding itself stays in the declarative read flow.
 */

export const DODO_V2_PMM_STATE_MODEL = "dodo-v2:pmm-state";
export const DODO_V2_FEE_RATES_MODEL = "dodo-v2:fee-rates";
export const DODO_V2_INPUT_POSITION_MODEL = "dodo-v2:input-position";
export const DODO_V2_EFFECTIVE_INPUT_MODEL = "dodo-v2:effective-input";
export const DODO_V2_PROBE_SELECTION_MODEL = "dodo-v2:probe-selection";
export const DODO_V2_PROBE_QUOTE_MODEL = "dodo-v2:probe-quote";
export const DODO_V2_PRICING_SNAPSHOT_MODEL = "dodo-v2:pricing-snapshot";

function record(value: MathValue, label: string): Record<string, MathValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
    throw new Error(`dodo-v2 math: ${label} must be a record`);
  }
  return value as Record<string, MathValue>;
}

function array(value: MathValue, label: string): readonly MathValue[] {
  if (!Array.isArray(value)) throw new Error(`dodo-v2 math: ${label} must be a list`);
  return value;
}

function uint(value: MathValue, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > DODO_UINT256_MAX) {
    throw new Error(`dodo-v2 math: ${label} must be uint256`);
  }
  return value;
}

function address(value: MathValue, label: string): string {
  if (typeof value !== "string") throw new Error(`dodo-v2 math: ${label} must be an address`);
  return value;
}

function bool(value: MathValue, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`dodo-v2 math: ${label} must be boolean`);
  return value;
}

function text(value: MathValue, label: string): string {
  if (typeof value !== "string") throw new Error(`dodo-v2 math: ${label} must be a string`);
  return value;
}

function word(data: MathValue, label: string): bigint {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64,}$/.test(data)) {
    throw new Error(`dodo-v2 ${label} returned malformed data`);
  }
  return BigInt(`0x${data.slice(2, 66)}`);
}

function optionalWord(data: MathValue, label: string): bigint {
  return word(data, label);
}

function rWord(value: MathValue): DodoRState {
  const raw = typeof value === "number"
    ? (Number.isSafeInteger(value) ? BigInt(value) : undefined)
    : typeof value === "bigint" ? value : undefined;
  if (raw === undefined || raw < 0n || raw > 2n) {
    throw new Error(`dodo-v2 returned invalid PMM R state ${String(value)}`);
  }
  return Number(raw) as DodoRState;
}

function pmmState(value: MathValue): DodoPmmState {
  const input = record(value, "pmm-state input");
  const values = array(input.values, "pmm-state values");
  if (values.length !== 7) throw new Error("dodo-v2 pmm-state requires seven words");
  const i = uint(values[0]!, "pmm i");
  const K = uint(values[1]!, "pmm K");
  const B = uint(values[2]!, "pmm B");
  const Q = uint(values[3]!, "pmm Q");
  const B0 = uint(values[4]!, "pmm B0");
  const Q0 = uint(values[5]!, "pmm Q0");
  if (K > DODO_DECIMAL_ONE) throw new Error("dodo PMM K exceeds one");
  return Object.freeze({ i, K, B, Q, B0, Q0, R: rWord(values[6]!) });
}

function feeRates(value: MathValue): { readonly lpFeeRate: bigint; readonly mtFeeRate: bigint } {
  const input = record(value, "fee-rates input");
  const values = array(input.values, "fee-rates values");
  if (values.length !== 2) throw new Error("dodo-v2 fee-rates requires two words");
  const lpFeeRate = uint(values[0]!, "lp fee rate");
  const mtFeeRate = uint(values[1]!, "mt fee rate");
  if (lpFeeRate + mtFeeRate >= DODO_DECIMAL_ONE) {
    throw new Error("dodo-v2 actor fee rate is outside the PMM quote domain");
  }
  return Object.freeze({ lpFeeRate, mtFeeRate });
}

interface MulticallRow {
  readonly success: boolean;
  readonly returnData: string;
}

function rows(value: MathValue): readonly MulticallRow[] {
  const list = array(value, "multicall rows");
  return list.map((row, index) => {
    const item = record(row, `multicall row ${index}`);
    return Object.freeze({
      success: bool(item.success, `multicall row ${index} success`),
      returnData: text(item.returnData, `multicall row ${index} returnData`),
    });
  });
}

function inputPosition(modelInput: MathValue): unknown {
  const input = record(modelInput, "input-position input");
  const pool = address(input.pool, "input-position pool");
  const decoded = rows(input.rows);
  if (decoded.length !== 7) {
    throw new Error(`dodo-v2 input semantics ${pool} returned ${decoded.length}/7 results`);
  }
  const required = (index: number, label: string): string => {
    const row = decoded[index]!;
    if (!row.success || row.returnData === "0x") throw new Error(`dodo-v2 multicall item ${label} failed`);
    return row.returnData;
  };
  const optional = (index: number): string | null => {
    const row = decoded[index]!;
    return row.success && row.returnData !== "0x" ? row.returnData : null;
  };
  const baseBalance = optionalWord(required(0, "base-balance"), "base balance");
  const quoteBalance = optionalWord(required(1, "quote-balance"), "quote balance");
  const baseReserve = optionalWord(required(2, "base-reserve"), "base reserve");
  const quoteReserve = optionalWord(required(3, "quote-reserve"), "quote reserve");
  const baseInput = optional(4);
  const quoteInput = optional(5);
  const mtFeeRaw = optional(6);
  let baseMtFee = 0n;
  let quoteMtFee = 0n;
  if (mtFeeRaw !== null) {
    if (!/^0x[0-9a-fA-F]{128,}$/.test(mtFeeRaw)) throw new Error("dodo-v2 mt fee total returned malformed data");
    baseMtFee = BigInt(`0x${mtFeeRaw.slice(2, 66)}`);
    quoteMtFee = BigInt(`0x${mtFeeRaw.slice(66, 130)}`);
  }
  return Object.freeze({
    base: resolvePosition({
      pool, side: "base", balance: baseBalance, reserve: baseReserve,
      accumulatedMtFee: baseMtFee, getterData: baseInput, hasMtFeeLedger: mtFeeRaw !== null,
    }),
    quote: resolvePosition({
      pool, side: "quote", balance: quoteBalance, reserve: quoteReserve,
      accumulatedMtFee: quoteMtFee, getterData: quoteInput, hasMtFeeLedger: mtFeeRaw !== null,
    }),
  });
}

function resolvePosition(input: {
  readonly pool: string;
  readonly side: "base" | "quote";
  readonly balance: bigint;
  readonly reserve: bigint;
  readonly accumulatedMtFee: bigint;
  readonly getterData: string | null;
  readonly hasMtFeeLedger: boolean;
}): { readonly surplus: bigint; readonly deficit: bigint } {
  const liability = checkedDodoInput(input.reserve, input.accumulatedMtFee, input.pool);
  if (input.getterData !== null) {
    if (input.balance < liability) {
      throw new Error(
        `dodo-v2 ${input.side} input getter succeeded below its proven liability for pool ${input.pool}`,
      );
    }
    const expected = input.balance - liability;
    const getter = optionalWord(input.getterData, `${input.side} input`);
    if (getter !== expected) {
      throw new Error(`dodo-v2 ${input.side} input semantics mismatch for pool ${input.pool}`);
    }
    return Object.freeze({ surplus: getter, deficit: 0n });
  }
  if (input.balance >= liability) {
    throw new Error(
      `dodo-v2 ${input.side} input getter reverted without a proven deficit for ` +
        `${input.hasMtFeeLedger ? "GSP" : "legacy"} pool ${input.pool}`,
    );
  }
  return Object.freeze({ surplus: 0n, deficit: liability - input.balance });
}

function position(value: MathValue): { readonly surplus: bigint; readonly deficit: bigint } {
  const input = record(value, "position");
  return Object.freeze({
    surplus: uint(input.surplus, "position surplus"),
    deficit: uint(input.deficit, "position deficit"),
  });
}

function effectiveInput(modelInput: MathValue): bigint {
  const input = record(modelInput, "effective-input input");
  return applyDodoTransferToInput(
    position(input.position),
    uint(input.transferAmount, "transfer amount"),
    address(input.pool, "effective-input pool"),
  );
}

function probeSelection(modelInput: MathValue): unknown {
  const input = record(modelInput, "probe-selection input");
  return selectDodoProbeInput({
    oneToken: uint(input.oneToken, "one token"),
    currentInput: uint(input.currentInput, "current input"),
    inputDeficit: uint(input.inputDeficit, "input deficit"),
    reserve: uint(input.reserve, "reserve"),
    pmm: pmmState({ values: input.pmm === undefined ? [] : [
      (input.pmm as Record<string, MathValue>).i,
      (input.pmm as Record<string, MathValue>).K,
      (input.pmm as Record<string, MathValue>).B,
      (input.pmm as Record<string, MathValue>).Q,
      (input.pmm as Record<string, MathValue>).B0,
      (input.pmm as Record<string, MathValue>).Q0,
      (input.pmm as Record<string, MathValue>).R,
    ] }),
    sellBase: bool(input.sellBase, "sell base"),
    pool: address(input.pool, "probe-selection pool"),
    lpFeeRate: uint(input.lpFeeRate, "lp fee rate"),
    mtFeeRate: uint(input.mtFeeRate, "mt fee rate"),
  });
}

function probeQuote(modelInput: MathValue): unknown {
  const input = record(modelInput, "probe-quote input");
  const pool = address(input.pool, "probe-quote pool");
  const tokenIn = address(input.tokenIn, "probe-quote tokenIn");
  const tokenOut = address(input.tokenOut, "probe-quote tokenOut");
  const plan = record(input.plan, "probe-quote plan");
  const candidates = array(plan.candidates, "probe-quote candidates");
  const decoded = rows(input.rows);
  if (decoded.length !== candidates.length) {
    throw new Error(`dodo-v2 bounded probe ${pool} returned ${decoded.length}/${candidates.length} results`);
  }
  for (let index = 0; index < candidates.length; index++) {
    const candidate = record(candidates[index]!, `probe candidate ${index}`);
    const result = decoded[index]!;
    if (!result.success) continue;
    const amountOut = optionalWord(result.returnData, `probe-${index} ${pool}`);
    if (amountOut <= 0n) continue;
    return Object.freeze({
      transferAmount: uint(candidate.transferAmount, "candidate transfer amount"),
      effectiveInput: uint(candidate.effectiveInput, "candidate effective input"),
      amountOut,
    });
  }
  throw new Error(
    `dodo-v2 current bounded probe found no positive quote for ` +
      `${tokenIn}->${tokenOut}: ${text(plan.reason, "probe reason")}`,
  );
}

function pricingSnapshot(modelInput: MathValue): unknown {
  const input = record(modelInput, "pricing-snapshot input");
  const pool = address(input.pool, "pricing-snapshot pool");
  const core = record(input.core, "pricing-snapshot core");
  const pmm = pmmState({ values: [
    (core.pmm as Record<string, MathValue>).i,
    (core.pmm as Record<string, MathValue>).K,
    (core.pmm as Record<string, MathValue>).B,
    (core.pmm as Record<string, MathValue>).Q,
    (core.pmm as Record<string, MathValue>).B0,
    (core.pmm as Record<string, MathValue>).Q0,
    (core.pmm as Record<string, MathValue>).R,
  ] });
  const lpFeeRate = uint(core.lpFeeRate, "pricing lp fee rate");
  const mtFeeRate = uint(core.mtFeeRate, "pricing mt fee rate");
  const base = position(core.base);
  const quote = position(core.quote);
  const selections = array(input.selections, "pricing selections");
  const probes = array(input.probes, "pricing probes");
  const routes = array(input.routes, "pricing routes");
  const quotes: Record<string, unknown> = {};
  const unavailable: Record<string, string> = {};
  const probeByRoute = new Map<string, { readonly transferAmount: bigint; readonly effectiveInput: bigint; readonly amountOut: bigint }>();
  for (const item of probes) {
    const row = record(item, "pricing probe");
    probeByRoute.set(text(row.routeKey, "probe routeKey"), {
      transferAmount: uint(row.transferAmount, "probe transfer amount"),
      effectiveInput: uint(row.effectiveInput, "probe effective input"),
      amountOut: uint(row.amountOut, "probe amountOut"),
    });
  }
  for (const item of routes) {
    const route = record(item, "pricing route");
    const routeKey = text(route.routeKey, "routeKey");
    const direction = text(route.direction, "direction");
    const tokenIn = address(route.tokenIn, "tokenIn");
    const tokenOut = address(route.tokenOut, "tokenOut");
    const selected = selections.find(candidate => {
      const row = record(candidate, "pricing selection");
      return row.routeKey === routeKey;
    });
    if (selected === undefined) throw new Error(`dodo-v2 pricing selection missing for ${routeKey}`);
    const declaration = record(selected, "pricing selection");
    const selection = declaration.selection as MathValue;
    const sellBase = direction === "sell-base";
    if (typeof selection === "bigint") {
      const positionValue = sellBase ? base : quote;
      const effective = applyDodoTransferToInput(positionValue, selection, pool);
      const local = quoteDodoPmmExactInput({
        state: pmm, sellBase, payAmount: effective, lpFeeRate, mtFeeRate,
      });
      if (local.status !== "quote" || local.amountOut <= 0n) {
        throw new Error(`dodo-v2 local selection contract changed for ${tokenIn}->${tokenOut}`);
      }
      quotes[routeKey] = Object.freeze({ amountIn: selection, amountOut: local.amountOut });
      continue;
    }
    const detail = record(selection, "pricing selection detail");
    const kind = text(detail.kind, "selection kind");
    if (kind === "provably-unavailable") {
      unavailable[routeKey] = text(detail.reason, "unavailable reason");
      continue;
    }
    if (kind !== "bounded-onchain-probe") throw new Error(`dodo-v2 unknown probe selection for ${routeKey}`);
    const probe = probeByRoute.get(routeKey);
    if (probe === undefined) {
      throw new Error(
        `dodo-v2 current bounded probe found no positive quote for ` +
          `${tokenIn}->${tokenOut}: ${text(detail.reason, "probe reason")}`,
      );
    }
    const candidates = array(detail.candidates, "probe candidates");
    if (!candidates.some(candidate => {
      const row = record(candidate, "probe candidate");
      return row.transferAmount === probe.transferAmount && row.effectiveInput === probe.effectiveInput;
    })) {
      throw new Error(`dodo-v2 bounded probe candidate mismatch for ${tokenIn}->${tokenOut}`);
    }
    quotes[routeKey] = Object.freeze({ amountIn: probe.transferAmount, amountOut: probe.amountOut });
  }
  return Object.freeze({
    source: core.source,
    pmm,
    lpFeeRate,
    mtFeeRate,
    baseInput: base,
    quoteInput: quote,
    quotes: Object.freeze(quotes),
    unavailable: Object.freeze(unavailable),
  });
}

function model(id: string, evaluate: (value: MathValue) => unknown): DeclarativeMathModel {
  return Object.freeze({
    id,
    version: 1,
    validateInput() { /* shape is asserted by the evaluator, not silently coerced */ },
    evaluate: evaluate as (value: MathValue) => MathValue,
    validateOutput() { /* lossless output is enforced by the registry */ },
  });
}

export const dodoV2MathModels: readonly DeclarativeMathModel[] = Object.freeze([
  model(DODO_V2_PMM_STATE_MODEL, value => pmmState(value)),
  model(DODO_V2_FEE_RATES_MODEL, value => feeRates(value)),
  model(DODO_V2_INPUT_POSITION_MODEL, value => inputPosition(value)),
  model(DODO_V2_EFFECTIVE_INPUT_MODEL, value => effectiveInput(value)),
  model(DODO_V2_PROBE_SELECTION_MODEL, value => probeSelection(value)),
  model(DODO_V2_PROBE_QUOTE_MODEL, value => probeQuote(value)),
  model(DODO_V2_PRICING_SNAPSHOT_MODEL, value => pricingSnapshot(value)),
]);
