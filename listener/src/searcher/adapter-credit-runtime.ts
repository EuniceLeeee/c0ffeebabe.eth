import {
  executeAdapterWork,
  type AdapterWorkOutcome,
  type CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import { deriveEdgeTaxonomy } from "./strategy-taxonomy.js";
import type { TokenEdge } from "./planner/token-graph.js";
import {
  assertDefinedFamilyPlugin,
  type CompiledInstanceDescriptor,
  type CreditFamilyPlugin,
  type CreditRiskProgramInput,
  type ExpectedEffect,
  type FamilyCandidate,
  type FamilyGraphProjection,
  type FamilyRouteDescriptor,
  type RuntimeEvidence,
  type VerifiedIdentity,
} from "./venues/adapter-family-plugin.js";
import type {
  FamilyId,
  InstanceKey,
  LineageId,
  RouteKey,
} from "./venues/adapter-family-identifiers.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  canonicalEdgeId,
  type CanonicalEdgeId,
} from "./venues/blockscan-state-capability.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import {
  assertIssuedLoadedFamilyBox,
  type FamilyCapabilityCatalog,
  type LoadedFamilyBox,
} from "./venues/family-capability-catalog.js";
import {
  assertFamilyOwnedPlanFragment,
  assertIssuedPreparedFamilyInstance,
  type PreparedFamilyInstance,
} from "./venues/adapter-family-runtime.js";
import type { PlanFragment } from "./venues/route-leg-adapter.js";

type RuntimeCreditPlugin = CreditFamilyPlugin<
  FamilyCandidate,
  VerifiedIdentity,
  CompiledInstanceDescriptor,
  FamilyRouteDescriptor,
  unknown,
  object,
  unknown
>;

declare const creditRouteRuntimeHandleBrand: unique symbol;

export interface CreditRouteRuntimeHandle {
  readonly [creditRouteRuntimeHandleBrand]: "credit-route-runtime-handle";
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly candidateKey: string;
  readonly instanceKey: InstanceKey;
  readonly routeKey: RouteKey;
  readonly source: CanonicalSource;
  readonly generation: number;
}

declare const sealedCreditRiskQuoteHandleBrand: unique symbol;

export interface SealedCreditRiskQuoteHandle {
  readonly [sealedCreditRiskQuoteHandleBrand]: "sealed-credit-risk-handle";
  readonly status: "resolved";
  readonly familyId: FamilyId;
  readonly candidateKey: string;
  readonly instanceKey: InstanceKey;
  readonly routeKey: RouteKey;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly amountOut: bigint;
  readonly positionKey: string;
  readonly blocksPrefixInversion: true;
  readonly evidenceRefs: readonly string[];
}

export interface PreparedCreditRoutePublication {
  readonly familyId: FamilyId;
  readonly candidateKey: string;
  readonly instanceKey: InstanceKey;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly routes: readonly CreditRouteRuntimeHandle[];
  readonly publicationFingerprint: string;
}

export type CreditRiskQuoteOutcome =
  | SealedCreditRiskQuoteHandle
  | {
      readonly status: "unresolved" | "failed";
      readonly reasonCode: string;
    };

export type CreditExecutionOutcome =
  | {
      readonly status: "resolved";
      readonly fragment: PlanFragment;
      readonly expectedEffects: readonly ExpectedEffect[];
    }
  | {
      readonly status: "rejected" | "failed";
      readonly reasonCode: string;
    };

export interface ProjectedCreditRouteGraph {
  readonly edge: TokenEdge & { readonly canonicalEdgeId: CanonicalEdgeId };
  readonly graph: FamilyGraphProjection;
  readonly venueIdentityHash: string;
  readonly handle: CreditRouteRuntimeHandle;
}

interface CreditRouteRuntimeHandleRecord {
  readonly family: LoadedFamilyBox;
  readonly instance: PreparedFamilyInstance;
  readonly descriptor: CompiledInstanceDescriptor;
  readonly route: FamilyRouteDescriptor;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly candidateKey: string;
}

