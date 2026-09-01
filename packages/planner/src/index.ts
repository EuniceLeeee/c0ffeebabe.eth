import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { asSchemaRef } from "../../capability-contracts/src/index.ts";
import {
  readIssuedStrategyPlanningInputV1,
  type IssuedStrategyPlanningInputV1,
  type StrategyGraphEdgeV1,
  type StrategyPlanningProblemV1,
} from "../../strategy-composition/src/index.ts";
import { decodeRuntimeAuthorityProjectionV1 } from "../../runtime-authority/src/index.ts";
import type { LoopIntentV1, RouteLegIntentV1 } from "../../strategy-sdk/src/index.ts";

export interface PlannedRouteLegV1 {
  readonly edgeId: Hash;
  readonly transitionRef: Hash;
  readonly inputAssetRef: Hash;
  readonly inputPortRef: Hash;
  readonly outputAssetRef: Hash;
  readonly outputPortRef: Hash;
}

export interface PlannedRouteCandidateV1 {
  readonly candidateId: Hash;
  readonly planningProblemHash: Hash;
  readonly legs: readonly PlannedRouteLegV1[];
  readonly loopIntent: LoopIntentV1;
  readonly orderKey: Hash;
}

export interface PlanningEnumerationV1 {
  readonly kind: "aloha.closed-loop-enumeration";
  readonly planningProblemHash: Hash;
  /** Full owner-issued Strategy binding consumed by the coarse join. */
  readonly planningProblem: StrategyPlanningProblemV1;
  readonly graphRoot: Hash;
  readonly candidateLimit: string;
  /** Process-local owner denominator. This array is not a wire envelope. */
  readonly candidates: readonly PlannedRouteCandidateV1[];
  /** True once at least one additional unique route was observed past the bound. */
  readonly truncated: boolean;
  readonly observedUniqueCountLowerBound: string;
  readonly enumerationRoot: Hash;
}

/**
 * The complete planner denominator is also a process-local capability.  Its
 * visible fields are retained for deterministic downstream projection and
 * evidence, while the owner-held identity prevents a caller from deleting or
 * replacing candidates and reusing the original enumeration root.
 */
export type IssuedPlanningEnumerationV1 = PlanningEnumerationV1 & {
  readonly __issuedPlanningEnumerationV1?: never;
};

interface IssuedPlanningEnumerationStateV1 {
  readonly enumeration: PlanningEnumerationV1;
  readonly problemCapability: IssuedStrategyPlanningInputV1;
}

const issuedPlanningEnumerations = new WeakMap<object, IssuedPlanningEnumerationStateV1>();
const ENUMERATION_HASH_TREE_FANOUT = 128;

