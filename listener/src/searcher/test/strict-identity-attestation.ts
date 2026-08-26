import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  attestPoolIdentitiesStrict,
  attestStartupPoolSetsStrict,
  centralAddressSurfaceFallback,
  mergeStartupFamilyPublications,
  poolInstanceKey,
  startupFamilyCandidateKey,
} from "../strict-identity-attestation.js";
import type { CentralAdapterRuntime } from
  "../adapter-work-intent.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from
  "../venues/family-capability-catalog.js";
import type { CaptureNominationProvider, UnifiedObservation } from
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
      poolAdapterIds: Object.freeze(["synthetic-pool"]),
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
  ownerOfPoolAdapter: (id: string) => {
    if (id !== "synthetic-pool") throw new Error("unknown pool adapter");
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
  const previousConcurrency = process.env.SEARCHER_ATTESTATION_CONCURRENCY;
  process.env.SEARCHER_ATTESTATION_CONCURRENCY = "0";
  try {
    await assert.rejects(attestPoolIdentitiesStrict({
      catalog,
      provider: {
        call: async () => "0x",
        getCode: async () => "0x",
        getStorage: async () => `0x${"00".repeat(32)}`,
      },
      runtime: runtime(true),
      source: SOURCE,
      pools: Object.freeze([]),
    }), /SEARCHER_ATTESTATION_CONCURRENCY must be an integer in \[1, 256\]/);
  } finally {
    if (previousConcurrency === undefined) {
      delete process.env.SEARCHER_ATTESTATION_CONCURRENCY;
    } else {
      process.env.SEARCHER_ATTESTATION_CONCURRENCY = previousConcurrency;
    }
  }
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
    "synthetic-pool",
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
    "synthetic-pool",
  );
  assert.equal(emptySurface, undefined);

  // Unknown adapter hint stays fail-closed (no family guessing).
  const unknownHint = await centralAddressSurfaceFallback(
    catalog,
    {
      call: async () => "0x",
      getCode: async () => "0x60806040",
      getStorage: async () => `0x${"00".repeat(32)}`,
    },
    SOURCE,
    POOL,
    "unrelated-adapter",
  );
  assert.equal(unknownHint, undefined);


  // Retain-channel contract: with channelOrder "reverse-binding-first" the
  // central pipeline runs the catalog-issued reverse-binding capability
  // before the fresh nomination channel. The synthetic family declares an
  // implementation that materializes the address-surface observation, so
  // the retained row is admitted through it; the stub runtime has no
  // identity outcome, so the row fails in identity, not in observation.
  const rbNominationProviders: CaptureNominationProvider[] = [];
  const reverseBindingFamily = Object.freeze({
    plugin: Object.freeze({
      manifest: Object.freeze({
        familyId: "synthetic:reverse-binding",
        domain: "protocol" as const,
        poolAdapterIds: Object.freeze(["synthetic-rb-pool"]),
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
        instanceNominationKey: () => POOL.toLowerCase(),
        reverseBinding: Object.freeze({
          kind: "implementation" as const,
          reverseBinding: async (input: {
            readonly provider: CaptureNominationProvider;
          }) => {
            rbNominationProviders.push(input.provider);
            return Object.freeze([Object.freeze({
              status: "verified" as const,
              observation: Object.freeze({
                kind: "address-surface" as const,
                source: SOURCE,
                address: POOL,
                codeHash: ethers.keccak256("0x60806040"),
                implementationWord: ethers.zeroPadValue("0x", 32),
                interfaceFingerprints: Object.freeze([FINGERPRINT]),
              }),
            })]);
          },
        }),
      }),
      identity: Object.freeze({
        variants: Object.freeze([]),
        identityKey: () => POOL.toLowerCase(),
      }),
    }),
  });
  const rbCatalog = Object.freeze({
    catalogHash: "e".repeat(64),
    listAll: () => Object.freeze([reverseBindingFamily]),
    forFamily: (id: string) => {
      if (id !== "synthetic:reverse-binding") throw new Error("unknown family");
      return reverseBindingFamily;
    },
    forStrictFamily: (id: string) => {
      if (id !== "synthetic:reverse-binding") throw new Error("unknown family");
      return reverseBindingFamily;
    },
    ownerOfAction: () => {
      throw new Error("unknown action");
    },
    ownerOfPoolAdapter: (id: string) => {
      if (id !== "synthetic-rb-pool") throw new Error("unknown pool adapter");
      return "synthetic:reverse-binding";
    },
    matches: (observation: UnifiedObservation) =>
      observation.kind === "address-surface" &&
        observation.interfaceFingerprints?.includes(FINGERPRINT)
      ? Object.freeze([Object.freeze({
          familyId: "synthetic:reverse-binding",
          patternId: "synthetic-surface",
        })])
      : Object.freeze([]),
  }) as unknown as FamilyCapabilityCatalog;
  let rbGetCodeCalls = 0;
  const rbProvider = {
    call: async () => "0x",
    getCode: async () => {
      rbGetCodeCalls += 1;
      return "0x60806040";
    },
    getStorage: async () => "0x" + "00".repeat(32),
  };
  const rbResult = await attestPoolIdentitiesStrict({
    catalog: rbCatalog,
    provider: rbProvider,
    runtime: runtime(false),
    source: SOURCE,
    pools: Object.freeze([Object.freeze({
      address: POOL,
      adapter: "synthetic-rb-pool",
    })]),
    channelOrder: "reverse-binding-first",
  });
  assert.equal(rbResult.accepted.length, 0);
  assert.equal(rbResult.rejected.length, 1);
  // The observation was materialized through the retain channel (verified
  // reverse-binding observation, no central address-surface fallback): the
  // universal no-code check is the only getCode call (1), and the row
  // reaches the family lifecycle (which rejects the un-issued synthetic box
  // before identity). The stub runtime has no identity outcome.
  assert.equal(
    rbGetCodeCalls,
    1,
    "retain-channel observation must bypass the central fallback getCode",
  );
  assert.match(
    rbResult.rejected[0]?.reason ?? "",
    /issued by the central catalog|identity/,
    "retain-channel observation must reach the family lifecycle",
  );
  await attestPoolIdentitiesStrict({
    catalog: rbCatalog,
    provider: rbProvider,
    runtime: runtime(false),
    source: SOURCE,
    pools: Object.freeze([Object.freeze({
      address: POOL,
      adapter: "synthetic-rb-pool",
    })]),
    channelOrder: "reverse-binding-first",
  });
  assert.equal(rbNominationProviders.length, 2);
  assert.equal(
    rbNominationProviders[0],
    rbNominationProviders[1],
    "per-candidate calls at one source must share nomination provider identity",
  );

  // Explicitly-unsupported declaration: the central pipeline skips the
  // reverse-binding channel for that family and falls through to fresh
  // nomination (which the family does not declare) and then the central
  // address-surface fallback.
  const unsupportedFamily = Object.freeze({
    plugin: Object.freeze({
      manifest: Object.freeze({
        familyId: "synthetic:unsupported",
        domain: "protocol" as const,
        poolAdapterIds: Object.freeze(["synthetic-un-pool"]),
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
        reverseBinding: Object.freeze({
          kind: "explicitly-unsupported" as const,
          reason: "synthetic test: no retain channel",
        }),
      }),
      identity: Object.freeze({
        variants: Object.freeze([]),
        identityKey: () => POOL.toLowerCase(),
      }),
    }),
  });
  const unCatalog = Object.freeze({
    catalogHash: "f".repeat(64),
    listAll: () => Object.freeze([unsupportedFamily]),
    forFamily: (id: string) => {
      if (id !== "synthetic:unsupported") throw new Error("unknown family");
      return unsupportedFamily;
    },
    forStrictFamily: (id: string) => {
      if (id !== "synthetic:unsupported") throw new Error("unknown family");
      return unsupportedFamily;
    },
    ownerOfAction: () => {
      throw new Error("unknown action");
    },
    ownerOfPoolAdapter: (id: string) => {
      if (id !== "synthetic-un-pool") throw new Error("unknown pool adapter");
      return "synthetic:unsupported";
    },
    matches: (observation: UnifiedObservation) =>
      observation.kind === "address-surface" &&
        observation.interfaceFingerprints?.includes(FINGERPRINT)
      ? Object.freeze([Object.freeze({
          familyId: "synthetic:unsupported",
          patternId: "synthetic-surface",
        })])
      : Object.freeze([]),
  }) as unknown as FamilyCapabilityCatalog;
  let unGetCodeCalls = 0;
  const unResult = await attestPoolIdentitiesStrict({
    catalog: unCatalog,
    provider: {
      call: async () => "0x",
      getCode: async () => {
        unGetCodeCalls += 1;
        return "0x60806040";
      },
      getStorage: async () => "0x" + "00".repeat(32),
    },
    runtime: runtime(false),
    source: SOURCE,
    pools: Object.freeze([Object.freeze({
      address: POOL,
      adapter: "synthetic-un-pool",
    })]),
    channelOrder: "reverse-binding-first",
  });
  assert.equal(unResult.accepted.length, 0);
  assert.equal(unResult.rejected.length, 1);
  // Explicitly-unsupported retain channel: the central pipeline skips
  // reverse binding and falls through to fresh nomination (undeclared) and
  // then the central address-surface fallback (second getCode call), and
  // the row reaches the family lifecycle.
  assert.equal(
    unGetCodeCalls,
    2,
    "explicitly-unsupported retain channel must fall through to the central fallback",
  );
  assert.match(
    unResult.rejected[0]?.reason ?? "",
    /issued by the central catalog|identity/,
    "explicitly-unsupported retain channel must reach the family lifecycle",
  );

  // P0.1: family-aware candidate key. A shared physical address serving
  // two families (distinct adapter labels) keeps two keys; the same
  // family + pool collapses to one.
  const twoFamilyCatalog = Object.freeze({
    catalogHash: "f".repeat(64),
    listAll: () => Object.freeze([family]),
    forFamily: (id: string) => {
      if (id !== FAMILY) throw new Error("unknown family");
      return family;
    },
    forStrictFamily: (id: string) => {
      if (id !== FAMILY) throw new Error("unknown family");
      return family;
    },
    ownerOfAction: () => { throw new Error("unknown action"); },
    ownerOfPoolAdapter: (id: string) => {
      if (id === "synthetic-pool") return "synthetic:identity";
      if (id === "synthetic-pool-b") return "synthetic:family-b";
      throw new Error("unknown pool adapter");
    },
    matches: () => Object.freeze([]),
  }) as unknown as FamilyCapabilityCatalog;
  const sharedAddr = "0x" + "55".repeat(20);
  assert.equal(
    startupFamilyCandidateKey(twoFamilyCatalog, Object.freeze({
      address: sharedAddr,
      adapter: "synthetic-pool",
    })),
    "synthetic:identity|address:" + sharedAddr.toLowerCase(),
  );
  assert.notEqual(
    startupFamilyCandidateKey(twoFamilyCatalog, Object.freeze({
      address: sharedAddr,
      adapter: "synthetic-pool",
    })),
    startupFamilyCandidateKey(twoFamilyCatalog, Object.freeze({
      address: sharedAddr,
      adapter: "synthetic-pool-b",
    })),
    "one shared address across two families must not collapse",
  );
  assert.equal(
    startupFamilyCandidateKey(twoFamilyCatalog, Object.freeze({
      address: sharedAddr,
      adapter: "unresolvable-adapter",
    })),
    "unknown-family|address:" + sharedAddr.toLowerCase(),
  );
  // P0-a: per-instance key contract. Shared-address families (V4/Angstrom)
  // key on the plugin-owned poolId; every other pool keys on its address.
  assert.equal(
    poolInstanceKey(Object.freeze({ address: POOL })),
    "address:" + POOL.toLowerCase(),
  );
  const sharedAddress = "0x" + "44".repeat(20);
  assert.equal(
    poolInstanceKey(Object.freeze({
      address: sharedAddress,
      poolId: "0x" + "a1".repeat(32),
    })),
    "poolId:" + "0x" + "a1".repeat(32),
  );
  assert.notEqual(
    poolInstanceKey(Object.freeze({
      address: sharedAddress,
      poolId: "0x" + "a1".repeat(32),
    })),
    poolInstanceKey(Object.freeze({
      address: sharedAddress,
      poolId: "0x" + "b2".repeat(32),
    })),
    "distinct poolIds on one shared address must not collapse",
  );

  // P0-a: startup pool-set deduplication. The universe and blockscan sets
  // both load the same snapshot; each unique pool must be attested exactly
  // once and the outcome distributed to every set that contains it. The
  // no-code provider rejects every row at the universal fact check (one
  // getCode per unique pool).
  let getCodeCalls = 0;
  const dedupeProvider = {
    call: async () => "0x",
    getCode: async () => {
      getCodeCalls += 1;
      return "0x";
    },
    getStorage: async () => "0x" + "00".repeat(32),
  };
  const dedupeResult = await attestStartupPoolSetsStrict({
    provider: dedupeProvider,
    source: SOURCE,
    poolSets: Object.freeze([
      Object.freeze([
        Object.freeze({ address: POOL, adapter: "synthetic-pool" }),
        Object.freeze({ address: "0x" + "22".repeat(20), adapter: "synthetic-pool" }),
      ]),
      Object.freeze([
        Object.freeze({ address: POOL, adapter: "synthetic-pool" }),
        Object.freeze({ address: "0x" + "33".repeat(20), adapter: "synthetic-pool" }),
      ]),
    ]),
  });
  assert.equal(
    getCodeCalls,
    3,
    "a pool present in two startup sets must be attested exactly once",
  );
  assert.equal(dedupeResult.sets.length, 2);
  assert.equal(dedupeResult.sets[0].rejected.length, 2);
  assert.equal(dedupeResult.sets[1].rejected.length, 2);
  assert.equal(dedupeResult.sets[0].accepted.length, 0);
  assert.equal(dedupeResult.sets[1].accepted.length, 0);
  assert.equal(dedupeResult.sets[0].rejected[0]?.reason, "no deployed code");
  assert.equal(dedupeResult.sets[1].rejected[0]?.reason, "no deployed code");

  // poolId-keyed dedupe: one shared address with distinct poolIds keeps
  // every pool (the key is the plugin-owned instance identity, not the
  // address); the same poolId across sets still attests once.
  let poolIdCalls = 0;
  const poolIdProvider = {
    call: async () => "0x",
    getCode: async () => {
      poolIdCalls += 1;
      return "0x";
    },
    getStorage: async () => "0x" + "00".repeat(32),
  };
  const poolIdResult = await attestStartupPoolSetsStrict({
    provider: poolIdProvider,
    source: SOURCE,
    poolSets: Object.freeze([
      Object.freeze([
        Object.freeze({
          address: sharedAddress,
          poolId: "0x" + "a1".repeat(32),
          adapter: "synthetic-pool",
        }),
      ]),
      Object.freeze([
        Object.freeze({
          address: sharedAddress,
          poolId: "0x" + "a1".repeat(32),
          adapter: "synthetic-pool",
        }),
        Object.freeze({
          address: sharedAddress,
          poolId: "0x" + "b2".repeat(32),
          adapter: "synthetic-pool",
        }),
      ]),
    ]),
  });
  assert.equal(
    poolIdCalls,
    2,
    "distinct poolIds on one shared address must each attest",
  );
  assert.equal(poolIdResult.sets[0].rejected.length, 1);
  assert.equal(poolIdResult.sets[1].rejected.length, 2);
  assert.equal(poolIdResult.sets[0].rejected[0]?.reason, "no deployed code");

  // P0-b: mergeStartupFamilyPublications combines per-pool publications
  // of one family into a single sealed publication, deduping instances.
  const pubSource = Object.freeze({ number: 1, hash: "0x" + "aa".repeat(32), generation: 1 });
  const mkInstance = (key: string) => Object.freeze({
    familyId: FAMILY as never,
    lineageId: "synthetic:lineage" as never,
    instanceKey: key,
    candidateKey: key,
    evidenceRefs: Object.freeze([]),
    staticBindingFingerprint: "b",
    staticEvidenceFingerprint: "e",
    descriptor: Object.freeze({ provenance: Object.freeze([]) }),
    pricingInstances: Object.freeze([]),
    routes: Object.freeze([]),
  }) as never;
  const pubA = Object.freeze({
    familyId: FAMILY as never,
    source: pubSource,
    generation: 1,
    instances: Object.freeze([mkInstance("pool-a"), mkInstance("pool-b")]),
    outcomes: Object.freeze([]),
    publicationFingerprint: "x",
  }) as never;
  const pubB = Object.freeze({
    familyId: FAMILY as never,
    source: pubSource,
    generation: 1,
    instances: Object.freeze([mkInstance("pool-b"), mkInstance("pool-c")]),
    outcomes: Object.freeze([]),
    publicationFingerprint: "y",
  }) as never;
  const merged = mergeStartupFamilyPublications([pubA, pubB, null]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].familyId, FAMILY);
  assert.equal(merged[0].publication.instances.length, 3, "instances deduped by instanceKey");
  const keys = merged[0].publication.instances.map((i) => i.instanceKey).sort();
  assert.deepEqual(keys, ["pool-a", "pool-b", "pool-c"]);
  assert.match(merged[0].publication.publicationFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(mergeStartupFamilyPublications([]).length, 0);
  console.log("strict identity attestation PASS (fail-closed paths + central cold-pool fallback + retain-channel contract + startup set dedupe + publication merge)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
