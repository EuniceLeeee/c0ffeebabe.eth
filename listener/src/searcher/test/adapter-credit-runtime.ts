import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  buildCreditExecutionFragment,
  executeCreditRiskQuote,
  issueCreditExecutionHandle,
  prepareCreditFamilyRoutes,
  projectCreditRouteGraph,
  type CreditRouteRuntimeHandle,
  type ProjectedCreditRouteGraph,
  type SealedCreditExecutionHandle,
  type SealedCreditRiskQuoteHandle,
} from "../adapter-credit-runtime.js";
import {
  buildFamilyRouteGraphView,
} from "../adapter-family-graph-runtime.js";
import {
  StrictAdapterFamilyShadowCatalogPublicationRoot,
  createStrictCatalogConsumer,
  readStrictCreditRoute,
} from "../adapter-family-shadow-catalog-publication.js";
import {
  catalogDiscoverySourceFingerprint,
  createCatalogSourceTransitionIssuer,
  createCatalogTerminalRemovalIssuer,
} from "../adapter-family-catalog-publication.js";
import type { CanonicalEdgeId } from
  "../venues/blockscan-state-capability.js";
import {
  executeCreditFamilyInstanceLifecycle,
  type FamilyLifecycleMatch,
  type PreparedFamilyInstance,
} from "../venues/adapter-family-runtime.js";
import type {
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "../adapter-work-intent.js";
import {
  defineCreditFamily,
  definedFamilyPluginContractSummary,
  type AnyDefinedStrictFamilyPlugin,
  type RuntimeEvidence,
} from "../venues/adapter-family-plugin.js";
import {
  familyId,
} from "../venues/adapter-family-identifiers.js";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
  type ObservedEffects,
} from "../venues/adapter-request-program.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
  type LoadedFamilyBox,
} from "../venues/family-capability-catalog.js";
import {
  fluidCreditStrictFamilyPlugin,
  type FluidCreditCandidate,
  type FluidCreditDescriptor,
  type FluidCreditIdentity,
  type FluidCreditRiskEvidence,
} from "../venues/credit/fluid-family-plugin.js";
import {
  FLUID_CREDIT_PROBE_ACTOR,
  FLUID_VAULT_FACTORY_INTERFACE,
  FLUID_VAULT_INTERFACE,
  fluidDebtAmount,
} from "../venues/credit/fluid-family/codec.js";
import { FLUID_CREDIT_OPERATE_CALL_PATTERN_ID } from
  "../venues/credit/fluid-family/discovery.js";
import { FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID } from
  "../venues/credit/fluid-family/identity.js";

const VAULT_A = ethers.getAddress(`0x${"11".repeat(20)}`);
const VAULT_B = ethers.getAddress(`0x${"12".repeat(20)}`);
const FACTORY = ethers.getAddress(`0x${"21".repeat(20)}`);
const LIQUIDITY = ethers.getAddress(`0x${"22".repeat(20)}`);
const SUPPLY_A = ethers.getAddress(`0x${"31".repeat(20)}`);
const BORROW_A = ethers.getAddress(`0x${"32".repeat(20)}`);
const SUPPLY_B = ethers.getAddress(`0x${"33".repeat(20)}`);
const BORROW_B = ethers.getAddress(`0x${"34".repeat(20)}`);
const EXECUTOR = ethers.getAddress(`0x${"41".repeat(20)}`);
const OTHER_EXECUTOR = ethers.getAddress(`0x${"42".repeat(20)}`);
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const FOREIGN_SOURCE: CanonicalSource = Object.freeze({
  number: SOURCE.number,
  hash: `0x${"52".repeat(32)}`,
  generation: SOURCE.generation,
});
const NEXT_SOURCE: CanonicalSource = Object.freeze({
  number: SOURCE.number + 1,
  hash: `0x${"53".repeat(32)}`,
  generation: SOURCE.generation + 1,
});
const COLLATERAL_AMOUNT = 2_000n * 10n ** 18n;
const DEBT_BPS = 8_500n;
const IDENTITY_COLLATERAL = 1_000n * 10n ** 18n;
const IDENTITY_DEBT = 1_000_000n;
type StrictFluidCreditRoute = ReturnType<
  typeof fluidCreditStrictFamilyPlugin.routes.project
>[number];

interface CallbackCounters {
  routeProject: number;
  graphProject: number;
  riskRequirements: number;
  riskBuild: number;
  riskDecode: number;
  riskQuote: number;
  executionBuild: number;
  expectedEffects: number;
}

const counters: CallbackCounters = {
  routeProject: 0,
  graphProject: 0,
  riskRequirements: 0,
  riskBuild: 0,
  riskDecode: 0,
  riskQuote: 0,
  executionBuild: 0,
  expectedEffects: 0,
};
const plugin = observedFluidCreditPlugin(counters);
const primary = loadedFamily(plugin);
const family = primary.family;
const lifecycleA = await executeCreditFamilyInstanceLifecycle({
  family,
  match: creditLifecycleMatch(VAULT_A),
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: creditLifecycleHarness({
    vault: VAULT_A,
    supplyToken: SUPPLY_A,
    borrowToken: BORROW_A,
  }),
});
const lifecycleB = await executeCreditFamilyInstanceLifecycle({
  family,
  match: creditLifecycleMatch(VAULT_B),
  source: SOURCE,
  generation: SOURCE.generation,
  runtime: creditLifecycleHarness({
    vault: VAULT_B,
    supplyToken: SUPPLY_B,
    borrowToken: BORROW_B,
  }),
});
assert(lifecycleA.instance !== null);
assert(lifecycleB.instance !== null);
const instanceA = lifecycleA.instance;
const instanceB = lifecycleB.instance;
const descriptorA = instanceA.descriptor as FluidCreditDescriptor;
const descriptorB = instanceB.descriptor as FluidCreditDescriptor;
const publicationA = prepareCreditFamilyRoutes({
  family,
  instance: instanceA,
  source: SOURCE,
  generation: SOURCE.generation,
});
const publicationB = prepareCreditFamilyRoutes({
  family,
  instance: instanceB,
  source: SOURCE,
  generation: SOURCE.generation,
});
const routeA = only(publicationA.routes);
const routeB = only(publicationB.routes);
const runtimeEvidenceA = runtimeEvidence(descriptorA, SOURCE, "a");
const runtimeEvidenceB = runtimeEvidence(descriptorB, SOURCE, "b");

