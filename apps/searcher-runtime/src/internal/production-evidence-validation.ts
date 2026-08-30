import {
  assertDecimalString,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainObject,
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type { PlannedRouteCandidateV1 } from "../../../../packages/planner/src/index.ts";
import type { ProducerCandidateTerminalObservationV1 } from "../../../../packages/producer/src/index.ts";
import type { RouteAccountingV1 } from "../../../../packages/search-pipeline/src/index.ts";
import type { StrategyPlanningProblemV1 } from "../../../../packages/strategy-composition/src/index.ts";
import {
  decodeCoarseRouteBindingV1,
  type CoarseRouteBindingV1,
} from "../../../../packages/coarse-economics/src/index.ts";
import { familyCoarseRouteOwnerRefV1 } from "../../../../packages/family-composition/src/index.ts";
import type { RuntimeReleaseStrategyEvidenceExpectationV1 } from "../../../../packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts";

const PLANNING_PROBLEM_KEYS = Object.freeze([
  "kind", "objectiveRef", "entryAssetRef", "returnAssetRef", "minLegs", "maxLegs", "candidateLimit", "edgeReuse",
  "requiredAnchorEdgeIds", "constraintSchemaRefs", "strategyId", "strategyDefinitionHash",
  "strategyCatalogLeafDigest", "definitionCatalogRoot", "generationId", "graphRoot",
  "triggerRef", "lane", "triggerCorrelationId", "triggerHeadHash",
  "requiredCapabilityPredicates", "strategyCompositionRoot", "strategyIssuerClosureRoot",
  "releaseProvenanceHash", "readyRecordHash", "problemHash",
]);

function record(value: unknown, path: string): Record<string, unknown> {
  assertPlainObject(value, path);
  return value as Record<string, unknown>;
}

function hash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) {
    throw new TypeError(`${path} is not a non-zero lowercase hash`);
  }
  return value as Hash;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  const leftBytes = encodeCanonicalBytes(left);
  const rightBytes = encodeCanonicalBytes(right);
  return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

export function exactProductionPlanningProblemV1(value: unknown, path: string): StrategyPlanningProblemV1 {
  const raw = record(value, path);
  assertExactKeys(raw, PLANNING_PROBLEM_KEYS, path);
  if (raw.kind !== "closed-loop" || raw.edgeReuse !== "forbid") throw new TypeError(`${path} kind/edgeReuse is invalid`);
  if (raw.lane !== "blockscan" && raw.lane !== "backrun") throw new TypeError(`${path}.lane is invalid`);
  for (const field of ["objectiveRef", "entryAssetRef", "returnAssetRef", "strategyDefinitionHash", "strategyCatalogLeafDigest",
    "definitionCatalogRoot", "graphRoot", "triggerRef", "triggerCorrelationId", "triggerHeadHash", "strategyCompositionRoot",
    "strategyIssuerClosureRoot", "releaseProvenanceHash", "readyRecordHash", "problemHash"] as const) {
    hash(raw[field], `${path}.${field}`);
  }
  if (raw.entryAssetRef !== raw.returnAssetRef) throw new TypeError(`${path} closed-loop asset boundary mismatch`);
  const minLegs = BigInt(assertDecimalString(raw.minLegs, `${path}.minLegs`));
  const maxLegs = BigInt(assertDecimalString(raw.maxLegs, `${path}.maxLegs`));
  const candidateLimit = BigInt(assertDecimalString(raw.candidateLimit, `${path}.candidateLimit`));
  if (minLegs < 1n || minLegs > 16n || maxLegs < minLegs || maxLegs > 16n
    || candidateLimit < 1n || candidateLimit > 100_000n) {
    throw new TypeError(`${path} planner bounds are invalid`);
  }
  assertNonEmptyString(raw.strategyId, `${path}.strategyId`);
  assertNonEmptyString(raw.generationId, `${path}.generationId`);
  if (!Array.isArray(raw.requiredAnchorEdgeIds) || !Array.isArray(raw.constraintSchemaRefs)
    || !Array.isArray(raw.requiredCapabilityPredicates)) throw new TypeError(`${path} arrays are invalid`);
  const anchors = raw.requiredAnchorEdgeIds.map((item, index) => hash(item, `${path}.requiredAnchorEdgeIds[${index}]`));
  const constraints = raw.constraintSchemaRefs.map((item, index) => hash(item, `${path}.constraintSchemaRefs[${index}]`));
  if (new Set(anchors).size !== anchors.length || new Set(constraints).size !== constraints.length) throw new TypeError(`${path} contains duplicate refs`);
  for (const [index, rawPredicate] of raw.requiredCapabilityPredicates.entries()) {
    const predicatePath = `${path}.requiredCapabilityPredicates[${index}]`;
    const predicate = record(rawPredicate, predicatePath);
    assertExactKeys(predicate, ["capabilityId", "minimumVersion", "schemaRefs"], predicatePath);
    assertNonEmptyString(predicate.capabilityId, `${predicatePath}.capabilityId`);
    assertNonEmptyString(predicate.minimumVersion, `${predicatePath}.minimumVersion`);
    if (!Array.isArray(predicate.schemaRefs)) throw new TypeError(`${predicatePath}.schemaRefs is invalid`);
    const refs = predicate.schemaRefs.map((item, refIndex) => hash(item, `${predicatePath}.schemaRefs[${refIndex}]`));
    if (new Set(refs).size !== refs.length) throw new TypeError(`${predicatePath} contains duplicate schema refs`);
  }
  const { problemHash, ...body } = raw;
  if (problemHash !== hashDomain("aloha/strategy-planning-problem/v1", body as CanonicalJson)) {
    throw new TypeError(`${path}.problemHash mismatch`);
  }
  return raw as unknown as StrategyPlanningProblemV1;
}

