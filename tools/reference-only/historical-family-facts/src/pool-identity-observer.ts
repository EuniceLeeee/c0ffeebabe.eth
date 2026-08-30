import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { loadHistoricalFamilyFactBundleV1 } from "./index.ts";
import {
  observeHistoricalExecutionVariantsV1,
  type HistoricalExecutionManifestIdentityV1,
  type HistoricalExecutionVariantCaseV1,
} from "./variant-observer.ts";

const FACTORY_SELECTOR = "0xc45a0155";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
const V2_GET_PAIR_SELECTOR = "0xe6a43905";
const V3_FEE_SELECTOR = "0xddca3f43";
const V3_TICK_SPACING_SELECTOR = "0xd0c93a7c";
const V3_GET_POOL_SELECTOR = "0x1698ee82";
const UNIV2_SWAP_SELECTOR = "0x022c0d9f";
const UNIV3_SWAP_SELECTOR = "0x128acb08";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const CANONICAL_BLOCK_POST_STATE = "canonical-block-post-state" as const;

export const HISTORICAL_POOL_IDENTITY_OBSERVER_SOURCE_DIGEST_V1 = sha256Hex(
  Uint8Array.from(readFileSync(fileURLToPath(import.meta.url))),
);

export interface HistoricalPoolIdentityJsonRpcV1 {
  request(method: string, params: readonly CanonicalJson[]): Promise<unknown>;
}

export interface HistoricalPoolIdentityObservationRequestV1 {
  readonly rootDirectory: string;
  readonly manifestRoot: Hash;
  readonly caseId: Hash;
}

export type HistoricalPoolIdentityStatusV1 =
  | "reverse-verified-ephemeral"
  | "contradicted"
  | "unavailable"
  | "unsupported"
  | "unresolved";

export interface HistoricalPoolIdentityCutoffV1 {
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly stateRoot: Hash;
  readonly statePosition: typeof CANONICAL_BLOCK_POST_STATE;
  readonly eip1898: Readonly<{ blockHash: Hash; requireCanonical: true }>;
}

export interface HistoricalPoolIdentityCaseBindingV1 {
  readonly caseId: Hash;
  readonly selectorCandidate: "univ2-standard" | "univ3-standard";
  readonly framePath: readonly string[];
  readonly target: string;
  readonly selector: string;
  readonly calldataSha256: Hash;
  readonly calldataByteLength: string;
}

export interface HistoricalPoolIdentityRpcEvidenceV1 {
  readonly label: string;
  readonly method: string;
  readonly params: readonly CanonicalJson[];
  readonly requestRoot: Hash;
  readonly responseKind: "result" | "error";
  readonly responseRoot: Hash;
}

export interface HistoricalPoolReverseIdentityV1 {
  readonly family: "univ2-standard" | "univ3-standard";
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: string | null;
  readonly tickSpacing: string | null;
  readonly reversePool: string;
  readonly reversePoolReversed: string | null;
}

export interface HistoricalPoolIdentityCoverageV1 {
  readonly status: "unresolved";
  readonly reason: string;
}

export interface HistoricalPoolIdentityReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.historical-pool-identity-report";
  readonly advisoryOnly: true;
  readonly status: HistoricalPoolIdentityStatusV1;
  readonly reasons: readonly string[];
  readonly sourceDigest: Hash;
  readonly manifestIdentity: HistoricalExecutionManifestIdentityV1;
  readonly statePosition: typeof CANONICAL_BLOCK_POST_STATE;
  readonly cutoff: HistoricalPoolIdentityCutoffV1 | null;
  readonly caseBinding: HistoricalPoolIdentityCaseBindingV1 | null;
  readonly requests: readonly HistoricalPoolIdentityRpcEvidenceV1[];
  readonly identity: HistoricalPoolReverseIdentityV1 | null;
  readonly actionCoverage: HistoricalPoolIdentityCoverageV1;
  readonly effectsCoverage: HistoricalPoolIdentityCoverageV1;
  readonly reportRoot: Hash;
}

class ObservationFailure extends Error {
  readonly status: Exclude<HistoricalPoolIdentityStatusV1, "reverse-verified-ephemeral">;