instanceCapabilityRejectsRawForgedAndStaleInputs();
await happyPathPublishesOneCommonCreditGraphAndExecutes();
await undeclaredDebtFailsBeforeSchedulerOrFamily();
await routeAndRiskAuthorityRejectStructuralFakes();
await familyBoxAuthorityRejectsForeignAndHotReloadBoxes();
await sourceGenerationExecutorAndEvidenceStayBound();
await routeRiskPairingAndGenerationFenceFailClosed();
await creditExecutionHandleIsOpaqueAndExecutesSealedInput();
await creditExecutionHandleRejectsForgedForeignAndTamperedHandles();
await creditExecutionHandleIssueRejectsWrongBinding();
projectedGraphAuthorityRejectsClones();
await creditStrictCatalogCasJoinsSamePublication();

console.log(
  "adapter Credit runtime PASS " +
    "(issuer handles, central risk work, common Graph, execution fail-closed)",
);

function instanceCapabilityRejectsRawForgedAndStaleInputs(): void {
  const attempts: Array<{
    readonly instance: PreparedFamilyInstance;
    readonly source: CanonicalSource;
    readonly generation: number;
    readonly pattern: RegExp;
  }> = [
    {
      instance: descriptorA as unknown as PreparedFamilyInstance,
      source: SOURCE,
      generation: SOURCE.generation,
      pattern: /Prepared Family instance must be lifecycle-issued/,
    },
    {
      instance: Object.freeze({ ...instanceA }) as PreparedFamilyInstance,
      source: SOURCE,
      generation: SOURCE.generation,
      pattern: /Prepared Family instance must be lifecycle-issued/,
    },
    {
      instance: Object.freeze({
        familyId: instanceA.familyId,
        lineageId: instanceA.lineageId,
        candidateKey: instanceA.candidateKey,
        instanceKey: instanceA.instanceKey,
        descriptor: instanceA.descriptor,
        routes: instanceA.routes,
        routeHandles: instanceA.routeHandles,
        pricingInstances: instanceA.pricingInstances,
        staticBindingFingerprint: instanceA.staticBindingFingerprint,
        staticEvidenceFingerprint: instanceA.staticEvidenceFingerprint,
        evidenceRefs: instanceA.evidenceRefs,
      }) as PreparedFamilyInstance,
      source: SOURCE,
      generation: SOURCE.generation,
      pattern: /Prepared Family instance must be lifecycle-issued/,
    },
    {
      instance: instanceA,
      source: FOREIGN_SOURCE,
      generation: FOREIGN_SOURCE.generation,
      pattern: /Prepared Family instance source\/generation mismatch/,
    },
    {
      instance: instanceA,
      source: NEXT_SOURCE,
      generation: NEXT_SOURCE.generation,
      pattern: /Prepared Family instance source\/generation mismatch/,
    },
  ];
  for (const attempt of attempts) {
    const before = snapshotCallbacks();
    assert.throws(
      () => prepareCreditFamilyRoutes({
        family,
        instance: attempt.instance,
        source: attempt.source,
        generation: attempt.generation,
      }),
      attempt.pattern,
    );
    assert.deepEqual(
      snapshotCallbacks(),
      before,
      "instance authority rejection must precede every Family callback",
    );
  }
}

async function happyPathPublishesOneCommonCreditGraphAndExecutes(): Promise<void> {
  const projected = projectCreditRouteGraph({
    family,
    route: routeA,
    centralScores: new Map([[routeA.routeKey, 7]]),
  });
  const graph = buildFamilyRouteGraphView({
    routes: [],
    creditRoutes: [projected],
  });
  assert.equal(graph.routes.length, 1);
  assert.equal(graph.edges.length, 1);
  assert.strictEqual(graph.routes[0], projected);
  assert.equal(projected.edge.slotKind, "lend");
  assert.equal(projected.edge.edgeKind, "credit");
  assert.equal(projected.edge.leavesStandingPosition, true);
  assert.equal(projected.edge.score, 7);
  assert.strictEqual(
    graph.handleByCanonicalEdgeId.get(projected.edge.canonicalEdgeId),
    routeA,
    "the canonical common-Graph index must return the exact Credit handle",
  );

  const harness = runtimeHarness({
    descriptor: descriptorA,
    currentSource: SOURCE,
    executor: EXECUTOR,
  });
  const risk = await executeCreditRiskQuote({
    family,
    route: routeA,
    collateralAmount: COLLATERAL_AMOUNT,
    debtBps: DEBT_BPS,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
  });
  if (risk.status !== "resolved") throw new Error(risk.reasonCode);
  assert.equal(risk.status, "resolved");
  assert.equal(harness.issues.length, 1);
  assert.equal(harness.issues[0]?.schedule.lane, "critical-proof");
  assert.equal(harness.issues[0]?.schedule.transportPool, "effect-sim");
  assert.equal(risk.blocksPrefixInversion, true);
  assert.equal(risk.amountOut, debtAmount(descriptorA));
  assert(Object.isFrozen(risk));

  const executionHandle = issueCreditExecutionHandle({
    family,
    route: routeA,
    risk,
    minAmountOut: risk.amountOut,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: SOURCE,
    generation: SOURCE.generation,
  });
  const execution = buildCreditExecutionFragment({
    family,
    actionOwnership: primary.catalog,
    handle: executionHandle,
  });
  if (execution.status !== "resolved") throw new Error(execution.reasonCode);
  assert.equal(execution.status, "resolved");
  assert.equal(execution.fragment.nodes[0]?.adapterId, "fluid-vault");
  assert.equal(execution.fragment.nodes[0]?.amount, COLLATERAL_AMOUNT);
  assert.equal(execution.fragment.nodes[0]?.params.debtDelta, risk.amountOut);
  assert(Object.isFrozen(execution.fragment));
  assert(Object.isFrozen(execution.fragment.nodes[0]!));
  assert.equal(execution.expectedEffects.length, 4);
}