export function exactProductionRouteCandidateV1(
  value: unknown,
  problem: StrategyPlanningProblemV1,
  entry: RouteAccountingV1["entries"][number],
  path: string,
): PlannedRouteCandidateV1 {
  const raw = record(value, path);
  assertExactKeys(raw, ["candidateId", "planningProblemHash", "legs", "loopIntent", "orderKey"], path);
  const candidateId = hash(raw.candidateId, `${path}.candidateId`);
  const planningProblemHash = hash(raw.planningProblemHash, `${path}.planningProblemHash`);
  const orderKey = hash(raw.orderKey, `${path}.orderKey`);
  if (!Array.isArray(raw.legs) || raw.legs.length < 2) throw new TypeError(`${path}.legs are invalid`);
  const legs = Object.freeze(raw.legs.map((rawLeg, index) => {
    const legPath = `${path}.legs[${index}]`;
    const leg = record(rawLeg, legPath);
    assertExactKeys(leg, ["edgeId", "transitionRef", "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef"], legPath);
    return Object.freeze({
      edgeId: hash(leg.edgeId, `${legPath}.edgeId`),
      transitionRef: hash(leg.transitionRef, `${legPath}.transitionRef`),
      inputAssetRef: hash(leg.inputAssetRef, `${legPath}.inputAssetRef`),
      inputPortRef: hash(leg.inputPortRef, `${legPath}.inputPortRef`),
      outputAssetRef: hash(leg.outputAssetRef, `${legPath}.outputAssetRef`),
      outputPortRef: hash(leg.outputPortRef, `${legPath}.outputPortRef`),
    });
  }));
  if (new Set(legs.map(leg => leg.edgeId)).size !== legs.length
    || legs.some((leg, index) => leg.outputAssetRef !== legs[(index + 1) % legs.length]!.inputAssetRef)) {
    throw new TypeError(`${path}.legs do not form a unique closed route`);
  }
  if (BigInt(legs.length) < BigInt(problem.minLegs) || BigInt(legs.length) > BigInt(problem.maxLegs)) {
    throw new TypeError(`${path}.legs are outside the planning bounds`);
  }
  const requiredAnchors = new Set(problem.requiredAnchorEdgeIds);
  if (requiredAnchors.size !== 0 && !legs.some(leg => requiredAnchors.has(leg.edgeId))) {
    throw new TypeError(`${path}.legs do not include a required anchor`);
  }
  if (planningProblemHash !== problem.problemHash || candidateId !== entry.candidateId || !sameCanonical(legs, entry.legs)) {
    throw new TypeError(`${path} does not exact-join the passed accounting entry`);
  }
  const candidatePayload = {
    planningProblemHash: problem.problemHash,
    objectiveRef: problem.objectiveRef,
    entryAssetRef: problem.entryAssetRef,
    returnAssetRef: problem.returnAssetRef,
    legs,
  };
  if (candidateId !== hashDomain("aloha/planner-route-candidate/v1", candidatePayload)
    || orderKey !== hashDomain("aloha/planner-route-order/v1", candidatePayload)) {
    throw new TypeError(`${path} candidate/order identity mismatch`);
  }
  const intent = record(raw.loopIntent, `${path}.loopIntent`);
  assertExactKeys(intent, ["kind", "entryAssetRef", "returnAssetRef", "objectiveRef", "constraintSchemaRefs", "legs"], `${path}.loopIntent`);
  if (!Array.isArray(intent.constraintSchemaRefs) || !Array.isArray(intent.legs)) throw new TypeError(`${path}.loopIntent arrays are invalid`);
  if (intent.kind !== "closed-loop"
    || intent.entryAssetRef !== problem.entryAssetRef
    || intent.returnAssetRef !== problem.returnAssetRef
    || intent.entryAssetRef !== legs[0]!.inputAssetRef
    || intent.objectiveRef !== problem.objectiveRef
    || intent.legs.length !== legs.length
    || hashDomain("aloha/planner-constraint-set/v1", intent.constraintSchemaRefs as CanonicalJson) !== hashDomain("aloha/planner-constraint-set/v1", problem.constraintSchemaRefs as unknown as CanonicalJson)) {
    throw new TypeError(`${path}.loopIntent mismatch`);
  }
  for (const [index, rawIntentLeg] of intent.legs.entries()) {
    const intentPath = `${path}.loopIntent.legs[${index}]`;
    const intentLeg = record(rawIntentLeg, intentPath);
    assertExactKeys(intentLeg, ["fromAssetRef", "toAssetRef", "selectionRef", "requiredCapabilityPredicates"], intentPath);
    if (!Array.isArray(intentLeg.requiredCapabilityPredicates)) throw new TypeError(`${intentPath}.requiredCapabilityPredicates is invalid`);
    if (intentLeg.fromAssetRef !== legs[index]!.inputAssetRef
      || intentLeg.toAssetRef !== legs[index]!.outputAssetRef
      || intentLeg.selectionRef !== hashDomain("aloha/planner-route-selection/v1", legs[index]!)
      || hashDomain("aloha/planner-capability-set/v1", intentLeg.requiredCapabilityPredicates as CanonicalJson) !== hashDomain("aloha/planner-capability-set/v1", problem.requiredCapabilityPredicates as unknown as CanonicalJson)) {
      throw new TypeError(`${intentPath} mismatch`);
    }
  }
  return deepFreeze({ candidateId, planningProblemHash, legs, loopIntent: intent as unknown as PlannedRouteCandidateV1["loopIntent"], orderKey });
}

