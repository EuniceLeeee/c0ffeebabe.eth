import { execFileSync } from "node:child_process";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  sha256Hex,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type {
  AttestationIdentityProofIssueInputV1,
  AttestationIdentityProofVerificationContextV1,
  AttestationOutcomeProofIssueInputV1,
  AttestationOutcomeProofVerificationContextV1,
} from "../../../attestation/src/internal-authority.ts";
import {
  identityProofSigningBytes,
  issueIdentityIssuerProof,
  validateIdentityIssuerProof,
} from "../../../attestation/src/internal/identity-proof.ts";
import {
  issueOutcomeIssuerProof,
  outcomeProofSigningBytes,
  validateOutcomeIssuerProof,
} from "../../../attestation/src/internal/outcome-proof.ts";
import {
  candidatePartitionProofId,
  candidatePartitionProofPayloadHash,
  candidatePartitionProofSigningBytes,
  decodeCandidatePartitionProofV1,
  validateCandidatePartitionProof,
  type CandidateNominationQualificationBindingV1,
  type CandidatePartitionProofIssuerPortV1,
  type CandidatePartitionProofPayloadV1,
  type CandidatePartitionProofReleaseBindingV1,
  type CandidatePartitionProofVerificationContextV1,
} from "../../../../specs/candidate-partition-authority/src/index.ts";
import { issueCandidatePartitionProofIssuerPort } from "../../../../specs/candidate-partition-authority/src/internal/issuer-owner.ts";
import {
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseBindingV1,
} from "../../../../specs/release-authority/src/index.ts";
import {
  issueDeploymentAttestationProofPort,
  type RuntimeReleaseAttestationProofPortV1,
} from "./attestation-proof-owner.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SIGNER_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });

export interface ExternalProofSignerRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.external-proof-signer";
  readonly executablePath: string;
  readonly executableSha256: Hash;
  readonly attestationPublicKeyHex: `0x${string}`;
  readonly candidatePartitionPublicKeyHex: `0x${string}`;
  readonly nominationQualifications: readonly CandidateNominationQualificationBindingV1[];
}

export interface ExternalProofPortsV1 {
  readonly attestationProof: RuntimeReleaseAttestationProofPortV1;
  readonly candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
}

function publicKeyHex(value: unknown, path: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || value === `0x${"00".repeat(32)}`) {
    throw new TypeError(`${path} must be a lowercase raw Ed25519 public key`);
  }
  return value as `0x${string}`;
}

function qualification(value: unknown, path: string): CandidateNominationQualificationBindingV1 {
  assertExactKeys(value, [
    "sourcePlanIdentity",
    "sourcePlanLeafDigest",
    "nominationProgramRoot",
    "nominationProgramProposalLeafDigest",
    "qualificationLeafDigest",
  ], path);
  return Object.freeze({
    sourcePlanIdentity: assertHash(value.sourcePlanIdentity, `${path}.sourcePlanIdentity`),
    sourcePlanLeafDigest: assertHash(value.sourcePlanLeafDigest, `${path}.sourcePlanLeafDigest`),
    nominationProgramRoot: assertHash(value.nominationProgramRoot, `${path}.nominationProgramRoot`),
    nominationProgramProposalLeafDigest: assertHash(value.nominationProgramProposalLeafDigest, `${path}.nominationProgramProposalLeafDigest`),
    qualificationLeafDigest: assertHash(value.qualificationLeafDigest, `${path}.qualificationLeafDigest`),
  });
}

export function decodeExternalProofSignerRequestV1(value: unknown): ExternalProofSignerRequestV1 {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "executablePath",
    "executableSha256",
    "attestationPublicKeyHex",
    "candidatePartitionPublicKeyHex",
    "nominationQualifications",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "aloha.external-proof-signer") {
    throw new TypeError("external proof signer request is invalid");
  }
  const executablePath = assertNonEmptyString(value.executablePath, "externalProofSigner.executablePath");
  if (!isAbsolute(executablePath)) throw new TypeError("external proof signer executable path must be absolute");
  if (!Array.isArray(value.nominationQualifications)) throw new TypeError("external proof signer nomination qualifications are required");
  const nominationQualifications = Object.freeze(value.nominationQualifications.map((entry, index) => qualification(
    entry,
    `externalProofSigner.nominationQualifications[${index}]`,
  )));
  const ordered = [...nominationQualifications].sort((left, right) => left.nominationProgramProposalLeafDigest.localeCompare(right.nominationProgramProposalLeafDigest));
  if (ordered.some((entry, index) => entry.nominationProgramProposalLeafDigest !== nominationQualifications[index]?.nominationProgramProposalLeafDigest)
    || new Set(nominationQualifications.map(entry => entry.nominationProgramProposalLeafDigest)).size !== nominationQualifications.length) {
    throw new TypeError("external proof signer nomination qualifications must be sorted and unique");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.external-proof-signer",
    executablePath,
    executableSha256: assertHash(value.executableSha256, "externalProofSigner.executableSha256"),
    attestationPublicKeyHex: publicKeyHex(value.attestationPublicKeyHex, "externalProofSigner.attestationPublicKeyHex"),
    candidatePartitionPublicKeyHex: publicKeyHex(value.candidatePartitionPublicKeyHex, "externalProofSigner.candidatePartitionPublicKeyHex"),
    nominationQualifications,
  });
}

