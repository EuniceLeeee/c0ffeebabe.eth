import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import {
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_SWAP_TOPIC,
} from "../venues/swaps/univ4-abi.js";
import { ADDR } from "../../shared/constants/addresses.js";
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
  rebuildFamilyInstanceDedupeKey,
  upgradeLegacyVerifiedMemo,
  validateObservedSenderEvidence,
  type RebuildScanObservation,
} from "../universe-rebuild-production.js";
import type {
  DurableSourceReceipt,
  DurableVerifiedMemo,
  LegacyDurableVerifiedMemo,
} from "../universe-rebuild-checkpoint.js";
import { durableVerifiedMemoFingerprint } from
  "../universe-rebuild-checkpoint.js";
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
const ERC20_BALANCE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

class TestSealedReadonlyMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: ReadonlyMap<Key, Value>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: Key): Value | undefined { return this.#values.get(key); }
  has(key: Key): boolean { return this.#values.has(key); }
  entries(): MapIterator<[Key, Value]> { return this.#values.entries(); }
  keys(): MapIterator<Key> { return this.#values.keys(); }
  values(): MapIterator<Value> { return this.#values.values(); }
  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[Key, Value]> { return this.entries(); }
  get [Symbol.toStringTag](): string { return "SealedReadonlyMap"; }
}

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
    candidateSnapshot: candidate,
    memoFingerprint: "",
  });
  const unsigned = Object.freeze({
    ...base,
    ...overrides,
    memoFingerprint: "",
  }) as DurableVerifiedMemo;
  return Object.freeze({
    ...unsigned,
    memoFingerprint: durableVerifiedMemoFingerprint(unsigned),
  });
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

function rpcBlockFixture(number: number, hash: string): object {
  const zeroHash = "0x" + "00".repeat(32);
  return {
    number: "0x" + number.toString(16),
    hash,
    parentHash: zeroHash,
    nonce: "0x0000000000000000",
    sha3Uncles: zeroHash,
    logsBloom: "0x" + "00".repeat(256),
    transactionsRoot: zeroHash,
    stateRoot: zeroHash,
    receiptsRoot: zeroHash,
    miner: "0x" + "00".repeat(20),
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x1",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: "0x1",
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x1",
    mixHash: zeroHash,
    withdrawals: [],
    blobGasUsed: "0x0",
    excessBlobGas: "0x0",
  };
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

  // Observed-sender authority is recovered only from the exact canonical
  // transaction/log and a catalog-plugin re-decode of that same log. The
  // executor is intentionally absent from this contract.
  const observedActor = "0x" + "ab".repeat(20);
  const observedCandidate = Object.freeze({
    address: a.address,
    actor: observedActor,
    familyId: "protocol:test-observed",
    pluginCandidateKey: "observed:key",
    blockNumber: a.blockNumber,
    blockHash: a.blockHash,
    transactionHash: a.transactionHash,
    logIndex: a.logIndex,
  });
  const evidenceRef = Object.freeze({
    blockNumber: a.blockNumber!,
    blockHash: a.blockHash!,
    txHash: a.transactionHash!,
    logIndex: a.logIndex!,
  });
  const observedReceipt = Object.freeze({
    blockNumber: a.blockNumber!,
    blockHash: a.blockHash!,
    logs: Object.freeze([Object.freeze({
      index: a.logIndex!,
      address: a.address,
      topics: a.topics,
      data: a.data,
      transactionHash: a.transactionHash!,
    })]),
  });
  assert.equal(validateObservedSenderEvidence({
    candidate: observedCandidate,
    evidenceRef,
    canonicalBlockHash: a.blockHash!,
    transaction: Object.freeze({
      hash: a.transactionHash!,
      blockNumber: a.blockNumber!,
      blockHash: a.blockHash!,
    }),
    receipt: observedReceipt,
    redecodedCandidates: Object.freeze([observedCandidate]),
  }), observedActor);
  assert.throws(() => validateObservedSenderEvidence({
    candidate: observedCandidate,
    evidenceRef,
    canonicalBlockHash: a.blockHash!,
    transaction: Object.freeze({
      hash: a.transactionHash!,
      blockNumber: a.blockNumber!,
      blockHash: a.blockHash!,
    }),
    receipt: observedReceipt,
    redecodedCandidates: Object.freeze([Object.freeze({
      ...observedCandidate,
      actor: "0x" + "cd".repeat(20),
    })]),
  }), /plugin re-decode mismatch/);

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
  const candidateWithOptionalUndefined = Object.freeze({
    ...richCandidate,
    optionalFactory: undefined,
    nested: Object.freeze({
      retained: "identity",
      optionalHint: undefined,
    }),
  });
  const encodedOptional = wiring.encodeCandidateSnapshot!(
    candidateWithOptionalUndefined,
  );
  assert.deepEqual(
    wiring.decodeCandidateSnapshot!(encodedOptional),
    Object.freeze({
      ...richCandidate,
      nested: Object.freeze({ retained: "identity" }),
    }),
    "durable object snapshots omit optional undefined fields recursively",
  );
  assert.throws(
    () => wiring.encodeCandidateSnapshot!(["stable", undefined]),
    /unsupported durable value type: undefined/,
    "undefined array positions remain ambiguous and fail closed",
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
  const mids = new TestSealedReadonlyMap(new Map([
    ["route:0", 1_000_000n],
  ]));
  const unavailable = new TestSealedReadonlyMap(new Map([
    ["route:1", "no-static-mid"],
  ]));
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
        descriptor: Object.freeze({
          pool: String(candidate.address),
          lineageId: familyId,
        }),
        routes: Object.freeze([]),
        pricingInstances: Object.freeze([Object.freeze({
          routes: Object.freeze([]),
          mids,
          unavailable,
        })]),
        evidenceRefs: Object.freeze([]),
      }),
    }),
    proofSource: SOURCE,
    familyCandidateKey: rebuildFamilyCandidateKey(candidate),
  });
  assert.equal(sealed.candidateFingerprint, candidateFingerprint(candidate));
  const {
    candidateSnapshot: _candidateSnapshot,
    memoFingerprint: _memoFingerprint,
    ...legacyFields
  } = sealed;
  const legacyUnsigned = Object.freeze({
    ...legacyFields,
    memoFingerprint: "",
  }) as LegacyDurableVerifiedMemo;
  const legacyMemo = Object.freeze({
    ...legacyUnsigned,
    memoFingerprint: durableVerifiedMemoFingerprint(legacyUnsigned),
  });
  const upgradedLegacyMemo = upgradeLegacyVerifiedMemo(legacyMemo);
  const upgradedLegacyCandidate = wiring.decodeCandidateSnapshot!(
    upgradedLegacyMemo.candidateSnapshot,
  ) as Readonly<Record<string, unknown>>;
  assert.equal(
    rebuildFamilyCandidateKey(upgradedLegacyCandidate),
    legacyMemo.familyCandidateKey,
    "legacy memo upgrade reconstructs the exact durable candidate key",
  );
  assert.equal(
    candidateFingerprint(upgradedLegacyCandidate),
    legacyMemo.candidateFingerprint,
    "legacy memo upgrade reconstructs the exact original candidate fingerprint",
  );
  assert.equal(
    upgradedLegacyMemo.memoFingerprint,
    durableVerifiedMemoFingerprint(upgradedLegacyMemo),
    "upgraded memo fingerprint binds its candidate snapshot",
  );
  assert.notEqual(
    upgradedLegacyMemo.memoFingerprint,
    legacyMemo.memoFingerprint,
  );
  assert.throws(
    () => upgradeLegacyVerifiedMemo(Object.freeze({
      ...legacyMemo,
      memoFingerprint: "0".repeat(64),
    })),
    /verified memo fingerprint mismatch/,
    "legacy memo migration fails closed before candidate reconstruction",
  );
  const decodedProjection = wiring.decodeCandidateSnapshot!(
    sealed.staticProjection,
  ) as {
    readonly pricingInstances: readonly {
      readonly mids: ReadonlyMap<string, bigint>;
      readonly unavailable: ReadonlyMap<string, string>;
    }[];
  };
  assert.equal(decodedProjection.pricingInstances[0]?.mids.get("route:0"), 1_000_000n);
  assert.equal(
    decodedProjection.pricingInstances[0]?.unavailable.get("route:1"),
    "no-static-mid",
    "production SealedReadonlyMap pricing state round-trips as a durable Map",
  );
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
  const sameRunCandidateKey = rebuildFamilyCandidateKey(candidate);
  const sameRunMemo = await wiring.findReusableMemo({
    candidate,
    cutoff: SOURCE,
    checkpoint: Object.freeze({
      revision: 2,
      verifiedMemos: Object.freeze({ [sameRunCandidateKey]: sealed }),
      inProgressRun: Object.freeze({
        cutoff: SOURCE,
        outcomesByCandidateKey: Object.freeze({
          [sameRunCandidateKey]: Object.freeze({
            status: "verified",
            familyCandidateKey: sameRunCandidateKey,
            familyInstanceKey: sealed.familyInstanceKey,
            memoFingerprint: sealed.memoFingerprint,
          }),
        }),
      }),
      readyGeneration: null,
      checkpointFingerprint: "f".repeat(64),
    }) as never,
  });
  assert.equal(
    sameRunMemo,
    sealed,
    "same fixed run reuses its sealed memo without per-instance authority RPC",
  );
  const sameProofSourceMemo = await wiring.findReusableMemo({
    candidate,
    cutoff: SOURCE,
    checkpoint: Object.freeze({
      revision: 3,
      verifiedMemos: Object.freeze({ [sameRunCandidateKey]: sealed }),
      retryableAttemptsByCandidateKey: Object.freeze({}),
      inProgressRun: null,
      readyGeneration: null,
      checkpointFingerprint: "f".repeat(64),
    }) as never,
  });
  assert.equal(
    sameProofSourceMemo,
    sealed,
    "a completed run reuses a memo sealed at the identical cutoff without RPC",
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
  const sharedPoolId = "0x" + "77".repeat(32);
  const retainedAlias = Object.freeze({
    address: manager,
    adapter: "univ4",
    familyId: "univ4-standard",
    poolId: sharedPoolId,
  });
  const eventAlias = Object.freeze({
    ...retainedAlias,
    pluginCandidateKey: manager + "\u001f" + sharedPoolId,
    transactionHash: "0x" + "91".repeat(32),
    blockNumber: SOURCE.number,
    blockHash: SOURCE.hash,
    logIndex: 7,
  });
  assert.notEqual(
    rebuildFamilyCandidateKey(retainedAlias),
    rebuildFamilyCandidateKey(eventAlias),
    "legacy retained/event nomination spellings are distinct durable keys",
  );
  assert.equal(
    rebuildFamilyInstanceDedupeKey(retainedAlias),
    rebuildFamilyInstanceDedupeKey(eventAlias),
    "Family+address+poolId must collapse the retained/event alias",
  );
  const aliases = wiring.dedupeFamilyCandidates(Object.freeze([
    Object.freeze({ kind: "startup-candidate", candidate: retainedAlias }),
    Object.freeze({ kind: "startup-candidate", candidate: eventAlias }),
  ]));
  assert.equal(aliases.length, 1, "one Family instance enters the run once");
  assert.equal(
    (aliases[0] as { pluginCandidateKey?: string }).pluginCandidateKey,
    eventAlias.pluginCandidateKey,
    "the exact source-bound event candidate is the representative",
  );
  const reversedAliases = wiring.dedupeFamilyCandidates(Object.freeze([
    Object.freeze({ kind: "startup-candidate", candidate: eventAlias }),
    Object.freeze({ kind: "startup-candidate", candidate: retainedAlias }),
  ]));
  assert.equal(
    (reversedAliases[0] as { pluginCandidateKey?: string }).pluginCandidateKey,
    eventAlias.pluginCandidateKey,
    "alias representative selection must not depend on pool-set order",
  );
  const siblingManager = Object.freeze({
    ...retainedAlias,
    address: "0x" + "99".repeat(20),
  });
  assert.notEqual(
    rebuildFamilyInstanceDedupeKey(retainedAlias),
    rebuildFamilyInstanceDedupeKey(siblingManager),
    "same poolId behind different managers remains a distinct instance",
  );
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
  const coverageReceipt: DurableSourceReceipt = Object.freeze({
    sourceKey: "1".repeat(64),
    sourceKind: "catalog-event-union",
    providerIdentity: "fixture",
    queryFingerprint: "2".repeat(64),
    fromBlock: SOURCE.number - 14_399,
    toBlock: SOURCE.number,
    cutoffNumber: SOURCE.number,
    cutoffHash: SOURCE.hash,
    coverageKeys: wiring.requiredSourceCoverageKeys(),
    completedChunks: Object.freeze([Object.freeze({
      fromBlock: SOURCE.number - 14_399,
      toBlock: SOURCE.number,
      resultCount: 0,
      resultHash: "3".repeat(64),
    })]),
    observationSetHash: "4".repeat(64),
    observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    retryableCount: 0,
    status: "complete",
  });
  const coverage = wiring.buildCoverage({
    sourceReceipts: Object.freeze([coverageReceipt]),
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

  // Retain-channel driver: a univ4 Swap log (poolId only, no PoolKey) must
  // reach the Family's declared reverseBinding through generic
  // plugin-declared semantics (logPattern emitter singleton-indexed-bytes32 +
  // topicIndex), and the verified observation must re-admit as a complete
  // candidate. No protocol names live in the central wiring: the swap topic,
  // manager address and PositionManager lookup all come from the plugin.
  const currency0 = "0x" + "11".repeat(20);
  const currency1 = "0x" + "22".repeat(20);
  const fee = 3000;
  const tickSpacing = 60;
  const hooks = "0x" + "00".repeat(20);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(abiCoder.encode(
    ["address", "address", "uint24", "int24", "address"],
    [currency0, currency1, fee, tickSpacing, hooks],
  ));
  const encodedPoolKey = abiCoder.encode(
    ["address", "address", "uint24", "int24", "address"],
    [currency0, currency1, fee, tickSpacing, hooks],
  );
  const v4Manager = ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase();
  // A second pool: the PositionManager stub resolves only pool 1, so pool 2
  // must recover its PoolKey from the exact transaction that emitted its
  // nomination log. This exercises the per-nomination admission without any
  // historical Initialize backscan.
  const currency0b = "0x" + "33".repeat(20);
  const currency1b = "0x" + "44".repeat(20);
  const fee2 = 500;
  const tickSpacing2 = 10;
  const poolId2 = ethers.keccak256(abiCoder.encode(
    ["address", "address", "uint24", "int24", "address"],
    [currency0b, currency1b, fee2, tickSpacing2, hooks],
  ));
  const swapInput = (
    key: Readonly<{
      readonly currency0: string;
      readonly currency1: string;
      readonly fee: number;
      readonly tickSpacing: number;
      readonly hooks: string;
    }>,
  ): string => UNIV4_POOL_MANAGER_INTERFACE.encodeFunctionData("swap", [
    key,
    Object.freeze({
      zeroForOne: true,
      amountSpecified: -1_000n,
      sqrtPriceLimitX96: 4_295_128_740n,
    }),
    "0x",
  ]);
  const pool1SwapInput = swapInput(Object.freeze({
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
  }));
  const pool2SwapInput = swapInput(Object.freeze({
    currency0: currency0b,
    currency1: currency1b,
    fee: fee2,
    tickSpacing: tickSpacing2,
    hooks,
  }));
  const pool1Tx = "0x" + "99".repeat(32);
  const pool2Tx = "0x" + "9a".repeat(32);
  const traceSender = "0x" + "ab".repeat(20);
  let pmResolvesPool1 = true;
  let traceAvailable = true;
  let traceReads = 0;
  let positionManagerReads = 0;
  const tracedTransactions: string[] = [];
  let historicalLogReads = 0;
  let fundingBalance = 1_000_000n;
  const memoProofHash = "0x" + "b2".repeat(32);
  let memoProofHashReads = 0;
  const stubServer = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      // ethers v6 batches independent calls into one request body array.
      const parsed = JSON.parse(body) as
        | {
          readonly id: number;
          readonly method: string;
          readonly params?: readonly unknown[];
        }
        | readonly {
          readonly id: number;
          readonly method: string;
          readonly params?: readonly unknown[];
        }[];
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      const results = batch.map((rpcRequest) => {
        const respond = (result: unknown) => Object.freeze({
          jsonrpc: "2.0",
          id: rpcRequest.id,
          result,
        });
        switch (rpcRequest.method) {
          case "eth_chainId":
            return respond("0x1");
          case "eth_blockNumber":
            return respond("0x" + SOURCE.number.toString(16));
          case "eth_getCode":
            // Any deployed code satisfies the manager-code gate.
            return respond("0x6000");
          case "eth_getStorageAt":
            return respond("0x" + "00".repeat(32));
          case "eth_getBlockByNumber": {
            const number = Number(BigInt(String(rpcRequest.params?.[0])));
            if (number === SOURCE.number - 1) memoProofHashReads += 1;
            return respond(rpcBlockFixture(
              number,
              number === SOURCE.number - 1 ? memoProofHash : SOURCE.hash,
            ));
          }
          case "eth_call": {
            const transaction = rpcRequest.params?.[0] as
              | { readonly to?: string; readonly data?: string }
              | undefined;
            const data = transaction?.data ?? "0x";
            if (
              data.slice(0, 10).toLowerCase() ===
                ERC20_BALANCE.getFunction("balanceOf")!.selector.toLowerCase()
            ) {
              return respond(ERC20_BALANCE.encodeFunctionResult(
                "balanceOf",
                [fundingBalance],
              ));
            }
            // V4_POSITION_MANAGER_POOL_KEYS_SELECTOR = 0x86b6be7d.
            if (data.startsWith("0x86b6be7d")) {
              positionManagerReads++;
              // PositionManager keys by the leading bytes25 of poolId.
              const requestedPoolIdPrefix =
                ("0x" + data.slice(10, 60)).toLowerCase();
              // An empty mapping slot decodes to a full zero tuple. Resolve
              // pool 1 only; pool 2 must use its exact nomination trace.
              if (
                pmResolvesPool1 &&
                requestedPoolIdPrefix === poolId.slice(0, 52).toLowerCase()
              ) {
                return respond(encodedPoolKey);
              }
              if (
                requestedPoolIdPrefix === poolId2.slice(0, 52).toLowerCase()
              ) {
                return respond("0x" + "00".repeat(160));
              }
              return respond("0x" + "00".repeat(160));
            }
            return respond("0x");
          }
          case "debug_traceTransaction": {
            traceReads++;
            const transactionHash = String(rpcRequest.params?.[0]).toLowerCase();
            tracedTransactions.push(transactionHash);
            if (!traceAvailable) return respond(null);
            const input = transactionHash === pool1Tx.toLowerCase()
              ? pool1SwapInput
              : transactionHash === pool2Tx.toLowerCase()
                ? pool2SwapInput
                : null;
            if (input === null) return respond(null);
            return respond(Object.freeze({
              type: "CALL",
              from: traceSender,
              to: v4Manager,
              input,
              calls: Object.freeze([]),
            }));
          }
          case "eth_getLogs": {
            historicalLogReads++;
            return respond([]);
          }
          default:
            return Object.freeze({
              jsonrpc: "2.0",
              id: rpcRequest.id,
              error: {
                code: -32601,
                message: "unsupported:" + rpcRequest.method,
              },
            });
        }
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
    });
  });
  await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
  const stubAddress = stubServer.address();
  const stubPort = typeof stubAddress === "object" && stubAddress !== null
    ? stubAddress.port
    : 0;
  try {
    const wired = createRebuildWiring({
      rpcUrl: "http://127.0.0.1:" + stubPort,
    });
    const noKnownCandidates = Object.freeze([]) as readonly unknown[];
    const fundingToken = ethers.getAddress("0x" + "f1".repeat(20));
    const fundingCandidate = candidatesFromLog(Object.freeze({
      address: ADDR.MORPHO,
      topics: Object.freeze([
        ethers.id("FlashLoan(address,address,uint256)"),
        ethers.zeroPadValue(ethers.ZeroAddress, 32),
        ethers.zeroPadValue(fundingToken, 32),
      ]),
      data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]),
      transactionHash: "0x" + "f2".repeat(32),
      blockNumber: SOURCE.number,
      blockHash: SOURCE.hash,
      logIndex: 9,
    }))[0]!;
    const funded = await wired.attestFamilyInstanceOnce({
      candidate: fundingCandidate,
      cutoff: SOURCE,
    });
    assert.equal(
      funded.status,
      "verified",
      "an observed Funding token enters Ready only with positive current liquidity",
    );
    fundingBalance = 0n;
    const emptyFunding = await wired.attestFamilyInstanceOnce({
      candidate: fundingCandidate,
      cutoff: SOURCE,
    });
    assert.equal(emptyFunding.status, "retryable");
    assert.match(
      emptyFunding.status === "retryable" ? emptyFunding.reasonCode : "",
      /no positive current liquidity/,
      "an observed token with zero current lender balance stays outside Ready",
    );
    fundingBalance = 1_000_000n;
    // Thousands of immutable memos normally share one proof block. Instance
    // authority (code + implementation) is still checked per candidate, but
    // the shared canonical block hash must be read only once for this fixed
    // cutoff, including across calls outside ethers' short request cache.
    const memoCandidateA = candidateFromLog(a);
    const memoCandidateB = candidateFromLog(b);
    const memoCandidateKeyA = rebuildFamilyCandidateKey(memoCandidateA);
    const memoCandidateKeyB = rebuildFamilyCandidateKey(memoCandidateB);
    const crossRunMemo = (
      memoCandidate: Readonly<Record<string, unknown>>,
      familyCandidateKey: string,
    ): DurableVerifiedMemo => makeMemo(memoCandidate, {
      familyCandidateKey,
      validity: Object.freeze({
        policy: "immutable-code",
        authorityFingerprint: authorityFor(memoCandidate),
        proofSource: Object.freeze({
          number: SOURCE.number - 1,
          hash: memoProofHash,
        }),
      }),
    });
    const memoA = crossRunMemo(memoCandidateA, memoCandidateKeyA);
    const memoB = crossRunMemo(memoCandidateB, memoCandidateKeyB);
    const memoCheckpoint = Object.freeze({
      revision: 1,
      verifiedMemos: Object.freeze({
        [memoCandidateKeyA]: memoA,
        [memoCandidateKeyB]: memoB,
      }),
      retryableAttemptsByCandidateKey: Object.freeze({}),
      inProgressRun: null,
      readyGeneration: null,
      checkpointFingerprint: "f".repeat(64),
    }) as never;
    assert.equal(await wired.findReusableMemo({
      candidate: memoCandidateA,
      checkpoint: memoCheckpoint,
      cutoff: SOURCE,
    }), memoA);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await wired.findReusableMemo({
      candidate: memoCandidateB,
      checkpoint: memoCheckpoint,
      cutoff: SOURCE,
    }), memoB);
    assert.equal(
      memoProofHashReads,
      1,
      "one fixed-run proof block hash is shared by every memo revalidation",
    );
    const v4SwapLog = Object.freeze({
      address: v4Manager,
      topics: Object.freeze([UNIV4_SWAP_TOPIC, poolId.toLowerCase()]),
      data: "0x",
      transactionHash: pool1Tx,
      blockNumber: SOURCE.number,
      blockHash: SOURCE.hash,
      logIndex: 0,
    });
    const reverseBound = await wired.reverseBindOpaqueCandidates!({
      observations: Object.freeze([v4SwapLog]),
      cutoff: SOURCE,
      knownCandidates: noKnownCandidates,
    });
    assert.equal(
      reverseBound.length,
      1,
      "a poolId-only Swap log resolves through the declared reverse binding",
    );
    const boundCandidate = reverseBound[0] as Readonly<Record<string, unknown>>;
    assert.equal(boundCandidate.familyId, "univ4");
    assert.equal(boundCandidate.poolId, poolId.toLowerCase());
    assert.equal(boundCandidate.address, v4Manager);
    assert.equal(
      (boundCandidate.poolKey as Readonly<Record<string, unknown>>).currency0,
      currency0.toLowerCase(),
    );
    assert.equal(
      (boundCandidate.poolKey as Readonly<Record<string, unknown>>).fee,
      fee,
    );
    assert.equal(
      (boundCandidate.pluginCandidateKey as string),
      manager + "\u001f" + poolId.toLowerCase(),
    );
    const positionManagerReadsBeforeMemoReuse = positionManagerReads;
    const reusedReverseBinding = await wired.reverseBindOpaqueCandidates!({
      observations: Object.freeze([v4SwapLog]),
      cutoff: SOURCE,
      knownCandidates: Object.freeze([boundCandidate]),
    });
    assert.equal(
      reusedReverseBinding.length,
      0,
      "a reusable retained candidate stays in the main partition without rebinding",
    );
    assert.equal(
      positionManagerReads,
      positionManagerReadsBeforeMemoReuse,
      "a reusable reverse-bound candidate performs no repeated reverse lookup",
    );
    // Duplicate swap logs of one pool collapse to a single candidate.
    const repeated = await wired.reverseBindOpaqueCandidates!({
      observations: Object.freeze([
        v4SwapLog,
        Object.freeze({ ...v4SwapLog, logIndex: 1 }),
      ]),
      cutoff: SOURCE,
      knownCandidates: noKnownCandidates,
    });
    assert.equal(repeated.length, 1, "reverse-bound candidates dedupe per pool");
    assert.equal(
      traceReads,
      0,
      "PositionManager-resolved candidates do not pay for transaction trace",
    );
    // Two pools in one driver call: the PositionManager resolves pool 1;
    // pool 2 is recovered from the exact transaction attached to its Swap
    // nomination. The global queue must preserve both candidates and input
    // order without a Family-partitioned driver.
    const twoPoolSource = Object.freeze({
      number: SOURCE.number - 3,
      hash: "0x" + "d1".repeat(32),
      generation: 1,
    });
    const v4SwapLog2 = Object.freeze({
      address: v4Manager,
      topics: Object.freeze([UNIV4_SWAP_TOPIC, poolId2.toLowerCase()]),
      data: "0x",
      transactionHash: pool2Tx,
      blockNumber: SOURCE.number,
      blockHash: SOURCE.hash,
      logIndex: 0,
    });
    const twoPools = await wired.reverseBindOpaqueCandidates!({
      observations: Object.freeze([v4SwapLog, v4SwapLog2]),
      cutoff: twoPoolSource,
      knownCandidates: noKnownCandidates,
    });
    assert.equal(twoPools.length, 2, "every pool nomination is reverse-bound");
    assert.equal(
      String((twoPools[0] as Readonly<Record<string, unknown>>).poolId),
      poolId.toLowerCase(),
      "global concurrent reverse binding preserves input order",
    );
    assert.equal(
      String((twoPools[1] as Readonly<Record<string, unknown>>).poolId),
      poolId2.toLowerCase(),
      "trace-derived pool follows its nomination",
    );
    const twoPoolKeys = new Set(twoPools.map((candidate) => String(
      (candidate as Readonly<Record<string, unknown>>).poolId,
    )));
    assert.equal(twoPoolKeys.has(poolId.toLowerCase()), true, "pool 1 admitted");
    assert.equal(
      twoPoolKeys.has(poolId2.toLowerCase()),
      true,
      "pool 2 admitted via its exact transaction trace",
    );
    assert.equal(
      traceReads,
      1,
      "only the catalog-matched Family capability inspects the miss",
    );
    assert.deepEqual(
      tracedTransactions,
      [pool2Tx.toLowerCase()],
      "only the PositionManager-missed pool transaction is traced",
    );
    // PositionManager misses router-side pools: the exact nomination trace
    // resolves the same complete candidate without any history backscan.
    pmResolvesPool1 = false;
    const fallbackSource = Object.freeze({
      number: SOURCE.number - 1,
      hash: "0x" + "b1".repeat(32),
      generation: 1,
    });
    const traced = await wired.reverseBindOpaqueCandidates!({
      observations: Object.freeze([v4SwapLog]),
      cutoff: fallbackSource,
      knownCandidates: noKnownCandidates,
    });
    assert.equal(
      traced.length,
      1,
      "exact nomination trace resolves the pool",
    );
    const tracedCandidate = traced[0] as
      Readonly<Record<string, unknown>>;
    assert.equal(tracedCandidate.familyId, "univ4");
    assert.equal(tracedCandidate.poolId, poolId.toLowerCase());
    assert.equal(
      (tracedCandidate.poolKey as Readonly<Record<string, unknown>>)
        .currency0,
      currency0.toLowerCase(),
    );
    assert.equal(
      (tracedCandidate.poolKey as Readonly<Record<string, unknown>>).fee,
      fee,
    );
    assert.equal(traceReads, 2, "router-side pool uses its exact Family trace");
    assert.equal(
      historicalLogReads,
      0,
      "reverse binding never performs a historical Initialize scan",
    );
    // Neither cheap chain truth nor exact trace resolves: the nomination is
    // durable retryable (fail-closed, never a guessed identity), so it cannot
    // block an otherwise complete Ready generation.
    traceAvailable = false;
    const missingSource = Object.freeze({
      number: SOURCE.number - 2,
      hash: "0x" + "c1".repeat(32),
      generation: 1,
    });
    const unresolved = await wired.reverseBindOpaqueCandidates!({
      observations: Object.freeze([v4SwapLog]),
      cutoff: missingSource,
      knownCandidates: noKnownCandidates,
    });
    assert.equal(unresolved.length, 1, "unresolved identity becomes retryable");
    const unresolvedCandidate = unresolved[0] as
      Readonly<Record<string, unknown>>;
    assert.equal(unresolvedCandidate.poolId, poolId.toLowerCase());
    assert.equal(
      wired.preAttestationRetryable?.(unresolvedCandidate)?.stage,
      "nomination",
    );
    assert.equal(
      wired.preAttestationRetryable?.(unresolvedCandidate)?.reasonCode,
      "poolkey-unresolved",
    );
    assert.equal(historicalLogReads, 0, "unresolved identity does not deep-scan");
    // A log that matches no declared reverse-binding pattern is untouched.
    const unrelated = await wired.reverseBindOpaqueCandidates!({
      observations: Object.freeze([
        log({ address: manager, logIndex: 0 }),
        log({ address: "0x" + "55".repeat(20), logIndex: 1 }),
      ]),
      cutoff: SOURCE,
      knownCandidates: noKnownCandidates,
    });
    assert.equal(unrelated.length, 0, "no reverse binding without a declared seed");
  } finally {
    // The JSON-RPC client keeps connections alive; force them closed so the
    // server can actually stop.
    stubServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      stubServer.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  console.log("universe rebuild production wiring PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
