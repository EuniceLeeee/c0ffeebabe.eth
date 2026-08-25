import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dodoV2ActionAdapter } from "../../adapters/dodo-v2.js";
import { dodoV2Adapter } from "../venues/swaps/dodo-v2.js";
import { univ2StandardAdapter } from "../venues/swaps/univ2-standard.js";
import {
  defineSwapFamily,
  explicitReverseBindingUnsupported,
  type CompiledInstanceDescriptor,
  type FamilyCandidate,
  type FamilyOwnedActionAdapter,
  type FamilyRouteDescriptor,
  type SwapFamilyPlugin,
  type VerifiedIdentity,
} from "../venues/adapter-family-plugin.js";
import {
  familyId,
  instanceKey,
  lineageId,
  routeKey,
  type FamilyId,
  type LineageId,
} from "../venues/adapter-family-identifiers.js";
import { bindFamilyOwnedAction } from "../venues/family-owned-action.js";
import {
  defineProductionFamilyModule,
} from "../venues/production-families/contract.js";
import {
  assertCompleteProductionFamilyLoad,
  loadProductionFamilyModules,
} from "../venues/production-families/loader.js";
import type { AdapterFamily } from "../venues/route-leg-adapter.js";

interface LoaderCandidate extends FamilyCandidate {
  readonly candidateKind: "loader-pool";
  readonly pool: string;
}

interface LoaderIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly subject: string;
}

interface LoaderDescriptor extends CompiledInstanceDescriptor {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
}

interface LoaderPricingDescriptor {
  readonly pool: string;
}

