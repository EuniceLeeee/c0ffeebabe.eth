import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  decodeJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  readOwnEnumerableDataProperty,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type { CanonicalHead, CanonicalSource } from "../../../canonical-source/src/index.ts";
import { issueProducerIngressPortV1 } from "./owners.ts";
import { brandProducerIngressSource } from "./source-brand.ts";
import type { ProducerIngressObservationV1, ProducerIngressPortV1, ProducerIngressSourceV1, ProducerPendingSnapshotV1 } from "../index.ts";

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const pendingBlockKeys = new Set([
  "number", "hash", "parentHash", "stateRoot", "transactions", "baseFeePerGas", "difficulty", "extraData",
  "gasLimit", "gasUsed", "logsBloom", "miner", "mixHash", "nonce", "receiptsRoot", "sha3Uncles", "size",
  "transactionsRoot", "uncles", "withdrawalsRoot", "withdrawals", "blobGasUsed", "excessBlobGas",
  "parentBeaconBlockRoot", "requestsHash", "author", "totalDifficulty",
]);
const pendingTransactionKeys = new Set([
  "hash", "from", "to", "nonce", "input", "value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas",
  "maxFeePerBlobGas", "blobVersionedHashes", "type", "accessList", "chainId", "v", "r", "s", "yParity",
  "blockHash", "blockNumber", "transactionIndex", "creates", "publicKey",
]);

export interface RethProducerIngressConfigV1 {
  readonly profile: "reth-json-rpc-v1";
  readonly endpoint: string;
  readonly pending: "disabled" | "public-pending-v1";
  readonly timeoutMs?: number;
  readonly blockscan: Readonly<{
    readonly objective: CanonicalJson;
    readonly callerId: string;
    readonly deadlineMs: number;
    readonly admission: Readonly<{
      readonly topK: number;
      readonly boundedUnrankedBudget: number;
    }>;
  }>;
}

interface ExactRethIngressConfig {
  readonly profile: "reth-json-rpc-v1";
  readonly endpoint: string;
  readonly pending: RethProducerIngressConfigV1["pending"];
  readonly timeoutMs: number;
  readonly blockscan: Readonly<{
    readonly objective: CanonicalJson;
    readonly callerId: string;
    readonly deadlineMs: number;
    readonly admission: Readonly<{ readonly topK: number; readonly boundedUnrankedBudget: number }>;
  }>;
}

function exactConfig(value: unknown): ExactRethIngressConfig {
  assertPlainObject(value, "rethProducerIngress.config");
  const expected = ["profile", "endpoint", "pending", "blockscan"];
  if (Object.prototype.hasOwnProperty.call(value, "timeoutMs")) expected.push("timeoutMs");
  assertExactKeys(value, expected, "rethProducerIngress.config");
  if (value.profile !== "reth-json-rpc-v1") throw new TypeError("unsupported Reth producer ingress profile");
  if (value.pending !== "disabled" && value.pending !== "public-pending-v1") throw new TypeError("invalid Reth pending profile");
  const endpointValue = assertNonEmptyString(value.endpoint, "rethProducerIngress.config.endpoint");
  let endpoint: URL;
  try { endpoint = new URL(endpointValue); } catch { throw new TypeError("Reth producer ingress endpoint must be a URL"); }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new TypeError("Reth producer ingress endpoint must use HTTP(S)");
  const blockscan = value.blockscan;
  assertPlainObject(blockscan, "rethProducerIngress.config.blockscan");
  assertExactKeys(blockscan, ["objective", "callerId", "deadlineMs", "admission"], "rethProducerIngress.config.blockscan");
  const objective = decodeCanonicalJson(encodeCanonicalJson(blockscan.objective));
  if (objective === null || typeof objective !== "object" || Array.isArray(objective)) throw new TypeError("Reth blockscan objective must be an object");
  const callerId = assertNonEmptyString(blockscan.callerId, "rethProducerIngress.config.blockscan.callerId");
  if (typeof blockscan.deadlineMs !== "number" || !Number.isFinite(blockscan.deadlineMs) || blockscan.deadlineMs <= 0 || blockscan.deadlineMs > 60_000) {
    throw new TypeError("Reth blockscan deadlineMs must be in (0, 60000]");
  }
  const admission = blockscan.admission;
  assertPlainObject(admission, "rethProducerIngress.config.blockscan.admission");
  assertExactKeys(admission, ["topK", "boundedUnrankedBudget"], "rethProducerIngress.config.blockscan.admission");
  const admissionRecord = admission as Record<string, unknown>;
  for (const [name, item] of [["topK", admissionRecord.topK], ["boundedUnrankedBudget", admissionRecord.boundedUnrankedBudget]] as const) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw new TypeError(`Reth admission ${name} is invalid`);
  }
  const topK = admissionRecord.topK as number;
  const boundedUnrankedBudget = admissionRecord.boundedUnrankedBudget as number;
  const timeoutMs = value.timeoutMs ?? 5_000;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError("Reth producer ingress timeoutMs is invalid");
  return deepFreeze({
    profile: "reth-json-rpc-v1",
    endpoint: endpoint.href,
    pending: value.pending,
    timeoutMs,
    blockscan: deepFreeze({ objective, callerId, deadlineMs: blockscan.deadlineMs, admission: deepFreeze({ topK, boundedUnrankedBudget }) }),
  });
}

