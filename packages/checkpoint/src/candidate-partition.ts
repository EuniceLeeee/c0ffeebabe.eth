import {
  assertHash,
  decodeCanonicalJson,
  encodeCanonicalJson,
  sha256Hex,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  candidatePartitionRoot,
  type CandidateRecordV1,
} from "../../discovery/src/index.ts";
import {
  candidatePartitionKeysRoot,
  decodeCandidatePartitionCommitmentV1,
  type CandidatePartitionCapabilityV1,
  type CandidatePartitionCommitmentV1,
  type CandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import { issueCheckpointCandidatePartitionReader } from "../../candidate-partition-runtime/src/internal/reader-issuer.ts";

export interface CandidatePartitionRawEvidenceSourceV1 {
  read(familyCandidateKey: Hash, rawLocatorHash: Hash): Uint8Array;
}

const bootstrapStates = new WeakMap<object, CandidatePartitionCapabilityRegistryV1>();

/** Opaque checkpoint-owned bootstrap used to break construction ordering. */
export type CandidatePartitionBootstrapV1 = object;

export function createCandidatePartitionBootstrap(): CandidatePartitionBootstrapV1 {
  const bootstrap = Object.freeze({});
  bootstrapStates.set(bootstrap, new CandidatePartitionCapabilityRegistryV1());
  return bootstrap;
}

export function candidatePartitionBootstrapReader(
  bootstrap: CandidatePartitionBootstrapV1,
): CandidatePartitionReaderPortV1 {
  return bootstrapRegistry(bootstrap).reader;
}

export function consumeCandidatePartitionBootstrap(
  bootstrap: CandidatePartitionBootstrapV1,
): CandidatePartitionCapabilityRegistryV1 {
  const registry = bootstrapRegistry(bootstrap);
  bootstrapStates.delete(bootstrap);
  return registry;
}

function bootstrapRegistry(bootstrap: CandidatePartitionBootstrapV1): CandidatePartitionCapabilityRegistryV1 {
  if (bootstrap === null || typeof bootstrap !== "object") {
    throw new TypeError("candidate partition bootstrap is not an object");
  }
  const registry = bootstrapStates.get(bootstrap);
  if (!registry) throw new TypeError("candidate partition bootstrap is not issued or was consumed");
  return registry;
}

function cloneCandidate(value: CandidateRecordV1): CandidateRecordV1 {
  return decodeCanonicalJson(encodeCanonicalJson(value)) as unknown as CandidateRecordV1;
}

interface CandidatePartitionStateV1 {
  readonly commitment: CandidatePartitionCommitmentV1;
  readonly candidates: ReadonlyMap<Hash, CandidateRecordV1>;
  readonly rawEvidence: CandidatePartitionRawEvidenceSourceV1;
}

/**
 * A content commitment can be verified as data, but only Checkpoint can turn
 * it into the process-local capability consumed by the runtime.
 */
export class CandidatePartitionCapabilityRegistryV1 {
  readonly #states = new WeakMap<object, CandidatePartitionStateV1>();
  readonly #reader: CandidatePartitionReaderPortV1;

  constructor() {
    this.#reader = issueCheckpointCandidatePartitionReader(Object.freeze({
      binding: (capability: CandidatePartitionCapabilityV1) => this.#state(capability).commitment,
      listKeys: (capability: CandidatePartitionCapabilityV1) => {
        return Object.freeze([...this.#state(capability).candidates.keys()].sort());
      },
      readCandidate: (
        capability: CandidatePartitionCapabilityV1,
        familyCandidateKey: Hash,
      ) => {
        const candidate = this.#state(capability).candidates.get(assertHash(familyCandidateKey, "familyCandidateKey"));
        if (!candidate) throw new TypeError("candidate partition key is absent");
        return cloneCandidate(candidate);
      },
      readRawEvidence: (
        capability: CandidatePartitionCapabilityV1,
        familyCandidateKey: Hash,
        rawLocatorHash: Hash,
      ) => {
        const state = this.#state(capability);
        const candidate = state.candidates.get(assertHash(familyCandidateKey, "familyCandidateKey"));
        if (!candidate) throw new TypeError("candidate partition key is absent");
        const locator = assertHash(rawLocatorHash, "rawLocatorHash");
        if (!candidate.evidence.some(evidence => evidence.rawLocatorHash === locator)) {
          throw new TypeError("raw evidence locator is outside the exact candidate record");
        }
        const value = state.rawEvidence.read(candidate.familyCandidateKey, locator);
        if (!(value instanceof Uint8Array) || value.byteLength === 0) {
          throw new TypeError("candidate raw evidence bytes are unavailable");
        }
        const bytes = new Uint8Array(value);
        if (sha256Hex(bytes) !== locator) throw new TypeError("candidate raw evidence content hash mismatch");
        return bytes;
      },
    }));
  }

  get reader(): CandidatePartitionReaderPortV1 {
    return this.#reader;
  }

  registerVerifiedCommitment(
    commitmentInput: CandidatePartitionCommitmentV1,
    candidatesInput: readonly CandidateRecordV1[],
    rawEvidence: CandidatePartitionRawEvidenceSourceV1,
  ): CandidatePartitionCapabilityV1 {
    if (rawEvidence === null || typeof rawEvidence !== "object" || typeof rawEvidence.read !== "function") {
      throw new TypeError("candidate partition raw evidence source is required");
    }
    const commitment = decodeCandidatePartitionCommitmentV1(commitmentInput);
    const candidates = candidatesInput.map(cloneCandidate);
    const keys = candidates.map(candidate => candidate.familyCandidateKey);
    if (commitment.recordCount !== String(candidates.length)) {
      throw new TypeError("candidate partition record count mismatch");
    }
    if (candidatePartitionRoot(candidates) !== commitment.candidatePartitionRoot) {
      throw new TypeError("candidate partition root mismatch");
    }
    if (candidatePartitionKeysRoot(keys) !== commitment.candidateKeysRoot) {
      throw new TypeError("candidate partition key root mismatch");
    }
    const map = new Map<Hash, CandidateRecordV1>();
    for (const candidate of candidates) {
      if (map.has(candidate.familyCandidateKey)) throw new TypeError("duplicate candidate partition key");
      map.set(candidate.familyCandidateKey, candidate);
    }
    const capability = Object.freeze({});
    this.#states.set(capability, { commitment, candidates: map, rawEvidence });
    return capability;
  }

  #state(capability: CandidatePartitionCapabilityV1): CandidatePartitionStateV1 {
    if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
      throw new TypeError("candidate partition capability is invalid");
    }
    const state = this.#states.get(capability);
    if (!state) throw new TypeError("candidate partition capability is not checkpoint-issued");
    return state;
  }
}
