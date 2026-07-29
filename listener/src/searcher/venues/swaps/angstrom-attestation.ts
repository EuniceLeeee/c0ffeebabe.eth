import { ethers } from "ethers";

export const ANGSTROM_MAINNET_CHAIN_ID = 1n;
export const ANGSTROM_MAINNET_HOOK =
  "0x0000000aa232009084Bd71A5797d089AA4Edfad4";
export const ANGSTROM_MAINNET_ADAPTER =
  "0xb535aEB27335B91e1B5bcCbd64888bA7574eFBF8";
export const ANGSTROM_ADAPTER_SWAP_SELECTOR = "0xa88f90c1";

export const ANGSTROM_ADAPTER_SWAP_ABI = [
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint128 amountIn,uint128 minAmountOut,(uint64 blockNumber,bytes unlockData)[] bundle,address recipient,uint256 deadline) returns (uint256 amountOut)",
] as const;

const ANGSTROM_ADAPTER_INTERFACE = new ethers.Interface(
  ANGSTROM_ADAPTER_SWAP_ABI,
);
const ANGSTROM_ADAPTER_BYTES = ethers.getBytes(ANGSTROM_MAINNET_ADAPTER);
const ANGSTROM_SWAP_SELECTOR_BYTES = ethers.getBytes(
  ANGSTROM_ADAPTER_SWAP_SELECTOR,
);
const UINT64_MAX = (1n << 64n) - 1n;
const ANGSTROM_NODE_PREFIX_BYTES = 20;
export const MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE = 64;
const MAX_SWAP_CANDIDATES = 8;

const ANGSTROM_EMPTY_BLOCK_ATTESTATION_TYPES: Record<
  string,
  ethers.TypedDataField[]
> = {
  AttestAngstromBlockEmpty: [
    {
      name: "block_number",
      type: "uint64",
    },
  ],
};

const ANGSTROM_EIP712_DOMAIN: ethers.TypedDataDomain = Object.freeze({
  name: "Angstrom",
  version: "v1",
  chainId: ANGSTROM_MAINNET_CHAIN_ID,
  verifyingContract: ANGSTROM_MAINNET_HOOK,
});

export interface AngstromAttestationInput {
  readonly blockNumber: bigint;
  readonly unlockData: string;
}

export interface AngstromAttestationCandidate
  extends AngstromAttestationInput {
  readonly validator: string;
  readonly signature: string;
  readonly digest: string;
  readonly evidenceHash: string;
  readonly eoaSignatureValid: boolean;
}

export interface VerifiedAngstromAttestation
  extends AngstromAttestationCandidate {
  readonly verification: "eoa" | "erc1271" | "evidence-bound";
}

export interface VerifiedAngstromSwapCall {
  readonly calldataOffsetBytes: number;
  readonly calldataLengthBytes: number;
  readonly framing: "top-level" | "address-prefixed" | "uint24-length-prefixed";
  readonly attestations: readonly VerifiedAngstromAttestation[];
}

export interface RejectedAngstromSwapCandidate {
  readonly calldataOffsetBytes: number;
  readonly framing: VerifiedAngstromSwapCall["framing"];
  readonly reason: string;
}

export interface AngstromAttestationExtraction {
  readonly calls: readonly VerifiedAngstromSwapCall[];
  readonly rejected: readonly RejectedAngstromSwapCandidate[];
}

export interface AngstromAttestationCandidateSwapCall {
  readonly calldataOffsetBytes: number;
  readonly calldataLengthBytes: number;
  readonly framing: VerifiedAngstromSwapCall["framing"];
  readonly attestations: readonly AngstromAttestationCandidate[];
}

export interface AngstromAttestationCandidateExtraction {
  readonly calls: readonly AngstromAttestationCandidateSwapCall[];
  readonly rejected: readonly RejectedAngstromSwapCandidate[];
}

export interface AngstromTransactionLike {
  readonly to?: string | null;
  readonly data: string;
}

const ANGSTROM_EXECUTION_EVIDENCE_TYPES = [
  "tuple(uint64 blockNumber,bytes unlockData)[]",
] as const;

