import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  attestPoolIdentitiesStrict,
  centralAddressSurfaceFallback,
} from "../strict-identity-attestation.js";
import type { CentralAdapterRuntime } from
  "../adapter-work-intent.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from
  "../venues/family-capability-catalog.js";
import type { UnifiedObservation } from
  "../venues/adapter-family-plugin.js";
import type {
  AdapterInstanceOutcome,
  AdapterInstanceStage,
} from "../venues/adapter-family-runtime.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 100,
  hash: `0x${"ab".repeat(32)}`,
  generation: 100,
});
const POOL = `0x${"11".repeat(20)}`;
const FAMILY = "synthetic:identity";
const ACTION = "synthetic-identity-action";
const FINGERPRINT = "synthetic:interface:v1";

const family = Object.freeze({
  plugin: Object.freeze({
    manifest: Object.freeze({
      familyId: FAMILY,
      domain: "protocol" as const,
    }),
    discovery: Object.freeze({
      evidenceChannel: "nominate" as const,
      sources: Object.freeze(["address-surface" as const]),
      addressSurfaces: Object.freeze([Object.freeze({
        id: "synthetic-surface",
        kind: "interface" as const,
        fingerprint: FINGERPRINT,
      })]),
      decodeCandidate: (input: {
        readonly observation: UnifiedObservation;
        readonly matchedPatternId: string;
      }) => input.observation.kind === "address-surface" &&
          input.matchedPatternId === "synthetic-surface"
        ? Object.freeze({ candidateKind: "synthetic" as const })
        : null,
      candidateKey: () => POOL.toLowerCase(),
    }),
    identity: Object.freeze({
      variants: Object.freeze([]),
      identityKey: () => POOL.toLowerCase(),
    }),
  }),
});

const catalog = Object.freeze({
  catalogHash: "d".repeat(64),
  listAll: () => Object.freeze([family]),
  forFamily: (id: string) => {
    if (id !== FAMILY) throw new Error("unknown family");
    return family;
  },
  forStrictFamily: (id: string) => {
    if (id !== FAMILY) throw new Error("unknown family");
    return family;
  },
  ownerOfAction: (id: string) => {
    if (id !== ACTION) throw new Error("unknown action");
    return FAMILY;
  },
  matches: (observation: UnifiedObservation) =>
    observation.kind === "address-surface" &&
      observation.interfaceFingerprints?.includes(FINGERPRINT)
    ? Object.freeze([Object.freeze({
        familyId: FAMILY,
        patternId: "synthetic-surface",
      })])
    : Object.freeze([]),
}) as unknown as FamilyCapabilityCatalog;

const verifiedOutcome: AdapterInstanceOutcome = Object.freeze({
  familyId: FAMILY as never,
  lineageId: "synthetic:lineage" as never,
  candidateKey: POOL.toLowerCase(),
  stage: "identity" as AdapterInstanceStage,
  status: "verified",
  reasonCode: "",
  source: SOURCE,
  evidenceRefs: Object.freeze([]),
});

function runtime(verified: boolean): CentralAdapterRuntime {
  return Object.freeze({
    policy: Object.freeze({}),
    budgets: Object.freeze({}),
    scheduler: Object.freeze({}),
    callerAuthority: Object.freeze({}),
    generationFence: Object.freeze({}),
    clock: Object.freeze({}),
    // The attestation delegates to the lifecycle batch; a real runtime would
    // execute the plugin identity program. This harness records the call via
    // the imported lifecycle function - see below.
  }) as unknown as CentralAdapterRuntime;
}

async function main(): Promise<void> {
  // The attestation calls executeAdapterFamilyLifecycleBatch, which needs a
  // real runtime; for the contract we verify the observation construction and
  // match routing by stubbing the lifecycle through the runtime shape. We
  // assert the fail-closed paths that do not need identity execution:
  // no code -> rejected.
  const provider = {
    call: async () => "0x",
    getCode: async () => "0x",
    getStorage: async () => `0x${"00".repeat(32)}`,
  };
  const noCode = await attestPoolIdentitiesStrict({
    catalog,
    provider,
    runtime: runtime(true),
    source: SOURCE,
    pools: Object.freeze([Object.freeze({
      address: POOL,
      adapter: ACTION,
    })]),
  });
  assert.equal(noCode.accepted.length, 0);
  assert.equal(noCode.rejected.length, 1);
  assert.match(noCode.rejected[0]?.reason ?? "", /no deployed code/);

  // With code but no catalog match (unknown fingerprint) -> rejected.
  const provider2 = {
    call: async () => "0x",
    getCode: async () => "0x60806040",
    getStorage: async () => `0x${"00".repeat(32)}`,
  };
  const noMatch = await attestPoolIdentitiesStrict({
    catalog: Object.freeze({
      ...catalog,
      matches: () => Object.freeze([]),
    }) as unknown as FamilyCapabilityCatalog,
    provider: provider2,
    runtime: runtime(true),
    source: SOURCE,
    pools: Object.freeze([Object.freeze({
      address: POOL,
      adapter: ACTION,
    })]),
  });
  assert.equal(noMatch.accepted.length, 0);
  assert.equal(noMatch.rejected[0]?.reason, "no_catalog_match");

  // Central cold-pool fallback contract: no plugin nomination result is
  // re-materialized by the framework as an address-surface observation
  // (deployed code + every catalog-declared interface fingerprint). This
  // is a central rule, not per-family logic.
  const surface = await centralAddressSurfaceFallback(
    catalog,
    {
      call: async () => "0x",
      getCode: async () => "0x60806040",
      getStorage: async () => `0x${"00".repeat(32)}`,
    },
    SOURCE,
    POOL,
  );
  assert(surface !== undefined);
  assert.equal(surface.kind, "address-surface");
  assert(surface.interfaceFingerprints?.includes(FINGERPRINT) === true);
  assert.match(surface.codeHash, /^0x[0-9a-f]{64}$/);

  // No deployed code -> no fallback observation (fail-closed).
  const emptySurface = await centralAddressSurfaceFallback(
    catalog,
    {
      call: async () => "0x",
      getCode: async () => "0x",
      getStorage: async () => `0x${"00".repeat(32)}`,
    },
    SOURCE,
    POOL,
  );
  assert.equal(emptySurface, undefined);

  console.log("strict identity attestation PASS (fail-closed paths + central cold-pool fallback)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
