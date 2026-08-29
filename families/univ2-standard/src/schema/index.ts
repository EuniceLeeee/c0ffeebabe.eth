import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  fieldArray,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeCanonicalCutoff,
  familyCandidateKey as centralFamilyCandidateKey,
  type CanonicalCutoffV1,
  type SourcePlanEvidenceRefV1,
} from "../../../../packages/discovery/src/index.ts";
import { canonicalAddress, decodeAddressWord } from "../kernel/codec.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
} from "../family-definition.ts";

export const UNIV2_SYNC_EVENT_TOPIC0 = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1" as Hash;
/** `token0()`, `token1()`, `factory()`, `getPair(address,address)`, `getReserves()`. */
export const UNIV2_TOKEN0_SELECTOR = "0x0dfe1681" as const;
export const UNIV2_TOKEN1_SELECTOR = "0xd21220a7" as const;
export const UNIV2_FACTORY_SELECTOR = "0xc45a0155" as const;
export const UNIV2_GET_PAIR_SELECTOR = "0xe6a43905" as const;
export const UNIV2_GET_RESERVES_SELECTOR = "0x0902f1ac" as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

function address(value: unknown, path: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) throw new TypeError(`${path} must be a 20-byte address`);
  return canonicalAddress(value);
}

function bytesHex(value: unknown, path: string): string {
  if (typeof value !== "string" || !HEX_BYTES_RE.test(value)) throw new TypeError(`${path} must be even-length hex bytes`);
  return value.toLowerCase();
}

function hash(value: unknown, path: string): Hash {
  return assertHash(value, path);
}

function cutoff(value: unknown, path: string): CanonicalCutoffV1 {
  return decodeCanonicalCutoff(value, path);
}

function decimal(value: unknown, path: string): string {
  return assertDecimalString(value, path);
}

export interface UniV2NominationEvidenceV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
  readonly emitter: string;
  readonly topic0: Hash;
  readonly rawLocatorHash: Hash;
}

export interface UniV2NominationObservationV1 {
  readonly pool: string;
  readonly evidence: UniV2NominationEvidenceV1;
}

export interface UniV2NominationV1 {
  readonly pool: string;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly evidence: UniV2NominationEvidenceV1 | UniV2SourceNominationEvidenceV1;
}
export interface UniV2SourceNominationEvidenceV1 { readonly kind: "source-plan"; readonly cutoff: CanonicalCutoffV1; readonly pool: string; readonly source: SourcePlanEvidenceRefV1; }

export interface UniV2IdentityReadFactsV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly pool: string;
  readonly token0ReturnHex: string;
  readonly token1ReturnHex: string;
  readonly factoryReturnHex: string;
  readonly forwardPairReturnHex: string;
  readonly reversePairReturnHex: string;
}

export interface UniV2DecodedIdentityReadsV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly forwardPair: string;
  readonly reversePair: string;
}

export interface UniV2IdentityMemoV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly facts: {
    readonly pool: string;
    readonly factory: string;
    readonly token0: string;
    readonly token1: string;
    readonly forwardPair: string;
    readonly reversePair: string;
  };
  readonly factsHash: Hash;
  readonly instanceKey: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly sourceRequestRoot: Hash;
}

export interface UniV2ReservesReadFactsV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly pool: string;
  readonly reservesReturnHex: string;
}

export interface UniV2MaterializedStateV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly pool: string;
  readonly reserve0: string;
  readonly reserve1: string;
  readonly blockTimestampLast: string;
  readonly stateHash: Hash;
}

export interface UniV2SourceRequestV1 {
  readonly requestId: Hash;
  readonly phase: "identity" | "materialization";
  readonly target: string;
  readonly data: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly responseEncoding: "abi-address-word" | "abi-address-word-pair" | "abi-reserves";
}