interface SealedCreditRiskQuoteHandleRecord {
  readonly family: LoadedFamilyBox;
  readonly routeHandle: CreditRouteRuntimeHandle;
  readonly routeRecord: CreditRouteRuntimeHandleRecord;
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly amountOut: bigint;
  readonly evidence: unknown;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
  readonly runtimeEvidenceFingerprint: string;
  readonly source: CanonicalSource;
  readonly generation: number;
}

const issuedCreditRouteRuntimeHandles = new WeakMap<
  object,
  CreditRouteRuntimeHandleRecord
>();
const issuedCreditRiskQuoteHandles = new WeakMap<
  object,
  SealedCreditRiskQuoteHandleRecord
>();
const issuedProjectedCreditRoutes = new WeakSet<object>();

/**
 * Shadow-only Credit route issuer. It receives one catalog-issued FamilyBox
 * plus a lifecycle-issued opaque instance, runs projection centrally, and
 * returns no raw descriptor or route objects.
 */
export function prepareCreditFamilyRoutes(input: {
  readonly family: LoadedFamilyBox;
  readonly instance: PreparedFamilyInstance;
  readonly source: CanonicalSource;
  readonly generation: number;
}): PreparedCreditRoutePublication {
  const plugin = resolveCreditPlugin(input.family);
  assertIssuedPreparedFamilyInstance({
    family: input.family,
    instance: input.instance,
    source: input.source,
    generation: input.generation,
  });
  const instance = input.instance;

  const bindingA = plugin.instance.staticBindingProjection(instance.descriptor);
  const bindingB = plugin.instance.staticBindingProjection(instance.descriptor);
  if (hashCanonical(bindingA) !== hashCanonical(bindingB)) {
    throw new Error("Credit descriptor binding projection is unstable");
  }
  const first = validateCreditRoutes(
    plugin.routes.project({ descriptor: instance.descriptor }),
    instance.descriptor,
    input.family,
  );
  const second = validateCreditRoutes(
    plugin.routes.project({ descriptor: instance.descriptor }),
    instance.descriptor,
    input.family,
  );
  if (routeSetFingerprint(first) !== routeSetFingerprint(second)) {
    throw new Error("Credit route projection is unstable");
  }
  if (first.length === 0) throw new Error("Credit Family projected no routes");

  const source = freezeSource(input.source);
  const handles = first.map((route) => {
    const handle = Object.freeze({
      familyId: input.family.plugin.manifest.familyId,
      lineageId: route.lineageId,
      candidateKey: instance.candidateKey,
      instanceKey: route.instanceKey,
      routeKey: route.routeKey,
      source,
      generation: input.generation,
    }) as CreditRouteRuntimeHandle;
    issuedCreditRouteRuntimeHandles.set(handle, Object.freeze({
      family: input.family,
      instance,
      descriptor: instance.descriptor,
      route,
      source,
      generation: input.generation,
      candidateKey: instance.candidateKey,
    }));
    return handle;
  });
  return Object.freeze({
    familyId: input.family.plugin.manifest.familyId,
    candidateKey: instance.candidateKey,
    instanceKey: instance.descriptor.instanceKey,
    source,
    generation: input.generation,
    routes: Object.freeze(handles),
    publicationFingerprint: hashCanonical({
      format: "adapter-credit-route-publication-v1",
      familyId: input.family.plugin.manifest.familyId,
      candidateKey: instance.candidateKey,
      instanceKey: instance.descriptor.instanceKey,
      source: sourceProjection(source),
      routes: first.map(routeProjection),
    }),
  });
}

export function assertIssuedCreditRouteRuntimeHandle(
  family: LoadedFamilyBox,
  value: unknown,
): asserts value is CreditRouteRuntimeHandle {
  assertIssuedLoadedFamilyBox(family);
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.isFrozen(value) ||
    !issuedCreditRouteRuntimeHandles.has(value)
  ) {
    throw new Error("Credit route handle must be issued by the central runtime");
  }
  if (issuedCreditRouteRuntimeHandles.get(value)!.family !== family) {
    throw new Error("Credit route handle escaped its catalog FamilyBox");
  }
}

