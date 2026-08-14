import assert from "node:assert/strict";
import {
  executeCatalogCaptureNominations,
} from "../venues/capture-materialization.js";
import { familyId } from "../venues/adapter-family-identifiers.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import type { FamilyId } from "../venues/adapter-family-identifiers.js";

const SYNTHETIC_FACTORY_LOG = familyId("synthetic:factory-log");
const SYNTHETIC_NO_NOMINATION = familyId("synthetic:no-nomination");

const SOURCE: CanonicalSource = Object.freeze({
  number: 42,
  hash: `0x${"d1".repeat(32)}`,
  generation: 42,
});
const POOL = `0x${"11".repeat(20)}`;
const FACTORY = `0x${"22".repeat(20)}`;
const TOKEN0 = `0x${"33".repeat(20)}`;
const TOKEN1 = `0x${"44".repeat(20)}`;
const FACTORY_TOPIC = `0x${"55".repeat(32)}` as `0x${string}`;
const TX = `0x${"66".repeat(32)}`;
const OTHER_FAMILY_ADDRESS = `0x${"77".repeat(20)}`;

/**
 * Synthetic factory-log Family: its plugin-owned nomination capability reads
 * token0/token1/factory from the pool and re-materializes the real factory
 * log through an exact topic query. The framework then admits it via
 * catalog.matches + decodeCandidate. No production Family is named.
 */
const syntheticFamily = Object.freeze({
  plugin: Object.freeze({
    manifest: Object.freeze({ familyId: SYNTHETIC_FACTORY_LOG }),
    discovery: Object.freeze({
      sources: Object.freeze(["factory-log" as const]),
      logPatterns: Object.freeze([Object.freeze({
        id: "synthetic-pair-created",
        topic: FACTORY_TOPIC,
        signature: "PairCreated(address,address,address,uint256)",
      })]),
      decodeCandidate: (input: {
        readonly observation: UnifiedObservation;
        readonly matchedPatternId: string;
      }) => input.observation.kind === "log" &&
          input.matchedPatternId === "synthetic-pair-created" &&
          input.observation.transactionHash === TX.toLowerCase()
        ? Object.freeze({ candidateKind: "synthetic-pair" as const })
        : null,
      candidateKey: () => POOL.toLowerCase(),
      nominate: Object.freeze({
        nominate: async (input: {
          readonly nominations: readonly {
            readonly address: string;
            readonly opaque: unknown;
          }[];
          readonly source: CanonicalSource;
          readonly provider: CaptureNominationProvider;
        }) => {
          nominationCalls += 1;
          const results: UnifiedObservation[] = [];
          for (const nomination of input.nominations) {
            const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
            if (opaque.adapter !== "synthetic-factory") continue;
            const address = nomination.address.toLowerCase();
            const [token0, token1, factory] = await Promise.all([
              input.provider.call({ to: address, data: "0xaa" }, input.source.number),
              input.provider.call({ to: address, data: "0xbb" }, input.source.number),
              input.provider.call({ to: address, data: "0xcc" }, input.source.number),
            ]);
            if (token0 !== TOKEN0.toLowerCase() ||
                token1 !== TOKEN1.toLowerCase() ||
                factory !== FACTORY.toLowerCase()) {
              continue;
            }
            const logs = await input.provider.getLogs({
              address: factory,
              fromBlock: 0,
              toBlock: input.source.number,
              topics: [FACTORY_TOPIC.toLowerCase()],
            });
            const hit = logs[0];
            if (hit === undefined || hit.transactionHash === undefined) continue;
            results.push(Object.freeze({
              kind: "log" as const,
              source: input.source,
              address: hit.address.toLowerCase(),
              topics: Object.freeze(hit.topics.map((t) => t.toLowerCase())),
              data: hit.data.toLowerCase(),
              transactionHash: hit.transactionHash.toLowerCase(),
            }));
          }
          return Object.freeze(results);
        },
      }),
    }),
  }),
});

/**
 * A second synthetic Family that declares no nomination capability: opaque
 * nominations for it must stay unclaimed (central executor is family-blind).
 */
const nominationlessFamily = Object.freeze({
  plugin: Object.freeze({
    manifest: Object.freeze({ familyId: SYNTHETIC_NO_NOMINATION }),
    discovery: Object.freeze({
      sources: Object.freeze(["observed-call" as const]),
      callPatterns: Object.freeze([Object.freeze({
        id: "synthetic-call",
        selector: "0x12345678",
        signature: "touch()",
      })]),
      decodeCandidate: (input: {
        readonly observation: UnifiedObservation;
        readonly matchedPatternId: string;
      }) => input.observation.kind === "call"
        ? Object.freeze({ candidateKind: "synthetic" as const })
        : null,
      candidateKey: () => OTHER_FAMILY_ADDRESS.toLowerCase(),
    }),
  }),
});

