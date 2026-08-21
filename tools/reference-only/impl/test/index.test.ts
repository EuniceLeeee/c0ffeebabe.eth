import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeCanonicalBytes,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  createReadOnlyArtifactRef,
  type ProcessAnchorV1,
  type ReadOnlyArtifactRefV1,
} from "../../../../specs/core-envelope/src/index.ts";
import {
  CALIBRATION_REFERENCE_IMPL_SHA,
  CALIBRATION_REFERENCE_STAGE_MANIFEST,
  decodeReferenceWitnessReceipt,
  importImplReference,
  recomputeReferenceWitnessClaimId,
  recomputeReferenceWitnessReceiptId,
  type ImplReferenceLock,
  type ReferenceArtifactReadPort,
  type ReferenceWitnessClaim,
  type ReferenceWitnessReceipt,
} from "../src/index.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const commit = (digit: string): `${string}${string}` => `${digit.repeat(40)}` as `${string}${string}`;

const anchor = (sha: string): ProcessAnchorV1 => ({
  systemId: "impl-host",
  commitSha: sha,
  executableHash: h("1"),
  deploymentManifestHash: h("2"),
  serviceIdentityHash: h("3"),
  pid: "17",
  processStartTicks: "19",
  bootIdHash: h("4"),
});

function rawRecord(
  stage: string,
  implCommitSha: string,
  runtimeAnchor: ProcessAnchorV1,
  untrustedClaims: Record<string, unknown> = { marker: stage },
): Uint8Array {
  return encodeCanonicalBytes({
    schemaVersion: 1,
    kind: "aloha.impl-reference-raw",
    stage,
    implCommitSha,
    runtimeAnchor,
    untrustedClaims,
  });
}

function refFor(bytes: Uint8Array, digit: string): ReadOnlyArtifactRefV1 {
  const contentSha256 = sha256Hex(bytes);
  return createReadOnlyArtifactRef({
    locator: { kind: "content-object", storeIdentityHash: h("a"), objectKey: h(digit) },
    immutableMirrorLocator: { kind: "content-object", storeIdentityHash: h("b"), objectKey: contentSha256 },
    contentSha256,
    byteLength: String(bytes.length),
    mediaType: "application/json",
    schema: null,
    resolverPolicyHash: h("c"),
    retentionLeaseReceiptId: h("d"),
  });
}

function readerFor(entries: readonly { ref: ReadOnlyArtifactRefV1; bytes: Uint8Array | null }[]): ReferenceArtifactReadPort {
  const byId = new Map(entries.map((entry) => [entry.ref.artifactRefId, entry.bytes]));
  return {
    async read(ref) {
      const bytes = byId.get(ref.artifactRefId);
      return bytes === undefined || bytes === null ? bytes ?? null : Uint8Array.from(bytes);
    },
  };
}

function lockFor(
  sha: string,
  refs: readonly ReadOnlyArtifactRefV1[],
  stages: readonly string[] = ["startup", "ready"],
): ImplReferenceLock {
  return { implCommitSha: sha as ImplReferenceLock["implCommitSha"], runtimeAnchor: anchor(sha), stages, rawArtifactRefs: refs };
}

async function importOne(
  sha: string,
  refs: readonly ReadOnlyArtifactRefV1[],
  entries: readonly { ref: ReadOnlyArtifactRefV1; bytes: Uint8Array | null }[],
  stages: readonly string[] = ["startup", "ready"],
): Promise<ReferenceWitnessReceipt> {
  return importImplReference({
    lock: lockFor(sha, refs, stages),
    port: readerFor(entries),
  });
}

function changeClaim(
  claim: ReferenceWitnessClaim,
  changes: Partial<ReferenceWitnessClaim>,
): ReferenceWitnessClaim {
  const payload = { ...claim, ...changes } as ReferenceWitnessClaim;
  return { ...payload, claimId: recomputeReferenceWitnessClaimId(payload) };
}

function rebuildReceipt(
  receipt: ReferenceWitnessReceipt,
  claims: readonly ReferenceWitnessClaim[],
): ReferenceWitnessReceipt {
  const candidate = {
    ...receipt,
    claims: Object.freeze([...claims]),
    rawArtifactRefIds: Object.freeze(
      claims.filter((claim) => claim.rawArtifactRef !== null).map((claim) => claim.rawArtifactRefId as Hash),
    ),
    denominator: {
      ...receipt.denominator,
      entries: Object.freeze(claims.map((claim) => ({
        claimId: claim.claimId,
        ordinal: claim.expectedOrdinal,
        stage: claim.stage,
        rawArtifactRefId: claim.rawArtifactRefId,
        status: claim.status,
      }))),
    },
  } as ReferenceWitnessReceipt;
  return {
    ...candidate,
    receiptId: recomputeReferenceWitnessReceiptId(candidate),
  };
}