/** Common-Graph projection from a Credit issuer record, never caller raw data. */
export function projectCreditRouteGraph(input: {
  readonly family: LoadedFamilyBox;
  readonly route: CreditRouteRuntimeHandle;
  readonly centralScores?: ReadonlyMap<string, number>;
}): ProjectedCreditRouteGraph {
  const plugin = resolveCreditPlugin(input.family);
  const record = resolveCreditRouteHandle(input.family, input.route);
  const first = validateGraphProjection(plugin.routes.projectGraph({
    descriptor: record.descriptor,
    route: record.route,
  }));
  const second = validateGraphProjection(plugin.routes.projectGraph({
    descriptor: record.descriptor,
    route: record.route,
  }));
  if (graphFingerprint(first) !== graphFingerprint(second)) {
    throw new Error("Credit Graph projection is unstable");
  }
  if (!input.family.plugin.manifest.ownedActionAdapterIds.includes(
    first.routeActionAdapterId,
  )) {
    throw new Error("Credit Graph projection uses a non-owned ActionAdapter");
  }
  const score = first.centralScoreKey === undefined
    ? 0
    : input.centralScores?.get(first.centralScoreKey) ?? 0;
  if (!Number.isFinite(score) || score < 0) {
    throw new Error("Credit central score must be finite and non-negative");
  }
  const venueIdentityHash = hashCanonical(first.venueIdentity);
  const executionVariantKey = hashCanonical({
    namespace: "adapter-family-graph-route-v1",
    routeKey: record.route.routeKey,
    routeBindingFingerprint: record.route.bindingRef.fingerprint,
    venueIdentityHash,
  });
  const taxonomy = deriveEdgeTaxonomy("lend");
  const unbound: TokenEdge = {
    instanceKey: record.route.instanceKey,
    executionVariantKey,
    adapterId: first.routeActionAdapterId,
    target: first.executionTarget,
    tokenIn: record.route.tokenIn,
    tokenOut: record.route.tokenOut,
    slotKind: "lend",
    ...taxonomy,
    score,
  };
  const edge = Object.freeze({
    ...unbound,
    canonicalEdgeId: canonicalEdgeId(
      input.family.plugin.manifest.familyId,
      unbound,
    ),
  });
  const projected = Object.freeze({
    edge,
    graph: first,
    venueIdentityHash,
    handle: input.route,
  });
  issuedProjectedCreditRoutes.add(projected);
  return projected;
}

export function assertIssuedProjectedCreditRoute(
  value: unknown,
): asserts value is ProjectedCreditRouteGraph {
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.isFrozen(value) ||
    !issuedProjectedCreditRoutes.has(value)
  ) {
    throw new Error("Credit Graph route must be issued by the Credit runtime");
  }
  const projected = value as ProjectedCreditRouteGraph;
  const record = resolveCreditRouteHandleRecord(projected.handle);
  if (
    projected.edge.instanceKey !== record.route.instanceKey ||
    projected.handle.routeKey !== record.route.routeKey
  ) {
    throw new Error("Credit Graph route metadata changed after issue");
  }
}

