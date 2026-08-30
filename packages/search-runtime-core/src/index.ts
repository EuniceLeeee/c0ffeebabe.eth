import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  composePackedCallPrograms,
  decodePackedCallProgram,
  encodeExecutorExecuteCalldata,
  normalizeEffectTransportDeclaration,
} from "../../execution-program/src/index.ts";
import type { IssuedRouteHandle } from "../../graph/src/index.ts";
import {
  assertGeneratedFamilyRuntimeComposition,
  familyCoarseRouteOwnerRefV1,
  type FamilyRuntimeCompositionV1,
} from "../../family-composition/src/index.ts";
import type { LoopIntentV1 } from "../../strategy-sdk/src/index.ts";
import type {
  FamilySearchAdapterV1,
  FamilySearchAmountEnvelopeV1,
  FamilySearchCoarseArtifactV1,
  FamilySearchCurrentSourceV1,
  FamilySearchExactArtifactV1,
  FamilySearchRouteLegBindingV1,
  FamilySearchSourceReadPortV1,
  FamilySearchStageOutcomeV1,
} from "../../family-sdk/search-runtime/index.ts";
import {
  familySearchAmount,
  familySearchAmountHash,
  familySearchArtifactHash,
  familySearchExecutionContext,
  familySearchObjective,
  familySearchPayloadHash,
  familySearchRouteBindingHash,
  familySearchSource,
  FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1,
  type FamilySearchObjectiveV1,
} from "../../family-sdk/search-runtime/index.ts";
import {
  issueCoarseRouteAssessmentV1,
  readIssuedCoarseRouteBindingV1,
  readQualifiedCoarseProjectionReceiptV1,
  readQualifiedCoarseProjectionV1,
  validateCoarseRouteAssessmentV1,
  type CoarseRouteAssessmentV1,
  type IssuedCoarseRouteAssessmentV1,
  type QualifiedCoarseProjectionV1,
} from "../../coarse-economics/src/index.ts";
import {
  routeBindingHash,
  sealExecutionProgram,
  sealUnsignedDryRunReceipt,
  type CoarseBoundedUnrankedV1,
  type CoarseRankableV1,
  type ExecutionProgramOutcomeV1,
  type ExecutionProgramSixStepEvidenceCapabilityV1,
  type ExecutionProgramSixStepEvidenceV1,
  type ExactOutcomeV1,
  type PlannedRouteV1,
  type RoutePipelinePortsV1,
  type RouteSelectionV1,
  type SearchObjectiveV1,
  type StageFailureV1,
  type UnsignedDryRunInputV1,
} from "../../search-pipeline/src/index.ts";
import type {
  RouteResolutionPortV1,
} from "../../search-pipeline/src/route-pipeline.ts";
import type { AssetReferenceV1 } from "../../asset-ref/src/index.ts";
import { createRouteCoarseAttemptEvidenceOwnerV1 } from "../../search-pipeline/src/internal/coarse-attempt-evidence-owner.ts";

/**
 * Generated production composition resolves the opaque Family capabilities.
 * This package never branches on familyId or protocol identity.
 */
export interface SearchRuntimeCoreInputV1 {
  readonly composition: FamilyRuntimeCompositionV1;
  readonly sourceRead: FamilySearchSourceReadPortV1;
  /** Generic sizing seed. Concrete assets come only from the planned Graph ports. */
  readonly amountSeed: Readonly<{
    readonly amountIn: string;
    readonly recipient: string;
  }>;
  /** Release-bound actors for EVM calls. These roles are deliberately
   * separate: transactionOrigin prices actor-sensitive reads, while the
   * executor receives/settles the compiled action program. */
  readonly execution: Readonly<{
    readonly transactionOrigin: string;
    readonly executorAddress: string;
  }>;
}

/** The only rankable projection admitted by the pipeline is the generic,
 * owner-issued coarse assessment. Family DTOs stay inside their adapter. */
export type SearchRuntimeProjectionV1 = CoarseRouteAssessmentV1;

export interface SearchRuntimePlanV1 {
  readonly kind: "search-runtime-plan-v1";
  readonly routeHash: Hash;
  readonly source: FamilySearchCurrentSourceV1["source"];
  readonly objectiveRef: Hash;
  readonly coarseKind: "rankable" | "bounded-unranked";
  readonly coarseEvidenceHash: Hash;
  readonly planHash: Hash;
}

export interface SearchRuntimeExactV1 {
  readonly kind: "search-runtime-exact-v1";
  readonly routeHash: Hash;
  readonly source: FamilySearchCurrentSourceV1["source"];
  readonly legs: readonly {
    readonly edgeId: Hash;
    readonly amount: FamilySearchAmountEnvelopeV1;
    readonly exact: FamilySearchExactArtifactV1;
  }[];
  readonly exactHash: Hash;
}

const executionProgramSixStepEvidence = new WeakMap<object, ExecutionProgramSixStepEvidenceV1>();

