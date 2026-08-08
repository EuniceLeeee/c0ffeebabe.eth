import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  type AdapterGenerationFence,
  type CentralAdapterRuntime,
  type CentralAdapterScheduler,
} from "../adapter-work-intent.js";
import {
  createAdapterFamilyLifecycleContentCache,
  type AdapterFamilyLifecycleContentCache,
} from "../adapter-family-lifecycle-content-cache.js";
import {
  createAdapterFamilyExactQuoteCache,
  type AdapterFamilyExactQuoteCache,
} from "../adapter-family-exact-quote-cache.js";
import {
  buildFamilyRouteGraphView,
  projectFamilyRouteGraph,
} from "../adapter-family-graph-runtime.js";
import {
  buildFamilyExecutionFragment,
  executeAdapterFamilyLifecycleBatch,
  executeFamilyExactQuote,
  type AdapterFamilyPublication,
  type FamilyRouteRuntimeHandle,
  type PreparedFamilyInstance,
  type SealedFamilyExactQuoteHandle,
} from "../venues/adapter-family-runtime.js";
import {
  defineProtocolFamily,
  definedFamilyPluginContractSummary,
  type CompiledInstanceDescriptor,
  type FamilyOwnedActionAdapter,
  type FamilyRouteDescriptor,
  type FamilySharedBindingRef,
  type ProtocolFamilyPlugin,
  type RuntimeEvidence,
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
import {
  createBoundedRequestExecutor,
  fingerprintTrustedResults,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "../venues/adapter-request-program.js";
import { hashCanonical } from "../venues/canonical-value.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
  type LoadedFamilyPlugin,
} from "../venues/family-capability-catalog.js";
import { bindFamilyOwnedAction } from "../venues/family-owned-action.js";

const SELECTOR = "0x12345678" as const;
const TOKEN0 = `0x${"31".repeat(20)}`;
const TOKEN1 = `0x${"32".repeat(20)}`;
const GOOD = `0x${"41".repeat(20)}`;
const BAD = `0x${"42".repeat(20)}`;
const OTHER = `0x${"43".repeat(20)}`;
const EXECUTOR = `0x${"44".repeat(20)}`;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_111,
  hash: `0x${"51".repeat(32)}`,
  generation: 11,
});
const CATALOG_BY_FAMILY = new Map<FamilyId, FamilyCapabilityCatalog>();

interface Candidate {
  readonly candidateKind: "observed-call";
  readonly pool: string;
  readonly tag?: string;
}

interface Identity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly subject: string;
  readonly provenance: readonly [{ readonly kind: "active-probe"; readonly subject: string }];
}

interface Descriptor extends CompiledInstanceDescriptor {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly instanceCode: string;
  readonly sharedBindings: readonly FamilySharedBindingRef[];
}

interface Route extends FamilyRouteDescriptor {
  readonly direction: "zero-to-one";
}

interface PricingDraft {
  readonly pool: string;
  readonly instanceCode: string;
}

interface PricingDescriptor extends PricingDraft {
  readonly pricingWord: string;
}

interface Snapshot {
  readonly pool: string;
  readonly core: string;
  readonly dependent: string;
}

interface FixtureProbe {
  readonly accepted: boolean;
}

interface FixtureExactEvidence {
  readonly witness: string;
  readonly sourceGeneration: number;
  readonly resultIds: readonly string[];
}

interface FixtureControls {
  readonly prematureNegative?: boolean;
  readonly candidateTagFromData?: boolean;
  readonly localExact?: boolean;
  readonly omitQuoteLocal?: boolean;
  readonly localExactNotApplicable?: boolean;
  readonly localExactAfterRequest?: boolean;
  readonly localExactThrow?: boolean;
  readonly exactDependent?: boolean;
  readonly exactDependentRounds?: number;
  readonly exactDependentNeverSettles?: boolean;
  readonly exactDecodeThrow?: boolean;
  readonly executionAdapterId?: string;
  readonly executionThenable?: boolean;
  readonly sharedBindingKey?: "pool" | "token0";
  readonly sharedProjectionThenable?: boolean;
  readonly sharedReferenceDrift?: boolean;
  exactRequestOrder?: "forward" | "reverse";
  exactCalldata?: string;
  readonly descriptorPools: string[];
  readonly finalSharedBindingCounts?: number[];
  lastPlanNode?: {
    readonly params: { amountOut: bigint; minAmountOut: bigint };
  };
  exactDecodeCalls?: number;
  exactDependentBuildCalls?: number;
  exactDependentDecodeCalls?: number;
  lastExactResultIds?: readonly string[];
  lastExactSourceGeneration?: number;
  lastProducedExactEvidence?: FixtureExactEvidence;
  lastExecutionExactEvidence?: FixtureExactEvidence;
  lastExecutionRuntimeEvidence?: readonly RuntimeEvidence[];
  localExactCalls?: number;
  executionCalls?: number;
  unavailableCalls: number;
}