export function decodeNominationCandidate(
  value: unknown,
  path = "univ2.nomination",
): UniV2NominationV1 {
  const decoded = decodeExactObject(value, {
    pool: (field, itemPath) => address(field, itemPath),
    instanceNominationKey: (field, itemPath) => assertNonEmptyString(field, itemPath),
    candidateSnapshotHash: (field, itemPath) => hash(field, itemPath),
    evidence: (field, itemPath) => field !== null && typeof field === "object" && !Array.isArray(field) && "kind" in field ? decodeExactObject(field, {
      kind: (item, childPath) => { if (item !== "source-plan") throw new TypeError(`${childPath} kind mismatch`); return "source-plan" as const; },
      cutoff: (item, childPath) => cutoff(item, childPath),
      pool: (item, childPath) => address(item, childPath),
      source: (item, childPath) => decodeExactObject(item, { kind: (v, p) => { if (v !== "source-plan") throw new TypeError(`${p} kind mismatch`); return "source-plan" as const; }, version: (v, p) => { if (v !== 1) throw new TypeError(`${p} version mismatch`); return 1 as const; }, ownerRef: (v, p) => hash(v, p), sourcePlanRef: (v, p) => hash(v, p), evidenceRef: (v, p) => hash(v, p), rawLocatorHash: (v, p) => hash(v, p) }, childPath),
    }, itemPath) : decodeExactObject(field, {
      cutoff: (item, childPath) => cutoff(item, childPath),
      blockNumber: (item, childPath) => decimal(item, childPath),
      blockHash: (item, childPath) => hash(item, childPath),
      txHash: (item, childPath) => hash(item, childPath),
      logIndex: (item, childPath) => decimal(item, childPath),
      emitter: (item, childPath) => address(item, childPath),
      topic0: (item, childPath) => hash(item, childPath),
      rawLocatorHash: (item, childPath) => hash(item, childPath),
    }, itemPath),
  }, path);
  const pool = "kind" in decoded.evidence ? decoded.evidence.pool : decodeNominationObservation({ pool: decoded.pool, evidence: decoded.evidence }).pool;
  if (decoded.pool !== pool || decoded.instanceNominationKey !== nominationKeyForPool(pool)) throw new Error("univ2-instance-nomination-key-mismatch");
  return deepFreeze(decoded);
}

export function decodeNominationObservation(
  value: unknown,
  path = "univ2.nominationObservation",
): UniV2NominationObservationV1 {
  const decoded = decodeExactObject(value, {
    pool: (field, itemPath) => address(field, itemPath),
    evidence: (field, itemPath) => decodeExactObject(field, {
      cutoff: (item, childPath) => cutoff(item, childPath),
      blockNumber: (item, childPath) => decimal(item, childPath),
      blockHash: (item, childPath) => hash(item, childPath),
      txHash: (item, childPath) => hash(item, childPath),
      logIndex: (item, childPath) => decimal(item, childPath),
      emitter: (item, childPath) => address(item, childPath),
      topic0: (item, childPath) => hash(item, childPath),
      rawLocatorHash: (item, childPath) => hash(item, childPath),
    }, itemPath),
  }, path);
  const block = BigInt(decoded.evidence.blockNumber);
  if (block > BigInt(decoded.evidence.cutoff.number)) throw new Error("nomination-evidence-after-cutoff");
  if (decoded.evidence.emitter !== decoded.pool) throw new Error("nomination-emitter-pool-mismatch");
  if (decoded.evidence.topic0 !== UNIV2_SYNC_EVENT_TOPIC0) throw new Error("nomination-topic-not-univ2-sync");
  return deepFreeze(decoded);
}

export function decodeIdentityReadFacts(
  value: unknown,
  path = "univ2.identityReadFacts",
): UniV2IdentityReadFactsV1 {
  return decodeExactObject(value, {
    cutoff: (field, itemPath) => cutoff(field, itemPath),
    pool: (field, itemPath) => address(field, itemPath),
    token0ReturnHex: (field, itemPath) => bytesHex(field, itemPath),
    token1ReturnHex: (field, itemPath) => bytesHex(field, itemPath),
    factoryReturnHex: (field, itemPath) => bytesHex(field, itemPath),
    forwardPairReturnHex: (field, itemPath) => bytesHex(field, itemPath),
    reversePairReturnHex: (field, itemPath) => bytesHex(field, itemPath),
  }, path);
}

export function decodeIdentityMemo(
  value: unknown,
  path = "univ2.identityMemo",
): UniV2IdentityMemoV1 {
  return decodeExactObject(value, {
    cutoff: (field, itemPath) => cutoff(field, itemPath),
    facts: (field, itemPath) => decodeExactObject(field, {
      pool: (item, childPath) => address(item, childPath),
      factory: (item, childPath) => address(item, childPath),
      token0: (item, childPath) => address(item, childPath),
      token1: (item, childPath) => address(item, childPath),
      forwardPair: (item, childPath) => address(item, childPath),
      reversePair: (item, childPath) => address(item, childPath),
    }, itemPath),
    factsHash: (field, itemPath) => hash(field, itemPath),
    instanceKey: (field, itemPath) => address(field, itemPath),
    familyDefinitionHash: (field, itemPath) => hash(field, itemPath),
    instanceNominationKey: (field, itemPath) => assertNonEmptyString(field, itemPath),
    candidateSnapshotHash: (field, itemPath) => hash(field, itemPath),
    sourceRequestRoot: (field, itemPath) => hash(field, itemPath),
  }, path);
}

