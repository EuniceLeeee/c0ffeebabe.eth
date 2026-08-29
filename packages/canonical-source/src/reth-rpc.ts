import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeJson,
  deepFreeze,
  readOwnEnumerableDataProperty,
} from "../../canonical-codec/src/index.ts";
import type {
  BlockNumber,
  CanonicalHeader,
  CanonicalHeaderProvider,
  CanonicalHeaderReadResult,
} from "./index.ts";

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const allowedBlockKeys = new Set([
  "number", "hash", "parentHash", "stateRoot", "transactions", "baseFeePerGas", "difficulty",
  "extraData", "gasLimit", "gasUsed", "logsBloom", "miner", "mixHash", "nonce", "receiptsRoot",
  "sha3Uncles", "size", "transactionsRoot", "uncles", "withdrawalsRoot", "withdrawals",
  "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash", "author", "totalDifficulty",
]);

export interface RethCanonicalHeaderProviderConfigV1 {
  readonly profile: "reth-json-rpc-v1";
  readonly endpoint: string;
  readonly chainId: string;
  readonly timeoutMs?: number;
}

function exactConfig(value: unknown): RethCanonicalHeaderProviderConfigV1 {
  assertPlainObject(value, "rethCanonicalSource.config");
  const keys = Reflect.ownKeys(value);
  const expected = ["profile", "endpoint", "chainId"];
  if (Object.prototype.hasOwnProperty.call(value, "timeoutMs")) expected.push("timeoutMs");
  assertExactKeys(value, expected, "rethCanonicalSource.config");
  if (readOwnEnumerableDataProperty(value, "profile", "rethCanonicalSource.config") !== "reth-json-rpc-v1") {
    throw new TypeError("unsupported Reth canonical source profile");
  }
  const endpoint = assertNonEmptyString(
    readOwnEnumerableDataProperty(value, "endpoint", "rethCanonicalSource.config"),
    "rethCanonicalSource.config.endpoint",
  );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError("Reth canonical source endpoint must be a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Reth canonical source endpoint must use HTTP(S)");
  }
  const chainId = assertDecimalString(
    readOwnEnumerableDataProperty(value, "chainId", "rethCanonicalSource.config"),
    "rethCanonicalSource.config.chainId",
  );
  const timeoutMs = Object.prototype.hasOwnProperty.call(value, "timeoutMs")
    ? readOwnEnumerableDataProperty(value, "timeoutMs", "rethCanonicalSource.config")
    : 5_000;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError("Reth canonical source timeoutMs must be in (0, 60000]");
  }
  return deepFreeze({ profile: "reth-json-rpc-v1", endpoint: url.href, chainId, timeoutMs });
}

function quantity(value: unknown, path: string): string {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) throw new TypeError(`${path} is not a canonical quantity`);
  return BigInt(value).toString();
}

function blockTag(number: BlockNumber): string {
  return `0x${BigInt(assertDecimalString(number, "blockNumber")).toString(16)}`;
}