export function validateProductionStage2EdgeMembershipV1(
  value: unknown,
  leg: RouteAccountingV1["entries"][number]["legs"][number],
  path: string,
): void {
  const edge = record(value, path);
  assertExactKeys(edge, [
    "edgeId", "inputAssetPorts", "outputAssetPorts", "opaqueTransitionRef", "constraintRefs",
    "owningFamilyId", "owningFamilyDefinitionHash", "owningInstanceKey", "instancePublicationHash",
    "staticProjectionHash", "projectionHash", "rehydrationRef",
  ], path);
  if (!Array.isArray(edge.inputAssetPorts) || !Array.isArray(edge.outputAssetPorts) || !Array.isArray(edge.constraintRefs)) {
    throw new TypeError(`${path} port/constraint arrays are invalid`);
  }
  const decodePorts = (values: readonly unknown[], portPath: string) => Object.freeze(values.map((rawPort, index) => {
    const itemPath = `${portPath}[${index}]`;
    const port = record(rawPort, itemPath);
    assertExactKeys(port, ["assetIdentity", "assetRef", "portRef", "ordinal"], itemPath);
    return Object.freeze({
      assetIdentity: port.assetIdentity as CanonicalJson,
      assetRef: hash(port.assetRef, `${itemPath}.assetRef`),
      portRef: hash(port.portRef, `${itemPath}.portRef`),
      ordinal: assertDecimalString(port.ordinal, `${itemPath}.ordinal`),
    });
  }));
  const inputAssetPorts = decodePorts(edge.inputAssetPorts, `${path}.inputAssetPorts`);
  const outputAssetPorts = decodePorts(edge.outputAssetPorts, `${path}.outputAssetPorts`);
  const constraintRefs = Object.freeze(edge.constraintRefs.map((item, index) => hash(item, `${path}.constraintRefs[${index}]`)));
  const rehydration = record(edge.rehydrationRef, `${path}.rehydrationRef`);
  assertExactKeys(rehydration, ["familyDefinitionHash", "instanceKey", "instancePublicationHash", "staticProjectionMemoHash", "requestedArtifactDependencyRoot"], `${path}.rehydrationRef`);
  const payload = Object.freeze({
    inputAssetPorts,
    outputAssetPorts,
    opaqueTransitionRef: hash(edge.opaqueTransitionRef, `${path}.opaqueTransitionRef`),
    constraintRefs,
    owningFamilyId: assertNonEmptyString(edge.owningFamilyId, `${path}.owningFamilyId`),
    owningFamilyDefinitionHash: hash(edge.owningFamilyDefinitionHash, `${path}.owningFamilyDefinitionHash`),
    owningInstanceKey: assertNonEmptyString(edge.owningInstanceKey, `${path}.owningInstanceKey`),
    instancePublicationHash: hash(edge.instancePublicationHash, `${path}.instancePublicationHash`),
    staticProjectionHash: hash(edge.staticProjectionHash, `${path}.staticProjectionHash`),
    projectionHash: hash(edge.projectionHash, `${path}.projectionHash`),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: hash(rehydration.familyDefinitionHash, `${path}.rehydrationRef.familyDefinitionHash`),
      instanceKey: assertNonEmptyString(rehydration.instanceKey, `${path}.rehydrationRef.instanceKey`),
      instancePublicationHash: hash(rehydration.instancePublicationHash, `${path}.rehydrationRef.instancePublicationHash`),
      staticProjectionMemoHash: hash(rehydration.staticProjectionMemoHash, `${path}.rehydrationRef.staticProjectionMemoHash`),
      requestedArtifactDependencyRoot: hash(rehydration.requestedArtifactDependencyRoot, `${path}.rehydrationRef.requestedArtifactDependencyRoot`),
    }),
  });
  const edgeId = hash(edge.edgeId, `${path}.edgeId`);
  if (edgeId !== hashDomain("aloha/persisted-graph-edge/v1", payload)
    || edgeId !== leg.edgeId
    || payload.opaqueTransitionRef !== leg.transitionRef
    || !inputAssetPorts.some(port => port.assetRef === leg.inputAssetRef && port.portRef === leg.inputPortRef)
    || !outputAssetPorts.some(port => port.assetRef === leg.outputAssetRef && port.portRef === leg.outputPortRef)) {
    throw new TypeError(`${path} does not contain the passed route leg`);
  }
}

