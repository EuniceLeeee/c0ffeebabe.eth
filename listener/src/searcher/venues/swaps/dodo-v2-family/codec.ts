import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
  encodeMulticall,
  type MulticallItem,
} from "../blockscan-state-shared.js";
import {
  DODO_V2_ERC20_INTERFACE,
  DODO_V2_POOL_INTERFACE,
} from "../dodo-v2-abi.js";
import { checkedDodoInput, type DodoPmmState } from "../dodo-pmm-math.js";
import type { DodoInputPosition } from "./types.js";

export { BLOCKSCAN_MULTICALL3 } from "../blockscan-state-shared.js";
export {
  DODO_V2_ERC20_INTERFACE,
  DODO_V2_EVENT_INTERFACE,
  DODO_V2_POOL_INTERFACE,
  DODO_V2_REGISTRIES,
  DODO_V2_REGISTRY_INTERFACE,
  DODO_V2_SELL_BASE_SELECTOR,
  DODO_V2_SELL_QUOTE_SELECTOR,
  DODO_V2_SWAP_TOPIC,
} from "../dodo-v2-abi.js";

export function canonicalAddress(value: string): string {
  return ethers.getAddress(value);
}

export function lowerAddress(value: string): string {
  return canonicalAddress(value).toLowerCase();
}

export function sameAddress(left: string, right: string): boolean {
  return canonicalAddress(left) === canonicalAddress(right);
}

export function requireSuccessfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) {
    throw new Error(`dodo-v2 request result ${id} is missing`);
  }
  if (!result.ok) {
    throw new Error(`dodo-v2 request result ${id} is unresolved: ${result.failure}`);
  }
  if (result.completion !== "returned") {
    throw new Error(`dodo-v2 request result ${id} did not return normally`);
  }
  return result;
}

export function decodeAddressResult(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName: "_BASE_TOKEN_" | "_QUOTE_TOKEN_",
): string {
  const result = requireSuccessfulResult(results, id);
  if (!ethers.isHexString(result.data) || ethers.dataLength(result.data) !== 32) {
    throw new Error(`dodo-v2 request result ${id} has a non-canonical address shape`);
  }
  return canonicalAddress(String(
    DODO_V2_POOL_INTERFACE.decodeFunctionResult(functionName, result.data)[0],
  ));
}

export function decodeDodoPmmState(data: string): DodoPmmState {
  const decoded = DODO_V2_POOL_INTERFACE.decodeFunctionResult(
    "getPMMStateForCall",
    data,
  );
  const R = Number(decoded[6]);
  if (!Number.isInteger(R) || R < 0 || R > 2) {
    throw new Error(`dodo-v2 returned invalid PMM R state ${R}`);
  }
  return Object.freeze({
    i: BigInt(decoded[0]),
    K: BigInt(decoded[1]),
    B: BigInt(decoded[2]),
    Q: BigInt(decoded[3]),
    B0: BigInt(decoded[4]),
    Q0: BigInt(decoded[5]),
    R: R as DodoPmmState["R"],
  });
}

export function decodeFeeRates(data: string): {
  readonly lpFeeRate: bigint;
  readonly mtFeeRate: bigint;
} {
  const decoded = DODO_V2_POOL_INTERFACE.decodeFunctionResult(
    "getUserFeeRate",
    data,
  );
  const lpFeeRate = BigInt(decoded[0]);
  const mtFeeRate = BigInt(decoded[1]);
  if (lpFeeRate + mtFeeRate >= 10n ** 18n) {
    throw new Error("dodo-v2 actor fee rate is outside the PMM quote domain");
  }
  return Object.freeze({ lpFeeRate, mtFeeRate });
}

