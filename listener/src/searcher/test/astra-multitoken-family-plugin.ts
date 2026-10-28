import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { bytesToHex } from "../../encoder.js";
import { astraMultiTokenChangeActionAdapter } from "../../adapters/astra-multitoken.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type {
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "../adapter-work-intent.js";
import {
  executeAdapterFamilyLifecycleBatch,
  type AdapterFamilyPublication,
} from "../venues/adapter-family-runtime.js";
import {
  definedFamilyPluginContractSummary,
  type AnyDefinedFamilyPlugin,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "../venues/adapter-request-program.js";
import type {
  StateRead,
  StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { generateCapabilityClosure } from "../venues/capability-content-hash.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
  type LoadedFamilyPlugin,
} from "../venues/family-capability-catalog.js";
import { astraMultiTokenStrictFamilyPlugin } from "../venues/protocols/astra-multitoken-family-plugin.js";
import {
  ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID,
  ASTRA_MULTITOKEN_CHANGE_LOG_PATTERN_ID,
} from "../venues/protocols/astra-multitoken-family/discovery.js";
import type {
  AstraMultiTokenCandidate,
  AstraMultiTokenIdentity,
  AstraMultiTokenIdentityEvidence,
} from "../venues/protocols/astra-multitoken-family/types.js";
import {
  ASTRA_ERC20_INTERFACE,
  ASTRA_MULTITOKEN_CHANGE_SELECTOR,
  ASTRA_MULTITOKEN_INTERFACE,
} from "../venues/protocols/astra-multitoken-family/codec.js";
import {
  astraMultiTokenAdapter,
} from "../venues/protocols/astra-multitoken.js";
import {
  astraMultiTokenEdge,
} from "../venues/protocols/astra-multitoken-discovery.js";

const TARGET = ethers.getAddress("0x00000000000000000000000000000000000000A1");
const BAD_TARGET = ethers.getAddress("0x00000000000000000000000000000000000000A2");
const TOKEN_A = ethers.getAddress("0x00000000000000000000000000000000000000B1");
const TOKEN_B = ethers.getAddress("0x00000000000000000000000000000000000000B2");
const TOKEN_C = ethers.getAddress("0x00000000000000000000000000000000000000B3");
const FOREIGN = ethers.getAddress("0x00000000000000000000000000000000000000B4");
const ACTOR = ethers.getAddress("0x00000000000000000000000000000000000000C1");
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_456,
  hash: `0x${"11".repeat(32)}`,
  generation: 9,
});
const PROVENANCE = Object.freeze({
  kind: "astra-fixture",
  fingerprint: "astra-multitoken-s1-v1",
});

const callData = ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData("change", [
  TOKEN_A,
  TOKEN_B,
  100n,
  150n,
]);
const callObservation: UnifiedObservation = Object.freeze({
  kind: "call",
  source: SOURCE,
  target: TARGET,
  sender: ACTOR,
  data: callData,
  transactionHash: `0x${"22".repeat(32)}`,
});
const changeLog = ASTRA_MULTITOKEN_INTERFACE.encodeEventLog(
  ASTRA_MULTITOKEN_INTERFACE.getEvent("Change")!,
  [TOKEN_A, TOKEN_B, ACTOR, 100n, 200n],
);
const logObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: TARGET,
  topics: Object.freeze(changeLog.topics),
  data: changeLog.data,
  transactionHash: `0x${"22".repeat(32)}`,
});

