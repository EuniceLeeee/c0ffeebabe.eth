import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { encodeEvmLogObservation, sealRecentObservation, type ObservedBlockV1 } from "../../../packages/observation/src/index.ts";
import {
  buildIdentityBaseReadRequests,
  buildIdentityPairReadRequests,
  issueUniV2RouteHandle,
  makeUniV2RehydrationRef,
  materializeUniV2,
  nominateUniV2,
  UNIV2_STANDARD_SOURCE_PLAN_RUNTIME,
  UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM,
  UNIV2_STANDARD_SOURCE_PLAN_ID,
  UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
  projectUniV2,
  rehydrateUniV2RouteHandle,
  routeHandleBindingHash,
  verifyUniV2IdentityStage,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_SYNC_EVENT_TOPIC0,
  type UniV2RouteHandleAuthorityPort,
  type UniV2RouteHandleV1,
} from "../src/public.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (label: string) => hashDomain("aloha/univ2-standard/test-source/v1", label);
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;

const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: hash("cutoff-hash"),
  stateRoot: hash("cutoff-state"),
});

const pool = address("1");
const token0 = address("2");
const token1 = address("3");
const factory = address("f");

const nominationObservation = Object.freeze({
  pool,
  evidence: Object.freeze({
    cutoff,
    blockNumber: "99",
    blockHash: hash("evidence-block"),
    txHash: hash("evidence-tx"),
    logIndex: "0",
    emitter: pool,
    topic0: UNIV2_SYNC_EVENT_TOPIC0,
    rawLocatorHash: hash("evidence-raw-locator"),
  }),
});

function sourceBoundIdentityFacts() {
  return Object.freeze({
    cutoff,
    pool,
    token0ReturnHex: addressWord(token0),
    token1ReturnHex: addressWord(token1),
    factoryReturnHex: addressWord(factory),
    forwardPairReturnHex: addressWord(pool),
    reversePairReturnHex: addressWord(pool),
  });
}

function completeVerticalSlice() {
  const nominated = nominateUniV2(nominationObservation);
  assert.equal(nominated.status, "nominated");
  const nomination = nominated.candidate;
  const reads = sourceBoundIdentityFacts();
  const identity = verifyUniV2IdentityStage({ nomination, reads });
  assert.equal(identity.status, "verified");
  const materialization = materializeUniV2({
    identity: identity.identity,
    read: {
      cutoff,
      pool,
      reservesReturnHex: `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`,
    },
  });
  assert.equal(materialization.status, "verified");
  const projection = projectUniV2({
    nomination,
    identity: identity.identity,
    materialization: materialization.materialization,
    feeBps: 30n,
    evidenceRoot: hash("candidate-evidence-root"),
    publicationIdentityMemo: identity.identity as unknown as CanonicalJson,
  });
  assert.equal(projection.status, "verified");
  return { nomination, identity: identity.identity, materialization: materialization.materialization, projection: projection.projection };
}

test("source-bound UniV2 five stages produce a sealed publication", () => {
  const slice = completeVerticalSlice();
  assert.equal(slice.identity.familyDefinitionHash, UNIV2_STANDARD_FAMILY_DEFINITION_HASH);
  assert.equal(slice.projection.publication.familyDefinitionHash, UNIV2_STANDARD_FAMILY_DEFINITION_HASH);
  assert.equal(slice.projection.publication.cutoff.hash, cutoff.hash);
  assert.equal(slice.projection.publication.transitions.length, 2);
  assert.equal(slice.projection.publication.instanceKey, pool);
  assert.ok(slice.projection.publication.instancePublicationHash.startsWith("0x"));
});

test("identity rejects a one-direction factory mismatch and malformed ABI padding", () => {
  const nominated = nominateUniV2(nominationObservation);
  assert.equal(nominated.status, "nominated");
  assert.deepEqual(
    verifyUniV2IdentityStage({
      nomination: nominated.candidate,
      reads: { ...sourceBoundIdentityFacts(), reversePairReturnHex: addressWord(address("4")) },
    }),
    { status: "chain-proven-rejected", reasonCode: "factory-reverse-binding-failed" },
  );
  assert.throws(
    () => verifyUniV2IdentityStage({
      nomination: nominated.candidate,
      reads: { ...sourceBoundIdentityFacts(), token0ReturnHex: `0x01${"0".repeat(22)}${token0.slice(2)}` },
    }),
    /padding/,
  );
});

