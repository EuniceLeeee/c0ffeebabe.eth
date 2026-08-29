import {
  createPrivateKey,
  createPublicKey,
  sign as signSignature,
  verify as verifySignature,
} from "node:crypto";
import {
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  candidatePartitionRoot,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";
import {
  candidatePartitionProofId,
  candidatePartitionProofPayloadHash,
  candidatePartitionProofSigningBytes,
  candidatePartitionBindingFromProof,
  decodeCandidatePartitionProofV1,
  makeCandidatePartitionProofPayload,
  validateCandidatePartitionProof,
  type CandidatePartitionProofIssuerPortV1,
  type CandidatePartitionProofPayloadV1,
  type CandidatePartitionProofReleaseBindingV1,
  type CandidatePartitionProofVerificationContextV1,
  type CandidatePartitionCapabilityV1,
  type CandidatePartitionBindingV1,
  type CandidatePartitionReaderPortV1,
  type CandidateNominationQualificationBindingV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import { issueCandidatePartitionProofIssuerPort } from "../../../specs/candidate-partition-authority/src/internal/issuer-owner.ts";
import {
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseBindingV1,
} from "../../../specs/release-authority/src/index.ts";
import { CandidatePartitionCapabilityRegistryV1 } from "../src/candidate-partition.ts";

const PRIVATE_KEY_DER_BASE64 = "MC4CAQAwBQYDK2VwBCIEIBkwnjY4jrp3lZ5OHLbf6/zyv+KqmljVVV38rJEoFMrv";
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(PRIVATE_KEY_DER_BASE64, "base64"),
  format: "der",
  type: "pkcs8",
});
const PUBLIC_KEY = createPublicKey(PRIVATE_KEY);

function signHex(bytes: Uint8Array): `0x${string}` {
  const signature = signSignature(null, bytes, PRIVATE_KEY);
  return `0x${Buffer.from(signature).toString("hex")}` as `0x${string}`;
}

function verifyHex(bytes: Uint8Array, value: string): void {
  if (!verifySignature(null, bytes, PUBLIC_KEY, Buffer.from(value.slice(2), "hex"))) {
    throw new TypeError("candidate partition fixture signature mismatch");
  }
}

/** Test-only external issuer; never imported by checkpoint production code. */
export function createCandidatePartitionProofIssuerFixture(
  binding: RuntimeReleaseBindingV1,
  currentBinding: () => RuntimeReleaseBindingV1 = () => binding,
  qualifiedBindings?: readonly CandidateNominationQualificationBindingV1[],
): CandidatePartitionProofIssuerPortV1 {
  const release = (): CandidatePartitionProofReleaseBindingV1 => {
    const current = currentBinding();
    return Object.freeze({
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(current),
      releaseAuthorityRoot: current.releaseAuthorityRoot,
      candidatePartitionProofIssuerKeyId: current.candidatePartitionProofIssuerKeyId,
    });
  };
  return issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease: release,
    assertNominationQualificationsQualified(bindings: readonly CandidateNominationQualificationBindingV1[]) {
      const current = currentBinding();
      const qualifiedByProposal = new Map(current.nominationQualificationSet.entries.map(entry => [
        entry.proposalLeafDigest,
        entry.qualificationLeafDigest,
      ]));
      if (bindings.length !== qualifiedByProposal.size) {
        throw new TypeError("candidate partition fixture nomination qualification set is incomplete");
      }
      const seen = new Set<Hash>();
      for (const value of bindings) {
        if (seen.has(value.nominationProgramProposalLeafDigest)) {
          throw new TypeError("candidate partition fixture nomination qualification set has duplicates");
        }
        seen.add(value.nominationProgramProposalLeafDigest);
        if (qualifiedByProposal.get(value.nominationProgramProposalLeafDigest) !== value.qualificationLeafDigest) {
          throw new TypeError("candidate partition fixture nomination qualification is not externally signed");
        }
      }
      if (qualifiedBindings !== undefined
        && JSON.stringify(bindings) !== JSON.stringify(qualifiedBindings)) {
        throw new TypeError("candidate partition fixture nomination qualification binding mismatch");
      }
    },
    issue(payload: CandidatePartitionProofPayloadV1) {
      const payloadHash = candidatePartitionProofPayloadHash(payload);
      const proofId = candidatePartitionProofId(payloadHash);
      const proof = {
        ...payload,
        proofId,
        payloadHash,
        signatureAlgorithm: "ed25519" as const,
        signerKeyId: payload.issuerKeyId,
      };
      return decodeCandidatePartitionProofV1({
        ...proof,
        signatureHex: signHex(candidatePartitionProofSigningBytes(payload, payload.issuerKeyId)),
      });
    },
    verify(value: unknown, context: CandidatePartitionProofVerificationContextV1) {
      const current = currentBinding();
      const currentRelease = release();
      if (context.release.releaseProvenanceHash !== currentRelease.releaseProvenanceHash) throw new TypeError("candidate partition fixture release binding rotated");
      const proof = validateCandidatePartitionProof(value, context);
      if (proof.signerKeyId !== current.candidatePartitionProofIssuerKeyId) {
        throw new TypeError("candidate partition fixture issuer key mismatch");
      }
      verifyHex(candidatePartitionProofSigningBytes(proof), proof.signatureHex);
      return proof;
    },
  }));
}