interface TransitionV1 extends PlannedRouteLegV1 {
  readonly transitionKey: string;
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function boundedOrderedRoot(domain: string, values: readonly unknown[]): Hash {
  let level = values.length === 0
    ? [hashDomain(`${domain}/node/v1`, { level: "0", firstOrdinal: "0", values: [] })]
    : Array.from({ length: Math.ceil(values.length / ENUMERATION_HASH_TREE_FANOUT) }, (_, index) => {
      const first = index * ENUMERATION_HASH_TREE_FANOUT;
      return hashDomain(`${domain}/node/v1`, {
        level: "0",
        firstOrdinal: String(first),
        values: values.slice(first, first + ENUMERATION_HASH_TREE_FANOUT),
      });
    });
  let depth = 1;
  while (level.length > 1) {
    const previous = level;
    level = Array.from({ length: Math.ceil(previous.length / ENUMERATION_HASH_TREE_FANOUT) }, (_, index) => {
      const first = index * ENUMERATION_HASH_TREE_FANOUT;
      return hashDomain(`${domain}/node/v1`, {
        level: String(depth),
        firstOrdinal: String(first),
        values: previous.slice(first, first + ENUMERATION_HASH_TREE_FANOUT),
      });
    });
    depth += 1;
  }
  return hashDomain(domain, {
    algorithm: "bounded-ordered-tree-v1",
    count: String(values.length),
    treeRoot: level[0]!,
  });
}

export function planningEnumerationRootV1(value: Omit<PlanningEnumerationV1, "enumerationRoot">): Hash {
  const orderedCandidateRoot = boundedOrderedRoot(
    "aloha/planner-enumeration-candidates/v1",
    value.candidates.map(candidate => ({ candidateId: candidate.candidateId, orderKey: candidate.orderKey })),
  );
  return hashDomain("aloha/planner-enumeration/v1", {
    kind: value.kind,
    planningProblemHash: value.planningProblemHash,
    graphRoot: value.graphRoot,
    candidateLimit: value.candidateLimit,
    truncated: value.truncated,
    observedUniqueCountLowerBound: value.observedUniqueCountLowerBound,
    candidateCount: String(value.candidates.length),
    orderedCandidateRoot,
  });
}

const PROBLEM_CORE_KEYS = Object.freeze([
  "kind", "objectiveRef", "entryAssetRef", "returnAssetRef", "minLegs", "maxLegs", "candidateLimit", "edgeReuse",
  "requiredAnchorEdgeIds", "constraintSchemaRefs", "strategyId", "strategyDefinitionHash",
  "strategyCatalogLeafDigest", "definitionCatalogRoot", "generationId", "graphRoot",
  "triggerRef", "lane", "triggerCorrelationId", "triggerHeadHash",
  "requiredCapabilityPredicates", "strategyCompositionRoot", "strategyIssuerClosureRoot",
  "readyRecordHash", "problemHash",
]);
const SIGNED_PROBLEM_KEYS = Object.freeze([...PROBLEM_CORE_KEYS, "releaseProvenanceHash", "runtimeAuthority"]);
const UNSIGNED_PROBLEM_KEYS = Object.freeze([...PROBLEM_CORE_KEYS, "runtimeMembershipHash", "runtimeAuthority"]);

function validateProblem(value: StrategyPlanningProblemV1): StrategyPlanningProblemV1 {
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(value.runtimeAuthority);
  assertExactKeys(
    value,
    runtimeAuthority.authorityClass === "signed-release" ? SIGNED_PROBLEM_KEYS : UNSIGNED_PROBLEM_KEYS,
    "planningProblem",
  );
  if (value.kind !== "closed-loop" || value.edgeReuse !== "forbid") throw new TypeError("planner received an unsupported planning problem");
  if (value.lane !== "blockscan" && value.lane !== "backrun") throw new TypeError("planner problem has an unsupported lane");
  assertHash(value.objectiveRef, "planningProblem.objectiveRef");
  assertHash(value.entryAssetRef, "planningProblem.entryAssetRef");
  assertHash(value.returnAssetRef, "planningProblem.returnAssetRef");
  if (value.entryAssetRef !== value.returnAssetRef) throw new TypeError("planner closed-loop objective asset boundary mismatch");
  assertHash(value.strategyDefinitionHash, "planningProblem.strategyDefinitionHash");
  assertHash(value.strategyCatalogLeafDigest, "planningProblem.strategyCatalogLeafDigest");
  assertHash(value.definitionCatalogRoot, "planningProblem.definitionCatalogRoot");
  assertHash(value.graphRoot, "planningProblem.graphRoot");
  assertHash(value.triggerRef, "planningProblem.triggerRef");
  assertHash(value.triggerCorrelationId, "planningProblem.triggerCorrelationId");
  assertHash(value.triggerHeadHash, "planningProblem.triggerHeadHash");
  assertHash(value.strategyCompositionRoot, "planningProblem.strategyCompositionRoot");
  assertHash(value.strategyIssuerClosureRoot, "planningProblem.strategyIssuerClosureRoot");
  if (runtimeAuthority.authorityClass === "signed-release") {
    assertHash(value.releaseProvenanceHash, "planningProblem.releaseProvenanceHash");
  } else {
    assertHash(value.runtimeMembershipHash, "planningProblem.runtimeMembershipHash");
  }
  assertHash(value.readyRecordHash, "planningProblem.readyRecordHash");
  assertHash(value.problemHash, "planningProblem.problemHash");
  if (typeof value.strategyId !== "string" || value.strategyId.length === 0 || typeof value.generationId !== "string" || value.generationId.length === 0) {
    throw new TypeError("planner problem identity is incomplete");
  }
  const anchors = value.requiredAnchorEdgeIds.map((item, index) => assertHash(item, `planningProblem.requiredAnchorEdgeIds[${index}]`));
  const constraints = value.constraintSchemaRefs.map((item, index) => assertHash(item, `planningProblem.constraintSchemaRefs[${index}]`));
  if (new Set(anchors).size !== anchors.length || new Set(constraints).size !== constraints.length) throw new TypeError("planner problem contains duplicate refs");
  for (const [index, predicate] of value.requiredCapabilityPredicates.entries()) {
    assertExactKeys(predicate, ["capabilityId", "minimumVersion", "schemaRefs"], `planningProblem.requiredCapabilityPredicates[${index}]`);
    if (typeof predicate.capabilityId !== "string" || predicate.capabilityId.length === 0 || typeof predicate.minimumVersion !== "string" || predicate.minimumVersion.length === 0) {
      throw new TypeError("planner problem capability predicate is incomplete");
    }
    const refs = predicate.schemaRefs.map((item, refIndex) => assertHash(item, `planningProblem.requiredCapabilityPredicates[${index}].schemaRefs[${refIndex}]`));
    if (new Set(refs).size !== refs.length) throw new TypeError("planner problem capability predicate contains duplicate schema refs");
  }
  const { problemHash, ...body } = value;
  if (hashDomain("aloha/strategy-planning-problem/v1", body) !== problemHash) throw new TypeError("planner problem hash mismatch");
  return value;
}

function boundedNumber(value: string, path: string, maximum: number): number {
  const canonical = assertDecimalString(value, path);
  const decoded = BigInt(canonical);
  if (decoded <= 0n || decoded > BigInt(maximum)) throw new TypeError(`${path} is outside the supported bound`);
  return Number(decoded);
}

function transitions(edges: readonly StrategyGraphEdgeV1[]): readonly TransitionV1[] {
  if (!Array.isArray(edges)) throw new TypeError("planner Graph edges must be an array");
  const seenEdges = new Set<Hash>();
  const result: TransitionV1[] = [];
  for (const [edgeIndex, edge] of edges.entries()) {
    const edgeId = assertHash(edge.edgeId, `planner.edges[${edgeIndex}].edgeId`);
    const transitionRef = assertHash(edge.opaqueTransitionRef, `planner.edges[${edgeIndex}].opaqueTransitionRef`);
    if (seenEdges.has(edgeId)) throw new TypeError("planner Graph contains duplicate edge ids");
    seenEdges.add(edgeId);
    if (!Array.isArray(edge.inputAssetPorts) || edge.inputAssetPorts.length === 0 || !Array.isArray(edge.outputAssetPorts) || edge.outputAssetPorts.length === 0) {
      throw new TypeError("planner Graph edge has incomplete asset ports");
    }
    for (const [inputIndex, input] of edge.inputAssetPorts.entries()) {
      const inputAssetRef = assertHash(input.assetRef, `planner.edges[${edgeIndex}].inputAssetPorts[${inputIndex}].assetRef`);
      const inputPortRef = assertHash(input.portRef, `planner.edges[${edgeIndex}].inputAssetPorts[${inputIndex}].portRef`);
      assertDecimalString(input.ordinal, `planner.edges[${edgeIndex}].inputAssetPorts[${inputIndex}].ordinal`);
      for (const [outputIndex, output] of edge.outputAssetPorts.entries()) {
        const outputAssetRef = assertHash(output.assetRef, `planner.edges[${edgeIndex}].outputAssetPorts[${outputIndex}].assetRef`);
        const outputPortRef = assertHash(output.portRef, `planner.edges[${edgeIndex}].outputAssetPorts[${outputIndex}].portRef`);
        assertDecimalString(output.ordinal, `planner.edges[${edgeIndex}].outputAssetPorts[${outputIndex}].ordinal`);
        const transitionKey = `${edgeId}\u001f${transitionRef}\u001f${inputAssetRef}\u001f${inputPortRef}\u001f${outputAssetRef}\u001f${outputPortRef}`;
        result.push(Object.freeze({ edgeId, transitionRef, inputAssetRef, inputPortRef, outputAssetRef, outputPortRef, transitionKey }));
      }
    }
  }
  result.sort((left, right) => compare(left.transitionKey, right.transitionKey));
  if (new Set(result.map(item => item.transitionKey)).size !== result.length) throw new TypeError("planner Graph contains duplicate transitions");
  return Object.freeze(result);
}

function loopIntent(problem: StrategyPlanningProblemV1, legs: readonly PlannedRouteLegV1[]): LoopIntentV1 {
  if (legs[0]?.inputAssetRef !== problem.entryAssetRef || legs.at(-1)?.outputAssetRef !== problem.returnAssetRef) {
    throw new TypeError("planner executable route does not bind the objective asset boundary");
  }
  const routeLegs: readonly RouteLegIntentV1[] = Object.freeze(legs.map(leg => Object.freeze({
    fromAssetRef: leg.inputAssetRef,
    toAssetRef: leg.outputAssetRef,
    selectionRef: hashDomain("aloha/planner-route-selection/v1", leg),
    requiredCapabilityPredicates: problem.requiredCapabilityPredicates,
  })));
  return deepFreeze({
    kind: "closed-loop" as const,
    entryAssetRef: problem.entryAssetRef,
    returnAssetRef: problem.returnAssetRef,
    objectiveRef: problem.objectiveRef,
    constraintSchemaRefs: Object.freeze(problem.constraintSchemaRefs.map((ref, index) => asSchemaRef(ref, `planningProblem.constraintSchemaRefs[${index}]`))),
    legs: routeLegs,
  });
}

function sealCandidate(problem: StrategyPlanningProblemV1, rawLegs: readonly TransitionV1[]): PlannedRouteCandidateV1 {
  const legs: readonly PlannedRouteLegV1[] = Object.freeze(rawLegs.map(({ transitionKey: _transitionKey, ...leg }) => Object.freeze(leg)));
  const candidatePayload = {
    planningProblemHash: problem.problemHash,
    objectiveRef: problem.objectiveRef,
    entryAssetRef: problem.entryAssetRef,
    returnAssetRef: problem.returnAssetRef,
    legs,
  };
  const candidateId = hashDomain("aloha/planner-route-candidate/v1", candidatePayload);
  return deepFreeze({
    candidateId,
    planningProblemHash: problem.problemHash,
    legs,
    loopIntent: loopIntent(problem, legs),
    orderKey: hashDomain("aloha/planner-route-order/v1", candidatePayload),
  });
}

/**
 * Generic directed-cycle enumeration. It knows only asset/edge refs and the
 * generated Strategy planning problem; no Family, protocol, ABI or venue type
 * enters this package.
 */
export function enumerateClosedLoopPlanningProblem(input: {
  readonly problem: IssuedStrategyPlanningInputV1;
}): IssuedPlanningEnumerationV1 {
  const problemCapability = input.problem;
  assertExactKeys(input, ["problem"], "planner.enumerationInput");
  const issued = readIssuedStrategyPlanningInputV1(problemCapability);
  const problem = validateProblem(issued.problem);
  const minLegs = boundedNumber(problem.minLegs, "planner.problem.minLegs", 16);
  const maxLegs = boundedNumber(problem.maxLegs, "planner.problem.maxLegs", 16);
  if (minLegs > maxLegs) throw new TypeError("planner problem has inverted leg bounds");
  const candidateLimit = boundedNumber(problem.candidateLimit, "planner.problem.candidateLimit", 100_000);
  const graphTransitions = transitions(issued.edges);
  const byInput = new Map<Hash, TransitionV1[]>();
  for (const transition of graphTransitions) {
    const group = byInput.get(transition.inputAssetRef) ?? [];
    group.push(transition);
    byInput.set(transition.inputAssetRef, group);
  }
  const requiredAnchors = new Set(problem.requiredAnchorEdgeIds.map((value, index) => assertHash(value, `planner.problem.requiredAnchorEdgeIds[${index}]`)));
  const unique = new Map<Hash, PlannedRouteCandidateV1>();
  let truncated = false;
  let observedUniqueCountLowerBound = 0;

  const visit = (startAssetRef: Hash, currentAssetRef: Hash, path: readonly TransitionV1[], usedEdges: ReadonlySet<Hash>): boolean => {
    if (path.length >= maxLegs) return false;
    for (const transition of byInput.get(currentAssetRef) ?? []) {
      if (usedEdges.has(transition.edgeId)) continue;
      const next = [...path, transition];
      if (transition.outputAssetRef === startAssetRef && next.length >= minLegs) {
        if (requiredAnchors.size === 0 || next.some(leg => requiredAnchors.has(leg.edgeId))) {
          const candidate = sealCandidate(problem, next);
          if (!unique.has(candidate.candidateId)) {
            observedUniqueCountLowerBound += 1;
            if (unique.size >= candidateLimit) {
              truncated = true;
              return true;
            }
            unique.set(candidate.candidateId, candidate);
          }
        }
      }
      if (next.length < maxLegs && transition.outputAssetRef !== startAssetRef) {
        const stop = visit(startAssetRef, transition.outputAssetRef, next, new Set([...usedEdges, transition.edgeId]));
        if (stop) return true;
      }
    }
    return false;
  };

  visit(problem.entryAssetRef, problem.entryAssetRef, [], new Set());
  const candidates = Object.freeze([...unique.values()].sort((left, right) => {
    const byOrder = compare(left.orderKey, right.orderKey);
    return byOrder !== 0 ? byOrder : compare(left.candidateId, right.candidateId);
  }));
  const body = {
    kind: "aloha.closed-loop-enumeration" as const,
    planningProblemHash: problem.problemHash,
    planningProblem: problem,
    graphRoot: problem.graphRoot,
    candidateLimit: problem.candidateLimit,
    candidates,
    truncated,
    observedUniqueCountLowerBound: observedUniqueCountLowerBound.toString(),
  };
  const enumeration = deepFreeze({
    ...body,
    enumerationRoot: planningEnumerationRootV1(body),
  }) as IssuedPlanningEnumerationV1;
  issuedPlanningEnumerations.set(enumeration, Object.freeze({
    enumeration,
    problemCapability,
  }));
  return enumeration;
}

/** Narrow owner reader used by the coarse denominator join. */
export function readIssuedPlanningEnumerationV1(value: unknown): PlanningEnumerationV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("planner enumeration capability is invalid");
  }
  const state = issuedPlanningEnumerations.get(value);
  if (state === undefined) {
    throw new TypeError("planner enumeration was not issued by the planner owner");
  }
  const current = readIssuedStrategyPlanningInputV1(state.problemCapability);
  if (state.enumeration !== value || state.enumeration.planningProblem !== current.problem) {
    throw new TypeError("planner enumeration owner binding is invalid");
  }
  return state.enumeration;
}