  constructor(
    status: Exclude<HistoricalPoolIdentityStatusV1, "reverse-verified-ephemeral">,
    message: string,
  ) {
    super(message);
    this.name = "ObservationFailure";
    this.status = status;
  }
}

function fail(message: string): never {
  throw new ObservationFailure("unresolved", message);
}

function contradict(message: string): never {
  throw new ObservationFailure("contradicted", message);
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`expected plain object at ${path}`);
  return value as Record<string, unknown>;
}

function hash(value: unknown, path: string): Hash {
  if (typeof value !== "string") fail(`expected 32-byte hash at ${path}`);
  const result = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) fail(`expected 32-byte hash at ${path}`);
  return result as Hash;
}

function address(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`expected address at ${path}`);
  const result = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) fail(`expected address at ${path}`);
  return result;
}

function hexData(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`expected hex data at ${path}`);
  const result = value.toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result)) fail(`expected even-length hex data at ${path}`);
  return result;
}

function quantity(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`expected canonical hex quantity at ${path}`);
  const result = value.toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(result)) fail(`expected canonical hex quantity at ${path}`);
  return result;
}

function chainId(value: CanonicalJson, path: string): string {
  const result = BigInt(quantity(value, path));
  if (result === 0n) fail(`chainId must be positive at ${path}`);
  return result.toString(10);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "number"
    ? descriptor.value
    : null;
}

function unsupportedEip1898(error: unknown): boolean {
  const code = errorCode(error);
  return code === -32601 || code === -32602 ||
    /eip-?1898|requirecanonical|blockhash.*unsupported|unsupported.*block/i.test(errorText(error));
}

function errorRoot(error: unknown): Hash {
  return hashDomain("aloha/historical-pool-identity-rpc-error/v1", {
    code: errorCode(error) === null ? null : String(errorCode(error)),
    message: errorText(error),
  });
}

async function rpcRequest(
  rpc: HistoricalPoolIdentityJsonRpcV1,
  evidence: HistoricalPoolIdentityRpcEvidenceV1[],
  label: string,
  method: string,
  params: readonly CanonicalJson[],
  eip1898Required: boolean,
): Promise<CanonicalJson> {
  const frozenParams = Object.freeze([...params]);
  const requestRoot = hashDomain("aloha/historical-pool-identity-rpc-request/v1", {
    label,
    method,
    params: frozenParams,
  });
  try {
    const raw = await rpc.request(method, frozenParams);
    const bytes = encodeCanonicalBytes(raw);
    evidence.push(Object.freeze({
      label,
      method,
      params: frozenParams,
      requestRoot,
      responseKind: "result",
      responseRoot: sha256Hex(bytes),
    }));
    if (raw === null) fail(`null RPC result for ${label}`);
    return raw as CanonicalJson;
  } catch (error) {
    if (error instanceof ObservationFailure) throw error;
    evidence.push(Object.freeze({
      label,
      method,
      params: frozenParams,
      requestRoot,
      responseKind: "error",
      responseRoot: errorRoot(error),
    }));
    if (eip1898Required && unsupportedEip1898(error)) {
      throw new ObservationFailure("unsupported", `EIP-1898 unavailable for ${label}: ${errorText(error)}`);
    }
    throw new ObservationFailure("unavailable", `RPC unavailable for ${label}: ${errorText(error)}`);
  }
}

function exactReturnWord(value: CanonicalJson, path: string): string {
  const data = hexData(value, path);
  if (!/^0x[0-9a-f]{64}$/.test(data)) fail(`expected exact 32-byte ABI return at ${path}`);
  return data.slice(2);
}

function decodeAddressReturn(value: CanonicalJson, path: string): string {
  const word = exactReturnWord(value, path);
  if (!/^0{24}/.test(word)) fail(`non-canonical address return padding at ${path}`);
  return `0x${word.slice(24)}`;
}

function decodeUint24Return(value: CanonicalJson, path: string): bigint {
  const word = exactReturnWord(value, path);
  if (!/^0{58}/.test(word)) fail(`non-canonical uint24 return padding at ${path}`);
  return BigInt(`0x${word}`);
}

