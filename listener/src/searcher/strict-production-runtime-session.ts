import type { CentralAdapterRuntime } from "./adapter-work-intent.js";
import {
  buildFamilyRouteGraphView,
} from "./adapter-family-graph-runtime.js";
import {
  buildCreditExecutionFragment,
  executeCreditRiskQuote,
  issueCreditExecutionHandle,
  prepareCreditFamilyRoutes,
  projectCreditRouteGraph,
  type CreditRouteRuntimeHandle,
  type SealedCreditRiskQuoteHandle,
} from "./adapter-credit-runtime.js";
import type { TokenEdge } from "./planner/token-graph.js";
import type { RuntimeEvidence } from
  "./venues/adapter-family-plugin.js";
import {
  buildFamilyExecutionFragment,
  executeFamilyExactQuote,
  reissuePreparedInstanceAuthority,
  reissuePreparedInstanceRouteHandles,
  type FamilyExecutionOutcome,
  type FamilyRouteRuntimeHandle,
  type PreparedFamilyInstance,
  type SealedFamilyExactQuoteHandle,
} from "./venues/adapter-family-runtime.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { CanonicalEdgeId } from
  "./venues/blockscan-state-capability.js";
import type {
  FamilyCapabilityCatalog,
  LoadedFamilyBox,
  LoadedFamilyPlugin,
} from "./venues/family-capability-catalog.js";

export type StrictProductionExactHandle =
  | SealedFamilyExactQuoteHandle
  | SealedCreditRiskQuoteHandle;

export type StrictProductionExecutionOutcome = FamilyExecutionOutcome | ReturnType<
  typeof buildCreditExecutionFragment
>;

interface RouteBinding {
  readonly kind: "route";
  readonly family: LoadedFamilyPlugin;
  readonly handle: FamilyRouteRuntimeHandle;
  readonly edge: TokenEdge & { readonly canonicalEdgeId: CanonicalEdgeId };
}

interface CreditBinding {
  readonly kind: "credit";
  readonly family: LoadedFamilyBox;
  readonly handle: CreditRouteRuntimeHandle;
  readonly edge: TokenEdge & { readonly canonicalEdgeId: CanonicalEdgeId };
}

type StrictRouteBinding = RouteBinding | CreditBinding;

interface ExactBinding {
  readonly route: StrictRouteBinding;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
}

/**
 * Immutable startup authority used to mint one current-source execution
 * session. It owns only the instances admitted by the atomic readyGeneration;
 * creating a session re-issues process-local handles and never discovers,
 * backfills, traces or changes topology.
 */
export class StrictProductionRuntimeRoot {
  readonly #catalog: FamilyCapabilityCatalog;
  readonly #readySource: CanonicalSource;
  readonly #readyGraph: readonly TokenEdge[];
  readonly #readyInstances: readonly PreparedFamilyInstance[];

  constructor(input: {
    readonly catalog: FamilyCapabilityCatalog;
    readonly readySource: CanonicalSource;
    readonly readyGraph: readonly TokenEdge[];
    readonly readyInstances: readonly PreparedFamilyInstance[];
  }) {
    assertCanonicalSource(input.readySource);
    const graphIds = new Set<string>();
    for (const edge of input.readyGraph) {
      const edgeId = requiredCanonicalEdgeId(edge);
      if (graphIds.has(edgeId)) {
        throw new Error(`strict ready Graph duplicates ${edgeId}`);
      }
      graphIds.add(edgeId);
    }
    const instanceKeys = new Set<string>();
    for (const instance of input.readyInstances) {
      const family = input.catalog.forStrictFamily(instance.familyId);
      if (family.plugin.manifest.domain === "funding") {
        throw new Error("Funding Family cannot enter the ready instance set");
      }
      const key = `${instance.familyId}\u0000${instance.instanceKey}`;
      if (instanceKeys.has(key)) {
        throw new Error(`strict ready instances duplicate ${key}`);
      }
      instanceKeys.add(key);
    }
    this.#catalog = input.catalog;
    this.#readySource = Object.freeze({ ...input.readySource });
    this.#readyGraph = Object.freeze([...input.readyGraph]);
    this.#readyInstances = Object.freeze([...input.readyInstances]);
    Object.freeze(this);
  }