async function undeclaredDebtFailsBeforeSchedulerOrFamily(): Promise<void> {
  const harness = runtimeHarness({
    descriptor: descriptorA,
    currentSource: SOURCE,
    executor: EXECUTOR,
  });
  const before = snapshotCallbacks();
  const outcome = await executeCreditRiskQuote({
    family,
    route: routeA,
    collateralAmount: COLLATERAL_AMOUNT,
    debtBps: 8_501n,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.reasonCode, /debtBps was not declared/);
  assert.equal(harness.issues.length, 0);
  assert.deepEqual(snapshotCallbacks(), before);
}

async function routeAndRiskAuthorityRejectStructuralFakes(): Promise<void> {
  const routeFakes = [
    { ...routeA },
    Object.freeze({ ...routeA }),
    Object.freeze({
      familyId: routeA.familyId,
      lineageId: routeA.lineageId,
      candidateKey: routeA.candidateKey,
      instanceKey: routeA.instanceKey,
      routeKey: routeA.routeKey,
      source: routeA.source,
      generation: routeA.generation,
    }),
  ] as unknown as readonly CreditRouteRuntimeHandle[];
  for (const fake of routeFakes) {
    const before = snapshotCallbacks();
    assert.throws(
      () => projectCreditRouteGraph({ family, route: fake }),
      /must be issued by the central runtime/,
    );
    assert.deepEqual(snapshotCallbacks(), before);
  }

  const harness = runtimeHarness({
    descriptor: descriptorA,
    currentSource: SOURCE,
    executor: EXECUTOR,
  });
  const risk = await resolvedRisk({
    route: routeA,
    descriptor: descriptorA,
    evidence: runtimeEvidenceA,
    harness,
  });
  const riskFakes = [
    { ...risk },
    Object.freeze({ ...risk }),
    Object.freeze({
      status: risk.status,
      familyId: risk.familyId,
      candidateKey: risk.candidateKey,
      instanceKey: risk.instanceKey,
      routeKey: risk.routeKey,
      source: risk.source,
      generation: risk.generation,
      collateralAmount: risk.collateralAmount,
      debtBps: risk.debtBps,
      amountOut: risk.amountOut,
      positionKey: risk.positionKey,
      blocksPrefixInversion: risk.blocksPrefixInversion,
      evidenceRefs: risk.evidenceRefs,
    }),
  ] as unknown as readonly SealedCreditRiskQuoteHandle[];
  for (const fake of riskFakes) {
    const before = snapshotCallbacks();
    assert.throws(() => issueCreditExecutionHandle({
      family,
      route: routeA,
      risk: fake,
      minAmountOut: risk.amountOut,
      executor: EXECUTOR,
      runtimeEvidence: runtimeEvidenceA,
      source: SOURCE,
      generation: SOURCE.generation,
    }), /must be issued by the central runtime/);
    assert.deepEqual(snapshotCallbacks(), before);
  }
}

async function familyBoxAuthorityRejectsForeignAndHotReloadBoxes(): Promise<void> {
  const hotReload = loadedFamily(plugin);
  assert.notStrictEqual(hotReload.family, family);
  assert.equal(
    hotReload.family.hashes.credit.contentHash,
    family.hashes.credit.contentHash,
  );
  const beforeHotReload = snapshotCallbacks();
  assert.throws(
    () => prepareCreditFamilyRoutes({
      family: hotReload.family,
      instance: instanceA,
      source: SOURCE,
      generation: SOURCE.generation,
    }),
    /Prepared Family instance escaped its catalog FamilyBox/,
  );
  assert.throws(
    () => projectCreditRouteGraph({ family: hotReload.family, route: routeA }),
    /escaped its catalog FamilyBox/,
  );
  assert.deepEqual(snapshotCallbacks(), beforeHotReload);

  const foreignPlugin = observedFluidCreditPlugin(
    freshCounters(),
    familyId("credit:foreign-fluid"),
  );
  const foreign = loadedFamily(foreignPlugin);
  const beforeForeign = snapshotCallbacks();
  assert.throws(
    () => projectCreditRouteGraph({ family: foreign.family, route: routeA }),
    /escaped its catalog FamilyBox/,
  );
  assert.deepEqual(snapshotCallbacks(), beforeForeign);
}

async function sourceGenerationExecutorAndEvidenceStayBound(): Promise<void> {
  const harness = runtimeHarness({
    descriptor: descriptorA,
    currentSource: SOURCE,
    executor: EXECUTOR,
  });
  for (const invocation of [
    { source: FOREIGN_SOURCE, generation: FOREIGN_SOURCE.generation },
    { source: NEXT_SOURCE, generation: NEXT_SOURCE.generation },
  ]) {
    const before = snapshotCallbacks();
    const outcome = await executeCreditRiskQuote({
      family,
      route: routeA,
      collateralAmount: COLLATERAL_AMOUNT,
      debtBps: DEBT_BPS,
      executor: EXECUTOR,
      runtimeEvidence: runtimeEvidenceA,
      source: invocation.source,
      generation: invocation.generation,
      runtime: harness.runtime,
    });
    assert.equal(outcome.status, "failed");
    assert.deepEqual(snapshotCallbacks(), before);
  }
  const foreignEvidence = runtimeEvidence(descriptorA, FOREIGN_SOURCE, "x");
  const beforeEvidence = snapshotCallbacks();
  const foreignEvidenceOutcome = await executeCreditRiskQuote({
    family,
    route: routeA,
    collateralAmount: COLLATERAL_AMOUNT,
    debtBps: DEBT_BPS,
    executor: EXECUTOR,
    runtimeEvidence: foreignEvidence,
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: harness.runtime,
  });
  assert.equal(foreignEvidenceOutcome.status, "failed");
  assert.deepEqual(snapshotCallbacks(), beforeEvidence);

  const risk = await resolvedRisk({
    route: routeA,
    descriptor: descriptorA,
    evidence: runtimeEvidenceA,
    harness,
  });
  for (const invocation of [
    { executor: OTHER_EXECUTOR, evidence: runtimeEvidenceA },
    {
      executor: EXECUTOR,
      evidence: runtimeEvidence(descriptorA, SOURCE, "changed"),
    },
  ]) {
    const before = snapshotCallbacks();
    assert.throws(() => issueCreditExecutionHandle({
      family,
      route: routeA,
      risk,
      minAmountOut: risk.amountOut,
      executor: invocation.executor,
      runtimeEvidence: invocation.evidence,
      source: SOURCE,
      generation: SOURCE.generation,
    }), /executor differs from risk quote|runtime evidence differs from risk quote/);
    assert.deepEqual(snapshotCallbacks(), before);
  }
}

async function routeRiskPairingAndGenerationFenceFailClosed(): Promise<void> {
  const harnessB = runtimeHarness({
    descriptor: descriptorB,
    currentSource: SOURCE,
    executor: EXECUTOR,
  });
  const riskB = await resolvedRisk({
    route: routeB,
    descriptor: descriptorB,
    evidence: runtimeEvidenceB,
    harness: harnessB,
  });
  const beforePairing = snapshotCallbacks();
  assert.throws(() => issueCreditExecutionHandle({
    family,
    route: routeA,
    risk: riskB,
    minAmountOut: riskB.amountOut,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceB,
    source: SOURCE,
    generation: SOURCE.generation,
  }), /exact route handle/);
  assert.deepEqual(snapshotCallbacks(), beforePairing);

  const staleHarness = runtimeHarness({
    descriptor: descriptorA,
    currentSource: NEXT_SOURCE,
    executor: EXECUTOR,
  });
  const beforeStale = snapshotCallbacks();
  const stale = await executeCreditRiskQuote({
    family,
    route: routeA,
    collateralAmount: COLLATERAL_AMOUNT,
    debtBps: DEBT_BPS,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: staleHarness.runtime,
  });
  assert.equal(stale.status, "unresolved");
  assert.equal(staleHarness.issues.length, 0);
  assert.deepEqual(snapshotCallbacks(), beforeStale);
}

async function creditExecutionHandleIsOpaqueAndExecutesSealedInput(): Promise<void> {
  const harness = runtimeHarness({
    descriptor: descriptorA,
    currentSource: SOURCE,
    executor: EXECUTOR,
  });
  const risk = await resolvedRisk({
    route: routeA,
    descriptor: descriptorA,
    evidence: runtimeEvidenceA,
    harness,
  });
  const handle = issueCreditExecutionHandle({
    family,
    route: routeA,
    risk,
    minAmountOut: risk.amountOut,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: SOURCE,
    generation: SOURCE.generation,
  });
  assert(Object.isFrozen(handle));
  assert.equal(handle.minAmountOut, risk.amountOut);
  assert.equal(handle.generation, SOURCE.generation);
  assert.equal("evidence" in handle, false);
  assert.equal("runtimeEvidence" in handle, false);
  assert.equal("descriptor" in handle, false);
  assert.equal("risk" in handle, false);

  const execution = buildCreditExecutionFragment({
    family,
    actionOwnership: primary.catalog,
    handle,
  });
  if (execution.status !== "resolved") throw new Error(execution.reasonCode);
  assert.equal(execution.status, "resolved");
  assert.equal(execution.fragment.nodes[0]?.adapterId, "fluid-vault");
  assert.equal(execution.fragment.nodes[0]?.amount, COLLATERAL_AMOUNT);
  assert.equal(execution.fragment.nodes[0]?.params.debtDelta, risk.amountOut);
  assert(Object.isFrozen(execution.fragment));
  assert(Object.isFrozen(execution.fragment.nodes[0]!));
  assert.equal(execution.expectedEffects.length, 4);
}

async function creditExecutionHandleRejectsForgedForeignAndTamperedHandles(): Promise<void> {
  const harness = runtimeHarness({
    descriptor: descriptorA,
    currentSource: SOURCE,
    executor: EXECUTOR,
  });
  const risk = await resolvedRisk({
    route: routeA,
    descriptor: descriptorA,
    evidence: runtimeEvidenceA,
    harness,
  });
  const handle = issueCreditExecutionHandle({
    family,
    route: routeA,
    risk,
    minAmountOut: risk.amountOut,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: SOURCE,
    generation: SOURCE.generation,
  });

  const forged = Object.freeze({}) as SealedCreditExecutionHandle;
  const beforeForged = snapshotCallbacks();
  const forgedOutcome = buildCreditExecutionFragment({
    family,
    actionOwnership: primary.catalog,
    handle: forged,
  });
  assert.equal(forgedOutcome.status, "failed");
  assert.match(forgedOutcome.reasonCode, /must be issued by the central runtime/);
  assert.deepEqual(snapshotCallbacks(), beforeForged);

  const hotReload = loadedFamily(plugin);
  const beforeForeign = snapshotCallbacks();
  const foreignOutcome = buildCreditExecutionFragment({
    family: hotReload.family,
    actionOwnership: primary.catalog,
    handle,
  });
  assert.equal(foreignOutcome.status, "failed");
  assert.match(foreignOutcome.reasonCode, /escaped its catalog FamilyBox/);
  assert.deepEqual(snapshotCallbacks(), beforeForeign);

  const sameFieldClone = Object.freeze({
    ...handle,
  }) as SealedCreditExecutionHandle;
  const beforeClone = snapshotCallbacks();
  const cloneOutcome = buildCreditExecutionFragment({
    family,
    actionOwnership: primary.catalog,
    handle: sameFieldClone,
  });
  assert.equal(cloneOutcome.status, "failed");
  assert.match(cloneOutcome.reasonCode, /must be issued by the central runtime/);
  assert.deepEqual(snapshotCallbacks(), beforeClone);
}

async function creditExecutionHandleIssueRejectsWrongBinding(): Promise<void> {
  const harness = runtimeHarness({
    descriptor: descriptorA,
    currentSource: SOURCE,
    executor: EXECUTOR,
  });
  const risk = await resolvedRisk({
    route: routeA,
    descriptor: descriptorA,
    evidence: runtimeEvidenceA,
    harness,
  });
  assert.throws(() => issueCreditExecutionHandle({
    family,
    route: routeA,
    risk,
    minAmountOut: risk.amountOut,
    executor: OTHER_EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: SOURCE,
    generation: SOURCE.generation,
  }), /executor differs from risk quote/);
  assert.throws(() => issueCreditExecutionHandle({
    family,
    route: routeA,
    risk,
    minAmountOut: risk.amountOut,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidence(descriptorA, SOURCE, "changed"),
    source: SOURCE,
    generation: SOURCE.generation,
  }), /runtime evidence differs from risk quote/);
  assert.throws(() => issueCreditExecutionHandle({
    family,
    route: routeA,
    risk,
    minAmountOut: risk.amountOut + 1n,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: SOURCE,
    generation: SOURCE.generation,
  }), /outside the sealed risk quote/);
  assert.throws(() => issueCreditExecutionHandle({
    family,
    route: routeA,
    risk,
    minAmountOut: risk.amountOut,
    executor: EXECUTOR,
    runtimeEvidence: runtimeEvidenceA,
    source: NEXT_SOURCE,
    generation: NEXT_SOURCE.generation,
  }), /source\/generation mismatch/);
}

function projectedGraphAuthorityRejectsClones(): void {
  const projected = projectCreditRouteGraph({ family, route: routeA });
  for (const fake of [
    { ...projected },
    Object.freeze({ ...projected }),
  ] as unknown as readonly ProjectedCreditRouteGraph[]) {
    assert.throws(
      () => buildFamilyRouteGraphView({ routes: [], creditRoutes: [fake] }),
      /must be issued by the Credit runtime/,
    );
  }
}

async function creditStrictCatalogCasJoinsSamePublication(): Promise<void> {
  const terminalIssuer = createCatalogTerminalRemovalIssuer();
  const transitionIssuer = createCatalogSourceTransitionIssuer();
  const root = new StrictAdapterFamilyShadowCatalogPublicationRoot({
    catalog: primary.catalog,
    chainId: "1",
    terminalRemovalAuthority: terminalIssuer.authority,
    sourceTransitionAuthority: transitionIssuer.authority,
  });
  const creditStage = root.stageCreditFamily({
    family,
    publication: publicationA,
    instance: instanceA,
  });
  assert.equal(creditStage.instances.length, 1);
  const anchorsFor = (canonical: CanonicalSource) =>
    primary.catalog.listAll().flatMap((catalogFamily) => {
    const sourceIds = "discovery" in catalogFamily.plugin
      ? catalogFamily.plugin.discovery.sources
      : [];
    return sourceIds.map((sourceId) => Object.freeze({
      familyId: catalogFamily.plugin.manifest.familyId,
      sourceId,
      sourceFingerprint: catalogDiscoverySourceFingerprint({
        familyId: catalogFamily.plugin.manifest.familyId,
        sourceId,
        source: canonical,
      }),
      authority: "append-only-nomination" as const,
      status: "complete" as const,
      completeThroughBlock: canonical.number,
      completeThroughHash: canonical.hash,
    }));
  });
  const sourceAnchors = anchorsFor(SOURCE);
  const prepared = root.prepare({
    source: SOURCE,
    previous: null,
    stages: [creditStage],
    sourceAnchors,
  });
  assert.equal(await root.compareAndPublish({
    expected: null,
    staged: prepared,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), true);
  const committed = root.capture()!;
  assert.equal(committed.views.edges.length, 1);
  assert.equal(committed.views.handleByCanonicalEdgeId.size, 1);
  assert.equal(committed.views.fundingByPublicationKey.size, 0);
  assert.equal(committed.envelope.snapshot.revision, 1);
  assert.equal(
    committed.envelope.snapshot.familyStatuses.get(
      family.plugin.manifest.familyId,
    )?.status,
    "resolved",
  );
  const committedEdge = committed.views.edges[0]!;
  assert.equal(
    readStrictCreditRoute({
      views: committed.views,
      canonicalEdgeId: committedEdge.canonicalEdgeId,
    }),
    routeA,
  );
  assert.equal(
    readStrictCreditRoute({
      views: committed.views,
      canonicalEdgeId: "0x" + "9".repeat(64) as CanonicalEdgeId,
    }),
    null,
  );
  const consumer = createStrictCatalogConsumer(committed.views);
  assert(Object.isFrozen(consumer));
  assert.equal(
    consumer.resolveCreditRoute({
      canonicalEdgeId: committedEdge.canonicalEdgeId,
    }),
    routeA,
  );
  assert.deepEqual(consumer.resolveFundingOffers({
    fundingPublicationKey: "missing-funding-key",
  }), { kind: "missing" });

  const nextSource: CanonicalSource = Object.freeze({
    ...SOURCE,
    number: SOURCE.number + 1,
    generation: SOURCE.generation + 1,
  });
  const omitStages = primary.catalog.listAll().map((catalogFamily) =>
    root.stageUnsupported({
      familyId: catalogFamily.plugin.manifest.familyId,
      source: nextSource,
      outcomeRefs: ["shadow:not-wired"],
    })
  );
  const transitionProof = transitionIssuer.issue({
    previous: SOURCE,
    current: nextSource,
    status: "canonical-descendant",
    evidenceRef: `ancestry:${SOURCE.number}:${nextSource.number}`,
  });
  assert.throws(() => root.prepare({
    source: nextSource,
    previous: committed,
    stages: omitStages,
    sourceAnchors: anchorsFor(nextSource),
    sourceTransitionProof: transitionProof,
  }), /issuer-bound StateInstance mutation proof/);

  // A Credit route bound to a different staged instance must be rejected
  // before any graph projection.
  assert.throws(() => root.stageCreditFamily({
    family,
    publication: Object.freeze({
      ...publicationB,
      routes: Object.freeze([routeB]),
    }),
    instance: instanceA,
  }), /escaped its staged instance/);
  assert.throws(() => root.stageCreditFamily({
    family,
    publication: Object.freeze({
      ...publicationB,
      source: Object.freeze({
        ...SOURCE,
        number: SOURCE.number + 2,
        generation: SOURCE.generation + 2,
      }),
      generation: SOURCE.generation + 2,
    }),
    instance: instanceB,
  }), /source\/generation mismatch/);
}

function observedFluidCreditPlugin(
  callbacks: CallbackCounters,
  familyIdOverride = fluidCreditStrictFamilyPlugin.manifest.familyId,
) {
  const base = fluidCreditStrictFamilyPlugin;
  const discovery = mutableClone(base.discovery);
  const identity = mutableClone(base.identity);
  const instance = mutableClone(base.instance);
  const routes = mutableClone(base.routes);
  const execution = mutableClone(base.execution);
  const position = mutableClone(base.credit.position);
  const risk = mutableClone(base.credit.risk);
  const evidence = risk.evidence;
  if (evidence === undefined) throw new Error("Fluid Credit evidence program missing");
  return defineCreditFamily<
    FluidCreditCandidate,
    FluidCreditIdentity,
    FluidCreditDescriptor,
    StrictFluidCreditRoute,
    FluidCreditRiskEvidence
  >({
    manifest: {
      ...mutableClone(base.manifest),
      familyId: familyIdOverride,
    },
    discovery,
    identity,
    instance,
    routes: {
      project(input) {
        callbacks.routeProject++;
        return routes.project(input);
      },
      projectGraph(input) {
        callbacks.graphProject++;
        return routes.projectGraph(input);
      },
    },
    execution: {
      buildFragment(input) {
        callbacks.executionBuild++;
        return execution.buildFragment(input);
      },
      expectedEffects(input) {
        callbacks.expectedEffects++;
        return execution.expectedEffects(input);
      },
    },
    credit: {
      activeBehaviorProof: base.credit.activeBehaviorProof,
      position,
      risk: {
        debtBpsCandidates: risk.debtBpsCandidates,
        blocksPrefixInversion: risk.blocksPrefixInversion,
        evidence: {
          requirements(input) {
            callbacks.riskRequirements++;
            return evidence.requirements(input);
          },
          buildRequests(input) {
            callbacks.riskBuild++;
            return evidence.buildRequests(input);
          },
          decode(input) {
            callbacks.riskDecode++;
            return evidence.decode(input);
          },
        },
        quoteOutputByDebtBps(input) {
          callbacks.riskQuote++;
          return risk.quoteOutputByDebtBps(input);
        },
      },
    },
    actionAdapters: base.actionAdapters,
  });
}

function loadedFamily(pluginInput: AnyDefinedStrictFamilyPlugin): {
  readonly catalog: FamilyCapabilityCatalog;
  readonly family: LoadedFamilyBox;
} {
  const entries: GeneratedCapabilityIdentity[] = FAMILY_CAPABILITY_NAMES.map(
    (capability) => ({
      familyId: pluginInput.manifest.familyId,
      capability,
      contractVersion: "adapter-credit-runtime-test-v1",
      contentHash: createHash("sha256")
        .update(`${pluginInput.manifest.familyId}/${capability}`)
        .digest("hex"),
      semanticDependencies: [`contract:${capability}`],
      provenanceCommit: "a".repeat(40),
    }),
  );
  const catalog = new FamilyCapabilityCatalog({
    modules: [{
      sourceFile: `fixture/${pluginInput.manifest.familyId}.production.ts`,
      definitionBoundaryHash:
        definedFamilyPluginContractSummary(pluginInput).definitionBoundaryHash,
      plugin: pluginInput,
    }],
    generatedManifest: {
      format: "adapter-family-capabilities-v1",
      entries,
      manifestHash: capabilityManifestHash(entries),
    },
  });
  return Object.freeze({
    catalog,
    family: catalog.forStrictFamily(pluginInput.manifest.familyId),
  });
}

function creditLifecycleMatch(vault: string): FamilyLifecycleMatch {
  return Object.freeze({
    matchedPatternId: FLUID_CREDIT_OPERATE_CALL_PATTERN_ID,
    observation: Object.freeze({
      kind: "call" as const,
      source: SOURCE,
      target: vault,
      sender: EXECUTOR,
      data: FLUID_VAULT_INTERFACE.encodeFunctionData("operate", [
        0n,
        IDENTITY_COLLATERAL,
        IDENTITY_DEBT,
        EXECUTOR,
      ]),
    }),
  });
}

function creditLifecycleHarness(input: {
  readonly vault: string;
  readonly supplyToken: string;
  readonly borrowToken: string;
}): CentralAdapterRuntime {
  let now = 100;
  return {
    clock: { nowMs: () => now++ },
    generationFence: {
      assertCurrent(generation, source) {
        assert.equal(generation, SOURCE.generation);
        assert.deepEqual(source, SOURCE);
      },
    },
    callerAuthority: {
      bind(binding) {
        assert.equal(binding.stage, "identity");
        return Object.freeze({
          verifiedActors: Object.freeze({
            [FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID]: FLUID_CREDIT_PROBE_ACTOR,
          }),
        });
      },
    },
    policy: {
      bind(policyInput) {
        assert.equal(policyInput.stage, "identity");
        return Object.freeze({
          lane: "background" as const,
          deadlineAtMs: 10_000,
          maxAttempts: 1,
          transportPool: policyInput.requirements.transports.includes(
              "effect-delta-simulation"
            )
            ? "effect-sim" as const
            : "state-read" as const,
          fairnessKey: policyInput.subjectKey,
        });
      },
    },
    budgets: { assertAdmitted() {} },
    scheduler: {
      issueExecutor(issue) {
        return Object.freeze({
          executor: createBoundedRequestExecutor({
            assertSupported(requirements) {
              assert.deepEqual(requirements, issue.requirements);
            },
            assertCallerBinding(binding) {
              assert.equal(binding.familyId, family.plugin.manifest.familyId);
              assert.deepEqual(binding.source, SOURCE);
            },
            assertWithinBudget(familyIdValue, requests) {
              assert.equal(familyIdValue, family.plugin.manifest.familyId);
              assert.deepEqual(requests, issue.requests);
            },
            execute: async ({ requests, source }) => Object.freeze(
              requests.map((request) =>
                creditIdentityResult(request, source, input)
              ),
            ),
            sealStaticEvidenceReuseProof: () => ({
              proofHash: "cd".repeat(32),
            }),
          }),
          timing: () => Object.freeze({
            queueWaitMs: 1,
            transportWallMs: 2,
            attempts: 1,
          }),
        });
      },
    },
  };
}

function creditIdentityResult(
  request: AdapterRequest,
  source: CanonicalSource,
  input: {
    readonly vault: string;
    readonly supplyToken: string;
    readonly borrowToken: string;
  },
): AdapterRequestResult {
  let data: string;
  let effects: ObservedEffects | undefined;
  switch (request.id) {
    case "vault-constants":
      data = FLUID_VAULT_INTERFACE.encodeFunctionResult("constantsView", [[
        LIQUIDITY,
        FACTORY,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        input.supplyToken,
        input.borrowToken,
        18,
        6,
        input.vault === VAULT_A ? 1n : 2n,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash,
      ]]);
      break;
    case "vault-code":
      data = "0x6000";
      break;
    case "factory-reverse-vault":
      data = FLUID_VAULT_FACTORY_INTERFACE.encodeFunctionResult(
        "getVaultAddress",
        [input.vault],
      );
      break;
    case "supply-token-code":
      data = "0x6001";
      break;
    case "borrow-token-code":
      data = "0x6002";
      break;
    case "active-operate-effect-proof":
      data = FLUID_VAULT_INTERFACE.encodeFunctionResult("operate", [
        9n,
        IDENTITY_COLLATERAL,
        IDENTITY_DEBT,
      ]);
      effects = Object.freeze({
        tokenDeltas: Object.freeze([
          Object.freeze({
            token: input.supplyToken,
            account: FLUID_CREDIT_PROBE_ACTOR,
            delta: -IDENTITY_COLLATERAL,
          }),
          Object.freeze({
            token: input.borrowToken,
            account: FLUID_CREDIT_PROBE_ACTOR,
            delta: IDENTITY_DEBT,
          }),
        ]),
      });
      break;
    default:
      throw new Error(`unexpected Credit identity request ${request.id}`);
  }
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source,
    provenance: Object.freeze({
      kind: "fixture",
      fingerprint: "credit-lifecycle-identity-v1",
    }),
    completion: "returned" as const,
    data,
    ...(effects === undefined ? {} : { effects }),
  });
}