export async function executeCreditRiskQuote(input: {
  readonly family: LoadedFamilyBox;
  readonly route: CreditRouteRuntimeHandle;
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly runtime: CentralAdapterRuntime;
}): Promise<CreditRiskQuoteOutcome> {
  let plugin: RuntimeCreditPlugin;
  let routeRecord: CreditRouteRuntimeHandleRecord;
  let executor: string;
  let runtimeEvidence: readonly RuntimeEvidence[];
  try {
    plugin = resolveCreditPlugin(input.family);
    routeRecord = resolveCreditRouteHandle(input.family, input.route);
    assertRiskInvocation(input, routeRecord, plugin);
    executor = canonicalAddress(input.executor, "Credit executor");
    runtimeEvidence = sealRuntimeEvidence(
      input.runtimeEvidence,
      input.family.plugin.manifest.familyId,
      routeRecord.route.instanceKey,
      input.source,
    );
  } catch (error) {
    return terminalRisk("failed", `risk-declaration:${errorMessage(error)}`);
  }

  const program = plugin.credit.risk.evidence;
  if (program === undefined) {
    return terminalRisk("failed", "risk-declaration:evidence-program-required");
  }
  const programInput: CreditRiskProgramInput<
    CompiledInstanceDescriptor,
    FamilyRouteDescriptor
  > = Object.freeze({
    descriptor: routeRecord.descriptor,
    route: routeRecord.route,
    collateralAmount: input.collateralAmount,
    debtBps: input.debtBps,
    source: freezeSource(input.source),
    executor,
    runtimeEvidence,
  });
  let work: AdapterWorkOutcome<unknown>;
  try {
    work = await executeAdapterWork({
      intent: {
        stage: "runtime-evidence",
        familyId: input.family.plugin.manifest.familyId,
        instanceKey: routeRecord.route.instanceKey,
        routeKey: routeRecord.route.routeKey,
        source: input.source,
        generation: input.generation,
        program,
        programInput,
      },
      runtime: input.runtime,
    });
  } catch (error) {
    return terminalRisk("unresolved", `risk-work:${errorMessage(error)}`);
  }
  if (work.status === "unresolved") {
    return terminalRisk(
      "unresolved",
      `risk-work:${work.failure.stage}:${work.failure.code}`,
    );
  }

  try {
    deepFreezeOpaqueValue(work.executed.evidence, "Credit risk evidence");
    const amountOut = plugin.credit.risk.quoteOutputByDebtBps({
      descriptor: routeRecord.descriptor,
      route: routeRecord.route,
      collateralAmount: input.collateralAmount,
      debtBps: input.debtBps,
      evidence: work.executed.evidence,
    });
    if (typeof amountOut !== "bigint" || amountOut < 0n) {
      throw new Error("Credit risk quote must be a non-negative bigint");
    }
    const positionKey = nonempty(plugin.credit.position.positionKey({
      descriptor: routeRecord.descriptor,
      route: routeRecord.route,
    }), "Credit position key");
    input.runtime.generationFence.assertCurrent(input.generation, input.source);
    const source = freezeSource(input.source);
    const evidenceRefs = Object.freeze([
      `risk-transport:${work.executed.trustedResultsFingerprint}`,
      `risk-debt-bps:${input.debtBps}`,
    ]);
    const handle = Object.freeze({
      status: "resolved" as const,
      familyId: input.family.plugin.manifest.familyId,
      candidateKey: input.route.candidateKey,
      instanceKey: input.route.instanceKey,
      routeKey: input.route.routeKey,
      source,
      generation: input.generation,
      collateralAmount: input.collateralAmount,
      debtBps: input.debtBps,
      amountOut,
      positionKey,
      blocksPrefixInversion: true as const,
      evidenceRefs,
    }) as SealedCreditRiskQuoteHandle;
    issuedCreditRiskQuoteHandles.set(handle, Object.freeze({
      family: input.family,
      routeHandle: input.route,
      routeRecord,
      collateralAmount: input.collateralAmount,
      debtBps: input.debtBps,
      amountOut,
      evidence: work.executed.evidence,
      executor,
      runtimeEvidence,
      runtimeEvidenceFingerprint: runtimeEvidenceHash(runtimeEvidence),
      source,
      generation: input.generation,
    }));
    return handle;
  } catch (error) {
    return terminalRisk("failed", `risk-quote:${errorMessage(error)}`);
  }
}

/** Synchronous Credit execution; no raw evidence or descriptor is accepted. */
export function buildCreditExecutionFragment(input: {
  readonly family: LoadedFamilyBox;
  readonly actionOwnership: Pick<FamilyCapabilityCatalog, "ownerOfAction">;
  readonly route: CreditRouteRuntimeHandle;
  readonly risk: SealedCreditRiskQuoteHandle;
  readonly minAmountOut: bigint;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
  readonly source: CanonicalSource;
  readonly generation: number;
}): CreditExecutionOutcome {
  try {
    const plugin = resolveCreditPlugin(input.family);
    const routeRecord = resolveCreditRouteHandle(input.family, input.route);
    const riskRecord = resolveCreditRiskHandle(input.family, input.risk);
    assertExecutionInvocation(input, routeRecord, riskRecord);
    const fragment = plugin.execution.buildFragment({
      descriptor: routeRecord.descriptor,
      route: routeRecord.route,
      amountIn: riskRecord.collateralAmount,
      quotedAmountOut: riskRecord.amountOut,
      minAmountOut: input.minAmountOut,
      exactEvidence: riskRecord.evidence,
      executor: riskRecord.executor,
      runtimeEvidence: riskRecord.runtimeEvidence,
    });
    assertFamilyOwnedPlanFragment({
      family: input.family,
      actionOwnership: input.actionOwnership,
      fragment,
    });
    const effects = plugin.execution.expectedEffects({
      descriptor: routeRecord.descriptor,
      route: routeRecord.route,
      amountIn: riskRecord.collateralAmount,
      quotedAmountOut: riskRecord.amountOut,
    });
    if (!Array.isArray(effects)) {
      throw new Error("Credit expectedEffects must be an array");
    }
    return Object.freeze({
      status: "resolved" as const,
      fragment: sealPlanFragment(fragment),
      expectedEffects: Object.freeze(effects.map((effect) =>
        Object.freeze({ ...effect })
      )),
    });
  } catch (error) {
    return Object.freeze({
      status: "failed" as const,
      reasonCode: `execution:${errorMessage(error)}`,
    });
  }
}