export function validateProductionPlanningContextJoinV1(input: Readonly<{
  readonly problem: Pick<StrategyPlanningProblemV1, "triggerCorrelationId" | "objectiveRef">;
  readonly candidateCorrelationId: Hash;
  readonly resolvedCorrelationId: Hash;
  readonly resolvedObjectiveRef: Hash;
}>): void {
  if (input.problem.triggerCorrelationId !== input.candidateCorrelationId
    || input.problem.triggerCorrelationId !== input.resolvedCorrelationId
    || input.problem.objectiveRef !== input.resolvedObjectiveRef) {
    throw new TypeError("production evidence planning trigger/objective splice");
  }
}

export function validateProductionStrategyQualificationV1(
  problem: StrategyPlanningProblemV1,
  expectation: RuntimeReleaseStrategyEvidenceExpectationV1 | null,
): void {
  if (expectation === null) {
    throw new TypeError("production evidence release-owned Strategy qualification expectation is unavailable");
  }
  const matches = expectation.entries.filter(entry => entry.strategyId === problem.strategyId);
  if (matches.length !== 1) throw new TypeError("production evidence Strategy qualification membership mismatch");
  const entry = matches[0]!;
  const template = entry.catalogEntry.planningTemplate;
  const requiredCapabilityPredicates = entry.catalogEntry.requiredCapabilityRefs.map(ref => Object.freeze({
    capabilityId: ref.capabilityId,
    minimumVersion: ref.version,
    schemaRefs: Object.freeze([ref.schemaHash]),
  }));
  if (problem.strategyDefinitionHash !== entry.strategyDefinitionHash
    || problem.strategyCatalogLeafDigest !== entry.catalogEntry.definitionCatalogLeafDigest
    || problem.definitionCatalogRoot !== expectation.definitionCatalogRoot
    || problem.strategyCompositionRoot !== expectation.strategyCompositionRoot
    || problem.strategyIssuerClosureRoot !== expectation.strategyIssuerClosureRoot
    || problem.releaseProvenanceHash !== expectation.releaseProvenanceHash
    || problem.minLegs !== template.minLegs
    || problem.maxLegs !== template.maxLegs
    || problem.candidateLimit !== template.candidateLimit
    || problem.edgeReuse !== template.edgeReuse
    || !sameCanonical(problem.constraintSchemaRefs, template.constraintSchemaRefs)
    || !sameCanonical(problem.requiredCapabilityPredicates, requiredCapabilityPredicates)) {
    throw new TypeError("production evidence Strategy qualification expectation mismatch");
  }
}