async function main(): Promise<void> {
  const backend = new AstraBackend();
  const callCandidate = astraMultiTokenStrictFamilyPlugin.discovery
    .decodeCandidate({
      observation: callObservation,
      matchedPatternId: ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID,
    });
  assert(callCandidate !== null);
  assert.equal(callCandidate.sourceKind, "observed-change-call");
  assert.equal(callCandidate.target, TARGET);
  assert.equal(callCandidate.actor, ACTOR);
  assert.equal(callCandidate.tokenIn, TOKEN_A);
  assert.equal(callCandidate.tokenOut, TOKEN_B);
  assert.equal(callCandidate.amountIn, 100n);
  assert.equal(callCandidate.minAmountOut, 150n);

  const logCandidate = astraMultiTokenStrictFamilyPlugin.discovery
    .decodeCandidate({
      observation: logObservation,
      matchedPatternId: ASTRA_MULTITOKEN_CHANGE_LOG_PATTERN_ID,
    });
  assert(logCandidate !== null);
  assert.equal(logCandidate.sourceKind, "change-log");
  assert.equal(logCandidate.observedAmountOut, 200n);
  assert.notEqual(
    astraMultiTokenStrictFamilyPlugin.discovery.candidateKey(callCandidate),
    astraMultiTokenStrictFamilyPlugin.discovery.candidateKey(logCandidate),
    "independent observations must not conflict at the candidate coalescer",
  );
  assert.equal(
    astraMultiTokenStrictFamilyPlugin.discovery.decodeCandidate({
      observation: {
        kind: "call",
        source: SOURCE,
        target: TARGET,
        data: callData,
        transactionHash: `0x${"22".repeat(32)}`,
      },
      matchedPatternId: ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID,
    }),
    null,
    "a call without its observed actor cannot become active-proof input",
  );
  assert.equal(
    astraMultiTokenStrictFamilyPlugin.discovery.decodeCandidate({
      observation: {
        kind: "call",
        source: SOURCE,
        target: TARGET,
        sender: ACTOR,
        data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData("change", [
          TOKEN_A,
          TOKEN_A,
          100n,
          0n,
        ]),
        transactionHash: `0x${"22".repeat(32)}`,
      },
      matchedPatternId: ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID,
    }),
    null,
    "same-token observations fail closed",
  );

  const identity = await runIdentity(callCandidate, backend);
  assert.equal(identity.subject, TARGET);
  assert.deepEqual(identity.facts.registryBinding.tokens, [
    TOKEN_A,
    TOKEN_B,
    TOKEN_C,
  ]);
  assert.deepEqual(
    identity.facts.registryBinding.tokenWeights.map((binding) => binding.weight),
    [1n, 2n, 3n],
  );
  assert.equal(identity.facts.behaviorBinding.interfaceMode, "erc165");
  assert.equal(
    identity.facts.behaviorBinding.activeProof,
    "registry-bound-effect-delta",
  );

  const legacyIdentity = await runIdentity(
    callCandidate,
    new AstraBackend({ legacyAbi: true }),
  );
  assert.equal(
    legacyIdentity.facts.behaviorBinding.interfaceMode,
    "legacy-abi",
    "the legacy ABI fallback remains supported only when both version calls are absent",
  );
  const emptyLegacyIdentity = await runIdentity(
    callCandidate,
    new AstraBackend({ legacyEmptyReturn: true }),
  );
  assert.equal(
    emptyLegacyIdentity.facts.behaviorBinding.interfaceMode,
    "legacy-abi",
    "a legacy empty return remains version absence, not a malformed active surface",
  );
  await assert.rejects(
    runIdentity(callCandidate, new AstraBackend({ denyInterface: true })),
    /identity surface is not supported/,
    "an explicit interface denial is not legacy absence",
  );

  const variant = astraMultiTokenStrictFamilyPlugin.identity.variants[0];
  const surfaceStep = { candidate: callCandidate, step: 0, evidence: undefined };
  const surfaceRequests = variant.buildRequests(surfaceStep);
  const failedSurfaceResults = [...await adapterResults(surfaceRequests, backend)];
  failedSurfaceResults[4] = Object.freeze({
    id: failedSurfaceResults[4].id,
    ok: false as const,
    source: SOURCE,
    failure: "rpc" as const,
  });
  assert.throws(
    () => variant.decode({ step: surfaceStep, results: failedSurfaceResults }),
    /unresolved: rpc/,
    "RPC failure remains unresolved and cannot become a behavior rejection",
  );

  const descriptorDraft = astraMultiTokenStrictFamilyPlugin.instance
    .compileDraft(identity);
  const descriptor = astraMultiTokenStrictFamilyPlugin.instance
    .finalizeDescriptor({
      identity,
      draft: descriptorDraft,
      sharedBindings: [],
    });
  assert(Object.isFrozen(descriptor));
  assert.deepEqual(
    descriptor.runtimeRequirements.map((requirement) => requirement.kind),
    ["source-state", "execution-actor", "quote-completion", "effect-observation"],
  );

  const routes = astraMultiTokenStrictFamilyPlugin.routes.project({ descriptor });
  assert.equal(routes.length, 6, "three verified tokens project all six directed pairs");
  assert.deepEqual(
    routes.map((route) => [route.tokenIn, route.tokenOut]),
    [
      [TOKEN_A, TOKEN_B],
      [TOKEN_A, TOKEN_C],
      [TOKEN_B, TOKEN_A],
      [TOKEN_B, TOKEN_C],
      [TOKEN_C, TOKEN_A],
      [TOKEN_C, TOKEN_B],
    ],
  );
  assert.equal(new Set(routes.map((route) => route.routeKey)).size, 6);
  assert.equal(new Set(routes.map((route) => route.bindingRef.fingerprint)).size, 1);

  const legacyEdges = routes.map((route) => astraMultiTokenEdge(
    descriptor.target,
    route.tokenIn,
    route.tokenOut,
  ));
  assert.deepEqual(
    routes.map(routeSemantics),
    legacyEdges.map((edge) => ({
      adapterId: edge.adapterId,
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      slotKind: edge.slotKind,
      protocolAction: edge.protocolAction,
      leavesStandingPosition: edge.leavesStandingPosition,
    })),
    "strict all-directed-pairs projection preserves legacy Astra semantics",
  );

  assert.throws(
    () => astraMultiTokenStrictFamilyPlugin.pricing.compileDraft({
      descriptor,
      stateKey: routes[0].routeKey,
      routes,
    }),
    /requires one route/,
    "pricing compilation cannot regain a whole-Family route array",
  );
  const selected = routes[0];
  const pricingDraft = astraMultiTokenStrictFamilyPlugin.pricing.compileDraft({
    descriptor,
    stateKey: selected.routeKey,
    routes: [selected],
  });
  assert.equal("tokens" in pricingDraft, false);
  assert.equal("groups" in pricingDraft, false);
  const staticProgram = astraMultiTokenStrictFamilyPlugin.pricing.staticEvidence;
  assert(staticProgram !== undefined);
  const staticRequests = staticProgram.buildRequests(pricingDraft);
  assert.equal(staticRequests.length, 1);
  assert.equal(requestTarget(staticRequests[0]), TOKEN_A);
  const staticEvidence = staticProgram.decode({
    programInput: pricingDraft,
    results: await adapterResults(staticRequests, backend),
  });
  const pricingDescriptor = astraMultiTokenStrictFamilyPlugin.pricing
    .finalizePricingDescriptor({
      draft: pricingDraft,
      staticEvidence,
      sharedBindings: [],
    });
  assert.equal(pricingDescriptor.oneToken, 10n ** 18n);
  const currentInput = Object.freeze({
    descriptor: pricingDescriptor,
    routes: Object.freeze([selected]),
    source: SOURCE,
  });
  const currentRequests = astraMultiTokenStrictFamilyPlugin.pricing.current
    .buildRequests(currentInput);
  assert.equal(currentRequests.length, 1, "one StateInstance performs one current read");
  const currentResults = await adapterResults(currentRequests, backend);
  const snapshot = astraMultiTokenStrictFamilyPlugin.pricing.current
    .decodeSnapshot({
      descriptor: pricingDescriptor,
      initialResults: currentResults,
      dependentEvidence: [],
    });
  const strictMids = astraMultiTokenStrictFamilyPlugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    snapshot,
    routes: [selected],
  });
  assert.equal(strictMids.size, 1);
  assert.equal(strictMids.get(selected.routeKey)?.mid, 2);

  const legacyState = astraMultiTokenAdapter.pricingState;
  let legacySchema = await legacyState.compileStaticSchema({
    edges: [legacyEdges[0]],
    deadlineAtMs: Date.now() + 10_000,
    signal: new AbortController().signal,
  });
  const legacyStaticReads = legacyState.buildStaticSchemaReads!({
    schema: legacySchema,
    edges: [legacyEdges[0]],
    sourceBlock: SOURCE.number,
    sourceBlockHash: SOURCE.hash,
  });
  legacySchema = legacyState.hydrateStaticSchema!(
    legacySchema,
    await stateResults(legacyStaticReads, backend),
  );
  const legacyCurrentReads = legacyState.buildCurrentBlockReads({
    schema: legacySchema,
    edges: [legacyEdges[0]],
    sourceBlock: SOURCE.number,
    sourceBlockHash: SOURCE.hash,
  });
  const legacySnapshot = legacyState.decodeState(
    legacySchema,
    await stateResults(legacyCurrentReads, backend),
  );
  const legacyMids = legacyState.deriveMids(legacySnapshot, [legacyEdges[0]]);
  assert.deepEqual(
    [...strictMids.values()].map(midSemantics),
    [...legacyMids.values()].map(midSemantics),
    "descriptor-only per-route pricing preserves the legacy current getReturn mid",
  );

  const amountIn = 11n;
  const exactInput = Object.freeze({
    descriptor,
    route: selected,
    amountIn,
    source: SOURCE,
    executor: ACTOR,
    runtimeEvidence: Object.freeze([]),
  });
  const exactMethods = astraMultiTokenStrictFamilyPlugin.exact.methods(exactInput);
  const exactRequestMethod = exactMethods[1];
  assert.equal(exactRequestMethod.kind, "request-program");
  if (exactRequestMethod.kind !== "request-program") {
    throw new Error("Astra exact request program is missing");
  }
  const exactRequests = exactRequestMethod.program.buildRequests(exactInput);
  assert.equal(exactRequests.length, 1);
  const strictExact = exactRequestMethod.program.decode({
    programInput: exactInput,
    initialResults: await adapterResults(exactRequests, backend),
    dependentEvidence: [],
  });
  const legacyExact = await astraMultiTokenAdapter.quoteExact({
    state: backend as unknown as StateBackend,
    target: TARGET,
    edgeAdapterId: "astra-multitoken-change",
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    amountIn,
  });
  assert.equal(strictExact.amountOut, legacyExact);
  assert.equal(strictExact.amountOut, 22n);
  const zeroInput = Object.freeze({ ...exactInput, amountIn: 0n });
  const zeroMethod = astraMultiTokenStrictFamilyPlugin.exact.methods(zeroInput)[0];
  assert.equal(zeroMethod.kind, "local");
  if (zeroMethod.kind !== "local") throw new Error("Astra local method missing");
  const zeroAttempt = zeroMethod.quote(zeroInput);
  assert.equal(
    zeroAttempt.status === "quoted" ? zeroAttempt.result.amountOut : null,
    0n,
  );
  assert.throws(
    () => exactRequestMethod.program.buildRequests({
      ...exactInput,
      route: { ...selected, tokenOut: FOREIGN },
    }),
    /not registry-bound/,
  );
  assert.throws(
    () => exactRequestMethod.program.buildRequests({
      ...exactInput,
      route: {
        ...selected,
        taxonomy: { slotKind: "swap" },
      } as never,
    }),
    /not registry-bound/,
    "a forged Domain taxonomy cannot borrow an Astra route binding",
  );
  assert.throws(
    () => exactRequestMethod.program.buildRequests({
      ...exactInput,
      descriptor: {
        ...descriptor,
        behaviorBinding: {
          ...descriptor.behaviorBinding,
          changeFee: descriptor.behaviorBinding.changeFee + 1n,
        },
      },
    }),
    /not registry-bound/,
    "a stale route fingerprint cannot survive an immutable binding change",
  );

  const strictFragment = astraMultiTokenStrictFamilyPlugin.execution
    .buildFragment({
      descriptor,
      route: selected,
      amountIn,
      quotedAmountOut: strictExact.amountOut,
      minAmountOut: strictExact.amountOut,
      exactEvidence: strictExact.evidence,
      executor: ACTOR,
      runtimeEvidence: [],
    });
  const legacyFragment = await astraMultiTokenAdapter.buildPlanFragment({
    edge: legacyEdges[0],
    amountIn,
    amountOut: strictExact.amountOut,
    executor: ACTOR,
    state: backend as unknown as StateBackend,
  });
  assert.deepEqual(strictFragment, legacyFragment);
  assert.throws(
    () => astraMultiTokenStrictFamilyPlugin.execution.buildFragment({
      descriptor,
      route: selected,
      amountIn,
      quotedAmountOut: strictExact.amountOut + 1n,
      minAmountOut: strictExact.amountOut,
      exactEvidence: strictExact.evidence,
      executor: ACTOR,
      runtimeEvidence: [],
    }),
    /incompatible exact evidence/,
  );

  const summary = definedFamilyPluginContractSummary(
    astraMultiTokenStrictFamilyPlugin,
  );
  assert.equal(summary.domain, "protocol");
  assert.deepEqual(summary.ownedActionAdapterIds, ["astra-multitoken-change"]);
  assert.deepEqual(summary.requiredInfraActionAdapterIds, ["erc20-approve"]);
  const strictEncoded = astraMultiTokenStrictFamilyPlugin.actionAdapters[0]
    .encode(strictFragment.nodes[0], ACTOR, new Uint8Array());
  const legacyEncoded = astraMultiTokenChangeActionAdapter.encode(
    strictFragment.nodes[0],
    ACTOR,
    new Uint8Array(),
  );
  assert.deepEqual(strictEncoded, legacyEncoded);
  const encodedCalldata = bytesToHex(strictEncoded.slice(24));
  assert.equal(encodedCalldata.slice(0, 10), ASTRA_MULTITOKEN_CHANGE_SELECTOR);
  const encodedArgs = ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData(
    "change",
    encodedCalldata,
  );
  assert.equal(ethers.getAddress(String(encodedArgs[0])), TOKEN_A);
  assert.equal(ethers.getAddress(String(encodedArgs[1])), TOKEN_B);
  assert.equal(BigInt(encodedArgs[2]), amountIn);
  assert.equal(BigInt(encodedArgs[3]), strictExact.amountOut);

  await assertLifecycleFailureIsolation(backend);
  await assertCapabilityRoots();

  console.log(
    "astra-multitoken-family-plugin PASS " +
      "(call/log discovery, active registry proof, six routes, per-route pricing, exact/execution parity, isolation)",
  );
}