test("locks exact impl SHA and runtime anchor; mismatch remains invalid and does not become a fact", async () => {
  const expected = CALIBRATION_REFERENCE_IMPL_SHA;
  const actual = commit("b");
  const bytes = rawRecord("startup", actual, anchor(actual), { selected: true });
  const ref = refFor(bytes, "1");
  const receipt = await importOne(expected, [ref], [{ ref, bytes }]);
  assert.equal(receipt.claims[0]?.status, "invalid");
  assert.equal(receipt.claims[0]?.reason, "impl-sha-mismatch");
  assert.equal(receipt.claims[0]?.untrustedClaims, null);
  assert.equal(receipt.claims.find((claim) => claim.reason === "missing-stage")?.stage, "ready");
  assert.equal(receipt.claims.some((claim) => claim.reason === "missing-stage" && claim.stage === "startup"), false);
  assert.equal(receipt.implCommitSha, expected);
  assert.equal(receipt.runtimeAnchor.commitSha, expected);
});

test("rejects a lock for every impl SHA other than the calibration reference", async () => {
  await assert.rejects(
    importImplReference({
      lock: lockFor(commit("b"), [], ["startup"]),
      port: readerFor([]),
    }),
    /impl reference lock must pin 5f104cedd4b4778316c177ce4fa08a6761af85b1/,
  );
});

test("rejects a stage subset, reordering, or extra stage outside the frozen calibration manifest", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const bytes = rawRecord("startup", sha, anchor(sha));
  const ref = refFor(bytes, "1");
  assert.equal(Object.isFrozen(CALIBRATION_REFERENCE_STAGE_MANIFEST), true);
  assert.equal(Object.isFrozen(CALIBRATION_REFERENCE_STAGE_MANIFEST[0]), true);
  assert.deepEqual(CALIBRATION_REFERENCE_STAGE_MANIFEST, [
    { ordinal: 1, id: "startup" },
    { ordinal: 2, id: "ready" },
  ]);
  for (const stages of [
    ["startup"],
    ["ready", "startup"],
    ["startup", "ready", "execution"],
  ]) {
    await assert.rejects(
      importImplReference({ lock: lockFor(sha, [ref], stages), port: readerFor([{ ref, bytes }]) }),
      /stage manifest must exactly match startup→ready calibration stages/,
    );
  }
});

test("malformed, unknown, and top-level status/verdict records stay in the denominator", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const malformed = encodeCanonicalBytes({
    schemaVersion: 1,
    kind: "aloha.impl-reference-raw",
    stage: "startup",
    implCommitSha: sha,
    runtimeAnchor: anchor(sha),
    status: "pass",
  });
  const unknown = rawRecord("not-a-requested-stage", sha, anchor(sha));
  const malformedRef = refFor(malformed, "1");
  const unknownRef = refFor(unknown, "2");
  const receipt = await importOne(
    sha,
    [malformedRef, unknownRef],
    [{ ref: malformedRef, bytes: malformed }, { ref: unknownRef, bytes: unknown }],
  );
  assert.deepEqual(
    receipt.claims.filter((claim) => claim.status === "invalid").map((claim) => claim.reason),
    ["malformed-raw-record", "unknown-stage"],
  );
  assert.equal("verdict" in receipt, false);
  assert.equal("expectedVerdict" in receipt, false);
  assert.equal("independentOracleCaseCount" in receipt, false);
  assert.equal(receipt.denominator.entries.length, receipt.claims.length);
});

test("missing stages remain explicit; importer does not synthesize absent downstream facts", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const bytes = rawRecord("startup", sha, anchor(sha), { only: "raw" });
  const ref = refFor(bytes, "1");
  const receipt = await importOne(sha, [ref], [{ ref, bytes }]);
  const observed = receipt.claims.filter((claim) => claim.status === "observed");
  const missing = receipt.claims.filter((claim) => claim.status === "missing");
  assert.equal(observed.length, 1);
  assert.deepEqual(missing.map((claim) => claim.stage), ["ready"]);
  assert.equal(observed[0]?.untrustedClaims?.only, "raw");
  assert.equal(observed[0]?.untrustedClaims?.positiveQuote, undefined);
  assert.equal(observed[0]?.untrustedClaims?.simulationSuccess, undefined);
});

test("producer verdict-shaped data remains visibly untrusted and cannot become receipt authority", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const bytes = rawRecord("startup", sha, anchor(sha), {
    verdict: "pass",
    expectedVerdict: "pass",
    checks: { passed: true },
  });
  const ref = refFor(bytes, "1");
  const receipt = await importOne(sha, [ref], [{ ref, bytes }]);
  assert.equal(receipt.claims[0]?.status, "observed");
  assert.equal(receipt.claims[0]?.untrustedClaims?.verdict, "pass");
  assert.equal("verdict" in receipt, false);
  assert.equal("expectedVerdict" in receipt, false);
  assert.equal("facts" in receipt.claims[0]!, false);
  assert.deepEqual(decodeReferenceWitnessReceipt(receipt), receipt);
});

