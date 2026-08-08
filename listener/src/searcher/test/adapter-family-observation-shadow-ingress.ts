import assert from "node:assert/strict";
import {
  AdapterFamilyObservationShadowIngress,
  adapterFamilyShadowInventoryHash,
  createAdapterFamilyShadowAncestryIssuer,
  createAdapterFamilyShadowInputIssuer,
  type AdapterFamilyShadowAncestryProof,
  type AdapterFamilyShadowBootstrapReceipt,
  type AdapterFamilyShadowIncumbentNomination,
  type AdapterFamilyShadowInputIssuer,
  type AdapterFamilyShadowReattestationInput,
  type AdapterFamilyShadowReattestationResult,
  type AdapterFamilyShadowReattestor,
  type AdapterFamilyShadowSourceScanReceipt,
  type AdapterFamilyShadowWatermarkSeedInput,
} from "../adapter-family-observation-shadow-ingress.js";
import type { AdapterGenerationFence } from "../adapter-work-intent.js";
import type { AdapterInstanceOutcome } from
  "../venues/adapter-family-runtime.js";
import {
  definedFamilyPluginContractSummary,
  type DiscoverySourceKind,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
} from "../venues/family-capability-catalog.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import { WSTETH_INTERFACE } from
  "../venues/protocols/wsteth-family/codec.js";
import { wstethStrictFamilyPlugin } from
  "../venues/protocols/wsteth-family-plugin.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 10,
  hash: `0x${"a".repeat(64)}`,
  generation: 4,
});
const SOURCE_9: CanonicalSource = Object.freeze({
  number: 9,
  hash: `0x${"b".repeat(64)}`,
  generation: 3,
});
const PRIOR_HASH = `0x${"b".repeat(64)}`;
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const CHAIN_ID = "1";
const REGISTRY = "strict-source-registry-v1";

function catalog(): FamilyCapabilityCatalog {
  const summary = definedFamilyPluginContractSummary(wstethStrictFamilyPlugin);
  const entries = FAMILY_CAPABILITY_NAMES.map((capability, index) =>
    Object.freeze({
      familyId: WSTETH_FAMILY_ID,
      capability,
      contractVersion: "adapter-family-contract-v1",
      contentHash: index.toString(16).padStart(64, "0"),
      semanticDependencies: Object.freeze([]),
      provenanceCommit: null,
    }) satisfies GeneratedCapabilityIdentity
  );
  return new FamilyCapabilityCatalog({
    modules: [Object.freeze({
      sourceFile: "wsteth-family-plugin.ts",
      definitionBoundaryHash: summary.definitionBoundaryHash,
      plugin: wstethStrictFamilyPlugin,
    })],
    generatedManifest: Object.freeze({
      format: "adapter-family-capabilities-v1",
      entries: Object.freeze(entries),
      manifestHash: capabilityManifestHash(entries),
    }),
  });
}

function callObservation(source: CanonicalSource = SOURCE) {
  return Object.freeze({
    kind: "call" as const,
    source,
    target: WSTETH,
    data: `${WSTETH_INTERFACE.getFunction("wrap")!.selector}${"0".repeat(64)}`,
  });
}

function surfaceObservation(source: CanonicalSource = SOURCE) {
  return Object.freeze({
    kind: "address-surface" as const,
    source,
    address: WSTETH,
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
    interfaceFingerprints: Object.freeze(["wsteth-conversion-surface-v1"]),
  });
}

interface FakeOptions {
  readonly partialSourceId?: DiscoverySourceKind;
  readonly omitTerminalSourceId?: DiscoverySourceKind;
  readonly foreignTerminalSourceId?: DiscoverySourceKind;
  readonly throwSourceId?: DiscoverySourceKind;
  readonly invocations?: AdapterFamilyShadowReattestationInput[];
}