function resolveCreditPlugin(family: LoadedFamilyBox): RuntimeCreditPlugin {
  assertIssuedLoadedFamilyBox(family);
  assertDefinedFamilyPlugin(family.plugin);
  if (family.plugin.manifest.domain !== "credit") {
    throw new Error("Credit runtime requires a Credit FamilyBox");
  }
  return family.plugin as RuntimeCreditPlugin;
}

function resolveCreditRouteHandle(
  family: LoadedFamilyBox,
  handle: CreditRouteRuntimeHandle,
): CreditRouteRuntimeHandleRecord {
  assertIssuedCreditRouteRuntimeHandle(family, handle);
  const record = issuedCreditRouteRuntimeHandles.get(handle)!;
  assertIssuedPreparedFamilyInstance({
    family,
    instance: record.instance,
    source: record.source,
    generation: record.generation,
  });
  if (
    record.instance.descriptor !== record.descriptor ||
    handle.familyId !== family.plugin.manifest.familyId ||
    handle.familyId !== record.descriptor.familyId ||
    handle.lineageId !== record.descriptor.lineageId ||
    handle.lineageId !== record.route.lineageId ||
    handle.candidateKey !== record.candidateKey ||
    handle.instanceKey !== record.descriptor.instanceKey ||
    handle.instanceKey !== record.route.instanceKey ||
    handle.routeKey !== record.route.routeKey ||
    handle.generation !== record.generation ||
    !sameSource(handle.source, record.source)
  ) {
    throw new Error("Credit route handle metadata changed after issue");
  }
  return record;
}

function resolveCreditRouteHandleRecord(
  handle: CreditRouteRuntimeHandle,
): CreditRouteRuntimeHandleRecord {
  const record = issuedCreditRouteRuntimeHandles.get(handle);
  if (record === undefined) {
    throw new Error("Credit route handle must be issued by the central runtime");
  }
  resolveCreditRouteHandle(record.family, handle);
  return record;
}

function resolveCreditRiskHandle(
  family: LoadedFamilyBox,
  handle: SealedCreditRiskQuoteHandle,
): SealedCreditRiskQuoteHandleRecord {
  if (
    handle === null ||
    typeof handle !== "object" ||
    !Object.isFrozen(handle)
  ) {
    throw new Error("Credit risk handle must be issued by the central runtime");
  }
  const record = issuedCreditRiskQuoteHandles.get(handle);
  if (record === undefined) {
    throw new Error("Credit risk handle must be issued by the central runtime");
  }
  if (record.family !== family) {
    throw new Error("Credit risk handle escaped its catalog FamilyBox");
  }
  if (
    handle.status !== "resolved" ||
    handle.familyId !== family.plugin.manifest.familyId ||
    handle.candidateKey !== record.routeHandle.candidateKey ||
    handle.instanceKey !== record.routeHandle.instanceKey ||
    handle.routeKey !== record.routeHandle.routeKey ||
    handle.generation !== record.generation ||
    handle.collateralAmount !== record.collateralAmount ||
    handle.debtBps !== record.debtBps ||
    handle.amountOut !== record.amountOut ||
    handle.blocksPrefixInversion !== true ||
    !sameSource(handle.source, record.source)
  ) {
    throw new Error("Credit risk handle metadata changed after issue");
  }
  return record;
}

