import { ethers } from "ethers";
import type {
  RuntimeEvidence,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  decodeAngstromExecutionEvidence,
  type VerifiedAngstromAttestation,
} from "../angstrom-attestation.js";
import { ANGSTROM_V4_FAMILY_ID } from "./manifest.js";
import type { AngstromV4Descriptor } from "./types.js";

export interface BoundAngstromRuntimeEvidence {
  readonly runtime: RuntimeEvidence;
  readonly payload: string;
  readonly payloadHash: string;
  readonly attestations: readonly VerifiedAngstromAttestation[];
}

export function angstromRuntimeEvidenceHash(input: {
  readonly txHash: string;
  readonly source: CanonicalSource;
  readonly payloadHash: string;
}): string {
  return hashCanonical({
    familyId: ANGSTROM_V4_FAMILY_ID,
    txHash: input.txHash.toLowerCase(),
    source: {
      number: input.source.number,
      hash: input.source.hash.toLowerCase(),
      generation: input.source.generation,
    },
    payloadHash: input.payloadHash.toLowerCase(),
  });
}

export function requireAngstromRuntimeEvidence(input: {
  readonly descriptor: AngstromV4Descriptor;
  readonly source: CanonicalSource;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
}): BoundAngstromRuntimeEvidence {
  const matching = input.runtimeEvidence.filter((item) =>
    item.familyId === ANGSTROM_V4_FAMILY_ID &&
    item.kind === "angstrom-empty-block-attestation"
  );
  if (matching.length !== 1) {
    throw new Error(
      "angstrom-v4 requires exactly one tx-bound family execution evidence",
    );
  }
  const runtime = matching[0];
  if (
    runtime.scope !== "transaction" ||
    runtime.txHash === undefined ||
    !ethers.isHexString(runtime.txHash, 32)
  ) {
    throw new Error("angstrom-v4 execution evidence is not transaction-bound");
  }
  if (
    runtime.instanceKey !== undefined &&
    runtime.instanceKey !== input.descriptor.instanceKey
  ) {
    throw new Error("angstrom-v4 execution evidence escaped its instance");
  }
  if (
    runtime.source.number !== input.source.number ||
    runtime.source.hash.toLowerCase() !== input.source.hash.toLowerCase() ||
    runtime.source.generation !== input.source.generation
  ) {
    throw new Error("angstrom-v4 execution evidence is stale or foreign");
  }
  const payload = runtime.sealedPayloadRef;
  if (!ethers.isHexString(payload)) {
    throw new Error("angstrom-v4 sealed execution payload is not hex");
  }
  const payloadHash = ethers.keccak256(payload);
  if (
    runtime.evidenceHash !== angstromRuntimeEvidenceHash({
      txHash: runtime.txHash,
      source: runtime.source,
      payloadHash,
    })
  ) {
    throw new Error("angstrom-v4 execution evidence hash mismatch");
  }
  const attestations = decodeAngstromExecutionEvidence(payload);
  if (!attestations.some(
    (attestation) => attestation.blockNumber === BigInt(input.source.number)
  )) {
    throw new Error("angstrom-v4 execution evidence has no current-head proof");
  }
  return Object.freeze({ runtime, payload, payloadHash, attestations });
}