export function validateProductionResolvedRouteBindingV1(input: Readonly<{
  readonly value: unknown;
  readonly candidate: PlannedRouteCandidateV1;
  readonly problem: StrategyPlanningProblemV1;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>;
  readonly objectiveRef: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly actionOwners: readonly unknown[];
  readonly path: string;
}>): CoarseRouteBindingV1 {
  const raw = record(input.value, input.path);
  assertExactKeys(raw, ["routeHash", "routeBindingHash", "legs"], input.path);
  if (!Array.isArray(raw.legs) || raw.legs.length !== input.candidate.legs.length
    || input.actionOwners.length !== input.candidate.legs.length) {
    throw new TypeError(`${input.path} route/action denominator mismatch`);
  }
  const routeLegs = Object.freeze(raw.legs.map((rawLeg, index) => {
    const legPath = `${input.path}.legs[${index}]`;
    const leg = record(rawLeg, legPath);
    assertExactKeys(leg, ["edgeId", "ownerRef"], legPath);
    const edgeId = hash(leg.edgeId, `${legPath}.edgeId`);
    const ownerRef = hash(leg.ownerRef, `${legPath}.ownerRef`);
    const candidateLeg = input.candidate.legs[index]!;
    const actionOwner = record(input.actionOwners[index], `${input.path}.actionOwners[${index}]`);
    const familyDefinitionHash = hash(actionOwner.familyDefinitionHash, `${input.path}.actionOwners[${index}].familyDefinitionHash`);
    const familyRouteBindingHash = hash(actionOwner.routeBindingHash, `${input.path}.actionOwners[${index}].routeBindingHash`);
    if (edgeId !== candidateLeg.edgeId
      || ownerRef !== familyCoarseRouteOwnerRefV1(familyDefinitionHash, familyRouteBindingHash)) {
      throw new TypeError(`${legPath} does not join the planned leg/action owner`);
    }
    return Object.freeze({ edgeId, ownerRef, familyRouteBindingHash });
  }));
  const routeHash = hash(raw.routeHash, `${input.path}.routeHash`);
  const routeBindingHash = hash(raw.routeBindingHash, `${input.path}.routeBindingHash`);
  const bindingLegs = routeLegs.map(({ edgeId, ownerRef }) => ({ edgeId, ownerRef }));
  if (routeBindingHash !== hashDomain("aloha/route-binding/v1", { legs: bindingLegs })) {
    throw new TypeError(`${input.path}.routeBindingHash mismatch`);
  }
  const expectedRouteHash = hashDomain("aloha/search-runtime-route/v1", {
    candidateId: input.candidate.candidateId,
    legs: input.candidate.legs.map((leg, index) => ({
      edgeId: leg.edgeId,
      inputAssetRef: leg.inputAssetRef,
      inputPortRef: leg.inputPortRef,
      outputAssetRef: leg.outputAssetRef,
      outputPortRef: leg.outputPortRef,
      transitionRef: leg.transitionRef,
      routeBindingHash: routeLegs[index]!.familyRouteBindingHash,
    })),
  });
  if (routeHash !== expectedRouteHash) throw new TypeError(`${input.path}.routeHash mismatch`);
  const ownerRefs = Object.freeze([...new Set(routeLegs.map(leg => leg.ownerRef))].sort());
  return decodeCoarseRouteBindingV1(Object.freeze({
    candidateId: input.candidate.candidateId,
    orderKey: input.candidate.orderKey,
    planningProblemHash: input.problem.problemHash,
    routeHash,
    routeBindingHash,
    dependencySetRef: hashDomain("aloha/coarse-route-dependency-set/v1", bindingLegs),
    ownerRefs,
    generationId: input.generationId,
    graphRoot: input.graphRoot,
    source: input.source,
    objectiveRef: input.objectiveRef,
    releaseProvenanceHash: input.releaseProvenanceHash,
    legs: input.candidate.legs,
  }));
}

