import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";

export interface HistoricalSenderNonceTransactionEvidence {
  readonly canonicalIndex: number;
  readonly hash: string;
  readonly nonce: number;
  readonly canonicalStatus: number | null;
  readonly localStatus: number | null;
  readonly logCount: number;
  readonly logsSha256: string;
  readonly equivalent: true;
}

export interface HistoricalSenderNonceAnchorResult {
  readonly kind: "sender-nonce-prefix";
  readonly blockNumber: number;
  readonly triggerTxHash: string;
  readonly triggerIndex: number;
  readonly sender: string;
  readonly firstNonce: number;
  readonly lastNonce: number;
  readonly transactionIndexes: readonly number[];
  readonly transactionHashes: readonly string[];
  readonly transactions: readonly HistoricalSenderNonceTransactionEvidence[];
}

/**
 * Reconstruct a historical post-trigger state without trusting Anvil's
 * version-dependent --fork-transaction-hash semantics. Starting from the
 * canonical parent state, discover and execute every same-sender transaction
 * from the parent's account nonce through the trigger nonce in one historical
 * block. No transaction hash other than the trigger is supplied by a fixture.
 *
 * This is deliberately a sender-local prefix, not a claim that unrelated
 * earlier transactions in the canonical block were replayed. If any required
 * nonce is missing or any queued transaction fails, the anchor fails closed.
 */
export async function anchorHistoricalSenderNoncePrefix(input: {
  readonly state: AnvilStateBackend;
  readonly archiveProvider: ethers.JsonRpcProvider;
  readonly triggerTxHash: string;
  readonly expectedBlockNumber?: number;
  readonly mustPrecedeIndex?: number;
  readonly mineLabel?: string;
}): Promise<HistoricalSenderNonceAnchorResult> {
  const triggerTxHash = normalizeTxHash(input.triggerTxHash, "triggerTxHash");
  const [trigger, receipt] = await Promise.all([
    input.archiveProvider.getTransaction(triggerTxHash),
    input.archiveProvider.getTransactionReceipt(triggerTxHash),
  ]);
  if (!trigger || !receipt || receipt.status !== 1) {
    throw new Error(`historical trigger missing or reverted: ${triggerTxHash}`);
  }
  if (
    input.expectedBlockNumber !== undefined &&
    receipt.blockNumber !== input.expectedBlockNumber
  ) {
    throw new Error(
      `historical trigger block ${receipt.blockNumber} != expected ${input.expectedBlockNumber}`,
    );
  }
  const triggerIndex = Number(receipt.index);
  if (
    input.mustPrecedeIndex !== undefined &&
    triggerIndex >= input.mustPrecedeIndex
  ) {
    throw new Error(
      `historical trigger index ${triggerIndex} does not precede ${input.mustPrecedeIndex}`,
    );
  }
  const parentNonce = await input.archiveProvider.getTransactionCount(
    trigger.from,
    receipt.blockNumber - 1,
  );
  if (parentNonce > trigger.nonce) {
    throw new Error(
      `trigger sender parent nonce ${parentNonce} exceeds trigger nonce ${trigger.nonce}`,
    );
  }
  const block = await input.archiveProvider.send("eth_getBlockByNumber", [
    ethers.toQuantity(receipt.blockNumber),
    true,
  ]) as { transactions?: unknown };
  if (!Array.isArray(block?.transactions) || triggerIndex >= block.transactions.length) {
    throw new Error(`historical block ${receipt.blockNumber} is missing tx index ${triggerIndex}`);
  }

  const sender = ethers.getAddress(trigger.from);
  const byNonce = new Map<number, { hash: string; index: number; nonce: number }>();
  for (let index = 0; index <= triggerIndex; index++) {
    const value = block.transactions[index] as {
      hash?: unknown;
      from?: unknown;
      nonce?: unknown;
    };
    if (typeof value?.from !== "string" || value.from.toLowerCase() !== sender.toLowerCase()) {
      continue;
    }
    if (typeof value.hash !== "string" || typeof value.nonce !== "string") {
      throw new Error(`historical sender transaction ${index} has an invalid RPC shape`);
    }
    const nonce = Number(BigInt(value.nonce));
    if (!Number.isSafeInteger(nonce) || nonce < parentNonce || nonce > trigger.nonce) continue;
    if (byNonce.has(nonce)) throw new Error(`duplicate sender nonce ${nonce} in historical block`);
    byNonce.set(nonce, {
      hash: normalizeTxHash(value.hash, `historical transaction ${index}`),
      index,
      nonce,
    });
  }

  const ordered: Array<{ hash: string; index: number; nonce: number }> = [];
  for (let nonce = parentNonce; nonce <= trigger.nonce; nonce++) {
    const entry = byNonce.get(nonce);
    if (!entry) {
      throw new Error(
        `trigger sender nonce prefix is incomplete: missing nonce ${nonce} before ` +
          `tx index ${triggerIndex}`,
      );
    }
    ordered.push(entry);
  }
  if (ordered.at(-1)?.hash.toLowerCase() !== triggerTxHash) {
    throw new Error("sender nonce prefix does not terminate at the requested trigger");
  }
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].index <= ordered[index - 1].index) {
      throw new Error("sender nonce prefix is not ordered by canonical transaction index");
    }
  }

  const canonicalReceipts = await Promise.all(ordered.map(async (entry) => {
    const historicalReceipt = await input.archiveProvider.getTransactionReceipt(entry.hash);
    if (!historicalReceipt) {
      throw new Error(
        `canonical receipt missing at tx index ${entry.index}: ${entry.hash}`,
      );
    }
    return historicalReceipt;
  }));

  const transactions: Array<{ rawTx: string; expectedHash: string }> = [];
  for (const entry of ordered) {
    transactions.push({
      rawTx: await fetchRawHistoricalTransaction(input.archiveProvider, entry.hash),
      expectedHash: entry.hash,
    });
  }
  const queued = await input.state.queueHistoricalRawTransactions(
    receipt.blockNumber,
    transactions,
  );
  await input.state.mineQueuedHistoricalBlock(
    queued,
    input.mineLabel ?? "historical-sender-nonce-prefix",
  );
  if (queued.at(-1)?.toLowerCase() !== triggerTxHash) {
    throw new Error(`sender nonce prefix did not end at trigger ${triggerTxHash}`);
  }
  const localBlock = await input.state.provider.getBlockNumber();
  if (localBlock !== receipt.blockNumber) {
    throw new Error(`sender nonce prefix block ${localBlock} != expected ${receipt.blockNumber}`);
  }
  const localReceipts = await Promise.all(ordered.map(async (entry) => {
    const localReceipt = await input.state.provider.getTransactionReceipt(entry.hash);
    if (!localReceipt) {
      throw new Error(`local receipt missing at canonical tx index ${entry.index}: ${entry.hash}`);
    }
    return localReceipt;
  }));
  const transactionEvidence = ordered.map((entry, index) =>
    assertReceiptEquivalent(
      entry,
      canonicalReceipts[index],
      localReceipts[index],
    ));

  return {
    kind: "sender-nonce-prefix",
    blockNumber: receipt.blockNumber,
    triggerTxHash,
    triggerIndex,
    sender,
    firstNonce: parentNonce,
    lastNonce: trigger.nonce,
    transactionIndexes: ordered.map((entry) => entry.index),
    transactionHashes: queued.map((hash) => hash.toLowerCase()),
    transactions: transactionEvidence,
  };
}

