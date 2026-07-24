import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  BLIND_SCHEMA_VERSION,
  canonicalJson,
  revealConversionSelection,
  sha256Canonical,
  validateConversionEligibilityPlan,
  type ConversionCandidate,
  type ConversionEligibilityPlan,
} from "./adapter-family-blind-contract.js";
import { buildConversionEligibilityPlan } from "./conversion-sentinel-commitment.js";

export const CONVERSION_PRIVATE_PREDICATE_PROFILE =
  "conversion-freshness-private-predicate-v1" as const;
export const CONVERSION_PRIVATE_EVIDENCE_PROFILE =
  "conversion-freshness-private-evidence-v1" as const;
export const CONVERSION_REVEAL_PROFILE =
  "conversion-freshness-selection-reveal-v1" as const;

interface ConversionCodeRead {
  readonly id: string;
  readonly kind: "code";
  readonly address: string;
}

interface ConversionCallRead {
  readonly id: string;
  readonly kind: "call";
  readonly to: string;
  readonly data: string;
}

type ConversionTopologyRead = ConversionCodeRead | ConversionCallRead;

export interface ConversionFreshnessPrivatePredicate {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: typeof CONVERSION_PRIVATE_PREDICATE_PROFILE;
  /** Opaque public label. Protocol names belong only in the private field below. */
  readonly predicateVersion: string;
  readonly chainId: number;
  readonly protocol: string;
  readonly instanceAddress: string;
  readonly event: {
    readonly address: string;
    readonly topic0: string;
  };
  readonly topologyReads: readonly ConversionTopologyRead[];
  readonly rateReads: readonly ConversionCallRead[];
}

interface ConversionBlockHeader {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly stateRoot: string;
}

interface ConversionTopologyEvidence {
  readonly id: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly unchanged: boolean;
}

interface ConversionRateEvidence {
  readonly id: string;
  readonly beforeRaw: string;
  readonly afterRaw: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

export interface ConversionFreshnessCandidateEvidence {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: "conversion-freshness-candidate-evidence-v1";
  readonly predicateSha256: string;
  readonly protocol: string;
  readonly instanceAddress: string;
  readonly eventSourceAddress: string;
  readonly eventTopic0: string;
  readonly eventEvidenceSha256: string;
  readonly eventCount: number;
  readonly base: ConversionBlockHeader;
  readonly source: ConversionBlockHeader;
  readonly topology: readonly ConversionTopologyEvidence[];
  readonly rates: readonly ConversionRateEvidence[];
  readonly topologyUnchanged: true;
  readonly rateChangedAtSource: true;
}

interface ConversionRejectedEvidence {
  readonly sourceBlock: number;
  readonly reason: "topology_changed" | "rate_unchanged";
  readonly detailSha256: string;
}

export interface ConversionFreshnessPrivateEvidenceBundle {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: typeof CONVERSION_PRIVATE_EVIDENCE_PROFILE;
  readonly planSha256: string;
  readonly predicateSha256: string;
  readonly rangeHash: string;
  readonly chainId: number;
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly eligible: readonly {
    readonly candidate: ConversionCandidate;
    readonly evidence: ConversionFreshnessCandidateEvidence;
  }[];
  readonly rejected: readonly ConversionRejectedEvidence[];
}

export interface ConversionFreshnessReveal {
  readonly schemaVersion: typeof BLIND_SCHEMA_VERSION;
  readonly profile: typeof CONVERSION_REVEAL_PROFILE;
  readonly plan: ConversionEligibilityPlan;
  readonly reveal: {
    readonly seed: string;
    readonly salt: string;
  };
  readonly freshnessEvidence: "selected" | "missing";
  readonly eligibleSetSha256: string;
  readonly selected: ConversionCandidate | null;
  readonly selectedEvidence: ConversionFreshnessCandidateEvidence | null;
}

interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: string;
  readonly removed?: boolean;
}

interface RpcBlock {
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
  readonly stateRoot: string;
}

