import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  defineProtocolFamily,
  definedFamilyPluginContractSummary,
  type FamilyOwnedActionAdapter,
  type ProtocolFamilyPlugin,
} from "../venues/adapter-family-plugin.js";
import {
  familyId,
  instanceKey,
  lineageId,
  routeKey,
} from "../venues/adapter-family-identifiers.js";
import { bindFamilyOwnedAction } from "../venues/family-owned-action.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
  type GeneratedCapabilityManifest,
} from "../venues/family-capability-catalog.js";

const ADDRESS = `0x${"11".repeat(20)}`;
const TOKEN0 = `0x${"22".repeat(20)}`;
const TOKEN1 = `0x${"33".repeat(20)}`;
const SOURCE_HASH = `0x${"44".repeat(32)}` as `0x${string}`;
const SELECTOR = "0x12345678" as const;

function defineFixture(
  familyName: string,
  actionId: string,
  addressSurface?: {
    readonly id: string;
    readonly kind: "proxy-implementation";
    readonly fingerprint: string;
  },
) {
  const family = familyId(familyName);
  const lineage = lineageId(`${familyName}:standalone`);
  const action = fixtureAction(actionId);
  const definition: ProtocolFamilyPlugin<
    { readonly candidateKind: "fixture"; readonly address: string },
    {
      readonly familyId: typeof family;
      readonly lineageId: typeof lineage;
      readonly subject: string;
      readonly provenance: readonly [];
    },
    {
      readonly familyId: typeof family;
      readonly lineageId: typeof lineage;
      readonly instanceKey: ReturnType<typeof instanceKey>;
      readonly provenance: readonly [];
      readonly runtimeRequirements: readonly [];
      readonly address: string;
    },
    {
      readonly routeKey: ReturnType<typeof routeKey>;
      readonly familyId: typeof family;
      readonly lineageId: typeof lineage;
      readonly instanceKey: ReturnType<typeof instanceKey>;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly taxonomy: {
        readonly slotKind: "protocol";
        readonly protocolAction: "convert";
      };
      readonly bindingRef: {
        readonly bindingKey: string;
        readonly fingerprint: string;
      };
      readonly runtimeRequirements: readonly [];
    },
    { readonly address: string },
    { readonly amountOut: bigint },
    { readonly witness: string }
  > = {
    manifest: {
      familyId: family,
      domain: "protocol",
      ownedActionAdapterIds: [actionId],
      requiredInfraActionAdapterIds: [],
      allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
      supportedLineages: [lineage],
    },
    discovery: {
      evidenceChannel: "tx-evidence" as const,
      sources: addressSurface === undefined
        ? ["observed-call"]
        : ["observed-call", "address-surface"],
      callPatterns: [{
        id: "convert-call",
        selector: SELECTOR,
        signature: "convert(uint256)",
        candidateAddress: { from: "call-target" },
      }],
      ...(addressSurface === undefined
        ? {}
        : { addressSurfaces: [addressSurface] }),
      decodeCandidate: ({ observation }) => observation.kind === "call"
        ? { candidateKind: "fixture", address: observation.target }
        : observation.kind === "address-surface"
        ? { candidateKind: "fixture", address: observation.address }
        : null,
      candidateKey: (candidate) => candidate.address,
    },
    identity: {
      variants: [{
        id: "standalone",
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
            subject: candidate.address,
            provenance: [],
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
        provenance: [],
        runtimeRequirements: [],
        address: identity.subject,
      }),
      finalizeDescriptor: ({ draft }) => draft,
      staticBindingProjection: (descriptor) => ({
        address: descriptor.address,
      }),
    },
    routes: {
      project: ({ descriptor }) => [{
        routeKey: routeKey(`${descriptor.address}:convert`),
        familyId: family,
        lineageId: lineage,
        instanceKey: descriptor.instanceKey,
        tokenIn: TOKEN0,
        tokenOut: TOKEN1,
        taxonomy: { slotKind: "protocol", protocolAction: "convert" },
        bindingRef: {
          bindingKey: descriptor.address,
          fingerprint: "binding-v1",
        },
        runtimeRequirements: [],
      }],
      projectGraph: ({ descriptor, route }) => ({
        routeActionAdapterId: actionId,
        executionTarget: descriptor.address,
        venueIdentity: { target: descriptor.address.toLowerCase() },
        centralScoreKey: route.routeKey,
      }),
    },
    pricing: {
      stateKey: (route) => route.instanceKey,
      staticBindingProjection: ({ descriptor }) => ({
        address: descriptor.address,
      }),
      snapshotCompatibilityProjection: ({ descriptor }) => ({
        address: descriptor.address,
      }),
      compileDraft: ({ descriptor }) => ({ address: descriptor.address }),
      finalizePricingDescriptor: ({ draft }) => draft,
      current: {
        requirements: () => ({ transports: [] }),
        buildRequests: () => [],
        decodeSnapshot: () => ({ amountOut: 1n }),
        deriveMids: () => new Map(),
      },
      dependencies: ({ descriptor }) => [descriptor.address],
    },
    exact: {
      methods: () => [Object.freeze({
        id: "local",
        kind: "local" as const,
        quote: ({ amountIn }) => Object.freeze({
          status: "quoted" as const,
          result: Object.freeze({
            amountOut: amountIn,
            evidence: { witness: "local" },
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
    protocol: {
      candidateKinds: ["observed-call", "standalone-contract"],
      activeBehaviorProof: "required",
    },
    actionAdapters: [action],
  };
  return defineProtocolFamily(definition);
}

function fixtureAction(id: string): FamilyOwnedActionAdapter {
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
      lineage: `custom-protocol:${id}`,
      edgeKind: "protocol",
      action: "convert",
      canSendValue: false,
      leavesStandingPositionDefault: false,
    },
  });
}

function manifestFor(
  plugins: readonly ReturnType<typeof defineFixture>[],
): GeneratedCapabilityManifest {
  const entries: GeneratedCapabilityIdentity[] = plugins.flatMap((plugin) =>
    FAMILY_CAPABILITY_NAMES.map((capability) => ({
      familyId: plugin.manifest.familyId,
      capability,
      contractVersion: "s1-v1",
      contentHash: createHash("sha256")
        .update(`${plugin.manifest.familyId}/${capability}`)
        .digest("hex"),
      semanticDependencies: [`contract:${capability}`, "shared:canonical-value"]
        .sort(),
      provenanceCommit: "a".repeat(40),
    }))
  );
  return {
    format: "adapter-family-capabilities-v1",
    entries,
    manifestHash: capabilityManifestHash(entries),
  };
}

function moduleFor(
  plugin: ReturnType<typeof defineFixture>,
  sourceFile: string,
) {
  return {
    sourceFile,
    definitionBoundaryHash:
      definedFamilyPluginContractSummary(plugin).definitionBoundaryHash,
    plugin,
  };
}

const alpha = defineFixture("protocol:alpha", "alpha-convert");
const beta = defineFixture("protocol:beta", "beta-convert");
const manifest = manifestFor([alpha, beta]);
const catalog = new FamilyCapabilityCatalog({
  modules: [moduleFor(beta, "beta.production.ts"), moduleFor(
    alpha,
    "alpha.production.ts",
  )],
  generatedManifest: manifest,
});

assert.deepEqual(
  catalog.list().map((family) => family.plugin.manifest.familyId),
  ["protocol:alpha", "protocol:beta"],
);
assert.equal(catalog.ownerOfAction("alpha-convert"), "protocol:alpha");
assert.equal(
  catalog.forFamily(familyId("protocol:beta")).hashes.exact.contentHash,
  manifest.entries.find((entry) =>
    entry.familyId === "protocol:beta" && entry.capability === "exact"
  )?.contentHash,
);
assert.deepEqual(
  catalog.matches({
    kind: "call",
    source: { number: 1, hash: SOURCE_HASH, generation: 1 },
    target: ADDRESS,
    data: `${SELECTOR}${"00".repeat(32)}`,
  }),
  [
    { familyId: "protocol:alpha", patternId: "convert-call" },
    { familyId: "protocol:beta", patternId: "convert-call" },
  ],
  "selector collisions must nominate every matching Family",
);
assert.match(catalog.catalogHash, /^[0-9a-f]{64}$/);

const missingExact = manifest.entries.filter((entry) => !(
  entry.familyId === "protocol:alpha" && entry.capability === "exact"
));
assert.throws(
  () => new FamilyCapabilityCatalog({
    modules: [moduleFor(alpha, "alpha.production.ts"), moduleFor(
      beta,
      "beta.production.ts",
    )],
    generatedManifest: {
      ...manifest,
      entries: missingExact,
      manifestHash: capabilityManifestHash(missingExact),
    },
  }),
  /missing protocol:alpha\/exact/,
);

assert.throws(
  () => new FamilyCapabilityCatalog({
    modules: [moduleFor(alpha, "alpha.production.ts"), moduleFor(
      beta,
      "beta.production.ts",
    )],
    generatedManifest: { ...manifest, manifestHash: "0".repeat(64) },
  }),
  /manifest hash is stale or invalid/,
);

assert.throws(
  () => new FamilyCapabilityCatalog({
    modules: [{
      ...moduleFor(alpha, "alpha.production.ts"),
      definitionBoundaryHash: "0".repeat(64),
    }, moduleFor(beta, "beta.production.ts")],
    generatedManifest: manifest,
  }),
  /definition boundary hash does not match/,
);

const gamma = defineFixture("protocol:gamma", "alpha-convert");
assert.throws(
  () => new FamilyCapabilityCatalog({
    modules: [moduleFor(alpha, "alpha.production.ts"), moduleFor(
      gamma,
      "gamma.production.ts",
    )],
    generatedManifest: manifestFor([alpha, gamma]),
  }),
  /owned by both protocol:alpha and protocol:gamma/,
);

assert.throws(
  () => new FamilyCapabilityCatalog({
    modules: [moduleFor(alpha, "alpha.production.ts")],
    generatedManifest: manifest,
  }),
  /contains inactive Family protocol:beta/,
);

const proxy = defineFixture(
  "protocol:proxy-family",
  "proxy-convert",
  Object.freeze({
    id: "proxy-surface",
    kind: "proxy-implementation" as const,
    fingerprint: "proxy-label-v1",
  }),
);
const proxyCatalog = new FamilyCapabilityCatalog({
  modules: [
    moduleFor(alpha, "alpha.production.ts"),
    moduleFor(proxy, "proxy.production.ts"),
  ],
  generatedManifest: manifestFor([alpha, proxy]),
});
const NON_ZERO_IMPL = `0x${"00".repeat(12)}${"11".repeat(20)}`;
assert.deepEqual(
  proxyCatalog.matches({
    kind: "address-surface",
    source: { number: 1, hash: SOURCE_HASH, generation: 1 },
    address: ADDRESS,
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: NON_ZERO_IMPL,
  }),
  [{ familyId: "protocol:proxy-family", patternId: "proxy-surface" }],
  "a non-zero implementation word must match proxy-implementation surfaces",
);
assert.deepEqual(
  proxyCatalog.matches({
    kind: "address-surface",
    source: { number: 1, hash: SOURCE_HASH, generation: 1 },
    address: ADDRESS,
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
  }),
  [],
  "a zero implementation word must not match a proxy-implementation surface",
);

console.log(
  "family-capability-catalog PASS " +
    "(generated hashes + multi-value indexes + ownership + proxy address surfaces + fail-closed drift)",
);
