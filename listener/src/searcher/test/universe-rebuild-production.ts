import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  canReuseMemo,
  candidateFingerprint,
  candidateFromLog,
  familyDefinitionHash,
  fullLogIdentityKey,
  rebuildFamilyCandidateKey,
  type RebuildScanObservation,
} from "../universe-rebuild-production.js";
import type { DurableVerifiedMemo } from "../universe-rebuild-checkpoint.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});
const SWAP_TOPIC = ethers.id(
  "Swap(address,uint256,uint256,uint256,uint256,address)",
).toLowerCase();

function log(overrides: Partial<RebuildScanObservation>): RebuildScanObservation {
  return Object.freeze({
    address: "0x" + "11".repeat(20),
    topics: Object.freeze([SWAP_TOPIC, "0x" + "22".repeat(32)]),
    data: "0x",
    transactionHash: "0x" + "33".repeat(32),
    blockNumber: 25_750_000,
    logIndex: 0,
    ...overrides,
  });
}

function makeMemo(
  candidate: Readonly<Record<string, unknown>>,
  overrides?: Partial<DurableVerifiedMemo>,
): DurableVerifiedMemo {
  const familyId = String(candidate.familyId ?? "unknown-family");
  const fp = candidateFingerprint(candidate);
  const fdh = familyDefinitionHash(familyId);
  const base = Object.freeze({
    familyCandidateKey: "k",
    familyInstanceKey: "inst",
    familyId,
    candidateKey: "c",
    instanceKey: "inst",
    candidateFingerprint: fp,
    familyDefinitionHash: fdh,
    validity: Object.freeze({
      policy: "immutable-code",
      authorityFingerprint: fdh,
      proofSource: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    }),
    verifiedIdentity: Object.freeze({}),
    compiledDescriptor: Object.freeze({}),
    staticProjection: Object.freeze({}),
    evidenceFingerprint: "ef",
    memoFingerprint: "mf",
  });
  return Object.freeze({ ...base, ...overrides }) as DurableVerifiedMemo;
}

async function main(): Promise<void> {
  // Full log identity: two pools in one transaction never collapse.
  const a = log({ address: "0x" + "11".repeat(20), logIndex: 0 });
  const b = log({ address: "0x" + "44".repeat(20), logIndex: 1 });
  assert.notEqual(fullLogIdentityKey(a), fullLogIdentityKey(b));
  assert.equal(
    fullLogIdentityKey(a),
    "log:25750000:0x" + "33".repeat(32) + ":0:0x" + "11".repeat(20) + ":" +
      SWAP_TOPIC + ",0x" + "22".repeat(32),
    "full log identity includes every topic",
  );

  // Candidate from a V4-style log: poolId extracted from topic1.
  const v4Log = log({
    address: "0x000000000004444c5dc75cB358380D2e3dE08A90".toLowerCase(),
    topics: Object.freeze([SWAP_TOPIC, "0x" + "55".repeat(32)]),
  });
  const v4Candidate = candidateFromLog(v4Log);
  assert.equal(v4Candidate.poolId, "0x" + "55".repeat(32));
  assert.equal(v4Candidate.address, "0x000000000004444c5dc75cB358380D2e3dE08A90".toLowerCase());

  // Candidate fingerprint is stable and excludes dynamic fields.
  assert.equal(
    candidateFingerprint(candidateFromLog(a)),
    candidateFingerprint(candidateFromLog(log({ transactionHash: undefined }))),
    "fingerprint excludes txHash/block/logIndex",
  );
  assert.notEqual(
    candidateFingerprint(candidateFromLog(a)),
    candidateFingerprint(candidateFromLog(b)),
  );

  // Rebuild family candidate key.
  const key = rebuildFamilyCandidateKey(candidateFromLog(a));
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(
    rebuildFamilyCandidateKey(candidateFromLog(a)),
    rebuildFamilyCandidateKey(candidateFromLog(log({ logIndex: 7 }))),
    "candidate key is log-position independent",
  );

  // Memo reuse rules (audit §8).
  const candidate = candidateFromLog(a);
  const familyId = String(candidate.familyId ?? "");
  assert.equal(
    canReuseMemo({ memo: makeMemo(candidate), candidate, cutoff: SOURCE, familyId }),
    true,
  );
  assert.equal(
    canReuseMemo({
      memo: makeMemo(candidate, { familyId: "univ3-standard" }),
      candidate,
      cutoff: SOURCE,
      familyId,
    }),
    false,
    "family mismatch must invalidate",
  );
  assert.equal(
    canReuseMemo({
      memo: makeMemo(candidate, { candidateFingerprint: "other" }),
      candidate,
      cutoff: SOURCE,
      familyId,
    }),
    false,
    "candidate fingerprint mismatch must invalidate",
  );
  assert.equal(
    canReuseMemo({
      memo: makeMemo(candidate, { familyDefinitionHash: "other" }),
      candidate,
      cutoff: SOURCE,
      familyId,
    }),
    false,
    "family definition hash mismatch must invalidate",
  );
  assert.equal(
    canReuseMemo({
      memo: makeMemo(candidate, {
        validity: Object.freeze({
          policy: "dependency-proof",
          authorityFingerprint: "fdh",
          proofSource: Object.freeze({
            number: SOURCE.number,
            hash: SOURCE.hash,
          }),
        }),
      }),
      candidate,
      cutoff: SOURCE,
      familyId,
    }),
    false,
    "dependency-proof policy is not reusable without re-verification",
  );
  assert.equal(
    canReuseMemo({
      memo: makeMemo(candidate, {
        validity: Object.freeze({
          policy: "immutable-code",
          authorityFingerprint: "fdh",
          proofSource: Object.freeze({
            number: SOURCE.number - 1,
            hash: "0x" + "b2".repeat(32),
          }),
        }),
      }),
      candidate,
      cutoff: SOURCE,
      familyId,
    }),
    false,
    "stale proof source must invalidate",
  );

  console.log("universe rebuild production wiring PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
