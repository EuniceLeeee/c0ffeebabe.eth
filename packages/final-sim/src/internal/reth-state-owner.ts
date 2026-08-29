import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type { RevmWorkerAuthorityIssuer } from "../../../../runtime/revm-workers/src/lifecycle.ts";
import {
  readIssuedProducerCurrentSourceSessionCapabilityV1,
  type ProducerCurrentSourceSessionCapabilityV1,
  type ProducerCurrentSourceSessionViewV1,
} from "../../../canonical-source/src/index.ts";
import {
  createQualifiedFinalSimulationExecutorStateSnapshotIssuer,
} from "./state-snapshot.ts";
import type {
  QualifiedFinalSimulationExecutorStateFactV1,
  QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1,
  SourceViewV1,
} from "../index.ts";

/** A process-local CanonicalSource-issued session capability. */
export type RethStateOwnerSessionV1 = ProducerCurrentSourceSessionCapabilityV1;

export interface RethStateOwnerAccountRequestV1 {
  readonly address: string;
  readonly storageSlots?: readonly string[];
}

export interface RethQualifiedExecutorStateOwnerRequestV1 {
  readonly session: RethStateOwnerSessionV1;
  readonly authority: RevmWorkerAuthorityIssuer;
  readonly executorAddress: string;
  readonly callerAddress: string;
  /** The code hash selected by the qualified executor release, not caller data. */
  readonly qualifiedExecutorCodeHash: Hash;
  /** Static execution controls; account/state fields are forbidden here. */
  readonly executorConfig?: CanonicalJson;
  readonly accounts?: readonly RethStateOwnerAccountRequestV1[];
  readonly signal?: AbortSignal;
}

export interface RethStateOwnerTransportOptions {
  readonly endpoint: string | URL;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable transport for deterministic local RPC fixtures only. */
  readonly fetch?: typeof globalThis.fetch;
}

export type RethStateOwnerFailureCode =
  | "source-stale"
  | "abort"
  | "deadline"
  | "transport"
  | "rpc"
  | "malformed-response"
  | "state-unavailable"
  | "state-mismatch";

export class RethStateOwnerError extends Error {
  readonly code: RethStateOwnerFailureCode;

  constructor(code: RethStateOwnerFailureCode, message: string) {
    super(message);
    this.name = "RethStateOwnerError";
    this.code = code;
  }
}

interface RpcResult {
  readonly result: unknown;
}

interface HeaderFact {
  readonly hash: Hash;
  readonly number: string;
  readonly stateRoot: Hash;
  readonly timestamp?: string;
  readonly gasLimit?: string;
  readonly baseFeePerGas?: string;
  readonly miner?: string;
  readonly mixHash?: Hash;
}

interface AccountFact {
  readonly balance: string;
  readonly nonce: string;
  readonly code: string;
  readonly storage: Readonly<Record<string, string>>;
}

interface MutableAccountFact {
  balance?: string;
  nonce?: string;
  code?: string;
  readonly storage: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const RESERVED_CONFIG_KEYS = Object.freeze([
  "accounts",
  "state",
  "stateOverrides",
  "to",
  "target",
  "data",
  "calldata",
  "executor",
  "block",
]);

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) throw new TypeError(`${path} must be a 20-byte address`);
  return value.toLowerCase();
}

function bytes(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== "string" || !BYTES_RE.test(value) || (!allowEmpty && value === "0x")) throw new TypeError(`${path} must be hex bytes`);
  return value.toLowerCase();
}

function hash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new TypeError(`${path} must be a 32-byte hash`);
  return assertHash(value.toLowerCase(), path);
}

function quantity(value: unknown, path: string): string {
  if (typeof value !== "string" || !QUANTITY_RE.test(value)) throw new TypeError(`${path} must be a JSON-RPC quantity`);
  return BigInt(value).toString(10);
}

function quantityHex(value: unknown, path: string): string {
  if (typeof value !== "string" || !QUANTITY_RE.test(value)) throw new TypeError(`${path} must be a JSON-RPC quantity`);
  return value.toLowerCase();
}

function source(value: unknown, path: string): SourceViewV1 {
  const object = record(value, path);
  assertExactKeys(object, ["chainId", "number", "hash", "stateRoot"], path);
  return deepFreeze({
    chainId: assertNonEmptyString(object.chainId, `${path}.chainId`),
    number: quantityOrDecimal(object.number, `${path}.number`),
    hash: hash(object.hash, `${path}.hash`),
    stateRoot: hash(object.stateRoot, `${path}.stateRoot`),
  });
}

