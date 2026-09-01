import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  type CanonicalJson,
} from "../../../canonical-codec/src/index.ts";
import type {
  FamilySearchAdapterV1,
  FamilySearchAmountEnvelopeV1,
  FamilySearchCurrentSourceV1,
  FamilySearchExecutionContextV1,
  FamilySearchObjectiveV1,
  FamilySearchRouteLegBindingV1,
  FamilySearchSourceReadPortV1,
} from "../../../family-sdk/search-runtime/index.ts";
import {
  sealCoarseEdgeProjectionV1,
  type CoarseEdgeProjectionV1,
} from "../../../coarse-economics/src/index.ts";

export interface FamilyCoarseProjectionV1 {
  readonly projection: CoarseEdgeProjectionV1;
  readonly stateOutcome: CanonicalJson;
  readonly coarseOutcome: CanonicalJson | null;
}

type CoarseProjectionCommonV1 = Omit<
  CoarseEdgeProjectionV1,
  | "schemaVersion"
  | "kind"
  | "projectionId"
  | "stateFactsRoot"
  | "estimatedOutput"
  | "conservativeOutputUpperBound"
  | "inputCapacityUpperBound"
  | "status"
  | "reasonCode"
>;

function canonicalObservation(value: unknown, path: string): CanonicalJson {
  try {
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
  } catch (error) {
    throw new TypeError(`${path} is not canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The sole Family state -> coarse projection algorithm used by the signed
 * production owner.
 */
export async function projectFamilyCoarseV1(input: {
  readonly adapter: FamilySearchAdapterV1;
  readonly route: FamilySearchRouteLegBindingV1;
  readonly routeBindingHash: `0x${string}`;
  readonly currentSource: FamilySearchCurrentSourceV1;
  readonly sourceRead: FamilySearchSourceReadPortV1;
  readonly objective: FamilySearchObjectiveV1;
  readonly amount: FamilySearchAmountEnvelopeV1;
  readonly execution: FamilySearchExecutionContextV1;
  readonly common: CoarseProjectionCommonV1;
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
  readonly path: string;
}): Promise<FamilyCoarseProjectionV1> {
  const rawStateOutcome = await input.adapter.readState({
    route: input.route,
    currentSource: input.currentSource,
    objective: input.objective,
    amount: input.amount,
    execution: input.execution,
    readPort: input.sourceRead,
    ...(input.deadlineAtMs === undefined ? {} : { deadlineAtMs: input.deadlineAtMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const stateOutcomeSnapshot = canonicalObservation(rawStateOutcome, `${input.path}.stateOutcome`);
  const stateOutcome = stateOutcomeSnapshot as unknown as Awaited<ReturnType<FamilySearchAdapterV1["readState"]>>;
  if (stateOutcome.kind === "invalidProgram") {
    throw new TypeError(`${input.path} state invalid: ${stateOutcome.code}`);
  }
  if (stateOutcome.kind === "unavailable") {
    return deepFreeze({
      projection: sealCoarseEdgeProjectionV1({
        ...input.common,
        stateFactsRoot: stateOutcome.evidenceHash,
        estimatedOutput: null,
        conservativeOutputUpperBound: null,
        inputCapacityUpperBound: null,
        status: "unavailable",
        reasonCode: `state:${stateOutcome.reasonCode}`,
      }),
      stateOutcome: stateOutcomeSnapshot,
      coarseOutcome: null,
    });
  }
  if (stateOutcome.kind !== "verified") throw new TypeError(`${input.path} state outcome kind is invalid`);
  if (stateOutcome.artifact.routeBindingHash !== input.routeBindingHash) {
    throw new TypeError(`${input.path} state route binding mismatch`);
  }
  const rawCoarseOutcome = input.adapter.projectCoarse({
    route: input.route,
    currentSource: input.currentSource,
    objective: input.objective,
    amount: input.amount,
    execution: input.execution,
    state: stateOutcome.artifact,
  });
  const coarseOutcomeSnapshot = canonicalObservation(rawCoarseOutcome, `${input.path}.coarseOutcome`);
  const coarseOutcome = coarseOutcomeSnapshot as unknown as ReturnType<FamilySearchAdapterV1["projectCoarse"]>;
  if (coarseOutcome.kind === "invalidProgram") {
    throw new TypeError(`${input.path} projection invalid: ${coarseOutcome.code}`);
  }
  if (coarseOutcome.kind === "unavailable") {
    return deepFreeze({
      projection: sealCoarseEdgeProjectionV1({
        ...input.common,
        stateFactsRoot: stateOutcome.artifact.factsRoot,
        estimatedOutput: null,
        conservativeOutputUpperBound: null,
        inputCapacityUpperBound: null,
        status: "unavailable",
        reasonCode: `coarse:${coarseOutcome.reasonCode}`,
      }),
      stateOutcome: stateOutcomeSnapshot,
      coarseOutcome: coarseOutcomeSnapshot,
    });
  }
  if (coarseOutcome.kind !== "verified") throw new TypeError(`${input.path} projection outcome kind is invalid`);
  const artifact = coarseOutcome.artifact;
  const source = input.currentSource.source;
  if (artifact.routeBindingHash !== input.routeBindingHash
    || artifact.objectiveRef !== input.objective.objectiveRef
    || artifact.source.chainId !== source.chainId
    || artifact.source.number !== source.number
    || artifact.source.hash !== source.hash
    || artifact.source.stateRoot !== source.stateRoot
    || artifact.input.assetRef !== input.amount.inputAssetRef
    || artifact.input.amount !== input.amount.amountIn) {
    throw new TypeError(`${input.path} artifact binding mismatch`);
  }
  if (artifact.status === "rankable" && artifact.output === null) {
    throw new TypeError(`${input.path} rankable output is missing`);
  }
  return deepFreeze({
    projection: sealCoarseEdgeProjectionV1({
      ...input.common,
      stateFactsRoot: artifact.stateFactsRoot,
      estimatedOutput: artifact.status === "rankable" ? artifact.output : null,
      // The coarse kernel never upgrades a Family estimate into a hard-prune proof.
      conservativeOutputUpperBound: null,
      inputCapacityUpperBound: null,
      status: artifact.status,
      reasonCode: artifact.status === "rankable" ? null : (artifact.reasonCode ?? "coarse-unavailable"),
    }),
    stateOutcome: stateOutcomeSnapshot,
    coarseOutcome: coarseOutcomeSnapshot,
  });
}
