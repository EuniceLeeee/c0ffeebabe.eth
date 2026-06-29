import type { PlanNode } from "../../shared/types/plan.js";
import type { Opportunity } from "../detector/detector.js";
import type { PathTemplate } from "../templates/path-template.js";
import { passesConstraints } from "../templates/constraints.js";
import { buildTokenPaths, type TokenEdge, type TokenPath } from "./token-graph.js";
import type { FlashLiquidityView } from "../solver/flash-liquidity.js";

export interface CandidatePlan {
  templateName: string;
  root: PlanNode;
  opportunity: Opportunity;
  tokenPath: TokenPath;
  flashAdapterIds: string[];
  /** Preferred flash adapter for compatibility with older call sites. */
  flashAdapterId: string;
  /** Candidate-specific flash cap from the selected provider's live balance. */
  maxFlashAmount?: bigint;
  /** Full cycle tokens before rotation, for observability/debugging. */
  cycleTokens?: string[];
  /** Borrowable cycle tokens, sorted by deepest provider balance. */
  borrowableTokens?: BorrowableCycleToken[];
}

export interface BorrowableCycleToken {
  token: string;
  amount: bigint;
  adapterId: string;
}

export interface Planner {
  plan(opp: Opportunity, templates: PathTemplate[]): Promise<CandidatePlan[]>;
  lastNoCandidateDiagnostic?(): NoCandidateDiagnostic | null;
}

export type NoCandidateClassification =
  | "impact_pool_not_in_routing_graph"
  | "only_immediate_same_pool_reverse"
  | "impact_token_no_supported_return_venue"
  | "return_venue_pruned_by_bounds"
  | "template_constraint_failed"
  | "borrowability_missing"
  | "unknown_no_candidate";

export interface NoCandidateTemplateDiagnostic {
  template: string;
  edges: number;
  raw_paths: number;
  pruned_immediate_same_pool_reverse: number;
  same_pool_reverse_raw_paths: number;
  same_pool_reverse_pruned: number;
  focused_same_pool_reverse: number;
  focused_cross_venue_reverse: number;
  focused_same_pool_any_direction: number;
  focused_count: number;
  constraint_pass: number;
  no_borrowable: number;
  rotated_plans: number;
}

export interface NoCandidateDiagnostic {
  impact_pool?: string;
  impact_token_in?: string;
  impact_token_out?: string;
  impact_pool_in_detection_set: boolean;
  impact_pool_edge_in_routing_graph: boolean;
  same_pool_reverse_edge_exists: boolean;
  same_pool_reverse_raw_paths: number;
  same_pool_reverse_pruned: number;
  cross_venue_reverse_count: number;
  same_pool_any_direction_count: number;
  focused_count: number;
  impact_token_degree: number;
  impact_token_supported_pools: number;
  impact_token_return_venues: number;
  impact_token_return_venues_excluding_impact_pool: number;
  raw_paths: number;
  pruned_immediate_same_pool_reverse: number;
  constraint_pass: number;
  no_borrowable: number;
  rotated_plans: number;
  classification: NoCandidateClassification;
  templates: NoCandidateTemplateDiagnostic[];
}

export class TemplatePlanner implements Planner {
  private graph: TokenEdge[] | null = null;
  private maxCandidates = 20;
  private maxHops = 8;
  private maxPoolsPerToken = Infinity;
  private maxRotationsPerPath = 3;
  private flashLiquidity: FlashLiquidityView | null = null;
  private lastDiagnostic: NoCandidateDiagnostic | null = null;

  /** Inject a pre-built graph (from buildTokenGraph). Falls back to hardcoded default. */
  setGraph(graph: TokenEdge[]): void {
    this.graph = graph;
  }

  /** Cap the number of candidate plans returned per opportunity. */
  setMaxCandidates(n: number): void {
    this.maxCandidates = n;
  }

  /** Cap DFS depth (hops). Live should use a small value (e.g. 3); AC-3 keeps 8. */
  setMaxHops(n: number): void {
    this.maxHops = n;
  }

  /** Cap outgoing edges explored per token (top-N by score; pinned exempt). */
  setMaxPoolsPerToken(n: number): void {
    this.maxPoolsPerToken = n;
  }

