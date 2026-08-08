import { hashCanonical, type CanonicalValue } from "./venues/canonical-value.js";

export type ArchitectureMigrationMode =
  | "pure-refactor"
  | "declared-improvement";

export type ArchitectureMigrationScope =
  | {
      readonly kind: "single-family";
      readonly familyIds: readonly [string];
      readonly reason: "targeted-follow-up" | "isolated-family-change";
    }
  | {
      readonly kind: "batch";
      readonly familyIds: readonly string[];
    };

export interface ArchitectureStateAnchor {
  readonly number: number;
  readonly hash: string;
  readonly stateRoot: string;
}

export interface CanonicalSemanticItem {
  readonly id: string;
  readonly semanticHash: string;
}

export interface CanonicalFamilySemanticOutput {
  readonly familyId: string;
  readonly implementationClosureHash: string;
  readonly exercisedCaseIds: readonly string[];
  readonly frameworkBlocker: string | null;
  readonly instances: readonly CanonicalSemanticItem[];
  readonly edges: readonly CanonicalSemanticItem[];
  readonly stateCoverage: readonly CanonicalSemanticItem[];
  readonly pricedEdges: readonly CanonicalSemanticItem[];
  readonly prices: readonly CanonicalSemanticItem[];
  readonly failures: readonly CanonicalSemanticItem[];
  readonly enumeratedRoutes: readonly CanonicalSemanticItem[];
  readonly exactQuotes: readonly CanonicalSemanticItem[];
  readonly executionFragments: readonly CanonicalSemanticItem[];
  readonly finalSimulations: readonly CanonicalSemanticItem[];
  readonly evidenceRefs: readonly string[];
}

export interface DeclaredSemanticDelta {
  readonly familyId: string;
  readonly kind:
    | "verified-addition"
    | "canonical-deduplication"
    | "semantic-correction"
    | "approved-deactivation";
  readonly affectedCanonicalIds: readonly string[];
  readonly independentEvidenceRefs: readonly string[];
}

export type FamilyArchitectureParityOutcome =
  | "pass"
  | "semantic-mismatch"
  | "not-exercised"
  | "framework-blocked";

export interface PriceParityMismatch {
  readonly id: string;
  readonly baselineHash: string | null;
  readonly challengerHash: string | null;
}

export interface RouteParityMismatch extends PriceParityMismatch {}
export interface ExactParityMismatch extends PriceParityMismatch {}

export interface FamilyArchitectureParityResult {
  readonly familyId: string;
  readonly implementationClosureHash: string;
  readonly missingInstances: readonly string[];
  readonly addedInstances: readonly string[];
  readonly changedInstances: readonly string[];
  readonly missingEdges: readonly string[];
  readonly addedEdges: readonly string[];
  readonly changedEdgeMetadata: readonly string[];
  readonly lostStateKeys: readonly string[];
  readonly addedStateKeys: readonly string[];
  readonly changedStateCoverage: readonly string[];
  readonly newlyUnresolvedStateKeys: readonly string[];
  readonly missingPricedEdges: readonly string[];
  readonly addedPricedEdges: readonly string[];
  readonly changedPrices: readonly PriceParityMismatch[];
  readonly changedFailures: readonly PriceParityMismatch[];
  readonly changedRoutes: readonly RouteParityMismatch[];
  readonly changedExactQuotes: readonly ExactParityMismatch[];
  readonly changedExecutionFragments: readonly RouteParityMismatch[];
  readonly changedFinalSimulations: readonly RouteParityMismatch[];
  readonly unprovenAddedArtifacts: readonly string[];
  readonly undeclaredDeltaIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly outcome: FamilyArchitectureParityOutcome;
}

export interface ArchitectureMigrationParityReceipt {
  readonly scope: ArchitectureMigrationScope;
  readonly mode: ArchitectureMigrationMode;
  readonly inputManifestHash: string;
  readonly stateAnchors: readonly ArchitectureStateAnchor[];
  readonly familyResults: readonly FamilyArchitectureParityResult[];
  readonly familyResultMatrixHash: string;
  readonly nonPassFamilyIds: readonly string[];
  readonly nonMigratedFamilySemanticHashParity: boolean;
  readonly assembledCommonGraphParity: boolean;
  readonly aggregateVerdict: "pass" | "partial" | "fail";
  readonly performanceDiagnostics: {
    readonly wallMs: number;
    readonly requestCount: number;
    readonly batchCount: number;
    readonly peakConcurrency: number;
  };
}