/**
 * Test-only capability issuance for narrow non-SQLite consumers such as the
 * GenerationBuilder unit.  The returned handle is produced by the same
 * checkpoint-owned registry and a real Ed25519 proof issuer used by the
 * SQLite tests; callers cannot replace it with a shape-compatible object.
 */
export function issueCandidatePartitionCapabilityFixture(input: {
  readonly binding: RuntimeReleaseBindingV1;
  readonly candidates: readonly CandidateRecordV1[];
  readonly cutoff: CanonicalCutoffV1;
  readonly runId?: string;
  readonly checkpointRevision?: string;
}): {
  readonly issuer: CandidatePartitionProofIssuerPortV1;
  readonly registry: CandidatePartitionCapabilityRegistryV1;
  readonly capability: CandidatePartitionCapabilityV1;
  readonly reader: CandidatePartitionReaderPortV1;
  readonly binding: CandidatePartitionBindingV1;
} {
  const runId = input.runId ?? "run-a";
  const checkpointRevision = input.checkpointRevision ?? "1";
  const issuer = createCandidatePartitionProofIssuerFixture(input.binding);
  const registry = new CandidatePartitionCapabilityRegistryV1();
  const payload = makeCandidatePartitionProofPayload({
    runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: candidatePartitionRoot(input.candidates),
    candidatePartitionStorageHash: hashDomain("test/candidate-partition-storage", `${runId}:${checkpointRevision}`),
    nominationClosureRoot: hashDomain("test/nomination-closure", `${runId}:${checkpointRevision}`),
    nominationClosureStorageHash: hashDomain("test/nomination-closure-storage", `${runId}:${checkpointRevision}`),
    candidates: input.candidates,
    recentObservationRoot: hashDomain("test/candidate-partition-observation", `${runId}:${checkpointRevision}`),
    sourceCoverageRoot: hashDomain("test/candidate-partition-coverage", `${runId}:${checkpointRevision}`),
    checkpointRevision,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(input.binding),
    issuerKeyId: input.binding.candidatePartitionProofIssuerKeyId,
  });
  const issuedProof = issuer.issue(payload);
  const proof = issuer.verify(issuedProof, {
    binding: candidatePartitionBindingFromProof(issuedProof),
    release: {
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(input.binding),
      releaseAuthorityRoot: input.binding.releaseAuthorityRoot,
      candidatePartitionProofIssuerKeyId: input.binding.candidatePartitionProofIssuerKeyId,
    },
  });
  const capability = registry.registerVerifiedProof(proof, input.candidates);
  return Object.freeze({
    issuer,
    registry,
    capability,
    reader: registry.reader,
    binding: candidatePartitionBindingFromProof(proof),
  });
}
