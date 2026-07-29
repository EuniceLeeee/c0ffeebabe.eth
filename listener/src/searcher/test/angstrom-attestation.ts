import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  ANGSTROM_ADAPTER_SWAP_ABI,
  ANGSTROM_ADAPTER_SWAP_SELECTOR,
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_CHAIN_ID,
  ANGSTROM_MAINNET_HOOK,
  decodeAngstromExecutionEvidence,
  decodeAngstromSwapAttestations,
  encodeAngstromExecutionEvidence,
  extractAngstromAttestationCandidates,
  extractAngstromAttestations,
  hasAngstromSwapCandidate,
  verifyAngstromAttestation,
  type AngstromAttestationInput,
} from "../venues/swaps/angstrom-attestation.js";

const adapterInterface = new ethers.Interface(ANGSTROM_ADAPTER_SWAP_ABI);
const wallet = new ethers.Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412e5b41436b2d59d",
);
const secondWallet = new ethers.Wallet(
  "0x8b3a350cf5c34c9194ca3a545d3f2ea58b7f0e3d4ecf23e275f86c7f9b6095fe",
);
const types = {
  AttestAngstromBlockEmpty: [
    {
      name: "block_number",
      type: "uint64",
    },
  ],
};
const domain = {
  name: "Angstrom",
  version: "v1",
  chainId: ANGSTROM_MAINNET_CHAIN_ID,
  verifyingContract: ANGSTROM_MAINNET_HOOK,
};

async function makeAttestation(
  blockNumber: bigint,
  signer = wallet,
): Promise<AngstromAttestationInput> {
  const signature = await signer.signTypedData(
    domain,
    types,
    { block_number: blockNumber },
  );
  return {
    blockNumber,
    unlockData: ethers.concat([signer.address, signature]),
  };
}

function encodeSwap(
  bundle: readonly AngstromAttestationInput[],
  hooks = ANGSTROM_MAINNET_HOOK,
): string {
  return adapterInterface.encodeFunctionData("swap", [
    {
      currency0: "0x1111111111111111111111111111111111111111",
      currency1: "0x2222222222222222222222222222222222222222",
      fee: 0x80_0000,
      tickSpacing: 10,
      hooks,
    },
    true,
    1_000_000n,
    900_000n,
    bundle.map((entry) => ({
      blockNumber: entry.blockNumber,
      unlockData: entry.unlockData,
    })),
    "0x3333333333333333333333333333333333333333",
    1_900_000_000n,
  ]);
}

function uint24Hex(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff_ffff) {
    throw new Error(`not uint24: ${value}`);
  }
  return value.toString(16).padStart(6, "0");
}