function fakeReattestor(options: FakeOptions = {}): AdapterFamilyShadowReattestor {
  return Object.freeze({
    async reattest(
      input: AdapterFamilyShadowReattestationInput,
    ): Promise<AdapterFamilyShadowReattestationResult> {
      options.invocations?.push(input);
      if (options.throwSourceId === input.sourceId) {
        throw new Error(`fixture ${input.sourceId} re-attestation failure`);
      }
      const candidateKey = input.candidateKeys[0]!;
      const partial = options.partialSourceId === input.sourceId;
      const outcomes = Object.freeze([Object.freeze({
        familyId: input.family.plugin.manifest.familyId,
        candidateKey,
        stage: "identity" as const,
        status: partial ? "unresolved" as const : "verified" as const,
        reasonCode: partial ? "fixture-unresolved" : "fixture-verified",
        source: input.source,
        evidenceRefs: Object.freeze([`${input.subjectKey}:identity`]),
      }) satisfies AdapterInstanceOutcome]);
      const terminalKeys = options.foreignTerminalSourceId === input.sourceId
        ? ["foreign-candidate"]
        : options.omitTerminalSourceId === input.sourceId || partial
        ? []
        : [candidateKey];
      return Object.freeze({
        familyId: input.family.plugin.manifest.familyId,
        sourceId: input.sourceId,
        source: input.source,
        subjectKey: input.subjectKey,
        candidateTerminalKeys: Object.freeze(terminalKeys),
        outcomes,
        admittedInstanceKeys: partial
          ? Object.freeze([])
          : Object.freeze([`${input.subjectKey}:instance`]),
        publicationFingerprints: partial
          ? Object.freeze([])
          : Object.freeze([`${input.subjectKey}:publication`]),
      });
    },
  });
}

interface Harness {
  readonly catalog: FamilyCapabilityCatalog;
  readonly inputIssuer: AdapterFamilyShadowInputIssuer;
  readonly ancestryIssuer: ReturnType<typeof createAdapterFamilyShadowAncestryIssuer>;
  readonly ingress: AdapterFamilyObservationShadowIngress;
  readonly fenceCalls: CanonicalSource[];
}

function harness(input: {
  readonly seeds?: readonly AdapterFamilyShadowWatermarkSeedInput[];
  readonly reattestor?: AdapterFamilyShadowReattestor;
  readonly staleFence?: boolean;
  readonly registry?: string;
} = {}): Harness {
  const strictCatalog = catalog();
  const inputIssuer = createAdapterFamilyShadowInputIssuer({
    chainId: CHAIN_ID,
    catalogHash: strictCatalog.catalogHash,
    sourceRegistryFingerprint: input.registry ?? REGISTRY,
  });
  const ancestryIssuer = createAdapterFamilyShadowAncestryIssuer({
    chainId: CHAIN_ID,
  });
  const fenceCalls: CanonicalSource[] = [];
  const generationFence: AdapterGenerationFence = Object.freeze({
    assertCurrent(_generation: number, source: CanonicalSource): void {
      fenceCalls.push(source);
      if (input.staleFence) throw new Error("fixture stale generation");
    },
  });
  const ingress = new AdapterFamilyObservationShadowIngress({
    catalog: strictCatalog,
    reattestor: input.reattestor ?? fakeReattestor(),
    generationFence,
    inputAuthority: inputIssuer.authority,
    ancestryAuthority: ancestryIssuer.authority,
    initialWatermarks: (input.seeds ?? []).map((seed) =>
      inputIssuer.sealWatermarkSeed(seed)
    ),
  });
  return { catalog: strictCatalog, inputIssuer, ancestryIssuer, ingress, fenceCalls };
}

function watermarkSeed(input: {
  readonly sourceId: DiscoverySourceKind;
  readonly block: number;
  readonly hash: string | null;
}): AdapterFamilyShadowWatermarkSeedInput {
  return Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    sourceId: input.sourceId,
    coverageAuthority: "append-only",
    completeThroughBlock: input.block,
    completeThroughHash: input.hash,
  });
}