export function decodeReservesReadFacts(
  value: unknown,
  path = "univ2.reservesReadFacts",
): UniV2ReservesReadFactsV1 {
  return decodeExactObject(value, {
    cutoff: (field, itemPath) => cutoff(field, itemPath),
    pool: (field, itemPath) => address(field, itemPath),
    reservesReturnHex: (field, itemPath) => bytesHex(field, itemPath),
  }, path);
}

export function decodeMaterializedState(
  value: unknown,
  path = "univ2.materializedState",
): UniV2MaterializedStateV1 {
  return decodeExactObject(value, {
    cutoff: (field, itemPath) => cutoff(field, itemPath),
    pool: (field, itemPath) => address(field, itemPath),
    reserve0: (field, itemPath) => decimal(field, itemPath),
    reserve1: (field, itemPath) => decimal(field, itemPath),
    blockTimestampLast: (field, itemPath) => decimal(field, itemPath),
    stateHash: (field, itemPath) => hash(field, itemPath),
  }, path);
}

export function sealMaterializedState(input: Omit<UniV2MaterializedStateV1, "stateHash">): UniV2MaterializedStateV1 {
  const normalized = decodeExactObject({ ...input, stateHash: hashDomain("aloha/univ2-standard/materialized-state/v1", input) }, {
    cutoff: (field, path) => cutoff(field, path),
    pool: (field, path) => address(field, path),
    reserve0: (field, path) => decimal(field, path),
    reserve1: (field, path) => decimal(field, path),
    blockTimestampLast: (field, path) => decimal(field, path),
    stateHash: (field, path) => hash(field, path),
  }, "univ2.materializedState");
  return deepFreeze(normalized);
}

export function assertCutoffEqual(left: CanonicalCutoffV1, right: CanonicalCutoffV1): void {
  if (
    left.chainId !== right.chainId
    || left.number !== right.number
    || left.hash !== right.hash
    || left.stateRoot !== right.stateRoot
  ) throw new Error("univ2-source-cutoff-mismatch");
}

export function familyCandidateKeyForNomination(instanceNominationKey: string): Hash {
  return centralFamilyCandidateKey(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, instanceNominationKey);
}

export function nominationSnapshotHash(observation: UniV2NominationObservationV1): Hash {
  return hashDomain("aloha/univ2-standard/candidate-snapshot/v1", observation);
}

export function nominationKeyForPool(pool: string): string {
  return canonicalAddress(pool);
}

export function decodeIdentityReads(value: UniV2IdentityReadFactsV1): UniV2DecodedIdentityReadsV1 {
  const input = decodeIdentityReadFacts(value);
  // The kernel decoder enforces exact one-word ABI returns and zero padding.
  return deepFreeze({
    cutoff: input.cutoff,
    pool: input.pool,
    factory: decodeAddressWord(input.factoryReturnHex),
    token0: decodeAddressWord(input.token0ReturnHex),
    token1: decodeAddressWord(input.token1ReturnHex),
    forwardPair: decodeAddressWord(input.forwardPairReturnHex),
    reversePair: decodeAddressWord(input.reversePairReturnHex),
  });
}

export function sourceRequestRoot(requests: readonly UniV2SourceRequestV1[]): Hash {
  return hashDomain("aloha/univ2-standard/source-request-root/v1", [...requests].sort((left, right) => left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0));
}

export function decodeSourceRequest(value: unknown, path = "univ2.sourceRequest"): UniV2SourceRequestV1 {
  return decodeExactObject(value, {
    requestId: (field, itemPath) => hash(field, itemPath),
    phase: (field, itemPath) => {
      if (field !== "identity" && field !== "materialization") throw new TypeError(`${itemPath} has invalid phase`);
      return field;
    },
    target: (field, itemPath) => address(field, itemPath),
    data: (field, itemPath) => bytesHex(field, itemPath),
    cutoff: (field, itemPath) => cutoff(field, itemPath),
    responseEncoding: (field, itemPath) => {
      if (field !== "abi-address-word" && field !== "abi-address-word-pair" && field !== "abi-reserves") throw new TypeError(`${itemPath} has invalid response encoding`);
      return field;
    },
  }, path);
}

export function decodeSourceRequests(value: unknown, path = "univ2.sourceRequests"): readonly UniV2SourceRequestV1[] {
  return fieldArray(value, (item, itemPath) => decodeSourceRequest(item, itemPath), path);
}