function issueExecutionProgramSixStepEvidence(
  value: Omit<ExecutionProgramSixStepEvidenceV1, "evidenceRoot">,
): ExecutionProgramSixStepEvidenceCapabilityV1 {
  const evidence = deepFreeze({
    ...value,
    evidenceRoot: hashDomain("aloha/execution-program-six-step-evidence/v1", value as unknown as CanonicalJson),
  });
  const capability = Object.freeze(Object.create(null)) as ExecutionProgramSixStepEvidenceCapabilityV1;
  executionProgramSixStepEvidence.set(capability, evidence);
  return capability;
}

function readExecutionProgramSixStepEvidence(
  capability: ExecutionProgramSixStepEvidenceCapabilityV1,
): ExecutionProgramSixStepEvidenceV1 {
  if (capability === null || typeof capability !== "object") throw new TypeError("execution-program six-step evidence capability is required");
  const evidence = executionProgramSixStepEvidence.get(capability);
  if (evidence === undefined) throw new TypeError("execution-program six-step evidence capability was not issued");
  const { evidenceRoot: _evidenceRoot, ...body } = evidence;
  if (evidence.evidenceRoot !== hashDomain("aloha/execution-program-six-step-evidence/v1", body as unknown as CanonicalJson)) {
    throw new TypeError("execution-program six-step evidence identity mismatch");
  }
  return evidence;
}

export type SearchRuntimeCorePortsV1<Simulation = unknown> = Omit<
  RoutePipelinePortsV1<SearchRuntimeProjectionV1, SearchRuntimePlanV1, SearchRuntimeExactV1, Simulation>,
  "finalSimulation" | "economicSafety" | "sixStepArtifacts"
>;

interface ResolvedRouteLegV1 {
  readonly edgeId: Hash;
  readonly familyDefinitionHash: Hash;
  readonly inputAssetRef: Hash;
  readonly inputPortRef: Hash;
  readonly outputAssetRef: Hash;
  readonly outputPortRef: Hash;
  readonly inputAssetReference: AssetReferenceV1;
  readonly outputAssetReference: AssetReferenceV1;
  readonly transitionRef: Hash;
  readonly issuedHandle: IssuedRouteHandle;
  readonly route: FamilySearchRouteLegBindingV1;
  readonly routeBindingHash: Hash;
  readonly adapter: FamilySearchAdapterV1;
}

interface RouteContextV1 {
  readonly routeHash: Hash;
  readonly source?: FamilySearchCurrentSourceV1["source"];
  readonly objective?: FamilySearchObjectiveV1;
  readonly legs: readonly ResolvedRouteLegV1[];
}

const sameSource = (
  left: FamilySearchCurrentSourceV1["source"],
  right: FamilySearchCurrentSourceV1["source"],
): boolean => left.chainId === right.chainId
  && left.number === right.number
  && left.hash === right.hash
  && left.stateRoot === right.stateRoot;

function stageFailure(
  stage: StageFailureV1["stage"],
  outcome: Extract<FamilySearchStageOutcomeV1<unknown>, { readonly kind: "invalidProgram" }>,
): StageFailureV1 {
  return Object.freeze({ kind: "invalidProgram" as const, stage, code: `${stage}:${outcome.code}` });
}

function unavailable(
  stage: StageFailureV1["stage"],
  outcome: Extract<FamilySearchStageOutcomeV1<unknown>, { readonly kind: "unavailable" }>,
): StageFailureV1 {
  return Object.freeze({ kind: "retryable" as const, stage, code: `${stage}:${outcome.reasonCode}` });
}

function routeSource(value: unknown, expected: FamilySearchCurrentSourceV1["source"]): void {
  const observed = familySearchSource(value, "searchRuntime.source");
  if (!sameSource(observed, expected)) throw new TypeError("search-runtime-source-mismatch");
}

function amountMatches(
  artifact: Pick<FamilySearchCoarseArtifactV1, "input" | "output" | "amountHash">,
  amount: FamilySearchAmountEnvelopeV1,
): void {
  if (artifact.amountHash !== familySearchAmountHash(amount)) throw new TypeError("search-runtime-amount-hash-mismatch");
  if (artifact.input.assetRef !== amount.inputAssetRef || artifact.input.amount !== amount.amountIn) {
    throw new TypeError("search-runtime-amount-input-mismatch");
  }
  if (artifact.output === null || artifact.output.assetRef !== amount.outputAssetRef) {
    throw new TypeError("search-runtime-amount-output-mismatch");
  }
  assertDecimalString(artifact.output.amount, "searchRuntime.output.amount");
  if (BigInt(artifact.output.amount) <= 0n) throw new TypeError("search-runtime-output-not-positive");
}

function validateCoarse(
  artifact: FamilySearchCoarseArtifactV1,
  leg: ResolvedRouteLegV1,
  source: FamilySearchCurrentSourceV1["source"],
  objective: FamilySearchObjectiveV1,
  amount: FamilySearchAmountEnvelopeV1,
): void {
  if (artifact.kind !== "coarse" || artifact.status !== "rankable") throw new TypeError("search-runtime-coarse-not-rankable");
  routeSource(artifact.source, source);
  if (artifact.routeBindingHash !== leg.routeBindingHash) throw new TypeError("search-runtime-coarse-route-mismatch");
  if (artifact.objectiveRef !== objective.objectiveRef) throw new TypeError("search-runtime-coarse-objective-mismatch");
  amountMatches(artifact, amount);
  assertHash(artifact.artifactHash, "searchRuntime.coarse.artifactHash");
  assertHash(artifact.projectionHash, "searchRuntime.coarse.projectionHash");
  if (artifact.rankKey === null) throw new TypeError("search-runtime-coarse-rank-missing");
  assertHash(artifact.rankKey, "searchRuntime.coarse.rankKey");
}