interface LoaderPricingSnapshot {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

interface LoaderExactEvidence {
  readonly witness: string;
}

interface StrictDefinitionOptions {
  readonly familyIdValue?: string;
  readonly actionId?: string;
  readonly patternId?: string;
}

const HASH = `0x${"11".repeat(32)}` as `0x${string}`;
const POOL = `0x${"22".repeat(20)}`;
const TOKEN0 = `0x${"33".repeat(20)}`;
const TOKEN1 = `0x${"44".repeat(20)}`;

function strictAction(id: string): FamilyOwnedActionAdapter {
  return bindFamilyOwnedAction({
    action: {
      id,
      isWrapper: false,
      field2Offset: null,
      encode: () => new Uint8Array(),
      matchTrace: () => false,
    },
    descriptor: {
      adapterId: id,
      lineage: "custom-swap:loader-test",
      edgeKind: "swap",
      action: "swap",
      canSendValue: false,
      leavesStandingPositionDefault: false,
    },
  });
}

function strictDefinition(
  options: StrictDefinitionOptions = {},
): SwapFamilyPlugin<
  LoaderCandidate,
  LoaderIdentity,
  LoaderDescriptor,
  FamilyRouteDescriptor,
  LoaderPricingDescriptor,
  LoaderPricingSnapshot,
  LoaderExactEvidence
> {
  const familyIdValue = options.familyIdValue ?? "swap:loader-test";
  const actionId = options.actionId ?? "strict-loader-swap";
  const patternId = options.patternId ?? "loader-swap";
  const family = familyId(familyIdValue);
  const lineage = lineageId(`${familyIdValue}:standalone`);
  return {
    manifest: {
      familyId: family,
      domain: "swap",
      ownedActionAdapterIds: [actionId],
      requiredInfraActionAdapterIds: ["erc20-transfer"],
      allowedTaxonomy: [{ slotKind: "swap" }],
      supportedLineages: [lineage],
    },
    discovery: {
      evidenceChannel: "tx-evidence" as const,
      sources: ["landed-log"],
      reverseBinding: explicitReverseBindingUnsupported(
        "synthetic loader fixture has no retained chain identity",
      ),
      logPatterns: [{
        id: patternId,
        topic: HASH,
        signature: "Swap(address,uint256)",
      }],
      decodeCandidate: () => ({
        candidateKind: "loader-pool",
        pool: POOL,
      }),
      candidateKey: (candidate) => candidate.pool,
    },
    identity: {
      variants: [{
        id: "loader-standalone",
        kind: "standalone-contract",
        lineageId: lineage,
        applies: () => true,
        requirements: () => ({ transports: [] }),
        buildRequests: () => [],
        decode: () => undefined,
        decide: ({ candidate }) => ({
          status: "verified",
          identity: {
            familyId: family,
            lineageId: lineage,
            subject: candidate.pool,
            provenance: [{ kind: "loader-fixture", subject: candidate.pool }],
          },
        }),
      }],
      identityKey: (identity) => identity.subject,
    },
    instance: {
      instanceKey: (identity) => instanceKey(identity.subject),
      compileDraft: (identity) => ({
        familyId: family,
        lineageId: lineage,
        instanceKey: instanceKey(identity.subject),
        provenance: identity.provenance,
        runtimeRequirements: [],
        pool: identity.subject,
        token0: TOKEN0,
        token1: TOKEN1,
      }),
      finalizeDescriptor: ({ draft }) => draft,
      staticBindingProjection: (descriptor) => ({
        pool: descriptor.pool,
        token0: descriptor.token0,
        token1: descriptor.token1,
      }),
    },
    routes: {
      project: ({ descriptor }) => [{
        routeKey: routeKey(`${descriptor.pool}:0-1`),
        familyId: descriptor.familyId,
        lineageId: descriptor.lineageId,
        instanceKey: descriptor.instanceKey,
        tokenIn: descriptor.token0,
        tokenOut: descriptor.token1,
        taxonomy: { slotKind: "swap" },
        bindingRef: {
          bindingKey: descriptor.pool,
          fingerprint: "loader-binding-v1",
        },
        runtimeRequirements: [],
      }],
      projectGraph: ({ descriptor, route }) => ({
        routeActionAdapterId: actionId,
        executionTarget: descriptor.pool,
        venueIdentity: { pool: descriptor.pool.toLowerCase() },
        centralScoreKey: route.routeKey,
      }),
    },
    pricing: {
      stateKey: (route) => route.instanceKey,
      staticBindingProjection: ({ descriptor }) => ({ pool: descriptor.pool }),
      snapshotCompatibilityProjection: ({ routes }) => ({
        routes: routes.map((route) => route.routeKey),
      }),
      compileDraft: ({ descriptor }) => ({ pool: descriptor.pool }),
      finalizePricingDescriptor: ({ draft }) => draft,
      current: {
        requirements: () => ({ transports: ["eth-call"] }),
        buildRequests: () => [],
        decodeSnapshot: () => ({ reserve0: 1n, reserve1: 1n }),
        deriveMids: () => new Map(),
      },
      dependencies: ({ descriptor }) => [descriptor.pool],
    },
    exact: {
      methods: () => [Object.freeze({
        id: "local",
        kind: "local" as const,
        quote: ({ amountIn }) => Object.freeze({
          status: "quoted" as const,
          result: Object.freeze({
            amountOut: amountIn,
            evidence: { witness: "loader" },
          }),
        }),
      })],
      cacheCompatibilityProjection: ({ route }) => ({
        routeKey: route.routeKey,
      }),
    },
    execution: {
      runtimeProjection: () => ({
        allowanceSpender: null,
        prewarmQuoteCalls: [],
      }),
      buildFragment: () => ({ requirements: [], nodes: [] }),
      expectedEffects: () => [],
    },
    actionAdapters: [strictAction(actionId)],
    swap: {
      landedEvents: {
        patternIds: [patternId],
        classify: () => "swap",
      },
      observation: {
        patternIds: [patternId],
        decode: () => [{ kind: "swap", canonicalPayload: { ok: true } }],
      },
      receiptObservation: {
        topics: [HASH],
        canonicalIntakeTargets: [],
        observedPoolIdentity: () => null,
        decodeReceiptImpacts: async () => ({ status: "no-match" }),
      },
      victimSupport: "none",
    },
  };
}

function strictPlugin(options: StrictDefinitionOptions = {}) {
  return defineSwapFamily(strictDefinition(options));
}

async function loadFixture(
  entries: Readonly<Record<string, unknown>>,
  baseFamilies: readonly AdapterFamily[] = [univ2StandardAdapter],
) {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "mev-strict-families-"));
  try {
    await Promise.all(
      Object.keys(entries).map((name) => writeFile(join(sourceDirectory, name), "")),
    );
    return await loadProductionFamilyModules(baseFamilies, {
      sourceDirectory,
      async importEntry(sourceFile) {
        assert(Object.prototype.hasOwnProperty.call(entries, sourceFile));
        return entries[sourceFile];
      },
    });
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
  }
}

const validModule = defineProductionFamilyModule({
  family: dodoV2Adapter,
  actionAdapters: [Object.freeze({
    ...dodoV2ActionAdapter,
    descriptor: Object.freeze({
      adapterId: dodoV2ActionAdapter.id,
      lineage: "dodo-v2",
      edgeKind: "swap",
      action: "swap",
      canSendValue: false,
      leavesStandingPositionDefault: false,
    }),
  })],
});

const wrongTaxonomyAction = Object.freeze({
  ...dodoV2ActionAdapter,
  descriptor: Object.freeze({
    adapterId: dodoV2ActionAdapter.id,
    lineage: "dodo-v2",
    edgeKind: "protocol" as const,
    action: "swap" as const,
    canSendValue: false,
    leavesStandingPositionDefault: false,
  }),
});
assert.throws(
  () => defineProductionFamilyModule({
    family: dodoV2Adapter,
    actionAdapters: [wrongTaxonomyAction],
  }),
  /descriptor edgeKind protocol does not match family kind swap/,
);