export function judgeArchitectureMigration(input: {
  readonly scope: ArchitectureMigrationScope;
  readonly mode: ArchitectureMigrationMode;
  readonly inputManifestHash: string;
  readonly stateAnchors: readonly ArchitectureStateAnchor[];
  readonly baseline: readonly CanonicalFamilySemanticOutput[];
  readonly challenger: readonly CanonicalFamilySemanticOutput[];
  readonly declaredDeltas?: readonly DeclaredSemanticDelta[];
  readonly nonMigratedFamilySemanticHashParity: boolean;
  readonly assembledCommonGraphParity: boolean;
  readonly performanceDiagnostics: {
    readonly wallMs: number;
    readonly requestCount: number;
    readonly batchCount: number;
    readonly peakConcurrency: number;
  };
}): ArchitectureMigrationParityReceipt {
  const familyIds = validateScope(input.scope);
  assertSha256(input.inputManifestHash, "inputManifestHash");
  validateAnchors(input.stateAnchors);
  validatePerformance(input.performanceDiagnostics);
  const baseline = indexOutputs(input.baseline, "baseline");
  const challenger = indexOutputs(input.challenger, "challenger");
  const declared = indexDeclaredDeltas(
    input.mode,
    familyIds,
    input.declaredDeltas ?? [],
  );
  for (const outputFamilyId of [...baseline.keys(), ...challenger.keys()]) {
    if (!familyIds.has(outputFamilyId)) {
      throw new Error(
        `migration output contains undeclared Family ${outputFamilyId}`,
      );
    }
  }

  const familyResults = Object.freeze([...familyIds].sort().map((familyId) =>
    compareFamily({
      familyId,
      baseline: baseline.get(familyId),
      challenger: challenger.get(familyId),
      mode: input.mode,
      declaredIds: declared.get(familyId) ?? new Set(),
    })
  ));
  const nonPassFamilyIds = Object.freeze(
    familyResults
      .filter((result) => result.outcome !== "pass")
      .map((result) => result.familyId),
  );
  const semanticMismatch = familyResults.some((result) =>
    result.outcome === "semantic-mismatch"
  );
  const sharedGateFailed =
    !input.nonMigratedFamilySemanticHashParity ||
    !input.assembledCommonGraphParity;
  const aggregateVerdict = nonPassFamilyIds.length === 0 && !sharedGateFailed
    ? "pass"
    : semanticMismatch || sharedGateFailed
      ? "fail"
      : "partial";
  const matrixProjection = familyResults.map(resultProjection);
  return deepFreeze({
    scope: input.scope,
    mode: input.mode,
    inputManifestHash: input.inputManifestHash,
    stateAnchors: input.stateAnchors,
    familyResults,
    familyResultMatrixHash: hashCanonical(matrixProjection),
    nonPassFamilyIds,
    nonMigratedFamilySemanticHashParity:
      input.nonMigratedFamilySemanticHashParity,
    assembledCommonGraphParity: input.assembledCommonGraphParity,
    aggregateVerdict,
    performanceDiagnostics: input.performanceDiagnostics,
  });
}