function signingCommand(request: ExternalProofSignerRequestV1) {
  const executablePath = realpathSync(request.executablePath);
  const stat = statSync(executablePath);
  if (executablePath !== request.executablePath || !stat.isFile() || (stat.mode & 0o111) === 0
    || sha256Hex(new Uint8Array(readFileSync(executablePath))) !== request.executableSha256) {
    throw new TypeError("external proof signer executable does not match the approved bytes");
  }
  const sign = (domain: string, keyId: Hash, bytes: Uint8Array, publicKey: `0x${string}`): `0x${string}` => {
    const output = new Uint8Array(execFileSync(executablePath, [], {
      input: encodeCanonicalBytes({
        schemaVersion: 1,
        kind: "aloha.external-proof-signing-request",
        domain,
        keyId,
        signingBytesHex: `0x${Buffer.from(bytes).toString("hex")}`,
      }),
      env: SIGNER_ENV,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    const decoded = decodeCanonicalJson(output);
    assertExactKeys(decoded, ["signatureHex"]);
    const signatureHex = decoded.signatureHex;
    if (typeof signatureHex !== "string" || !/^0x[0-9a-f]{128}$/.test(signatureHex)) {
      throw new TypeError("external proof signer returned an invalid signature");
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey.slice(2), "hex")]),
      format: "der",
      type: "spki",
    });
    if (!verifySignature(null, bytes, key, Buffer.from(signatureHex.slice(2), "hex"))) {
      throw new TypeError("external proof signer signature verification failed");
    }
    return signatureHex as `0x${string}`;
  };
  const verify = (bytes: Uint8Array, signatureHex: string, publicKey: `0x${string}`): void => {
    if (!/^0x[0-9a-f]{128}$/.test(signatureHex)) throw new TypeError("external proof signature is invalid");
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey.slice(2), "hex")]),
      format: "der",
      type: "spki",
    });
    if (!verifySignature(null, bytes, key, Buffer.from(signatureHex.slice(2), "hex"))) {
      throw new TypeError("external proof signature verification failed");
    }
  };
  return Object.freeze({ sign, verify });
}

function assertAttestationBinding(
  value: AttestationIdentityProofIssueInputV1 | AttestationIdentityProofVerificationContextV1
    | AttestationOutcomeProofIssueInputV1 | AttestationOutcomeProofVerificationContextV1,
  binding: RuntimeReleaseBindingV1,
): void {
  if (value.attestationProofIssuerKeyId !== binding.attestationProofIssuerKeyId
    || value.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
    || value.frameworkAuthorityRoot !== binding.frameworkAuthorityRoot
    || value.executorAuthorityRoot !== binding.executorAuthorityRoot
    || value.releaseAuthorityRoot !== binding.releaseAuthorityRoot) {
    throw new TypeError("external attestation proof runtime binding mismatch");
  }
}

function sameQualifications(
  left: readonly CandidateNominationQualificationBindingV1[],
  right: readonly CandidateNominationQualificationBindingV1[],
): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

