import { ethers } from "ethers";
import type {
  AdapterWorkControl,
  CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import {
  buildFamilyRouteGraphView,
} from "./adapter-family-graph-runtime.js";
import {
  buildFundingBorrowFragment,
  executeFundingFamilyLiquidity,
  type PreparedFundingOffer,
} from "./adapter-funding-runtime.js";
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
import type { FlashLiquidityView, FlashSource } from
  "./solver/flash-liquidity.js";
import type { ResolvedPlanNode } from "../shared/types/plan.js";
import type { RuntimeEvidence } from
  "./venues/adapter-family-plugin.js";
import { PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND } from
  "./runtime-evidence.js";
import type {
  NormalizedSwapVictimImpact,
  UnifiedObservation,
} from "./venues/adapter-family-plugin.js";
import {
  buildFamilyExecutionFragment,
  executeFamilyVictimReplay,
  executeFamilyExactQuote,
  refreshPreparedFamilyInstancePricing,
  reissuePreparedInstanceAuthority,
  reissuePreparedInstanceRouteHandles,
  type FamilyExecutionOutcome,
  type FamilyVictimReplayOutcome,
  type FamilyRouteRuntimeHandle,
  type PreparedFamilyInstance,
  type SealedFamilyExactQuoteHandle,
} from "./venues/adapter-family-runtime.js";
import type { CanonicalValue } from "./venues/canonical-value.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";
import { familyId } from "./venues/adapter-family-identifiers.js";
import type { PendingExecutionEvidence } from
  "./venues/route-leg-adapter.js";
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

/**
 * A pricing session refreshes every ready instance and publishes current mids.
 * An exact session only re-issues the ready route authorities at the pinned
 * source; exact/solver work does not need to rebuild the coarse pricing view.
 */
export type StrictProductionSessionKind = "pricing" | "exact";

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

export type StrictCurrentRoutePricing =
  | {
      readonly status: "priced";
      readonly mid: RouteVenueMid;
    }
  | {
      readonly status: "behavior-proven-unavailable";
      readonly reason: string;
    };

interface ExactBinding {
  readonly route: StrictRouteBinding;
  readonly executor: string;
  readonly runtimeEvidence: readonly RuntimeEvidence[];
}

interface InstanceRefreshOutcome {
  readonly routes: readonly {
    readonly family: LoadedFamilyPlugin;
    readonly descriptor: PreparedFamilyInstance["descriptor"];
    readonly route: PreparedFamilyInstance["routes"][number];
    readonly handle: FamilyRouteRuntimeHandle;
  }[];
  readonly creditRoutes: readonly ReturnType<typeof projectCreditRouteGraph>[];
  readonly pricing: readonly [
    FamilyRouteRuntimeHandle,
    StrictCurrentRoutePricing,
  ][];
}

interface FundingBinding {
  readonly family: LoadedFamilyBox;
  readonly offer: PreparedFundingOffer;
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

  async createSession(input: {
    readonly source: CanonicalSource;
    readonly runtime: CentralAdapterRuntime;
    readonly fundingAssets: readonly string[];
    readonly kind?: StrictProductionSessionKind;
    readonly control?: AdapterWorkControl;
    readonly touchedPools?: ReadonlySet<string>;
  }): Promise<StrictProductionRuntimeSession> {
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
    const pricingByHandle = new Map<
      FamilyRouteRuntimeHandle,
      StrictCurrentRoutePricing
    >();

    const kind = input.kind ?? "pricing";
    if (kind === "pricing") {
      /*
       * Ready instances refresh independently through the shared transport
       * (each refresh already fans its own requests out in parallel), so the
       * session refresh runs them under bounded concurrency. Results are
       * collected per index and flattened in original ready order, preserving
       * route/credit ordering and the ready-topology assertion.
       */
      // A ready pricing instance normally emits one small eth_call.  The
      // local Reth endpoint sustains this bounded fan-out; keeping it high
      // enough to finish the full ready set within one block cadence avoids
      // turning a producer generation into a permanent N-1 backlog.
      const refreshConcurrency = Math.max(1, Math.min(128, this.#readyInstances.length));
      const refreshedOutcomes = Array.from(
        { length: this.#readyInstances.length },
        () => null as InstanceRefreshOutcome | null | "skipped",
      );
      let refreshCursor = 0;
      const refreshWorkers = Array.from(
        { length: refreshConcurrency },
        async () => {
          for (;;) {
            const index = refreshCursor++;
            if (index >= this.#readyInstances.length) return;
            const readyInstance = this.#readyInstances[index]!;
            if (
              input.touchedPools !== undefined &&
              !touchedInstanceMatches(readyInstance, input.touchedPools)
            ) {
              // Current pricing refreshes only this block's touched venues;
              // untouched instances have no current mid this block and the
              // scanner's touched filter keeps enumeration over the touched
              // venues. Mark the slot explicitly: skipped slots must not
              // look like a missing refresh (null throws below).
              refreshedOutcomes[index] = "skipped";
              continue;
            }
            refreshedOutcomes[index] = await this.refreshReadyInstancePricing({
              readyInstance,
              source: input.source,
              runtime: input.runtime,
              ...(input.control === undefined ? {} : { control: input.control }),
            });
          }
        },
      );
      await Promise.all(refreshWorkers);
      for (const outcome of refreshedOutcomes) {
        if (outcome === "skipped") continue;
        if (outcome === null) {
          throw new Error("strict ready instance refresh did not complete");
        }
        routes.push(...outcome.routes);
        creditRoutes.push(...outcome.creditRoutes);
        for (const [handle, pricing] of outcome.pricing) {
          pricingByHandle.set(handle, pricing);
        }
      }
    } else {
      /*
       * Exact/solver stages already have a coarse producer snapshot. They
       * need source-bound route authorities, not another all-instance
       * current-pricing read. Re-issuing the process-local handles is purely
       * local and keeps exact work on the pinned source without paying the
       * producer's 3k-instance refresh cost a second time.
       */
      for (const readyInstance of this.#readyInstances) {
        const strictFamily = this.#catalog.forStrictFamily(
          readyInstance.familyId,
        );
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
        const family = this.#catalog.forFamily(readyInstance.familyId);
        const currentAuthority = reissuePreparedInstanceAuthority({
          family,
          instance: readyInstance,
          source: input.source,
          generation: input.source.generation,
        });
        const currentInstance = reissuePreparedInstanceRouteHandles({
          family,
          instance: currentAuthority,
          source: input.source,
          generation: input.source.generation,
        });
        routes.push(...currentInstance.routes.map((route, index) => ({
          family,
          descriptor: currentInstance.descriptor,
          route,
          handle: currentInstance.routeHandles[index]!,
        })));
      }
    }

    const view = buildFamilyRouteGraphView({ routes, creditRoutes });
    assertSameReadyTopology(this.#readyGraph, view.edges);
    const bindings = new Map<CanonicalEdgeId, StrictRouteBinding>();
    const currentPricing = new Map<
      CanonicalEdgeId,
      StrictCurrentRoutePricing
    >();
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
      if (binding.kind === "route") {
        const pricing = pricingByHandle.get(binding.handle);
        if (pricing === undefined && kind === "pricing") {
          throw new Error(
            `strict current pricing missing for ${projected.edge.canonicalEdgeId}`,
          );
        }
        if (pricing !== undefined) {
          currentPricing.set(
            projected.edge.canonicalEdgeId,
            bindCurrentPricingToEdge(pricing, projected.edge),
          );
        }
      }
    }

    const fundingBindings: FundingBinding[] = [];
    for (const family of this.#catalog.listAll()) {
      if (family.plugin.manifest.domain !== "funding") continue;
      const result = await executeFundingFamilyLiquidity({
        family,
        assets: input.fundingAssets,
        source: input.source,
        generation: input.source.generation,
        runtime: input.runtime,
        ...(input.control === undefined ? {} : { control: input.control }),
        publisher: Object.freeze({ publish() {} }),
      });
      const incomplete = result.outcomes.filter((outcome) =>
        outcome.status !== "verified"
      );
      if (incomplete.length > 0) {
        throw new Error(
          `strict current Funding incomplete for ` +
            `${family.plugin.manifest.familyId} (` +
            `${incomplete.map((outcome) => outcome.reasonCode).sort().join(",")})`,
        );
      }
      fundingBindings.push(...result.offers.map((offer) => Object.freeze({
        family,
        offer,
      })));
    }
    return new StrictProductionRuntimeSession({
      catalog: this.#catalog,
      source: input.source,
      runtime: input.runtime,
      readySource: this.#readySource,
      edges: view.edges,
      bindings,
      currentPricing,
      fundingBindings,
      pricingComplete: kind === "pricing",
    });
  }

  private async refreshReadyInstancePricing(input: {
    readonly readyInstance: PreparedFamilyInstance;
    readonly source: CanonicalSource;
    readonly runtime: CentralAdapterRuntime;
    readonly control?: AdapterWorkControl;
  }): Promise<InstanceRefreshOutcome> {
    const { readyInstance, source, runtime, control } = input;
    const strictFamily = this.#catalog.forStrictFamily(readyInstance.familyId);
    if (strictFamily.plugin.manifest.domain === "credit") {
      const currentInstance = reissuePreparedInstanceAuthority({
        family: strictFamily,
        instance: readyInstance,
        source,
        generation: source.generation,
      });
      const publication = prepareCreditFamilyRoutes({
        family: strictFamily,
        instance: currentInstance,
        source,
        generation: source.generation,
      });
      return Object.freeze({
        routes: Object.freeze([]),
        creditRoutes: Object.freeze(publication.routes.map((route) =>
          projectCreditRouteGraph({ family: strictFamily, route })
        )),
        pricing: Object.freeze([]),
      });
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
    const currentAuthority = reissuePreparedInstanceAuthority({
      family,
      instance: readyInstance,
      source,
      generation: source.generation,
    });
    const refreshed = await refreshPreparedFamilyInstancePricing({
      family,
      instance: currentAuthority,
      source,
      generation: source.generation,
      runtime,
      ...(control === undefined ? {} : { control }),
    });
    if (refreshed.instance === null) {
      const reasons = refreshed.outcomes
        .filter((outcome) =>
          outcome.status === "failed" || outcome.status === "unresolved"
        )
        .map((outcome) => outcome.reasonCode)
        .sort();
      throw new Error(
        `strict current pricing incomplete for ${readyInstance.familyId}:` +
          `${readyInstance.instanceKey}` +
          (reasons.length === 0 ? "" : ` (${reasons.join(",")})`),
      );
    }
    const currentInstance = reissuePreparedInstanceRouteHandles({
      family,
      instance: refreshed.instance,
      source,
      generation: source.generation,
    });
    const pricing: [
      FamilyRouteRuntimeHandle,
      StrictCurrentRoutePricing,
    ][] = [];
    const routes = currentInstance.routes.map((route, index) => {
      const handle = currentInstance.routeHandles[index]!;
      pricing.push([
        handle,
        currentPricingForRoute(currentInstance, route.routeKey),
      ]);
      return {
        family,
        descriptor: currentInstance.descriptor,
        route,
        handle,
      };
    });
    return Object.freeze({
      routes: Object.freeze(routes),
      creditRoutes: Object.freeze([]),
      pricing: Object.freeze(pricing),
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
  readonly #currentPricing: ReadonlyMap<
    CanonicalEdgeId,
    StrictCurrentRoutePricing
  >;
  readonly #fundingBindings: readonly FundingBinding[];
  readonly #pricingComplete: boolean;
  readonly #exactBindings = new WeakMap<object, ExactBinding>();

  constructor(input: {
    readonly catalog: FamilyCapabilityCatalog;
    readonly source: CanonicalSource;
    readonly readySource: CanonicalSource;
    readonly runtime: CentralAdapterRuntime;
    readonly edges: readonly TokenEdge[];
    readonly bindings: ReadonlyMap<CanonicalEdgeId, StrictRouteBinding>;
    readonly currentPricing: ReadonlyMap<
      CanonicalEdgeId,
      StrictCurrentRoutePricing
    >;
    readonly fundingBindings: readonly FundingBinding[];
    readonly pricingComplete?: boolean;
  }) {
    this.#catalog = input.catalog;
    this.source = Object.freeze({ ...input.source });
    this.readySource = Object.freeze({ ...input.readySource });
    this.#runtime = input.runtime;
    this.edges = Object.freeze([...input.edges]);
    this.#bindings = new Map(input.bindings);
    this.#currentPricing = new Map(input.currentPricing);
    this.#fundingBindings = Object.freeze([...input.fundingBindings]);
    this.#pricingComplete = input.pricingComplete ?? true;
    Object.freeze(this);
  }

  familyIdForEdge(edge: TokenEdge): string {
    return this.#resolve(edge).family.plugin.manifest.familyId;
  }

  blocksPrefixInversion(edge: TokenEdge): boolean {
    return this.#resolve(edge).kind === "credit";
  }

  /**
   * Current-source coarse pricing for one ready swap/protocol edge. Credit is
   * exact-only and therefore returns null rather than inventing a coarse mid.
   */
  currentPricingForEdge(edge: TokenEdge): StrictCurrentRoutePricing | null {
    const binding = this.#resolve(edge);
    if (binding.kind === "credit") return null;
    const pricing = this.#currentPricing.get(binding.edge.canonicalEdgeId);
    if (pricing === undefined) {
      if (!this.#pricingComplete) return null;
      throw new Error(
        `strict session has no current pricing for ${binding.edge.canonicalEdgeId}`,
      );
    }
    return pricing;
  }

  /**
   * Bind already validated pending input to this exact source/session without
   * interpreting its Family-owned payload. Exact Family code remains the only
   * consumer allowed to assign protocol meaning to sealedPayloadRef.
   */
  runtimeEvidenceFromPendingExecution(
    evidence: readonly PendingExecutionEvidence[],
  ): readonly RuntimeEvidence[] {
    const bound: RuntimeEvidence[] = [];
    const seen = new Set<string>();
    for (const item of evidence) {
      if (
        item.headBlockNumber !== this.source.number ||
        item.headHash.toLowerCase() !== this.source.hash.toLowerCase() ||
        !ethers.isHexString(item.txHash, 32) ||
        !ethers.isHexString(item.canonicalPayload) ||
        !ethers.isHexString(item.payloadHash, 32) ||
        !ethers.isHexString(item.evidenceHash, 32)
      ) {
        throw new Error("pending execution evidence differs from strict source");
      }
      this.#catalog.forStrictFamily(familyId(item.familyId));
      const payloadHash = ethers.keccak256(item.canonicalPayload);
      const expectedEvidenceHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "bytes32", "uint256", "bytes32", "bytes32"],
          [
            item.familyId,
            item.txHash,
            item.headBlockNumber,
            item.headHash,
            payloadHash,
          ],
        ),
      );
      if (
        payloadHash.toLowerCase() !== item.payloadHash.toLowerCase() ||
        expectedEvidenceHash.toLowerCase() !== item.evidenceHash.toLowerCase()
      ) {
        throw new Error("pending execution evidence hash mismatch");
      }
      const key = `${item.familyId}\u001f${item.txHash.toLowerCase()}\u001f` +
        item.evidenceHash.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      bound.push(Object.freeze({
        evidenceId: `pending:${item.txHash.toLowerCase()}`,
        familyId: familyId(item.familyId),
        kind: PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND,
        scope: "transaction" as const,
        source: this.source,
        txHash: item.txHash.toLowerCase(),
        evidenceHash: item.evidenceHash.toLowerCase(),
        sealedPayloadRef: item.canonicalPayload,
      }));
    }
    return Object.freeze(bound);
  }

  /** Planner-only projection; executable Funding authority remains private. */
  fundingLiquidityView(): FlashLiquidityView {
    const sources = new Map<string, FlashSource>();
    for (const { offer } of this.#fundingBindings) {
      const asset = offer.asset.toLowerCase();
      const incumbent = sources.get(asset);
      if (
        incumbent === undefined ||
        offer.maxBorrow > incumbent.amount
      ) {
        sources.set(asset, Object.freeze({
          amount: offer.maxBorrow,
          adapterId: offer.actionAdapterId,
          fundingId: offer.fundingId,
        }));
      }
    }
    return Object.freeze({
      borrowable(token: string): bigint {
        return sources.get(token.toLowerCase())?.amount ?? 0n;
      },
      source(token: string): FlashSource | null {
        return sources.get(token.toLowerCase()) ?? null;
      },
    });
  }

  fundingActionIds(asset: string, amount?: bigint): readonly string[] {
    const normalizedAsset = asset.toLowerCase();
    return Object.freeze(this.#fundingBindings
      .filter(({ offer }) =>
        offer.asset.toLowerCase() === normalizedAsset &&
        (amount === undefined || offer.maxBorrow >= amount)
      )
      .sort((left, right) =>
        left.offer.planningPriority - right.offer.planningPriority ||
        left.offer.liquidityPriority - right.offer.liquidityPriority ||
        left.offer.actionAdapterId.localeCompare(right.offer.actionAdapterId)
      )
      .map(({ offer }) => offer.actionAdapterId));
  }

  buildFundingRoot(input: {
    readonly actionAdapterId: string;
    readonly asset: string;
    readonly amount: bigint;
    readonly minProfit: bigint;
    readonly children: readonly ResolvedPlanNode[];
  }): ResolvedPlanNode {
    const normalizedAsset = input.asset.toLowerCase();
    const binding = this.#fundingBindings.find(({ offer }) =>
      offer.actionAdapterId === input.actionAdapterId &&
      offer.asset.toLowerCase() === normalizedAsset &&
      offer.maxBorrow >= input.amount
    );
    if (binding === undefined) {
      throw new Error(
        `strict session has no Funding offer ${input.actionAdapterId} ` +
          `${input.asset} amount=${input.amount}`,
      );
    }
    const fragment = buildFundingBorrowFragment({
      family: binding.family,
      offer: binding.offer,
      source: this.source,
      generation: this.source.generation,
      amount: input.amount,
      minProfit: input.minProfit,
      children: Object.freeze([Object.freeze({
        requirements: Object.freeze([]),
        nodes: Object.freeze([...input.children]),
      })]),
    });
    if (fragment.requirements.length !== 0 || fragment.nodes.length !== 1) {
      throw new Error("strict Funding fragment must produce one closed root");
    }
    return fragment.nodes[0]!;
  }

  supportsVictimReplay(edge: TokenEdge): boolean {
    const route = this.#resolve(edge);
    if (
      route.kind !== "route" ||
      route.family.plugin.manifest.domain !== "swap"
    ) {
      return false;
    }
    const plugin = route.family.plugin as unknown as {
      readonly swap: {
        readonly victimSupport: string;
        readonly replay?: unknown;
      };
    };
    return plugin.swap.victimSupport === "replay" &&
      plugin.swap.replay !== undefined;
  }

  replayVictim(input: {
    readonly edge: TokenEdge;
    readonly impact: NormalizedSwapVictimImpact;
    readonly preState: CanonicalValue | null;
    readonly validUntil: bigint;
  }): FamilyVictimReplayOutcome {
    const route = this.#resolve(input.edge);
    if (route.kind !== "route") {
      throw new Error("Credit route cannot own a swap victim replay");
    }
    return executeFamilyVictimReplay({
      family: route.family,
      route: route.handle,
      impact: input.impact,
      preState: input.preState,
      validUntil: input.validUntil,
      source: this.source,
      generation: this.source.generation,
      runtime: this.#runtime,
    });
  }

  runtimeEvidenceFromObservation(
    observation: UnifiedObservation,
  ): readonly RuntimeEvidence[] {
    assertObservationSource(observation, this.source);
    const evidence: RuntimeEvidence[] = [];
    const seen = new Set<string>();
    for (const match of this.#catalog.matches(observation)) {
      const family = this.#catalog.forStrictFamily(match.familyId);
      if (!("discovery" in family.plugin)) continue;
      const derive = family.plugin.discovery?.runtimeEvidenceFromObservation;
      if (derive === undefined) continue;
      for (const item of derive({ observation, source: this.source })) {
        if (
          item.familyId !== family.plugin.manifest.familyId ||
          item.source.number !== this.source.number ||
          item.source.hash.toLowerCase() !== this.source.hash.toLowerCase() ||
          item.source.generation !== this.source.generation
        ) {
          throw new Error("plugin runtime evidence escaped its Family/source");
        }
        const key = `${item.familyId}\u001f${item.evidenceId}\u001f${item.evidenceHash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push(item);
      }
    }
    return Object.freeze(evidence);
  }

  creditDebtBpsCandidates(path: { readonly edges: readonly TokenEdge[] }): readonly bigint[] {
    for (const edge of path.edges) {
      const route = this.#resolve(edge);
      if (route.kind !== "credit") continue;
      const plugin = route.family.plugin;
      if (plugin.manifest.domain !== "credit") {
        throw new Error("strict Credit binding escaped its domain");
      }
      const risk = (plugin as unknown as {
        readonly credit: {
          readonly risk: { readonly debtBpsCandidates: readonly bigint[] };
        };
      }).credit.risk;
      return Object.freeze([...risk.debtBpsCandidates]);
    }
    return Object.freeze([0n]);
  }

  async issueExact(input: {
    readonly edge: TokenEdge;
    readonly amountIn: bigint;
    readonly executor: string;
    readonly runtimeEvidence: readonly RuntimeEvidence[];
    readonly creditDebtBps?: bigint;
    readonly control?: AdapterWorkControl;
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
          ...(input.control === undefined ? {} : { control: input.control }),
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
          ...(input.control === undefined ? {} : { control: input.control }),
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
        runtimeEvidence: exactBinding.runtimeEvidence,
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
      runtimeEvidence: exactBinding.runtimeEvidence,
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

function currentPricingForRoute(
  instance: PreparedFamilyInstance,
  routeKey: PreparedFamilyInstance["routes"][number]["routeKey"],
): StrictCurrentRoutePricing {
  const owners = instance.pricingInstances.filter((pricing) =>
    pricing.routes.some((route) => route.routeKey === routeKey)
  );
  if (owners.length !== 1) {
    throw new Error(
      `strict current route ${routeKey} has ${owners.length} pricing owners`,
    );
  }
  const mid = owners[0]!.mids.get(routeKey);
  const reason = owners[0]!.unavailable.get(routeKey);
  if ((mid === undefined) === (reason === undefined)) {
    throw new Error(
      `strict current route ${routeKey} lacks one exact pricing classification`,
    );
  }
  return mid === undefined
    ? Object.freeze({
        status: "behavior-proven-unavailable" as const,
        reason: reason!,
      })
    : Object.freeze({ status: "priced" as const, mid });
}

function bindCurrentPricingToEdge(
  pricing: StrictCurrentRoutePricing,
  edge: TokenEdge,
): StrictCurrentRoutePricing {
  if (pricing.status === "behavior-proven-unavailable") return pricing;
  return Object.freeze({
    status: "priced" as const,
    mid: Object.freeze({
      ...pricing.mid,
      edges: Object.freeze([edge]) as unknown as TokenEdge[],
    }),
  });
}

function touchedInstanceMatches(
  instance: PreparedFamilyInstance,
  touchedPools: ReadonlySet<string>,
): boolean {
  // The pricing state key is the physical venue identity: pool address for
  // pair venues (univ2/univ3), poolId for singleton-manager venues (univ4) -
  // the same identity the scanner's touched filter uses.
  return instance.pricingInstances.some((pricing) =>
    touchedPools.has(String(pricing.stateKey).toLowerCase()),
  );
}

/**
 * The refreshed view is the current-block touched subset of the ready
 * graph: every view edge must exist in the ready graph with the same
 * binding fingerprint, while the ready graph may legitimately contain more
 * (untouched venues have no current mid this block).
 */
function assertSameReadyTopology(
  ready: readonly TokenEdge[],
  current: readonly TokenEdge[],
): void {
  const readyById = new Map(ready.map((edge) => [
    requiredCanonicalEdgeId(edge),
    edgeBindingFingerprint(edge),
  ]));
  for (const edge of current) {
    const edgeId = requiredCanonicalEdgeId(edge);
    if (readyById.get(edgeId) !== edgeBindingFingerprint(edge)) {
      throw new Error(
        `strict current-source topology differs from ready Graph at ${edgeId}`,
      );
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

function assertObservationSource(
  observation: UnifiedObservation,
  source: CanonicalSource,
): void {
  if (
    observation.source.number !== source.number ||
    observation.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
    observation.source.generation !== source.generation
  ) {
    throw new Error("runtime observation escaped its current-source session");
  }
}