function sealedScans(
  issuer: AdapterFamilyShadowInputIssuer,
  input: {
    readonly source?: CanonicalSource;
    readonly observedFrom?: number;
    readonly observedMode?: "contiguous" | "positive-only";
    readonly observedStatus?: "complete" | "partial";
    readonly includeCall?: boolean;
  } = {},
): readonly AdapterFamilyShadowSourceScanReceipt[] {
  const source = input.source ?? SOURCE;
  return Object.freeze([
    issuer.sealSourceScan({
      sourceId: "observed-call",
      mode: input.observedMode ?? "contiguous",
      status: input.observedStatus ?? "complete",
      source,
      range: { fromBlock: input.observedFrom ?? 0, toBlock: source.number },
      observations: input.includeCall === false ? [] : [callObservation(source)],
    }),
    issuer.sealSourceScan({
      sourceId: "address-surface",
      mode: "snapshot",
      status: "complete",
      source,
      range: { fromBlock: source.number, toBlock: source.number },
      observations: [],
    }),
  ]);
}

function inventory(
  incumbents: readonly AdapterFamilyShadowIncumbentNomination[],
) {
  const inventoryKeys = Object.freeze(
    incumbents.map((item) => item.incumbentKey).sort(),
  );
  return Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    inventoryKeys,
    inventoryCount: inventoryKeys.length,
    inventoryHash: adapterFamilyShadowInventoryHash(
      WSTETH_FAMILY_ID,
      inventoryKeys,
    ),
    incumbents,
  });
}

function sealedBootstrap(
  issuer: AdapterFamilyShadowInputIssuer,
  incumbents: readonly AdapterFamilyShadowIncumbentNomination[],
  source: CanonicalSource = SOURCE,
): AdapterFamilyShadowBootstrapReceipt {
  return issuer.sealBootstrap({
    inventoryMode: "complete-snapshot",
    source,
    range: { fromBlock: source.number, toBlock: source.number },
    families: [inventory(incumbents)],
  });
}

function ancestryProof(
  h: Harness,
  previous: { readonly number: number; readonly hash: string },
  current: CanonicalSource = SOURCE,
): AdapterFamilyShadowAncestryProof {
  return h.ancestryIssuer.issue({
    previous,
    current,
    status: "canonical-descendant",
    evidenceRef: `${previous.number}->${current.number}`,
  });
}

const invocations: AdapterFamilyShadowReattestationInput[] = [];
const completeHarness = harness({
  reattestor: fakeReattestor({ invocations }),
});
const complete = await completeHarness.ingress.run({
  sourceScans: sealedScans(completeHarness.inputIssuer, { observedFrom: 0 }),
  bootstrap: sealedBootstrap(completeHarness.inputIssuer, [
    {
      incumbentKey: "legacy:a",
      address: WSTETH,
      currentSurface: surfaceObservation(),
    },
    {
      incumbentKey: "legacy:b",
      address: WSTETH,
      currentSurface: surfaceObservation(),
    },
  ]),
  ancestryProofs: [],
});
assert.equal(complete.authority, "shadow-only");
assert.equal(
  complete.status,
  "shadow-partial",
  "an unsealed point-in-time scan cannot close snapshot coverage",
);
assert.equal(complete.bootstrap.status, "complete");
assert.deepEqual(
  complete.bootstrap.incumbents.map((item) => [item.incumbentKey, item.status]),
  [["legacy:a", "reattested"], ["legacy:b", "reattested"]],
);
assert.equal(complete.bootstrap.families[0]?.inventoryCount, 2);
assert.equal(
  complete.bootstrap.families[0]?.inventoryHash,
  adapterFamilyShadowInventoryHash(WSTETH_FAMILY_ID, ["legacy:a", "legacy:b"]),
);
assert.equal(
  invocations.filter((call) => call.sourceId === "address-surface").length,
  2,
  "each incumbent receives an independent re-attestation invocation",
);
assert.deepEqual(
  invocations.filter((call) => call.sourceId === "address-surface")
    .map((call) => call.subjectKey).sort(),
  ["legacy:a", "legacy:b"],
);
assert.equal(
  complete.sourceCoverage.find((coverage) =>
    coverage.sourceId === "observed-call"
  )?.status,
  "complete",
  "a genesis-through-current contiguous scan may close event history",
);
assert.equal(
  complete.sourceCoverage.find((coverage) =>
    coverage.sourceId === "observed-call"
  )?.coverageKind,
  "contiguous-history",
);
assert.equal(
  complete.sourceCoverage.find((coverage) =>
    coverage.sourceId === "address-surface"
  )?.status,
  "partial",
  "bootstrap input is not verifier-issued snapshot closure",
);
assert(
  complete.sourceCoverage.every((coverage) =>
    !("authority" in coverage)
  ),
  "plain shadow output must never mint catalog omission authority",
);
assert.equal(
  "sourceAnchors" in complete,
  false,
  "shadow coverage must not be structurally reusable as catalog anchors",
);
assert.equal(
  completeHarness.ingress.watermarkSnapshot().find((watermark) =>
    watermark.sourceId === "observed-call"
  )?.coverageAuthority,
  "contiguous-history",
  "a genesis-through-10 scan establishes in-process contiguous history",
);
assert.equal(completeHarness.fenceCalls.length, 1);

