import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type {
  CapabilityPredicateRefV1,
  ClosedLoopPlanningProblemDraftV1,
  ClosedLoopPlanningTemplateV1,
  GeneratedStrategyCatalogLeafV1,
  StrategyPlanningProblemIssuerV1,
} from "../../strategy-sdk/src/index.ts";
import { strategyPlanningTemplateHash } from "../../strategy-sdk/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";
import { readIssuedStrategyPlanningTriggerV1 } from "./internal/trigger-owner.ts";
import {
  readGeneratedStrategyRuntimeCompositionCapability,
  type GeneratedStrategyRuntimeCompositionCapabilityV1,
} from "./internal/runtime-composition-authority.ts";

export type StrategyPlanningLaneV1 = "blockscan" | "backrun";

/** Structural, read-only Graph projection.  Strategy composition deliberately
 * does not import Graph/Ready implementations or route-handle authority. */
export interface StrategyGraphBindingV1 {
  readonly generationId: string;
  readonly definitionCatalogRoot: Hash;
  readonly graphRoot: Hash;
  /** Exact active Ready lease; planning never runs from an unready Graph. */
  readonly readyRecordHash: Hash;
  /** Active release provenance is mandatory for production strategy issuance. */
  readonly releaseProvenanceHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  /** Current producer-head hash; a trigger cannot be replayed on another head. */
  readonly sourceHash: Hash;
}

export interface StrategyGraphAssetPortV1 {
  readonly assetRef: Hash;
  readonly portRef: Hash;
  readonly ordinal: string;
}

export interface StrategyGraphEdgeV1 {
  readonly edgeId: Hash;
  readonly opaqueTransitionRef: Hash;
  readonly inputAssetPorts: readonly StrategyGraphAssetPortV1[];
  readonly outputAssetPorts: readonly StrategyGraphAssetPortV1[];
}

export interface StrategyPlanningTriggerCapabilityV1 {
  readonly __strategyPlanningTriggerCapability: never;
}

/** Decoded view of an owner-issued trigger. This view is never accepted as ingress. */
export interface StrategyPlanningTriggerV1 {
  readonly lane: StrategyPlanningLaneV1;
  readonly triggerRef: Hash;
  readonly objectiveRef: Hash;
  readonly entryAssetRef: Hash;
  readonly returnAssetRef: Hash;
  readonly affectedEdgeIds: readonly Hash[];
  readonly correlationId: Hash;
  readonly headHash: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
}

export interface StrategyPlanningProblemCoreV1 extends ClosedLoopPlanningProblemDraftV1 {
  readonly strategyId: string;
  readonly strategyDefinitionHash: Hash;
  readonly strategyCatalogLeafDigest: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly triggerRef: Hash;
  readonly lane: StrategyPlanningLaneV1;
  readonly triggerCorrelationId: Hash;
  readonly triggerHeadHash: Hash;
  readonly requiredCapabilityPredicates: readonly CapabilityPredicateRefV1[];
  /** Exact generated composition identity used to issue this problem. */
  readonly strategyCompositionRoot: Hash;
  /** Exact closure of the named issuer(s) used by the generated composition. */
  readonly strategyIssuerClosureRoot: Hash;
  /** Exact Ready record used to issue this problem. */
  readonly readyRecordHash: Hash;
  readonly problemHash: Hash;
}

export interface StrategyPlanningProblemV1 extends StrategyPlanningProblemCoreV1 {
  readonly releaseProvenanceHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
}

export type StrategyPlanningInputV1 = StrategyPlanningProblemV1;

/** The visible evidence body is carried by a process-local owner capability. */
export type IssuedStrategyPlanningProblemV1 = StrategyPlanningProblemV1 & {
  readonly __issuedStrategyPlanningProblemV1?: never;
};

export type IssuedStrategyPlanningInputV1 = IssuedStrategyPlanningProblemV1;

/** Process-local authenticity fence for issued planning problems. A caller
 * cannot replace an issued problem with a structurally identical object whose
 * hash was recomputed outside this composition. */
interface IssuedPlanningProblemStateV1 {
  readonly problem: StrategyPlanningInputV1;
  readonly edges: readonly StrategyGraphEdgeV1[];
  readonly composition: StrategyRuntimeCompositionV1;
  readonly assertCurrent: () => void;
}

