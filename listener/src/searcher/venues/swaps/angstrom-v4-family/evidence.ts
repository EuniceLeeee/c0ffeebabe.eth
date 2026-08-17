import { ethers } from "ethers";
import type {
  RuntimeEvidence,
} from "../../adapter-family-plugin.js";
import { PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND } from
  "../../../runtime-evidence.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_ADAPTER_SWAP_SELECTOR,
  decodeAngstromExecutionEvidence,
  encodeAngstromExecutionEvidence,
  extractAngstromAttestationCandidates,
  MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE,
  parseAngstromAttestation,
  type AngstromAttestationCandidate,
  type VerifiedAngstromAttestation,
} from "../angstrom-attestation.js";
import {
  ANGSTROM_MAINNET_HOOK,
} from "../angstrom-attestation.js";
import {
  BLOCKSCAN_MULTICALL3,
  decodeMulticall,
  encodeMulticall,
  type MulticallItem,
} from "../blockscan-state-shared.js";
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
  return "0x" + hashCanonical({
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
    (
      item.kind === "angstrom-empty-block-attestation" ||
      item.kind === PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND
    )
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
  const expectedEvidenceHash = runtime.kind ===
      PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND
    ? ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "bytes32", "uint256", "bytes32", "bytes32"],
          [
            runtime.familyId,
            runtime.txHash,
            runtime.source.number,
            runtime.source.hash,
            payloadHash,
          ],
        ),
      )
    : angstromRuntimeEvidenceHash({
        txHash: runtime.txHash,
        source: runtime.source,
        payloadHash,
      });
  if (runtime.evidenceHash.toLowerCase() !== expectedEvidenceHash.toLowerCase()) {
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

const ANGSTROM_CONTROLLER_SLOT = 0n;
const ANGSTROM_NODE_MAPPING_SLOT = 1n;
const ANGSTROM_HOOK_STATE_INTERFACE = new ethers.Interface([
  "function extsload(uint256 slot) view returns (uint256 value)",
]);
const ANGSTROM_CONTROLLER_INTERFACE = new ethers.Interface([
  "function ANGSTROM() view returns (address)",
]);

/**
 * Current-head pending evidence. Unlike the synchronous observation
 * projection, this path proves the live Hook -> Controller -> validator
 * authority at the exact frozen head before the central dispatcher seals the
 * payload. Protocol knowledge stays in the Family; the dispatcher only owns
 * bounded transport and the outer tx/head hash binding.
 */
export async function angstromPendingRuntimeEvidenceFromObservation(input: {
  readonly observation: UnifiedObservation;
  readonly source: CanonicalSource;
  call(read: { readonly to: string; readonly data: string }): Promise<string>;
}): Promise<readonly RuntimeEvidence[]> {
  const observation = input.observation;
  if (
    observation.kind !== "call" ||
    observation.transactionHash === undefined ||
    observation.target.toLowerCase() !== ANGSTROM_MAINNET_ADAPTER.toLowerCase()
  ) {
    return Object.freeze([]);
  }
  const extraction = extractAngstromAttestationCandidates({
    to: observation.target,
    data: observation.data,
  });
  const unique = new Map<string, AngstromAttestationCandidate>();
  for (const candidate of extraction.calls.flatMap((call) => call.attestations)) {
    unique.set(candidate.evidenceHash.toLowerCase(), candidate);
  }
  if (unique.size === 0) return Object.freeze([]);
  if (unique.size > MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE) {
    throw new Error(
      `angstrom-v4 pending evidence exceeds ` +
        `${MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE} unique attestations`,
    );
  }
  const verified = await verifyCurrentAngstromAuthority(
    input.source,
    [...unique.values()],
    input.call,
  );
  if (verified.length === 0) return Object.freeze([]);
  const payload = encodeAngstromExecutionEvidence(verified);
  const payloadHash = ethers.keccak256(payload);
  const txHash = observation.transactionHash.toLowerCase();
  return Object.freeze([Object.freeze({
    evidenceId: "pending:angstrom-current-head",
    familyId: ANGSTROM_V4_FAMILY_ID,
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
}

async function verifyCurrentAngstromAuthority(
  source: CanonicalSource,
  candidates: readonly AngstromAttestationCandidate[],
  call: (read: { readonly to: string; readonly data: string }) => Promise<string>,
): Promise<readonly VerifiedAngstromAttestation[]> {
  if (!candidates.some((candidate) =>
    candidate.blockNumber === BigInt(source.number)
  )) {
    return Object.freeze([]);
  }
  const controllerWord = await call({
    to: ANGSTROM_MAINNET_HOOK,
    data: ANGSTROM_HOOK_STATE_INTERFACE.encodeFunctionData(
      "extsload",
      [ANGSTROM_CONTROLLER_SLOT],
    ),
  });
  const controllerSlot = ethers.toBeHex(
    BigInt(
      ANGSTROM_HOOK_STATE_INTERFACE.decodeFunctionResult(
        "extsload",
        controllerWord,
      )[0],
    ),
    32,
  );
  const controller = ethers.getAddress(ethers.dataSlice(controllerSlot, 12));
  if (controller === ethers.ZeroAddress) {
    throw new Error("angstrom-v4 hook has no controller");
  }
  const canonicalHookRaw = await call({
    to: controller,
    data: ANGSTROM_CONTROLLER_INTERFACE.encodeFunctionData("ANGSTROM"),
  });
  const canonicalHook = ethers.getAddress(String(
    ANGSTROM_CONTROLLER_INTERFACE.decodeFunctionResult(
      "ANGSTROM",
      canonicalHookRaw,
    )[0],
  ));
  if (canonicalHook !== ethers.getAddress(ANGSTROM_MAINNET_HOOK)) {
    throw new Error(
      `angstrom-v4 controller ${controller} does not govern canonical hook`,
    );
  }

  const validators = [...new Set(
    candidates.map((candidate) => candidate.validator.toLowerCase()),
  )];
  const items: MulticallItem[] = validators.map((validator) => ({
    label: angstromNodeProofLabel(validator),
    target: ANGSTROM_MAINNET_HOOK,
    callData: ANGSTROM_HOOK_STATE_INTERFACE.encodeFunctionData(
      "extsload",
      [angstromNodeMappingStorageSlot(validator)],
    ),
    allowFailure: true,
  }));
  const proofRaw = await call({
    to: BLOCKSCAN_MULTICALL3,
    data: encodeMulticall(items),
  });
  const proofs = decodeMulticall({
    id: "angstrom-v4-current-authority",
    ok: true,
    sourceBlock: source.number,
    sourceBlockHash: source.hash,
    provenance: {
      kind: "immutable-fork",
      source,
      forkId: `pending-evidence:${source.hash}`,
    },
    data: proofRaw,
  }, items);
  const authorized = new Set(validators.filter((validator) => {
    const result = proofs.get(angstromNodeProofLabel(validator));
    if (!result?.success || result.returnData === "0x") return false;
    try {
      return BigInt(
        ANGSTROM_HOOK_STATE_INTERFACE.decodeFunctionResult(
          "extsload",
          result.returnData,
        )[0],
      ) === 1n;
    } catch {
      return false;
    }
  }));
  return Object.freeze(candidates.flatMap((candidate) =>
    authorized.has(candidate.validator.toLowerCase()) &&
      candidate.eoaSignatureValid &&
      candidate.blockNumber === BigInt(source.number)
      ? [Object.freeze({ ...candidate, verification: "eoa" as const })]
      : []
  ));
}

function angstromNodeMappingStorageSlot(validator: string): bigint {
  return BigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [validator, ANGSTROM_NODE_MAPPING_SLOT],
    ),
  ));
}

function angstromNodeProofLabel(validator: string): string {
  return `angstrom-v4-node:${validator.toLowerCase()}`;
}
