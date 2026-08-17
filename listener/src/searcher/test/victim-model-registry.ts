import { STRICT_PROJECTED_FAMILY_TEST_REGISTRY } from "./strict-family-test-compat.js";
import {
  VictimModelRegistry,
  type VictimModelDescriptor,
} from "../venues/victim-model-registry.js";
import { settleVictimRuntimeStage } from "../venues/victim-runtime-supervisor.js";

const PRODUCTION_VICTIM_MODELS = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.victimModels();

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function testBindingsAreRouteBacked(): void {
  for (const model of PRODUCTION_VICTIM_MODELS.list()) {
    for (const edgeAdapterId of model.edgeAdapterIds) {
      assert(
        STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().findForEdge(edgeAdapterId) !== null,
        `${model.id}: unknown route edge ${edgeAdapterId}`,
      );
    }
  }
  console.log("[victim-model-registry] route-backed bindings: PASS");
}

function testEverySwapEdgeHasAnExplicitVictimDisposition(): void {
  const expected = new Set(
    STRICT_PROJECTED_FAMILY_TEST_REGISTRY.swaps().flatMap((family) => family.edgeAdapterIds),
  );
  const actual = new Set(
    PRODUCTION_VICTIM_MODELS.list()
      .filter((model) => model.kind === "pool-swap-overlay")
      .flatMap((model) => model.edgeAdapterIds),
  );
  assert(
    expected.size === actual.size &&
      [...expected].every((edgeAdapterId) => actual.has(edgeAdapterId)),
    "pool-swap victim model coverage must exactly match active swap edges",
  );
  console.log("[victim-model-registry] exact active-swap disposition: PASS");
}

function testPoolSwapCapabilities(): void {
  const v2 = PRODUCTION_VICTIM_MODELS.forEdge("univ2-swap");
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

  const v4 = PRODUCTION_VICTIM_MODELS.forEdge("univ4-unlock");
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
  const underlying = PRODUCTION_VICTIM_MODELS.forEdge("curve-exchange-underlying");
  assert(underlying?.runtime === null, "curve underlying replay must stay disabled");
  console.log("[victim-model-registry] curve underlying fail-closed: PASS");
}

function testOracleModelIsOrthogonal(): void {
  const oracle = PRODUCTION_VICTIM_MODELS.forId("oracle-rawtx:metronome");
  assert(oracle?.kind === "oracle-rawtx", "oracle raw-tx model missing");
  assert(oracle.edgeAdapterIds.length === 0, "oracle model must not claim route edges");
  const declaration = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.oracleVictims().find(
    (candidate) => candidate.modelId === oracle.id,
  );
  assert(declaration !== undefined, "oracle model must derive from a family declaration");
  for (const affected of declaration.affectedEdges) {
    const owner = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().findForEdge(
      affected.adapterId,
    );
    assert(
      owner?.oracleVictim?.modelId === oracle.id,
      `oracle affected edge ${affected.adapterId} is not owned by its declaring family`,
    );
  }
  console.log("[victim-model-registry] oracle model orthogonality: PASS");
}

function testUnknownAdapterFailsClosed(): void {
  assert(PRODUCTION_VICTIM_MODELS.forEdge("unknown-swap") === null, "unknown adapter admitted");
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
  for (const family of STRICT_PROJECTED_FAMILY_TEST_REGISTRY.swaps()) {
    const model = PRODUCTION_VICTIM_MODELS.forEdge(family.edgeAdapterIds[0]);
    assert(model !== null, `${family.id}: missing victim model`);
    if (family.victimModel.mode === "detect-only") {
      assert(model.runtime === null, `${family.id}: detect-only leaked runtime callbacks`);
      continue;
    }
    assert(model.runtime !== null, `${family.id}: replay runtime missing`);
    assert(
      model.runtime.localApply !== null ||
        model.runtime.exactPostImpact !== null ||
        model.runtime.buildOverlay !== null,
      `${family.id}: replay runtime has no callback`,
    );
    assert(
      model.runtime.localApply?.apply ===
        family.victimModel.runtime.localApply?.apply,
      `${family.id}: local apply callback changed during registry projection`,
    );
    assert(
      model.runtime.exactPostImpact ===
        family.victimModel.runtime.exactPostImpact,
      `${family.id}: exact post-impact callback changed during registry projection`,
    );
    assert(
      model.runtime.buildOverlay === family.victimModel.runtime.buildOverlay,
      `${family.id}: overlay callback changed during registry projection`,
    );
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