  /** Cap borrowable start-token rotations per token path, ranked by live depth. */
  setMaxRotationsPerPath(n: number): void {
    this.maxRotationsPerPath = Math.max(1, n);
  }

  /** Inject live flash-borrowability. Detector stays topology-only; planner
   *  rotates each complete cycle to borrowable start tokens here. */
  setFlashLiquidity(liquidity: FlashLiquidityView): void {
    this.flashLiquidity = liquidity;
  }

  async plan(opp: Opportunity, templates: PathTemplate[]): Promise<CandidatePlan[]> {
    const candidates: CandidatePlan[] = [];
    const baseGraph = this.graph ?? [];
    this.lastDiagnostic = null;
    if (baseGraph.length === 0) {
      console.warn("[planner] empty graph — no candidates will be generated; call setGraph()");
    }
    const impact = impactFromOpportunity(opp);
    const debug: string[] = [];
    const diagnostics: NoCandidateTemplateDiagnostic[] = [];
    const seenPathKeys = new Set<string>();

    for (const template of templates) {
      const flashSlot = template.slots.find((s) => s.kind === "flash");
      const flashAdapters = flashSlot?.adapters ?? ["morpho-flash"];
      const preferredFlash = flashAdapters[0] ?? "morpho-flash";

      // Full graph (template-adapter-filtered only). Relevance to the victim
      // impact is enforced at the PATH level by focusPathsOnImpact below — NOT by
      // culling edges here. Edge-level culling dropped mid-route legs
      // (e.g. USDC→DAI→USDT→sUSDS) that long arb loops require, which silently
      // disabled the flash-lend-swap-repay template.
      const graph = baseGraph.filter((edge) =>
        template.slots.some((slot) => slot.adapters.includes(edge.adapterId)),
      );
      // Pin the victim pool so top-N pruning never drops the edge the backrun
      // must reverse through (it may have a low activity score yet be essential).
      const pinnedPools = impact ? new Set([impact.pool.toLowerCase()]) : undefined;
      const rawPaths = buildTokenPaths(graph, opp.startToken, opp.profitToken, {
        maxHops: this.maxHops,
        maxPoolsPerToken: this.maxPoolsPerToken,
        pinnedPools,
      });
      const rawFocus = analyzeImpactFocus(rawPaths, impact);
      const roundtripPrunedPaths = rawPaths.filter((path) => !hasImmediateSamePoolReverse(path));
      const prunedRoundtrip = rawPaths.length - roundtripPrunedPaths.length;
      const focus = focusPathsOnImpact(roundtripPrunedPaths, impact);
      const paths = focus.paths;

      let constraintPass = 0;
      let duplicatePath = 0;
      let noBorrowable = 0;
      let rotatedPlanCount = 0;
      for (const path of paths) {
        if (!satisfiesRequiredSlots(path, template)) {
          continue;
        }
        if (!passesConstraints(path, template.constraints, opp.startToken, opp.profitToken)) {
          continue;
        }
        constraintPass++;
        const rotations = buildBorrowabilityRotations(
          path,
          opp,
          flashAdapters,
          preferredFlash,
          this.flashLiquidity,
          this.maxRotationsPerPath,
        );
        if (rotations.length === 0) {
          noBorrowable++;
          continue;
        }
        for (const rotation of rotations) {
          if (!passesConstraints(
            rotation.tokenPath,
            template.constraints,
            rotation.opportunity.startToken,
            rotation.opportunity.profitToken,
          )) {
            continue;
          }
          const pathKey = `${tokenPathKey(rotation.tokenPath)}:${rotation.flashAdapterId}`;
          if (seenPathKeys.has(pathKey)) {
            duplicatePath++;
            continue;
          }
          seenPathKeys.add(pathKey);
          candidates.push({
            templateName: template.name,
            root: buildAbstractRoot(rotation.tokenPath, rotation.opportunity, rotation.flashAdapterId),
            opportunity: rotation.opportunity,
            tokenPath: rotation.tokenPath,
            flashAdapterIds: [...rotation.flashAdapterIds],
            flashAdapterId: rotation.flashAdapterId,
            maxFlashAmount: rotation.maxFlashAmount,
            cycleTokens: rotation.cycleTokens,
            borrowableTokens: rotation.borrowableTokens,
          });
          rotatedPlanCount++;
          if (candidates.length >= this.maxCandidates) break;
        }
        if (candidates.length >= this.maxCandidates) break;
      }
      if (candidates.length >= this.maxCandidates) break;
      debug.push(
        `${template.name}: edges=${graph.length}/${baseGraph.length} raw=${rawPaths.length} ` +
          `focused=${paths.length} prunedRoundtrip=${prunedRoundtrip} ` +
          `duplicates=${duplicatePath} constraintPass=${constraintPass}` +
          (this.flashLiquidity ? ` rotatedPlans=${rotatedPlanCount} noBorrowable=${noBorrowable}` : ""),
      );
      diagnostics.push({
        template: template.name,
        edges: graph.length,
        raw_paths: rawPaths.length,
        pruned_immediate_same_pool_reverse: prunedRoundtrip,
        same_pool_reverse_raw_paths: rawFocus.samePoolReverse.length,
        same_pool_reverse_pruned: Math.max(0, rawFocus.samePoolReverse.length - focus.samePoolReverse.length),
        focused_same_pool_reverse: focus.samePoolReverse.length,
        focused_cross_venue_reverse: focus.crossVenueReverse.length,
        focused_same_pool_any_direction: focus.samePoolAnyDirection.length,
        focused_count: paths.length,
        constraint_pass: constraintPass,
        no_borrowable: noBorrowable,
        rotated_plans: rotatedPlanCount,
      });
    }

    if (candidates.length === 0 && baseGraph.length > 0) {
      this.lastDiagnostic = buildNoCandidateDiagnostic(baseGraph, opp, impact, diagnostics);
      console.log(
        `[planner] 0 candidates start=${opp.startToken} profit=${opp.profitToken} ` +
          `impact=${impact ? `${impact.pool} ${impact.tokenIn}->${impact.tokenOut}` : "none"} | ` +
          `class=${this.lastDiagnostic.classification} | ` +
          (this.flashLiquidity ? "skip=no_borrowable_token_or_no_path | " : "") +
          debug.join(" | "),
      );
    }

    return candidates;
  }

