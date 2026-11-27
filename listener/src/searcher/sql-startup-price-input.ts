import { selectorExecutionPrograms, selectSingleExecution } from "./venues/selector-program-role.js";
import assert from "node:assert/strict";
import { setImmediate as yieldToLive } from "node:timers/promises";
import { isEnabledSqlExecutionLeg } from "./sql-execution-selectors.js";
import { sqlSelectorModules, type SqlTrialGraphMetadata, type SqlTrialMarket, type SqlLiveMaterializedRoute } from "./sql-edge-live-producer.js";
import type { SqlStartupPriceTrials } from "./sql-startup-price-sessions.js";
import type { SqlPriceEdge } from "./sql-edge-price-index.js";
import { compileSqlTrialLegs } from "./venues/selector-native-sql-trial.js";
import { selectorExecutionResourceKey } from "./venues/selector-execution-keys.js";
import { selectorNativeProgramKey, type SelectorNativeExecutionDefinition } from "./venues/selector-native-definition.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { sqlTrialVariantId, sqlSourceTemplateVariantId } from "./sql-trial-variant.js";
import { issueSelectorCurrentSourceRoutes } from "./venues/selector-source-issued-route.js";
import { createSelectorIdentityRequestReader } from "./venues/selector-source-identity.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "./venues/production-family-composition.js";
import { buildFamilyRouteGraphView } from "./adapter-family-graph-runtime.js";
import { selectorSourceGraphNomination } from "./venues/selector-source-graph.js";

/** Source-only startup:
 * - When `read`/`readCode` are omitted (live startup), project candidate topology
 *   with 0 RPC calls (`source-lazy-on-quote`); reachable directions confirm pool
 *   identity lazily on quote via `selectedAuthority`.
 * - When `read` & `readCode` are provided (explicit eager bind), confirm identity
 *   and materialize routes directly at `source`. */
