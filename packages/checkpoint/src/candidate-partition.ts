import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
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
} from "../../../specs/candidate-partition-authority/src/index.ts";
import { issueCheckpointCandidatePartitionReader } from "../../candidate-partition-runtime/src/internal/reader-issuer.ts";

interface CandidatePartitionStateV1 {
  readonly binding: CandidatePartitionBindingV1;
  readonly candidates: ReadonlyMap<Hash, CandidateRecordV1>;
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
    }));
  }

  get reader(): CandidatePartitionReaderPortV1 {
    return this.#reader;
  }

  registerVerifiedProof(
    proofInput: CandidatePartitionProofV1,
    candidatesInput: readonly CandidateRecordV1[],
  ): CandidatePartitionCapabilityV1 {
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