function decodeInt24Return(value: CanonicalJson, path: string): bigint {
  const word = exactReturnWord(value, path);
  const raw = BigInt(`0x${word.slice(58)}`);
  const negative = raw >= (1n << 23n);
  const expectedPrefix = negative ? "f".repeat(58) : "0".repeat(58);
  if (word.slice(0, 58) !== expectedPrefix) fail(`non-canonical int24 return padding at ${path}`);
  return negative ? raw - (1n << 24n) : raw;
}

function addressArgument(value: string): string {
  return value.slice(2).padStart(64, "0");
}

function uint24Argument(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function caseFrame(trace: CanonicalJson, item: HistoricalExecutionVariantCaseV1): Record<string, unknown> {
  let node = plainObject(trace, "$.trace");
  for (const [depth, rawIndex] of item.framePath.entries()) {
    if (!/^(0|[1-9][0-9]*)$/.test(rawIndex)) fail("case framePath is not canonical decimal");
    if (!Array.isArray(node.calls)) fail(`case framePath has no calls at depth ${depth}`);
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || node.calls[index] === undefined) fail("case framePath is outside trace");
    node = plainObject(node.calls[index], `$.trace framePath depth ${depth}`);
  }
  return node;
}

function bindCase(trace: CanonicalJson, item: HistoricalExecutionVariantCaseV1): HistoricalPoolIdentityCaseBindingV1 {
  const frame = caseFrame(trace, item);
  if (frame.type !== "CALL") fail("case trace frame is not a CALL");
  const calldata = hexData(frame.input, "$.caseFrame.input");
  const bytes = Uint8Array.from(Buffer.from(calldata.slice(2), "hex"));
  const target = address(frame.to, "$.caseFrame.to");
  if (target !== item.to) fail("case target does not match trace frame");
  const expectedSelector = item.selectorCandidate === "univ2-standard" ? UNIV2_SWAP_SELECTOR : UNIV3_SWAP_SELECTOR;
  if (item.selector !== expectedSelector) fail("case selector candidate is not derived from its swap selector");
  if (calldata.slice(0, 10) !== item.selector) fail("case selector does not match trace frame");
  if (sha256Hex(bytes) !== item.calldataSha256 || String(bytes.length) !== item.calldataByteLength) {
    fail("case calldata commitment does not match trace frame");
  }
  return Object.freeze({
    caseId: item.caseId,
    selectorCandidate: item.selectorCandidate,
    framePath: Object.freeze([...item.framePath]),
    target,
    selector: item.selector,
    calldataSha256: item.calldataSha256,
    calldataByteLength: item.calldataByteLength,
  });
}

function report(
  status: HistoricalPoolIdentityStatusV1,
  reasons: readonly string[],
  manifestIdentity: HistoricalExecutionManifestIdentityV1,
  cutoff: HistoricalPoolIdentityCutoffV1 | null,
  caseBinding: HistoricalPoolIdentityCaseBindingV1 | null,
  requests: readonly HistoricalPoolIdentityRpcEvidenceV1[],
  identity: HistoricalPoolReverseIdentityV1 | null,
): HistoricalPoolIdentityReportV1 {
  const actionCoverage = Object.freeze({
    status: "unresolved" as const,
    reason: "current action construction is outside the pool identity observer",
  });
  const effectsCoverage = Object.freeze({
    status: "unresolved" as const,
    reason: "frame-local execution effects are outside the pool identity observer",
  });
  const base = {
    schemaVersion: 1 as const,
    kind: "aloha.historical-pool-identity-report" as const,
    advisoryOnly: true as const,
    status,
    reasons: Object.freeze([...reasons]),
    sourceDigest: HISTORICAL_POOL_IDENTITY_OBSERVER_SOURCE_DIGEST_V1,
    manifestIdentity,
    statePosition: CANONICAL_BLOCK_POST_STATE,
    cutoff,
    caseBinding,
    requests: Object.freeze([...requests]),
    identity,
    actionCoverage,
    effectsCoverage,
  };
  return Object.freeze({
    ...base,
    reportRoot: hashDomain("aloha/historical-pool-identity-report/v1", base),
  });
}

async function ethCall(
  rpc: HistoricalPoolIdentityJsonRpcV1,
  evidence: HistoricalPoolIdentityRpcEvidenceV1[],
  label: string,
  to: string,
  data: string,
  cutoff: HistoricalPoolIdentityCutoffV1,
): Promise<CanonicalJson> {
  return rpcRequest(
    rpc,
    evidence,
    label,
    "eth_call",
    [{ to, data }, cutoff.eip1898],
    true,
  );
}