async function runIdentity(
  candidate: AstraMultiTokenCandidate,
  backend: AstraBackend,
): Promise<AstraMultiTokenIdentity> {
  const variant = astraMultiTokenStrictFamilyPlugin.identity.variants[0];
  let evidence: AstraMultiTokenIdentityEvidence | undefined;
  for (let step = 0; step < 3; step++) {
    const input = { candidate, evidence, step };
    assert.deepEqual(variant.decide(input), { status: "continue" });
    const requests = variant.buildRequests(input);
    assert(requests.length > 0);
    evidence = variant.decode({
      step: input,
      results: await adapterResults(requests, backend),
    }) as AstraMultiTokenIdentityEvidence;
  }
  const decision = variant.decide({ candidate, evidence, step: 3 });
  assert.equal(decision.status, "verified");
  return decision.identity;
}

async function assertLifecycleFailureIsolation(
  backend: AstraBackend,
): Promise<void> {
  const family = loadFamily(astraMultiTokenStrictFamilyPlugin);
  const publications: AdapterFamilyPublication[] = [];
  const runtime = testRuntime(new AstraScheduler(backend, BAD_TARGET));
  const badObservation: UnifiedObservation = Object.freeze({
    ...callObservation,
    target: BAD_TARGET,
    transactionHash: `0x${"33".repeat(32)}`,
  });
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [{
      observation: callObservation,
      matchedPatternId: ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID,
    }, {
      observation: badObservation,
      matchedPatternId: ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID,
    }],
    source: SOURCE,
    generation: SOURCE.generation,
    runtime,
    publisher: { publish: (publication) => publications.push(publication) },
  });
  assert.equal(publications.length, 1);
  assert.equal(publications[0].instances.length, 1);
  assert.equal(publications[0].instances[0].descriptor.instanceKey, TARGET.toLowerCase());
  assert.equal(publications[0].instances[0].routes.length, 6);
  assert.equal(publications[0].instances[0].pricingInstances.length, 6);
  assert(result.outcomes.some((outcome) =>
    outcome.candidateKey.startsWith(BAD_TARGET.toLowerCase()) &&
    outcome.stage === "identity" &&
    outcome.status === "unresolved"
  ));
  assert(result.outcomes.some((outcome) =>
    outcome.instanceKey === TARGET.toLowerCase() &&
    outcome.stage === "pricing-current" &&
    outcome.status === "verified"
  ));
}