export function validateProductionCandidateEvidenceJoinV1(
  entry: Pick<RouteAccountingV1["entries"][number], "terminalKind" | "evidenceHash" | "reasonCode">,
  observation: Pick<ProducerCandidateTerminalObservationV1, "terminalKind" | "evidenceHash" | "terminalLineageHash" | "sixStepEvidenceRoot">,
): void {
  if (entry.terminalKind !== observation.terminalKind) {
    throw new TypeError("production evidence candidate denominator terminal kind splice");
  }
  if (entry.terminalKind === "passed") {
    if (entry.reasonCode !== null
      || entry.evidenceHash !== null
      || observation.evidenceHash === null
      || observation.evidenceHash !== observation.terminalLineageHash
      || observation.sixStepEvidenceRoot === null) {
      throw new TypeError("production evidence passed candidate lineage evidence splice");
    }
    return;
  }
  if (entry.evidenceHash !== observation.evidenceHash
    || observation.terminalLineageHash !== null
    || observation.sixStepEvidenceRoot !== null) {
    throw new TypeError("production evidence non-passed candidate evidence splice");
  }
}

export function validateProductionPassedCandidateSixStepJoinV1(input: Readonly<{
  candidate: Pick<ProducerCandidateTerminalObservationV1,
    "candidateId" | "correlationId" | "generationId" | "graphRoot" | "planningProblemHash" | "enumerationRoot" | "admissionPolicyHash"
    | "routeHash" | "terminalLineageHash" | "sixStepEvidenceRoot">;
  accountingRoot: Hash;
  sixStep: Readonly<{
    candidateId: Hash;
    correlationId: Hash;
    generationId: string;
    graphRoot: Hash;
    planningProblemHash: Hash;
    enumerationRoot: Hash;
    admissionPolicyHash: Hash;
    accountingRoot: Hash;
    routeHash: Hash;
    unsignedDryRunLineageHash: Hash;
    stage36Root: Hash;
  }>;
}>): void {
  const { candidate, sixStep } = input;
  if (candidate.candidateId !== sixStep.candidateId
    || candidate.correlationId !== sixStep.correlationId
    || candidate.generationId !== sixStep.generationId
    || candidate.graphRoot !== sixStep.graphRoot
    || candidate.planningProblemHash !== sixStep.planningProblemHash
    || candidate.enumerationRoot !== sixStep.enumerationRoot
    || candidate.admissionPolicyHash !== sixStep.admissionPolicyHash
    || input.accountingRoot !== sixStep.accountingRoot
    || candidate.routeHash !== sixStep.routeHash
    || candidate.terminalLineageHash !== sixStep.unsignedDryRunLineageHash
    || candidate.sixStepEvidenceRoot !== sixStep.stage36Root) {
    throw new TypeError("production evidence passed candidate Six-Step splice");
  }
}