async function reverseIdentity(
  rpc: HistoricalPoolIdentityJsonRpcV1,
  evidence: HistoricalPoolIdentityRpcEvidenceV1[],
  item: HistoricalExecutionVariantCaseV1,
  cutoff: HistoricalPoolIdentityCutoffV1,
): Promise<HistoricalPoolReverseIdentityV1> {
  const pool = item.to;
  if (pool === ZERO_ADDRESS) contradict("observed pool address is zero");
  const factory = decodeAddressReturn(
    await ethCall(rpc, evidence, "pool.factory", pool, FACTORY_SELECTOR, cutoff),
    "$.pool.factory",
  );
  const token0 = decodeAddressReturn(
    await ethCall(rpc, evidence, "pool.token0", pool, TOKEN0_SELECTOR, cutoff),
    "$.pool.token0",
  );
  const token1 = decodeAddressReturn(
    await ethCall(rpc, evidence, "pool.token1", pool, TOKEN1_SELECTOR, cutoff),
    "$.pool.token1",
  );
  if (factory === ZERO_ADDRESS) contradict("pool factory address is zero");
  if (token0 === ZERO_ADDRESS || token1 === ZERO_ADDRESS) contradict("pool token address is zero");
  if (token0 >= token1) contradict("pool tokens are not in strict token0 < token1 order");
  if (item.selectorCandidate === "univ2-standard") {
    const reversePool = decodeAddressReturn(
      await ethCall(
        rpc,
        evidence,
        "factory.getPair(token0,token1)",
        factory,
        `${V2_GET_PAIR_SELECTOR}${addressArgument(token0)}${addressArgument(token1)}`,
        cutoff,
      ),
      "$.factory.getPair.token0-token1",
    );
    const reversePoolReversed = decodeAddressReturn(
      await ethCall(
        rpc,
        evidence,
        "factory.getPair(token1,token0)",
        factory,
        `${V2_GET_PAIR_SELECTOR}${addressArgument(token1)}${addressArgument(token0)}`,
        cutoff,
      ),
      "$.factory.getPair.token1-token0",
    );
    if (reversePool === ZERO_ADDRESS || reversePoolReversed === ZERO_ADDRESS) {
      contradict("factory reverse lookup returned a zero pool address");
    }
    return Object.freeze({
      family: item.selectorCandidate,
      pool,
      factory,
      token0,
      token1,
      fee: null,
      tickSpacing: null,
      reversePool,
      reversePoolReversed,
    });
  }
  const fee = decodeUint24Return(
    await ethCall(rpc, evidence, "pool.fee", pool, V3_FEE_SELECTOR, cutoff),
    "$.pool.fee",
  );
  const tickSpacing = decodeInt24Return(
    await ethCall(rpc, evidence, "pool.tickSpacing", pool, V3_TICK_SPACING_SELECTOR, cutoff),
    "$.pool.tickSpacing",
  );
  if (fee < 0n || fee > 0xff_ffffn) contradict("pool fee is outside uint24 range");
  if (tickSpacing <= 0n || tickSpacing > 0x7f_ffffn) {
    contradict("pool tickSpacing is outside positive int24 range");
  }
  const reversePool = decodeAddressReturn(
    await ethCall(
      rpc,
      evidence,
      "factory.getPool(token0,token1,fee)",
      factory,
      `${V3_GET_POOL_SELECTOR}${addressArgument(token0)}${addressArgument(token1)}${uint24Argument(fee)}`,
      cutoff,
    ),
    "$.factory.getPool",
  );
  if (reversePool === ZERO_ADDRESS) contradict("factory reverse lookup returned a zero pool address");
  return Object.freeze({
    family: item.selectorCandidate,
    pool,
    factory,
    token0,
    token1,
    fee: fee.toString(),
    tickSpacing: tickSpacing.toString(),
    reversePool,
    reversePoolReversed: null,
  });
}