export function issueExternalProofPortsV1(input: Readonly<{
  readonly binding: RuntimeReleaseBindingV1;
  readonly request: ExternalProofSignerRequestV1;
}>): ExternalProofPortsV1 {
  assertExactKeys(input, ["binding", "request"]);
  const binding = input.binding;
  const request = decodeExternalProofSignerRequestV1(input.request);
  const qualificationByProposal = new Map(binding.nominationQualificationSet.entries.map(entry => [
    entry.proposalLeafDigest,
    entry.qualificationLeafDigest,
  ]));
  if (request.nominationQualifications.length !== qualificationByProposal.size
    || request.nominationQualifications.some(entry => qualificationByProposal.get(
      entry.nominationProgramProposalLeafDigest,
    ) !== entry.qualificationLeafDigest)) {
    throw new TypeError("external proof signer nomination qualifications do not join the signed release");
  }
  const command = signingCommand(request);
  let sequence = 0n;
  const attestationProof = issueDeploymentAttestationProofPort(Object.freeze({
    issueIdentity(value: unknown) {
      const proofInput = value as AttestationIdentityProofIssueInputV1;
      assertAttestationBinding(proofInput, binding);
      sequence += 1n;
      return issueIdentityIssuerProof(proofInput, binding.attestationProofIssuerKeyId, sequence.toString(), bytes => command.sign(
        "attestation-identity-v2",
        binding.attestationProofIssuerKeyId,
        bytes,
        request.attestationPublicKeyHex,
      ));
    },
    verifyIdentity(value: unknown, contextValue: unknown) {
      const context = contextValue as AttestationIdentityProofVerificationContextV1;
      assertAttestationBinding(context, binding);
      const proof = validateIdentityIssuerProof(value, context);
      command.verify(identityProofSigningBytes(proof), proof.signatureHex, request.attestationPublicKeyHex);
      return proof;
    },
    issueOutcome(value: unknown) {
      const proofInput = value as AttestationOutcomeProofIssueInputV1;
      assertAttestationBinding(proofInput, binding);
      sequence += 1n;
      return issueOutcomeIssuerProof(proofInput, binding.attestationProofIssuerKeyId, sequence.toString(), bytes => command.sign(
        "attestation-outcome-v2",
        binding.attestationProofIssuerKeyId,
        bytes,
        request.attestationPublicKeyHex,
      ));
    },
    verifyOutcome(value: unknown, contextValue: unknown) {
      const context = contextValue as AttestationOutcomeProofVerificationContextV1;
      assertAttestationBinding(context, binding);
      const proof = validateOutcomeIssuerProof(value, context);
      command.verify(outcomeProofSigningBytes(proof), proof.signatureHex, request.attestationPublicKeyHex);
      return proof;
    },
  }));
  const release = (): CandidatePartitionProofReleaseBindingV1 => Object.freeze({
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    releaseAuthorityRoot: binding.releaseAuthorityRoot,
    candidatePartitionProofIssuerKeyId: binding.candidatePartitionProofIssuerKeyId,
  });
  const candidatePartitionProofIssuer = issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: release,
    assertNominationQualificationsQualified(values: readonly CandidateNominationQualificationBindingV1[]) {
      if (!sameQualifications(values, request.nominationQualifications)) {
        throw new TypeError("candidate partition nomination qualifications do not match the approved exact set");
      }
    },
    issue(payload: CandidatePartitionProofPayloadV1) {
      if (payload.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
        || payload.issuerKeyId !== binding.candidatePartitionProofIssuerKeyId) {
        throw new TypeError("candidate partition proof runtime binding mismatch");
      }
      const payloadHash = candidatePartitionProofPayloadHash(payload);
      const signatureHex = command.sign(
        "candidate-partition-v2",
        binding.candidatePartitionProofIssuerKeyId,
        candidatePartitionProofSigningBytes(payload, binding.candidatePartitionProofIssuerKeyId),
        request.candidatePartitionPublicKeyHex,
      );
      return decodeCandidatePartitionProofV1({
        ...payload,
        proofId: candidatePartitionProofId(payloadHash),
        payloadHash,
        signatureAlgorithm: "ed25519",
        signerKeyId: binding.candidatePartitionProofIssuerKeyId,
        signatureHex,
      });
    },
    verify(value: unknown, context: CandidatePartitionProofVerificationContextV1) {
      const expectedRelease = release();
      if (context.release.releaseProvenanceHash !== expectedRelease.releaseProvenanceHash
        || context.release.releaseAuthorityRoot !== expectedRelease.releaseAuthorityRoot
        || context.release.candidatePartitionProofIssuerKeyId !== expectedRelease.candidatePartitionProofIssuerKeyId) {
        throw new TypeError("candidate partition proof release binding mismatch");
      }
      const proof = validateCandidatePartitionProof(value, context);
      command.verify(candidatePartitionProofSigningBytes(proof), proof.signatureHex, request.candidatePartitionPublicKeyHex);
      return proof;
    },
  }));
  return Object.freeze({ attestationProof, candidatePartitionProofIssuer });
}