export async function prepareSqlSourceStartupInputs(input: {
  edges: readonly SqlPriceEdge[];
  source: CanonicalSource;
  executor: string;
  transactionOrigin: string;
  signal?: AbortSignal;
  read?: (to: string, data: string) => Promise<string>;
  readCode?: (address: string) => Promise<string>;
  readStorage?: (address: string, slot: string) => Promise<string>;
  concurrency: number;
  report?: (counts: { processed: number; locallyEncodable: number; unavailable: number }) => void;
}) {
  const materialized: SqlLiveMaterializedRoute[] = [], unavailable: { sqlEdgeKey: string; reason: string }[] = [], markets = new Map<string, SqlTrialMarket>();
  if (!input.read || !input.readCode) {
    const templates = new Map<SelectorNativeExecutionDefinition, { variant: string; policy: "on-touch" | "each-block" }>();
    const templateVariants = new Map<string, string>();
    let lastYield = performance.now(), lastReport = lastYield;
    for (const [index, edge] of input.edges.entries()) {
      input.signal?.throwIfAborted();
      const id = edge.candidateInstanceKey, m = sqlSelectorModules.get(edge.selector);
      if (!m || !isEnabledSqlExecutionLeg(m)) {
        unavailable.push({ sqlEdgeKey: id, reason: "selector is disabled or has no execution capability" });
      } else {
        const single = selectSingleExecution(m.definition);
        assert(m.definition.directState && single.program.type === "execution", "active SQL selector requires a single authored execution template");
        let template = templates.get(m.definition);
        if (!template) {
          template = {
            variant: sqlSourceTemplateVariantId(single.programKey),
            policy: single.program.sourceRefreshPolicy ?? single.program.refreshPolicy ?? "each-block",
          };
          templates.set(m.definition, template);
        }
        try {
          const graph = selectorSourceGraphNomination(m.definition, edge);
          markets.set(id, { graph, variants: new Map([[template.variant, template.policy]]) });
          templateVariants.set(id, template.variant);
        } catch (error) {
          unavailable.push({ sqlEdgeKey: id, reason: "source graph nomination unavailable: " + String(error) });
        }
      }
      if (performance.now() - lastYield >= 40) {
        await yieldToLive(); lastYield = performance.now();
        if (lastYield - lastReport >= 5000) {
          input.report?.({ processed: index + 1, locallyEncodable: markets.size, unavailable: unavailable.length });
          lastReport = lastYield;
        }
      }
    }
    input.report?.({ processed: input.edges.length, locallyEncodable: markets.size, unavailable: unavailable.length });
    const trials: SqlStartupPriceTrials = {
      ids: new Set(),
      templateVariants,
      atSource() { throw Error("source candidates require the formal current-source quote session"); },
    };
    return { trials, markets, materialized, unavailable };
  }

  const rawRead = input.read, rawReadCode = input.readCode;
  const abort = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  const readIdentityRequests = createSelectorIdentityRequestReader({ source: input.source, signal, read: rawRead, readCode: rawReadCode, readStorage: input.readStorage });
  const codeCache = new Map<string, Promise<string>>();
  const readCode = (address: string) => { let p = codeCache.get(address); if (!p) { p = rawReadCode(address); codeCache.set(address, p); } return p; };
  let cursor = 0, processed = 0, lastReport = performance.now();
  async function worker() {
    try {
      for (;;) {
        signal.throwIfAborted(); const edge = input.edges[cursor++]; if (!edge) return;
        const id = edge.candidateInstanceKey, m = sqlSelectorModules.get(edge.selector);
        if (!m || !isEnabledSqlExecutionLeg(m)) { unavailable.push({ sqlEdgeKey: id, reason: "selector is disabled or has no execution capability" }); processed++; continue; }
        const single = selectSingleExecution(m.definition);
        assert(m.definition.directState && single.program.type === "execution", "active SQL selector requires a single authored execution template");
        const result = await issueSelectorCurrentSourceRoutes({
          catalog, definition: m.definition, edge, source: input.source, executor: input.executor, transactionOrigin: input.transactionOrigin,
          signal, read: rawRead, readCode, readIdentityRequests,
        });
        if (result.alternatives.length !== 1) {
          unavailable.push({ sqlEdgeKey: id, reason: result.issues.join("; ") || "no independently bound execution route" });
        } else {
          const route = result.alternatives[0]!;
          assert.equal(route.programKey, single.programKey, "issued route differs from selector single execution template");
          const projected = buildFamilyRouteGraphView({ routes: route.instance.routes.map((r, i) => ({
            family: catalog.forFamily(route.instance.familyId), descriptor: route.instance.descriptor, route: r, handle: route.instance.routeHandles[i]!,
          })) }).edges;
          assert.equal(projected.length, 1, "expected single projected direction edge");
          const variants = new Map<string, "on-touch" | "each-block">([[projected[0]!.canonicalEdgeId!, single.program.sourceRefreshPolicy ?? single.program.refreshPolicy ?? "each-block"]]);
          materialized.push({ sqlEdgeKey: id, ...route });
          markets.set(id, { graph: projected[0]!, variants });
        }
        processed++;
        if (performance.now() - lastReport >= 5000) {
          input.report?.({ processed, locallyEncodable: markets.size, unavailable: unavailable.length });
          lastReport = performance.now();
        }
      }
    } catch (error) { if (!signal.aborted) abort.abort(error); throw error; }
  }
  assert(Number.isSafeInteger(input.concurrency) && input.concurrency > 0, "invalid source identity worker count");
  const settled = await Promise.allSettled(Array.from({ length: Math.min(input.edges.length, input.concurrency) }, worker));
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  input.report?.({ processed, locallyEncodable: markets.size, unavailable: unavailable.length });
  const trials: SqlStartupPriceTrials = { ids: new Set(), atSource() { throw Error("source-bound execution does not use direct SQL trials"); } };
  return { trials, markets, materialized, unavailable };
}