test("duplicate and out-of-order stages are invalid rather than silently overwritten", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const stageTwo = rawRecord("ready", sha, anchor(sha));
  const stageOneA = rawRecord("startup", sha, anchor(sha), { n: 1 });
  const stageOneB = rawRecord("startup", sha, anchor(sha), { n: 2 });
  const duplicateRefs = [refFor(stageOneA, "1"), refFor(stageOneB, "2")];
  const duplicateReceipt = await importOne(sha, duplicateRefs, [
    { ref: duplicateRefs[0]!, bytes: stageOneA },
    { ref: duplicateRefs[1]!, bytes: stageOneB },
  ]);
  assert.ok(duplicateReceipt.claims.filter((claim) => claim.reason === "duplicate-stage").length >= 2);
  assert.equal(duplicateReceipt.claims.some((claim) => claim.reason === "missing-stage" && claim.stage === "startup"), false);
  assert.deepEqual(decodeReferenceWitnessReceipt(duplicateReceipt), duplicateReceipt);

  const orderedRefs = [refFor(stageTwo, "3"), refFor(stageOneA, "4")];
  const receipt = await importOne(sha, orderedRefs, [
    { ref: orderedRefs[0]!, bytes: stageTwo },
    { ref: orderedRefs[1]!, bytes: stageOneA },
  ]);
  assert.ok(receipt.claims.some((claim) => claim.reason === "out-of-order-stage"));
  assert.equal(receipt.claims.find((claim) => claim.stage === "startup")?.status, "invalid");
  assert.equal(receipt.claims.some((claim) => claim.reason === "missing-stage" && claim.stage === "startup"), false);
  assert.deepEqual(decodeReferenceWitnessReceipt(receipt), receipt);
});

test("receipt decoder rejects forged observed stage identity and ordinal", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const startup = rawRecord("startup", sha, anchor(sha));
  const ready = rawRecord("ready", sha, anchor(sha));
  const refs = [refFor(startup, "1"), refFor(ready, "2")];
  const receipt = await importOne(sha, refs, [
    { ref: refs[0]!, bytes: startup },
    { ref: refs[1]!, bytes: ready },
  ]);
  const startupClaim = receipt.claims.find((claim) => claim.stage === "startup" && claim.status === "observed")!;
  const forgedStage = changeClaim(startupClaim, { stage: "evil" });
  assert.throws(
    () => decodeReferenceWitnessReceipt(rebuildReceipt(receipt, receipt.claims.map((claim) => claim === startupClaim ? forgedStage : claim))),
    /observed claim stage is not in the locked denominator|does not close expected stage/,
  );

  const forgedOrdinal = changeClaim(startupClaim, { expectedOrdinal: 2 });
  assert.throws(
    () => decodeReferenceWitnessReceipt(rebuildReceipt(receipt, receipt.claims.map((claim) => claim === startupClaim ? forgedOrdinal : claim))),
    /observed claim stage is not in the locked denominator|does not close expected stage/,
  );
});

test("receipt decoder rejects reordered observed claims even when all IDs are recomputed", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const startup = rawRecord("startup", sha, anchor(sha));
  const ready = rawRecord("ready", sha, anchor(sha));
  const refs = [refFor(startup, "1"), refFor(ready, "2")];
  const receipt = await importOne(sha, refs, [
    { ref: refs[0]!, bytes: startup },
    { ref: refs[1]!, bytes: ready },
  ]);
  const observed = receipt.claims.filter((claim) => claim.status === "observed");
  const reordered = [
    ...receipt.claims.filter((claim) => claim.status !== "observed"),
    ...observed.reverse(),
  ];
  assert.throws(
    () => decodeReferenceWitnessReceipt(rebuildReceipt(receipt, reordered)),
    /observed claim is out of importer stage order/,
  );
});

test("receipt decoder includes invalid known attempts in stage-order validation", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const startup = rawRecord("startup", sha, anchor(sha));
  const ready = rawRecord("ready", sha, anchor(sha));
  const refs = [refFor(startup, "1"), refFor(ready, "2")];
  const receipt = await importOne(sha, refs, [
    { ref: refs[0]!, bytes: startup },
    { ref: refs[1]!, bytes: ready },
  ]);
  const startupClaim = receipt.claims.find((claim) => claim.stage === "startup" && claim.status === "observed")!;
  const readyClaim = receipt.claims.find((claim) => claim.stage === "ready" && claim.status === "observed")!;
  const invalidReady = changeClaim(readyClaim, {
    status: "invalid",
    reason: "impl-sha-mismatch",
    untrustedClaims: null,
  });
  assert.throws(
    () => decodeReferenceWitnessReceipt(rebuildReceipt(receipt, [invalidReady, startupClaim])),
    /observed claim is out of importer stage order/,
  );
});