export interface IssuedStrategyPlanningProblemOwnerViewV1 {
  readonly problem: StrategyPlanningProblemV1;
  /** Exact Graph denominator snapshotted by the issuing composition. */
  readonly edges: readonly StrategyGraphEdgeV1[];
}

export interface IssuedStrategyPlanningInputOwnerViewV1 {
  readonly problem: StrategyPlanningInputV1;
  /** Exact Graph denominator snapshotted by the issuing composition. */
  readonly edges: readonly StrategyGraphEdgeV1[];
}

const issuedPlanningProblems = new WeakMap<object, IssuedPlanningProblemStateV1>();

export interface GeneratedStrategyRuntimeEntryV1 {
  readonly catalogEntry: GeneratedStrategyCatalogLeafV1;
  readonly issuerModulePath: string;
  readonly issuerExportName: string;
  readonly issuerClosureRoot: Hash;
  readonly planningTemplateHash: Hash;
  readonly leafDigest: Hash;
}

export interface GeneratedStrategyRuntimeDescriptorV1 {
  readonly schemaVersion: 1;
  readonly releaseIntentRoot: Hash;
  /** Global Family + Strategy definition root used by ReadyGeneration. */
  readonly definitionCatalogRoot: Hash;
  readonly proposedCapabilitySetRoot: Hash;
  readonly strategies: readonly GeneratedStrategyRuntimeEntryV1[];
  readonly descriptorRoot: Hash;
}

export interface StrategyRuntimeCompositionV1 {
  readonly definitionCatalogRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly compositionRoot: Hash;
  readonly issuerClosureRoot: Hash;
  readonly strategyIds: readonly string[];
  issuePlanningProblems(input: {
    readonly binding: StrategyGraphBindingV1;
    readonly edges: readonly StrategyGraphEdgeV1[];
    readonly trigger: StrategyPlanningTriggerCapabilityV1;
  }): readonly IssuedStrategyPlanningProblemV1[];
}

const generatedCompositionStates = new WeakMap<object, () => void>();

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function positiveDecimal(value: string, path: string): string {
  const decoded = assertDecimalString(value, path);
  if (BigInt(decoded) <= 0n) throw new TypeError(`${path} must be positive`);
  return decoded;
}

function sortedHashes(values: readonly Hash[], path: string): readonly Hash[] {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  const result = values.map((value, index) => assertHash(value, `${path}[${index}]`)).sort(compare);
  if (new Set(result).size !== result.length) throw new TypeError(`${path} contains duplicates`);
  return Object.freeze(result);
}

function normalizeGraphEdges(value: readonly StrategyGraphEdgeV1[]): readonly StrategyGraphEdgeV1[] {
  if (!Array.isArray(value)) throw new TypeError("Strategy runtime Graph edge set is invalid");
  const result = value.map((edge, edgeIndex) => {
    const inputAssetPorts = edge.inputAssetPorts;
    const outputAssetPorts = edge.outputAssetPorts;
    assertExactKeys(edge, ["edgeId", "opaqueTransitionRef", "inputAssetPorts", "outputAssetPorts"], `strategyGraph.edges[${edgeIndex}]`);
    const edgeId = assertHash(edge.edgeId, `strategyGraph.edges[${edgeIndex}].edgeId`);
    const opaqueTransitionRef = assertHash(edge.opaqueTransitionRef, `strategyGraph.edges[${edgeIndex}].opaqueTransitionRef`);
    const ports = (items: readonly StrategyGraphAssetPortV1[], side: "input" | "output") => {
      if (!Array.isArray(items) || items.length === 0) throw new TypeError(`Strategy runtime Graph ${side} ports are invalid`);
      return Object.freeze(items.map((port, portIndex) => {
        assertExactKeys(port, ["assetRef", "portRef", "ordinal"], `strategyGraph.edges[${edgeIndex}].${side}AssetPorts[${portIndex}]`);
        return Object.freeze({
          assetRef: assertHash(port.assetRef, `strategyGraph.edges[${edgeIndex}].${side}AssetPorts[${portIndex}].assetRef`),
          portRef: assertHash(port.portRef, `strategyGraph.edges[${edgeIndex}].${side}AssetPorts[${portIndex}].portRef`),
          ordinal: assertDecimalString(port.ordinal, `strategyGraph.edges[${edgeIndex}].${side}AssetPorts[${portIndex}].ordinal`),
        });
      }));
    };
    return Object.freeze({
      edgeId,
      opaqueTransitionRef,
      inputAssetPorts: ports(inputAssetPorts, "input"),
      outputAssetPorts: ports(outputAssetPorts, "output"),
    });
  });
  if (new Set(result.map(edge => edge.edgeId)).size !== result.length) {
    throw new TypeError("Strategy runtime Graph edge set is invalid");
  }
  return Object.freeze(result);
}