function validateExact(
  artifact: FamilySearchExactArtifactV1,
  leg: ResolvedRouteLegV1,
  source: FamilySearchCurrentSourceV1["source"],
  objective: FamilySearchObjectiveV1,
  amount: FamilySearchAmountEnvelopeV1,
): void {
  if (artifact.kind !== "exact" || artifact.status !== "verified") throw new TypeError("search-runtime-exact-not-verified");
  routeSource(artifact.source, source);
  if (artifact.routeBindingHash !== leg.routeBindingHash) throw new TypeError("search-runtime-exact-route-mismatch");
  if (artifact.objectiveRef !== objective.objectiveRef) throw new TypeError("search-runtime-exact-objective-mismatch");
  if (artifact.amountHash !== familySearchAmountHash(amount)) throw new TypeError("search-runtime-exact-amount-mismatch");
  if (artifact.inputs.length === 0 || artifact.inputs[0]!.assetRef !== amount.inputAssetRef || artifact.inputs[0]!.amount !== amount.amountIn) {
    throw new TypeError("search-runtime-exact-input-mismatch");
  }
  if (artifact.outputs.length === 0 || artifact.outputs[artifact.outputs.length - 1]!.assetRef !== amount.outputAssetRef) {
    throw new TypeError("search-runtime-exact-output-mismatch");
  }
  assertHash(artifact.evaluationHash, "searchRuntime.exact.evaluationHash");
  assertHash(artifact.obligationRoot, "searchRuntime.exact.obligationRoot");
}

function validateAction(
  action: import("../../family-sdk/search-runtime/index.ts").FamilySearchActionArtifactV1,
  leg: ResolvedRouteLegV1,
  source: FamilySearchCurrentSourceV1["source"],
  objective: FamilySearchObjectiveV1,
  amount: FamilySearchAmountEnvelopeV1,
  exact: FamilySearchExactArtifactV1,
): void {
  if (action.kind !== "action" || action.status !== "ready") throw new TypeError("search-runtime-action-not-ready");
  routeSource(action.source, source);
  if (action.routeBindingHash !== leg.routeBindingHash) throw new TypeError("search-runtime-action-route-mismatch");
  if (action.objectiveRef !== objective.objectiveRef) throw new TypeError("search-runtime-action-objective-mismatch");
  if (action.amountHash !== familySearchAmountHash(amount)) throw new TypeError("search-runtime-action-amount-mismatch");
  if (action.exactEvaluationHash !== exact.evaluationHash) throw new TypeError("search-runtime-action-exact-mismatch");
  if (action.actionOwnerRef === null) throw new TypeError("search-runtime-action-owner-missing");
  assertHash(action.actionOwnerRef, "searchRuntime.action.actionOwnerRef");
  assertNonEmptyString(action.actionOwnerId, "searchRuntime.action.actionOwnerId");
  assertNonEmptyString(action.opaqueBytes, "searchRuntime.action.opaqueBytes");
  assertHash(action.actionHash, "searchRuntime.action.actionHash");
  assertHash(action.obligationRoot, "searchRuntime.action.obligationRoot");
  if (action.effectTransport !== undefined) normalizeEffectTransportDeclaration(action.effectTransport, "searchRuntime.action.effectTransport");
  if (action.payloadHash !== familySearchPayloadHash(action.kind, action.payload)) {
    throw new TypeError("search-runtime-action-payload-hash-mismatch");
  }
  if (action.artifactHash !== familySearchArtifactHash({
    kind: action.kind,
    source: action.source,
    routeBindingHash: action.routeBindingHash,
    objectiveRef: action.objectiveRef,
    amountHash: action.amountHash,
    payloadHash: action.payloadHash,
  })) {
    throw new TypeError("search-runtime-action-artifact-hash-mismatch");
  }
}

function mergeEffectTransportDeclarations(
  declarations: readonly import("../../execution-program/src/index.ts").EffectTransportDeclarationV1[],
): import("../../execution-program/src/index.ts").EffectTransportDeclarationV1 | undefined {
  if (declarations.length === 0) return undefined;
  const first = declarations[0]!;
  const callerRoot = hashDomain("aloha/effect-transport-caller/v1", first.caller);
  for (const declaration of declarations.slice(1)) {
    if (hashDomain("aloha/effect-transport-caller/v1", declaration.caller) !== callerRoot) {
      throw new TypeError("execution program effect transport caller mismatch");
    }
  }
  const observations = declarations
    .flatMap(declaration => declaration.observeTokenBalances)
    .filter((value, index, values) => values.findIndex(candidate =>
      candidate.token === value.token
      && JSON.stringify(candidate.account) === JSON.stringify(value.account)) === index);
  return normalizeEffectTransportDeclaration({
    caller: first.caller,
    preCalls: declarations.flatMap(declaration => declaration.preCalls),
    observeTokenBalances: observations,
    observeLogs: declarations.some(declaration => declaration.observeLogs),
  }, "searchRuntime.effectTransport");
}

