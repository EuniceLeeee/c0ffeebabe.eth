import assert from "node:assert/strict";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import { buildSqlEdgeLiveProducer, sqlSelectorModules, type SqlLiveMaterializedRoute, type SqlTrialMarket } from "./sql-edge-live-producer.js";
import type { SqlPriceEdge } from "./sql-edge-price-index.js";
import { isEnabledSqlExecutionLeg } from "./sql-execution-selectors.js";
import type { RethTransportScheduler } from "./reth-transport-scheduler.js";
import type { StrictReadyFundingAsset } from "./strict-production-runtime-session.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "./venues/production-family-composition.js";
import { createSelectorCurrentSourceRouteCache, SelectorSourceRouteUnavailable } from "./venues/selector-source-issued-route.js";
import { reissueSqlDirectMaterializedInstance } from "./venues/selector-native-sql-live-materializer.js";
import { selectSingleExecution } from "./venues/selector-program-role.js";
import type { StrictSessionPurpose } from "./strict-current-runtime-coordinator.js";
import type { PreparedFamilyInstance } from "./venues/adapter-family-runtime.js";
import type { StrictProductionRuntimeRoot } from "./strict-production-runtime-session.js";

/** First-table simulations need current pool evidence to create their own
 * prices. That does not release downstream execution before publication. */
export function guardSqlSelectedAuthority<T>(input: {
  published: () => boolean;
  issue: (request: { purpose: StrictSessionPurpose; source: CanonicalSource; requiredEdgeIds: ReadonlySet<string>; control?: AdapterWorkControl }) => Promise<T>;
}) {
  return (request: Parameters<typeof input.issue>[0]) => {
    if (!input.published() && request.purpose !== "startup-price") {
      throw Error("SQL execution blocked until a complete usable price table is published");
    }
    return input.issue(request);
  };
}

/** Admission for a selected execution (or a startup-price frontier wave) at a
 * single source pin, issuing the selector's sole execution template after
 * optional pool/direction confirmation. Shares a source-pinned read cache
 * across waves at the same canonical source, dropping all cached reads on
 * source change so stale state can never cross block boundaries. */