function assertRiskInvocation(
  input: {
    readonly family: LoadedFamilyBox;
    readonly route: CreditRouteRuntimeHandle;
    readonly collateralAmount: bigint;
    readonly debtBps: bigint;
    readonly executor: string;
    readonly runtimeEvidence: readonly RuntimeEvidence[];
    readonly source: CanonicalSource;
    readonly generation: number;
  },
  record: CreditRouteRuntimeHandleRecord,
  plugin: RuntimeCreditPlugin,
): void {
  assertSource(input.source, input.generation);
  if (!sameSource(input.source, record.source)) {
    throw new Error("Credit risk source escaped its route publication");
  }
  if (input.generation !== record.generation) {
    throw new Error("Credit risk generation escaped its route publication");
  }
  if (typeof input.collateralAmount !== "bigint" || input.collateralAmount <= 0n) {
    throw new Error("Credit collateral amount must be positive");
  }
  if (
    typeof input.debtBps !== "bigint" ||
    !plugin.credit.risk.debtBpsCandidates.some((item) => item === input.debtBps)
  ) {
    throw new Error("Credit debtBps was not declared by the Family");
  }
  if (plugin.credit.risk.blocksPrefixInversion !== true) {
    throw new Error("Credit Family must block prefix inversion");
  }
  canonicalAddress(input.executor, "Credit executor");
  // Validate before any Request Program callback.
  sealRuntimeEvidence(
    input.runtimeEvidence,
    input.family.plugin.manifest.familyId,
    record.route.instanceKey,
    input.source,
  );
}

function assertExecutionInvocation(
  input: {
    readonly route: CreditRouteRuntimeHandle;
    readonly risk: SealedCreditRiskQuoteHandle;
    readonly minAmountOut: bigint;
    readonly executor: string;
    readonly runtimeEvidence: readonly RuntimeEvidence[];
    readonly source: CanonicalSource;
    readonly generation: number;
  },
  route: CreditRouteRuntimeHandleRecord,
  risk: SealedCreditRiskQuoteHandleRecord,
): void {
  assertSource(input.source, input.generation);
  if (risk.routeHandle !== input.route || risk.routeRecord !== route) {
    throw new Error("Credit risk handle escaped its exact route handle");
  }
  if (
    input.generation !== route.generation ||
    input.generation !== risk.generation ||
    !sameSource(input.source, route.source) ||
    !sameSource(input.source, risk.source)
  ) {
    throw new Error("Credit execution source/generation mismatch");
  }
  if (
    typeof input.minAmountOut !== "bigint" ||
    input.minAmountOut < 0n ||
    input.minAmountOut > risk.amountOut
  ) {
    throw new Error("Credit minAmountOut is outside the sealed risk quote");
  }
  const executor = canonicalAddress(input.executor, "Credit executor");
  if (executor !== risk.executor) {
    throw new Error("Credit execution executor differs from risk quote");
  }
  const evidence = sealRuntimeEvidence(
    input.runtimeEvidence,
    route.family.plugin.manifest.familyId,
    route.route.instanceKey,
    input.source,
  );
  if (runtimeEvidenceHash(evidence) !== risk.runtimeEvidenceFingerprint) {
    throw new Error("Credit execution runtime evidence differs from risk quote");
  }
}

function validateCreditDescriptor(
  descriptor: CompiledInstanceDescriptor,
  family: LoadedFamilyBox,
): void {
  requireObject(descriptor, "Credit descriptor");
  if (descriptor.familyId !== family.plugin.manifest.familyId) {
    throw new Error("Credit descriptor escaped its Family");
  }
  if (!family.plugin.manifest.supportedLineages.includes(descriptor.lineageId)) {
    throw new Error("Credit descriptor lineage is not declared");
  }
  nonempty(descriptor.instanceKey, "Credit instance key");
  if (!Array.isArray(descriptor.runtimeRequirements)) {
    throw new Error("Credit descriptor runtimeRequirements must be an array");
  }
}