function makeRoutePorts(
  input: SearchRuntimeCoreInputV1,
): Omit<RoutePipelinePortsV1<SearchRuntimeProjectionV1, SearchRuntimePlanV1, SearchRuntimeExactV1, unknown>, "finalSimulation" | "economicSafety" | "sixStepArtifacts"> {
  const contextByRoute = new Map<Hash, RouteContextV1>();
  const adapterByFamily = new Map<Hash, FamilySearchAdapterV1>();
  const coarseAttemptEvidenceOwner = createRouteCoarseAttemptEvidenceOwnerV1();
  assertGeneratedFamilyRuntimeComposition(input.composition);
  assertExactKeys(input.amountSeed, ["amountIn", "recipient"], "searchRuntime.amountSeed");
  assertDecimalString(input.amountSeed.amountIn, "searchRuntime.amountSeed.amountIn");
  assertNonEmptyString(input.amountSeed.recipient, "searchRuntime.amountSeed.recipient");
  const execution = familySearchExecutionContext(input.execution, "searchRuntime.execution");
  if (execution.executorAddress !== input.amountSeed.recipient) {
    throw new TypeError("searchRuntime executor/recipient mismatch");
  }
  const noStageRejectionAuthority = Object.freeze({
    read(): never {
      throw new TypeError("search runtime stage does not issue chain rejection capabilities");
    },
  });

  const route: RouteResolutionPortV1 = {
    resolve: ({ candidate, selections }) => {
      const legs: ResolvedRouteLegV1[] = selections.map((selection: RouteSelectionV1) => {
        const familyDefinitionHash = selection.ownerDefinitionRef;
        const routeBinding = input.composition.resolveRouteHandle(selection.issuedHandle, familyDefinitionHash);
        const normalizedRoute = familySearchRouteBindingHash(routeBinding);
        let adapter = adapterByFamily.get(familyDefinitionHash);
        if (adapter === undefined) {
          adapter = input.composition.requireAdapter(familyDefinitionHash, FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1);
          if (adapter === null || typeof adapter !== "object") throw new TypeError("generated-search-adapter-missing");
          adapterByFamily.set(familyDefinitionHash, adapter);
        }
        const inputAssetRef = assertHash(selection.inputAssetPort.assetRef, "route.inputAssetPort.assetRef");
        const inputPortRef = assertHash(selection.inputAssetPort.portRef, "route.inputAssetPort.portRef");
        const outputAssetRef = assertHash(selection.outputAssetPort.assetRef, "route.outputAssetPort.assetRef");
        const outputPortRef = assertHash(selection.outputAssetPort.portRef, "route.outputAssetPort.portRef");
        const transitionRef = assertHash(selection.opaqueTransitionRef, "route.opaqueTransitionRef");
        return Object.freeze({
          edgeId: selection.edgeId,
          familyDefinitionHash,
          inputAssetRef,
          inputPortRef,
          outputAssetRef,
          outputPortRef,
          inputAssetReference: Object.freeze({ identity: selection.inputAssetPort.assetIdentity, assetRef: inputAssetRef }),
          outputAssetReference: Object.freeze({ identity: selection.outputAssetPort.assetIdentity, assetRef: outputAssetRef }),
          transitionRef,
          issuedHandle: selection.issuedHandle,
          route: routeBinding,
          routeBindingHash: normalizedRoute,
          adapter,
        });
      });
      const routeHash = hashDomain("aloha/search-runtime-route/v1", {
        candidateId: candidate.candidateId,
        legs: legs.map(leg => ({
          edgeId: leg.edgeId,
          inputAssetRef: leg.inputAssetRef,
          inputPortRef: leg.inputPortRef,
          outputAssetRef: leg.outputAssetRef,
          outputPortRef: leg.outputPortRef,
          transitionRef: leg.transitionRef,
          routeBindingHash: leg.routeBindingHash,
        })),
      });
      const routeLegs = legs.map(leg => ({
        edgeId: leg.edgeId,
        ownerRef: familyCoarseRouteOwnerRefV1(leg.familyDefinitionHash, leg.routeBindingHash),
        issuedHandle: leg.issuedHandle,
      }));
      const context: RouteContextV1 = {
        routeHash,
        legs,
      };
      // Source/objective are filled by coarse on the first immutable read;
      // route resolution itself has no source shortcut.
      contextByRoute.set(routeHash, context);
      return Object.freeze({ routeHash, legs: Object.freeze(routeLegs), routeBindingHash: routeBindingHash(routeLegs) });
    },
  };

  const coarse = {
    assess: async (request: Parameters<RoutePipelinePortsV1<SearchRuntimeProjectionV1, SearchRuntimePlanV1, SearchRuntimeExactV1, unknown>["coarse"]["assess"]>[0]): Promise<IssuedCoarseRouteAssessmentV1 | null> => {
      const binding = readIssuedCoarseRouteBindingV1(request.binding);
      coarseAttemptEvidenceOwner.start(request.binding);
      const routeContext = contextByRoute.get(binding.routeHash);
      if (routeContext === undefined || routeContext.legs.length !== binding.legs.length) return null;
      const source = familySearchSource(request.currentSource.source);
      const objective = familySearchObjective(request.objective);
      if (!sameSource(source, binding.source) || objective.objectiveRef !== binding.objectiveRef) return null;
      const firstLeg = routeContext.legs[0];
      if (firstLeg === undefined) return null;
      contextByRoute.set(binding.routeHash, { ...routeContext, source, objective });
      let amount = familySearchAmount({
        inputAssetRef: firstLeg.inputAssetRef,
        outputAssetRef: firstLeg.outputAssetRef,
        amountIn: input.amountSeed.amountIn,
        recipient: input.amountSeed.recipient,
      });
      const projections: QualifiedCoarseProjectionV1[] = [];
      await request.currentSource.assertCurrent();
      try {
        for (const [index, leg] of routeContext.legs.entries()) {
          const boundLeg = binding.legs[index];
          if (boundLeg === undefined
            || boundLeg.edgeId !== leg.edgeId
            || boundLeg.transitionRef !== leg.transitionRef
            || boundLeg.inputAssetRef !== leg.inputAssetRef
            || boundLeg.outputAssetRef !== leg.outputAssetRef
            || amount.inputAssetRef !== leg.inputAssetRef
            || amount.outputAssetRef !== leg.outputAssetRef) return null;
          const seam = input.composition.resolveCoarseProjection(leg.familyDefinitionHash);
          if (seam === null) return null;
          const capability = await input.composition.issueCoarseProjection(seam.producer, {
            binding: request.binding,
            legIndex: index,
            issuedHandle: leg.issuedHandle,
            currentSource: request.currentSource,
            sourceRead: input.sourceRead,
            objective,
            amount,
            execution,
            deadlineAtMs: request.deadlineAtMs,
            signal: request.signal,
          });
          const familyObservation = input.composition.readCoarseProjectionObservation(seam.producer, capability);
          const qualified = readQualifiedCoarseProjectionV1({ service: seam.service, capability });
          coarseAttemptEvidenceOwner.observe(
            request.binding,
            qualified,
            familyObservation as unknown as CanonicalJson,
          );
          const receipt = readQualifiedCoarseProjectionReceiptV1(qualified);
          const projection = receipt.projection;
          if (projection.edgeId !== leg.edgeId
            || projection.transitionRef !== leg.transitionRef
            || projection.routeBindingHash !== binding.routeBindingHash
            || projection.objectiveRef !== objective.objectiveRef
            || !sameSource(projection.source, source)
            || projection.status !== "rankable"
            || projection.estimatedOutput === null) return null;
          const expectedOutput = routeContext.legs[index + 1]?.inputAssetRef ?? firstLeg.inputAssetRef;
          if (projection.sampleInput.assetRef !== amount.inputAssetRef
            || projection.sampleInput.amount !== amount.amountIn
            || projection.estimatedOutput.assetRef !== expectedOutput) return null;
          projections.push(qualified);
          if (index < routeContext.legs.length - 1) {
            amount = familySearchAmount({
              inputAssetRef: projection.estimatedOutput.assetRef,
              outputAssetRef: routeContext.legs[index + 1]!.outputAssetRef,
              amountIn: projection.estimatedOutput.amount,
              recipient: amount.recipient,
            });
          }
        }
        return issueCoarseRouteAssessmentV1({ binding: request.binding, projections });
      } finally {
        await request.currentSource.assertCurrent();
      }
    },
    attemptEvidenceAuthority: coarseAttemptEvidenceOwner.authority,
  };

  const planner = {
    rejectionAuthority: noStageRejectionAuthority,
    plan: ({ route, coarse: inputCoarse, objective }: { readonly route: import("../../search-pipeline/src/index.ts").RouteCapabilityV1; readonly coarse: CoarseRankableV1<SearchRuntimeProjectionV1> | CoarseBoundedUnrankedV1; readonly strategy: LoopIntentV1; readonly objective: SearchObjectiveV1; readonly binding: import("../../graph/src/index.ts").GraphLeaseBindingV1; readonly correlationId: Hash }): PlannedRouteV1<SearchRuntimePlanV1> | StageFailureV1 => {
      try {
        const routeContext = contextByRoute.get(route.routeHash);
        const normalizedObjective = familySearchObjective(objective);
        const coarseSource = familySearchSource(inputCoarse.source, "searchRuntime.planner.coarse.source");
        if (routeContext === undefined || routeContext.source === undefined || routeContext.objective === undefined
          || routeContext.objective.objectiveRef !== normalizedObjective.objectiveRef
          || inputCoarse.routeHash !== route.routeHash
          || !sameSource(coarseSource, routeContext.source)) {
          return Object.freeze({ kind: "invalidProgram", stage: "planner", code: "route-coarse-binding-missing" });
        }
        if (inputCoarse.kind === "rankable") {
          validateCoarseRouteAssessmentV1(inputCoarse.projection);
          if (inputCoarse.projection.routeHash !== route.routeHash
            || inputCoarse.projection.objectiveRef !== normalizedObjective.objectiveRef
            || !sameSource(inputCoarse.projection.source, routeContext.source)
            || inputCoarse.projection.assessmentId !== inputCoarse.projectionHash) {
            return Object.freeze({ kind: "invalidProgram", stage: "planner", code: "rankable-coarse-assessment-mismatch" });
          }
        }
        const coarseEvidenceHash = inputCoarse.kind === "rankable" ? inputCoarse.projectionHash : inputCoarse.evidenceHash;
        const planBody = {
          kind: "search-runtime-plan-v1" as const,
          routeHash: route.routeHash,
          source: routeContext.source,
          objectiveRef: normalizedObjective.objectiveRef,
          coarseKind: inputCoarse.kind,
          coarseEvidenceHash,
        };
        const plan = deepFreeze({ ...planBody, planHash: hashDomain("aloha/search-runtime-plan/v1", planBody) });
        return Object.freeze({ kind: "planned" as const, routeHash: route.routeHash, source: routeContext.source, plan, planHash: plan.planHash });
      } catch (error) {
        return Object.freeze({ kind: "invalidProgram", stage: "planner", code: error instanceof Error ? error.message : "planner-error" });
      }
    },
  };

  const exact = {
    rejectionAuthority: noStageRejectionAuthority,
    evaluate: async ({ plan, planHash, route, source: currentSource, deadlineAtMs, signal }: { readonly plan: SearchRuntimePlanV1; readonly planHash: Hash; readonly route: import("../../search-pipeline/src/index.ts").RouteCapabilityV1; readonly source: import("../../search-pipeline/src/index.ts").CurrentSourceSessionV1; readonly deadlineAtMs: number; readonly signal?: AbortSignal }): Promise<ExactOutcomeV1<SearchRuntimeExactV1>> => {
      const context = contextByRoute.get(route.routeHash);
      const { planHash: embeddedPlanHash, ...planBody } = plan;
      if (context === undefined || context.source === undefined || context.objective === undefined
        || plan.routeHash !== route.routeHash
        || plan.objectiveRef !== context.objective.objectiveRef
        || embeddedPlanHash !== planHash
        || hashDomain("aloha/search-runtime-plan/v1", planBody) !== planHash) {
        return Object.freeze({ kind: "invalidProgram", stage: "exact", code: "exact-plan-missing" });
      }
      try {
        const source = familySearchSource(currentSource.source);
        if (!sameSource(source, context.source)) throw new TypeError("search-runtime-exact-source-mismatch");
        await currentSource.assertCurrent();
        const exactLegs: Array<SearchRuntimeExactV1["legs"][number]> = [];
        const firstLeg = context.legs[0];
        if (firstLeg === undefined) throw new TypeError("search-runtime-exact-route-empty");
        let amount = familySearchAmount({
          inputAssetRef: firstLeg.inputAssetRef,
          outputAssetRef: firstLeg.outputAssetRef,
          amountIn: input.amountSeed.amountIn,
          recipient: input.amountSeed.recipient,
        });
        for (const [index, resolvedLeg] of context.legs.entries()) {
          if (resolvedLeg.inputAssetRef !== amount.inputAssetRef || resolvedLeg.outputAssetRef !== amount.outputAssetRef) {
            throw new TypeError("search-runtime-exact-asset-schedule-mismatch");
          }
          const stateOutcome = await resolvedLeg.adapter.readState({
            route: resolvedLeg.route,
            currentSource: currentSource as FamilySearchCurrentSourceV1,
            objective: context.objective,
            amount,
            execution,
            readPort: input.sourceRead,
            signal,
            deadlineAtMs,
          });
          if (stateOutcome.kind === "unavailable") return unavailable("exact", stateOutcome) as ExactOutcomeV1<SearchRuntimeExactV1>;
          if (stateOutcome.kind === "invalidProgram") return stageFailure("exact", stateOutcome) as ExactOutcomeV1<SearchRuntimeExactV1>;
          routeSource(stateOutcome.artifact.source, source);
          if (stateOutcome.artifact.routeBindingHash !== resolvedLeg.routeBindingHash) throw new TypeError("search-runtime-state-route-mismatch");
          const coarseOutcome = resolvedLeg.adapter.projectCoarse({
            route: resolvedLeg.route,
            currentSource: currentSource as FamilySearchCurrentSourceV1,
            objective: context.objective,
            amount,
            execution,
            state: stateOutcome.artifact,
          });
          if (coarseOutcome.kind === "unavailable") return unavailable("exact", coarseOutcome) as ExactOutcomeV1<SearchRuntimeExactV1>;
          if (coarseOutcome.kind === "invalidProgram") return stageFailure("exact", coarseOutcome) as ExactOutcomeV1<SearchRuntimeExactV1>;
          validateCoarse(coarseOutcome.artifact, resolvedLeg, source, context.objective, amount);
          const outcome = await resolvedLeg.adapter.evaluateExact({
            route: resolvedLeg.route,
            currentSource: currentSource as FamilySearchCurrentSourceV1,
            objective: context.objective,
            amount,
            execution,
            state: stateOutcome.artifact,
            coarse: coarseOutcome.artifact,
          });
          if (outcome.kind === "unavailable") return unavailable("exact", outcome) as ExactOutcomeV1<SearchRuntimeExactV1>;
          if (outcome.kind === "invalidProgram") return stageFailure("exact", outcome) as ExactOutcomeV1<SearchRuntimeExactV1>;
          validateExact(outcome.artifact, resolvedLeg, source, context.objective, amount);
          const terminalOutput = outcome.artifact.outputs[outcome.artifact.outputs.length - 1];
          if (terminalOutput === undefined) throw new TypeError("search-runtime-exact-output-missing");
          if (terminalOutput.assetRef !== resolvedLeg.outputAssetRef) throw new TypeError("search-runtime-exact-route-output-mismatch");
          exactLegs.push(Object.freeze({ edgeId: resolvedLeg.edgeId, amount, exact: outcome.artifact }));
          const nextLeg = context.legs[index + 1];
          if (nextLeg === undefined) {
            if (terminalOutput.assetRef !== firstLeg.inputAssetRef) throw new TypeError("search-runtime-exact-loop-output-mismatch");
            continue;
          }
          if (terminalOutput.assetRef !== nextLeg.inputAssetRef) throw new TypeError("search-runtime-exact-next-input-asset-mismatch");
          amount = familySearchAmount({
            inputAssetRef: terminalOutput.assetRef,
            outputAssetRef: nextLeg.outputAssetRef,
            amountIn: terminalOutput.amount,
            recipient: amount.recipient,
          });
        }
        const body = { kind: "search-runtime-exact-v1" as const, routeHash: route.routeHash, source, legs: exactLegs };
        const result = deepFreeze({ ...body, exactHash: hashDomain("aloha/search-runtime-exact/v1", body) });
        contextByRoute.set(route.routeHash, { ...context, source });
        return Object.freeze({ kind: "verified" as const, routeHash: route.routeHash, source, exact: result, exactHash: result.exactHash });
      } catch (error) {
        return Object.freeze({ kind: "invalidProgram", stage: "exact", code: error instanceof Error ? error.message : "exact-error" });
      } finally {
        await currentSource.assertCurrent();
      }
    },
  };

  const executionProgram = {
    rejectionAuthority: noStageRejectionAuthority,
    compile: async ({ binding, plan, planHash, exact: exactValue, exactHash, route, source: currentSource, correlationId }: { readonly binding: import("../../graph/src/index.ts").GraphLeaseBindingV1; readonly plan: SearchRuntimePlanV1; readonly planHash: Hash; readonly exact: SearchRuntimeExactV1; readonly exactHash: Hash; readonly route: import("../../search-pipeline/src/index.ts").RouteCapabilityV1; readonly source: import("../../search-pipeline/src/index.ts").CurrentSourceSessionV1; readonly correlationId: Hash; readonly deadlineAtMs: number }): Promise<ExecutionProgramOutcomeV1> => {
      const context = contextByRoute.get(route.routeHash);
      const { planHash: embeddedPlanHash, ...planBody } = plan;
      const { exactHash: embeddedExactHash, ...exactBody } = exactValue;
      if (context === undefined || context.source === undefined || context.objective === undefined
        || plan.routeHash !== route.routeHash
        || plan.objectiveRef !== context.objective.objectiveRef
        || embeddedPlanHash !== planHash
        || hashDomain("aloha/search-runtime-plan/v1", planBody) !== planHash
        || exactValue.routeHash !== route.routeHash
        || embeddedExactHash !== exactHash
        || hashDomain("aloha/search-runtime-exact/v1", exactBody) !== exactHash) return Object.freeze({ kind: "invalidProgram", stage: "execution-program", code: "execution-input-missing" });
      try {
        const source = familySearchSource(currentSource.source);
        const actions = [];
        for (const leg of exactValue.legs) {
          const resolved = context.legs.find(item => item.edgeId === leg.edgeId);
          if (resolved === undefined) throw new TypeError("execution-route-leg-missing");
          const outcome = await resolved.adapter.buildAction({ route: resolved.route, currentSource: currentSource as FamilySearchCurrentSourceV1, objective: context.objective, amount: leg.amount, execution, exact: leg.exact });
          if (outcome.kind === "unavailable") return unavailable("execution-program", outcome) as ExecutionProgramOutcomeV1;
          if (outcome.kind === "invalidProgram") return stageFailure("execution-program", outcome) as ExecutionProgramOutcomeV1;
          validateAction(outcome.artifact, resolved, source, context.objective, leg.amount, leg.exact);
          const actionEffectTransport = outcome.artifact.effectTransport === undefined
            ? undefined
            : normalizeEffectTransportDeclaration(outcome.artifact.effectTransport, "searchRuntime.action.effectTransport");
          actions.push({
            artifact: outcome.artifact,
            familyDefinitionHash: resolved.familyDefinitionHash,
            routeBindingHash: resolved.routeBindingHash,
            actionOwnerRef: assertHash(outcome.artifact.actionOwnerRef, "searchRuntime.action.actionOwnerRef"),
            actionOwnerId: outcome.artifact.actionOwnerId,
            actionHash: outcome.artifact.actionHash,
            actionArtifactHash: outcome.artifact.artifactHash,
            exactEvaluationHash: outcome.artifact.exactEvaluationHash,
            payload: outcome.artifact.payload,
            payloadHash: outcome.artifact.payloadHash,
            inputs: outcome.artifact.inputs,
            outputs: outcome.artifact.outputs,
            opaqueBytes: outcome.artifact.opaqueBytes,
            obligationRoot: outcome.artifact.obligationRoot,
            ...(actionEffectTransport === undefined ? {} : { effectTransport: actionEffectTransport }),
          });
        }
        const packedProgram = composePackedCallPrograms(actions.map(action => action.opaqueBytes));
        const programBytes = encodeExecutorExecuteCalldata(packedProgram);
        const actionLineage = actions.map(({ opaqueBytes: _opaqueBytes, artifact: _artifact, ...lineage }) => lineage);
        const actionPayload = {
          kind: "aloha.search-runtime.ordered-action-program-v1",
          routeHash: route.routeHash,
          source,
          actions: actionLineage,
          executeCalldataHash: hashDomain("aloha/search-runtime-execute-calldata/v1", programBytes),
        };
        const effectTransport = mergeEffectTransportDeclarations(actions.flatMap(action => action.effectTransport === undefined ? [] : [action.effectTransport]));
        const program = sealExecutionProgram({
          kind: "execution-program",
          generationId: binding.generationId,
          source,
          routeHash: route.routeHash,
          programBytes,
          payloadHash: hashDomain("aloha/search-runtime-action-payload/v1", actionPayload),
          issuerRef: hashDomain("aloha/search-runtime-action-issuer/v1", actions.map(action => action.actionOwnerRef)),
          obligationRoot: hashDomain("aloha/search-runtime-obligation-root/v1", actions.map(action => action.obligationRoot)),
          ...(effectTransport === undefined ? {} : { effectTransport }),
        });
        const facts = deepFreeze({
          kind: "aloha.search-runtime.execution-program-owner-facts-v1",
          callerMode: effectTransport?.caller.executionMode ?? "top-level",
          preCalls: effectTransport?.preCalls ?? Object.freeze([]),
          observationPairs: effectTransport?.observeTokenBalances ?? Object.freeze([]),
          observeLogs: effectTransport?.observeLogs ?? false,
          callSequence: decodePackedCallProgram(packedProgram),
          routeAssetReferences: [...new Map(context.legs.flatMap(leg => [
            leg.inputAssetReference,
            leg.outputAssetReference,
          ]).map(reference => [reference.assetRef, reference] as const)).values()]
            .sort((left, right) => left.assetRef.localeCompare(right.assetRef)),
          actionOwners: actions.map(({ opaqueBytes: _opaqueBytes, effectTransport: _effectTransport, artifact: _artifact, ...action }) => action),
          declaredObligations: actions.map(action => ({
            obligationRef: action.obligationRoot,
            ownerRef: action.actionOwnerRef,
            policy: "must-satisfy" as const,
          })),
          obligationRoot: program.obligationRoot,
        }) as unknown as CanonicalJson;
        const ownerObservation = deepFreeze({
          kind: "aloha.search-runtime.execution-program-owner-observation-v1",
          actionArtifacts: actions.map(action => action.artifact),
          effectTransport: effectTransport ?? null,
        }) as unknown as CanonicalJson;
        const sixStepEvidence = issueExecutionProgramSixStepEvidence({
          schemaVersion: 1,
          kind: "aloha.execution-program-six-step-evidence-v1",
          correlationId,
          generationId: binding.generationId,
          source,
          routeHash: route.routeHash,
          exactHash,
          programHash: program.programHash,
          facts,
          ownerObservation,
        });
        return Object.freeze({ kind: "compiled" as const, program, sixStepEvidence });
      } catch (error) {
        return Object.freeze({ kind: "invalidProgram", stage: "execution-program", code: error instanceof Error ? error.message : "execution-program-error" });
      }
    },
  };

  const unsignedDryRun = {
    issue: (value: UnsignedDryRunInputV1<SearchRuntimeProjectionV1, SearchRuntimePlanV1, SearchRuntimeExactV1, unknown>) => sealUnsignedDryRunReceipt(value),
  };

  return {
    route,
    coarse,
    planner,
    exact,
    executionProgram: Object.freeze({
      ...executionProgram,
      sixStepEvidenceAuthority: Object.freeze({ read: readExecutionProgramSixStepEvidence }),
    }),
    unsignedDryRun,
  };

}

/**
 * Build the generated, protocol-neutral search ports.  Final simulation is
 * deliberately not constructed here: the qualified @aloha/final-sim bridge
 * remains an independent production input and is attached by the app entry.
 */
export function createGeneratedSearchRuntimePorts(
  input: SearchRuntimeCoreInputV1,
): SearchRuntimeCorePortsV1<unknown> {
  if (input === null || typeof input !== "object") throw new TypeError("search-runtime-core input is required");
  return makeRoutePorts(input);
}
