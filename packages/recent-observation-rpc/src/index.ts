import {
  assertDecimalString,
  assertHash,
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  decodeCanonicalCutoff,
  recentObservationRange,
  SOURCE_EVIDENCE_VERSION_V1,
  type CanonicalCutoffV1,
  type RawEvidenceLocatorContentV1,
  type RecentLogEvidenceRefV1,
} from "../../discovery/src/index.ts";
import type {
  DiscoveryProviderRef,
  DiscoveryTransport,
} from "../../discovery-transport/src/index.ts";
import { assertIssuedDiscoveryTransport } from "../../discovery-transport/src/index.ts";
import {
  encodeEvmLogObservation,
  type EvmLogObservationV1,
  type ObservedBlockV1,
  type RecentObservationScanV1,
} from "../../observation/src/index.ts";

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const EVM_BYTES = /^0x(?:[0-9a-f]{2})*$/;

export type RecentObservationRpcFailureCode =
  | "window-unavailable"
  | "malformed-header"
  | "malformed-log"
  | "header-chain-mismatch"
  | "cutoff-mismatch";

export class RecentObservationRpcError extends Error {
  readonly code: RecentObservationRpcFailureCode;
  readonly retryClass = "retryable" as const;

  constructor(code: RecentObservationRpcFailureCode, message: string) {
    super(message);
    this.name = "RecentObservationRpcError";
    this.code = code;
  }
}

export interface RecentObservationRpcOptions {
  /** Scheduler-backed transport; this observer never owns raw HTTP authority. */
  readonly transport: DiscoveryTransport;
  readonly provider: DiscoveryProviderRef;
}

interface RpcHeader {
  readonly number: string;
  readonly hash: Hash;
  readonly parentHash: Hash;
  readonly stateRoot: Hash;
}

function canonical(value: unknown): CanonicalJson {
  return decodeCanonicalJson(encodeCanonicalJson(value));
}

function record(value: unknown, path: string): Readonly<Record<string, CanonicalJson>> {
  const decoded = canonical(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError(`${path} must be an object`);
  }
  return decoded as Readonly<Record<string, CanonicalJson>>;
}

function array(value: unknown, path: string): readonly CanonicalJson[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value as readonly CanonicalJson[];
}

function quantity(value: unknown, path: string): string {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) {
    throw new TypeError(`${path} must be a canonical lowercase hex quantity`);
  }
  return BigInt(value).toString();
}

function blockTag(value: string): string {
  return `0x${BigInt(assertDecimalString(value, "blockNumber")).toString(16)}`;
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string" || !EVM_ADDRESS.test(value)) {
    throw new TypeError(`${path} must be a lowercase EVM address`);
  }
  return value;
}

function bytes(value: unknown, path: string): string {
  if (typeof value !== "string" || !EVM_BYTES.test(value)) {
    throw new TypeError(`${path} must be lowercase even-length EVM bytes`);
  }
  return value;
}