interface TrustedRpcRequest {
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface ConversionSecret {
  readonly seed: string;
  readonly salt: string;
}

export function conversionRangeHash(input: {
  readonly chainId: number;
  readonly fromBlock: number;
  readonly toBlock: number;
}): string {
  validateRange(input.fromBlock, input.toBlock);
  assert(
    Number.isSafeInteger(input.chainId) && input.chainId > 0,
    "conversion chain id",
  );
  return sha256Canonical({
    chainId: input.chainId,
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
  });
}

export function buildConversionFreshnessPlan(input: {
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly minEligibleCardinality: number;
  readonly productionInputsSha256: string;
  readonly secret: ConversionSecret;
}): ConversionEligibilityPlan {
  validatePrivatePredicate(input.predicate);
  validateRange(input.fromBlock, input.toBlock);
  return buildConversionEligibilityPlan({
    range: {
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
      rangeHash: conversionRangeHash({
        chainId: input.predicate.chainId,
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
      }),
    },
    predicateVersion: input.predicate.predicateVersion,
    predicateSha256: sha256Canonical(input.predicate),
    productionInputsSha256: input.productionInputsSha256,
    minEligibleCardinality: input.minEligibleCardinality,
    selectionAlgorithm: "sha256-seeded-order-v1",
  }, input.secret);
}

export async function scanConversionFreshness(input: {
  readonly plan: ConversionEligibilityPlan;
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly rpcUrl: string;
  readonly rpcTimeoutMs?: number;
  readonly rpcMinIntervalMs?: number;
  readonly logChunkSize?: number;
}): Promise<{
  readonly candidates: readonly ConversionCandidate[];
  readonly privateEvidence: ConversionFreshnessPrivateEvidenceBundle;
}> {
  validateConversionEligibilityPlan(input.plan);
  validatePrivatePredicate(input.predicate);
  assertPlanMatchesPredicate(input.plan, input.predicate);
  const rpc = new TrustedRpc(
    input.rpcUrl,
    input.rpcTimeoutMs ?? 30_000,
    input.rpcMinIntervalMs ?? 0,
  );
  const chainId = Number(BigInt(await rpc.call<string>("eth_chainId", [])));
  assert(chainId === input.predicate.chainId, "conversion RPC chain mismatch");
  const logs = await scanUpdateLogs({
    rpc,
    predicate: input.predicate,
    fromBlock: input.plan.range.fromBlock,
    toBlock: input.plan.range.toBlock,
    chunkSize: input.logChunkSize ?? 1_000,
  });
  const logsByBlock = new Map<number, RpcLog[]>();
  for (const log of logs) {
    const blockNumber = Number(BigInt(log.blockNumber));
    const bucket = logsByBlock.get(blockNumber) ?? [];
    bucket.push(log);
    logsByBlock.set(blockNumber, bucket);
  }

  const eligible: Array<{
    readonly candidate: ConversionCandidate;
    readonly evidence: ConversionFreshnessCandidateEvidence;
  }> = [];
  const rejected: ConversionRejectedEvidence[] = [];
  for (const sourceBlock of [...logsByBlock.keys()].sort((a, b) => a - b)) {
    const blockLogs = logsByBlock.get(sourceBlock)!;
    const evaluated = await evaluateCandidate({
      rpc,
      plan: input.plan,
      predicate: input.predicate,
      sourceBlock,
      logs: blockLogs,
    });
    if ("evidence" in evaluated) {
      eligible.push(evaluated);
    } else {
      rejected.push(evaluated.rejected);
    }
  }
  const candidates = eligible.map((entry) => entry.candidate);
  const privateEvidence: ConversionFreshnessPrivateEvidenceBundle = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: CONVERSION_PRIVATE_EVIDENCE_PROFILE,
    planSha256: sha256Canonical(input.plan),
    predicateSha256: sha256Canonical(input.predicate),
    rangeHash: input.plan.range.rangeHash,
    chainId,
    predicate: input.predicate,
    eligible,
    rejected,
  };
  validatePrivateEvidence(input.plan, input.predicate, candidates, privateEvidence);
  return {
    candidates: Object.freeze(candidates),
    privateEvidence: Object.freeze(privateEvidence),
  };
}

export function revealConversionFreshness(input: {
  readonly plan: ConversionEligibilityPlan;
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly candidates: readonly ConversionCandidate[];
  readonly privateEvidence: ConversionFreshnessPrivateEvidenceBundle;
  readonly secret: ConversionSecret;
}): ConversionFreshnessReveal {
  validateConversionEligibilityPlan(input.plan);
  validatePrivatePredicate(input.predicate);
  assertPlanMatchesPredicate(input.plan, input.predicate);
  validatePrivateEvidence(
    input.plan,
    input.predicate,
    input.candidates,
    input.privateEvidence,
  );
  const selection = revealConversionSelection({
    plan: input.plan,
    candidates: input.candidates,
    ...input.secret,
  });
  const selectedEvidence = selection.selected
    ? input.privateEvidence.eligible.find((entry) =>
        entry.candidate.id === selection.selected!.id
      )?.evidence ?? null
    : null;
  assert(
    selection.selected === null || selectedEvidence !== null,
    "selected conversion evidence missing",
  );
  return {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: CONVERSION_REVEAL_PROFILE,
    plan: input.plan,
    reveal: input.secret,
    freshnessEvidence: selection.freshnessEvidence,
    eligibleSetSha256: selection.eligibleSetSha256,
    selected: selection.selected,
    selectedEvidence,
  };
}