function validateCreditRoutes(
  routes: readonly FamilyRouteDescriptor[],
  descriptor: CompiledInstanceDescriptor,
  family: LoadedFamilyBox,
): readonly FamilyRouteDescriptor[] {
  if (!Array.isArray(routes)) throw new Error("Credit routes must be an array");
  const seen = new Set<RouteKey>();
  const output = routes.map((route) => {
    requireObject(route, "Credit route");
    if (
      route.familyId !== family.plugin.manifest.familyId ||
      route.familyId !== descriptor.familyId ||
      route.lineageId !== descriptor.lineageId ||
      route.instanceKey !== descriptor.instanceKey
    ) {
      throw new Error("Credit route escaped its descriptor");
    }
    nonempty(route.routeKey, "Credit route key");
    if (seen.has(route.routeKey)) throw new Error("Credit route keys must be unique");
    seen.add(route.routeKey);
    canonicalAddress(route.tokenIn, "Credit route tokenIn");
    canonicalAddress(route.tokenOut, "Credit route tokenOut");
    if (route.tokenIn.toLowerCase() === route.tokenOut.toLowerCase()) {
      throw new Error("Credit route must change token");
    }
    if (route.taxonomy.slotKind !== "lend") {
      throw new Error("Credit route taxonomy must be lend");
    }
    const allowed = family.plugin.manifest.allowedTaxonomy.some((item) =>
      item.slotKind === "lend" && item.protocolAction === undefined
    );
    if (!allowed) throw new Error("Credit route taxonomy is not allowed");
    nonempty(route.bindingRef?.fingerprint, "Credit route binding fingerprint");
    deepFreezeOpaqueValue(route, `Credit route ${route.routeKey}`);
    return route;
  });
  return Object.freeze(output);
}

function validateGraphProjection(value: FamilyGraphProjection):
  FamilyGraphProjection {
  requireObject(value, "Credit Graph projection");
  nonempty(value.routeActionAdapterId, "Credit Graph ActionAdapter id");
  canonicalAddress(value.executionTarget, "Credit Graph target");
  if (
    value.centralScoreKey !== undefined &&
    value.centralScoreKey.trim().length === 0
  ) {
    throw new Error("Credit Graph score key must be non-empty");
  }
  hashCanonical(value.venueIdentity);
  return Object.freeze({
    routeActionAdapterId: value.routeActionAdapterId,
    executionTarget: value.executionTarget,
    venueIdentity: sealCanonicalValue(value.venueIdentity),
    ...(value.centralScoreKey === undefined
      ? {}
      : { centralScoreKey: value.centralScoreKey }),
  });
}

function sealRuntimeEvidence(
  evidence: readonly RuntimeEvidence[],
  familyId: FamilyId,
  instanceKey: InstanceKey,
  source: CanonicalSource,
): readonly RuntimeEvidence[] {
  if (!Array.isArray(evidence)) throw new Error("runtime evidence must be an array");
  const seen = new Set<string>();
  return Object.freeze(evidence.map((item) => {
    requireObject(item, "runtime evidence");
    nonempty(item.evidenceId, "runtime evidence id");
    if (seen.has(item.evidenceId)) throw new Error("runtime evidence ids must be unique");
    seen.add(item.evidenceId);
    if (item.familyId !== familyId) {
      throw new Error("runtime evidence escaped its Credit Family");
    }
    if (item.instanceKey !== undefined && item.instanceKey !== instanceKey) {
      throw new Error("runtime evidence escaped its Credit instance");
    }
    if (!sameSource(item.source, source)) {
      throw new Error("runtime evidence escaped its Credit source");
    }
    nonempty(item.kind, "runtime evidence kind");
    nonempty(item.evidenceHash, "runtime evidence hash");
    nonempty(item.sealedPayloadRef, "runtime evidence payload ref");
    if (
      item.scope !== "source-block" &&
      item.scope !== "head" &&
      item.scope !== "transaction"
    ) {
      throw new Error("runtime evidence scope is invalid");
    }
    return Object.freeze({
      evidenceId: item.evidenceId,
      familyId: item.familyId,
      ...(item.instanceKey === undefined ? {} : { instanceKey: item.instanceKey }),
      kind: item.kind,
      scope: item.scope,
      source: freezeSource(item.source),
      ...(item.txHash === undefined ? {} : { txHash: item.txHash }),
      evidenceHash: item.evidenceHash,
      sealedPayloadRef: item.sealedPayloadRef,
    });
  }));
}