function compareFamily(input: {
  readonly familyId: string;
  readonly baseline?: CanonicalFamilySemanticOutput;
  readonly challenger?: CanonicalFamilySemanticOutput;
  readonly mode: ArchitectureMigrationMode;
  readonly declaredIds: ReadonlySet<string>;
}): FamilyArchitectureParityResult {
  const baseline = input.baseline;
  const challenger = input.challenger;
  const evidenceRefs = Object.freeze([...new Set([
    ...(baseline?.evidenceRefs ?? []),
    ...(challenger?.evidenceRefs ?? []),
  ])].sort());
  if (
    baseline === undefined ||
    challenger === undefined ||
    baseline.exercisedCaseIds.length === 0 ||
    challenger.exercisedCaseIds.length === 0
  ) {
    return emptyFamilyResult({
      familyId: input.familyId,
      implementationClosureHash:
        challenger?.implementationClosureHash ?? "",
      evidenceRefs,
      outcome: "not-exercised",
    });
  }
  if (baseline.frameworkBlocker !== null || challenger.frameworkBlocker !== null) {
    return emptyFamilyResult({
      familyId: input.familyId,
      implementationClosureHash: challenger.implementationClosureHash,
      evidenceRefs,
      outcome: "framework-blocked",
    });
  }
  assertSameCaseSet(baseline, challenger);

  const instances = compareSet(baseline.instances, challenger.instances);
  const edges = compareSet(baseline.edges, challenger.edges);
  const state = compareSet(baseline.stateCoverage, challenger.stateCoverage);
  const priced = compareSet(baseline.pricedEdges, challenger.pricedEdges);
  const prices = compareSet(baseline.prices, challenger.prices);
  const failures = compareSet(baseline.failures, challenger.failures);
  const routes = compareSet(
    baseline.enumeratedRoutes,
    challenger.enumeratedRoutes,
  );
  const exact = compareSet(baseline.exactQuotes, challenger.exactQuotes);
  const execution = compareSet(
    baseline.executionFragments,
    challenger.executionFragments,
  );
  const finalSim = compareSet(
    baseline.finalSimulations,
    challenger.finalSimulations,
  );
  const changedIds = new Set<string>([
    ...instances.allDeltaIds,
    ...edges.allDeltaIds,
    ...state.allDeltaIds,
    ...priced.allDeltaIds,
    ...prices.allDeltaIds,
    ...failures.allDeltaIds,
    ...routes.allDeltaIds,
    ...exact.allDeltaIds,
    ...execution.allDeltaIds,
    ...finalSim.allDeltaIds,
  ]);
  const undeclaredDeltaIds = Object.freeze(
    [...changedIds]
      .filter((id) => !input.declaredIds.has(id))
      .sort(),
  );
  const unprovenAddedArtifacts = Object.freeze([
    ...new Set([
      ...instances.added,
      ...edges.added,
      ...state.added,
      ...priced.added,
      ...prices.added,
      ...failures.added,
      ...routes.added,
      ...exact.added,
      ...execution.added,
      ...finalSim.added,
    ].filter((id) => !input.declaredIds.has(id))),
  ].sort());
  const forbiddenLosses = new Set<string>([
    ...instances.missing,
    ...edges.missing,
    ...state.missing,
    ...priced.missing,
  ]);
  const pureMatch = changedIds.size === 0;
  const declaredImprovementPass =
    input.mode === "declared-improvement" &&
    undeclaredDeltaIds.length === 0 &&
    forbiddenLosses.size === 0;
  const outcome = pureMatch || declaredImprovementPass
    ? "pass"
    : "semantic-mismatch";

  return deepFreeze({
    familyId: input.familyId,
    implementationClosureHash: challenger.implementationClosureHash,
    missingInstances: instances.missing,
    addedInstances: instances.added,
    changedInstances: instances.changed.map((item) => item.id),
    missingEdges: edges.missing,
    addedEdges: edges.added,
    changedEdgeMetadata: edges.changed.map((item) => item.id),
    lostStateKeys: state.missing,
    addedStateKeys: state.added,
    changedStateCoverage: state.changed.map((item) => item.id),
    newlyUnresolvedStateKeys: failures.added,
    missingPricedEdges: priced.missing,
    addedPricedEdges: priced.added,
    changedPrices: prices.changed,
    changedFailures: failures.changed,
    changedRoutes: routes.changed,
    changedExactQuotes: exact.changed,
    changedExecutionFragments: execution.changed,
    changedFinalSimulations: finalSim.changed,
    unprovenAddedArtifacts,
    undeclaredDeltaIds,
    evidenceRefs,
    outcome,
  });
}