test("receipt decoder round-trips importer output with an earlier invalid attempt", async () => {
  const expectedSha = CALIBRATION_REFERENCE_IMPL_SHA;
  const wrongSha = commit("b");
  const ready = rawRecord("ready", expectedSha, anchor(expectedSha));
  const invalidStartup = rawRecord("startup", wrongSha, anchor(wrongSha));
  const refs = [refFor(ready, "1"), refFor(invalidStartup, "2")];
  const receipt = await importOne(expectedSha, refs, [
    { ref: refs[0]!, bytes: ready },
    { ref: refs[1]!, bytes: invalidStartup },
  ]);
  assert.equal(receipt.claims[0]?.status, "observed");
  assert.equal(receipt.claims[1]?.reason, "impl-sha-mismatch");
  assert.deepEqual(decodeReferenceWitnessReceipt(receipt), receipt);
});

test("raw bytes are bound to the immutable ref hash and locator", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const expected = rawRecord("startup", sha, anchor(sha));
  const actual = rawRecord("startup", sha, anchor(sha), { changed: true });
  const ref = refFor(expected, "1");
  const receipt = await importOne(sha, [ref], [{ ref, bytes: actual }]);
  const claim = receipt.claims[0]!;
  assert.equal(claim.status, "invalid");
  assert.equal(claim.reason, "bytes-hash-mismatch");
  assert.equal(claim.rawArtifactRefId, ref.artifactRefId);
  assert.equal(claim.rawArtifactRef?.locatorId, ref.locatorId);
  assert.equal(claim.rawBytesSha256, sha256Hex(actual));
  assert.equal(claim.untrustedClaims, null);
  assert.deepEqual(decodeReferenceWitnessReceipt(receipt), receipt);
});

test("native raw bytes with a hostile own iterator are copied by index without executing it", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const source = rawRecord("startup", sha, anchor(sha));
  const ref = refFor(source, "1");
  const hostile = source.slice();
  let iteratorTrapHits = 0;
  Object.defineProperty(hostile, Symbol.iterator, {
    configurable: true,
    enumerable: false,
    get() {
      iteratorTrapHits += 1;
      throw new Error("iterator trap must not run");
    },
  });
  const receipt = await importOne(sha, [ref], []);
  // Use a direct port so the fixture itself does not copy through an iterator.
  const directReceipt = await importImplReference({
    lock: lockFor(sha, [ref]),
    port: { async read() { return hostile; } },
  });
  assert.equal(receipt.claims[0]?.reason, "missing-artifact");
  assert.equal(directReceipt.claims[0]?.status, "observed");
  assert.equal(iteratorTrapHits, 0);
});

test("a known invalid stage remains invalid and is not replaced by synthetic missing", async () => {
  const expected = CALIBRATION_REFERENCE_IMPL_SHA;
  const actual = commit("b");
  const bytes = rawRecord("startup", actual, anchor(actual));
  const ref = refFor(bytes, "1");
  const receipt = await importOne(expected, [ref], [{ ref, bytes }]);
  const startup = receipt.claims.filter((claim) => claim.stage === "startup");
  assert.equal(startup.length, 1);
  assert.equal(startup[0]?.status, "invalid");
  assert.equal(startup[0]?.reason, "impl-sha-mismatch");
  assert.deepEqual(decodeReferenceWitnessReceipt(receipt), receipt);
});

test("the locked stage denominator cannot be empty", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  await assert.rejects(
    importImplReference({ lock: lockFor(sha, [], []), port: readerFor([]) }),
    /stages must not be empty/,
  );
});

test("receipt and claims are content-addressed and round-trip without authority fields", async () => {
  const sha = CALIBRATION_REFERENCE_IMPL_SHA;
  const bytes = rawRecord("startup", sha, anchor(sha));
  const ref = refFor(bytes, "1");
  const receipt = await importOne(sha, [ref], [{ ref, bytes }]);
  assert.equal(receipt.trustLevel, "untrusted-reference");
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.claims[0]), true);
  assert.deepEqual(decodeReferenceWitnessReceipt(receipt), receipt);
  assert.deepEqual(decodeReferenceWitnessReceipt(new TextDecoder().decode(encodeCanonicalBytes(receipt))), receipt);
  assert.equal("verdict" in receipt, false);
  assert.equal("independentOracleKinds" in receipt, false);
});