function defineFixture(name: string, controls: FixtureControls) {
  const family = familyId(`protocol:${name}`);
  const lineage = lineageId(`${name}:active-probe`);
  const actionId = `${name}-convert`;
  const plugin: ProtocolFamilyPlugin<
    Candidate,
    Identity,
    Descriptor,
    Route,
    PricingDescriptor,
    Snapshot,
    FixtureExactEvidence,
    Omit<Descriptor, "instanceCode" | "sharedBindings">,
    PricingDraft,
    { readonly code: string },
    { readonly word: string }
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
      sources: ["observed-call"],
      callPatterns: [{
        id: "fixture-call",
        selector: SELECTOR,
        signature: "convert(uint256)",
        candidateAddress: { from: "call-target" },
      }],
      decodeCandidate: ({ observation }) => observation.kind === "call"
        ? {
            candidateKind: "observed-call",
            pool: observation.target,
            ...(controls.candidateTagFromData
              ? { tag: observation.data.slice(-2) }
              : {}),
          }
        : null,
      candidateKey: (candidate) => candidate.pool,
    },
    identity: {
      variants: [{
        id: "active-probe",
        kind: "standalone-contract",
        lineageId: lineage,
        applies: () => true,
        requirements: () => ({ transports: ["eth-call"] }),
        buildRequests: ({ candidate }) => [call(
          `identity:${candidate.pool}`,
          candidate.pool,
          "0xaaaaaaaa",
        )],
        decode: ({ results }) => ({
          accepted: successful(results[0]).data === "0x01",
        }),
        decide: ({ candidate, evidence }) => {
          if (controls.prematureNegative) {
            return { status: "rejected", reason: "premature-negative" };
          }
          if (evidence === undefined) return { status: "continue" };
          const probe = evidence as FixtureProbe;
          return probe.accepted
            ? {
                status: "verified",
                identity: {
                  familyId: family,
                  lineageId: lineage,
                  subject: candidate.pool,
                  provenance: [{
                    kind: "active-probe",
                    subject: candidate.pool,
                  }],
                },
              }
            : { status: "rejected", reason: "active-probe-negative" };
        },
      }],
      identityKey: (identity) => identity.subject,
    },
    instance: {
      instanceKey: (identity): InstanceKey => instanceKey(identity.subject),
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
      staticEvidence: {
        reusePolicy: { kind: "source-local" },
        requirements: () => ({ transports: ["get-code"] }),
        buildRequests: (draft) => [{
          id: `instance-static:${draft.pool}`,
          kind: "get-code",
          address: draft.pool,
        }],
        decode: ({ results }) => ({ code: successful(results[0]).data }),
      },
      finalizeDescriptor: ({ draft, staticEvidence, sharedBindings }) => {
        controls.finalSharedBindingCounts?.push(sharedBindings.length);
        return {
          ...draft,
          token0: controls.sharedReferenceDrift && sharedBindings.length > 0
            ? TOKEN1
            : draft.token0,
          instanceCode: staticEvidence!.code,
          sharedBindings: Object.freeze([...sharedBindings]),
        };
      },
      staticBindingProjection: (descriptor) => ({
        pool: descriptor.pool,
        token0: descriptor.token0,
        token1: descriptor.token1,
        instanceCode: descriptor.instanceCode,
        sharedBindings: descriptor.sharedBindings.map((item) => ({
          bindingKind: item.bindingKind,
          bindingKey: item.bindingKey,
          fingerprint: item.fingerprint,
        })),
      }),
    },
    ...(controls.sharedBindingKey === undefined
      ? {}
      : {
          sharedBindings: {
            references: (descriptor: Descriptor) => [{
              bindingKind: "fixture-binding",
              bindingKey: controls.sharedBindingKey === "pool"
                ? descriptor.pool
                : descriptor.token0,
            }],
            program: {
              requirements: () => ({ transports: ["eth-call" as const] }),
              buildRequests: (request: {
                readonly bindingKind: string;
                readonly bindingKey: string;
              }) => [call(
                `shared:${request.bindingKind}:${request.bindingKey}`,
                request.bindingKey,
                "0xeeeeeeee",
              )],
              decode: ({ results }: {
                readonly results: readonly AdapterRequestResult[];
              }) => ({ word: successful(results[0]).data }),
            },
            canonicalProjection: (evidence: unknown) =>
              controls.sharedProjectionThenable
                ? Promise.resolve({ word: "forged" }) as never
                : {
                    word: (evidence as { readonly word: string }).word,
                  },
          },
        }),
    routes: {
      project: ({ descriptor }) => [{
        routeKey: routeKey(`${descriptor.pool}:0-1`),
        familyId: family,
        lineageId: lineage,
        instanceKey: descriptor.instanceKey,
        tokenIn: descriptor.token0,
        tokenOut: descriptor.token1,
        taxonomy: { slotKind: "protocol", protocolAction: "convert" },
        bindingRef: {
          bindingKey: descriptor.pool,
          fingerprint: hashCanonical({
            pool: descriptor.pool,
            instanceCode: descriptor.instanceCode,
          }),
        },
        runtimeRequirements: [],
        direction: "zero-to-one",
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
      staticBindingProjection: ({ descriptor, routes }) => ({
        pool: descriptor.pool,
        instanceCode: descriptor.instanceCode,
        routes: routes.map((route) => route.routeKey),
      }),
      snapshotCompatibilityProjection: ({ descriptor }) => ({
        pool: descriptor.pool,
      }),
      compileDraft: ({ descriptor, routes }) => {
        assert(routes.every((route) => route.instanceKey === descriptor.instanceKey));
        assert.equal("pools" in descriptor, false);
        assert.equal("groups" in descriptor, false);
        controls.descriptorPools.push(descriptor.pool);
        return { pool: descriptor.pool, instanceCode: descriptor.instanceCode };
      },
      staticEvidence: {
        reusePolicy: { kind: "source-local" },
        requirements: () => ({ transports: ["get-storage"] }),
        buildRequests: (draft) => [{
          id: `pricing-static:${draft.pool}`,
          kind: "get-storage",
          address: draft.pool,
          slot: `0x${"00".repeat(32)}`,
        }],
        decode: ({ results }) => ({ word: successful(results[0]).data }),
      },
      finalizePricingDescriptor: ({ draft, staticEvidence }) => ({
        ...draft,
        pricingWord: staticEvidence!.word,
      }),
      current: {
        requirements: ({ descriptor, routes }) => {
          assertDescriptorOnly(descriptor, routes);
          return { transports: ["eth-call"] };
        },
        buildRequests: ({ descriptor, routes }) => {
          assertDescriptorOnly(descriptor, routes);
          return [call(`current:${descriptor.pool}`, descriptor.pool, "0xbbbbbbbb")];
        },
        buildDependentProgram: ({
          current,
          completedRound,
          initialResults,
          priorEvidence,
        }) => {
          assertDescriptorOnly(current.descriptor, current.routes);
          assert(initialResults.some((result) => result.id.startsWith("current:")));
          if (completedRound !== 0) return null;
          assert.equal(priorEvidence.length, 0);
          return {
            requirements: { transports: ["eth-call"] },
            requests: [call(
              `dependent:${current.descriptor.pool}`,
              current.descriptor.pool,
              "0xcccccccc",
            )],
            decode: (results) => ({
              dependent: successful(results[0]).data,
            }),
          };
        },
        decodeSnapshot: ({ descriptor, initialResults, dependentEvidence }) => {
          assert.equal("pools" in descriptor, false);
          return {
            pool: descriptor.pool,
            core: successful(initialResults.find((item) =>
              item.id === `current:${descriptor.pool}`
            )).data,
            dependent: (dependentEvidence[0] as { readonly dependent: string })
              .dependent,
          };
        },
        deriveMids: ({ descriptor, snapshot, routes }) => {
          assert.equal(snapshot.pool, descriptor.pool);
          return new Map(routes.map((route) => [route.routeKey, {
            kind: "protocol" as const,
            pool: descriptor.pool,
            edges: [],
            mid: 1,
            feeBps: 0,
            depthProxy: 1,
          }]));
        },
        classifyUnavailable: () => {
          controls.unavailableCalls++;
          return new Map();
        },
      },
      dependencies: ({ descriptor, routes }) => {
        assertDescriptorOnly(descriptor, routes);
        return [descriptor.pool];
      },
    },
    exact: {
      methods: () => {
        if (controls.omitQuoteLocal) return Object.freeze([]);
        const local = Object.freeze({
          id: "fixture-local",
          kind: "local" as const,
          quote: ({ amountIn, source }: {
            readonly amountIn: bigint;
            readonly source: CanonicalSource;
          }) => {
            controls.localExactCalls = (controls.localExactCalls ?? 0) + 1;
            if (controls.localExactThrow) {
              throw new Error("deterministic local bug");
            }
            if (controls.localExactNotApplicable) {
              return {
                status: "not-applicable" as const,
                reason: "fixture local state unavailable",
              };
            }
            return {
              status: "quoted" as const,
              result: {
                amountOut: amountIn + 1n,
                evidence: {
                  witness: "local-fixture",
                  sourceGeneration: source.generation,
                  resultIds: Object.freeze([]),
                },
              },
            };
          },
        });
        const remote = Object.freeze({
          id: "fixture-request-program",
          kind: "request-program" as const,
          program: Object.freeze({
            requirements: () => ({ transports: ["eth-call" as const] }),
            buildRequests: ({ descriptor }: { readonly descriptor: Descriptor }) => {
              const primary = call(
                `exact:${descriptor.pool}`,
                descriptor.pool,
                controls.exactCalldata ?? "0xdddddddd",
              );
              if (controls.exactRequestOrder === undefined) return [primary];
              const secondary = call(
                `exact-extra:${descriptor.pool}`,
                descriptor.pool,
                "0xabababab",
              );
              return controls.exactRequestOrder === "forward"
                ? [primary, secondary]
                : [secondary, primary];
            },
            ...(controls.exactDependent
              ? {
                  buildDependentProgram: ({
                    programInput,
                    completedRound,
                    initialResults,
                    priorEvidence,
                  }: {
                    readonly programInput: {
                      readonly descriptor: Descriptor;
                    };
                    readonly completedRound: number;
                    readonly initialResults: readonly AdapterRequestResult[];
                    readonly priorEvidence: readonly unknown[];
                  }) => {
                    controls.exactDependentBuildCalls =
                      (controls.exactDependentBuildCalls ?? 0) + 1;
                    assert.equal(programInput.descriptor.pool, GOOD);
                    assert(initialResults.some((result) =>
                      result.id === `exact:${GOOD}`
                    ));
                    assert.equal(priorEvidence.length, completedRound);
                    const roundCount = controls.exactDependentNeverSettles
                      ? Number.POSITIVE_INFINITY
                      : controls.exactDependentRounds ?? 1;
                    if (completedRound >= roundCount) return null;
                    return {
                      requirements: { transports: ["eth-call" as const] },
                      requests: [call(
                        `exact-dependent:${programInput.descriptor.pool}:` +
                          completedRound,
                        programInput.descriptor.pool,
                        "0xeeeeeeee",
                      )],
                      decode: (results: readonly AdapterRequestResult[]) => {
                        controls.exactDependentDecodeCalls =
                          (controls.exactDependentDecodeCalls ?? 0) + 1;
                        return Object.freeze({
                          round: completedRound,
                          results: Object.freeze([...results]),
                        });
                      },
                    };
                  },
                }
              : {}),
            decode: ({
              programInput,
              initialResults,
              dependentEvidence,
            }: {
              readonly programInput: {
                readonly amountIn: bigint;
                readonly source: CanonicalSource;
              };
              readonly initialResults: readonly AdapterRequestResult[];
              readonly dependentEvidence: readonly unknown[];
            }) => {
              controls.exactDecodeCalls = (controls.exactDecodeCalls ?? 0) + 1;
              if (controls.exactDecodeThrow) {
                throw new Error("deterministic request decode bug");
              }
              const dependentResults = dependentEvidence.flatMap((evidence) =>
                [...(evidence as {
                  readonly results: readonly AdapterRequestResult[];
                }).results]
              );
              const results = [...initialResults, ...dependentResults];
              controls.lastExactResultIds = Object.freeze(
                results.map((result) => result.id),
              );
              controls.lastExactSourceGeneration =
                programInput.source.generation;
              const dependentAmount = dependentResults.reduce(
                (sum, result) => sum + BigInt(successful(result).data),
                0n,
              );
              const evidence: FixtureExactEvidence = {
                witness: "fixture",
                sourceGeneration: programInput.source.generation,
                resultIds: Object.freeze(results.map((result) => result.id)),
              };
              controls.lastProducedExactEvidence = evidence;
              return {
                amountOut: programInput.amountIn + dependentAmount,
                evidence,
              };
            },
          }),
        });
        if (controls.localExact) return Object.freeze([local]);
        if (controls.localExactNotApplicable) {
          return controls.localExactAfterRequest
            ? Object.freeze([remote, local])
            : Object.freeze([local, remote]);
        }
        return Object.freeze([remote]);
      },
      cacheCompatibilityProjection: ({ route }) => ({ routeKey: route.routeKey }),
    },
    execution: {
      buildFragment: ({
        descriptor,
        route,
        amountIn,
        quotedAmountOut,
        minAmountOut,
        exactEvidence,
        runtimeEvidence,
      }) => {
        controls.executionCalls = (controls.executionCalls ?? 0) + 1;
        controls.lastExecutionExactEvidence = exactEvidence;
        controls.lastExecutionRuntimeEvidence = runtimeEvidence;
        const fragment = {
          requirements: [],
          nodes: [{
            adapterId: controls.executionAdapterId ?? actionId,
            target: descriptor.pool,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            amount: amountIn,
            params: { amountOut: quotedAmountOut, minAmountOut },
            children: [],
          }],
        };
        controls.lastPlanNode = fragment.nodes[0];
        return controls.executionThenable
          ? Promise.resolve(fragment) as never
          : fragment;
      },
      expectedEffects: ({ descriptor }) => [{
        kind: "token-delta",
        token: descriptor.token1,
        account: "executor",
        direction: "increase",
      }],
    },
    protocol: {
      candidateKinds: ["observed-call"],
      activeBehaviorProof: "required",
    },
    actionAdapters: [action(actionId)],
  };
  return load(defineProtocolFamily(plugin), `${name}.production.ts`);
}