  createSession(input: {
    readonly source: CanonicalSource;
    readonly runtime: CentralAdapterRuntime;
  }): StrictProductionRuntimeSession {
    assertCanonicalSource(input.source);
    input.runtime.generationFence.assertCurrent(
      input.source.generation,
      input.source,
    );

    const routes: {
      readonly family: LoadedFamilyPlugin;
      readonly descriptor: PreparedFamilyInstance["descriptor"];
      readonly route: PreparedFamilyInstance["routes"][number];
      readonly handle: FamilyRouteRuntimeHandle;
    }[] = [];
    const creditRoutes = [] as ReturnType<typeof projectCreditRouteGraph>[];

    for (const readyInstance of this.#readyInstances) {
      const strictFamily = this.#catalog.forStrictFamily(readyInstance.familyId);
      if (strictFamily.plugin.manifest.domain === "credit") {
        const currentInstance = reissuePreparedInstanceAuthority({
          family: strictFamily,
          instance: readyInstance,
          source: input.source,
          generation: input.source.generation,
        });
        const publication = prepareCreditFamilyRoutes({
          family: strictFamily,
          instance: currentInstance,
          source: input.source,
          generation: input.source.generation,
        });
        creditRoutes.push(...publication.routes.map((route) =>
          projectCreditRouteGraph({ family: strictFamily, route })
        ));
        continue;
      }
      if (
        strictFamily.plugin.manifest.domain !== "swap" &&
        strictFamily.plugin.manifest.domain !== "protocol"
      ) {
        throw new Error(
          `strict ready instance has unsupported domain ${strictFamily.plugin.manifest.domain}`,
        );
      }
      const family = this.#catalog.forFamily(readyInstance.familyId);
      const currentInstance = reissuePreparedInstanceRouteHandles({
        family,
        instance: readyInstance,
        source: input.source,
        generation: input.source.generation,
      });
      routes.push(...currentInstance.routes.map((route, index) => ({
        family,
        descriptor: currentInstance.descriptor,
        route,
        handle: currentInstance.routeHandles[index],
      })));
    }

    const view = buildFamilyRouteGraphView({ routes, creditRoutes });
    assertSameReadyTopology(this.#readyGraph, view.edges);
    const bindings = new Map<CanonicalEdgeId, StrictRouteBinding>();
    for (const projected of view.routes) {
      const strictFamily = this.#catalog.forStrictFamily(
        projected.handle.familyId,
      );
      const binding: StrictRouteBinding = strictFamily.plugin.manifest.domain === "credit"
        ? Object.freeze({
            kind: "credit" as const,
            family: strictFamily,
            handle: projected.handle as CreditRouteRuntimeHandle,
            edge: projected.edge,
          })
        : Object.freeze({
            kind: "route" as const,
            family: this.#catalog.forFamily(projected.handle.familyId),
            handle: projected.handle as FamilyRouteRuntimeHandle,
            edge: projected.edge,
          });
      bindings.set(projected.edge.canonicalEdgeId, binding);
    }
    return new StrictProductionRuntimeSession({
      catalog: this.#catalog,
      source: input.source,
      runtime: input.runtime,
      readySource: this.#readySource,
      edges: view.edges,
      bindings,
    });
  }
}

/** One current-source strict authority consumed by propagation and planning. */
export class StrictProductionRuntimeSession {
  readonly source: CanonicalSource;
  readonly edges: readonly TokenEdge[];
  readonly readySource: CanonicalSource;
  readonly #catalog: FamilyCapabilityCatalog;
  readonly #runtime: CentralAdapterRuntime;
  readonly #bindings: ReadonlyMap<CanonicalEdgeId, StrictRouteBinding>;
  readonly #exactBindings = new WeakMap<object, ExactBinding>();

  constructor(input: {
    readonly catalog: FamilyCapabilityCatalog;
    readonly source: CanonicalSource;
    readonly readySource: CanonicalSource;
    readonly runtime: CentralAdapterRuntime;
    readonly edges: readonly TokenEdge[];
    readonly bindings: ReadonlyMap<CanonicalEdgeId, StrictRouteBinding>;
  }) {
    this.#catalog = input.catalog;
    this.source = Object.freeze({ ...input.source });
    this.readySource = Object.freeze({ ...input.readySource });
    this.#runtime = input.runtime;
    this.edges = Object.freeze([...input.edges]);
    this.#bindings = new Map(input.bindings);
    Object.freeze(this);
  }

  familyIdForEdge(edge: TokenEdge): string {
    return this.#resolve(edge).family.plugin.manifest.familyId;
  }

  blocksPrefixInversion(edge: TokenEdge): boolean {
    return this.#resolve(edge).kind === "credit";
  }