async function assertCapabilityRoots(): Promise<void> {
  const listenerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const familyDirectory = resolve(
    listenerRoot,
    "src/searcher/venues/protocols/astra-multitoken-family",
  );
  const manifestRoot = resolve(familyDirectory, "manifest.ts");
  const capabilityRoots = {
    discovery: resolve(familyDirectory, "discovery.ts"),
    identity: resolve(familyDirectory, "identity.ts"),
    instance: resolve(familyDirectory, "instance.ts"),
    routes: resolve(familyDirectory, "routes.ts"),
    pricing: resolve(familyDirectory, "pricing.ts"),
    exact: resolve(familyDirectory, "exact.ts"),
    execution: resolve(familyDirectory, "execution.ts"),
  } as const;
  assert.equal(new Set(Object.values(capabilityRoots)).size, 7);
  assert(!Object.values(capabilityRoots).includes(
    resolve(familyDirectory, "protocol.ts") as never,
  ));
  const generated = await Promise.all(Object.entries(capabilityRoots).map(
    async ([capability, entryFile]) => generateCapabilityClosure({
      familyId: astraMultiTokenStrictFamilyPlugin.manifest.familyId,
      capability: capability as keyof typeof capabilityRoots,
      rootDirectory: listenerRoot,
      entryFile,
      additionalEntryFiles: [
        manifestRoot,
        ...(capability === "execution"
          ? [resolve(familyDirectory, "action.ts")]
          : []),
      ],
      provenanceCommit: null,
    }),
  ));
  assert.equal(new Set(generated.map((entry) => entry.entryLogicalId)).size, 7);
  for (const closure of generated) {
    assert(
      closure.identity.semanticDependencies.every((dependency) =>
        !dependency.endsWith("protocols/astra-multitoken.ts") &&
        !dependency.endsWith("protocols/astra-multitoken-discovery.ts") &&
        !dependency.endsWith("shared/state/state-backend.ts") &&
        !dependency.includes("adapter-family-lifecycle-content-cache") &&
        !dependency.includes("adapter-family-exact-quote-cache") &&
        !dependency.includes("adapter-work-intent") &&
        !dependency.includes("reth-adapter-work-runtime")
      ),
      `${closure.identity.capability} closure inherited legacy or central runtime APIs`,
    );
  }
  const execution = generated.find(
    (entry) => entry.identity.capability === "execution",
  )!;
  assert(execution.identity.semanticDependencies.some((dependency) =>
    dependency.endsWith("adapters/astra-multitoken.ts")
  ));
}