function assertDescriptorOnly(
  descriptor: PricingDescriptor,
  routes: readonly Route[],
): void {
  assert.equal("pools" in descriptor, false);
  assert.equal("groups" in descriptor, false);
  assert(routes.every((route) => route.instanceKey === instanceKey(descriptor.pool)));
}

function action(id: string): FamilyOwnedActionAdapter {
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

function call(id: string, to: string, data: string): AdapterRequest {
  return { id, kind: "eth-call", to, data, completion: "return-data" };
}

function successful(
  result: AdapterRequestResult | undefined,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  assert(result?.ok, `expected successful result, received ${result?.id ?? "none"}`);
  return result;
}

function load(
  plugin: ReturnType<typeof defineProtocolFamily>,
  sourceFile: string,
): LoadedFamilyPlugin {
  const entries: GeneratedCapabilityIdentity[] = FAMILY_CAPABILITY_NAMES.map(
    (capability) => ({
      familyId: plugin.manifest.familyId,
      capability,
      contractVersion: "s1-v1",
      contentHash: createHash("sha256")
        .update(`${plugin.manifest.familyId}/${capability}`)
        .digest("hex"),
      semanticDependencies: [`contract:${capability}`],
      provenanceCommit: "a".repeat(40),
    }),
  );
  const catalog = new FamilyCapabilityCatalog({
    modules: [{
      sourceFile,
      definitionBoundaryHash:
        definedFamilyPluginContractSummary(plugin).definitionBoundaryHash,
      plugin,
    }],
    generatedManifest: {
      format: "adapter-family-capabilities-v1",
      entries,
      manifestHash: capabilityManifestHash(entries),
    },
  });
  CATALOG_BY_FAMILY.set(plugin.manifest.familyId, catalog);
  return catalog.forFamily(plugin.manifest.familyId);
}

function ownershipFor(family: LoadedFamilyPlugin): FamilyCapabilityCatalog {
  const catalog = CATALOG_BY_FAMILY.get(family.plugin.manifest.familyId);
  assert(catalog, "fixture catalog missing");
  return catalog;
}

function issuedRoute(
  instance: PreparedFamilyInstance,
  route: FamilyRouteDescriptor = instance.routes[0]!,
): FamilyRouteRuntimeHandle {
  const handle = instance.routeHandles.find((item) =>
    item.routeKey === route.routeKey
  );
  assert(handle, `missing issued route handle for ${route.routeKey}`);
  return handle;
}

class TestFence implements AdapterGenerationFence {
  private remainingChecks: number | null = null;

  failAfter(checks: number): void {
    this.remainingChecks = checks;
  }

  assertCurrent(): void {
    if (this.remainingChecks === null) return;
    if (this.remainingChecks === 0) throw new Error("synthetic stale generation");
    this.remainingChecks--;
  }
}

class TestScheduler implements CentralAdapterScheduler {
  readonly requestIds: string[] = [];

  constructor(private readonly options: {
    readonly fail?: (request: AdapterRequest) => boolean;
    readonly identityAccepted?: boolean;
    readonly beforeTransport?: (
      request: AdapterRequest,
    ) => void | Promise<void>;
    readonly afterTransport?: (request: AdapterRequest) => void;
  } = {}) {}

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (family, requests) => {
        assert.equal(family, input.subject.familyId);
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(async (request) => {
        this.requestIds.push(request.id);
        await this.options.beforeTransport?.(request);
        const failed = this.options.fail?.(request) ?? false;
        this.options.afterTransport?.(request);
        return failed
          ? {
              id: request.id,
              ok: false as const,
              source: execution.source,
              failure: "rpc" as const,
            }
          : {
              id: request.id,
              ok: true as const,
              source: execution.source,
              provenance: {
                kind: "fixture-scheduler",
                fingerprint: `issued:${request.id}`,
              },
              completion: "returned" as const,
              data: responseData(request, this.options.identityAccepted ?? true),
            };
      })),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function responseData(request: AdapterRequest, identityAccepted: boolean): string {
  if (request.id.startsWith("identity:")) return identityAccepted ? "0x01" : "0x00";
  if (request.id.startsWith("instance-static:")) return "0x6000";
  if (request.id.startsWith("pricing-static:")) return "0x02";
  if (request.id.startsWith("current:")) return "0x03";
  if (request.id.startsWith("dependent:")) return "0x04";
  return "0x05";
}

function runtime(
  scheduler: TestScheduler,
  fence = new TestFence(),
  observedStages: string[] = [],
  staticEvidenceCache?: AdapterFamilyLifecycleContentCache,
  exactQuoteCache?: AdapterFamilyExactQuoteCache,
): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: fence,
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => {
        observedStages.push(input.stage);
        return {
          lane: input.stage === "identity" ? "critical-proof" : "background",
          deadlineAtMs: 9_999,
          maxAttempts: 1,
          transportPool: "state-read",
          fairnessKey: input.subjectKey,
        };
      },
    },
    budgets: { assertAdmitted() {} },
    scheduler,
    ...(staticEvidenceCache === undefined ? {} : { staticEvidenceCache }),
    ...(exactQuoteCache === undefined ? {} : { exactQuoteCache }),
  };
}

function match(
  pool: string,
  trailingByte = "00",
  source: CanonicalSource = SOURCE,
) {
  return {
    matchedPatternId: "fixture-call",
    observation: {
      kind: "call" as const,
      source,
      target: pool,
      data: `${SELECTOR}${"00".repeat(31)}${trailingByte}`,
    },
  };
}

function publisher() {
  const publications: AdapterFamilyPublication[] = [];
  return {
    publications,
    sink: { publish: (publication: AdapterFamilyPublication) => {
      publications.push(publication);
    } },
  };
}

async function run(input: {
  readonly family: LoadedFamilyPlugin;
  readonly pools: readonly string[];
  readonly scheduler: TestScheduler;
  readonly fence?: TestFence;
  readonly observedStages?: string[];
  readonly source?: CanonicalSource;
}) {
  const source = input.source ?? SOURCE;
  const published = publisher();
  const result = await executeAdapterFamilyLifecycleBatch({
    family: input.family,
    matches: input.pools.map((pool) => match(pool, "00", source)),
    source,
    generation: source.generation,
    runtime: runtime(input.scheduler, input.fence, input.observedStages),
    publisher: published.sink,
  });
  return { result, publications: published.publications };
}

function deferred(): Readonly<{
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return Object.freeze({ promise, resolve });
}

async function testLifecycleSnapshotsCallerOwnedSourceAcrossAwait(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("lifecycle-source-snapshot", controls);
  const transportStarted = deferred();
  const releaseTransport = deferred();
  const mutableSource = {
    number: SOURCE.number,
    hash: SOURCE.hash,
    generation: SOURCE.generation,
  };
  const scheduler = new TestScheduler({
    beforeTransport: async (request) => {
      if (request.id !== `identity:${GOOD}`) return;
      transportStarted.resolve();
      await releaseTransport.promise;
    },
  });
  const published = publisher();
  const pending = executeAdapterFamilyLifecycleBatch({
    family,
    matches: [match(GOOD, "00", mutableSource)],
    source: mutableSource,
    generation: SOURCE.generation,
    runtime: runtime(scheduler),
    publisher: published.sink,
  });

  await transportStarted.promise;
  mutableSource.number++;
  mutableSource.hash = `0x${"52".repeat(32)}`;
  mutableSource.generation++;
  releaseTransport.resolve();

  const result = await pending;
  assert.equal(published.publications.length, 1);
  assert.deepEqual(result.source, SOURCE);
  assert.deepEqual(published.publications[0].source, SOURCE);
  assert(result.outcomes.every((outcome) =>
    outcome.source.number === SOURCE.number &&
    outcome.source.hash === SOURCE.hash &&
    outcome.source.generation === SOURCE.generation
  ));
}

async function testExactSnapshotsSourceAndRuntimeEvidenceAcrossAwait(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("exact-source-snapshot", controls);
  const scheduler = new TestScheduler();
  const lifecycle = await run({ family, pools: [GOOD], scheduler });
  const instance = lifecycle.publications[0].instances[0];
  const route = issuedRoute(instance);
  const transportStarted = deferred();
  const releaseTransport = deferred();
  const exactScheduler = new TestScheduler({
    beforeTransport: async (request) => {
      if (!request.id.startsWith("exact:")) return;
      transportStarted.resolve();
      await releaseTransport.promise;
    },
  });
  const mutableSource = {
    number: SOURCE.number,
    hash: SOURCE.hash,
    generation: SOURCE.generation,
  };
  const originalEvidence: RuntimeEvidence = Object.freeze({
    evidenceId: "exact-source-snapshot-evidence",
    familyId: family.plugin.manifest.familyId,
    instanceKey: instance.instanceKey,
    kind: "fixture-runtime",
    scope: "source-block",
    source: SOURCE,
    evidenceHash: "61".repeat(32),
    sealedPayloadRef: "fixture:exact-source-snapshot",
  });
  const mutableEvidence = {
    ...originalEvidence,
    source: mutableSource,
  };
  const pending = executeFamilyExactQuote({
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [mutableEvidence],
    source: mutableSource,
    generation: SOURCE.generation,
    runtime: runtime(exactScheduler),
  });

  await transportStarted.promise;
  mutableSource.number++;
  mutableSource.hash = `0x${"53".repeat(32)}`;
  mutableSource.generation++;
  mutableEvidence.evidenceHash = "62".repeat(32);
  mutableEvidence.sealedPayloadRef = "fixture:mutated-after-admission";
  releaseTransport.resolve();

  const exact = await pending;
  assert.equal(exact.status, "resolved");
  if (exact.status !== "resolved") throw new Error("snapshot exact failed");
  assert.deepEqual(exact.source, SOURCE);
  assert.deepEqual(exact.outcome.source, SOURCE);
  const execution = buildFamilyExecutionFragment({
    family,
    actionOwnership: ownershipFor(family),
    route,
    exact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [originalEvidence],
  });
  assert.equal(execution.status, "resolved");
  assert.deepEqual(controls.lastExecutionRuntimeEvidence, [originalEvidence]);
}