export type { ClosedLoopPlanningProblemDraftV1, StrategyPlanningProblemIssuerV1 } from "../../strategy-sdk/src/index.ts";
export { strategyPlanningTemplateHash } from "../../strategy-sdk/src/index.ts";

function descriptorPayload(value: Omit<GeneratedStrategyRuntimeDescriptorV1, "descriptorRoot">): object {
  return {
    schemaVersion: value.schemaVersion,
    releaseIntentRoot: value.releaseIntentRoot,
    definitionCatalogRoot: value.definitionCatalogRoot,
    proposedCapabilitySetRoot: value.proposedCapabilitySetRoot,
    strategies: value.strategies,
  };
}

export function sealGeneratedStrategyRuntimeDescriptor(
  value: Omit<GeneratedStrategyRuntimeDescriptorV1, "descriptorRoot">,
): GeneratedStrategyRuntimeDescriptorV1 {
  if (value.schemaVersion !== 1) throw new TypeError("unsupported generated Strategy runtime descriptor");
  assertHash(value.releaseIntentRoot, "strategyRuntime.releaseIntentRoot");
  assertHash(value.definitionCatalogRoot, "strategyRuntime.definitionCatalogRoot");
  assertHash(value.proposedCapabilitySetRoot, "strategyRuntime.proposedCapabilitySetRoot");
  const strategies = value.strategies.map((entry, index) => {
    assertNonEmptyString(entry.catalogEntry.strategyId, `strategyRuntime.strategies[${index}].strategyId`);
    assertHash(entry.catalogEntry.strategyDefinitionHash, `strategyRuntime.strategies[${index}].strategyDefinitionHash`);
    assertNonEmptyString(entry.issuerModulePath, `strategyRuntime.strategies[${index}].issuerModulePath`);
    assertNonEmptyString(entry.issuerExportName, `strategyRuntime.strategies[${index}].issuerExportName`);
    assertHash(entry.issuerClosureRoot, `strategyRuntime.strategies[${index}].issuerClosureRoot`);
    const templateHash = strategyPlanningTemplateHash(entry.catalogEntry.planningTemplate);
    if (entry.planningTemplateHash !== templateHash) throw new TypeError("generated Strategy planning template hash mismatch");
    const leafPayload = {
      strategyId: entry.catalogEntry.strategyId,
      strategyDefinitionHash: entry.catalogEntry.strategyDefinitionHash,
      definitionCatalogLeafDigest: entry.catalogEntry.definitionCatalogLeafDigest,
      issuerModulePath: entry.issuerModulePath,
      issuerExportName: entry.issuerExportName,
      issuerClosureRoot: entry.issuerClosureRoot,
      planningTemplateHash: entry.planningTemplateHash,
    };
    if (entry.leafDigest !== hashDomain("aloha/generated-strategy-runtime-leaf/v1", leafPayload)) {
      throw new TypeError("generated Strategy runtime leaf mismatch");
    }
    return deepFreeze({ ...entry, catalogEntry: { ...entry.catalogEntry } });
  }).sort((left, right) => compare(left.catalogEntry.strategyId, right.catalogEntry.strategyId));
  if (new Set(strategies.map(entry => entry.catalogEntry.strategyId)).size !== strategies.length) {
    throw new TypeError("duplicate generated Strategy runtime entry");
  }
  const draft = deepFreeze({
    schemaVersion: 1 as const,
    releaseIntentRoot: value.releaseIntentRoot,
    definitionCatalogRoot: value.definitionCatalogRoot,
    proposedCapabilitySetRoot: value.proposedCapabilitySetRoot,
    strategies,
  });
  return deepFreeze({
    ...draft,
    descriptorRoot: hashDomain("aloha/generated-strategy-runtime-descriptor/v1", descriptorPayload(draft)),
  });
}