function compareSet(
  baseline: readonly CanonicalSemanticItem[],
  challenger: readonly CanonicalSemanticItem[],
): {
  readonly missing: readonly string[];
  readonly added: readonly string[];
  readonly changed: readonly PriceParityMismatch[];
  readonly allDeltaIds: readonly string[];
} {
  const before = indexItems(baseline, "baseline semantic set");
  const after = indexItems(challenger, "challenger semantic set");
  const missing = [...before.keys()].filter((id) => !after.has(id)).sort();
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const changed = [...before.keys()]
    .filter((id) => after.has(id) && before.get(id) !== after.get(id))
    .sort()
    .map((id) => Object.freeze({
      id,
      baselineHash: before.get(id) ?? null,
      challengerHash: after.get(id) ?? null,
    }));
  return Object.freeze({
    missing: Object.freeze(missing),
    added: Object.freeze(added),
    changed: Object.freeze(changed),
    allDeltaIds: Object.freeze([
      ...new Set([...missing, ...added, ...changed.map((item) => item.id)]),
    ].sort()),
  });
}

function indexItems(
  items: readonly CanonicalSemanticItem[],
  label: string,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const item of items) {
    nonempty(item.id, `${label} id`);
    assertSha256(item.semanticHash, `${label} hash`);
    if (index.has(item.id)) throw new Error(`${label} duplicates ${item.id}`);
    index.set(item.id, item.semanticHash);
  }
  return index;
}

function indexOutputs(
  outputs: readonly CanonicalFamilySemanticOutput[],
  label: string,
): ReadonlyMap<string, CanonicalFamilySemanticOutput> {
  const index = new Map<string, CanonicalFamilySemanticOutput>();
  for (const output of outputs) {
    nonempty(output.familyId, `${label} familyId`);
    assertSha256(
      output.implementationClosureHash,
      `${output.familyId} implementationClosureHash`,
    );
    if (index.has(output.familyId)) {
      throw new Error(`${label} duplicates Family ${output.familyId}`);
    }
    index.set(output.familyId, output);
  }
  return index;
}

function indexDeclaredDeltas(
  mode: ArchitectureMigrationMode,
  families: ReadonlySet<string>,
  deltas: readonly DeclaredSemanticDelta[],
): ReadonlyMap<string, ReadonlySet<string>> {
  if (mode === "pure-refactor" && deltas.length > 0) {
    throw new Error("pure-refactor migration cannot declare semantic deltas");
  }
  const index = new Map<string, Set<string>>();
  for (const delta of deltas) {
    if (!families.has(delta.familyId)) {
      throw new Error(`semantic delta targets undeclared Family ${delta.familyId}`);
    }
    if (delta.affectedCanonicalIds.length === 0) {
      throw new Error(`${delta.familyId} semantic delta has no affected ids`);
    }
    if (delta.independentEvidenceRefs.length === 0) {
      throw new Error(`${delta.familyId} semantic delta lacks independent evidence`);
    }
    const ids = index.get(delta.familyId) ?? new Set<string>();
    for (const id of delta.affectedCanonicalIds) {
      nonempty(id, "declared semantic id");
      if (ids.has(id)) {
        throw new Error(`${delta.familyId} declares semantic id ${id} twice`);
      }
      ids.add(id);
    }
    index.set(delta.familyId, ids);
  }
  return index;
}

function validateScope(scope: ArchitectureMigrationScope): ReadonlySet<string> {
  if (!Array.isArray(scope.familyIds) || scope.familyIds.length === 0) {
    throw new Error("architecture migration scope has no Families");
  }
  if (scope.kind === "single-family" && scope.familyIds.length !== 1) {
    throw new Error("single-family scope must contain exactly one Family");
  }
  const families = new Set(scope.familyIds.map((familyId) =>
    nonempty(familyId, "scope familyId")
  ));
  if (families.size !== scope.familyIds.length) {
    throw new Error("architecture migration scope duplicates a Family");
  }
  return families;
}