async function testRpcFailureIsUnresolved(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("rpc-unresolved", controls);
  const scheduler = new TestScheduler({
    fail: (request) => request.id.startsWith("current:"),
  });
  const { result, publications } = await run({ family, pools: [GOOD], scheduler });
  assert.equal(publications.length, 0);
  assert(result.outcomes.some((outcome) =>
    outcome.stage === "pricing-current" &&
    outcome.status === "unresolved" &&
    outcome.reasonCode.includes(":rpc")
  ));
  assert.equal(controls.unavailableCalls, 0);
  assert(!result.outcomes.some((outcome) =>
    outcome.stage === "pricing-current" && outcome.status === "rejected"
  ));
}

async function testProtocolNegativeRequiresSuccessfulEvidence(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("negative-proof", controls);
  const scheduler = new TestScheduler({ identityAccepted: false });
  const { result } = await run({ family, pools: [GOOD], scheduler });
  assert.equal(scheduler.requestIds.filter((id) => id.startsWith("identity:")).length, 1);
  assert(result.outcomes.some((outcome) =>
    outcome.stage === "identity" && outcome.status === "rejected"
  ));

  const prematureControls: FixtureControls = {
    prematureNegative: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const premature = defineFixture("premature-negative", prematureControls);
  const prematureScheduler = new TestScheduler();
  const prematureRun = await run({
    family: premature,
    pools: [GOOD],
    scheduler: prematureScheduler,
  });
  assert(!prematureRun.result.outcomes.some((outcome) =>
    outcome.stage === "identity" && outcome.status === "rejected"
  ));
  assert(prematureRun.result.outcomes.some((outcome) =>
    outcome.stage === "identity" && outcome.status === "failed"
  ));
  assert.equal(prematureScheduler.requestIds.length, 0);
}

async function testSingleInstanceFailureIsolation(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("isolation", controls);
  const scheduler = new TestScheduler({
    fail: (request) => request.id === `instance-static:${BAD}`,
  });
  const { result, publications } = await run({
    family,
    pools: [GOOD, BAD],
    scheduler,
  });
  assert.equal(publications.length, 1);
  assert.deepEqual(
    publications[0].instances.map((instance) => instance.instanceKey),
    [instanceKey(GOOD)],
  );
  assert(result.outcomes.some((outcome) =>
    outcome.candidateKey === BAD && outcome.status === "unresolved"
  ));
  assert(result.outcomes.some((outcome) =>
    outcome.candidateKey === GOOD &&
    outcome.stage === "pricing-current" &&
    outcome.status === "verified"
  ));
}

async function testDuplicateObservationCoalescing(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("duplicate-coalescing", controls);
  const scheduler = new TestScheduler();
  const { publications } = await run({
    family,
    pools: [GOOD, GOOD],
    scheduler,
  });
  assert.equal(publications.length, 1);
  assert.equal(publications[0].instances.length, 1);
  assert.deepEqual(controls.descriptorPools, [GOOD]);
  for (const prefix of [
    "identity:",
    "instance-static:",
    "pricing-static:",
    "current:",
    "dependent:",
  ]) {
    assert.equal(
      scheduler.requestIds.filter((id) => id.startsWith(prefix)).length,
      1,
      `${prefix} should execute once for duplicate observations`,
    );
  }
}

async function testStaticEvidenceContentCacheAcrossGeneration(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("static-content-cache", controls);
  const scheduler = new TestScheduler();
  const cache = createAdapterFamilyLifecycleContentCache({ capacity: 8 });
  const sharedRuntime = runtime(scheduler, new TestFence(), [], cache);

  const firstPublished = publisher();
  const first = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [match(GOOD)],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: sharedRuntime,
    publisher: firstPublished.sink,
  });
  assert(first.publication);

  const nextSource: CanonicalSource = Object.freeze({
    ...SOURCE,
    generation: SOURCE.generation + 1,
  });
  const secondPublished = publisher();
  const second = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [match(GOOD, "00", nextSource)],
    source: nextSource,
    generation: nextSource.generation,
    runtime: sharedRuntime,
    publisher: secondPublished.sink,
  });
  assert(second.publication);
  assert.equal(
    scheduler.requestIds.filter((id) => id.startsWith("identity:")).length,
    2,
    "identity remains source-bound and is not part of the static content cache",
  );
  assert.equal(
    scheduler.requestIds.filter((id) => id.startsWith("instance-static:")).length,
    1,
    "same block/hash may reuse instance static evidence across generations",
  );
  assert.equal(
    scheduler.requestIds.filter((id) => id.startsWith("pricing-static:")).length,
    1,
    "same block/hash may reuse pricing static evidence across generations",
  );
  assert.equal(
    scheduler.requestIds.filter((id) => id.startsWith("current:")).length,
    2,
    "current state must still be read for every lifecycle run",
  );
  assert.equal(
    scheduler.requestIds.filter((id) => id.startsWith("dependent:")).length,
    2,
    "dependent current reads must still be read for every lifecycle run",
  );
  assert.equal(cache.snapshot().hits, 2);
  assert.equal(cache.snapshot().stores, 2);
  assert(second.publication.instances[0].evidenceRefs.some((ref) =>
    ref.startsWith("static-evidence-cache:")
  ));

  const differentBlock: CanonicalSource = Object.freeze({
    number: SOURCE.number + 1,
    hash: `0x${"52".repeat(32)}`,
    generation: SOURCE.generation + 2,
  });
  const thirdPublished = publisher();
  const third = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [match(GOOD, "00", differentBlock)],
    source: differentBlock,
    generation: differentBlock.generation,
    runtime: sharedRuntime,
    publisher: thirdPublished.sink,
  });
  assert(third.publication);
  assert.equal(
    scheduler.requestIds.filter((id) => id.startsWith("instance-static:")).length,
    2,
    "source-local evidence must miss at a different block",
  );
  assert.equal(
    scheduler.requestIds.filter((id) => id.startsWith("pricing-static:")).length,
    2,
    "source-local pricing evidence must miss at a different block",
  );
  assert.equal(cache.snapshot().rejectedReuse, 2);
}

async function testConflictingCandidateFailsClosed(): Promise<void> {
  const controls: FixtureControls = {
    candidateTagFromData: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const family = defineFixture("candidate-conflict", controls);
  const scheduler = new TestScheduler();
  const published = publisher();
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [match(GOOD, "01"), match(GOOD, "02")],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(scheduler),
    publisher: published.sink,
  });
  assert.equal(published.publications.length, 0);
  assert.equal(scheduler.requestIds.length, 0);
  assert(result.outcomes.some((outcome) =>
    outcome.status === "failed" &&
    outcome.reasonCode === "candidate-key-conflicting-identity-input"
  ));
}

async function testGenerationFencePreventsPublication(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("generation-fence", controls);
  const fence = new TestFence();
  const scheduler = new TestScheduler({
    afterTransport: (request) => {
      if (request.id.startsWith("dependent:")) fence.failAfter(2);
    },
  });
  const { result, publications } = await run({
    family,
    pools: [GOOD],
    scheduler,
    fence,
  });
  assert.equal(publications.length, 0);
  assert.equal(result.publication, null);
  assert(result.outcomes.some((outcome) =>
    outcome.status === "unresolved" &&
    outcome.reasonCode.includes("publication-fence:synthetic stale generation")
  ));
}

async function testDescriptorOnlyAndDependentReads(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("descriptor-only", controls);
  const scheduler = new TestScheduler();
  const { publications } = await run({
    family,
    pools: [GOOD, OTHER],
    scheduler,
  });
  assert.equal(publications.length, 1);
  assert.deepEqual([...controls.descriptorPools].sort(), [GOOD, OTHER].sort());
  assert.deepEqual(
    publications[0].instances.map((instance) => instance.instanceKey).sort(),
    [instanceKey(GOOD), instanceKey(OTHER)].sort(),
  );
  assert.deepEqual(
    scheduler.requestIds.filter((id) => id.startsWith("dependent:")).sort(),
    [`dependent:${GOOD}`, `dependent:${OTHER}`].sort(),
  );
  assert.equal(controls.unavailableCalls, 2);
}

async function testSharedBindingsExecuteCentrallyAndCoalesce(): Promise<void> {
  const finalSharedBindingCounts: number[] = [];
  const controls: FixtureControls = {
    sharedBindingKey: "token0",
    descriptorPools: [],
    finalSharedBindingCounts,
    unavailableCalls: 0,
  };
  const family = defineFixture("shared-binding-coalesce", controls);
  const scheduler = new TestScheduler();
  const observedStages: string[] = [];
  const { publications } = await run({
    family,
    pools: [GOOD, OTHER],
    scheduler,
    observedStages,
  });
  const requestId = `shared:fixture-binding:${TOKEN0}`;
  assert.equal(
    scheduler.requestIds.filter((id) => id === requestId).length,
    1,
    "one batch must execute a shared shard only once",
  );
  assert.equal(
    observedStages.filter((stage) => stage === "instance-static").length,
    3,
    "two instance reads plus one shared shard must use instance-static work",
  );
  assert.equal(finalSharedBindingCounts.filter((count) => count === 0).length, 2);
  assert.equal(finalSharedBindingCounts.filter((count) => count === 1).length, 2);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].instances.length, 2);

  const trustedEvidence = fingerprintTrustedResults([{
    id: requestId,
    ok: true,
    source: SOURCE,
    provenance: {
      kind: "fixture-scheduler",
      fingerprint: `issued:${requestId}`,
    },
    completion: "returned",
    data: "0x05",
  }]);
  const expectedFingerprint = hashCanonical({
    familyId: family.plugin.manifest.familyId,
    bindingKind: "fixture-binding",
    bindingKey: TOKEN0,
    capabilityHash: family.hashes.instance.contentHash,
    canonicalProjection: { word: "0x05" },
    trustedEvidence,
  });
  for (const instance of publications[0].instances) {
    const descriptor = instance.descriptor as Descriptor;
    assert.equal(descriptor.sharedBindings.length, 1);
    assert.deepEqual(descriptor.sharedBindings[0], {
      familyId: family.plugin.manifest.familyId,
      bindingKind: "fixture-binding",
      bindingKey: TOKEN0,
      fingerprint: expectedFingerprint,
    });
    assert(Object.isFrozen(descriptor.sharedBindings));
    assert(Object.isFrozen(descriptor.sharedBindings[0]));
    assert(instance.evidenceRefs.includes(`shared-binding:${expectedFingerprint}`));
  }
}