function runtimeEvidence(
  descriptor: FluidCreditDescriptor,
  source: CanonicalSource,
  suffix: string,
): readonly RuntimeEvidence[] {
  return Object.freeze([Object.freeze({
    evidenceId: `credit-runtime-${suffix}`,
    familyId: descriptor.familyId,
    instanceKey: descriptor.instanceKey,
    kind: "source-state-proof",
    scope: "source-block" as const,
    source,
    evidenceHash: `${suffix}-evidence-hash`,
    sealedPayloadRef: `${suffix}-sealed-payload`,
  })]);
}

function runtimeHarness(input: {
  readonly descriptor: FluidCreditDescriptor;
  readonly currentSource: CanonicalSource;
  readonly executor: string;
}): {
  readonly runtime: CentralAdapterRuntime;
  readonly issues: Array<Parameters<CentralAdapterScheduler["issueExecutor"]>[0]>;
} {
  const issues: Array<Parameters<CentralAdapterScheduler["issueExecutor"]>[0]> = [];
  let now = 1_000;
  const scheduler: CentralAdapterScheduler = {
    issueExecutor(issue) {
      issues.push(issue);
      return Object.freeze({
        executor: createBoundedRequestExecutor({
          assertSupported(requirements) {
            assert.deepEqual(requirements, issue.requirements);
          },
          assertCallerBinding(binding) {
            assert.equal(binding.familyId, input.descriptor.familyId);
            assert.equal(binding.callerRef.kind, "executor");
          },
          assertWithinBudget(familyIdValue, requests) {
            assert.equal(familyIdValue, input.descriptor.familyId);
            assert.deepEqual(requests, issue.requests);
          },
          execute: async ({ requests, source }) => Object.freeze(
            requests.map((request) => riskResult(request, source, input)),
          ),
          sealStaticEvidenceReuseProof: () => ({
            proofHash: "ab".repeat(32),
          }),
        }),
        timing: () => Object.freeze({
          queueWaitMs: 1,
          transportWallMs: 2,
          attempts: 1,
        }),
      });
    },
  };
  const runtime: CentralAdapterRuntime = {
    clock: { nowMs: () => now++ },
    generationFence: {
      assertCurrent(generation, source) {
        if (
          generation !== input.currentSource.generation ||
          source.number !== input.currentSource.number ||
          source.hash.toLowerCase() !== input.currentSource.hash.toLowerCase()
        ) {
          throw new Error("stale Credit generation");
        }
      },
    },
    callerAuthority: {
      bind: () => Object.freeze({ executor: input.executor }),
    },
    policy: {
      bind(policyInput) {
        assert.equal(policyInput.stage, "runtime-evidence");
        return Object.freeze({
          lane: "critical-proof" as const,
          deadlineAtMs: 10_000,
          maxAttempts: 1,
          transportPool: "effect-sim" as const,
          fairnessKey: policyInput.subjectKey,
        });
      },
    },
    budgets: { assertAdmitted() {} },
    scheduler,
  };
  return { runtime, issues };
}