test("nomination is evidence keyed and rejects non-Sync observations", () => {
  assert.equal(nominateUniV2({
    ...nominationObservation,
    evidence: { ...nominationObservation.evidence, topic0: hash("not-sync") },
  }).status, "chain-proven-rejected");
  const first = nominateUniV2(nominationObservation);
  const second = nominateUniV2({ ...nominationObservation, evidence: { ...nominationObservation.evidence, txHash: hash("other-tx") } });
  assert.equal(first.status, "nominated");
  assert.equal(second.status, "nominated");
  assert.equal(first.candidate.instanceNominationKey, second.candidate.instanceNominationKey);
});

test("UniV2 source-plan nomination skips unrelated Family evidence before reading raw bytes", async () => {
  const blocks: ObservedBlockV1[] = [];
  let parentHash = hash("genesis-parent");
  for (let number = 51; number <= 100; number += 1) {
    const blockHash = hash(`mixed-block:${number}`);
    blocks.push({ number: String(number), hash: blockHash, parentHash, evidence: [] });
    parentHash = blockHash;
  }
  const last = blocks.at(-1)!;
  const syncBytes = encodeEvmLogObservation({
    kind: "evm-log",
    version: 1,
    blockNumber: last.number,
    blockHash: last.hash,
    transactionHash: hash("mixed-sync-tx"),
    logIndex: "0",
    address: pool,
    topics: [UNIV2_SYNC_EVENT_TOPIC0],
    data: "0x",
  });
  const syncRawLocatorHash = sha256Hex(syncBytes);
  const unrelatedBytes = encodeEvmLogObservation({
    kind: "evm-log",
    version: 1,
    blockNumber: last.number,
    blockHash: last.hash,
    transactionHash: hash("mixed-other-tx"),
    logIndex: "1",
    address: address("4"),
    topics: [hash("other-family-topic")],
    data: "0x",
  });
  const unrelatedRawLocatorHash = sha256Hex(unrelatedBytes);
  blocks[blocks.length - 1] = {
    ...last,
    evidence: [
      {
        kind: "recent-log",
        version: 1,
        ownerRef: null,
        sourcePlanRef: null,
        blockNumber: last.number,
        blockHash: last.hash,
        txHash: hash("mixed-sync-tx"),
        logIndex: "0",
        address: pool,
        topic: UNIV2_SYNC_EVENT_TOPIC0,
        rawLocatorHash: syncRawLocatorHash,
      },
      {
        kind: "recent-log",
        version: 1,
        ownerRef: null,
        sourcePlanRef: null,
        blockNumber: last.number,
        blockHash: last.hash,
        txHash: hash("mixed-other-tx"),
        logIndex: "1",
        address: address("4"),
        topic: hash("other-family-topic"),
        rawLocatorHash: unrelatedRawLocatorHash,
      },
    ],
  };
  const mixedCutoff = Object.freeze({ ...cutoff, hash: last.hash });
  const rawLocators = [
    { kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: syncRawLocatorHash, bytes: syncBytes },
    { kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: unrelatedRawLocatorHash, bytes: unrelatedBytes },
  ].sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash));
  const recent = sealRecentObservation(mixedCutoff, { from: "51", to: "100" }, blocks, rawLocators);
  const plan = {
    ownerRef: hash("univ2-source-owner"),
    sourcePlanRef: hash("univ2-source-ref"),
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const executed = await UNIV2_STANDARD_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff: mixedCutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source plan is not used"); } },
    new AbortController().signal,
  );
  const reads: Hash[] = [];
  const nominations = await UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM.evaluate({
    execution: executed.execution,
    sourceEvidence: executed.sourceEvidence,
    recent,
    rawEvidence: {
      read(rawLocatorHash) {
        reads.push(rawLocatorHash);
        if (rawLocatorHash === syncRawLocatorHash) return syncBytes;
        throw new Error("unrelated raw evidence was read");
      },
    },
  }, new AbortController().signal);
  assert.equal(nominations.length, 1);
  assert.deepEqual(reads, [syncRawLocatorHash]);
  assert.equal(nominations[0]?.evidence.rawLocatorHash, syncRawLocatorHash);

  await assert.rejects(
    () => UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM.evaluate({
      execution: executed.execution,
      sourceEvidence: executed.sourceEvidence,
      recent,
      rawEvidence: {
        read(rawLocatorHash) {
          if (rawLocatorHash === syncRawLocatorHash) return unrelatedBytes;
          return unrelatedBytes;
        },
      },
    }, new AbortController().signal),
    /raw-evidence-binding-mismatch/,
  );
  assert.equal(UNIV2_STANDARD_SOURCE_PLAN_ID, "univ2-standard.fixed-cutoff-50-block");
  assert.match(UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH, /^0x[0-9a-f]{64}$/);
});

