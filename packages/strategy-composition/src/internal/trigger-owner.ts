import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  encodeCanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import { decodeRuntimeAuthorityProjectionV1 } from "../../../runtime-authority/src/index.ts";
import type {
  StrategyGraphBindingV1,
  StrategyPlanningLaneV1,
  StrategyPlanningTriggerCapabilityV1,
  StrategyPlanningTriggerV1,
} from "../index.ts";

interface IssuedTriggerRecordV1 {
  readonly binding: StrategyGraphBindingV1;
  readonly lane: StrategyPlanningLaneV1;
  readonly triggerRef: Hash;
  readonly objectiveRef: Hash;
  readonly entryAssetRef: Hash;
  readonly returnAssetRef: Hash;
  readonly affectedEdgeIds: readonly Hash[];
  readonly correlationId: Hash;
}

const issuedTriggers = new WeakMap<object, IssuedTriggerRecordV1>();
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const BINDING_KEYS = Object.freeze([
  "generationId",
  "definitionCatalogRoot",
  "graphRoot",
  "readyRecordHash",
  "releaseProvenanceHash",
  "runtimeMembershipHash",
  "runtimeAuthority",
  "sourceHash",
] as const);
function binding(value: StrategyGraphBindingV1): StrategyGraphBindingV1 {
  if (value === null || typeof value !== "object") throw new TypeError("strategy trigger binding is required");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(value.runtimeAuthority);
  const expectedKeys = runtimeAuthority.authorityClass === "signed-release"
    ? BINDING_KEYS.filter(key => key !== "runtimeMembershipHash" || Object.prototype.hasOwnProperty.call(value, key))
    : BINDING_KEYS.filter(key => key !== "releaseProvenanceHash");
  assertExactKeys(value, expectedKeys, "strategyTrigger.binding");
  assertNonEmptyString(value.generationId, "strategyTrigger.binding.generationId");
  assertHash(value.definitionCatalogRoot, "strategyTrigger.binding.definitionCatalogRoot");
  assertHash(value.graphRoot, "strategyTrigger.binding.graphRoot");
  assertHash(value.readyRecordHash, "strategyTrigger.binding.readyRecordHash");
  assertHash(value.sourceHash, "strategyTrigger.binding.sourceHash");
  const releaseProvenanceHash = runtimeAuthority.authorityClass === "signed-release"
    ? assertHash(value.releaseProvenanceHash, "strategyTrigger.binding.releaseProvenanceHash")
    : undefined;
  const runtimeMembershipHash = assertHash(
    value.runtimeMembershipHash ?? releaseProvenanceHash,
    "strategyTrigger.binding.runtimeMembershipHash",
  );
  if (releaseProvenanceHash !== undefined && runtimeMembershipHash !== releaseProvenanceHash) {
    throw new TypeError("signed strategy trigger membership must equal release provenance");
  }
  return Object.freeze({
    generationId: value.generationId,
    definitionCatalogRoot: value.definitionCatalogRoot,
    graphRoot: value.graphRoot,
    readyRecordHash: value.readyRecordHash,
    ...(runtimeAuthority.authorityClass === "unsigned-dry-run" ? { runtimeMembershipHash } : {}),
    ...(releaseProvenanceHash === undefined ? {} : { releaseProvenanceHash }),
    runtimeAuthority,
    sourceHash: value.sourceHash,
  });
}

function hashes(value: readonly Hash[], path: string): readonly Hash[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const result = value.map((item, index) => assertHash(item, `${path}[${index}]`)).sort(compare);
  if (new Set(result).size !== result.length) throw new TypeError(`${path} contains duplicates`);
  return Object.freeze(result);
}

