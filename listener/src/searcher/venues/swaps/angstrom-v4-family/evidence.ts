import { ethers } from "ethers";
import type {
  RuntimeEvidence,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  ANGSTROM_ADAPTER_SWAP_SELECTOR,
  decodeAngstromExecutionEvidence,
  encodeAngstromExecutionEvidence,
  parseAngstromAttestation,
  type VerifiedAngstromAttestation,
} from "../angstrom-attestation.js";
import type {
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
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


/**
 * Plugin-declared runtime-evidence materialization: recover the family's
 * empty-block attestation from a real observed angstrom swap call. The
 * adapter swap calldata carries the hookData array ((uint64,bytes)[]) whose
 * byte payloads are validator attestations (node + EOA signature over the
 * empty block); the first EOA-verified attestation becomes the tx-bound
 * execution evidence. The central descriptor builder executes this
 * capability; families without it carry an empty evidence list.
 */
export function angstromRuntimeEvidenceFromObservation(input: {
  readonly observation: UnifiedObservation;
  readonly source: CanonicalSource;
}): readonly RuntimeEvidence[] {
  if (
    input.observation.kind !== "call" ||
    input.observation.transactionHash === undefined
  ) {
    return Object.freeze([]);
  }
  const swapIface = new ethers.Interface([
    "function swap((address,address,uint24,int24,address),bool,uint128,uint128,(uint64,bytes)[],address,uint256)",
  ]);
  try {
    if (input.observation.data.slice(0, 10).toLowerCase() !==
      ANGSTROM_ADAPTER_SWAP_SELECTOR) {
      return Object.freeze([]);
    }
    const decoded = swapIface.decodeFunctionData(
      "swap",
      input.observation.data,
    ) as unknown as {
      readonly [index: number]: unknown;
    };
    const hookData = decoded[4];
    if (!Array.isArray(hookData)) return Object.freeze([]);
    const txHash = input.observation.transactionHash.toLowerCase();
    for (const item of hookData) {
      const record = item as { readonly [index: number]: unknown };
      const blockNumber = record[0];
      const unlockData = record[1];
      if (
        typeof blockNumber !== "bigint" ||
        typeof unlockData !== "string" ||
        !ethers.isHexString(unlockData)
      ) {
        continue;
      }
      try {
        // parseAngstromAttestation only returns a candidate after the EOA
        // signature recovery matches the embedded validator.
        const attestation = Object.freeze({
          ...parseAngstromAttestation({
            blockNumber,
            unlockData,
          }),
          verification: "eoa" as const,
        });
        const payload = encodeAngstromExecutionEvidence([attestation]);
        const payloadHash = ethers.keccak256(payload);
        return Object.freeze([Object.freeze({
          evidenceId: "observation:angstrom-empty-block",
          familyId: ANGSTROM_V4_FAMILY_ID,
          instanceKey: null as never,
          kind: "angstrom-empty-block-attestation",
          scope: "transaction" as const,
          source: input.source,
          txHash,
          evidenceHash: angstromRuntimeEvidenceHash({
            txHash,
            source: input.source,
            payloadHash,
          }),
          sealedPayloadRef: payload,
        })]);
      } catch {
        // One unverifiable attestation must not block the next.
      }
    }
  } catch {
    // Not a decodable angstrom swap call.
  }
  return Object.freeze([]);
}