await assert.rejects(
  () => completeHarness.ingress.run({
    sourceScans: [{} as AdapterFamilyShadowSourceScanReceipt],
    ancestryProofs: [],
  }),
  /forged or foreign/,
  "structural scan objects must not cross the WeakMap issuer boundary",
);

const foreignIssuer = createAdapterFamilyShadowInputIssuer({
  chainId: CHAIN_ID,
  catalogHash: completeHarness.catalog.catalogHash,
  sourceRegistryFingerprint: "foreign-registry-v2",
});
await assert.rejects(
  () => completeHarness.ingress.run({
    sourceScans: sealedScans(foreignIssuer),
    ancestryProofs: [],
  }),
  /forged or foreign/,
  "same-shaped receipts from another source registry remain foreign",
);

assert.throws(
  () => completeHarness.inputIssuer.sealSourceScan({
    sourceId: "observed-call",
    mode: "snapshot",
    status: "complete",
    source: SOURCE,
    range: { fromBlock: 10, toBlock: 10 },
    observations: [callObservation()],
  }),
  /cannot claim snapshot authority/,
);
assert.throws(
  () => completeHarness.inputIssuer.sealSourceScan({
    sourceId: "address-surface",
    mode: "contiguous",
    status: "complete",
    source: SOURCE,
    range: { fromBlock: 10, toBlock: 10 },
    observations: [surfaceObservation()],
  }),
  /requires a point-in-time snapshot/,
);
assert.throws(
  () => completeHarness.inputIssuer.sealBootstrap({
    inventoryMode: "complete-snapshot",
    source: SOURCE,
    range: { fromBlock: 10, toBlock: 10 },
    families: [],
  }),
  /explicit per-Family inventory/,
);
assert.throws(
  () => completeHarness.inputIssuer.sealBootstrap({
    inventoryMode: "complete-snapshot",
    source: SOURCE,
    range: { fromBlock: 10, toBlock: 10 },
    families: [{
      ...inventory([]),
      inventoryCount: 1,
    }],
  }),
  /inventory count mismatch/,
);
assert.throws(
  () => completeHarness.inputIssuer.sealWatermarkSeed({
    familyId: WSTETH_FAMILY_ID,
    sourceId: "observed-call",
    completeThroughBlock: 9,
    completeThroughHash: PRIOR_HASH,
    coverageAuthority: "contiguous-history",
  } as unknown as AdapterFamilyShadowWatermarkSeedInput),
  /durable checkpoint authority/,
  "a process-local input issuer cannot restore trusted restart continuity",
);
const unsealedCheckpoint = completeHarness.ingress.watermarkSnapshot().find(
  (watermark) => watermark.sourceId === "observed-call",
)!;
assert.equal(unsealedCheckpoint.coverageAuthority, "contiguous-history");
assert.throws(
  () => completeHarness.inputIssuer.sealWatermarkSeed(
    unsealedCheckpoint as unknown as AdapterFamilyShadowWatermarkSeedInput,
  ),
  /durable checkpoint authority/,
  "an in-memory coverage snapshot cannot be re-sealed as a restart checkpoint",
);
assert.throws(
  () => completeHarness.inputIssuer.sealWatermarkSeed({
    familyId: WSTETH_FAMILY_ID,
    sourceId: "observed-call",
    completeThroughBlock: 9,
    completeThroughHash: PRIOR_HASH,
    coverageAuthority: "snapshot",
  } as unknown as AdapterFamilyShadowWatermarkSeedInput),
  /invalid adapter Family shadow watermark seed/,
);
assert.throws(
  () => completeHarness.inputIssuer.sealWatermarkSeed({
    familyId: WSTETH_FAMILY_ID,
    sourceId: "address-surface",
    completeThroughBlock: 9,
    completeThroughHash: PRIOR_HASH,
    coverageAuthority: "contiguous-history",
  } as unknown as AdapterFamilyShadowWatermarkSeedInput),
  /invalid adapter Family shadow watermark seed/,
);
assert.throws(
  () => completeHarness.inputIssuer.sealSourceScan({
    sourceId: "observed-call",
    mode: "contiguous",
    status: "complete",
    source: SOURCE,
    range: { fromBlock: 10, toBlock: 10 },
    observations: [callObservation({
      ...SOURCE,
      hash: `0x${"f".repeat(64)}`,
    })],
  }),
  /escaped its canonical source/,
  "source provenance must come from the sealed scan source",
);