function quantityOrDecimal(value: unknown, path: string): string {
  if (typeof value === "string" && QUANTITY_RE.test(value)) return BigInt(value).toString(10);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value).toString(10);
  throw new TypeError(`${path} must be a decimal or JSON-RPC quantity`);
}

function sameSource(left: SourceViewV1, right: SourceViewV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function slot(value: unknown, path: string): string {
  const raw = bytes(value, path);
  if (raw.length !== 66) throw new TypeError(`${path} must be a 32-byte storage slot`);
  return raw;
}

function canonicalConfig(value: CanonicalJson | undefined): CanonicalJson {
  const config = value === undefined ? {} : JSON.parse(encodeCanonicalJson(value)) as CanonicalJson;
  const object = record(config, "executorConfig");
  for (const key of RESERVED_CONFIG_KEYS) {
    if (own(object, key)) throw new TypeError(`executorConfig.${key} is state-owned`);
  }
  return deepFreeze(config);
}

function normalizeAccounts(input: RethQualifiedExecutorStateOwnerRequestV1): readonly RethStateOwnerAccountRequestV1[] {
  const entries = [
    { address: input.executorAddress },
    { address: input.callerAddress },
    ...(input.accounts ?? []),
  ];
  const byAddress = new Map<string, string[]>();
  for (const [index, item] of entries.entries()) {
    if (item === null || typeof item !== "object") throw new TypeError(`accounts[${index}] must be an object`);
    const normalizedAddress = address(item.address, `accounts[${index}].address`);
    const slots = (item.storageSlots ?? []).map((value, slotIndex) => slot(value, `accounts[${index}].storageSlots[${slotIndex}]`));
    const previous = byAddress.get(normalizedAddress) ?? [];
    byAddress.set(normalizedAddress, [...previous, ...slots]);
  }
  return Object.freeze([...byAddress.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([normalizedAddress, slots]) => Object.freeze({
    address: normalizedAddress,
    storageSlots: Object.freeze([...new Set(slots)].sort()),
  })));
}

function endpoint(value: string | URL): string {
  let url: URL;
  try { url = value instanceof URL ? new URL(value.href) : new URL(value); } catch { throw new TypeError("Reth state RPC endpoint must be a URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Reth state RPC endpoint must use HTTP(S)");
  return url.href;
}

function timeout(value: number | undefined): number {
  const result = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(result) || result <= 0) throw new TypeError("timeoutMs must be positive");
  return result;
}

async function runBounded(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (!task) return;
      try {
        await task();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failed) throw failure;
}

function freezeAccountFact(value: MutableAccountFact, accountAddress: string): AccountFact {
  if (value.balance === undefined || value.nonce === undefined || value.code === undefined) {
    throw new RethStateOwnerError("state-unavailable", `Reth account state is incomplete for ${accountAddress}`);
  }
  return Object.freeze({
    balance: value.balance,
    nonce: value.nonce,
    code: value.code,
    storage: Object.freeze(value.storage),
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function parseRpc(body: string, requestId: string): RpcResult {
  let value: unknown;
  try { value = decodeJson(body); } catch { throw new RethStateOwnerError("malformed-response", "Reth RPC response is not JSON"); }
  const object = record(value, "rpc.response");
  if (object.jsonrpc !== "2.0" || object.id !== requestId) throw new RethStateOwnerError("malformed-response", "Reth RPC response id mismatch");
  if (own(object, "error")) {
    try { assertExactKeys(object, ["jsonrpc", "id", "error"], "rpc.response"); } catch { throw new RethStateOwnerError("malformed-response", "Reth RPC error response shape is invalid"); }
    throw new RethStateOwnerError("rpc", "Reth RPC returned an error");
  }
  if (!own(object, "result")) throw new RethStateOwnerError("malformed-response", "Reth RPC response has no result");
  try { assertExactKeys(object, ["jsonrpc", "id", "result"], "rpc.response"); } catch { throw new RethStateOwnerError("malformed-response", "Reth RPC result response shape is invalid"); }
  return { result: object.result };
}

function header(value: unknown, expected: SourceViewV1): HeaderFact {
  if (value === null) throw new RethStateOwnerError("state-unavailable", "Reth block header is unavailable");
  const object = record(value, "block");
  const actual = source({
    chainId: expected.chainId,
    number: object.number,
    hash: object.hash,
    stateRoot: object.stateRoot,
  }, "block");
  if (!sameSource(actual, expected)) throw new RethStateOwnerError("state-mismatch", "Reth block header does not match canonical source");
  const optionalQuantity = (key: string): string | undefined => object[key] === undefined || object[key] === null ? undefined : quantityHex(object[key], `block.${key}`);
  const optionalHash = (key: string): Hash | undefined => object[key] === undefined || object[key] === null ? undefined : hash(object[key], `block.${key}`);
  return Object.freeze({
    hash: hash(actual.hash, "block.hash"),
    number: actual.number,
    stateRoot: hash(actual.stateRoot, "block.stateRoot"),
    timestamp: optionalQuantity("timestamp"),
    gasLimit: optionalQuantity("gasLimit"),
    baseFeePerGas: optionalQuantity("baseFeePerGas"),
    miner: object.miner === undefined || object.miner === null ? undefined : address(object.miner, "block.miner"),
    mixHash: optionalHash("mixHash"),
  });
}

function accountFacts(addresses: readonly RethStateOwnerAccountRequestV1[], values: readonly AccountFact[]): CanonicalJson {
  const result: Record<string, CanonicalJson> = {};
  for (const [index, request] of addresses.entries()) {
    const value = values[index];
    if (!value) throw new Error("account response count mismatch");
    result[request.address] = {
      balance: value.balance,
      nonce: value.nonce,
      code: value.code,
      ...(Object.keys(value.storage).length === 0 ? {} : { storage: value.storage }),
    };
  }
  return deepFreeze(result);
}

function stateInput(sourceValue: SourceViewV1, block: HeaderFact): CanonicalJson {
  const blockValue: Record<string, CanonicalJson> = {};
  if (block.timestamp !== undefined) blockValue.timestamp = quantity(block.timestamp, "block.timestamp");
  if (block.gasLimit !== undefined) blockValue.gasLimit = quantity(block.gasLimit, "block.gasLimit");
  if (block.baseFeePerGas !== undefined) blockValue.baseFeePerGas = quantity(block.baseFeePerGas, "block.baseFeePerGas");
  if (block.miner !== undefined) blockValue.beneficiary = block.miner;
  if (block.mixHash !== undefined) blockValue.prevrandao = block.mixHash;
  return deepFreeze({ chainId: sourceValue.chainId, block: blockValue });
}

/**
 * A production state owner backed by Reth's EIP-1898 JSON-RPC reads.  It does
 * not accept account bytes, code, balances, nonces, or storage from callers;
 * callers supply only addresses/slots and the owner reads every fact at the
 * exact canonical block hash.  A process-local snapshot capability is issued
 * only after the current-source fence and qualified-code check both pass.
 */
export class RethQualifiedExecutorStateOwner {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;
  #requestSequence = 0;

  constructor(options: RethStateOwnerTransportOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("Reth state owner options are required");
    this.#endpoint = endpoint(options.endpoint);
    this.#timeoutMs = timeout(options.timeoutMs);
    this.#headers = Object.freeze({ ...(options.headers ?? {}) });
    for (const [key, value] of Object.entries(this.#headers)) if (typeof value !== "string") throw new TypeError(`headers.${key} must be a string`);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new TypeError("global fetch is required");
  }

  async issue(input: RethQualifiedExecutorStateOwnerRequestV1): Promise<QualifiedFinalSimulationExecutorStateSnapshotCapabilityV1> {
    if (input === null || typeof input !== "object") throw new TypeError("Reth state owner request is required");
    const session = readIssuedProducerCurrentSourceSessionCapabilityV1(input.session);
    // Canonical-source owns a full header (including parentHash), while the
    // execution state identity is the strict four-field EVM source view.
    const expectedSource = source({
      chainId: session.source.chainId,
      number: session.source.number,
      hash: session.source.hash,
      stateRoot: session.source.stateRoot,
    }, "session.source");
    const cutoff = source(session.generation.cutoff, "session.generation.cutoff");
    const generationId = assertNonEmptyString(session.generationId, "session.generationId");
    if (cutoff.chainId !== expectedSource.chainId) throw new TypeError("session cutoff chain mismatch");
    const executorAddress = address(input.executorAddress, "executorAddress");
    const callerAddress = address(input.callerAddress, "callerAddress");
    const qualifiedExecutorCodeHash = hash(input.qualifiedExecutorCodeHash, "qualifiedExecutorCodeHash");
    const config = canonicalConfig(input.executorConfig);
    const accounts = normalizeAccounts({ ...input, executorAddress, callerAddress });
    await this.#assertCurrent(session, input.signal);
    const authority = input.authority;
    if (authority === null || typeof authority !== "object" || typeof authority.issue !== "function" || typeof authority.assertCurrent !== "function") throw new TypeError("Reth state owner authority is required");
    const authorityBinding = authority.issue();
    authority.assertCurrent(authorityBinding);
    let block: HeaderFact | undefined;
    const mutableState = accounts.map((): MutableAccountFact => ({ storage: {} }));
    const tasks: (() => Promise<void>)[] = [async () => {
      block = header(await this.rpc("eth_getBlockByHash", [expectedSource.hash, false], input.signal), expectedSource);
    }];
    for (const [index, account] of accounts.entries()) {
      const value = mutableState[index]!;
      tasks.push(
        async () => { value.balance = quantity(await this.rpc("eth_getBalance", [account.address, { blockHash: expectedSource.hash, requireCanonical: true }], input.signal), `balance.${account.address}`); },
        async () => { value.nonce = quantity(await this.rpc("eth_getTransactionCount", [account.address, { blockHash: expectedSource.hash, requireCanonical: true }], input.signal), `nonce.${account.address}`); },
        async () => { value.code = bytes(await this.rpc("eth_getCode", [account.address, { blockHash: expectedSource.hash, requireCanonical: true }], input.signal), `code.${account.address}`); },
      );
      for (const storageSlot of account.storageSlots ?? []) {
        tasks.push(async () => {
          value.storage[storageSlot] = bytes(await this.rpc("eth_getStorageAt", [account.address, storageSlot, { blockHash: expectedSource.hash, requireCanonical: true }], input.signal), `storage.${account.address}.${storageSlot}`);
        });
      }
    }
    await runBounded(tasks, DEFAULT_MAX_CONCURRENT_REQUESTS);
    if (block === undefined) throw new RethStateOwnerError("state-unavailable", "Reth block header was not read");
    const stateValues = mutableState.map((value, index) => freezeAccountFact(value, accounts[index]!.address));
    await this.#assertCurrent(session, input.signal);
    authority.assertCurrent(authorityBinding);
    const executor = stateValues[accounts.findIndex(item => item.address === executorAddress)];
    if (!executor) throw new RethStateOwnerError("state-unavailable", "executor account was not read");
    const executorCodeHash = hashDomain("aloha/qualified-final-simulation-executor-code/v1", executor.code) as Hash;
    if (executorCodeHash !== qualifiedExecutorCodeHash) throw new RethStateOwnerError("state-mismatch", "Reth executor code does not match qualified executor code hash");
    const fact: QualifiedFinalSimulationExecutorStateFactV1 = {
      kind: "aloha.qualified-final-simulation-executor-state-v1",
      authorityBinding,
      generationId,
      cutoff,
      source: expectedSource,
      executorAddress,
      callerAddress,
      executorCode: executor.code,
      executorCodeHash,
      executorConfig: config,
      executorConfigHash: hashDomain("aloha/qualified-final-simulation-executor-config/v1", config),
      stateInput: stateInput(expectedSource, block),
      stateAccounts: accountFacts(accounts, stateValues),
    };
    return createQualifiedFinalSimulationExecutorStateSnapshotIssuer({ fact, authority }).issue();
  }

  async #request(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    const requestId = `aloha-state-${++this.#requestSequence}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) throw new RethStateOwnerError("abort", "Reth state read aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("deadline elapsed", "TimeoutError")); }, this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...this.#headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new RethStateOwnerError("transport", `Reth state RPC HTTP ${response.status}`);
      const body = await response.text();
      return parseRpc(body, requestId).result;
    } catch (error) {
      if (error instanceof RethStateOwnerError) throw error;
      if (timedOut) throw new RethStateOwnerError("deadline", "Reth state RPC deadline elapsed");
      if (signal?.aborted || isAbort(error)) throw new RethStateOwnerError("abort", "Reth state RPC aborted");
      throw new RethStateOwnerError("transport", `Reth state RPC transport failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #assertCurrent(session: ProducerCurrentSourceSessionViewV1, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RethStateOwnerError("abort", "Reth state read aborted");
    try { await session.assertCurrent(signal); } catch (error) { throw new RethStateOwnerError("source-stale", `canonical source is stale: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private rpc(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    return this.#request(method, params, signal);
  }
}

export function createRethQualifiedExecutorStateOwner(options: RethStateOwnerTransportOptions): RethQualifiedExecutorStateOwner {
  return new RethQualifiedExecutorStateOwner(options);
}