const catalog = Object.freeze({
  catalogHash: "b".repeat(64),
  listAll: () => Object.freeze([syntheticFamily, nominationlessFamily]),
  matches: (observation: UnifiedObservation) => {
    if (observation.kind !== "log") return Object.freeze([]);
    return Object.freeze([Object.freeze({
      familyId: syntheticFamily.plugin.manifest.familyId,
      patternId: "synthetic-pair-created",
    })]);
  },
}) as unknown as FamilyCapabilityCatalog;

let nominationCalls = 0;

async function main(): Promise<void> {
  const provider: CaptureNominationProvider = {
    call: async (transaction) => {
      if (transaction.data === "0xaa") return TOKEN0.toLowerCase();
      if (transaction.data === "0xbb") return TOKEN1.toLowerCase();
      if (transaction.data === "0xcc") return FACTORY.toLowerCase();
      throw new Error("unexpected call data");
    },
    getCode: async () => "0x01",
    getStorage: async () => `0x${"00".repeat(32)}`,
    getLogs: async (filter) => Object.freeze([Object.freeze({
      address: FACTORY.toLowerCase(),
      topics: Object.freeze([FACTORY_TOPIC.toLowerCase()]),
      data: "0x",
      transactionHash: TX.toLowerCase(),
    })]),
  };

  // Positive loop: graph pool nomination -> plugin nomination -> log
  // observation -> catalog.matches + decodeCandidate admission.
  const observations = await executeCatalogCaptureNominations({
    catalog,
    source: SOURCE,
    nominations: Object.freeze([
      Object.freeze({
        address: POOL,
        opaque: Object.freeze({ adapter: "synthetic-factory" }),
      }),
      // Foreign-family nomination must be ignored, not admitted.
      Object.freeze({
        address: OTHER_FAMILY_ADDRESS,
        opaque: Object.freeze({ adapter: "other-synthetic" }),
      }),
    ]),
    provider,
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.kind, "log");
  assert.equal(observations[0]?.transactionHash, TX.toLowerCase());

  // Per-Family early stop: the plugin was called once per candidate until
  // the first admitted one; with two candidates and the first admitting,
  // only one call happened for this Family (no all-pools scan).
  assert.equal(nominationCalls, 1);
  nominationCalls = 0;

  // Fail-closed: an observation that passes nomination but fails
  // decodeCandidate must be rejected by the executor.
  const rejectingCatalog = Object.freeze({
    catalogHash: "c".repeat(64),
    listAll: () => Object.freeze([syntheticFamily]),
    matches: () => Object.freeze([Object.freeze({
      familyId: syntheticFamily.plugin.manifest.familyId,
      patternId: "synthetic-pair-created",
    })]),
  }) as unknown as FamilyCapabilityCatalog;
  nominationCalls = 0;
  // Fail-closed: a nomination observation that fails decodeCandidate is a
  // per-candidate rejection - the executor returns no admission for it
  // (no fabrication), continues without throwing, and records the Family as
  // unresolved via the caller's diagnostics.
  const rejected = await executeCatalogCaptureNominations({
    catalog: rejectingCatalog,
    source: SOURCE,
    nominations: Object.freeze([
      Object.freeze({
        address: POOL,
        opaque: Object.freeze({ adapter: "synthetic-factory" }),
      }),
    ]),
    provider: Object.freeze({
      ...provider,
      // A different txHash makes the observation fail decodeCandidate.
      getLogs: async () => Object.freeze([Object.freeze({
        address: FACTORY.toLowerCase(),
        topics: Object.freeze([FACTORY_TOPIC.toLowerCase()]),
        data: "0x",
        transactionHash: `0x${"99".repeat(32)}`,
      })]),
    }),
  });
  assert.equal(rejected.length, 0);
  assert.equal(nominationCalls, 1);
  nominationCalls = 0;

  // alreadyAdmitted Families are skipped entirely (admit-as-you-go).
  nominationCalls = 0;
  const skipped = await executeCatalogCaptureNominations({
    catalog,
    source: SOURCE,
    nominations: Object.freeze([
      Object.freeze({
        address: POOL,
        opaque: Object.freeze({ adapter: "synthetic-factory" }),
      }),
    ]),
    provider,
    alreadyAdmitted: new Set<FamilyId>([
      syntheticFamily.plugin.manifest.familyId as FamilyId,
    ]),
  });
  assert.equal(skipped.length, 0);
  assert.equal(nominationCalls, 0);

  console.log("capture nomination framework PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
