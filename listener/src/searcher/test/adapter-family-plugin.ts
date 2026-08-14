import assert from "node:assert/strict";
import type { ActionAdapter } from "../../types.js";
import {
  assertDefinedFamilyPlugin,
  defineProtocolFamily,
  defineSwapFamily,
  definedFamilyPluginContractSummary,
  type AdapterFamilyCore,
  type CompiledInstanceDescriptor,
  type FamilyCandidate,
  type FamilyCaptureDescriptor,
  type FamilyCaptureVector,
  type FamilyManifest,
  type FamilyOwnedActionAdapter,
  type FamilyRouteDescriptor,
  type ProtocolFamilyPlugin,
  type SwapFamilyPlugin,
  type UnifiedObservation,
  type VerifiedIdentity,
} from "../venues/adapter-family-plugin.js";
import {
  familyId,
  instanceKey,
  lineageId,
  routeKey,
  type FamilyId,
  type InstanceKey,
  type LineageId,
} from "../venues/adapter-family-identifiers.js";
import { bindFamilyOwnedAction } from "../venues/family-owned-action.js";

interface TestCandidate extends FamilyCandidate {
  readonly candidateKind: "test-pool";
  readonly pool: string;
}

interface TestIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly subject: string;
}

interface TestDescriptor extends CompiledInstanceDescriptor {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
}

interface TestRoute extends FamilyRouteDescriptor {
  readonly direction: "zero-to-one";
}

interface TestPricingDescriptor {
  readonly pool: string;
}