const missingProofHarness = harness({
  seeds: [watermarkSeed({
    sourceId: "observed-call",
    block: 9,
    hash: PRIOR_HASH,
  })],
});
await assert.rejects(
  () => missingProofHarness.ingress.run({
    sourceScans: sealedScans(missingProofHarness.inputIssuer, {
      observedFrom: 10,
    }),
    bootstrap: sealedBootstrap(missingProofHarness.inputIssuer, []),
    ancestryProofs: [],
  }),
  /lacks canonical ancestry proof/,
);

const reorgHarness = harness({
  seeds: [watermarkSeed({
    sourceId: "observed-call",
    block: 10,
    hash: PRIOR_HASH,
  })],
});
await assert.rejects(
  () => reorgHarness.ingress.run({
    sourceScans: sealedScans(reorgHarness.inputIssuer, { observedFrom: 10 }),
    bootstrap: sealedBootstrap(reorgHarness.inputIssuer, []),
    ancestryProofs: [ancestryProof(reorgHarness, {
      number: 10,
      hash: PRIOR_HASH,
    })],
  }),
  /same-height canonical source hash changed/,
);

const appendOnlyHarness = harness({
  seeds: [watermarkSeed({
    sourceId: "observed-call",
    block: 9,
    hash: PRIOR_HASH,
  })],
});
const appendOnly = await appendOnlyHarness.ingress.run({
  sourceScans: sealedScans(appendOnlyHarness.inputIssuer, { observedFrom: 10 }),
  bootstrap: sealedBootstrap(appendOnlyHarness.inputIssuer, []),
  ancestryProofs: [ancestryProof(appendOnlyHarness, {
    number: 9,
    hash: PRIOR_HASH,
  })],
});
const appendCoverage = appendOnly.sourceCoverage.find((coverage) =>
  coverage.sourceId === "observed-call"
)!;
assert.equal(appendCoverage.status, "partial");
assert.equal(appendCoverage.coverageKind, "append-only");
assert.equal(appendCoverage.completeThroughBlock, 9);

const currentPartialHarness = harness();
await currentPartialHarness.ingress.run({
  sourceScans: sealedScans(currentPartialHarness.inputIssuer, {
    source: SOURCE_9,
    observedFrom: 0,
  }),
  bootstrap: sealedBootstrap(currentPartialHarness.inputIssuer, [], SOURCE_9),
  ancestryProofs: [],
});
const currentPartial = await currentPartialHarness.ingress.run({
  sourceScans: sealedScans(currentPartialHarness.inputIssuer, {
    observedFrom: 10,
    observedStatus: "partial",
  }),
  bootstrap: sealedBootstrap(currentPartialHarness.inputIssuer, []),
  ancestryProofs: [ancestryProof(currentPartialHarness, SOURCE_9)],
});
assert.equal(currentPartial.status, "shadow-partial");
assert.equal(
  currentPartial.sourceCoverage.find((coverage) =>
    coverage.sourceId === "observed-call"
  )?.status,
  "partial",
  "an old current watermark cannot mask this round's partial scan",
);
assert.equal(
  currentPartial.sourceCoverage.find((coverage) =>
    coverage.sourceId === "observed-call"
  )?.completeThroughBlock,
  9,
);