function exactHead(value: unknown, path: string): CanonicalHead {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "parentHash", "stateRoot"], path);
  return deepFreeze({
    chainId: assertNonEmptyString(value.chainId, `${path}.chainId`),
    number: assertDecimalString(value.number, `${path}.number`),
    hash: assertHash(value.hash, `${path}.hash`),
    parentHash: assertHash(value.parentHash, `${path}.parentHash`),
    stateRoot: assertHash(value.stateRoot, `${path}.stateRoot`),
  });
}

function sameHead(left: CanonicalHead, right: CanonicalHead): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function exactRpc(value: unknown, expectedId: number): unknown {
  assertPlainObject(value, "rethProducerIngress.rpcResponse");
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  assertExactKeys(value, hasResult ? ["jsonrpc", "id", "result"] : ["jsonrpc", "id", "error"], "rethProducerIngress.rpcResponse");
  if (value.jsonrpc !== "2.0" || value.id !== expectedId) throw new TypeError("Reth producer ingress RPC identity mismatch");
  if (!hasResult) throw new Error("Reth producer ingress RPC error");
  return value.result;
}

function exactPendingTransaction(value: unknown): Readonly<{ readonly hash: Hash; readonly from: string; readonly to: string | null; readonly nonce: string; readonly input: string }> {
  assertPlainObject(value, "rethProducerIngress.pendingTransaction");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !pendingTransactionKeys.has(key)) throw new TypeError(`unknown pending transaction field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("pending transaction has non-data field");
  }
  const hash = assertHash(readOwnEnumerableDataProperty(value, "hash", "pendingTransaction"), "pendingTransaction.hash");
  const from = readOwnEnumerableDataProperty(value, "from", "pendingTransaction.from");
  if (typeof from !== "string" || !ADDRESS.test(from)) throw new TypeError("pendingTransaction.from is invalid");
  const toValue = readOwnEnumerableDataProperty(value, "to", "pendingTransaction.to");
  if (toValue !== null && (typeof toValue !== "string" || !ADDRESS.test(toValue))) throw new TypeError("pendingTransaction.to is invalid");
  const nonceValue = readOwnEnumerableDataProperty(value, "nonce", "pendingTransaction.nonce");
  if (typeof nonceValue !== "string" || !HEX_QUANTITY.test(nonceValue)) throw new TypeError("pendingTransaction.nonce is invalid");
  const input = readOwnEnumerableDataProperty(value, "input", "pendingTransaction.input");
  if (typeof input !== "string" || !HEX_BYTES.test(input)) throw new TypeError("pendingTransaction.input is invalid");
  return deepFreeze({ hash, from, to: toValue as string | null, nonce: BigInt(nonceValue).toString(), input });
}

function uniqueHashesInRpcOrder(values: readonly Hash[], path: string): readonly Hash[] {
  if (new Set(values).size !== values.length) throw new TypeError(`${path} are not unique`);
  return Object.freeze([...values]);
}

function pendingSnapshot(
  head: CanonicalHead,
  pendingNumber: string,
  parentHash: Hash,
  orderedTransactionHashes: readonly Hash[],
): ProducerPendingSnapshotV1 {
  const orderedTransactionHashesRoot = hashDomain("aloha/public-pending-transaction-set/v1", orderedTransactionHashes);
  const transactionCount = orderedTransactionHashes.length.toString();
  const snapshot = {
    pendingNumber,
    parentHash,
    orderedTransactionHashes: Object.freeze([...orderedTransactionHashes]),
    orderedTransactionHashesRoot,
    transactionCount,
  };
  return deepFreeze({ ...snapshot, snapshotHash: hashDomain("aloha/public-pending-snapshot/v1", { head, ...snapshot }) });
}

function unavailablePending(
  head: CanonicalHead,
  reasonCode: "pending-observation-disabled" | "pending-block-unavailable" | "pending-set-not-single",
  snapshot: ProducerPendingSnapshotV1 | null,
): ProducerIngressObservationV1["backrun"] {
  return deepFreeze({
    kind: "unavailable",
    snapshot,
    reasonCode,
    evidenceHash: hashDomain("aloha/public-pending-unavailable-evidence/v1", {
      head,
      reasonCode,
      snapshotHash: snapshot?.snapshotHash ?? null,
    }),
  });
}

/** Candidate-owned Reth intake; no fetch or result callback can be injected. */
export class RethProducerIngressSourceV1 {
  readonly #config: ExactRethIngressConfig;
  #nextId = 0;

  constructor(config: RethProducerIngressConfigV1) {
    this.#config = exactConfig(config);
    if (typeof globalThis.fetch !== "function") throw new TypeError("Reth producer ingress requires platform fetch");
    brandProducerIngressSource(this);
  }

  async observe(input: { readonly head: CanonicalHead; readonly signal: AbortSignal }): Promise<ProducerIngressObservationV1 | null> {
    const head = exactHead(input.head, "producerIngress.head");
    const blockscan = {
      input: Object.freeze({
        objective: this.#config.blockscan.objective,
        deadlineAtMs: performance.now() + this.#config.blockscan.deadlineMs,
        callerId: this.#config.blockscan.callerId,
        admission: this.#config.blockscan.admission,
      }),
    } as const;
    const pending = this.#config.pending === "public-pending-v1"
      ? await this.#readPending(head, input.signal)
      : unavailablePending(head, "pending-observation-disabled", null);
    return deepFreeze({
      head,
      blockscan,
      backrun: pending,
    });
  }

  async #readPending(head: CanonicalHead, signal: AbortSignal): Promise<ProducerIngressObservationV1["backrun"]> {
    const result = await this.#rpc("eth_getBlockByNumber", ["pending", true], signal);
    if (result === null) return unavailablePending(head, "pending-block-unavailable", null);
    assertPlainObject(result, "rethProducerIngress.pendingBlock");
    for (const key of Reflect.ownKeys(result)) {
      if (typeof key !== "string" || !pendingBlockKeys.has(key)) throw new TypeError(`unknown pending block field ${String(key)}`);
      const descriptor = Object.getOwnPropertyDescriptor(result, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("pending block has non-data field");
    }
    const pendingNumberHex = readOwnEnumerableDataProperty(result, "number", "rethProducerIngress.pendingBlock.number");
    if (
      typeof pendingNumberHex !== "string"
      || !HEX_QUANTITY.test(pendingNumberHex)
      || BigInt(pendingNumberHex) !== BigInt(head.number) + 1n
    ) throw new TypeError("pending block is not the exact successor of the producer head");
    const pendingParentHash = assertHash(
      readOwnEnumerableDataProperty(result, "parentHash", "rethProducerIngress.pendingBlock.parentHash"),
      "rethProducerIngress.pendingBlock.parentHash",
    );
    if (pendingParentHash !== head.hash) throw new TypeError("pending block parent does not match the producer head");
    const transactions = readOwnEnumerableDataProperty(result, "transactions", "rethProducerIngress.pendingBlock.transactions");
    if (!Array.isArray(transactions)) throw new TypeError("pending block transactions must be an array");
    const decoded = transactions.map((transaction, index) => exactPendingTransaction(transaction ?? null));
    const transactionHashes = uniqueHashesInRpcOrder(decoded.map(transaction => transaction.hash), "pending block transaction hashes");
    const snapshot = pendingSnapshot(head, BigInt(pendingNumberHex).toString(), pendingParentHash, transactionHashes);
    if (decoded.length === 0) {
      return deepFreeze({
        kind: "observed-empty",
        snapshot,
        absenceEvidenceHash: hashDomain("aloha/public-pending-absence-evidence/v1", { head, snapshotHash: snapshot.snapshotHash }),
      });
    }
    if (decoded.length !== 1) return unavailablePending(head, "pending-set-not-single", snapshot);
    const transaction = decoded[0];
    if (transaction === undefined) throw new TypeError("singleton pending transaction is missing");
    const pendingEvidenceHash = hashDomain("aloha/public-pending-transaction-evidence/v2", { head, snapshotHash: snapshot.snapshotHash, transaction });
    return deepFreeze({
      kind: "pending-transaction",
      snapshot,
      txHash: transaction.hash,
      affectedEdgeIds: Object.freeze([]),
      pendingEvidenceHash,
      input: Object.freeze({
        objective: this.#config.blockscan.objective,
        deadlineAtMs: performance.now() + this.#config.blockscan.deadlineMs,
        callerId: this.#config.blockscan.callerId,
        admission: this.#config.blockscan.admission,
        pendingTxHash: transaction.hash,
        pendingEvidenceHash,
        pendingTransaction: transaction,
      }),
    });
  }

  async #rpc(method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown> {
    const id = ++this.#nextId;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const response = await globalThis.fetch(this.#config.endpoint, {
        method: "POST",
        headers: { "accept": "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Reth producer ingress HTTP ${response.status}`);
      return exactRpc(decodeJson(await response.text()), id);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

export function createRethProducerIngressPortV1(config: RethProducerIngressConfigV1): ProducerIngressPortV1 {
  const source = new RethProducerIngressSourceV1(config);
  return issueProducerIngressPortV1(source as unknown as ProducerIngressSourceV1);
}