async function testSharedBindingFailureIsInstanceLocal(): Promise<void> {
  const controls: FixtureControls = {
    sharedBindingKey: "pool",
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const family = defineFixture("shared-binding-isolation", controls);
  const scheduler = new TestScheduler({
    fail: (request) =>
      request.id === `shared:fixture-binding:${GOOD}`,
  });
  const { result, publications } = await run({
    family,
    pools: [GOOD, OTHER],
    scheduler,
  });
  assert.equal(publications.length, 1);
  assert.deepEqual(
    publications[0].instances.map((instance) => instance.instanceKey),
    [instanceKey(OTHER)],
  );
  assert(result.outcomes.some((outcome) =>
    outcome.candidateKey === GOOD &&
    outcome.stage === "instance-compile" &&
    outcome.status === "unresolved" &&
    outcome.reasonCode === "adapter-work:transport:rpc"
  ));
  assert(result.outcomes.some((outcome) =>
    outcome.candidateKey === OTHER &&
    outcome.stage === "pricing-current" &&
    outcome.status === "verified"
  ));
  assert.equal(controls.unavailableCalls, 1);
}

async function testSharedBindingTwoPassDriftFailsClosed(): Promise<void> {
  const controls: FixtureControls = {
    sharedBindingKey: "token0",
    sharedReferenceDrift: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const family = defineFixture("shared-binding-drift", controls);
  const scheduler = new TestScheduler();
  const { result, publications } = await run({
    family,
    pools: [GOOD],
    scheduler,
  });
  assert.equal(publications.length, 0);
  assert.equal(
    scheduler.requestIds.filter((id) => id.startsWith("shared:")).length,
    1,
  );
  assert(result.outcomes.some((outcome) =>
    outcome.candidateKey === GOOD &&
    outcome.stage === "instance-compile" &&
    outcome.status === "failed" &&
    outcome.reasonCode.includes(
      "final descriptor changed its preliminary shared binding references",
    )
  ));
}

async function testSharedBindingProjectionThenableIsUnresolved(): Promise<void> {
  const controls: FixtureControls = {
    sharedBindingKey: "token0",
    sharedProjectionThenable: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const family = defineFixture("shared-binding-thenable", controls);
  const scheduler = new TestScheduler();
  const { result, publications } = await run({
    family,
    pools: [GOOD],
    scheduler,
  });
  assert.equal(publications.length, 0);
  assert(result.outcomes.some((outcome) =>
    outcome.candidateKey === GOOD &&
    outcome.stage === "instance-compile" &&
    outcome.status === "unresolved" &&
    outcome.reasonCode === "adapter-work:decode:decode-failure"
  ));
  assert.equal(controls.unavailableCalls, 0);
}

async function testCallerCannotInjectSharedBindingRefs(): Promise<void> {
  const controls: FixtureControls = {
    sharedBindingKey: "token0",
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const family = defineFixture("shared-binding-injection", controls);
  const scheduler = new TestScheduler();
  const published = publisher();
  const injected = {
    family,
    matches: [match(GOOD)],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(scheduler),
    publisher: published.sink,
    sharedBindings: {
      forInstance: () => [{
        familyId: family.plugin.manifest.familyId,
        bindingKind: "fixture-binding",
        bindingKey: TOKEN0,
        fingerprint: "caller-forged",
      }],
    },
  };
  await assert.rejects(
    executeAdapterFamilyLifecycleBatch(injected),
    /caller-provided shared bindings are forbidden/,
  );
  assert.equal(scheduler.requestIds.length, 0);
  assert.equal(published.publications.length, 0);
}

async function testRequestExactAndOwnedExecution(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("request-exact", controls);
  const scheduler = new TestScheduler();
  const { publications } = await run({ family, pools: [GOOD], scheduler });
  const instance = publications[0].instances[0];
  const route = issuedRoute(instance);
  const exact = await executeFamilyExactQuote({
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(scheduler),
  });
  assert.equal(exact.status, "resolved");
  if (exact.status !== "resolved") throw new Error("exact quote did not resolve");
  assert.equal(exact.amountOut, 10n);
  assert.equal(exact.methodId, "fixture-request-program");
  assert.equal(exact.methodIndex, 0);
  assert(exact.evidenceRefs.some((ref) => ref.startsWith("exact-method-order:")));
  assert(exact.evidenceRefs.some((ref) =>
    ref.startsWith("exact-method:0:fixture-request-program:request-program:")
  ));
  assert.equal(controls.localExactCalls ?? 0, 0);
  assert(scheduler.requestIds.includes(`exact:${GOOD}`));
  const requestCount = scheduler.requestIds.length;
  const execution = buildFamilyExecutionFragment({
    family,
    actionOwnership: ownershipFor(family),
    route,
    exact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [],
  });
  assert.equal(execution.status, "resolved");
  assert.equal(scheduler.requestIds.length, requestCount, "S4 must not perform I/O");
  assert.equal(controls.executionCalls, 1);
  if (execution.status !== "resolved") throw new Error("execution did not resolve");
  const returnedNode = execution.fragment.nodes[0];
  assert(Object.isFrozen(execution.fragment));
  assert(Object.isFrozen(execution.fragment.nodes));
  assert(Object.isFrozen(returnedNode));
  assert(Object.isFrozen(returnedNode.params));
  assert(Object.isFrozen(returnedNode.children));
  assert(Object.isFrozen(execution.expectedEffects));
  assert(Object.isFrozen(execution.expectedEffects[0]));
  (controls.lastPlanNode!.params as { amountOut: bigint }).amountOut = 999n;
  assert.equal(returnedNode.params.amountOut, 10n);
  assert.equal(returnedNode.params.minAmountOut, 9n);
  assert.throws(() => {
    (returnedNode.params as { amountOut: bigint }).amountOut = 2n;
  }, TypeError);
}

async function testOpaquePublicationAndEvidenceAreSealed(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("opaque-runtime-values", controls);
  const scheduler = new TestScheduler();
  const { publications } = await run({ family, pools: [GOOD], scheduler });
  const instance = publications[0].instances[0];
  const rawRoute = instance.routes[0] as Route;
  const route = issuedRoute(instance, rawRoute);

  assert(Object.isFrozen(instance.descriptor));
  assert(Object.isFrozen(rawRoute));
  assert.throws(() => {
    (instance.descriptor as unknown as { pool: string }).pool = OTHER;
  }, TypeError);
  assert.throws(() => {
    (rawRoute as unknown as { direction: string }).direction = "mutated";
  }, TypeError);
  assert.equal((instance.descriptor as Descriptor).pool, GOOD);
  assert.equal(rawRoute.direction, "zero-to-one");

  const callerSource: CanonicalSource = { ...SOURCE };
  const callerRuntimeEvidence: RuntimeEvidence = {
    evidenceId: "mutable-runtime-evidence",
    familyId: family.plugin.manifest.familyId,
    instanceKey: route.instanceKey,
    kind: "fixture",
    scope: "source-block",
    source: callerSource,
    evidenceHash: "original-evidence-hash",
    sealedPayloadRef: "original-payload-ref",
  };
  const matchingRuntimeEvidence: RuntimeEvidence = Object.freeze({
    ...callerRuntimeEvidence,
    source: SOURCE,
  });
  const exact = await executeFamilyExactQuote({
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [callerRuntimeEvidence],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(scheduler),
  });
  assert.equal(exact.status, "resolved");
  if (exact.status !== "resolved") throw new Error("sealed exact did not resolve");

  const producedExactEvidence = controls.lastProducedExactEvidence!;
  assert(Object.isFrozen(producedExactEvidence));
  assert(Object.isFrozen(producedExactEvidence.resultIds));
  assert.throws(() => {
    (producedExactEvidence as { witness: string }).witness = "mutated";
  }, TypeError);

  (callerRuntimeEvidence as { evidenceHash: string }).evidenceHash =
    "mutated-after-exact";
  (callerSource as { hash: string }).hash = `0x${"99".repeat(32)}`;
  const execution = buildFamilyExecutionFragment({
    family,
    actionOwnership: ownershipFor(family),
    route,
    exact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [matchingRuntimeEvidence],
  });
  assert.equal(execution.status, "resolved");

  assert.strictEqual(controls.lastExecutionExactEvidence, producedExactEvidence);
  const sealedRuntimeEvidence = controls.lastExecutionRuntimeEvidence!;
  assert(Object.isFrozen(sealedRuntimeEvidence));
  assert(Object.isFrozen(sealedRuntimeEvidence[0]));
  assert(Object.isFrozen(sealedRuntimeEvidence[0].source));
  assert.notStrictEqual(sealedRuntimeEvidence[0], callerRuntimeEvidence);
  assert.notStrictEqual(sealedRuntimeEvidence[0].source, callerSource);
  assert.equal(sealedRuntimeEvidence[0].evidenceHash, "original-evidence-hash");
  assert.equal(sealedRuntimeEvidence[0].source.hash, SOURCE.hash);
}

async function testIssuedRouteGraphProjectionBoundary(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("issued-graph", controls);
  const scheduler = new TestScheduler();
  const { publications } = await run({
    family,
    pools: [GOOD, OTHER],
    scheduler,
  });
  const instances = publications[0].instances;
  const firstRoute = instances[0].routes[0];
  const firstHandle = issuedRoute(instances[0]);
  const secondRoute = instances[1].routes[0];
  const secondHandle = issuedRoute(instances[1]);
  const scores = new Map<string, number>([[firstRoute.routeKey, 17]]);
  const view = buildFamilyRouteGraphView({
    routes: [
      {
        family,
        descriptor: instances[0].descriptor,
        route: firstRoute,
        handle: firstHandle,
      },
      {
        family,
        descriptor: instances[1].descriptor,
        route: secondRoute,
        handle: secondHandle,
      },
    ],
    centralScores: scores,
  });
  assert.equal(view.edges.length, 2);
  assert.equal(view.edges[0].adapterId, "issued-graph-convert");
  assert.equal(view.edges[0].score, 17);
  assert.equal(
    view.edges[1].score,
    0,
    "missing central score metadata must not become curated/pinned",
  );
  assert.notEqual(
    view.edges[0].canonicalEdgeId,
    view.edges[1].canonicalEdgeId,
  );
  assert.equal(
    view.handleByCanonicalEdgeId.get(view.edges[0].canonicalEdgeId),
    firstHandle,
  );
  assert.equal("set" in view.handleByCanonicalEdgeId, false);
  assert.equal("direction" in view.edges[0], false);

  const clonedRoute = Object.freeze({
    ...firstRoute,
    direction: "forged-private-direction" as never,
  });
  assert.throws(
    () => projectFamilyRouteGraph({
      family,
      descriptor: instances[0].descriptor,
      route: clonedRoute,
      handle: firstHandle,
    }),
    /not bound to the supplied descriptor\/route/,
  );
  assert.throws(
    () => projectFamilyRouteGraph({
      family,
      descriptor: Object.freeze({ ...instances[0].descriptor }),
      route: firstRoute,
      handle: firstHandle,
    }),
    /not bound to the supplied descriptor\/route/,
  );
  assert.throws(
    () => projectFamilyRouteGraph({
      family,
      descriptor: instances[0].descriptor,
      route: firstRoute,
      handle: Object.freeze({ ...firstHandle }) as FamilyRouteRuntimeHandle,
    }),
    /issued by the central runtime/,
  );
}

async function testOpaqueRouteAndExactHandleBoundary(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("opaque-handle-boundary", controls);
  const scheduler = new TestScheduler();
  const { publications } = await run({
    family,
    pools: [GOOD, OTHER],
    scheduler,
  });
  const firstInstance = publications[0].instances.find((instance) =>
    instance.candidateKey === GOOD
  )!;
  const secondInstance = publications[0].instances.find((instance) =>
    instance.candidateKey === OTHER
  )!;
  const firstRoute = issuedRoute(firstInstance);
  const secondRoute = issuedRoute(secondInstance);
  assert(Object.isFrozen(firstRoute));

  const forgedRoute = Object.freeze({
    ...firstRoute,
  }) as unknown as FamilyRouteRuntimeHandle;
  const forgedRouteQuote = await executeFamilyExactQuote({
    family,
    route: forgedRoute,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(scheduler),
  });
  assert.equal(forgedRouteQuote.status, "failed");
  assert(forgedRouteQuote.outcome.reasonCode.includes("must be issued"));

  const wrongSource = Object.freeze({
    ...SOURCE,
    generation: SOURCE.generation + 1,
  });
  const wrongSourceQuote = await executeFamilyExactQuote({
    family,
    route: firstRoute,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: wrongSource,
    generation: wrongSource.generation,
    runtime: runtime(scheduler),
  });
  assert.equal(wrongSourceQuote.status, "failed");
  assert(wrongSourceQuote.outcome.reasonCode.includes("route publication"));

  const runtimeEvidence: RuntimeEvidence = Object.freeze({
    evidenceId: "fixture-runtime-evidence",
    familyId: family.plugin.manifest.familyId,
    instanceKey: firstRoute.instanceKey,
    kind: "fixture",
    scope: "source-block",
    source: SOURCE,
    evidenceHash: "fixture-evidence-hash",
    sealedPayloadRef: "fixture-payload-ref",
  });
  const exact = await executeFamilyExactQuote({
    family,
    route: firstRoute,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [runtimeEvidence],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(scheduler),
  });
  assert.equal(exact.status, "resolved");
  if (exact.status !== "resolved") throw new Error("sealed exact did not resolve");
  assert(Object.isFrozen(exact));
  assert.equal("evidence" in exact, false, "exact evidence must remain private");
  assert.throws(() => {
    (exact as unknown as { amountOut: bigint }).amountOut = 99n;
  }, TypeError);

  const forgedExact = Object.freeze({
    ...exact,
  }) as unknown as SealedFamilyExactQuoteHandle;
  const forgedExecution = buildFamilyExecutionFragment({
    family,
    actionOwnership: ownershipFor(family),
    route: firstRoute,
    exact: forgedExact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [runtimeEvidence],
  });
  assert.equal(forgedExecution.status, "failed");
  assert(forgedExecution.outcome.reasonCode.includes("must be issued"));

  const wrongRouteExecution = buildFamilyExecutionFragment({
    family,
    actionOwnership: ownershipFor(family),
    route: secondRoute,
    exact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [runtimeEvidence],
  });
  assert.equal(wrongRouteExecution.status, "failed");
  assert(wrongRouteExecution.outcome.reasonCode.includes("issued Family route"));

  const wrongExecutorExecution = buildFamilyExecutionFragment({
    family,
    actionOwnership: ownershipFor(family),
    route: firstRoute,
    exact,
    minAmountOut: 9n,
    executor: OTHER,
    runtimeEvidence: [runtimeEvidence],
  });
  assert.equal(wrongExecutorExecution.status, "failed");
  assert(wrongExecutorExecution.outcome.reasonCode.includes("executor differs"));

  const differentEvidence = Object.freeze({
    ...runtimeEvidence,
    evidenceHash: "different-fixture-evidence-hash",
  });
  const wrongEvidenceExecution = buildFamilyExecutionFragment({
    family,
    actionOwnership: ownershipFor(family),
    route: firstRoute,
    exact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [differentEvidence],
  });
  assert.equal(wrongEvidenceExecution.status, "failed");
  assert(wrongEvidenceExecution.outcome.reasonCode.includes("evidence differs"));

  const execution = buildFamilyExecutionFragment({
    family,
    actionOwnership: ownershipFor(family),
    route: firstRoute,
    exact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [runtimeEvidence],
  });
  assert.equal(execution.status, "resolved");
  assert.equal(controls.executionCalls, 1);
}

async function testExactCacheBindsAmountAndPhysicalSource(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("exact-cache", controls);
  const scheduler = new TestScheduler();
  const prepared = await run({ family, pools: [GOOD], scheduler });
  const instance = prepared.publications[0].instances[0];
  const route = issuedRoute(instance);
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 4 });
  const sharedRuntime = runtime(
    scheduler,
    new TestFence(),
    [],
    undefined,
    cache,
  );
  const first = await executeFamilyExactQuote({
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: sharedRuntime,
  });
  assert.equal(first.status, "resolved");
  assert.equal(controls.exactDecodeCalls, 1);

  const retriedSource: CanonicalSource = Object.freeze({
    ...SOURCE,
    generation: SOURCE.generation + 1,
  });
  const retriedPrepared = await run({
    family,
    pools: [GOOD],
    scheduler,
    source: retriedSource,
  });
  const retriedRoute = issuedRoute(
    retriedPrepared.publications[0].instances[0],
  );
  const retried = await executeFamilyExactQuote({
    family,
    route: retriedRoute,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: retriedSource,
    generation: retriedSource.generation,
    runtime: sharedRuntime,
  });
  assert.equal(retried.status, "resolved");
  if (retried.status !== "resolved") throw new Error("exact cache did not resolve");
  assert.notEqual(
    retried,
    first,
    "a cache hit must issue a fresh sealed exact handle",
  );
  assert.equal(retried.outcome.reasonCode, "exact-cache-reused");
  assert.equal(retried.generation, retriedSource.generation);
  assert.equal(
    controls.exactDecodeCalls,
    2,
    "a cache hit must re-run the current Family decoder over trusted results",
  );
  assert(retried.evidenceRefs.some((ref) => ref.startsWith("exact-cache:")));
  assert.equal(
    scheduler.requestIds.filter((id) => id === `exact:${GOOD}`).length,
    1,
    "same amount and physical source should execute exact transport once",
  );

  const differentAmount = await executeFamilyExactQuote({
    family,
    route: retriedRoute,
    amountIn: 11n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: retriedSource,
    generation: retriedSource.generation,
    runtime: sharedRuntime,
  });
  assert.equal(differentAmount.status, "resolved");
  assert.equal(controls.exactDecodeCalls, 3);
  assert.equal(
    scheduler.requestIds.filter((id) => id === `exact:${GOOD}`).length,
    2,
    "amountIn is a central exact cache key component",
  );

  const differentBlock: CanonicalSource = Object.freeze({
    number: SOURCE.number + 1,
    hash: `0x${"53".repeat(32)}`,
    generation: SOURCE.generation + 2,
  });
  const nextPrepared = await run({
    family,
    pools: [GOOD],
    scheduler,
    source: differentBlock,
  });
  const nextBlock = await executeFamilyExactQuote({
    family,
    route: issuedRoute(nextPrepared.publications[0].instances[0]),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: differentBlock,
    generation: differentBlock.generation,
    runtime: sharedRuntime,
  });
  assert.equal(nextBlock.status, "resolved");
  assert.equal(controls.exactDecodeCalls, 4);
  assert.equal(
    scheduler.requestIds.filter((id) => id === `exact:${GOOD}`).length,
    3,
    "exact cache cannot carry across block hashes without a mutation proof",
  );
  assert.deepEqual(cache.snapshot(), {
    size: 3,
    capacity: 4,
    hits: 1,
    misses: 3,
    stores: 3,
    evictions: 0,
  });
}

async function testExactCacheBindsDeclaredRequestShape(): Promise<void> {
  const controls: FixtureControls = {
    descriptorPools: [],
    unavailableCalls: 0,
    exactCalldata: "0xdddddddd",
  };
  const family = defineFixture("exact-cache-request-shape", controls);
  const scheduler = new TestScheduler();
  const prepared = await run({ family, pools: [GOOD], scheduler });
  const instance = prepared.publications[0].instances[0];
  const route = issuedRoute(instance);
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 4 });
  const sharedRuntime = runtime(
    scheduler,
    new TestFence(),
    [],
    undefined,
    cache,
  );
  const exactInput = {
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: sharedRuntime,
  } as const;

  assert.equal((await executeFamilyExactQuote(exactInput)).status, "resolved");
  controls.exactCalldata = "0xeeeeeeee";
  assert.equal((await executeFamilyExactQuote(exactInput)).status, "resolved");
  assert.equal(
    scheduler.requestIds.filter((id) => id === `exact:${GOOD}`).length,
    2,
    "a changed physical request cannot reuse exact evidence under the same projection",
  );
  assert.deepEqual(cache.snapshot(), {
    size: 2,
    capacity: 4,
    hits: 0,
    misses: 2,
    stores: 2,
    evictions: 0,
  });
}

