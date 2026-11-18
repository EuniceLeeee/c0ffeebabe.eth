import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { StrictProductionFamilyDeclarations } from "../strict-production-family-declarations.js";
import {
  VictimModelRegistry,
  type VictimModelDescriptor,
} from "../venues/victim-model-registry.js";
import { settleVictimRuntimeStage } from "../venues/victim-runtime-supervisor.js";

const declarations = new StrictProductionFamilyDeclarations(catalog);
const swapFamilies = catalog.listAll().flatMap(({ plugin }) => "swap" in plugin ? [plugin] : []);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function testBindingsAreRouteBacked(): void {
  for (const group of declarations.swapObservationGroups) {
    for (const edgeAdapterId of group.edgeAdapterIds) {
      assert(
        group.familyIds.includes(catalog.ownerOfAction(edgeAdapterId)),
        `${group.familyIds.join(",")}: unknown route edge ${edgeAdapterId}`,
      );
    }
  }
  console.log("[victim-model-registry] route-backed bindings: PASS");
}

function testEverySwapEdgeHasAnExplicitVictimDisposition(): void {
  const expected = new Set(
    swapFamilies.filter((family) => family.swap.receiptObservation !== undefined).flatMap((family) => family.manifest.edgeAdapterIds ?? []),
  );
  const actual = new Set(
    declarations.swapObservationGroups.flatMap((group) => [...group.edgeAdapterIds]),
  );
  assert(
    expected.size === actual.size &&
      [...expected].every((edgeAdapterId) => actual.has(edgeAdapterId)),
    "pool-swap victim model coverage must exactly match declared observation capabilities",
  );
  console.log("[victim-model-registry] exact active-swap disposition: PASS");
}

function testPoolSwapCapabilities(): void {
  // Replay mechanics remain generic capabilities. Selector-native production
  // does not claim old protocol replay models that its JSON never declared.
  const fixtures = new VictimModelRegistry([{
    id: "fixture:cache-backed", kind: "pool-swap-overlay", edgeAdapterIds: ["fixture:cached-edge"], runtime: {
      localApply: { cacheBacked: true, needsMutablePoolRefresh: true, apply: () => null },
      exactPostImpact: () => null,
      buildOverlay: async () => ({ whale: `0x${"01".repeat(20)}`, tokenDeals: [], preCalls: [] }),
    },
  }, {
    id: "fixture:event-state", kind: "pool-swap-overlay", edgeAdapterIds: ["fixture:event-edge"], runtime: {
      localApply: { cacheBacked: false, needsMutablePoolRefresh: false, apply: () => null },
      exactPostImpact: () => null, buildOverlay: null,
    },
  }]);
  const v2 = fixtures.forEdge("fixture:cached-edge");
  assert(
    v2 !== null && v2.runtime !== null && v2.runtime.localApply !== null,
    "univ2 local apply",
  );
  const v2Runtime = v2.runtime;
  const v2LocalApply = v2Runtime.localApply;
  assert(v2LocalApply !== null, "univ2 local apply disappeared");
  assert(v2LocalApply.cacheBacked, "univ2 local apply must be cache-backed");
  assert(
    v2LocalApply.needsMutablePoolRefresh,
    "univ2 local apply must request mutable pool refresh",
  );
  assert(v2Runtime.exactPostImpact !== null, "univ2 exact post-impact");
  assert(v2Runtime.buildOverlay !== null, "univ2 overlay replay");

  const v4 = fixtures.forEdge("fixture:event-edge");
  assert(
    v4 !== null && v4.runtime !== null && v4.runtime.localApply !== null,
    "univ4 event post-state apply",
  );
  const v4Runtime = v4.runtime;
  const v4LocalApply = v4Runtime.localApply;
  assert(v4LocalApply !== null, "univ4 local apply disappeared");
  assert(!v4LocalApply.cacheBacked, "univ4 exact event apply must not use cache");
  assert(v4Runtime.exactPostImpact !== null, "univ4 exact post-impact");
  assert(v4Runtime.buildOverlay === null, "univ4 must not use router replay");
  console.log("[victim-model-registry] pool-swap capabilities: PASS");
}