function validateAnchors(anchors: readonly ArchitectureStateAnchor[]): void {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new Error("architecture migration requires a StateAnchor");
  }
  for (const anchor of anchors) {
    if (!Number.isSafeInteger(anchor.number) || anchor.number < 0) {
      throw new Error(`invalid StateAnchor number ${anchor.number}`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(anchor.hash)) {
      throw new Error("StateAnchor hash must be bytes32");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(anchor.stateRoot)) {
      throw new Error("StateAnchor stateRoot must be bytes32");
    }
  }
}

function validatePerformance(input: {
  readonly wallMs: number;
  readonly requestCount: number;
  readonly batchCount: number;
  readonly peakConcurrency: number;
}): void {
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid performance diagnostic ${key}=${value}`);
    }
  }
}

function assertSameCaseSet(
  baseline: CanonicalFamilySemanticOutput,
  challenger: CanonicalFamilySemanticOutput,
): void {
  const before = [...new Set(baseline.exercisedCaseIds)].sort();
  const after = [...new Set(challenger.exercisedCaseIds)].sort();
  if (
    before.length !== baseline.exercisedCaseIds.length ||
    after.length !== challenger.exercisedCaseIds.length ||
    before.length !== after.length ||
    before.some((id, index) => id !== after[index])
  ) {
    throw new Error(
      `${baseline.familyId} baseline/challenger did not run the same cases`,
    );
  }
}

function emptyFamilyResult(input: {
  readonly familyId: string;
  readonly implementationClosureHash: string;
  readonly evidenceRefs: readonly string[];
  readonly outcome: "not-exercised" | "framework-blocked";
}): FamilyArchitectureParityResult {
  return deepFreeze({
    familyId: input.familyId,
    implementationClosureHash: input.implementationClosureHash,
    missingInstances: [],
    addedInstances: [],
    changedInstances: [],
    missingEdges: [],
    addedEdges: [],
    changedEdgeMetadata: [],
    lostStateKeys: [],
    addedStateKeys: [],
    changedStateCoverage: [],
    newlyUnresolvedStateKeys: [],
    missingPricedEdges: [],
    addedPricedEdges: [],
    changedPrices: [],
    changedFailures: [],
    changedRoutes: [],
    changedExactQuotes: [],
    changedExecutionFragments: [],
    changedFinalSimulations: [],
    unprovenAddedArtifacts: [],
    undeclaredDeltaIds: [],
    evidenceRefs: input.evidenceRefs,
    outcome: input.outcome,
  });
}

function resultProjection(
  result: FamilyArchitectureParityResult,
): CanonicalValue {
  return {
    familyId: result.familyId,
    implementationClosureHash: result.implementationClosureHash,
    missingInstances: result.missingInstances,
    addedInstances: result.addedInstances,
    changedInstances: result.changedInstances,
    missingEdges: result.missingEdges,
    addedEdges: result.addedEdges,
    changedEdgeMetadata: result.changedEdgeMetadata,
    lostStateKeys: result.lostStateKeys,
    addedStateKeys: result.addedStateKeys,
    changedStateCoverage: result.changedStateCoverage,
    newlyUnresolvedStateKeys: result.newlyUnresolvedStateKeys,
    missingPricedEdges: result.missingPricedEdges,
    addedPricedEdges: result.addedPricedEdges,
    changedPrices: result.changedPrices.map(mismatchProjection),
    changedFailures: result.changedFailures.map(mismatchProjection),
    changedRoutes: result.changedRoutes.map(mismatchProjection),
    changedExactQuotes: result.changedExactQuotes.map(mismatchProjection),
    changedExecutionFragments:
      result.changedExecutionFragments.map(mismatchProjection),
    changedFinalSimulations:
      result.changedFinalSimulations.map(mismatchProjection),
    unprovenAddedArtifacts: result.unprovenAddedArtifacts,
    undeclaredDeltaIds: result.undeclaredDeltaIds,
    evidenceRefs: result.evidenceRefs,
    outcome: result.outcome,
  };
}

function mismatchProjection(item: PriceParityMismatch): CanonicalValue {
  return {
    id: item.id,
    baselineHash: item.baselineHash,
    challengerHash: item.challengerHash,
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value as object)) deepFreeze(item);
  return Object.freeze(value);
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}