function normalizeTrigger(
  trigger: StrategyPlanningTriggerCapabilityV1,
  binding: StrategyGraphBindingV1,
  edges: readonly StrategyGraphEdgeV1[],
): StrategyPlanningTriggerV1 {
  const issued = readIssuedStrategyPlanningTriggerV1(trigger, binding);
  const triggerRef = assertHash(issued.triggerRef, "strategyTrigger.triggerRef");
  const affectedEdgeIds = sortedHashes(issued.affectedEdgeIds, "strategyTrigger.affectedEdgeIds");
  const graphEdgeIds = new Set(edges.map((edge, index) => assertHash(edge.edgeId, `strategyGraph.edges[${index}].edgeId`)));
  for (const edgeId of affectedEdgeIds) if (!graphEdgeIds.has(edgeId)) throw new TypeError("Strategy trigger references an edge outside GraphView");
  if (issued.lane === "blockscan" && affectedEdgeIds.length !== 0) throw new TypeError("blockscan Strategy trigger cannot narrow GraphView");
  if (issued.lane === "backrun" && affectedEdgeIds.length === 0) throw new TypeError("backrun Strategy trigger requires affected Graph edges");
  return Object.freeze({
    lane: issued.lane,
    triggerRef,
    objectiveRef: assertHash(issued.objectiveRef, "strategyTrigger.objectiveRef"),
    entryAssetRef: assertHash(issued.entryAssetRef, "strategyTrigger.entryAssetRef"),
    returnAssetRef: assertHash(issued.returnAssetRef, "strategyTrigger.returnAssetRef"),
    affectedEdgeIds,
    correlationId: issued.correlationId,
    headHash: issued.headHash,
    generationId: issued.generationId,
    graphRoot: issued.graphRoot,
    releaseProvenanceHash: issued.releaseProvenanceHash,
    runtimeAuthority: issued.runtimeAuthority,
  });
}

function validateDraft(
  draft: ClosedLoopPlanningProblemDraftV1,
  template: ClosedLoopPlanningTemplateV1,
  trigger: StrategyPlanningTriggerV1,
): ClosedLoopPlanningProblemDraftV1 {
  if (draft === null || typeof draft !== "object" || draft.kind !== "closed-loop") throw new TypeError("Strategy issuer returned an unsupported planning problem");
  const minLegs = positiveDecimal(draft.minLegs, "planningProblem.minLegs");
  const maxLegs = positiveDecimal(draft.maxLegs, "planningProblem.maxLegs");
  const candidateLimit = positiveDecimal(draft.candidateLimit, "planningProblem.candidateLimit");
  if (
    minLegs !== template.minLegs
    || maxLegs !== template.maxLegs
    || candidateLimit !== template.candidateLimit
    || draft.edgeReuse !== template.edgeReuse
  ) throw new TypeError("Strategy issuer changed its generated planning template");
  if (draft.objectiveRef !== trigger.objectiveRef) throw new TypeError("Strategy issuer changed the trigger objective");
  if (draft.entryAssetRef !== trigger.entryAssetRef || draft.returnAssetRef !== trigger.returnAssetRef) throw new TypeError("Strategy issuer changed the objective asset boundary");
  const constraintSchemaRefs = sortedHashes(draft.constraintSchemaRefs, "planningProblem.constraintSchemaRefs");
  const expectedConstraints = sortedHashes(template.constraintSchemaRefs, "planningTemplate.constraintSchemaRefs");
  if (encodeCanonicalJson(constraintSchemaRefs) !== encodeCanonicalJson(expectedConstraints)) {
    throw new TypeError("Strategy issuer changed its generated constraint set");
  }
  const requiredAnchorEdgeIds = sortedHashes(draft.requiredAnchorEdgeIds, "planningProblem.requiredAnchorEdgeIds");
  if (encodeCanonicalJson(requiredAnchorEdgeIds) !== encodeCanonicalJson(trigger.affectedEdgeIds)) {
    throw new TypeError("Strategy issuer changed the trigger edge scope");
  }
  return deepFreeze({
    kind: "closed-loop" as const,
    objectiveRef: assertHash(draft.objectiveRef, "planningProblem.objectiveRef"),
    entryAssetRef: assertHash(draft.entryAssetRef, "planningProblem.entryAssetRef"),
    returnAssetRef: assertHash(draft.returnAssetRef, "planningProblem.returnAssetRef"),
    minLegs,
    maxLegs,
    candidateLimit,
    edgeReuse: "forbid" as const,
    requiredAnchorEdgeIds,
    constraintSchemaRefs,
  });
}