function testCurveUnderlyingFailsClosed(): void {
  const detectOnly = VictimModelRegistry.fromSwapFamilies([{ id: "fixture:detect-only", edgeAdapterIds: ["fixture:observed-edge"],
    victimModel: { id: "fixture:detect-only", mode: "detect-only" } }]);
  assert(detectOnly.forEdge("fixture:observed-edge")?.runtime === null, "detect-only must never gain replay callbacks");
  console.log("[victim-model-registry] detect-only fail-closed: PASS");
}

function testOracleModelIsOrthogonal(): void {
  const registry = new VictimModelRegistry([{ id: "fixture:oracle", kind: "oracle-rawtx", edgeAdapterIds: [], runtime: null }]);
  const oracle = registry.forId("fixture:oracle");
  assert(oracle?.kind === "oracle-rawtx", "oracle raw-tx model missing");
  assert(oracle.edgeAdapterIds.length === 0, "oracle model must not claim route edges");
  for (const declaration of declarations.oracleVictims) {
    for (const affected of declaration.affectedEdges) {
      const owner = catalog.forStrictFamily(catalog.ownerOfAction(affected.adapterId)).plugin;
      assert("protocol" in owner && owner.protocol.oracleVictim?.runtimeDetection.id === declaration.id,
        `oracle affected edge ${affected.adapterId} is not owned by its declaring family`);
    }
  }
  console.log("[victim-model-registry] oracle model orthogonality: PASS");
}

function testUnknownAdapterFailsClosed(): void {
  assert(new VictimModelRegistry([]).forEdge("unknown-swap") === null, "unknown adapter admitted");
  assert(!declarations.swapObservationGroups.some(group => group.edgeAdapterIds.has("unknown-swap")), "strict declarations admitted an unknown edge");
  console.log("[victim-model-registry] unknown adapter fail-closed: PASS");
}

function testDuplicateBindingRejected(): void {
  const descriptor: VictimModelDescriptor = {
    id: "test:a",
    kind: "pool-swap-overlay",
    edgeAdapterIds: ["test-swap"],
    runtime: {
      localApply: null,
      exactPostImpact: () => null,
      buildOverlay: null,
    },
  };
  let rejected = false;
  try {
    new VictimModelRegistry([
      descriptor,
      { ...descriptor, id: "test:b" },
    ]);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("duplicate edge adapter");
  }
  assert(rejected, "duplicate edge binding should throw");
  console.log("[victim-model-registry] duplicate binding rejected: PASS");
}

function testRegistryCallbacksMatchFamilyDeclarations(): void {
  for (const family of swapFamilies) {
    const id = family.manifest.familyId;
    const groups = declarations.swapObservationGroups.filter(group => group.familyIds.includes(id));
    if (family.swap.receiptObservation === undefined) {
      assert(groups.length === 0, `${id}: execution-only swap invented a receipt decoder`);
      assert(family.swap.victimSupport === "none", `${id}: missing victim receipt semantics`);
      continue;
    }
    assert(groups.length === 1, `${id}: receipt declaration was omitted or duplicated`);
    assert(groups[0]!.observation === family.swap.receiptObservation, `${id}: receipt decoder changed during strict projection`);
    if (family.swap.victimSupport === "detect-only") {
      assert(family.swap.localApply === undefined && family.swap.overlay === undefined && family.swap.replay === undefined,
        `${id}: detect-only leaked replay callbacks`);
    }
  }
  console.log("[victim-model-registry] family callback projection: PASS");
}