export async function observeHistoricalPoolIdentityV1(
  rpc: HistoricalPoolIdentityJsonRpcV1,
  request: HistoricalPoolIdentityObservationRequestV1,
): Promise<HistoricalPoolIdentityReportV1> {
  const evidence: HistoricalPoolIdentityRpcEvidenceV1[] = [];
  const emptyManifestIdentity: HistoricalExecutionManifestIdentityV1 = Object.freeze({
    manifestRoot: request.manifestRoot,
    chainId: null,
    canonicalBlockHash: null,
    txHash: null,
  });
  let manifestIdentity = emptyManifestIdentity;
  let cutoff: HistoricalPoolIdentityCutoffV1 | null = null;
  let caseBinding: HistoricalPoolIdentityCaseBindingV1 | null = null;
  let identity: HistoricalPoolReverseIdentityV1 | null = null;
  try {
    const bundle = loadHistoricalFamilyFactBundleV1(request.rootDirectory, request.manifestRoot);
    const variants = observeHistoricalExecutionVariantsV1(request.rootDirectory, request.manifestRoot);
    manifestIdentity = variants.manifestIdentity;
    if (variants.status !== "observed") fail(`execution variants unavailable: ${variants.reasons.join("; ")}`);
    const matches = variants.cases.filter((item) => item.caseId === request.caseId);
    if (matches.length !== 1) fail("caseId does not identify exactly one case in the bound manifest");
    const item = matches[0]!;
    caseBinding = bindCase(bundle.results.trace, item);
    const header = plainObject(bundle.results.header, "$.header");
    const blockNumber = quantity(header.number, "$.header.number");
    const blockHash = hash(header.hash, "$.header.hash");
    const stateRoot = hash(header.stateRoot, "$.header.stateRoot");
    if (blockHash !== bundle.manifest.canonicalBlockHash) fail("cutoff header hash does not match manifest");
    cutoff = Object.freeze({
      chainId: bundle.manifest.chainId,
      blockNumber,
      blockHash,
      stateRoot,
      statePosition: CANONICAL_BLOCK_POST_STATE,
      eip1898: Object.freeze({ blockHash, requireCanonical: true as const }),
    });
    const chainIdBefore = chainId(
      await rpcRequest(rpc, evidence, "chain-id.before", "eth_chainId", [], false),
      "$.chainId.before",
    );
    if (chainIdBefore !== bundle.manifest.chainId) fail("RPC chainId before differs from bound manifest");
    const before = await rpcRequest(
      rpc,
      evidence,
      "canonical-fence.before",
      "eth_getBlockByNumber",
      [blockNumber, false],
      false,
    );
    if (!canonicalEqual(before, bundle.results.header)) fail("canonical fence before differs from bound header");
    let reverseFailure: unknown = null;
    try {
      identity = await reverseIdentity(rpc, evidence, item, cutoff);
    } catch (error) {
      reverseFailure = error;
    }
    const after = await rpcRequest(
      rpc,
      evidence,
      "canonical-fence.after",
      "eth_getBlockByNumber",
      [blockNumber, false],
      false,
    );
    const chainIdAfter = chainId(
      await rpcRequest(rpc, evidence, "chain-id.after", "eth_chainId", [], false),
      "$.chainId.after",
    );
    if (!canonicalEqual(after, bundle.results.header) || !canonicalEqual(before, after)) {
      fail("canonical fence changed during pool identity observation");
    }
    if (chainIdAfter !== bundle.manifest.chainId || chainIdAfter !== chainIdBefore) {
      fail("RPC chainId changed during pool identity observation");
    }
    if (reverseFailure !== null) throw reverseFailure;
    if (identity === null) fail("reverse identity result missing");
    const matched = identity.reversePool === identity.pool &&
      (identity.reversePoolReversed === null || identity.reversePoolReversed === identity.pool);
    return report(
      matched ? "reverse-verified-ephemeral" : "contradicted",
      matched
        ? ["response hashes are not yet backed by a persistent frozen RPC object closure"]
        : ["factory reverse lookup does not exactly return the observed pool"],
      manifestIdentity,
      cutoff,
      caseBinding,
      evidence,
      identity,
    );
  } catch (error) {
    const failure = error instanceof ObservationFailure
      ? error
      : new ObservationFailure("unresolved", error instanceof Error ? error.message : String(error));
    return report(
      failure.status,
      [failure.message],
      manifestIdentity,
      cutoff,
      caseBinding,
      evidence,
      identity,
    );
  }
}
