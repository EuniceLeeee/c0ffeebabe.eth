import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";
import {
  PRODUCTION_VICTIM_MODELS,
  VictimModelRegistry,
  type VictimModelDescriptor,
} from "../venues/victim-model-registry.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function testBindingsAreRouteBacked(): void {
  for (const model of PRODUCTION_VICTIM_MODELS.list()) {
    for (const edgeAdapterId of model.edgeAdapterIds) {
      assert(
        PRODUCTION_ROUTE_ADAPTERS.routeLegs.findForEdge(edgeAdapterId) !== null,
        `${model.id}: unknown route edge ${edgeAdapterId}`,
      );
    }
  }
  console.log("[victim-model-registry] route-backed bindings: PASS");
}

function testPoolSwapCapabilities(): void {
  const v2 = PRODUCTION_VICTIM_MODELS.forEdge("univ2-swap");
  assert(v2?.impactVariant === "univ2", "univ2 impact variant");
  assert(v2.localApplyVariant === "univ2", "univ2 local apply");
  assert(v2.overlayReplayVariant === "univ2", "univ2 overlay replay");

  const v4 = PRODUCTION_VICTIM_MODELS.forEdge("univ4-unlock");
  assert(v4?.localApplyVariant === "univ4", "univ4 event post-state apply");
  assert(v4.overlayReplayVariant === null, "univ4 must not use router replay");
  console.log("[victim-model-registry] pool-swap capabilities: PASS");
}

function testCurveUnderlyingFailsClosed(): void {
  const underlying = PRODUCTION_VICTIM_MODELS.forEdge("curve-exchange-underlying");
  assert(underlying?.impactVariant === "curve", "curve underlying impact decode");
  assert(underlying.localApplyVariant === null, "curve underlying local apply must stay disabled");
  assert(underlying.overlayReplayVariant === null, "curve underlying replay must stay disabled");
  console.log("[victim-model-registry] curve underlying fail-closed: PASS");
}

function testOracleModelIsOrthogonal(): void {
  const oracle = PRODUCTION_VICTIM_MODELS.forId("oracle-rawtx:metronome");
  assert(oracle?.kind === "oracle-rawtx", "oracle raw-tx model missing");
  assert(oracle.edgeAdapterIds.length === 0, "oracle model must not claim route edges");
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
    impactVariant: "univ2",
    localApplyVariant: "univ2",
    overlayReplayVariant: "univ2",
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

function main(): void {
  testBindingsAreRouteBacked();
  testPoolSwapCapabilities();
  testCurveUnderlyingFailsClosed();
  testOracleModelIsOrthogonal();
  testUnknownAdapterFailsClosed();
  testDuplicateBindingRejected();
  console.log("victim-model-registry PASS (6/6)");
}

main();