async function testExactCacheUsesCurrentRequestOrder(): Promise<void> {
  const controls: FixtureControls = {
    descriptorPools: [],
    unavailableCalls: 0,
    exactRequestOrder: "forward",
  };
  const family = defineFixture("exact-cache-request-order", controls);
  const scheduler = new TestScheduler();
  const prepared = await run({ family, pools: [GOOD], scheduler });
  const instance = prepared.publications[0].instances[0];
  const route = issuedRoute(instance);
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 4 });
  const sharedRuntime = runtime(
    scheduler,
    new TestFence(),
    [],
    undefined,
    cache,
  );
  const first = await executeFamilyExactQuote({
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: sharedRuntime,
  });
  assert.equal(first.status, "resolved");
  if (first.status !== "resolved") throw new Error("first exact quote failed");
  assert.deepEqual(
    controls.lastExactResultIds,
    [`exact:${GOOD}`, `exact-extra:${GOOD}`],
  );

  controls.exactRequestOrder = "reverse";
  const nextSource: CanonicalSource = Object.freeze({
    ...SOURCE,
    generation: SOURCE.generation + 1,
  });
  const nextPrepared = await run({
    family,
    pools: [GOOD],
    scheduler,
    source: nextSource,
  });
  const retried = await executeFamilyExactQuote({
    family,
    route: issuedRoute(nextPrepared.publications[0].instances[0]),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: nextSource,
    generation: nextSource.generation,
    runtime: sharedRuntime,
  });
  assert.equal(retried.status, "resolved");
  if (retried.status !== "resolved") throw new Error("cached exact quote failed");
  assert.equal(retried.outcome.reasonCode, "exact-cache-reused");
  assert.deepEqual(
    controls.lastExactResultIds,
    [`exact-extra:${GOOD}`, `exact:${GOOD}`],
    "cached results must be presented in the current request declaration order",
  );
  assert.equal(
    scheduler.requestIds.filter((id) =>
      id === `exact:${GOOD}` || id === `exact-extra:${GOOD}`
    ).length,
    2,
    "reordering an identical request set must not repeat physical transport",
  );
}