  async quoteExact(input: {
    readonly edge: TokenEdge;
    readonly amountIn: bigint;
    readonly executor: string;
    readonly runtimeEvidence: readonly RuntimeEvidence[];
    readonly creditDebtBps?: bigint;
  }): Promise<StrictProductionExactHandle> {
    this.#runtime.generationFence.assertCurrent(
      this.source.generation,
      this.source,
    );
    const route = this.#resolve(input.edge);
    const exact = route.kind === "credit"
      ? await executeCreditRiskQuote({
          family: route.family,
          route: route.handle,
          collateralAmount: input.amountIn,
          debtBps: input.creditDebtBps ?? (() => {
            throw new Error("strict Credit quote requires a declared debtBps");
          })(),
          executor: input.executor,
          runtimeEvidence: input.runtimeEvidence,
          source: this.source,
          generation: this.source.generation,
          runtime: this.#runtime,
        })
      : await executeFamilyExactQuote({
          family: route.family,
          route: route.handle,
          amountIn: input.amountIn,
          executor: input.executor,
          runtimeEvidence: input.runtimeEvidence,
          source: this.source,
          generation: this.source.generation,
          runtime: this.#runtime,
        });
    if (exact.status !== "resolved") {
      const reason = "reasonCode" in exact
        ? exact.reasonCode
        : exact.outcome.reasonCode;
      throw new Error(
        `strict exact unresolved for ${route.edge.canonicalEdgeId}: ${reason}`,
      );
    }
    this.#exactBindings.set(exact, Object.freeze({
      route,
      executor: input.executor.toLowerCase(),
      runtimeEvidence: Object.freeze([...input.runtimeEvidence]),
    }));
    return exact;
  }

  buildExecution(input: {
    readonly edge: TokenEdge;
    readonly exact: StrictProductionExactHandle;
    readonly minAmountOut: bigint;
    readonly executor: string;
    readonly runtimeEvidence: readonly RuntimeEvidence[];
  }): StrictProductionExecutionOutcome {
    const route = this.#resolve(input.edge);
    const exactBinding = this.#exactBindings.get(input.exact);
    if (
      exactBinding === undefined ||
      exactBinding.route !== route ||
      exactBinding.executor !== input.executor.toLowerCase()
    ) {
      throw new Error(
        "strict execution requires the same session-issued route/exact authority",
      );
    }
    if (route.kind === "credit") {
      const handle = issueCreditExecutionHandle({
        family: route.family,
        route: route.handle,
        risk: input.exact as SealedCreditRiskQuoteHandle,
        minAmountOut: input.minAmountOut,
        executor: input.executor,
        runtimeEvidence: input.runtimeEvidence,
        source: this.source,
        generation: this.source.generation,
      });
      return buildCreditExecutionFragment({
        family: route.family,
        actionOwnership: this.#catalog,
        handle,
      });
    }
    return buildFamilyExecutionFragment({
      family: route.family,
      actionOwnership: this.#catalog,
      route: route.handle,
      exact: input.exact as SealedFamilyExactQuoteHandle,
      minAmountOut: input.minAmountOut,
      executor: input.executor,
      runtimeEvidence: input.runtimeEvidence,
    });
  }

  #resolve(edge: TokenEdge): StrictRouteBinding {
    const edgeId = requiredCanonicalEdgeId(edge);
    const binding = this.#bindings.get(edgeId);
    if (binding === undefined) {
      throw new Error(`strict session has no ready edge ${edgeId}`);
    }
    if (edgeBindingFingerprint(edge) !== edgeBindingFingerprint(binding.edge)) {
      throw new Error(`strict session edge shell diverged at ${edgeId}`);
    }
    return binding;
  }
}

function assertSameReadyTopology(
  ready: readonly TokenEdge[],
  current: readonly TokenEdge[],
): void {
  const readyById = new Map(ready.map((edge) => [
    requiredCanonicalEdgeId(edge),
    edgeBindingFingerprint(edge),
  ]));
  const currentById = new Map(current.map((edge) => [
    requiredCanonicalEdgeId(edge),
    edgeBindingFingerprint(edge),
  ]));
  if (readyById.size !== currentById.size) {
    throw new Error(
      `strict current-source topology differs from ready Graph: ` +
        `${currentById.size} != ${readyById.size}`,
    );
  }
  for (const [edgeId, fingerprint] of readyById) {
    if (currentById.get(edgeId) !== fingerprint) {
      throw new Error(`strict current-source topology differs at ${edgeId}`);
    }
  }
}

function edgeBindingFingerprint(edge: TokenEdge): string {
  return [
    requiredCanonicalEdgeId(edge),
    edge.adapterId,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.protocolAction ?? "",
    edge.edgeKind,
    edge.leavesStandingPosition ? "standing" : "flat",
    edge.instanceKey ?? "",
    edge.executionVariantKey ?? "",
  ].join("\u001f");
}

function requiredCanonicalEdgeId(edge: TokenEdge): CanonicalEdgeId {
  if (
    typeof edge.canonicalEdgeId !== "string" ||
    edge.canonicalEdgeId.trim().length === 0
  ) {
    throw new Error("strict production session requires canonicalEdgeId");
  }
  return edge.canonicalEdgeId;
}

function assertCanonicalSource(source: CanonicalSource): void {
  if (
    !Number.isSafeInteger(source.number) ||
    source.number < 0 ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.hash)
  ) {
    throw new Error("strict production session source must be canonical");
  }
}