  lastNoCandidateDiagnostic(): NoCandidateDiagnostic | null {
    return this.lastDiagnostic;
  }
}

const FLASH_TARGETS: Record<string, string> = {
  "morpho-flash": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  "balancer-flash": "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

function buildAbstractRoot(path: TokenPath, opp: Opportunity, flashAdapterId: string): PlanNode {
  const flashTarget = FLASH_TARGETS[flashAdapterId];
  if (!flashTarget) throw new Error(`unknown flash adapter: ${flashAdapterId}`);
  return {
    adapterId: flashAdapterId,
    target: flashTarget,
    tokenIn: opp.startToken,
    tokenOut: opp.startToken,
    amount: { kind: "balance-bps", token: opp.startToken, account: "executor", bps: 0 },
    params: {
      mode: "mode-b",
      route: path.edges.map((edge) => ({
        adapterId: edge.adapterId,
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
      })),
    },
    children: [],
  };
}

interface CandidateRotation {
  opportunity: Opportunity;
  tokenPath: TokenPath;
  flashAdapterIds: string[];
  flashAdapterId: string;
  maxFlashAmount?: bigint;
  cycleTokens?: string[];
  borrowableTokens?: BorrowableCycleToken[];
}

function buildBorrowabilityRotations(
  path: TokenPath,
  opp: Opportunity,
  templateFlashAdapters: string[],
  preferredFlash: string,
  flashLiquidity: FlashLiquidityView | null,
  maxRotationsPerPath: number,
): CandidateRotation[] {
  if (!flashLiquidity) {
    return [{
      opportunity: opp,
      tokenPath: path,
      flashAdapterIds: [...templateFlashAdapters],
      flashAdapterId: preferredFlash,
    }];
  }

  const cycleTokens = collectCycleTokens(path);
  const borrowableTokens = cycleTokens
    .map((token): BorrowableCycleToken | null => {
      const source = flashLiquidity.source(token);
      if (!source || source.amount <= 0n) return null;
      return { token, amount: source.amount, adapterId: source.adapterId };
    })
    .filter((x): x is BorrowableCycleToken => x !== null)
    .sort((a, b) => b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)
    .slice(0, maxRotationsPerPath);

  const rotations: CandidateRotation[] = [];
  const seen = new Set<string>();
  for (const borrowable of borrowableTokens) {
    for (const rotatedPath of rotatePathToStartToken(path, borrowable.token)) {
      const key = tokenPathKey(rotatedPath);
      if (seen.has(key)) continue;
      seen.add(key);
      const rotatedOpp: Opportunity = {
        ...opp,
        startToken: borrowable.token,
        profitToken: borrowable.token,
        affectedTokens: uniqueAddresses([...(opp.affectedTokens ?? []), ...cycleTokens]),
      };
      rotations.push({
        opportunity: rotatedOpp,
        tokenPath: rotatedPath,
        flashAdapterIds: [borrowable.adapterId],
        flashAdapterId: borrowable.adapterId,
        maxFlashAmount: borrowable.amount,
        cycleTokens,
        borrowableTokens,
      });
    }
  }
  return rotations;
}

function collectCycleTokens(path: TokenPath): string[] {
  if (path.edges.length === 0) return [];
  return uniqueAddresses([
    path.edges[0].tokenIn,
    ...path.edges.map((edge) => edge.tokenOut),
  ]);
}

function rotatePathToStartToken(path: TokenPath, startToken: string): TokenPath[] {
  const rotations: TokenPath[] = [];
  const wanted = startToken.toLowerCase();
  for (let i = 0; i < path.edges.length; i++) {
    if (path.edges[i].tokenIn.toLowerCase() !== wanted) continue;
    const edges = [...path.edges.slice(i), ...path.edges.slice(0, i)];
    if (isClosedContinuousPath(edges, startToken)) rotations.push({ edges });
  }
  return rotations;
}

function isClosedContinuousPath(edges: TokenEdge[], startToken: string): boolean {
  if (edges.length === 0) return false;
  if (!sameAddress(edges[0].tokenIn, startToken)) return false;
  if (!sameAddress(edges[edges.length - 1].tokenOut, startToken)) return false;
  for (let i = 1; i < edges.length; i++) {
    if (!sameAddress(edges[i - 1].tokenOut, edges[i].tokenIn)) return false;
  }
  return true;
}

interface OpportunityImpact {
  pool: string;
  tokenIn: string;
  tokenOut: string;
}

function impactFromOpportunity(opp: Opportunity): OpportunityImpact | null {
  const impact = opp.hints.impact;
  if (!impact || typeof impact !== "object") return null;
  const maybe = impact as Partial<OpportunityImpact>;
  if (
    typeof maybe.pool !== "string" ||
    typeof maybe.tokenIn !== "string" ||
    typeof maybe.tokenOut !== "string"
  ) {
    return null;
  }
  return {
    pool: maybe.pool,
    tokenIn: maybe.tokenIn,
    tokenOut: maybe.tokenOut,
  };
}

interface ImpactFocus {
  paths: TokenPath[];
  samePoolReverse: TokenPath[];
  crossVenueReverse: TokenPath[];
  samePoolAnyDirection: TokenPath[];
}

function focusPathsOnImpact(paths: TokenPath[], impact: OpportunityImpact | null): ImpactFocus {
  const focus = analyzeImpactFocus(paths, impact);
  if (!impact) return focus;
  if (focus.samePoolReverse.length > 0) return { ...focus, paths: focus.samePoolReverse };
  if (focus.crossVenueReverse.length > 0) return { ...focus, paths: focus.crossVenueReverse };
  return { ...focus, paths: focus.samePoolAnyDirection };
}

function analyzeImpactFocus(paths: TokenPath[], impact: OpportunityImpact | null): ImpactFocus {
  if (!impact) {
    return {
      paths,
      samePoolReverse: paths,
      crossVenueReverse: [],
      samePoolAnyDirection: [],
    };
  }

  // Best: reverse the impact through the SAME pool
  const samePoolReverse = paths.filter((path) =>
    path.edges.some((edge) =>
      sameAddress(edge.target, impact.pool) &&
      sameAddress(edge.tokenIn, impact.tokenOut) &&
      sameAddress(edge.tokenOut, impact.tokenIn),
    ),
  );
  const crossVenueReverse = paths.filter((path) =>
    path.edges.some((edge) =>
      !sameAddress(edge.target, impact.pool) &&
      sameAddress(edge.tokenIn, impact.tokenOut) &&
      sameAddress(edge.tokenOut, impact.tokenIn),
    ),
  );
  const samePoolAnyDirection = paths.filter((path) =>
    path.edges.some((edge) => sameAddress(edge.target, impact.pool)),
  );
  return {
    paths,
    samePoolReverse,
    crossVenueReverse,
    samePoolAnyDirection,
  };
}

function buildNoCandidateDiagnostic(
  graph: TokenEdge[],
  opp: Opportunity,
  impact: OpportunityImpact | null,
  templates: NoCandidateTemplateDiagnostic[],
): NoCandidateDiagnostic {
  const aggregate = aggregateTemplateDiagnostics(templates);
  if (!impact) {
    const coverage = {
      impact_pool_edge_in_routing_graph: false,
      same_pool_reverse_edge_exists: false,
      same_pool_reverse_pruned: aggregate.same_pool_reverse_pruned,
      cross_venue_reverse_count: 0,
      impact_token_return_venues: 0,
      impact_token_return_venues_excluding_impact_pool: 0,
    };
    return {
      impact_pool_in_detection_set: false,
      impact_pool_edge_in_routing_graph: coverage.impact_pool_edge_in_routing_graph,
      same_pool_reverse_edge_exists: coverage.same_pool_reverse_edge_exists,
      cross_venue_reverse_count: 0,
      impact_token_degree: 0,
      impact_token_supported_pools: 0,
      impact_token_return_venues: coverage.impact_token_return_venues,
      impact_token_return_venues_excluding_impact_pool: coverage.impact_token_return_venues_excluding_impact_pool,
      ...aggregate,
      classification: classifyNoCandidate(aggregate, coverage),
      templates,
    };
  }

  const impactPool = impact.pool.toLowerCase();
  const tokenIn = impact.tokenIn.toLowerCase();
  const tokenOut = impact.tokenOut.toLowerCase();
  let impactTokenDegree = 0;
  const impactTokenPools = new Set<string>();
  const directReturnVenues = new Set<string>();
  const directReturnVenuesExcludingImpact = new Set<string>();
  const reverseVenues = new Set<string>();
  let impactPoolEdgeInRoutingGraph = false;
  let samePoolReverseEdgeExists = false;

  for (const edge of graph) {
    const target = edge.target.toLowerCase();
    const edgeIn = edge.tokenIn.toLowerCase();
    const edgeOut = edge.tokenOut.toLowerCase();
    if (target === impactPool) impactPoolEdgeInRoutingGraph = true;
    if (edgeIn === tokenIn || edgeOut === tokenIn) {
      impactTokenDegree++;
      impactTokenPools.add(target);
    }
    if (edgeIn === tokenIn && edgeOut === tokenOut) {
      directReturnVenues.add(target);
      if (target !== impactPool) directReturnVenuesExcludingImpact.add(target);
    }
    if (edgeIn === tokenOut && edgeOut === tokenIn) {
      if (target === impactPool) samePoolReverseEdgeExists = true;
      else reverseVenues.add(target);
    }
  }

  const coverage = {
    impact_pool_edge_in_routing_graph: impactPoolEdgeInRoutingGraph,
    same_pool_reverse_edge_exists: samePoolReverseEdgeExists,
    same_pool_reverse_pruned: aggregate.same_pool_reverse_pruned,
    cross_venue_reverse_count: reverseVenues.size,
    impact_token_return_venues: directReturnVenues.size,
    impact_token_return_venues_excluding_impact_pool: directReturnVenuesExcludingImpact.size,
  };

  return {
    impact_pool: impact.pool,
    impact_token_in: impact.tokenIn,
    impact_token_out: impact.tokenOut,
    impact_pool_in_detection_set: (opp.affectedPools ?? []).some((pool) => sameAddress(pool, impact.pool)),
    impact_pool_edge_in_routing_graph: coverage.impact_pool_edge_in_routing_graph,
    same_pool_reverse_edge_exists: coverage.same_pool_reverse_edge_exists,
    cross_venue_reverse_count: coverage.cross_venue_reverse_count,
    impact_token_degree: impactTokenDegree,
    impact_token_supported_pools: impactTokenPools.size,
    impact_token_return_venues: coverage.impact_token_return_venues,
    impact_token_return_venues_excluding_impact_pool: coverage.impact_token_return_venues_excluding_impact_pool,
    ...aggregate,
    classification: classifyNoCandidate(aggregate, coverage),
    templates,
  };
}

function aggregateTemplateDiagnostics(
  templates: NoCandidateTemplateDiagnostic[],
): Pick<NoCandidateDiagnostic,
  | "same_pool_reverse_raw_paths"
  | "same_pool_reverse_pruned"
  | "same_pool_any_direction_count"
  | "focused_count"
  | "raw_paths"
  | "pruned_immediate_same_pool_reverse"
  | "constraint_pass"
  | "no_borrowable"
  | "rotated_plans"
> {
  return {
    same_pool_reverse_raw_paths: sum(templates, (x) => x.same_pool_reverse_raw_paths),
    same_pool_reverse_pruned: sum(templates, (x) => x.same_pool_reverse_pruned),
    same_pool_any_direction_count: sum(templates, (x) => x.focused_same_pool_any_direction),
    focused_count: sum(templates, (x) => x.focused_count),
    raw_paths: sum(templates, (x) => x.raw_paths),
    pruned_immediate_same_pool_reverse: sum(templates, (x) => x.pruned_immediate_same_pool_reverse),
    constraint_pass: sum(templates, (x) => x.constraint_pass),
    no_borrowable: sum(templates, (x) => x.no_borrowable),
    rotated_plans: sum(templates, (x) => x.rotated_plans),
  };
}

function classifyNoCandidate(
  aggregate: Pick<NoCandidateDiagnostic,
    | "focused_count"
    | "constraint_pass"
    | "no_borrowable"
    | "rotated_plans"
  >,
  coverage: Pick<NoCandidateDiagnostic,
    | "impact_pool_edge_in_routing_graph"
    | "same_pool_reverse_edge_exists"
    | "same_pool_reverse_pruned"
    | "cross_venue_reverse_count"
    | "impact_token_return_venues"
    | "impact_token_return_venues_excluding_impact_pool"
  >,
): NoCandidateClassification {
  if (!coverage.impact_pool_edge_in_routing_graph) {
    return "impact_pool_not_in_routing_graph";
  }
  if (
    aggregate.focused_count === 0 &&
    coverage.same_pool_reverse_edge_exists &&
    coverage.same_pool_reverse_pruned > 0 &&
    coverage.cross_venue_reverse_count === 0 &&
    coverage.impact_token_return_venues_excluding_impact_pool === 0
  ) {
    return "only_immediate_same_pool_reverse";
  }
  if (
    aggregate.focused_count === 0 &&
    coverage.impact_token_return_venues <= 1 &&
    coverage.cross_venue_reverse_count === 0
  ) {
    return "impact_token_no_supported_return_venue";
  }
  if (aggregate.focused_count === 0) {
    return "return_venue_pruned_by_bounds";
  }
  if (aggregate.focused_count > 0 && aggregate.constraint_pass === 0) {
    return "template_constraint_failed";
  }
  if (aggregate.constraint_pass > 0 && aggregate.rotated_plans === 0 && aggregate.no_borrowable > 0) {
    return "borrowability_missing";
  }
  return "unknown_no_candidate";
}

function sum<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((acc, item) => acc + fn(item), 0);
}

function satisfiesRequiredSlots(path: TokenPath, template: PathTemplate): boolean {
  return template.slots.every((slot) => {
    if ((slot.min ?? 0) <= 0 || slot.kind === "flash") return true;
    return path.edges.some((edge) => slot.adapters.includes(edge.adapterId));
  });
}

function hasImmediateSamePoolReverse(path: TokenPath): boolean {
  for (let i = 0; i < path.edges.length - 1; i++) {
    const a = path.edges[i];
    const b = path.edges[i + 1];
    if (
      sameAddress(a.target, b.target) &&
      sameAddress(a.tokenIn, b.tokenOut) &&
      sameAddress(a.tokenOut, b.tokenIn)
    ) {
      return true;
    }
  }
  return false;
}

function tokenPathKey(path: TokenPath): string {
  return path.edges
    .map((edge) =>
      [
        edge.adapterId,
        edge.target.toLowerCase(),
        edge.tokenIn.toLowerCase(),
        edge.tokenOut.toLowerCase(),
      ].join(":"),
    )
    .join("|");
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