async function testExactDependentRoundsAreCentralBoundedAndCached(): Promise<void> {
  const controls: FixtureControls = {
    exactDependent: true,
    exactDependentRounds: 2,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const family = defineFixture("exact-dependent", controls);
  const scheduler = new TestScheduler();
  const prepared = await run({ family, pools: [GOOD], scheduler });
  const instance = prepared.publications[0].instances[0];
  const route = issuedRoute(instance);
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 4 });
  const sharedRuntime = runtime(
    scheduler,
    new TestFence(),
    [],
    undefined,
    cache,
  );
  const first = await executeFamilyExactQuote({
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: sharedRuntime,
    maxDependentReadRounds: 2,
  });
  assert.equal(first.status, "resolved");
  if (first.status !== "resolved") throw new Error("dependent exact failed");
  assert.equal(first.amountOut, 20n);
  assert.deepEqual(
    controls.lastExactResultIds,
    [
      `exact:${GOOD}`,
      `exact-dependent:${GOOD}:0`,
      `exact-dependent:${GOOD}:1`,
    ],
  );
  assert.equal(controls.exactDependentDecodeCalls, 2);

  const replaySource = Object.freeze({
    ...SOURCE,
    generation: SOURCE.generation + 1,
  });
  const replayPrepared = await run({
    family,
    pools: [GOOD],
    scheduler,
    source: replaySource,
  });
  const cached = await executeFamilyExactQuote({
    family,
    route: issuedRoute(replayPrepared.publications[0].instances[0]),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: replaySource,
    generation: replaySource.generation,
    runtime: sharedRuntime,
    maxDependentReadRounds: 2,
  });
  assert.equal(cached.status, "resolved");
  if (cached.status !== "resolved") throw new Error("dependent cache failed");
  assert.equal(cached.outcome.reasonCode, "exact-cache-reused");
  assert.equal(cached.amountOut, 20n);
  assert.equal(
    controls.exactDependentDecodeCalls,
    4,
    "cache replay must rebuild each dependent round's opaque evidence",
  );
  assert.deepEqual(
    scheduler.requestIds.filter((id) => id.startsWith("exact")),
    [
      `exact:${GOOD}`,
      `exact-dependent:${GOOD}:0`,
      `exact-dependent:${GOOD}:1`,
    ],
    "cache replay must reconstruct dependent rounds without physical I/O",
  );

  const endlessControls: FixtureControls = {
    exactDependent: true,
    exactDependentNeverSettles: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const endlessFamily = defineFixture("exact-dependent-budget", endlessControls);
  const endlessScheduler = new TestScheduler();
  const endlessPrepared = await run({
    family: endlessFamily,
    pools: [GOOD],
    scheduler: endlessScheduler,
  });
  const endlessInstance = endlessPrepared.publications[0].instances[0];
  const exhausted = await executeFamilyExactQuote({
    family: endlessFamily,
    route: issuedRoute(endlessInstance),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(endlessScheduler),
    maxDependentReadRounds: 1,
  });
  assert.equal(exhausted.status, "failed");
  assert.equal(
    exhausted.outcome.reasonCode,
    "exact-dependent-round-budget-exhausted",
  );
  assert.deepEqual(
    endlessScheduler.requestIds.filter((id) => id.startsWith("exact")),
    [`exact:${GOOD}`, `exact-dependent:${GOOD}:0`],
  );
}

