import assert from "node:assert/strict";

export interface TransactionSource { readonly number: number; readonly hash: string }
export interface TransactionStateSelection {
  readonly mode: "transaction" | "parent";
  readonly evidenceSource: TransactionSource;
  readonly executionSource: TransactionSource;
  readonly evidenceHeader?: { readonly number: string; readonly hash: string; readonly parentHash: string };
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const anchor = (source: TransactionSource) => {
  assert(source && Number.isSafeInteger(source.number) && source.number >= 0 && hash(source.hash), "invalid transaction state source");
};

/** TX evidence never moves. A parent selection is a separate same-state test,
 * not the transaction's pre-call state and not a historical output oracle. */
export function validateTransactionStateSelection(evidenceSource: TransactionSource, selection?: TransactionStateSelection): TransactionStateSelection {
  anchor(evidenceSource);
  const value = selection ?? { mode: "transaction", evidenceSource, executionSource: evidenceSource };
  anchor(value.evidenceSource); anchor(value.executionSource);
  assert.equal(value.evidenceSource.number, evidenceSource.number);
  assert(same(value.evidenceSource.hash, evidenceSource.hash), "transaction evidence source changed");
  assert(value.mode === "transaction" || value.mode === "parent", "invalid execution source selection");
  if (value.mode === "transaction") {
    assert.equal(value.executionSource.number, evidenceSource.number);
    assert(same(value.executionSource.hash, evidenceSource.hash), "execution source differs from transaction source");
    assert.equal(value.evidenceHeader, undefined, "unexpected parent proof");
  } else {
    const header = value.evidenceHeader;
    assert(header && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(header.number) && hash(header.hash) && hash(header.parentHash), "parent selection requires TX block header evidence");
    assert.equal(BigInt(header.number), BigInt(evidenceSource.number));
    assert(same(header.hash, evidenceSource.hash), "TX block header differs from evidence source");
    assert(evidenceSource.number > 0 && value.executionSource.number === evidenceSource.number - 1, "execution source must be the immediate parent");
    assert(same(value.executionSource.hash, header.parentHash), "execution source is not the TX block parent");
  }
  return value;
}

export async function selectTransactionExecutionSource(source: TransactionSource, mode: string,
  send: (method: string, params: readonly unknown[]) => Promise<any>): Promise<TransactionStateSelection> {
  anchor(source);
  assert(mode === "transaction" || mode === "parent", "--execution-source must be transaction or parent");
  if (mode === "transaction") return validateTransactionStateSelection(source);
  const header = await send("eth_getBlockByNumber", [`0x${source.number.toString(16)}`, false]);
  assert(header, "transaction evidence header unavailable");
  return validateTransactionStateSelection(source, { mode, evidenceSource: source,
    executionSource: { number: source.number - 1, hash: header.parentHash },
    evidenceHeader: { number: header.number, hash: header.hash, parentHash: header.parentHash } });
}