function exactHeader(value: unknown, expectedNumber: string | null): CanonicalHeader | null {
  if (value === null) return null;
  assertPlainObject(value, "rethCanonicalSource.block");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedBlockKeys.has(key)) throw new TypeError(`unknown Reth block field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`Reth block field ${key} is not an exact data property`);
    }
  }
  const number = quantity(readOwnEnumerableDataProperty(value, "number", "rethCanonicalSource.block"), "rethCanonicalSource.block.number");
  if (expectedNumber !== null && number !== expectedNumber) throw new TypeError("Reth block number mismatch");
  return deepFreeze({
    chainId: "" as never,
    number,
    hash: assertHash(readOwnEnumerableDataProperty(value, "hash", "rethCanonicalSource.block"), "rethCanonicalSource.block.hash"),
    parentHash: assertHash(readOwnEnumerableDataProperty(value, "parentHash", "rethCanonicalSource.block"), "rethCanonicalSource.block.parentHash"),
    stateRoot: assertHash(readOwnEnumerableDataProperty(value, "stateRoot", "rethCanonicalSource.block"), "rethCanonicalSource.block.stateRoot"),
  });
}

function exactRpc(value: unknown, expectedId: number): Record<string, unknown> {
  assertPlainObject(value, "rethCanonicalSource.rpcResponse");
  assertExactKeys(value, ["jsonrpc", "id", "result"].includes("result") && Object.prototype.hasOwnProperty.call(value, "result")
    ? ["jsonrpc", "id", "result"]
    : ["jsonrpc", "id", "error"], "rethCanonicalSource.rpcResponse");
  if (readOwnEnumerableDataProperty(value, "jsonrpc", "rethCanonicalSource.rpcResponse") !== "2.0") {
    throw new TypeError("Reth JSON-RPC version mismatch");
  }
  if (readOwnEnumerableDataProperty(value, "id", "rethCanonicalSource.rpcResponse") !== expectedId) {
    throw new TypeError("Reth JSON-RPC id mismatch");
  }
  if (Object.prototype.hasOwnProperty.call(value, "error")) {
    const error = readOwnEnumerableDataProperty(value, "error", "rethCanonicalSource.rpcResponse");
    assertPlainObject(error, "rethCanonicalSource.rpcResponse.error");
    const errorKeys = Object.prototype.hasOwnProperty.call(error, "data") ? ["code", "message", "data"] : ["code", "message"];
    assertExactKeys(error, errorKeys, "rethCanonicalSource.rpcResponse.error");
    throw new Error(`Reth JSON-RPC error ${String(readOwnEnumerableDataProperty(error, "code", "rethCanonicalSource.rpcResponse.error"))}`);
  }
  return value;
}

/**
 * Candidate-owned Reth JSON-RPC header provider. Configuration is data only;
 * the transport is always the platform fetch implementation. No caller can
 * inject a fetch function or a successful header result.
 */
export class RethCanonicalHeaderProviderV1 implements CanonicalHeaderProvider {
  readonly #config: RethCanonicalHeaderProviderConfigV1;
  #nextId = 0;

  constructor(config: RethCanonicalHeaderProviderConfigV1) {
    this.#config = exactConfig(config);
    if (typeof globalThis.fetch !== "function") throw new TypeError("Reth canonical source requires platform fetch");
  }

  async getLatestHeader(signal?: AbortSignal): Promise<CanonicalHeader> {
    const header = await this.#readBlock("latest", signal);
    if (header === null) throw new Error("Reth latest block is unavailable");
    return header;
  }

  async getHeader(number: BlockNumber, signal?: AbortSignal): Promise<CanonicalHeaderReadResult> {
    const exactNumber = assertDecimalString(number, "Reth canonical header number");
    const header = await this.#readBlock(blockTag(exactNumber), signal);
    return header === null
      ? Object.freeze({ kind: "unavailable" as const, failureCode: "header-unavailable" })
      : Object.freeze({ kind: "found" as const, header });
  }

  async #readBlock(tag: string, signal?: AbortSignal): Promise<CanonicalHeader | null> {
    const chainIdHex = await this.#rpc("eth_chainId", [], signal);
    const chainId = quantity(chainIdHex, "Reth eth_chainId");
    if (chainId !== this.#config.chainId) throw new Error("Reth chain id does not match release configuration");
    const result = await this.#rpc("eth_getBlockByNumber", [tag, false], signal);
    const decoded = exactHeader(result, tag === "latest" ? null : BigInt(tag).toString());
    if (decoded === null) return null;
    return deepFreeze({ ...decoded, chainId: this.#config.chainId });
  }

  async #rpc(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    const id = ++this.#nextId;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const response = await globalThis.fetch(this.#config.endpoint, {
        method: "POST",
        headers: { "accept": "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Reth JSON-RPC HTTP ${response.status}`);
      const body = decodeJson(await response.text());
      const envelope = exactRpc(body, id);
      return readOwnEnumerableDataProperty(envelope, "result", "rethCanonicalSource.rpcResponse");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export function createRethCanonicalHeaderProviderV1(
  config: RethCanonicalHeaderProviderConfigV1,
): RethCanonicalHeaderProviderV1 {
  return new RethCanonicalHeaderProviderV1(config);
}