interface TestPricingSnapshot {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

interface TestExactEvidence {
  readonly witness: string;
}

type TestCore = AdapterFamilyCore<
  TestCandidate,
  TestIdentity,
  TestDescriptor,
  TestRoute,
  TestPricingDescriptor,
  TestPricingSnapshot,
  TestExactEvidence
>;

const HASH = `0x${"11".repeat(32)}` as `0x${string}`;
const ADDRESS = `0x${"22".repeat(20)}`;
const TOKEN0 = `0x${"33".repeat(20)}`;
const TOKEN1 = `0x${"44".repeat(20)}`;

function actionAdapter(input: {
  readonly id: string;
  readonly edgeKind: "swap" | "protocol";
}): FamilyOwnedActionAdapter {
  return bindFamilyOwnedAction({
    action: {
      id: input.id,
      isWrapper: false,
      field2Offset: null,
      encode: () => new Uint8Array(),
      matchTrace: () => false,
    },
    descriptor: {
      adapterId: input.id,
      lineage: input.edgeKind === "swap"
        ? "custom-swap:test-terminal"
        : "custom-protocol:test-terminal",
      edgeKind: input.edgeKind,
      action: input.edgeKind === "swap" ? "swap" : "convert",
      canSendValue: false,
      leavesStandingPositionDefault: false,
    },
  });
}

function core(input: {
  readonly family: FamilyId;
  readonly lineage: LineageId;
  readonly taxonomy: FamilyManifest<"swap" | "protocol">["allowedTaxonomy"][number];
  readonly actionId: string;
  readonly edgeKind: "swap" | "protocol";
  readonly source: "landed-log" | "observed-call";
}): TestCore {
  const observationPattern = input.edgeKind === "swap"
    ? {
        sources: [input.source],
        evidenceChannel: "tx-evidence" as const,
        logPatterns: [{
          id: "test-observation",
          topic: HASH,
          signature: "Swap(address,uint256)",
        }],
      }
    : {
        sources: [input.source],
        evidenceChannel: "tx-evidence" as const,
        callPatterns: [{
          id: "test-observation",
          selector: "0x12345678" as const,
          signature: "convert(uint256)",
          candidateAddress: { from: "call-target" as const },
        }],
      };
  return {
    discovery: {
      ...observationPattern,
      decodeCandidate: () => ({
        candidateKind: "test-pool",
        pool: ADDRESS,
      }),
      candidateKey: (candidate) => candidate.pool,
    },
    identity: {
      variants: [{
        id: "verified-test-instance",
        kind: "standalone-contract",
        lineageId: input.lineage,
        applies: () => true,
        requirements: () => ({ transports: [] }),
        buildRequests: () => [],
        decode: () => undefined,
        decide: ({ candidate }) => ({
          status: "verified",
          identity: {
            familyId: input.family,
            lineageId: input.lineage,
            subject: candidate.pool,
            provenance: [{ kind: "fixture", subject: candidate.pool }],
          },
        }),
      }],
      identityKey: (identity) => identity.subject,
    },
    instance: {
      instanceKey: (identity): InstanceKey => instanceKey(identity.subject),
      compileDraft: (identity) => ({
        familyId: input.family,
        lineageId: input.lineage,
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
        taxonomy: input.taxonomy,
        bindingRef: { bindingKey: descriptor.pool, fingerprint: "binding-v1" },
        runtimeRequirements: [],
        direction: "zero-to-one",
      }],
      projectGraph: ({ descriptor, route }) => ({
        routeActionAdapterId: input.actionId,
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
    actionAdapters: [actionAdapter({
      id: input.actionId,
      edgeKind: input.edgeKind,
    })],
  };
}

function swapDefinition(): SwapFamilyPlugin<
  TestCandidate,
  TestIdentity,
  TestDescriptor,
  TestRoute,
  TestPricingDescriptor,
  TestPricingSnapshot,
  TestExactEvidence
> {
  const family = familyId("univ3-standard");
  const lineage = lineageId("test:swap-standalone");
  return {
    manifest: {
      familyId: family,
      domain: "swap",
      ownedActionAdapterIds: ["test-swap"],
      requiredInfraActionAdapterIds: ["erc20-approve"],
      allowedTaxonomy: [{ slotKind: "swap" }],
      supportedLineages: [lineage],
    },
    ...core({
      family,
      lineage,
      taxonomy: { slotKind: "swap" },
      actionId: "test-swap",
      edgeKind: "swap",
      source: "landed-log",
    }),
    swap: {
      landedEvents: {
        patternIds: ["test-observation"],
        classify: () => "swap",
      },
      observation: {
        patternIds: ["test-observation"],
        decode: () => [{ kind: "swap", canonicalPayload: { ok: true } }],
      },
      victimSupport: "none",
    },
  };
}

function protocolDefinition(): ProtocolFamilyPlugin<
  TestCandidate,
  TestIdentity,
  TestDescriptor,
  TestRoute,
  TestPricingDescriptor,
  TestPricingSnapshot,
  TestExactEvidence
> {
  const family = familyId("protocol:test-terminal");
  const lineage = lineageId("test:protocol-standalone");
  return {
    manifest: {
      familyId: family,
      domain: "protocol",
      ownedActionAdapterIds: ["test-convert"],
      requiredInfraActionAdapterIds: ["erc20-approve"],
      allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
      supportedLineages: [lineage],
    },
    ...core({
      family,
      lineage,
      taxonomy: { slotKind: "protocol", protocolAction: "convert" },
      actionId: "test-convert",
      edgeKind: "protocol",
      source: "observed-call",
    }),
    protocol: {
      candidateKinds: ["observed-call", "standalone-contract"],
      activeBehaviorProof: "required",
    },
  };
}

if (false) {
  const swap = swapDefinition();
  const protocol = protocolDefinition();
  // @ts-expect-error Protocol plugins cannot enter the Swap constructor.
  defineSwapFamily(protocol);
  // @ts-expect-error Swap plugins cannot enter the Protocol constructor.
  defineProtocolFamily(swap);
  // @ts-expect-error A Swap plugin cannot expose both domain policies.
  defineSwapFamily({ ...swap, protocol: protocol.protocol });
  const { swap: _removedSwap, ...missingSwap } = swap;
  void _removedSwap;
  // @ts-expect-error Swap policy is mandatory for a Swap plugin.
  defineSwapFamily(missingSwap);
}

const rawSwap = swapDefinition();
assert.throws(
  () => assertDefinedFamilyPlugin(rawSwap),
  /defineSwapFamily or defineProtocolFamily/,
);

const definedSwap = defineSwapFamily(rawSwap);
assertDefinedFamilyPlugin(definedSwap);
assert(Object.isFrozen(definedSwap));
assert(Object.isFrozen(definedSwap.manifest));
assert(Object.isFrozen(definedSwap.manifest.supportedLineages));
assert(Object.isFrozen(definedSwap.identity.variants));
assert(Object.isFrozen(definedSwap.actionAdapters[0]));
assert(Object.isFrozen(definedSwap.actionAdapters[0].descriptor));
assert(Object.isFrozen(definedSwap.actionAdapters[0].encode));
assert.throws(() => {
  (definedSwap.actionAdapters[0] as { encode: ActionAdapter["encode"] }).encode =
    () => new Uint8Array([9]);
}, TypeError);
assert.throws(() => {
  (definedSwap.actionAdapters[0].descriptor as { action: string }).action =
    "convert";
}, TypeError);
assert.equal(
  definedFamilyPluginContractSummary(definedSwap).domain,
  "swap",
);
assert.match(
  definedFamilyPluginContractSummary(definedSwap).definitionBoundaryHash,
  /^[a-f0-9]{64}$/,
);

function captureDefinition(input?: {
  readonly materialize?: (
    descriptor: FamilyCaptureDescriptor,
  ) => FamilyCaptureVector;
}): ReturnType<typeof swapDefinition> {
  const definition = swapDefinition();
  (definition as unknown as {
    capture: {
      materialize(descriptor: FamilyCaptureDescriptor): FamilyCaptureVector;
    };
  }).capture = {
    materialize: input?.materialize ?? ((descriptor) => ({
      kind: "route" as const,
      observations: [{
        kind: "observed-log" as const,
        patternId: "test-observation",
        transactionHash: HASH,
        logIndex: 0,
      }],
      amountIn: 1n,
      minAmountOut: 0n,
      executor: ADDRESS,
      runtimeEvidence: [{
        evidenceId: "synthetic-onchain-capture",
        familyId: descriptor.familyId,
        kind: "receipt-log",
        scope: "source-block" as const,
        source: descriptor.source,
        evidenceHash: HASH,
        sealedPayloadRef: `onchain:synthetic:${descriptor.source.hash}`,
      }],
    })),
  };
  return definition;
}

const capturePlugin = defineSwapFamily(captureDefinition());
const captureDescriptor: FamilyCaptureDescriptor = Object.freeze({
  familyId: capturePlugin.manifest.familyId,
  candidateIdentity: ADDRESS,
  source: Object.freeze({ number: 1, hash: HASH, generation: 1 }),
  opaqueBinding: Object.freeze({ kind: "synthetic" }),
});
const captureVector = capturePlugin.capture!.materialize(captureDescriptor);
assert(Object.isFrozen(captureVector));
assert.equal(captureVector.kind, "route");
if (captureVector.kind !== "route") throw new Error("route capture expected");
assert(Object.isFrozen(captureVector.observations));
assert(Object.isFrozen(captureVector.observations[0]));
assert(Object.isFrozen(captureVector.runtimeEvidence));
assert(Object.isFrozen(captureVector.runtimeEvidence[0]));

assert.throws(
  () => capturePlugin.capture!.materialize({
    ...captureDescriptor,
    familyId: familyId("synthetic:foreign"),
  }),
  /descriptor Family does not match its plugin/,
);
assert.throws(
  () => capturePlugin.capture!.materialize({
    ...captureDescriptor,
    source: { number: -1, hash: HASH, generation: 1 },
  }),
  /source.number must be a nonnegative safe integer/,
);

const undeclaredCapture = defineSwapFamily(captureDefinition({
  materialize: (descriptor) => ({
    kind: "route",
    observations: [{
      kind: "observed-log",
      patternId: "not-declared",
      transactionHash: HASH,
      logIndex: 0,
    }],
    amountIn: 1n,
    minAmountOut: 0n,
    executor: ADDRESS,
    runtimeEvidence: [{
      evidenceId: "synthetic-onchain-capture",
      familyId: descriptor.familyId,
      kind: "receipt-log",
      scope: "source-block",
      source: descriptor.source,
      evidenceHash: HASH,
      sealedPayloadRef: "onchain:synthetic",
    }],
  }),
}));
assert.throws(
  () => undeclaredCapture.capture!.materialize({
    ...captureDescriptor,
    familyId: undeclaredCapture.manifest.familyId,
  }),
  /patternId is not declared by its plugin/,
);

const fixtureEvidenceCapture = defineSwapFamily(captureDefinition({
  materialize: (descriptor) => ({
    kind: "route",
    observations: [{
      kind: "observed-log",
      patternId: "test-observation",
      transactionHash: HASH,
      logIndex: 0,
    }],
    amountIn: 1n,
    minAmountOut: 0n,
    executor: ADDRESS,
    runtimeEvidence: [{
      evidenceId: "synthetic-fixture-capture",
      familyId: descriptor.familyId,
      kind: "receipt-log",
      scope: "source-block",
      source: descriptor.source,
      evidenceHash: HASH,
      sealedPayloadRef: "fixture:forbidden",
    }],
  }),
}));
assert.throws(
  () => fixtureEvidenceCapture.capture!.materialize({
    ...captureDescriptor,
    familyId: fixtureEvidenceCapture.manifest.familyId,
  }),
  /sealedPayloadRef must be onchain evidence/,
);

const thenableCapture = defineSwapFamily(captureDefinition({
  materialize: (() => Promise.resolve({})) as never,
}));
assert.throws(
  () => thenableCapture.capture!.materialize({
    ...captureDescriptor,
    familyId: thenableCapture.manifest.familyId,
  }),
  /returned a thenable; it must be synchronous/,
);

assert.throws(
  () => assertDefinedFamilyPlugin({ ...definedSwap }),
  /defineSwapFamily or defineProtocolFamily/,
  "spreading a defined plugin must not copy its runtime brand",
);

const forgedActionDefinition = swapDefinition();
(forgedActionDefinition as unknown as {
  actionAdapters: readonly FamilyOwnedActionAdapter[];
}).actionAdapters = [{ ...forgedActionDefinition.actionAdapters[0] }];
assert.throws(
  () => defineSwapFamily(forgedActionDefinition),
  /must come from bindFamilyOwnedAction/,
  "a raw structural ActionAdapter must not enter a strict Family",
);

const rawWithUnknownCapability = {
  ...swapDefinition(),
  scheduler: { priority: "adapter-owned" },
};
assert.throws(
  () => defineSwapFamily(rawWithUnknownCapability as never),
  /unknown top-level capability scheduler/,
);

const nestedUnknownCases: readonly {
  readonly mutate: (definition: ReturnType<typeof swapDefinition>) => void;
  readonly expected: RegExp;
}[] = [
  {
    mutate: (definition) => {
      (definition.discovery as unknown as Record<string, unknown>).backend = {};
    },
    expected: /discovery semantics has unknown field backend/,
  },
  {
    mutate: (definition) => {
      (definition.discovery.logPatterns?.[0] as unknown as Record<string, unknown>)
        .rpc = {};
    },
    expected: /log pattern has unknown field rpc/,
  },
  {
    mutate: (definition) => {
      (definition.identity as unknown as Record<string, unknown>).cache = {};
    },
    expected: /identity semantics has unknown field cache/,
  },
  {
    mutate: (definition) => {
      (definition.identity.variants[0] as unknown as Record<string, unknown>)
        .retry = 2;
    },
    expected: /identity variant has unknown field retry/,
  },
  {
    mutate: (definition) => {
      (definition.instance as unknown as Record<string, unknown>).scheduler = {};
    },
    expected: /instance semantics has unknown field scheduler/,
  },
  {
    mutate: (definition) => {
      (definition.routes as unknown as Record<string, unknown>).lane = "fast";
    },
    expected: /route projection semantics has unknown field lane/,
  },
  {
    mutate: (definition) => {
      (definition.pricing as unknown as Record<string, unknown>).backend = {};
    },
    expected: /pricing semantics has unknown field backend/,
  },
  {
    mutate: (definition) => {
      (definition.pricing.current as unknown as Record<string, unknown>)
        .deadline = 10;
    },
    expected: /pricing\.current has unknown field deadline/,
  },
  {
    mutate: (definition) => {
      (definition.exact as unknown as Record<string, unknown>).cache = {};
    },
    expected: /exact semantics has unknown field cache/,
  },
  {
    mutate: (definition) => {
      (definition.execution as unknown as Record<string, unknown>).scheduler = {};
    },
    expected: /execution semantics has unknown field scheduler/,
  },
  {
    mutate: (definition) => {
      (definition.swap.landedEvents as unknown as Record<string, unknown>)
        .retry = 1;
    },
    expected: /swap\.landedEvents has unknown field retry/,
  },
];
for (const testCase of nestedUnknownCases) {
  const definition = swapDefinition();
  testCase.mutate(definition);
  assert.throws(() => defineSwapFamily(definition), testCase.expected);
}

const callPatternWithScheduler = protocolDefinition();
const callPattern = callPatternWithScheduler.discovery.callPatterns?.[0];
assert(callPattern !== undefined);
(callPattern.candidateAddress as unknown as Record<string, unknown>).scheduler = {};
assert.throws(
  () => defineProtocolFamily(callPatternWithScheduler),
  /candidateAddress has unknown field scheduler/,
);

const staticProgramWithCache = swapDefinition();
(staticProgramWithCache.instance as unknown as Record<string, unknown>)
  .staticEvidence = {
    requirements: () => ({ transports: ["get-code"] }),
    buildRequests: () => [],
    decode: () => ({ immutable: true }),
    reusePolicy: { kind: "source-local", cache: {} },
  };
assert.throws(
  () => defineSwapFamily(staticProgramWithCache),
  /reusePolicy has unknown field cache/,
);

const wrongDomain = swapDefinition();
(wrongDomain.manifest as { domain: string }).domain = "protocol";
assert.throws(
  () => defineSwapFamily(wrongDomain),
  /does not match swap/,
);

const wrongActionOwner = swapDefinition();
(wrongActionOwner as unknown as {
  actionAdapters: readonly FamilyOwnedActionAdapter[];
}).actionAdapters = [actionAdapter({
  id: "test-swap",
  edgeKind: "protocol",
})];
assert.throws(
  () => defineSwapFamily(wrongActionOwner),
  /descriptor edgeKind must be swap/,
);

const missingLineage = swapDefinition();
(missingLineage.identity.variants[0] as { lineageId: LineageId }).lineageId =
  lineageId("test:unknown");
assert.throws(
  () => defineSwapFamily(missingLineage),
  /absent from the manifest/,
);

const incoherentVictimPolicy = swapDefinition();
(incoherentVictimPolicy.swap as unknown as Record<string, unknown>).localApply = {
  apply: () => null,
};
assert.throws(
  () => defineSwapFamily(incoherentVictimPolicy),
  /none victim support cannot declare replay callbacks/,
);

const replayVictimDefinition = swapDefinition();
(replayVictimDefinition.swap as unknown as Record<string, unknown>)
  .victimSupport = "replay";
(replayVictimDefinition.swap as unknown as Record<string, unknown>).replay = {
  bind: ({ routes }: { readonly routes: readonly TestRoute[] }) => routes[0] ?? null,
  applyLocal: () => ({ postImpact: { reserve0: 1n }, amountOut: 1n }),
  exactPostState: () => ({ reserve0: 1n }),
  buildOverlay: () => ({
    whale: ADDRESS,
    tokenDeals: [{ token: TOKEN0, to: ADDRESS, amount: "2" }],
    preCalls: [{ from: ADDRESS, to: ADDRESS, calldata: "0x" }],
  }),
};
const replayVictimPlugin = defineSwapFamily(replayVictimDefinition);
assert.equal(replayVictimPlugin.swap.victimSupport, "replay");
assert(replayVictimPlugin.swap.replay !== undefined);

const replayWithoutCombinedContract = swapDefinition();
(replayWithoutCombinedContract.swap as unknown as Record<string, unknown>)
  .victimSupport = "replay";
assert.throws(
  () => defineSwapFamily(replayWithoutCombinedContract),
  /requires only the combined replay contract/,
);

const asyncStage = swapDefinition();
(asyncStage.instance as unknown as Record<string, unknown>).compileDraft =
  async () => asyncStage.instance.compileDraft({
    familyId: asyncStage.manifest.familyId,
    lineageId: asyncStage.manifest.supportedLineages[0],
    subject: ADDRESS,
    provenance: [],
  });
assert.throws(
  () => defineSwapFamily(asyncStage),
  /instance\.compileDraft must be synchronous/,
);

const callbackState = { prefix: "stable" };
const statefulCandidateKey = Object.assign(
  (candidate: TestCandidate) => `${callbackState.prefix}:${candidate.pool}`,
  { impl: callbackState },
);
const functionStateDefinition = swapDefinition();
(functionStateDefinition.discovery as unknown as {
  candidateKey: typeof statefulCandidateKey;
}).candidateKey = statefulCandidateKey;
const functionStatePlugin = defineSwapFamily(functionStateDefinition);
assert(Object.isFrozen(statefulCandidateKey));
assert(Object.isFrozen(statefulCandidateKey.impl));
assert(Object.isFrozen(functionStatePlugin.discovery.candidateKey));
assert.equal(
  functionStatePlugin.discovery.candidateKey({
    candidateKind: "test-pool",
    pool: ADDRESS,
  }),
  `stable:${ADDRESS}`,
);
assert.throws(() => {
  callbackState.prefix = "mutated";
}, TypeError);
assert.throws(() => {
  statefulCandidateKey.impl = { prefix: "mutated" };
}, TypeError);

const disguisedThenableDefinition = swapDefinition();
(disguisedThenableDefinition.discovery as unknown as Record<string, unknown>)
  .candidateKey = () => Promise.resolve("async-key");
const disguisedThenablePlugin = defineSwapFamily(disguisedThenableDefinition);
assert.throws(
  () => disguisedThenablePlugin.discovery.candidateKey({
    candidateKind: "test-pool",
    pool: ADDRESS,
  }),
  /candidateKey returned a thenable; it must be synchronous/,
);

const actionThenableDefinition = swapDefinition();
(actionThenableDefinition as unknown as {
  actionAdapters: readonly FamilyOwnedActionAdapter[];
}).actionAdapters = [bindFamilyOwnedAction({
  action: {
    id: "test-swap",
    isWrapper: false,
    field2Offset: null,
    encode: (() => Promise.resolve(new Uint8Array())) as never,
    matchTrace: () => false,
  },
  descriptor: actionThenableDefinition.actionAdapters[0].descriptor,
})];
const actionThenablePlugin = defineSwapFamily(actionThenableDefinition);
assert.throws(
  () => actionThenablePlugin.actionAdapters[0].encode(
    {} as never,
    ADDRESS,
    new Uint8Array(),
  ),
  /ActionAdapter test-swap\.encode returned a thenable/,
);

const alternateActionDefinition = swapDefinition();
(alternateActionDefinition as unknown as {
  actionAdapters: readonly FamilyOwnedActionAdapter[];
}).actionAdapters = [bindFamilyOwnedAction({
  action: {
    id: "test-swap",
    isWrapper: false,
    field2Offset: null,
    encode: () => new Uint8Array([7]),
    matchTrace: () => true,
  },
  descriptor: alternateActionDefinition.actionAdapters[0].descriptor,
})];
const alternateActionPlugin = defineSwapFamily(alternateActionDefinition);
assert.equal(
  definedFamilyPluginContractSummary(alternateActionPlugin)
    .definitionBoundaryHash,
  definedFamilyPluginContractSummary(definedSwap).definitionBoundaryHash,
  "definitionBoundaryHash is an activation receipt, not a capability content hash",
);
assert.notDeepEqual(
  [...alternateActionPlugin.actionAdapters[0].encode(
    {} as never,
    ADDRESS,
    new Uint8Array(),
  )],
  [...definedSwap.actionAdapters[0].encode(
    {} as never,
    ADDRESS,
    new Uint8Array(),
  )],
  "the activation-only hash must not be mistaken for implementation equality",
);

const definedProtocol = defineProtocolFamily(protocolDefinition());
assertDefinedFamilyPlugin(definedProtocol);
assert.equal(
  definedFamilyPluginContractSummary(definedProtocol).domain,
  "protocol",
);
assert(Object.isFrozen(definedProtocol.protocol.candidateKinds));

const protocolCandidate: TestCandidate = {
  candidateKind: "test-pool",
  pool: ADDRESS,
};
const zeroRequestVariant = definedProtocol.identity.variants[0];
assert.throws(
  () => zeroRequestVariant.requirements({ candidate: protocolCandidate, step: 0 }),
  /active behavior proof requires a transport/,
);
assert.throws(
  () => zeroRequestVariant.buildRequests({ candidate: protocolCandidate, step: 0 }),
  /active behavior proof requires at least one request/,
);
assert.throws(
  () => zeroRequestVariant.decode({
    step: { candidate: protocolCandidate, step: 0 },
    results: [],
  }),
  /requires successful results and explicit evidence/,
);
assert.throws(
  () => zeroRequestVariant.decide({ candidate: protocolCandidate, step: 0 }),
  /cannot verify before active behavior proof evidence/,
);

const provenProtocolDefinition = protocolDefinition();
const provenVariant = provenProtocolDefinition.identity.variants[0] as unknown as
  Record<string, unknown>;
provenVariant.requirements = () => ({ transports: ["get-code"] });
provenVariant.buildRequests = () => [{
  id: "active-behavior-code",
  kind: "get-code",
  address: ADDRESS,
}];
provenVariant.decode = () => ({ behavior: "observed" });
provenVariant.decide = ({ candidate, evidence, step }: {
  readonly candidate: TestCandidate;
  readonly evidence?: unknown;
  readonly step: number;
}) => step === 0
  ? { status: "continue" }
  : {
      status: "verified",
      identity: {
        familyId: provenProtocolDefinition.manifest.familyId,
        lineageId: provenProtocolDefinition.manifest.supportedLineages[0],
        subject: candidate.pool,
        provenance: [{
          kind: "active-behavior",
          subject: candidate.pool,
          evidenceHash: JSON.stringify(evidence),
        }],
      },
    };
const provenProtocol = defineProtocolFamily(provenProtocolDefinition);
const activeVariant = provenProtocol.identity.variants[0];
const proofStep = { candidate: protocolCandidate, step: 0 };
assert.deepEqual(activeVariant.requirements(proofStep).transports, ["get-code"]);
assert.equal(activeVariant.buildRequests(proofStep).length, 1);
assert.equal(activeVariant.decide(proofStep).status, "continue");
const activeEvidence = activeVariant.decode({
  step: proofStep,
  results: [{
    id: "active-behavior-code",
    ok: true,
    source: { number: 1, hash: HASH, generation: 1 },
    provenance: { kind: "fixture", fingerprint: "fixture-proof" },
    completion: "returned",
    data: "0x01",
  }],
});
assert.equal(
  activeVariant.decide({
    candidate: protocolCandidate,
    evidence: activeEvidence,
    step: 1,
  }).status,
  "verified",
);

const observation: UnifiedObservation = {
  kind: "call",
  source: { number: 1, hash: HASH, generation: 1 },
  target: ADDRESS,
  data: "0x12345678",
};
assert.equal(
  definedProtocol.discovery.decodeCandidate({
    observation,
    matchedPatternId: "test-observation",
  })?.pool,
  ADDRESS,
);

console.log(
  "adapter-family-plugin PASS " +
    "(terminal seven-stage types + strict domains + unforgeable brand)",
);