/**
 * Public construction consumes only the generated factory's opaque,
 * release-owned capability.  Descriptor data, callable issuers and release
 * provenance are never caller-supplied at this boundary.
 */
export function createGeneratedStrategyRuntimeComposition(
  capability: GeneratedStrategyRuntimeCompositionCapabilityV1,
): StrategyRuntimeCompositionV1 {
  const input = readGeneratedStrategyRuntimeCompositionCapability(capability);
  const descriptor = sealGeneratedStrategyRuntimeDescriptor({
    schemaVersion: input.descriptor.schemaVersion,
    releaseIntentRoot: input.descriptor.releaseIntentRoot,
    definitionCatalogRoot: input.descriptor.definitionCatalogRoot,
    proposedCapabilitySetRoot: input.descriptor.proposedCapabilitySetRoot,
    strategies: input.descriptor.strategies,
  });
  if (descriptor.descriptorRoot !== input.descriptor.descriptorRoot) throw new TypeError("generated Strategy runtime descriptor root mismatch");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(input.runtimeAuthority);
  const releaseProvenanceHash = assertHash(input.releaseProvenanceHash, "strategyRuntime.releaseProvenanceHash");
  if (runtimeAuthority.authorityClass !== "signed-release") {
    throw new TypeError("Strategy runtime authority class/provenance mismatch");
  }
  if (!Array.isArray(input.issuers) || input.issuers.length !== descriptor.strategies.length) {
    throw new TypeError("generated Strategy issuer set is incomplete");
  }
  const bindings = descriptor.strategies.map((entry, index) => {
    const issuer = input.issuers[index]!;
    if (
      issuer === null
      || typeof issuer !== "object"
      || typeof issuer.issue !== "function"
      || issuer.strategyId !== entry.catalogEntry.strategyId
      || issuer.version !== entry.catalogEntry.strategyVersion
      || issuer.planningTemplateHash !== entry.planningTemplateHash
    ) throw new TypeError("generated Strategy issuer identity mismatch");
    return Object.freeze({ entry, issuer });
  });
  const compositionRoot = hashDomain("aloha/generated-strategy-runtime-composition/v1", {
    descriptorRoot: descriptor.descriptorRoot,
    runtimeAuthority,
    leaves: bindings.map(binding => binding.entry.leafDigest),
  });
  const issuerClosureRoot = hashDomain("aloha/generated-strategy-runtime-issuer-closure/v1", {
    descriptorRoot: descriptor.descriptorRoot,
    issuers: bindings.map(binding => binding.entry.issuerClosureRoot),
  });
  const issueDrafts = (
    binding: StrategyGraphBindingV1,
    normalizedEdges: readonly StrategyGraphEdgeV1[],
    normalizedTrigger: StrategyPlanningTriggerV1,
  ) => Object.freeze(bindings.map(({ entry, issuer }) => Object.freeze({
    entry,
    draft: validateDraft(issuer.issue({
      template: entry.catalogEntry.planningTemplate,
      binding,
      edges: normalizedEdges,
      trigger: normalizedTrigger,
    }), entry.catalogEntry.planningTemplate, normalizedTrigger),
  })));
  let composition!: StrategyRuntimeCompositionV1;
  const compositionValue = {
    definitionCatalogRoot: descriptor.definitionCatalogRoot,
    releaseProvenanceHash,
    runtimeAuthority,
    compositionRoot,
    issuerClosureRoot,
    strategyIds: Object.freeze(bindings.map(binding => binding.entry.catalogEntry.strategyId)),
    issuePlanningProblems({ binding, edges, trigger }: {
      readonly binding: StrategyGraphBindingV1;
      readonly edges: readonly StrategyGraphEdgeV1[];
      readonly trigger: StrategyPlanningTriggerCapabilityV1;
    }) {
      input.assertCurrent();
      if (binding.graphRoot === undefined || assertHash(binding.graphRoot, "strategyRuntime.binding.graphRoot") !== binding.graphRoot) {
        throw new TypeError("Strategy runtime Graph binding is invalid");
      }
      assertNonEmptyString(binding.generationId, "strategyRuntime.binding.generationId");
      if (binding.definitionCatalogRoot !== descriptor.definitionCatalogRoot) {
        throw new TypeError("Strategy runtime definition catalog binding mismatch");
      }
      if (runtimeAuthority.authorityClass !== "signed-release") {
        throw new TypeError("Strategy production planning requires signed-release authority");
      }
      if (assertHash(binding.releaseProvenanceHash, "strategyRuntime.binding.releaseProvenanceHash") !== releaseProvenanceHash) {
        throw new TypeError("Strategy runtime release provenance binding mismatch");
      }
      const bindingAuthority = decodeRuntimeAuthorityProjectionV1(binding.runtimeAuthority);
      if (bindingAuthority.authorityClass !== "signed-release"
        || encodeCanonicalJson(bindingAuthority) !== encodeCanonicalJson(runtimeAuthority)) {
        throw new TypeError("Strategy runtime authority binding mismatch");
      }
      const normalizedEdges = normalizeGraphEdges(edges);
      const normalizedTrigger = normalizeTrigger(trigger, binding, normalizedEdges);
      return Object.freeze(issueDrafts(binding, normalizedEdges, normalizedTrigger).map(({ entry, draft }) => {
        const body = {
          ...draft,
          strategyId: entry.catalogEntry.strategyId,
          strategyDefinitionHash: entry.catalogEntry.strategyDefinitionHash,
          strategyCatalogLeafDigest: entry.catalogEntry.definitionCatalogLeafDigest,
          definitionCatalogRoot: descriptor.definitionCatalogRoot,
          generationId: binding.generationId,
          graphRoot: binding.graphRoot,
          strategyCompositionRoot: compositionRoot,
          strategyIssuerClosureRoot: issuerClosureRoot,
          releaseProvenanceHash,
          runtimeAuthority,
          readyRecordHash: binding.readyRecordHash,
          triggerRef: normalizedTrigger.triggerRef,
          lane: normalizedTrigger.lane,
          triggerCorrelationId: normalizedTrigger.correlationId,
          triggerHeadHash: normalizedTrigger.headHash,
          requiredCapabilityPredicates: entry.catalogEntry.requiredCapabilityRefs.map(ref => Object.freeze({
            capabilityId: ref.capabilityId,
            minimumVersion: ref.version,
            schemaRefs: Object.freeze([ref.schemaHash]),
          })),
        };
        const problem = deepFreeze({
          ...body,
          problemHash: hashDomain("aloha/strategy-planning-problem/v1", body),
        }) as IssuedStrategyPlanningProblemV1;
        issuedPlanningProblems.set(problem, Object.freeze({
          problem,
          edges: normalizedEdges,
          composition,
          assertCurrent: input.assertCurrent,
        }));
        return problem;
      }));
    },
  };
  composition = Object.freeze(compositionValue) as StrategyRuntimeCompositionV1;
  generatedCompositionStates.set(composition, input.assertCurrent);
  return composition;
}