const directory = await mkdtemp(join(tmpdir(), "mev-production-families-"));
try {
  for (const name of [
    "a-valid.production.ts",
    "b-invalid.production.ts",
    "c-import-failure.production.ts",
    "d-conflict.production.ts",
    "e-timeout.production.ts",
    "f-wrong-taxonomy.production.ts",
    "g-raw-structural.production.ts",
    "h-spread-copy.production.ts",
    "ignored.ts",
  ]) {
    await writeFile(join(directory, name), "");
  }

  const result = await loadProductionFamilyModules(
    [univ2StandardAdapter],
    {
      sourceDirectory: directory,
      importTimeoutMs: 20,
      async importEntry(sourceFile) {
        switch (sourceFile) {
          case "a-valid.production.ts":
          case "d-conflict.production.ts":
            return { productionFamilyModule: validModule };
          case "b-invalid.production.ts":
            return { productionFamilyModule: { family: dodoV2Adapter } };
          case "c-import-failure.production.ts":
            throw new Error("synthetic import failure");
          case "e-timeout.production.ts":
            return await new Promise<never>(() => {});
          case "f-wrong-taxonomy.production.ts":
            return {
              productionFamilyModule: {
                family: dodoV2Adapter,
                actionAdapters: [wrongTaxonomyAction],
              },
            };
          case "g-raw-structural.production.ts":
            return {
              productionFamilyModule: {
                family: validModule.family,
                actionAdapters: validModule.actionAdapters,
              },
            };
          case "h-spread-copy.production.ts":
            return { productionFamilyModule: { ...validModule } };
          default:
            throw new Error(`unexpected source ${sourceFile}`);
        }
      },
    },
  );

  assert.deepEqual(
    result.modules.map((module) => module.family.id),
    ["custom-swap:dodo-v2"],
  );
  assert.deepEqual(
    result.issues.map((issue) => [issue.sourceFile, issue.code]),
    [
      ["b-invalid.production.ts", "invalid_module_contract"],
      ["c-import-failure.production.ts", "module_import_failed"],
      ["d-conflict.production.ts", "family_registration_conflict"],
      ["e-timeout.production.ts", "module_import_timeout"],
      ["f-wrong-taxonomy.production.ts", "invalid_module_contract"],
      ["g-raw-structural.production.ts", "invalid_module_contract"],
      ["h-spread-copy.production.ts", "invalid_module_contract"],
    ],
  );
  assert.match(result.scanSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.modules[0]?.contractKind, "legacy-production-module");
  assert.match(
    result.modules[0]?.activationContractHash ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.throws(
    () => assertCompleteProductionFamilyLoad(result),
    /production family activation is incomplete/,
  );
  assert.doesNotThrow(() => assertCompleteProductionFamilyLoad({
    ...result,
    issues: [],
  }));
  console.log("production-family-loader PASS (static root + isolated failures)");
} finally {
  await rm(directory, { recursive: true, force: true });
}

const brandedPlugin = strictPlugin({
  familyIdValue: "swap:loader-branded",
  actionId: "strict-loader-branded-swap",
});
const spreadSourcePlugin = strictPlugin({
  familyIdValue: "swap:loader-spread-source",
  actionId: "strict-loader-spread-swap",
});
const strictContractResult = await loadFixture({
  "a-branded.production.ts": { plugin: brandedPlugin },
  "b-raw-structural.production.ts": {
    plugin: strictDefinition({
      familyIdValue: "swap:loader-raw",
      actionId: "strict-loader-raw-swap",
    }),
  },
  "c-spread-copy.production.ts": { plugin: { ...spreadSourcePlugin } },
  "d-both-exports.production.ts": {
    plugin: strictPlugin({
      familyIdValue: "swap:loader-both",
      actionId: "strict-loader-both-swap",
    }),
    productionFamilyModule: validModule,
  },
});
assert.deepEqual(strictContractResult.modules, []);
assert.deepEqual(
  strictContractResult.plugins.map((entry) => entry.familyId),
  ["swap:loader-branded"],
);
assert.equal(strictContractResult.plugins[0]?.plugin, brandedPlugin);
assert.equal(
  strictContractResult.plugins[0]?.contractKind,
  "defined-family-plugin",
);
assert.match(
  strictContractResult.plugins[0]?.definitionBoundaryHash ?? "",
  /^[a-f0-9]{64}$/,
);
assert.deepEqual(
  strictContractResult.issues.map((issue) => [issue.sourceFile, issue.code]),
  [
    ["b-raw-structural.production.ts", "invalid_module_contract"],
    ["c-spread-copy.production.ts", "invalid_module_contract"],
    ["d-both-exports.production.ts", "invalid_module_contract"],
  ],
);

const strictLegacyFamilyId = "swap:loader-legacy-conflict";
const legacyConflictAction = strictAction("legacy-loader-conflict-swap");
const legacyConflictFamily = Object.freeze({
  ...dodoV2Adapter,
  id: strictLegacyFamilyId,
  ownedActionAdapterIds: [legacyConflictAction.id],
}) as unknown as AdapterFamily;
const legacyConflictModule = defineProductionFamilyModule({
  family: legacyConflictFamily,
  actionAdapters: [legacyConflictAction],
});
const strictLegacyConflictResult = await loadFixture({
  "a-strict.production.ts": {
    plugin: strictPlugin({
      familyIdValue: strictLegacyFamilyId,
      actionId: "strict-loader-conflict-swap",
    }),
  },
  "b-legacy.production.ts": { productionFamilyModule: legacyConflictModule },
});
assert.deepEqual(
  strictLegacyConflictResult.plugins.map((entry) => entry.familyId),
  [strictLegacyFamilyId],
);
assert.deepEqual(strictLegacyConflictResult.modules, []);
assert.deepEqual(
  strictLegacyConflictResult.issues.map((issue) => [issue.sourceFile, issue.code]),
  [["b-legacy.production.ts", "family_registration_conflict"]],
);

const strictBaseFamilyId = "swap:loader-base-conflict";
const syntheticBaseFamily = Object.freeze({
  ...univ2StandardAdapter,
  id: strictBaseFamilyId,
}) as unknown as AdapterFamily;
const strictBaseFamilyConflictResult = await loadFixture({
  "base-family-conflict.production.ts": {
    plugin: strictPlugin({
      familyIdValue: strictBaseFamilyId,
      actionId: "strict-loader-base-family-swap",
    }),
  },
}, [syntheticBaseFamily]);
assert.deepEqual(strictBaseFamilyConflictResult.plugins, []);
assert.deepEqual(
  strictBaseFamilyConflictResult.issues.map((issue) => [issue.sourceFile, issue.code]),
  [["base-family-conflict.production.ts", "family_registration_conflict"]],
);

const strictActionConflictResult = await loadFixture({
  "a-action-owner.production.ts": {
    plugin: strictPlugin({
      familyIdValue: "swap:loader-action-owner-a",
      actionId: "strict-loader-shared-action",
    }),
  },
  "b-action-owner.production.ts": {
    plugin: strictPlugin({
      familyIdValue: "swap:loader-action-owner-b",
      actionId: "strict-loader-shared-action",
    }),
  },
});
assert.deepEqual(
  strictActionConflictResult.plugins.map((entry) => entry.familyId),
  ["swap:loader-action-owner-a"],
);
assert.deepEqual(
  strictActionConflictResult.issues.map((issue) => [issue.sourceFile, issue.code]),
  [["b-action-owner.production.ts", "family_registration_conflict"]],
);

const strictBaseActionConflictResult = await loadFixture({
  "base-action-conflict.production.ts": {
    plugin: strictPlugin({
      familyIdValue: "swap:loader-base-action-conflict",
      actionId: "univ2-swap",
    }),
  },
});
assert.deepEqual(strictBaseActionConflictResult.plugins, []);
assert.deepEqual(
  strictBaseActionConflictResult.issues.map((issue) => [issue.sourceFile, issue.code]),
  [["base-action-conflict.production.ts", "family_registration_conflict"]],
);

const hashAResult = await loadFixture({
  "definition-hash.production.ts": {
    plugin: strictPlugin({
      familyIdValue: "swap:loader-definition-hash",
      actionId: "strict-loader-definition-hash-swap",
      patternId: "definition-hash-a",
    }),
  },
});
const hashBResult = await loadFixture({
  "definition-hash.production.ts": {
    plugin: strictPlugin({
      familyIdValue: "swap:loader-definition-hash",
      actionId: "strict-loader-definition-hash-swap",
      patternId: "definition-hash-b",
    }),
  },
});
assert.equal(hashAResult.issues.length, 0);
assert.equal(hashBResult.issues.length, 0);
assert.notEqual(
  hashAResult.plugins[0]?.definitionBoundaryHash,
  hashBResult.plugins[0]?.definitionBoundaryHash,
);
assert.notEqual(hashAResult.scanSha256, hashBResult.scanSha256);

console.log(
  "production-family-loader strict PASS " +
    "(brand + mixed-boundary conflicts + definition hash)",
);