export function decodeDecimalsResult(
  results: readonly AdapterRequestResult[],
  id: string,
): bigint {
  const result = requireSuccessfulResult(results, id);
  const decimals = Number(
    DODO_V2_ERC20_INTERFACE.decodeFunctionResult("decimals", result.data)[0],
  );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`dodo-v2 request result ${id} has invalid decimals ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

export function decodeFirstWord(data: string, label: string): bigint {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(data)) {
    throw new Error(`dodo-v2 ${label} returned malformed data`);
  }
  return BigInt(`0x${data.slice(2, 66)}`);
}

export function inputSemanticsCall(input: {
  readonly pool: string;
  readonly baseToken: string;
  readonly quoteToken: string;
}): { readonly to: string; readonly data: string } {
  return Object.freeze({
    to: BLOCKSCAN_MULTICALL3,
    data: encodeMulticall(inputSemanticsItems(input)),
  });
}

export function decodeInputSemanticsResult(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly pool: string;
  readonly baseToken: string;
  readonly quoteToken: string;
}): {
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
} {
  const items = inputSemanticsItems(input);
  const decoded = blockScanMulticallIface.decodeFunctionResult(
    "aggregate3",
    input.result.data,
  )[0] as readonly { readonly success: boolean; readonly returnData: string }[];
  if (decoded.length !== items.length) {
    throw new Error(
      `dodo-v2 input semantics ${input.pool} returned ` +
        `${decoded.length}/${items.length} results`,
    );
  }
  const results = new Map<string, {
    readonly success: boolean;
    readonly returnData: string;
  }>();
  for (let index = 0; index < items.length; index++) {
    results.set(items[index].label, Object.freeze({
      success: Boolean(decoded[index].success),
      returnData: String(decoded[index].returnData),
    }));
  }
  return resolveInputSemantics(results, input.pool);
}

export function assertSameSource(
  results: readonly Extract<AdapterRequestResult, { readonly ok: true }>[],
): void {
  const first = results[0]?.source;
  if (first === undefined) throw new Error("dodo-v2 request result set is empty");
  for (const result of results.slice(1)) {
    if (
      result.source.number !== first.number ||
      result.source.hash.toLowerCase() !== first.hash.toLowerCase() ||
      result.source.generation !== first.generation
    ) {
      throw new Error("dodo-v2 reads came from different canonical sources");
    }
  }
}

function inputSemanticsItems(input: {
  readonly pool: string;
  readonly baseToken: string;
  readonly quoteToken: string;
}): readonly MulticallItem[] {
  const pool = canonicalAddress(input.pool);
  const baseToken = canonicalAddress(input.baseToken);
  const quoteToken = canonicalAddress(input.quoteToken);
  return Object.freeze([
    {
      label: "base-balance",
      target: baseToken,
      callData: DODO_V2_ERC20_INTERFACE.encodeFunctionData("balanceOf", [pool]),
      allowFailure: false,
    },
    {
      label: "quote-balance",
      target: quoteToken,
      callData: DODO_V2_ERC20_INTERFACE.encodeFunctionData("balanceOf", [pool]),
      allowFailure: false,
    },
    {
      label: "base-reserve",
      target: pool,
      callData: DODO_V2_POOL_INTERFACE.encodeFunctionData("_BASE_RESERVE_"),
      allowFailure: false,
    },
    {
      label: "quote-reserve",
      target: pool,
      callData: DODO_V2_POOL_INTERFACE.encodeFunctionData("_QUOTE_RESERVE_"),
      allowFailure: false,
    },
    {
      label: "base-input",
      target: pool,
      callData: DODO_V2_POOL_INTERFACE.encodeFunctionData("getBaseInput"),
      allowFailure: true,
    },
    {
      label: "quote-input",
      target: pool,
      callData: DODO_V2_POOL_INTERFACE.encodeFunctionData("getQuoteInput"),
      allowFailure: true,
    },
    {
      label: "mt-fee-total",
      target: pool,
      callData: DODO_V2_POOL_INTERFACE.encodeFunctionData("getMtFeeTotal"),
      allowFailure: true,
    },
  ]);
}

function resolveInputSemantics(
  results: ReadonlyMap<string, {
    readonly success: boolean;
    readonly returnData: string;
  }>,
  pool: string,
): {
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
} {
  const baseBalance = decodeFirstWord(required(results, "base-balance"), "base balance");
  const quoteBalance = decodeFirstWord(required(results, "quote-balance"), "quote balance");
  const baseReserve = decodeFirstWord(required(results, "base-reserve"), "base reserve");
  const quoteReserve = decodeFirstWord(required(results, "quote-reserve"), "quote reserve");
  const mtFeeRaw = optional(results, "mt-fee-total");
  const mtFees = mtFeeRaw === null
    ? null
    : DODO_V2_POOL_INTERFACE.decodeFunctionResult("getMtFeeTotal", mtFeeRaw);
  return Object.freeze({
    baseInput: resolveInputPosition({
      pool,
      side: "base",
      balance: baseBalance,
      reserve: baseReserve,
      accumulatedMtFee: mtFees === null ? 0n : BigInt(mtFees[0]),
      getterData: optional(results, "base-input"),
      hasMtFeeLedger: mtFees !== null,
    }),
    quoteInput: resolveInputPosition({
      pool,
      side: "quote",
      balance: quoteBalance,
      reserve: quoteReserve,
      accumulatedMtFee: mtFees === null ? 0n : BigInt(mtFees[1]),
      getterData: optional(results, "quote-input"),
      hasMtFeeLedger: mtFees !== null,
    }),
  });
}

function resolveInputPosition(input: {
  readonly pool: string;
  readonly side: "base" | "quote";
  readonly balance: bigint;
  readonly reserve: bigint;
  readonly accumulatedMtFee: bigint;
  readonly getterData: string | null;
  readonly hasMtFeeLedger: boolean;
}): DodoInputPosition {
  const liability = checkedDodoInput(
    input.reserve,
    input.accumulatedMtFee,
    input.pool,
  );
  if (input.getterData !== null) {
    if (input.balance < liability) {
      throw new Error(
        `dodo-v2 ${input.side} input getter succeeded below its proven liability ` +
          `for pool ${input.pool}`,
      );
    }
    const expected = input.balance - liability;
    const getter = decodeFirstWord(input.getterData, `${input.side} input`);
    if (getter !== expected) {
      throw new Error(
        `dodo-v2 ${input.side} input semantics mismatch for pool ${input.pool}`,
      );
    }
    return Object.freeze({ surplus: getter, deficit: 0n });
  }
  if (input.balance >= liability) {
    throw new Error(
      `dodo-v2 ${input.side} input getter reverted without a proven deficit ` +
        `for ${input.hasMtFeeLedger ? "GSP" : "legacy"} pool ${input.pool}`,
    );
  }
  return Object.freeze({ surplus: 0n, deficit: liability - input.balance });
}

function required(
  results: ReadonlyMap<string, { readonly success: boolean; readonly returnData: string }>,
  label: string,
): string {
  const result = results.get(label);
  if (!result?.success || result.returnData === "0x") {
    throw new Error(`dodo-v2 multicall item ${label} failed`);
  }
  return result.returnData;
}

function optional(
  results: ReadonlyMap<string, { readonly success: boolean; readonly returnData: string }>,
  label: string,
): string | null {
  const result = results.get(label);
  return result?.success && result.returnData !== "0x" ? result.returnData : null;
}