async function main(): Promise<void> {
  assert.equal(
    adapterInterface.getFunction("swap")!.selector,
    ANGSTROM_ADAPTER_SWAP_SELECTOR,
  );

  const block = 25_635_365n;
  const current = await makeAttestation(block);
  const next = await makeAttestation(block + 1n);
  const calldata = encodeSwap([current, next]);

  const decoded = decodeAngstromSwapAttestations(calldata);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0]!.blockNumber, block);
  assert.equal(decoded[0]!.validator, ethers.getAddress(wallet.address));
  assert.equal(decoded[0]!.unlockData, current.unlockData);
  const executionPayload = encodeAngstromExecutionEvidence(decoded);
  const executionEvidence = decodeAngstromExecutionEvidence(executionPayload);
  assert(Object.isFrozen(executionEvidence));
  assert.equal(executionEvidence.length, 2);
  assert.equal(executionEvidence[0]!.evidenceHash, decoded[0]!.evidenceHash);
  assert.throws(
    () =>
      decodeAngstromSwapAttestations(calldata, {
        allowedValidators: new Set([secondWallet.address.toLowerCase()]),
      }),
    /not authorized/,
    "current on-chain validator membership must be required by production intake",
  );
  assert.throws(
    () =>
      decodeAngstromSwapAttestations(
        encodeSwap(
          [current],
          "0x0000000000000000000000000000000000000003",
        ),
      ),
    /foreign hook/,
    "the official adapter selector must not classify a foreign hook as Angstrom",
  );

  const direct = extractAngstromAttestations({
    to: ANGSTROM_MAINNET_ADAPTER,
    data: calldata,
  });
  assert.equal(direct.calls.length, 1);
  assert.equal(direct.calls[0]!.framing, "top-level");
  assert.equal(direct.calls[0]!.attestations.length, 2);
  assert.equal(direct.rejected.length, 0);

  const wrongTopLevelTarget = extractAngstromAttestations({
    to: "0x4444444444444444444444444444444444444444",
    data: calldata,
  });
  assert.equal(wrongTopLevelTarget.calls.length, 0);
  assert.equal(wrongTopLevelTarget.rejected.length, 0);

  const bareNestedSelector = extractAngstromAttestations({
    data: ethers.concat(["0x010203", calldata, "0xaabb"]),
  });
  assert.equal(
    bareNestedSelector.calls.length,
    0,
    "an embedded selector without the official adapter prefix is ignored",
  );

  const addressPrefixed = extractAngstromAttestations({
    data: ethers.concat([
      "0x010203",
      ANGSTROM_MAINNET_ADAPTER,
      calldata,
    ]),
  });
  assert.equal(addressPrefixed.calls.length, 1);
  assert.equal(addressPrefixed.calls[0]!.framing, "address-prefixed");
  assert.equal(addressPrefixed.calls[0]!.attestations.length, 2);

  const calldataLength = ethers.getBytes(calldata).length;
  const lengthPrefixed = extractAngstromAttestations({
    data: ethers.concat([
      "0x010203",
      ANGSTROM_MAINNET_ADAPTER,
      `0x${uint24Hex(calldataLength)}`,
      calldata,
      "0xaabbccdd",
    ]),
  });
  assert.equal(lengthPrefixed.calls.length, 1);
  assert.equal(
    lengthPrefixed.calls[0]!.framing,
    "uint24-length-prefixed",
  );
  assert.equal(lengthPrefixed.calls[0]!.calldataLengthBytes, calldataLength);

  const suffixedLengthPrefixed = extractAngstromAttestations({
    data: ethers.concat([
      ANGSTROM_MAINNET_ADAPTER,
      `0x${uint24Hex(calldataLength + 4)}`,
      calldata,
      "0xdeadbeef",
    ]),
  });
  assert.equal(suffixedLengthPrefixed.calls.length, 0);
  assert.equal(suffixedLengthPrefixed.rejected.length, 1);
  assert.match(
    suffixedLengthPrefixed.rejected[0]!.reason,
    /non-canonical|trailing suffix/,
  );

  const truncatedLengthPrefixed = extractAngstromAttestations({
    data: ethers.concat([
      ANGSTROM_MAINNET_ADAPTER,
      `0x${uint24Hex(calldataLength + 1_000)}`,
      calldata,
    ]),
  });
  assert.equal(truncatedLengthPrefixed.calls.length, 0);

  const wrongLength = {
    blockNumber: block,
    unlockData: ethers.hexlify(ethers.getBytes(current.unlockData).slice(0, 83)),
  };
  assert.throws(
    () => verifyAngstromAttestation(wrongLength),
    /not a valid EOA signature/,
  );

  const mismatchedPrefix: AngstromAttestationInput = {
    blockNumber: block,
    unlockData: ethers.concat([
      secondWallet.address,
      ethers.dataSlice(current.unlockData, 20),
    ]),
  };
  assert.throws(
    () => verifyAngstromAttestation(mismatchedPrefix),
    /not a valid EOA signature/,
  );

  const wrongBlock: AngstromAttestationInput = {
    blockNumber: block + 1n,
    unlockData: current.unlockData,
  };
  assert.throws(
    () => verifyAngstromAttestation(wrongBlock),
    /not a valid EOA signature/,
  );

  const malformedCall = encodeSwap([wrongLength]);
  const rejectedDirect = extractAngstromAttestations({
    to: ANGSTROM_MAINNET_ADAPTER,
    data: malformedCall,
  });
  assert.equal(rejectedDirect.calls.length, 0);
  assert.equal(rejectedDirect.rejected.length, 1);
  assert.match(rejectedDirect.rejected[0]!.reason, /not a valid EOA signature/);

  const contractNode = "0x6666666666666666666666666666666666666666";
  const contractAttestation: AngstromAttestationInput = {
    blockNumber: block,
    unlockData: ethers.concat([contractNode, `0x${"ab".repeat(103)}`]),
  };
  const contractCalldata = encodeSwap([contractAttestation]);
  assert.throws(
    () => decodeAngstromSwapAttestations(contractCalldata),
    /not a valid EOA signature/,
    "pure EOA verification must not pretend an ERC-1271 signature is valid",
  );
  const contractCandidates = extractAngstromAttestationCandidates({
    to: ANGSTROM_MAINNET_ADAPTER,
    data: contractCalldata,
  });
  assert.equal(contractCandidates.calls.length, 1);
  assert.equal(contractCandidates.calls[0]!.attestations.length, 1);
  assert.equal(
    contractCandidates.calls[0]!.attestations[0]!.validator,
    ethers.getAddress(contractNode),
  );
  assert.equal(
    contractCandidates.calls[0]!.attestations[0]!.eoaSignatureValid,
    false,
  );

  const sameBlockSecond = verifyAngstromAttestation(
    await makeAttestation(block, secondWallet),
  );
  const sameBlockPayload = encodeAngstromExecutionEvidence([
    verifyAngstromAttestation(current),
    sameBlockSecond,
  ]);
  assert.equal(
    decodeAngstromExecutionEvidence(sameBlockPayload).length,
    1,
    "canonical evidence must select exactly one proof per block",
  );

  const largeNoMatch = `0x${"00".repeat(128 * 1024)}`;
  assert.equal(
    hasAngstromSwapCandidate({ data: largeNoMatch }),
    false,
    "full-firehose prefilter must reject a large no-match payload",
  );

  console.log(
    JSON.stringify({
      ok: true,
      directCalls: direct.calls.length,
      addressPrefixedCalls: addressPrefixed.calls.length,
      lengthPrefixedCalls: lengthPrefixed.calls.length,
      executionEvidence: executionEvidence.length,
    }),
  );
}

await main();
