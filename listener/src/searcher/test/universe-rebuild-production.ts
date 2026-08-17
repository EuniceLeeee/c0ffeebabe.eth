import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  attestationPoolFromCandidate,
  canReuseMemo,
  candidateFingerprint,
  candidateFromLog,
  candidatesFromLog,
  createProbeWiring,
  createRebuildWiring,
  familyDefinitionHash,
  fullLogIdentityKey,
  isChainProvenTerminalReason,
  memoAuthorityFingerprint,
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
    blockHash: "0x" + "44".repeat(32),
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
  const authorityFingerprint = authorityFor(candidate);
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
      authorityFingerprint,
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

function authorityFor(
  candidate: Readonly<Record<string, unknown>>,
): string {
  return memoAuthorityFingerprint({
    familyId: String(candidate.familyId ?? "unknown-family"),
    address: String(candidate.address),
    code: "0x6000",
    implementationWord: "0x" + "00".repeat(32),
  });
}

async function main(): Promise<void> {
  // Full log identity: two pools in one transaction never collapse.
  const a = log({ address: "0x" + "11".repeat(20), logIndex: 0 });
  const b = log({ address: "0x" + "44".repeat(20), logIndex: 1 });
  assert.notEqual(fullLogIdentityKey(a), fullLogIdentityKey(b));
  assert.equal(
    fullLogIdentityKey(a),
    "log:25750000:0x" + "44".repeat(32) + ":0x" + "33".repeat(32) +
      ":0:0x" + "11".repeat(20) + ":" +
      SWAP_TOPIC + ",0x" + "22".repeat(32),
    "full log identity includes every topic",
  );
  assert.notEqual(
    fullLogIdentityKey(a),
    fullLogIdentityKey(log({ blockHash: "0x" + "99".repeat(32) })),
    "full log identity binds the canonical block hash",
  );

  // Central code must not guess that topic1 is a poolId. For an ordinary
  // Swap it is a different indexed field; plugin decode owns identity.
  const indexedSwap = log({
    address: "0x000000000004444c5dc75cB358380D2e3dE08A90".toLowerCase(),
    topics: Object.freeze([SWAP_TOPIC, "0x" + "55".repeat(32)]),
  });
  const indexedCandidate = candidateFromLog(indexedSwap);
  assert.equal(indexedCandidate.poolId, undefined);
  const v4Swap = log({
    address: "0x000000000004444c5dc75cB358380D2e3dE08A90".toLowerCase(),
    topics: Object.freeze([
      ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
        .toLowerCase(),
      "0x" + "55".repeat(32),
    ]),
  });
  assert.equal(
    candidatesFromLog(v4Swap).length,
    0,
    "mutation-only V4 Swap cannot nominate a partial PoolKey",
  );

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
    canReuseMemo({
      memo: makeMemo(candidate),
      candidate,
      cutoff: SOURCE,
      familyId,
      currentAuthorityFingerprint: authorityFor(candidate),
    }),
    true,
  );
  assert.equal(
    canReuseMemo({
      memo: makeMemo(candidate, { familyId: "univ3-standard" }),
      candidate,
      cutoff: SOURCE,
      familyId,
      currentAuthorityFingerprint: authorityFor(candidate),
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
      currentAuthorityFingerprint: authorityFor(candidate),
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
      currentAuthorityFingerprint: authorityFor(candidate),
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
      currentAuthorityFingerprint: authorityFor(candidate),
    }),
    false,
    "dependency-proof policy is not reusable without re-verification",
  );
  assert.equal(
    canReuseMemo({
      memo: makeMemo(candidate, {
        validity: Object.freeze({
          policy: "immutable-code",
          authorityFingerprint: authorityFor(candidate),
          proofSource: Object.freeze({
            number: SOURCE.number - 1,
            hash: "0x" + "b2".repeat(32),
          }),
        }),
      }),
      candidate,
      cutoff: SOURCE,
      familyId,
      currentAuthorityFingerprint: authorityFor(candidate),
    }),
    true,
    "older immutable proof is reusable only after production rechecks its hash",
  );
  assert.equal(
    canReuseMemo({
      memo: makeMemo(candidate, {
        validity: Object.freeze({
          policy: "immutable-code",
          authorityFingerprint: "wrong-authority",
          proofSource: Object.freeze({
            number: SOURCE.number,
            hash: SOURCE.hash,
          }),
        }),
      }),
      candidate,
      cutoff: SOURCE,
      familyId,
      currentAuthorityFingerprint: authorityFor(candidate),
    }),
    false,
    "authority fingerprint mismatch invalidates reuse",
  );
  assert.notEqual(
    authorityFor(candidate),
    memoAuthorityFingerprint({
      familyId,
      address: String(candidate.address),
      code: "0x6001",
      implementationWord: "0x" + "00".repeat(32),
    }),
    "runtime code changes invalidate a durable memo",
  );
  assert.notEqual(
    authorityFor(candidate),
    memoAuthorityFingerprint({
      familyId,
      address: String(candidate.address),
      code: "0x6000",
      implementationWord: "0x" + "01".repeat(32),
    }),
    "proxy implementation changes invalidate a durable memo",
  );
  assert.equal(isChainProvenTerminalReason("no deployed code"), true);
  assert.equal(isChainProvenTerminalReason("identity_rejected:bad_factory"), true);
  assert.equal(
    isChainProvenTerminalReason("missing response (requestBody=...)") ,
    false,
    "unknown transport failures stay retryable, never become rejection proof",
  );

  // Candidate dedupe is per pool, not per log: hundreds of Swap logs of
  // one pool in the window collapse to a single candidate carrying the
  // newest log as its evidence; a second pool stays a second candidate.
  const wiring = createRebuildWiring({
    rpcUrl: "http://127.0.0.1:1",
  });
  const richCandidate = Object.freeze({
    address: "0x" + "88".repeat(20),
    adapter: "univ4",
    familyId: "univ4-standard",
    pluginCandidateKey: "manager:pool-id",
    amountIn: 123n,
    poolKey: Object.freeze({
      currency0: "0x" + "11".repeat(20),
      currency1: "0x" + "22".repeat(20),
      fee: 3_000,
      tickSpacing: 60,
      hooks: "0x" + "00".repeat(20),
    }),
  });
  const encodedRichCandidate = wiring.encodeCandidateSnapshot!(richCandidate);
  assert.doesNotThrow(
    () => JSON.stringify(encodedRichCandidate),
    "durable candidate partitions must encode bigint/plugin fields",
  );
  assert.deepEqual(
    wiring.decodeCandidateSnapshot!(encodedRichCandidate),
    richCandidate,
    "resume/probe must restore the complete plugin-owned candidate",
  );
  assert.deepEqual(
    attestationPoolFromCandidate(richCandidate).poolKey,
    richCandidate.poolKey,
    "strict attestation must not drop event-dependent Family payload",
  );
  assert.equal(
    attestationPoolFromCandidate(richCandidate).amountIn,
    123n,
  );

  // The production memo sealer and reuse predicate must share one candidate
  // fingerprint algorithm. This exercises the actual production sealer; a
  // hand-built memo can otherwise make both unit helpers look green while
  // every real restart misses the cache.
  const probeWiring = createProbeWiring({ rpcUrl: "http://127.0.0.1:1" });
  const sealed = probeWiring.sealDurableVerifiedMemo({
    candidate,
    result: Object.freeze({
      accepted: Object.freeze({
        familyId,
        lineageId: familyId,
        subject: String(candidate.address),
      }),
      authorityFingerprint: authorityFor(candidate),
      instance: Object.freeze({
        instanceKey: "canonical-instance",
        descriptor: Object.freeze({}),
        routes: Object.freeze([]),
        pricingInstances: Object.freeze([]),
        evidenceRefs: Object.freeze([]),
      }),
    }),
    proofSource: SOURCE,
    familyCandidateKey: rebuildFamilyCandidateKey(candidate),
  });
  assert.equal(sealed.candidateFingerprint, candidateFingerprint(candidate));
  assert.equal(
    canReuseMemo({
      memo: sealed,
      candidate,
      cutoff: SOURCE,
      familyId,
      currentAuthorityFingerprint: authorityFor(candidate),
    }),
    true,
    "a production-sealed immutable memo must be reusable on restart",
  );
  const aliasSealed = probeWiring.sealDurableVerifiedMemo({
    candidate: Object.freeze({
      ...candidate,
      pluginCandidateKey: "alias-candidate-key",
    }),
    result: Object.freeze({
      accepted: Object.freeze({
        familyId,
        lineageId: familyId,
        subject: String(candidate.address),
      }),
      authorityFingerprint: authorityFor(candidate),
      instance: Object.freeze({
        instanceKey: "canonical-instance",
        descriptor: Object.freeze({}),
        routes: Object.freeze([]),
        pricingInstances: Object.freeze([]),
        evidenceRefs: Object.freeze([]),
      }),
    }),
    proofSource: SOURCE,
    familyCandidateKey: "alias",
  });
  assert.equal(
    aliasSealed.familyInstanceKey,
    sealed.familyInstanceKey,
    "FamilyInstanceKey must derive from verified instanceKey, not nomination alias",
  );
  const poolALogs = Object.freeze([
    log({ blockNumber: SOURCE.number - 100, logIndex: 1 }),
    log({ blockNumber: SOURCE.number - 50, logIndex: 2 }),
    log({ blockNumber: SOURCE.number, logIndex: 3 }),
  ]);
  const poolBLog = log({
    address: "0x" + "66".repeat(20),
    topics: Object.freeze([SWAP_TOPIC, "0x" + "77".repeat(32)]),
    logIndex: 0,
  });
  const deduped = wiring.dedupeFamilyCandidates(
    Object.freeze([...poolALogs, poolBLog]),
  );
  assert.equal(deduped.length, 2, "one candidate per pool, never per log");
  const poolACandidate = deduped.find((candidate) =>
    (candidate as { address: string }).address === "0x" + "11".repeat(20)
  );
  assert.equal(
    (poolACandidate as { logIndex?: number }).logIndex,
    3,
    "the newest log is the representative evidence",
  );
  assert.equal(
    (poolACandidate as { blockNumber?: number }).blockNumber,
    SOURCE.number,
  );

  // Shared-address startup candidates remain distinct by plugin-owned
  // poolId and never collapse to the manager address.
  const manager = "0x000000000004444c5dc75cB358380D2e3dE08A90".toLowerCase();
  const seeded = wiring.dedupeFamilyCandidates(Object.freeze([
    Object.freeze({
      kind: "startup-candidate",
      candidate: Object.freeze({
        address: manager,
        adapter: "univ4",
        familyId: "univ4-standard",
        poolId: "0x" + "55".repeat(32),
      }),
    }),
    Object.freeze({
      kind: "startup-candidate",
      candidate: Object.freeze({
        address: manager,
        adapter: "univ4",
        familyId: "univ4-standard",
        poolId: "0x" + "66".repeat(32),
      }),
    }),
  ]));
  assert.equal(seeded.length, 2, "V4 candidates dedupe by Family+poolId");
  const duplicatePoolSetCandidate = Object.freeze({
    address: "0x" + "88".repeat(20),
    adapter: "univ2",
    familyId: "univ2-standard",
  });
  assert.equal(
    wiring.dedupeFamilyCandidates(Object.freeze(Array.from(
      { length: 4 },
      () => Object.freeze({
        kind: "startup-candidate",
        candidate: duplicatePoolSetCandidate,
      }),
    ))).length,
    1,
    "pinned/universe/blockscan/override copies attest once",
  );
  const coverage = wiring.buildCoverage({
    observations: Object.freeze([]),
    candidates: Object.freeze([]),
    cutoff: SOURCE,
  });
  assert(coverage.some((row) =>
    row.familyId === "univ2-standard" &&
    row.sourceId === "startup-universe"
  ));
  assert(coverage.some((row) =>
    row.familyId === "univ2-standard" &&
    row.sourceId === "event:univ2-pair-created"
  ));
  assert(coverage.every((row) =>
    row.completeThroughBlock === SOURCE.number &&
    row.completeThroughHash === SOURCE.hash
  ));

  console.log("universe rebuild production wiring PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