export async function prepareSqlStartupPriceInputs(input: {
  edges: readonly SqlPriceEdge[]; source: CanonicalSource; executor: string; transactionOrigin: string; signal?: AbortSignal;
  report?: (counts: { processed: number; locallyEncodable: number; unavailable: number }) => void;
}) {
  const rows = new Map<string, SqlPriceEdge>(), markets = new Map<string, SqlTrialMarket>();
  const unavailable: { sqlEdgeKey: string; reason: string }[] = [];
  const policies = new Map<SelectorNativeExecutionDefinition, Map<string, "on-touch" | "each-block">>();
  function compile(edge: SqlPriceEdge, source: CanonicalSource) {
    const m = sqlSelectorModules.get(edge.selector); assert(m && isEnabledSqlExecutionLeg(m), "inactive SQL price selector");
    const d = m.definition;
    const result = compileSqlTrialLegs({ definition: d, edge, source, executor: input.executor, transactionOrigin: input.transactionOrigin });
    let graph: SqlTrialGraphMetadata | undefined, p = policies.get(d);
    if (!p) { p = new Map(selectorExecutionPrograms(d).map(a => [selectorNativeProgramKey(a), a.refreshPolicy === "on-touch" ? "on-touch" : "each-block"])); policies.set(d, p); }
    const variants = new Map<string, "on-touch" | "each-block">(), programs = new Map<string, (typeof result.legs)[number]["leg"]>();
    for (const trial of result.legs) {
      const { tokenIn, tokenOut, poolNamespace, taxonomy } = trial;
      const g = { tokenIn, tokenOut, slotKind: taxonomy.slotKind, ...(taxonomy.protocolAction ? { protocolAction: taxonomy.protocolAction } : {}),
        stateResourceKey: selectorExecutionResourceKey({ chainId: edge.chainId, target: edge.poolAddress,
          ...(edge.poolId ? { poolId: edge.poolId, poolNamespace: poolNamespace ?? undefined } : {}) }) };
      const id = sqlTrialVariantId(trial.programKey, trial.leg.program), policy = p.get(trial.programKey);
      assert(policy && !variants.has(id), "duplicate or foreign SQL trial program");
      if (graph && JSON.stringify(graph) !== JSON.stringify(g)) return { ...result, complete: false, graph: undefined,
        variants: new Map<string, "on-touch" | "each-block">(), programs: new Map<string, (typeof trial)["leg"]>(), issues: ["encodings disagree on graph identity"] };
      graph ??= g; variants.set(id, policy); programs.set(id, trial.leg);
    }
    return { ...result, graph, variants, programs };
  }
  let lastYield = performance.now(), lastReport = lastYield;
  for (const [i, edge] of input.edges.entries()) {
    if (performance.now() - lastYield >= 40) {
      await yieldToLive(); lastYield = performance.now();
      if (lastYield - lastReport >= 5000) { input.report?.({ processed: i, locallyEncodable: markets.size, unavailable: unavailable.length }); lastReport = lastYield; }
    }
    input.signal?.throwIfAborted();
    const id = edge.candidateInstanceKey, m = sqlSelectorModules.get(edge.selector);
    if (!m || !isEnabledSqlExecutionLeg(m)) { unavailable.push({ sqlEdgeKey: id, reason: !m ? "unregistered conversion selector" : !m.activation.enabled ? "selector is disabled" : "selector has no independent conversion program" }); continue; }
    rows.set(id, edge);
    const c = compile(edge, input.source);
    if (c.graph) markets.set(id, { graph: c.graph, variants: c.variants });
    else unavailable.push({ sqlEdgeKey: id, reason: c.issues.join("; ") || "no compatible SQL execution recipe" });
  }
  const trials: SqlStartupPriceTrials = { ids: new Set(rows.keys()), atSource(id, source) {
    const e = rows.get(id); assert(e, "foreign SQL price edge");
    const m = markets.get(id), c = m && compile(e, source);
    const same = !!m && !!c?.graph && JSON.stringify(m.graph) === JSON.stringify(c.graph);
    return { tokenIn: m?.graph.tokenIn ?? e.tokenIn, tokenOut: m?.graph.tokenOut ?? e.tokenOut,
      complete: !!same && c!.complete, programs: same ? c!.programs : new Map() };
  } };
  return { trials, markets, unavailable };
}
