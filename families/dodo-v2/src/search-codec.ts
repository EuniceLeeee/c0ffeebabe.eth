import { canonicalAddress } from "./types.ts";
import type { DodoPmmState } from "./kernel/math.ts";

const UINT256 = 1n << 256n;
const WORD_HEX = 64;
const WORD_RE = /^[0-9a-fA-F]{64}$/;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export const DODO_SEARCH_SELECTORS = Object.freeze({
  pmm: "0xfd1ed7e9",
  userFeeRate: "0x44096609",
  querySellBase: "0x79a04876",
  querySellQuote: "0x66410a21",
} as const);

function word(value: bigint, path: string): string {
  if (value < 0n || value >= UINT256) throw new RangeError(`${path} is outside uint256`);
  return value.toString(16).padStart(WORD_HEX, "0");
}

function raw(value: string, path: string): string {
  if (!BYTES_RE.test(value)) throw new TypeError(`${path} must be raw even-length ABI bytes`);
  return value.slice(2).toLowerCase();
}

function call(selector: string, args: readonly string[] = []): string {
  return `0x${selector.slice(2)}${args.join("")}`;
}

export function encodeDodoStateCall(
  kind: "pmm" | "userFeeRate" | "querySellBase" | "querySellQuote",
  pool: string,
  quoteActor?: string,
  amountIn?: string,
): { readonly target: string; readonly data: string; readonly responseEncoding: `abi-${string}` } {
  const target = canonicalAddress(pool);
  if (kind === "pmm") return Object.freeze({ target, data: call(DODO_SEARCH_SELECTORS.pmm), responseEncoding: "abi-dodo-pmm-v1" });
  if (quoteActor === undefined) throw new TypeError("DODO quote actor is required");
  const actorWord = word(BigInt(canonicalAddress(quoteActor)), "quote actor");
  if (kind === "userFeeRate") return Object.freeze({ target, data: call(DODO_SEARCH_SELECTORS.userFeeRate, [actorWord]), responseEncoding: "abi-dodo-fee-rate-v1" });
  if (amountIn === undefined || !/^\d+$/.test(amountIn)) throw new TypeError("DODO query amount must be an unsigned decimal string");
  return Object.freeze({
    target,
    data: call(DODO_SEARCH_SELECTORS[kind], [actorWord, word(BigInt(amountIn), "query amount")]),
    responseEncoding: "abi-dodo-query-v1",
  });
}

function words(data: string, count: number, path: string): readonly string[] {
  const body = raw(data, path);
  if (body.length !== WORD_HEX * count) throw new TypeError(`${path} must contain exactly ${count} ABI words`);
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = body.slice(index * WORD_HEX, (index + 1) * WORD_HEX);
    if (!WORD_RE.test(item)) throw new TypeError(`${path}[${index}] is not an ABI word`);
    output.push(item);
  }
  return output;
}

export function decodeDodoPmm(data: string, path = "dodo.pmm"): DodoPmmState {
  const values = words(data, 7, path).map(value => BigInt(`0x${value}`));
  const R = values[6]!;
  if (R !== 0n && R !== 1n && R !== 2n) throw new TypeError(`${path}.R is outside the PMM enum`);
  return Object.freeze({ i: values[0]!, K: values[1]!, B: values[2]!, Q: values[3]!, B0: values[4]!, Q0: values[5]!, R: Number(R) as DodoPmmState["R"] });
}

export function decodeDodoFeeRate(data: string, path = "dodo.feeRate"): { readonly lpFeeRate: bigint; readonly mtFeeRate: bigint } {
  const values = words(data, 2, path).map(value => BigInt(`0x${value}`));
  if (values[0]! + values[1]! >= 10n ** 18n) throw new TypeError(`${path} exceeds the PMM fee domain`);
  return Object.freeze({ lpFeeRate: values[0]!, mtFeeRate: values[1]! });
}

export function decodeDodoQuery(data: string, path = "dodo.query"): bigint {
  return BigInt(`0x${words(data, 1, path)[0]!}`);
}