function testInvalidCallbackContractsRejected(): void {
  let emptyRejected = false;
  try {
    new VictimModelRegistry([{
      id: "test:empty",
      kind: "pool-swap-overlay",
      edgeAdapterIds: ["test-empty-swap"],
      runtime: {
        localApply: null,
        exactPostImpact: null,
        buildOverlay: null,
      },
    }]);
  } catch (error) {
    emptyRejected =
      error instanceof Error && error.message.includes("has no callback");
  }
  assert(emptyRejected, "empty replay callback contract should throw");

  let refreshRejected = false;
  try {
    new VictimModelRegistry([{
      id: "test:invalid-refresh",
      kind: "pool-swap-overlay",
      edgeAdapterIds: ["test-invalid-refresh-swap"],
      runtime: {
        localApply: {
          cacheBacked: false,
          needsMutablePoolRefresh: true,
          apply: () => null,
        },
        exactPostImpact: null,
        buildOverlay: null,
      },
    }]);
  } catch (error) {
    refreshRejected =
      error instanceof Error && error.message.includes("non-cache local apply");
  }
  assert(refreshRejected, "non-cache mutable refresh contract should throw");
  console.log("[victim-model-registry] invalid callback contracts rejected: PASS");
}

async function testFamilyLocalRuntimeFailureIsolation(): Promise<void> {
  let childAborted = false;
  const bad = settleVictimRuntimeStage({
    familyId: "bad-family",
    stage: "overlay",
    timeoutMs: 5,
    work: (control) =>
      new Promise<string>((resolve) => {
        control.signal.addEventListener("abort", () => {
          childAborted = true;
          setTimeout(() => resolve("late-value-must-not-publish"), 0);
        }, { once: true });
      }),
  });
  const healthy = settleVictimRuntimeStage({
    familyId: "healthy-family",
    stage: "overlay",
    timeoutMs: 100,
    work: () => "healthy-value",
  });
  const [badResult, healthyResult] = await Promise.all([bad, healthy]);
  assert(
    !badResult.ok &&
      badResult.familyId === "bad-family" &&
      badResult.timedOut,
    "timed-out callback must settle as its own family failure",
  );
  assert(childAborted, "timed-out callback must receive a family-local abort");
  assert(
    healthyResult.ok &&
      healthyResult.familyId === "healthy-family" &&
      healthyResult.value === "healthy-value",
    "healthy sibling must settle while another family times out",
  );

  const thrown = await settleVictimRuntimeStage({
    familyId: "throwing-family",
    stage: "local-apply",
    timeoutMs: 100,
    work: () => {
      throw new Error("injected victim callback failure");
    },
  });
  assert(
    !thrown.ok &&
      !thrown.timedOut &&
      thrown.familyId === "throwing-family" &&
      thrown.reason === "injected victim callback failure",
    "thrown callback must settle as an attributed family failure",
  );
  const exactThrown = await settleVictimRuntimeStage({
    familyId: "throwing-exact-family",
    stage: "exact-post-impact",
    timeoutMs: 100,
    work: () => {
      throw new Error("injected exact callback failure");
    },
  });
  assert(
    !exactThrown.ok &&
      exactThrown.stage === "exact-post-impact" &&
      exactThrown.familyId === "throwing-exact-family",
    "exact post-impact callback failure must retain its family/stage",
  );
  console.log("[victim-model-registry] family-local runtime failure isolation: PASS");
}

async function main(): Promise<void> {
  testBindingsAreRouteBacked();
  testEverySwapEdgeHasAnExplicitVictimDisposition();
  testPoolSwapCapabilities();
  testCurveUnderlyingFailsClosed();
  testOracleModelIsOrthogonal();
  testUnknownAdapterFailsClosed();
  testDuplicateBindingRejected();
  testRegistryCallbacksMatchFamilyDeclarations();
  testInvalidCallbackContractsRejected();
  await testFamilyLocalRuntimeFailureIsolation();
  console.log("victim-model-registry PASS (10/10)");
}

await main();
