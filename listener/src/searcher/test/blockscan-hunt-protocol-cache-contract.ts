import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  advanceProtocolObservedContiguousAuthority,
  createProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
  recordVerifiedProtocolCandidates,
  saveProtocolDiscoveryEvidenceCache,
  updateProtocolObservedSourceFingerprint,
} from "../protocol-discovery-cache.js";
import { protocolInstanceKey } from "../protocol-instance-discovery.js";
import { pairInstanceId } from "../venues/protocols/eigenpie-discovery.js";
import {
  isVerifiedRetainedTopologyProof,
  loadTrustedHuntProtocolDiscoveryCache,
} from "./blockscan-hunt-protocol-cache.js";
import {
  adapterFamilyQuoteCoverageIsComplete,
} from "./blockscan-hunt-selection.js";

const cursor = 10;
const cursorHash = `0x${"11".repeat(32)}`;
const observedFingerprint = `0x${"22".repeat(32)}`;
const familyFingerprints = new Map([
  ["protocol:eigenpie", `0x${"33".repeat(32)}`],
]);
const root = mkdtempSync(resolve(tmpdir(), "hunt-protocol-cache-"));
const path = resolve(root, "cache.json");

try {
  const cache = createProtocolDiscoveryEvidenceCache(1);
  updateProtocolObservedSourceFingerprint(
    cache,
    observedFingerprint,
    familyFingerprints,
  );
  const tokenIn = "0x0000000000000000000000000000000000000001";
  const tokenOut = "0x0000000000000000000000000000000000000002";
  const instance = {
    pool: {
      address: "0x0000000000000000000000000000000000000003",
      adapter: "eigenpie-deposit-router" as const,
      venueId: "unknown" as const,
      identitySource: "eigenpie-compatible-call-surface" as const,
      fixedTokenIn: tokenIn,
      fixedTokenOut: tokenOut,
      fixedSlotKind: "protocol" as const,
      fixedProtocolAction: "wrap" as const,
      logicalInstanceId: pairInstanceId(tokenIn, tokenOut),
    },
    sources: ["observed-interaction"],
    selectors: ["0x12345678"],
    evidence: [{
      kind: "eigenpie-deposit-observation",
      txHash: `0x${"77".repeat(32)}`,
      blockNumber: cursor - 1,
      depositor: "0x0000000000000000000000000000000000000004",
      tokenIn,
      tokenOut,
      amountIn: 123n,
      amountOut: 120n,
      referral: "0x0000000000000000000000000000000000000005",
    }],
    ownerAdapterId: "protocol:eigenpie",
  };
  recordVerifiedProtocolCandidates(cache, [{
    adapterId: "protocol:eigenpie",
    instance,
  }]);
  recordProtocolRouteOwnership(cache, {
    version: 1,
    admissions: new Map([[
      protocolInstanceKey("protocol:eigenpie", instance.pool),
      {
        adapterId: "protocol:eigenpie",
        instance,
      },
    ]]),
  });
  const contiguousAuthority = advanceProtocolObservedContiguousAuthority({
    cache,
    families: [{
      familyId: "protocol:eigenpie",
      sourceIds: ["observed-interaction"],
    }],
    familySourceCoverage: [{
      familyId: "protocol:eigenpie",
      sourceId: "observed-interaction",
      complete: true,
    }],
    fromBlock: 0,
    toBlock: cursor,
    toBlockHash: cursorHash,
    contiguousSourceIds: new Set(["observed-interaction"]),
  });
  assert.ok(contiguousAuthority);
  saveProtocolDiscoveryEvidenceCache(path, cache);
  const contentSha256 = sha256(readFileSync(path));

  const loaded = await loadTrustedHuntProtocolDiscoveryCache({
    path,
    expectedSha256: contentSha256,
    expectedChainId: 1,
    maxCursor: cursor,
    expectedObservedSourceFingerprint: observedFingerprint,
    expectedDiscoverySourceFingerprints: familyFingerprints,
    readCanonicalBlockHash: async (blockNumber) =>
      blockNumber === cursor ? cursorHash : null,
  });
  assert.equal(loaded.cursor, cursor);
  assert.equal(loaded.cursorHash, cursorHash);
  assert.equal(loaded.contentSha256, contentSha256);
  assert.equal(loaded.ownership.admissions.size, 1);
  assert.equal(
    loaded.topologyProof,
    null,
    "a caller-sealed cache must remain nominations-only even when it claims genesis-contiguous history",
  );
  assert.equal(
    loaded.cache.runtime.observedContiguousAuthority,
    null,
    "file-backed contiguous authority must not survive into the current process",
  );
  assert.equal(
    loaded.bootstrapCandidates.get("protocol:eigenpie")?.length,
    1,
    "nominations must remain available for source-N re-attestation",
  );
  assert.deepEqual(
    [...loaded.ownership.admissions.values()][0]?.edges,
    [],
    "persisted ownership must not restore executable edges before source-N re-attestation",
  );
  assert.equal(
    isVerifiedRetainedTopologyProof({
      cursor,
      cursorHash,
      contentSha256,
    }),
    false,
    "a structurally valid object must not become a process-local topology proof",
  );
  assert.equal(
    adapterFamilyQuoteCoverageIsComplete(
      [{
        familyId: "protocol:eigenpie",
        graphEdges: 1,
        positiveQuotes: 1,
        unavailableEdges: 0,
        unresolvedEdges: 0,
      }],
      ["protocol:eigenpie"],
      loaded.topologyProof,
    ),
    false,
    "current quote coverage cannot turn caller-supplied history into global completeness",
  );
  assert.equal(
    loaded.cache.routeOwnership.admissions[0].instance.evidence[0] &&
      (loaded.cache.routeOwnership.admissions[0].instance.evidence[0] as {
        amountIn?: unknown;
      }).amountIn,
    123n,
    "opaque bigint evidence must survive the trusted load exactly",
  );

  await assert.rejects(
    loadTrustedHuntProtocolDiscoveryCache({
      path,
      expectedSha256: "44".repeat(32),
      expectedChainId: 1,
      maxCursor: cursor,
      expectedObservedSourceFingerprint: observedFingerprint,
      expectedDiscoverySourceFingerprints: familyFingerprints,
      readCanonicalBlockHash: async () => cursorHash,
    }),
    /hash mismatch/,
  );

  await assert.rejects(
    loadTrustedHuntProtocolDiscoveryCache({
      path,
      expectedSha256: contentSha256,
      expectedChainId: 1,
      maxCursor: cursor - 1,
      expectedObservedSourceFingerprint: observedFingerprint,
      expectedDiscoverySourceFingerprints: familyFingerprints,
      readCanonicalBlockHash: async () => cursorHash,
    }),
    /exceeds/,
  );

  await assert.rejects(
    loadTrustedHuntProtocolDiscoveryCache({
      path,
      expectedSha256: contentSha256,
      expectedChainId: 1,
      maxCursor: cursor,
      expectedObservedSourceFingerprint: observedFingerprint,
      expectedDiscoverySourceFingerprints: familyFingerprints,
      readCanonicalBlockHash: async () => `0x${"55".repeat(32)}`,
    }),
    /not canonical/,
  );

  await assert.rejects(
    loadTrustedHuntProtocolDiscoveryCache({
      path,
      expectedSha256: contentSha256,
      expectedChainId: 1,
      maxCursor: cursor,
      expectedObservedSourceFingerprint: `0x${"66".repeat(32)}`,
      expectedDiscoverySourceFingerprints: familyFingerprints,
      readCanonicalBlockHash: async () => cursorHash,
    }),
    /observed registry fingerprint mismatch/,
  );

  const futureEvidencePath = resolve(root, "future-evidence.json");
  const futureEvidence = JSON.parse(readFileSync(path, "utf8")) as {
    route_ownership: {
      admissions: Array<{
        instance: { evidence: Array<{ blockNumber?: number }> };
      }>;
    };
  };
  futureEvidence.route_ownership.admissions[0].instance
    .evidence[0].blockNumber = cursor + 1;
  const futureEvidenceBytes = `${JSON.stringify(futureEvidence, null, 2)}\n`;
  writeFileSync(futureEvidencePath, futureEvidenceBytes, { mode: 0o600 });
  await assert.rejects(
    loadTrustedHuntProtocolDiscoveryCache({
      path: futureEvidencePath,
      expectedSha256: sha256(futureEvidenceBytes),
      expectedChainId: 1,
      maxCursor: cursor,
      expectedObservedSourceFingerprint: observedFingerprint,
      expectedDiscoverySourceFingerprints: familyFingerprints,
      readCanonicalBlockHash: async () => cursorHash,
    }),
    /post-cursor evidence/,
  );

  const boundedCache = createProtocolDiscoveryEvidenceCache(1);
  updateProtocolObservedSourceFingerprint(
    boundedCache,
    observedFingerprint,
    familyFingerprints,
  );
  assert.equal(
    advanceProtocolObservedContiguousAuthority({
      cache: boundedCache,
      families: [{
        familyId: "protocol:eigenpie",
        sourceIds: ["observed-interaction"],
      }],
      familySourceCoverage: [{
        familyId: "protocol:eigenpie",
        sourceId: "observed-interaction",
        complete: true,
      }],
      fromBlock: 7,
      toBlock: cursor,
      toBlockHash: cursorHash,
      contiguousSourceIds: new Set(["observed-interaction"]),
    }),
    null,
    "a clean bounded window must remain positive-only",
  );
  const boundedPath = resolve(root, "bounded-positive-only.json");
  saveProtocolDiscoveryEvidenceCache(boundedPath, boundedCache);
  const boundedSha256 = sha256(readFileSync(boundedPath));
  const boundedLoaded = await loadTrustedHuntProtocolDiscoveryCache({
    path: boundedPath,
    expectedSha256: boundedSha256,
    expectedChainId: 1,
    maxCursor: cursor,
    expectedObservedSourceFingerprint: observedFingerprint,
    expectedDiscoverySourceFingerprints: familyFingerprints,
    readCanonicalBlockHash: async () => cursorHash,
  });
  assert.equal(
    boundedLoaded.topologyProof,
    null,
    "a hash-sealed bounded cache is still nominations, not negative completeness",
  );

  const forgedAuthorityPath = resolve(root, "forged-authority.json");
  const forgedAuthority = JSON.parse(readFileSync(boundedPath, "utf8")) as {
    observed_contiguous_authority: unknown;
  };
  forgedAuthority.observed_contiguous_authority = {
    profile: "protocol-observed-contiguous-from-genesis-v1",
    fromBlock: 0,
    completeThroughBlock: cursor,
    completeThroughHash: cursorHash,
  };
  const forgedAuthorityBytes =
    `${JSON.stringify(forgedAuthority, null, 2)}\n`;
  writeFileSync(
    forgedAuthorityPath,
    forgedAuthorityBytes,
    { mode: 0o600 },
  );
  const forgedLoaded = await loadTrustedHuntProtocolDiscoveryCache({
    path: forgedAuthorityPath,
    // Recomputing a matching digest is deliberately insufficient provenance.
    expectedSha256: sha256(forgedAuthorityBytes),
    expectedChainId: 1,
    maxCursor: cursor,
    expectedObservedSourceFingerprint: observedFingerprint,
    expectedDiscoverySourceFingerprints: familyFingerprints,
    readCanonicalBlockHash: async () => cursorHash,
  });
  assert.equal(
    forgedLoaded.topologyProof,
    null,
    "a forged authority plus recomputed SHA must not mint topology proof",
  );
  assert.equal(
    forgedLoaded.cache.runtime.observedContiguousAuthority,
    null,
    "a forged authority must be stripped before the cache can be reused",
  );
  assert.equal(
    adapterFamilyQuoteCoverageIsComplete(
      [{
        familyId: "protocol:eigenpie",
        graphEdges: 1,
        positiveQuotes: 1,
        unavailableEdges: 0,
        unresolvedEdges: 0,
      }],
      ["protocol:eigenpie"],
      forgedLoaded.topologyProof,
    ),
    false,
    "forged retained topology must not support a global completeness claim",
  );
  assert.equal(
    advanceProtocolObservedContiguousAuthority({
      cache: boundedCache,
      families: [{
        familyId: "protocol:eigenpie",
        sourceIds: ["observed-interaction"],
      }],
      familySourceCoverage: [{
        familyId: "protocol:eigenpie",
        sourceId: "observed-interaction",
        complete: true,
      }],
      fromBlock: cursor + 1,
      toBlock: cursor + 2,
      toBlockHash: `0x${"88".repeat(32)}`,
      contiguousSourceIds: new Set(["observed-interaction"]),
    }),
    null,
    "two adjacent bounded positive scans must not self-mint genesis completeness",
  );

  const tamperedAuthorityPath = resolve(root, "tampered-authority.json");
  const tamperedAuthority = JSON.parse(readFileSync(path, "utf8")) as {
    observed_contiguous_authority: { fromBlock: number };
  };
  tamperedAuthority.observed_contiguous_authority.fromBlock = 1;
  const tamperedAuthorityBytes =
    `${JSON.stringify(tamperedAuthority, null, 2)}\n`;
  writeFileSync(
    tamperedAuthorityPath,
    tamperedAuthorityBytes,
    { mode: 0o600 },
  );
  const tamperedAuthorityLoaded =
    await loadTrustedHuntProtocolDiscoveryCache({
      path: tamperedAuthorityPath,
      expectedSha256: sha256(tamperedAuthorityBytes),
      expectedChainId: 1,
      maxCursor: cursor,
      expectedObservedSourceFingerprint: observedFingerprint,
      expectedDiscoverySourceFingerprints: familyFingerprints,
      readCanonicalBlockHash: async () => cursorHash,
    });
  assert.equal(
    tamperedAuthorityLoaded.topologyProof,
    null,
    "malformed caller authority remains irrelevant to nominations",
  );
  assert.equal(
    tamperedAuthorityLoaded.cache.runtime.observedContiguousAuthority,
    null,
    "malformed caller authority must not survive the loader",
  );

  const unanchoredPath = resolve(root, "unanchored.json");
  const unanchored = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  unanchored.observed_cursor_hash = null;
  const unanchoredBytes = `${JSON.stringify(unanchored, null, 2)}\n`;
  writeFileSync(unanchoredPath, unanchoredBytes, { mode: 0o600 });
  await assert.rejects(
    loadTrustedHuntProtocolDiscoveryCache({
      path: unanchoredPath,
      expectedSha256: sha256(unanchoredBytes),
      expectedChainId: 1,
      maxCursor: cursor,
      expectedObservedSourceFingerprint: observedFingerprint,
      expectedDiscoverySourceFingerprints: familyFingerprints,
      readCanonicalBlockHash: async () => cursorHash,
    }),
    /observed_cursor_hash must be 32 bytes/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("blockscan-hunt-protocol-cache-contract PASS");

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