async function scanUpdateLogs(input: {
  readonly rpc: TrustedRpc;
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly chunkSize: number;
}): Promise<RpcLog[]> {
  assert(
    Number.isSafeInteger(input.chunkSize) &&
      input.chunkSize > 0 &&
      input.chunkSize <= 10_000,
    "conversion log chunk size",
  );
  const logs: RpcLog[] = [];
  const seen = new Set<string>();
  for (
    let fromBlock = input.fromBlock;
    fromBlock <= input.toBlock;
    fromBlock += input.chunkSize
  ) {
    const toBlock = Math.min(
      input.toBlock,
      fromBlock + input.chunkSize - 1,
    );
    const chunk = await input.rpc.call<RpcLog[]>("eth_getLogs", [{
      fromBlock: toQuantity(fromBlock),
      toBlock: toQuantity(toBlock),
      address: input.predicate.event.address,
      topics: [input.predicate.event.topic0],
    }]);
    assert(Array.isArray(chunk), "conversion log response");
    for (const log of chunk) {
      validateUpdateLog(log, input.predicate, fromBlock, toBlock);
      const key =
        `${log.blockHash.toLowerCase()}:` +
        `${log.transactionHash.toLowerCase()}:` +
        `${log.logIndex.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      logs.push(log);
    }
  }
  return logs;
}

async function evaluateCandidate(input: {
  readonly rpc: TrustedRpc;
  readonly plan: ConversionEligibilityPlan;
  readonly predicate: ConversionFreshnessPrivatePredicate;
  readonly sourceBlock: number;
  readonly logs: readonly RpcLog[];
}): Promise<
  | {
    readonly candidate: ConversionCandidate;
    readonly evidence: ConversionFreshnessCandidateEvidence;
  }
  | { readonly rejected: ConversionRejectedEvidence }
> {
  assert(
    input.sourceBlock >= input.plan.range.fromBlock &&
      input.sourceBlock <= input.plan.range.toBlock,
    "conversion candidate outside frozen range",
  );
  assert(input.sourceBlock > 0, "conversion candidate has no parent block");
  const {
    base,
    source,
    beforeTopology,
    afterTopology,
    beforeRates,
    afterRates,
  } = await readCandidateBundle(
    input.rpc,
    input.predicate,
    input.sourceBlock,
  );
  assert(
    sameHex(source.parentHash, base.hash),
    "conversion candidate parent/header mismatch",
  );
  assert(
    input.logs.every((log) => sameHex(log.blockHash, source.hash)),
    "conversion event/header hash mismatch",
  );
  const topology = input.predicate.topologyReads.map((read, index) => {
    const before = beforeTopology[index]!;
    const after = afterTopology[index]!;
    return {
      id: read.id,
      beforeSha256: sha256Canonical(before),
      afterSha256: sha256Canonical(after),
      unchanged: before.toLowerCase() === after.toLowerCase(),
    };
  });
  const rates = input.predicate.rateReads.map((read, index) => {
    const beforeRaw = beforeRates[index]!;
    const afterRaw = afterRates[index]!;
    const before = decodeUint(beforeRaw);
    const after = decodeUint(afterRaw);
    return {
      id: read.id,
      beforeRaw,
      afterRaw,
      before: before.toString(),
      after: after.toString(),
      changed: before !== after,
    };
  });
  const topologyUnchanged = topology.every((entry) => entry.unchanged);
  const everyRateChanged = rates.every((entry) => entry.changed);
  if (!topologyUnchanged || !everyRateChanged) {
    return {
      rejected: {
        sourceBlock: input.sourceBlock,
        reason: topologyUnchanged ? "rate_unchanged" : "topology_changed",
        detailSha256: sha256Canonical({ base, source, topology, rates }),
      },
    };
  }
  const eventEvidenceSha256 = sha256Canonical(
    input.logs.map((log) => ({
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      logIndex: log.logIndex.toLowerCase(),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
    })),
  );
  const evidence: ConversionFreshnessCandidateEvidence = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: "conversion-freshness-candidate-evidence-v1",
    predicateSha256: input.plan.predicateSha256,
    protocol: input.predicate.protocol,
    instanceAddress: input.predicate.instanceAddress,
    eventSourceAddress: input.predicate.event.address,
    eventTopic0: input.predicate.event.topic0,
    eventEvidenceSha256,
    eventCount: input.logs.length,
    base,
    source,
    topology,
    rates,
    topologyUnchanged: true,
    rateChangedAtSource: true,
  };
  const candidate: ConversionCandidate = {
    id: conversionCandidateId(evidence),
    sourceBlock: input.sourceBlock,
    evidenceSha256: sha256Canonical(evidence),
  };
  return { candidate, evidence };
}

async function readCandidateBundle(
  rpc: TrustedRpc,
  predicate: ConversionFreshnessPrivatePredicate,
  sourceBlock: number,
): Promise<{
  readonly base: ConversionBlockHeader;
  readonly source: ConversionBlockHeader;
  readonly beforeTopology: readonly string[];
  readonly afterTopology: readonly string[];
  readonly beforeRates: readonly string[];
  readonly afterRates: readonly string[];
}> {
  const baseBlock = sourceBlock - 1;
  const headerRequests: TrustedRpcRequest[] = [
    {
      method: "eth_getBlockByNumber",
      params: [toQuantity(baseBlock), false],
    },
    {
      method: "eth_getBlockByNumber",
      params: [toQuantity(sourceBlock), false],
    },
  ];
  const initialHeaders = await rpc.batch(headerRequests);
  const base = decodeHeader(
    initialHeaders[0] as RpcBlock | null,
    baseBlock,
  );
  const source = decodeHeader(
    initialHeaders[1] as RpcBlock | null,
    sourceBlock,
  );
  assert(
    sameHex(source.parentHash, base.hash),
    "conversion candidate parent/header mismatch",
  );

  const requests: TrustedRpcRequest[] = [];
  const spans: Array<{
    readonly reads: readonly ConversionTopologyRead[];
    readonly source: ConversionBlockHeader;
  }> = [
    { reads: predicate.topologyReads, source: base },
    { reads: predicate.topologyReads, source },
    { reads: predicate.rateReads, source: base },
    { reads: predicate.rateReads, source },
  ];
  for (const span of spans) {
    for (const read of span.reads) {
      requests.push(descriptorRequest(read, span.source.hash));
    }
  }
  const results = await rpc.batch(requests);
  let offset = 0;
  const take = (reads: readonly ConversionTopologyRead[]): string[] =>
    reads.map((read) => {
      const value = results[offset++];
      assert(typeof value === "string", `${read.id} result`);
      if (read.kind === "code") {
        assert(/^0x[0-9a-f]*$/i.test(value) && value.length > 2, `${read.id} code`);
      } else {
        assert(/^0x(?:[0-9a-f]{2})+$/i.test(value), `${read.id} call result`);
      }
      return value;
    });
  const beforeTopology = take(predicate.topologyReads);
  const afterTopology = take(predicate.topologyReads);
  const beforeRates = take(predicate.rateReads);
  const afterRates = take(predicate.rateReads);
  assert(offset === results.length, "conversion candidate batch shape");

  // The hash-pinned reads above prove which fork supplied state. Re-read the
  // canonical number mapping after the batch so a mid-evaluation reorg cannot
  // leave the evidence attached to headers that are no longer canonical.
  const finalHeaders = await rpc.batch(headerRequests);
  const finalBase = decodeHeader(
    finalHeaders[0] as RpcBlock | null,
    baseBlock,
  );
  const finalSource = decodeHeader(
    finalHeaders[1] as RpcBlock | null,
    sourceBlock,
  );
  assert(
    canonicalJson(finalBase) === canonicalJson(base) &&
      canonicalJson(finalSource) === canonicalJson(source),
    "conversion candidate canonical header changed during evaluation",
  );
  return {
    base,
    source,
    beforeTopology,
    afterTopology,
    beforeRates,
    afterRates,
  };
}

function descriptorRequest(
  read: ConversionTopologyRead,
  blockHash: string,
): TrustedRpcRequest {
  assertHash(blockHash, "conversion descriptor block hash");
  const block = Object.freeze({
    blockHash,
    requireCanonical: true,
  });
  if (read.kind === "code") {
    return {
      method: "eth_getCode",
      params: [read.address, block],
    };
  }
  return {
    method: "eth_call",
    params: [{ to: read.to, data: read.data }, block],
  };
}

function decodeHeader(
  block: RpcBlock | null,
  blockNumber: number,
): ConversionBlockHeader {
  assert(block, `conversion block ${blockNumber} is unavailable`);
  const actualNumber = Number(BigInt(block.number));
  assert(actualNumber === blockNumber, "conversion block number mismatch");
  assertHash(block.hash, "conversion block hash");
  assertHash(block.parentHash, "conversion parent hash");
  assertHash(block.stateRoot, "conversion state root");
  return {
    number: actualNumber,
    hash: block.hash,
    parentHash: block.parentHash,
    stateRoot: block.stateRoot,
  };
}

function validatePrivateEvidence(
  plan: ConversionEligibilityPlan,
  predicate: ConversionFreshnessPrivatePredicate,
  candidates: readonly ConversionCandidate[],
  bundle: ConversionFreshnessPrivateEvidenceBundle,
): void {
  assert(
    bundle.schemaVersion === BLIND_SCHEMA_VERSION &&
      bundle.profile === CONVERSION_PRIVATE_EVIDENCE_PROFILE,
    "conversion private evidence profile",
  );
  assert(bundle.planSha256 === sha256Canonical(plan), "conversion evidence plan");
  assert(
    bundle.predicateSha256 === sha256Canonical(predicate),
    "conversion evidence predicate",
  );
  assert(bundle.rangeHash === plan.range.rangeHash, "conversion evidence range");
  assert(bundle.chainId === predicate.chainId, "conversion evidence chain");
  assert(
    canonicalJson(bundle.predicate) === canonicalJson(predicate),
    "conversion evidence private predicate mismatch",
  );
  assert(
    canonicalJson(bundle.eligible.map((entry) => entry.candidate)) ===
      canonicalJson(candidates),
    "conversion public/private candidate mismatch",
  );
  const ids = new Set<string>();
  for (const entry of bundle.eligible) {
    assert(!ids.has(entry.candidate.id), "duplicate conversion evidence");
    ids.add(entry.candidate.id);
    assert(
      entry.candidate.evidenceSha256 === sha256Canonical(entry.evidence),
      "conversion candidate evidence hash",
    );
    assert(
      entry.candidate.sourceBlock === entry.evidence.source.number,
      "conversion candidate/evidence block mismatch",
    );
    assert(
      entry.candidate.id === conversionCandidateId(entry.evidence),
      "conversion candidate id mismatch",
    );
    assert(
      entry.evidence.predicateSha256 === plan.predicateSha256,
      "conversion evidence predicate hash",
    );
    assert(entry.evidence.topologyUnchanged, "conversion topology changed");
    assert(entry.evidence.rateChangedAtSource, "conversion rate did not change");
  }
}

function conversionCandidateId(
  evidence: ConversionFreshnessCandidateEvidence,
): string {
  return sha256Canonical({
    profile: "conversion-freshness-candidate-id-v1",
    predicateSha256: evidence.predicateSha256,
    sourceBlockHash: evidence.source.hash.toLowerCase(),
    eventEvidenceSha256: evidence.eventEvidenceSha256,
  });
}

function assertPlanMatchesPredicate(
  plan: ConversionEligibilityPlan,
  predicate: ConversionFreshnessPrivatePredicate,
): void {
  assert(
    plan.predicateVersion === predicate.predicateVersion,
    "conversion predicate version mismatch",
  );
  assert(
    plan.predicateSha256 === sha256Canonical(predicate),
    "conversion predicate commitment mismatch",
  );
  assert(
    plan.range.rangeHash === conversionRangeHash({
      chainId: predicate.chainId,
      fromBlock: plan.range.fromBlock,
      toBlock: plan.range.toBlock,
    }),
    "conversion range commitment mismatch",
  );
}

function validatePrivatePredicate(
  predicate: ConversionFreshnessPrivatePredicate,
): void {
  assertExactKeys(
    predicate,
    [
      "chainId",
      "event",
      "instanceAddress",
      "predicateVersion",
      "profile",
      "protocol",
      "rateReads",
      "schemaVersion",
      "topologyReads",
    ],
    "conversion private predicate",
  );
  assert(
    predicate.schemaVersion === BLIND_SCHEMA_VERSION &&
      predicate.profile === CONVERSION_PRIVATE_PREDICATE_PROFILE,
    "conversion private predicate profile",
  );
  assertNonempty(predicate.predicateVersion, "conversion predicate version");
  assert(
    Number.isSafeInteger(predicate.chainId) && predicate.chainId > 0,
    "conversion predicate chain",
  );
  assertNonempty(predicate.protocol, "conversion predicate protocol");
  assertAddress(predicate.instanceAddress, "conversion predicate instance");
  assertExactKeys(predicate.event, ["address", "topic0"], "conversion event");
  assertAddress(predicate.event.address, "conversion event address");
  assertHash(predicate.event.topic0, "conversion event topic");
  assert(
    predicate.topologyReads.length > 0,
    "conversion predicate needs topology reads",
  );
  assert(
    predicate.rateReads.length === 2,
    "conversion predicate needs both conversion directions",
  );
  const ids = new Set<string>();
  for (const read of [...predicate.topologyReads, ...predicate.rateReads]) {
    assertNonempty(read.id, "conversion read id");
    assert(!ids.has(read.id), `duplicate conversion read ${read.id}`);
    ids.add(read.id);
    if (read.kind === "code") {
      assertExactKeys(read, ["address", "id", "kind"], `conversion read ${read.id}`);
      assertAddress(read.address, `conversion read ${read.id} address`);
    } else {
      assertExactKeys(read, ["data", "id", "kind", "to"], `conversion read ${read.id}`);
      assertAddress(read.to, `conversion read ${read.id} target`);
      assert(
        /^0x(?:[0-9a-f]{2}){4,}$/i.test(read.data),
        `conversion read ${read.id} calldata`,
      );
    }
  }
}

function validateUpdateLog(
  log: RpcLog,
  predicate: ConversionFreshnessPrivatePredicate,
  fromBlock: number,
  toBlock: number,
): void {
  assertAddress(log.address, "conversion log address");
  assert(
    log.address.toLowerCase() === predicate.event.address.toLowerCase(),
    "conversion log source mismatch",
  );
  assert(Array.isArray(log.topics) && log.topics.length > 0, "conversion log topics");
  assert(
    sameHex(log.topics[0]!, predicate.event.topic0),
    "conversion log topic mismatch",
  );
  assert(log.removed !== true, "conversion log is removed");
  const blockNumber = Number(BigInt(log.blockNumber));
  assert(
    blockNumber >= fromBlock && blockNumber <= toBlock,
    "conversion log outside requested chunk",
  );
  assertHash(log.blockHash, "conversion log block hash");
  assertHash(log.transactionHash, "conversion log transaction hash");
  assert(/^0x[0-9a-f]+$/i.test(log.logIndex), "conversion log index");
  assert(/^0x[0-9a-f]*$/i.test(log.data), "conversion log data");
}

function decodeUint(value: string): bigint {
  assert(/^0x[0-9a-f]{64}$/i.test(value), "conversion rate uint256 result");
  const decoded = BigInt(value);
  assert(decoded > 0n, "conversion rate must be positive");
  return decoded;
}

class TrustedRpc {
  private id = 0;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestStartedAt = 0;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly minIntervalMs: number,
  ) {
    const parsed = new URL(url);
    assert(
      parsed.protocol === "http:" || parsed.protocol === "https:",
      "conversion RPC protocol",
    );
    assert(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
      "conversion RPC timeout",
    );
    assert(
      Number.isSafeInteger(minIntervalMs) && minIntervalMs >= 0,
      "conversion RPC minimum interval",
    );
  }

  async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    const execute = this.queue.then(
      () => this.execute<T>(method, params),
      () => this.execute<T>(method, params),
    );
    this.queue = execute.then(() => undefined, () => undefined);
    return await execute;
  }

  async batch(
    requests: readonly TrustedRpcRequest[],
  ): Promise<readonly unknown[]> {
    assert(
      requests.length > 0 && requests.length <= 100,
      "conversion RPC batch size",
    );
    const execute = this.queue.then(
      () => this.executeBatch(requests),
      () => this.executeBatch(requests),
    );
    this.queue = execute.then(() => undefined, () => undefined);
    return await execute;
  }

  private async execute<T>(
    method: string,
    params: readonly unknown[],
  ): Promise<T> {
    const id = ++this.id;
    let lastError = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const waitMs =
          this.lastRequestStartedAt + this.minIntervalMs - Date.now();
        if (waitMs > 0) {
          await new Promise<void>((resolveWait) =>
            setTimeout(resolveWait, waitMs)
          );
        }
        this.lastRequestStartedAt = Date.now();
        const response = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const retryable =
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500;
          if (!retryable) {
            throw new Error(`conversion RPC ${method} HTTP ${response.status}`);
          }
          lastError = `HTTP ${response.status}`;
        } else {
          const payload = await response.json() as {
            readonly result?: T;
            readonly error?: { readonly code?: number; readonly message?: string };
          };
          if (!payload.error) {
            assert(
              payload.result !== undefined,
              `conversion RPC ${method} missing result`,
            );
            return payload.result;
          }
          const detail =
            `${String(payload.error.code ?? "unknown")}:` +
            `${payload.error.message ?? "unknown"}`;
          if (!/timeout|temporar|rate|limit|busy|unavailable/i.test(detail)) {
            throw new Error(`conversion RPC ${method} failed ${detail}`);
          }
          lastError = detail;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("conversion RPC")) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < 4) {
        await new Promise<void>((resolveWait) =>
          setTimeout(resolveWait, 250 * 2 ** attempt)
        );
      }
    }
    throw new Error(
      `conversion RPC ${method} exhausted retries: ${lastError || "unknown"}`,
    );
  }

  private async executeBatch(
    requests: readonly TrustedRpcRequest[],
  ): Promise<readonly unknown[]> {
    const envelopes = requests.map((request) => ({
      jsonrpc: "2.0" as const,
      id: ++this.id,
      method: request.method,
      params: request.params,
    }));
    let lastError = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const waitMs =
          this.lastRequestStartedAt + this.minIntervalMs - Date.now();
        if (waitMs > 0) {
          await new Promise<void>((resolveWait) =>
            setTimeout(resolveWait, waitMs)
          );
        }
        this.lastRequestStartedAt = Date.now();
        const response = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelopes),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const retryable =
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500;
          if (!retryable) {
            throw new Error(`conversion RPC batch HTTP ${response.status}`);
          }
          lastError = `HTTP ${response.status}`;
        } else {
          const payload = await response.json() as ReadonlyArray<{
            readonly id?: number;
            readonly result?: unknown;
            readonly error?: {
              readonly code?: number;
              readonly message?: string;
            };
          }>;
          assert(Array.isArray(payload), "conversion RPC batch response");
          const byId = new Map(payload.map((item) => [item.id, item]));
          const values: unknown[] = [];
          let retryableError = "";
          for (const envelope of envelopes) {
            const item = byId.get(envelope.id);
            assert(item, "conversion RPC batch omitted response");
            if (item.error) {
              const detail =
                `${String(item.error.code ?? "unknown")}:` +
                `${item.error.message ?? "unknown"}`;
              if (!/timeout|temporar|rate|limit|busy|unavailable/i.test(detail)) {
                throw new Error(
                  `conversion RPC ${envelope.method} failed ${detail}`,
                );
              }
              retryableError = detail;
              break;
            }
            assert(
              item.result !== undefined,
              `conversion RPC ${envelope.method} missing result`,
            );
            values.push(item.result);
          }
          if (!retryableError) return Object.freeze(values);
          lastError = retryableError;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("conversion RPC")) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < 4) {
        await new Promise<void>((resolveWait) =>
          setTimeout(resolveWait, 250 * 2 ** attempt)
        );
      }
    }
    throw new Error(
      `conversion RPC batch exhausted retries: ${lastError || "unknown"}`,
    );
  }
}

function parseNamedArgs(args: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`${name} requires a value`);
    assert(!(name in parsed), `duplicate argument ${name}`);
    parsed[name] = value;
  }
  return parsed;
}

function required(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readSecret(path: string): ConversionSecret {
  const secret = readJson<Partial<ConversionSecret>>(path);
  assertNonempty(secret.seed, "conversion seed");
  assertNonempty(secret.salt, "conversion salt");
  return { seed: secret.seed, salt: secret.salt };
}

function writeJson(path: string, value: unknown, mode: number): void {
  writeFileSync(path, `${canonicalJson(value)}\n`, { mode });
  chmodSync(path, mode);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseNamedArgs(rest);
  if (command === "commit") {
    const predicate = readJson<ConversionFreshnessPrivatePredicate>(
      required(args, "--predicate-file"),
    );
    const plan = buildConversionFreshnessPlan({
      predicate,
      fromBlock: Number(required(args, "--from-block")),
      toBlock: Number(required(args, "--to-block")),
      minEligibleCardinality: Number(
        args["--min-eligible-cardinality"] ?? "32",
      ),
      productionInputsSha256: required(
        args,
        "--production-inputs-sha256",
      ),
      secret: readSecret(required(args, "--secret-file")),
    });
    writeJson(required(args, "--out"), plan, 0o644);
    console.log(`CONVERSION_RANGE_HASH=${plan.range.rangeHash}`);
    console.log(`CONVERSION_PREDICATE_SHA256=${plan.predicateSha256}`);
    console.log(`CONVERSION_SEED_COMMITMENT=${plan.seedCommitment}`);
    return;
  }
  if (command === "scan") {
    const rpcUrl = process.env.CONVERSION_FRESHNESS_RPC_URL ??
      process.env.SEARCHER_LIVE_RPC_URL ??
      process.env.MAINNET_RPC_URL ??
      "";
    assertNonempty(
      rpcUrl,
      "CONVERSION_FRESHNESS_RPC_URL/SEARCHER_LIVE_RPC_URL/MAINNET_RPC_URL",
    );
    const plan = readJson<ConversionEligibilityPlan>(required(args, "--plan"));
    const predicate = readJson<ConversionFreshnessPrivatePredicate>(
      required(args, "--predicate-file"),
    );
    const scanned = await scanConversionFreshness({
      plan,
      predicate,
      rpcUrl,
      rpcTimeoutMs: Number(args["--rpc-timeout-ms"] ?? "30000"),
      logChunkSize: Number(args["--log-chunk-size"] ?? "1000"),
    });
    writeJson(required(args, "--candidates-out"), scanned.candidates, 0o600);
    writeJson(required(args, "--evidence-out"), scanned.privateEvidence, 0o600);
    console.log(`CONVERSION_CANDIDATE_COUNT=${scanned.candidates.length}`);
    console.log(
      `CONVERSION_CANDIDATE_SET_SHA256=${sha256Canonical(scanned.candidates)}`,
    );
    return;
  }
  if (command === "reveal") {
    const plan = readJson<ConversionEligibilityPlan>(required(args, "--plan"));
    const predicate = readJson<ConversionFreshnessPrivatePredicate>(
      required(args, "--predicate-file"),
    );
    const candidates = readJson<ConversionCandidate[]>(
      required(args, "--candidates"),
    );
    const privateEvidence = readJson<ConversionFreshnessPrivateEvidenceBundle>(
      required(args, "--evidence"),
    );
    const revealed = revealConversionFreshness({
      plan,
      predicate,
      candidates,
      privateEvidence,
      secret: readSecret(required(args, "--secret-file")),
    });
    writeJson(required(args, "--out"), revealed, 0o600);
    console.log(
      `CONVERSION_SELECTION=${revealed.freshnessEvidence}:` +
        `${revealed.selected?.id ?? "missing"}`,
    );
    if (revealed.freshnessEvidence === "missing") process.exitCode = 2;
    return;
  }
  throw new Error(
    "usage: commit --predicate-file <private.json> --from-block <N> " +
      "--to-block <N> --secret-file <private.json> --out <plan.json> | " +
      "scan --plan <plan.json> --predicate-file <private.json> " +
      "--candidates-out <private.json> --evidence-out <private.json> | " +
      "reveal --plan <plan.json> --predicate-file <private.json> " +
      "--candidates <private.json> --evidence <private.json> " +
      "--secret-file <private.json> --out <reveal.json>",
  );
}

function validateRange(fromBlock: number, toBlock: number): void {
  assert(
    Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock >= 0 &&
      toBlock >= fromBlock,
    "conversion block range",
  );
}

function toQuantity(value: number): string {
  return `0x${value.toString(16)}`;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertAddress(value: unknown, label: string): asserts value is string {
  assert(
    typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value),
    `${label} must be an address`,
  );
}

function assertHash(value: unknown, label: string): asserts value is string {
  assert(
    typeof value === "string" && /^(?:0x)?[0-9a-f]{64}$/i.test(value),
    `${label} must be a 32-byte hash`,
  );
}

function assertNonempty(
  value: unknown,
  label: string,
): asserts value is string {
  assert(typeof value === "string" && value.length > 0, label);
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${label} contains unexpected or missing fields`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