const sameHeightPartialHarness = harness();
await sameHeightPartialHarness.ingress.run({
  sourceScans: sealedScans(sameHeightPartialHarness.inputIssuer, {
    observedFrom: 0,
  }),
  bootstrap: sealedBootstrap(sameHeightPartialHarness.inputIssuer, []),
  ancestryProofs: [],
});
const sameHeightPartial = await sameHeightPartialHarness.ingress.run({
  sourceScans: sealedScans(sameHeightPartialHarness.inputIssuer, {
    observedFrom: SOURCE.number,
    observedStatus: "partial",
  }),
  bootstrap: sealedBootstrap(sameHeightPartialHarness.inputIssuer, []),
  ancestryProofs: [ancestryProof(sameHeightPartialHarness, SOURCE)],
});
const sameHeightCoverage = sameHeightPartial.sourceCoverage.find((coverage) =>
  coverage.sourceId === "observed-call"
)!;
assert.equal(sameHeightCoverage.completeThroughBlock, SOURCE.number);
assert.equal(
  sameHeightCoverage.status,
  "partial",
  "same-height success from an earlier round cannot mask this round's partial scan",
);

let omitTerminal = false;
const missingTerminalHarness = harness({
  reattestor: Object.freeze({
    async reattest(input: AdapterFamilyShadowReattestationInput) {
      return fakeReattestor({
        omitTerminalSourceId: omitTerminal ? "observed-call" : undefined,
      }).reattest(input);
    },
  }),
});
await missingTerminalHarness.ingress.run({
  sourceScans: sealedScans(missingTerminalHarness.inputIssuer, {
    source: SOURCE_9,
    observedFrom: 0,
  }),
  bootstrap: sealedBootstrap(missingTerminalHarness.inputIssuer, [], SOURCE_9),
  ancestryProofs: [],
});
omitTerminal = true;
const missingTerminal = await missingTerminalHarness.ingress.run({
  sourceScans: sealedScans(missingTerminalHarness.inputIssuer, {
    observedFrom: 10,
  }),
  bootstrap: sealedBootstrap(missingTerminalHarness.inputIssuer, []),
  ancestryProofs: [ancestryProof(missingTerminalHarness, SOURCE_9)],
});
assert.equal(
  missingTerminal.sourceCoverage.find((coverage) =>
    coverage.sourceId === "observed-call"
  )?.completeThroughBlock,
  9,
  "missing per-candidate terminal coverage cannot advance",
);

const foreignTerminalHarness = harness({
  seeds: [watermarkSeed({
    sourceId: "observed-call",
    block: 9,
    hash: PRIOR_HASH,
  })],
  reattestor: fakeReattestor({ foreignTerminalSourceId: "observed-call" }),
});
const foreignTerminal = await foreignTerminalHarness.ingress.run({
  sourceScans: sealedScans(foreignTerminalHarness.inputIssuer, {
    observedFrom: 10,
  }),
  bootstrap: sealedBootstrap(foreignTerminalHarness.inputIssuer, []),
  ancestryProofs: [ancestryProof(foreignTerminalHarness, {
    number: 9,
    hash: PRIOR_HASH,
  })],
});
assert(
  foreignTerminal.issues.some((issue) =>
    issue.code === "reattest-invalid-result"
  ),
);

const missingSurfaceHarness = harness();
const missingSurface = await missingSurfaceHarness.ingress.run({
  sourceScans: sealedScans(missingSurfaceHarness.inputIssuer),
  bootstrap: sealedBootstrap(missingSurfaceHarness.inputIssuer, [{
    incumbentKey: "legacy:missing",
    address: WSTETH,
    currentSurface: null,
  }]),
  ancestryProofs: [],
});
assert.equal(missingSurface.status, "shadow-partial");
assert.equal(
  missingSurface.bootstrap.incumbents[0]?.status,
  "missing-current-surface",
);
assert.equal(
  missingSurface.sourceCoverage.find((coverage) =>
    coverage.sourceId === "observed-call"
  )?.completeThroughBlock,
  10,
  "a sealed multi-block contiguous 0..10 backfill establishes history coverage",
);