function assertReceiptEquivalent(
  entry: { readonly hash: string; readonly index: number; readonly nonce: number },
  canonical: ethers.TransactionReceipt,
  local: ethers.TransactionReceipt,
): HistoricalSenderNonceTransactionEvidence {
  if (canonical.hash.toLowerCase() !== entry.hash || local.hash.toLowerCase() !== entry.hash) {
    throw new Error(`receipt hash mismatch at canonical tx index ${entry.index}: ${entry.hash}`);
  }
  if (canonical.status !== local.status) {
    throw new Error(
      `receipt status mismatch at canonical tx index ${entry.index} ${entry.hash}: ` +
        `canonical=${canonical.status} local=${local.status}`,
    );
  }
  if (canonical.logs.length !== local.logs.length) {
    throw new Error(
      `receipt log count mismatch at canonical tx index ${entry.index} ${entry.hash}: ` +
        `canonical=${canonical.logs.length} local=${local.logs.length}`,
    );
  }
  const canonicalLogs = canonical.logs.map(normalizeReceiptLog);
  const localLogs = local.logs.map(normalizeReceiptLog);
  for (let logIndex = 0; logIndex < canonicalLogs.length; logIndex++) {
    const expected = canonicalLogs[logIndex];
    const actual = localLogs[logIndex];
    if (expected.address !== actual.address) {
      throw receiptLogMismatch(entry, logIndex, "address", expected.address, actual.address);
    }
    if (expected.data !== actual.data) {
      throw receiptLogMismatch(entry, logIndex, "data", expected.data, actual.data);
    }
    if (
      expected.topics.length !== actual.topics.length ||
      expected.topics.some((topic, topicIndex) => topic !== actual.topics[topicIndex])
    ) {
      throw receiptLogMismatch(
        entry,
        logIndex,
        "topics",
        expected.topics.join(","),
        actual.topics.join(","),
      );
    }
  }
  const canonicalDigest = sha256(JSON.stringify(canonicalLogs));
  const localDigest = sha256(JSON.stringify(localLogs));
  if (canonicalDigest !== localDigest) {
    throw new Error(
      `receipt log digest mismatch at canonical tx index ${entry.index} ${entry.hash}`,
    );
  }
  return {
    canonicalIndex: entry.index,
    hash: entry.hash,
    nonce: entry.nonce,
    canonicalStatus: canonical.status,
    localStatus: local.status,
    logCount: canonicalLogs.length,
    logsSha256: canonicalDigest,
    equivalent: true,
  };
}

function normalizeReceiptLog(log: ethers.Log): {
  address: string;
  topics: string[];
  data: string;
} {
  return {
    address: log.address.toLowerCase(),
    topics: [...log.topics].map((topic) => topic.toLowerCase()),
    data: log.data.toLowerCase(),
  };
}

function receiptLogMismatch(
  entry: { readonly hash: string; readonly index: number },
  logIndex: number,
  field: "address" | "topics" | "data",
  canonical: string,
  local: string,
): Error {
  return new Error(
    `receipt log ${field} mismatch at canonical tx index ${entry.index} ${entry.hash} ` +
      `log ${logIndex}: canonical=${canonical} local=${local}`,
  );
}

async function fetchRawHistoricalTransaction(
  provider: ethers.JsonRpcProvider,
  hash: string,
): Promise<string> {
  const raw = await provider.send("eth_getRawTransactionByHash", [hash]);
  if (typeof raw !== "string" || !/^0x[0-9a-f]+$/i.test(raw)) {
    throw new Error(`archive RPC did not return raw historical transaction ${hash}`);
  }
  const parsed = ethers.Transaction.from(raw);
  if (parsed.hash?.toLowerCase() !== hash.toLowerCase()) {
    throw new Error(`raw historical transaction hash mismatch: ${parsed.hash ?? "null"} != ${hash}`);
  }
  return raw;
}

function normalizeTxHash(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${field} must be a transaction hash`);
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