test("zero liquidity is a chain-proven rejection, not a verified publication", () => {
  const nominated = nominateUniV2(nominationObservation);
  assert.equal(nominated.status, "nominated");
  const identity = verifyUniV2IdentityStage({ nomination: nominated.candidate, reads: sourceBoundIdentityFacts() });
  assert.equal(identity.status, "verified");
  const materialization = materializeUniV2({
    identity: identity.identity,
    read: { cutoff, pool, reservesReturnHex: `0x${word(0n)}${word(2_000_000n)}${word(42n)}` },
  });
  assert.deepEqual(materialization, { status: "chain-proven-rejected", reasonCode: "zero-liquidity" });
});

test("rehydration delegates handle ownership to the current process authority", () => {
  const slice = completeVerticalSlice();
  const handles = new WeakMap<object, Hash>();
  const authority: UniV2RouteHandleAuthorityPort = {
    authorityRoot: hash("route-authority"),
    issueRouteHandle(input) {
      const opaque = Object.freeze({});
      handles.set(opaque, routeHandleBindingHash(input.publication, input.transition, input.rehydrationRef, this.authorityRoot));
      return Object.freeze({ opaque });
    },
    rehydrateRouteHandle(input) {
      const opaque = Object.freeze({});
      handles.set(opaque, routeHandleBindingHash(input.publication, input.transition, input.rehydrationRef, this.authorityRoot));
      return Object.freeze({ opaque });
    },
    assertOwnedRouteHandle(input) {
      if (handles.get(input.handle.opaque) !== routeHandleBindingHash(input.publication, input.transition, input.rehydrationRef, this.authorityRoot)) throw new Error("foreign-route-handle");
    },
  };
  const transition = slice.projection.publication.transitions[0]!;
  const issued = issueUniV2RouteHandle({ authority, publication: slice.projection.publication, transition });
  const ref = makeUniV2RehydrationRef(slice.projection.publication);
  const restored = rehydrateUniV2RouteHandle({ authority, publication: slice.projection.publication, transition, rehydrationRef: ref });
  assert.notEqual(issued.opaque, restored.opaque);
  assert.throws(() => rehydrateUniV2RouteHandle({
    authority,
    publication: slice.projection.publication,
    transition,
    rehydrationRef: { ...ref, instancePublicationHash: hash("forged") },
  }), /rehydration-ref-mismatch/);
  const foreignHandles = new WeakMap<object, Hash>();
  const foreignAuthority: UniV2RouteHandleAuthorityPort = {
    authorityRoot: hash("foreign-authority"),
    issueRouteHandle(input) {
      const opaque = Object.freeze({});
      foreignHandles.set(opaque, routeHandleBindingHash(input.publication, input.transition, input.rehydrationRef, this.authorityRoot));
      return Object.freeze({ opaque });
    },
    rehydrateRouteHandle(input) {
      void input;
      throw new Error("authority-not-current");
    },
    assertOwnedRouteHandle(input) {
      if (foreignHandles.get(input.handle.opaque) !== routeHandleBindingHash(input.publication, input.transition, input.rehydrationRef, this.authorityRoot)) throw new Error("foreign-route-handle");
    },
  };
  assert.throws(() => rehydrateUniV2RouteHandle({ authority: foreignAuthority, publication: slice.projection.publication, transition, rehydrationRef: ref }), /foreign-route-handle|route|authority-not-current/);
});