const partialBootstrapHarness = harness({
  reattestor: fakeReattestor({ partialSourceId: "address-surface" }),
});
const partialBootstrap = await partialBootstrapHarness.ingress.run({
  sourceScans: sealedScans(partialBootstrapHarness.inputIssuer),
  bootstrap: sealedBootstrap(partialBootstrapHarness.inputIssuer, [{
    incumbentKey: "legacy:partial",
    address: WSTETH,
    currentSurface: surfaceObservation(),
  }]),
  ancestryProofs: [],
});
assert.equal(partialBootstrap.bootstrap.families[0]?.status, "partial");
assert.equal(
  partialBootstrap.sourceCoverage.find((coverage) =>
    coverage.sourceId === "address-surface"
  )?.status,
  "partial",
  "partial bootstrap re-attestation must downgrade current source coverage",
);

const throwingBootstrapHarness = harness({
  reattestor: fakeReattestor({ throwSourceId: "address-surface" }),
});
const throwingBootstrap = await throwingBootstrapHarness.ingress.run({
  sourceScans: sealedScans(throwingBootstrapHarness.inputIssuer),
  bootstrap: sealedBootstrap(throwingBootstrapHarness.inputIssuer, [{
    incumbentKey: "legacy:throw",
    address: WSTETH,
    currentSurface: surfaceObservation(),
  }]),
  ancestryProofs: [],
});
assert.equal(throwingBootstrap.bootstrap.families[0]?.status, "partial");
assert(
  throwingBootstrap.issues.some((issue) => issue.code === "reattest-threw"),
);
assert.equal(
  throwingBootstrap.sourceCoverage.find((coverage) =>
    coverage.sourceId === "address-surface"
  )?.status,
  "partial",
  "thrown bootstrap re-attestation must downgrade current source coverage",
);

const positiveOnlyHarness = harness();
const positiveOnly = await positiveOnlyHarness.ingress.run({
  sourceScans: sealedScans(positiveOnlyHarness.inputIssuer, {
    observedFrom: 8,
    observedMode: "positive-only",
  }),
  bootstrap: sealedBootstrap(positiveOnlyHarness.inputIssuer, []),
  ancestryProofs: [],
});
assert.equal(
  positiveOnly.sourceCoverage.find((coverage) =>
    coverage.sourceId === "observed-call"
  )?.completeThroughBlock,
  -1,
);

const staleFenceHarness = harness({ staleFence: true });
const beforeStale = staleFenceHarness.ingress.watermarkSnapshot();
await assert.rejects(
  () => staleFenceHarness.ingress.run({
    sourceScans: sealedScans(staleFenceHarness.inputIssuer),
    bootstrap: sealedBootstrap(staleFenceHarness.inputIssuer, []),
    ancestryProofs: [],
  }),
  /fixture stale generation/,
);
assert.deepEqual(
  staleFenceHarness.ingress.watermarkSnapshot(),
  beforeStale,
  "the required post-async fence prevents every watermark write",
);
assert.equal(staleFenceHarness.fenceCalls.length, 1);

const seedOwner = harness();
const otherOwner = harness({ registry: "strict-source-registry-v2" });
assert.throws(
  () => new AdapterFamilyObservationShadowIngress({
    catalog: otherOwner.catalog,
    reattestor: fakeReattestor(),
    generationFence: { assertCurrent() {} },
    inputAuthority: otherOwner.inputIssuer.authority,
    ancestryAuthority: otherOwner.ancestryIssuer.authority,
    initialWatermarks: [seedOwner.inputIssuer.sealWatermarkSeed(
      watermarkSeed({ sourceId: "observed-call", block: 9, hash: PRIOR_HASH }),
    )],
  }),
  /not issued by this ingress authority/,
  "seed receipts bind catalog, chain and source registry authority",
);

console.log("adapter-family-observation-shadow-ingress PASS");