function riskResult(
  request: AdapterRequest,
  source: CanonicalSource,
  input: {
    readonly descriptor: FluidCreditDescriptor;
    readonly executor: string;
  },
): AdapterRequestResult {
  assert.equal(request.kind, "effect-delta-simulation");
  if (request.kind !== "effect-delta-simulation") {
    throw new Error("unexpected Credit risk request");
  }
  const debt = debtAmount(input.descriptor);
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source,
    provenance: Object.freeze({
      kind: "fixture",
      fingerprint: "credit-runtime-risk-v1",
    }),
    completion: "returned" as const,
    data: FLUID_VAULT_INTERFACE.encodeFunctionResult("operate", [
      9n,
      COLLATERAL_AMOUNT,
      debt,
    ]),
    effects: Object.freeze({
      tokenDeltas: Object.freeze([
        Object.freeze({
          token: input.descriptor.supplyToken,
          account: input.executor,
          delta: -COLLATERAL_AMOUNT,
        }),
        Object.freeze({
          token: input.descriptor.borrowToken,
          account: input.executor,
          delta: debt,
        }),
      ]),
    }),
  });
}

async function resolvedRisk(input: {
  readonly route: CreditRouteRuntimeHandle;
  readonly descriptor: FluidCreditDescriptor;
  readonly evidence: readonly RuntimeEvidence[];
  readonly harness: ReturnType<typeof runtimeHarness>;
}): Promise<SealedCreditRiskQuoteHandle> {
  const risk = await executeCreditRiskQuote({
    family,
    route: input.route,
    collateralAmount: COLLATERAL_AMOUNT,
    debtBps: DEBT_BPS,
    executor: EXECUTOR,
    runtimeEvidence: input.evidence,
    source: SOURCE,
    generation: SOURCE.generation,
    runtime: input.harness.runtime,
  });
  if (risk.status !== "resolved") throw new Error(risk.reasonCode);
  assert.equal(risk.status, "resolved");
  assert.equal(risk.amountOut, debtAmount(input.descriptor));
  return risk;
}

function debtAmount(descriptor: FluidCreditDescriptor): bigint {
  return fluidDebtAmount({
    collateralAmount: COLLATERAL_AMOUNT,
    debtBps: DEBT_BPS,
    supplyDecimals: descriptor.supplyDecimals,
    borrowDecimals: descriptor.borrowDecimals,
  });
}

function snapshotCallbacks(): CallbackCounters {
  return { ...counters };
}

function freshCounters(): CallbackCounters {
  return {
    routeProject: 0,
    graphProject: 0,
    riskRequirements: 0,
    riskBuild: 0,
    riskDecode: 0,
    riskQuote: 0,
    executionBuild: 0,
    expectedEffects: 0,
  };
}

function mutableClone<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map((item) => mutableClone(item)) as Value;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = mutableClone(item);
    }
    return output as Value;
  }
  return value;
}

function only<Value>(values: readonly Value[]): Value {
  assert.equal(values.length, 1);
  return values[0]!;
}