function header(value: unknown, expectedNumber: string): RpcHeader {
  try {
    const item = record(value, `header[${expectedNumber}]`);
    const number = quantity(item.number, `header[${expectedNumber}].number`);
    if (number !== expectedNumber) throw new TypeError("header number mismatch");
    return Object.freeze({
      number,
      hash: assertHash(item.hash, `header[${expectedNumber}].hash`),
      parentHash: assertHash(item.parentHash, `header[${expectedNumber}].parentHash`),
      stateRoot: assertHash(item.stateRoot, `header[${expectedNumber}].stateRoot`),
    });
  } catch (error) {
    throw new RecentObservationRpcError(
      "malformed-header",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function logObservation(
  value: unknown,
  expected: RpcHeader,
  index: number,
): EvmLogObservationV1 | null {
  try {
    const item = record(value, `logs[${expected.number}][${index}]`);
    if (item.removed !== false) throw new TypeError("removed log is not canonical evidence");
    const blockNumber = quantity(item.blockNumber, `logs[${expected.number}][${index}].blockNumber`);
    const blockHash = assertHash(item.blockHash, `logs[${expected.number}][${index}].blockHash`);
    if (blockNumber !== expected.number || blockHash !== expected.hash) {
      throw new TypeError("log source does not match requested blockHash");
    }
    const topics = array(item.topics, `logs[${expected.number}][${index}].topics`)
      .map((topic, topicIndex) => assertHash(topic, `logs[${expected.number}][${index}].topics[${topicIndex}]`));
    // Anonymous/no-topic logs cannot nominate any current Family.  Omitting
    // them is a schema fact, never a protocol filter.
    if (topics.length === 0) return null;
    return Object.freeze({
      kind: "evm-log" as const,
      version: 1 as const,
      blockNumber,
      blockHash,
      transactionHash: assertHash(item.transactionHash, `logs[${expected.number}][${index}].transactionHash`),
      logIndex: quantity(item.logIndex, `logs[${expected.number}][${index}].logIndex`),
      address: address(item.address, `logs[${expected.number}][${index}].address`),
      topics: Object.freeze(topics),
      data: bytes(item.data, `logs[${expected.number}][${index}].data`),
    });
  } catch (error) {
    throw new RecentObservationRpcError(
      "malformed-log",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function requestId(
  cutoff: CanonicalCutoffV1,
  method: string,
  params: CanonicalJson,
): Hash {
  return hashDomain("aloha/recent-observation-rpc-request/v1", { cutoff, method, params });
}

const OWNER_REF = "recent-observation.rpc.v1";
const REQUEST_CODEC = "ethereum-json-rpc-result.v1";
const WORK_CLASS = "startup.rpc-fast.recent-observation.v1";
const MAX_RECENT_POSITIVE_LOGS = 1_024;

/**
 * Qualified observer mechanics for the exact recent 50-block window.  It
 * retrieves headers by number, then logs by exact blockHash, preserves a
 * protocol-neutral canonical log byte envelope, and leaves every semantic
 * topic/address decision to the Family plugin.
 */
export class RecentObservationRpcObserver {
  private readonly transport: DiscoveryTransport;
  private readonly provider: DiscoveryProviderRef;

  constructor(options: RecentObservationRpcOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("recent observation RPC options are required");
    assertIssuedDiscoveryTransport(options.transport);
    if (
      !options.provider
      || typeof options.provider.provider !== "string"
      || options.provider.provider.length === 0
      || typeof options.provider.backendEpoch !== "string"
      || options.provider.backendEpoch.length === 0
    ) throw new TypeError("discovery provider identity is required");
    this.transport = options.transport;
    this.provider = Object.freeze({ ...options.provider });
    issuedRecentObservationRpcObservers.add(this);
  }

  async scan(cutoffValue: CanonicalCutoffV1, signal: AbortSignal): Promise<RecentObservationScanV1> {
    const cutoff = decodeCanonicalCutoff(cutoffValue);
    let range: { readonly from: string; readonly to: string };
    try {
      range = recentObservationRange(cutoff.number);
    } catch (error) {
      throw new RecentObservationRpcError(
        "window-unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (signal.aborted) throw signal.reason;
    const first = BigInt(range.from);
    const numbers = Object.freeze(Array.from({ length: 50 }, (_, index) => (first + BigInt(index)).toString()));
    const source = Object.freeze({
      chainId: cutoff.chainId,
      number: cutoff.number,
      hash: cutoff.hash,
      stateRoot: cutoff.stateRoot,
    });
    const run = (method: string, params: CanonicalJson, target: CanonicalJson) => this.transport.request<unknown>({
      requestId: requestId(cutoff, method, params),
      provider: this.provider,
      source,
      method,
      params,
      requestCodec: REQUEST_CODEC,
      target,
      manager: null,
      topic: null,
      lookback: 50,
      chunk: 1,
      phase: "recent-observation",
      workClassRef: WORK_CLASS,
      ownerRef: OWNER_REF,
      signal,
    });
    const headers = await Promise.all(numbers.map(async number => {
      const params = Object.freeze([blockTag(number), false]) as CanonicalJson;
      return header(await run("eth_getBlockByNumber", params, blockTag(number)), number);
    }));
    for (let index = 1; index < headers.length; index += 1) {
      if (headers[index]!.parentHash !== headers[index - 1]!.hash) {
        throw new RecentObservationRpcError("header-chain-mismatch", "recent observation header chain is not contiguous");
      }
    }
    const last = headers.at(-1)!;
    if (last.hash !== cutoff.hash || last.stateRoot !== cutoff.stateRoot || last.number !== cutoff.number) {
      throw new RecentObservationRpcError("cutoff-mismatch", "recent observation does not end at the frozen cutoff");
    }
    const logSets = await Promise.all(headers.map(async observed => {
      const filter = Object.freeze({ blockHash: observed.hash });
      const params = Object.freeze([filter]) as CanonicalJson;
      return array(await run("eth_getLogs", params, observed.hash), `logs[${observed.number}]`)
        .map((value, index) => logObservation(value, observed, index))
        .filter((value): value is EvmLogObservationV1 => value !== null);
    }));
    // Recent observations nominate positive evidence only; they never supply
    // source omission authority. Keep the newest bounded suffix so a busy
    // 50-block window cannot turn one receipt into an unbounded pseudo-index.
    // Complete cold-start coverage remains owned by Family rolling sources.
    const retainedLogSets: (readonly EvmLogObservationV1[])[] = logSets.map(() => Object.freeze([]));
    let remaining = MAX_RECENT_POSITIVE_LOGS;
    for (let index = logSets.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const logs = logSets[index]!;
      const count = Math.min(remaining, logs.length);
      retainedLogSets[index] = Object.freeze(logs.slice(logs.length - count));
      remaining -= count;
    }
    const rawByHash = new Map<Hash, RawEvidenceLocatorContentV1>();
    const seenLogIdentities = new Set<string>();
    const blocks: ObservedBlockV1[] = headers.map((observed, blockIndex) => {
      const evidence = retainedLogSets[blockIndex]!.map(log => {
        const identity = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
        if (seenLogIdentities.has(identity)) {
          throw new RecentObservationRpcError("malformed-log", "duplicate log identity in exact block observation");
        }
        seenLogIdentities.add(identity);
        const rawBytes = encodeEvmLogObservation(log);
        const rawLocatorHash = sha256Hex(rawBytes);
        rawByHash.set(rawLocatorHash, Object.freeze({
          kind: "raw-evidence-locator" as const,
          version: SOURCE_EVIDENCE_VERSION_V1,
          rawLocatorHash,
          bytes: rawBytes,
        }));
        return Object.freeze({
          kind: "recent-log" as const,
          version: SOURCE_EVIDENCE_VERSION_V1,
          sourcePlanRef: null,
          ownerRef: null,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          address: log.address,
          topic: log.topics[0]!,
          rawLocatorHash,
        }) satisfies RecentLogEvidenceRefV1;
      }).sort((left, right) => BigInt(left.logIndex) < BigInt(right.logIndex) ? -1 : BigInt(left.logIndex) > BigInt(right.logIndex) ? 1 : 0);
      return Object.freeze({
        number: observed.number,
        hash: observed.hash,
        parentHash: observed.parentHash,
        evidence: Object.freeze(evidence),
      });
    });
    return Object.freeze({
      kind: "recent-observation-scan" as const,
      version: 1 as const,
      blocks: Object.freeze(blocks),
      rawEvidenceLocators: Object.freeze([...rawByHash.values()].sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash))),
    });
  }
}

const issuedRecentObservationRpcObservers = new WeakSet<object>();

export function assertIssuedRecentObservationRpcObserver(
  value: unknown,
): asserts value is RecentObservationRpcObserver {
  if (value === null || typeof value !== "object" || !issuedRecentObservationRpcObservers.has(value)) {
    throw new TypeError("recent observation RPC observer is not owner-issued");
  }
}

export const createRecentObservationRpcObserver = (
  options: RecentObservationRpcOptions,
): RecentObservationRpcObserver => new RecentObservationRpcObserver(options);