function sameBinding(left: StrategyGraphBindingV1, right: StrategyGraphBindingV1): boolean {
  return left.generationId === right.generationId
    && left.definitionCatalogRoot === right.definitionCatalogRoot
    && left.graphRoot === right.graphRoot
    && left.readyRecordHash === right.readyRecordHash
    && left.sourceHash === right.sourceHash
    && (left.runtimeMembershipHash ?? left.releaseProvenanceHash)
      === (right.runtimeMembershipHash ?? right.releaseProvenanceHash)
    && left.releaseProvenanceHash === right.releaseProvenanceHash
    && encodeCanonicalJson(left.runtimeAuthority) === encodeCanonicalJson(right.runtimeAuthority);
}

/** Owner-only ingress for an objective-, head-, and session-bound planning trigger. */
export function issueStrategyPlanningTriggerCapabilityV1(input: {
  readonly binding: StrategyGraphBindingV1;
  readonly lane: StrategyPlanningLaneV1;
  readonly triggerRef: Hash;
  readonly objectiveRef: Hash;
  readonly entryAssetRef: Hash;
  readonly returnAssetRef: Hash;
  readonly affectedEdgeIds: readonly Hash[];
  readonly correlationId: Hash;
}): StrategyPlanningTriggerCapabilityV1 {
  const graphBinding = binding(input.binding);
  if (input.lane !== "blockscan" && input.lane !== "backrun") throw new TypeError("unsupported Strategy planning lane");
  const triggerRef = assertHash(input.triggerRef, "strategyTrigger.triggerRef");
  const objectiveRef = assertHash(input.objectiveRef, "strategyTrigger.objectiveRef");
  const entryAssetRef = assertHash(input.entryAssetRef, "strategyTrigger.entryAssetRef");
  const returnAssetRef = assertHash(input.returnAssetRef, "strategyTrigger.returnAssetRef");
  if (entryAssetRef !== returnAssetRef) throw new TypeError("closed-loop Strategy trigger must return to its entry asset");
  const affectedEdgeIds = hashes(input.affectedEdgeIds, "strategyTrigger.affectedEdgeIds");
  const correlationId = assertHash(input.correlationId, "strategyTrigger.correlationId");
  if (input.lane === "blockscan" && affectedEdgeIds.length !== 0) throw new TypeError("blockscan Strategy trigger cannot narrow GraphView");
  if (input.lane === "backrun" && affectedEdgeIds.length === 0) throw new TypeError("backrun Strategy trigger requires affected Graph edges");
  const capability = Object.freeze(Object.create(null)) as StrategyPlanningTriggerCapabilityV1;
  issuedTriggers.set(capability, Object.freeze({ binding: graphBinding, lane: input.lane, triggerRef, objectiveRef, entryAssetRef, returnAssetRef, affectedEdgeIds, correlationId }));
  return capability;
}

export function readIssuedStrategyPlanningTriggerV1(
  value: unknown,
  expectedBinding: StrategyGraphBindingV1,
): StrategyPlanningTriggerV1 {
  if (value === null || typeof value !== "object") throw new TypeError("Strategy planning trigger is not owner-issued");
  const record = issuedTriggers.get(value);
  if (record === undefined) throw new TypeError("Strategy planning trigger is not owner-issued");
  const graphBinding = binding(expectedBinding);
  if (!sameBinding(record.binding, graphBinding)) throw new TypeError("Strategy planning trigger binding mismatch");
  const common = {
    lane: record.lane,
    triggerRef: record.triggerRef,
    objectiveRef: record.objectiveRef,
    entryAssetRef: record.entryAssetRef,
    returnAssetRef: record.returnAssetRef,
    affectedEdgeIds: record.affectedEdgeIds,
    correlationId: record.correlationId,
    headHash: graphBinding.sourceHash,
    generationId: graphBinding.generationId,
    graphRoot: graphBinding.graphRoot,
  };
  return deepFreeze({
    ...common,
    ...(graphBinding.runtimeMembershipHash === undefined ? {} : { runtimeMembershipHash: graphBinding.runtimeMembershipHash }),
    ...(graphBinding.releaseProvenanceHash === undefined ? {} : { releaseProvenanceHash: graphBinding.releaseProvenanceHash }),
    runtimeAuthority: graphBinding.runtimeAuthority,
  });
}