export function createSqlSelectedAuthority(input: {
  edges: readonly SqlPriceEdge[];
  fundingAssets: readonly StrictReadyFundingAsset[];
  swapTableSha256: string;
  fundingTableSha256: string;
  executionIdentity: { executor: string; transactionOrigin: string };
  rpcUrl: string;
  scheduler: RethTransportScheduler;
  signal: AbortSignal;
  candidateMarkets: ReadonlyMap<string, SqlTrialMarket>;
}) {
  const rows = new Map(input.edges.map(e => [e.candidateInstanceKey, e]));
  assert.equal(rows.size, input.edges.length, "duplicate selected SQL identities");
  const nominations = new Map([...input.candidateMarkets].map(([id, market]) => {
    assert(rows.has(id), "foreign selected SQL nomination");
    return [id, Object.freeze({ ...market.graph })] as const;
  }));
  const issueCurrent = createSelectorCurrentSourceRouteCache();

  // Pin-scoped contract read & bytecode cache across frontier waves at the exact same source.
  let cachedPinKey = "";
  let pinnedCalls = new Map<string, Promise<string>>();
  let pinnedCodes = new Map<string, Promise<string>>();

  // Deterministic 0-RPC direct-execution template cache per SQL edge ID & bounded RuntimeRoot LRU.
  type CachedDirectOutcome =
    | { readonly kind: "issued"; readonly templateInstance: PreparedFamilyInstance; readonly routeKey: string; readonly programKey: string }
    | { readonly kind: "unavailable"; readonly reason: string };
  const directEdgeCache = new Map<string, CachedDirectOutcome>();
  const runtimeRootCache = new Map<string, StrictProductionRuntimeRoot>();
  const MAX_RUNTIME_ROOT_CACHE = 384;

  return async (request: { purpose?: StrictSessionPurpose; source: CanonicalSource; requiredEdgeIds: ReadonlySet<string>; control?: AdapterWorkControl }) => {
    const ids = [...request.requiredEdgeIds];
    if (!ids.some(id => nominations.has(id))) return undefined;
    const selected = ids.map(id => {
      const row = rows.get(id);
      assert(row && nominations.has(id), "foreign or topology-rejected selected SQL edge");
      return row;
    });
    const { source, control } = request;
    assert(Number.isSafeInteger(source.number) && source.number >= 0 && Number.isSafeInteger(source.generation) && source.generation >= 0 &&
      /^0x[0-9a-f]{64}$/.test(source.hash), "invalid selected SQL source");

    const open = () => {
      input.signal.throwIfAborted();
      control?.signal?.throwIfAborted();
      if (control?.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs) throw Error("selected SQL authority deadline");
    };
    open();

    const rootCacheKey = `${request.purpose === "startup-price" ? "p" : "e"}:${[...ids].sort().join(",")}`;
    const cachedRoot = runtimeRootCache.get(rootCacheKey);
    if (cachedRoot) {
      runtimeRootCache.delete(rootCacheKey);
      runtimeRootCache.set(rootCacheKey, cachedRoot);
      return cachedRoot;
    }

    const pinKey = `${source.number}:${source.hash.toLowerCase()}:${source.generation}`;
    if (pinKey !== cachedPinKey) {
      cachedPinKey = pinKey;
      pinnedCalls = new Map();
      pinnedCodes = new Map();
    }
    const callCache = pinnedCalls, codeCache = pinnedCodes;

    const abort = new AbortController(), signal = AbortSignal.any([input.signal, abort.signal, ...(control?.signal ? [control.signal] : [])]);
    const checkOpen = () => { signal.throwIfAborted(); if (control?.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs) throw Error("selected SQL authority deadline"); };
    checkOpen();
    const noRpc = async (): Promise<never> => { throw Error("0-RPC direct execution must not invoke identity RPC reads"); };
    const materialized: SqlLiveMaterializedRoute[] = [], unavailable: { sqlEdgeKey: string; reason: string }[] = [];
    let cursor = 0, lastYield = performance.now();
    async function work() {
      try {
        for (;;) {
          if (selected.length > 64 && performance.now() - lastYield >= 40) {
            await new Promise<void>(r => setImmediate(r));
            lastYield = performance.now();
          }
          checkOpen(); const edge = selected[cursor++]; if (!edge) return;
          const sqlEdgeKey = edge.candidateInstanceKey, m = sqlSelectorModules.get(edge.selector);
          assert(m && isEnabledSqlExecutionLeg(m), "inactive or unregistered selected SQL direction");
          assert(m.definition.directState, "selected execution requires an authored source definition");
          const cachedEdge = directEdgeCache.get(sqlEdgeKey);
          if (cachedEdge) {
            if (cachedEdge.kind === "unavailable") {
              unavailable.push({ sqlEdgeKey, reason: cachedEdge.reason });
            } else {
              const instance = reissueSqlDirectMaterializedInstance({
                catalog,
                templateInstance: cachedEdge.templateInstance,
                source,
              });
              materialized.push({ sqlEdgeKey, instance, routeKey: cachedEdge.routeKey, programKey: cachedEdge.programKey });
            }
            continue;
          }
          const single = selectSingleExecution(m.definition);
          let result;
          try {
            result = await issueCurrent({
              catalog, definition: m.definition, edge, source, signal, ...input.executionIdentity,
              directExecution: true,
              read: noRpc, readCode: noRpc,
            });
          } catch (error) {
            if (error instanceof SelectorSourceRouteUnavailable) {
              directEdgeCache.set(sqlEdgeKey, { kind: "unavailable", reason: error.message });
              unavailable.push({ sqlEdgeKey, reason: error.message });
              continue;
            }
            throw error;
          }
          if (result.alternatives.length !== 1) {
            const reason = result.issues.join("; ") || "no issued runtime route";
            directEdgeCache.set(sqlEdgeKey, { kind: "unavailable", reason });
            unavailable.push({ sqlEdgeKey, reason });
          } else {
            const { instance, routeKey, programKey } = result.alternatives[0]!;
            assert.equal(programKey, single.programKey, "selected route differs from selector single execution");
            directEdgeCache.set(sqlEdgeKey, { kind: "issued", templateInstance: instance, routeKey, programKey });
            materialized.push({ sqlEdgeKey, instance, routeKey, programKey });
          }
        }
      } catch (e) { if (!signal.aborted) abort.abort(e); throw e; }
    }
    const startedAtMs = performance.now();
    const settled = await Promise.allSettled([work()]);
    for (const s of settled) if (s.status === "rejected") throw s.reason;
    checkOpen();
    const reasons = new Map<string, number>();
    for (const row of unavailable) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
    console.log("[searcher/sql-source-lazy-identity] " + JSON.stringify({
      sourceBlock: source.number,
      mode: "direct-0rpc",
      wallMs: Math.round(performance.now() - startedAtMs),
      requestedDirections: selected.length,
      issuedDirections: materialized.length,
      unavailableDirections: unavailable.length,
      cachedCalls: callCache.size,
      cachedCodes: codeCache.size,
      reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason: reason.slice(0, 512), count })),
    }));
    const scopedFundingAssets = request.purpose === "startup-price"
      ? input.fundingAssets.slice(0, 1)
      : input.fundingAssets;
    const builtRoot = buildSqlEdgeLiveProducer({
      source, edges: selected, swapTableSha256: input.swapTableSha256,
      fundingAssets: scopedFundingAssets, fundingTableSha256: input.fundingTableSha256, currentHead: source.number, materialized, unavailable,
      retainedUnavailableMarkets: new Map(unavailable.map(row => [row.sqlEdgeKey, nominations.get(row.sqlEdgeKey)!])),
      runtimeRootOnly: true,
    }).runtimeRoot;
    if (runtimeRootCache.size >= MAX_RUNTIME_ROOT_CACHE) {
      const oldestKey = runtimeRootCache.keys().next().value;
      if (oldestKey !== undefined) runtimeRootCache.delete(oldestKey);
    }
    runtimeRootCache.set(rootCacheKey, builtRoot);
    return builtRoot;
  };
}