export interface AngstromAttestationVerificationPolicy {
  /**
   * Lower/checksummed forms are both accepted. Production intake supplies the
   * exact node set proven from the current canonical hook/controller state.
   */
  readonly allowedValidators?: ReadonlySet<string>;
}

interface SwapCandidate {
  readonly offset: number;
  readonly length: number;
  readonly framing: VerifiedAngstromSwapCall["framing"];
}

function normalizeAddress(address: string): string {
  return ethers.getAddress(address);
}

function isOfficialAdapter(address: string | null | undefined): boolean {
  if (!address) return false;
  try {
    return (
      normalizeAddress(address) === normalizeAddress(ANGSTROM_MAINNET_ADAPTER)
    );
  } catch {
    return false;
  }
}

function assertUint64(value: bigint, label: string): void {
  if (value < 0n || value > UINT64_MAX) {
    throw new Error(`${label} must fit uint64, got ${value}`);
  }
}

function bytesEqualAt(
  haystack: Uint8Array,
  offset: number,
  needle: Uint8Array,
): boolean {
  if (offset < 0 || offset + needle.length > haystack.length) return false;
  for (let index = 0; index < needle.length; index += 1) {
    if (haystack[offset + index] !== needle[index]) return false;
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validates the evidence accepted by Angstrom's
 * `unlockWithEmptyAttestation`: the first 20 bytes name the validator and the
 * remaining bytes sign the exact target block using Angstrom's EIP-712
 * domain. EOAs use ECDSA here; contract-node signatures are verified by the
 * family observer against ERC-1271 at the same frozen canonical head.
 *
 * Validator-set membership is intentionally not inferred here. The on-chain
 * hook remains authoritative for membership, while this pure module prevents
 * malformed, mismatched, or wrong-block evidence from entering the store.
 */
export function verifyAngstromAttestation(
  input: AngstromAttestationInput,
  policy: AngstromAttestationVerificationPolicy = {},
): VerifiedAngstromAttestation {
  const candidate = parseAngstromAttestation(input);
  if (
    policy.allowedValidators !== undefined &&
    !policy.allowedValidators.has(candidate.validator) &&
    !policy.allowedValidators.has(candidate.validator.toLowerCase())
  ) {
    throw new Error(
      `Angstrom attestation validator ${candidate.validator} is not authorized`,
    );
  }
  if (!candidate.eoaSignatureValid) {
    throw new Error(
      `Angstrom attestation signature is not a valid EOA signature for ${candidate.validator}`,
    );
  }
  return Object.freeze({
    ...candidate,
    verification: "eoa",
  });
}

/**
 * Structural/EIP-712 decode shared by EOA and ERC-1271 nodes. This function
 * never treats a contract signature as verified; the pending-evidence
 * observer must prove ERC-1271 plus hook membership before promotion.
 */
export function parseAngstromAttestation(
  input: AngstromAttestationInput,
): AngstromAttestationCandidate {
  assertUint64(input.blockNumber, "Angstrom attestation blockNumber");

  let bytes: Uint8Array;
  try {
    bytes = ethers.getBytes(input.unlockData);
  } catch (error) {
    throw new Error(`Angstrom unlockData is not valid bytes: ${errorMessage(error)}`);
  }
  if (bytes.length <= ANGSTROM_NODE_PREFIX_BYTES) {
    throw new Error(
      `Angstrom unlockData must contain a 20-byte node and non-empty signature, got ${bytes.length} bytes`,
    );
  }

  const validator = normalizeAddress(
    ethers.hexlify(bytes.slice(0, ANGSTROM_NODE_PREFIX_BYTES)),
  );
  const signature = ethers.hexlify(bytes.slice(ANGSTROM_NODE_PREFIX_BYTES));
  const digest = ethers.TypedDataEncoder.hash(
    ANGSTROM_EIP712_DOMAIN,
    ANGSTROM_EMPTY_BLOCK_ATTESTATION_TYPES,
    { block_number: input.blockNumber },
  );

  let eoaSignatureValid = false;
  try {
    const recovered = normalizeAddress(
      ethers.verifyTypedData(
        ANGSTROM_EIP712_DOMAIN,
        ANGSTROM_EMPTY_BLOCK_ATTESTATION_TYPES,
        { block_number: input.blockNumber },
        signature,
      ),
    );
    eoaSignatureValid = recovered === validator;
  } catch {
    // Arbitrary-length ERC-1271 signatures are verified on-chain by observer.
  }

  const unlockData = ethers.hexlify(bytes);
  return Object.freeze({
    blockNumber: input.blockNumber,
    unlockData,
    validator,
    signature,
    digest,
    evidenceHash: ethers.keccak256(unlockData),
    eoaSignatureValid,
  });
}

/**
 * Decodes one canonical AngstromAdapter.swap payload and verifies every
 * attestation before returning anything.
 */
export function decodeAngstromSwapAttestations(
  calldata: string,
  policy: AngstromAttestationVerificationPolicy = {},
): readonly VerifiedAngstromAttestation[] {
  const rawBundle = decodeCanonicalAngstromSwapBundle(calldata);
  const verified = Array.from(rawBundle, (entry) => {
    const tuple = entry as ethers.Result;
    return verifyAngstromAttestation(
      {
        blockNumber: BigInt(tuple[0]),
        unlockData: String(tuple[1]),
      },
      policy,
    );
  });
  return Object.freeze(verified);
}

export function decodeAngstromSwapAttestationCandidates(
  calldata: string,
): readonly AngstromAttestationCandidate[] {
  const rawBundle = decodeCanonicalAngstromSwapBundle(calldata);
  return Object.freeze(Array.from(rawBundle, (entry) => {
    const tuple = entry as ethers.Result;
    return parseAngstromAttestation({
      blockNumber: BigInt(tuple[0]),
      unlockData: String(tuple[1]),
    });
  }));
}

function decodeCanonicalAngstromSwapBundle(
  calldata: string,
): ethers.Result {
  const bytes = ethers.getBytes(calldata);
  if (!bytesEqualAt(bytes, 0, ANGSTROM_SWAP_SELECTOR_BYTES)) {
    throw new Error(
      `not AngstromAdapter.swap calldata: expected selector ${ANGSTROM_ADAPTER_SWAP_SELECTOR}`,
    );
  }

  let decoded: ethers.Result;
  try {
    decoded = ANGSTROM_ADAPTER_INTERFACE.decodeFunctionData("swap", calldata);
  } catch (error) {
    throw new Error(
      `invalid AngstromAdapter.swap calldata: ${errorMessage(error)}`,
    );
  }
  const canonicalCalldata = ANGSTROM_ADAPTER_INTERFACE.encodeFunctionData(
    "swap",
    [...decoded],
  );
  if (canonicalCalldata.toLowerCase() !== ethers.hexlify(bytes).toLowerCase()) {
    throw new Error(
      "invalid AngstromAdapter.swap calldata: payload is non-canonical or has a trailing suffix",
    );
  }

  const poolKey = decoded[0] as ethers.Result;
  if (!isOfficialHook(String(poolKey[4]))) {
    throw new Error(
      `invalid AngstromAdapter.swap calldata: foreign hook ${String(poolKey[4])}`,
    );
  }
  const rawBundle = decoded[4] as ethers.Result;
  if (rawBundle.length > MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE) {
    throw new Error(
      `Angstrom attestation bundle exceeds ${MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE} entries`,
    );
  }
  return rawBundle;
}

function isOfficialHook(address: string | null | undefined): boolean {
  if (!address) return false;
  try {
    return (
      normalizeAddress(address) === normalizeAddress(ANGSTROM_MAINNET_HOOK)
    );
  } catch {
    return false;
  }
}

function collectSwapCandidates(
  transaction: AngstromTransactionLike,
): readonly SwapCandidate[] {
  if (
    typeof transaction.data !== "string" ||
    !transaction.data.startsWith("0x") ||
    (transaction.data.length & 1) !== 0
  ) {
    return [];
  }
  // The registry canonicalizes pending evidence input with hexlify before any
  // family matcher. Keep this as a native substring search over those
  // lowercase bytes; lowercasing/copying every full-firehose payload here
  // would reintroduce a shared synchronous hot-path tax.
  const data = transaction.data.slice(2);
  const dataLength = data.length / 2;
  const adapterHex = ANGSTROM_MAINNET_ADAPTER.slice(2).toLowerCase();
  const selectorHex = ANGSTROM_ADAPTER_SWAP_SELECTOR.slice(2).toLowerCase();
  const candidates = new Map<string, SwapCandidate>();
  const add = (candidate: SwapCandidate): void => {
    candidates.set(
      `${candidate.offset}:${candidate.length}:${candidate.framing}`,
      candidate,
    );
  };

  if (
    isOfficialAdapter(transaction.to) &&
    data.startsWith(selectorHex)
  ) {
    add({
      offset: 0,
      length: dataLength,
      framing: "top-level",
    });
  }

  let searchFrom = 0;
  let inspectedOccurrences = 0;
  while (inspectedOccurrences < MAX_SWAP_CANDIDATES) {
    const match = data.indexOf(adapterHex, searchFrom);
    if (match < 0) break;
    inspectedOccurrences += 1;
    searchFrom = match + 2;
    if ((match & 1) !== 0) continue;
    const adapterOffset = match / 2;

    const addressPrefixedOffset =
      adapterOffset + ANGSTROM_ADAPTER_BYTES.length;
    const addressPrefixedHexOffset = addressPrefixedOffset * 2;
    if (
      data.startsWith(selectorHex, addressPrefixedHexOffset)
    ) {
      add({
        offset: addressPrefixedOffset,
        length: dataLength - addressPrefixedOffset,
        framing: "address-prefixed",
      });
    }

    // The public executor observed in landed Angstrom transactions uses the
    // protocol-agnostic packed-call frame [target:20][calldataLength:3][data].
    // Binding both the target and declared payload boundary avoids treating an
    // untrusted selector elsewhere in arbitrary calldata as Angstrom evidence.
    const lengthOffset = addressPrefixedOffset;
    const lengthPrefixedOffset = lengthOffset + 3;
    if (
      lengthPrefixedOffset + ANGSTROM_SWAP_SELECTOR_BYTES.length <=
        dataLength &&
      data.startsWith(selectorHex, lengthPrefixedOffset * 2)
    ) {
      const declaredLength = Number.parseInt(
        data.slice(lengthOffset * 2, lengthPrefixedOffset * 2),
        16,
      );
      if (
        declaredLength >= ANGSTROM_SWAP_SELECTOR_BYTES.length &&
        lengthPrefixedOffset + declaredLength <= dataLength
      ) {
        add({
          offset: lengthPrefixedOffset,
          length: declaredLength,
          framing: "uint24-length-prefixed",
        });
      }
    }
  }

  return [...candidates.values()].sort(
    (left, right) => left.offset - right.offset,
  );
}

export function hasAngstromSwapCandidate(
  transaction: AngstromTransactionLike,
): boolean {
  if (
    typeof transaction.data !== "string" ||
    !transaction.data.startsWith("0x") ||
    (transaction.data.length & 1) !== 0
  ) {
    return false;
  }
  const data = transaction.data;
  if (
    isOfficialAdapter(transaction.to) &&
    data.startsWith(ANGSTROM_ADAPTER_SWAP_SELECTOR.toLowerCase())
  ) {
    return true;
  }
  return data.includes(ANGSTROM_MAINNET_ADAPTER.slice(2).toLowerCase());
}

/**
 * Extracts verified evidence from either a direct call to the official
 * AngstromAdapter or an embedded call whose framing binds the selector to that
 * adapter address. A selector by itself is never trusted.
 */
export function extractAngstromAttestations(
  transaction: AngstromTransactionLike,
  policy: AngstromAttestationVerificationPolicy = {},
): AngstromAttestationExtraction {
  const calls: VerifiedAngstromSwapCall[] = [];
  const rejected: RejectedAngstromSwapCandidate[] = [];

  for (const candidate of collectSwapCandidates(transaction)) {
    try {
      const calldata = sliceHexCalldata(transaction.data, candidate);
      calls.push(
        Object.freeze({
          calldataOffsetBytes: candidate.offset,
          calldataLengthBytes: candidate.length,
          framing: candidate.framing,
          attestations: decodeAngstromSwapAttestations(calldata, policy),
        }),
      );
    } catch (error) {
      rejected.push(
        Object.freeze({
          calldataOffsetBytes: candidate.offset,
          framing: candidate.framing,
          reason: errorMessage(error),
        }),
      );
    }
  }

  return Object.freeze({
    calls: Object.freeze(calls),
    rejected: Object.freeze(rejected),
  });
}

export function extractAngstromAttestationCandidates(
  transaction: AngstromTransactionLike,
): AngstromAttestationCandidateExtraction {
  const calls: AngstromAttestationCandidateSwapCall[] = [];
  const rejected: RejectedAngstromSwapCandidate[] = [];
  for (const candidate of collectSwapCandidates(transaction)) {
    try {
      calls.push(Object.freeze({
        calldataOffsetBytes: candidate.offset,
        calldataLengthBytes: candidate.length,
        framing: candidate.framing,
        attestations: decodeAngstromSwapAttestationCandidates(
          sliceHexCalldata(transaction.data, candidate),
        ),
      }));
    } catch (error) {
      rejected.push(Object.freeze({
        calldataOffsetBytes: candidate.offset,
        framing: candidate.framing,
        reason: errorMessage(error),
      }));
    }
  }
  return Object.freeze({
    calls: Object.freeze(calls),
    rejected: Object.freeze(rejected),
  });
}

function sliceHexCalldata(
  data: string,
  candidate: SwapCandidate,
): string {
  const body = data.slice(2);
  return `0x${body.slice(
    candidate.offset * 2,
    (candidate.offset + candidate.length) * 2,
  )}`;
}

/** Canonical opaque payload carried by the generic pending-evidence kernel. */
export function encodeAngstromExecutionEvidence(
  evidence: readonly VerifiedAngstromAttestation[],
): string {
  if (
    evidence.length === 0 ||
    evidence.length > MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE
  ) {
    throw new Error(
      `Angstrom execution evidence requires 1..${MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE} attestations`,
    );
  }
  const unique = new Map<bigint, AngstromAttestationCandidate>();
  for (const item of evidence) {
    const candidate = parseAngstromAttestation(item);
    const prior = unique.get(candidate.blockNumber);
    if (
      !prior ||
      candidate.evidenceHash.localeCompare(prior.evidenceHash) < 0
    ) {
      unique.set(candidate.blockNumber, candidate);
    }
  }
  const ordered = [...unique.values()].sort((left, right) =>
    left.blockNumber < right.blockNumber
      ? -1
      : left.blockNumber > right.blockNumber
        ? 1
        : left.evidenceHash.localeCompare(right.evidenceHash)
  );
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ANGSTROM_EXECUTION_EVIDENCE_TYPES,
    [ordered.map((item) => ({
      blockNumber: item.blockNumber,
      unlockData: item.unlockData,
    }))],
  );
}

/**
 * Decode and re-verify the family payload at every quote/plan boundary. The
 * registry has already bound these bytes to txHash+headHash; this function
 * prevents an invalid family-local encoding from reaching calldata.
 */
export function decodeAngstromExecutionEvidence(
  payload: string,
): readonly VerifiedAngstromAttestation[] {
  if (!ethers.isHexString(payload)) {
    throw new Error("Angstrom execution evidence payload is not hex");
  }
  let decoded: ethers.Result;
  try {
    decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ANGSTROM_EXECUTION_EVIDENCE_TYPES,
      payload,
    );
  } catch (error) {
    throw new Error(
      `Angstrom execution evidence payload is invalid: ${errorMessage(error)}`,
    );
  }
  const raw = decoded[0] as ethers.Result;
  if (
    raw.length === 0 ||
    raw.length > MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE
  ) {
    throw new Error(
      `Angstrom execution evidence requires 1..${MAX_ANGSTROM_ATTESTATIONS_PER_EVIDENCE} attestations`,
    );
  }
  const verified = Array.from(raw, (entry) => {
    const tuple = entry as ethers.Result;
    const candidate = parseAngstromAttestation({
      blockNumber: BigInt(tuple[0]),
      unlockData: String(tuple[1]),
    });
    return Object.freeze({
      ...candidate,
      verification: "evidence-bound" as const,
    });
  });
  const canonical = encodeAngstromExecutionEvidence(verified);
  if (canonical.toLowerCase() !== payload.toLowerCase()) {
    throw new Error("Angstrom execution evidence payload is non-canonical");
  }
  return Object.freeze(verified);
}