async function testOnlyLocalNotApplicableCanFallback(): Promise<void> {
  const fallbackControls: FixtureControls = {
    localExactNotApplicable: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const fallbackFamily = defineFixture("local-fallback", fallbackControls);
  const fallbackScheduler = new TestScheduler();
  const fallbackPrepared = await run({
    family: fallbackFamily,
    pools: [GOOD],
    scheduler: fallbackScheduler,
  });
  const fallbackInstance = fallbackPrepared.publications[0].instances[0];
  const fallback = await executeFamilyExactQuote({
    family: fallbackFamily,
    route: issuedRoute(fallbackInstance),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(fallbackScheduler),
  });
  assert.equal(fallback.status, "resolved");
  if (fallback.status !== "resolved") throw new Error("fallback exact failed");
  assert.equal(fallback.methodId, "fixture-request-program");
  assert.equal(fallback.methodIndex, 1);
  assert.equal(fallbackControls.localExactCalls, 1);
  assert.deepEqual(
    fallbackScheduler.requestIds.filter((id) => id.startsWith("exact:")),
    [`exact:${GOOD}`],
  );
  assert(fallback.evidenceRefs.some((ref) => ref.includes("not-applicable")));

  const rpcControls: FixtureControls = {
    localExactNotApplicable: true,
    localExactAfterRequest: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const rpcFamily = defineFixture("request-no-fallback-rpc", rpcControls);
  const rpcScheduler = new TestScheduler({
    fail: (request) => request.id.startsWith("exact:"),
  });
  const rpcPrepared = await run({
    family: rpcFamily,
    pools: [GOOD],
    scheduler: rpcScheduler,
  });
  const rpcInstance = rpcPrepared.publications[0].instances[0];
  const rpc = await executeFamilyExactQuote({
    family: rpcFamily,
    route: issuedRoute(rpcInstance),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(rpcScheduler),
  });
  assert.equal(rpc.status, "unresolved");
  assert.equal(rpc.outcome.reasonCode, "adapter-work:transport:rpc");
  assert.equal(rpcControls.localExactCalls ?? 0, 0);

  const decodeControls: FixtureControls = {
    localExactNotApplicable: true,
    localExactAfterRequest: true,
    exactDecodeThrow: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const decodeFamily = defineFixture("request-no-fallback-decode", decodeControls);
  const decodeScheduler = new TestScheduler();
  const decodePrepared = await run({
    family: decodeFamily,
    pools: [GOOD],
    scheduler: decodeScheduler,
  });
  const decodeInstance = decodePrepared.publications[0].instances[0];
  const decode = await executeFamilyExactQuote({
    family: decodeFamily,
    route: issuedRoute(decodeInstance),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(decodeScheduler),
  });
  assert.equal(decode.status, "failed");
  assert(decode.outcome.reasonCode.includes("deterministic request decode bug"));
  assert.equal(decodeControls.localExactCalls ?? 0, 0);
}

async function testExactCacheIsolatedByIssuedFamilyBox(): Promise<void> {
  const controls: FixtureControls = { descriptorPools: [], unavailableCalls: 0 };
  const family = defineFixture("exact-cache-family-box", controls);
  const scheduler = new TestScheduler();
  const prepared = await run({ family, pools: [GOOD], scheduler });
  const instance = prepared.publications[0].instances[0];
  const route = issuedRoute(instance);
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 4 });
  const sharedRuntime = runtime(
    scheduler,
    new TestFence(),
    [],
    undefined,
    cache,
  );
  const first = await executeFamilyExactQuote({
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: sharedRuntime,
  });
  assert.equal(first.status, "resolved");

  const reloadedFamily = load(
    family.plugin as ReturnType<typeof defineProtocolFamily>,
    "exact-cache-family-box-reloaded.production.ts",
  );
  assert.notEqual(reloadedFamily, family);
  assert.equal(reloadedFamily.plugin, family.plugin);
  const replaySource: CanonicalSource = Object.freeze({
    ...SOURCE,
    generation: SOURCE.generation + 1,
  });
  const foreignHandle = await executeFamilyExactQuote({
    family: reloadedFamily,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: sharedRuntime,
  });
  assert.equal(foreignHandle.status, "failed");
  assert(foreignHandle.outcome.reasonCode.includes("catalog Family box"));
  const reloadedPrepared = await run({
    family: reloadedFamily,
    pools: [GOOD],
    scheduler,
    source: replaySource,
  });
  const reloaded = await executeFamilyExactQuote({
    family: reloadedFamily,
    route: issuedRoute(reloadedPrepared.publications[0].instances[0]),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: replaySource,
    generation: replaySource.generation,
    runtime: sharedRuntime,
  });
  assert.equal(reloaded.status, "resolved");
  if (reloaded.status !== "resolved") throw new Error("reloaded exact failed");
  assert.equal(reloaded.outcome.reasonCode, "request-exact-derived");
  assert.equal(
    scheduler.requestIds.filter((id) => id === `exact:${GOOD}`).length,
    2,
    "a new catalog-issued FamilyBox must not consume old opaque exact evidence",
  );
  assert.deepEqual(cache.snapshot(), {
    size: 2,
    capacity: 4,
    hits: 0,
    misses: 2,
    stores: 2,
    evictions: 0,
  });
}

async function testLocalExactSkipsScheduler(): Promise<void> {
  const controls: FixtureControls = {
    localExact: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const family = defineFixture("local-exact", controls);
  const scheduler = new TestScheduler();
  const { publications } = await run({ family, pools: [GOOD], scheduler });
  const instance = publications[0].instances[0];
  const route = issuedRoute(instance);
  const requestCount = scheduler.requestIds.length;
  const exact = await executeFamilyExactQuote({
    family,
    route,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(scheduler),
  });
  assert.equal(exact.status, "resolved");
  if (exact.status !== "resolved") throw new Error("local quote did not resolve");
  assert.equal(exact.amountOut, 11n);
  assert.equal(controls.localExactCalls, 1);
  assert.equal(scheduler.requestIds.length, requestCount);
  assert(!scheduler.requestIds.some((id) => id.startsWith("exact:")));
}

async function testEmptyAndThrowingLocalExactFailClosed(): Promise<void> {
  const emptyControls: FixtureControls = {
    localExact: true,
    omitQuoteLocal: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const emptyFamily = defineFixture("empty-exact", emptyControls);
  const emptyScheduler = new TestScheduler();
  const emptyRun = await run({
    family: emptyFamily,
    pools: [GOOD],
    scheduler: emptyScheduler,
  });
  const emptyInstance = emptyRun.publications[0].instances[0];
  const emptyResult = await executeFamilyExactQuote({
    family: emptyFamily,
    route: issuedRoute(emptyInstance),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(emptyScheduler),
  });
  assert.equal(emptyResult.status, "failed");
  assert.equal(
    emptyResult.outcome.reasonCode,
    "exact-declaration:exact methods must be a non-empty array",
  );

  const throwingControls: FixtureControls = {
    localExactNotApplicable: true,
    localExactThrow: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const throwingFamily = defineFixture("throwing-local-exact", throwingControls);
  const throwingScheduler = new TestScheduler();
  const throwingRun = await run({
    family: throwingFamily,
    pools: [OTHER],
    scheduler: throwingScheduler,
  });
  const throwingInstance = throwingRun.publications[0].instances[0];
  const throwingResult = await executeFamilyExactQuote({
    family: throwingFamily,
    route: issuedRoute(throwingInstance),
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(throwingScheduler),
  });
  assert.equal(throwingResult.status, "failed");
  assert(throwingResult.outcome.reasonCode.includes("deterministic local bug"));
  assert(!throwingScheduler.requestIds.some((id) => id.startsWith("exact:")));
}

async function testExecutionOwnershipAndThenableFailClosed(): Promise<void> {
  const foreignControls: FixtureControls = {
    executionAdapterId: "foreign-action",
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const foreignFamily = defineFixture("foreign-execution", foreignControls);
  const foreignScheduler = new TestScheduler();
  const foreignRun = await run({
    family: foreignFamily,
    pools: [GOOD],
    scheduler: foreignScheduler,
  });
  const foreignInstance = foreignRun.publications[0].instances[0];
  const foreignRoute = issuedRoute(foreignInstance);
  const foreignExact = await executeFamilyExactQuote({
    family: foreignFamily,
    route: foreignRoute,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(foreignScheduler),
  });
  assert.equal(foreignExact.status, "resolved");
  if (foreignExact.status !== "resolved") throw new Error("foreign exact failed");
  const rejected = buildFamilyExecutionFragment({
    family: foreignFamily,
    actionOwnership: ownershipFor(foreignFamily),
    route: foreignRoute,
    exact: foreignExact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [],
  });
  assert.equal(rejected.status, "rejected");
  assert(rejected.outcome.reasonCode.includes("foreign-action"));

  const thenableControls: FixtureControls = {
    executionThenable: true,
    descriptorPools: [],
    unavailableCalls: 0,
  };
  const thenableFamily = defineFixture("thenable-execution", thenableControls);
  const thenableScheduler = new TestScheduler();
  const thenableRun = await run({
    family: thenableFamily,
    pools: [OTHER],
    scheduler: thenableScheduler,
  });
  const thenableInstance = thenableRun.publications[0].instances[0];
  const thenableRoute = issuedRoute(thenableInstance);
  const thenableExact = await executeFamilyExactQuote({
    family: thenableFamily,
    route: thenableRoute,
    amountIn: 10n,
    executor: EXECUTOR,
    runtimeEvidence: [],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: runtime(thenableScheduler),
  });
  assert.equal(thenableExact.status, "resolved");
  if (thenableExact.status !== "resolved") throw new Error("thenable exact failed");
  const requestCount = thenableScheduler.requestIds.length;
  const failed = buildFamilyExecutionFragment({
    family: thenableFamily,
    actionOwnership: ownershipFor(thenableFamily),
    route: thenableRoute,
    exact: thenableExact,
    minAmountOut: 9n,
    executor: EXECUTOR,
    runtimeEvidence: [],
  });
  assert.equal(failed.status, "failed");
  assert(failed.outcome.reasonCode.includes("thenable"));
  assert.equal(thenableScheduler.requestIds.length, requestCount);
}

await testLifecycleSnapshotsCallerOwnedSourceAcrossAwait();
await testExactSnapshotsSourceAndRuntimeEvidenceAcrossAwait();
await testRpcFailureIsUnresolved();
await testProtocolNegativeRequiresSuccessfulEvidence();
await testSingleInstanceFailureIsolation();
await testDuplicateObservationCoalescing();
await testStaticEvidenceContentCacheAcrossGeneration();
await testConflictingCandidateFailsClosed();
await testGenerationFencePreventsPublication();
await testDescriptorOnlyAndDependentReads();
await testSharedBindingsExecuteCentrallyAndCoalesce();
await testSharedBindingFailureIsInstanceLocal();
await testSharedBindingTwoPassDriftFailsClosed();
await testSharedBindingProjectionThenableIsUnresolved();
await testCallerCannotInjectSharedBindingRefs();
await testRequestExactAndOwnedExecution();
await testOpaquePublicationAndEvidenceAreSealed();
await testIssuedRouteGraphProjectionBoundary();
await testOpaqueRouteAndExactHandleBoundary();
await testExactCacheBindsAmountAndPhysicalSource();
await testExactCacheBindsDeclaredRequestShape();
await testExactCacheUsesCurrentRequestOrder();
await testExactDependentRoundsAreCentralBoundedAndCached();
await testOnlyLocalNotApplicableCanFallback();
await testExactCacheIsolatedByIssuedFamilyBox();
await testLocalExactSkipsScheduler();
await testEmptyAndThrowingLocalExactFailClosed();
await testExecutionOwnershipAndThenableFailClosed();

console.log("adapter Family terminal lifecycle runtime tests passed");