function runtimeEvidenceHash(evidence: readonly RuntimeEvidence[]): string {
  return hashCanonical(evidence.map((item) => ({
    evidenceId: item.evidenceId,
    familyId: item.familyId,
    instanceKey: item.instanceKey ?? null,
    kind: item.kind,
    scope: item.scope,
    source: sourceProjection(item.source),
    txHash: item.txHash ?? null,
    evidenceHash: item.evidenceHash,
    sealedPayloadRef: item.sealedPayloadRef,
  })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}

function routeSetFingerprint(routes: readonly FamilyRouteDescriptor[]): string {
  return hashCanonical(routes.map(routeProjection));
}

function routeProjection(route: FamilyRouteDescriptor): CanonicalValue {
  return {
    routeKey: route.routeKey,
    familyId: route.familyId,
    lineageId: route.lineageId,
    instanceKey: route.instanceKey,
    tokenIn: route.tokenIn.toLowerCase(),
    tokenOut: route.tokenOut.toLowerCase(),
    taxonomy: {
      slotKind: route.taxonomy.slotKind,
      protocolAction: route.taxonomy.protocolAction ?? null,
    },
    bindingRef: {
      bindingKey: route.bindingRef.bindingKey,
      fingerprint: route.bindingRef.fingerprint,
    },
    runtimeRequirements: route.runtimeRequirements as unknown as CanonicalValue,
  };
}

function graphFingerprint(graph: FamilyGraphProjection): string {
  return hashCanonical({
    routeActionAdapterId: graph.routeActionAdapterId,
    executionTarget: graph.executionTarget.toLowerCase(),
    venueIdentity: graph.venueIdentity,
    centralScoreKey: graph.centralScoreKey ?? null,
  });
}

function terminalRisk(
  status: "unresolved" | "failed",
  reasonCode: string,
): CreditRiskQuoteOutcome {
  return Object.freeze({ status, reasonCode });
}

function sealPlanFragment(fragment: PlanFragment): PlanFragment {
  requireObject(fragment, "Credit PlanFragment");
  if (!Array.isArray(fragment.requirements) || !Array.isArray(fragment.nodes)) {
    throw new Error("Credit PlanFragment must contain arrays");
  }
  return deepSealPlain(fragment, "Credit PlanFragment") as PlanFragment;
}

function deepSealPlain(value: unknown, label: string): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "number"
  ) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepSealPlain(item, label)));
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} contains a non-plain value`);
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = deepSealPlain(item, label);
  }
  return Object.freeze(output);
}

function deepFreezeOpaqueValue(
  value: unknown,
  label: string,
  seen = new Set<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) {
    throw new Error(`${label} must contain only plain objects and arrays`);
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} contains a symbol`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${label} contains an accessor`);
    }
    deepFreezeOpaqueValue(descriptor.value, label, seen);
  }
  seen.delete(value);
  Object.freeze(value);
}

function sealCanonicalValue(value: CanonicalValue): CanonicalValue {
  return deepSealPlain(value, "Credit Graph venue identity") as CanonicalValue;
}

function assertSource(source: CanonicalSource, generation: number): void {
  if (!Number.isSafeInteger(source.number) || source.number < 0) {
    throw new Error("Credit source block is invalid");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(source.hash)) {
    throw new Error("Credit source hash is invalid");
  }
  if (
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    source.generation !== generation
  ) {
    throw new Error("Credit source generation is invalid");
  }
}

function freezeSource(source: CanonicalSource): CanonicalSource {
  assertSource(source, source.generation);
  return Object.freeze({
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  });
}

function sameSource(left: CanonicalSource, right: CanonicalSource): boolean {
  return left.number === right.number &&
    left.hash.toLowerCase() === right.hash.toLowerCase() &&
    left.generation === right.generation;
}

function sourceProjection(source: CanonicalSource): CanonicalValue {
  return {
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  };
}

function canonicalAddress(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} must be a 20-byte address`);
  }
  return value.toLowerCase();
}

function nonempty<Value extends string>(value: Value, label: string): Value {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be non-empty without surrounding whitespace`);
  }
  return value;
}

function requireObject(value: unknown, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
