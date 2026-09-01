import {
  assertHash,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  sha256Hex,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  candidatePartitionRoot,
  type CandidateRecordV1,
} from "../../discovery/src/index.ts";
import {
  assertCandidatePartitionCapability,
  candidatePartitionBindingFromProof,
  candidatePartitionKeysRoot,
  decodeCandidatePartitionProofV1,
  type CandidatePartitionBindingV1,
  type CandidatePartitionCapabilityV1,
  type CandidatePartitionProofV1,
  type CandidatePartitionReaderPortV1,
  decodeUnsignedDryRunCandidatePartitionCommitmentV1,
  type UnsignedDryRunCandidatePartitionCapabilityV1,
  type UnsignedDryRunCandidatePartitionCommitmentV1,
  type UnsignedDryRunCandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import { issueCheckpointCandidatePartitionReader } from "../../candidate-partition-runtime/src/internal/reader-issuer.ts";

interface CandidatePartitionStateV1 {
  readonly binding: CandidatePartitionBindingV1;
  readonly candidates: ReadonlyMap<Hash, CandidateRecordV1>;
  readonly rawEvidence: CandidatePartitionRawEvidenceSourceV1;
}

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

function bindingFromProof(proof: CandidatePartitionProofV1): CandidatePartitionBindingV1 {
  return candidatePartitionBindingFromProof(proof);
}

/**
 * Checkpoint-owned capability registry. The only way to create a capability
 * is to register a proof that checkpoint has already verified against the
 * current release binding and the exact durable candidate snapshot. A copied
 * proof, spread object, or JSON round-trip is never a capability.
 */
export class CandidatePartitionCapabilityRegistryV1 {
  readonly #states = new WeakMap<object, CandidatePartitionStateV1>();
  readonly #reader: CandidatePartitionReaderPortV1;

  constructor() {
    this.#reader = issueCheckpointCandidatePartitionReader(Object.freeze({
      binding: (capability: CandidatePartitionCapabilityV1): CandidatePartitionBindingV1 => {
        return this.#state(capability).binding;
      },
      listKeys: (capability: CandidatePartitionCapabilityV1): readonly Hash[] => {
        return Object.freeze([...this.#state(capability).candidates.keys()].sort());
      },
      readCandidate: (
        capability: CandidatePartitionCapabilityV1,
        familyCandidateKey: Hash,
      ): CandidateRecordV1 => {
        const key = familyCandidateKey;
        const candidate = this.#state(capability).candidates.get(key);
        if (!candidate) throw new TypeError("candidate partition key is absent");
        return cloneCandidate(candidate);
      },
      readRawEvidence: (
        capability: CandidatePartitionCapabilityV1,
        familyCandidateKey: Hash,
        rawLocatorHash: Hash,
      ): Uint8Array => {
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
        if (sha256Hex(bytes) !== locator) {
          throw new TypeError("candidate raw evidence content hash mismatch");
        }
        return bytes;
      },
    }));
  }

  get reader(): CandidatePartitionReaderPortV1 {
    return this.#reader;
  }

  registerVerifiedProof(
    proofInput: CandidatePartitionProofV1,
    candidatesInput: readonly CandidateRecordV1[],
    rawEvidence: CandidatePartitionRawEvidenceSourceV1,
  ): CandidatePartitionCapabilityV1 {
    if (rawEvidence === null || typeof rawEvidence !== "object" || typeof rawEvidence.read !== "function") {
      throw new TypeError("candidate partition raw evidence source is required");
    }
    const proof = decodeCandidatePartitionProofV1(proofInput);
    const candidates = candidatesInput.map(cloneCandidate);
    const keys = candidates.map(candidate => candidate.familyCandidateKey);
    if (proof.recordCount !== String(candidates.length)) throw new TypeError("candidate partition proof record count mismatch");
    if (candidatePartitionRoot(candidates) !== proof.candidatePartitionRoot) {
      throw new TypeError("candidate partition proof candidate root mismatch");
    }
    if (candidatePartitionKeysRoot(keys) !== proof.candidateKeysRoot) {
      throw new TypeError("candidate partition proof key root mismatch");
    }
    const map = new Map<Hash, CandidateRecordV1>();
    for (const candidate of candidates) {
      if (map.has(candidate.familyCandidateKey)) throw new TypeError("duplicate candidate partition key");
      map.set(candidate.familyCandidateKey, candidate);
    }
    const capability = Object.freeze({});
    this.#states.set(capability, {
      binding: bindingFromProof(proof),
      candidates: map,
      rawEvidence,
    });
    return capability as CandidatePartitionCapabilityV1;
  }

  assertOwned(capability: CandidatePartitionCapabilityV1): void {
    this.#state(capability);
  }

  #state(capability: CandidatePartitionCapabilityV1): CandidatePartitionStateV1 {
    assertCandidatePartitionCapability(capability);
    const state = this.#states.get(capability);
    if (!state) throw new TypeError("candidate partition capability is not checkpoint-issued");
    return state;
  }
}

