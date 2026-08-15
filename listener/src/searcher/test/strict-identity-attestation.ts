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
        reverseBinding: Object.freeze({
          kind: "implementation" as const,
          reverseBinding: async () => Object.freeze([Object.freeze({
            status: "verified" as const,
            observation: Object.freeze({
              kind: "address-surface" as const,
              source: SOURCE,
              address: POOL,
              codeHash: ethers.keccak256("0x60806040"),
              implementationWord: ethers.zeroPadValue("0x", 32),
              interfaceFingerprints: Object.freeze([FINGERPRINT]),
            }),
          })]),
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
  const rbResult = await attestPoolIdentitiesStrict({
    catalog: rbCatalog,
    provider: {
      call: async () => "0x",
      getCode: async () => {
        rbGetCodeCalls += 1;
        return "0x60806040";
      },
      getStorage: async () => "0x" + "00".repeat(32),
    },
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

  console.log("strict identity attestation PASS (fail-closed paths + central cold-pool fallback + retain-channel contract)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