function loadFamily(plugin: AnyDefinedFamilyPlugin): LoadedFamilyPlugin {
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
      sourceFile: "astra-multitoken-family-plugin.ts",
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
  return catalog.forFamily(plugin.manifest.familyId);
}

function testRuntime(scheduler: CentralAdapterScheduler): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: { assertCurrent() {} },
    callerAuthority: {
      bind: () => ({
        executor: ACTOR.toLowerCase(),
        observedSender: ACTOR.toLowerCase(),
        verifiedActors: { "astra-test-actor": ACTOR.toLowerCase() },
      }),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "foreground",
        deadlineAtMs: 99_999,
        maxAttempts: 1,
        transportPool: input.requirements.transports.includes(
          "effect-delta-simulation",
        ) ? "effect-sim" : "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler,
  };
}

class AstraScheduler implements CentralAdapterScheduler {
  constructor(
    private readonly backend: AstraBackend,
    private readonly failedTarget: string,
  ) {}

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (familyId, requests) => {
        assert.equal(familyId, input.subject.familyId);
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        async (request): Promise<AdapterRequestResult> => {
          if (
            request.id === "surface-token-count" &&
            requestTarget(request) === this.failedTarget
          ) {
            return Object.freeze({
              id: request.id,
              ok: false as const,
              source: execution.source,
              failure: "rpc" as const,
            });
          }
          return executeAdapterRequest(request, this.backend, execution.source);
        },
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

async function adapterResults(
  requests: readonly AdapterRequest[],
  backend: AstraBackend,
): Promise<readonly AdapterRequestResult[]> {
  return Object.freeze(await Promise.all(requests.map((request) =>
    executeAdapterRequest(request, backend, SOURCE)
  )));
}

async function executeAdapterRequest(
  request: AdapterRequest,
  backend: AstraBackend,
  source: CanonicalSource,
): Promise<AdapterRequestResult> {
  try {
    const executed = request.kind === "eth-call"
      ? { data: await backend.call({ to: request.to, data: request.data }), effects: undefined }
      : request.kind === "get-code"
      ? { data: await backend.getCode(request.address), effects: undefined }
      : request.kind === "get-storage"
      ? { data: ethers.ZeroHash, effects: undefined }
      : await backend.simulate(request);
    return Object.freeze({
      id: request.id,
      ok: true as const,
      source,
      provenance: PROVENANCE,
      completion: "returned" as const,
      data: executed.data,
      ...(executed.effects === undefined ? {} : { effects: executed.effects }),
    });
  } catch (error) {
    if (
      request.kind === "eth-call" &&
      request.completion === "return-or-revert-data" &&
      error instanceof OptionalAbiAbsence
    ) {
      return Object.freeze({
        id: request.id,
        ok: true as const,
        source,
        provenance: PROVENANCE,
        completion: "reverted-as-declared" as const,
        data: "0x",
      });
    }
    throw error;
  }
}

async function stateResults(
  reads: readonly StateRead[],
  backend: AstraBackend,
): Promise<readonly StateReadResult[]> {
  return Object.freeze(await Promise.all(reads.map(async (read) =>
    Object.freeze({
      id: read.id,
      ok: true as const,
      sourceBlock: read.sourceBlock,
      sourceBlockHash: read.sourceBlockHash,
      provenance: Object.freeze({
        kind: "eip1898" as const,
        source: SOURCE,
        requireCanonical: true as const,
      }),
      data: await backend.call({ to: read.to, data: read.data }),
    })
  )));
}

function routeSemantics(route: {
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly taxonomy: { readonly slotKind: string; readonly protocolAction?: string };
}) {
  return {
    adapterId: "astra-multitoken-change",
    target: route.target,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    slotKind: route.taxonomy.slotKind,
    protocolAction: route.taxonomy.protocolAction,
    leavesStandingPosition: false,
  };
}

function midSemantics(mid: {
  readonly kind: string;
  readonly pool: string;
  readonly mid: number;
  readonly feeBps: number;
  readonly reserveA?: bigint;
  readonly reserveB?: bigint;
  readonly depthProxy: number;
}) {
  return {
    kind: mid.kind,
    pool: mid.pool,
    mid: mid.mid,
    feeBps: mid.feeBps,
    reserveA: mid.reserveA,
    reserveB: mid.reserveB,
    depthProxy: mid.depthProxy,
  };
}

function requestTarget(request: AdapterRequest): string {
  return ethers.getAddress(request.kind === "eth-call"
    ? request.to
    : request.kind === "get-code" || request.kind === "get-storage"
    ? request.address
    : request.call.to);
}

class OptionalAbiAbsence extends Error {}

class AstraBackend {
  private readonly tokens = Object.freeze([TOKEN_A, TOKEN_B, TOKEN_C]);

  constructor(private readonly options: {
    readonly legacyAbi?: boolean;
    readonly legacyEmptyReturn?: boolean;
    readonly denyInterface?: boolean;
  } = {}) {}

  async getCode(address: string): Promise<string> {
    const normalized = ethers.getAddress(address);
    if (
      normalized !== TARGET &&
      normalized !== BAD_TARGET &&
      !this.tokens.includes(normalized as typeof TOKEN_A)
    ) return "0x";
    return "0x60006000";
  }

  async call(request: { readonly to: string; readonly data: string }): Promise<string> {
    const to = ethers.getAddress(request.to);
    const selector = request.data.slice(0, 10).toLowerCase();
    if (
      this.tokens.includes(to as typeof TOKEN_A) &&
      selector === ASTRA_ERC20_INTERFACE.getFunction("decimals")!.selector
    ) {
      return ASTRA_ERC20_INTERFACE.encodeFunctionResult("decimals", [18]);
    }
    if (to !== TARGET && to !== BAD_TARGET) {
      throw new Error(`unexpected Astra target ${to}`);
    }
    if (
      selector ===
        ASTRA_MULTITOKEN_INTERFACE.getFunction("supportsInterface")!.selector
    ) {
      if (this.options.legacyAbi) throw new OptionalAbiAbsence("legacy ABI");
      if (this.options.legacyEmptyReturn) return "0x";
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
        "supportsInterface",
        [!this.options.denyInterface],
      );
    }
    if (
      selector ===
        ASTRA_MULTITOKEN_INTERFACE.getFunction("inLendingMode")!.selector
    ) {
      if (this.options.legacyAbi) throw new OptionalAbiAbsence("legacy ABI");
      if (this.options.legacyEmptyReturn) return "0x";
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult("inLendingMode", [0n]);
    }
    if (selector === ASTRA_MULTITOKEN_INTERFACE.getFunction("tokensCount")!.selector) {
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
        "tokensCount",
        [this.tokens.length],
      );
    }
    if (selector === ASTRA_MULTITOKEN_INTERFACE.getFunction("tokens")!.selector) {
      const [index] = ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData(
        "tokens",
        request.data,
      );
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
        "tokens",
        [this.tokens[Number(index)]],
      );
    }
    if (selector === ASTRA_MULTITOKEN_INTERFACE.getFunction("weights")!.selector) {
      const [token] = ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData(
        "weights",
        request.data,
      );
      const index = this.tokens.findIndex((item) =>
        item.toLowerCase() === String(token).toLowerCase()
      );
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult("weights", [
        BigInt(index + 1),
      ]);
    }
    if (
      selector ===
        ASTRA_MULTITOKEN_INTERFACE.getFunction("changesEnabled")!.selector
    ) {
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
        "changesEnabled",
        [true],
      );
    }
    if (selector === ASTRA_MULTITOKEN_INTERFACE.getFunction("changeFee")!.selector) {
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult("changeFee", [123n]);
    }
    if (
      selector ===
        ASTRA_MULTITOKEN_INTERFACE.getFunction("TOTAL_PERCRENTS")!.selector
    ) {
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
        "TOTAL_PERCRENTS",
        [1_000_000n],
      );
    }
    if (selector === ASTRA_MULTITOKEN_INTERFACE.getFunction("getReturn")!.selector) {
      const [tokenIn, tokenOut, amountIn] =
        ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData("getReturn", request.data);
      assert.notEqual(String(tokenIn).toLowerCase(), String(tokenOut).toLowerCase());
      return ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult("getReturn", [
        quote(BigInt(amountIn)),
      ]);
    }
    throw new Error(`unexpected Astra selector ${selector}`);
  }

  async simulate(request: Extract<AdapterRequest, {
    readonly kind: "state-override-simulation" | "effect-delta-simulation";
  }>) {
    const [tokenIn, tokenOut, amountIn] =
      ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData(
        "change",
        request.call.data,
      );
    const input = BigInt(amountIn);
    const output = quote(input);
    const target = ethers.getAddress(request.call.to);
    assert.equal(request.call.caller.kind, "observed-sender");
    const actor = ethers.getAddress(ACTOR);
    const inputToken = ethers.getAddress(String(tokenIn));
    const outputToken = ethers.getAddress(String(tokenOut));
    const log = ASTRA_MULTITOKEN_INTERFACE.encodeEventLog(
      ASTRA_MULTITOKEN_INTERFACE.getEvent("Change")!,
      [inputToken, outputToken, actor, input, output],
    );
    return {
      data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult("change", [output]),
      effects: Object.freeze({
        tokenDeltas: Object.freeze([
          Object.freeze({ token: inputToken, account: actor, delta: -input }),
          Object.freeze({ token: inputToken, account: target, delta: input }),
          Object.freeze({ token: outputToken, account: target, delta: -output }),
          Object.freeze({ token: outputToken, account: actor, delta: output }),
        ]),
        logs: Object.freeze([Object.freeze({
          address: target,
          topics: Object.freeze(log.topics),
          data: log.data,
        })]),
      }),
    };
  }
}

function quote(amountIn: bigint): bigint {
  return amountIn * 2n;
}

await main();