export function assertIssuedStrategyPlanningProblem(
  value: unknown,
): asserts value is IssuedStrategyPlanningProblemV1 {
  readIssuedStrategyPlanningProblemV1(value);
}

export function assertIssuedStrategyPlanningInput(
  value: unknown,
): asserts value is IssuedStrategyPlanningInputV1 {
  readIssuedStrategyPlanningInputV1(value);
}

/** Planner-only owner read of the signed Strategy/Graph denominator. */
export function readIssuedStrategyPlanningInputV1(
  value: unknown,
): IssuedStrategyPlanningInputOwnerViewV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Strategy planning input was not issued by the active Strategy composition");
  }
  const state = issuedPlanningProblems.get(value);
  if (state === undefined) {
    throw new TypeError("Strategy planning input was not issued by the active Strategy composition");
  }
  state.assertCurrent();
  if (state.problem !== value || generatedCompositionStates.get(state.composition) !== state.assertCurrent) {
    throw new TypeError("Strategy planning input owner state is invalid");
  }
  return Object.freeze({ problem: state.problem, edges: state.edges });
}

/** Planner-only owner read. It re-fences release rotation on every use. */
export function readIssuedStrategyPlanningProblemV1(
  value: unknown,
): IssuedStrategyPlanningProblemOwnerViewV1 {
  const state = readIssuedStrategyPlanningInputV1(value);
  return Object.freeze({ problem: state.problem, edges: state.edges });
}

export function assertGeneratedStrategyRuntimeComposition(value: unknown): asserts value is StrategyRuntimeCompositionV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Strategy runtime composition is not generated and release-authenticated");
  }
  const assertCurrent = generatedCompositionStates.get(value);
  if (assertCurrent === undefined) throw new TypeError("Strategy runtime composition is not generated and release-authenticated");
  assertCurrent();
}