interface UnsignedDryRunCandidatePartitionStateV1 {
  readonly commitment: UnsignedDryRunCandidatePartitionCommitmentV1;
  readonly candidates: ReadonlyMap<Hash, CandidateRecordV1>;
  readonly rawEvidence: CandidatePartitionRawEvidenceSourceV1;
}

/**
 * Unsigned dry-run registry is physically and nominally separate from the
 * signed-proof registry.  A JSON commitment can be verified as data, but only
 * this owner can turn it into the process-local capability consumed by the
 * runtime.
 */
export class UnsignedDryRunCandidatePartitionCapabilityRegistryV1 {
  readonly #states = new WeakMap<object, UnsignedDryRunCandidatePartitionStateV1>();
  readonly #reader: UnsignedDryRunCandidatePartitionReaderPortV1;

  constructor() {
    this.#reader = Object.freeze({
      binding: (capability: UnsignedDryRunCandidatePartitionCapabilityV1) => this.#state(capability).commitment,
      listKeys: (capability: UnsignedDryRunCandidatePartitionCapabilityV1) => {
        return Object.freeze([...this.#state(capability).candidates.keys()].sort());
      },
      readCandidate: (
        capability: UnsignedDryRunCandidatePartitionCapabilityV1,
        familyCandidateKey: Hash,
      ) => {
        const candidate = this.#state(capability).candidates.get(assertHash(familyCandidateKey, "familyCandidateKey"));
        if (!candidate) throw new TypeError("unsigned dry-run candidate partition key is absent");
        return cloneCandidate(candidate);
      },
      readRawEvidence: (
        capability: UnsignedDryRunCandidatePartitionCapabilityV1,
        familyCandidateKey: Hash,
        rawLocatorHash: Hash,
      ) => {
        const state = this.#state(capability);
        const candidate = state.candidates.get(assertHash(familyCandidateKey, "familyCandidateKey"));
        if (!candidate) throw new TypeError("unsigned dry-run candidate partition key is absent");
        const locator = assertHash(rawLocatorHash, "rawLocatorHash");
        if (!candidate.evidence.some(evidence => evidence.rawLocatorHash === locator)) {
          throw new TypeError("raw evidence locator is outside the exact unsigned dry-run candidate record");
        }
        const value = state.rawEvidence.read(candidate.familyCandidateKey, locator);
        if (!(value instanceof Uint8Array) || value.byteLength === 0) {
          throw new TypeError("candidate raw evidence bytes are unavailable");
        }
        const bytes = new Uint8Array(value);
        if (sha256Hex(bytes) !== locator) throw new TypeError("candidate raw evidence content hash mismatch");
        return bytes;
      },
    });
  }

  get reader(): UnsignedDryRunCandidatePartitionReaderPortV1 {
    return this.#reader;
  }

  registerVerifiedCommitment(
    commitmentInput: UnsignedDryRunCandidatePartitionCommitmentV1,
    candidatesInput: readonly CandidateRecordV1[],
    rawEvidence: CandidatePartitionRawEvidenceSourceV1,
  ): UnsignedDryRunCandidatePartitionCapabilityV1 {
    if (rawEvidence === null || typeof rawEvidence !== "object" || typeof rawEvidence.read !== "function") {
      throw new TypeError("candidate partition raw evidence source is required");
    }
    const commitment = decodeUnsignedDryRunCandidatePartitionCommitmentV1(commitmentInput);
    const candidates = candidatesInput.map(cloneCandidate);
    const keys = candidates.map(candidate => candidate.familyCandidateKey);
    if (commitment.recordCount !== String(candidates.length)) {
      throw new TypeError("unsigned dry-run candidate partition record count mismatch");
    }
    if (candidatePartitionRoot(candidates) !== commitment.candidatePartitionRoot) {
      throw new TypeError("unsigned dry-run candidate partition root mismatch");
    }
    if (candidatePartitionKeysRoot(keys) !== commitment.candidateKeysRoot) {
      throw new TypeError("unsigned dry-run candidate partition key root mismatch");
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

  #state(capability: UnsignedDryRunCandidatePartitionCapabilityV1): UnsignedDryRunCandidatePartitionStateV1 {
    if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
      throw new TypeError("unsigned dry-run candidate partition capability is invalid");
    }
    const state = this.#states.get(capability);
    if (!state) throw new TypeError("unsigned dry-run candidate partition capability is not checkpoint-issued");
    return state;
  }
}
